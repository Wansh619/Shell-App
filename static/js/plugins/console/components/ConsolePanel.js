import ConsoleManager from "./ConsoleManager.js";

export default class ConsolePanel {
    constructor() {
        this.manager = null;
    }

    start(container) {
        const host = document.createElement("div");
        host.className = "console-panel-host";
        host.innerHTML = `
            <main class="console-shell">
                <header class="console-topbar">
                    <div class="console-brand">
                        <button
                            id="toggle-console-sidebar"
                            class="console-sidebar-toggle"
                            type="button"
                            aria-label="Hide session sidebar"
                            aria-expanded="true"
                            aria-controls="console-sidebar"
                            title="Hide session sidebar"
                        ><span aria-hidden="true">☰</span></button>
                        <span class="console-status-dot"></span>
                        <div>
                            <strong>Shell Console</strong>
                            <span>Interactive workspace</span>
                        </div>
                    </div>
                    <div class="console-actions" aria-label="Terminal pane actions">
                        <button id="split-horizontal" type="button" title="Split left and right">
                            <span aria-hidden="true">◫</span> Split horizontal
                        </button>
                        <button id="split-vertical" type="button" title="Split top and bottom">
                            <span aria-hidden="true">⊟</span> Split vertical
                        </button>
                        <button id="close-pane" type="button" title="Close active pane">
                            <span aria-hidden="true">−</span> Close pane
                        </button>
                    </div>
                </header>
                <div class="console-main">
                    <aside id="console-sidebar" class="console-sidebar" aria-hidden="false">
                        <nav class="console-session-nav" aria-label="Console sessions">
                            <div class="console-sidebar-heading">Sessions</div>
                            <div id="console-sessions" class="console-sessions"></div>
                            <button id="new-console-session" class="console-new-session" type="button">
                                <span aria-hidden="true">+</span> New session
                            </button>
                        </nav>
                    </aside>
                    <section id="console-workspaces" class="console-workspaces" aria-label="Terminal panes"></section>
                </div>
            </main>
        `;
        container.append(host);
        this.manager = new ConsoleManager();
    }

    stop() {
        this.manager?.dispose();
        this.manager = null;
    }
}
