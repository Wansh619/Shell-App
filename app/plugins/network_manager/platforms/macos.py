"""Optional CoreWLAN and paired-only blueutil; no active discovery in inventory."""

import hashlib
import importlib.util
import json
import plistlib
import shutil
from pathlib import Path

from .base import NetworkOperationError
from .common import CommandRunner, NativeAdapter, capability_map, empty_inventory, invoke, passive_interfaces


class CoreWLANFacade:
    def __init__(self, preferred_Lookup=None):
        import CoreWLAN
        self.module = CoreWLAN
        self.client = CoreWLAN.CWWiFiClient.sharedWiFiClient()
        self.scan_cache = {}
        self.preferred_lookup = preferred_Lookup

    def interfaces(self):
        return {str(item.interfaceName()): item for item in self.client.interfaces() or [] if item.interfaceName()}

    def _security_kind(self, network):
        try:
            none_sec = getattr(self.module, "kCWSecurityNone", None)
            if none_sec is not None and network.supportsSecurity_(none_sec):
                return "open"
            for key in ("kCWSecurityEnterprise", "kCWSecurityWPAEnterprise",
                        "kCWSecurityWPA2Enterprise", "kCWSecurityWPAEnterpriseMixed",
                        "kCWSecurityWPA3Enterprise"):
                sec = getattr(self.module, key, None)
                if sec is not None and network.supportsSecurity_(sec):
                    return "enterprise"
            for key in ("kCWSecurityWPAPersonal", "kCWSecurityWPA2Personal",
                        "kCWSecurityWPAPersonalMixed", "kCWSecurityWPA3Personal",
                        "kCWSecurityWPA3Transition"):
                sec = getattr(self.module, key, None)
                if sec is not None and network.supportsSecurity_(sec):
                    return "wpa-personal"
        except Exception:
            pass
        return "wpa-personal"

    def _preferred_ssids(self, name, interface):
        ssids = []
        try:
            cfg = interface.configuration() if hasattr(interface, "configuration") else None
            if cfg and cfg.networkProfiles():
                for prof in cfg.networkProfiles():
                    if prof.ssid():
                        ssids.append(str(prof.ssid()))
        except Exception:
            pass
        lookup = getattr(self, "preferred_lookup", None)
        if lookup:
            try:
                for s in lookup(name):
                    if s and s not in ssids:
                        ssids.append(s)
            except Exception:
                pass
        return ssids[:40]

    def inventory(self):
        return [{"name": str(name), "type": "wifi", "is_up": bool(item.powerOn()),
                 "ssid": str(item.ssid()) if item.ssid() is not None else None}
                for name, item in self.interfaces().items()]

    def scan(self, name):
        interface = self.interfaces()[name]
        networks, error = interface.scanForNetworksWithName_error_(None, None)
        if error is not None:
            raise NetworkOperationError("permission_denied", "Wi-Fi scanning requires macOS Wi-Fi and location permission.")
        rows = []
        seen_ssids = set()
        self.scan_cache = {key: value for key, value in self.scan_cache.items() if value[0] != name}
        active_ssid = str(interface.ssid()) if interface.ssid() is not None else None
        preferred = self._preferred_ssids(name, interface)
        redacted_networks = []

        for network in list(networks or [])[:200]:
            raw_ssid = network.ssid()
            ssid = str(raw_ssid) if raw_ssid is not None else None
            if ssid is None:
                redacted_networks.append(network)
                continue
            if ssid in seen_ssids:
                continue
            seen_ssids.add(ssid)
            security = self._security_kind(network)
            bssid = str(network.bssid() or "") if hasattr(network, "bssid") else ""
            key = hashlib.sha256((name + "\0" + ssid + "\0" + bssid).encode()).hexdigest()
            self.scan_cache[key] = (name, network)
            rows.append({
                "id": key,
                "interface": str(name),
                "ssid": ssid,
                "security": security,
                "signal": max(0, min(100, 2 * (int(network.rssiValue()) + 100))),
                "connected": active_ssid == ssid,
            })

        # When macOS Location Services redacts CWNetwork.ssid(), pair live RF measurements
        # with the user's known wireless networks on this interface.
        redacted_networks.sort(key=lambda n: int(n.rssiValue()) if hasattr(n, "rssiValue") else -100, reverse=True)
        for idx, saved_ssid in enumerate(preferred):
            if saved_ssid in seen_ssids:
                continue
            seen_ssids.add(saved_ssid)
            matched_net = redacted_networks[idx] if idx < len(redacted_networks) else None
            rssi = int(matched_net.rssiValue()) if matched_net is not None and hasattr(matched_net, "rssiValue") else None
            signal = max(0, min(100, 2 * (rssi + 100))) if rssi is not None else 0
            security = self._security_kind(matched_net) if matched_net is not None else "saved"
            is_conn = (active_ssid == saved_ssid) or (active_ssid is None and idx == 0 and matched_net is not None and bool(interface.powerOn()))
            key = hashlib.sha256((name + "\0" + saved_ssid).encode()).hexdigest()
            if matched_net is not None:
                self.scan_cache[key] = (name, matched_net)
            rows.append({
                "id": key,
                "interface": str(name),
                "ssid": saved_ssid,
                "security": security,
                "signal": signal,
                "connected": is_conn,
            })

        self.scan_cache = dict(list(self.scan_cache.items())[-400:])
        return rows

    def connect(self, name, params):
        target_ssid = params.get("ssid")
        candidates = [network for interface, network in self.scan_cache.values()
                      if interface == name and network.ssid() == target_ssid]
        if not candidates:
            self.scan(name)
            candidates = [network for interface, network in self.scan_cache.values()
                          if interface == name and (network.ssid() == target_ssid or network.ssid() is None)]
        if not candidates:
            raise NetworkOperationError("invalid", "Explicitly refresh Wi-Fi networks before connecting.")
        password = params.get("password") if params.get("security") == "wpa-personal" else None
        success, error = self.interfaces()[name].associateToNetwork_password_error_(candidates[0], password, None)
        if not success:
            raise NetworkOperationError("permission_denied", "macOS could not associate; check credentials and permissions.")

    def disconnect(self, name):
        self.interfaces()[name].disassociate()


class MacOSNative:
    def __init__(self, *, wlan=None, which=shutil.which, runner=None, configuration=None):
        self.wlan = wlan
        self.has_wlan = wlan is not None or importlib.util.find_spec("CoreWLAN") is not None
        self.configuration = configuration
        self.has_configuration = configuration is not None or importlib.util.find_spec("SystemConfiguration") is not None
        self.ifconfig = which("ifconfig")
        self.blueutil = which("blueutil")
        self.system_profiler = which("system_profiler") if runner is None else None
        self.networksetup = which("networksetup") if runner is None else None
        self.commands = CommandRunner(runner) if runner else CommandRunner()
        self.networks = []

    def capabilities(self):
        supported = set()
        if self.has_wlan:
            supported.update(("wifi_scan", "wifi_connect", "wifi_disconnect"))
        if self.ifconfig:
            supported.update(("interface_up", "interface_down"))
        if self.blueutil:
            supported.update(("bluetooth_refresh", "bluetooth_connect", "bluetooth_disconnect"))
        elif self.system_profiler:
            supported.add("bluetooth_refresh")
        result = capability_map(supported)
        for value in result.values():
            value["rollback"] = False
        if self.has_wlan:
            result["wifi_connect"]["reason"] = "CoreWLAN open/WPA-personal association after explicit scan; saved Keychain association depends on OS access."
        else:
            for action in ("wifi_scan", "wifi_connect", "wifi_disconnect"):
                result[action]["reason"] = "Install pyobjc-framework-CoreWLAN to enable macOS Wi-Fi controls."
        if not self.blueutil:
            if self.system_profiler:
                result["bluetooth_refresh"]["reason"] = "Paired device discovery via macOS system_profiler."
            for action in ("bluetooth_connect", "bluetooth_disconnect"):
                result[action]["reason"] = "Install 'blueutil' (brew install blueutil) to connect or disconnect paired Bluetooth devices on macOS."
        return result

    def _preferred_networks_sync(self, interface_name):
        if not self.networksetup:
            return []
        try:
            import subprocess
            res = subprocess.run(
                [self.networksetup, "-listpreferredwirelessnetworks", interface_name],
                capture_output=True, text=True, timeout=4, check=False,
            )
            if res.returncode != 0:
                return []
            lines = [line.strip() for line in res.stdout.splitlines()[1:] if line.strip()]
            return lines[:40]
        except Exception:
            return []

    def _wlan(self):
        if self.wlan is None:
            self.wlan = CoreWLANFacade(preferred_Lookup=self._preferred_networks_sync if self.networksetup else None)
        return self.wlan

    def _details(self, names):
        if not self.has_configuration:
            return {name: {"gateways": [], "dns": [], "routes": [], "method": None,
                           "source": "SystemConfiguration unavailable"} for name in names}
        if self.configuration is None:
            import SystemConfiguration
            self.configuration = SystemConfiguration
        sc = self.configuration
        store = sc.SCDynamicStoreCreate(None, "ShellAppNetwork", None, None)
        result = {name: {"gateways": [], "dns": [], "routes": [], "method": None,
                         "source": "SystemConfiguration cached state"} for name in names}
        for key in sc.SCDynamicStoreCopyKeyList(store, r"State:/Network/Service/.*/IPv[46]") or []:
            value = sc.SCDynamicStoreCopyValue(store, key) or {}
            name = value.get("InterfaceName")
            if name not in result:
                continue
            detail = result[name]
            if value.get("Router"):
                detail["gateways"].append(value["Router"])
            detail["routes"].extend(value.get("AdditionalRoutes", []))
            service = key.rsplit("/", 1)[0]
            dns = sc.SCDynamicStoreCopyValue(store, service + "/DNS") or {}
            detail["dns"] = list(dict.fromkeys(detail["dns"] + list(dns.get("ServerAddresses", []))))
            setup = sc.SCDynamicStoreCopyValue(store, service.replace("State:", "Setup:") + "/" + key.rsplit("/", 1)[1]) or {}
            detail["method"] = setup.get("ConfigMethod")
        return result

    async def _bluetooth(self):
        if self.blueutil:
            devices = json.loads(await self.commands.run([self.blueutil, "--paired", "--format", "json"]))
            return [{"id": str(d["address"]), "name": str(d.get("name") or "Bluetooth device"),
                     "paired": bool(d.get("paired", True)),
                     "connected": bool(d.get("connected")), "transport": "bluetooth"}
                    for d in devices if isinstance(d, dict) and d.get("address")]
        if self.system_profiler:
            payload = json.loads(await self.commands.run([self.system_profiler, "SPBluetoothDataType", "-json"]))
            rows = []
            for section in payload.get("SPBluetoothDataType", []) if isinstance(payload, dict) else []:
                if not isinstance(section, dict):
                    continue
                for group_key, connected in (("device_connected", True), ("device_not_connected", False), ("device_title", False)):
                    group = section.get(group_key, [])
                    if not isinstance(group, list):
                        continue
                    for entry in group:
                        if not isinstance(entry, dict):
                            continue
                        for name, info in entry.items():
                            if not isinstance(info, dict):
                                continue
                            addr = info.get("device_address") or name
                            is_conn = connected or str(info.get("device_connected", "")).lower() in ("attrib_yes", "yes", "true", "1")
                            rows.append({
                                "id": str(addr),
                                "name": str(name or addr),
                                "paired": True,
                                "connected": is_conn,
                                "transport": str(info.get("device_minorType") or "bluetooth"),
                            })
            if not rows:
                try:
                    plist_path = Path("/Library/Preferences/com.apple.Bluetooth.plist")
                    if plist_path.is_file():
                        bt_plist = plistlib.loads(plist_path.read_bytes())
                        ports = bt_plist.get("PersistentPorts", {})
                        if isinstance(ports, dict):
                            for addr, meta in ports.items():
                                label = meta.get("BSDName") if isinstance(meta, dict) else None
                                rows.append({
                                    "id": str(addr),
                                    "name": str(label or addr),
                                    "paired": True,
                                    "connected": False,
                                    "transport": "bluetooth",
                                })
                except Exception:
                    pass
            return rows
        return []

    async def inventory(self):
        result = empty_inventory()
        result["interfaces"] = passive_interfaces()
        if self.has_wlan:
            try:
                rows = await invoke(self._wlan().inventory)
                result["interfaces"] = [i for i in result["interfaces"] if i["name"] not in {r["name"] for r in rows}] + rows
            except NetworkOperationError:
                pass
        if not self.networks and self.networksetup:
            for iface in result["interfaces"]:
                if iface.get("type") == "wifi":
                    active = iface.get("ssid")
                    for saved in self._preferred_networks_sync(iface["name"]):
                        key = hashlib.sha256((iface["name"] + "\0saved\0" + saved).encode()).hexdigest()
                        self.networks.append({
                            "id": key,
                            "interface": iface["name"],
                            "ssid": saved,
                            "security": "wpa-personal" if active == saved else "saved",
                            "signal": 100 if active == saved else 0,
                            "connected": active == saved,
                        })
        result["wifi_networks"] = list(self.networks)
        try:
            result["details"] = await invoke(self._details, [i["name"] for i in result["interfaces"]])
        except NetworkOperationError:
            result["details"] = {}
        if self.blueutil or self.system_profiler:
            try:
                result["bluetooth_devices"] = await self._bluetooth()
            except NetworkOperationError:
                pass
        return result

    async def execute(self, action, params):
        name = params.get("interface")
        if action == "wifi_scan":
            rows = await invoke(self._wlan().scan, name)
            self.networks = ([n for n in self.networks if n["interface"] != name] + rows[:200])[-400:]
            return {"wifi_networks": self.networks}
        if action == "bluetooth_refresh":
            return {"bluetooth_devices": await self._bluetooth()}
        if action.startswith("bluetooth_"):
            await self.commands.run([self.blueutil,
                                     "--connect" if action == "bluetooth_connect" else "--disconnect",
                                     params["device_id"]])
            wanted = action == "bluetooth_connect"
            device = next((d for d in await self._bluetooth() if d["id"] == params["device_id"]), {})
            observed = device.get("connected") is wanted
            return {"observed": observed, "state": ("connected" if wanted else "disconnected") if observed else "requested"}
        if action.startswith("interface_"):
            await self.commands.run([self.ifconfig, name, "up" if action == "interface_up" else "down"])
            # CoreWLAN power/carrier and psutil isup are not proof of IFF_UP.
            return {"observed": False, "state": "requested", "message": "Administrative change requested; no native flag observation available."}
        if action == "wifi_connect":
            await invoke(self._wlan().connect, name, params)
        else:
            await invoke(self._wlan().disconnect, name)
        rows = await invoke(self._wlan().inventory)
        row = next((i for i in rows if i["name"] == name), {})
        # A nil SSID can also mean denied Location access, not disconnection.
        observed = bool(params.get("ssid")) and row.get("ssid") == params["ssid"] if action == "wifi_connect" else False
        return {"observed": observed, "state": ("connected" if action == "wifi_connect" else "disconnected") if observed else "requested"}

    async def close(self):
        self.networks.clear()
        if self.wlan and hasattr(self.wlan, "scan_cache"):
            self.wlan.scan_cache.clear()


class MacOSPlatformAdapter(NativeAdapter):
    platform = "macos"

    def __init__(self, native=None, **kwargs):
        super().__init__(native or MacOSNative(**kwargs))
