import { el } from "./core.js";

/**
 * Modular, accessible TabController with smooth CSS transitions.
 * Supports keyboard navigation (ArrowLeft, ArrowRight, Home, End) and clean disposal.
 */
export default class TabController {
    constructor(container, tabs = [], { className = "monitoring-tabs", onChange = null } = {}) {
        this.container = container;
        this.onChange = onChange;
        this.tabs = new Map();
        this.order = [];
        this.listeners = [];
        this.activeId = "";

        this.root = el("div", className);
        this.tablist = el("div", "monitoring-tablist");
        this.tablist.setAttribute("role", "tablist");
        this.panelsWrap = el("div", "monitoring-tabpanels");
        this.root.append(this.tablist, this.panelsWrap);
        container.append(this.root);

        for (const tab of tabs) {
            this.addTab(tab.id, tab.label, tab.content, tab.badge);
        }
        if (this.order.length) {
            this.select(this.order[0], false);
        }
    }

    addTab(id, label, contentNode, badgeText = "") {
        const button = el("button", "monitoring-tab-btn");
        button.type = "button";
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", "false");
        button.dataset.tabId = id;

        const titleSpan = el("span", "monitoring-tab-label", label);
        const badgeSpan = el("span", "monitoring-tab-badge", badgeText);
        if (!badgeText) badgeSpan.hidden = true;
        button.append(titleSpan, badgeSpan);

        const panel = el("div", "monitoring-tabpanel");
        panel.setAttribute("role", "tabpanel");
        panel.dataset.tabId = id;
        if (contentNode) panel.append(contentNode);

        const onClick = () => this.select(id, true);
        const onKeyDown = (event) => this._handleKey(event, id);
        button.addEventListener("click", onClick);
        button.addEventListener("keydown", onKeyDown);
        this.listeners.push([button, "click", onClick], [button, "keydown", onKeyDown]);

        this.tablist.append(button);
        this.panelsWrap.append(panel);
        this.tabs.set(id, { id, button, badge: badgeSpan, panel });
        this.order.push(id);
        return panel;
    }

    setBadge(id, value) {
        const entry = this.tabs.get(id);
        if (!entry) return;
        const text = value === null || value === undefined || value === "" ? "" : String(value);
        entry.badge.textContent = text;
        entry.badge.hidden = !text;
    }

    select(id, notify = true) {
        if (!this.tabs.has(id)) return;
        this.activeId = id;
        for (const [tabId, entry] of this.tabs) {
            const active = tabId === id;
            entry.button.setAttribute("aria-selected", active ? "true" : "false");
            entry.button.dataset.active = active ? "true" : "false";
            entry.panel.dataset.active = active ? "true" : "false";
            if (entry.button.classList) {
                entry.button.classList.toggle("is-active", active);
                entry.panel.classList.toggle("is-active", active);
            }
        }
        if (notify && typeof this.onChange === "function") {
            this.onChange(id);
        }
    }

    _handleKey(event, currentId) {
        const idx = this.order.indexOf(currentId);
        if (idx < 0) return;
        let nextIdx = -1;
        if (event.key === "ArrowRight") nextIdx = (idx + 1) % this.order.length;
        else if (event.key === "ArrowLeft") nextIdx = (idx - 1 + this.order.length) % this.order.length;
        else if (event.key === "Home") nextIdx = 0;
        else if (event.key === "End") nextIdx = this.order.length - 1;
        if (nextIdx >= 0) {
            event.preventDefault?.();
            const nextId = this.order[nextIdx];
            this.select(nextId, true);
            this.tabs.get(nextId)?.button?.focus?.();
        }
    }

    stop() {
        for (const [node, event, handler] of this.listeners) {
            node.removeEventListener(event, handler);
        }
        this.listeners = [];
        this.tabs.clear();
        this.order = [];
        this.root.remove();
    }
}
