import Plugin from "../plugin.js";

export default class ConsolePlugin extends Plugin {
    constructor() {
        super("Console", "console.svg");
        this.component = null;
    }

    async start({ overlay }) {
        const { default: ConsolePanel } = await import(
            "./components/ConsolePanel.js?v=console-plugin-components-1"
        );
        this.component = new ConsolePanel();
        this.component.start(overlay);
    }

    async stop() {
        this.component?.stop();
        this.component = null;
    }
}
