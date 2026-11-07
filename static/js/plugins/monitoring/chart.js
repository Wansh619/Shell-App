import { el, finite, number, visible } from "./core.js";

// Preserve unavailable buckets instead of drawing a misleading line across them.
export function chartPoints(samples, getValue, limit = 600) {
    const stride = Math.max(1, Math.ceil(samples.length / limit));
    const points = [];
    for (let start = 0; start < samples.length; start += stride) {
        const bucket = samples.slice(start, start + stride);
        const values = bucket.map(getValue);
        points.push({
            timestamp: bucket.at(-1).timestamp,
            value: values.every(finite) ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        });
    }
    return points;
}

export class ChartLegend {
    constructor(lines, onToggle) {
        this.lines = lines;
        this.onToggle = onToggle;
        this.root = el("div", "monitoring-chart-legend");
        this.root.setAttribute("role", "group");
        this.root.setAttribute("aria-label", "Toggle plot series");
        this.items = [];
        this.listeners = [];
        lines.forEach((line, index) => {
            const btn = el("button", "monitoring-legend-item");
            btn.type = "button";
            btn.setAttribute("aria-pressed", "true");
            btn.dataset.seriesIndex = String(index);
            btn.dataset.active = "true";
            const swatch = el("span", "monitoring-legend-swatch");
            const label = el("span", "monitoring-legend-label", line.label);
            const value = el("strong", "monitoring-legend-value", "N/A");
            btn.append(swatch, label, value);
            const handler = () => this.onToggle(index);
            btn.addEventListener("click", handler);
            this.listeners.push([btn, "click", handler]);
            this.root.append(btn);
            this.items.push({ btn, swatch, label, value });
        });
    }

    update(colors, hiddenSeries, latestValues) {
        this.items.forEach((item, index) => {
            const active = !hiddenSeries.has(index);
            const color = colors[index % colors.length];
            item.btn.setAttribute("aria-pressed", active ? "true" : "false");
            item.btn.dataset.active = active ? "true" : "false";
            item.btn.classList?.toggle?.("is-muted", !active);
            if (item.swatch.style) {
                item.swatch.style.backgroundColor = color;
                item.swatch.style.boxShadow = active ? `0 0 8px ${color}` : "none";
            }
            item.value.textContent = latestValues[index] ?? "N/A";
        });
    }

    stop() {
        for (const [node, event, handler] of this.listeners) {
            node.removeEventListener(event, handler);
        }
        this.listeners = [];
        this.items = [];
        this.root.remove();
    }
}

export default class CanvasChart {
    constructor(container, title, lines, { max = null, format = (value) => number(value), area = true } = {}) {
        this.lines = lines;
        this.max = max;
        this.format = format;
        this.area = area;
        this.samples = [];
        this.previousSeries = [];
        this.hiddenSeries = new Set();
        this.seriesAlpha = lines.map(() => 1);
        this.displayCeiling = null;
        this.displayStart = null;
        this.displayEnd = null;
        this.animStart = 0;
        this.animDuration = 420;
        this.figure = el("figure", "monitoring-chart");
        const header = el("div", "monitoring-chart-header");
        this.caption = el("figcaption", "", title);
        this.legend = new ChartLegend(lines, (index) => this.toggleSeries(index));
        header.append(this.caption, this.legend.root);
        this.canvas = el("canvas");
        this.canvas.setAttribute("role", "img");
        this.canvas.setAttribute("aria-label", `${title}. Waiting for samples.`);
        this.canvas.textContent = `${title}: chart data summary is available below.`;
        this.summary = el("div", "monitoring-chart-summary", "No samples yet.");
        this.figure.append(header, this.canvas, this.summary);
        container.append(this.figure);
        this.onRepaint = () => this.requestDraw();
        this.resize = new ResizeObserver(this.onRepaint);
        this.resize.observe(this.figure);
        this.theme = new MutationObserver(this.onRepaint);
        this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    }
    toggleSeries(index) {
        if (index < 0 || index >= this.lines.length) return;
        if (this.hiddenSeries.has(index)) {
            this.hiddenSeries.delete(index);
        } else {
            this.hiddenSeries.add(index);
        }
        this.animStart = globalThis.performance?.now?.() ?? Date.now();
        this.requestDraw();
    }
    update(samples, start, end) {
        const latest = samples.at(-1)?.timestamp;
        if (latest !== this.lastTimestamp || samples.length !== this.samples.length) {
            this.lastTimestamp = latest;
            this.previousSeries = this.currentSeries || [];
            this.animStart = globalThis.performance?.now?.() ?? Date.now();
        }
        this.samples = samples;
        this.start = start;
        this.end = end;
        this.requestDraw();
    }
    requestDraw() {
        if (this.stopped || this.frame || !visible(this.figure)) return;
        this.frame = requestAnimationFrame((ts) => {
            this.frame = null;
            if (!this.stopped && visible(this.figure)) this.draw(ts);
        });
    }
    draw(frameTimestamp) {
        const nowPerf = finite(frameTimestamp) ? frameTimestamp : (globalThis.performance?.now?.() ?? Date.now());
        const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        const rawProgress = reducedMotion || !this.animStart ? 1 : Math.min(1, Math.max(0, (nowPerf - this.animStart) / this.animDuration));
        const eased = 1 - ((1 - rawProgress) ** 3);
        const width = Math.min(2000, Math.max(200, this.figure.clientWidth - 32));
        const height = 180;
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        this.canvas.width = width * ratio;
        this.canvas.height = height * ratio;
        const ctx = this.canvas.getContext("2d");
        if (!ctx) return;
        ctx.scale(ratio, ratio);
        const style = getComputedStyle(this.figure);
        const ink = style.getPropertyValue("--normal-text").trim() || "#888";
        const colors = [
            style.getPropertyValue("--monitoring-chart-primary").trim() || "#6200ee",
            style.getPropertyValue("--monitoring-chart-secondary").trim() || "#008978",
            style.getPropertyValue("--monitoring-chart-tertiary").trim() || "#b87400",
            style.getPropertyValue("--monitoring-chart-fourth").trim() || "#c94f68",
        ];
        const dashes = [[], [6, 3], [2, 3], [8, 3, 2, 3]];
        const series = this.lines.map((line) => chartPoints(this.samples, line.value, Math.min(600, Math.floor(width))));
        this.currentSeries = series;

        let alphaAnimating = false;
        this.seriesAlpha = this.lines.map((_, index) => {
            const target = this.hiddenSeries.has(index) ? 0 : 1;
            if (reducedMotion) return target;
            const current = finite(this.seriesAlpha[index]) ? this.seriesAlpha[index] : target;
            const next = current + (target - current) * 0.28;
            if (Math.abs(target - next) > 0.01) {
                alphaAnimating = true;
                return next;
            }
            return target;
        });

        const visibleValues = series.flatMap((points, idx) =>
            this.hiddenSeries.has(idx) ? [] : points.map((point) => point.value)
        ).filter(finite);
        const allValues = series.flatMap((points) => points.map((point) => point.value)).filter(finite);
        const scaleValues = visibleValues.length ? visibleValues : allValues;
        const targetCeiling = this.max ?? Math.max(1, ...scaleValues) * 1.12;
        if (!finite(this.displayCeiling) || reducedMotion) {
            this.displayCeiling = targetCeiling;
        } else {
            this.displayCeiling += (targetCeiling - this.displayCeiling) * 0.25;
            if (Math.abs(targetCeiling - this.displayCeiling) < 0.01) this.displayCeiling = targetCeiling;
        }
        const targetStart = finite(this.start) ? this.start : 0;
        const targetEnd = finite(this.end) ? this.end : 1;
        if (!finite(this.displayStart) || !finite(this.displayEnd) || reducedMotion || Math.abs(targetEnd - this.displayEnd) > 30) {
            this.displayStart = targetStart;
            this.displayEnd = targetEnd;
        } else {
            this.displayStart += (targetStart - this.displayStart) * 0.35;
            this.displayEnd += (targetEnd - this.displayEnd) * 0.35;
            if (Math.abs(targetStart - this.displayStart) < 0.02) this.displayStart = targetStart;
            if (Math.abs(targetEnd - this.displayEnd) < 0.02) this.displayEnd = targetEnd;
        }

        const ceiling = Math.max(1e-6, this.displayCeiling);
        const left = 58, top = 12, right = width - 8, bottom = height - 25;
        ctx.font = "11px sans-serif";
        ctx.fillStyle = ink;
        ctx.strokeStyle = ink;
        for (let step = 0; step <= 2; step++) {
            const y = top + (bottom - top) * step / 2;
            ctx.globalAlpha = 0.12;
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(right, y);
            ctx.stroke();
            ctx.globalAlpha = 0.8;
            ctx.fillText(this.format(ceiling * (1 - step / 2)), 0, y + 4);
        }
        ctx.fillText(new Date((this.displayStart || 0) * 1000).toLocaleTimeString(), left, height - 5);
        ctx.textAlign = "right";
        ctx.fillText(new Date((this.displayEnd || 0) * 1000).toLocaleTimeString(), right, height - 5);
        ctx.textAlign = "left";
        ctx.globalAlpha = 1;
        const span = Math.max(1, (this.displayEnd || 0) - (this.displayStart || 0));
        const maxGap = Math.max(15, span / 120);

        const latestFormatted = [];
        series.forEach((points, index) => {
            const latestRaw = points.at(-1)?.value;
            latestFormatted.push(this.format(latestRaw));
            const alpha = this.seriesAlpha[index];
            if (alpha <= 0.01) return;

            const color = colors[index % colors.length];
            const prevPoints = this.previousSeries[index] || [];
            const prevMap = new Map(prevPoints.map((p) => [p.timestamp, p.value]));
            const prevLast = prevPoints.at(-1)?.value;
            const segments = [];
            let currentSegment = [];
            for (let pIdx = 0; pIdx < points.length; pIdx++) {
                const point = points[pIdx];
                if (!finite(point.value)) {
                    if (currentSegment.length) { segments.push(currentSegment); currentSegment = []; }
                    continue;
                }
                const prevVal = prevMap.has(point.timestamp) ? prevMap.get(point.timestamp) :
                    (pIdx === points.length - 1 && finite(prevLast) ? prevLast : point.value);
                const val = finite(prevVal) ? prevVal + (point.value - prevVal) * eased : point.value;
                const rawX = left + ((point.timestamp - this.displayStart) / span) * (right - left);
                const x = Math.max(left, Math.min(right, rawX));
                const y = bottom - Math.max(0, Math.min(1, val / ceiling)) * (bottom - top);
                if (currentSegment.length && point.timestamp - currentSegment.at(-1).timestamp > maxGap) {
                    segments.push(currentSegment);
                    currentSegment = [];
                }
                currentSegment.push({ x, y, timestamp: point.timestamp, value: val });
            }
            if (currentSegment.length) segments.push(currentSegment);

            const traceSmoothCurve = (seg) => {
                ctx.moveTo(seg[0].x, seg[0].y);
                if (seg.length === 1) return;
                if (seg.length === 2 || typeof ctx.quadraticCurveTo !== "function") {
                    for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y);
                    return;
                }
                for (let i = 0; i < seg.length - 1; i++) {
                    const midX = (seg[i].x + seg[i + 1].x) / 2;
                    const midY = (seg[i].y + seg[i + 1].y) / 2;
                    if (i === 0) ctx.lineTo(midX, midY);
                    else ctx.quadraticCurveTo(seg[i].x, seg[i].y, midX, midY);
                }
                const last = seg.at(-1);
                ctx.lineTo(last.x, last.y);
            };

            if (this.area) {
                ctx.save?.();
                ctx.setLineDash([]);
                if (typeof ctx.createLinearGradient === "function") {
                    const grad = ctx.createLinearGradient(0, top, 0, bottom);
                    grad.addColorStop(0, color);
                    grad.addColorStop(1, "rgba(0, 0, 0, 0)");
                    ctx.fillStyle = grad;
                    ctx.globalAlpha = (series.length > 1 ? 0.24 : 0.36) * alpha;
                } else {
                    ctx.fillStyle = color;
                    ctx.globalAlpha = 0.22 * alpha;
                }
                for (const seg of segments) {
                    if (seg.length < 2) continue;
                    ctx.beginPath();
                    traceSmoothCurve(seg);
                    ctx.lineTo(seg.at(-1).x, bottom);
                    ctx.lineTo(seg[0].x, bottom);
                    ctx.closePath?.();
                    ctx.fill?.();
                }
                ctx.restore?.();
            }

            ctx.globalAlpha = alpha;
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = 2.2;
            ctx.setLineDash(dashes[index % dashes.length]);
            ctx.beginPath();
            for (const seg of segments) {
                traceSmoothCurve(seg);
                for (const pt of seg) ctx.fillRect(pt.x - 1, pt.y - 1, 2, 2);
            }
            ctx.stroke();

            const lastSeg = segments.at(-1);
            const head = lastSeg?.at(-1);
            if (head && typeof ctx.arc === "function") {
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.arc(head.x, head.y, 3.2, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        });
        ctx.setLineDash([]);
        this.legend.update(colors, this.hiddenSeries, latestFormatted);
        const summaries = this.lines.map((line, index) => {
            const points = series[index];
            const values = points.map((point) => point.value).filter(finite);
            const latest = points.at(-1)?.value;
            const stateTag = this.hiddenSeries.has(index) ? " (hidden)" : "";
            return `${line.label}${stateTag}: ${this.format(latest)}${values.length ? ` · min ${this.format(Math.min(...values))} / max ${this.format(Math.max(...values))}` : " · unavailable"}`;
        });
        this.summary.textContent = summaries.join(" | ");
        this.canvas.setAttribute("aria-label", `${this.caption.textContent}. ${summaries.join(". ")}. Gaps indicate unavailable samples.`);
        if (!allValues.length) {
            ctx.fillStyle = ink;
            ctx.textAlign = "center";
            ctx.fillText("No available samples in this range", (left + right) / 2, (top + bottom) / 2);
        }
        const timeAnimating = Math.abs(targetStart - this.displayStart) > 0.03 || Math.abs(targetEnd - this.displayEnd) > 0.03;
        if ((rawProgress < 1 || alphaAnimating || timeAnimating || Math.abs(targetCeiling - this.displayCeiling) > 0.05) && !this.stopped) {
            this.requestDraw();
        }
    }
    stop() {
        this.stopped = true;
        cancelAnimationFrame(this.frame);
        this.resize.disconnect();
        this.theme.disconnect();
        this.legend.stop();
        this.samples = [];
        this.figure.remove();
    }
}
