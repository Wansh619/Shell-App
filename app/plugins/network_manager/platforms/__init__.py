"""Lazy platform selection; importing the app never loads foreign native APIs."""

import platform

from .base import NetworkOperationError, NetworkPlatformAdapter
from .common import empty_inventory, passive_interfaces


class UnsupportedPlatformAdapter(NetworkPlatformAdapter):
    def __init__(self, system="unsupported"):
        self.platform = system.lower()

    async def inventory(self):
        result = empty_inventory()
        result["interfaces"] = passive_interfaces()
        return result

    async def execute(self, action, params):
        raise NetworkOperationError("unsupported", "Network controls are unavailable on this platform.")


def create_platform_adapter(system=None, **kwargs):
    system = system or platform.system()
    if system == "Linux":
        from .linux import LinuxPlatformAdapter
        return LinuxPlatformAdapter(**kwargs)
    if system == "Darwin":
        from .macos import MacOSPlatformAdapter
        return MacOSPlatformAdapter(**kwargs)
    if system == "Windows":
        from .windows import WindowsPlatformAdapter
        return WindowsPlatformAdapter(**kwargs)
    return UnsupportedPlatformAdapter(system)


__all__ = ["create_platform_adapter", "NetworkOperationError", "NetworkPlatformAdapter"]
