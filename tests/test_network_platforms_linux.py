import asyncio
import json
import sys
from types import SimpleNamespace

import pytest

from app.plugins.network_manager.platforms.base import NetworkOperationError
from app.plugins.network_manager.platforms.linux import (
    DEVICE, NM, ROOT, WIRELESS, LinuxNative, LinuxPlatformAdapter, unwrap,
)


def run(coroutine):
    return asyncio.run(coroutine)


class Variant:
    def __init__(self, signature, value):
        self.signature, self.value = signature, value


class FakeDBus(LinuxNative):
    def __init__(self):
        super().__init__(bus=SimpleNamespace(disconnect=lambda: self.calls.append(("close",))), which=lambda _: None)
        self.calls = []
        self.state = 100
        self.active = "/ap/1"
        self.connected = False
        self.profiles = ["/saved/1"]

    async def call(self, destination, path, interface, member, signature="", body=None):
        self.calls.append((member, path, signature, body))
        if member == "GetDevices":
            return [["/device/1"]]
        if member == "GetManagedObjects":
            return [{"/bluez/paired": {"org.bluez.Device1": {
                "Paired": True, "Connected": self.connected, "Alias": "Keyboard", "Adapter": "/bluez/hci0"}},
                "/bluez/unpaired": {"org.bluez.Device1": {"Paired": False}}}]
        if member == "ListConnections":
            return [self.profiles]
        if member == "GetSettings":
            return [{"connection": {"uuid": "saved-id", "interface-name": "wlan0"},
                     "802-11-wireless": {"ssid": list(b"Saved")},
                     "ipv4": {"method": "auto"}}]
        if member == "CheckpointCreate":
            return ["/checkpoint/1"]
        if member == "CheckpointRollback":
            return [{"/device/1": 0}]
        return []

    async def props(self, path, interface, destination=NM):
        if interface == DEVICE:
            return {"Interface": "wlan0", "DeviceType": 2, "InterfaceFlags": 1, "State": self.state,
                    "Ip4Config": "/ip4", "Ip6Config": "/", "ActiveConnection": "/"}
        if interface == WIRELESS:
            return {"ActiveAccessPoint": self.active, "AccessPoints": ["/ap/1", "/ap/enterprise"]}
        if interface == NM + ".AccessPoint":
            return {"Ssid": list(b"Saved" if path == "/ap/1" else b"Enterprise"),
                    "RsnFlags": 0x100 if path == "/ap/1" else 0x200, "Strength": 80}
        if interface == NM + ".IP4Config":
            return {"Gateway": "192.0.2.1", "NameserverData": [{"address": "192.0.2.53"}],
                    "RouteData": [{"dest": "0.0.0.0", "prefix": 0, "next-hop": "192.0.2.1"}]}
        if interface == "org.bluez.Device1":
            return {"Connected": self.connected}
        raise AssertionError("Unexpected property")


@pytest.fixture(autouse=True)
def no_host(monkeypatch):
    monkeypatch.setattr("app.plugins.network_manager.platforms.linux.passive_interfaces", lambda: [])


def test_inventory_uses_cached_APs_not_active_scan_and_includes_available_bluetooth():
    native = FakeDBus()
    inventory = run(LinuxPlatformAdapter(native=native).inventory())
    assert inventory["interfaces"] == [{"name": "wlan0", "type": "wifi", "is_up": True, "ssid": "Saved"}]
    assert len(inventory["bluetooth_devices"]) == 2
    assert {d["id"]: d["paired"] for d in inventory["bluetooth_devices"]} == {
        "/bluez/paired": True,
        "/bluez/unpaired": False,
    }
    assert inventory["wifi_networks"][1]["security"] == "enterprise"
    assert inventory["details"]["wlan0"]["dns"] == ["192.0.2.53"]
    assert all(call[0] != "RequestScan" for call in native.calls)


def test_explicit_scan_only_requests_nm_scan():
    native = FakeDBus()
    delta = run(LinuxPlatformAdapter(native=native).execute("wifi_scan", {"interface": "wlan0"}))
    assert len(delta["wifi_networks"]) == 2
    assert sum(call[0] == "RequestScan" for call in native.calls) == 1


@pytest.mark.parametrize("security", ["open", "wpa-personal"])
def test_new_connections_are_in_memory_dbus_variants(monkeypatch, security):
    monkeypatch.setitem(sys.modules, "dbus_next", SimpleNamespace(Variant=Variant))
    native = FakeDBus()
    result = run(LinuxPlatformAdapter(native=native).execute("wifi_connect", {
        "interface": "wlan0", "ssid": "Other", "security": security, "password": "fake-passphrase"}))
    assert result == {"observed": False, "state": "requested"}
    call = next(c for c in native.calls if c[0] == "AddAndActivateConnection")
    settings = call[3][0]
    assert settings["802-11-wireless"]["ssid"].value == b"Other"
    assert ("802-11-wireless-security" in settings) is (security == "wpa-personal")
    assert "fake-passphrase" not in str(result)


def test_saved_profiles_validate_membership_and_observation():
    native = FakeDBus()
    adapter = LinuxPlatformAdapter(native=native)
    result = run(adapter.execute("wifi_connect", {"interface": "wlan0", "security": "saved", "profile_id": "saved-id"}))
    assert result["observed"] is False
    result = run(adapter.execute("wifi_connect", {"interface": "wlan0", "security": "saved", "ssid": "Saved"}))
    assert result["observed"] is True
    with pytest.raises(NetworkOperationError):
        run(adapter.execute("wifi_connect", {"interface": "wlan0", "security": "saved", "profile_id": "/arbitrary"}))


def test_disconnect_observed_only_when_nm_state_disconnected():
    native = FakeDBus()
    adapter = LinuxPlatformAdapter(native=native)
    assert not run(adapter.execute("wifi_disconnect", {"interface": "wlan0"}))["observed"]
    native.state, native.active = 30, "/"
    assert run(adapter.execute("wifi_disconnect", {"interface": "wlan0"}))["observed"]


def test_bluetooth_call_accepted_is_not_connected():
    native = FakeDBus()
    adapter = LinuxPlatformAdapter(native=native)
    assert not run(adapter.execute("bluetooth_connect", {"device_id": "/bluez/paired"}))["observed"]
    assert not run(adapter.execute("bluetooth_connect", {"device_id": "/bluez/unpaired"}))["observed"]
    assert any(c[0] == "Pair" and c[1] == "/bluez/unpaired" for c in native.calls)
    native.connected = True
    assert run(adapter.execute("bluetooth_connect", {"device_id": "/bluez/paired"}))["observed"]


def test_nm_checkpoint_and_raw_link_capabilities_are_distinct():
    native = FakeDBus()
    native.ip = "/fake/ip"
    adapter = LinuxPlatformAdapter(native=native)
    assert adapter.capabilities()["wifi_connect"]["rollback"]
    assert adapter.capabilities()["interface_down"]["rollback"] is False
    checkpoint = run(adapter.create_checkpoint("wlan0", 60))
    assert checkpoint["expires_at"] > 0
    assert next(c for c in native.calls if c[0] == "CheckpointCreate")[3] == [["/device/1"], 60, 0]
    run(adapter.revert_checkpoint(checkpoint["id"]))
    run(adapter.close())
    assert native.calls[-1] == ("close",)


def test_missing_optional_dbus_and_tools_are_honest(monkeypatch):
    monkeypatch.setattr("app.plugins.network_manager.platforms.linux.importlib.util.find_spec", lambda _: None)
    native = LinuxNative(which=lambda _: None)
    assert not any(c["supported"] for c in native.capabilities().values())
    assert run(native.inventory()) == {"interfaces": [], "wifi_networks": [], "bluetooth_devices": [], "details": {}}


def test_service_absence_degrades_capabilities_without_native_exception():
    native = FakeDBus()
    async def unavailable(*args, **kwargs):
        raise RuntimeError("raw-private-native-output")
    native.call = unavailable
    result = run(native.inventory())
    assert result["interfaces"] == []
    assert not native.capabilities()["wifi_connect"]["supported"]
    assert not native.capabilities()["bluetooth_connect"]["supported"]


def test_ip_json_inventory_and_admin_flags_not_carrier(monkeypatch):
    monkeypatch.setattr("app.plugins.network_manager.platforms.linux.importlib.util.find_spec", lambda _: None)
    monkeypatch.setattr("app.plugins.network_manager.platforms.linux.passive_interfaces",
                        lambda: [{"name": "eth0", "type": "other", "is_up": False}])
    calls = []
    def runner(args, **kwargs):
        calls.append((args, kwargs))
        data = ([{"ifname": "eth0", "flags": ["UP"], "operstate": "DOWN"}] if "link" in args and "-j" in args else
                [{"dev": "eth0", "gateway": "192.0.2.1"}] if "route" in args else [])
        return SimpleNamespace(returncode=0, stdout=json.dumps(data))
    adapter = LinuxPlatformAdapter(which=lambda _: "/fake/ip", runner=runner)
    result = run(adapter.execute("interface_up", {"interface": "eth0"}))
    assert result == {"observed": True, "state": "up"}
    assert ["/fake/ip", "link", "set", "dev", "eth0", "up"] in [c[0] for c in calls]
    assert all(c[1]["shell"] is False and c[1]["timeout"] == 8 for c in calls)


def test_unwrap_recursive_variants():
    assert unwrap(Variant("a{sv}", {"value": Variant("s", "safe")})) == {"value": "safe"}
