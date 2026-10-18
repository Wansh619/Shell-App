const THEME_STORAGE_KEY = "shell-app-theme";

export function applyTheme(root, theme) {
    root.classList.toggle("dark", theme === "dark");
}

export function setTheme(root, theme) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    applyTheme(root, nextTheme);
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    return nextTheme;
}

export function initializeTheme(root = document.documentElement) {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    const theme = savedTheme === "light" || savedTheme === "dark"
        ? savedTheme
        : "dark";
    applyTheme(root, theme);

    window.addEventListener("storage", (event) => {
        if (event.key === THEME_STORAGE_KEY && event.newValue) {
            applyTheme(root, event.newValue);
        }
    });

    return theme;
}

export function toggleTheme(root = document.documentElement) {
    const nextTheme = root.classList.contains("dark") ? "light" : "dark";
    return setTheme(root, nextTheme);
}
