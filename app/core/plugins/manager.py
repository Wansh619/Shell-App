from quart import Quart

from app.core.plugins.base import Plugin


class PluginManager:
    def __init__(self) -> None:
        self._plugins: dict[str, Plugin] = {}

    def register(self, plugin: Plugin) -> None:
        name = getattr(plugin, "name", "").strip()
        if not name:
            raise ValueError("Plugin names must not be empty.")
        if name in self._plugins:
            raise ValueError(f"Plugin {plugin.name!r} is already registered.")
        if not hasattr(plugin, "version") or not getattr(plugin, "version", None):
            try:
                setattr(plugin, "version", "1.0.0")
            except (AttributeError, TypeError):
                pass
        self._plugins[name] = plugin

    def get_plugin(self, name: str) -> Plugin | None:
        return self._plugins.get(name)

    def initialize(self, app: Quart) -> None:
        for plugin in self._plugins.values():
            plugin.register(app)

    @property
    def plugin_names(self) -> tuple[str, ...]:
        return tuple(self._plugins)

    @property
    def plugins(self) -> tuple[Plugin, ...]:
        return tuple(self._plugins.values())
