"""Built-in application plugins."""

from app.plugins.console.plugin import ConsolePlugin, TerminalPlugin
from app.plugins.cpu_stats.plugin import CPUStatsPlugin
from app.plugins.network_manager.plugin import NetworkManagerPlugin
from app.plugins.panels.plugin import PanelsPlugin

__all__ = [
    "CPUStatsPlugin",
    "ConsolePlugin",
    "NetworkManagerPlugin",
    "PanelsPlugin",
    "TerminalPlugin",
]
