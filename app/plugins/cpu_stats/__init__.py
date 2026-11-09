"""CPU statistics plugin and monitoring components."""

import sys

from app.plugins.cpu_stats.models import (
    CompactCPUSample,
    CoreCount,
    CPUCapabilities,
    CPUFrequency,
    CPUSnapshot,
    CPUTimesBreakdown,
    MemoryMetrics,
    ProcessMetric,
)
from app.plugins.cpu_stats.plugin import CPUStatsPlugin
from app.plugins.cpu_stats.utils import (
    CPUMonitor,
    LiveUpdateService,
    MetricsCollector,
    MetricsStore,
    SystemMonitor,
    monitor,
)

sys.modules["app.plugins.cpu_stats.monitor"] = monitor

__all__ = [
    "CPUStatsPlugin",
    "SystemMonitor",
    "CPUMonitor",
    "MetricsCollector",
    "MetricsStore",
    "LiveUpdateService",
    "CPUTimesBreakdown",
    "CPUFrequency",
    "MemoryMetrics",
    "CoreCount",
    "CPUCapabilities",
    "ProcessMetric",
    "CPUSnapshot",
    "CompactCPUSample",
]
