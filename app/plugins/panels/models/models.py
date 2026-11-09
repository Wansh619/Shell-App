from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class LogUpdate:
    content: str
    offset: int
    generation: str
    reset: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def __getitem__(self, key: str) -> Any:
        return self.to_dict()[key]

    def keys(self):
        return self.to_dict().keys()

    def get(self, key: str, default: Any = None) -> Any:
        return self.to_dict().get(key, default)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, LogUpdate):
            return (
                self.content == other.content
                and self.offset == other.offset
                and self.generation == other.generation
                and self.reset == other.reset
            )
        if isinstance(other, dict):
            return self.to_dict() == other
        return NotImplemented


@dataclass
class PanelTemplateMap:
    templates: dict[str, str] = field(
        default_factory=lambda: {"home": "index.html", "console": "console.html"}
    )

    def get_template(self, panel_name: str) -> str:
        return self.templates[panel_name]

    def to_dict(self) -> dict[str, str]:
        return dict(self.templates)
