import Icon from "./utils/icon.js";
import { initializeTheme, toggleTheme } from "./utils/theme.js";

const starterMenus = [
    { name: "Home", icon: "home.svg", iframeurl: "#" },
    { name: "Platform", icon: "platform.svg", iframeurl: "/console" },
    { name: "Browser", icon: "browser.svg", iframeurl: "#" },
    { name: "Console", icon: "console.svg", iframeurl: "/console" },
    { name: "About", icon: "home.svg", iframeurl: "#" },
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
        this._menuMapping = menus.slice(0, ringCoords.length);

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

    _openMenu(hexSlot, item) {
        if (this.activeHex) this._closeActive();

        this.activeHex = hexSlot;

        const overlay = document.createElement("section");
        overlay.className = "hex-panel-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", `${item.name} panel`);

        const header = document.createElement("header");
        header.className = "hex-panel-header";

        const title = document.createElement("strong");
        title.textContent = item.name;

        const closeButton = document.createElement("button");
        closeButton.className = "hex-close";
        closeButton.type = "button";
        closeButton.textContent = "×";
        closeButton.setAttribute("aria-label", `Close ${item.name} panel`);
        closeButton.addEventListener("click", () => this._closeActive());
        header.append(title, closeButton);

        const iframe = document.createElement("iframe");
        iframe.className = "hex-iframe";
        iframe.src = item.iframeurl || "#";
        iframe.title = `${item.name} panel`;

        overlay.append(header, iframe);
        document.body.append(overlay);
        this.activeOverlay = overlay;
        closeButton.focus();
    }

    _closeActive() {
        if (!this.activeOverlay) return;
        this.activeOverlay.remove();
        this.activeOverlay = null;
        this.activeHex?.focus();
        this.activeHex = null;
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