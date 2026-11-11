import json
import os

from quart import Blueprint, websocket

from app.core.logging import logger
from app.core.socket_manager import SocketManager
from app.plugins.console.models.models import (
    ConsoleErrorPayload,
    ConsoleOutputPayload,
    ConsoleReadyPayload,
)
from app.plugins.console.skills import SkillRegistry, create_default_skill_registry
from app.plugins.console.utils.console import ConsoleSession
from app.plugins.console.utils.manager import ConsoleManager
from app.plugins.console.utils.services import ConsoleService


def create_sockets(
    console_manager: ConsoleManager,
    socket_manager: SocketManager,
    service: ConsoleService,
    skill_registry: SkillRegistry | None = None,
) -> Blueprint:
    sockets = Blueprint("console_sockets", __name__)
    registry = skill_registry or create_default_skill_registry()

    async def _handle_console_ws():
        client_sessions: dict[str, ConsoleSession] = {}
        task = socket_manager.track_current_task()

        async def send_output(session_id: str, value: str) -> None:
            payload = ConsoleOutputPayload(session_id=session_id, value=value).to_dict()
            await websocket.send(json.dumps(payload))

        try:
            while True:
                raw = await websocket.receive()
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                if not isinstance(message, dict):
                    continue

                session_id = message.get("session_id")
                if not isinstance(session_id, str):
                    continue
                session_id = session_id.strip()
                value = message.get("value")

                if not session_id:
                    continue

                if message.get("type") == "resize":
                    session = client_sessions.get(session_id)
                    cols = message.get("cols")
                    rows = message.get("rows")
                    if (
                        session
                        and isinstance(cols, int)
                        and not isinstance(cols, bool)
                        and isinstance(rows, int)
                        and not isinstance(rows, bool)
                        and cols > 0
                        and rows > 0
                        and cols <= 65535
                        and rows <= 65535
                    ):
                        session.resize(cols, rows)
                    continue

                if message.get("type") == "skill":
                    skill_name = str(message.get("skill") or "").strip()
                    action = str(message.get("action") or "read").strip()
                    args = str(message.get("args") or "")
                    content = (
                        message.get("content")
                        if isinstance(message.get("content"), str)
                        else None
                    )
                    session = client_sessions.get(session_id) or console_manager.get(
                        session_id
                    )
                    cwd = (
                        session.get_cwd()
                        if session is not None and hasattr(session, "get_cwd")
                        else os.getcwd()
                    )
                    result = await registry.execute(
                        skill_name,
                        session_id=session_id,
                        args=args,
                        action=action,
                        content=content,
                        cwd=cwd,
                    )
                    await websocket.send(json.dumps(result.to_dict()))
                    continue

                if isinstance(value, str) and value.startswith("__CTRL__:"):
                    command = value[len("__CTRL__:") :].strip().upper()

                    if command == "CREATE":
                        if session_id in client_sessions:
                            continue
                        session = ConsoleSession(session_id, send_output)
                        client_sessions[session_id] = session
                        console_manager.add(session_id, session)
                        try:
                            try:
                                service.create_record(session_id)
                            except Exception:
                                logger.exception("Failed to create DB session record")
                            await session.start()
                            logger.info("Console session started: %s", session_id)
                            await websocket.send(
                                json.dumps(
                                    ConsoleReadyPayload(
                                        session_id=session_id,
                                        prompt_token=session.prompt_token,
                                    ).to_dict()
                                )
                            )
                        except Exception:
                            logger.exception("Failed to start console session")
                            client_sessions.pop(session_id, None)
                            console_manager.remove(session_id)
                            await session.close()
                            try:
                                service.delete_record(session_id)
                            except Exception:
                                logger.exception(
                                    "Failed to delete DB session record"
                                )
                            await websocket.send(
                                json.dumps(
                                    ConsoleErrorPayload(
                                        session_id=session_id,
                                        message="Unable to start terminal session.",
                                    ).to_dict()
                                )
                            )
                        continue

                    if command == "CLOSE":
                        session = client_sessions.pop(session_id, None)
                        if session:
                            await session.close()
                            logger.info("Console session closed: %s", session_id)
                        console_manager.remove(session_id)
                        try:
                            service.delete_record(session_id)
                        except Exception:
                            logger.exception("Failed to delete DB session record")
                        continue

                    continue

                session = client_sessions.get(session_id)
                if session and isinstance(value, str):
                    await session.write(value)
        except Exception:
            logger.info("Client disconnected")
        finally:
            for session_id, session in list(client_sessions.items()):
                try:
                    await session.close()
                except Exception:
                    logger.exception(
                        "Failed to close console session after disconnect"
                    )
                else:
                    logger.info(
                        "Console session closed after disconnect: %s", session_id
                    )
                console_manager.remove(session_id)
                try:
                    service.delete_record(session_id)
                except Exception:
                    logger.exception("Failed to delete DB session record")
            client_sessions.clear()
            socket_manager.untrack_task(task)

    @sockets.websocket("/terminal")
    async def terminal():
        await _handle_console_ws()

    @sockets.websocket("/console/ws")
    async def console_ws():
        await _handle_console_ws()

    return sockets
