import { createDefaultSkillRegistry } from "../skills/registry.js";

const VALID_PANEL_STATES = new Set(["terminal", "editor panel", "image panel"]);

class CommandBlock {
    constructor(container, command) {
        this.element = document.createElement("article");
        this.element.className = "console-command-block";

        this.stdin = document.createElement("pre");
        this.stdin.className = "console-command-stdin";
        this.stdin.textContent = command;

        this.stdout = document.createElement("pre");
        this.stdout.className = "console-command-stdout";

        this.status = document.createElement("span");
        this.status.className = "console-command-status";
        this.status.setAttribute("aria-live", "polite");
        this.status.textContent = "Input";

        this.toolbar = document.createElement("div");
        this.toolbar.className = "console-command-toolbar";

        this.copyFeedback = document.createElement("span");
        this.copyFeedback.className = "console-command-copy-feedback";
        this.copyFeedback.setAttribute("role", "status");
        this.copyFeedback.setAttribute("aria-live", "polite");

        this.copyMenu = document.createElement("details");
        this.copyMenu.className = "console-command-copy-menu";

        this.copyMenuSummary = document.createElement("summary");
        this.copyMenuSummary.textContent = "\u22ee";
        this.copyMenuSummary.setAttribute("aria-label", "Copy command block");
        this.copyMenuSummary.title = "Copy command block";

        const copyOptions = document.createElement("div");
        copyOptions.className = "console-command-copy-options";
        const actions = [
            ["Copy stdin", () => this.stdin.textContent],
            ["Copy stdout", () => this.stdout.textContent],
            [
                "Copy whole block",
                () => this.stdout.textContent
                    ? `${this.stdin.textContent}\n${this.stdout.textContent}`
                    : this.stdin.textContent
            ]
        ];

        actions.forEach(([label, getText]) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.addEventListener("click", () => {
                void this.copyText(getText(), label);
            });
            copyOptions.append(button);
        });

        this.copyMenu.append(this.copyMenuSummary, copyOptions);
        this.copyMenu.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                this.copyMenu.open = false;
                this.copyMenuSummary.focus();
            }
        });

        this.toolbar.append(this.status, this.copyFeedback, this.copyMenu);
        this.element.append(this.stdin, this.stdout, this.toolbar);
        container.append(this.element);
    }

    updateInput(value) {
        this.stdin.textContent = value;
    }

    start() {
        this.status.textContent = "Running";
    }

    setRunningInput(form) {
        this.runningForm?.remove();
        this.runningForm = form;
        this.element.insertBefore(form, this.toolbar);
    }

    clearRunningInput() {
        this.runningForm?.remove();
        this.runningForm = null;
    }

    write(value) {
        this.stdout.textContent += value;
        this.stdout.scrollTop = this.stdout.scrollHeight;
    }

    async copyText(value, label) {
        try {
            if (navigator.clipboard?.writeText) {
                try {
                    await navigator.clipboard.writeText(value);
                } catch {
                    this.copyWithFallback(value);
                }
            } else {
                this.copyWithFallback(value);
            }
            this.copyFeedback.textContent = `${label} copied`;
        } catch {
            this.copyFeedback.textContent = "Copy failed";
        } finally {
            this.copyMenu.open = false;
            this.copyMenuSummary.focus();
        }
    }

    copyWithFallback(value) {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) {
            throw new Error("Clipboard copy failed.");
        }
    }

    finish(exitCode) {
        this.status.textContent = exitCode === 0
            ? "Completed"
            : `Exited with code ${exitCode}`;
        this.status.classList.toggle("has-error", exitCode !== 0);
    }

    fail(message) {
        this.status.textContent = message;
        this.status.classList.add("has-error");
    }
}

const ANSI_CONTROL_SEQUENCE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const NON_PRINTING_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1D\x1F\x7F]/g;

class ConsoleView {
    constructor(
        sessionId,
        container,
        {
            sendInput,
            sendResize,
            sendSkill,
            skillRegistry,
            paneElement = null,
            stateBadge = null,
            backButton = null
        } = {}
    ) {
        this.sessionId = sessionId;
        this.container = container;
        this.sendInput = sendInput || (() => {});
        this.sendResize = sendResize || (() => {});
        this.sendSkill = sendSkill || (() => {});
        this.skillRegistry = skillRegistry || createDefaultSkillRegistry();
        this.paneElement = paneElement;
        this.stateBadge = stateBadge;
        this.backButton = backButton;

        this.state = "terminal";
        this.inputMode = "terminal";
        this.selectedSkill = null;
        this.activeSkillController = null;

        this.promptMarker = null;
        this.pendingOutput = "";
        this.pendingCommandEcho = "";
        this.commandEchoBuffer = "";
        this.activeBlock = null;
        this.draftBlock = null;
        this.isReady = false;
        this.lastSize = "";

        this.output = document.createElement("div");
        this.output.className = "console-command-history";
        this.output.setAttribute("aria-live", "polite");

        this.modeBar = this._createModeBar();

        this.form = document.createElement("form");
        this.form.className = "console-command-form";

        this.prompt = document.createElement("span");
        this.prompt.className = "console-command-prompt";
        this.prompt.textContent = "$";

        this.input = document.createElement("textarea");
        this.input.className = "console-command-input";
        this.input.rows = 1;
        this.input.disabled = true;
        this.input.setAttribute("aria-label", "Command or process input");
        this.input.setAttribute("spellcheck", "false");
        this.input.autocomplete = "off";
        this.input.autocapitalize = "off";
        this.input.placeholder = "Connecting to terminal...";

        this.submit = document.createElement("button");
        this.submit.className = "console-command-submit";
        this.submit.type = "submit";
        this.submit.disabled = true;
        this.submit.textContent = "Run";

        this.skillPanel = document.createElement("div");
        this.skillPanel.className = "console-skill-panel";
        this.skillPanel.hidden = true;

        this.form.append(this.prompt, this.input, this.submit);
        this.container.replaceChildren(this.output, this.modeBar, this.form, this.skillPanel);
        this._syncStateAttributes();

        this.form.addEventListener("submit", (event) => {
            event.preventDefault();
            this.submitInput();
        });
        this.input.addEventListener("keydown", (event) => {
            this.handleKeydown(event, this.input, this.form);
        });
        this.input.addEventListener("input", () => this.updateDraft());

        this.resizeObserver = new ResizeObserver(() => this.fit());
        this.resizeObserver.observe(container);
        requestAnimationFrame(() => this.fit());
    }

    _createModeBar() {
        const bar = document.createElement("div");
        bar.className = "console-input-mode-bar";

        const toggleGroup = document.createElement("div");
        toggleGroup.className = "console-mode-toggle";
        toggleGroup.setAttribute("role", "group");
        toggleGroup.setAttribute("aria-label", "Input mode");

        this.terminalModeBtn = document.createElement("button");
        this.terminalModeBtn.type = "button";
        this.terminalModeBtn.className = "console-mode-btn is-active";
        this.terminalModeBtn.dataset.mode = "terminal";
        this.terminalModeBtn.setAttribute("aria-pressed", "true");
        this.terminalModeBtn.textContent = "Terminal";
        this.terminalModeBtn.addEventListener("click", () => this.setInputMode("terminal"));

        this.skillsModeBtn = document.createElement("button");
        this.skillsModeBtn.type = "button";
        this.skillsModeBtn.className = "console-mode-btn";
        this.skillsModeBtn.dataset.mode = "skills";
        this.skillsModeBtn.setAttribute("aria-pressed", "false");
        this.skillsModeBtn.textContent = "Skills";
        this.skillsModeBtn.addEventListener("click", () => this.setInputMode("skills"));

        toggleGroup.append(this.terminalModeBtn, this.skillsModeBtn);

        this.skillSelector = document.createElement("div");
        this.skillSelector.className = "console-skill-selector";
        this.skillSelector.hidden = true;

        this.skillPills = new Map();
        for (const skill of this.skillRegistry.list()) {
            const pill = document.createElement("button");
            pill.type = "button";
            pill.className = "console-skill-pill";
            pill.dataset.skill = skill.name;
            pill.textContent = skill.name;
            pill.title = skill.label || skill.name;
            pill.setAttribute("aria-pressed", "false");
            pill.addEventListener("click", () => {
                const nextSkill = this.selectedSkill === skill.name ? null : skill.name;
                this.setSelectedSkill(nextSkill);
                this.input.focus();
            });
            this.skillPills.set(skill.name, pill);
            this.skillSelector.append(pill);
        }

        bar.append(toggleGroup, this.skillSelector);
        return bar;
    }

    setInputMode(mode) {
        if (mode !== "terminal" && mode !== "skills") {
            return;
        }
        this.inputMode = mode;
        const isSkills = mode === "skills";
        this.terminalModeBtn.classList.toggle("is-active", !isSkills);
        this.terminalModeBtn.setAttribute("aria-pressed", String(!isSkills));
        this.skillsModeBtn.classList.toggle("is-active", isSkills);
        this.skillsModeBtn.setAttribute("aria-pressed", String(isSkills));
        this.skillSelector.hidden = !isSkills;
        this.container.dataset.inputMode = mode;

        if (isSkills && this.draftBlock) {
            this.draftBlock.element.remove();
            this.draftBlock = null;
        }

        this.updateInputState();
    }

    setSelectedSkill(skillName) {
        this.selectedSkill = skillName && this.skillRegistry.get(skillName)
            ? String(skillName).toLowerCase()
            : null;
        for (const [name, pill] of this.skillPills.entries()) {
            const active = name === this.selectedSkill;
            pill.classList.toggle("is-active", active);
            pill.setAttribute("aria-pressed", String(active));
        }
        this.updateInputState();
    }

    _syncStateAttributes() {
        this.container.dataset.panelState = this.state;
        if (this.paneElement) {
            this.paneElement.dataset.panelState = this.state;
        }
        if (this.stateBadge) {
            this.stateBadge.textContent = this.state;
            this.stateBadge.dataset.panelState = this.state;
        }
        if (this.backButton) {
            this.backButton.hidden = this.state === "terminal";
        }
    }

    transitionToState(panelState, skillResultData = {}, skillMeta = {}) {
        const normalizedState = String(panelState ?? "").trim();
        if (!VALID_PANEL_STATES.has(normalizedState)) {
            throw new Error(`Unsupported panel state: ${panelState}`);
        }
        if (normalizedState === "terminal") {
            this.transitionToTerminal();
            return;
        }

        if (this.activeSkillController?.dispose) {
            this.activeSkillController.dispose();
        }
        this.activeSkillController = null;

        this.state = normalizedState;
        this._syncStateAttributes();

        this.output.hidden = true;
        this.modeBar.hidden = true;
        this.form.hidden = true;
        this.skillPanel.hidden = false;
        this.skillPanel.dataset.panelState = normalizedState;

        const skillPlugin =
            (skillMeta?.skill && this.skillRegistry.get(skillMeta.skill))
            || this.skillRegistry.getByPanelState(normalizedState);

        if (!skillPlugin) {
            this.skillPanel.replaceChildren();
            return;
        }

        const context = {
            sessionId: this.sessionId,
            paneId: this.sessionId,
            skill: skillPlugin.name,
            panelState: normalizedState,
            sendSkillAction: (actionOrPayload, extra = {}) => {
                if (typeof actionOrPayload === "string") {
                    this.sendSkill(this.sessionId, {
                        skill: skillPlugin.name,
                        action: actionOrPayload,
                        ...extra
                    });
                    return;
                }
                if (actionOrPayload && typeof actionOrPayload === "object") {
                    this.sendSkill(this.sessionId, {
                        skill: skillPlugin.name,
                        ...actionOrPayload
                    });
                }
            },
            onBack: () => this.transitionToTerminal()
        };

        this.activeSkillController =
            skillPlugin.renderPanel(this.skillPanel, skillResultData, context) || null;
        this.activeSkillController?.focus?.();
    }

    transitionToTerminal() {
        if (this.activeSkillController?.dispose) {
            this.activeSkillController.dispose();
        }
        this.activeSkillController = null;
        this.skillPanel.replaceChildren();
        this.skillPanel.hidden = true;
        delete this.skillPanel.dataset.panelState;

        this.state = "terminal";
        this._syncStateAttributes();

        this.output.hidden = false;
        this.modeBar.hidden = false;
        this.form.hidden = false;
        this.updateInputState();
        this.input.focus();
    }

    handleSkillResult(message) {
        if (!message || typeof message !== "object") {
            return;
        }

        if (message.status === "error") {
            const errorText = message.message || "Skill execution failed.";
            if (this.state !== "terminal" && this.activeSkillController) {
                if (typeof this.activeSkillController.onSkillResult === "function") {
                    this.activeSkillController.onSkillResult(message);
                    return;
                }
                if (typeof this.activeSkillController.showError === "function") {
                    this.activeSkillController.showError(errorText);
                    return;
                }
            }
            this.showSkillError(errorText);
            return;
        }

        if (message.status === "ok") {
            const targetState =
                message.panel_state
                || this.skillRegistry.get(message.skill)?.panelState;

            const isFollowUpAction =
                this.state === targetState
                && this.state !== "terminal"
                && this.activeSkillController
                && typeof this.activeSkillController.onSkillResult === "function"
                && message.action
                && message.action !== "read";

            if (isFollowUpAction) {
                this.activeSkillController.onSkillResult(message);
                return;
            }

            if (targetState && VALID_PANEL_STATES.has(targetState)) {
                this.transitionToState(targetState, message.data || {}, message);
            }
        }
    }

    showSkillError(message) {
        const error = document.createElement("pre");
        error.className = "console-terminal-error";
        error.setAttribute("role", "alert");
        error.textContent = message;
        this.output.append(error);
        this.scrollToBottom();
    }

    handleKeydown(event, input, form, isRunningInput = false) {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            form.requestSubmit();
        } else if (event.key.toLowerCase() === "c" && event.ctrlKey) {
            event.preventDefault();
            input.value = "";
            if (isRunningInput) {
                this.sendInput(this.sessionId, "\u0003");
            } else {
                this.updateDraft();
            }
        } else if (event.key.toLowerCase() === "d" && event.ctrlKey) {
            event.preventDefault();
            this.sendInput(this.sessionId, "\u0004");
        }
    }

    createRunningInput(block) {
        const form = document.createElement("form");
        form.className = "console-command-running-form";

        const input = document.createElement("textarea");
        input.className = "console-command-running-input";
        input.rows = 1;
        input.setAttribute("aria-label", "Input to the running command");
        input.setAttribute("spellcheck", "false");
        input.autocomplete = "off";
        input.autocapitalize = "off";
        input.placeholder = "Send input to the running command";

        const submit = document.createElement("button");
        submit.className = "console-command-submit";
        submit.type = "submit";
        submit.textContent = "Send";

        form.append(input, submit);
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            if (this.activeBlock !== block || !this.isReady) {
                return;
            }

            const value = input.value;
            input.value = "";
            this.sendInput(this.sessionId, `${value}\n`);
            input.focus();
            this.scrollToBottom();
        });
        input.addEventListener("keydown", (event) => {
            this.handleKeydown(event, input, form, true);
        });
        block.setRunningInput(form);
        input.focus();
    }

    submitInput() {
        if (this.inputMode === "skills") {
            this.submitSkillInput();
            return;
        }

        if (!this.isReady || this.activeBlock) {
            return;
        }

        const value = this.input.value;
        this.input.value = "";
        if (!value.trim()) {
            this.draftBlock?.element.remove();
            this.draftBlock = null;
            return;
        }

        this.activeBlock = this.draftBlock || new CommandBlock(this.output, value);
        this.activeBlock.updateInput(value);
        this.activeBlock.start();
        this.draftBlock = null;
        this.createRunningInput(this.activeBlock);
        this.updateInputState();
        this.pendingCommandEcho = `${value.replace(/\n/g, "\r\n")}\r\n`;
        this.commandEchoBuffer = "";
        this.sendInput(this.sessionId, `${value}\n`);
        this.scrollToBottom();
    }

    submitSkillInput() {
        const rawValue = this.input.value.trim();
        if (!rawValue) {
            return;
        }

        const parsed = this.skillRegistry.parseSkillInput(rawValue, this.selectedSkill);
        if (!parsed) {
            this.showSkillError("Unknown skill command. Try 'open <path>' or 'image <path>'.");
            return;
        }
        if (!parsed.args) {
            this.showSkillError(`Missing file path argument for skill '${parsed.skill}'.`);
            return;
        }

        this.input.value = "";
        this.sendSkill(this.sessionId, {
            skill: parsed.skill,
            action: "read",
            args: parsed.args
        });
    }

    updateDraft() {
        if (this.inputMode === "skills" || this.activeBlock) {
            return;
        }

        if (!this.input.value) {
            this.draftBlock?.element.remove();
            this.draftBlock = null;
            return;
        }

        if (!this.draftBlock) {
            this.draftBlock = new CommandBlock(this.output, this.input.value);
        } else {
            this.draftBlock.updateInput(this.input.value);
        }
        this.scrollToBottom();
    }

    setPromptToken(token) {
        if (typeof token !== "string" || !/^[a-f0-9]+$/i.test(token)) {
            this.showError("The terminal server sent an invalid prompt token.");
            return;
        }

        if (this.isReady && this.activeBlock) {
            this.activeBlock.fail("Session restarted");
            this.activeBlock.clearRunningInput();
            this.activeBlock = null;
        }
        this.promptMarker = `\x1eSHELL_APP_PROMPT:${token}:`;
        this.isReady = true;
        this.updateInputState();
        this.consumeOutput();
        this.input.focus();
    }

    write(value) {
        this.pendingOutput += value;
        this.consumeOutput();
    }

    consumeOutput() {
        if (!this.promptMarker) {
            return;
        }

        while (true) {
            const markerIndex = this.pendingOutput.indexOf(this.promptMarker);
            if (markerIndex === -1) {
                const retainedLength = this.getPartialMarkerLength();
                const printableLength = this.pendingOutput.length - retainedLength;
                if (printableLength > 0) {
                    this.appendTerminalOutput(this.pendingOutput.slice(0, printableLength));
                    this.pendingOutput = this.pendingOutput.slice(printableLength);
                }
                return;
            }

            this.appendTerminalOutput(this.pendingOutput.slice(0, markerIndex));
            const statusStart = markerIndex + this.promptMarker.length;
            const markerEnd = this.pendingOutput.indexOf("\x1f", statusStart);
            if (markerEnd === -1) {
                this.pendingOutput = this.pendingOutput.slice(markerIndex);
                return;
            }

            const exitCode = Number.parseInt(
                this.pendingOutput.slice(statusStart, markerEnd),
                10
            );
            this.activeBlock?.finish(Number.isNaN(exitCode) ? 1 : exitCode);
            this.activeBlock?.clearRunningInput();
            this.activeBlock = null;
            this.updateInputState();
            this.input.focus();
            this.pendingOutput = this.pendingOutput.slice(markerEnd + 1);
        }
    }

    getPartialMarkerLength() {
        const maxLength = Math.min(
            this.pendingOutput.length,
            this.promptMarker.length - 1
        );
        for (let length = maxLength; length > 0; length--) {
            if (this.pendingOutput.endsWith(this.promptMarker.slice(0, length))) {
                return length;
            }
        }
        return 0;
    }

    appendOutput(value) {
        const printable = value
            .replace(ANSI_CONTROL_SEQUENCE, "")
            .replace(/\r\n?/g, "\n")
            .replace(NON_PRINTING_CONTROL, "");
        if (!printable) {
            return;
        }

        if (this.activeBlock) {
            this.activeBlock.write(printable);
        } else {
            const log = document.createElement("pre");
            log.className = "console-terminal-log";
            log.textContent = printable;
            this.output.append(log);
        }
        this.scrollToBottom();
    }

    appendTerminalOutput(value) {
        if (!this.pendingCommandEcho) {
            this.appendOutput(value);
            return;
        }

        this.commandEchoBuffer += value;
        if (this.pendingCommandEcho.startsWith(this.commandEchoBuffer)) {
            if (this.commandEchoBuffer === this.pendingCommandEcho) {
                this.pendingCommandEcho = "";
                this.commandEchoBuffer = "";
            }
            return;
        }

        const echoLength = this.commandEchoBuffer.startsWith(this.pendingCommandEcho)
            ? this.pendingCommandEcho.length
            : 0;
        const remainingOutput = this.commandEchoBuffer.slice(echoLength);
        this.pendingCommandEcho = "";
        this.commandEchoBuffer = "";
        this.appendOutput(remainingOutput);
    }

    updateInputState() {
        if (this.inputMode === "skills") {
            const activePlugin = this.selectedSkill
                ? this.skillRegistry.get(this.selectedSkill)
                : null;
            this.prompt.textContent = "✦";
            this.input.disabled = false;
            this.submit.disabled = false;
            this.form.setAttribute("aria-disabled", "false");
            this.input.placeholder = activePlugin?.placeholder
                || "Enter skill command (e.g. open path/to/file or image path/to/img.png)";
            this.submit.textContent = "Run Skill";
            return;
        }

        const isRunning = Boolean(this.activeBlock);
        this.prompt.textContent = isRunning ? ">" : "$";
        this.input.disabled = !this.isReady || isRunning;
        this.submit.disabled = !this.isReady || isRunning;
        this.form.setAttribute("aria-disabled", String(isRunning || !this.isReady));
        this.input.placeholder = !this.isReady
            ? "Connecting to terminal..."
            : isRunning
                ? "Send input to the running command"
                : "Enter a command";
        this.submit.textContent = isRunning ? "Send" : "Run";
        this.updateDraft();
    }

    showError(message) {
        const error = document.createElement("pre");
        error.className = "console-terminal-error";
        error.setAttribute("role", "alert");
        error.textContent = message;
        this.output.append(error);
        this.input.disabled = true;
        this.submit.disabled = true;
    }

    scrollToBottom() {
        this.output.scrollTop = this.output.scrollHeight;
    }

    fit() {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        if (!width || !height) {
            return;
        }

        const cols = Math.max(20, Math.floor(width / 8));
        const rows = Math.max(5, Math.floor(height / 20));
        const size = `${cols}x${rows}`;
        if (size !== this.lastSize) {
            this.lastSize = size;
            this.sendResize(this.sessionId, cols, rows);
        }
    }

    focus() {
        if (this.state !== "terminal" && this.activeSkillController?.focus) {
            this.activeSkillController.focus();
            return;
        }
        this.input.focus();
    }

    dispose() {
        if (this.activeSkillController?.dispose) {
            this.activeSkillController.dispose();
            this.activeSkillController = null;
        }
        this.resizeObserver.disconnect();
        this.container.replaceChildren();
    }
}

class ConsoleTransport {
    constructor({ onOpen, onMessage }) {
        this.onOpen = onOpen;
        this.onMessage = onMessage;
        this.socket = null;
        this.pendingMessages = new Map();
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.isClosing = false;
    }

    getSocketUrl() {
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        return `${protocol}://${window.location.host}/terminal`;
    }

    connect() {
        if (this.isClosing || (this.socket
            && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState))) {
            return;
        }

        this.socket = new WebSocket(this.getSocketUrl());
        this.socket.onopen = () => {
            this.reconnectAttempt = 0;
            this.onOpen();
            this.flushPending();
        };
        this.socket.onmessage = (event) => this.handleMessage(event);
        this.socket.onclose = () => this.scheduleReconnect();
        this.socket.onerror = () => this.socket.close();
    }

    handleMessage(event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (error) {
            console.error("Received an invalid terminal message.", error);
            return;
        }

        if (!message || typeof message !== "object") {
            console.error("Received an invalid terminal message.");
            return;
        }
        this.onMessage(message);
    }

    send(payload) {
        const encoded = JSON.stringify(payload);
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(encoded);
            return;
        }

        const queue = this.pendingMessages.get(payload.session_id) || [];
        queue.push(encoded);
        this.pendingMessages.set(payload.session_id, queue);
    }

    flushPending() {
        this.pendingMessages.forEach((queue) => {
            queue.forEach((message) => this.socket.send(message));
        });
        this.pendingMessages.clear();
    }

    scheduleReconnect() {
        if (this.isClosing || this.reconnectTimer) {
            return;
        }

        const delay = Math.min(8000, 400 * (2 ** Math.min(6, this.reconnectAttempt++)));
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    close(sessionIds) {
        if (this.isClosing) {
            return;
        }

        this.isClosing = true;
        if (this.reconnectTimer) {
            window.clearTimeout(this.reconnectTimer);
        }

        if (this.socket?.readyState === WebSocket.OPEN) {
            sessionIds.forEach((sessionId) => {
                this.socket.send(JSON.stringify({
                    session_id: sessionId,
                    value: "__CTRL__:CLOSE"
                }));
            });
            this.socket.close();
        } else if (this.socket?.readyState === WebSocket.CONNECTING) {
            this.socket.close();
        }
    }
}

class PaneManager {
    constructor(container, { createTerminal, removeTerminal, onActivate }) {
        this.container = container;
        this.createTerminal = createTerminal;
        this.removeTerminal = removeTerminal;
        this.onActivate = onActivate;
        this.nextPaneNumber = 1;
        this.activePaneId = null;
        this.root = this._createLeaf();
        this.activePaneId = this.root.id;
        this.render();
    }

    get paneCount() {
        return this._getLeaves().length;
    }

    split(orientation) {
        if (orientation !== "horizontal" && orientation !== "vertical") {
            throw new Error(`Unsupported split orientation: ${orientation}`);
        }

        const currentLeaf = this._findLeaf(this.root, this.activePaneId);
        if (!currentLeaf) {
            return;
        }

        const newLeaf = this._createLeaf();
        const splitNode = {
            type: "split",
            orientation,
            ratio: 0.5,
            children: [currentLeaf, newLeaf]
        };
        this.root = this._replaceNode(this.root, currentLeaf.id, splitNode);
        this.activePaneId = newLeaf.id;
        this.render();
        this.onActivate(newLeaf.id);
    }

    activate(paneId) {
        if (!this._findLeaf(this.root, paneId)) {
            return;
        }

        this.activePaneId = paneId;
        this._updateActiveStyles();
        this.onActivate(paneId);
    }

    closeActive() {
        if (this.paneCount <= 1) {
            return false;
        }

        const closingId = this.activePaneId;
        this.root = this._removeLeaf(this.root, closingId);
        this.removeTerminal(closingId);
        this.activePaneId = this._firstLeaf(this.root).id;
        this.render();
        this.onActivate(this.activePaneId);
        return true;
    }

    dispose() {
        for (const leaf of this._getLeaves()) {
            this.removeTerminal(leaf.id);
        }
        this.container.replaceChildren();
    }

    fit() {
        for (const leaf of this._getLeaves()) {
            leaf.terminal.fit();
        }
    }

    _createLeaf() {
        const id = `pane-${crypto.randomUUID()}`;
        const element = document.createElement("section");
        element.className = "console-pane";
        element.dataset.paneId = id;
        element.dataset.panelState = "terminal";

        const header = document.createElement("div");
        header.className = "console-pane-header";

        const titleGroup = document.createElement("div");
        titleGroup.className = "console-pane-title-group";

        const title = document.createElement("span");
        title.className = "console-pane-title";
        title.textContent = `Terminal ${this.nextPaneNumber++}`;

        const stateBadge = document.createElement("span");
        stateBadge.className = "console-pane-state-badge";
        stateBadge.dataset.panelState = "terminal";
        stateBadge.textContent = "terminal";

        titleGroup.append(title, stateBadge);

        const controlsGroup = document.createElement("div");
        controlsGroup.className = "console-pane-controls";

        const backButton = document.createElement("button");
        backButton.className = "console-pane-back";
        backButton.type = "button";
        backButton.hidden = true;
        backButton.textContent = "← Back to Terminal";
        backButton.setAttribute("aria-label", "Back to terminal");

        const closeButton = document.createElement("button");
        closeButton.className = "console-pane-close";
        closeButton.type = "button";
        closeButton.textContent = "×";
        closeButton.setAttribute("aria-label", "Close terminal pane");

        controlsGroup.append(backButton, closeButton);

        const terminalContainer = document.createElement("div");
        terminalContainer.className = "console-terminal";

        header.append(titleGroup, controlsGroup);
        element.append(header, terminalContainer);

        const terminal = this.createTerminal(id, terminalContainer, {
            paneElement: element,
            stateBadge,
            backButton
        });

        const leaf = {
            type: "leaf",
            id,
            element,
            stateBadge,
            backButton,
            terminal
        };

        backButton.addEventListener("click", (event) => {
            event.stopPropagation();
            leaf.terminal?.transitionToTerminal?.();
        });
        element.addEventListener("pointerdown", () => this.activate(id));
        closeButton.addEventListener("click", (event) => {
            event.stopPropagation();
            if (id !== this.activePaneId) {
                this.activate(id);
            }
            this.closeActive();
        });

        return leaf;
    }

    _renderNode(node) {
        if (node.type === "leaf") {
            return node.element;
        }

        const split = document.createElement("div");
        split.className = `console-split console-split--${node.orientation}`;
        const first = document.createElement("div");
        first.className = "console-split-child";
        first.append(this._renderNode(node.children[0]));
        first.style.flexGrow = String(node.ratio);

        const second = document.createElement("div");
        second.className = "console-split-child";
        second.append(this._renderNode(node.children[1]));
        second.style.flexGrow = String(1 - node.ratio);

        const divider = document.createElement("div");
        divider.className = `console-split-divider console-split-divider--${node.orientation}`;
        divider.setAttribute("role", "separator");
        divider.setAttribute("tabindex", "0");
        divider.setAttribute("aria-valuemin", "0");
        divider.setAttribute("aria-valuemax", "100");
        divider.setAttribute(
            "aria-orientation",
            node.orientation === "horizontal" ? "vertical" : "horizontal"
        );
        divider.setAttribute("aria-label", "Resize terminal panes");
        divider.setAttribute("aria-valuenow", String(Math.round(node.ratio * 100)));
        divider.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            divider.setPointerCapture(event.pointerId);
        });
        divider.addEventListener("pointermove", (event) => {
            if (!divider.hasPointerCapture(event.pointerId)) {
                return;
            }
            event.stopPropagation();
            this._resizeSplit(node, split, first, second, divider, event);
        });
        divider.addEventListener("pointerup", (event) => {
            if (divider.hasPointerCapture(event.pointerId)) {
                divider.releasePointerCapture(event.pointerId);
            }
        });
        divider.addEventListener("pointercancel", (event) => {
            if (divider.hasPointerCapture(event.pointerId)) {
                divider.releasePointerCapture(event.pointerId);
            }
        });
        divider.addEventListener("keydown", (event) => {
            const negativeKey = node.orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
            const positiveKey = node.orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
            if (event.key !== negativeKey && event.key !== positiveKey) {
                return;
            }
            event.preventDefault();
            const delta = event.key === positiveKey ? 0.05 : -0.05;
            this._setSplitRatio(
                node,
                first,
                second,
                divider,
                node.ratio + delta,
                this._minimumSplitRatio(split)
            );
        });

        split.append(first, divider, second);
        return split;
    }

    _resizeSplit(node, split, first, second, divider, event) {
        const bounds = split.getBoundingClientRect();
        const coordinate = node.orientation === "horizontal"
            ? event.clientX - bounds.left
            : event.clientY - bounds.top;
        const extent = node.orientation === "horizontal" ? bounds.width : bounds.height;
        if (extent <= 0) {
            return;
        }

        this._setSplitRatio(
            node,
            first,
            second,
            divider,
            coordinate / extent,
            this._minimumSplitRatio(split)
        );
    }

    _minimumSplitRatio(split) {
        const bounds = split.getBoundingClientRect();
        const extent = split.classList.contains("console-split--horizontal")
            ? bounds.width
            : bounds.height;
        return Math.min(0.5, 120 / Math.max(extent, 240));
    }

    _setSplitRatio(node, first, second, divider, ratio, minimum) {
        node.ratio = Math.max(minimum, Math.min(1 - minimum, ratio));
        first.style.flexGrow = String(node.ratio);
        second.style.flexGrow = String(1 - node.ratio);
        divider.setAttribute("aria-valuenow", String(Math.round(node.ratio * 100)));
    }

    render() {
        this.container.replaceChildren(this._renderNode(this.root));
        this._updateActiveStyles();
    }

    _updateActiveStyles() {
        this.container.querySelectorAll(".console-pane").forEach((pane) => {
            pane.classList.toggle("is-active", pane.dataset.paneId === this.activePaneId);
        });
    }

    _getLeaves(node = this.root) {
        if (node.type === "leaf") {
            return [node];
        }

        return node.children.flatMap((child) => this._getLeaves(child));
    }

    _findLeaf(node, paneId) {
        if (node.type === "leaf") {
            return node.id === paneId ? node : null;
        }

        return this._findLeaf(node.children[0], paneId)
            || this._findLeaf(node.children[1], paneId);
    }

    _replaceNode(node, paneId, replacement) {
        if (node.type === "leaf") {
            return node.id === paneId ? replacement : node;
        }

        return {
            ...node,
            children: node.children.map((child) =>
                this._replaceNode(child, paneId, replacement)
            )
        };
    }

    _removeLeaf(node, paneId) {
        if (node.type === "leaf") {
            return node.id === paneId ? null : node;
        }

        const left = this._removeLeaf(node.children[0], paneId);
        const right = this._removeLeaf(node.children[1], paneId);
        if (!left) {
            return right;
        }
        if (!right) {
            return left;
        }

        return { ...node, children: [left, right] };
    }

    _firstLeaf(node) {
        return node.type === "leaf" ? node : this._firstLeaf(node.children[0]);
    }
}

class PanelSession {
    constructor(id, number, tabsContainer, workspacesContainer, callbacks) {
        this.id = id;
        this.tab = document.createElement("div");
        this.tab.className = "console-session-tab";

        const selectButton = document.createElement("button");
        selectButton.className = "console-session-select";
        selectButton.type = "button";
        selectButton.textContent = `Session ${number}`;
        selectButton.addEventListener("click", () => callbacks.onActivate(this.id));

        const closeButton = document.createElement("button");
        closeButton.className = "console-session-close";
        closeButton.type = "button";
        closeButton.textContent = "×";
        closeButton.setAttribute("aria-label", `Close Session ${number}`);
        closeButton.addEventListener("click", () => callbacks.onClose(this.id));

        this.tab.append(selectButton, closeButton);
        tabsContainer.append(this.tab);

        this.workspace = document.createElement("div");
        this.workspace.className = "console-workspace";
        this.workspace.dataset.sessionId = id;
        workspacesContainer.append(this.workspace);

        this.paneManager = new PaneManager(this.workspace, {
            createTerminal: callbacks.createTerminal,
            removeTerminal: callbacks.removeTerminal,
            onActivate: (paneId) => callbacks.onTerminalActivate(this.id, paneId)
        });
    }

    setActive(active) {
        this.tab.classList.toggle("is-active", active);
        this.workspace.hidden = !active;
    }

    dispose() {
        this.paneManager.dispose();
        this.tab.remove();
        this.workspace.remove();
    }
}

export default class ConsoleManager {
    constructor({ skillRegistry } = {}) {
        this.tabsContainer = document.getElementById("console-sessions");
        this.workspacesContainer = document.getElementById("console-workspaces");
        this.sidebar = document.getElementById("console-sidebar");
        this.sidebarToggle = document.getElementById("toggle-console-sidebar");
        this.skillRegistry = skillRegistry || createDefaultSkillRegistry();
        this.terminalMap = new Map();
        this.panelSessions = new Map();
        this.activeSessionId = null;
        this.sessionNumber = 0;
        this.transport = new ConsoleTransport({
            onOpen: () => this.restoreTerminalSessions(),
            onMessage: (message) => this.handleMessage(message)
        });

        document.getElementById("new-console-session")
            .addEventListener("click", () => this.createPanelSession());
        this.sidebarToggle.addEventListener("click", () => this.toggleSidebar());
        document.getElementById("split-horizontal")
            .addEventListener("click", () => this.splitActive("horizontal"));
        document.getElementById("split-vertical")
            .addEventListener("click", () => this.splitActive("vertical"));
        document.getElementById("close-pane")
            .addEventListener("click", () => this.closeActivePane());

        this.onResize = () => {
            this.panelSessions.get(this.activeSessionId)?.paneManager.fit();
        };
        this.onUnload = () => this.close();
        window.addEventListener("resize", this.onResize);
        window.addEventListener("beforeunload", this.onUnload);
        window.addEventListener("pagehide", this.onUnload);

        this.transport.connect();
        this.createPanelSession();
    }

    toggleSidebar() {
        const isOpen = this.sidebar.classList.toggle("is-collapsed") === false;
        this.sidebarToggle.setAttribute("aria-expanded", String(isOpen));
        this.sidebarToggle.setAttribute(
            "aria-label",
            isOpen ? "Hide session sidebar" : "Show session sidebar"
        );
        this.sidebarToggle.title = isOpen ? "Hide session sidebar" : "Show session sidebar";
        this.sidebar.setAttribute("aria-hidden", String(!isOpen));
        this.sidebar.inert = !isOpen;
        requestAnimationFrame(() => {
            this.panelSessions.get(this.activeSessionId)?.paneManager.fit();
        });
    }

    createPanelSession() {
        const id = `workspace-${crypto.randomUUID()}`;
        const number = ++this.sessionNumber;
        const session = new PanelSession(
            id,
            number,
            this.tabsContainer,
            this.workspacesContainer,
            {
                onActivate: (sessionId) => this.activatePanelSession(sessionId),
                onClose: (sessionId) => this.closePanelSession(sessionId),
                createTerminal: (paneId, container, paneContext) =>
                    this.createTerminal(id, paneId, container, paneContext),
                removeTerminal: (paneId) => this.removeTerminal(paneId),
                onTerminalActivate: (sessionId, paneId) =>
                    this.activateTerminal(sessionId, paneId)
            }
        );
        this.panelSessions.set(id, session);
        this.activatePanelSession(id);
    }

    activatePanelSession(sessionId) {
        if (!this.panelSessions.has(sessionId)) {
            return;
        }

        this.activeSessionId = sessionId;
        this.panelSessions.forEach((session, id) => {
            session.setActive(id === sessionId);
        });

        const session = this.panelSessions.get(sessionId);
        session.paneManager.fit();
        this.updateToolbar(session.paneManager.activePaneId);
    }

    splitActive(orientation) {
        this.panelSessions.get(this.activeSessionId)?.paneManager.split(orientation);
    }

    closeActivePane() {
        this.panelSessions.get(this.activeSessionId)?.paneManager.closeActive();
    }

    closePanelSession(sessionId) {
        const session = this.panelSessions.get(sessionId);
        if (!session) {
            return;
        }

        session.dispose();
        this.panelSessions.delete(sessionId);

        if (this.panelSessions.size === 0) {
            this.createPanelSession();
        } else if (this.activeSessionId === sessionId) {
            this.activatePanelSession(this.panelSessions.keys().next().value);
        }
    }

    createTerminal(workspaceId, paneId, container, paneContext = {}) {
        const terminal = new ConsoleView(paneId, container, {
            sendInput: (sessionId, value) => this.send(sessionId, value),
            sendResize: (sessionId, cols, rows) =>
                this.sendResize(sessionId, cols, rows),
            sendSkill: (sessionId, skillPayload) =>
                this.sendSkill(sessionId, skillPayload),
            skillRegistry: this.skillRegistry,
            ...paneContext
        });
        this.terminalMap.set(paneId, { terminal, workspaceId });
        this.send(paneId, "__CTRL__:CREATE");
        requestAnimationFrame(() => terminal.fit());
        return terminal;
    }

    activateTerminal(workspaceId, paneId) {
        if (this.activeSessionId === workspaceId) {
            this.updateToolbar(paneId);
            this.terminalMap.get(paneId)?.terminal.focus();
        }
    }

    removeTerminal(paneId) {
        const entry = this.terminalMap.get(paneId);
        if (!entry) {
            return;
        }

        this.send(paneId, "__CTRL__:CLOSE");
        entry.terminal.dispose();
        this.terminalMap.delete(paneId);
    }

    updateToolbar(activePaneId) {
        const hasPane = Boolean(activePaneId);
        const canClose = hasPane
            && (this.panelSessions.get(this.activeSessionId)?.paneManager.paneCount || 0) > 1;
        document.getElementById("split-horizontal").disabled = !hasPane;
        document.getElementById("split-vertical").disabled = !hasPane;
        document.getElementById("close-pane").disabled = !canClose;
    }

    restoreTerminalSessions() {
        for (const [sessionId, { terminal }] of this.terminalMap) {
            this.send(sessionId, "__CTRL__:CREATE");
            terminal.fit();
        }
    }

    handleMessage(message) {
        const entry = this.terminalMap.get(message.session_id);
        if (!entry) {
            return;
        }

        if (message.type === "ready") {
            entry.terminal.setPromptToken(message.prompt_token);
        } else if (message.type === "skill_result") {
            entry.terminal.handleSkillResult(message);
        } else if (message.type === "error") {
            entry.terminal.showError(message.message || "The terminal session failed.");
        } else if (typeof message.value === "string") {
            entry.terminal.write(message.value);
        }
    }

    send(sessionId, value) {
        this.transport.send({ session_id: sessionId, value });
    }

    sendResize(sessionId, cols, rows) {
        this.transport.send({ session_id: sessionId, type: "resize", cols, rows });
    }

    sendSkill(sessionId, { skill, action = "read", args = "", ...rest } = {}) {
        this.transport.send({
            session_id: sessionId,
            type: "skill",
            skill,
            action,
            args,
            ...rest
        });
    }

    close() {
        this.transport.close(Array.from(this.terminalMap.keys()));
    }

    dispose() {
        window.removeEventListener("resize", this.onResize);
        window.removeEventListener("beforeunload", this.onUnload);
        window.removeEventListener("pagehide", this.onUnload);
        for (const session of this.panelSessions.values()) {
            session.dispose();
        }
        this.panelSessions.clear();
        this.transport.close(Array.from(this.terminalMap.keys()));
        this.terminalMap.clear();
    }
}

export {
    CommandBlock,
    ConsoleView,
    ConsoleView as TerminalView,
    ConsoleTransport,
    ConsoleTransport as TerminalTransport,
    PaneManager,
    PanelSession
};
