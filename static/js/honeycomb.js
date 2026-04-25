import Icon from "./utils/icon.js";

const starterMenus = [
    { name: "Home", icon: "home.svg", iframeurl: "#" },
    { name: "Terminal", icon: "home.svg", iframeurl: "/home/wansh/Desktop/Shell App/templates/terminal.html" },
    { name: "Sessions", icon: "home.svg", iframeurl: "#" },
    { name: "Settings", icon: "home.svg", iframeurl: "#" },
    { name: "About", icon: "home.svg", iframeurl: "#" },
    { name: "Help", icon: "home.svg", iframeurl: "#" },
];

function shuffle(array) {
    const a = array.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
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
        this.mouse = { x: 0, y: 0 };
        this.glow = { x: 0, y: 0 };
        this.rafId = null;
        this._onResize = null;
        this._grid = { rows: 0, cols: 0, cells: [] };
        this._hexMetrics = { w: 0, h: 0, stepY: 0 };
    }

    render(container) {
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
    }

    _renderBackground(container) {
        // Fill viewport with hex cells; some will become menu/theme cells.
        const rect = container.getBoundingClientRect();
        const w = rect.width || window.innerWidth;
        const h = rect.height || window.innerHeight;

        // Hex sizing tuned for performance + look
        const hexW = Math.max(56, Math.min(92, Math.floor(w / 14)));
        const hexH = hexW * 1.1547;
        const stepY = hexH * 0.75;
        const cols = Math.ceil(w / hexW) + 3;
        const rows = Math.ceil(h / stepY) + 3;

        this.bg.innerHTML = "";
        const frag = document.createDocumentFragment();
        const cells = [];

        this._hexMetrics = { w: hexW, h: hexH, stepY };

        for (let r = 0; r < rows; r += 1) {
            const row = [];
            for (let c = 0; c < cols; c += 1) {
                const x = c * hexW;
                const y = r * stepY;
                const offsetX = (r % 2 === 0) ? 0 : hexW / 2;

                const cellBtn = document.createElement("button");
                cellBtn.type = "button";
                cellBtn.className = "hex-cell";
                cellBtn.dataset.r = String(r);
                cellBtn.dataset.c = String(c);
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

        // Delegate clicks (only menu/theme cells will act)
        this.bg.onclick = (event) => {
            const cell = event.target.closest(".hex-cell");
            if (!cell || !this.bg.contains(cell)) return;
            const role = cell.dataset.role;
            if (role === "theme") {
                this._toggleTheme(event);
                return;
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
        return coords.filter(([rr, cc]) => rr >= 0 && cc >= 0 && rr < this._grid.rows && cc < this._grid.cols);
    }

    async _setCellContent(cell, { role, name, icon, menuIndex }) {
        cell.dataset.role = role;
        cell.dataset.menuIndex = menuIndex != null ? String(menuIndex) : "";

        const surface = cell.querySelector(".hex-surface");
        surface.innerHTML = "";

        const content = document.createElement("div");
        content.className = "hex-content";
        surface.appendChild(content);

        const iconWrap = document.createElement("div");
        iconWrap.className = "hex-icon";
        content.appendChild(iconWrap);

        if (role === "theme") {
        } else if (role === "menu") {
            const iconObj = new Icon(`/static/images/${icon}`, {
                className: "hex-icon-wrapper",
                svgClassName: "hex-icon-svg",
                size: 28,
         
            });
            try {
                await iconObj.render(iconWrap);
            } catch {
                iconWrap.textContent = name.slice(0, 1);
            }
        }

        const label = document.createElement("div");
        label.className = "hex-label";
        label.textContent = name;
        content.appendChild(label);

        if (role === "theme") {
            cell.classList.add("hex-theme-toggle");
        } else {
            cell.classList.remove("hex-theme-toggle");
        }
    }

    _clearCellRole(cell) {
        cell.dataset.role = "bg";
        cell.dataset.menuIndex = "";
        cell.classList.remove("hex-theme-toggle");
        const surface = cell.querySelector(".hex-surface");
        surface.innerHTML = "";
    }

    async _assignCenterAndRing() {
        const { rows, cols, cells } = this._grid;
        if (!rows || !cols) return;

        // Clear any previous roles
        for (let r = 0; r < rows; r += 1) {
            for (let c = 0; c < cols; c += 1) {
                this._clearCellRole(cells[r][c]);
            }
        }

        const centerR = Math.floor(rows / 2);
        const centerC = Math.floor(cols / 2);
        const centerCell = cells[centerR][centerC];

        // First ring: BFS distance 1 neighbors
        const ringCoords = this._neighbors(centerR, centerC).slice(0, 6);
        const menus = shuffle(this.menus);
        this._menuMapping = menus.slice(0, ringCoords.length);

        await this._setCellContent(centerCell, {
            role: "theme",
            name: "Theme",
            icon: null,
            menuIndex: null,
        });

        for (let i = 0; i < ringCoords.length; i += 1) {
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
        const x = e.clientX ?? (e.touches?.[0]?.clientX ?? innerWidth / 2);
        const y = e.clientY ?? (e.touches?.[0]?.clientY ?? innerHeight / 2);
        const endRadius = Math.hypot(
            Math.max(x, innerWidth - x),
            Math.max(y, innerHeight - y)
        );

        const doToggle = () => {
            document.documentElement.classList.toggle("dark");
        };

        if (document.startViewTransition) {
            const transition = document.startViewTransition(doToggle);
            transition.ready.then(() => {
                const animation = document.documentElement.animate(
                    {
                        clipPath: [
                            `circle(0px at ${x}px ${y}px)`,
                            `circle(${endRadius}px at ${x}px ${y}px)`,
                        ],
                    },
                    {
                        duration: 600,
                        easing: "ease-in-out",
                        pseudoElement: "::view-transition-new(root)",
                    }
                );
                animation.onfinish = () => animation.cancel();
            });
        } else {
            doToggle();
        }
    }

    _closeActive() {
        if (!this.activeHex) {
            return;
        }
        const current = this.activeHex;
        current.classList.remove("is-open");
        const iframe = current.querySelector("iframe.hex-iframe");
        if (iframe) iframe.remove();
        const closeBtn = current.querySelector("button.hex-close");
        if (closeBtn) closeBtn.remove();
        this.activeHex = null;
    }

    _openMenu(hexSlot, item) {
        if (this.activeHex && this.activeHex !== hexSlot) {
            this._closeActive();
        }
        if (hexSlot.classList.contains("is-open")) {
            this._closeActive();
            return;
        }

        hexSlot.classList.add("is-open");
        this.activeHex = hexSlot;

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "hex-close";
        closeBtn.setAttribute("aria-label", "Close");
        closeBtn.innerHTML = `<i class="fa-solid fa-xmark" aria-hidden="true"></i>`;
        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this._closeActive();
        });
        hexSlot.appendChild(closeBtn);

        const iframe = document.createElement("iframe");
        iframe.className = "hex-iframe";
        iframe.src = item.iframeurl || "#";
        iframe.setAttribute("loading", "lazy");
        hexSlot.appendChild(iframe);
    }

    _bindGlow(container) {
        const onMove = (e) => {
            const rect = container.getBoundingClientRect();
            this.mouse.x = e.clientX - rect.left;
            this.mouse.y = e.clientY - rect.top;
            if (!this.rafId) {
                this.rafId = requestAnimationFrame(() => this._tickGlow());
            }
        };
        container.addEventListener("mousemove", onMove);
        container.addEventListener("mouseleave", () => {
            this.mouse.x = container.clientWidth / 2;
            this.mouse.y = container.clientHeight / 2;
        });

        // Initialize center
        this.mouse.x = container.clientWidth / 2;
        this.mouse.y = container.clientHeight / 2;
        this.glow.x = this.mouse.x;
        this.glow.y = this.mouse.y;
        this._tickGlow();
    }

    _tickGlow() {
        const lerp = 0.12;
        this.glow.x += (this.mouse.x - this.glow.x) * lerp;
        this.glow.y += (this.mouse.y - this.glow.y) * lerp;
        this.hoverShadow.style.left = `${this.glow.x}px`;
        this.hoverShadow.style.top = `${this.glow.y}px`;
        this.rafId = requestAnimationFrame(() => this._tickGlow());
    }
}

const container = document.querySelector("#container");
const hcomb = new HomeyComb(starterMenus);
hcomb.render(container);
