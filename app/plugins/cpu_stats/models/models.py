"""Structured dataclass models for CPU statistics monitoring."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class CPUTimesBreakdown:
    user: float | None = None
    system: float | None = None
    idle: float | None = None
    iowait: float | None = None

    def to_dict(self) -> dict[str, float | None]:
        return asdict(self)


@dataclass
class CPUFrequency:
    current: float | None = None
    min: float | None = None
    max: float | None = None

    def to_dict(self) -> dict[str, float | None]:
        return asdict(self)


@dataclass
class MemoryMetrics:
    percent: float | None = None
    used: float | None = None
    total: float | None = None
    available: float | None = None

    def to_dict(self) -> dict[str, float | None]:
        return asdict(self)


@dataclass
class CoreCount:
    physical: int | None = None
    logical: int | None = None

    def to_dict(self) -> dict[str, int | None]:
        return asdict(self)


@dataclass
class CPUCapabilities:
    cpu_times: bool = False
    memory: bool = False
    per_core: bool = False
    frequency: bool = False
    load_average: bool = False
    temperature: bool = False
    processes: bool | None = None

    def to_dict(self) -> dict[str, bool]:
        data = asdict(self)
        if self.processes is None:
            data.pop("processes", None)
        return data


@dataclass
class ProcessMetric:
    pid: int
    name: str
    cpu_percent: float | None
    memory_percent: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CPUSnapshot:
    status: str = "ok"
    cpu_percent: float | None = None
    memory: MemoryMetrics | dict[str, Any] = field(default_factory=MemoryMetrics)
    per_core: list[float | None] = field(default_factory=list)
    frequency: CPUFrequency | dict[str, Any] = field(default_factory=CPUFrequency)
    times: CPUTimesBreakdown | dict[str, Any] = field(default_factory=CPUTimesBreakdown)
    load_average: list[float] | None = None
    core_count: CoreCount | dict[str, Any] = field(default_factory=CoreCount)
    temperature: float | None = None
    capabilities: CPUCapabilities | dict[str, Any] = field(default_factory=CPUCapabilities)
    timestamp: float | None = None
    processes: list[ProcessMetric | dict[str, Any]] | None = None

    def to_dict(self) -> dict[str, Any]:
        memory_dict = (
            self.memory.to_dict() if hasattr(self.memory, "to_dict") else dict(self.memory)
        )
        frequency_dict = (
            self.frequency.to_dict()
            if hasattr(self.frequency, "to_dict")
            else dict(self.frequency)
        )
        times_dict = (
            self.times.to_dict() if hasattr(self.times, "to_dict") else dict(self.times)
        )
        core_count_dict = (
            self.core_count.to_dict()
            if hasattr(self.core_count, "to_dict")
            else dict(self.core_count)
        )
        capabilities_dict = (
            self.capabilities.to_dict()
            if hasattr(self.capabilities, "to_dict")
            else dict(self.capabilities)
        )

        result: dict[str, Any] = {
            "status": self.status,
            "cpu_percent": self.cpu_percent,
            "memory": memory_dict,
            "per_core": list(self.per_core),
            "frequency": frequency_dict,
            "times": times_dict,
            "load_average": list(self.load_average) if self.load_average is not None else None,
            "core_count": core_count_dict,
            "temperature": self.temperature,
            "capabilities": capabilities_dict,
        }

        if self.timestamp is not None:
            result["timestamp"] = self.timestamp
        if self.processes is not None:
            result["processes"] = [
                proc.to_dict() if hasattr(proc, "to_dict") else dict(proc)
                for proc in self.processes
            ]
        return result


@dataclass
class CompactCPUSample:
    timestamp: float | None
    cpu_percent: float | None
    memory: dict[str, Any]
    frequency: dict[str, Any]
    temperature: float | None
    per_core: list[float | None]
    times: dict[str, Any]

    @classmethod
    def from_snapshot(cls, snapshot: dict[str, Any] | CPUSnapshot) -> "CompactCPUSample":
        data = snapshot.to_dict() if hasattr(snapshot, "to_dict") else snapshot
        return cls(
            timestamp=data["timestamp"],
            cpu_percent=data["cpu_percent"],
            memory=data["memory"],
            frequency=data["frequency"],
            temperature=data["temperature"],
            per_core=data["per_core"],
            times=data["times"],
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


__all__ = [
    "CPUTimesBreakdown",
    "CPUFrequency",
    "MemoryMetrics",
    "CoreCount",
    "CPUCapabilities",
    "ProcessMetric",
    "CPUSnapshot",
    "CompactCPUSample",
]
