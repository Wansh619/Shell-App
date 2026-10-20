from collections.abc import Callable

from app.plugins.terminal.models import SessionResponse


class TerminalService:
    def __init__(
        self,
        create_record: Callable[[str], None],
        delete_record: Callable[[str], None],
        list_records: Callable[[], list[tuple[str, str, str]]],
    ) -> None:
        self._create_record = create_record
        self._delete_record = delete_record
        self._list_records = list_records

    def create_record(self, session_id: str) -> None:
        self._create_record(session_id)

    def delete_record(self, session_id: str) -> None:
        self._delete_record(session_id)

    def list_sessions(self) -> list[SessionResponse]:
        return [
            {"session_id": row[0], "created_at": row[1], "status": row[2]}
            for row in self._list_records()
        ]
