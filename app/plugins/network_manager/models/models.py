"""Structured dataclass models for the network_manager plugin."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class NormalizedAddress:
    address: str | None = None
    netmask: str | None = None
    family: str | None = None
    broadcast: str | None = None
    version: int | None = None
    prefix_length: int | None = None
    network_cidr: str | None = None
    network_address: str | None = None
    subnet_broadcast: str | None = None
    scope_id: str | None = None
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "NormalizedAddress":
        known = {
            "address",
            "netmask",
            "family",
            "broadcast",
            "version",
            "prefix_length",
            "network_cidr",
            "network_address",
            "subnet_broadcast",
            "scope_id",
        }
        kwargs = {key: record[key] for key in known if key in record}
        extra = {key: value for key, value in record.items() if key not in known}
        return cls(**kwargs, extra=extra)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        extra = data.pop("extra", {}) or {}
        result: dict[str, Any] = dict(extra)
        for key, value in data.items():
            if key not in result or value is not None:
                result[key] = value
        return result


@dataclass
class InterfaceSnapshot:
    name: str
    type: str
    state: str
    is_up: bool
    addresses: list[dict]
    mac: str | None
    speed_mbps: int | float | None
    mtu: int | None
    bytes_recv: int
    bytes_sent: int
    recv_rate: float | None
    sent_rate: float | None
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["addresses"] = [
            addr.to_dict() if hasattr(addr, "to_dict") else dict(addr)
            for addr in self.addresses
        ]
        return data


@dataclass
class ConnectionSummary:
    state: str
    interfaces: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TrafficTotals:
    recv_rate: float | None = None
    sent_rate: float | None = None

    def to_dict(self) -> dict[str, float | None]:
        return asdict(self)


@dataclass
class CompactNetworkSample:
    timestamp: float | None
    totals: dict = field(default_factory=dict)
    interfaces: list[dict] = field(default_factory=list)

    @classmethod
    def from_snapshot(cls, snapshot: dict) -> "CompactNetworkSample":
        data = snapshot.to_dict() if hasattr(snapshot, "to_dict") else snapshot
        raw_totals = data["totals"]
        totals = (
            raw_totals.to_dict()
            if hasattr(raw_totals, "to_dict")
            else raw_totals.copy()
        )
        interfaces = []
        for interface in data["interfaces"]:
            item = interface.to_dict() if hasattr(interface, "to_dict") else interface
            interfaces.append(
                {key: item[key] for key in ("name", "recv_rate", "sent_rate")}
            )
        return cls(
            timestamp=data["timestamp"],
            totals=totals,
            interfaces=interfaces,
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CheckpointRecord:
    id: str
    expires_at: float
    observed: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        if self.observed is None:
            data.pop("observed", None)
        return data


@dataclass
class OperationRecord:
    id: str
    action: str
    target: str
    status: str
    created_at: float
    updated_at: float
    message: str
    checkpoint: dict | None = None
    error: dict | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        if self.checkpoint is None:
            data.pop("checkpoint", None)
        elif hasattr(self.checkpoint, "to_dict"):
            data["checkpoint"] = self.checkpoint.to_dict()
        if self.error is None:
            data.pop("error", None)
        return data


__all__ = [
    "NormalizedAddress",
    "InterfaceSnapshot",
    "ConnectionSummary",
    "TrafficTotals",
    "CompactNetworkSample",
    "CheckpointRecord",
    "OperationRecord",
]
