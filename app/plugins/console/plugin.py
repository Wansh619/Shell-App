from dataclasses import dataclass

from quart import Quart

from app.core.plugins import Plugin
from app.core.socket_manager import SocketManager
from app.plugins.console.skills import SkillRegistry, create_default_skill_registry
from app.plugins.console.utils import (
    ConsoleManager,
    ConsoleService,
    create_routes,
    create_session,
    create_sockets,
    delete_session,
    list_sessions,
)


@dataclass(init=False)
class ConsolePlugin(Plugin):
    name: str = "console"
    version: str = "1.0.0"
    console_manager: ConsoleManager | None = None
    socket_manager: SocketManager | None = None
    service: ConsoleService | None = None
    skill_registry: SkillRegistry | None = None

    def __init__(
        self,
        console_manager: ConsoleManager | str | None = None,
        socket_manager: SocketManager | str | None = None,
        service: ConsoleService | None = None,
        skill_registry: SkillRegistry | None = None,
        *,
        name: str = "console",
        version: str = "1.0.0",
    ) -> None:
        if isinstance(console_manager, str):
            name = console_manager
            console_manager = None
        if isinstance(socket_manager, str):
            version = socket_manager
            socket_manager = None
        super().__init__(name=name, version=version)
        self.console_manager = console_manager
        self.socket_manager = socket_manager
        self.service = service
        self.skill_registry = skill_registry

    @property
    def terminal_manager(self) -> ConsoleManager | None:
        return self.console_manager

    @terminal_manager.setter
    def terminal_manager(self, value: ConsoleManager | None) -> None:
        self.console_manager = value

    def register(self, app: Quart | None = None) -> None:
        if app is None:
            return
        console_manager = (
            self.console_manager
            or app.extensions.get("console_manager")
            or app.extensions.get("terminal_manager")
            or ConsoleManager()
        )
        socket_manager = (
            self.socket_manager
            or app.extensions.get("socket_manager")
            or SocketManager()
        )
        service = self.service or ConsoleService(
            create_record=lambda session_id: create_session(session_id),
            delete_record=lambda session_id: delete_session(session_id),
            list_records=lambda: list_sessions(),
        )
        skill_registry = self.skill_registry or create_default_skill_registry()
        app.register_blueprint(create_routes(service, skill_registry, console_manager))
        app.register_blueprint(
            create_sockets(
                console_manager,
                socket_manager,
                service,
                skill_registry,
            )
        )


TerminalPlugin = ConsolePlugin
