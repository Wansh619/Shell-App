export function renderFallbackImagePanel(container, data = {}, context = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = "console-image-panel";

    const toolbar = document.createElement("div");
    toolbar.className = "console-skill-toolbar";

    const pathLabel = document.createElement("span");
    pathLabel.className = "console-skill-filepath";
    pathLabel.textContent = data?.path || data?.name || data?.args || "Image Preview";

    const metaLabel = document.createElement("span");
    metaLabel.className = "console-skill-status";
    const metaParts = [];
    if (data?.mime_type) {
        metaParts.push(data.mime_type);
    }
    if (typeof data?.size_bytes === "number") {
        metaParts.push(`${data.size_bytes} B`);
    }
    metaLabel.textContent = metaParts.join(" • ") || "image";

    const actions = document.createElement("div");
    actions.className = "console-skill-actions";

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "console-skill-btn";
    backButton.textContent = "Back to Terminal";
    backButton.addEventListener("click", () => context.onBack?.());

    actions.append(backButton);
    toolbar.append(pathLabel, metaLabel, actions);

    const stage = document.createElement("div");
    stage.className = "console-image-stage";

    const img = document.createElement("img");
    img.className = "console-image-preview";
    img.alt = data?.name || data?.path || "Skill image preview";
    if (data?.data_url) {
        img.src = data.data_url;
    } else if (data?.content_base64 && data?.mime_type) {
        img.src = `data:${data.mime_type};base64,${data.content_base64}`;
    } else if (data?.url || data?.src) {
        img.src = data.url || data.src;
    }

    stage.append(img);
    wrapper.append(toolbar, stage);
    container.replaceChildren(wrapper);

    return {
        element: wrapper,
        image: img,
        onSkillResult(message) {
            if (message?.status === "error") {
                metaLabel.textContent = message.message || "Failed to load image";
                metaLabel.classList.add("has-error");
                return;
            }
            const nextData = message?.data || {};
            if (nextData.data_url) {
                img.src = nextData.data_url;
            } else if (nextData.content_base64 && nextData.mime_type) {
                img.src = `data:${nextData.mime_type};base64,${nextData.content_base64}`;
            }
        },
        showError(errorMessage) {
            metaLabel.textContent = errorMessage || "Failed to load image";
            metaLabel.classList.add("has-error");
        },
        focus() {
            backButton.focus?.();
        },
        dispose() {
            container.replaceChildren();
        }
    };
}

export const imageSkillPlugin = {
    name: "image",
    panelState: "image panel",
    label: "View Image",
    placeholder: "Enter image path to preview (e.g. static/images/favicon.svg)",
    parseArgs(rawInput) {
        return String(rawInput ?? "").trim();
    },
    renderPanel(container, model, context) {
        return renderFallbackImagePanel(container, model, context);
    }
};

export default imageSkillPlugin;
