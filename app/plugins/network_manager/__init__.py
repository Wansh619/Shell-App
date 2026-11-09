"""Read-only, process-local network monitoring."""

import sys

from app.plugins.network_manager.models import (
    CheckpointRecord,
    CompactNetworkSample,
    ConnectionSummary,
    InterfaceSnapshot,
    NormalizedAddress,
    OperationRecord,
    TrafficTotals,
)
from app.plugins.network_manager.plugin import NetworkManagerPlugin
from app.plugins.network_manager.utils import (
    BluetoothManager,
    ConnectionManager,
    EthernetManager,
    HotspotManager,
    InterfaceManager,
    LinuxMetadataProvider,
    NetworkControlError,
    NetworkController,
    NetworkManager,
    NetworkMonitor,
    PsutilProvider,
    WiFiManager,
    _split_terse,
    compact_snapshot,
    control_routes,
    controller,
    create_control_routes,
    create_platform_adapter,
    inspection,
    manager,
    normalize_address,
    platforms,
    providers,
)
from app.plugins.network_manager.utils.platforms import (
    base as _platforms_base,
    common as _platforms_common,
    linux as _platforms_linux,
    macos as _platforms_macos,
    windows as _platforms_windows,
)

sys.modules.setdefault(f"{__name__}.manager", manager)
sys.modules.setdefault(f"{__name__}.controller", controller)
sys.modules.setdefault(f"{__name__}.control_routes", control_routes)
sys.modules.setdefault(f"{__name__}.providers", providers)
sys.modules.setdefault(f"{__name__}.inspection", inspection)
sys.modules.setdefault(f"{__name__}.platforms", platforms)
sys.modules.setdefault(f"{__name__}.platforms.base", _platforms_base)
sys.modules.setdefault(f"{__name__}.platforms.common", _platforms_common)
sys.modules.setdefault(f"{__name__}.platforms.linux", _platforms_linux)
sys.modules.setdefault(f"{__name__}.platforms.macos", _platforms_macos)
sys.modules.setdefault(f"{__name__}.platforms.windows", _platforms_windows)

__all__ = [
    "NetworkManagerPlugin",
    "NormalizedAddress",
    "InterfaceSnapshot",
    "ConnectionSummary",
    "TrafficTotals",
    "CompactNetworkSample",
    "CheckpointRecord",
    "OperationRecord",
    "InterfaceManager",
    "ConnectionManager",
    "WiFiManager",
    "EthernetManager",
    "BluetoothManager",
    "HotspotManager",
    "NetworkManager",
    "NetworkMonitor",
    "compact_snapshot",
    "NetworkController",
    "NetworkControlError",
    "create_control_routes",
    "normalize_address",
    "PsutilProvider",
    "LinuxMetadataProvider",
    "_split_terse",
    "create_platform_adapter",
    "manager",
    "controller",
    "control_routes",
    "providers",
    "inspection",
    "platforms",
]
