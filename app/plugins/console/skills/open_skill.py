from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .base import Skill
from .models import EditorViewModel, SkillResultPayload


def _strip_quotes(value: str) -> str:
    cleaned = (value or "").strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in ("'", '"'):
        return cleaned[1:-1].strip()
    return cleaned


@dataclass
class OpenSkill(Skill):
    name: str = "open"
    panel_state: str = "editor panel"
    description: str = "Open and edit text files in the console editor panel."

    async def execute(
        self,
        session_id: str,
        args: str = "",
        action: str = "read",
        content: str | None = None,
        cwd: str | None = None,
    ) -> SkillResultPayload:
        raw_path = _strip_quotes(args)
        if not raw_path:
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state="terminal",
                status="error",
                message="File path is required for the open skill.",
            )

        try:
            expanded = Path(raw_path).expanduser()
            if not expanded.is_absolute():
                base_dir = Path(cwd) if cwd else Path(os.getcwd())
                expanded = base_dir / expanded
            target = expanded.resolve()
        except (OSError, RuntimeError) as error:
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state="terminal",
                status="error",
                message=f"Invalid file path: {error}",
            )

        if target.exists() and target.is_dir():
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state="terminal",
                status="error",
                message=f"Cannot open directory: {target}",
            )

        normalized_action = (action or "read").strip().lower()

        if normalized_action == "read":
            if target.exists():
                try:
                    raw_bytes = target.read_bytes()
                except OSError as error:
                    return SkillResultPayload(
                        session_id=session_id,
                        skill=self.name,
                        panel_state="terminal",
                        status="error",
                        message=f"Unable to read file {target.name}: {error}",
                    )

                if b"\x00" in raw_bytes[:8192]:
                    return SkillResultPayload(
                        session_id=session_id,
                        skill=self.name,
                        panel_state="terminal",
                        status="error",
                        message=f"Cannot open binary file: {target.name}",
                    )

                try:
                    text_content = raw_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    return SkillResultPayload(
                        session_id=session_id,
                        skill=self.name,
                        panel_state="terminal",
                        status="error",
                        message=f"Cannot open binary or non-UTF-8 file: {target.name}",
                    )

                writable = os.access(target, os.W_OK)
                view_model = EditorViewModel(
                    filepath=str(target),
                    filename=target.name,
                    content=text_content,
                    encoding="utf-8",
                    writable=writable,
                    exists=True,
                    line_count=max(1, text_content.count("\n") + 1),
                    panel_state=self.panel_state,
                )
            else:
                writable = (
                    os.access(target.parent, os.W_OK)
                    if target.parent.exists()
                    else True
                )
                view_model = EditorViewModel(
                    filepath=str(target),
                    filename=target.name,
                    content="",
                    encoding="utf-8",
                    writable=writable,
                    exists=False,
                    line_count=1,
                    panel_state=self.panel_state,
                )

            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state=self.panel_state,
                status="ok",
                data={**view_model.to_dict(), "action": "read"},
                message=f"Opened {target.name}",
            )

        if normalized_action == "write":
            text_content = content if content is not None else ""
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text_content, encoding="utf-8")
            except OSError as error:
                return SkillResultPayload(
                    session_id=session_id,
                    skill=self.name,
                    panel_state=self.panel_state,
                    status="error",
                    message=f"Unable to write file {target.name}: {error}",
                )

            view_model = EditorViewModel(
                filepath=str(target),
                filename=target.name,
                content=text_content,
                encoding="utf-8",
                writable=os.access(target, os.W_OK),
                exists=True,
                line_count=max(1, text_content.count("\n") + 1),
                panel_state=self.panel_state,
            )
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state=self.panel_state,
                status="ok",
                data={**view_model.to_dict(), "action": "write"},
                message=f"Saved {target.name}",
            )

        return SkillResultPayload(
            session_id=session_id,
            skill=self.name,
            panel_state="terminal",
            status="error",
            message=f"Unsupported action for open skill: {action}",
        )
