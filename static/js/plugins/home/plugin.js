import Plugin from "../plugin.js";
import HomePanel from "./components/HomePanel.js";

export default class HomePlugin extends Plugin {
    constructor() {
        super("Home", "home.svg");
    }

    async start({ overlay, plugins, openPlugin }) {
        const panel = new HomePanel(
            plugins.filter((plugin) => plugin !== this),
            openPlugin
        );
        panel.render(overlay);
    }
}
