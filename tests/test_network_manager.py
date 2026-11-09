import asyncio
import subprocess
from types import SimpleNamespace

import pytest
from quart import Quart

from app.plugins.network_manager.manager import (
    BluetoothManager,
    ConnectionManager,
    EthernetManager,
    HotspotManager,
    InterfaceManager,
    NetworkManager,
    WiFiManager,
    compact_snapshot,
)
from app.plugins.network_manager.plugin import NetworkManagerPlugin
from app.plugins.network_manager.providers import LinuxMetadataProvider, PsutilProvider, _split_terse


class FakeProvider:
    def __init__(self):
        self.discovery_calls = self.counter_calls = 0
        self.devices = {"eth0": {"name": "eth0", "type": "ethernet", "is_up": True}}
        self.values = {"eth0": {"bytes_recv": 100, "bytes_sent": 50}}
        self.discovery_error = self.counter_error = False

    def discover(self):
        self.discovery_calls += 1
        if self.discovery_error:
            raise OSError("discovery failed")
        return self.devices.copy()

    def counters(self):
        self.counter_calls += 1
        if self.counter_error:
            raise OSError("counter failed")
        return {key: value.copy() for key, value in self.values.items()}


class FakeMetadata:
    def __init__(self):
        self.calls = 0
        self.error = False
        self.data = {"interfaces": {}, "capabilities": {"bluez": {"supported": False}}}

    def collect(self, interfaces):
        self.calls += 1
        if self.error:
            raise OSError("metadata failed")
        return self.data


def make_manager():
    provider, metadata = FakeProvider(), FakeMetadata()
    clock = [0.0]
    manager = NetworkManager(
        provider, metadata, monotonic=lambda: clock[0], wall_time=lambda: 1000 + clock[0]
    )
    return manager, provider, metadata, clock


def test_split_cadence_and_monotonic_rates():
    manager, provider, metadata, clock = make_manager()
    first = manager.collect()
    assert first["totals"]["recv_rate"] is None
    assert first["interfaces"][0]["state"] == "unknown"
    clock[0] = 2
    provider.values["eth0"] = {"bytes_recv": 300, "bytes_sent": 150}
    second = manager.collect()
    assert second["totals"] == {"recv_rate": 100, "sent_rate": 50}
    assert first["interfaces"][0]["bytes_recv"] == 100
    assert (provider.discovery_calls, metadata.calls, provider.counter_calls) == (1, 1, 2)
    clock[0] = 6
    manager.collect()
    assert (provider.discovery_calls, metadata.calls) == (2, 1)
    clock[0] = 10
    manager.collect()
    assert (provider.discovery_calls, metadata.calls) == (2, 2)


def test_reset_disappearance_and_hotplug_are_not_rate_spikes():
    manager, provider, _, clock = make_manager()
    manager.collect()
    clock[0] = 2
    provider.values["eth0"] = {"bytes_recv": 1, "bytes_sent": 100}
    assert manager.collect()["totals"]["recv_rate"] is None
    clock[0] = 4
    provider.values = {}
    assert manager.collect()["interfaces"] == []
    assert manager.connections["ethernet"].interfaces == {}
    clock[0] = 5
    provider.values["eth0"] = {"bytes_recv": 10000, "bytes_sent": 10000}
    assert manager.collect()["interfaces"][0]["recv_rate"] is None
    provider.values["new0"] = {"bytes_recv": 20, "bytes_sent": 5}
    clock[0] = 6
    new = manager.collect()["interfaces"][1]
    assert new["name"] == "new0" and new["type"] == "other"
    assert new["state"] == "unknown" and new["recv_rate"] is None


def test_provider_failures_recover_without_reusing_counter_baseline():
    manager, provider, metadata, clock = make_manager()
    manager.collect()
    clock[0] = 10
    provider.discovery_error = provider.counter_error = metadata.error = True
    failed = manager.collect()
    assert failed["status"] == "degraded"
    assert failed["interfaces"][0]["state"] == "unknown"
    assert failed["interfaces"][0]["recv_rate"] is None
    assert failed["capabilities"]["metadata"]["available"] is False
    clock[0] = 20
    provider.discovery_error = provider.counter_error = metadata.error = False
    assert manager.collect()["interfaces"][0]["recv_rate"] is None
    assert manager.collect()["status"] == "ok"


def test_independent_interfaces_and_specialized_ownership():
    manager, provider, metadata, _ = make_manager()
    provider.devices["wlan0"] = {"type": "wifi", "is_up": True}
    provider.values["wlan0"] = {"bytes_recv": 0, "bytes_sent": 0}
    metadata.data["interfaces"]["wlan0"] = {
        "type": "hotspot", "state": "connected", "metadata": {"wireless_mode": "AP"}
    }
    snapshot = manager.collect()
    assert snapshot["connections"]["hotspot"] == {"state": "connected", "interfaces": ["wlan0"]}
    assert snapshot["connections"]["wifi"]["state"] == "unavailable"
    assert all(issubclass(cls, ConnectionManager) for cls in
               (WiFiManager, EthernetManager, BluetoothManager, HotspotManager))
    assert not issubclass(InterfaceManager, ConnectionManager)
    assert manager.connections["ethernet"].interfaces["eth0"] is not manager.connections["hotspot"].interfaces["wlan0"]
    compact = compact_snapshot(snapshot)
    assert set(compact) == {"timestamp", "totals", "interfaces"}
    assert set(compact["interfaces"][0]) == {"name", "recv_rate", "sent_rate"}


def test_no_tools_is_honest_and_detection_is_cached():
    looked_up = []
    def which(name):
        looked_up.append(name)
        return None
    provider = LinuxMetadataProvider(which=which, system="Linux")
    first = provider.collect({"wlan0": {}})
    provider.collect({})
    assert looked_up == ["nmcli", "iw"]
    assert first["interfaces"] == {}
    assert all(not value["supported"] for value in first["capabilities"].values())
    manager = NetworkManager(FakeProvider(), provider)
    assert manager.collect()["status"] == "ok"


def test_linux_tools_are_read_only_bounded_and_hotspot_requires_ap():
    calls = []
    def runner(args, **kwargs):
        calls.append((args, kwargs))
        output = (
            "wlan0:wifi:connected\nveth0:ethernet:connected (externally)\nwlan1:wifi:connecting (prepare)\n"
            if args[0].endswith("nmcli") else
            "phy#0\n\tInterface wlan0\n\t\tssid Local AP\n\t\ttype AP\n\tInterface wlan1\n\t\ttype managed\n"
        )
        return SimpleNamespace(returncode=0, stdout=output)
    provider = LinuxMetadataProvider(
        runner=runner, which=lambda name: "/usr/bin/" + name, system="Linux"
    )
    result = provider.collect({"wlan0": {}, "wlan1": {}, "veth0": {}})
    assert result["interfaces"]["wlan0"]["type"] == "hotspot"
    assert result["interfaces"]["wlan0"]["metadata"]["ssid"] == "Local AP"
    assert result["interfaces"]["wlan1"]["type"] == "wifi"
    assert result["interfaces"]["wlan1"]["state"] == "connecting"
    assert "type" not in result["interfaces"]["veth0"]
    assert result["interfaces"]["veth0"]["state"] == "connected"
    for args, kwargs in calls:
        assert kwargs["timeout"] == 0.7 and kwargs.get("shell", False) is False
        assert kwargs["env"]["LC_ALL"] == "C"
        assert not any(word in args for word in ("scan", "connect", "disconnect", "modify"))
    assert _split_terse(r"veth\:odd:ethernet:connected") == ["veth:odd", "ethernet", "connected"]


@pytest.mark.parametrize("failure", [OSError("absent"), subprocess.TimeoutExpired("nmcli", 0.7)])
def test_optional_tool_failures_are_capabilities_not_collection_failures(failure):
    def runner(*args, **kwargs):
        raise failure
    provider = LinuxMetadataProvider(
        runner=runner, which=lambda name: "/usr/bin/" + name, system="Linux"
    )
    result = provider.collect({"eth0": {}})
    assert result["interfaces"] == {}
    assert result["capabilities"]["nmcli"]["available"] is False
    assert result["capabilities"]["iw"]["error"]
    manager = NetworkManager(FakeProvider(), provider)
    snapshot = manager.collect()
    assert snapshot["interfaces"][0]["name"] == "eth0"
    assert snapshot["status"] == "degraded"


def test_generic_discovery_normalizes_addresses_and_no_wrap(monkeypatch):
    import socket
    from app.plugins.network_manager import providers
    stats = SimpleNamespace(isup=True, speed=0, mtu=1500)
    address = SimpleNamespace(family=socket.AF_INET, address="192.0.2.1", netmask="255.255.255.0", broadcast="192.0.2.255")
    monkeypatch.setattr(providers.psutil, "net_if_stats", lambda: {"veth0": stats})
    monkeypatch.setattr(providers.psutil, "net_if_addrs", lambda: {"veth0": [address]})
    monkeypatch.setattr(providers.platform, "system", lambda: "Darwin")
    calls = []
    def counters(**kwargs):
        calls.append(kwargs)
        return {"veth0": SimpleNamespace(bytes_recv=12, bytes_sent=7)}
    monkeypatch.setattr(providers.psutil, "net_io_counters", counters)
    provider = PsutilProvider()
    result = provider.discover()["veth0"]
    assert result["type"] == "other"
    assert result["speed_mbps"] is None
    assert result["addresses"][0]["family"] == "AF_INET"
    assert provider.counters()["veth0"]["bytes_recv"] == 12
    assert calls == [{"pernic": True, "nowrap": False}]


def test_plugin_registers_cached_routes_and_validates_config(monkeypatch):
    monkeypatch.setenv("SHELL_APP_NETWORK_INTERVAL", "nan")
    app = Quart(__name__)
    app.config["SHELL_APP_NETWORK_DISCOVERY_INTERVAL"] = 7
    NetworkManagerPlugin().register(app)
    service = app.extensions["network_manager"]
    assert service.interval == 2
    assert service.manager.discovery_interval == 7
    assert service.manager.metadata_interval == 10
    def no_collection():
        raise AssertionError("HTTP requests must not collect")
    service.collect = no_collection
    async def verify():
        client = app.test_client()
        response = await client.get("/api/network-manager")
        assert await response.get_json() == {"timestamp": None, "status": "starting"}
        history = await client.get("/api/network-manager/history")
        assert await history.get_json() == {"samples": []}
    asyncio.run(verify())


@pytest.mark.parametrize("metadata_state,expected", [
    ("connected", "disconnected"), ("connecting", "connecting"), ("unavailable", "unavailable")
])
def test_discovery_link_down_overrides_stale_connected_metadata(metadata_state, expected):
    manager, provider, metadata, clock = make_manager()
    metadata.data["interfaces"]["eth0"] = {"state": metadata_state}
    manager.collect()
    provider.devices["eth0"] = {"type": "ethernet", "is_up": False}
    clock[0] = 5
    snapshot = manager.collect()
    assert snapshot["interfaces"][0]["state"] == expected
    assert metadata.calls == 1


def test_linux_classification_requires_physical_evidence(monkeypatch, tmp_path):
    from app.plugins.network_manager import providers
    monkeypatch.setattr(providers.platform, "system", lambda: "Linux")
    monkeypatch.setattr(providers, "Path", lambda path: tmp_path)
    (tmp_path / "eth0").mkdir()
    (tmp_path / "eth0" / "type").write_text("1\n")
    assert PsutilProvider.interface_type("eth0") == "other"
    (tmp_path / "eth0" / "device").mkdir()
    assert PsutilProvider.interface_type("eth0") == "ethernet"
    (tmp_path / "eth0" / "wireless").mkdir()
    assert PsutilProvider.interface_type("eth0") == "wifi"
    assert PsutilProvider.interface_type("../eth0") == "other"


def test_counter_timestamps_exclude_metadata_collection_delay():
    manager, provider, metadata, clock = make_manager()
    original_collect = metadata.collect
    def delayed_metadata(interfaces):
        clock[0] += 1
        return original_collect(interfaces)
    metadata.collect = delayed_metadata
    manager.collect()  # Baseline read at t=1, not before metadata at t=0.
    clock[0] = 3
    provider.values["eth0"] = {"bytes_recv": 300, "bytes_sent": 150}
    assert manager.collect()["totals"] == {"recv_rate": 100, "sent_rate": 50}


def test_nonpositive_elapsed_time_never_divides_or_spikes():
    manager, provider, _, clock = make_manager()
    manager.collect()
    provider.values["eth0"] = {"bytes_recv": 200, "bytes_sent": 100}
    assert manager.collect()["totals"]["recv_rate"] is None
    clock[0] = -1
    assert manager.collect()["totals"]["recv_rate"] is None
