"""Linux native boundaries: NetworkManager/BlueZ D-Bus and administrative ip link."""

import asyncio
import importlib.util
import json
import shutil
import time
import uuid

from .base import NetworkOperationError
from .common import CommandRunner, NativeAdapter, capability_map, empty_inventory, invoke, passive_interfaces

NM = "org.freedesktop.NetworkManager"
ROOT = "/org/freedesktop/NetworkManager"
DEVICE = NM + ".Device"
WIRELESS = DEVICE + ".Wireless"


def unwrap(value):
    if hasattr(value, "value"):
        return unwrap(value.value)
    if isinstance(value, dict):
        return {k: unwrap(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [unwrap(v) for v in value]
    return value


class LinuxNative:
    def __init__(self, *, bus=None, which=shutil.which, runner=None):
        self.bus = bus
        self.has_dbus = bus is not None or importlib.util.find_spec("dbus_next") is not None
        self.ip = which("ip")
        self.commands = CommandRunner(runner) if runner else CommandRunner()
        self.devices = {}
        self.nm_available = self.has_dbus
        self.bluez_available = self.has_dbus
        self.device_states = {}

    def capabilities(self):
        supported = set()
        if self.has_dbus and self.nm_available:
            supported.update(("wifi_scan", "wifi_connect", "wifi_disconnect"))
        if self.has_dbus and self.bluez_available:
            supported.update(("bluetooth_refresh", "bluetooth_connect", "bluetooth_disconnect"))
        if self.ip:
            supported.update(("interface_up", "interface_down"))
        result = capability_map(supported)
        for action in ("wifi_connect", "wifi_disconnect"):
            result[action]["rollback"] = self.has_dbus and self.nm_available
        for action in ("interface_up", "interface_down"):
            result[action]["rollback"] = False
            if self.ip:
                result[action]["reason"] = "Administrative ip link change; requires OS permission, no NetworkManager rollback."
        return result

    async def _bus(self):
        if self.bus is None:
            from dbus_next.aio import MessageBus
            from dbus_next import BusType
            self.bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        return self.bus

    async def call(self, destination, path, interface, member, signature="", body=None):
        from dbus_next import Message, MessageType
        bus = await self._bus()
        reply = await asyncio.wait_for(bus.call(
            Message(destination=destination, path=path, interface=interface,
                    member=member, signature=signature, body=body or [])), timeout=8)
        if reply.message_type == MessageType.ERROR:
            denied = any(word in (reply.error_name or "").lower()
                         for word in ("denied", "authorized", "permission"))
            raise NetworkOperationError(
                "permission_denied" if denied else "provider_unavailable",
                "D-Bus denied access." if denied else "The D-Bus service could not complete the operation.",
            )
        return unwrap(reply.body)

    async def props(self, path, interface, destination=NM):
        return (await self.call(destination, path, "org.freedesktop.DBus.Properties",
                                "GetAll", "s", [interface]))[0]

    async def _nm_inventory(self, result):
        paths = (await self.call(NM, ROOT, NM, "GetDevices"))[0]
        devices = {}
        for path in paths:
            prop = await self.props(path, DEVICE)
            name = prop["Interface"]
            devices[name] = path
            self.device_states[name] = prop.get("State")
            interface = {"name": name, "type": {1: "ethernet", 2: "wifi"}.get(prop.get("DeviceType"), "other"),
                         "is_up": bool(prop.get("InterfaceFlags", 0) & 1)}
            result["interfaces"] = [i for i in result["interfaces"] if i["name"] != name] + [interface]
            if prop.get("DeviceType") == 2:
                wireless = await self.props(path, WIRELESS)
                active = wireless.get("ActiveAccessPoint")
                for ap in wireless.get("AccessPoints", []):
                    access = await self.props(ap, NM + ".AccessPoint")
                    ssid = bytes(access.get("Ssid", [])).decode("utf-8", "replace")
                    # RSN/WPA 802.1X key management is not personal authentication.
                    flags = access.get("RsnFlags", 0) | access.get("WpaFlags", 0)
                    security = "enterprise" if flags & 0x200 else (
                        "wpa-personal" if flags & 0x100 else
                        "unsupported" if access.get("Flags", 0) & 1 else "open")
                    connected = ap == active
                    result["wifi_networks"].append({"id": ap, "interface": name, "ssid": ssid,
                                                   "security": security, "signal": access.get("Strength", 0),
                                                   "connected": connected})
                    if connected:
                        interface["ssid"] = ssid
            details = {"gateways": [], "dns": [], "routes": [], "method": None, "source": "NetworkManager"}
            for family in (4, 6):
                config_path = prop.get(f"Ip{family}Config", "/")
                if config_path == "/":
                    continue
                config = await self.props(config_path, NM + f".IP{family}Config")
                if config.get("Gateway"):
                    details["gateways"].append(config["Gateway"])
                details["routes"].extend(config.get("RouteData", []))
                # Modern NetworkManager exposes textual DNS without endian ambiguity.
                for server in config.get("NameserverData", []):
                    if server.get("address"):
                        details["dns"].append(server["address"])
            active_path = prop.get("ActiveConnection", "/")
            if active_path != "/":
                active = await self.props(active_path, NM + ".Connection.Active")
                connection = active.get("Connection", "/")
                if connection != "/":
                    settings = (await self.call(NM, connection, NM + ".Settings.Connection", "GetSettings"))[0]
                    details["method"] = settings.get("ipv4", {}).get("method")
            result["details"][name] = details
        self.devices = devices

    async def _bluez_inventory(self, result):
        objects = (await self.call("org.bluez", "/", "org.freedesktop.DBus.ObjectManager",
                                   "GetManagedObjects"))[0]
        for path, interfaces in objects.items():
            if "org.bluez.Device1" not in interfaces:
                continue
            prop = interfaces.get("org.bluez.Device1", {})
            result["bluetooth_devices"].append({
                "id": path, "name": prop.get("Alias", prop.get("Name", "Bluetooth device")),
                "paired": bool(prop.get("Paired")), "connected": bool(prop.get("Connected")),
                "transport": "bluetooth", "adapter": prop.get("Adapter"),
            })

    async def inventory(self):
        result = empty_inventory()
        result["interfaces"] = passive_interfaces()
        if self.has_dbus:
            try:
                await self._nm_inventory(result)
                self.nm_available = True
            except Exception:
                self.nm_available = False
                self.devices = {}
                self.device_states = {}
            try:
                await self._bluez_inventory(result)
                self.bluez_available = True
            except Exception:
                self.bluez_available = False
        if self.ip and not result["details"]:
            try:
                routes = json.loads(await self.commands.run([self.ip, "-j", "route", "show", "table", "all"]))
                routes += json.loads(await self.commands.run([self.ip, "-j", "-6", "route", "show", "table", "all"]))
                for interface in result["interfaces"]:
                    records = [r for r in routes if r.get("dev") == interface["name"]]
                    result["details"][interface["name"]] = {
                        "gateways": list(dict.fromkeys(r["gateway"] for r in records if r.get("gateway"))),
                        "dns": [], "routes": records, "method": None, "source": "ip-json (DNS unavailable)",
                    }
            except NetworkOperationError:
                pass
        return result

    async def execute(self, action, params):
        interface = params.get("interface")
        if action.startswith("interface_"):
            await self.commands.run([self.ip, "link", "set", "dev", interface,
                                     "up" if action == "interface_up" else "down"])
            links = json.loads(await self.commands.run([self.ip, "-j", "link", "show", "dev", interface]))
            up = "UP" in links[0].get("flags", []) if links else None
            wanted = action == "interface_up"
            return {"observed": up is wanted, "state": ("up" if wanted else "down") if up is wanted else "requested"}
        if action == "bluetooth_refresh":
            return {"bluetooth_devices": (await self.inventory())["bluetooth_devices"]}
        if action.startswith("bluetooth_"):
            device_id = params["device_id"]
            if action == "bluetooth_connect":
                prop = await self.props(device_id, "org.bluez.Device1", "org.bluez")
                if not prop.get("Paired"):
                    try:
                        await self.call("org.bluez", device_id, "org.bluez.Device1", "Pair")
                    except NetworkOperationError:
                        pass
            await self.call("org.bluez", device_id, "org.bluez.Device1",
                            "Connect" if action == "bluetooth_connect" else "Disconnect")
            prop = await self.props(device_id, "org.bluez.Device1", "org.bluez")
            wanted = action == "bluetooth_connect"
            observed = prop.get("Connected") is wanted
            return {"observed": observed, "state": ("connected" if wanted else "disconnected") if observed else "requested"}
        path = self.devices.get(interface)
        if not path:
            raise NetworkOperationError("invalid", "This interface is not managed by NetworkManager.")
        if action == "wifi_scan":
            before = (await self.props(path, WIRELESS)).get("LastScan", -1)
            await self.call(NM, path, WIRELESS, "RequestScan", "a{sv}", [{}])
            for _ in range(20):
                if (await self.props(path, WIRELESS)).get("LastScan", -1) != before:
                    break
                await asyncio.sleep(0.25)
            return {"wifi_networks": (await self.inventory())["wifi_networks"]}
        if action == "wifi_disconnect":
            await self.call(NM, path, DEVICE, "Disconnect")
        elif action == "wifi_connect":
            security = params.get("security", "saved")
            if security == "saved":
                profiles = (await self.call(NM, ROOT + "/Settings", NM + ".Settings", "ListConnections"))[0]
                matched = None
                for profile in profiles:
                    settings = (await self.call(NM, profile, NM + ".Settings.Connection", "GetSettings"))[0]
                    wifi = settings.get("802-11-wireless", {})
                    connection = settings.get("connection", {})
                    if connection.get("interface-name") not in (None, "", interface):
                        continue
                    if settings.get("802-11-wireless-security", {}).get("key-mgmt") in ("wpa-eap", "ieee8021x"):
                        continue
                    if params.get("profile_id"):
                        match = params["profile_id"] in (profile, connection.get("uuid"))
                    else:
                        match = bytes(wifi.get("ssid", [])).decode("utf-8", "replace") == params.get("ssid")
                    if wifi and match:
                        matched = profile
                        break
                if matched is None:
                    raise NetworkOperationError("invalid", "No compatible saved Wi-Fi profile was found.")
                await self.call(NM, ROOT, NM, "ActivateConnection", "ooo", [matched, path, "/"])
            else:
                from dbus_next import Variant
                settings = {
                    "connection": {"id": Variant("s", params["ssid"]), "uuid": Variant("s", str(uuid.uuid4())),
                                   "type": Variant("s", "802-11-wireless"), "interface-name": Variant("s", interface)},
                    "802-11-wireless": {"ssid": Variant("ay", params["ssid"].encode()), "mode": Variant("s", "infrastructure")},
                    "ipv4": {"method": Variant("s", "auto")}, "ipv6": {"method": Variant("s", "auto")},
                }
                if security == "wpa-personal":
                    settings["802-11-wireless-security"] = {
                        "key-mgmt": Variant("s", "wpa-psk"), "psk": Variant("s", params["password"])}
                # Native system profile storage, not an application credential file.
                await self.call(NM, ROOT, NM, "AddAndActivateConnection", "a{sa{sv}}oo", [settings, path, "/"])
        inventory = await self.inventory()
        row = next((i for i in inventory["interfaces"] if i["name"] == interface), {})
        connected = row.get("ssid")
        observed = (bool(params.get("ssid")) and connected == params["ssid"]) if action == "wifi_connect" else self.device_states.get(interface) == 30
        return {"observed": observed, "state": ("connected" if action == "wifi_connect" else "disconnected") if observed else "requested"}

    async def create_checkpoint(self, interface, timeout):
        path = self.devices.get(interface)
        if not path:
            return None
        try:
            result = await self.call(NM, ROOT, NM, "CheckpointCreate", "aouu", [[path], timeout, 0])
        except NetworkOperationError as exc:
            if exc.code == "provider_unavailable":
                return None
            raise
        return {"id": result[0], "expires_at": time.time() + timeout}

    async def confirm_checkpoint(self, checkpoint_id):
        await self.call(NM, ROOT, NM, "CheckpointDestroy", "o", [checkpoint_id])

    async def revert_checkpoint(self, checkpoint_id):
        outcomes = (await self.call(NM, ROOT, NM, "CheckpointRollback", "o", [checkpoint_id]))[0]
        if any(value != 0 for value in outcomes.values()):
            raise NetworkOperationError("provider_unavailable", "NetworkManager could not restore every checkpoint device.")

    async def close(self):
        if self.bus is not None:
            self.bus.disconnect()
            self.bus = None


class LinuxPlatformAdapter(NativeAdapter):
    platform = "linux"

    def __init__(self, native=None, **kwargs):
        super().__init__(native or LinuxNative(**kwargs))
        self._checkpoints = set()

    async def create_checkpoint(self, interface, timeout=60):
        await self._target("wifi_disconnect", {"interface": interface})
        checkpoint = await invoke(self.native.create_checkpoint, interface, max(1, min(int(timeout), 300)))
        if checkpoint:
            self._checkpoints.add(checkpoint["id"])
        return checkpoint

    async def _checkpoint(self, checkpoint_id, method):
        if checkpoint_id not in self._checkpoints:
            raise NetworkOperationError("invalid", "Unknown checkpoint.")
        await invoke(method, checkpoint_id)
        self._checkpoints.discard(checkpoint_id)

    async def confirm_checkpoint(self, checkpoint_id):
        await self._checkpoint(checkpoint_id, self.native.confirm_checkpoint)

    async def revert_checkpoint(self, checkpoint_id):
        await self._checkpoint(checkpoint_id, self.native.revert_checkpoint)
