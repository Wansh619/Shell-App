import Plugin from "../plugin.js";
import MonitoringDashboard from "../monitoring/dashboard.js";
import { animateNumber, bytes, details, el, finite, number, text } from "../monitoring/core.js";
import TabController from "../monitoring/tabs.js";

export class CPUDashboard extends MonitoringDashboard {
    constructor(overlay) {
        super(overlay, "cpu-stats", "CPU overview", "Host utilization, thermal headroom, and process activity.");
        const summary = el("div", "monitoring-summary");
        this.cards = {};
        for (const [key, label, accent, subtitle] of [
            ["usage", "System Load", "primary", "CORE OPERATIONAL"],
            ["memory", "RAM Usage", "secondary", "MEMORY CONSUMPTION"],
            ["frequency", "Clock Freq", "secondary", "FREQ SCALING"],
            ["temperature", "Thermal Core", "tertiary", "THERMAL SENSOR"],
            ["cores", "CPU Cores", "fourth", "TOPOLOGY ONLINE"],
        ]) {
            this.cards[key] = this.card(label, "N/A", { accent, subtitle });
            summary.append(this.cards[key].card);
        }
        this.content.append(summary);

        const overviewPane = el("div", "monitoring-tab-stack");
        const charts = el("div", "monitoring-chart-grid");
        overviewPane.append(charts);
        this.chart(charts, "CPU utilization", [{ label: "Usage", value: (s) => s.cpu_percent }], { max: 100, format: (v) => number(v, "%") });
        this.chart(charts, "RAM consumption & spikes", [{ label: "RAM Usage", value: (s) => s.memory?.percent }], { max: 100, format: (v) => number(v, "%") });
        this.chart(charts, "Clock frequency", [{ label: "Frequency", value: (s) => s.frequency?.current }], { format: (v) => number(v, " MHz", 0) });
        this.chart(charts, "CPU temperature", [{ label: "Temperature", value: (s) => s.temperature }], { format: (v) => number(v, " °C") });

        this.times = el("div", "monitoring-time-grid");
        this.timeNodes = new Map();
        for (const key of ["user", "system", "idle", "iowait"]) {
            const item = el("div", "monitoring-time");
            const val = el("strong", "", "N/A");
            const track = el("div", "monitoring-progress-track");
            const fill = el("div", "monitoring-progress-fill");
            track.append(fill);
            item.append(el("span", "monitoring-label", key), val, track);
            this.times.append(item);
            this.timeNodes.set(key, { val, fill });
        }
        const timesSection = el("section", "monitoring-section");
        timesSection.append(el("h2", "", "CPU time breakdown"), this.times);
        overviewPane.append(timesSection);

        const coresPane = el("div", "monitoring-tab-stack");
        this.cores = el("div", "monitoring-cores");
        this.coreNodes = [];
        const coreSection = el("section", "monitoring-section");
        coreSection.append(el("h2", "", "Per-core utilization"), this.cores);
        this.selectedCore = 0;
        const coreLabel = el("label", "monitoring-interface-label", "Core history ");
        this.coreSelect = el("select");
        this.coreSelect.setAttribute("aria-label", "CPU core history");
        coreLabel.append(this.coreSelect);
        coreSection.append(coreLabel);
        this.onCore = () => {
            this.selectedCore = Number(this.coreSelect.value);
            this.requestRender();
        };
        this.coreSelect.addEventListener("change", this.onCore);
        this.chart(coreSection, "Selected core · utilization history", [
            { label: "Selected core", value: (s) => s.per_core?.[this.selectedCore] },
        ], { max: 100, format: (v) => number(v, "%") });
        coresPane.append(coreSection);

        this.chart(timesSection, "CPU time · percentage history", [
            { label: "User (solid)", value: (s) => s.times?.user },
            { label: "System (dashed)", value: (s) => s.times?.system },
            { label: "Idle (dotted)", value: (s) => s.times?.idle },
            { label: "I/O wait (dash-dot)", value: (s) => s.times?.iowait },
        ], { max: 100, format: (v) => number(v, "%") });

        const processesPane = el("div", "monitoring-tab-stack");
        const processes = el("section", "monitoring-section");
        processes.append(el("h2", "", "Top processes"),
            el("p", "monitoring-muted", "Process CPU may exceed 100% on multicore hosts. Process discovery refreshes less frequently than CPU metrics."));
        const scroll = el("div", "monitoring-table-wrap");
        const table = el("table", "monitoring-table");
        table.append(el("caption", "monitoring-sr-only", "Processes ordered by CPU utilization"));
        const head = el("thead"), row = el("tr");
        for (const title of ["PID", "Process", "CPU", "Memory"]) {
            const cell = el("th", "", title);
            cell.scope = "col";
            row.append(cell);
        }
        head.append(row);
        this.processes = el("tbody");
        table.append(head, this.processes);
        scroll.append(table);
        processes.append(scroll);
        this.hardware = el("div");
        const hardwareSection = el("section", "monitoring-section");
        hardwareSection.append(el("h2", "", "Processor details"), this.hardware);
        this.capabilities = el("div");
        const disclosure = el("details", "monitoring-capabilities");
        disclosure.append(el("summary", "", "Collection capabilities"), this.capabilities);
        processesPane.append(processes, hardwareSection, disclosure);

        this.tabs = new TabController(this.content, [
            { id: "overview", label: "Overview & Area Plots", content: overviewPane },
            { id: "cores", label: "Per-Core Telemetry", content: coresPane },
            { id: "processes", label: "Top Processes & Hardware", content: processesPane },
        ], { onChange: () => this.requestRender() });
    }
    compact(sample = {}) {
        if (!sample) return {};
        return {
            timestamp: sample.timestamp, cpu_percent: sample.cpu_percent,
            memory: sample.memory,
            frequency: sample.frequency, temperature: sample.temperature,
            per_core: sample.per_core, times: sample.times,
        };
    }
    render(sample) {
        this.cards.usage.updateValue(sample.cpu_percent, (v) => number(v, "%"), {
            percent: sample.cpu_percent,
            statusText: finite(sample.cpu_percent) ? "CORE OPERATIONAL" : "SAMPLING BASELINE",
        });
        const memPct = sample.memory?.percent;
        const memUsed = sample.memory?.used;
        const memTotal = sample.memory?.total;
        const memStatus = finite(memUsed) && finite(memTotal)
            ? `${bytes(memUsed)} / ${bytes(memTotal)}`
            : (finite(memPct) ? "MEMORY CONSUMPTION" : "MEMORY UNAVAILABLE");
        this.cards.memory.updateValue(memPct, (v) => number(v, "%"), {
            percent: memPct,
            statusText: memStatus,
        });
        const freqMax = finite(sample.frequency?.max) && sample.frequency.max > 0
            ? sample.frequency.max
            : (finite(sample.frequency?.current) ? Math.max(4000, sample.frequency.current * 1.25) : 4000);
        this.cards.frequency.updateValue(sample.frequency?.current, (v) => number(v, " MHz", 0), {
            max: freqMax,
            statusText: finite(sample.frequency?.current) ? "CLOCK ACTIVE" : "FREQ UNAVAILABLE",
        });
        this.cards.temperature.updateValue(sample.temperature, (v) => number(v, " °C"), {
            max: 100,
            statusText: finite(sample.temperature) ? "THERMAL NOMINAL" : "SENSOR UNAVAILABLE",
        });
        const phys = sample.core_count?.physical;
        const logi = sample.core_count?.logical;
        const coreRatio = finite(phys) && finite(logi) && logi > 0 ? (phys / logi) * 100 : (finite(logi) ? 100 : 0);
        this.cards.cores.updateText(`${number(phys, "", 0)} / ${number(logi, "", 0)}`, {
            percent: coreRatio,
            statusText: finite(logi) ? "TOPOLOGY ONLINE" : "AWAITING TELEMETRY",
        });
        const cores = (Array.isArray(sample.per_core) ? sample.per_core : []).slice(0, 512);
        if (this.coreOptionCount !== cores.length) {
            this.coreOptionCount = cores.length;
            if (this.selectedCore >= cores.length) this.selectedCore = 0;
            const options = cores.map((_value, index) => {
                const option = el("option", "", `Core ${index}`);
                option.value = String(index);
                return option;
            });
            if (!options.length) {
                const empty = el("option", "", "N/A · no core telemetry");
                empty.value = "0";
                options.push(empty);
            }
            this.coreSelect.replaceChildren(...options);
        }
        this.coreSelect.value = String(this.selectedCore);
        if (!cores.length) {
            this.coreNodes = [];
            this.cores.replaceChildren(el("p", "monitoring-muted", "Per-core telemetry unavailable."));
        } else {
            if (this.coreNodes.length !== cores.length) {
                this.coreNodes = cores.map((_v, index) => {
                    const card = el("div", "monitoring-core");
                    const label = el("span", "", `Core ${index}`);
                    const val = el("strong", "", "N/A");
                    const meter = el("meter");
                    meter.min = 0;
                    meter.max = 100;
                    meter.setAttribute("aria-label", `Core ${index} utilization`);
                    const track = el("div", "monitoring-progress-track");
                    const fill = el("div", "monitoring-progress-fill");
                    track.append(fill);
                    card.append(label, val, track, meter);
                    return { card, val, meter, track, fill };
                });
                this.cores.replaceChildren(...this.coreNodes.map((n) => n.card));
            }
            cores.forEach((value, index) => {
                const node = this.coreNodes[index];
                animateNumber(node.val, value, (v) => number(v, "%"));
                const pct = finite(value) ? Math.max(0, Math.min(100, value)) : 0;
                node.meter.value = pct;
                node.meter.hidden = !finite(value);
                node.track.hidden = !finite(value);
                if (node.fill.style) node.fill.style.width = `${pct}%`;
                node.fill.setAttribute("data-percent", String(Math.round(pct)));
            });
        }
        for (const key of ["user", "system", "idle", "iowait"]) {
            const view = this.timeNodes.get(key);
            const value = sample.times?.[key];
            animateNumber(view.val, value, (v) => number(v, "%"));
            const pct = finite(value) ? Math.max(0, Math.min(100, value)) : 0;
            if (view.fill.style) view.fill.style.width = `${pct}%`;
        }
        this.hardware.replaceChildren(details([
            ["Minimum frequency", number(sample.frequency?.min, " MHz", 0)],
            ["Maximum frequency", number(sample.frequency?.max, " MHz", 0)],
            ["RAM used / total", finite(memUsed) && finite(memTotal) ? `${bytes(memUsed)} / ${bytes(memTotal)}` : "N/A"],
            ["Load average · 1 / 5 / 15 min", Array.isArray(sample.load_average) ? sample.load_average.map((v) => number(v, "", 2)).join(" / ") : "N/A"],
        ]));
        const processes = (Array.isArray(sample.processes) ? sample.processes : []).slice()
            .sort((a, b) => (finite(b.cpu_percent) ? b.cpu_percent : -1) - (finite(a.cpu_percent) ? a.cpu_percent : -1))
            .slice(0, 50);
        this.processes.replaceChildren(...processes.map((process) => {
            const row = el("tr");
            for (const value of [text(process.pid), text(process.name), number(process.cpu_percent, "%"), number(process.memory_percent, "%")]) {
                row.append(el("td", "", value));
            }
            return row;
        }));
        if (!processes.length) {
            const row = el("tr"), cell = el("td", "monitoring-muted", "Process telemetry unavailable or warming up.");
            cell.colSpan = 4;
            row.append(cell);
            this.processes.append(row);
        }
        this.capabilities.replaceChildren(details(Object.entries(sample.capabilities || {})));
    }
    stop() {
        this.tabs?.stop();
        this.coreSelect.removeEventListener("change", this.onCore);
        super.stop();
    }
}

export default class CPUStatsPlugin extends Plugin {
    constructor() {
        super("CPU Stats", "cpu.svg");
        this.dashboard = null;
    }
    async start({ overlay }) {
        this.dashboard?.stop();
        this.dashboard = new CPUDashboard(overlay);
        this.dashboard.start();
    }
    async stop() {
        this.dashboard?.stop();
        this.dashboard = null;
    }
}
