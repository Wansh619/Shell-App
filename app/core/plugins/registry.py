from collections.abc import Iterable

from quart import Quart

from app.core.plugins.base import Plugin
from app.core.plugins.manager import PluginManager


def register_plugins(
    plugin_manager: PluginManager, plugins: Iterable[Plugin] = ()
) -> None:
    for plugin in plugins:
        plugin_manager.register(plugin)


def initialize_plugins(
    app: Quart,
    plugins: Iterable[Plugin] = (),
    builtin_plugins: Iterable[Plugin] = (),
) -> PluginManager:
    plugin_manager = app.extensions.get("plugin_manager")
    if not isinstance(plugin_manager, PluginManager):
        plugin_manager = PluginManager()
        app.extensions["plugin_manager"] = plugin_manager

    register_plugins(plugin_manager, builtin_plugins)
    register_plugins(plugin_manager, plugins)
    plugin_manager.initialize(app)
    return plugin_manager
