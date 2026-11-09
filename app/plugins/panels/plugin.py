from dataclasses import dataclass

from quart import Quart

from app.core.plugins import Plugin
from app.plugins.panels.utils import PanelManager, PanelService, create_routes


@dataclass
class PanelsPlugin(Plugin):
    name: str = "panels"
    version: str = "1.0.0"

    def register(self, app: Quart) -> None:
        app.register_blueprint(create_routes(PanelManager(), PanelService()))
