"""Read-only collection boundaries; optional Linux tools never gate psutil data."""

import os
import platform
import shutil
import socket
import subprocess
from pathlib import Path

import psutil


class PsutilProvider:
    """Discover slowly, but read lightweight byte counters every sample."""

    def discover(self):
        stats = psutil.net_if_stats()
        addresses = psutil.net_if_addrs()
        result = {}
        for name in stats.keys() | addresses.keys():
            info = stats.get(name)
            normalized = []
            mac = None
            for address in addresses.get(name, []):
                if address.family in (getattr(psutil, "AF_LINK", None), socket.AF_PACKET if hasattr(socket, "AF_PACKET") else -1):
                    mac = address.address
                else:
                    normalized.append({
                        "family": getattr(address.family, "name", str(address.family)),
                        "address": address.address,
                        "netmask": address.netmask,
                        "broadcast": address.broadcast,
                    })
            result[name] = {
                "name": name,
                "type": self.interface_type(name),
                "is_up": bool(info and info.isup),
                "addresses": normalized,
                "mac": mac,
                "speed_mbps": info.speed if info and info.speed > 0 else None,
                "mtu": info.mtu if info else None,
            }
        return result

    @staticmethod
    def interface_type(name):
        # Names alone cannot distinguish bridges, veth, tunnels, and physical NICs.
        if platform.system() != "Linux" or "/" in name or name in (".", ".."):
            return "other"
        root = Path("/sys/class/net") / name
        if (root / "wireless").is_dir():
            return "wifi"
        try:
            if (root / "device").exists() and (root / "type").read_text().strip() == "1":
                return "ethernet"
        except OSError:
            pass
        return "other"

    def counters(self):
        return {
            name: {"bytes_recv": info.bytes_recv, "bytes_sent": info.bytes_sent}
            for name, info in psutil.net_io_counters(pernic=True, nowrap=False).items()
        }


def _split_terse(line):
    """Split nmcli's escaped terse output without corrupting interface names."""
    fields, current, escaped = [], [], False
    for char in line:
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == ":":
            fields.append("".join(current))
            current = []
        else:
            current.append(char)
    fields.append("".join(current))
    return fields


class LinuxMetadataProvider:
    """Cached tool detection; no scans, writes, privileges, D-Bus, or probes."""

    def __init__(self, runner=None, which=None, system=None, timeout=0.7):
        self.runner = runner or subprocess.run
        which = which or shutil.which
        linux = (system or platform.system()) == "Linux"
        self.tools = {name: which(name) if linux else None for name in ("nmcli", "iw")}
        self.timeout = timeout

    def _run(self, name, arguments):
        result = self.runner(
            [self.tools[name], *arguments],
            capture_output=True, text=True, timeout=self.timeout,
            check=False, env={**os.environ, "LC_ALL": "C"},
        )
        if result.returncode:
            raise RuntimeError("Read-only metadata command failed")
        return result.stdout

    def collect(self, interfaces):
        data = {}
        capabilities = {
            "nmcli": {"supported": bool(self.tools["nmcli"]), "available": False},
            "iw": {"supported": bool(self.tools["iw"]), "available": False},
            "bluez": {"supported": False, "available": False},
            "dbus": {"supported": False, "available": False},
            "netlink": {"supported": False, "available": False},
        }
        if self.tools["nmcli"]:
            try:
                output = self._run("nmcli", ["-t", "-e", "yes", "-f", "DEVICE,TYPE,STATE", "device", "status"])
                types = {"wifi": "wifi", "ethernet": "ethernet", "bt": "bluetooth"}
                for line in output.splitlines():
                    fields = _split_terse(line)
                    if len(fields) != 3 or fields[0] not in interfaces:
                        continue
                    name, kind, state = fields
                    entry = data.setdefault(name, {"metadata": {}})
                    # NetworkManager identifies virtual ethernet devices as ethernet too.
                    # Only sysfs-confirmed physical ethernet keeps that classification.
                    if kind in ("wifi", "bt"):
                        entry["type"] = types[kind]
                    entry["state"] = (
                        "connected" if state == "connected" or state.startswith("connected (") else
                        "connecting" if state.startswith("connecting") else
                        "disconnected" if state == "disconnected" else
                        "unavailable" if state in ("unavailable", "unmanaged") else "unknown"
                    )
                    entry["metadata"]["networkmanager_state"] = state
                capabilities["nmcli"]["available"] = True
            except (OSError, subprocess.SubprocessError, RuntimeError):
                capabilities["nmcli"]["error"] = "Metadata unavailable"
        if self.tools["iw"]:
            try:
                # One bounded command discovers local wireless modes, not nearby networks.
                output = self._run("iw", ["dev"])
                current = None
                for line in output.splitlines():
                    line = line.strip()
                    if line.startswith("Interface "):
                        name = line.removeprefix("Interface ")
                        current = data.setdefault(name, {"metadata": {}}) if name in interfaces else None
                    elif current is not None and line.startswith("type "):
                        mode = line.removeprefix("type ")
                        current["metadata"]["wireless_mode"] = mode
                        if mode == "AP":
                            current["type"] = "hotspot"
                        elif mode in ("managed", "IBSS"):
                            current["type"] = "wifi"
                    elif current is not None and line.startswith("ssid "):
                        current["metadata"]["ssid"] = line.removeprefix("ssid ")
                capabilities["iw"]["available"] = True
            except (OSError, subprocess.SubprocessError, RuntimeError):
                capabilities["iw"]["error"] = "Metadata unavailable"
        return {"interfaces": data, "capabilities": capabilities}
