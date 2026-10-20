from app.core.logging import logger
from app.plugins.terminal.terminal import TerminalSession


class TerminalManager:
    def __init__(self) -> None:
        self.sessions: dict[str, TerminalSession] = {}

    def add(self, session_id: str, session: TerminalSession) -> None:
        self.sessions[session_id] = session

    def get(self, session_id: str) -> TerminalSession | None:
        return self.sessions.get(session_id)

    def remove(self, session_id: str) -> TerminalSession | None:
        return self.sessions.pop(session_id, None)

    async def close_all(self) -> None:
        for session_id, session in list(self.sessions.items()):
            try:
                await session.close()
            except Exception:
                logger.exception("Failed to close terminal session during shutdown")
            finally:
                self.sessions.pop(session_id, None)
