import { animateNumber, el, finite, number, text } from "./core.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const CIRCUMFERENCE = 2 * Math.PI * 94; // ~590.62 for r=94

function svgNode(tag, className = "", attrs = {}) {
    const node = typeof document.createElementNS === "function"
        ? document.createElementNS(SVG_NS, tag)
        : document.createElement(tag);
    if (className) {
        node.setAttribute("class", className);
    }
    for (const [key, val] of Object.entries(attrs)) {
        node.setAttribute(key, String(val));
    }
    return node;
}

let gaugeCounter = 0;

/**
 * Class-based HUD Circular Progress Gauge adapted to the application's theme palette.
 * Features outer segmented ticks, a rotating orbital ring, glowing progress arc,
 * inner decorative ring, and smooth numeric & arc transitions.
 */
export default class CircularProgressGauge {
    constructor(label, { initial = "N/A", subtitle = "TELEMETRY ONLINE", max = 100, accent = "primary" } = {}) {
        this.label = label;
        this.max = max;
        this.currentPercent = 0;
        const glowId = `monitoring-gauge-glow-${++gaugeCounter}`;

        this.card = el("div", `monitoring-card monitoring-gauge-card is-${accent}`);
        this.svg = svgNode("svg", "monitoring-gauge-svg", {
            viewBox: "0 0 300 300",
            role: "img",
            "aria-label": `${label} circular gauge`,
        });

        const defs = svgNode("defs");
        const filter = svgNode("filter", "", { id: glowId, x: "-20%", y: "-20%", width: "140%", height: "140%" });
        const blur = svgNode("feGaussianBlur", "", { stdDeviation: "3.5", result: "blur" });
        const merge = svgNode("feMerge");
        merge.append(
            svgNode("feMergeNode", "", { in: "blur" }),
            svgNode("feMergeNode", "", { in: "SourceGraphic" })
        );
        filter.append(blur, merge);
        defs.append(filter);

        // 1. Background ring
        const bgRing = svgNode("circle", "monitoring-gauge-bg-ring", {
            cx: 150, cy: 150, r: 105, fill: "none", "stroke-width": 2,
        });

        // 2. Outer segmented ticks
        const outerTicks = svgNode("circle", "monitoring-gauge-ticks", {
            cx: 150, cy: 150, r: 130, fill: "none", "stroke-width": 2, "stroke-dasharray": "2 8",
        });

        // 3. Rotating outer ring
        const orbitGroup = svgNode("g", "monitoring-gauge-orbit");
        const orbitCircle = svgNode("circle", "monitoring-gauge-orbit-ring", {
            cx: 150, cy: 150, r: 119, fill: "none", "stroke-width": 1.4, "stroke-dasharray": "35 12 5 12",
        });
        orbitGroup.append(orbitCircle);

        // 4. Inner static track ring
        const trackRing = svgNode("circle", "monitoring-gauge-track", {
            cx: 150, cy: 150, r: 94, fill: "none", "stroke-width": 7,
        });

        // 5. Smooth animated progress ring
        this.progressRing = svgNode("circle", "monitoring-gauge-progress", {
            cx: 150, cy: 150, r: 94, fill: "none", "stroke-width": 7,
            "stroke-linecap": "round",
            "stroke-dasharray": `0 ${CIRCUMFERENCE.toFixed(1)}`,
            transform: "rotate(-90 150 150)",
            filter: `url(#${glowId})`,
        });

        // 6. Inner decorative dashed ring
        const innerDeco = svgNode("circle", "monitoring-gauge-inner-deco", {
            cx: 150, cy: 150, r: 76, fill: "none", "stroke-width": 1, "stroke-dasharray": "3 5",
        });

        // 7. Central value readout (kept as this.value for full API compatibility)
        this.value = svgNode("text", "monitoring-value monitoring-gauge-value", {
            x: 150, y: 146, "text-anchor": "middle",
        });
        this.value.textContent = text(initial);

        // 8. Uppercase metric label inside ring
        this.labelNode = svgNode("text", "monitoring-gauge-label", {
            x: 150, y: 170, "text-anchor": "middle",
        });
        this.labelNode.textContent = String(label).toUpperCase();

        this.svg.append(
            defs,
            bgRing,
            outerTicks,
            orbitGroup,
            trackRing,
            this.progressRing,
            innerDeco,
            this.value,
            this.labelNode
        );
        this.card.append(this.svg);
    }

    setProgress(percent) {
        const clamped = finite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
        this.currentPercent = clamped;
        const arc = (clamped / 100) * CIRCUMFERENCE;
        this.progressRing.setAttribute("stroke-dasharray", `${arc.toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`);
        this.card.dataset.active = finite(percent) ? "true" : "false";
    }

    updateValue(numericValue, formatter = (v) => number(v), { percent = null, max = null } = {}) {
        animateNumber(this.value, numericValue, formatter);
        const denom = max ?? this.max;
        const computedPct = percent !== null ? percent : (finite(numericValue) && denom > 0 ? (numericValue / denom) * 100 : null);
        this.setProgress(computedPct);
    }

    updateText(displayText, { percent = 0 } = {}) {
        this.value.textContent = text(displayText);
        this.setProgress(percent);
    }
}
