from typing import TypedDict


class TerminalMessage(TypedDict, total=False):
    session_id: str
    type: str
    value: str
    cols: int
    rows: int


class SessionResponse(TypedDict):
    session_id: str
    created_at: str
    status: str
