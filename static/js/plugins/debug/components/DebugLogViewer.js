export default class DebugLogViewer {
    constructor() {
        this.intervalId = null;
        this.controller = null;
        this.stopped = false;
        this.polling = false;
        this.hasOutput = false;
        this.requestToken = 0;
        this.offset = 0;
        this.generation = "";
    }

    start(container) {
        const panel = document.createElement("div");
        panel.className = "debug-panel";

        const toolbar = document.createElement("div");
        toolbar.className = "debug-toolbar";

        const label = document.createElement("label");
        label.htmlFor = "debug-log-file";
        label.textContent = "Log file";

        this.select = document.createElement("select");
        this.select.id = "debug-log-file";
        this.select.className = "debug-log-select";
        for (const [value, text] of [
            ["debug", "Debug (all levels)"],
            ["warning", "Warning"],
            ["error", "Error"],
        ]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = text;
            this.select.append(option);
        }

        this.status = document.createElement("span");
        this.status.className = "debug-log-status";
        this.status.setAttribute("role", "status");
        this.status.textContent = "Connecting...";

        this.output = document.createElement("pre");
        this.output.className = "debug-log-output";
        this.output.setAttribute("role", "log");
        this.output.setAttribute("aria-label", "Live application logs");
        this.output.textContent = "Waiting for log entries...";

        toolbar.append(label, this.select, this.status);
        panel.append(toolbar, this.output);
        container.append(panel);

        this.select.addEventListener("change", () => this._changeLog());
        this.intervalId = window.setInterval(() => this._poll(), 1000);
        this._poll();
    }

    async _poll() {
        if (this.stopped || this.polling) return;
        this.polling = true;
        const token = ++this.requestToken;
        const selectedLog = this.select.value;
        this.controller = new AbortController();
        const query = new URLSearchParams({
            offset: String(this.offset),
            generation: this.generation,
        });

        try {
            const response = await fetch(
                `/logs/${encodeURIComponent(selectedLog)}?${query}`,
                { signal: this.controller.signal }
            );
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || "Unable to read log file.");
            }
            if (this.stopped || token !== this.requestToken) return;

            if (result.reset) {
                this.offset = 0;
                this.output.textContent = "";
                this.hasOutput = false;
            }
            this.generation = result.generation;
            this.offset = result.offset;

            if (result.content) {
                const current = this.hasOutput ? this.output.textContent : "";
                const lines = `${current}${result.content}`.split("\n");
                this.output.textContent = lines.slice(-2000).join("\n");
                this.hasOutput = true;
                this.output.scrollTop = this.output.scrollHeight;
            } else if (!this.hasOutput) {
                this.output.textContent = "No log entries yet.";
            }

            this.status.textContent = `Live · ${selectedLog}.log`;
        } catch (error) {
            if (error.name !== "AbortError" && !this.stopped && token === this.requestToken) {
                this.status.textContent = `Log stream error: ${error.message}`;
            }
        } finally {
            if (token === this.requestToken) {
                this.polling = false;
                this.controller = null;
            }
        }
    }

    _changeLog() {
        this.requestToken++;
        this.controller?.abort();
        this.polling = false;
        this.controller = null;
        this.offset = 0;
        this.generation = "";
        this.hasOutput = false;
        this.output.textContent = "Loading log entries...";
        this._poll();
    }

    stop() {
        this.stopped = true;
        window.clearInterval(this.intervalId);
        this.controller?.abort();
    }
}
