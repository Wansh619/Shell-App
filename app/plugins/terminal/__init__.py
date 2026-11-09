"""Interactive terminal plugin."""

import sys

from app.plugins.terminal.models import SessionResponse, TerminalMessage
from app.plugins.terminal.plugin import TerminalPlugin
from app.plugins.terminal.utils import (
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
from app.plugins.terminal.utils import (
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

__all__ = [
    "TerminalPlugin",
    "TerminalManager",
    "TerminalService",
    "TerminalSession",
    "resolve_shell",
    "create_routes",
    "create_sockets",
    "init_db",
    "create_session",
    "delete_session",
    "list_sessions",
    "clear_sessions",
    "TerminalMessage",
    "SessionResponse",
]
