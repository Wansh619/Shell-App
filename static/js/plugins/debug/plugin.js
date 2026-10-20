import Plugin from "../plugin.js";

export default class DebugPlugin extends Plugin {
    constructor() {
        super("Debug", "bug.svg");
        this.component = null;
    }

    async start({ overlay }) {
        const { default: DebugLogViewer } = await import(
            "./components/DebugLogViewer.js?v=debug-plugin-components-1"
        );
        this.component = new DebugLogViewer();
        this.component.start(overlay);
    }

    async stop() {
        this.component?.stop();
        this.component = null;
    }
}
