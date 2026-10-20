from quart import Blueprint, jsonify, request

from app.core.logging import logger
from app.plugins.panels.manager import PanelManager
from app.plugins.panels.services import PanelService


def create_routes(panel_manager: PanelManager, service: PanelService) -> Blueprint:
    routes = Blueprint("panels", __name__)

    @routes.get("/")
    async def index():
        return await panel_manager.render("home")

    @routes.get("/console")
    async def console():
        return await panel_manager.render("console")

    @routes.get("/logs/<log_type>")
    async def get_log_updates(log_type: str):
        if not service.has_log(log_type):
            return jsonify({"error": "Unknown log file."}), 404

        try:
            offset = int(request.args.get("offset", "0"))
            if offset < 0:
                raise ValueError
        except ValueError:
            return jsonify({"error": "Invalid log offset."}), 400

        generation = request.args.get("generation", "")
        try:
            return jsonify(service.read_log(log_type, offset, generation)), 200
        except KeyError:
            return jsonify({"error": "Unknown log file."}), 404
        except OSError:
            logger.exception("Failed to read application log file")
            return jsonify({"error": "Unable to read application log file."}), 500

    return routes
