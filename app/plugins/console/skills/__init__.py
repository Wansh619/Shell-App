from __future__ import annotations

from .base import Skill, SkillRegistry
from .models import (
    EditorViewModel,
    ImageViewModel,
    SkillPayload,
    SkillResultPayload,
)


def create_default_skill_registry() -> SkillRegistry:
    registry = SkillRegistry()
    try:
        from .open_skill import OpenSkill

        registry.register(OpenSkill())
    except ImportError:
        pass

    try:
        from .image_skill import ImageSkill

        registry.register(ImageSkill())
    except ImportError:
        pass

    return registry


__all__ = [
    "Skill",
    "SkillRegistry",
    "SkillPayload",
    "SkillResultPayload",
    "EditorViewModel",
    "ImageViewModel",
    "create_default_skill_registry",
]
