from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class ConsoleMessage:
    session_id: str = ""
    type: str | None = None
    value: str | None = None
    cols: int | None = None
    rows: int | None = None
    skill: str | None = None
    action: str | None = None
    args: str | None = None
    content: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ConsoleMessage":
        raw_session_id = data.get("session_id")
        session_id = raw_session_id if isinstance(raw_session_id, str) else ""
        return cls(
            session_id=session_id,
            type=data.get("type"),
            value=data.get("value"),
            cols=data.get("cols"),
            rows=data.get("rows"),
            skill=data.get("skill"),
            action=data.get("action"),
            args=data.get("args"),
            content=data.get("content"),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SessionResponse:
    session_id: str
    created_at: str
    status: str = "active"

    def to_dict(self) -> dict[str, str]:
        return asdict(self)

    def __getitem__(self, key: str) -> Any:
        return self.to_dict()[key]

    def keys(self):
        return self.to_dict().keys()

    def get(self, key: str, default: Any = None) -> Any:
        return self.to_dict().get(key, default)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, SessionResponse):
            return (
                self.session_id == other.session_id
                and self.created_at == other.created_at
                and self.status == other.status
            )
        if isinstance(other, dict):
            return self.to_dict() == other
        return NotImplemented


@dataclass
class ConsoleOutputPayload:
    session_id: str
    value: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass
class ConsoleReadyPayload:
    session_id: str
    prompt_token: str
    type: str = "ready"

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass
class ConsoleErrorPayload:
    session_id: str
    message: str = "Unable to start terminal session."
    type: str = "error"

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass
class SkillPayload:
    session_id: str
    skill: str
    action: str = "read"
    args: str = ""
    content: str | None = None
    type: str = "skill"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SkillPayload":
        return cls(
            session_id=str(data.get("session_id") or "").strip(),
            skill=str(data.get("skill") or "").strip(),
            action=str(data.get("action") or "read").strip(),
            args=str(data.get("args") or ""),
            content=data.get("content") if isinstance(data.get("content"), str) else None,
            type=str(data.get("type") or "skill"),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SkillResultPayload:
    session_id: str
    skill: str
    panel_state: str
    status: str = "ok"
    data: dict[str, Any] = field(default_factory=dict)
    message: str = ""
    type: str = "skill_result"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EditorViewModel:
    filepath: str
    filename: str
    content: str
    encoding: str = "utf-8"
    writable: bool = True
    exists: bool = True
    line_count: int = 1
    panel_state: str = "editor panel"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ImageViewModel:
    filepath: str
    filename: str
    mime_type: str
    size_bytes: int
    data_url: str
    raw_url: str = ""
    width: int | None = None
    height: int | None = None
    panel_state: str = "image panel"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


TerminalMessage = ConsoleMessage
TerminalOutputPayload = ConsoleOutputPayload
TerminalReadyPayload = ConsoleReadyPayload
TerminalErrorPayload = ConsoleErrorPayload
