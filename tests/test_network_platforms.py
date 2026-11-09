import asyncio
import copy
import json
import subprocess
from types import SimpleNamespace

import pytest

from app.plugins.network_manager.platforms import create_platform_adapter
from app.plugins.network_manager.platforms.base import ACTIONS, NetworkOperationError
from app.plugins.network_manager.platforms.common import (
    CommandRunner, NativeAdapter, capability_map, empty_inventory, invoke,
)
from app.plugins.network_manager.platforms.linux import LinuxPlatformAdapter
from app.plugins.network_manager.platforms.macos import MacOSPlatformAdapter
from app.plugins.network_manager.platforms.windows import WindowsPlatformAdapter


def run(coroutine):
    return asyncio.run(coroutine)


class FakeNative:
    def __init__(self):
        self.calls = []
        self.data = empty_inventory()
        self.data["interfaces"] = [{"name": "wlan0", "type": "wifi", "is_up": True},
                                   {"name": "eth0", "type": "ethernet", "is_up": True}]
        self.data["bluetooth_devices"] = [
            {"id": "/paired", "name": "<script>", "paired": True, "connected": False, "transport": "bluetooth"},
            {"id": "/unpaired", "name": "unknown", "paired": False, "connected": False, "transport": "bluetooth"},
        ]

    def capabilities(self):
        return capability_map(ACTIONS)

    async def inventory(self):
        self.calls.append("inventory")
        return self.data

    async def execute(self, action, params):
        self.calls.append((action, params.get("interface"), params.get("device_id")))
        return {"observed": False, "state": "requested"}

    async def create_checkpoint(self, interface, timeout):
        self.calls.append(("checkpoint", interface, timeout))
        return {"id": "/checkpoint/1", "expires_at": 9999}

    async def confirm_checkpoint(self, checkpoint_id):
        self.calls.append(("confirm", checkpoint_id))

    async def revert_checkpoint(self, checkpoint_id):
        self.calls.append(("revert", checkpoint_id))

    async def close(self):
        self.calls.append("close")


@pytest.mark.parametrize("adapter_class", [LinuxPlatformAdapter, MacOSPlatformAdapter, WindowsPlatformAdapter])
def test_contract_copy_safety_no_implicit_scan_and_cleanup(adapter_class):
    native = FakeNative()
    adapter = adapter_class(native=native)
    inventory = run(adapter.inventory())
    inventory["interfaces"][0]["name"] = "changed"
    assert native.data["interfaces"][0]["name"] == "wlan0"
    assert native.calls == ["inventory"]
    caps = adapter.capabilities()
    caps["wifi_connect"]["supported"] = False
    assert adapter.capabilities()["wifi_connect"]["supported"]
    assert run(adapter.execute("wifi_connect", {"interface": "wlan0", "ssid": "safe", "security": "open"})) == {
        "observed": False, "state": "requested"}
    run(adapter.close())
    assert native.calls[-1] == "close"


@pytest.mark.parametrize("action,params", [
    ("interface_down", {"interface": "invented; shutdown"}),
    ("wifi_scan", {"interface": "eth0"}),
    ("wifi_disconnect", {"interface": "--invalid"}),
    ("bluetooth_connect", {"device_id": "/not-inventoried"}),
    ("bluetooth_disconnect", {"device_id": "/arbitrary/object"}),
    ("arbitrary", {}),
])
def test_targets_are_validated_inside_adapter(action, params):
    native = FakeNative()
    with pytest.raises(NetworkOperationError) as error:
        run(NativeAdapter(native).execute(action, params))
    assert error.value.code == "invalid"
    assert all(isinstance(call, str) for call in native.calls)
    assert run(NativeAdapter(native).execute("bluetooth_connect", {"device_id": "/unpaired"})) == {
        "observed": False, "state": "requested"}


@pytest.mark.parametrize("security,password,code", [
    ("enterprise", "irrelevant", "unsupported"),
    ("wpa-personal", "short", "invalid"),
    ("wpa-personal", None, "invalid"),
])
def test_security_validation_does_not_reach_native(security, password, code):
    native = FakeNative()
    with pytest.raises(NetworkOperationError) as error:
        run(NativeAdapter(native).execute("wifi_connect", {
            "interface": "wlan0", "ssid": "test", "security": security, "password": password}))
    assert error.value.code == code
    assert len(native.calls) == 1


def test_missing_capability_rejected_before_native_calls():
    native = FakeNative()
    native.capabilities = lambda: capability_map([])
    with pytest.raises(NetworkOperationError) as error:
        run(NativeAdapter(native).execute("wifi_scan", {"interface": "wlan0"}))
    assert error.value.code == "unsupported"
    assert native.calls == []


@pytest.mark.parametrize("exception,code", [
    (RuntimeError("private credentials and raw output"), "provider_unavailable"),
    (PermissionError("private credentials"), "permission_denied"),
    (subprocess.TimeoutExpired("private", 1), "timeout"),
])
def test_native_error_redaction(exception, code):
    def broken():
        raise exception
    with pytest.raises(NetworkOperationError) as error:
        run(invoke(broken))
    assert error.value.code == code
    assert "private" not in str(error.value)


def test_async_timeout_is_sanitized():
    async def slow():
        await asyncio.sleep(1)
    with pytest.raises(NetworkOperationError) as error:
        run(invoke(slow, timeout=0.001))
    assert error.value.code == "timeout"


def test_subprocess_is_fixed_args_finite_no_shell_and_stdin_json():
    calls = []
    def runner(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout='{"ok":true}')
    assert run(CommandRunner(runner).run(["tool", "--json"], {"interface": "a; unsafe"})) == '{"ok":true}'
    args, kwargs = calls[0]
    assert args == ["tool", "--json"]
    assert json.loads(kwargs["input"]) == {"interface": "a; unsafe"}
    assert kwargs["shell"] is False and kwargs["timeout"] == 8


def test_failed_command_discards_stderr_and_stdout():
    runner = lambda *a, **k: SimpleNamespace(returncode=1, stdout="private", stderr="private")
    with pytest.raises(NetworkOperationError) as error:
        run(CommandRunner(runner).run(["tool"]))
    assert "private" not in str(error.value)


def test_real_checkpoint_only_known_ids_confirm_and_revert():
    native = FakeNative()
    adapter = LinuxPlatformAdapter(native=native)
    with pytest.raises(NetworkOperationError):
        run(adapter.confirm_checkpoint("/arbitrary"))
    assert run(adapter.create_checkpoint("wlan0", 1000))["id"] == "/checkpoint/1"
    assert ("checkpoint", "wlan0", 300) in native.calls
    run(adapter.confirm_checkpoint("/checkpoint/1"))
    with pytest.raises(NetworkOperationError):
        run(adapter.revert_checkpoint("/checkpoint/1"))
    run(adapter.create_checkpoint("wlan0"))
    run(adapter.revert_checkpoint("/checkpoint/1"))


def test_no_checkpoint_for_ethernet_and_unsupported_os():
    adapter = LinuxPlatformAdapter(native=FakeNative())
    with pytest.raises(NetworkOperationError):
        run(adapter.create_checkpoint("eth0"))
    unsupported = create_platform_adapter("Other")
    assert not any(c["supported"] for c in unsupported.capabilities().values())
    with pytest.raises(NetworkOperationError):
        run(unsupported.execute("interface_up", {}))


@pytest.mark.parametrize("system,expected", [("Linux", "linux"), ("Darwin", "macos"), ("Windows", "windows")])
def test_factory_does_not_touch_native_until_called(system, expected):
    native = FakeNative()
    adapter = create_platform_adapter(system, native=native)
    assert adapter.platform == expected and native.calls == []
