export const finite = (value) => typeof value === "number" && Number.isFinite(value);
export const number = (value, unit = "", digits = 1) =>
    finite(value) ? `${value.toLocaleString(undefined, { maximumFractionDigits: digits })}${unit}` : "N/A";
export function bytes(value, rate = false) {
    if (!finite(value) || value < 0) return "N/A";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const index = Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10));
    return `${number(value / (1024 ** index))} ${units[index]}${rate ? "/s" : ""}`;
}
export function text(value) {
    if (value === null || value === undefined) return "N/A";
    if (typeof value === "object") {
        try { return JSON.stringify(value); } catch { return "N/A"; }
    }
    return String(value);
}
export function el(tag, className = "", content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = text(content);
    return node;
}

const numberAnimations = new WeakMap();

export function animateNumber(node, targetValue, formatter = (v) => number(v), duration = 380) {
    const prev = numberAnimations.get(node);
    if (prev?.frame) cancelAnimationFrame(prev.frame);
    if (!finite(targetValue)) {
        numberAnimations.set(node, { value: null, frame: null });
        node.textContent = formatter(targetValue);
        return;
    }
    const startValue = finite(prev?.value) ? prev.value : null;
    if (startValue === null || Math.abs(targetValue - startValue) < 1e-6 ||
        !globalThis.requestAnimationFrame || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
        numberAnimations.set(node, { value: targetValue, frame: null });
        node.textContent = formatter(targetValue);
        return;
    }
    const startTime = globalThis.performance?.now?.() ?? Date.now();
    const state = { value: startValue, frame: null };
    numberAnimations.set(node, state);
    node.classList?.add?.("monitoring-updating");
    const step = (nowTimestamp) => {
        const now = finite(nowTimestamp) ? nowTimestamp : (globalThis.performance?.now?.() ?? Date.now());
        const elapsed = Math.max(0, now - startTime);
        const progress = Math.min(1, elapsed / duration);
        const eased = 1 - ((1 - progress) ** 3);
        const current = startValue + (targetValue - startValue) * eased;
        state.value = current;
        node.textContent = formatter(current);
        if (progress < 1 && node.isConnected !== false) {
            state.frame = requestAnimationFrame(step);
        } else {
            state.value = targetValue;
            state.frame = null;
            node.textContent = formatter(targetValue);
            node.classList?.remove?.("monitoring-updating");
        }
    };
    state.frame = requestAnimationFrame(step);
}
export function details(entries) {
    const list = el("dl", "monitoring-details");
    for (const [key, value] of entries) list.append(el("dt", "", key), el("dd", "", value));
    return list;
}
export function visible(node) {
    return !document.hidden && node.isConnected &&
        !node.closest("[hidden], [inert], [aria-hidden='true']") &&
        node.getClientRects().length > 0;
}

export class BoundedSeries {
    constructor(capacity = 14400, seconds = 3600) {
        this.capacity = capacity;
        this.seconds = seconds;
        this.samples = [];
    }
    merge(samples) {
        const values = new Map(this.samples.map((sample) => [sample.timestamp, sample]));
        for (const sample of samples) {
            if (sample && finite(sample.timestamp)) values.set(sample.timestamp, sample);
        }
        const sorted = [...values.values()].sort((a, b) => a.timestamp - b.timestamp);
        const cutoff = (sorted.at(-1)?.timestamp ?? 0) - this.seconds;
        this.samples = sorted.filter((sample) => sample.timestamp >= cutoff).slice(-this.capacity);
    }
    range(seconds, now = Date.now() / 1000) {
        return this.samples.filter((sample) => sample.timestamp >= now - seconds && sample.timestamp <= now);
    }
    clear() { this.samples = []; }
}

export class ReconnectingTransport {
    constructor(path, onSnapshot, onState, options = {}) {
        this.path = path;
        this.onSnapshot = onSnapshot;
        this.onState = onState;
        this.WebSocket = options.WebSocket || globalThis.WebSocket;
        this.setTimer = options.setTimeout || globalThis.setTimeout.bind(globalThis);
        this.clearTimer = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
        this.random = options.random || Math.random;
        this.stopped = true;
        this.attempt = 0;
        this.socket = null;
        this.timer = null;
        this.connectTimer = null;
    }
    start() {
        if (!this.stopped) return;
        this.stopped = false;
        this.connect();
    }
    connect() {
        if (this.stopped) return;
        this.onState(this.attempt ? "reconnecting" : "connecting");
        try {
            const url = new URL(this.path, globalThis.location?.href || "http://localhost");
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            const socket = new this.WebSocket(url.href);
            this.socket = socket;
            this.connectTimer = this.setTimer(() => {
                this.connectTimer = null;
                if (!this.stopped && this.socket === socket) socket.close();
            }, 10000);
            socket.onopen = () => {
                if (this.stopped || this.socket !== socket) return;
                this.clearTimer(this.connectTimer);
                this.connectTimer = null;
                this.attempt = 0;
                this.onState("connected");
            };
            socket.onmessage = (event) => {
                if (this.stopped || this.socket !== socket) return;
                try {
                    const message = JSON.parse(event.data);
                    if (["snapshot", "update"].includes(message.type) &&
                        message.data && typeof message.data === "object" && !Array.isArray(message.data)) {
                        this.onSnapshot(message.data);
                    }
                } catch { /* Ignore malformed frames; wait for the next valid sample. */ }
            };
            socket.onerror = () => {
                if (!this.stopped && this.socket === socket) this.onState("reconnecting");
                socket.close();
            };
            socket.onclose = () => {
                if (this.stopped || this.socket !== socket) return;
                this.clearTimer(this.connectTimer);
                this.connectTimer = null;
                socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
                this.socket = null;
                this.retry();
            };
        } catch {
            this.retry();
        }
    }
    retry() {
        if (this.stopped || this.timer !== null) return;
        this.onState("reconnecting");
        const delay = Math.min(30000, 1000 * (2 ** Math.min(this.attempt++, 5))) * (0.8 + this.random() * 0.4);
        this.timer = this.setTimer(() => {
            this.timer = null;
            this.connect();
        }, delay);
    }
    stop() {
        this.stopped = true;
        this.clearTimer(this.timer);
        this.clearTimer(this.connectTimer);
        this.timer = null;
        this.connectTimer = null;
        if (this.socket) {
            const socket = this.socket;
            this.socket = null;
            socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
            socket.close();
        }
    }
}
