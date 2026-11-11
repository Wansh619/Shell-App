import test from "node:test";
import assert from "node:assert/strict";
import ConsoleManager, {
    ConsoleView,
    TerminalView,
    ConsoleTransport,
    TerminalTransport,
    PaneManager
} from "./components/ConsoleManager.js";
import { SkillRegistry, createDefaultSkillRegistry } from "./skills/registry.js";

class FakeClassList {
    constructor() {
        this.items = new Set();
    }
    add(...names) {
        names.forEach((name) => this.items.add(name));
    }
    remove(...names) {
        names.forEach((name) => this.items.delete(name));
    }
    toggle(name, force) {
        const shouldAdd = force === undefined ? !this.items.has(name) : Boolean(force);
        if (shouldAdd) {
            this.items.add(name);
        } else {
            this.items.delete(name);
        }
        return shouldAdd;
    }
    contains(name) {
        return this.items.has(name);
    }
}

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.classList = new FakeClassList();
        this.listeners = new Map();
        this.attributes = new Map();
        this.hidden = false;
        this.disabled = false;
        this.value = "";
        this.textContent = "";
    }
    append(...nodes) {
        this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
        this.children = [...nodes];
    }
    insertBefore(node, referenceNode) {
        const index = this.children.indexOf(referenceNode);
        if (index === -1) {
            this.children.push(node);
        } else {
            this.children.splice(index, 0, node);
        }
    }
    remove() {
        this.removed = true;
    }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }
    getAttribute(name) {
        return this.attributes.get(name);
    }
    addEventListener(type, handler) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), handler]);
    }
    removeEventListener(type, handler) {
        this.listeners.set(
            type,
            (this.listeners.get(type) || []).filter((item) => item !== handler)
        );
    }
    dispatch(type, event = {}) {
        for (const handler of this.listeners.get(type) || []) {
            handler({
                preventDefault() {},
                stopPropagation() {},
                ...event
            });
        }
    }
    requestSubmit() {
        this.dispatch("submit");
    }
    focus() {
        this.focused = true;
    }
    querySelectorAll() {
        return [];
    }
}

function setupFakeDom() {
    globalThis.document = {
        createElement: (tag) => new FakeElement(tag)
    };
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.requestAnimationFrame = (fn) => fn();
}

test("ConsoleView and ConsoleTransport export aliases for backwards compatibility", () => {
    assert.equal(ConsoleView, TerminalView);
    assert.equal(ConsoleTransport, TerminalTransport);
    assert.equal(typeof ConsoleManager, "function");
});

test("SkillRegistry registers open and image skills and parses both prefixed and selected skill input", () => {
    const registry = createDefaultSkillRegistry();
    const names = registry.list().map((skill) => skill.name);
    assert.deepEqual(names, ["open", "image"]);
    assert.equal(registry.get("open").panelState, "editor panel");
    assert.equal(registry.get("image").panelState, "image panel");
    assert.equal(registry.getByPanelState("editor panel").name, "open");
    assert.equal(registry.getByPanelState("image panel").name, "image");

    const explicitOpen = registry.parseSkillInput("open app/main.py");
    assert.equal(explicitOpen.skill, "open");
    assert.equal(explicitOpen.panelState, "editor panel");
    assert.equal(explicitOpen.args, "app/main.py");

    const selectedImage = registry.parseSkillInput("static/images/logo.png", "image");
    assert.equal(selectedImage.skill, "image");
    assert.equal(selectedImage.panelState, "image panel");
    assert.equal(selectedImage.args, "static/images/logo.png");

    assert.equal(registry.parseSkillInput("   "), null);
    assert.equal(registry.parseSkillInput("unknown_skill foo.txt"), null);
});

test("PaneManager and ConsoleView manage Terminal/Skills toggle and panel state machine transitions", () => {
    setupFakeDom();
    const registry = createDefaultSkillRegistry();
    const sentSkills = [];
    const sentInputs = [];

    const paneManager = new PaneManager(new FakeElement("div"), {
        createTerminal: (paneId, container, paneContext) =>
            new ConsoleView(paneId, container, {
                sendInput: (sessionId, value) => sentInputs.push({ sessionId, value }),
                sendResize: () => {},
                sendSkill: (sessionId, payload) => sentSkills.push({ sessionId, ...payload }),
                skillRegistry: registry,
                ...paneContext
            }),
        removeTerminal: () => {},
        onActivate: () => {}
    });

    const leaf = paneManager.root;
    const view = leaf.terminal;

    assert.equal(view.state, "terminal");
    assert.equal(leaf.element.dataset.panelState, "terminal");
    assert.equal(leaf.stateBadge.textContent, "terminal");
    assert.equal(leaf.backButton.hidden, true);
    assert.equal(view.inputMode, "terminal");
    assert.equal(view.prompt.textContent, "$");

    // Ready prompt enables terminal input
    view.setPromptToken("deadbeef");
    view.write("initial output\n\x1eSHELL_APP_PROMPT:deadbeef:0\x1f");
    assert.equal(view.output.children.length, 1);

    // Switch to Skills mode
    view.skillsModeBtn.dispatch("click");
    assert.equal(view.inputMode, "skills");
    assert.equal(view.prompt.textContent, "✦");
    assert.equal(view.submit.textContent, "Run Skill");
    assert.equal(view.skillSelector.hidden, false);

    // Submit "open app.py" in Skills mode
    view.input.value = "open app.py";
    view.form.dispatch("submit");
    assert.equal(sentSkills.length, 1);
    assert.deepEqual(sentSkills[0], {
        sessionId: leaf.id,
        skill: "open",
        action: "read",
        args: "app.py"
    });

    // Receive skill_result for editor panel
    view.handleSkillResult({
        session_id: leaf.id,
        type: "skill_result",
        skill: "open",
        action: "read",
        panel_state: "editor panel",
        status: "ok",
        data: {
            path: "app.py",
            content: "print('hello')\n",
            language: "python"
        }
    });

    assert.equal(view.state, "editor panel");
    assert.equal(leaf.element.dataset.panelState, "editor panel");
    assert.equal(leaf.stateBadge.textContent, "editor panel");
    assert.equal(leaf.backButton.hidden, false);
    assert.equal(view.output.hidden, true);
    assert.equal(view.modeBar.hidden, true);
    assert.equal(view.form.hidden, true);
    assert.equal(view.skillPanel.hidden, false);

    // Click Back to Terminal in pane header -> returns to terminal preserving history
    leaf.backButton.dispatch("click");
    assert.equal(view.state, "terminal");
    assert.equal(leaf.element.dataset.panelState, "terminal");
    assert.equal(leaf.stateBadge.textContent, "terminal");
    assert.equal(leaf.backButton.hidden, true);
    assert.equal(view.output.hidden, false);
    assert.equal(view.output.children.length, 1);
    assert.equal(view.modeBar.hidden, false);
    assert.equal(view.form.hidden, false);
    assert.equal(view.skillPanel.hidden, true);

    // Transition to image panel and return
    view.handleSkillResult({
        session_id: leaf.id,
        type: "skill_result",
        skill: "image",
        action: "read",
        panel_state: "image panel",
        status: "ok",
        data: {
            path: "logo.png",
            mime_type: "image/png",
            data_url: "data:image/png;base64,AAAA"
        }
    });
    assert.equal(view.state, "image panel");
    assert.equal(leaf.stateBadge.textContent, "image panel");
    assert.equal(leaf.backButton.hidden, false);

    view.transitionToTerminal();
    assert.equal(view.state, "terminal");
    assert.equal(leaf.backButton.hidden, true);

    // Switch back to Terminal mode and verify typing in input bar animates the input mirror without creating a draftBlock preview
    view.terminalModeBtn.dispatch("click");
    assert.equal(view.inputMode, "terminal");
    view.input.value = "ls";
    view.input.dispatch("input");
    assert.equal(view.form.classList.contains("is-typing"), true);
    assert.equal(view.input.classList.contains("is-typing"), true);
    assert.equal(view.draftBlock, null);
    assert.equal(view.inputMirror.children.length, 3); // 'l', 's', and caret

    view.input.value = "ls -la";
    view.input.dispatch("input");
    assert.equal(view.draftBlock, null);
    assert.equal(view.inputMirror.children.length, 7); // 6 chars + caret
    assert.ok(view.inputMirror.children[5].className.includes("console-input-char--new"));

    // Splitting pane adds split entrance animation classes
    paneManager.split("horizontal");
    assert.equal(paneManager.paneCount, 2);

    view.dispose();
});
