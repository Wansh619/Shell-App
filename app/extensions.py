from quart import Quart

from app.core.plugins import PluginManager
from app.core.socket_manager import SocketManager
from app.plugins.terminal.utils import TerminalManager


def init_extensions(app: Quart) -> None:
    app.extensions["plugin_manager"] = PluginManager()
    app.extensions["socket_manager"] = SocketManager()
    app.extensions["terminal_manager"] = TerminalManager()
