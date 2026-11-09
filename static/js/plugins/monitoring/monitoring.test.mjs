import test from "node:test";
import assert from "node:assert/strict";
import { BoundedSeries, ReconnectingTransport, bytes, number } from "./core.js";
import { chartPoints } from "./chart.js";
import MonitoringDashboard from "./dashboard.js";
import { CPUDashboard } from "../cpu_stats/plugin.js";
import { NetworkDashboard } from "../network_manager/plugin.js";

class FakeNode {
    constructor(tag = "div") {
        this.tagName = tag;
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.listeners = new Map();
        this.isConnected = true;
        this.clientWidth = 400;
        this.value = "";
    }
    set textContent(value) { this.content = String(value); this.children = []; }
    get textContent() { return this.content || this.children.map((node) => node.textContent).join(""); }
    get firstChild() { return this.children[0]; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.content = ""; this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, callback) { this.listeners.set(key, callback); }
    removeEventListener(key) { this.listeners.delete(key); }
    getClientRects() { return [{}]; }
    closest() { return this.hiddenAncestor || null; }
    remove() { this.isConnected = false; }
}
class FakeObserver {
    static instances = [];
    constructor(callback) { this.callback = callback; FakeObserver.instances.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
}
class FakeSocket {
    static instances = [];
    constructor(url) { this.url = url; FakeSocket.instances.push(this); }
    close() { this.closed = true; this.onclose?.(); }
    open() { this.onopen?.(); }
    sample(data) { this.onmessage?.({ data: JSON.stringify({ type: "update", data }) }); }
}
const frames = new Map();
let frameId = 0;
globalThis.document = Object.assign(new FakeNode(), {
    createElement: (tag) => new FakeNode(tag),
    documentElement: new FakeNode("html"),
    hidden: false,
});
globalThis.window = { devicePixelRatio: 1 };
globalThis.MutationObserver = globalThis.ResizeObserver = FakeObserver;
globalThis.WebSocket = FakeSocket;
globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("series merges, deduplicates, sorts and bounds count/time", () => {
    const series = new BoundedSeries(3, 10);
    series.merge([{ timestamp: 20 }, { timestamp: 1 }, { timestamp: 15 }, { timestamp: null }, { timestamp: NaN }]);
    series.merge([{ timestamp: 20, cpu_percent: 99 }, { timestamp: 21 }, { timestamp: 22 }]);
    assert.deepEqual(series.samples.map((s) => s.timestamp), [20, 21, 22]);
    assert.equal(series.samples[0].cpu_percent, 99);
    assert.deepEqual(series.range(1, 22).map((s) => s.timestamp), [21, 22]);
    series.clear();
    assert.equal(series.samples.length, 0);
});

test("charts bound drawing and preserve null gaps; formatters never turn null into zero", () => {
    const samples = Array.from({ length: 4200 }, (_, timestamp) => ({ timestamp, value: timestamp === 5 ? null : 20 }));
    const points = chartPoints(samples, (s) => s.value);
    assert.ok(points.length <= 600);
    assert.equal(points[0].value, null);
    assert.equal(points[1].value, 20);
    assert.equal(number(null, "%"), "N/A");
    assert.equal(bytes(null, true), "N/A");
    assert.equal(bytes(1024, true), "1 KiB/s");
});

test("transport validates frames, backs off, and cannot reconnect after stop", () => {
    const timers = new Map();
    let id = 0;
    const states = [], samples = [];
    const transport = new ReconnectingTransport("/ws/cpu-stats", (s) => samples.push(s), (s) => states.push(s), {
        WebSocket: FakeSocket, random: () => 0.5,
        setTimeout: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
        clearTimeout: (key) => timers.delete(key),
    });
    transport.start();
    const socket = FakeSocket.instances.at(-1);
    assert.equal(socket.url, "ws://localhost/ws/cpu-stats");
    socket.open();
    socket.onmessage({ data: "invalid" });
    socket.onmessage({ data: '{"type":"update","data":[]}' });
    socket.sample({ timestamp: 1, status: "ok" });
    assert.equal(samples.length, 1);
    socket.close();
    assert.equal(states.at(-1), "reconnecting");
    assert.equal([...timers.values()][0].delay, 1000);
    const retry = [...timers.values()][0].callback;
    transport.stop();
    assert.equal(timers.size, 0);
    const before = FakeSocket.instances.length;
    retry();
    assert.equal(FakeSocket.instances.length, before);
    assert.equal(socket.onmessage, null);
});

class TestDashboard extends MonitoringDashboard {
    constructor() { super(new FakeNode(), "cpu-stats", "Test", ""); }
    render() { this.renderCount = (this.renderCount || 0) + 1; }
}

test("socket-before-history reconciles racing samples and disposes pending work", async () => {
    let resolveHistory;
    globalThis.fetch = () => new Promise((resolve) => { resolveHistory = resolve; });
    const panel = new TestDashboard();
    panel.start();
    const socket = FakeSocket.instances.at(-1);
    socket.open();
    socket.sample({ timestamp: 101, cpu_percent: 80, status: "ok" });
    resolveHistory({ ok: true, json: async () => ({ samples: [
        { timestamp: 100, cpu_percent: 20 }, { timestamp: 101, cpu_percent: 10 },
    ] }) });
    await settle();
    assert.equal(panel.series.samples.length, 2);
    assert.equal(panel.series.samples[1].cpu_percent, 80);
    assert.equal(panel.snapshot.cpu_percent, 80);
    panel.stop();
    assert.ok(socket.closed);
    assert.ok(panel.overlayObserver.disconnected);
    assert.equal(panel.rangeSelect.listeners.size, 0);
    assert.equal(panel.series.samples.length, 0);
    assert.equal(frames.size, 0);
});

test("out-of-order range fetches and late disposed responses are ignored", async () => {
    const requests = [];
    globalThis.fetch = (_url, options) => new Promise((resolve) => requests.push({ resolve, options }));
    const panel = new TestDashboard();
    const first = panel.loadHistory();
    panel.range = 300;
    const second = panel.loadHistory();
    assert.ok(requests[0].options.signal.aborted);
    requests[1].resolve({ ok: true, json: async () => ({ samples: [{ timestamp: 2 }] }) });
    await second;
    requests[0].resolve({ ok: true, json: async () => ({ samples: [{ timestamp: 1 }] }) });
    await first;
    assert.deepEqual(panel.series.samples.map((s) => s.timestamp), [2]);
    const third = panel.loadHistory();
    panel.stop();
    requests[2].resolve({ ok: true, json: async () => ({ samples: [{ timestamp: 3 }] }) });
    await third;
    assert.equal(panel.series.samples.length, 0);
});

test("hidden overlays skip rendering; restore schedules rendering", () => {
    const panel = new TestDashboard();
    panel.root.hiddenAncestor = {};
    panel.requestRender();
    assert.equal(frames.size, 0);
    panel.root.hiddenAncestor = null;
    panel.onVisibility();
    assert.equal(frames.size, 1);
    const callback = [...frames.values()][0];
    frames.clear();
    callback();
    assert.equal(panel.renderCount, 1);
    panel.stop();
});

test("CPU dashboard renders null values honestly, sorts processes and uses safe text", () => {
    const panel = new CPUDashboard(new FakeNode());
    panel.render({ cpu_percent: null, per_core: [null, 25], processes: [
        { pid: 1, name: "<img src=x onerror=alert(1)>", cpu_percent: null },
        { pid: 2, name: "busy", cpu_percent: 80 },
    ] });
    assert.equal(panel.cards.usage.value.textContent, "N/A");
    assert.equal(panel.cards.usage.currentPercent, 0);
    panel.render({ cpu_percent: 72, memory: { percent: 64.5, used: 8 * (1024 ** 3), total: 16 * (1024 ** 3) }, per_core: [50, 25], processes: [] });
    assert.equal(panel.cards.usage.currentPercent, 72);
    assert.equal(panel.cards.memory.currentPercent, 64.5);
    assert.equal(panel.cards.memory.value.textContent, "64.5%");
    assert.match(panel.hardware.textContent, /8 GiB \/ 16 GiB/);
    assert.match(panel.cards.usage.progressRing.attributes["stroke-dasharray"], /^425\.2 /);
    panel.render({ cpu_percent: null, memory: null, per_core: [null, 25], processes: [
        { pid: 1, name: "<img src=x onerror=alert(1)>", cpu_percent: null },
        { pid: 2, name: "busy", cpu_percent: 80 },
    ] });
    assert.equal(panel.processes.children[0].children[1].textContent, "busy");
    assert.equal(panel.processes.children[1].children[1].textContent, "<img src=x onerror=alert(1)>");
    assert.equal(panel.processes.children[1].children[2].textContent, "N/A");
    const compacted = panel.compact({ timestamp: 1, memory: { percent: 55 }, processes: [{}] });
    assert.equal("processes" in compacted, false);
    assert.deepEqual(compacted.memory, { percent: 55 });
    assert.equal(panel.charts.length, 6);
    assert.equal(panel.charts[1].lines[0].value({ memory: { percent: 64.5 } }), 64.5);
    panel.coreSelect.value = "1";
    panel.onCore();
    assert.equal(panel.charts[4].lines[0].value({ per_core: [10, 70] }), 70);
    assert.deepEqual(panel.charts[5].lines.map((line) => line.value({ times: { user: 5, system: 10, idle: 85, iowait: null } })),
        [5, 10, 85, null]);
    panel.stop();
    assert.ok(panel.charts.length === 0);
    assert.equal(panel.coreSelect.listeners.size, 0);
});

test("network keeps disappearing selection explicit and does not infer internet availability", () => {
    const panel = new NetworkDashboard(new FakeNode());
    panel.render({ timestamp: 1, interfaces: [{ name: "en0", type: "wifi", state: "connected", is_up: true,
        recv_rate: null, sent_rate: null, metadata: { ssid: "<script>bad</script>" } }],
    connections: { wifi: { state: "connected", interfaces: ["en0"] } }, capabilities: { wifi: { supported: true, available: false } } });
    assert.equal(panel.selected, "en0");
    assert.equal(panel.technologies.get("wifi").state.textContent, "Link connected");
    assert.match(panel.metadata.textContent, /<script>bad<\/script>/);
    assert.equal(panel.receive.value.textContent, "N/A");
    panel.render({ interfaces: [] });
    assert.equal(panel.selected, "en0");
    assert.match(panel.interfaceSelect.textContent, /no longer present/);
    assert.match(panel.interfaceStatus.textContent, /Interface unavailable/);
    assert.deepEqual(Object.keys(panel.compact({ interfaces: [{ name: "a", mac: "secret", recv_rate: 1 }] }).interfaces[0]),
        ["name", "recv_rate", "sent_rate"]);
    assert.equal(panel.tabs.order.length, 4);
    panel.tabs.select("controls");
    assert.equal(panel.tabs.activeId, "controls");
    assert.equal(panel.controls.tabs.order.length, 4);
    panel.controls.tabs.select("bluetooth");
    assert.equal(panel.controls.tabs.activeId, "bluetooth");
    panel.tabs.select("overview");
    panel.technologies.get("ethernet").section.listeners.get("click")();
    assert.equal(panel.tabs.activeId, "controls");
    assert.equal(panel.controls.activeSection, "interfaces");
    panel.charts[0].toggleSeries(0);
    assert.equal(panel.charts[0].hiddenSeries.has(0), true);
    panel.charts[0].toggleSeries(0);
    assert.equal(panel.charts[0].hiddenSeries.has(0), false);
    panel.stop();
    assert.equal(panel.interfaceSelect.listeners.size, 0);
});
