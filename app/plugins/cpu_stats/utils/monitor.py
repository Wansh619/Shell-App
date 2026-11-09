"""CPU statistics monitoring utilities and collectors."""

import math
import time

import psutil

from app.core.monitoring import (
    LiveUpdateService,
    MetricsStore,
    MonitoringService,
    positive_number,
)
from app.plugins.cpu_stats.models.models import (
    CompactCPUSample,
    CoreCount,
    CPUCapabilities,
    CPUFrequency,
    CPUSnapshot,
    CPUTimesBreakdown,
    MemoryMetrics,
    ProcessMetric,
)


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _optional(call, default=None):
    try:
        return call()
    except (psutil.Error, OSError, AttributeError, NotImplementedError):
        return default


class CPUMonitor:
    """Normalize host CPU metrics using explicit, worker-independent deltas."""

    def __init__(self, provider=None):
        self.provider = provider if provider is not None else psutil
        self._previous = None
        self._previous_cores = []

    @staticmethod
    def _times(value):
        return value._asdict() if value is not None else None

    @staticmethod
    def _delta(previous, current):
        empty = CPUTimesBreakdown().to_dict()
        if previous is None or current is None or previous.keys() != current.keys():
            return None, empty
        deltas = {key: current[key] - previous[key] for key in current}
        if any(not math.isfinite(value) or value < 0 for value in deltas.values()):
            return None, empty
        # Linux guest/guest_nice are already included in user/nice.
        total = sum(deltas.values()) - deltas.get("guest", 0) - deltas.get("guest_nice", 0)
        if total <= 0:
            return None, empty
        idle = deltas.get("idle", 0) + deltas.get("iowait", 0)
        usage = max(0.0, min(100.0, (total - idle) * 100 / total))
        percentages = CPUTimesBreakdown(
            user=deltas["user"] * 100 / total if "user" in deltas else None,
            system=deltas["system"] * 100 / total if "system" in deltas else None,
            idle=deltas["idle"] * 100 / total if "idle" in deltas else None,
            iowait=deltas["iowait"] * 100 / total if "iowait" in deltas else None,
        ).to_dict()
        return usage, percentages

    def _temperature(self):
        readings = _optional(lambda: self.provider.sensors_temperatures(), {}) or {}
        values = []
        for sensor, entries in readings.items():
            for entry in entries:
                label = getattr(entry, "label", "").lower()
                cpu_sensor = any(
                    token in sensor.lower()
                    for token in ("coretemp", "k10temp", "zenpower", "cpu", "soc_thermal")
                )
                if cpu_sensor or any(token in label for token in ("cpu", "package", "core")):
                    value = _number(getattr(entry, "current", None))
                    if value is not None:
                        values.append(value)
        return max(values) if values else None

    def collect(self):
        current = self._times(_optional(lambda: self.provider.cpu_times()))
        cores = _optional(lambda: self.provider.cpu_times(percpu=True), []) or []
        cores = [self._times(core) for core in cores]
        usage, times = self._delta(self._previous, current)
        # A topology change invalidates core-index baselines.
        previous = self._previous_cores if len(cores) == len(self._previous_cores) else []
        per_core = [
            self._delta(previous[index] if previous else None, core)[0]
            for index, core in enumerate(cores)
        ]
        self._previous, self._previous_cores = current, cores
        raw_freq = _optional(lambda: self.provider.cpu_freq())
        freq_values = {
            key: _number(getattr(raw_freq, key, None))
            for key in ("current", "min", "max")
        }
        frequency = CPUFrequency(
            **{
                key: value if value is not None and value > 0 else None
                for key, value in freq_values.items()
            }
        )
        load = _optional(lambda: self.provider.getloadavg())
        load = [_number(value) for value in load] if load is not None else None
        if load is not None and (len(load) != 3 or any(value is None for value in load)):
            load = None
        temperature = self._temperature()
        vm = _optional(lambda: self.provider.virtual_memory())
        mem_values = {
            key: _number(getattr(vm, key, None))
            for key in ("percent", "used", "total", "available")
        }
        if mem_values["percent"] is not None:
            mem_values["percent"] = max(0.0, min(100.0, mem_values["percent"]))
        memory = MemoryMetrics(**mem_values)
        core_count = CoreCount(
            physical=_optional(lambda: self.provider.cpu_count(logical=False)),
            logical=_optional(lambda: self.provider.cpu_count(logical=True)),
        )
        capabilities = CPUCapabilities(
            cpu_times=current is not None,
            memory=memory.percent is not None,
            per_core=bool(cores),
            frequency=frequency.current is not None,
            load_average=load is not None,
            temperature=temperature is not None,
        )
        snapshot = CPUSnapshot(
            status="ok" if current is not None else "degraded",
            cpu_percent=usage,
            memory=memory,
            per_core=per_core,
            frequency=frequency,
            times=times,
            load_average=load,
            core_count=core_count,
            temperature=temperature,
            capabilities=capabilities,
        )
        return snapshot.to_dict()


class MetricsCollector:
    """Collect CPU samples and refresh cached process objects at a slower cadence."""

    def __init__(
        self,
        cpu_monitor=None,
        provider=None,
        process_interval=5.0,
        monotonic=time.monotonic,
        clock=time.time,
        process_limit=10,
    ):
        self.provider = provider if provider is not None else psutil
        self.cpu_monitor = cpu_monitor if cpu_monitor is not None else CPUMonitor(self.provider)
        self.process_interval = positive_number(process_interval, 5.0)
        self.monotonic = monotonic
        self.clock = clock
        self.process_limit = max(1, process_limit)
        self._processes = {}
        self._process_rows = []
        self._last_process_sample = None
        self._process_available = True

    def _collect_processes(self):
        try:
            discovered = list(self.provider.process_iter())
        except (psutil.Error, OSError, NotImplementedError):
            self._processes.clear()
            self._process_rows = []
            self._process_available = False
            return
        seen = set()
        rows = []
        self._process_available = True
        for candidate in discovered:
            pid = candidate.pid
            seen.add(pid)
            process = self._processes.get(pid)
            try:
                # Do not reuse a stale baseline when the OS recycles a PID.
                fresh = process is None or process.create_time() != candidate.create_time()
                if fresh:
                    process = candidate
                    self._processes[pid] = process
                # Process.cpu_percent baselines are per-instance, not thread-local.
                cpu = process.cpu_percent(interval=None)
                name = process.name()
                memory = _number(process.memory_percent())
                rows.append(
                    ProcessMetric(
                        pid=pid,
                        name=name,
                        cpu_percent=None if fresh else _number(cpu),
                        memory_percent=memory,
                    ).to_dict()
                )
            except (psutil.Error, OSError, NotImplementedError):
                self._processes.pop(pid, None)
        self._processes = {
            pid: process for pid, process in self._processes.items() if pid in seen
        }
        rows.sort(key=lambda row: row["cpu_percent"] or 0.0, reverse=True)
        self._process_rows = rows[:self.process_limit]

    def collect(self):
        snapshot = self.cpu_monitor.collect()
        now = self.monotonic()
        if (
            self._last_process_sample is None
            or now - self._last_process_sample >= self.process_interval
        ):
            self._collect_processes()
            self._last_process_sample = now
        snapshot["timestamp"] = self.clock()
        snapshot["processes"] = list(self._process_rows)
        snapshot["capabilities"]["processes"] = self._process_available
        return snapshot


class SystemMonitor(MonitoringService):
    """Compose CPU collection with the shared lifecycle, store and live fan-out."""

    def __init__(self, interval=1.0, process_interval=5.0, collector=None):
        self.collector = (
            collector
            if collector is not None
            else MetricsCollector(process_interval=process_interval)
        )
        super().__init__(self.collector.collect, interval=interval, compact=self.compact_cpu)

    @staticmethod
    def compact_cpu(snapshot):
        return CompactCPUSample.from_snapshot(snapshot).to_dict()


__all__ = [
    "SystemMonitor",
    "CPUMonitor",
    "MetricsCollector",
    "MetricsStore",
    "LiveUpdateService",
    "MonitoringService",
    "positive_number",
    "_number",
    "_optional",
]
