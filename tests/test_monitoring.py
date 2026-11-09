import asyncio
import time

from quart import Quart

from app.core.monitoring import (
    LiveUpdateService,
    MetricsStore,
    MonitoringService,
    positive_number,
    register_monitoring,
)
from app.core.socket_manager import SocketManager


def test_configuration_rejects_nonfinite_and_too_fast_intervals():
    for value in (None, "bad", "nan", "inf", -1, 0, 0.01):
        assert positive_number(value, 2) == 2
    assert positive_number("0.5", 2) == 0.5


def test_history_is_bounded_filtered_and_preserves_endpoints():
    store = MetricsStore(capacity=5)
    now = time.time()
    for index in range(10):
        store.append({"timestamp": now - 10 + index, "value": index})
    assert len(store.samples) == 5
    assert [sample["value"] for sample in store.history(60, 3)] == [5, 7, 9]
    assert store.history(60, 1)[0]["value"] == 9
    assert store.history(1) == []


def test_latest_only_fanout_and_subscriber_limit():
    live = LiveUpdateService(max_subscribers=2)
    first = live.subscribe()
    second = live.subscribe()
    try:
        live.subscribe()
    except RuntimeError:
        pass
    else:
        raise AssertionError("Subscriber cap must be enforced")
    for index in range(100):
        live.publish({"value": index})
    assert first.qsize() == second.qsize() == 1
    assert first.get_nowait() == second.get_nowait() == {"value": 99}
    live.unsubscribe(first)
    live.unsubscribe(second)
    assert not live.subscribers


def test_single_collector_lifecycle_and_error_recovery():
    async def exercise():
        calls = []

        def collect():
            calls.append(time.monotonic())
            if len(calls) == 1:
                raise OSError("temporary provider failure")
            return {"value": len(calls)}

        service = MonitoringService(collect, interval=0.25)
        queues = [service.live.subscribe(), service.live.subscribe()]
        await service.start()
        task = service.task
        await service.start()
        assert service.task is task
        first = await asyncio.wait_for(queues[0].get(), 2)
        assert first["status"] == "error"
        second = await asyncio.wait_for(queues[0].get(), 2)
        assert second["status"] == "ok"
        assert second["value"] == 2
        assert queues[1].qsize() == 1
        await service.stop()
        count = len(calls)
        await asyncio.sleep(0.05)
        assert len(calls) == count
        assert service.task is None
        await service.start()
        await asyncio.wait_for(queues[0].get(), 2)
        await service.stop()

    asyncio.run(exercise())


def test_cached_routes_history_validation_and_websocket_cleanup():
    async def exercise():
        application = Quart(__name__)
        application.extensions["socket_manager"] = SocketManager()
        service = MonitoringService(lambda: {"value": 42}, interval=0.25)
        register_monitoring(application, "test_monitor", service, "test-monitor")
        client = application.test_client()
        # Requests do not start a collector.
        response = await client.get("/api/test-monitor")
        assert (await response.get_json())["status"] == "starting"
        assert service.task is None
        for query in ("seconds=0", "seconds=3601", "seconds=x", "limit=0", "limit=601"):
            response = await client.get(f"/api/test-monitor/history?{query}")
            assert response.status_code == 400
        async with application.test_app():
            async with client.websocket("/ws/test-monitor") as connection:
                initial = await connection.receive_json()
                assert initial["type"] == "snapshot"
                update = await asyncio.wait_for(connection.receive_json(), 2)
                assert update["type"] == "update"
                assert update["data"]["value"] == 42
                response = await client.get("/api/test-monitor/history?seconds=60")
                assert (await response.get_json())["samples"]
            # Quart finishes disconnect cleanup asynchronously.
            for _ in range(20):
                if not service.live.subscribers:
                    break
                await asyncio.sleep(0.01)
            assert not service.live.subscribers
            assert not application.extensions["socket_manager"].active_tasks
        assert service.task is None

    asyncio.run(exercise())
