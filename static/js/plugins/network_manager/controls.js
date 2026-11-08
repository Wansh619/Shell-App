import { details, el, text } from "../monitoring/core.js";
import TabController from "../monitoring/tabs.js";

const LABELS = {
    wifi_scan: "Scan available Wi-Fi", wifi_connect: "Connect Wi-Fi", wifi_disconnect: "Disconnect Wi-Fi",
    bluetooth_refresh: "Scan available Bluetooth", bluetooth_connect: "Connect Bluetooth",
    bluetooth_disconnect: "Disconnect Bluetooth", interface_up: "Bring interface up",
    interface_down: "Bring interface down", checkpoint_revert: "Revert checkpointed network change",
};
const QUICK_SECTIONS = [
    ["wifi", "Wi-Fi", "Available wireless"],
    ["bluetooth", "Bluetooth", "Available devices"],
    ["interfaces", "Interfaces", "Hardware links"],
    ["operations", "Operations", "Control activity"],
];
const GUARDED = new Set(["wifi_connect", "wifi_disconnect", "bluetooth_disconnect", "interface_down", "checkpoint_revert"]);
const FINAL = new Set(["succeeded", "failed", "cancelled", "rolled_back", "expired"]);
const list = (value) => Array.isArray(value) ? value.slice(0, 256) : [];
const expiry = (value) => typeof value === "number" ? value * 1000 : Date.parse(value);

function svgEl(tag, attrs = {}, className = "") {
    const doc = globalThis.document;
    const node = typeof doc?.createElementNS === "function"
        ? doc.createElementNS("http://www.w3.org/2000/svg", tag)
        : doc.createElement(tag);
    if (className) {
        if (typeof node.setAttribute === "function") node.setAttribute("class", className);
        else node.className = className;
    }
    for (const [k, v] of Object.entries(attrs)) {
        node.setAttribute?.(k, String(v));
    }
    return node;
}

export function createTechSvg(kind) {
    const svg = svgEl("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
    }, "network-tile-svg");

    const paths = {
        wifi: [
            "M2 8.82a15 15 0 0 1 20 0",
            "M5 12.86a10 10 0 0 1 14 0",
            "M8.5 16.43a5 5 0 0 1 7 0",
            "M12 20h.01",
        ],
        bluetooth: [
            "M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11",
            "M18.5 8.5a5 5 0 0 1 0 7",
            "M5.5 8.5a5 5 0 0 0 0 7",
        ],
        interfaces: [
            "M4 5h16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
            "M8 14v5",
            "M16 14v5",
            "M5 19h14",
            "M8 9h.01",
            "M12 9h.01",
            "M16 9h.01",
        ],
        ethernet: [
            "M4 5h16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
            "M8 14v5",
            "M16 14v5",
            "M5 19h14",
            "M8 9h.01",
            "M12 9h.01",
            "M16 9h.01",
        ],
        hotspot: [
            "M4.9 19.1C1 15.2 1 8.8 4.9 4.9",
            "M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5",
            "M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5",
            "M19.1 4.9C23 8.8 23 15.1 19.1 19",
            "M12 12v8",
        ],
        operations: [
            "M22 12h-4l-3 9L9 3l-3 9H2",
        ],
        back: [
            "M19 12H5",
            "M12 19l-7-7 7-7",
        ],
    }[kind] || ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"];

    paths.forEach((d, index) => {
        const p = svgEl("path", {
            d,
            pathLength: "100",
            style: `--svg-delay: ${index * 65}ms`,
        }, "network-tile-svg-path");
        svg.append(p);
    });
    return svg;
}

export function triggerDropRipple(node, ev) {
    if (!node) return;
    let x = "28px";
    let y = "50%";
    if (ev && typeof ev.clientX === "number" && typeof node.getBoundingClientRect === "function") {
        const rect = node.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
            x = `${Math.round(ev.clientX - rect.left)}px`;
            y = `${Math.round(ev.clientY - rect.top)}px`;
        }
    }
    if (node.style && typeof node.style.setProperty === "function") {
        node.style.setProperty("--drop-x", x);
        node.style.setProperty("--drop-y", y);
    }
    const ripple = el("span", "network-drop-ripple");
    ripple.setAttribute("aria-hidden", "true");
    if (ripple.style && typeof ripple.style.setProperty === "function") {
        ripple.style.setProperty("--drop-x", x);
        ripple.style.setProperty("--drop-y", y);
    }
    node.append(ripple);
    const cleanup = () => ripple.remove?.();
    ripple.addEventListener?.("animationend", cleanup);
    setTimeout(cleanup, 750);
}

function createBackButton(controls) {
    const backBtn = el("button", "network-tile-btn network-back-btn");
    backBtn.type = "button";
    backBtn.dataset.action = "back-to-menu";
    backBtn.setAttribute("aria-label", "Back to connection tiles");
    const spread = el("span", "network-tile-spread");
    spread.setAttribute("aria-hidden", "true");
    const iconWrap = el("span", "network-back-btn-icon");
    iconWrap.append(createTechSvg("back"));
    const label = el("span", "network-back-btn-label", "Back");
    backBtn.append(spread, iconWrap, label);
    controls.listen(backBtn, "mouseenter", (ev) => triggerDropRipple(backBtn, ev));
    controls.listen(backBtn, "click", (ev) => {
        ev?.stopPropagation?.();
        triggerDropRipple(backBtn, ev);
        controls.openMenu();
    });
    return backBtn;
}

export class WiFiControlPanel {
    constructor(controls) {
        this.controls = controls;
        this.selectedDetailItem = null;
        this.root = el("div", "network-control-group");

        const panelHeader = el("div", "network-panel-header");
        const titleWrap = el("div", "network-panel-title-wrap");
        this.backBtn = createBackButton(controls);
        const headerIcon = el("span", "network-panel-header-icon");
        headerIcon.append(createTechSvg("wifi"));
        titleWrap.append(this.backBtn, headerIcon, el("h3", "", "Available Wi-Fi Connections"));
        panelHeader.append(titleWrap);
        this.interfaceSwitcher = el("div", "network-interface-switcher");
        this.interfacePills = el("div", "network-interface-pills");
        this.interfaceToggleBtn = el("button", "network-tile-btn network-interface-toggle-btn", "Switch Adapter");
        this.interfaceToggleBtn.type = "button";
        this.interfaceToggleBtn.dataset.action = "toggle-interface";
        this.quickScanBtn = el("button", "network-tile-btn is-primary network-quick-scan-btn", "Scan Available");
        this.quickScanBtn.type = "button";
        this.quickScanBtn.dataset.action = "quick-scan";
        this.interfaceSwitcher.append(this.interfacePills, this.interfaceToggleBtn, this.quickScanBtn);
        panelHeader.append(this.interfaceSwitcher);
        this.root.append(panelHeader);

        this.root.append(el("p", "monitoring-muted", "Showing Wi-Fi networks available right now. Click any available connection below to inspect details or connect."));

        // Connection Detail Pop-up Card — opens when clicking a connection list item
        this.detailPopup = el("div", "network-detail-popup");
        this.detailPopup.hidden = true;
        this.detailPopup.dataset.open = "false";
        const popupHeader = el("div", "network-popup-header");
        this.popupTitle = el("h4", "network-popup-title", "Connection Details");
        this.popupBadge = el("span", "network-tile-badge", "");
        popupHeader.append(this.popupTitle, this.popupBadge);
        this.popupBody = el("div", "network-popup-body");
        this.popupActions = el("div", "network-popup-actions");
        this.popupConnectBtn = el("button", "network-tile-btn is-primary", "Connect");
        this.popupConnectBtn.type = "button";
        this.popupConnectBtn.dataset.action = "connect";
        this.popupDisconnectBtn = el("button", "network-tile-btn", "Disconnect");
        this.popupDisconnectBtn.type = "button";
        this.popupDisconnectBtn.dataset.action = "disconnect";
        this.popupCloseBtn = el("button", "network-tile-btn", "Close");
        this.popupCloseBtn.type = "button";
        this.popupCloseBtn.dataset.action = "close";
        this.popupActions.append(this.popupConnectBtn, this.popupDisconnectBtn, this.popupCloseBtn);
        this.detailPopup.append(popupHeader, this.popupBody, this.popupActions);
        this.root.append(this.detailPopup);

        // Conditional Authentication Drawer — hidden until a network requires credentials or custom SSID.
        this.authDrawer = el("div", "network-auth-drawer");
        this.authDrawer.hidden = true;
        this.authPromptTitle = el("h4", "network-auth-title", "Authentication required");
        this.authPromptHint = el("p", "monitoring-muted", "Enter the required credentials for this Wi-Fi network.");
        this.authFieldsWrap = el("div", "network-auth-fields");

        this.ssid = controls.input(this.authFieldsWrap, "Network name (SSID)", "text");
        this.ssid.maxLength = 32;
        this.security = controls.select(this.authFieldsWrap, "Security");
        controls.options(this.security, [["open", "Open (no password)"], ["saved", "Saved OS profile"], ["wpa-personal", "WPA personal"]]);
        this.profile = controls.input(this.authFieldsWrap, "Saved profile ID (optional)", "text");
        this.password = controls.input(this.authFieldsWrap, "Wi-Fi password (WPA passphrase)", "password");
        this.password.autocomplete = "new-password";
        this.password.maxLength = 128;

        const authActions = el("div", "network-auth-actions");
        this.authSubmitBtn = el("button", "network-tile-btn is-primary", "Authenticate & Connect");
        this.authSubmitBtn.type = "button";
        this.authCancelBtn = el("button", "network-tile-btn", "Cancel");
        this.authCancelBtn.type = "button";
        authActions.append(this.authSubmitBtn, this.authCancelBtn);
        this.authDrawer.append(this.authPromptTitle, this.authPromptHint, this.authFieldsWrap, authActions);
        this.root.append(this.authDrawer);

        this.tilesHeader = el("h4", "network-tiles-heading", "Connections Available Right Now");
        this.tileGrid = el("div", "network-tile-grid network-connection-list");
        this.root.append(this.tilesHeader, this.tileGrid);

        const selectorRow = el("div", "network-control-selector-row");
        this.wifiInterface = controls.select(selectorRow, "Wi-Fi interface");
        this.network = controls.select(selectorRow, "Available Wi-Fi connections");
        this.root.append(selectorRow);

        const actionsBar = el("div", "network-control-actions-bar");
        controls.action(actionsBar, "wifi_scan", () => ({ interface: this.wifiInterface.value }));
        controls.action(actionsBar, "wifi_connect", () => this.buildConnectParams(), (params) => this.handleConnectClick(params));
        controls.action(actionsBar, "wifi_disconnect", () => ({ interface: this.wifiInterface.value }));
        this.root.append(actionsBar);

        controls.listen(this.security, "change", () => this.securityFields());
        controls.listen(this.wifiInterface, "change", () => {
            this.closeDetailPopup();
            controls.render();
        });
        controls.listen(this.network, "change", () => this.syncFromSelectedNetwork(false));
        controls.listen(this.interfaceToggleBtn, "click", () => this.toggleInterface());
        controls.listen(this.quickScanBtn, "click", () => {
            if (this.wifiInterface.value) {
                controls.dispatch("wifi_scan", { interface: this.wifiInterface.value });
            }
        });
        controls.listen(this.popupConnectBtn, "click", () => {
            if (this.selectedDetailItem) {
                this.network.value = this.selectedDetailItem.id;
                this.syncFromSelectedNetwork(true);
            }
            this.handleConnectClick(this.buildConnectParams());
        });
        controls.listen(this.popupDisconnectBtn, "click", () => {
            const targetIface = this.selectedDetailItem?.interface || this.wifiInterface.value;
            this.closeDetailPopup();
            controls.dispatch("wifi_disconnect", { interface: targetIface });
        });
        controls.listen(this.popupCloseBtn, "click", () => this.closeDetailPopup());
        controls.listen(this.authSubmitBtn, "click", () => {
            const params = this.buildConnectParams();
            this.closeAuthPrompt();
            this.closeDetailPopup();
            controls.dispatch("wifi_connect", params);
        });
        controls.listen(this.authCancelBtn, "click", () => {
            this.password.value = "";
            this.closeAuthPrompt();
        });
    }

    toggleInterface() {
        const wifiIfaces = list(this.controls.snapshot?.interfaces).filter((item) => item.type === "wifi");
        if (!wifiIfaces.length) return;
        const currentIndex = wifiIfaces.findIndex((item) => item.name === this.wifiInterface.value);
        const nextIndex = (currentIndex + 1) % wifiIfaces.length;
        this.wifiInterface.value = wifiIfaces[nextIndex].name;
        this.closeDetailPopup();
        this.controls.render();
    }

    renderInterfaceSwitcher(wifiIfaces) {
        const canScan = this.controls.snapshot?.capabilities?.wifi_scan?.supported === true;
        this.interfaceToggleBtn.disabled = wifiIfaces.length <= 1 || this.controls.sending === true;
        this.quickScanBtn.disabled = !canScan || !this.wifiInterface.value || this.controls.sending === true;
        const pills = wifiIfaces.map((iface, idx) => {
            const roleLabel = idx === 0 ? "Primary" : "External";
            const pill = el("button", "network-interface-pill", `${iface.name} (${roleLabel})`);
            pill.type = "button";
            const active = iface.name === this.wifiInterface.value;
            pill.dataset.interface = iface.name;
            pill.dataset.active = active ? "true" : "false";
            pill.classList?.toggle?.("is-active", active);
            pill.addEventListener("click", () => {
                if (this.wifiInterface.value !== iface.name) {
                    this.wifiInterface.value = iface.name;
                    this.closeDetailPopup();
                    this.controls.render();
                }
            });
            return pill;
        });
        this.interfacePills.replaceChildren(...pills);
    }

    openDetailPopup(item) {
        if (!item) return;
        this.selectedDetailItem = item;
        const canConnect = this.controls.snapshot?.capabilities?.wifi_connect?.supported === true;
        const canDisconnect = this.controls.snapshot?.capabilities?.wifi_disconnect?.supported === true;
        const iface = item.interface || this.wifiInterface.value || "wlan0";
        const statusLabel = item.connected ? `Connected to ${iface}` :
            item.security === "open" ? "Open · Available" : "Available · WPA-Personal";
        this.popupTitle.textContent = item.ssid || "(Hidden SSID)";
        this.popupBadge.textContent = statusLabel;
        this.popupBadge.dataset.state = item.connected ? "connected" : (item.security === "open" ? "open" : "available");

        const sigVal = typeof item.signal === "number" && Number.isFinite(item.signal) ? `${Math.max(0, Math.min(100, item.signal))}%` : "N/A";
        const rows = [
            ["SSID", text(item.ssid || "(Hidden SSID)")],
            ["BSSID", text(item.bssid || "N/A")],
            ...(item.channel ? [["Channel", text(item.channel)]] : []),
            ["Interface", text(iface)],
            ["Status", statusLabel],
            ["Security", text(item.security || "wpa-personal")],
            ["Signal strength", sigVal],
        ];
        const native = this.controls.snapshot?.details?.[iface];
        if (item.connected && native) {
            rows.push(
                ["Gateways", text(native.gateways)],
                ["DNS servers", text(native.dns)],
                ["Address method", text(native.method)],
            );
        }
        this.popupBody.replaceChildren(details(rows));
        this.popupConnectBtn.disabled = this.controls.sending === true || !canConnect;
        this.popupDisconnectBtn.disabled = this.controls.sending === true || !canDisconnect || !item.connected;
        this.popupDisconnectBtn.hidden = !item.connected;
        this.detailPopup.hidden = false;
        this.detailPopup.dataset.open = "true";
        this.controls.detailPopup = this.detailPopup;
    }

    closeDetailPopup() {
        this.selectedDetailItem = null;
        this.detailPopup.hidden = true;
        this.detailPopup.dataset.open = "false";
    }

    buildConnectParams() {
        return {
            interface: this.wifiInterface.value,
            ssid: this.ssid.value,
            security: this.security.value,
            ...(this.security.value === "saved" && this.profile.value ? { profile_id: this.profile.value } : {}),
            ...(this.security.value === "wpa-personal" ? { password: this.password.value } : {}),
        };
    }

    syncFromSelectedNetwork(openAuthIfRequired = false) {
        if (this.network.value === "__custom__") {
            this.ssid.value = "";
            this.security.value = "wpa-personal";
            this.profile.value = "";
            this.password.value = "";
            this.securityFields();
            this.openAuthPrompt("Connect to hidden or custom Wi-Fi network", true);
            return;
        }
        const selected = list(this.controls.snapshot?.wifi_networks).find((item) =>
            item.id === this.network.value && item.interface === this.wifiInterface.value);
        if (!selected) return;
        this.ssid.value = selected.ssid || "";
        if (["open", "saved", "wpa-personal"].includes(selected.security)) this.security.value = selected.security;
        else this.security.value = "wpa-personal";
        this.profile.value = selected.profile_id || "";
        this.password.value = "";
        this.securityFields();
        if (openAuthIfRequired && this.requiresCredentials()) {
            this.openAuthPrompt(`Authentication required for "${selected.ssid || "Wi-Fi"}"`, false);
        } else if (!this.requiresCredentials()) {
            this.closeAuthPrompt();
        }
    }

    requiresCredentials() {
        if (!this.ssid.value) return true;
        if (this.security.value === "wpa-personal" && !this.password.value) return true;
        return false;
    }

    openAuthPrompt(titleText, showCustomFields = false) {
        this.authPromptTitle.textContent = titleText || "Authentication required";
        this.authPromptHint.textContent = this.security.value === "wpa-personal"
            ? "This network uses WPA-Personal security. Enter the passphrase to connect."
            : "Confirm network details to continue.";
        this.ssid.parentElement && (this.ssid.parentElement.hidden = !showCustomFields && Boolean(this.ssid.value));
        this.security.parentElement && (this.security.parentElement.hidden = !showCustomFields);
        this.authDrawer.hidden = false;
        this.authDrawer.dataset.open = "true";
        if (this.security.value === "wpa-personal") {
            this.password.focus?.();
        } else {
            this.ssid.focus?.();
        }
    }

    closeAuthPrompt() {
        this.authDrawer.hidden = true;
        this.authDrawer.dataset.open = "false";
    }

    handleConnectClick(params) {
        if (!params.ssid && this.network.value && this.network.value !== "__custom__") {
            this.syncFromSelectedNetwork(false);
            params = this.buildConnectParams();
        }
        if (this.requiresCredentials()) {
            const label = this.ssid.value ? `Authentication required for "${this.ssid.value}"` : "Enter Wi-Fi network credentials";
            this.openAuthPrompt(label, !this.ssid.value || this.network.value === "__custom__");
            return;
        }
        this.closeAuthPrompt();
        this.controls.dispatch("wifi_connect", params);
    }

    securityFields() {
        this.password.disabled = this.security.value !== "wpa-personal";
        this.profile.disabled = this.security.value !== "saved";
        if (this.password.parentElement) this.password.parentElement.hidden = this.security.value !== "wpa-personal";
        if (this.profile.parentElement) this.profile.parentElement.hidden = this.security.value !== "saved";
        if (this.password.disabled) this.password.value = "";
    }

    renderTiles(networks) {
        const canConnect = this.controls.snapshot?.capabilities?.wifi_connect?.supported === true;
        const canDisconnect = this.controls.snapshot?.capabilities?.wifi_disconnect?.supported === true;
        if (!networks.length) {
            const emptyTile = el("div", "network-connection-tile is-empty");
            emptyTile.append(
                el("strong", "network-tile-title", "No Wi-Fi networks in list yet"),
                el("p", "monitoring-muted", "Click 'Scan Wi-Fi networks' above to discover nearby networks on this interface.")
            );
            this.tileGrid.replaceChildren(emptyTile);
            return;
        }
        const tiles = networks.map((item) => {
            const tile = el("div", "network-connection-tile");
            const selected = this.network.value === item.id;
            const iface = item.interface || this.wifiInterface.value || "wlan0";
            tile.dataset.selected = selected ? "true" : "false";
            tile.dataset.connected = item.connected ? "true" : "false";
            tile.dataset.security = item.security || "unknown";
            if (tile.classList) {
                tile.classList.toggle("is-selected", selected);
                tile.classList.toggle("is-connected", Boolean(item.connected));
            }
            const spread = el("span", "network-tile-spread");
            spread.setAttribute("aria-hidden", "true");
            const header = el("div", "network-tile-header");
            const titleWrap = el("div", "network-tile-title-row");
            const rowIcon = el("span", "network-row-svg-icon");
            rowIcon.append(createTechSvg("wifi"));
            const ssidLabel = item.ssid || "(Hidden SSID)";
            const title = el("strong", "network-tile-title", ssidLabel);
            titleWrap.append(rowIcon, title);
            const badgeText = item.connected ? `Connected to ${iface}` :
                item.security === "open" ? "Open" : "Available";
            const badge = el("span", "network-tile-badge", badgeText);
            badge.dataset.state = item.connected ? "connected" :
                (item.security === "open" ? "open" : "available");
            header.append(titleWrap, badge);

            const meta = el("div", "network-tile-meta");
            const ssidTag = `SSID: ${text(ssidLabel)}`;
            const bssidText = item.bssid ? `BSSID: ${text(item.bssid)}` : "BSSID: N/A";
            const secTag = item.security === "open" ? "Open · No password" :
                item.security === "enterprise" ? "WPA-Enterprise" : "WPA-Personal · Secured";
            const sigVal = typeof item.signal === "number" && Number.isFinite(item.signal) ? Math.max(0, Math.min(100, item.signal)) : 0;
            meta.append(
                el("span", "network-tile-ssid", ssidTag),
                el("span", "network-tile-bssid", bssidText),
                ...(item.channel ? [el("span", "", text(item.channel))] : []),
                el("span", "", secTag),
                el("span", "", item.connected ? `Connected (${iface})` : `Available on ${iface}`),
                el("span", "", sigVal > 0 ? `Signal ${sigVal}%` : "Available"),
            );

            const barTrack = el("div", "monitoring-progress-track");
            const barFill = el("div", "monitoring-progress-fill");
            if (barFill.style) barFill.style.width = `${sigVal}%`;
            barTrack.append(barFill);

            const footer = el("div", "network-tile-footer");
            const btn = el("button", "network-tile-btn is-primary", item.connected ? "Disconnect" : (item.security === "wpa-personal" ? "Connect (Auth)…" : "Connect"));
            btn.type = "button";
            btn.disabled = this.controls.sending === true || (item.connected ? !canDisconnect : !canConnect);
            btn.addEventListener("click", (ev) => {
                ev?.stopPropagation?.();
                this.network.value = item.id;
                this.syncFromSelectedNetwork(true);
                if (item.connected) {
                    this.controls.dispatch("wifi_disconnect", { interface: this.wifiInterface.value });
                } else if (!this.requiresCredentials()) {
                    this.controls.dispatch("wifi_connect", this.buildConnectParams());
                }
            });
            const detailsBtn = el("button", "network-tile-btn", "Details");
            detailsBtn.type = "button";
            detailsBtn.addEventListener("click", (ev) => {
                ev?.stopPropagation?.();
                this.network.value = item.id;
                this.syncFromSelectedNetwork(false);
                this.openDetailPopup(item);
                this.renderTiles(networks);
            });
            footer.append(btn, detailsBtn);

            tile.addEventListener("mouseenter", (ev) => triggerDropRipple(tile, ev));
            tile.addEventListener("click", (ev) => {
                triggerDropRipple(tile, ev);
                this.network.value = item.id;
                this.syncFromSelectedNetwork(false);
                this.openDetailPopup(item);
                this.renderTiles(networks);
            });
            tile.append(spread, header, meta, barTrack, footer);
            return tile;
        });
        this.tileGrid.replaceChildren(...tiles);
        if (this.detailPopup.dataset.open === "true" && this.selectedDetailItem) {
            const refreshed = networks.find((n) => n.id === this.selectedDetailItem.id);
            if (refreshed) this.openDetailPopup(refreshed);
        }
    }
}

export class BluetoothControlPanel {
    constructor(controls) {
        this.controls = controls;
        this.selectedDetailItem = null;
        this.root = el("div", "network-control-group");
        const panelHeader = el("div", "network-panel-header");
        const titleWrap = el("div", "network-panel-title-wrap");
        this.backBtn = createBackButton(controls);
        const headerIcon = el("span", "network-panel-header-icon");
        headerIcon.append(createTechSvg("bluetooth"));
        titleWrap.append(this.backBtn, headerIcon, el("h3", "", "Available Bluetooth Connections"));
        panelHeader.append(titleWrap);
        this.interfaceSwitcher = el("div", "network-interface-switcher");
        this.quickRefreshBtn = el("button", "network-tile-btn is-primary network-quick-scan-btn", "Scan Available");
        this.quickRefreshBtn.type = "button";
        this.interfaceSwitcher.append(this.quickRefreshBtn);
        panelHeader.append(this.interfaceSwitcher);
        this.root.append(panelHeader);

        this.root.append(el("p", "monitoring-muted", "Showing Bluetooth devices available right now. Click any device below to view details, connect, or disconnect."));

        this.detailPopup = el("div", "network-detail-popup");
        this.detailPopup.hidden = true;
        this.detailPopup.dataset.open = "false";
        const popupHeader = el("div", "network-popup-header");
        this.popupTitle = el("h4", "network-popup-title", "Bluetooth Device Details");
        this.popupBadge = el("span", "network-tile-badge", "");
        popupHeader.append(this.popupTitle, this.popupBadge);
        this.popupBody = el("div", "network-popup-body");
        this.popupActions = el("div", "network-popup-actions");
        this.popupConnectBtn = el("button", "network-tile-btn is-primary", "Connect");
        this.popupConnectBtn.type = "button";
        this.popupConnectBtn.dataset.action = "connect";
        this.popupDisconnectBtn = el("button", "network-tile-btn", "Disconnect");
        this.popupDisconnectBtn.type = "button";
        this.popupDisconnectBtn.dataset.action = "disconnect";
        this.popupCloseBtn = el("button", "network-tile-btn", "Close");
        this.popupCloseBtn.type = "button";
        this.popupCloseBtn.dataset.action = "close";
        this.popupActions.append(this.popupConnectBtn, this.popupDisconnectBtn, this.popupCloseBtn);
        this.detailPopup.append(popupHeader, this.popupBody, this.popupActions);
        this.root.append(this.detailPopup);

        this.tilesHeader = el("h4", "network-tiles-heading", "Connections Available Right Now");
        this.tileGrid = el("div", "network-tile-grid network-connection-list");
        this.root.append(this.tilesHeader, this.tileGrid);

        const selectorRow = el("div", "network-control-selector-row");
        this.device = controls.select(selectorRow, "Available Bluetooth connections");
        this.root.append(selectorRow);
        controls.listen(this.device, "change", () => controls.render());
        controls.listen(this.quickRefreshBtn, "click", () => controls.dispatch("bluetooth_refresh", {}));
        const actionsBar = el("div", "network-control-actions-bar");
        controls.action(actionsBar, "bluetooth_refresh", () => ({}));
        controls.action(actionsBar, "bluetooth_connect", () => ({ device_id: this.device.value }));
        controls.action(actionsBar, "bluetooth_disconnect", () => ({ device_id: this.device.value }));
        this.root.append(actionsBar);

        controls.listen(this.popupConnectBtn, "click", () => {
            const id = this.selectedDetailItem?.id || this.device.value;
            if (id) {
                this.device.value = id;
                this.closeDetailPopup();
                controls.dispatch("bluetooth_connect", { device_id: id });
            }
        });
        controls.listen(this.popupDisconnectBtn, "click", () => {
            const id = this.selectedDetailItem?.id || this.device.value;
            if (id) {
                this.device.value = id;
                this.closeDetailPopup();
                controls.dispatch("bluetooth_disconnect", { device_id: id });
            }
        });
        controls.listen(this.popupCloseBtn, "click", () => this.closeDetailPopup());
    }

    openDetailPopup(item) {
        if (!item) return;
        this.selectedDetailItem = item;
        const canConnect = this.controls.snapshot?.capabilities?.bluetooth_connect?.supported === true;
        const canDisconnect = this.controls.snapshot?.capabilities?.bluetooth_disconnect?.supported === true;
        const statusText = item.connected ? "Connected" : (item.paired ? "Paired" : "Available");
        this.popupTitle.textContent = item.name || item.id;
        this.popupBadge.textContent = statusText;
        this.popupBadge.dataset.state = item.connected ? "connected" : (item.paired ? "paired" : "available");
        this.popupBody.replaceChildren(details([
            ["Device Name", text(item.name || item.id)],
            ["Device ID", text(item.id)],
            ["Status", statusText],
            ["Paired", item.paired ? "Yes" : "No"],
            ["Transport", text(item.transport || "bluetooth")],
        ]));
        this.popupConnectBtn.disabled = this.controls.sending === true || !canConnect || item.connected === true;
        this.popupDisconnectBtn.disabled = this.controls.sending === true || !canDisconnect || !item.connected;
        this.detailPopup.hidden = false;
        this.detailPopup.dataset.open = "true";
        this.controls.detailPopup = this.detailPopup;
    }

    closeDetailPopup() {
        this.selectedDetailItem = null;
        this.detailPopup.hidden = true;
        this.detailPopup.dataset.open = "false";
    }

    renderTiles(devices) {
        const canConnect = this.controls.snapshot?.capabilities?.bluetooth_connect?.supported === true;
        const canDisconnect = this.controls.snapshot?.capabilities?.bluetooth_disconnect?.supported === true;
        const canRefresh = this.controls.snapshot?.capabilities?.bluetooth_refresh?.supported === true;
        this.quickRefreshBtn.disabled = !canRefresh || this.controls.sending === true;
        if (!devices.length) {
            const emptyTile = el("div", "network-connection-tile is-empty");
            emptyTile.append(
                el("strong", "network-tile-title", "No Bluetooth connections available right now"),
                el("p", "monitoring-muted", "Click 'Scan Available' above to discover nearby available Bluetooth devices.")
            );
            this.tileGrid.replaceChildren(emptyTile);
            return;
        }
        const tiles = devices.map((item) => {
            const tile = el("div", "network-connection-tile");
            const selected = this.device.value === item.id;
            tile.dataset.selected = selected ? "true" : "false";
            tile.dataset.connected = item.connected ? "true" : "false";
            if (tile.classList) {
                tile.classList.toggle("is-selected", selected);
                tile.classList.toggle("is-connected", Boolean(item.connected));
            }
            const spread = el("span", "network-tile-spread");
            spread.setAttribute("aria-hidden", "true");
            const header = el("div", "network-tile-header");
            const titleWrap = el("div", "network-tile-title-row");
            const rowIcon = el("span", "network-row-svg-icon");
            rowIcon.append(createTechSvg("bluetooth"));
            const title = el("strong", "network-tile-title", item.name || item.id);
            titleWrap.append(rowIcon, title);
            const badgeText = item.connected ? "Connected" : "Available";
            const badge = el("span", "network-tile-badge", badgeText);
            badge.dataset.state = item.connected ? "connected" : "available";
            header.append(titleWrap, badge);

            const meta = el("div", "network-tile-meta");
            meta.append(
                el("span", "", `ID: ${text(item.id)}`),
                el("span", "", `Transport: ${text(item.transport || "bluetooth")}`),
                el("span", "", item.connected ? "Connected now" : "Available right now"),
            );

            const footer = el("div", "network-tile-footer");
            const actionName = item.connected ? "bluetooth_disconnect" : "bluetooth_connect";
            const allowed = item.connected ? canDisconnect : canConnect;
            const btn = el("button", "network-tile-btn is-primary", item.connected ? "Disconnect" : "Connect");
            btn.type = "button";
            btn.disabled = !allowed || this.controls.sending === true;
            btn.addEventListener("click", (ev) => {
                ev?.stopPropagation?.();
                this.device.value = item.id;
                this.controls.dispatch(actionName, { device_id: item.id });
            });
            const detailsBtn = el("button", "network-tile-btn", "Details");
            detailsBtn.type = "button";
            detailsBtn.addEventListener("click", (ev) => {
                ev?.stopPropagation?.();
                this.device.value = item.id;
                this.openDetailPopup(item);
                this.renderTiles(devices);
            });
            footer.append(btn, detailsBtn);

            tile.addEventListener("mouseenter", (ev) => triggerDropRipple(tile, ev));
            tile.addEventListener("click", (ev) => {
                triggerDropRipple(tile, ev);
                this.device.value = item.id;
                this.openDetailPopup(item);
                this.controls.render();
            });
            tile.append(spread, header, meta, footer);
            return tile;
        });
        this.tileGrid.replaceChildren(...tiles);
    }
}

export class InterfaceControlPanel {
    constructor(controls) {
        this.controls = controls;
        this.root = el("div", "network-control-group");
        const panelHeader = el("div", "network-panel-header");
        const titleWrap = el("div", "network-panel-title-wrap");
        this.backBtn = createBackButton(controls);
        const headerIcon = el("span", "network-panel-header-icon");
        headerIcon.append(createTechSvg("interfaces"));
        titleWrap.append(this.backBtn, headerIcon, el("h3", "", "Available Network Interfaces"));
        panelHeader.append(titleWrap);
        this.interfaceSwitcher = el("div", "network-interface-switcher");
        this.interfacePills = el("div", "network-interface-pills");
        this.interfaceToggleBtn = el("button", "network-tile-btn network-interface-toggle-btn", "Switch Interface");
        this.interfaceToggleBtn.type = "button";
        this.interfaceToggleBtn.dataset.action = "toggle-interface";
        this.interfaceSwitcher.append(this.interfacePills, this.interfaceToggleBtn);
        panelHeader.append(this.interfaceSwitcher);
        this.root.append(panelHeader);

        this.root.append(el("p", "network-control-warning", "Warning: bringing an interface down can disconnect this browser and other users. Wi-Fi disconnect is not administrative link down. Recovery is not guaranteed without an OS checkpoint."));
        this.tilesHeader = el("h4", "network-tiles-heading", "Interfaces Available Right Now");
        this.tileGrid = el("div", "network-tile-grid network-connection-list");
        this.root.append(this.tilesHeader, this.tileGrid);
        const selectorRow = el("div", "network-control-selector-row");
        this.interface = controls.select(selectorRow, "Interface to administer");
        this.root.append(selectorRow);
        controls.listen(this.interface, "change", () => controls.render());
        controls.listen(this.interfaceToggleBtn, "click", () => this.toggleInterface());
        const actionsBar = el("div", "network-control-actions-bar");
        controls.action(actionsBar, "interface_up", () => ({ interface: this.interface.value }));
        controls.action(actionsBar, "interface_down", () => ({ interface: this.interface.value }));
        this.root.append(actionsBar);
    }

    toggleInterface() {
        const interfaces = list(this.controls.snapshot?.interfaces);
        if (!interfaces.length) return;
        const currentIndex = interfaces.findIndex((item) => item.name === this.interface.value);
        const nextIndex = (currentIndex + 1) % interfaces.length;
        this.interface.value = interfaces[nextIndex].name;
        this.controls.render();
    }

    renderInterfaceSwitcher(interfaces) {
        this.interfaceToggleBtn.disabled = interfaces.length <= 1 || this.controls.sending === true;
        const pills = interfaces.map((iface) => {
            const pill = el("button", "network-interface-pill", `${iface.name} · ${iface.type || "link"}`);
            pill.type = "button";
            const active = iface.name === this.interface.value;
            pill.dataset.interface = iface.name;
            pill.dataset.active = active ? "true" : "false";
            pill.classList?.toggle?.("is-active", active);
            pill.addEventListener("click", () => {
                if (this.interface.value !== iface.name) {
                    this.interface.value = iface.name;
                    this.controls.render();
                }
            });
            return pill;
        });
        this.interfacePills.replaceChildren(...pills);
    }

    renderTiles(interfaces) {
        this.renderInterfaceSwitcher(interfaces);
        const canUp = this.controls.snapshot?.capabilities?.interface_up?.supported === true;
        const canDown = this.controls.snapshot?.capabilities?.interface_down?.supported === true;
        if (!interfaces.length) {
            this.tileGrid.replaceChildren(el("p", "monitoring-muted", "No interfaces in control inventory."));
            return;
        }
        const tiles = interfaces.map((item) => {
            const tile = el("div", "network-connection-tile");
            const selected = this.interface.value === item.name;
            tile.dataset.selected = selected ? "true" : "false";
            tile.dataset.connected = item.is_up ? "true" : "false";
            if (tile.classList) {
                tile.classList.toggle("is-selected", selected);
                tile.classList.toggle("is-connected", Boolean(item.is_up));
            }
            const spread = el("span", "network-tile-spread");
            spread.setAttribute("aria-hidden", "true");
            const header = el("div", "network-tile-header");
            const titleWrap = el("div", "network-tile-title-row");
            const rowIcon = el("span", "network-row-svg-icon");
            rowIcon.append(createTechSvg(item.type === "wifi" ? "wifi" : "interfaces"));
            const title = el("strong", "network-tile-title", item.name);
            titleWrap.append(rowIcon, title);
            const badge = el("span", "network-tile-badge", item.is_up ? "Admin UP" : "Admin DOWN");
            badge.dataset.state = item.is_up ? "connected" : "disconnected";
            header.append(titleWrap, badge);

            const meta = el("div", "network-tile-meta");
            meta.append(el("span", "", `Type: ${text(item.type || "other")}`),
                el("span", "", item.ssid ? `SSID: ${item.ssid}` : "Link interface"));

            const footer = el("div", "network-tile-footer");
            const upBtn = el("button", "network-tile-btn", "Bring Up");
            upBtn.type = "button";
            upBtn.disabled = !canUp || this.controls.sending === true || item.is_up === true;
            upBtn.addEventListener("click", (ev) => {
                ev?.stopPropagation?.();
                this.interface.value = item.name;
                this.controls.dispatch("interface_up", { interface: item.name });
            });
            const downBtn = el("button", "network-tile-btn", "Bring Down");
            downBtn.type = "button";
            downBtn.disabled = !canDown || this.controls.sending === true || item.is_up === false || item.name === "lo" || item.name === "lo0";
            downBtn.addEventListener("click", (ev) => {
                ev?.stopPropagation?.();
                this.interface.value = item.name;
                this.controls.dispatch("interface_down", { interface: item.name });
            });
            footer.append(upBtn, downBtn);

            tile.addEventListener("click", () => {
                this.interface.value = item.name;
                this.controls.render();
            });
            tile.append(spread, header, meta, footer);
            return tile;
        });
        this.tileGrid.replaceChildren(...tiles);
    }
}

/** One view of the backend NetworkController. Never discovers or polls on a browser timer. */
export class NetworkControls {
    constructor(container, options = {}) {
        this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
        this.confirm = options.confirm || ((message) => globalThis.confirm(message));
        this.now = options.now || Date.now;
        this.listeners = [];
        this.requests = new Set();
        this.localOperations = new Map();
        this.buttons = new Map();
        this.stopped = false;
        this.version = 0;
        this.viewMode = "menu";
        this.root = el("section", "monitoring-section network-controls");
        this.root.dataset.viewMode = "menu";
        this.root.append(el("h2", "", "Connection & Adapter Controls"),
            el("p", "monitoring-muted", "Tap a ControlTile below to open its available connections. Use the Back button inside any opened container to return to the tile menu."));
        this.status = el("p", "network-control-status", "Loading cached control inventory…");
        this.status.setAttribute("role", "status");
        this.feedback = el("p", "network-control-feedback");
        this.feedback.setAttribute("role", "status");
        this.root.append(this.status, this.feedback);

        // Primary Android Quick-Settings ControlTile Bar with SVG Logos & Drop-Spread Ripple
        this.quickTileBar = el("div", "network-quick-tiles");
        this.quickTiles = new Map();
        for (const [id, title, defaultSubtitle] of QUICK_SECTIONS) {
            const tile = el("button", "network-quick-tile network-control-tile");
            tile.type = "button";
            tile.dataset.section = id;
            tile.dataset.active = "false";
            tile.dataset.state = "idle";
            const spread = el("span", "network-tile-spread");
            spread.setAttribute("aria-hidden", "true");
            const iconWrap = el("span", "network-quick-tile-icon");
            const svgNode = createTechSvg(id);
            iconWrap.append(svgNode);
            const copyWrap = el("div", "network-control-tile-copy");
            const top = el("div", "network-quick-tile-top");
            const titleNode = el("strong", "network-quick-tile-title", title);
            const badgeNode = el("span", "network-quick-tile-badge", "");
            badgeNode.hidden = true;
            top.append(titleNode, badgeNode);
            const subtitleNode = el("span", "network-quick-tile-subtitle", defaultSubtitle);
            copyWrap.append(top, subtitleNode);
            const chevronNode = el("span", "network-quick-tile-chevron", "›");
            tile.append(spread, iconWrap, copyWrap, chevronNode);
            this.listen(tile, "mouseenter", (ev) => triggerDropRipple(tile, ev));
            this.listen(tile, "click", (ev) => {
                triggerDropRipple(tile, ev);
                this.selectSection(id, ev);
            });
            this.quickTileBar.append(tile);
            this.quickTiles.set(id, { tile, title: titleNode, subtitle: subtitleNode, badge: badgeNode, svg: svgNode });
        }
        this.root.append(this.quickTileBar);

        this.wifiPanel = new WiFiControlPanel(this);
        this.bluetoothPanel = new BluetoothControlPanel(this);
        this.interfacePanel = new InterfaceControlPanel(this);
        this.detailPopup = this.wifiPanel.detailPopup;
        this.backBtn = this.wifiPanel.backBtn;

        this.wifiInterface = this.wifiPanel.wifiInterface;
        this.network = this.wifiPanel.network;
        this.ssid = this.wifiPanel.ssid;
        this.security = this.wifiPanel.security;
        this.profile = this.wifiPanel.profile;
        this.password = this.wifiPanel.password;
        this.device = this.bluetoothPanel.device;
        this.interface = this.interfacePanel.interface;

        this.operationsWrap = el("div", "network-control-group");
        const opsHeader = el("div", "network-panel-header");
        const opsTitleWrap = el("div", "network-panel-title-wrap");
        this.opsBackBtn = createBackButton(this);
        const opsIcon = el("span", "network-panel-header-icon");
        opsIcon.append(createTechSvg("operations"));
        opsTitleWrap.append(this.opsBackBtn, opsIcon, el("h3", "", "Recent Control Operations"));
        opsHeader.append(opsTitleWrap);
        this.operationsWrap.append(opsHeader);
        this.operations = el("div", "network-operations");
        this.operations.setAttribute("aria-live", "polite");
        this.operationsWrap.append(this.operations);

        this.sectionGroups = new Map([
            ["wifi", this.wifiPanel.root],
            ["bluetooth", this.bluetoothPanel.root],
            ["interfaces", this.interfacePanel.root],
            ["operations", this.operationsWrap],
        ]);

        this.tabs = new TabController(this.root, [
            { id: "wifi", label: "Wi-Fi", content: this.wifiPanel.root },
            { id: "bluetooth", label: "Bluetooth", content: this.bluetoothPanel.root },
            { id: "interfaces", label: "Interface Up / Down", content: this.interfacePanel.root },
            { id: "operations", label: "Operations Log", content: this.operationsWrap },
        ], {
            className: "monitoring-tabs network-control-tabs",
            onChange: (id) => this.syncQuickTiles(id),
        });
        for (const [, entry] of this.tabs.tabs) {
            entry.panel.className = "monitoring-tabpanel network-drop-panel";
        }
        this.syncQuickTiles(this.tabs.activeId || "wifi");
        this.root.dataset.viewMode = "menu";

        container.append(this.root);
        this.securityFields();
        this.render();
    }
    selectSection(id, ev = null) {
        if (!this.tabs?.tabs.has(id)) return;
        this.viewMode = "container";
        this.root.dataset.viewMode = "container";
        this.tabs.select(id, true);
        this.syncQuickTiles(id);
        const groupNode = this.sectionGroups?.get(id) || this.tabs.tabs.get(id)?.panel;
        if (groupNode) {
            groupNode.dataset.rippleOpen = "false";
            if (groupNode.classList) {
                groupNode.classList.remove("is-ripple-opening");
                void groupNode.offsetWidth;
                groupNode.classList.add("is-ripple-opening");
            }
            groupNode.dataset.rippleOpen = "true";
            triggerDropRipple(groupNode, ev);
        }
    }
    openMenu() {
        this.wifiPanel?.closeDetailPopup?.();
        this.wifiPanel?.closeAuthPrompt?.();
        this.bluetoothPanel?.closeDetailPopup?.();
        this.viewMode = "menu";
        this.root.dataset.viewMode = "menu";
    }
    syncQuickTiles(activeId) {
        this.activeSection = activeId;
        for (const [id, entry] of this.quickTiles) {
            const active = id === activeId;
            entry.tile.dataset.active = active ? "true" : "false";
            entry.tile.classList?.toggle?.("is-active", active);
        }
        if (this.tabs?.tabs) {
            for (const [tabId, entry] of this.tabs.tabs) {
                entry.panel.dataset.dropdown = tabId === activeId ? "open" : "closed";
            }
        }
    }
    group(title) {
        const group = el("div", "network-control-group");
        group.append(el("h3", "", title));
        return group;
    }
    listen(node, event, handler) {
        node.addEventListener(event, handler);
        this.listeners.push([node, event, handler]);
    }
    field(group, label, node) {
        const wrapper = el("label", "network-control-field", label);
        wrapper.append(node);
        group.append(wrapper);
        return node;
    }
    select(group, label) {
        const node = el("select");
        node.setAttribute("aria-label", label);
        return this.field(group, label, node);
    }
    input(group, label, type) {
        const node = el("input");
        node.type = type;
        node.autocomplete = "off";
        node.spellcheck = false;
        return this.field(group, label, node);
    }
    options(select, entries) {
        const signature = JSON.stringify(entries);
        if (select.dataset.options === signature) return;
        const previous = select.value;
        select.replaceChildren(...entries.map(([value, label]) => {
            const option = el("option", "", label);
            option.value = value;
            return option;
        }));
        select.dataset.options = signature;
        select.value = entries.some(([value]) => value === previous) ? previous : (entries[0]?.[0] || "");
    }
    securityFields() {
        this.wifiPanel.securityFields();
    }
    action(group, action, params, customClick = null) {
        const row = el("div", "network-control-action");
        const button = el("button", "", LABELS[action]);
        button.type = "button";
        const reason = el("span", "monitoring-muted");
        this.listen(button, "click", () => {
            if (customClick) customClick(params());
            else this.dispatch(action, params());
        });
        row.append(button, reason);
        group.append(row);
        this.buttons.set(action, { button, reason });
    }
    async start() {
        if (this.started || this.stopped) return;
        this.started = true;
        const version = this.version;
        const request = new AbortController();
        this.requests.add(request);
        const timeout = setTimeout(() => request.abort(), 10000);
        try {
            const response = await this.fetch("/api/network-manager/control", {
                signal: request.signal, cache: "no-store", credentials: "same-origin",
            });
            if (!response.ok) throw new Error("unavailable");
            const control = await response.json();
            if (!this.stopped && version === this.version) this.render(control);
        } catch {
            if (!this.stopped && version === this.version) {
                this.status.textContent = "Cached control inventory unavailable. Waiting for live telemetry.";
            }
        } finally {
            clearTimeout(timeout);
            this.requests.delete(request);
        }
    }
    render(control) {
        if (this.stopped) return;
        if (control && typeof control === "object" && !Array.isArray(control)) {
            this.snapshot = control;
            this.version++;
        }
        const snapshot = this.snapshot;
        this.status.textContent = !snapshot ? (this.started ? "Control inventory missing; waiting for live telemetry." :
            "Loading cached control inventory…") : snapshot.error ?
            `Control inventory error: ${text(snapshot.error.message || snapshot.error)}` :
            `${text(snapshot.platform)} · cached inventory; refresh explicitly to discover networks or paired devices.`;
        const interfaces = list(snapshot?.interfaces);
        const wifiIfaces = interfaces.filter((item) => item.type === "wifi");
        this.options(this.wifiInterface, wifiIfaces
            .map((item) => [item.name, `${item.name}${item.ssid ? ` · ${item.ssid}` : ""}`]));
        this.options(this.interface, interfaces.map((item) =>
            [item.name, `${item.name} · administrative state ${item.is_up === true ? "up" : item.is_up === false ? "down" : "unknown"}`]));
        this.renderNetworks();
        const allDevices = list(snapshot?.bluetooth_devices);
        this.options(this.device, allDevices
            .map((item) => [item.id, `${item.name || item.id} · ${item.transport || "unknown transport"} · ${item.connected ? "connected (observed)" : item.paired ? "paired" : "available"}`]));
        this.tabs?.setBadge("wifi", wifiIfaces.length || "");
        this.tabs?.setBadge("bluetooth", allDevices.length || "");
        this.tabs?.setBadge("interfaces", interfaces.length || "");
        for (const [action, view] of this.buttons) {
            const capability = snapshot?.capabilities?.[action];
            const targetMissing = action.startsWith("wifi_") ? !this.wifiInterface.value :
                action.startsWith("interface_") ? !this.interface.value :
                    action !== "bluetooth_refresh" && !this.device.value;
            view.button.disabled = capability?.supported !== true || targetMissing || this.sending === true;
            view.reason.textContent = !snapshot ? "Loading platform capabilities…" :
                capability?.supported !== true ?
                    (capability?.reason || "Not supported on this host.") :
                    targetMissing ? "No eligible target in cached inventory." : (capability.reason || "Ready.");
        }
        const currentNetworks = list(snapshot?.wifi_networks).filter((item) =>
            item.interface === this.wifiInterface.value &&
            !(item.security === "saved" && !item.connected && !(item.signal > 0)));
        this.wifiPanel.renderInterfaceSwitcher(wifiIfaces);
        this.wifiPanel.renderTiles(currentNetworks);
        this.bluetoothPanel.renderTiles(allDevices);
        this.interfacePanel.renderTiles(interfaces);
        this.updateQuickTiles(wifiIfaces, currentNetworks, allDevices, interfaces);
        this.renderOperations();
    }
    updateQuickTiles(wifiIfaces, currentNetworks, allDevices, interfaces) {
        if (!this.quickTiles) return;
        const connectedWifi = currentNetworks.find((n) => n.connected) || wifiIfaces.find((i) => i.ssid);
        const wifiEntry = this.quickTiles.get("wifi");
        if (wifiEntry) {
            wifiEntry.subtitle.textContent = connectedWifi
                ? `Connected · ${connectedWifi.ssid} (${this.wifiInterface.value || connectedWifi.name || "wifi"})`
                : (wifiIfaces.length ? `${this.wifiInterface.value || wifiIfaces[0].name} · ${currentNetworks.length} available` : "No adapter");
            wifiEntry.tile.dataset.state = connectedWifi ? "connected" : "available";
            wifiEntry.badge.textContent = wifiIfaces.length ? `${currentNetworks.length} available` : "";
            wifiEntry.badge.hidden = !wifiEntry.badge.textContent;
        }
        const connectedBt = allDevices.find((d) => d.connected);
        const btEntry = this.quickTiles.get("bluetooth");
        if (btEntry) {
            btEntry.subtitle.textContent = connectedBt
                ? `Connected · ${connectedBt.name || connectedBt.id}`
                : `${allDevices.length} available right now`;
            btEntry.tile.dataset.state = connectedBt ? "connected" : "available";
            btEntry.badge.textContent = `${allDevices.length} available`;
            btEntry.badge.hidden = false;
        }
        const upIfaces = interfaces.filter((i) => i.is_up === true);
        const ifaceEntry = this.quickTiles.get("interfaces");
        if (ifaceEntry) {
            ifaceEntry.subtitle.textContent = interfaces.length
                ? `${upIfaces.length} / ${interfaces.length} UP`
                : "No interfaces";
            ifaceEntry.tile.dataset.state = upIfaces.length ? "connected" : "available";
            ifaceEntry.badge.textContent = interfaces.length ? String(interfaces.length) : "";
            ifaceEntry.badge.hidden = !ifaceEntry.badge.textContent;
        }
    }
    renderNetworks() {
        const currentNetworks = list(this.snapshot?.wifi_networks).filter((item) =>
            item.interface === this.wifiInterface.value &&
            !(item.security === "saved" && !item.connected && !(item.signal > 0)));
        this.options(this.network, [
            ...currentNetworks.map((item) => [
                item.id,
                `${item.ssid || "(hidden SSID)"}${item.bssid ? ` (${item.bssid})` : ""} · ${item.security || "unknown security"}${item.signal ? ` · signal ${text(item.signal)}%` : ""}${item.connected ? " · connected" : ""}`,
            ]),
            ["__custom__", "+ Enter custom / hidden SSID…"],
        ]);
        if (!this.ssid.value && currentNetworks.length && this.network.value !== "__custom__") {
            const first = currentNetworks.find((n) => n.id === this.network.value) || currentNetworks[0];
            if (first) {
                this.ssid.value = first.ssid || "";
                if (["open", "saved", "wpa-personal"].includes(first.security)) this.security.value = first.security;
                this.securityFields();
            }
        }
    }
    async dispatch(action, params = {}) {
        if (this.stopped || this.sending) return;
        const checkpointAction = action === "checkpoint_confirm" || action === "checkpoint_revert";
        if (!checkpointAction && this.snapshot?.capabilities?.[action]?.supported !== true) return;
        if (GUARDED.has(action)) {
            if (!this.confirm(`${LABELS[action]} on this server? This may interrupt the browser connection and other users. Only a real OS checkpoint can provide automatic rollback.`)) {
                this.password.value = "";
                delete params.password;
                return;
            }
            params.confirmed = true;
        }
        // Serialize once, then immediately remove the credential from the editable DOM.
        let body = JSON.stringify({ action, ...params });
        delete params.password;
        this.password.value = "";
        const request = new AbortController();
        this.requests.add(request);
        const timeout = setTimeout(() => request.abort(), 15000);
        this.sending = true;
        this.render();
        this.feedback.textContent = `${LABELS[action] || action}: submitting request…`;
        try {
            const pending = this.fetch("/api/network-manager/actions", {
                method: "POST", signal: request.signal, credentials: "same-origin", cache: "no-store",
                headers: { "Content-Type": "application/json", "X-Network-Control": "1" }, body,
            });
            body = null;
            const response = await pending;
            const result = await response.json();
            if (this.stopped) return;
            if (!response.ok) {
                const code = text(result.error?.code || response.status);
                this.feedback.textContent = `${code}: ${text(result.error?.message || "Network request rejected.")}`;
                return;
            }
            const operation = result.operation;
            if (!operation?.id) {
                this.feedback.textContent = "Invalid operation response; wait for cached live state before retrying.";
                return;
            }
            // A live record may have advanced while the POST response was in flight.
            const live = list(this.snapshot?.operations).find((item) => item.id === operation.id);
            if (!live || this.newer(operation, live)) this.localOperations.set(operation.id, operation);
            while (this.localOperations.size > 100) this.localOperations.delete(this.localOperations.keys().next().value);
            this.feedback.textContent = "Request accepted; operation status is not proof of a connected link.";
            this.renderOperations();
        } catch {
            if (!this.stopped) this.feedback.textContent = "Request outcome unknown. Check live operation state before retrying; connection may have changed.";
        } finally {
            body = null;
            clearTimeout(timeout);
            this.requests.delete(request);
            this.sending = false;
            if (!this.stopped) this.render();
        }
    }
    newer(candidate, other) {
        if (candidate.updated_at === other.updated_at) return false;
        const time = (value) => typeof value === "number" ? value : Date.parse(value);
        return time(candidate.updated_at) > time(other.updated_at);
    }
    renderOperations() {
        const records = new Map(this.localOperations);
        for (const operation of list(this.snapshot?.operations)) {
            if (!operation?.id) continue;
            const local = records.get(operation.id);
            if (!local || !this.newer(local, operation)) {
                records.set(operation.id, operation);
                this.localOperations.delete(operation.id);
            }
        }
        clearTimeout(this.countdownTimer);
        let countdown = false;
        const nodes = [...records.values()].slice(-100).reverse().map((operation) => {
            const row = el("div", "network-operation");
            row.dataset.state = operation.status;
            row.append(el("strong", "", `${LABELS[operation.action] || operation.action} · ${text(operation.target)} · ${text(operation.status)}`));
            const status = operation.status === "submitted" ? "Requested only; not yet observed connected." :
                operation.status === "succeeded" ? "Completed; see observed inventory for link state." : "";
            row.append(el("p", "", [operation.message, status].filter(Boolean).join(" ")));
            if (operation.error) row.append(el("p", "network-control-warning", `${text(operation.error.code)}: ${text(operation.error.message)}`));
            const checkpoint = operation.checkpoint;
            if (checkpoint?.id && !FINAL.has(operation.status)) {
                const remaining = Math.max(0, Math.ceil((expiry(checkpoint.expires_at) - this.now()) / 1000));
                if (Number.isFinite(remaining)) {
                    row.append(el("p", "", remaining ? `OS rollback checkpoint: ${remaining}s remaining.` :
                        "Checkpoint deadline reached; waiting for observed backend outcome."));
                    countdown ||= remaining > 0;
                    for (const [action, label] of [["checkpoint_confirm", "Keep change"], ["checkpoint_revert", "Revert change"]]) {
                        const button = el("button", "", label);
                        button.type = "button";
                        button.disabled = !remaining || this.sending === true;
                        // Detached rows and their handlers are collected together on the next render.
                        button.addEventListener("click", () => this.dispatch(action, { operation_id: operation.id }));
                        row.append(button);
                    }
                }
            }
            return row;
        });
        this.tabs?.setBadge("operations", records.size || "");
        this.operations.replaceChildren(...(nodes.length ? nodes : [el("p", "monitoring-muted", "No operations requested.")]));
        if (countdown && !this.stopped) this.countdownTimer = setTimeout(() => this.renderOperations(), 1000);
    }
    stop() {
        this.stopped = true;
        this.version++;
        clearTimeout(this.countdownTimer);
        for (const request of this.requests) request.abort();
        this.requests.clear();
        for (const [node, event, handler] of this.listeners) node.removeEventListener(event, handler);
        this.listeners = [];
        this.tabs?.stop();
        this.password.value = "";
        this.profile.value = "";
        this.localOperations.clear();
        this.snapshot = null;
        this.root.remove();
    }
}
