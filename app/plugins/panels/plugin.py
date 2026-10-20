from quart import Quart

from app.plugins.panels.manager import PanelManager
from app.plugins.panels.routes import create_routes
from app.plugins.panels.services import PanelService


class PanelsPlugin:
    name = "panels"

    def register(self, app: Quart) -> None:
        app.register_blueprint(create_routes(PanelManager(), PanelService()))
