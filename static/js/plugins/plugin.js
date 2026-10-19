export default class Plugin {
    constructor(name, icon) {
        if (!name || !icon) {
            throw new Error("Plugins require a name and an icon.");
        }
        this.name = name;
        this.icon = icon;
    }

    async start() {
        throw new Error(`${this.name} must implement start().`);
    }

    async stop() {}
}
