from app.core.logging import logger
from app.plugins.console.utils.console import ConsoleSession


class ConsoleManager:
    def __init__(self) -> None:
        self.sessions: dict[str, ConsoleSession] = {}

    def add(self, session_id: str, session: ConsoleSession) -> None:
        self.sessions[session_id] = session

    def get(self, session_id: str) -> ConsoleSession | None:
        return self.sessions.get(session_id)

    def remove(self, session_id: str) -> ConsoleSession | None:
        return self.sessions.pop(session_id, None)

    async def close_all(self) -> None:
        for session_id, session in list(self.sessions.items()):
            try:
                await session.close()
            except Exception:
                logger.exception("Failed to close console session during shutdown")
            finally:
                self.sessions.pop(session_id, None)


TerminalManager = ConsoleManager
