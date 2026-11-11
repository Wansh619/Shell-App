import ConsoleManager from "./ConsoleManager.js?v=console-skills-9";

function buildGeometricAmbientSvg() {
    const spokes = [];
    for (let i = 0; i < 24; i += 1) {
        const angle = (i * 15 * Math.PI) / 180;
        const x1 = (800 + Math.cos(angle) * 90).toFixed(1);
        const y1 = (500 + Math.sin(angle) * 90).toFixed(1);
        const x2 = (800 + Math.cos(angle) * 680).toFixed(1);
        const y2 = (500 + Math.sin(angle) * 680).toFixed(1);
        spokes.push(
            `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="0.55" stroke-dasharray="3 9" />`
        );
    }

    const rosettePetals = [];
    for (let i = 0; i < 12; i += 1) {
        const deg = i * 30;
        rosettePetals.push(
            `<ellipse cx="800" cy="500" rx="460" ry="170" transform="rotate(${deg} 800 500)" stroke="currentColor" stroke-width="0.75" stroke-dasharray="18 10 4 10" />`
        );
    }

    const innerHarmonics = [];
    for (let i = 0; i < 18; i += 1) {
        const deg = i * 20;
        innerHarmonics.push(
            `<rect x="520" y="220" width="560" height="560" rx="28" transform="rotate(${deg} 800 500)" stroke="currentColor" stroke-width="0.6" stroke-dasharray="12 16" />`
        );
    }

    const periodicWaves = [];
    for (let k = 0; k < 9; k += 1) {
        const yBase = 100 + k * 100;
        const d1 = `M -100 ${yBase} Q 350 ${yBase - 110}, 800 ${yBase} T 1700 ${yBase}`;
        const d2 = `M -100 ${yBase} Q 350 ${yBase + 110}, 800 ${yBase} T 1700 ${yBase}`;
        periodicWaves.push(
            `<path class="geo-wave geo-wave--a" d="${d1}" stroke="currentColor" stroke-width="0.65" stroke-dasharray="8 12" />`,
            `<path class="geo-wave geo-wave--b" d="${d2}" stroke="currentColor" stroke-width="0.5" stroke-dasharray="4 14" />`
        );
    }

    return `
        <svg class="console-ambient-svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" fill="none">
            <g class="geo-layer geo-layer--waves">
                ${periodicWaves.join("")}
            </g>
            <g class="geo-layer geo-layer--spokes">
                ${spokes.join("")}
                <circle cx="800" cy="500" r="640" stroke="currentColor" stroke-width="0.8" stroke-dasharray="4 12" />
                <circle cx="800" cy="500" r="520" stroke="currentColor" stroke-width="0.9" stroke-dasharray="28 14 4 14" />
                <circle cx="800" cy="500" r="390" stroke="currentColor" stroke-width="0.75" stroke-dasharray="10 10" />
            </g>
            <g class="geo-layer geo-layer--rosette">
                ${rosettePetals.join("")}
            </g>
            <g class="geo-layer geo-layer--polyhedra">
                ${innerHarmonics.join("")}
            </g>
            <g class="geo-layer geo-layer--core">
                <circle cx="800" cy="500" r="240" stroke="currentColor" stroke-width="1.1" stroke-dasharray="16 8 2 8" />
                <circle cx="800" cy="500" r="140" stroke="currentColor" stroke-width="1" stroke-dasharray="6 6" />
                <circle cx="800" cy="500" r="64" stroke="currentColor" stroke-width="1.2" />
            </g>
        </svg>
    `;
}

export default class ConsolePanel {
    constructor(options = {}) {
        this.options = options;
        this.manager = null;
    }

    start(container) {
        const host = document.createElement("div");
        host.className = "console-panel-host";
        host.innerHTML = `
            <main class="console-shell">
                <div class="console-ambient-bg" aria-hidden="true">
                    ${buildGeometricAmbientSvg()}
                </div>
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
                        >
                            <svg class="console-sidebar-svg" viewBox="0 0 24 24" aria-hidden="true">
                                <rect class="svg-trace-frame" x="3" y="4" width="18" height="16" rx="3" />
                                <line class="svg-trace-divider" x1="9.5" y1="4" x2="9.5" y2="20" />
                                <rect class="svg-fill-panel" x="4.2" y="5.2" width="4.2" height="13.6" rx="1.2" />
                                <path class="svg-trace-chevron" d="M15 9.5L12.5 12L15 14.5" />
                            </svg>
                        </button>
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
        this.manager = new ConsoleManager(this.options);
    }

    stop() {
        this.manager?.dispose();
        this.manager = null;
    }
}
