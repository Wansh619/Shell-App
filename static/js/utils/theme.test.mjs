import test from "node:test";
import assert from "node:assert/strict";
import {
    THEME_STORAGE_KEY,
    DEFAULT_THEME,
    THEMES,
    getThemes,
    getThemeConfig,
    isValidTheme,
    registerTheme,
    getTheme,
    applyTheme,
    setTheme,
    initializeTheme,
    toggleTheme,
} from "./theme.js";

function createFakeRoot(initialClasses = ["dark"], initialDataTheme = undefined) {
    const classSet = new Set(initialClasses);
    const attributes = new Map();
    const dataset = {};
    if (initialDataTheme !== undefined) {
        dataset.theme = initialDataTheme;
        attributes.set("data-theme", initialDataTheme);
    }

    return {
        dataset,
        classList: {
            contains(cls) {
                return classSet.has(cls);
            },
            toggle(cls, force) {
                if (force === undefined) {
                    if (classSet.has(cls)) {
                        classSet.delete(cls);
                        return false;
                    }
                    classSet.add(cls);
                    return true;
                }
                if (force) {
                    classSet.add(cls);
                } else {
                    classSet.delete(cls);
                }
                return Boolean(force);
            },
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
            if (name === "data-theme") {
                dataset.theme = String(value);
            }
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        },
    };
}

function setupEnvironment(initialSavedTheme = null) {
    const store = new Map();
    if (initialSavedTheme !== null) {
        store.set(THEME_STORAGE_KEY, initialSavedTheme);
    }
    const listeners = new Map();
    const root = createFakeRoot(["dark"], "dark");

    globalThis.localStorage = {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
    };

    globalThis.document = {
        documentElement: root,
    };

    globalThis.window = {
        addEventListener(type, listener) {
            const list = listeners.get(type) || [];
            list.push(listener);
            listeners.set(type, list);
        },
        dispatchStorage(event) {
            for (const fn of listeners.get("storage") || []) {
                fn(event);
            }
        },
    };

    return { root, store, window: globalThis.window };
}

test("initializeTheme defaults to dark and respects saved valid named themes", () => {
    const { root: defaultRoot } = setupEnvironment(null);
    assert.equal(initializeTheme(defaultRoot), DEFAULT_THEME);
    assert.equal(defaultRoot.dataset.theme, "dark");
    assert.equal(defaultRoot.getAttribute("data-theme"), "dark");
    assert.equal(defaultRoot.classList.contains("dark"), true);
    assert.equal(defaultRoot.classList.contains("light"), false);

    const { root: invalidRoot } = setupEnvironment("non-existent-theme");
    assert.equal(initializeTheme(invalidRoot), "dark");
    assert.equal(invalidRoot.dataset.theme, "dark");

    for (const saved of ["cyberpunk", "ocean", "sage", "ember", "light", "dark"]) {
        const { root, window } = setupEnvironment(saved);
        const active = initializeTheme(root);
        const expectedMode = getThemeConfig(saved).mode;
        assert.equal(active, saved);
        assert.equal(root.dataset.theme, saved);
        assert.equal(root.getAttribute("data-theme"), saved);
        assert.equal(root.classList.contains("dark"), expectedMode === "dark");
        assert.equal(root.classList.contains("light"), expectedMode === "light");

        window.dispatchStorage({ key: THEME_STORAGE_KEY, newValue: "ocean" });
        assert.equal(root.dataset.theme, "ocean");
        assert.equal(root.classList.contains("dark"), true);
    }
});

test("setTheme sets data-theme and .dark/.light classes properly and falls back to dark for unknown names", () => {
    const { root, store } = setupEnvironment();

    assert.equal(setTheme(root, "light"), "light");
    assert.equal(root.dataset.theme, "light");
    assert.equal(root.getAttribute("data-theme"), "light");
    assert.equal(root.classList.contains("light"), true);
    assert.equal(root.classList.contains("dark"), false);
    assert.equal(store.get(THEME_STORAGE_KEY), "light");

    for (const darkPalette of ["cyberpunk", "ocean", "sage", "ember", "dark"]) {
        assert.equal(setTheme(root, darkPalette), darkPalette);
        assert.equal(root.dataset.theme, darkPalette);
        assert.equal(root.getAttribute("data-theme"), darkPalette);
        assert.equal(root.classList.contains("dark"), true);
        assert.equal(root.classList.contains("light"), false);
        assert.equal(store.get(THEME_STORAGE_KEY), darkPalette);
        assert.equal(getTheme(root), darkPalette);
    }

    assert.equal(setTheme(root, "unknown-palette"), "dark");
    assert.equal(root.dataset.theme, "dark");
    assert.equal(root.classList.contains("dark"), true);
    assert.equal(root.classList.contains("light"), false);
    assert.equal(store.get(THEME_STORAGE_KEY), "dark");
});

test("toggleTheme cycles through all registered themes in order", () => {
    const { root, store } = setupEnvironment("dark");
    initializeTheme(root);

    const expectedOrder = ["light", "cyberpunk", "ocean", "sage", "ember", "dark"];
    for (const expected of expectedOrder) {
        const next = toggleTheme(root);
        assert.equal(next, expected);
        assert.equal(root.dataset.theme, expected);
        assert.equal(store.get(THEME_STORAGE_KEY), expected);
        const mode = getThemeConfig(expected).mode;
        assert.equal(root.classList.contains("dark"), mode === "dark");
        assert.equal(root.classList.contains("light"), mode === "light");
    }
});

test("registerTheme allows registering a new named palette and cycling through it", () => {
    const { root } = setupEnvironment("ember");
    initializeTheme(root);

    try {
        const solar = registerTheme("solar", { label: "Solar", mode: "light" });
        assert.deepEqual(solar, { name: "solar", label: "Solar", mode: "light" });
        assert.equal(isValidTheme("solar"), true);
        assert.equal(getThemes().some((t) => t.name === "solar"), true);

        const next = toggleTheme(root);
        assert.equal(next, "solar");
        assert.equal(root.dataset.theme, "solar");
        assert.equal(root.classList.contains("light"), true);
        assert.equal(root.classList.contains("dark"), false);

        const wrapped = toggleTheme(root);
        assert.equal(wrapped, "dark");
        assert.equal( applyTheme(root, "solar"), "solar");
    } finally {
        delete THEMES.solar;
    }
});
