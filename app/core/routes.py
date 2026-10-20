from quart import Blueprint, current_app, jsonify


core_routes = Blueprint("core", __name__)


@core_routes.get("/health")
async def health():
    return jsonify({"status": "ok"}), 200


@core_routes.get("/internal/plugins")
async def registered_plugins():
    plugin_manager = current_app.extensions["plugin_manager"]
    return jsonify({"plugins": plugin_manager.plugin_names}), 200
