"""One process-local action coordinator; native I/O never runs in HTTP handlers."""

import asyncio
import math
import time
import uuid
from collections import OrderedDict
from copy import deepcopy
from datetime import datetime

from app.plugins.network_manager.platforms.base import ACTIONS, NetworkOperationError


class NetworkControlError(NetworkOperationError):
    def __init__(self, code, message, http_status=400):
        super().__init__(code, message)
        self.http_status = http_status


_ERRORS = {
    "unsupported": "This operation is not supported.",
    "permission_denied": "The operating system denied permission.",
    "unavailable": "The network provider is unavailable.",
    "provider_unavailable": "The network provider is unavailable.",
    "timeout": "The native operation timed out; its outcome is unknown.",
    "invalid": "The network provider rejected this request.",
}
_TERMINAL = {"succeeded", "failed", "cancelled", "rolled_back", "expired", "submitted"}
_CHECKPOINT_ACTIONS = {"checkpoint_confirm", "checkpoint_revert"}


def _text(value, limit=256):
    return value[:limit] if isinstance(value, str) else None


def _number(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None

def _redact(value, secret):
    if not secret:
        return value
    if isinstance(value, str):
        return value.replace(secret, "[redacted]")
    if isinstance(value, list):
        return [_redact(item, secret) for item in value]
    if isinstance(value, dict):
        return {_redact(key, secret): _redact(item, secret) for key, item in value.items()}
    return value


def _inventory(data):
    """Schema whitelist: never forward arbitrary native results or parameter maps."""
    data = data if isinstance(data, dict) else {}
    result = {"interfaces": [], "wifi_networks": [], "bluetooth_devices": [], "details": {}}
    schemas = {
        "interfaces": {"name": str, "type": str, "is_up": bool, "ssid": str},
        "wifi_networks": {"id": str, "interface": str, "ssid": str, "security": str,
                          "signal": (int, float), "connected": bool, "profile_id": str},
        "bluetooth_devices": {"id": str, "name": str, "paired": bool, "connected": bool,
                              "transport": str, "adapter": str},
    }
    for key, schema in schemas.items():
        values = data.get(key, [])
        if not isinstance(values, list):
            continue
        for item in values[:256]:
            if not isinstance(item, dict):
                continue
            clean = {}
            for field, kind in schema.items():
                value = item.get(field)
                if kind is str and isinstance(value, str):
                    clean[field] = value[:512]
                elif kind is bool and type(value) is bool:
                    clean[field] = value
                elif isinstance(kind, tuple) and _number(value) is not None:
                    clean[field] = value
            required = "name" if key == "interfaces" else "id"
            if clean.get(required):
                result[key].append(clean)
    details = data.get("details", {})
    if isinstance(details, dict):
        for interface, item in list(details.items())[:256]:
            if not isinstance(interface, str) or not isinstance(item, dict):
                continue
            clean = {"method": _text(item.get("method")), "source": _text(item.get("source"))}
            for key in ("gateways", "dns", "routes"):
                values = item.get(key, [])
                clean[key] = []
                if not isinstance(values, list):
                    continue
                for value in values[:64]:
                    if isinstance(value, str):
                        clean[key].append(value[:512])
                    elif isinstance(value, dict):
                        clean[key].append({
                            field: (_text(raw, 512) if isinstance(raw, str) else raw)
                            for field, raw in value.items()
                            if field in {"address", "gateway", "destination", "prefix", "metric",
                                         "family", "interface", "source", "netmask", "dst", "dev",
                                         "prefsrc", "table", "dest", "next-hop", "DestinationPrefix",
                                         "NextHop", "RouteMetric", "DestinationAddress", "SubnetMask"}
                            and (isinstance(raw, str) or _number(raw) is not None)
                        })
            result["details"][interface[:256]] = clean
    return result


class NetworkController:
    """Own cached inventory and bounded operations on the application's event loop.

    snapshot() only copies an atomically published tree, so monitoring worker
    threads never traverse the mutable operation/inventory structures.
    """

    def __init__(self, adapter, on_change=None, *, refresh_interval=15,
                 native_timeout=20, shutdown_timeout=2, scan_cooldown=10,
                 result_ttl=900, max_results=100, max_pending=8, concurrency=2,
                 checkpoint_timeout=60):
        self.adapter = adapter
        self.on_change = on_change
        self.refresh_interval = max(0.01, refresh_interval)
        self.native_timeout = max(0.01, native_timeout)
        self.shutdown_timeout = max(0.01, shutdown_timeout)
        self.scan_cooldown = max(0, scan_cooldown)
        self.result_ttl = max(0.01, result_ttl)
        self.max_results = min(100, max(1, max_results))
        self.max_pending = min(8, max(1, max_pending))
        self.checkpoint_timeout = min(60, max(1, checkpoint_timeout))
        self._slots = asyncio.Semaphore(min(2, max(1, concurrency)))
        self._operations = OrderedDict()
        self._busy = {}
        self._checkpoints = {}
        self._checkpoint_busy = set()
        self._mutating = set()
        self._cooldowns = {}
        self._jobs = set()
        self._started_jobs = set()
        self._expiry_tasks = set()
        self._native = set()
        self._refresh_task = None
        self._inventory_task = None
        self._accepting = False
        self._closed = False
        self._data = _inventory({})
        self._error = None
        self._published = {}
        self._publish()

    def _capabilities(self):
        try:
            raw = self.adapter.capabilities()
            return {
                action: {
                    "supported": raw.get(action, {}).get("supported") is True,
                    "reason": _text(raw.get(action, {}).get("reason")) or "",
                    **({"rollback": raw[action]["rollback"]}
                       if type(raw.get(action, {}).get("rollback")) is bool else {}),
                } for action in ACTIONS
            }
        except Exception:
            return {action: {"supported": False, "reason": "Provider unavailable."}
                    for action in ACTIONS}

    def _prune(self):
        now = time.time()
        for ident, record in list(self._operations.items()):
            if (record["status"] in _TERMINAL and ident not in self._busy.values()
                    and now - record["updated_at"] > self.result_ttl):
                del self._operations[ident]
        while len(self._operations) > self.max_results:
            removable = next((ident for ident, record in self._operations.items()
                              if record["status"] in _TERMINAL
                              and ident not in self._busy.values()), None)
            if removable is None:
                break
            del self._operations[removable]

    def _publish(self):
        self._prune()
        self._published = deepcopy({
            "platform": _text(getattr(self.adapter, "platform", "unsupported")) or "unsupported",
            "capabilities": self._capabilities(), **self._data,
            "operations": list(self._operations.values()), "updated_at": time.time(),
            **({"error": self._error} if self._error else {}),
        })
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    def snapshot(self):
        snapshot = deepcopy(self._published)
        cutoff = time.time() - self.result_ttl
        snapshot["operations"] = [
            record for record in snapshot["operations"]
            if record["status"] not in _TERMINAL or record["updated_at"] >= cutoff
        ]
        return snapshot

    def get_operation(self, ident):
        return next((record for record in self.snapshot()["operations"]
                     if record["id"] == ident), None)

    async def start(self):
        if self._accepting:
            return
        if self._closed:
            raise NetworkControlError("provider_unavailable", "Network controls are stopped.", 503)
        self._accepting = True
        await self._refresh()
        if self._accepting:
            self._refresh_task = asyncio.create_task(self._refresh_loop())

    async def stop(self):
        if self._closed:
            return
        self._accepting = False
        self._closed = True
        tasks = [*self._jobs, *self._expiry_tasks]
        if self._refresh_task:
            tasks.append(self._refresh_task)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=self.shutdown_timeout)
        native = set(self._native)
        for task in native:
            task.cancel()
        if native:
            await asyncio.wait(native, timeout=self.shutdown_timeout)
        for ident, record in self._operations.items():
            if record["status"] == "pending" and ident not in self._started_jobs:
                record.update(status="cancelled", message="Controller stopped.",
                              updated_at=time.time())
                self._mutating.discard(ident)
                if self._busy.get(record["target"]) == ident:
                    del self._busy[record["target"]]
        self._publish()
        close = asyncio.create_task(self.adapter.close())
        self._track_native(close)
        await asyncio.wait({close}, timeout=self.shutdown_timeout)

    def _track_native(self, task):
        self._native.add(task)

        def done(completed):
            self._native.discard(completed)
            if not completed.cancelled():
                completed.exception()  # Retrieve without exposing native diagnostics.

        task.add_done_callback(done)

    async def _call(self, awaitable, owned):
        task = asyncio.create_task(awaitable)
        owned.append(task)
        self._track_native(task)
        done, _ = await asyncio.wait({task}, timeout=self.native_timeout)
        if not done:
            raise NetworkOperationError("timeout", _ERRORS["timeout"])
        return task.result()

    async def _refresh(self, secret=None):
        # A timed-out read remains the sole read until its native work ends.
        if self._inventory_task and not self._inventory_task.done():
            return
        task = asyncio.create_task(self.adapter.inventory())
        self._inventory_task = task
        self._track_native(task)
        try:
            done, _ = await asyncio.wait({task}, timeout=self.native_timeout)
            if not done:
                self._error = {"code": "timeout", "message": "Inventory refresh timed out."}
            else:
                fresh = _inventory(_redact(task.result(), secret))
                if not fresh["wifi_networks"]:
                    fresh["wifi_networks"] = self._data["wifi_networks"]
                self._data = fresh
                self._error = None
        except asyncio.CancelledError:
            raise
        except Exception:
            self._error = {"code": "provider_unavailable", "message": "Inventory unavailable."}
        self._publish()

    async def _refresh_loop(self):
        while True:
            await asyncio.sleep(self.refresh_interval)
            self._expire_checkpoints()
            await self._refresh()

    @staticmethod
    def _invalid():
        raise NetworkControlError("invalid", "Invalid network action payload.")

    def _validate(self, payload):
        if not isinstance(payload, dict):
            self._invalid()
        action = payload.get("action")
        if not isinstance(action, str) or action not in (*ACTIONS, *_CHECKPOINT_ACTIONS):
            self._invalid()
        allowed = {"action", "confirmed"}
        if action in _CHECKPOINT_ACTIONS:
            allowed.add("operation_id")
        elif action.startswith("wifi_") or action.startswith("interface_"):
            allowed.add("interface")
            if action == "wifi_connect":
                allowed.update(("ssid", "security", "password", "profile_id"))
        elif action in ("bluetooth_connect", "bluetooth_disconnect"):
            allowed.add("device_id")
        if set(payload) - allowed:
            self._invalid()
        if "confirmed" in payload and type(payload["confirmed"]) is not bool:
            self._invalid()
        for field in ("interface", "ssid", "security", "password", "profile_id", "device_id",
                      "operation_id"):
            if field in payload:
                value = payload[field]
                if not isinstance(value, str) or not value or "\x00" in value:
                    self._invalid()
                try:
                    size = len(value.encode("utf-8"))
                except UnicodeError:
                    self._invalid()
                if size > (32 if field == "ssid" else 512):
                    self._invalid()
        if action in {"wifi_connect", "wifi_disconnect", "interface_down",
                      "bluetooth_disconnect", "checkpoint_revert"}:
            if payload.get("confirmed") is not True:
                raise NetworkControlError("confirmation_required",
                                          "Explicit confirmation is required.", 403)
        if action in _CHECKPOINT_ACTIONS:
            ident = payload.get("operation_id")
            if not ident or ident not in self._checkpoints:
                raise NetworkControlError("invalid", "No pending checkpoint for this operation.")
            if ident in self._checkpoint_busy:
                raise NetworkControlError("busy", "Checkpoint operation is already running.", 409)
            if ident in self._mutating:
                raise NetworkControlError("busy", "The guarded native operation is still running.", 409)
            return action, self._operations[ident]["target"]
        if not self._capabilities()[action]["supported"]:
            raise NetworkControlError("unsupported", "This operation is not supported.", 503)
        if action.startswith(("wifi_", "interface_")):
            interface = payload.get("interface")
            item = next((item for item in self._data["interfaces"]
                         if item.get("name") == interface), None)
            if item is None:
                raise NetworkControlError("invalid", "Select an existing interface.")
            if action.startswith("wifi_") and item.get("type") != "wifi":
                raise NetworkControlError("invalid", "Select a Wi-Fi interface.")
            if action == "interface_down" and (
                    item.get("type") == "loopback" or interface == "lo"
                    or (interface.startswith("lo") and interface[2:].isdigit())):
                raise NetworkControlError("invalid", "Loopback cannot be disabled.")
            target = interface
        elif action == "bluetooth_refresh":
            target = "bluetooth"
        else:
            device = next((item for item in self._data["bluetooth_devices"]
                           if item.get("id") == payload.get("device_id")), None)
            if device is None:
                raise NetworkControlError("invalid", "Select a known Bluetooth device.")
            target = "bluetooth:" + device["id"]
        if action == "wifi_connect":
            security = payload.get("security")
            if security not in {"open", "wpa-personal", "saved"} or "ssid" not in payload:
                self._invalid()
            password = payload.get("password")
            if security == "wpa-personal":
                if password is None or not 8 <= len(password.encode("utf-8")) <= 63:
                    self._invalid()
            elif password is not None:
                self._invalid()
            if security != "saved" and "profile_id" in payload:
                self._invalid()
        return action, target

    async def submit(self, payload):
        if not self._accepting:
            raise NetworkControlError("provider_unavailable", "Network controls are stopped.", 503)
        self._expire_checkpoints()
        action, target = self._validate(payload)
        if action not in _CHECKPOINT_ACTIONS and (
                target in self._busy or (target == "bluetooth" and
                                         any(key.startswith("bluetooth:") for key in self._busy))
                or (target.startswith("bluetooth:") and "bluetooth" in self._busy)):
            raise NetworkControlError("busy", "An operation already owns this target.", 409)
        self._prune()
        active = sum(record["status"] in {"pending", "running"} for record in self._operations.values())
        if active >= self.max_pending or (
                action not in _CHECKPOINT_ACTIONS and len(self._busy) >= self.max_pending):
            raise NetworkControlError("capacity", "Too many pending network operations.", 429)
        if len(self._operations) >= self.max_results:
            removable = next((ident for ident, record in self._operations.items()
                              if record["status"] in _TERMINAL
                              and ident not in self._busy.values()), None)
            if removable is None:
                raise NetworkControlError("capacity", "Network operation capacity reached.", 429)
            del self._operations[removable]
        if action in {"wifi_scan", "bluetooth_refresh"}:
            now_mono = time.monotonic()
            self._cooldowns = {key: when for key, when in self._cooldowns.items()
                               if now_mono - when < self.scan_cooldown}
            key = (action, target)
            if now_mono - self._cooldowns.get(key, -math.inf) < self.scan_cooldown:
                raise NetworkControlError("cooldown", "Wait before refreshing this target again.", 429)
            self._cooldowns[key] = now_mono
        ident = uuid.uuid4().hex
        now = time.time()
        record = {"id": ident, "action": action, "target": target, "status": "pending",
                  "created_at": now, "updated_at": now, "message": "Queued."}
        self._operations[ident] = record
        if action in _CHECKPOINT_ACTIONS:
            self._checkpoint_busy.add(payload["operation_id"])
        else:
            self._busy[target] = ident
            self._mutating.add(ident)
        task = asyncio.create_task(self._run(ident, dict(payload)))
        self._jobs.add(task)
        task.add_done_callback(self._jobs.discard)
        self._publish()
        return deepcopy(record)

    def _update(self, ident, status, message, **extra):
        self._operations[ident].update(status=status, message=message, updated_at=time.time(),
                                       **extra)
        self._publish()

    def _expire_checkpoints(self):
        for ident, checkpoint in list(self._checkpoints.items()):
            if checkpoint["expires_at"] <= time.time() and ident not in self._checkpoint_busy:
                del self._checkpoints[ident]
                record = self._operations[ident]
                if ident not in self._mutating and self._busy.get(record["target"]) == ident:
                    del self._busy[record["target"]]
                self._update(ident, "expired", "Checkpoint expired; native rollback is not verified.")
    async def _checkpoint_expiry(self, ident, expires_at):
        await asyncio.sleep(max(0, expires_at - time.time()))
        self._expire_checkpoints()

    async def _run(self, ident, payload):
        self._started_jobs.add(ident)
        record = self._operations[ident]
        action, target = record["action"], record["target"]
        owned = []
        acquired = False
        checkpoint_owner = payload.get("operation_id") if action in _CHECKPOINT_ACTIONS else None
        try:
            await self._slots.acquire()
            acquired = True
            if not self._accepting:
                raise asyncio.CancelledError
            self._update(ident, "running", "Operation in progress.")
            if checkpoint_owner:
                checkpoint = self._checkpoints[checkpoint_owner]
                if checkpoint["expires_at"] <= time.time():
                    raise NetworkOperationError("invalid", "Checkpoint expired.")
                method = (self.adapter.confirm_checkpoint if action == "checkpoint_confirm"
                          else self.adapter.revert_checkpoint)
                await self._call(method(checkpoint["id"]), owned)
                self._checkpoints.pop(checkpoint_owner, None)
                self._busy.pop(target, None)
                observed = checkpoint.get("observed", False)
                status = ("succeeded" if observed else "submitted") if action == "checkpoint_confirm" else "rolled_back"
                self._update(checkpoint_owner, status, "Checkpoint confirmed." if
                             action == "checkpoint_confirm" else "Native checkpoint reverted.")
                self._update(ident, "succeeded", "Checkpoint request completed.")
            else:
                if action in {"wifi_connect", "wifi_disconnect"}:
                    checkpoint = await self._call(
                        self.adapter.create_checkpoint(target, timeout=self.checkpoint_timeout), owned)
                    if (isinstance(checkpoint, dict) and _text(checkpoint.get("id"))
                            and len(checkpoint["id"]) <= 512):
                        expires = checkpoint.get("expires_at")
                        if isinstance(expires, str):
                            expires = datetime.fromisoformat(expires.replace("Z", "+00:00")).timestamp()
                        if _number(expires) is not None and time.time() < expires <= time.time() + 120:
                            self._checkpoints[ident] = {"id": checkpoint["id"],
                                                        "expires_at": expires}
                            record["checkpoint"] = deepcopy(self._checkpoints[ident])
                            timer = asyncio.create_task(self._checkpoint_expiry(ident, expires))
                            self._expiry_tasks.add(timer)
                            timer.add_done_callback(self._expiry_tasks.discard)
                params = {key: value for key, value in payload.items()
                          if key not in {"action", "confirmed"}}
                result = await self._call(self.adapter.execute(action, params), owned)
                result = _redact(result, payload.get("password"))
                if isinstance(result, dict):
                    for key in ("wifi_networks", "bluetooth_devices"):
                        if key in result:
                            self._data[key] = _inventory(result)[key]
                observed = isinstance(result, dict) and result.get("observed") is True
                if ident in self._checkpoints:
                    self._checkpoints[ident]["observed"] = observed
                    status, message = "awaiting_confirmation", "Confirm or revert the native checkpoint."
                elif record["status"] == "expired":
                    status, message = "expired", "Checkpoint expired; native rollback is not verified."
                elif action in {"wifi_scan", "bluetooth_refresh"}:
                    status, message = "succeeded", "Refresh completed."
                else:
                    status = "succeeded" if observed else "submitted"
                    message = "Native state observed." if observed else "Request submitted; state is not verified."
                self._update(ident, status, message)
            await self._refresh(payload.get("password"))
        except asyncio.CancelledError:
            self._update(ident, "cancelled", "Controller stopped; native outcome may be unknown.")
        except Exception as exc:
            code = exc.code if isinstance(exc, NetworkOperationError) else "provider_unavailable"
            code = code if code in _ERRORS else "provider_unavailable"
            self._update(ident, "failed", _ERRORS[code],
                         error={"code": code, "message": _ERRORS[code]})
        finally:
            # Discard credentials before native-drain callbacks retain coordinator state.
            payload.clear()
            pending = {task for task in owned if not task.done()}
            released = False

            def release(_task=None):
                nonlocal released
                if released:
                    return
                if any(not task.done() for task in pending):
                    return
                released = True
                if acquired:
                    self._slots.release()
                if checkpoint_owner:
                    self._checkpoint_busy.discard(checkpoint_owner)
                    self._expire_checkpoints()
                elif ident not in self._checkpoints and self._busy.get(target) == ident:
                    del self._busy[target]
                self._mutating.discard(ident)
                self._started_jobs.discard(ident)
                self._publish()

            if pending:
                # Never unlock a target or semaphore slot while timed-out native
                # work can still mutate it. Native adapters must have own deadlines.
                for task in pending:
                    task.add_done_callback(release)
            else:
                release()
