from quart import Quart

from app.plugins.terminal.manager import TerminalManager
from app.plugins.terminal.routes import create_routes
from app.plugins.terminal.services import TerminalService
from app.plugins.terminal.sockets import create_sockets
from app.core.socket_manager import SocketManager


class TerminalPlugin:
    name = "terminal"

    def __init__(
        self,
        terminal_manager: TerminalManager,
        socket_manager: SocketManager,
        service: TerminalService,
    ) -> None:
        self._terminal_manager = terminal_manager
        self._socket_manager = socket_manager
        self._service = service

    def register(self, app: Quart) -> None:
        app.register_blueprint(create_routes(self._service))
        app.register_blueprint(
            create_sockets(
                self._terminal_manager,
                self._socket_manager,
                self._service,
            )
        )
