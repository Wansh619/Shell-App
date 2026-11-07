"""Application registration for the CPU statistics plugin."""

import os

from app.core.monitoring import positive_number, register_monitoring

from .monitor import SystemMonitor


class CPUStatsPlugin:
    name = "cpu_stats"

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
