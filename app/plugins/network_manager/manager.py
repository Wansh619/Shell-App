"""NetworkManager -> specialized ConnectionManager -> independent InterfaceManager."""

import threading
import time
from copy import deepcopy

from app.core.monitoring import MonitoringService, positive_number
from app.plugins.network_manager.inspection import normalize_address
from app.plugins.network_manager.providers import LinuxMetadataProvider, PsutilProvider


class InterfaceManager:
    def __init__(self, name):
        self.name = name
        self.snapshot = {}
        self._previous = None

    def update(self, discovery, metadata, counters, now):
        recv_rate = sent_rate = None
        if counters is not None:
            if self._previous is not None:
                before, previous = self._previous
                elapsed = now - before
                received = counters["bytes_recv"] - previous["bytes_recv"]
                sent = counters["bytes_sent"] - previous["bytes_sent"]
                if elapsed > 0 and received >= 0 and sent >= 0:
                    recv_rate, sent_rate = received / elapsed, sent / elapsed
            self._previous = (now, counters.copy())
        else:
            self._previous = None
        is_up = bool(discovery.get("is_up", False))
        state = metadata.get("state", "unknown" if is_up else "disconnected")
        if not is_up and state not in ("connecting", "unavailable"):
            state = "disconnected"
        self.snapshot = {
            "name": self.name,
            "type": metadata.get("type", discovery.get("type", "other")),
            "state": state,
            "is_up": is_up,
            "addresses": [normalize_address(item) for item in discovery.get("addresses", [])],
            "mac": discovery.get("mac"),
            "speed_mbps": discovery.get("speed_mbps"),
            "mtu": discovery.get("mtu"),
            "bytes_recv": counters["bytes_recv"] if counters else self.snapshot.get("bytes_recv", 0),
            "bytes_sent": counters["bytes_sent"] if counters else self.snapshot.get("bytes_sent", 0),
            "recv_rate": recv_rate,
            "sent_rate": sent_rate,
            "metadata": metadata.get("metadata", {}),
        }
        return self.snapshot


class ConnectionManager:
    technology = "other"

    def __init__(self):
        self.interfaces = {}

    def summary(self):
        states = {interface.snapshot["state"] for interface in self.interfaces.values()}
        state = next(
            (value for value in ("connected", "connecting", "unknown", "disconnected", "unavailable") if value in states),
            "unavailable",
        )
        return {"state": state, "interfaces": sorted(self.interfaces)}


class WiFiManager(ConnectionManager):
    technology = "wifi"


class EthernetManager(ConnectionManager):
    technology = "ethernet"


class BluetoothManager(ConnectionManager):
    technology = "bluetooth"


class HotspotManager(ConnectionManager):
    technology = "hotspot"


def compact_snapshot(snapshot):
    return {
        "timestamp": snapshot["timestamp"],
        "totals": snapshot["totals"].copy(),
        "interfaces": [
            {key: interface[key] for key in ("name", "recv_rate", "sent_rate")}
            for interface in snapshot["interfaces"]
        ],
    }


class NetworkManager:
    """Prime coordinator; no framework requests or scheduler in collection code."""

    def __init__(self, provider=None, metadata_provider=None, discovery_interval=5,
                 metadata_interval=10, monotonic=None, wall_time=None, controller=None):
        self.provider = provider if provider is not None else PsutilProvider()
        self.metadata_provider = metadata_provider if metadata_provider is not None else LinuxMetadataProvider()
        self.discovery_interval = positive_number(discovery_interval, 5)
        self.metadata_interval = positive_number(metadata_interval, 10)
        self.monotonic = monotonic or time.monotonic
        self.wall_time = wall_time or time.time
        self.controller = controller
        self._refresh_requested = threading.Event()
        self.connections = {
            manager.technology: manager()
            for manager in (WiFiManager, EthernetManager, BluetoothManager, HotspotManager)
        }
        self.other = ConnectionManager()
        self._discovery = {}
        self._metadata = {"interfaces": {}, "capabilities": {}}
        self._last_discovery = self._last_metadata = None
        self._discovery_available = False
        self._metadata_available = True

    def request_refresh(self):
        """Invalidate caches on the collector thread, not on the event loop."""
        self._refresh_requested.set()

    def collect(self):
        if self._refresh_requested.is_set():
            self._refresh_requested.clear()
            self._last_discovery = self._last_metadata = None
        control = self.controller.snapshot() if self.controller is not None else None
        control_interfaces = {
            item["name"]: item for item in (control or {}).get("interfaces", [])
        }
        now = self.monotonic()
        if self._last_discovery is None or now - self._last_discovery >= self.discovery_interval:
            self._last_discovery = now
            try:
                self._discovery = self.provider.discover()
                self._discovery_available = True
            except Exception:
                self._discovery_available = False
        if self._last_metadata is None or now - self._last_metadata >= self.metadata_interval:
            self._last_metadata = now
            try:
                self._metadata = self.metadata_provider.collect(self._discovery)
                self._metadata_available = True
            except Exception:
                self._metadata = {"interfaces": {}, "capabilities": {}}
                self._metadata_available = False
        try:
            counters = self.provider.counters()
            counters_available = True
        except Exception:
            counters = {}
            counters_available = False
        counter_time = self.monotonic()
        all_managers = [*self.connections.values(), self.other]
        existing = {
            name: interface
            for manager in all_managers for name, interface in manager.interfaces.items()
        }
        for manager in all_managers:
            manager.interfaces = {}
        # Counter inventory immediately drops disappeared devices. Returning devices
        # receive a new InterfaceManager, so a stale baseline never survives hotplug.
        names = counters.keys() if counters_available else self._discovery.keys()
        interfaces = []
        for name in sorted(names):
            discovery = self._discovery.get(name, {})
            metadata = deepcopy(self._metadata["interfaces"].get(name, {}))
            native = control_interfaces.get(name, {})
            if native.get("type") in self.connections:
                metadata["type"] = native["type"]
            if native.get("ssid"):
                metadata.setdefault("metadata", {})["ssid"] = native["ssid"]
                if discovery.get("is_up") and native.get("type") == "wifi":
                    metadata["state"] = "connected"
            interface = existing.get(name) or InterfaceManager(name)
            snapshot = interface.update(discovery, metadata, counters.get(name), counter_time)
            if not self._discovery_available or name not in self._discovery:
                snapshot["state"] = "unknown"
            manager = self.connections.get(snapshot["type"], self.other)
            manager.interfaces[name] = interface
            interfaces.append(snapshot)
        capabilities = {
            "psutil": {"supported": True, "available": self._discovery_available and counters_available},
            "discovery": {"available": self._discovery_available},
            "counters": {"available": counters_available},
            "metadata": {"available": self._metadata_available},
            "internet_connectivity": {"supported": False, "available": False},
            **self._metadata["capabilities"],
        }
        degraded = not (self._discovery_available and counters_available and self._metadata_available)
        degraded = degraded or any(value.get("error") for value in capabilities.values())
        totals = {}
        for key in ("recv_rate", "sent_rate"):
            values = [item[key] for item in interfaces]
            totals[key] = sum(values) if values and all(value is not None for value in values) else None
        snapshot = {
            "timestamp": self.wall_time(),
            "status": "degraded" if degraded else "ok",
            "interfaces": interfaces,
            "connections": {key: manager.summary() for key, manager in self.connections.items()},
            "totals": totals,
            "capabilities": capabilities,

        }
        if control is not None:
            snapshot["control"] = control
        return deepcopy(snapshot)


class NetworkMonitor(MonitoringService):
    def __init__(self, manager, interval=2):
        self.manager = manager
        super().__init__(manager.collect, interval=interval, compact=compact_snapshot)

    async def start(self):
        if self.manager.controller is not None:
            await self.manager.controller.start()
        await super().start()

    async def stop(self):
        await super().stop()
        if self.manager.controller is not None:
            await self.manager.controller.stop()
