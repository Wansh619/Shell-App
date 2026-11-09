from dataclasses import dataclass

from quart import Quart

from app.core.plugins import Plugin
from app.core.socket_manager import SocketManager
from app.plugins.terminal.utils import (
    TerminalManager,
    TerminalService,
    create_routes,
    create_session,
    create_sockets,
    delete_session,
    list_sessions,
)


@dataclass(init=False)
class TerminalPlugin(Plugin):
    name: str = "terminal"
    version: str = "1.0.0"
    terminal_manager: TerminalManager | None = None
    socket_manager: SocketManager | None = None
    service: TerminalService | None = None

    def __init__(
        self,
        terminal_manager: TerminalManager | str | None = None,
        socket_manager: SocketManager | str | None = None,
        service: TerminalService | None = None,
        *,
        name: str = "terminal",
        version: str = "1.0.0",
    ) -> None:
        if isinstance(terminal_manager, str):
            name = terminal_manager
            terminal_manager = None
        if isinstance(socket_manager, str):
            version = socket_manager
            socket_manager = None
        super().__init__(name=name, version=version)
        self.terminal_manager = terminal_manager
        self.socket_manager = socket_manager
        self.service = service

    def register(self, app: Quart | None = None) -> None:
        if app is None:
            return
        terminal_manager = (
            self.terminal_manager
            or app.extensions.get("terminal_manager")
            or TerminalManager()
        )
        socket_manager = (
            self.socket_manager
            or app.extensions.get("socket_manager")
            or SocketManager()
        )
        service = self.service or TerminalService(
            create_record=lambda session_id: create_session(session_id),
            delete_record=lambda session_id: delete_session(session_id),
            list_records=lambda: list_sessions(),
        )
        app.register_blueprint(create_routes(service))
        app.register_blueprint(
            create_sockets(
                terminal_manager,
                socket_manager,
                service,
            )
        )
