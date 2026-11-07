"""Process-local monitoring: one sampler, bounded history, latest-only delivery."""

import asyncio
import math
import time
from collections import deque
from collections.abc import Callable

from quart import Blueprint, Quart, jsonify, request, websocket

from app.core.logging import logger


def positive_number(value, default: float, minimum: float = 0.25) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) and number >= minimum else default


class MetricsStore:
    def __init__(self, capacity: int = 3600) -> None:
        self.samples: deque[dict] = deque(maxlen=max(1, capacity))

    def append(self, sample: dict) -> None:
        self.samples.append(sample)

    def history(self, seconds: int = 60, limit: int = 600) -> list[dict]:
        cutoff = time.time() - seconds
        samples = [item for item in self.samples if item["timestamp"] >= cutoff]
        if len(samples) <= limit:
            return samples
        if limit == 1:
            return samples[-1:]
        return [
            samples[round(index * (len(samples) - 1) / (limit - 1))]
            for index in range(limit)
        ]


class LiveUpdateService:
    def __init__(self, max_subscribers: int = 32) -> None:
        self.subscribers: set[asyncio.Queue] = set()
        self.max_subscribers = max_subscribers

    def subscribe(self) -> asyncio.Queue:
        if len(self.subscribers) >= self.max_subscribers:
            raise RuntimeError("Monitoring subscriber limit reached")
        queue = asyncio.Queue(maxsize=1)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.discard(queue)

    def publish(self, snapshot: dict) -> None:
        for queue in tuple(self.subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(snapshot)


class MonitoringService:
    """Collection is synchronous and runs off-loop; publication stays on-loop."""

    def __init__(
        self,
        collect: Callable[[], dict],
        interval: float = 1.0,
        compact: Callable[[dict], dict] | None = None,
        store: MetricsStore | None = None,
        live: LiveUpdateService | None = None,
    ) -> None:
        self.collect = collect
        self.interval = positive_number(interval, 1.0)
        self.compact = compact or (lambda sample: sample.copy())
        self.store = store if store is not None else MetricsStore(
            capacity=min(14400, math.ceil(3600 / self.interval) + 1)
        )
        self.live = live if live is not None else LiveUpdateService()
        self.snapshot: dict = {"timestamp": None, "status": "starting"}
        self.task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        if self.task is not None and not self.task.done():
            return
        self._stop = asyncio.Event()
        self.task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if self.task is not None:
            await self.task
            self.task = None

    async def _run(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                sample = await asyncio.to_thread(self.collect)
                sample.setdefault("timestamp", time.time())
                sample.setdefault("status", "ok")
                compact = self.compact(sample)
                self.store.append(compact)
                self.snapshot = sample
            except Exception:
                logger.exception("Monitoring sample collection failed")
                self.snapshot = {
                    **self.snapshot,
                    "status": "error",
                    "error": "Collection unavailable; retrying.",
                }
            self.live.publish(self.snapshot)
            remaining = max(0.01, self.interval - (time.monotonic() - started))
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                pass


def register_monitoring(
    app: Quart, name: str, service: MonitoringService, slug: str
) -> None:
    """Register cached APIs and lifecycle hooks without collecting in requests."""
    app.extensions[name] = service
    app.before_serving(service.start)
    app.after_serving(service.stop)
    routes = Blueprint(f"{name}_monitoring", __name__)

    @routes.get(f"/api/{slug}")
    async def snapshot():
        return jsonify(service.snapshot)

    @routes.get(f"/api/{slug}/history")
    async def history():
        try:
            seconds = int(request.args.get("seconds", "60"))
            limit = int(request.args.get("limit", "600"))
            if not 1 <= seconds <= 3600 or not 1 <= limit <= 600:
                raise ValueError
        except ValueError:
            return jsonify({"error": "seconds must be 1–3600; limit must be 1–600."}), 400
        return jsonify({"samples": service.store.history(seconds, limit)})

    @routes.websocket(f"/ws/{slug}")
    async def updates():
        tracker = app.extensions["socket_manager"]
        task = tracker.track_current_task()
        queue = None
        try:
            try:
                queue = service.live.subscribe()
            except RuntimeError:
                await websocket.close(1013)
                return
            await asyncio.wait_for(
                websocket.send_json({"type": "snapshot", "data": service.snapshot}),
                timeout=10,
            )

            async def sender():
                while True:
                    sample = await queue.get()
                    await asyncio.wait_for(
                        websocket.send_json({"type": "update", "data": sample}),
                        timeout=10,
                    )

            async def receiver():
                # Also wait for disconnect when there are no new samples.
                while True:
                    await websocket.receive()

            tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for completed in done:
                    completed.result()
            finally:
                for child in tasks:
                    child.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            if queue is not None:
                service.live.unsubscribe(queue)
            tracker.untrack_task(task)

    app.register_blueprint(routes)
