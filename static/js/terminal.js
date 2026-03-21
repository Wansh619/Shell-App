const tabsContainer = document.getElementById("terminal-tabs");
const panelsContainer = document.getElementById("terminal-panels");
const newTabButton = document.getElementById("new-terminal-tab");

const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const sessions = new Map();

let activeSessionId = null;
let tabCounter = 0;

const buildTerminal = () => new Terminal({
    cursorBlink: true,
    fontSize: 14,
    theme: {
        background: "#121212",
        foreground: "#ffffff"
    }
});

const setActiveSession = (sessionId) => {
    activeSessionId = sessionId;
    sessions.forEach((session, id) => {
        const isActive = id === sessionId;
        session.tabButton.classList.toggle("active", isActive);
        session.pane.classList.toggle("active", isActive);
    });
};

const closeSocket = (ws) => {
    if (!ws) {
        return;
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
    }
};

const createSessionTab = () => {
    const sessionId = `tab-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    tabCounter += 1;

    const tabButton = document.createElement("button");
    tabButton.type = "button";
    tabButton.className = "terminal-tab";
    tabButton.dataset.sessionId = sessionId;

    const tabLabel = document.createElement("span");
    tabLabel.textContent = `Terminal ${tabCounter}`;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "terminal-tab-close";
    closeButton.textContent = "x";
    closeButton.setAttribute("aria-label", `Close Terminal ${tabCounter}`);

    tabButton.appendChild(tabLabel);
    tabButton.appendChild(closeButton);
    tabsContainer.appendChild(tabButton);

    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    pane.dataset.sessionId = sessionId;
    panelsContainer.appendChild(pane);

    const term = buildTerminal();
    term.open(pane);

    const ws = new WebSocket(`${wsProtocol}://${window.location.host}/terminal`);
    ws.onopen = () => {
        term.write("Connected to terminal\r\n");
    };
    ws.onmessage = (event) => {
        term.write(event.data);
    };
    ws.onclose = () => {
        term.write("\r\n[Terminal session closed]\r\n");
    };
    ws.onerror = () => {
        term.write("\r\n[Terminal connection error]\r\n");
    };

    term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    tabButton.addEventListener("click", () => {
        setActiveSession(sessionId);
    });

    closeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        removeSessionTab(sessionId);
    });

    sessions.set(sessionId, { term, ws, pane, tabButton });
    setActiveSession(sessionId);
};

const removeSessionTab = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
        return;
    }

    closeSocket(session.ws);
    session.term.dispose();
    session.pane.remove();
    session.tabButton.remove();
    sessions.delete(sessionId);

    if (sessions.size === 0) {
        createSessionTab();
        return;
    }

    if (activeSessionId === sessionId) {
        const nextSessionId = sessions.keys().next().value;
        setActiveSession(nextSessionId);
    }
};

const closeAllSockets = () => {
    sessions.forEach((session) => closeSocket(session.ws));
};

newTabButton.addEventListener("click", createSessionTab);
window.addEventListener("beforeunload", closeAllSockets);
window.addEventListener("pagehide", closeAllSockets);

createSessionTab();
