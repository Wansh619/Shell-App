function computeLineCount(text) {
    const content = typeof text === "string" ? text : "";
    if (!content) {
        return 1;
    }
    return content.split("\n").length;
}

function buildLineNumbersText(lineCount) {
    const total = Math.max(1, Number(lineCount) || 1);
    const lines = [];
    for (let i = 1; i <= total; i += 1) {
        lines.push(String(i));
    }
    return lines.join("\n");
}

export class EditorPanelView {
    constructor(container, model = {}, context = {}) {
        this.container = container;
        this.model = model || {};
        this.context = context || {};

        this.filepath =
            this.model.filepath
            || this.model.path
            || this.model.filename
            || this.model.args
            || "Untitled";
        this.filename = this.model.filename || this.filepath;
        this.encoding = this.model.encoding ? String(this.model.encoding) : "utf-8";
        this.writable = this.model.writable !== false;
        this.initialContent = typeof this.model.content === "string" ? this.model.content : "";
        this.isDirty = false;
        this.disposed = false;

        this.element = document.createElement("div");
        this.element.className = "console-editor-panel";
        this.element.dataset.panelState = "editor panel";

        this.toolbar = document.createElement("div");
        this.toolbar.className = "console-skill-toolbar";

        this.badge = document.createElement("span");
        this.badge.className = "console-skill-badge";
        this.badge.dataset.panelState = "editor panel";
        this.badge.textContent = "editor panel";

        this.pathLabel = document.createElement("span");
        this.pathLabel.className = "console-skill-filepath";

        this.metaLabel = document.createElement("span");
        this.metaLabel.className = "console-editor-meta";

        this.statusLabel = document.createElement("span");
        this.statusLabel.className = "console-editor-status console-skill-status";
        this.statusLabel.setAttribute("role", "status");
        this.statusLabel.setAttribute("aria-live", "polite");
        this.statusLabel.textContent = "Loaded";

        this.actions = document.createElement("div");
        this.actions.className = "console-skill-actions";

        this.saveButton = document.createElement("button");
        this.saveButton.type = "button";
        this.saveButton.className = "console-editor-save console-skill-btn console-skill-btn--primary";
        this.saveButton.textContent = "Save";
        this.saveButton.disabled = !this.writable;

        this.backButton = document.createElement("button");
        this.backButton.type = "button";
        this.backButton.className = "console-skill-back console-skill-btn";
        this.backButton.textContent = "← Back to Terminal";

        this.actions.append(this.saveButton, this.backButton);
        this.toolbar.append(
            this.badge,
            this.pathLabel,
            this.metaLabel,
            this.statusLabel,
            this.actions
        );

        this.body = document.createElement("div");
        this.body.className = "console-editor-workspace console-editor-body";

        this.gutter = document.createElement("pre");
        this.gutter.className = "console-editor-gutter console-editor-line-numbers";
        this.gutter.setAttribute("aria-hidden", "true");

        this.editor = document.createElement("textarea");
        this.editor.className = "console-editor-textarea";
        this.editor.setAttribute("aria-label", "File content editor");
        this.editor.setAttribute("spellcheck", "false");
        this.editor.value = this.initialContent;
        this.editor.readOnly = !this.writable;
        if (!this.writable) {
            this.editor.setAttribute("readonly", "true");
        }

        this.body.append(this.gutter, this.editor);
        this.element.append(this.toolbar, this.body);

        this._onInput = () => {
            if (!this.writable) {
                return;
            }
            this.isDirty = this.editor.value !== this.initialContent;
            this._updateLineNumbersAndMeta();
            this._updatePathLabel();
            this.statusLabel.classList?.remove?.("has-error");
            this.statusLabel.textContent = "Modified";
        };

        this._onScroll = () => {
            this.gutter.scrollTop = this.editor.scrollTop || 0;
        };

        this._onKeydown = (event) => {
            const key = String(event?.key || "");
            if ((event?.ctrlKey || event?.metaKey) && key.toLowerCase() === "s") {
                event.preventDefault?.();
                this.save();
                return;
            }
            if (key === "Tab") {
                event.preventDefault?.();
                if (!this.writable) {
                    return;
                }
                const value = this.editor.value ?? "";
                const start =
                    typeof this.editor.selectionStart === "number"
                        ? this.editor.selectionStart
                        : value.length;
                const end =
                    typeof this.editor.selectionEnd === "number"
                        ? this.editor.selectionEnd
                        : start;
                const indent = "    ";
                this.editor.value = `${value.slice(0, start)}${indent}${value.slice(end)}`;
                if (typeof this.editor.selectionStart === "number") {
                    this.editor.selectionStart = start + indent.length;
                    this.editor.selectionEnd = start + indent.length;
                }
                this._onInput();
            }
        };

        this._onSaveClick = () => {
            this.save();
        };

        this._onBackClick = () => {
            this.context.onBack?.();
        };

        this.editor.addEventListener("input", this._onInput);
        this.editor.addEventListener("scroll", this._onScroll);
        this.editor.addEventListener("keydown", this._onKeydown);
        this.saveButton.addEventListener("click", this._onSaveClick);
        this.backButton.addEventListener("click", this._onBackClick);

        this._updatePathLabel();
        this._updateLineNumbersAndMeta();

        if (this.container?.replaceChildren) {
            this.container.replaceChildren(this.element);
        } else if (this.container?.append) {
            this.container.append(this.element);
        }
    }

    _updatePathLabel() {
        const displayPath = this.filepath || "Untitled";
        this.pathLabel.textContent = this.isDirty ? `${displayPath} *` : displayPath;
        this.pathLabel.dataset.dirty = String(this.isDirty);
    }

    _updateLineNumbersAndMeta() {
        const lineCount = computeLineCount(this.editor.value);
        this.gutter.textContent = buildLineNumbersText(lineCount);
        const lineLabel = `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
        const parts = [this.encoding, lineLabel];
        if (!this.writable) {
            parts.push("read-only");
        }
        this.metaLabel.textContent = parts.join(" • ");
    }

    save() {
        if (!this.writable) {
            return false;
        }
        this.statusLabel.classList?.remove?.("has-error");
        this.statusLabel.textContent = "Saving...";
        const targetPath =
            this.model.filepath
            || this.model.path
            || this.model.args
            || this.filepath
            || "";
        this.context.sendSkillAction?.({
            action: "write",
            args: targetPath,
            content: this.editor.value
        });
        return true;
    }

    onSkillResult(message) {
        if (!message || typeof message !== "object") {
            return;
        }
        if (message.status === "error") {
            this.showError(message.message || "Save failed");
            return;
        }
        const action = message.action || message.data?.action;
        if (action === "write" || message.data?.saved || message.status === "ok") {
            if (typeof message.data?.content === "string" && action === "read") {
                this.initialContent = message.data.content;
                this.editor.value = message.data.content;
                this.isDirty = false;
                this._updatePathLabel();
                this._updateLineNumbersAndMeta();
                this.statusLabel.classList?.remove?.("has-error");
                this.statusLabel.textContent = "Loaded";
                return;
            }
            this.initialContent = this.editor.value;
            this.isDirty = false;
            this._updatePathLabel();
            this._updateLineNumbersAndMeta();
            this.statusLabel.classList?.remove?.("has-error");
            this.statusLabel.textContent = "Saved";
        }
    }

    showError(errorMessage) {
        this.statusLabel.textContent = errorMessage || "Operation failed";
        this.statusLabel.classList?.add?.("has-error");
    }

    focus() {
        this.editor.focus?.();
    }

    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.editor.removeEventListener?.("input", this._onInput);
        this.editor.removeEventListener?.("scroll", this._onScroll);
        this.editor.removeEventListener?.("keydown", this._onKeydown);
        this.saveButton.removeEventListener?.("click", this._onSaveClick);
        this.backButton.removeEventListener?.("click", this._onBackClick);
        this.container?.replaceChildren?.();
    }
}

export function renderEditorPanel(container, model = {}, context = {}) {
    return new EditorPanelView(container, model, context);
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
        return renderEditorPanel(container, model, context);
    }
};

export { renderEditorPanel as renderFallbackOpenPanel };
export default openSkillPlugin;
