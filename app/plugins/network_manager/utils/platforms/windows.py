"""Native WLAN credentials remain in memory; PowerShell receives only JSON targets."""

import ctypes as C
import json
import platform
import shutil
import uuid
from xml.sax.saxutils import escape

from .base import NetworkOperationError
from .common import CommandRunner, NativeAdapter, capability_map, empty_inventory, invoke

DWORD = C.c_uint32
WORD = C.c_uint16
BYTE = C.c_ubyte
BOOL = C.c_uint32
WCHAR = C.c_uint16


class GUID(C.Structure):
    _fields_ = [("data1", DWORD), ("data2", WORD), ("data3", WORD), ("data4", BYTE * 8)]

    @classmethod
    def parse(cls, value):
        return cls.from_buffer_copy(uuid.UUID(value.strip("{}")).bytes_le)

    def text(self):
        return str(uuid.UUID(bytes_le=bytes(self)))


class DOT11_SSID(C.Structure):
    _fields_ = [("length", DWORD), ("data", BYTE * 32)]

    def text(self):
        return bytes(self.data[:min(self.length, 32)]).decode("utf-8", "replace")


class WLAN_INTERFACE_INFO(C.Structure):
    _fields_ = [("guid", GUID), ("description", WCHAR * 256), ("state", DWORD)]


class WLAN_AVAILABLE_NETWORK(C.Structure):
    _fields_ = [
        ("profile", WCHAR * 256), ("ssid", DOT11_SSID), ("bss_type", DWORD),
        ("bssid_count", DWORD), ("connectable", BOOL), ("reason", DWORD),
        ("phy_count", DWORD), ("phy_types", DWORD * 8), ("more_phy", BOOL),
        ("signal", DWORD), ("security_enabled", BOOL), ("auth", DWORD),
        ("cipher", DWORD), ("flags", DWORD), ("reserved", DWORD),
    ]


class WLAN_PROFILE_INFO(C.Structure):
    _fields_ = [("name", WCHAR * 256), ("flags", DWORD)]


class WLAN_ASSOCIATION_ATTRIBUTES(C.Structure):
    _fields_ = [("ssid", DOT11_SSID), ("bss_type", DWORD), ("bssid", BYTE * 6),
                ("phy_type", DWORD), ("phy_index", DWORD), ("signal", DWORD),
                ("rx_rate", DWORD), ("tx_rate", DWORD)]


class WLAN_SECURITY_ATTRIBUTES(C.Structure):
    _fields_ = [("enabled", BOOL), ("one_x", BOOL), ("auth", DWORD), ("cipher", DWORD)]


class WLAN_CONNECTION_ATTRIBUTES(C.Structure):
    _fields_ = [("state", DWORD), ("mode", DWORD), ("profile", WCHAR * 256),
                ("association", WLAN_ASSOCIATION_ATTRIBUTES), ("security", WLAN_SECURITY_ATTRIBUTES)]


class WLAN_CONNECTION_PARAMETERS(C.Structure):
    _fields_ = [("mode", DWORD), ("profile", C.c_wchar_p), ("ssid", C.POINTER(DOT11_SSID)),
                ("bssid_list", C.c_void_p), ("bss_type", DWORD), ("flags", DWORD)]


def utf16(array):
    return bytes(array).decode("utf-16-le").split("\0", 1)[0]


def list_entries(pointer, structure):
    """WLAN variable-size lists have two DWORDs before aligned inline records."""
    count = C.cast(pointer, C.POINTER(DWORD))[0]
    if count > 4096:
        raise NetworkOperationError("provider_unavailable", "The native WLAN list exceeded its safety limit.")
    start = C.cast(pointer, C.c_void_p).value + 8
    return [structure.from_buffer_copy(C.string_at(start + n * C.sizeof(structure), C.sizeof(structure)))
            for n in range(count)]


def profile_xml(ssid, security, password=None):
    raw = ssid.encode("utf-8")
    if not 1 <= len(raw) <= 32:
        raise NetworkOperationError("invalid", "Wi-Fi names must contain 1–32 UTF-8 bytes.")
    auth = "open" if security == "open" else "WPA2PSK"
    encryption = "none" if security == "open" else "AES"
    key = "" if security == "open" else (
        "<sharedKey><keyType>passPhrase</keyType><protected>false</protected>"
        f"<keyMaterial>{escape(password or '')}</keyMaterial></sharedKey>")
    return (
        '<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">'
        f"<name>{escape(ssid)}</name><SSIDConfig><SSID><hex>{raw.hex()}</hex>"
        f"<name>{escape(ssid)}</name></SSID></SSIDConfig><connectionType>ESS</connectionType>"
        "<connectionMode>manual</connectionMode><MSM><security><authEncryption>"
        f"<authentication>{auth}</authentication><encryption>{encryption}</encryption>"
        f"<useOneX>false</useOneX></authEncryption>{key}</security></MSM></WLANProfile>"
    )


class WindowsWLAN:
    """ctypes façade, injectable DLL for deterministic marshalling tests."""

    def __init__(self, dll=None):
        self.dll = dll if dll is not None else C.WinDLL("wlanapi.dll")
        self.handle = C.c_void_p()
        signatures = {
            "WlanOpenHandle": ([DWORD, C.c_void_p, C.POINTER(DWORD), C.POINTER(C.c_void_p)], DWORD),
            "WlanCloseHandle": ([C.c_void_p, C.c_void_p], DWORD),
            "WlanEnumInterfaces": ([C.c_void_p, C.c_void_p, C.POINTER(C.c_void_p)], DWORD),
            "WlanGetAvailableNetworkList": ([C.c_void_p, C.POINTER(GUID), DWORD, C.c_void_p, C.POINTER(C.c_void_p)], DWORD),
            "WlanGetProfileList": ([C.c_void_p, C.POINTER(GUID), C.c_void_p, C.POINTER(C.c_void_p)], DWORD),
            "WlanQueryInterface": ([C.c_void_p, C.POINTER(GUID), DWORD, C.c_void_p, C.POINTER(DWORD), C.POINTER(C.c_void_p), C.POINTER(DWORD)], DWORD),
            "WlanScan": ([C.c_void_p, C.POINTER(GUID), C.c_void_p, C.c_void_p, C.c_void_p], DWORD),
            "WlanConnect": ([C.c_void_p, C.POINTER(GUID), C.POINTER(WLAN_CONNECTION_PARAMETERS), C.c_void_p], DWORD),
            "WlanDisconnect": ([C.c_void_p, C.POINTER(GUID), C.c_void_p], DWORD),
            "WlanFreeMemory": ([C.c_void_p], None),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.dll, name)
            # Python fake DLL methods do not expose ctypes function attributes.
            if isinstance(function, C._CFuncPtr):
                function.argtypes, function.restype = args, result
        version = DWORD()
        self.check(self.dll.WlanOpenHandle(2, None, C.byref(version), C.byref(self.handle)))

    @staticmethod
    def check(code):
        if code:
            raise NetworkOperationError("permission_denied" if code == 5 else "provider_unavailable",
                                        "Windows WLAN denied access." if code == 5 else "Windows WLAN could not complete the operation.")

    def _list(self, function, structure, *args):
        pointer = C.c_void_p()
        self.check(function(self.handle, *args, C.byref(pointer)))
        try:
            return list_entries(pointer, structure)
        finally:
            self.dll.WlanFreeMemory(pointer)

    def _connection(self, guid):
        size, opcode, pointer = DWORD(), DWORD(), C.c_void_p()
        code = self.dll.WlanQueryInterface(self.handle, C.byref(guid), 7, None,
                                           C.byref(size), C.byref(pointer), C.byref(opcode))
        if code:
            return None
        try:
            if size.value < C.sizeof(WLAN_CONNECTION_ATTRIBUTES):
                return None
            return WLAN_CONNECTION_ATTRIBUTES.from_buffer_copy(C.string_at(pointer, C.sizeof(WLAN_CONNECTION_ATTRIBUTES)))
        finally:
            self.dll.WlanFreeMemory(pointer)

    def inventory(self):
        result = empty_inventory()
        for item in self._list(self.dll.WlanEnumInterfaces, WLAN_INTERFACE_INFO, None):
            name = item.guid.text()
            row = {"name": name, "type": "wifi", "is_up": item.state not in (0, 2)}
            current = self._connection(item.guid)
            if current is not None and current.state == 1:
                row["ssid"] = current.association.ssid.text()
            result["interfaces"].append(row)
            networks = self._list(self.dll.WlanGetAvailableNetworkList, WLAN_AVAILABLE_NETWORK,
                                  C.byref(item.guid), 0, None)
            for network in networks:
                security = "open" if not network.security_enabled else (
                    "wpa-personal" if network.auth in (4, 7) else "enterprise" if network.auth in (3, 6) else "unsupported")
                ssid = network.ssid.text()
                result["wifi_networks"].append({
                    "id": name + ":" + bytes(network.ssid.data[:min(network.ssid.length, 32)]).hex(),
                    "interface": name, "ssid": ssid, "security": security,
                    "signal": int(network.signal), "connected": bool(network.flags & 1),
                    "profile_id": utf16(network.profile),
                })
        return result

    def scan(self, name):
        guid = GUID.parse(name)
        self.check(self.dll.WlanScan(self.handle, C.byref(guid), None, None, None))

    def connect(self, name, params):
        guid = GUID.parse(name)
        security = params.get("security", "saved")
        if security == "saved":
            profiles = self._list(self.dll.WlanGetProfileList, WLAN_PROFILE_INFO, C.byref(guid), None)
            requested = params.get("profile_id") or params.get("ssid")
            if requested not in {utf16(profile.name) for profile in profiles}:
                raise NetworkOperationError("invalid", "Select a saved Windows Wi-Fi profile.")
            profile, mode = requested, 0
        else:
            profile, mode = profile_xml(params["ssid"], security, params.get("password")), 1
        connection = WLAN_CONNECTION_PARAMETERS(mode, profile, None, None, 1, 0)
        try:
            self.check(self.dll.WlanConnect(self.handle, C.byref(guid), C.byref(connection), None))
        finally:
            connection.profile = None
            profile = None

    def disconnect(self, name):
        guid = GUID.parse(name)
        self.check(self.dll.WlanDisconnect(self.handle, C.byref(guid), None))

    def close(self):
        if self.handle.value:
            self.check(self.dll.WlanCloseHandle(self.handle, None))
            self.handle = C.c_void_p()


# Input is data only, never script text. No Invoke-Expression or interpolated command.
POWERSHELL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.action -eq 'inventory') {
    $result = @(Get-NetAdapter -IncludeHidden | ForEach-Object {
      $a = $_
      $routes = @(Get-NetRoute -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue |
        Select-Object DestinationPrefix,NextHop,RouteMetric)
      $dns = @(Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue |
        ForEach-Object { $_.ServerAddresses })
      $ip = @(Get-NetIPInterface -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue)
      [pscustomobject]@{ name=$a.Name; interface_guid=[string]$a.InterfaceGuid;
        is_up=([int]$a.AdminStatus -eq 1); dns=$dns; routes=$routes;
        method=([string]($ip | Select-Object -First 1).Dhcp) }
    })
    ConvertTo-Json -InputObject $result -Depth 6 -Compress
  } elseif ($request.action -in @('interface_up','interface_down')) {
    $adapter = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -ceq $request.interface })
    if ($adapter.Count -ne 1) { throw 'Unknown interface' }
    if ($request.action -eq 'interface_up') {
      $adapter[0] | Enable-NetAdapter -Confirm:$false
    } else { $adapter[0] | Disable-NetAdapter -Confirm:$false }
    '{"accepted":true}'
  } else { throw 'Unknown action' }
} catch { [Console]::Error.WriteLine('Network operation failed'); exit 1 }
"""


class WindowsNative:
    def __init__(self, *, wlan=None, which=shutil.which, runner=None):
        self.wlan = wlan
        self.has_wlan = wlan is not None or platform.system() == "Windows"
        self.powershell = which("powershell") or which("pwsh")
        self.commands = CommandRunner(runner) if runner else CommandRunner()
        self.guids = {}

    def capabilities(self):
        supported = {"wifi_scan", "wifi_connect", "wifi_disconnect"} if self.has_wlan else set()
        if self.powershell:
            supported.update(("interface_up", "interface_down"))
        result = capability_map(supported)
        for action in ("bluetooth_refresh", "bluetooth_connect", "bluetooth_disconnect"):
            result[action]["reason"] = "Windows classic Bluetooth has no generic profile connection API; no retained paired-only BLE provider is configured."
        for value in result.values():
            value["rollback"] = False
        return result

    def _wlan(self):
        if self.wlan is None:
            self.wlan = WindowsWLAN()
        return self.wlan

    async def _powershell(self, payload):
        return json.loads(await self.commands.run([
            self.powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT,
        ], payload))

    async def inventory(self):
        result = await invoke(self._wlan().inventory) if self.has_wlan else empty_inventory()
        self.guids = {i["name"]: i["name"] for i in result["interfaces"]}
        if self.powershell:
            adapters = await self._powershell({"action": "inventory"})
            for adapter in adapters:
                guid = adapter.get("interface_guid", "").strip("{}").lower()
                name = adapter["name"]
                found = next((i for i in result["interfaces"] if i["name"].lower() == guid), None)
                if found:
                    found.update(name=name, is_up=bool(adapter["is_up"]))
                    self.guids[name] = guid
                    for network in result["wifi_networks"]:
                        if network["interface"].lower() == guid:
                            network["interface"] = name
                else:
                    result["interfaces"].append({"name": name, "type": "other", "is_up": bool(adapter["is_up"])})
                routes = adapter.get("routes", [])
                result["details"][name] = {
                    "gateways": list(dict.fromkeys(r["NextHop"] for r in routes if r.get("NextHop") not in (None, "0.0.0.0", "::"))),
                    "dns": adapter.get("dns", []), "routes": routes, "method": adapter.get("method"),
                    "source": "Windows NetTCPIP JSON",
                }
        return result

    async def execute(self, action, params):
        name = params.get("interface")
        if action.startswith("interface_"):
            await self._powershell({"action": action, "interface": name})
            current = await self.inventory()
            row = next((i for i in current["interfaces"] if i["name"] == name), {})
            wanted = action == "interface_up"
            observed = row.get("is_up") is wanted
            return {"observed": observed, "state": ("up" if wanted else "down") if observed else "requested"}
        guid = self.guids.get(name)
        if not guid:
            raise NetworkOperationError("invalid", "Select an inventoried WLAN interface.")
        wlan = self._wlan()
        if action == "wifi_scan":
            await invoke(wlan.scan, guid)
            return {"wifi_networks": (await self.inventory())["wifi_networks"]}
        if action == "wifi_connect":
            await invoke(wlan.connect, guid, params)
        else:
            await invoke(wlan.disconnect, guid)
        current = await self.inventory()
        row = next((i for i in current["interfaces"] if i["name"] == name), {})
        # Saved profile names need not be SSIDs. Without an explicit SSID do not
        # report an unrelated existing association as the requested connection.
        observed = bool(params.get("ssid")) and row.get("ssid") == params["ssid"] if action == "wifi_connect" else "ssid" not in row
        return {"observed": observed, "state": ("connected" if action == "wifi_connect" else "disconnected") if observed else "requested"}

    async def close(self):
        if self.wlan:
            await invoke(self.wlan.close)


class WindowsPlatformAdapter(NativeAdapter):
    platform = "windows"

    def __init__(self, native=None, **kwargs):
        super().__init__(native or WindowsNative(**kwargs))
