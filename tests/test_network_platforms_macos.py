import asyncio
import json
from types import SimpleNamespace

import pytest

from app.plugins.network_manager.platforms.base import NetworkOperationError
from app.plugins.network_manager.platforms.macos import CoreWLANFacade, MacOSNative, MacOSPlatformAdapter


def run(coroutine):
    return asyncio.run(coroutine)


class FakeWLAN:
    def __init__(self):
        self.calls = []
        self.ssid = None

    def inventory(self):
        self.calls.append("inventory")
        return [{"name": "en0", "type": "wifi", "is_up": True, "ssid": self.ssid}]

    def scan(self, name):
        self.calls.append(("scan", name))
        return [{"id": "network", "interface": name, "ssid": "Example", "security": "wpa-personal", "signal": 80}]

    def connect(self, name, params):
        self.calls.append(("connect", name, params.get("security")))

    def disconnect(self, name):
        self.calls.append(("disconnect", name))


@pytest.fixture(autouse=True)
def no_host(monkeypatch):
    monkeypatch.setattr("app.plugins.network_manager.platforms.macos.passive_interfaces",
                        lambda: [{"name": "en0", "type": "other", "is_up": True}])
    monkeypatch.setattr("app.plugins.network_manager.platforms.macos.importlib.util.find_spec", lambda _: None)


def test_inventory_does_not_scan_and_explicit_scan_populates_cache():
    wlan = FakeWLAN()
    adapter = MacOSPlatformAdapter(wlan=wlan, which=lambda _: None)
    assert run(adapter.inventory())["wifi_networks"] == []
    assert wlan.calls == ["inventory"]
    delta = run(adapter.execute("wifi_scan", {"interface": "en0"}))
    assert delta["wifi_networks"][0]["ssid"] == "Example"
    assert sum(isinstance(c, tuple) and c[0] == "scan" for c in wlan.calls) == 1
    assert run(adapter.inventory())["wifi_networks"] == delta["wifi_networks"]


def test_association_accepted_not_connected_and_privacy_nil_not_disconnected():
    wlan = FakeWLAN()
    adapter = MacOSPlatformAdapter(wlan=wlan, which=lambda _: None)
    params = {"interface": "en0", "ssid": "Example", "security": "wpa-personal", "password": "fake-passphrase"}
    assert not run(adapter.execute("wifi_connect", params))["observed"]
    wlan.ssid = "Example"
    assert run(adapter.execute("wifi_connect", params))["observed"]
    wlan.ssid = None
    assert not run(adapter.execute("wifi_disconnect", {"interface": "en0"}))["observed"]


def test_ifconfig_changes_administrative_link_not_disassociation():
    calls = []
    def runner(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout="")
    adapter = MacOSPlatformAdapter(wlan=FakeWLAN(), which=lambda n: "/fake/ifconfig" if n == "ifconfig" else None, runner=runner)
    result = run(adapter.execute("interface_down", {"interface": "en0"}))
    assert calls[0][0] == ["/fake/ifconfig", "en0", "down"]
    assert result["observed"] is False
    assert not adapter.capabilities()["interface_down"]["rollback"]


def test_blueutil_only_paired_json_and_inventory_target_validation():
    calls = []
    connected = [False]
    def runner(args, **kwargs):
        calls.append((args, kwargs))
        if "--connect" in args:
            connected[0] = True
            return SimpleNamespace(returncode=0, stdout="")
        return SimpleNamespace(returncode=0, stdout=json.dumps([
            {"address": "AA-BB-CC-DD-EE-FF", "name": "Keyboard", "paired": True, "connected": connected[0]},
            {"address": "00-00-00-00-00-00", "paired": False},
        ]))
    adapter = MacOSPlatformAdapter(which=lambda n: "/fake/blueutil" if n == "blueutil" else None, runner=runner)
    inventory = run(adapter.inventory())
    assert len(inventory["bluetooth_devices"]) == 2
    assert {d["id"]: d["paired"] for d in inventory["bluetooth_devices"]} == {
        "AA-BB-CC-DD-EE-FF": True,
        "00-00-00-00-00-00": False,
    }
    result = run(adapter.execute("bluetooth_connect", {"device_id": "AA-BB-CC-DD-EE-FF"}))
    assert result["observed"]
    assert ["/fake/blueutil", "--connect", "AA-BB-CC-DD-EE-FF"] in [c[0] for c in calls]
    assert not any("--inquiry" in c[0] for c in calls)
    with pytest.raises(NetworkOperationError):
        run(adapter.execute("bluetooth_connect", {"device_id": "--inquiry"}))


def test_optional_bluetooth_failure_does_not_hide_wifi_or_link_inventory():
    runner = lambda *a, **k: SimpleNamespace(returncode=1, stdout="", stderr="private")
    adapter = MacOSPlatformAdapter(wlan=FakeWLAN(), which=lambda _: "/fake/tool", runner=runner)
    inventory = run(adapter.inventory())
    assert inventory["interfaces"][0]["type"] == "wifi"
    assert inventory["bluetooth_devices"] == []
    assert adapter.capabilities()["interface_up"]["supported"]


def test_optional_wlan_permission_failure_preserves_other_inventory():
    wlan = FakeWLAN()
    def broken():
        raise PermissionError("private")
    wlan.inventory = broken
    adapter = MacOSPlatformAdapter(wlan=wlan, which=lambda _: None)
    assert run(adapter.inventory())["interfaces"][0]["name"] == "en0"


def test_systemconfiguration_uses_structured_cached_state():
    state = {
        "State:/Network/Service/one/IPv4": {"InterfaceName": "en0", "Router": "192.0.2.1"},
        "State:/Network/Service/one/DNS": {"ServerAddresses": ["192.0.2.53"]},
        "Setup:/Network/Service/one/IPv4": {"ConfigMethod": "DHCP"},
    }
    configuration = SimpleNamespace(
        SCDynamicStoreCreate=lambda *a: object(),
        SCDynamicStoreCopyKeyList=lambda *a: ["State:/Network/Service/one/IPv4"],
        SCDynamicStoreCopyValue=lambda store, key: state.get(key),
    )
    adapter = MacOSPlatformAdapter(wlan=FakeWLAN(), configuration=configuration, which=lambda _: None)
    details = run(adapter.inventory())["details"]["en0"]
    assert details["dns"] == ["192.0.2.53"] and details["method"] == "DHCP"
    assert details["gateways"] == ["192.0.2.1"]


class CWNetwork:
    def __init__(self, name="Example", security=2):
        self.name, self.security = name, security
    def ssid(self):
        return self.name
    def bssid(self):
        return self.name
    def supportsSecurity_(self, security):
        return self.security == security
    def rssiValue(self):
        return -55


class CWInterface:
    def __init__(self):
        self.networks = [CWNetwork()]
        self.calls = []
    def interfaceName(self):
        return "en0"
    def powerOn(self):
        return True
    def ssid(self):
        return None
    def scanForNetworksWithName_error_(self, name, error):
        self.calls.append("scan")
        return self.networks, None
    def associateToNetwork_password_error_(self, network, password, error):
        self.calls.append(("associate", network.ssid(), password is not None))
        return True, None
    def disassociate(self):
        self.calls.append("disassociate")


def facade(interface):
    result = CoreWLANFacade.__new__(CoreWLANFacade)
    result.client = SimpleNamespace(interfaces=lambda: [interface])
    result.module = SimpleNamespace(kCWSecurityNone=0, kCWSecurityWPAPersonal=1,
                                    kCWSecurityWPA2Personal=2, kCWSecurityWPAPersonalMixed=3)
    result.scan_cache = {}
    return result


def test_corewlan_native_selection_memory_only_credentials_and_bounded_cache():
    interface = CWInterface()
    native = facade(interface)
    assert native.inventory()[0]["name"] == "en0"
    assert interface.calls == []
    with pytest.raises(NetworkOperationError):
        native.connect("en0", {"ssid": "Missing", "security": "open"})
    assert interface.calls == ["scan"]
    native.connect("en0", {"ssid": "Example", "security": "wpa-personal", "password": "fake-passphrase"})
    assert interface.calls[-1] == ("associate", "Example", True)
    interface.networks = [CWNetwork("Other" + str(i)) for i in range(300)]
    assert len(native.scan("en0")) == 200
    assert len(native.scan_cache) == 200
    assert not any(network.ssid() == "Example" for _, network in native.scan_cache.values())


def test_corewlan_scan_permission_failure_is_safe():
    interface = CWInterface()
    interface.scanForNetworksWithName_error_ = lambda *a: (None, "private error")
    with pytest.raises(NetworkOperationError) as error:
        facade(interface).scan("en0")
    assert error.value.code == "permission_denied"
    assert "private" not in str(error.value)
