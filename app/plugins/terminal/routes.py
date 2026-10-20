from quart import Blueprint, jsonify

from app.plugins.terminal.services import TerminalService


def create_routes(service: TerminalService) -> Blueprint:
    routes = Blueprint("terminal_routes", __name__)

    @routes.get("/sessions")
    async def get_sessions():
        try:
            return jsonify(service.list_sessions()), 200
        except Exception as error:
            return jsonify({"error": f"Failed to fetch sessions: {error}"}), 500

    return routes
