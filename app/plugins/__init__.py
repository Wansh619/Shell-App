"""Built-in application plugins."""

from app.plugins.cpu_stats.plugin import CPUStatsPlugin
from app.plugins.network_manager.plugin import NetworkManagerPlugin
from app.plugins.panels.plugin import PanelsPlugin
from app.plugins.terminal.plugin import TerminalPlugin

__all__ = [
    "CPUStatsPlugin",
    "NetworkManagerPlugin",
    "PanelsPlugin",
    "TerminalPlugin",
]
