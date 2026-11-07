import os

from app.core.monitoring import positive_number, register_monitoring
from app.plugins.network_manager.control_routes import create_control_routes
from app.plugins.network_manager.controller import NetworkController
from app.plugins.network_manager.manager import NetworkManager, NetworkMonitor
from app.plugins.network_manager.platforms import create_platform_adapter


class NetworkManagerPlugin:
    name = "network_manager"

    def register(self, app):
        def setting(name, default):
            return positive_number(app.config.get(name, os.environ.get(name)), default)

        adapter = app.config.get("SHELL_APP_NETWORK_ADAPTER") or create_platform_adapter()
        controller = NetworkController(
            adapter,
            refresh_interval=setting("SHELL_APP_NETWORK_CONTROL_INTERVAL", 15),
        )
        manager = NetworkManager(
            discovery_interval=setting("SHELL_APP_NETWORK_DISCOVERY_INTERVAL", 5),
            metadata_interval=setting("SHELL_APP_NETWORK_METADATA_INTERVAL", 10),
            controller=controller,
        )
        controller.on_change = manager.request_refresh
        app.extensions["network_controller"] = controller
        service = NetworkMonitor(manager, interval=setting("SHELL_APP_NETWORK_INTERVAL", 2))
        register_monitoring(app, self.name, service, "network-manager")
        app.register_blueprint(create_control_routes(controller))
