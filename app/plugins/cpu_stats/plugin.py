"""Application registration for the CPU statistics plugin."""

from dataclasses import dataclass
import os

from app.core.monitoring import register_monitoring
from app.core.plugins import Plugin
from app.plugins.cpu_stats.utils import SystemMonitor, positive_number


@dataclass
class CPUStatsPlugin(Plugin):
    name: str = "cpu_stats"
    version: str = "1.0.0"

    def register(self, app):
        service = SystemMonitor(
            interval=positive_number(
                app.config.get("SHELL_APP_CPU_INTERVAL", os.getenv("SHELL_APP_CPU_INTERVAL")),
                1.0,
            ),
            process_interval=positive_number(
                app.config.get(
                    "SHELL_APP_CPU_PROCESS_INTERVAL", os.getenv("SHELL_APP_CPU_PROCESS_INTERVAL")
                ),
                5.0,
            ),
        )
        register_monitoring(app, self.name, service, "cpu-stats")
