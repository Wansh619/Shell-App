"""Interactive console plugin with skills support."""

import sys

from app.plugins.console import skills as _skills
from app.plugins.console.models import (
    ConsoleErrorPayload,
    ConsoleMessage,
    ConsoleOutputPayload,
    ConsoleReadyPayload,
    EditorViewModel,
    ImageViewModel,
    SessionResponse,
    SkillPayload,
    SkillResultPayload,
    TerminalErrorPayload,
    TerminalMessage,
    TerminalOutputPayload,
    TerminalReadyPayload,
)
from app.plugins.console.plugin import ConsolePlugin, TerminalPlugin
from app.plugins.console.skills import (
    Skill,
    SkillRegistry,
    create_default_skill_registry,
)
from app.plugins.console.utils import (
    ConsoleManager,
    ConsoleService,
    ConsoleSession,
    TerminalManager,
    TerminalService,
    TerminalSession,
    clear_sessions,
    create_routes,
    create_session,
    create_sockets,
    delete_session,
    init_db,
    list_sessions,
    resolve_shell,
)
from app.plugins.console.utils import (
    console as _console,
    manager as _manager,
    routes as _routes,
    services as _services,
    sockets as _sockets,
    storage as _storage,
    terminal as _terminal,
)

sys.modules[f"{__name__}.manager"] = _manager
sys.modules[f"{__name__}.routes"] = _routes
sys.modules[f"{__name__}.services"] = _services
sys.modules[f"{__name__}.sockets"] = _sockets
sys.modules[f"{__name__}.storage"] = _storage
sys.modules[f"{__name__}.terminal"] = _terminal
sys.modules[f"{__name__}.console"] = _console
sys.modules[f"{__name__}.skills"] = _skills

__all__ = [
    "ConsolePlugin",
    "TerminalPlugin",
    "ConsoleManager",
    "TerminalManager",
    "ConsoleService",
    "TerminalService",
    "ConsoleSession",
    "TerminalSession",
    "resolve_shell",
    "create_routes",
    "create_sockets",
    "init_db",
    "create_session",
    "delete_session",
    "list_sessions",
    "clear_sessions",
    "ConsoleMessage",
    "TerminalMessage",
    "SessionResponse",
    "ConsoleOutputPayload",
    "TerminalOutputPayload",
    "ConsoleReadyPayload",
    "TerminalReadyPayload",
    "ConsoleErrorPayload",
    "TerminalErrorPayload",
    "SkillPayload",
    "SkillResultPayload",
    "EditorViewModel",
    "ImageViewModel",
    "Skill",
    "SkillRegistry",
    "create_default_skill_registry",
]
