import openSkillPlugin, { renderFallbackOpenPanel } from "./open/plugin.js";
import imageSkillPlugin, { renderFallbackImagePanel } from "./image/plugin.js";

export class SkillRegistry {
    constructor(skills = []) {
        this._skills = new Map();
        for (const skill of skills) {
            this.register(skill);
        }
    }

    register(skillPlugin) {
        if (!skillPlugin || typeof skillPlugin !== "object") {
            throw new Error("Skill plugin must be an object.");
        }
        const name = String(skillPlugin.name ?? "").trim().toLowerCase();
        const panelState = String(skillPlugin.panelState ?? "").trim();
        if (!name) {
            throw new Error("Skill plugin must have a non-empty name.");
        }
        if (!panelState) {
            throw new Error(`Skill plugin "${name}" must specify a panelState.`);
        }

        const normalized = {
            name,
            panelState,
            label: skillPlugin.label || name,
            placeholder:
                skillPlugin.placeholder
                || `Enter arguments for ${name} (e.g. ${name} path/to/file)`,
            parseArgs:
                typeof skillPlugin.parseArgs === "function"
                    ? (rawInput) => skillPlugin.parseArgs(rawInput)
                    : (rawInput) => String(rawInput ?? "").trim(),
            renderPanel:
                typeof skillPlugin.renderPanel === "function"
                    ? (container, model, context) =>
                        skillPlugin.renderPanel(container, model, context)
                    : (container, model, context) =>
                        this._renderDefaultFallback(panelState, container, model, context)
        };

        this._skills.set(name, normalized);
        return normalized;
    }

    _renderDefaultFallback(panelState, container, model, context) {
        if (panelState === "editor panel") {
            return renderFallbackOpenPanel(container, model, context);
        }
        if (panelState === "image panel") {
            return renderFallbackImagePanel(container, model, context);
        }
        const wrapper = document.createElement("div");
        wrapper.className = "console-skill-fallback";
        wrapper.textContent = typeof model === "string" ? model : JSON.stringify(model ?? {});
        container.replaceChildren(wrapper);
        return {
            dispose() {
                container.replaceChildren();
            }
        };
    }

    get(name) {
        if (!name) {
            return null;
        }
        return this._skills.get(String(name).trim().toLowerCase()) || null;
    }

    getByPanelState(panelState) {
        if (!panelState) {
            return null;
        }
        const normalizedState = String(panelState).trim();
        for (const skill of this._skills.values()) {
            if (skill.panelState === normalizedState) {
                return skill;
            }
        }
        return null;
    }

    list() {
        return Array.from(this._skills.values());
    }

    parseSkillInput(inputValue, selectedSkill = null) {
        const raw = String(inputValue ?? "").trim();
        if (!raw) {
            return null;
        }

        const tokenMatch = raw.match(/^(\S+)(?:\s+([\s\S]*))?$/);
        if (tokenMatch) {
            const explicitSkill = this.get(tokenMatch[1]);
            if (explicitSkill) {
                const rawArgs = (tokenMatch[2] ?? "").trim();
                const args = explicitSkill.parseArgs(rawArgs);
                return {
                    skill: explicitSkill.name,
                    panelState: explicitSkill.panelState,
                    args,
                    plugin: explicitSkill
                };
            }
        }

        const fallbackSkill = this.get(selectedSkill);
        if (fallbackSkill) {
            const args = fallbackSkill.parseArgs(raw);
            return {
                skill: fallbackSkill.name,
                panelState: fallbackSkill.panelState,
                args,
                plugin: fallbackSkill
            };
        }

        return null;
    }
}

export function createDefaultSkillRegistry() {
    return new SkillRegistry([openSkillPlugin, imageSkillPlugin]);
}

export default SkillRegistry;
