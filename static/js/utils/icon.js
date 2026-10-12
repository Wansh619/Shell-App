class Icon {
    /**
     * @param {string} iconPath
     * @param {{
     *  className?: string,
     *  svgClassName?: string,
     *  size?: number,
     * }} [options]
     */
    constructor(iconPath, options = {}) {
        this.iconPath = iconPath;
        this.options = options;
    }

    static svgCache = new Map();

    async _fetchSvgText() {
        if (Icon.svgCache.has(this.iconPath)) {
            return Icon.svgCache.get(this.iconPath);
        }

        const res = await fetch(this.iconPath);
        if (!res.ok) {
            throw new Error(`Failed to load icon: ${this.iconPath}`);
        }

        const text = await res.text();
        Icon.svgCache.set(this.iconPath, text);
        return text;
    }

    // 🔥 Apply styles DIRECTLY to children
    _processSvg(svg) {
        const { fill, stroke } = this.options;

        const elements = svg.querySelectorAll("*");

        elements.forEach(el => {
            // ❌ remove inline attributes
            el.removeAttribute("fill");
            el.removeAttribute("stroke");
        });

        return svg;
    }

    async buildElement() {
        const svgText = await this._fetchSvgText();

        const wrapper = document.createElement("span");
        wrapper.className = this.options.className || "icon-wrapper";

        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, "image/svg+xml");
        let svg = doc.querySelector("svg");

        if (!svg) {
            throw new Error(`Invalid SVG: ${this.iconPath}`);
        }

        // SVG classes
        if (this.options.svgClassName) {
            svg.classList.add(
                ...this.options.svgClassName.split(/\s+/).filter(Boolean)
            );
        }

        // Size(
        const size = this.options.size || 24;
        svg.setAttribute("width", size);
        svg.setAttribute("height", size);

        // 🔥 Apply child-level styles
        svg.removeAttribute('fill')
        svg.removeAttribute('stroke')
        svg = this._processSvg(svg);

        // Extra attributes
        if (this.options.attrs) {
            Object.entries(this.options.attrs).forEach(([k, v]) =>
                svg.setAttribute(k, v)
            );
        }

        // Extra styles (applies to SVG root only)
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