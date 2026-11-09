"""Page and log-panel plugin."""

import sys

from app.plugins.panels.models import LogUpdate, PanelTemplateMap
from app.plugins.panels.plugin import PanelsPlugin
from app.plugins.panels.utils import (
    PanelManager,
    PanelService,
    create_routes,
    manager as _manager,
    routes as _routes,
    services as _services,
)

sys.modules["app.plugins.panels.manager"] = _manager
sys.modules["app.plugins.panels.routes"] = _routes
sys.modules["app.plugins.panels.services"] = _services

__all__ = [
    "PanelsPlugin",
    "LogUpdate",
    "PanelTemplateMap",
    "PanelManager",
    "PanelService",
    "create_routes",
]
