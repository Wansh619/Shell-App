export const THEME_STORAGE_KEY = "shell-app-theme";
export const DEFAULT_THEME = "dark";

export const THEMES = {
    dark: { name: "dark", label: "Dark", mode: "dark" },
    light: { name: "light", label: "Light", mode: "light" },
    cyberpunk: { name: "cyberpunk", label: "Cyberpunk", mode: "dark" },
    ocean: { name: "ocean", label: "Ocean", mode: "dark" },
    sage: { name: "sage", label: "Sage", mode: "dark" },
    ember: { name: "ember", label: "Ember", mode: "dark" },
};

export function getThemes() {
    return Object.values(THEMES);
}

export function isValidTheme(themeName) {
    return Boolean(
        typeof themeName === "string" &&
        Object.prototype.hasOwnProperty.call(THEMES, themeName)
    );
}

export function getThemeConfig(themeName) {
    return isValidTheme(themeName) ? THEMES[themeName] : THEMES[DEFAULT_THEME];
}

export function registerTheme(name, { label, mode = "dark" } = {}) {
    if (typeof name !== "string" || !name.trim()) {
        throw new TypeError("Theme name must be a non-empty string.");
    }
    const key = name.trim();
    const resolvedMode = mode === "light" ? "light" : "dark";
    const resolvedLabel = label || key.charAt(0).toUpperCase() + key.slice(1);
    THEMES[key] = {
        name: key,
        label: resolvedLabel,
        mode: resolvedMode,
    };
    return THEMES[key];
}

export function getTheme(root = document.documentElement) {
    const attrTheme = root?.dataset?.theme || root?.getAttribute?.("data-theme");
    if (isValidTheme(attrTheme)) {
        return attrTheme;
    }
    return root?.classList?.contains?.("dark") ? "dark" : "light";
}

export function applyTheme(root, theme) {
    const resolved = getThemeConfig(theme);
    if (root) {
        if (root.dataset) {
            root.dataset.theme = resolved.name;
        }
        root.setAttribute?.("data-theme", resolved.name);
        root.classList?.toggle("dark", resolved.mode === "dark");
        root.classList?.toggle("light", resolved.mode === "light");
    }
    return resolved.name;
}

export function setTheme(root, theme) {
    const nextTheme = applyTheme(root, theme);
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    return nextTheme;
}

export function initializeTheme(root = document.documentElement) {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    const theme = isValidTheme(savedTheme) ? savedTheme : DEFAULT_THEME;
    applyTheme(root, theme);

    window.addEventListener("storage", (event) => {
        if (event.key === THEME_STORAGE_KEY && event.newValue) {
            applyTheme(root, event.newValue);
        }
    });

    return theme;
}

export function toggleTheme(root = document.documentElement) {
    const themes = getThemes();
    const current = getTheme(root);
    const idx = themes.findIndex((t) => t.name === current);
    const nextTheme = themes[(idx + 1) % themes.length]?.name || DEFAULT_THEME;
    return setTheme(root, nextTheme);
}
