const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4.0;
const ZOOM_STEP = 0.25;
const DEFAULT_BFS_COLS = 10;
const DEFAULT_BFS_ROWS = 8;
const BFS_DEPTH_DELAY_MS = 85;
const BFS_INDEX_DELAY_MS = 18;
const BFS_CELL_DURATION_MS = 480;

function createElement(tagName, ...classNames) {
    const element = document.createElement(tagName);
    if (classNames.length > 0) {
        element.className = classNames.join(" ");
        element.classList?.add?.(...classNames);
    }
    return element;
}

function setStyleProperty(element, property, value) {
    if (!element?.style) {
        return;
    }
    if (typeof element.style.setProperty === "function") {
        element.style.setProperty(property, value);
    }
    element.style[property] = value;
}

export function bfsSquareOrder(rows = DEFAULT_BFS_ROWS, cols = DEFAULT_BFS_COLS) {
    const totalRows = Math.max(1, Math.floor(Number(rows) || DEFAULT_BFS_ROWS));
    const totalCols = Math.max(1, Math.floor(Number(cols) || DEFAULT_BFS_COLS));
    const visited = Array.from({ length: totalRows }, () =>
        Array(totalCols).fill(false)
    );
    const order = [];
    const queue = [[0, 0, 0]];
    visited[0][0] = true;

    // Left-to-right priority neighbors so the BFS wavefront sweeps left -> right then top -> bottom
    const deltas = [
        [0, 1],
        [1, 0],
        [1, 1],
        [0, -1],
        [-1, 0]
    ];

    while (queue.length > 0) {
        const [r, c, depth] = queue.shift();
        order.push({ r, c, depth, index: order.length });

        for (const [dr, dc] of deltas) {
            const nr = r + dr;
            const nc = c + dc;
            if (
                nr >= 0
                && nr < totalRows
                && nc >= 0
                && nc < totalCols
                && !visited[nr][nc]
            ) {
                visited[nr][nc] = true;
                queue.push([nr, nc, depth + 1]);
            }
        }
    }

    return order;
}

export function formatBytes(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
        return "0 B";
    }
    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function resolveImageSource(model = {}) {
    if (!model || typeof model !== "object") {
        return "";
    }
    if (model.data_url) {
        return String(model.data_url);
    }
    if (model.raw_url) {
        return String(model.raw_url);
    }
    if (model.url) {
        return String(model.url);
    }
    if (model.content_base64 && model.mime_type) {
        return `data:${model.mime_type};base64,${model.content_base64}`;
    }
    if (model.src) {
        return String(model.src);
    }
    return "";
}

function resolveDisplayName(model = {}) {
    if (!model || typeof model !== "object") {
        return "Image Preview";
    }
    return (
        model.filename
        || model.filepath
        || model.path
        || model.name
        || model.args
        || "Image Preview"
    );
}

export function renderImagePanel(container, model = {}, context = {}) {
    let currentModel = { ...(model || {}) };
    let zoom = 1.0;
    let fitMode = "contain";

    const wrapper = createElement("div", "console-image-panel");
    wrapper.dataset.fit = fitMode;
    wrapper.dataset.zoom = String(zoom);

    const toolbar = createElement("div", "console-skill-toolbar");

    const badge = createElement("span", "console-skill-badge");
    badge.dataset.panelState = "image panel";
    badge.textContent = "image panel";

    const pathLabel = createElement("span", "console-skill-filepath");

    const metaLabel = createElement("span", "console-image-meta");

    const controls = createElement("div", "console-image-controls");

    const fitButton = createElement("button", "console-skill-btn", "console-image-fit", "is-active");
    fitButton.type = "button";
    fitButton.dataset.fit = fitMode;
    fitButton.setAttribute("aria-pressed", "true");
    fitButton.setAttribute("aria-label", "Toggle fit to pane");
    fitButton.textContent = "Fit";

    const zoomOutButton = createElement("button", "console-skill-btn", "console-image-zoom-out");
    zoomOutButton.type = "button";
    zoomOutButton.setAttribute("aria-label", "Zoom out");
    zoomOutButton.textContent = "−";

    const zoomResetButton = createElement("button", "console-skill-btn", "console-image-zoom-reset");
    zoomResetButton.type = "button";
    zoomResetButton.setAttribute("aria-label", "Reset zoom");
    zoomResetButton.textContent = "100%";

    const zoomInButton = createElement("button", "console-skill-btn", "console-image-zoom-in");
    zoomInButton.type = "button";
    zoomInButton.setAttribute("aria-label", "Zoom in");
    zoomInButton.textContent = "+";

    controls.append(fitButton, zoomOutButton, zoomResetButton, zoomInButton);

    const statusLabel = createElement("span", "console-skill-status", "console-image-status");
    statusLabel.setAttribute("role", "status");
    statusLabel.setAttribute("aria-live", "polite");

    const actions = createElement("div", "console-skill-actions");

    const backButton = createElement("button", "console-skill-btn", "console-skill-back");
    backButton.type = "button";
    backButton.textContent = "Back";

    actions.append(backButton);
    toolbar.append(badge, pathLabel, metaLabel, controls, statusLabel, actions);

    const stage = createElement("div", "console-image-stage");
    stage.dataset.fit = fitMode;

    const frame = createElement("div", "console-image-frame");
    const img = createElement("img", "console-image-preview");
    const bfsGrid = createElement("div", "console-image-bfs-grid");
    bfsGrid.setAttribute("aria-hidden", "true");
    bfsGrid.hidden = true;
    let bfsTimer = null;

    function clearBfsTimer() {
        if (bfsTimer !== null) {
            clearTimeout(bfsTimer);
            bfsTimer = null;
        }
    }

    function startBfsReveal(cols = currentModel.bfsCols, rows = currentModel.bfsRows) {
        clearBfsTimer();
        const gridCols = Math.max(1, Math.floor(Number(cols) || DEFAULT_BFS_COLS));
        const gridRows = Math.max(1, Math.floor(Number(rows) || DEFAULT_BFS_ROWS));

        setStyleProperty(bfsGrid, "--bfs-cols", String(gridCols));
        setStyleProperty(bfsGrid, "--bfs-rows", String(gridRows));
        bfsGrid.dataset.cols = String(gridCols);
        bfsGrid.dataset.rows = String(gridRows);

        const cellsMatrix = Array.from({ length: gridRows }, (_, r) =>
            Array.from({ length: gridCols }, (__, c) => {
                const cell = createElement("div", "console-image-bfs-cell");
                cell.dataset.row = String(r);
                cell.dataset.col = String(c);
                return cell;
            })
        );

        const bfsOrder = bfsSquareOrder(gridRows, gridCols);
        let maxDelayMs = 0;

        for (const { r, c, depth, index } of bfsOrder) {
            const cell = cellsMatrix[r][c];
            const delayMs = Math.round(depth * BFS_DEPTH_DELAY_MS + index * BFS_INDEX_DELAY_MS);
            if (delayMs > maxDelayMs) {
                maxDelayMs = delayMs;
            }
            cell.dataset.bfsIndex = String(index);
            cell.dataset.bfsDepth = String(depth);
            setStyleProperty(cell, "--bfs-delay", `${delayMs}ms`);
            setStyleProperty(cell, "--bfs-duration", `${BFS_CELL_DURATION_MS}ms`);
            cell.classList.add("console-image-bfs-cell--reveal");
        }

        const flatCells = cellsMatrix.flat();
        bfsGrid.replaceChildren(...flatCells);
        bfsGrid.hidden = false;
        bfsGrid.classList.remove("is-complete");
        bfsGrid.classList.add("is-animating");

        const totalDurationMs = maxDelayMs + BFS_CELL_DURATION_MS + 120;
        bfsTimer = setTimeout(() => {
            bfsTimer = null;
            bfsGrid.classList.remove("is-animating");
            bfsGrid.classList.add("is-complete");
            bfsGrid.hidden = true;
        }, totalDurationMs);

        return bfsOrder;
    }

    function updateMetadata() {
        const displayName = resolveDisplayName(currentModel);
        pathLabel.textContent = displayName;
        pathLabel.title = currentModel.filepath || currentModel.path || displayName;

        const parts = [];
        if (currentModel.mime_type) {
            parts.push(String(currentModel.mime_type));
        }
        if (typeof currentModel.size_bytes === "number" && Number.isFinite(currentModel.size_bytes)) {
            parts.push(formatBytes(currentModel.size_bytes));
        }
        const width = Number(currentModel.width);
        const height = Number(currentModel.height);
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
            parts.push(`${width}×${height}`);
        }
        metaLabel.textContent = parts.join(" • ") || "image";
    }

    function applyZoomAndFit() {
        const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(zoom.toFixed(2))));
        zoom = clampedZoom;
        const percentText = `${Math.round(zoom * 100)}%`;

        wrapper.dataset.zoom = String(zoom);
        wrapper.dataset.fit = fitMode;
        stage.dataset.fit = fitMode;
        fitButton.dataset.fit = fitMode;
        img.dataset.zoom = String(zoom);
        img.dataset.fit = fitMode;

        const isFit = fitMode === "contain";
        fitButton.classList.toggle("is-active", isFit);
        fitButton.setAttribute("aria-pressed", String(isFit));

        zoomResetButton.textContent = percentText;
        zoomOutButton.disabled = zoom <= MIN_ZOOM;
        zoomInButton.disabled = zoom >= MAX_ZOOM;

        const width = Number(currentModel.width);
        const height = Number(currentModel.height);
        const hasDimensions =
            Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
        const isSvg =
            String(currentModel.mime_type || "").includes("svg")
            || String(currentModel.filename || currentModel.filepath || "").toLowerCase().endsWith(".svg");

        img.style.transform = `scale(${zoom})`;
        if (isFit && zoom === 1) {
            img.style.objectFit = "contain";
            img.style.maxWidth = "100%";
            img.style.maxHeight = "100%";
            if (isSvg) {
                img.style.width = hasDimensions ? `${Math.max(width, 280)}px` : "320px";
                img.style.height = hasDimensions ? `${Math.max(height, 280)}px` : "320px";
            } else {
                img.style.width = "";
                img.style.height = "";
            }
        } else {
            img.style.objectFit = "none";
            img.style.maxWidth = "none";
            img.style.maxHeight = "none";
            img.style.width = percentText;
            img.style.height = "";
        }
    }

    function clearError() {
        statusLabel.textContent = "";
        statusLabel.classList.remove("has-error");
        wrapper.classList.remove("has-error");
    }

    function showError(errorMessage) {
        clearBfsTimer();
        const message = errorMessage || "Failed to load image.";
        statusLabel.textContent = message;
        statusLabel.classList.add("has-error");
        wrapper.classList.add("has-error");
        img.hidden = true;
        bfsGrid.hidden = true;
        bfsGrid.classList.remove("is-animating");
    }

    function applyModel(nextModel = {}) {
        currentModel = { ...(nextModel || {}) };
        updateMetadata();

        const src = resolveImageSource(currentModel);
        img.alt = currentModel.filename || currentModel.filepath || currentModel.path || currentModel.name || "Skill image preview";

        if (!src) {
            img.src = "";
            showError(currentModel.error || "Image source is missing or unavailable.");
            return;
        }

        clearError();
        img.hidden = false;
        img.src = src;
        applyZoomAndFit();
        startBfsReveal();
    }

    const onFitClick = () => {
        fitMode = fitMode === "contain" ? "actual" : "contain";
        if (fitMode === "contain") {
            zoom = 1.0;
        }
        applyZoomAndFit();
    };

    const onZoomOutClick = () => {
        fitMode = "actual";
        zoom = Math.max(MIN_ZOOM, zoom - ZOOM_STEP);
        applyZoomAndFit();
    };

    const onZoomResetClick = () => {
        zoom = 1.0;
        applyZoomAndFit();
    };

    const onZoomInClick = () => {
        fitMode = "actual";
        zoom = Math.min(MAX_ZOOM, zoom + ZOOM_STEP);
        applyZoomAndFit();
    };

    const onBackClick = () => {
        context.onBack?.();
    };

    const onImageLoad = () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            currentModel.width = img.naturalWidth;
            currentModel.height = img.naturalHeight;
            updateMetadata();
        }
    };

    const onImageError = () => {
        showError(`Failed to load image: ${resolveDisplayName(currentModel)}`);
    };

    fitButton.addEventListener("click", onFitClick);
    zoomOutButton.addEventListener("click", onZoomOutClick);
    zoomResetButton.addEventListener("click", onZoomResetClick);
    zoomInButton.addEventListener("click", onZoomInClick);
    backButton.addEventListener("click", onBackClick);
    img.addEventListener("load", onImageLoad);
    img.addEventListener("error", onImageError);
    img.onload = onImageLoad;
    img.onerror = onImageError;

    frame.append(img, bfsGrid);
    stage.append(frame);
    wrapper.append(toolbar, stage);
    container.replaceChildren(wrapper);

    applyModel(currentModel);

    return {
        element: wrapper,
        toolbar,
        badge,
        pathLabel,
        metaLabel,
        controls,
        fitButton,
        zoomOutButton,
        zoomResetButton,
        zoomInButton,
        statusLabel,
        backButton,
        stage,
        frame,
        bfsGrid,
        image: img,
        startBfsReveal,
        getZoom() {
            return zoom;
        },
        getFit() {
            return fitMode;
        },
        onSkillResult(message) {
            if (message?.status === "error") {
                showError(message.message || "Failed to load image.");
                return;
            }
            if (message?.data && typeof message.data === "object") {
                applyModel({ ...currentModel, ...message.data });
            }
        },
        showError,
        focus() {
            backButton.focus?.();
        },
        dispose() {
            clearBfsTimer();
            fitButton.removeEventListener("click", onFitClick);
            zoomOutButton.removeEventListener("click", onZoomOutClick);
            zoomResetButton.removeEventListener("click", onZoomResetClick);
            zoomInButton.removeEventListener("click", onZoomInClick);
            backButton.removeEventListener("click", onBackClick);
            img.removeEventListener("load", onImageLoad);
            img.removeEventListener("error", onImageError);
            img.onload = null;
            img.onerror = null;
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
        return renderImagePanel(container, model, context);
    }
};

export { renderImagePanel as renderFallbackImagePanel };
export default imageSkillPlugin;
