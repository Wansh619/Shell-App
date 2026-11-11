export function renderFallbackOpenPanel(container, data = {}, context = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = "console-editor-panel";

    const toolbar = document.createElement("div");
    toolbar.className = "console-skill-toolbar";

    const pathLabel = document.createElement("span");
    pathLabel.className = "console-skill-filepath";
    pathLabel.textContent = data?.path || data?.args || "Untitled";

    const statusLabel = document.createElement("span");
    statusLabel.className = "console-skill-status";
    statusLabel.setAttribute("role", "status");
    statusLabel.setAttribute("aria-live", "polite");
    statusLabel.textContent = data?.language ? String(data.language) : "text";

    const actions = document.createElement("div");
    actions.className = "console-skill-actions";

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "console-skill-btn console-skill-btn--primary";
    saveButton.textContent = "Save";

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "console-skill-btn";
    backButton.textContent = "Back to Terminal";
    backButton.addEventListener("click", () => context.onBack?.());

    const editor = document.createElement("textarea");
    editor.className = "console-editor-textarea";
    editor.setAttribute("aria-label", "File content editor");
    editor.setAttribute("spellcheck", "false");
    editor.value = typeof data?.content === "string" ? data.content : "";

    saveButton.addEventListener("click", () => {
        statusLabel.textContent = "Saving...";
        statusLabel.classList.remove("has-error");
        context.sendSkillAction?.({
            skill: "open",
            action: "write",
            args: data?.path || data?.args || "",
            content: editor.value
        });
    });

    actions.append(saveButton, backButton);
    toolbar.append(pathLabel, statusLabel, actions);
    wrapper.append(toolbar, editor);
    container.replaceChildren(wrapper);

    return {
        element: wrapper,
        editor,
        onSkillResult(message) {
            if (message?.status === "error") {
                statusLabel.textContent = message.message || "Save failed";
                statusLabel.classList.add("has-error");
                return;
            }
            if (message?.action === "write" || message?.data?.saved) {
                statusLabel.textContent = "Saved";
                statusLabel.classList.remove("has-error");
            } else if (typeof message?.data?.content === "string") {
                editor.value = message.data.content;
                statusLabel.textContent = "Loaded";
                statusLabel.classList.remove("has-error");
            }
        },
        showError(errorMessage) {
            statusLabel.textContent = errorMessage || "Operation failed";
            statusLabel.classList.add("has-error");
        },
        focus() {
            editor.focus?.();
        },
        dispose() {
            container.replaceChildren();
        }
    };
}

export const openSkillPlugin = {
    name: "open",
    panelState: "editor panel",
    label: "Open File",
    placeholder: "Enter file path to open (e.g. app.py)",
    parseArgs(rawInput) {
        return String(rawInput ?? "").trim();
    },
    renderPanel(container, model, context) {
        return renderFallbackOpenPanel(container, model, context);
    }
};

export default openSkillPlugin;
