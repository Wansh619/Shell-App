from typing import Protocol

from quart import Quart


class Plugin(Protocol):
    name: str

    def register(self, app: Quart) -> None:
        """Register this plugin's routes and services with the application."""
