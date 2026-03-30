/**
 * Mounts a rhombus START control, PCB traces (radial hub + cardinal legs), and N nodes.
 * Uses theme CSS vars via existing classes in index.css.
 */
class PcbStartLayout {
    /**
     * @param {object} options
     * @param {HTMLElement} options.container
     * @param {string} [options.startLabel='START']
     * @param {Array<{name: string, icon?: string, svg?: string, image?: string, imageDark?: string, ariaLabel?: string}>} options.nodes
     * @param {number} [options.viewBoxSize=400]
     * @param {number} [options.nodeRadius=140]
     * @param {'horizontalFirst'|'verticalFirst'|'auto'} [options.traceRouting='auto']
     */
    constructor(options) {
        if (!options || !options.container) {
            throw new Error("PcbStartLayout: container is required");
        }
        const nodes = options.nodes || [];
        if (nodes.length < 1) {
            throw new Error("PcbStartLayout: nodes must have at least one item");
        }

        this._container = options.container;
        this._startLabel = options.startLabel || "START";
        this._nodes = nodes;
        this._viewBoxSize = options.viewBoxSize ?? 400;
        this._nodeRadius = options.nodeRadius ?? 140;
        this._traceRouting = options.traceRouting || "auto";

        /** @type {SVGPathElement[]} */
        this._tracePaths = [];
        /** @type {HTMLButtonElement[]} */
        this._nodeButtons = [];
        /** @type {{ nx: number, ny: number }[]} */
        this._nodePositions = [];
        this._themeObserver = null;
        this._resizeBound = null;

        this._mount();
    }

    _mount() {
        this._container.innerHTML = "";

        const inner = document.createElement("div");
        inner.className = "start-overlay-inner";

        const startButton = document.createElement("button");
        startButton.type = "button";
        startButton.id = "start-button";
        startButton.className = "start-button";
        startButton.setAttribute("aria-label", "Start");
        const label = document.createElement("span");
        label.className = "start-button-label";
        label.textContent = this._startLabel;
        startButton.appendChild(label);

        const vb = this._viewBoxSize;
        const cx = vb / 2;
        const cy = vb / 2;
        const n = this._nodes.length;
        const R = this._nodeRadius;

        const svgNs = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNs, "svg");
        svg.setAttribute("id", "pcb-svg");
        svg.setAttribute("class", "pcb-svg");
        svg.setAttribute("viewBox", `0 0 ${vb} ${vb}`);
        svg.setAttribute("xmlns", svgNs);
        svg.setAttribute("aria-hidden", "true");

        const tracesGroup = document.createElementNS(svgNs, "g");
        tracesGroup.setAttribute("class", "pcb-traces");
        tracesGroup.setAttribute("fill", "none");
        tracesGroup.setAttribute("stroke", "currentColor");
        tracesGroup.setAttribute("stroke-width", "2");
        tracesGroup.setAttribute("stroke-linecap", "round");
        tracesGroup.setAttribute("stroke-linejoin", "round");

        const nodesWrap = document.createElement("div");
        nodesWrap.id = "pcb-nodes";
        nodesWrap.className = "pcb-nodes";

        this._nodePositions = [];

        for (let i = 0; i < n; i += 1) {
            const theta = (2 * Math.PI * i) / n - Math.PI / 2;
            const tx = cx + R * Math.cos(theta);
            const ty = cy + R * Math.sin(theta);
            const nx = Math.round(tx * 1000) / 1000;
            const ny = Math.round(ty * 1000) / 1000;

            this._nodePositions.push({ nx, ny });

            const pathD = this._tracePathRadialThenCardinal(cx, cy, nx, ny, 0);
            const path = document.createElementNS(svgNs, "path");
            path.setAttribute("class", "pcb-trace");
            path.setAttribute("d", pathD);
            tracesGroup.appendChild(path);
            this._tracePaths.push(path);

            const spec = this._nodes[i];
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "pcb-node";
            btn.dataset.node = String(i);
            btn.style.left = `${(nx / vb) * 100}%`;
            btn.style.top = `${(ny / vb) * 100}%`;
            btn.style.setProperty("--pcb-node-i", String(i));
            btn.setAttribute("aria-label", spec.ariaLabel || spec.name || `Node ${i + 1}`);

            const circle = document.createElement("span");
            circle.className = "pcb-node-circle";
            this._fillNodeContent(circle, spec);
            btn.appendChild(circle);

            const lbl = document.createElement("span");
            lbl.className = "pcb-node-label";
            lbl.textContent = spec.name || "";
            btn.appendChild(lbl);

            nodesWrap.appendChild(btn);
            this._nodeButtons.push(btn);
        }

        svg.appendChild(tracesGroup);
        inner.appendChild(startButton);
        inner.appendChild(svg);
        inner.appendChild(nodesWrap);
        this._container.appendChild(inner);

        this._inner = inner;
        this._startButton = startButton;
        this._svg = svg;
        this._nodesContainer = nodesWrap;

        window.requestAnimationFrame(() => {
            this._refreshTraceGeometry();
        });

        this._resizeBound = () => {
            window.requestAnimationFrame(() => this._refreshTraceGeometry());
        };
        window.addEventListener("resize", this._resizeBound);

        this._bindThemeImages();
    }

    /**
     * Side length of rhombus from square of side L (diamond clip on L×L box).
     * @param {number} L
     */
    static _rhombusEdgeFromSquare(L) {
        return (L * Math.SQRT2) / 2;
    }

    /**
     * Hub radius in viewBox: (rhombus edge / 2) mapped from START button size.
     */
    _innerHubRadiusVb() {
        const inner = this._inner;
        const btn = this._startButton;
        const innerRect = inner.getBoundingClientRect();
        const w = innerRect.width;
        if (w <= 0 || !btn) {
            return this._viewBoxSize * 0.06;
        }
        const L = btn.offsetWidth || parseFloat(getComputedStyle(btn).width) || 124;
        const edge = PcbStartLayout._rhombusEdgeFromSquare(L);
        const rPx = edge / 2;
        return (rPx / w) * this._viewBoxSize;
    }

    _refreshTraceGeometry() {
        const vb = this._viewBoxSize;
        const cx = vb / 2;
        const cy = vb / 2;
        const rHub = Math.min(this._innerHubRadiusVb(), this._nodeRadius * 0.98);

        this._nodePositions.forEach(({ nx, ny }, i) => {
            const path = this._tracePaths[i];
            if (!path) {
                return;
            }
            path.setAttribute("d", this._tracePathRadialThenCardinal(cx, cy, nx, ny, rHub));
        });
        this._prepareTraceDashStyles();
    }

    /**
     * Segment: center → point on hub circle along ray to node, then cardinal steps to node.
     */
    _tracePathRadialThenCardinal(cx, cy, nx, ny, rHub) {
        const dx = nx - cx;
        const dy = ny - cy;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const effectiveR = Math.min(rHub, dist * 0.98);
        const px = Math.round((cx + ux * effectiveR) * 1000) / 1000;
        const py = Math.round((cy + uy * effectiveR) * 1000) / 1000;

        return `M ${cx} ${cy} L ${px} ${py}${this._cardinalLegs(px, py, nx, ny)}`;
    }

    _cardinalLegs(px, py, nx, ny) {
        const routing = this._traceRouting;
        let horizontalFirst;

        if (routing === "horizontalFirst") {
            horizontalFirst = true;
        } else if (routing === "verticalFirst") {
            horizontalFirst = false;
        } else {
            horizontalFirst = Math.abs(nx - px) >= Math.abs(ny - py);
        }

        if (horizontalFirst) {
            return ` L ${nx} ${py} L ${nx} ${ny}`;
        }
        return ` L ${px} ${ny} L ${nx} ${ny}`;
    }

    _fillNodeContent(circle, spec) {
        if (spec.icon) {
            const icon = document.createElement("i");
            spec.icon.split(/\s+/).filter(Boolean).forEach((c) => icon.classList.add(c));
            icon.setAttribute("aria-hidden", "true");
            circle.appendChild(icon);
            return;
        }
        if (spec.svg) {
            const wrap = document.createElement("span");
            wrap.className = "pcb-node-svg-wrap";
            wrap.innerHTML = spec.svg;
            const svgEl = wrap.querySelector("svg");
            if (svgEl) {
                svgEl.setAttribute("width", "24");
                svgEl.setAttribute("height", "24");
                svgEl.style.display = "block";
            }
            circle.appendChild(wrap);
            return;
        }
        if (spec.image || spec.imageDark) {
            const img = document.createElement("img");
            img.className = "pcb-node-img";
            img.alt = "";
            img.decoding = "async";
            this._setImageSrc(img, spec);
            circle.appendChild(img);
            return;
        }
        const fallback = document.createElement("span");
        fallback.className = "pcb-node-fallback";
        fallback.textContent = (spec.name || "?").slice(0, 1).toUpperCase();
        circle.appendChild(fallback);
    }

    _setImageSrc(img, spec) {
        const dark = document.documentElement.classList.contains("dark");
        const src = dark && spec.imageDark ? spec.imageDark : (spec.image || spec.imageDark);
        if (src) {
            img.src = src;
        }
    }

    _bindThemeImages() {
        const imgs = this._nodesContainer.querySelectorAll("img.pcb-node-img");
        if (imgs.length === 0) {
            return;
        }
        this._themeObserver = new MutationObserver(() => {
            this._nodes.forEach((spec, i) => {
                const btn = this._nodeButtons[i];
                if (!btn) {
                    return;
                }
                const img = btn.querySelector("img.pcb-node-img");
                if (img && (spec.image || spec.imageDark)) {
                    this._setImageSrc(img, spec);
                }
            });
        });
        this._themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class"]
        });
    }

    _prepareTraceDashStyles() {
        this._tracePaths.forEach((path) => {
            const len = path.getTotalLength();
            const dash = len > 0 ? len : 1;
            path.style.strokeDasharray = String(dash);
            path.style.strokeDashoffset = String(dash);
            path.style.opacity = "0";
        });
    }

    /**
     * Run trace draw animations (call after overlay gets .pcb-active).
     */
    playTraceAnimations() {
        this._refreshTraceGeometry();

        const prefersReduced =
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        this._tracePaths.forEach((path, i) => {
            const len = path.getTotalLength();
            const dash = len > 0 ? len : 1;
            path.style.strokeDasharray = String(dash);
            path.style.strokeDashoffset = String(dash);

            const delay = i * 80;
            const duration = prefersReduced ? 0 : 850;

            if (prefersReduced || !path.animate) {
                path.style.strokeDashoffset = "0";
                path.style.opacity = "1";
                return;
            }

            path.animate(
                [
                    { strokeDashoffset: dash, opacity: 0.4 },
                    { strokeDashoffset: 0, opacity: 1 }
                ],
                {
                    duration,
                    delay,
                    easing: "ease-out",
                    fill: "forwards"
                }
            );
        });
    }

    destroy() {
        if (this._resizeBound) {
            window.removeEventListener("resize", this._resizeBound);
            this._resizeBound = null;
        }
        if (this._themeObserver) {
            this._themeObserver.disconnect();
            this._themeObserver = null;
        }
        this._container.innerHTML = "";
    }

    getElements() {
        return {
            overlayRoot: this._container,
            inner: this._inner,
            startButton: this._startButton,
            nodesContainer: this._nodesContainer,
            svg: this._svg,
            nodeButtons: this._nodeButtons
        };
    }
}

window.PcbStartLayout = PcbStartLayout;
