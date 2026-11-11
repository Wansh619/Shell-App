import test from "node:test";
import assert from "node:assert/strict";
import imageSkillPlugin, {
    renderImagePanel,
    renderFallbackImagePanel,
    formatBytes
} from "./plugin.js";

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
        this.src = "";
        this.alt = "";
        this.title = "";
        this.naturalWidth = 0;
        this.naturalHeight = 0;
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
        for (const handler of this.listeners.get(type) || []) {
            handler({
                preventDefault() {},
                stopPropagation() {},
                ...event
            });
        }
    }
    focus() {
        this.focused = true;
    }
    findByClass(className) {
        if (
            this.classList.contains(className)
            || String(this.className || "").split(/\s+/).includes(className)
        ) {
            return this;
        }
        for (const child of this.children) {
            const match = child.findByClass?.(className);
            if (match) {
                return match;
            }
        }
        return null;
    }
}

function setupFakeDom() {
    globalThis.document = {
        createElement: (tag) => new FakeElement(tag)
    };
}

test("imageSkillPlugin exports contract and formatBytes formats byte sizes", () => {
    assert.equal(imageSkillPlugin.name, "image");
    assert.equal(imageSkillPlugin.panelState, "image panel");
    assert.equal(renderImagePanel, renderFallbackImagePanel);
    assert.equal(imageSkillPlugin.parseArgs("  static/images/logo.png  "), "static/images/logo.png");

    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(-5), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(1048576), "1.0 MB");
});

test("renderImagePanel renders image panel with src, filename, MIME type, byte size, and dimensions", () => {
    setupFakeDom();
    const container = new FakeElement("div");

    const controller = imageSkillPlugin.renderPanel(
        container,
        {
            filepath: "/workspace/static/images/banner.png",
            filename: "banner.png",
            mime_type: "image/png",
            size_bytes: 2048,
            width: 640,
            height: 480,
            data_url: "data:image/png;base64,iVBORw0KGgo="
        },
        {}
    );

    assert.equal(container.children.length, 1);
    const panel = container.children[0];
    assert.ok(panel.classList.contains("console-image-panel"));

    const badge = panel.findByClass("console-skill-badge");
    assert.equal(badge.textContent, "image panel");
    assert.equal(badge.dataset.panelState, "image panel");

    const filepath = panel.findByClass("console-skill-filepath");
    assert.equal(filepath.textContent, "banner.png");
    assert.equal(filepath.title, "/workspace/static/images/banner.png");

    const meta = panel.findByClass("console-image-meta");
    assert.equal(meta.textContent, "image/png • 2.0 KB • 640×480");

    const img = panel.findByClass("console-image-preview");
    assert.equal(img.src, "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(img.hidden, false);

    // Updating dimensions on image load when not initially provided
    const container2 = new FakeElement("div");
    const controller2 = renderImagePanel(container2, {
        filename: "vector.svg",
        mime_type: "image/svg+xml",
        size_bytes: 512,
        raw_url: "/raw/vector.svg"
    });
    assert.equal(controller2.metaLabel.textContent, "image/svg+xml • 512 B");
    controller2.image.naturalWidth = 300;
    controller2.image.naturalHeight = 150;
    controller2.image.dispatch("load");
    assert.equal(controller2.metaLabel.textContent, "image/svg+xml • 512 B • 300×150");
    assert.equal(controller.getZoom(), 1.0);
});

test("Zoom In, Zoom Out, Reset, and Fit toggle buttons update zoom level and fit state accurately", () => {
    setupFakeDom();
    const container = new FakeElement("div");
    const controller = renderImagePanel(container, {
        filename: "photo.jpg",
        mime_type: "image/jpeg",
        size_bytes: 4096,
        url: "https://example.com/photo.jpg"
    });

    const {
        element,
        image,
        fitButton,
        zoomOutButton,
        zoomResetButton,
        zoomInButton
    } = controller;

    // Initial state: Fit active ("contain"), 100% zoom
    assert.equal(fitButton.dataset.fit, "contain");
    assert.equal(element.dataset.fit, "contain");
    assert.ok(fitButton.classList.contains("is-active"));
    assert.equal(fitButton.getAttribute("aria-pressed"), "true");
    assert.equal(zoomResetButton.textContent, "100%");
    assert.equal(controller.getZoom(), 1.0);

    // Zoom In (+) -> 125%, exits contain fit mode
    zoomInButton.dispatch("click");
    assert.equal(controller.getZoom(), 1.25);
    assert.equal(zoomResetButton.textContent, "125%");
    assert.equal(image.style.transform, "scale(1.25)");
    assert.equal(image.style.width, "125%");
    assert.equal(fitButton.dataset.fit, "actual");
    assert.equal(fitButton.classList.contains("is-active"), false);
    assert.equal(fitButton.getAttribute("aria-pressed"), "false");

    // Zoom Out (−) twice -> 100% then 75%
    zoomOutButton.dispatch("click");
    assert.equal(controller.getZoom(), 1.0);
    assert.equal(zoomResetButton.textContent, "100%");

    zoomOutButton.dispatch("click");
    assert.equal(controller.getZoom(), 0.75);
    assert.equal(zoomResetButton.textContent, "75%");
    assert.equal(image.style.transform, "scale(0.75)");

    // Clamp at min zoom (0.25)
    for (let i = 0; i < 10; i += 1) {
        zoomOutButton.dispatch("click");
    }
    assert.equal(controller.getZoom(), 0.25);
    assert.equal(zoomResetButton.textContent, "25%");
    assert.equal(zoomOutButton.disabled, true);

    // Reset (100%) -> restores 1.0 zoom
    zoomResetButton.dispatch("click");
    assert.equal(controller.getZoom(), 1.0);
    assert.equal(zoomResetButton.textContent, "100%");
    assert.equal(zoomOutButton.disabled, false);

    // Clamp at max zoom (4.0)
    for (let i = 0; i < 20; i += 1) {
        zoomInButton.dispatch("click");
    }
    assert.equal(controller.getZoom(), 4.0);
    assert.equal(zoomResetButton.textContent, "400%");
    assert.equal(zoomInButton.disabled, true);

    // Clicking Fit toggles back to "contain" and resets zoom to 100%
    fitButton.dispatch("click");
    assert.equal(fitButton.dataset.fit, "contain");
    assert.equal(element.dataset.fit, "contain");
    assert.ok(fitButton.classList.contains("is-active"));
    assert.equal(controller.getZoom(), 1.0);
    assert.equal(zoomResetButton.textContent, "100%");
    assert.equal(image.style.objectFit, "contain");

    // Clicking Fit again toggles off "contain" to "actual"
    fitButton.dispatch("click");
    assert.equal(fitButton.dataset.fit, "actual");
    assert.equal(fitButton.classList.contains("is-active"), false);
    assert.equal(image.style.objectFit, "none");
});

test("Missing image URL, img.onerror, onSkillResult error, or showError displays error state with .has-error", () => {
    setupFakeDom();
    const container = new FakeElement("div");

    // 1. Missing image source URL
    const controller = renderImagePanel(container, {
        filename: "missing.png",
        mime_type: "image/png"
    });
    const status = controller.element.findByClass("console-image-status");
    assert.ok(status.classList.contains("has-error"));
    assert.equal(status.getAttribute("role"), "status");
    assert.ok(status.textContent.length > 0);
    assert.equal(controller.image.hidden, true);

    // 2. Recover via onSkillResult with valid data
    controller.onSkillResult({
        status: "ok",
        data: {
            data_url: "data:image/png;base64,AAAA",
            size_bytes: 1024
        }
    });
    assert.equal(status.classList.contains("has-error"), false);
    assert.equal(controller.image.hidden, false);
    assert.equal(controller.image.src, "data:image/png;base64,AAAA");

    // 3. Explicit showError
    controller.showError("Corrupted image file");
    assert.ok(status.classList.contains("has-error"));
    assert.equal(status.textContent, "Corrupted image file");
    assert.equal(controller.image.hidden, true);

    // 4. onSkillResult error payload
    controller.onSkillResult({
        status: "error",
        message: "Permission denied reading image"
    });
    assert.ok(status.classList.contains("has-error"));
    assert.equal(status.textContent, "Permission denied reading image");

    // 5. Image onerror handler
    const container2 = new FakeElement("div");
    const controller2 = renderImagePanel(container2, {
        filename: "broken.png",
        url: "/broken.png"
    });
    assert.equal(controller2.statusLabel.classList.contains("has-error"), false);
    controller2.image.dispatch("error");
    assert.ok(controller2.statusLabel.classList.contains("has-error"));
    assert.match(controller2.statusLabel.textContent, /broken\.png/);
    assert.equal(controller2.image.hidden, true);
});

test("Back button invokes context.onBack() and lifecycle methods focus/dispose work", () => {
    setupFakeDom();
    const container = new FakeElement("div");
    let backCalled = 0;

    const controller = renderImagePanel(
        container,
        {
            filename: "preview.png",
            data_url: "data:image/png;base64,AAAA"
        },
        {
            onBack: () => {
                backCalled += 1;
            }
        }
    );

    const backButton = controller.element.findByClass("console-skill-back");
    assert.ok(backButton);

    controller.focus();
    assert.equal(backButton.focused, true);

    backButton.dispatch("click");
    assert.equal(backCalled, 1);

    controller.dispose();
    assert.equal(container.children.length, 0);
});
