import asyncio


class SocketManager:
    def __init__(self) -> None:
        self.active_tasks: set[asyncio.Task] = set()

    def track_current_task(self) -> asyncio.Task | None:
        task = asyncio.current_task()
        if task is not None:
            self.active_tasks.add(task)
        return task

    def untrack_task(self, task: asyncio.Task | None) -> None:
        if task is not None:
            self.active_tasks.discard(task)

    def cancel_active_tasks(self) -> None:
        for task in tuple(self.active_tasks):
            task.cancel()
