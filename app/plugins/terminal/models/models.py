from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class TerminalMessage:
    session_id: str = ""
    type: str | None = None
    value: str | None = None
    cols: int | None = None
    rows: int | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TerminalMessage":
        raw_session_id = data.get("session_id")
        session_id = raw_session_id if isinstance(raw_session_id, str) else ""
        return cls(
            session_id=session_id,
            type=data.get("type"),
            value=data.get("value"),
            cols=data.get("cols"),
            rows=data.get("rows"),
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
class TerminalOutputPayload:
    session_id: str
    value: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass
class TerminalReadyPayload:
    session_id: str
    prompt_token: str
    type: str = "ready"

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass
class TerminalErrorPayload:
    session_id: str
    message: str = "Unable to start terminal session."
    type: str = "error"

    def to_dict(self) -> dict[str, str]:
        return asdict(self)
