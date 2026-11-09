import test from "node:test";
import assert from "node:assert/strict";
import { NetworkControls } from "./controls.js";

class FakeNode {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.dataset = {};
        this.listeners = new Map();
        this.value = "";
        this.ownText = "";
    }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map((node) => node.textContent).join(""); }
    set innerHTML(_) { throw new Error("Unsafe HTML rendering"); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.ownText = ""; }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(event, handler) { this.listeners.set(event, [...(this.listeners.get(event) || []), handler]); }
    removeEventListener(event, handler) {
        this.listeners.set(event, (this.listeners.get(event) || []).filter((item) => item !== handler));
    }
    fire(event) { for (const handler of this.listeners.get(event) || []) handler(); }
    remove() { this.removed = true; }
}
globalThis.document = { createElement: (tag) => new FakeNode(tag) };
const response = (body, ok = true) => ({ ok, json: async () => body });
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};
const ACTIONS = ["wifi_scan", "wifi_connect", "wifi_disconnect", "bluetooth_refresh",
    "bluetooth_connect", "bluetooth_disconnect", "interface_up", "interface_down"];
function snapshot(extra = {}) {
    return {
        platform: "fake-native",
        capabilities: Object.fromEntries(ACTIONS.map((action) => [action, { supported: true, reason: "" }])),
        interfaces: [{ name: "wlan0", type: "wifi", is_up: true, ssid: "Existing network" }],
        wifi_networks: [{ id: "network-1", interface: "wlan0", ssid: "<img onerror=alert(1)>", security: "wpa-personal", signal: 77 }],
        bluetooth_devices: [{ id: "paired-1", name: "<script>device</script>", paired: true, connected: false, transport: "classic" },
            { id: "unpaired", name: "Not paired", paired: false }],
        operations: [],
        ...extra,
    };
}
function setup(options = {}) {
    const calls = [];
    const view = new NetworkControls(new FakeNode("main"), {
        fetch: async (...args) => { calls.push(args); return response({ operation: { id: "op-1", action: "wifi_connect", status: "pending", updated_at: 1 } }); },
        confirm: () => true,
        ...options,
    });
    return { view, calls };
}
function descendants(node, tag) {
    return node.children.flatMap((child) => [
        ...(child.tagName === tag ? [child] : []), ...descendants(child, tag),
    ]);
}

test("initial GET is once-only, cached, and never requests discovery", async () => {
    const calls = [];
    const { view } = setup({ fetch: async (...args) => { calls.push(args); return response(snapshot()); } });
    await view.start();
    await view.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/api/network-manager/control");
    assert.equal(calls[0][1].method, undefined);
    assert.equal(view.wifiInterface.value, "wlan0");
    assert.equal(view.device.children.length, 2);
    assert.match(view.root.textContent, /<img onerror=alert\(1\)>/);
    assert.match(view.root.textContent, /<script>device<\/script>/);
    assert.equal(descendants(view.root, "script").length, 0);
    view.stop();
});

test("live snapshot wins over a late initial GET", async () => {
    const pending = deferred();
    const { view } = setup({ fetch: () => pending.promise });
    const start = view.start();
    view.render(snapshot({ platform: "new-live" }));
    pending.resolve(response(snapshot({ platform: "stale-get" })));
    await start;
    assert.equal(view.snapshot.platform, "new-live");
    view.stop();
});

test("unsupported capability reasons and missing targets disable actions", () => {
    const { view, calls } = setup();
    const control = snapshot({ bluetooth_devices: [] });
    control.capabilities.wifi_scan = { supported: false, reason: "CoreWLAN privacy permission denied." };
    view.render(control);
    assert.equal(view.buttons.get("wifi_scan").button.disabled, true);
    assert.match(view.buttons.get("wifi_scan").reason.textContent, /permission denied/);
    assert.equal(view.buttons.get("bluetooth_connect").button.disabled, true);
    view.dispatch("wifi_scan", { interface: "wlan0" });
    assert.equal(calls.length, 0);
    view.stop();
});

test("Wi-Fi connect is flat JSON, confirmed, transient and not falsely connected", async () => {
    const pending = deferred();
    const calls = [];
    let confirmed = 0;
    const { view } = setup({
        fetch: (...args) => { calls.push(args); return pending.promise; },
        confirm: () => { confirmed++; return true; },
    });
    view.render(snapshot());
    view.password.value = "fake-only-password";
    const params = { interface: "wlan0", ssid: "Test network", security: "wpa-personal", password: view.password.value };
    const dispatch = view.dispatch("wifi_connect", params);
    assert.equal(view.password.value, "");
    assert.equal(params.password, undefined);
    assert.equal(confirmed, 1);
    assert.equal(calls.length, 1);
    const [path, request] = calls[0];
    assert.equal(path, "/api/network-manager/actions");
    assert.deepEqual(request.headers, { "Content-Type": "application/json", "X-Network-Control": "1" });
    const payload = JSON.parse(request.body);
    assert.deepEqual(payload, { action: "wifi_connect", interface: "wlan0", ssid: "Test network",
        security: "wpa-personal", password: "fake-only-password", confirmed: true });
    assert.equal(payload.params, undefined);
    pending.resolve(response({ operation: { id: "op-1", action: "wifi_connect", target: "wlan0",
        status: "submitted", updated_at: 2, message: "Requested" } }));
    await dispatch;
    assert.match(view.operations.textContent, /not yet observed connected/);
    assert.doesNotMatch(view.root.textContent, /fake-only-password/);
    assert.equal(view.localOperations.get("op-1").password, undefined);
    view.stop();
});

test("destructive actions and all connects require UI confirmation; refusal sends nothing", async () => {
    let confirmations = 0;
    const { view, calls } = setup({ confirm: () => { confirmations++; return false; } });
    view.render(snapshot());
    for (const action of ["wifi_connect", "wifi_disconnect", "bluetooth_disconnect", "interface_down", "checkpoint_revert"]) {
        await view.dispatch(action, { interface: "wlan0" });
    }
    assert.equal(confirmations, 5);
    assert.equal(calls.length, 0);
    view.stop();
});

test("cancelled Wi-Fi confirmation clears password without dispatch", async () => {
    const { view, calls } = setup({ confirm: () => false });
    view.render(snapshot());
    view.password.value = "fake-cancelled-password";
    const params = { interface: "wlan0", ssid: "Test", security: "wpa-personal", password: view.password.value };
    await view.dispatch("wifi_connect", params);
    assert.equal(view.password.value, "");
    assert.equal(params.password, undefined);
    assert.equal(calls.length, 0);
    view.stop();
});

test("checkpoint revert confirms and sends confirmed flag with original operation", async () => {
    let confirmation = "";
    const { view, calls } = setup({ confirm: (message) => { confirmation = message; return true; } });
    view.render(snapshot());
    await view.dispatch("checkpoint_revert", { operation_id: "original-guarded-operation" });
    assert.match(confirmation, /Revert checkpointed network change/);
    assert.deepEqual(JSON.parse(calls[0][1].body), {
        action: "checkpoint_revert", operation_id: "original-guarded-operation", confirmed: true,
    });
    view.stop();
});

test("saved and open selection never reuse a WPA password; form state survives telemetry", () => {
    const { view } = setup();
    view.render(snapshot());
    view.security.value = "wpa-personal";
    view.securityFields();
    view.password.value = "fake-password";
    view.ssid.value = "Typing network";
    view.render(snapshot({ updated_at: 99 }));
    assert.equal(view.password.value, "fake-password");
    assert.equal(view.ssid.value, "Typing network");
    view.security.value = "saved";
    view.security.fire("change");
    assert.equal(view.password.value, "");
    assert.equal(view.password.disabled, true);
    assert.equal(view.profile.disabled, false);
    view.security.value = "open";
    view.security.fire("change");
    assert.equal(view.profile.disabled, true);
    view.stop();
});

test("checkpoint countdown exists only for real checkpoint and references guarded operation", async () => {
    const { view, calls } = setup({ now: () => 100000 });
    view.render(snapshot({ operations: [{ id: "original-operation", action: "interface_down",
        status: "awaiting_confirmation", checkpoint: { id: "native-checkpoint", expires_at: 130 } }] }));
    assert.match(view.operations.textContent, /30s remaining/);
    const buttons = descendants(view.operations, "button");
    assert.deepEqual(buttons.map((node) => node.textContent), ["Keep change", "Revert change"]);
    await view.dispatch("checkpoint_confirm", { operation_id: "original-operation" });
    assert.deepEqual(JSON.parse(calls[0][1].body), { action: "checkpoint_confirm", operation_id: "original-operation" });
    view.render(snapshot({ operations: [{ id: "no-checkpoint", action: "interface_down", status: "submitted" }] }));
    assert.doesNotMatch(view.operations.textContent, /OS rollback checkpoint/);
    view.stop();
});

test("HTTP error remains safe and visible, including permission and cooldown failures", async () => {
    for (const code of ["permission_denied", "cooldown", "unsupported"]) {
        const { view } = setup({ fetch: async () => response({ error: { code, message: "Safe public error" } }, false) });
        view.render(snapshot());
        await view.dispatch("interface_up", { interface: "wlan0" });
        assert.equal(view.feedback.textContent, `${code}: Safe public error`);
        view.render(snapshot());
        assert.equal(view.feedback.textContent, `${code}: Safe public error`);
        assert.equal(view.buttons.get("interface_up").button.disabled, false);
        view.stop();
    }
});

test("late POST cannot regress an advanced live operation", async () => {
    const pending = deferred();
    const { view } = setup({ fetch: () => pending.promise });
    view.render(snapshot());
    const dispatch = view.dispatch("interface_up", { interface: "wlan0" });
    view.render(snapshot({ operations: [{ id: "op-1", action: "interface_up", status: "succeeded", updated_at: 10 }] }));
    pending.resolve(response({ operation: { id: "op-1", action: "interface_up", status: "pending", updated_at: 1 } }));
    await dispatch;
    assert.match(view.operations.textContent, /succeeded/);
    assert.doesNotMatch(view.operations.textContent, /pending/);
    view.stop();
});

test("stop aborts requests, clears password and ignores stale response", async () => {
    const pending = deferred();
    let signal;
    const { view } = setup({ fetch: (_, options) => { signal = options.signal; return pending.promise; } });
    const start = view.start();
    view.password.value = "fake-stop-password";
    view.stop();
    assert.equal(signal.aborted, true);
    assert.equal(view.password.value, "");
    assert.equal(view.root.removed, true);
    pending.resolve(response(snapshot()));
    await start;
    assert.equal(view.snapshot, null);
    assert.equal(view.requests.size, 0);
});

test("stop while POST is pending cannot restore operations", async () => {
    const pending = deferred();
    let signal;
    const { view } = setup({ fetch: (_, options) => { signal = options.signal; return pending.promise; } });
    view.render(snapshot());
    const dispatch = view.dispatch("interface_up", { interface: "wlan0" });
    view.stop();
    pending.resolve(response({ operation: { id: "late", action: "interface_up", status: "pending" } }));
    await dispatch;
    assert.equal(signal.aborted, true);
    assert.equal(view.localOperations.size, 0);
});

test("dashboard preserves chart scopes, compact history and missing interface selection", async () => {
    const { NetworkDashboard } = await import("./plugin.js");
    globalThis.MutationObserver = globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.cancelAnimationFrame = () => {};
    document.addEventListener = document.removeEventListener = () => {};
    const dashboard = new NetworkDashboard(new FakeNode("main"));
    const control = snapshot({ details: { wlan0: { gateways: ["192.0.2.1"], dns: ["192.0.2.53"],
        routes: [{ destination: "0.0.0.0/0" }], method: "dhcp", source: "fake native" } } });
    const sample = { timestamp: 1, totals: { recv_rate: 12, sent_rate: 4 }, control,
        interfaces: [{ name: "wlan0", type: "wifi", state: "connected", is_up: true,
            recv_rate: 12, sent_rate: 4, addresses: [{ family: "IPv4", address: "192.0.2.5",
                prefix_length: 24, network_cidr: "192.0.2.0/24" }] }] };
    dashboard.render(sample);
    assert.equal(dashboard.controls.snapshot, control);
    assert.match(dashboard.addresses.textContent, /192\.0\.2\.0\/24/);
    assert.match(dashboard.nativeDetails.textContent, /192\.0\.2\.53/);
    assert.match(dashboard.nativeDetails.textContent, /dhcp/);
    const compact = dashboard.compact(sample);
    assert.equal(compact.control, undefined);
    assert.deepEqual(compact.interfaces, [{ name: "wlan0", recv_rate: 12, sent_rate: 4 }]);
    assert.equal(dashboard.charts.length, 2);
    assert.equal(dashboard.charts[0].lines[0].value(sample), 12);
    assert.equal(dashboard.charts[1].lines[0].value(sample), 12);
    dashboard.render({ ...sample, interfaces: [] });
    assert.equal(dashboard.selected, "wlan0");
    assert.match(dashboard.interfaceSelect.textContent, /no longer present/);
    dashboard.stop();
    assert.equal(dashboard.controls.stopped, true);
    assert.equal(dashboard.charts.length, 0);
});

test("tile-based panels render available connections and open auth drawer only when required", async () => {
    const { view, calls } = setup();
    view.render(snapshot({
        wifi_networks: [
            { id: "open-net", interface: "wlan0", ssid: "GuestWiFi", security: "open", signal: 92, connected: false },
            { id: "wpa-net", interface: "wlan0", ssid: "SecureCorp", security: "wpa-personal", signal: 80, connected: false },
        ],
    }));
    // Available connections appear in both dropdown and tile grid (including unpaired Bluetooth devices)
    assert.equal(view.wifiPanel.tileGrid.children.length, 2);
    assert.equal(view.bluetoothPanel.tileGrid.children.length, 2);
    assert.equal(view.interfacePanel.tileGrid.children.length, 1);
    assert.equal(view.wifiPanel.authDrawer.hidden, true);

    // Selecting WPA network without password and clicking Connect opens auth drawer without dispatching yet
    view.network.value = "wpa-net";
    view.network.fire("change");
    view.buttons.get("wifi_connect").button.fire("click");
    assert.equal(view.wifiPanel.authDrawer.hidden, false);
    assert.equal(calls.length, 0);

    // Selecting Open network and clicking Connect closes auth drawer and dispatches immediately
    view.network.value = "open-net";
    view.network.fire("change");
    assert.equal(view.wifiPanel.authDrawer.hidden, true);
    view.buttons.get("wifi_connect").button.fire("click");
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0][1].body).ssid, "GuestWiFi");
    view.stop();
});

test("Android quick-settings tiles, drop-down transition, interface switcher, labeled list, and detail pop-up work end-to-end", async () => {
    const { view, calls } = setup();
    view.render(snapshot({
        interfaces: [
            { name: "wlan0", type: "wifi", is_up: true, ssid: "OfficeNet" },
            { name: "wlan1", type: "wifi", is_up: true, ssid: "" },
        ],
        wifi_networks: [
            { id: "conn-net", interface: "wlan0", ssid: "OfficeNet", security: "saved", signal: 88, connected: true },
            { id: "open-net", interface: "wlan0", ssid: "FreeCafe", security: "open", signal: 74, connected: false },
            { id: "ext-net", interface: "wlan1", ssid: "ExtLab", security: "open", signal: 91, connected: false },
        ],
        details: {
            wlan0: { gateways: ["10.0.0.1"], dns: ["1.1.1.1"], method: "dhcp" },
        },
    }));

    // 1. Android Quick-Settings ControlTile Menu-to-Container drilldown and Back button
    assert.equal(view.quickTiles.size, 4);
    assert.equal(view.root.dataset.viewMode, "menu");
    assert.equal(view.activeSection, "wifi");
    assert.equal(view.tabs.tabs.get("wifi").panel.dataset.dropdown, "open");
    assert.equal(view.quickTiles.get("wifi").tile.dataset.state, "connected");
    view.quickTiles.get("bluetooth").tile.fire("click");
    assert.equal(view.root.dataset.viewMode, "container");
    assert.equal(view.activeSection, "bluetooth");
    assert.equal(view.tabs.activeId, "bluetooth");
    assert.equal(view.tabs.tabs.get("bluetooth").panel.dataset.dropdown, "open");
    assert.equal(view.tabs.tabs.get("wifi").panel.dataset.dropdown, "closed");
    view.bluetoothPanel.backBtn.fire("click");
    assert.equal(view.root.dataset.viewMode, "menu");
    view.quickTiles.get("wifi").tile.fire("click");
    assert.equal(view.root.dataset.viewMode, "container");
    assert.equal(view.activeSection, "wifi");

    // 2. Labeled Wi-Fi list items (SSID name, Connected to wlan0 & Open)
    assert.equal(view.wifiPanel.tileGrid.children.length, 2);
    assert.match(view.wifiPanel.tileGrid.children[0].textContent, /SSID: OfficeNet/);
    assert.match(view.wifiPanel.tileGrid.children[0].textContent, /Connected to wlan0/);
    assert.match(view.wifiPanel.tileGrid.children[1].textContent, /SSID: FreeCafe/);
    assert.match(view.wifiPanel.tileGrid.children[1].textContent, /Open/);

    // 3. Clicking a Wi-Fi connection item opens the detail pop-up card with Connect, Disconnect, Close
    assert.equal(view.wifiPanel.detailPopup.hidden, true);
    view.wifiPanel.tileGrid.children[0].fire("click");
    assert.equal(view.wifiPanel.detailPopup.hidden, false);
    assert.equal(view.wifiPanel.detailPopup.dataset.open, "true");
    assert.match(view.wifiPanel.detailPopup.textContent, /OfficeNet/);
    assert.match(view.wifiPanel.detailPopup.textContent, /10\.0\.0\.1/);
    assert.equal(view.wifiPanel.popupDisconnectBtn.hidden, false);

    // Close button closes the detail pop-up
    view.wifiPanel.popupCloseBtn.fire("click");
    assert.equal(view.wifiPanel.detailPopup.hidden, true);

    // Clicking Open network tile and using Pop-up Connect button dispatches wifi_connect
    view.wifiPanel.tileGrid.children[1].fire("click");
    assert.equal(view.wifiPanel.detailPopup.hidden, false);
    assert.match(view.wifiPanel.detailPopup.textContent, /FreeCafe/);
    view.wifiPanel.popupConnectBtn.fire("click");
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0][1].body).ssid, "FreeCafe");

    // 4. Top-right hardware interface switcher toggles between wlan0 and wlan1
    assert.equal(view.wifiPanel.interfacePills.children.length, 2);
    assert.equal(view.wifiInterface.value, "wlan0");
    view.wifiPanel.interfaceToggleBtn.fire("click");
    assert.equal(view.wifiInterface.value, "wlan1");
    assert.equal(view.wifiPanel.tileGrid.children.length, 1);
    assert.match(view.wifiPanel.tileGrid.children[0].textContent, /ExtLab/);

    view.stop();
});
