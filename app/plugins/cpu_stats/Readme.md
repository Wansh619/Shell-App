# CPU Stats plugin

Read-only, process-local CPU monitoring for the Quart application, including Raspberry Pi / Ubuntu Server hosts. `psutil` is the collection dependency. The original dashboard requirements are preserved below; UI implementation is separate from this backend package.

## Implemented architecture

- `plugin.CPUStatsPlugin` has a no-argument constructor and `register(app)`. It registers a `SystemMonitor` under `app.extensions["cpu_stats"]` and exposes the `cpu-stats` API/stream.
- `monitor.SystemMonitor` subclasses the shared `app.core.monitoring.MonitoringService`, composing collection with exactly one background sampler per application process. Serving hooks start and stop it. Synchronous collection runs through `asyncio.to_thread`; requests never trigger collection.
- `monitor.CPUMonitor` normalizes cumulative host/per-core CPU times, CPU frequency, load, core counts, and CPU temperature. Explicit deltas are retained on the monitor, so changing executor threads does not invalidate utilization measurements.
- `monitor.MetricsCollector` combines CPU samples with a top-10 process list. It retains `psutil.Process` instances for their per-instance utilization baselines; process discovery, CPU sampling, name and memory reads happen only at the slower process cadence. Dead, inaccessible and PID-reused entries are pruned or re-primed.
- Shared `MetricsStore` retains bounded compact samples for up to one hour at the configured cadence. Shared `LiveUpdateService` fans out to latest-only subscriber queues; slow browsers do not accumulate a backlog.

The components can accept fake providers/clocks for deterministic tests and can be composed with additional future metric collectors without duplicating scheduling or transport.

## API contract

- `GET /api/cpu-stats` returns the latest snapshot directly. Before the first sample, this is `{"timestamp": null, "status": "starting"}`.
- `GET /api/cpu-stats/history?seconds=60&limit=600` returns `{"samples": [...]}`. `seconds` must be an integer from 1–3600 and `limit` from 1–600; invalid inputs return HTTP 400. Longer histories are evenly downsampled.
- `WS /ws/cpu-stats` sends `{"type": "snapshot", "data": snapshot}`, then `{"type": "update", "data": snapshot}`. It does not send full history each tick. Use REST only for initialization/history-range changes, not live polling.

Normal snapshot fields:

- `timestamp`: numeric UNIX seconds; `status`: `ok` or `degraded` when host CPU counters are unavailable. The shared service reports `error` if an unexpected collection exception occurs and retries.
- `cpu_percent`: overall utilization, number or null; `per_core`: logical-core utilization values, each number or null.
- `frequency`: `current`, `min`, `max` in MHz, each nullable.
- `times`: interval `user`, `system`, `idle`, `iowait` percentages, each nullable. These are not cumulative seconds and need not sum to 100 because other CPU states exist.
- `load_average`: `[1m, 5m, 15m]` or null.
- `core_count`: `physical`, `logical`, nullable if unavailable.
- `temperature`: hottest identified CPU/package/core sensor in Celsius, or null.
- `processes`: CPU-descending top-10 records containing `pid`, `name`, `cpu_percent`, `memory_percent`. Utilization is null until the process baseline is primed; memory can be null if unavailable.
- `capabilities`: booleans for `cpu_times`, `per_core`, `frequency`, `load_average`, `temperature`, and `processes`.

Compact history retains only `timestamp`, `cpu_percent`, `frequency`, `temperature`, `per_core`, and `times`; repeated process lists are not retained.

## Configuration

- `SHELL_APP_CPU_INTERVAL`: CPU sampling cadence in seconds, default `1`.
- `SHELL_APP_CPU_PROCESS_INTERVAL`: expensive process-inspection cadence in seconds, default `5`. Its effective resolution cannot be finer than CPU sampling.

Both accept finite numeric values of at least `0.25`; missing, malformed, infinite, NaN, zero, negative or smaller values fall back to their defaults. Values in `app.config` take precedence over environment variables; set configuration before plugin registration.

## Measurement and platform limitations

- Host/per-core utilization needs two cumulative samples. The first sample, counter resets, zero elapsed CPU time, and changed core topology produce null until re-primed. Linux guest counters are excluded from the total because user/nice already include them.
- A process's first `cpu_percent(interval=None)` call primes its retained instance and reports null (unmeasured, not idle); subsequent process samples reflect utilization across the process cadence. Per-process usage can exceed 100% for multithreaded processes. Rows remain cached between process samples, including processes that exit in that interval.
- Access-denied/disappearing processes are skipped without failing host collection. Enumeration failure produces an empty process list and `capabilities.processes = false`; successful enumeration can still omit inaccessible processes.
- Missing temperature, frequency, load, and physical-core metadata are null, not invented zeroes. Temperature uses psutil's available hardware interfaces (including supported Linux thermal/hwmon sensors), selecting CPU/package/core labels or known CPU sensor names; disk temperatures are not substituted. No direct privileged commands or custom sysfs provider are added. Unsupported platforms may expose no temperature or I/O wait.
- Frequency values reflect what the OS/psutil exposes; zero/negative sentinels for unavailable frequencies or bounds become null. Load averages describe runnable workload, not percent utilization.
- History, cached snapshots and subscribers are in-memory and reset on application restart. Each application worker samples independently; use one worker for a single target host to avoid duplicate sampling and inconsistent worker-local history.
- No root requirement, system mutation, cron subprocess, per-browser sampler, or chart CDN dependency is introduced. Client reconnect/staleness/chart behavior belongs to the separate frontend. Memory/disk collectors and additional hardware providers remain future extensions.


## Frontend architecture and integration

`static/js/plugins/cpu_stats/plugin.js` exports `CPUStatsPlugin`, extending the
shell's JavaScript `Plugin` class. The honeycomb plugin registry exposes it as
**CPU Stats**. `CPUDashboard` composes the shared `MonitoringDashboard`,
`ReconnectingTransport`, `BoundedSeries`, and `CanvasChart` classes under
`static/js/plugins/monitoring/`. Styling is scoped in `static/css/monitoring.css`.

The dashboard shows summary cards, current per-core meters, a selectable core's
history, overall utilization, frequency, temperature and CPU-time history charts,
process rows, processor details and capability flags. History ranges are one,
five and fifteen minutes or one hour. Canvas charts use native JavaScript, with
accessible text summaries and no chart library/CDN.

The socket connects before the one-time history request; history merges with
in-flight samples without overwriting newer live data. Range changes fetch
history again, not live REST polling. The browser retains at most 14,400 compact
samples within a one-hour window and draws at most 600 points per line. WebSocket
reconnects use bounded exponential backoff. Hidden/minimized panels keep bounded
data but skip drawing; closing disposes sockets, fetches, timers, observers and
listeners. Unsupported/priming values display N/A and chart gaps, not zero.

Native WebSockets share the app's existing deployment trust boundary. These
read-only endpoints expose host/process metadata; restrict access at the reverse
proxy if deploying beyond a trusted network. Use a single application worker.

## Backend and frontend validation

`tests/test_cpu_stats.py` uses fake psutil providers and clocks for cross-worker deltas, priming/resets, unavailable metrics, process cadence/instance retention/PID reuse/permission failures, finite configuration, compact history, cached APIs, and serving lifecycle. Tests use the project's pytest runner.

Shared JavaScript tests run with
`node --test static/js/plugins/monitoring/monitoring.test.mjs`. They cover bounded
series, null gaps, safe rendering, live/history races, selection and cleanup.

## Original requirements (preserved)

The supplied source specification ends at the partial `- Web` bullet below; no missing requirements have been inferred.

### Build a Real-Time System Monitor Plugin for Codex

Develop a **System Monitor plugin** for the Codex web application (Jarvis Codex), running on a Raspberry Pi with Ubuntu Server.

The purpose of this plugin is to continuously monitor system performance, collect CPU statistics, and display the information in a real-time dashboard using interactive charts, graphs, and tabular data.

## 1. Architecture

Implement an object-oriented architecture with the following components:

- **SystemMonitor:** Main entry point and orchestrator for all system monitoring components.
- **CPUMonitor:** Collects CPU-related statistics.
- **MetricsCollector:** Periodically collects and normalizes system metrics.
- **MetricsStore:** Maintains recent metric history for graphs and historical views.
- **LiveUpdateService:** Sends updated metrics to the frontend through WebSockets.

Keep the architecture modular so that memory, disk, temperature, and process monitoring can be added later without major structural changes.

## 2. CPU Metrics

Use Python's `psutil` library as the primary data collection dependency.

Collect the following information:

- Overall CPU utilization percentage.
- Individual CPU core utilization.
- CPU frequency (current, minimum, maximum).
- CPU user, system, idle, and I/O wait times.
- CPU load averages (1, 5, and 15 minutes).
- Physical and logical CPU core counts.
- CPU temperature, wherever supported by the hardware.
- Top processes sorted by CPU utilization.

Use appropriate Linux system interfaces when `psutil` does not expose a required metric.

## 3. Real-Time Monitoring

The monitoring process must run continuously in the backend, independently of frontend requests.

- Collect CPU metrics at configurable intervals, defaulting to one second.
- Maintain a rolling history of collected metrics.
- Push new metrics to connected frontend clients through WebSockets.
- Avoid repeatedly requesting the backend through REST polling.
- Ensure monitoring starts and stops cleanly with the application lifecycle.
- Handle unavailable metrics gracefully without crashing the monitoring service.

## 4. Dashboard UI

Create a modern, responsive dashboard consistent with the existing Codex application design.

Include:

**Summary cards**
- Overall CPU usage.
- CPU temperature.
- Current CPU frequency.
- Number of CPU cores.

**Interactive charts**
- Overall CPU utilization over time.
- Individual core utilization.
- CPU frequency history.
- CPU temperature history.
- CPU user/system/idle breakdown.

**Tabular information**
- Individual CPU core statistics.
- Top processes by CPU utilization.
- Process ID, process name, CPU percentage, and memory percentage.
- Detailed CPU metrics with timestamps.

Charts must update automatically as new metrics arrive through WebSockets, without requiring a page refresh.

Provide configurable history ranges, such as 1 minute, 5 minutes, 15 minutes, and 1 hour.

## 5. Technical Requirements

- Python backend.
- `psutil` for CPU and process statistics.
- Web