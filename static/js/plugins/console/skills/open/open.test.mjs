import test from "node:test";
import assert from "node:assert/strict";
import openSkillPlugin, {
    EditorPanelView,
    renderEditorPanel,
    renderFallbackOpenPanel
} from "./plugin.js";

class FakeClassList {
    constructor(initial = []) {
        this.items = new Set(initial);
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
        this._className = "";
        this.classList = new FakeClassList();
        this.listeners = new Map();
        this.attributes = new Map();
        this.hidden = false;
        this.disabled = false;
        this.readOnly = false;
        this.value = "";
        this.textContent = "";
        this.scrollTop = 0;
        this.selectionStart = 0;
        this.selectionEnd = 0;
    }
    get className() {
        return this._className;
    }
    set className(val) {
        this._className = String(val);
        this.classList = new FakeClassList(this._className.split(/\s+/).filter(Boolean));
    }
    append(...nodes) {
        this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
        this.children = [...nodes];
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
        let defaultPrevented = false;
        const evt = {
            preventDefault() {
                defaultPrevented = true;
            },
            stopPropagation() {},
            ...event
        };
        for (const handler of this.listeners.get(type) || []) {
            handler(evt);
        }
        return defaultPrevented;
    }
    focus() {
        this.focused = true;
    }
}

function setupFakeDom() {
    globalThis.document = {
        createElement: (tag) => new FakeElement(tag)
    };
}

test("openSkillPlugin exports expected contract and aliases", () => {
    assert.equal(openSkillPlugin.name, "open");
    assert.equal(openSkillPlugin.panelState, "editor panel");
    assert.equal(renderEditorPanel, renderFallbackOpenPanel);
    assert.equal(typeof EditorPanelView, "function");
    assert.equal(openSkillPlugin.parseArgs("  src/main.py  "), "src/main.py");
});

test("renderEditorPanel renders editor panel with line numbers gutter, filepath, content, Save and Back buttons", () => {
    setupFakeDom();
    const container = new FakeElement("div");
    const panel = openSkillPlugin.renderPanel(
        container,
        {
            filepath: "app/main.py",
            filename: "main.py",
            content: "import os\nprint('hi')\n",
            encoding: "utf-8",
            writable: true
        },
        {}
    );

    assert.equal(container.children.length, 1);
    assert.equal(panel.element, container.children[0]);
    assert.equal(panel.badge.textContent, "editor panel");
    assert.equal(panel.pathLabel.textContent, "app/main.py");
    assert.equal(panel.statusLabel.textContent, "Loaded");
    assert.equal(panel.statusLabel.getAttribute("role"), "status");
    assert.equal(panel.statusLabel.getAttribute("aria-live"), "polite");
    assert.equal(panel.gutter.textContent, "1\n2\n3");
    assert.equal(panel.gutter.getAttribute("aria-hidden"), "true");
    assert.equal(panel.editor.value, "import os\nprint('hi')\n");
    assert.equal(panel.saveButton.disabled, false);
    assert.equal(panel.saveButton.textContent, "Save");
    assert.equal(panel.backButton.textContent, "← Back to Terminal");
    assert.match(panel.metaLabel.textContent, /utf-8/);
    assert.match(panel.metaLabel.textContent, /3 lines/);
});

test("typing in textarea updates line numbers, dirty indicator, and marks status as Modified", () => {
    setupFakeDom();
    const container = new FakeElement("div");
    const panel = renderEditorPanel(
        container,
        {
            filepath: "notes.txt",
            content: "line 1"
        },
        {}
    );

    assert.equal(panel.gutter.textContent, "1");
    assert.equal(panel.statusLabel.textContent, "Loaded");

    panel.editor.value = "line 1\nline 2\nline 3\nline 4";
    panel.editor.dispatch("input");

    assert.equal(panel.gutter.textContent, "1\n2\n3\n4");
    assert.equal(panel.statusLabel.textContent, "Modified");
    assert.equal(panel.isDirty, true);
    assert.equal(panel.pathLabel.textContent, "notes.txt *");
    assert.match(panel.metaLabel.textContent, /4 lines/);

    // Scroll syncs gutter scrollTop
    panel.editor.scrollTop = 48;
    panel.editor.dispatch("scroll");
    assert.equal(panel.gutter.scrollTop, 48);

    // Tab key inserts 4 spaces and marks Modified
    panel.editor.selectionStart = 0;
    panel.editor.selectionEnd = 0;
    const prevented = panel.editor.dispatch("keydown", { key: "Tab" });
    assert.equal(prevented, true);
    assert.ok(panel.editor.value.startsWith("    line 1"));
});

test("clicking Save or pressing Ctrl+S / Cmd+S dispatches write action and updates status through Saving... to Saved", () => {
    setupFakeDom();
    const container = new FakeElement("div");
    const actions = [];
    const panel = renderEditorPanel(
        container,
        {
            filepath: "src/config.py",
            content: "DEBUG = False\n",
            writable: true
        },
        {
            sendSkillAction: (payload) => actions.push(payload)
        }
    );

    panel.editor.value = "DEBUG = True\n";
    panel.editor.dispatch("input");
    assert.equal(panel.statusLabel.textContent, "Modified");

    // Click Save button
    panel.saveButton.dispatch("click");
    assert.equal(panel.statusLabel.textContent, "Saving...");
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0], {
        action: "write",
        args: "src/config.py",
        content: "DEBUG = True\n"
    });

    // Simulate follow-up skill_result
    panel.onSkillResult({
        status: "ok",
        data: { action: "write" }
    });
    assert.equal(panel.statusLabel.textContent, "Saved");
    assert.equal(panel.isDirty, false);
    assert.equal(panel.pathLabel.textContent, "src/config.py");

    // Modify again and save with Ctrl+S
    panel.editor.value = "DEBUG = True\nPORT = 8000\n";
    panel.editor.dispatch("input");
    const ctrlSPrevented = panel.editor.dispatch("keydown", { key: "s", ctrlKey: true });
    assert.equal(ctrlSPrevented, true);
    assert.equal(panel.statusLabel.textContent, "Saving...");
    assert.equal(actions.length, 2);
    assert.deepEqual(actions[1], {
        action: "write",
        args: "src/config.py",
        content: "DEBUG = True\nPORT = 8000\n"
    });

    // Handle error result
    panel.onSkillResult({
        status: "error",
        message: "Disk full"
    });
    assert.equal(panel.statusLabel.textContent, "Disk full");
    assert.equal(panel.statusLabel.classList.contains("has-error"), true);
});

test("clicking Back calls context.onBack and dispose cleans up", () => {
    setupFakeDom();
    const container = new FakeElement("div");
    let backCalled = 0;
    const panel = renderEditorPanel(
        container,
        { filepath: "README.md", content: "# Hello" },
        { onBack: () => { backCalled += 1; } }
    );

    panel.focus();
    assert.equal(panel.editor.focused, true);

    panel.backButton.dispatch("click");
    assert.equal(backCalled, 1);

    panel.dispose();
    assert.equal(container.children.length, 0);
});

test("read-only file (writable: false) disables Save button and sets textarea.readOnly = true", () => {
    setupFakeDom();
    const container = new FakeElement("div");
    const actions = [];
    const panel = renderEditorPanel(
        container,
        {
            filepath: "/etc/hosts",
            content: "127.0.0.1 localhost\n",
            writable: false
        },
        {
            sendSkillAction: (payload) => actions.push(payload)
        }
    );

    assert.equal(panel.saveButton.disabled, true);
    assert.equal(panel.editor.readOnly, true);
    assert.match(panel.metaLabel.textContent, /read-only/);

    panel.saveButton.dispatch("click");
    panel.editor.dispatch("keydown", { key: "s", ctrlKey: true });
    assert.equal(actions.length, 0);
});
