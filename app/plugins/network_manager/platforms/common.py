"""Shared, bounded native boundaries. No discovery or commands at import time."""

import asyncio
import copy
import inspect
import json
import subprocess

from .base import ACTIONS, NetworkOperationError, NetworkPlatformAdapter


def to_builtin(value):
    """Convert Objective-C/native proxy types into plain Python containers."""
    if value is None or type(value) in (bool, int, float, str):
        return value
    if isinstance(value, str):
        return str(value)
    if isinstance(value, bool):
        return bool(value)
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value)
    if isinstance(value, dict) or hasattr(value, "keys"):
        return {str(k): to_builtin(value[k]) for k in value.keys()}
    if isinstance(value, (list, tuple, set)) or hasattr(value, "__iter__"):
        return [to_builtin(item) for item in value]
    return str(value)
def empty_inventory():
    return {"interfaces": [], "wifi_networks": [], "bluetooth_devices": [], "details": {}}


def passive_interfaces():
    import psutil

    return [
        {"name": name, "type": "other", "is_up": bool(stat.isup)}
        for name, stat in psutil.net_if_stats().items()
    ]


async def invoke(method, *args, timeout=20):
    """Also permit injected synchronous facades without blocking the event loop."""
    async def call():
        if inspect.iscoroutinefunction(method):
            return await method(*args)
        result = await asyncio.to_thread(method, *args)
        return await result if inspect.isawaitable(result) else result
    async def drain(task):
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not task.cancelled():
            # Consume exceptions; public error is timeout/cancellation, not native output.
            task.exception()

    task = asyncio.create_task(call())
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout)
    except asyncio.CancelledError:
        await drain(task)
        raise
    except NetworkOperationError:
        raise
    except (TimeoutError, subprocess.TimeoutExpired):
        await drain(task)
        raise NetworkOperationError("timeout", "The native operation timed out.") from None
    except PermissionError:
        raise NetworkOperationError("permission_denied", "The operating system denied permission.") from None
    except Exception:
        raise NetworkOperationError("provider_unavailable", "The native network provider could not complete the operation.") from None


class CommandRunner:
    """No shell, no credential-bearing arguments, discarded native stderr."""

    def __init__(self, runner=subprocess.run):
        self.runner = runner

    async def run(self, args, payload=None):
        def run():
            result = self.runner(
                list(args), input=json.dumps(payload) if payload is not None else None,
                capture_output=True, text=True, timeout=8, shell=False,
            )
            if result.returncode:
                raise NetworkOperationError(
                    "permission_denied" if result.returncode in (5, 13) else "provider_unavailable",
                    "The system command failed; check OS permissions and tool availability.",
                )
            return result.stdout
        return await invoke(run, timeout=10)


class NativeAdapter(NetworkPlatformAdapter):
    """Common target validation, sanitized errors and session disposal."""

    def __init__(self, native):
        self.native = native

    def capabilities(self):
        return copy.deepcopy(to_builtin(self.native.capabilities()))

    async def inventory(self):
        return copy.deepcopy(to_builtin(await invoke(self.native.inventory)))

    async def _target(self, action, params):
        inventory = await self.inventory()
        if action.startswith("bluetooth_"):
            if action == "bluetooth_refresh":
                return inventory
            devices = [d for d in inventory["bluetooth_devices"]
                       if d["id"] == params.get("device_id")]
            if not devices:
                raise NetworkOperationError("invalid", "Select an inventoried Bluetooth device.")
        else:
            interfaces = [i for i in inventory["interfaces"]
                          if i["name"] == params.get("interface")]
            if not interfaces or (action.startswith("wifi_") and interfaces[0]["type"] != "wifi"):
                raise NetworkOperationError("invalid", "Select an inventoried compatible interface.")
        return inventory

    async def execute(self, action, params):
        if action not in ACTIONS:
            raise NetworkOperationError("invalid", "Unknown network action.")
        capability = self.capabilities()[action]
        if not capability["supported"]:
            raise NetworkOperationError("unsupported", capability["reason"])
        await self._target(action, params)
        if action == "wifi_connect":
            security = params.get("security", "saved")
            if security not in ("open", "wpa-personal", "saved"):
                raise NetworkOperationError("unsupported", "Enterprise Wi-Fi is not supported.")
            if security != "saved" and not isinstance(params.get("ssid"), str):
                raise NetworkOperationError("invalid", "A network name is required.")
            if security == "wpa-personal":
                password = params.get("password")
                if not isinstance(password, str) or not 8 <= len(password) <= 63:
                    raise NetworkOperationError("invalid", "WPA personal requires an 8–63 character passphrase.")
        return copy.deepcopy(to_builtin(await invoke(self.native.execute, action, params, timeout=30)))

    async def close(self):
        if hasattr(self.native, "close"):
            await invoke(self.native.close)


def capability_map(supported, reason="Native operation available; OS permissions still apply."):
    return {a: {"supported": a in supported,
                "reason": reason if a in supported else "Native provider or required tool is unavailable."}
            for a in ACTIONS}
