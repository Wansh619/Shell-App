const tabsContainer = document.getElementById("terminal-tabs");
const panelsContainer = document.getElementById("terminal-panels");
const newTabButton = document.getElementById("new-terminal-tab");

const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const sessions = new Map();
const pendingInputs = new Map();

let activeSessionId = null;
let tabCounter = 0;

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let isPageClosing = false;

const getWsUrl = () => `${wsProtocol}://${window.location.host}/terminal`;

const buildTerminal = () => new Terminal({
    cursorBlink: true,
    fontSize: 14,
    theme: {
        background: "#121212",
        foreground: "#ffffff"
    }
});

const sendMessage = (sessionId, value) => {
    const payload = { session_id: sessionId, value };
    const data = JSON.stringify(payload);

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
        return true;
    }

    const queued = pendingInputs.get(sessionId) || [];
    queued.push(data);
    pendingInputs.set(sessionId, queued);
    return false;
};

const writeAll = (text) => {
    sessions.forEach((session) => {
        session.term.write(text);
    });
};

const flushPending = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }
    pendingInputs.forEach((queue, sessionId) => {
        queue.forEach((data) => ws.send(data));
        pendingInputs.delete(sessionId);
    });
};

const announceAndRecreateSessions = () => {
    sessions.forEach((_session, sessionId) => sendMessage(sessionId, "__CTRL__:CREATE"));
    flushPending();
};

const scheduleReconnect = () => {
    if (isPageClosing) {
        return;
    }
    if (reconnectTimer) {
        return;
    }

    reconnectAttempt += 1;
    const baseDelay = 400;
    const maxDelay = 8000;
    const delay = Math.min(maxDelay, baseDelay * (2 ** Math.min(6, reconnectAttempt - 1)));

    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectSocket();
    }, delay);
};

const connectSocket = () => {
    if (isPageClosing) {
        return;
    }

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    try {
        ws = new WebSocket(getWsUrl());
    } catch {
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        reconnectAttempt = 0;
        writeAll("\r\n[Terminal connected]\r\n");
        announceAndRecreateSessions();
    };

    ws.onmessage = (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }

        const sessionId = msg.session_id;
        const value = msg.value;
        const session = sessions.get(sessionId);
        if (!session) {
            return;
        }
        if (typeof value === "string") {
            session.term.write(value);
        }
    };

    ws.onclose = () => {
        if (!isPageClosing) {
            writeAll("\r\n[Terminal disconnected, reconnecting...]\r\n");
        }
        scheduleReconnect();
    };

    ws.onerror = () => {
        if (!isPageClosing) {
            writeAll("\r\n[Terminal connection error]\r\n");
        }
    };
};

const setActiveSession = (sessionId) => {
    activeSessionId = sessionId;
    sessions.forEach((session, id) => {
        const isActive = id === sessionId;
        session.tabButton.classList.toggle("active", isActive);
        session.pane.classList.toggle("active", isActive);
    });
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

    term.onData((data) => {
        sendMessage(sessionId, data);
    });

    tabButton.addEventListener("click", () => {
        setActiveSession(sessionId);
    });

    closeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        removeSessionTab(sessionId);
    });

    sessions.set(sessionId, { term, pane, tabButton });
    setActiveSession(sessionId);

    sendMessage(sessionId, "__CTRL__:CREATE");
};

const removeSessionTab = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
        return;
    }

    sendMessage(sessionId, "__CTRL__:CLOSE");
    session.term.dispose();
    session.pane.remove();
    session.tabButton.remove();
    sessions.delete(sessionId);
    pendingInputs.delete(sessionId);

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
    isPageClosing = true;
    sessions.forEach((_session, sessionId) => {
        sendMessage(sessionId, "__CTRL__:CLOSE");
    });
    if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
    }
};

newTabButton.addEventListener("click", createSessionTab);
window.addEventListener("beforeunload", closeAllSockets);
window.addEventListener("pagehide", closeAllSockets);

connectSocket();
createSessionTab();
