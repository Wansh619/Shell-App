import Icon from "./utils/icon.js";
import { initializeTheme, toggleTheme } from "./utils/theme.js";

const starterMenus = [
    { name: "Home", icon: "home.svg", iframeurl: "#" },
    { name: "Platform", icon: "platform.svg", iframeurl: "/console" },
    { name: "Browser", icon: "browser.svg", iframeurl: "#" },
    { name: "Console", icon: "console.svg", iframeurl: "/console" },
    { name: "Debug", icon: "bug.svg", view: "debug" },
];

function shuffle(array) {
    const a = array.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

class HomeyComb {
    constructor(menus) {
        this.menus = menus;
        this.bg = document.createElement("div");
        this.hoverShadow = document.createElement("div");
        this.activeHex = null;
        this.activeOverlay = null;
        this.minimizedOverlays = new Map();
        this.transitioning = false;
        this.mouse = { x: 0, y: 0 };
        this.glow = { x: 0, y: 0 };
        this.rafId = null;
        this._onResize = null;
        this._grid = { rows: 0, cols: 0, cells: [] };
        this._hexMetrics = { w: 0, h: 0, stepY: 0 };
    }

    render(container) {
        initializeTheme();
        container.innerHTML = "";
        container.style.position = "relative";

        this.bg.className = "homeycomb-bg";
        this.hoverShadow.className = "homeycomb-glow";

        container.appendChild(this.bg);
        container.appendChild(this.hoverShadow);

        this._renderBackground(container);
        this._assignCenterAndRing();
        this._bindGlow(container);

        if (this._onResize) {
            window.removeEventListener("resize", this._onResize);
        }
        this._onResize = () => {
            this._renderBackground(container);
            this._assignCenterAndRing();
        };
        window.addEventListener("resize", this._onResize);
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && this.activeOverlay) {
                this._closeActive();
            }
        });
    }

    _renderBackground(container) {
        const rect = container.getBoundingClientRect();
        const w = rect.width || window.innerWidth;
        const h = rect.height || window.innerHeight;

        const hexW = Math.max(56, Math.min(92, Math.floor(w / 14)));
        const hexH = hexW * 1.1547;
        const stepY = hexH * 0.75;
        const cols = Math.ceil(w / hexW) + 3;
        const rows = Math.ceil(h / stepY) + 3;

        this.bg.innerHTML = "";
        const frag = document.createDocumentFragment();
        const cells = [];

        this._hexMetrics = { w: hexW, h: hexH, stepY };

        for (let r = 0; r < rows; r++) {
            const row = [];
            for (let c = 0; c < cols; c++) {
                const x = c * hexW;
                const y = r * stepY;
                const offsetX = (r % 2 === 0) ? 0 : hexW / 2;

                const cellBtn = document.createElement("button");
                cellBtn.className = "hex-cell";
                cellBtn.style.width = `${hexW}px`;
                cellBtn.style.height = `${hexH}px`;
                cellBtn.style.transform = `translate(${x + offsetX}px, ${y}px)`;

                const surface = document.createElement("div");
                surface.className = "hex-surface";
                cellBtn.appendChild(surface);

                frag.appendChild(cellBtn);
                row.push(cellBtn);
            }
            cells.push(row);
        }

        this.bg.appendChild(frag);
        this._grid = { rows, cols, cells };

        this.bg.onclick = (event) => {
            const cell = event.target.closest(".hex-cell");
            if (!cell) return;

            const role = cell.dataset.role;

            if (role === "theme") {
                this._toggleTheme(event);
            }

            if (role === "menu") {
                const idx = Number(cell.dataset.menuIndex);
                const item = this._menuMapping?.[idx];
                if (item) this._openMenu(cell, item);
            }
        };
    }

    _neighbors(r, c) {
        const even = (r % 2 === 0);
        const coords = [
            [r, c - 1],
            [r, c + 1],
            [r - 1, even ? c - 1 : c],
            [r - 1, even ? c : c + 1],
            [r + 1, even ? c - 1 : c],
            [r + 1, even ? c : c + 1],
        ];
        return coords.filter(([rr, cc]) =>
            rr >= 0 && cc >= 0 && rr < this._grid.rows && cc < this._grid.cols
        );
    }

    async _setCellContent(cell, { role, name, icon, menuIndex }) {
        cell.dataset.role = role;
        cell.dataset.menuIndex = menuIndex ?? "";

        const surface = cell.querySelector(".hex-surface");
        surface.innerHTML = "";

        const content = document.createElement("div");
        content.className = "hex-content";
        surface.appendChild(content);

        const iconWrap = document.createElement("div");
        iconWrap.className = "hex-icon";
        content.appendChild(iconWrap);

        // 🔥 Unified icon system (theme + menu)
        if (icon) {
            const iconObj = new Icon(`/static/images/${icon}`, {
                className: "hex-icon-wrapper",
                svgClassName: `hex-icon-svg ${role === "theme" ? "theme-icon" : ""}`,
                size: role === "theme" ? 32 : 28,
            });

            try {
                await iconObj.render(iconWrap);
            } catch {
                iconWrap.textContent = name?.[0] || "?";
            }
        }

        const label = document.createElement("div");
        label.className = "hex-label";
        label.textContent = name;
        content.appendChild(label);

        cell.classList.toggle("hex-theme-toggle", role === "theme");
    }

    _clearCellRole(cell) {
        cell.dataset.role = "bg";
        cell.dataset.menuIndex = "";
        cell.classList.remove("hex-theme-toggle");
        cell.querySelector(".hex-surface").innerHTML = "";
    }

    async _assignCenterAndRing() {
        const { rows, cols, cells } = this._grid;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                this._clearCellRole(cells[r][c]);
            }
        }

        const centerR = Math.floor(rows / 2);
        const centerC = Math.floor(cols / 2);
        const centerCell = cells[centerR][centerC];

        const ringCoords = this._neighbors(centerR, centerC).slice(0, 6);
        const menus = shuffle(this.menus);
        this._menuMapping = this._menuMapping || menus.slice(0, ringCoords.length);
        this._menuMapping = this._menuMapping.slice(0, ringCoords.length);

        // 🔥 Theme center WITH ICON
        await this._setCellContent(centerCell, {
            role: "theme",
            name: "Theme",
            icon: null,
        });

        for (let i = 0; i < ringCoords.length; i++) {
            const [rr, cc] = ringCoords[i];
            const m = this._menuMapping[i];

            await this._setCellContent(cells[rr][cc], {
                role: "menu",
                name: m.name,
                icon: m.icon,
                menuIndex: i,
            });
        }
    }

    _toggleTheme(e) {
        toggleTheme();
    }

    async _openMenu(hexSlot, item) {
        if (this.transitioning) return;
        if (this.activeOverlay) await this._closeActive();

        const minimizedOverlay = this.minimizedOverlays.get(item.name);
        if (minimizedOverlay) {
            this.minimizedOverlays.delete(item.name);
            this.activeHex = hexSlot;
            this.activeOverlay = minimizedOverlay;
            minimizedOverlay.hidden = false;
            minimizedOverlay.inert = false;
            minimizedOverlay.setAttribute("aria-hidden", "false");
            minimizedOverlay.setAttribute("aria-modal", "true");
            minimizedOverlay.querySelectorAll("button").forEach((button) => {
                button.disabled = false;
            });
            this.transitioning = true;
            await this._animatePanelToTile(minimizedOverlay, hexSlot, true);
            this.transitioning = false;
            minimizedOverlay.querySelector(".hex-minimize").focus();
            return;
        }

        this.activeHex = hexSlot;

        const overlay = document.createElement("section");
        overlay.className = "hex-panel-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", `${item.name} panel`);
        overlay.hexSlot = hexSlot;
        overlay.menuItem = item;

        const header = document.createElement("header");
        header.className = "hex-panel-header";

        const title = document.createElement("strong");
        title.textContent = item.name;

        const controls = document.createElement("div");
        controls.className = "hex-window-controls";

        const minimizeButton = document.createElement("button");
        minimizeButton.className = "hex-minimize";
        minimizeButton.type = "button";
        minimizeButton.textContent = "−";
        minimizeButton.setAttribute("aria-label", `Minimize ${item.name} to its tile`);
        minimizeButton.title = "Minimize to tile";
        minimizeButton.addEventListener("click", () => this._minimizeActive());

        const closeButton = document.createElement("button");
        closeButton.className = "hex-close";
        closeButton.type = "button";
        closeButton.textContent = "×";
        closeButton.setAttribute("aria-label", `Close ${item.name} panel`);
        closeButton.addEventListener("click", () => this._closeActive());
        controls.append(minimizeButton, closeButton);
        header.append(title, controls);

        if (item.view === "debug") {
            overlay.cleanup = this._renderDebugPanel(overlay);
        } else {
            const iframe = document.createElement("iframe");
            iframe.className = "hex-iframe";
            iframe.src = item.iframeurl || "#";
            iframe.title = `${item.name} panel`;
            overlay.append(iframe);
        }

        overlay.prepend(header);
        document.body.append(overlay);
        this.activeOverlay = overlay;
        this.transitioning = true;
        await this._animatePanelToTile(overlay, hexSlot, true);
        this.transitioning = false;
        closeButton.focus();
    }

    async _animatePanelToTile(overlay, hexSlot, restoring) {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

        const rect = hexSlot.getBoundingClientRect();
        const scaleX = rect.width / window.innerWidth;
        const scaleY = rect.height / window.innerHeight;
        const translateX = rect.left + rect.width / 2 - window.innerWidth / 2;
        const translateY = rect.top + rect.height / 2 - window.innerHeight / 2;
        const fullSize = {
            transform: "translate3d(0, 0, 0) scale(1, 1)",
            clipPath: "inset(0)",
            opacity: 1,
        };
        const tileSize = {
            transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${scaleX}, ${scaleY})`,
            clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
            opacity: 0.35,
        };

        overlay.panelAnimation?.cancel();
        const animation = overlay.animate(
            restoring ? [tileSize, fullSize] : [fullSize, tileSize],
            {
                duration: 420,
                easing: "cubic-bezier(0.22, 1, 0.36, 1)",
                fill: "both",
            }
        );
        overlay.panelAnimation = animation;
        try {
            await animation.finished;
        } catch (error) {
            if (error.name !== "AbortError") throw error;
        }
    }

    async _minimizeActive() {
        const overlay = this.activeOverlay;
        if (!overlay || this.transitioning) return;
        const hexSlot = this.activeHex;

        this.transitioning = true;
        this.activeOverlay = null;
        this.activeHex = null;
        this.minimizedOverlays.set(overlay.menuItem.name, overlay);
        overlay.setAttribute("aria-hidden", "true");
        overlay.setAttribute("aria-modal", "false");
        overlay.querySelectorAll("button").forEach((button) => {
            button.disabled = true;
        });

        await this._animatePanelToTile(overlay, hexSlot, false);
        overlay.hidden = true;
        overlay.inert = true;
        this.transitioning = false;
        hexSlot.focus();
    }

    _renderDebugPanel(overlay) {
        const panel = document.createElement("div");
        panel.className = "debug-panel";

        const toolbar = document.createElement("div");
        toolbar.className = "debug-toolbar";

        const label = document.createElement("label");
        label.htmlFor = "debug-log-file";
        label.textContent = "Log file";

        const select = document.createElement("select");
        select.id = "debug-log-file";
        select.className = "debug-log-select";
        for (const [value, text] of [
            ["debug", "Debug (all levels)"],
            ["warning", "Warning"],
            ["error", "Error"],
        ]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = text;
            select.append(option);
        }

        const status = document.createElement("span");
        status.className = "debug-log-status";
        status.setAttribute("role", "status");
        status.textContent = "Connecting...";

        const output = document.createElement("pre");
        output.className = "debug-log-output";
        output.setAttribute("role", "log");
        output.setAttribute("aria-label", "Live application logs");
        output.textContent = "Waiting for log entries...";

        toolbar.append(label, select, status);
        panel.append(toolbar, output);
        overlay.append(panel);

        let offset = 0;
        let generation = "";
        let stopped = false;
        let polling = false;
        let hasOutput = false;
        let requestToken = 0;
        let controller = null;

        const poll = async () => {
            if (stopped || polling) return;
            polling = true;
            const token = ++requestToken;
            const selectedLog = select.value;
            controller = new AbortController();
            const query = new URLSearchParams({
                offset: String(offset),
                generation,
            });

            try {
                const response = await fetch(
                    `/logs/${encodeURIComponent(selectedLog)}?${query}`,
                    { signal: controller.signal }
                );
                const result = await response.json();
                if (!response.ok) {
                    throw new Error(result.error || "Unable to read log file.");
                }
                if (stopped || token !== requestToken) return;

                if (result.reset) {
                    offset = 0;
                    output.textContent = "";
                    hasOutput = false;
                }
                generation = result.generation;
                offset = result.offset;

                if (result.content) {
                    const current = hasOutput ? output.textContent : "";
                    const lines = `${current}${result.content}`.split("\n");
                    output.textContent = lines.slice(-2000).join("\n");
                    hasOutput = true;
                    output.scrollTop = output.scrollHeight;
                } else if (!hasOutput) {
                    output.textContent = "No log entries yet.";
                }

                status.textContent = `Live · ${selectedLog}.log`;
            } catch (error) {
                if (error.name !== "AbortError" && !stopped && token === requestToken) {
                    status.textContent = `Log stream error: ${error.message}`;
                }
            } finally {
                if (token === requestToken) {
                    polling = false;
                    controller = null;
                }
            }
        };

        const intervalId = window.setInterval(poll, 1000);
        select.addEventListener("change", () => {
            requestToken++;
            controller?.abort();
            polling = false;
            controller = null;
            offset = 0;
            generation = "";
            hasOutput = false;
            output.textContent = "Loading log entries...";
            poll();
        });
        poll();

        return () => {
            stopped = true;
            window.clearInterval(intervalId);
            controller?.abort();
        };
    }

    async _closeActive() {
        const overlay = this.activeOverlay;
        const hexSlot = this.activeHex;
        if (!overlay || this.transitioning) return;

        this.transitioning = true;
        this.activeOverlay = null;
        this.activeHex = null;
        overlay.setAttribute("aria-hidden", "true");
        overlay.setAttribute("aria-modal", "false");
        overlay.querySelectorAll("button").forEach((button) => {
            button.disabled = true;
        });

        await this._animatePanelToTile(overlay, hexSlot, false);
        overlay.cleanup?.();
        overlay.remove();
        this.transitioning = false;
        if (!this.activeOverlay) hexSlot?.focus();
    }

    _bindGlow(container) {
        container.addEventListener("mousemove", (e) => {
            this.hoverShadow.style.left = `${e.clientX}px`;
            this.hoverShadow.style.top = `${e.clientY}px`;
        });
    }
}

const container = document.querySelector("#container");
new HomeyComb(starterMenus).render(container);