import Plugin from "../plugin.js";
import MonitoringDashboard from "../monitoring/dashboard.js";
import { animateNumber, bytes, details, el, number, text } from "../monitoring/core.js";
import TabController from "../monitoring/tabs.js";
import { NetworkControls, createTechSvg, triggerDropRipple } from "./controls.js";

const TECHNOLOGIES = [["wifi", "Wi-Fi", "wifi"], ["ethernet", "Ethernet", "interfaces"], ["bluetooth", "Bluetooth", "bluetooth"], ["hotspot", "Hotspot", "wifi"]];
const LINK_STATES = {
    connected: "Link connected", disconnected: "Link disconnected",
    connecting: "Link connecting", unavailable: "Unavailable on this host", unknown: "Link state unknown",
};

export class NetworkDashboard extends MonitoringDashboard {
    constructor(overlay) {
        super(overlay, "network-manager", "Network activity", "Live link telemetry and explicit server connection controls. A connected link does not imply internet access.");
        this.selected = "";
        this.techListeners = [];
        const summary = el("div", "monitoring-summary");
        this.receive = this.card("Total Receive · RX", "N/A", { accent: "primary", subtitle: "INGRESS STREAM" });
        this.send = this.card("Total Transmit · TX", "N/A", { accent: "secondary", subtitle: "EGRESS STREAM" });
        this.linkCount = this.card("Active Links", "N/A", { accent: "tertiary", subtitle: "LINK TOPOLOGY" });
        summary.append(this.receive.card, this.send.card, this.linkCount.card);
        this.content.append(summary);

        const overviewPane = el("div", "monitoring-tab-stack");
        const technologies = el("div", "monitoring-technologies");
        this.technologies = new Map();
        for (const [key, name, targetSection] of TECHNOLOGIES) {
            const section = el("section", "monitoring-technology network-android-tile");
            section.dataset.technology = key;
            section.dataset.targetSection = targetSection;
            section.setAttribute("role", "button");
            section.tabIndex = 0;
            const spread = el("span", "network-tile-spread");
            spread.setAttribute("aria-hidden", "true");
            const topRow = el("div", "network-tech-tile-header");
            const iconWrap = el("span", "network-quick-tile-icon");
            iconWrap.append(createTechSvg(key));
            const heading = el("h2", "", name);
            topRow.append(iconWrap, heading);
            const state = el("p", "monitoring-link-state");
            const names = el("p", "monitoring-muted");
            section.append(spread, topRow, state, names);
            const onActivate = (ev) => {
                triggerDropRipple(section, ev);
                this.tabs?.select("controls");
                this.controls?.selectSection?.(targetSection);
            };
            const onHover = (ev) => triggerDropRipple(section, ev);
            section.addEventListener("mouseenter", onHover);
            section.addEventListener("click", onActivate);
            this.techListeners.push([section, "mouseenter", onHover], [section, "click", onActivate]);
            technologies.append(section);
            this.technologies.set(key, { section, state, names, targetSection });
        }
        overviewPane.append(technologies);
        this.chart(overviewPane, "All interfaces · traffic rate", [
            { label: "RX (solid)", value: (s) => s.totals?.recv_rate },
            { label: "TX (dashed)", value: (s) => s.totals?.sent_rate },
        ], { format: (value) => bytes(value, true) });

        const inspectorPane = el("div", "monitoring-tab-stack");
        const selectedSection = el("section", "monitoring-section");
        selectedSection.append(el("h2", "", "Interface inspector"));
        const label = el("label", "monitoring-interface-label", "Interface ");
        this.interfaceSelect = el("select");
        this.interfaceSelect.setAttribute("aria-label", "Network interface");
        label.append(this.interfaceSelect);
        this.interfaceStatus = el("p", "monitoring-muted");
        this.interfaceDetails = el("div");
        this.addresses = el("div");
        this.nativeDetails = el("div");
        this.metadata = el("div");
        this.onInterface = () => {
            this.selected = this.interfaceSelect.value;
            this.requestRender();
        };
        this.interfaceSelect.addEventListener("change", this.onInterface);
        selectedSection.append(label, this.interfaceStatus, this.interfaceDetails,
            el("h3", "", "Addresses & Subnets"), this.addresses,
            el("h3", "", "Gateways, DNS and routes (read-only)"), this.nativeDetails,
            el("h3", "", "Provider metadata"), this.metadata);
        this.chart(selectedSection, "Selected interface · traffic rate", [
            { label: "RX (solid)", value: (s) => s.interfaces?.find((item) => item.name === this.selected)?.recv_rate },
            { label: "TX (dashed)", value: (s) => s.interfaces?.find((item) => item.name === this.selected)?.sent_rate },
        ], { format: (value) => bytes(value, true) });
        inspectorPane.append(selectedSection);

        const controlsPane = el("div", "monitoring-tab-stack");
        this.controls = new NetworkControls(controlsPane);

        const capabilitiesPane = el("div", "monitoring-tab-stack");
        this.capabilities = el("div");
        const disclosure = el("section", "monitoring-section monitoring-capabilities");
        disclosure.append(el("h2", "", "Collection capabilities"), this.capabilities);
        capabilitiesPane.append(disclosure);

        this.tabs = new TabController(this.content, [
            { id: "overview", label: "Overview & Traffic", content: overviewPane },
            { id: "controls", label: "Connect", content: controlsPane },
            { id: "inspector", label: "Interface & Subnet Inspector", content: inspectorPane },
            { id: "capabilities", label: "Capabilities", content: capabilitiesPane },
        ], { onChange: () => this.requestRender() });
    }
    start() {
        super.start();
        this.controls.start();
    }
    compact(sample = {}) {
        if (!sample) return {};
        return {
            timestamp: sample.timestamp, totals: sample.totals,
            interfaces: (Array.isArray(sample.interfaces) ? sample.interfaces : []).map((item) => ({
                name: item.name, recv_rate: item.recv_rate, sent_rate: item.sent_rate,
            })),
        };
    }
    render(sample) {
        this.controls.render(sample.control);
        const interfaces = (Array.isArray(sample.interfaces) ? sample.interfaces : []).slice(0, 256);
        const rxRate = sample.totals?.recv_rate;
        const txRate = sample.totals?.sent_rate;
        const rateScale = (r) => (typeof r === "number" && Number.isFinite(r) && r >= 0)
            ? Math.min(100, (Math.log10(Math.max(1, r)) / 8) * 100)
            : null;
        this.receive.updateValue(rxRate, (v) => bytes(v, true), {
            percent: rateScale(rxRate),
            statusText: typeof rxRate === "number" ? "INGRESS ACTIVE" : "SAMPLING RATE",
        });
        this.send.updateValue(txRate, (v) => bytes(v, true), {
            percent: rateScale(txRate),
            statusText: typeof txRate === "number" ? "EGRESS ACTIVE" : "SAMPLING RATE",
        });
        const upCount = interfaces.filter((item) => item.is_up === true).length;
        const linkPct = interfaces.length ? (upCount / interfaces.length) * 100 : 0;
        this.linkCount.updateText(sample.interfaces ? `${upCount} / ${interfaces.length}` : "N/A", {
            percent: sample.interfaces ? linkPct : 0,
            statusText: sample.interfaces ? "INTERFACES ONLINE" : "DISCOVERING LINKS",
        });
        for (const [key] of TECHNOLOGIES) {
            const connection = sample.connections?.[key];
            const view = this.technologies.get(key);
            const state = connection?.state || "unknown";
            view.state.textContent = LINK_STATES[state] || LINK_STATES.unknown;
            view.state.dataset.state = state;
            if (view.section) view.section.dataset.state = state;
            view.names.textContent = Array.isArray(connection?.interfaces) && connection.interfaces.length ?
                connection.interfaces.join(", ") : "No reported interfaces";
        }
        if (!this.selected && interfaces.length) this.selected = interfaces[0].name;
        // Preserve a missing selection so disappearing interfaces are explicit, not silently replaced.
        const signature = JSON.stringify(interfaces.map((item) => [item.name, item.state]));
        if (signature !== this.interfaceSignature) {
            this.interfaceSignature = signature;
            const options = interfaces.map((item) => {
                const option = el("option", "", `${item.name} · ${LINK_STATES[item.state] || LINK_STATES.unknown}`);
                option.value = item.name;
                return option;
            });
            if (this.selected && !interfaces.some((item) => item.name === this.selected)) {
                const missing = el("option", "", `${this.selected} · no longer present`);
                missing.value = this.selected;
                options.push(missing);
            }
            if (!options.length) {
                const empty = el("option", "", "No interfaces available");
                empty.value = "";
                options.push(empty);
            }
            this.interfaceSelect.replaceChildren(...options);
        }
        this.interfaceSelect.value = this.selected;
        const selected = interfaces.find((item) => item.name === this.selected);
        this.interfaceStatus.textContent = selected ?
            `${LINK_STATES[selected.state] || LINK_STATES.unknown} · ${text(selected.type)} · Link up: ${selected.is_up === true ? "yes" : selected.is_up === false ? "no" : "N/A"}` :
            "Interface unavailable. Historical traffic remains visible; select another interface if available.";
        this.interfaceDetails.replaceChildren(details([
            ["MAC address", text(selected?.mac)], ["Link speed", number(selected?.speed_mbps, " Mbps")],
            ["MTU", number(selected?.mtu, " bytes", 0)], ["Received", bytes(selected?.bytes_recv)],
            ["Transmitted", bytes(selected?.bytes_sent)], ["Receive rate", bytes(selected?.recv_rate, true)],
            ["Transmit rate", bytes(selected?.sent_rate, true)],
        ]));
        const addresses = Array.isArray(selected?.addresses) ? selected.addresses : [];
        this.addresses.replaceChildren(...(addresses.length ? addresses.map((address) => details([
            ["Family", text(address.family)], ["Address", text(address.address)],
            ["Netmask", text(address.netmask)], ["Broadcast", text(address.broadcast)],
            ["Prefix length", number(address.prefix_length, "", 0)], ["Network CIDR", text(address.network_cidr)],
        ])) : [el("p", "monitoring-muted", "N/A · no addresses reported.")]));
        const native = this.controls.snapshot?.details?.[this.selected];
        this.nativeDetails.replaceChildren(details([
            ["Gateways", text(native?.gateways)], ["DNS servers", text(native?.dns)],
            ["Routes", text(native?.routes)], ["Address method", text(native?.method)],
            ["Detail source", text(native?.source)],
        ]));
        const metadata = Object.entries(selected?.metadata || {});
        this.metadata.replaceChildren(metadata.length ? details(metadata) :
            el("p", "monitoring-muted", "N/A · no optional metadata reported by this provider."));
        this.capabilities.replaceChildren(details(Object.entries(sample.capabilities || {})));
    }
    stop() {
        for (const [node, event, handler] of this.techListeners || []) {
            node.removeEventListener(event, handler);
        }
        this.techListeners = [];
        this.tabs?.stop();
        this.controls.stop();
        this.interfaceSelect.removeEventListener("change", this.onInterface);
        super.stop();
    }
}

export default class NetworkManagerPlugin extends Plugin {
    constructor() {
        super("Network Manager", "network.svg");
        this.dashboard = null;
    }
    async start({ overlay }) {
        this.dashboard?.stop();
        this.dashboard = new NetworkDashboard(overlay);
        this.dashboard.start();
    }
    async stop() {
        this.dashboard?.stop();
        this.dashboard = null;
    }
}
