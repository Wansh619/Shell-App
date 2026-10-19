import Icon from "./utils/icon.js";
import { initializeTheme, toggleTheme } from "./utils/theme.js";
import Plugin from "./plugins/plugin.js";
import HomePlugin from "./plugins/home/plugin.js";
import ConsolePlugin from "./plugins/console/plugin.js";
import DebugPlugin from "./plugins/debug/plugin.js";

class PluginManager {
    constructor(plugins = []) {
        this.plugins = new Map();
        this.runningPlugins = new Set();
        plugins.forEach((plugin) => this.register(plugin));
    }

    register(plugin) {
        if (!(plugin instanceof Plugin)) {
            throw new TypeError("Only Plugin instances can be registered.");
        }
        if (this.plugins.has(plugin.name)) {
            throw new Error(`A plugin named "${plugin.name}" is already registered.`);
        }
        this.plugins.set(plugin.name, plugin);
        return plugin;
    }

    getPlugins() {
        return Array.from(this.plugins.values());
    }

    async start(plugin, context) {
        if (this.plugins.get(plugin.name) !== plugin) {
            throw new Error(`Plugin "${plugin.name}" is not registered.`);
        }
        if (this.runningPlugins.has(plugin)) return;

        await plugin.start(context);
        this.runningPlugins.add(plugin);
    }

    async stop(plugin) {
        if (!this.runningPlugins.has(plugin)) return;

        await plugin.stop();
        this.runningPlugins.delete(plugin);
    }
}

const starterPlugins = [
    new HomePlugin(),
    new ConsolePlugin(),
    new DebugPlugin(),
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
    constructor(pluginManager) {
        this.pluginManager = pluginManager;
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

        const menuCoords = this._menuCoordinates(
            centerR,
            centerC,
            this.pluginManager.getPlugins().length
        );
        this._menuMapping = this._menuMapping ||
            shuffle(this.pluginManager.getPlugins());

        // 🔥 Theme center WITH ICON
        await this._setCellContent(centerCell, {
            role: "theme",
            name: "Theme",
            icon: null,
        });

        for (let i = 0; i < menuCoords.length; i++) {
            const [rr, cc] = menuCoords[i];
            const m = this._menuMapping[i];

            await this._setCellContent(cells[rr][cc], {
                role: "menu",
                name: m.name,
                icon: m.icon,
                menuIndex: i,
            });
        }
    }

    _menuCoordinates(centerR, centerC, count) {
        const coordinates = [];
        const queue = this._neighbors(centerR, centerC);
        const visited = new Set([`${centerR},${centerC}`]);
        queue.forEach(([r, c]) => visited.add(`${r},${c}`));

        while (queue.length && coordinates.length < count) {
            const [r, c] = queue.shift();
            coordinates.push([r, c]);

            for (const [neighborR, neighborC] of this._neighbors(r, c)) {
                const neighborKey = `${neighborR},${neighborC}`;
                if (visited.has(neighborKey)) continue;
                visited.add(neighborKey);
                queue.push([neighborR, neighborC]);
            }
        }

        return coordinates;
    }

    registerPlugin(plugin) {
        const registeredPlugin = this.pluginManager.register(plugin);
        this._menuMapping = null;
        if (this._grid.cells.length) this._assignCenterAndRing();
        return registeredPlugin;
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
        overlay.plugin = item;

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

        overlay.prepend(header);
        document.body.append(overlay);
        this.activeOverlay = overlay;

        this.transitioning = true;
        try {
            await this.pluginManager.start(item, {
                app: this,
                overlay,
                plugins: this.pluginManager.getPlugins(),
                openPlugin: (plugin) => this._openPlugin(plugin),
            });
        } catch (error) {
            this.activeOverlay = null;
            this.activeHex = null;
            overlay.remove();
            this.transitioning = false;
            throw error;
        }

        try {
            await this._animatePanelToTile(overlay, hexSlot, true);
        } finally {
            this.transitioning = false;
        }
        closeButton.focus();
    }

    _openPlugin(plugin) {
        const menuIndex = this._menuMapping.indexOf(plugin);
        const tile = this.bg.querySelector(
            `.hex-cell[data-role="menu"][data-menu-index="${menuIndex}"]`
        );
        if (menuIndex < 0 || !tile) {
            throw new Error(`No honeycomb tile is available for "${plugin.name}".`);
        }
        return this._openMenu(tile, plugin);
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
        this.minimizedOverlays.set(overlay.plugin.name, overlay);
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

    async _closeActive() {
        const overlay = this.activeOverlay;
        const hexSlot = this.activeHex;
        if (!overlay || this.transitioning) return;

        this.transitioning = true;
        try {
            await this.pluginManager.stop(overlay.plugin);
        } catch (error) {
            this.transitioning = false;
            throw error;
        }

        this.activeOverlay = null;
        this.activeHex = null;
        overlay.setAttribute("aria-hidden", "true");
        overlay.setAttribute("aria-modal", "false");
        overlay.querySelectorAll("button").forEach((button) => {
            button.disabled = true;
        });

        try {
            await this._animatePanelToTile(overlay, hexSlot, false);
        } finally {
            this.transitioning = false;
            overlay.remove();
        }
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
const pluginManager = new PluginManager(starterPlugins);
new HomeyComb(pluginManager).render(container);