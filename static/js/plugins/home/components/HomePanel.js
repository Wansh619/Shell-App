export default class HomePanel {
    constructor(plugins, openPlugin) {
        this.plugins = plugins;
        this.openPlugin = openPlugin;
    }

    render(container) {
        const panel = document.createElement("div");
        panel.className = "home-panel";

        const heading = document.createElement("h1");
        heading.textContent = "Welcome to Shell App";

        const description = document.createElement("p");
        description.textContent = "Choose a workspace to get started.";

        const actions = document.createElement("div");
        actions.className = "home-panel-actions";

        for (const plugin of this.plugins) {
            const button = document.createElement("button");
            button.className = "home-panel-action";
            button.type = "button";
            button.textContent = plugin.name;
            button.addEventListener("click", () => this.openPlugin(plugin));
            actions.append(button);
        }

        panel.append(heading, description, actions);
        container.append(panel);
    }
}
