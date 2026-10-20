import asyncio
import os
import signal
from collections.abc import Iterable
from pathlib import Path

from quart import Quart

from app.core.interfaces import Plugin
from app.core.logging import LOG_DIR, logger
from app.core.routes import core_routes
from app.extensions import init_extensions
from app.plugins.panels.plugin import PanelsPlugin
from app.plugins.terminal.plugin import TerminalPlugin
from app.plugins.terminal.services import TerminalService
from app.plugins.terminal.storage import (
    clear_sessions,
    create_session,
    delete_session,
    init_db,
    list_sessions,
)


def create_app(plugins: Iterable[Plugin] = ()) -> Quart:
    project_root = Path(__file__).resolve().parent.parent
    application = Quart(__name__, root_path=str(project_root))
    init_extensions(application)

    terminal_manager = application.extensions["terminal_manager"]
    socket_manager = application.extensions["socket_manager"]
    plugin_manager = application.extensions["plugin_manager"]
    terminal_service = TerminalService(
        create_record=lambda session_id: create_session(session_id),
        delete_record=lambda session_id: delete_session(session_id),
        list_records=lambda: list_sessions(),
    )
    plugin_manager.register(
        TerminalPlugin(terminal_manager, socket_manager, terminal_service)
    )
    plugin_manager.register(PanelsPlugin())
    for plugin in plugins:
        plugin_manager.register(plugin)
    application.register_blueprint(core_routes)
    plugin_manager.initialize(application)

    @application.before_serving
    async def startup() -> None:
        init_db()
        clear_sessions()
        logger.info("Shell App started; log files are stored in %s", LOG_DIR)

    @application.after_serving
    async def shutdown() -> None:
        await terminal_manager.close_all()
        clear_sessions()

    return application


app = create_app()
sessions = app.extensions["terminal_manager"].sessions
active_terminal_tasks = app.extensions["socket_manager"].active_tasks


async def run_server(host=None, port=None, application: Quart | None = None) -> None:
    host = host or os.environ.get("SHELL_APP_HOST", "127.0.0.1")
    port = port or int(os.environ.get("SHELL_APP_PORT", "5000"))
    application = application or app
    loop = asyncio.get_running_loop()
    shutdown_event = asyncio.Event()
    socket_manager = application.extensions["socket_manager"]

    def request_shutdown() -> None:
        shutdown_event.set()
        socket_manager.cancel_active_tasks()

    handled_signals = (signal.SIGINT, signal.SIGTERM)
    for handled_signal in handled_signals:
        loop.add_signal_handler(handled_signal, request_shutdown)

    try:
        await application.run_task(
            host=host,
            port=port,
            debug=False,
            shutdown_trigger=shutdown_event.wait,
        )
    finally:
        for handled_signal in handled_signals:
            loop.remove_signal_handler(handled_signal)


__all__ = [
    "active_terminal_tasks",
    "app",
    "clear_sessions",
    "create_app",
    "create_session",
    "delete_session",
    "init_db",
    "list_sessions",
    "run_server",
    "sessions",
]
