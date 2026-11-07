import asyncio
from copy import deepcopy

from app.plugins.network_manager.manager import (
    NetworkManager,
    NetworkMonitor,
    compact_snapshot,
)


class FakeProvider:
    def __init__(self):
        self.calls = 0

    def discover(self):
        self.calls += 1
        return {"wlan0": {
            "type": "other", "is_up": True,
            "addresses": [{"address": "192.0.2.7", "netmask": "255.255.255.0"}],
        }}

    def counters(self):
        return {"wlan0": {"bytes_recv": 100, "bytes_sent": 50}}


class FakeMetadata:
    def collect(self, _interfaces):
        return {"interfaces": {}, "capabilities": {}}


class FakeController:
    def __init__(self):
        self.starts = self.stops = 0
        self.data = {
            "interfaces": [{"name": "wlan0", "type": "wifi", "ssid": "Lab"}],
            "operations": [{"id": "test-operation", "status": "pending"}],
        }

    def snapshot(self):
        return deepcopy(self.data)

    async def start(self):
        self.starts += 1

    async def stop(self):
        self.stops += 1


def test_controller_enriches_monitoring_without_entering_traffic_history():
    controller, provider = FakeController(), FakeProvider()
    manager = NetworkManager(
        provider=provider, metadata_provider=FakeMetadata(), controller=controller
    )
    sample = manager.collect()
    assert manager.controller is controller
    assert sample["connections"]["wifi"]["interfaces"] == ["wlan0"]
    interface = sample["interfaces"][0]
    assert interface["metadata"]["ssid"] == "Lab"
    assert interface["addresses"][0]["network_cidr"] == "192.0.2.0/24"
    assert sample["control"]["operations"][0]["id"] == "test-operation"
    sample["control"]["operations"].clear()
    assert controller.data["operations"]
    assert "control" not in compact_snapshot(sample)
    assert "addresses" not in compact_snapshot(sample)["interfaces"][0]
    manager.collect()
    assert provider.calls == 1
    manager.request_refresh()
    manager.collect()
    assert provider.calls == 2


def test_monitor_owns_controller_lifecycle_and_closes_after_sampling_stops():
    async def verify():
        controller = FakeController()
        manager = NetworkManager(
            provider=FakeProvider(), metadata_provider=FakeMetadata(),
            controller=controller,
        )
        monitor = NetworkMonitor(manager, interval=0.25)
        queue = monitor.live.subscribe()
        await monitor.start()
        sample = await asyncio.wait_for(queue.get(), 2)
        assert sample["control"]
        await monitor.stop()
        assert monitor.task is None
        assert controller.starts == controller.stops == 1

    asyncio.run(verify())
