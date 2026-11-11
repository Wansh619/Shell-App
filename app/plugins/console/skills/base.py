from __future__ import annotations

from dataclasses import dataclass

from app.plugins.console.models.models import SkillResultPayload


@dataclass
class Skill:
    name: str = ""
    panel_state: str = "terminal"
    description: str = ""

    async def execute(
        self,
        session_id: str,
        args: str = "",
        action: str = "read",
        content: str | None = None,
        cwd: str | None = None,
    ) -> SkillResultPayload:
        raise NotImplementedError(f"Skill '{self.name}' must implement execute().")


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, Skill] = {}

    def register(self, skill: Skill) -> None:
        normalized = (skill.name or "").strip().lower()
        if not normalized:
            raise ValueError("Skill name must not be empty.")
        self._skills[normalized] = skill

    def get(self, name: str) -> Skill | None:
        normalized = (name or "").strip().lower()
        return self._skills.get(normalized)

    def list_skills(self) -> list[dict[str, str]]:
        return [
            {
                "name": skill.name,
                "panel_state": skill.panel_state,
                "description": skill.description,
            }
            for skill in self._skills.values()
        ]

    async def execute(
        self,
        skill_name: str,
        session_id: str,
        args: str = "",
        action: str = "read",
        content: str | None = None,
        cwd: str | None = None,
    ) -> SkillResultPayload:
        normalized = (skill_name or "").strip().lower()
        skill = self._skills.get(normalized)
        if skill is None:
            return SkillResultPayload(
                session_id=session_id,
                skill=skill_name,
                panel_state="terminal",
                status="error",
                message=f"Unknown skill: {skill_name}",
            )
        return await skill.execute(
            session_id=session_id,
            args=args,
            action=action,
            content=content,
            cwd=cwd,
        )
