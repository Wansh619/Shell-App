(function () {
    const overlay = document.getElementById("start-overlay");
    const terminalSection = document.getElementById("terminal-section");
    const revealFrame = document.getElementById("terminal-reveal-frame");
    const terminalWrapper = document.getElementById("terminal-wrapper");
    const borderRect = document.querySelector(".terminal-border-rect");
    const connectorSvg = document.getElementById("terminal-connector-svg");
    const connectorPath = document.getElementById("terminal-connector-path");

    if (!overlay || !terminalSection || !revealFrame || !terminalWrapper || typeof window.PcbStartLayout !== "function") {
        return;
    }

    const layout = new window.PcbStartLayout({
        container: overlay,
        startLabel: "START",
        viewBoxSize: 400,
        nodeRadius: 140,
        traceRouting: "auto",
        nodes: [
            { name: "Shell", icon: "fa-solid fa-terminal", ariaLabel: "Open terminal" },
            { name: "Host", icon: "fa-solid fa-server", ariaLabel: "Open terminal" },
            { name: "Code", icon: "fa-solid fa-code", ariaLabel: "Open terminal" },
            { name: "Debug", icon: "fa-solid fa-bug", ariaLabel: "Open terminal" },
            { name: "Config", icon: "fa-solid fa-gear", ariaLabel: "Open terminal" },
            { name: "Connect", icon: "fa-solid fa-plug", ariaLabel: "Open terminal" }
        ]
    });

    const { startButton, nodesContainer } = layout.getElements();

    let pcbNodesReady = false;
    let terminalRevealStarted = false;
    let terminalInitialized = false;

    const TRACE_MS = 1100;

    startButton.addEventListener("click", () => {
        if (overlay.classList.contains("pcb-active")) {
            return;
        }
        overlay.classList.add("pcb-active");
        layout.playTraceAnimations();
        window.setTimeout(() => {
            nodesContainer.classList.add("pcb-nodes--visible");
            pcbNodesReady = true;
        }, TRACE_MS);
    });

    /**
     * Cardinal connector from click point to top-center of terminal frame (viewport coords).
     */
    function layoutConnectorPath(sx, sy) {
        if (!connectorSvg || !connectorPath) {
            return;
        }
        const w = window.innerWidth;
        const h = window.innerHeight;
        connectorSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        const fr = revealFrame.getBoundingClientRect();
        const ex = fr.left + fr.width / 2;
        const ey = fr.top;
        const d = `M ${sx} ${sy} L ${sx} ${ey} L ${ex} ${ey}`;
        connectorPath.setAttribute("d", d);
    }

    function hideConnector() {
        if (connectorSvg) {
            connectorSvg.classList.remove("terminal-connector-svg--visible");
        }
        if (connectorPath) {
            connectorPath.style.strokeDashoffset = "";
            connectorPath.style.strokeDasharray = "";
            connectorPath.style.opacity = "";
        }
    }

    function playConnectorThen(sx, sy, onDone) {
        if (!connectorSvg || !connectorPath) {
            onDone();
            return;
        }

        const prefersReduced =
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        layoutConnectorPath(sx, sy);

        if (prefersReduced) {
            connectorSvg.classList.add("terminal-connector-svg--visible");
            window.setTimeout(() => {
                hideConnector();
                onDone();
            }, 50);
            return;
        }

        const len = connectorPath.getTotalLength();
        const dash = len > 0 ? len : 1;
        connectorPath.style.strokeDasharray = String(dash);
        connectorPath.style.strokeDashoffset = String(dash);
        connectorSvg.classList.add("terminal-connector-svg--visible");

        if (!connectorPath.animate) {
            connectorPath.style.strokeDashoffset = "0";
            window.setTimeout(() => {
                hideConnector();
                onDone();
            }, 400);
            return;
        }

        const anim = connectorPath.animate(
            [
                { strokeDashoffset: dash, opacity: 0.75 },
                { strokeDashoffset: 0, opacity: 1 }
            ],
            {
                duration: 550,
                easing: "ease-out",
                fill: "forwards"
            }
        );

        anim.onfinish = () => {
            hideConnector();
            onDone();
        };
    }

    function runBorderThenReveal() {
        if (terminalRevealStarted) {
            return;
        }
        terminalRevealStarted = true;

        let revealDone = false;
        let safetyTimer = null;

        const finishReveal = () => {
            if (revealDone) {
                return;
            }
            revealDone = true;
            if (safetyTimer !== null) {
                window.clearTimeout(safetyTimer);
                safetyTimer = null;
            }

            terminalWrapper.classList.remove("terminal-hidden");
            terminalWrapper.classList.add("terminal-visible");
            revealFrame.classList.remove("terminal-reveal-frame--tracing");

            if (!terminalInitialized && typeof window.initTerminalUI === "function") {
                terminalInitialized = true;
                window.requestAnimationFrame(() => {
                    window.requestAnimationFrame(() => {
                        window.initTerminalUI();
                    });
                });
            }
        };

        revealFrame.classList.remove("terminal-reveal-frame--tracing");
        void revealFrame.offsetWidth;
        revealFrame.classList.add("terminal-reveal-frame--tracing");

        safetyTimer = window.setTimeout(finishReveal, 1400);

        if (borderRect) {
            const brLen = borderRect.getTotalLength();
            const dash = brLen > 0 ? brLen : 400;
            borderRect.style.strokeDasharray = String(dash);
            borderRect.style.strokeDashoffset = String(dash);
            borderRect.style.opacity = "1";

            const prefersReduced =
                typeof window.matchMedia === "function" &&
                window.matchMedia("(prefers-reduced-motion: reduce)").matches;

            if (prefersReduced || !borderRect.animate) {
                borderRect.style.strokeDashoffset = "0";
                window.setTimeout(finishReveal, 50);
                return;
            }

            const borderAnim = borderRect.animate(
                [
                    { strokeDashoffset: dash, opacity: 1 },
                    { strokeDashoffset: 0, opacity: 1 }
                ],
                {
                    duration: 1100,
                    easing: "ease",
                    fill: "forwards"
                }
            );

            borderAnim.onfinish = () => {
                if (safetyTimer !== null) {
                    window.clearTimeout(safetyTimer);
                    safetyTimer = null;
                }
                finishReveal();
            };
        } else {
            finishReveal();
        }
    }

    function handleNodeClick(event) {
        if (!pcbNodesReady) {
            return;
        }

        const node = event.target.closest(".pcb-node");
        if (!node) {
            return;
        }

        const rect = node.getBoundingClientRect();
        const sx = rect.left + rect.width / 2;
        const sy = rect.top + rect.height / 2;

        overlay.classList.add("is-dismissed");
        overlay.setAttribute("aria-hidden", "true");

        terminalSection.scrollIntoView({ behavior: "smooth", block: "start" });

        window.setTimeout(() => {
            window.requestAnimationFrame(() => {
                playConnectorThen(sx, sy, () => {
                    runBorderThenReveal();
                });
            });
        }, 420);
    }

    nodesContainer.addEventListener("click", (event) => {
        const node = event.target.closest(".pcb-node");
        if (!node || !nodesContainer.contains(node)) {
            return;
        }
        handleNodeClick(event);
    });
})();
