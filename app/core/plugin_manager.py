from app.core.interfaces import Plugin
from quart import Quart


class PluginManager:
    def __init__(self) -> None:
        self._plugins: dict[str, Plugin] = {}

    def register(self, plugin: Plugin) -> None:
        if not plugin.name.strip():
            raise ValueError("Plugin names must not be empty.")
        if plugin.name in self._plugins:
            raise ValueError(f"Plugin {plugin.name!r} is already registered.")
        self._plugins[plugin.name] = plugin

    def initialize(self, app: Quart) -> None:
        for plugin in self._plugins.values():
            plugin.register(app)

    @property
    def plugin_names(self) -> tuple[str, ...]:
        return tuple(self._plugins)
