import asyncio
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import psutil
import pytest
from quart import Quart

from app.plugins.cpu_stats import (
    CPUMonitor,
    CPUStatsPlugin,
    MetricsCollector,
    SystemMonitor,
)


Times = namedtuple("Times", "user system idle iowait guest guest_nice")


class FakeProcess:
    def __init__(self, pid, cpu=40.0, created=1, denied=False):
        self.pid = pid
        self.cpu = cpu
        self.created = created
        self.denied = denied
        self.calls = []

    def create_time(self):
        return self.created

    def cpu_percent(self, interval=None):
        self.calls.append(interval)
        if self.denied:
            raise psutil.AccessDenied(self.pid)
        return self.cpu

    def name(self):
        return f"process-{self.pid}"

    def memory_percent(self):
        return 2.5


class FakePsutil:
    def __init__(self):
        self.times = Times(20, 10, 65, 5, 0, 0)
        self.cores = [self.times, self.times]
        self.processes = []
        self.process_calls = 0

    def cpu_times(self, percpu=False):
        return self.cores if percpu else self.times

    def cpu_freq(self):
        return SimpleNamespace(current=1800, min=600, max=2400)

    def virtual_memory(self):
        return SimpleNamespace(percent=42.5, used=4096, total=8192, available=4096)

    def getloadavg(self):
        return (0.5, 0.4, 0.3)

    def cpu_count(self, logical=True):
        return 2 if logical else 1

    def sensors_temperatures(self):
        return {
            "nvme": [SimpleNamespace(label="Composite", current=99)],
            "cpu_thermal": [SimpleNamespace(label="", current=54)],
        }

    def process_iter(self):
        self.process_calls += 1
        return iter(self.processes)


def test_first_sample_primed_and_explicit_cpu_deltas_across_workers():
    provider = FakePsutil()
    monitor = CPUMonitor(provider)
    with ThreadPoolExecutor(max_workers=1) as first_worker:
        first = first_worker.submit(monitor.collect).result()
    assert first["cpu_percent"] is None
    assert first["per_core"] == [None, None]
    assert first["times"] == dict.fromkeys(("user", "system", "idle", "iowait"))
    provider.times = Times(40, 20, 130, 10, 0, 0)
    provider.cores = [provider.times, provider.times]
    with ThreadPoolExecutor(max_workers=1) as different_worker:
        sample = different_worker.submit(monitor.collect).result()
    assert sample["cpu_percent"] == pytest.approx(30)
    assert sample["per_core"] == pytest.approx([30, 30])
    assert sample["times"] == {"user": 20, "system": 10, "idle": 65, "iowait": 5}
    assert sample["temperature"] == 54
    assert sample["memory"] == {"percent": 42.5, "used": 4096, "total": 8192, "available": 4096}
    assert sample["capabilities"]["memory"] is True
    assert sample["frequency"] == {"current": 1800, "min": 600, "max": 2400}
    assert sample["load_average"] == [0.5, 0.4, 0.3]
    assert sample["core_count"] == {"physical": 1, "logical": 2}


def test_guest_time_not_double_counted_and_resets_reprime():
    provider = FakePsutil()
    monitor = CPUMonitor(provider)
    monitor.collect()
    provider.times = Times(40, 20, 125, 5, 10, 0)
    assert monitor.collect()["cpu_percent"] == pytest.approx(30 / 90 * 100)
    provider.times = Times(1, 1, 1, 0, 0, 0)
    provider.cores = [provider.times]
    reset = monitor.collect()
    assert reset["cpu_percent"] is None
    assert reset["per_core"] == [None]
    assert monitor.collect()["cpu_percent"] is None  # Zero elapsed CPU time.


def test_unsupported_metrics_and_nonfinite_values_are_null():
    provider = FakePsutil()

    def unavailable():
        raise NotImplementedError

    provider.cpu_freq = unavailable
    provider.virtual_memory = unavailable
    provider.getloadavg = unavailable
    provider.sensors_temperatures = unavailable
    sample = CPUMonitor(provider).collect()
    assert sample["frequency"] == dict.fromkeys(("current", "min", "max"))
    assert sample["memory"] == dict.fromkeys(("percent", "used", "total", "available"))
    assert sample["capabilities"]["memory"] is False
    assert sample["load_average"] is None
    assert sample["temperature"] is None
    assert sample["capabilities"]["temperature"] is False
    provider.cpu_freq = lambda: SimpleNamespace(current=float("nan"), min=None, max=float("inf"))
    assert CPUMonitor(provider).collect()["frequency"] == sample["frequency"]
    provider.cpu_freq = lambda: SimpleNamespace(current=0, min=0, max=-1)
    assert CPUMonitor(provider).collect()["frequency"] == sample["frequency"]


def test_unavailable_cpu_times_report_degraded():
    provider = FakePsutil()

    def unavailable(percpu=False):
        raise OSError("CPU counters unavailable")

    provider.cpu_times = unavailable
    sample = CPUMonitor(provider).collect()
    assert sample["status"] == "degraded"
    assert sample["per_core"] == []
    assert sample["capabilities"]["cpu_times"] is False


def test_process_cadence_cached_instances_sort_prune_and_pid_reuse():
    provider = FakePsutil()
    process = FakeProcess(10)
    denied = FakeProcess(11, denied=True)
    provider.processes = [process, denied]
    now = [0.0]
    collector = MetricsCollector(provider=provider, monotonic=lambda: now[0], clock=lambda: 123.0)
    first = collector.collect()
    assert first["timestamp"] == 123
    assert first["processes"][0]["cpu_percent"] is None
    assert 11 not in collector._processes
    now[0] = 4.9
    collector.collect()
    assert provider.process_calls == 1
    # Fresh discovery instances must not discard cached utilization baselines.
    replacement_discovery = FakeProcess(10, cpu=99)
    provider.processes = [replacement_discovery, FakeProcess(12, cpu=90)]
    now[0] = 5
    second = collector.collect()
    assert second["processes"][0]["pid"] == 10
    assert second["processes"][0]["cpu_percent"] == 40
    assert process.calls == [None, None]
    assert replacement_discovery.calls == []
    provider.processes = [FakeProcess(10, created=2)]
    now[0] = 10
    third = collector.collect()
    assert third["processes"][0]["cpu_percent"] is None
    assert 12 not in collector._processes
    provider.processes = []
    now[0] = 15
    assert collector.collect()["processes"] == []
    assert collector._processes == {}


def test_process_discovery_failure_does_not_stop_cpu_collection():
    provider = FakePsutil()

    def denied():
        raise psutil.AccessDenied()

    provider.process_iter = denied
    sample = MetricsCollector(provider=provider).collect()
    assert sample["status"] == "ok"
    assert sample["processes"] == []
    assert sample["capabilities"]["processes"] is False


@pytest.mark.parametrize("invalid", ["nan", "inf", "-inf", "-1", "0", "bad", "0.1"])
def test_plugin_configuration_requires_finite_safe_intervals(monkeypatch, invalid):
    monkeypatch.setenv("SHELL_APP_CPU_INTERVAL", invalid)
    monkeypatch.setenv("SHELL_APP_CPU_PROCESS_INTERVAL", invalid)
    app = Quart(__name__)
    CPUStatsPlugin().register(app)
    service = app.extensions["cpu_stats"]
    assert service.interval == 1.0
    assert service.collector.process_interval == 5.0


def test_plugin_cached_apis_compaction_and_lifecycle(monkeypatch):
    monkeypatch.setenv("SHELL_APP_CPU_INTERVAL", "0.25")
    monkeypatch.setenv("SHELL_APP_CPU_PROCESS_INTERVAL", "2.5")
    app = Quart(__name__)
    CPUStatsPlugin().register(app)
    service = app.extensions["cpu_stats"]
    provider = FakePsutil()
    collector = MetricsCollector(provider=provider)
    service.collect = collector.collect

    async def verify():
        client = app.test_client()
        initial = await (await client.get("/api/cpu-stats")).get_json()
        assert initial == {"timestamp": None, "status": "starting"}
        assert provider.process_calls == 0
        assert service.interval == 0.25
        assert service.collector.process_interval == 2.5
        async with app.test_app():
            for _ in range(100):
                if service.snapshot["timestamp"] is not None:
                    break
                await asyncio.sleep(0.005)
            assert service.task is not None
            calls = provider.process_calls
            for _ in range(3):
                response = await client.get("/api/cpu-stats")
                assert response.status_code == 200
                assert (await response.get_json())["status"] == "ok"
            assert provider.process_calls == calls
            response = await client.get("/api/cpu-stats/history?seconds=60&limit=1")
            history = (await response.get_json())["samples"]
            assert len(history) == 1
            assert set(history[0]) == {
                "timestamp", "cpu_percent", "memory", "frequency", "temperature", "per_core", "times"
            }
            assert (await client.get("/api/cpu-stats/history?limit=601")).status_code == 400
        assert service.task is None

    asyncio.run(verify())


def test_plugin_app_config_overrides_environment(monkeypatch):
    monkeypatch.setenv("SHELL_APP_CPU_INTERVAL", "1")
    monkeypatch.setenv("SHELL_APP_CPU_PROCESS_INTERVAL", "5")
    app = Quart(__name__)
    app.config["SHELL_APP_CPU_INTERVAL"] = 2
    app.config["SHELL_APP_CPU_PROCESS_INTERVAL"] = 10
    CPUStatsPlugin().register(app)
    service = app.extensions["cpu_stats"]
    assert service.interval == 2
    assert service.collector.process_interval == 10


def test_system_monitor_uses_shared_store_and_live_service():
    from app.core.monitoring import LiveUpdateService, MetricsStore, MonitoringService

    monitor = SystemMonitor(collector=MetricsCollector(provider=FakePsutil()))
    assert isinstance(monitor, MonitoringService)
    assert isinstance(monitor.store, MetricsStore)
    assert isinstance(monitor.live, LiveUpdateService)
