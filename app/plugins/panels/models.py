from typing import TypedDict


class LogUpdate(TypedDict):
    content: str
    offset: int
    generation: str
    reset: bool
