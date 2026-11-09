import { BoundedSeries, ReconnectingTransport, el, finite, visible } from "./core.js";
import CanvasChart from "./chart.js";
import CircularProgressGauge from "./gauge.js";

export default class MonitoringDashboard {
    constructor(overlay, slug, title, subtitle) {
        this.overlay = overlay;
        this.slug = slug;
        this.series = new BoundedSeries();
        this.range = 60;
        this.charts = [];
        this.stopped = false;
        this.historyToken = 0;
        this.connection = "connecting";
        this.historyError = "";
        this.root = el("div", "monitoring-dashboard");
        const heading = el("div", "monitoring-heading");
        const titleGroup = el("div");
        titleGroup.append(el("p", "monitoring-eyebrow", "SYSTEM TELEMETRY"), el("h1", "", title),
            el("p", "monitoring-muted", subtitle));
        const label = el("label", "monitoring-range", "History ");
        this.rangeSelect = el("select");
        this.rangeSelect.setAttribute("aria-label", "History time range");
        for (const [value, name] of [[60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"], [3600, "1 hour"]]) {
            const option = el("option", "", name);
            option.value = String(value);
            this.rangeSelect.append(option);
        }
        label.append(this.rangeSelect);
        heading.append(titleGroup, label);
        this.banner = el("div", "monitoring-banner", "Connecting to live telemetry…");
        this.banner.setAttribute("role", "status");
        this.timestamp = el("p", "monitoring-timestamp", "No sample received yet.");
        this.content = el("div", "monitoring-content");
        this.root.append(heading, this.banner, this.timestamp, this.content);
        overlay.append(this.root);
        this.onRange = () => {
            this.range = Number(this.rangeSelect.value);
            this.loadHistory();
            this.requestRender();
        };
        this.rangeSelect.addEventListener("change", this.onRange);
        this.onVisibility = () => this.requestRender();
        document.addEventListener("visibilitychange", this.onVisibility);
        this.overlayObserver = new MutationObserver(this.onVisibility);
        this.overlayObserver.observe(overlay, { attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "class", "style"] });
    }
    start() {
        this.transport = new ReconnectingTransport(`/ws/${this.slug}`, (sample) => {
            if (this.stopped) return;
            if (!this.snapshot || !finite(this.snapshot.timestamp) || !finite(sample.timestamp) ||
                sample.timestamp >= this.snapshot.timestamp) this.snapshot = sample;
            this.series.merge([this.compact(sample)]);
            this.receivedAt = Date.now();
            this.requestRender();
        }, (state) => {
            this.connection = state;
            this.requestRender();
        });
        // Connect first, then merge history into (not over) samples received in flight.
        this.transport.start();
        this.loadHistory();
        this.staleTimer = setInterval(() => this.requestRender(), 3000);
        this.requestRender();
    }
    compact(sample) { return sample; }
    async loadHistory() {
        const token = ++this.historyToken;
        this.historyController?.abort();
        clearTimeout(this.historyTimeout);
        const controller = new AbortController();
        this.historyController = controller;
        const timeout = setTimeout(() => controller.abort(), 10000);
        this.historyTimeout = timeout;
        this.historyError = "";
        try {
            const response = await fetch(`/api/${this.slug}/history?seconds=${this.range}&limit=600`,
                { signal: controller.signal, cache: "no-store" });
            if (!response.ok) throw new Error("History unavailable");
            const body = await response.json();
            if (!Array.isArray(body.samples)) throw new Error("Invalid history");
            if (this.stopped || token !== this.historyToken) return;
            // Prefer live data at identical timestamps.
            const live = this.series.samples.slice();
            this.series.merge(body.samples.slice(-600).map((sample) => this.compact(sample)));
            this.series.merge(live);
        } catch {
            if (!this.stopped && token === this.historyToken) {
                this.historyError = "History unavailable. Live updates continue; select a range to retry.";
            }
        } finally {
            clearTimeout(timeout);
            if (token === this.historyToken) this.historyController = null;
            this.requestRender();
        }
    }
    card(label, initial = "N/A", options = {}) {
        return new CircularProgressGauge(label, { initial, ...options });
    }
    section(title) {
        const section = el("section", "monitoring-section");
        section.append(el("h2", "", title));
        this.content.append(section);
        return section;
    }
    chart(container, title, lines, options = {}) {
        const chart = new CanvasChart(container, title, lines, options);
        this.charts.push(chart);
        return chart;
    }
    requestRender() {
        if (this.stopped || this.frame || !visible(this.root)) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            if (this.stopped || !visible(this.root)) return;
            this.renderStatus();
            this.render(this.snapshot || {});
            const now = Date.now() / 1000;
            const samples = this.series.range(this.range, now);
            for (const chart of this.charts) chart.update(samples, now - this.range, now);
        });
    }
    renderStatus() {
        const sample = this.snapshot;
        const stale = this.receivedAt && Date.now() - this.receivedAt > 15000;
        const oldSample = finite(sample?.timestamp) && Date.now() / 1000 - sample.timestamp > 15;
        let state = "live";
        let message = "Live · automatic updates";
        if (this.connection !== "connected") {
            state = "warning";
            message = this.connection === "reconnecting" ? "Reconnecting… showing last received values." : "Connecting to live telemetry…";
        } else if (sample?.status === "error") {
            state = "error";
            message = "Collection error · showing last available values; the service will retry.";
        } else if (stale || oldSample) {
            state = "warning";
            message = "Stale data · waiting for a fresh sample.";
        } else if (!sample || sample.status === "starting") {
            state = "warning";
            message = "Collector starting · waiting for the first sample.";
        } else if (sample.status === "degraded") {
            state = "warning";
            message = "Partial telemetry · some metrics are unavailable on this host.";
        }
        this.banner.dataset.state = state;
        this.banner.textContent = `${message}${this.historyError ? ` ${this.historyError}` : ""}`;
        if (finite(sample?.timestamp)) {
            const date = new Date(sample.timestamp * 1000);
            this.timestamp.textContent = `Sample: ${date.toLocaleString()} · ${date.toISOString()} · UNIX ${sample.timestamp}`;
        }
    }
    stop() {
        this.stopped = true;
        this.historyToken++;
        this.historyController?.abort();
        clearTimeout(this.historyTimeout);
        this.transport?.stop();
        clearInterval(this.staleTimer);
        cancelAnimationFrame(this.frame);
        this.rangeSelect.removeEventListener("change", this.onRange);
        document.removeEventListener("visibilitychange", this.onVisibility);
        this.overlayObserver.disconnect();
        for (const chart of this.charts) chart.stop();
        this.charts = [];
        this.series.clear();
        this.root.remove();
    }
}
