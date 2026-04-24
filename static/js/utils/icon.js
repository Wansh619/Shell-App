class Icon {
    /**
     * @param {string} iconPath Path under /static/images/...
     * @param {{
     *  className?: string,
     *  svgClassName?: string,
     *  attrs?: Record<string, string>,
     *  style?: Partial<CSSStyleDeclaration>,
     *  size?: number,
     * }} [options]
     */
    constructor(iconPath, options = {}) {
        this.iconPath = iconPath;
        this.options = options;
    }

    async _fetchSvgText() {
        const res = await fetch(this.iconPath);
        if (!res.ok) {
            throw new Error(`Failed to load icon: ${this.iconPath}`);
        }
        return await res.text();
    }

    /**
     * Returns a wrapper <span> containing the inline <svg>.
     */
    async buildElement() {
        const svgText = await this._fetchSvgText();
        const wrapper = document.createElement("span");
        wrapper.className = this.options.className || "icon-wrapper";

        // Parse SVG into DOM
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, "image/svg+xml");
        const svg = doc.querySelector("svg");
        if (!svg) {
            throw new Error(`Invalid SVG: ${this.iconPath}`);
        }

        if (this.options.svgClassName) {
            svg.classList.add(...this.options.svgClassName.split(/\s+/).filter(Boolean));
        }

        // Ensure size + themeability through currentColor
        const size = this.options.size || 24;
        svg.setAttribute("width", String(size));
        svg.setAttribute("height", String(size));

        // Prefer currentColor where possible (won't override explicit fills inside SVG)
        svg.style.color = "currentColor";

        if (this.options.attrs) {
            Object.entries(this.options.attrs).forEach(([k, v]) => svg.setAttribute(k, v));
        }
        if (this.options.style) {
            Object.assign(svg.style, this.options.style);
        }

        wrapper.appendChild(document.importNode(svg, true));
        return wrapper;
    }

    async render(container) {
        const el = await this.buildElement();
        container.innerHTML = "";
        container.appendChild(el);
        return container;
    }
}

export default Icon;