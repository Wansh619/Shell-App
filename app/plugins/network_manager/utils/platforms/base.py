"""Native OS boundaries used only by NetworkController, never by requests."""

from abc import ABC, abstractmethod


ACTIONS = (
    "wifi_scan",
    "wifi_connect",
    "wifi_disconnect",
    "bluetooth_refresh",
    "bluetooth_connect",
    "bluetooth_disconnect",
    "interface_up",
    "interface_down",
)


class NetworkOperationError(Exception):
    """A public error with no native command output or credential material."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class NetworkPlatformAdapter(ABC):
    platform = "unsupported"

    def capabilities(self) -> dict:
        return {
            action: {"supported": False, "reason": "Not supported by this platform."}
            for action in ACTIONS
        }

    @abstractmethod
    async def inventory(self) -> dict:
        """No active scans: interfaces, paired devices and cached IP details.

        Return {interfaces:[{name,type,is_up,ssid?}], wifi_networks:[],
        bluetooth_devices:[{id,name,paired,connected,transport,adapter?}],
        details:{interface:{gateways:[],dns:[],routes:[],method:null,source:str}}}.
        Optional fields may be absent. IDs must be stable, never supplied code.
        """

    @abstractmethod
    async def execute(self, action: str, params: dict) -> dict:
        """Perform an explicit allowlisted action with finite native deadlines.

        Params: interface for Wi-Fi/link actions; ssid, security ('open',
        'wpa-personal' or 'saved'), optional password/profile_id for connect;
        device_id for Bluetooth. wifi_scan returns {wifi_networks:[{id,interface,
        ssid,security,signal,connected?}]}; bluetooth_refresh returns
        {bluetooth_devices:[...]}. Mutations return {observed:bool,state:str,
        message:str?}; observed false means requested, NOT connected.
        Never echo params/passwords or raw native exceptions.
        """

    async def create_checkpoint(self, interface: str, timeout: int = 60) -> dict | None:
        """Return {id,expires_at} only for an actual OS-backed rollback."""
        return None

    async def confirm_checkpoint(self, checkpoint_id: str) -> None:
        raise NetworkOperationError("unsupported", "Rollback confirmation is unavailable.")

    async def revert_checkpoint(self, checkpoint_id: str) -> None:
        raise NetworkOperationError("unsupported", "Automatic rollback is unavailable.")

    async def close(self) -> None:
        """Dispose native sessions; do not silently disconnect unrelated devices."""
