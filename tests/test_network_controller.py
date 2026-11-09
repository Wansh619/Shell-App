import asyncio
import json
import time
from copy import deepcopy

import pytest
from quart import Quart

from app.plugins.network_manager.control_routes import create_control_routes
from app.plugins.network_manager.controller import NetworkController, NetworkControlError
from app.plugins.network_manager.platforms.base import ACTIONS, NetworkOperationError


class FakeAdapter:
    platform = "fake"

    def __init__(self):
        self.calls = []
        self.inventory_calls = 0
        self.closed = False
        self.gate = None
        self.observed = False
        self.uncancellable = False
        self.inventory_failure = False
        self.failure = None
        self.checkpoint_lifetime = None
        self.checkpoint_calls = []
        self.supported = True
        self.active = self.peak = 0
        self.data = {
            "interfaces": [
                {"name": "wlan0", "type": "wifi", "is_up": True},
                {"name": "eth0", "type": "ethernet", "is_up": True},
                {"name": "lo", "type": "loopback", "is_up": True},
            ],
            "wifi_networks": [],
            "bluetooth_devices": [
                {"id": "paired", "name": "Known", "paired": True, "connected": False,
                 "transport": "classic"},
                {"id": "unknown", "name": "Not paired", "paired": False},
            ],
            "details": {"wlan0": {"gateways": ["192.0.2.1"], "dns": ["192.0.2.53"],
                                   "routes": [], "method": None, "source": "fake"}},
        }

    def capabilities(self):
        return {action: {"supported": self.supported, "reason": "", "rollback": True}
                for action in ACTIONS}

    async def inventory(self):
        self.inventory_calls += 1
        if self.inventory_failure:
            raise OSError("native credentials not public")
        return deepcopy(self.data)

    async def execute(self, action, params):
        self.calls.append((action, dict(params)))
        self.active += 1
        self.peak = max(self.active, self.peak)
        try:
            if self.gate:
                try:
                    await self.gate.wait()
                except asyncio.CancelledError:
                    if not self.uncancellable:
                        raise
                    await self.gate.wait()
            if self.failure:
                raise self.failure
            if action == "wifi_scan":
                return {"wifi_networks": [{"id": "ap", "interface": "wlan0", "ssid": "<AP>",
                                           "security": "open", "signal": -42,
                                           "profile_id": "saved-prof-1",
                                           "password": "never-return"}]}
            return {"observed": self.observed, "state": "connected",
                    "password": params.get("password"), "message": params.get("password")}
        finally:
            self.active -= 1

    async def create_checkpoint(self, interface, timeout=60):
        if self.checkpoint_lifetime is None:
            return None
        return {"id": "native-owned", "expires_at": time.time() + self.checkpoint_lifetime}

    async def confirm_checkpoint(self, ident):
        self.checkpoint_calls.append(("confirm", ident))

    async def revert_checkpoint(self, ident):
        self.checkpoint_calls.append(("revert", ident))

    async def close(self):
        self.closed = True


async def settle(controller):
    for _ in range(200):
        if not controller._jobs:
            return
        await asyncio.sleep(0.001)
    raise AssertionError("Controller tasks did not settle")


async def wait_for(predicate):
    for _ in range(200):
        if predicate():
            return
        await asyncio.sleep(0.001)
    raise AssertionError("Expected condition not reached")


def wifi_payload(**updates):
    return {"action": "wifi_connect", "interface": "wlan0", "ssid": "Example",
            "security": "wpa-personal", "password": "test-only-credential",
            "confirmed": True, **updates}


def test_start_cache_is_copy_safe_bounded_and_does_not_scan():
    async def verify():
        adapter = FakeAdapter()
        adapter.data["password"] = "never-return"
        adapter.data["details"]["wlan0"]["password"] = "never-return"
        changes = []
        controller = NetworkController(adapter, on_change=lambda: changes.append(True),
                                       refresh_interval=0.02)
        await controller.start()
        await controller.start()
        snapshot = await asyncio.to_thread(controller.snapshot)
        snapshot["interfaces"][0]["name"] = "changed"
        snapshot["details"]["wlan0"]["gateways"].clear()
        assert controller.snapshot()["interfaces"][0]["name"] == "wlan0"
        assert controller.snapshot()["details"]["wlan0"]["gateways"] == ["192.0.2.1"]
        assert "password" not in json.dumps(controller.snapshot())
        await asyncio.sleep(0.045)
        assert adapter.inventory_calls >= 2
        assert not adapter.calls
        assert changes
        await controller.stop()
        assert adapter.closed
        with pytest.raises(NetworkControlError) as exc:
            await controller.submit({"action": "interface_up", "interface": "eth0"})
        assert exc.value.http_status == 503
    asyncio.run(verify())


@pytest.mark.parametrize("observed,expected", [(False, "submitted"), (True, "succeeded")])
def test_pending_then_native_observation_only(observed, expected):
    async def verify():
        adapter = FakeAdapter()
        adapter.observed = observed
        controller = NetworkController(adapter, shutdown_timeout=0.01)
        await controller.start()
        record = await controller.submit(wifi_payload())
        assert record["status"] == "pending"
        assert "password" not in json.dumps(record)
        await settle(controller)
        result = controller.get_operation(record["id"])
        assert result["status"] == expected
        assert "test-only-credential" not in json.dumps(controller.snapshot())
        assert adapter.calls[0][1]["password"] == "test-only-credential"
        await controller.stop()
    asyncio.run(verify())


@pytest.mark.parametrize("payload,status", [
    ([], 400), (None, 400), ({}, 400), ({"action": []}, 400),
    ({"action": "shell"}, 400),
    ({"action": "interface_up"}, 400),
    ({"action": "wifi_scan", "interface": "eth0"}, 400),
    ({"action": "wifi_scan", "interface": "*"}, 400),
    ({"action": "wifi_scan", "interface": "wlan0", "password": "no"}, 400),
    ({"action": "interface_down", "interface": "lo", "confirmed": True}, 400),
    ({"action": "interface_down", "interface": "eth0"}, 403),
    ({"action": "wifi_disconnect", "interface": "wlan0", "confirmed": 1}, 400),
    ({"action": "bluetooth_disconnect", "device_id": "unknown"}, 403),
    ({"action": "bluetooth_connect", "device_id": "not-known"}, 400),
    (wifi_payload(confirmed=False), 403),
    (wifi_payload(ssid="é" * 17), 400),
    (wifi_payload(password="short"), 400),
    (wifi_payload(password="z" * 64), 400),
    (wifi_payload(password="a" * 64), 400),
    (wifi_payload(password="a" * 65), 400),
    (wifi_payload(security="enterprise"), 400),
    (wifi_payload(security="open"), 400),
    (wifi_payload(security="saved"), 400),
    (wifi_payload(extra="ignored?"), 400),
    ({"action": "checkpoint_confirm", "operation_id": "/native/arbitrary"}, 400),
])
def test_strict_payload_target_and_confirmation_validation(payload, status):
    async def verify():
        controller = NetworkController(FakeAdapter())
        await controller.start()
        with pytest.raises(NetworkControlError) as exc:
            await controller.submit(payload)
        assert exc.value.http_status == status
        assert controller.snapshot()["operations"] == []
        await controller.stop()
    asyncio.run(verify())


def test_conflict_limit_global_concurrency_and_cancellation():
    async def verify():
        adapter = FakeAdapter()
        adapter.gate = asyncio.Event()
        adapter.uncancellable = True
        adapter.data["interfaces"] += [
            {"name": f"eth{i}", "type": "ethernet", "is_up": True} for i in range(1, 9)
        ]
        controller = NetworkController(adapter, shutdown_timeout=0.01)
        await controller.start()
        records = []
        for index in range(8):
            records.append(await controller.submit({"action": "interface_up",
                                                     "interface": f"eth{index}"}))
        await wait_for(lambda: adapter.active == 2)
        assert adapter.peak == 2
        with pytest.raises(NetworkControlError) as exc:
            await controller.submit({"action": "interface_up", "interface": "eth0"})
        assert exc.value.http_status == 409
        with pytest.raises(NetworkControlError) as exc:
            await controller.submit({"action": "interface_up", "interface": "eth8"})
        assert exc.value.http_status == 429
        await controller.stop()
        assert all(controller.get_operation(record["id"])["status"] == "cancelled"
                   for record in records)
        assert "eth0" in controller._busy  # Uncancelled native work still owns target.
        adapter.gate.set()
        await wait_for(lambda: not controller._busy)
        assert adapter.closed
    asyncio.run(verify())


def test_native_timeout_retains_conflict_and_global_slot_until_completion():
    async def verify():
        adapter = FakeAdapter()
        adapter.gate = asyncio.Event()
        controller = NetworkController(adapter, native_timeout=0.015, concurrency=1)
        await controller.start()
        first = await controller.submit({"action": "interface_up", "interface": "eth0"})
        await settle(controller)
        assert controller.get_operation(first["id"])["error"]["code"] == "timeout"
        with pytest.raises(NetworkControlError) as exc:
            await controller.submit({"action": "interface_down", "interface": "eth0",
                                     "confirmed": True})
        assert exc.value.http_status == 409
        second = await controller.submit({"action": "interface_up", "interface": "wlan0"})
        await asyncio.sleep(0.02)
        assert controller.get_operation(second["id"])["status"] == "pending"
        assert len(adapter.calls) == 1
        adapter.gate.set()
        await settle(controller)
        assert controller.get_operation(first["id"])["status"] == "failed"
        assert controller.get_operation(second["id"])["status"] == "submitted"
        await controller.stop()
    asyncio.run(verify())


def test_scan_is_explicit_cached_and_cooled_down():
    async def verify():
        adapter = FakeAdapter()
        controller = NetworkController(adapter)
        await controller.start()
        record = await controller.submit({"action": "wifi_scan", "interface": "wlan0"})
        await settle(controller)
        assert controller.get_operation(record["id"])["status"] == "succeeded"
        assert controller.snapshot()["wifi_networks"][0]["ssid"] == "<AP>"
        assert controller.snapshot()["wifi_networks"][0]["profile_id"] == "saved-prof-1"
        assert "never-return" not in json.dumps(controller.snapshot())
        bt_record = await controller.submit({"action": "bluetooth_connect", "device_id": "unknown"})
        await settle(controller)
        assert controller.get_operation(bt_record["id"])["status"] == "submitted"
        with pytest.raises(NetworkControlError) as exc:
            await controller.submit({"action": "wifi_scan", "interface": "wlan0"})
        assert exc.value.code == "cooldown" and exc.value.http_status == 429
        await controller.stop()
    asyncio.run(verify())


@pytest.mark.parametrize("action,expected", [
    ("checkpoint_confirm", "submitted"), ("checkpoint_revert", "rolled_back"),
])
def test_checkpoint_is_owned_and_confirmation_does_not_invent_connected_state(action, expected):
    async def verify():
        adapter = FakeAdapter()
        adapter.checkpoint_lifetime = 1
        controller = NetworkController(adapter)
        await controller.start()
        original = await controller.submit(wifi_payload())
        await settle(controller)
        assert controller.get_operation(original["id"])["status"] == "awaiting_confirmation"
        with pytest.raises(NetworkControlError) as exc:
            await controller.submit({"action": "interface_up", "interface": "wlan0"})
        assert exc.value.http_status == 409
        followup = await controller.submit({"action": action, "operation_id": original["id"],
                                            "confirmed": True})
        await settle(controller)
        assert controller.get_operation(original["id"])["status"] == expected
        assert controller.get_operation(followup["id"])["status"] == "succeeded"
        assert adapter.checkpoint_calls == [
            ("confirm" if action == "checkpoint_confirm" else "revert", "native-owned")]
        with pytest.raises(NetworkControlError):
            await controller.submit({"action": action, "operation_id": original["id"],
                                     "confirmed": True})
        await controller.stop()
    asyncio.run(verify())


def test_checkpoint_expiry_does_not_claim_rollback_or_unlock_active_mutation():
    async def verify():
        adapter = FakeAdapter()
        adapter.gate = asyncio.Event()
        adapter.checkpoint_lifetime = 0.02
        controller = NetworkController(adapter, native_timeout=0.1)
        await controller.start()
        original = await controller.submit(wifi_payload())
        await wait_for(lambda: bool(adapter.calls))
        with pytest.raises(NetworkControlError) as exc:
            await controller.submit({"action": "checkpoint_confirm", "operation_id": original["id"]})
        assert exc.value.http_status == 409
        await asyncio.sleep(0.03)
        assert controller.get_operation(original["id"])["status"] == "expired"
        assert not adapter.checkpoint_calls
        with pytest.raises(NetworkControlError) as exc:
            await controller.submit({"action": "interface_up", "interface": "wlan0"})
        assert exc.value.http_status == 409
        adapter.gate.set()
        await settle(controller)
        assert controller.get_operation(original["id"])["status"] == "expired"
        assert "wlan0" not in controller._busy
        await controller.stop()
    asyncio.run(verify())


@pytest.mark.parametrize("failure", [
    RuntimeError("test-only-credential native diagnostic"),
    NetworkOperationError("permission_denied", "test-only-credential unsafe message"),
])
def test_errors_never_reflect_native_exception_or_parameters(failure):
    async def verify():
        adapter = FakeAdapter()
        adapter.failure = failure
        controller = NetworkController(adapter)
        await controller.start()
        record = await controller.submit(wifi_payload())
        await settle(controller)
        assert controller.get_operation(record["id"])["status"] == "failed"
        serialized = json.dumps(controller.snapshot())
        assert "test-only-credential" not in serialized
        assert "unsafe" not in serialized and "diagnostic" not in serialized
        await controller.stop()
    asyncio.run(verify())


def test_result_capacity_ttl_and_unsupported():
    async def verify():
        adapter = FakeAdapter()
        controller = NetworkController(adapter, max_results=3, result_ttl=0.02)
        await controller.start()
        for _ in range(5):
            await controller.submit({"action": "interface_up", "interface": "eth0"})
            await settle(controller)
        assert len(controller.snapshot()["operations"]) <= 3
        await asyncio.sleep(0.03)
        assert not controller.snapshot()["operations"]
        adapter.supported = False
        with pytest.raises(NetworkControlError) as exc:
            await controller.submit({"action": "interface_up", "interface": "eth0"})
        assert exc.value.http_status == 503
        await controller.stop()
    asyncio.run(verify())


def test_immediate_stop_marks_not_yet_started_jobs_cancelled():
    async def verify():
        controller = NetworkController(FakeAdapter())
        await controller.start()
        record = await controller.submit({"action": "interface_up", "interface": "eth0"})
        await controller.stop()
        assert controller.get_operation(record["id"])["status"] == "cancelled"
        assert not controller._busy
    asyncio.run(verify())


def test_initial_inventory_failure_is_safe_and_background_retry_recovers():
    async def verify():
        adapter = FakeAdapter()
        adapter.inventory_failure = True
        controller = NetworkController(adapter, refresh_interval=0.015)
        await controller.start()
        assert controller.snapshot()["error"]["code"] == "provider_unavailable"
        assert "native credentials" not in json.dumps(controller.snapshot())
        adapter.inventory_failure = False
        await wait_for(lambda: bool(controller.snapshot()["interfaces"]))
        assert "error" not in controller.snapshot()
        assert not adapter.calls
        await controller.stop()
        await controller.stop()
        with pytest.raises(NetworkControlError):
            await controller.start()
    asyncio.run(verify())


def test_inventory_deadline_prevents_overlapping_reads_and_shutdown_is_finite():
    async def verify():
        adapter = FakeAdapter()
        gate = asyncio.Event()
        calls = []

        async def inventory():
            calls.append(True)
            await gate.wait()
            return adapter.data

        async def close():
            await gate.wait()

        adapter.inventory = inventory
        adapter.close = close
        controller = NetworkController(adapter, native_timeout=0.01,
                                       refresh_interval=0.01, shutdown_timeout=0.01)
        await controller.start()
        assert controller.snapshot()["error"]["code"] == "timeout"
        await asyncio.sleep(0.03)
        assert len(calls) == 1
        started = time.monotonic()
        await controller.stop()
        assert time.monotonic() - started < 0.15
        gate.set()
        await asyncio.sleep(0)
    asyncio.run(verify())


def test_known_string_fields_redact_accidentally_echoed_password():
    async def verify():
        adapter = FakeAdapter()

        async def execute(action, params):
            return {"observed": False, "wifi_networks": [
                {"id": "id", "ssid": params["password"], "interface": "wlan0",
                 "password": params["password"], "security": "open", "signal": -40}
            ]}

        adapter.execute = execute
        controller = NetworkController(adapter)
        await controller.start()
        await controller.submit(wifi_payload())
        await settle(controller)
        snapshot = controller.snapshot()
        assert "test-only-credential" not in json.dumps(snapshot)
        assert snapshot["wifi_networks"][0]["ssid"] == "[redacted]"
        await controller.stop()
    asyncio.run(verify())


@pytest.mark.parametrize("security,profile", [("saved", None), ("saved", "profile-id"), ("open", None)])
def test_saved_profile_id_is_optional_and_open_needs_no_password(security, profile):
    async def verify():
        controller = NetworkController(FakeAdapter())
        await controller.start()
        payload = {"action": "wifi_connect", "interface": "wlan0", "ssid": "é" * 16,
                   "security": security, "confirmed": True}
        if profile:
            payload["profile_id"] = profile
        record = await controller.submit(payload)
        await settle(controller)
        assert controller.get_operation(record["id"])["status"] == "submitted"
        await controller.stop()
    asyncio.run(verify())


def test_http_contract_integrity_origin_json_and_cached_gets():
    async def verify():
        adapter = FakeAdapter()
        controller = NetworkController(adapter)
        await controller.start()
        app = Quart(__name__)
        app.register_blueprint(create_control_routes(controller))
        client = app.test_client()
        endpoint = "/api/network-manager/actions"
        payload = {"action": "interface_up", "interface": "eth0"}
        headers = {"X-Network-Control": "1"}
        before = adapter.inventory_calls
        response = await client.get("/api/network-manager/control")
        assert (await response.get_json())["platform"] == "fake"
        assert adapter.inventory_calls == before
        for bad in [
            {}, {"X-Network-Control": "0"},
            {**headers, "Origin": "https://evil.example"},
            {**headers, "Origin": "null"},
            {**headers, "Origin": "https://localhost.evil"},
            {**headers, "Origin": "https://localhost", "Sec-Fetch-Site": "cross-site"},
            {**headers, "Origin": "https://evil.example", "X-Forwarded-Host": "evil.example"},
        ]:
            response = await client.post(endpoint, json=payload, headers=bad)
            assert response.status_code == 403
            assert set(await response.get_json()) == {"error"}
        for raw in ['[]', 'null', '{', '{"action":"interface_up","action":"wifi_scan"}',
                    '{"action":NaN}', '{"padding":"' + "x" * 8192 + '"}']:
            response = await client.post(endpoint, data=raw, headers={
                **headers, "Content-Type": "application/json"})
            assert response.status_code == 400
            assert (await response.get_json())["error"]["code"] == "invalid"
        response = await client.post(endpoint, data="{}", headers=headers)
        assert response.status_code == 400
        response = await client.post(endpoint, json=payload, headers={
            **headers, "Origin": "https://localhost"})
        assert response.status_code == 202  # TLS proxy can use an internal HTTP app.
        record = (await response.get_json())["operation"]
        assert record["status"] == "pending"
        await settle(controller)
        response = await client.get("/api/network-manager/operations/" + record["id"])
        assert response.status_code == 200
        assert (await response.get_json())["status"] == "submitted"
        response = await client.get("/api/network-manager/operations/not-present")
        assert response.status_code == 404
        app.config["SHELL_APP_NETWORK_PUBLIC_ORIGIN"] = "https://public.example:8443"
        response = await client.post(endpoint, json=payload, headers={
            **headers, "Origin": "https://public.example:8443"})
        assert response.status_code == 202
        await settle(controller)
        response = await client.post(endpoint, json=payload, headers={
            **headers, "Origin": "https://public.example"})
        assert response.status_code == 403
        await controller.stop()
    asyncio.run(verify())
