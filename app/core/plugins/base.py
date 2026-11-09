from dataclasses import dataclass

from quart import Quart


@dataclass
class Plugin:
    name: str = ""
    version: str = "1.0.0"

    def register(self, app: Quart | None = None) -> None:
        """Register this plugin's routes and services with the application."""
        pass
