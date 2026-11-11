from quart import Quart

from app.core.plugins import PluginManager
from app.core.socket_manager import SocketManager
from app.plugins.console.utils import ConsoleManager


def init_extensions(app: Quart) -> None:
    console_manager = ConsoleManager()
    app.extensions["plugin_manager"] = PluginManager()
    app.extensions["socket_manager"] = SocketManager()
    app.extensions["console_manager"] = console_manager
    app.extensions["terminal_manager"] = console_manager
