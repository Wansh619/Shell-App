import json

from quart import Blueprint, websocket

from app.core.socket_manager import SocketManager
from app.core.logging import logger
from app.plugins.terminal.manager import TerminalManager
from app.plugins.terminal.services import TerminalService
from app.plugins.terminal.terminal import TerminalSession


def create_sockets(
    terminal_manager: TerminalManager,
    socket_manager: SocketManager,
    service: TerminalService,
) -> Blueprint:
    sockets = Blueprint("terminal_sockets", __name__)

    @sockets.websocket("/terminal")
    async def terminal():
        client_sessions: dict[str, TerminalSession] = {}
        task = socket_manager.track_current_task()

        async def send_output(session_id: str, value: str) -> None:
            payload = {"session_id": session_id, "value": value}
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

                if isinstance(value, str) and value.startswith("__CTRL__:"):
                    command = value[len("__CTRL__:") :].strip().upper()

                    if command == "CREATE":
                        if session_id in client_sessions:
                            continue
                        session = TerminalSession(session_id, send_output)
                        client_sessions[session_id] = session
                        terminal_manager.add(session_id, session)
                        try:
                            try:
                                service.create_record(session_id)
                            except Exception:
                                logger.exception("Failed to create DB session record")
                            await session.start()
                            logger.info("Terminal session started: %s", session_id)
                            await websocket.send(
                                json.dumps(
                                    {
                                        "session_id": session_id,
                                        "type": "ready",
                                        "prompt_token": session.prompt_token,
                                    }
                                )
                            )
                        except Exception:
                            logger.exception("Failed to start terminal session")
                            client_sessions.pop(session_id, None)
                            terminal_manager.remove(session_id)
                            await session.close()
                            try:
                                service.delete_record(session_id)
                            except Exception:
                                logger.exception(
                                    "Failed to delete DB session record"
                                )
                            await websocket.send(
                                json.dumps(
                                    {
                                        "session_id": session_id,
                                        "type": "error",
                                        "message": "Unable to start terminal session.",
                                    }
                                )
                            )
                        continue

                    if command == "CLOSE":
                        session = client_sessions.pop(session_id, None)
                        if session:
                            await session.close()
                            logger.info("Terminal session closed: %s", session_id)
                        terminal_manager.remove(session_id)
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
                        "Failed to close terminal session after disconnect"
                    )
                else:
                    logger.info(
                        "Terminal session closed after disconnect: %s", session_id
                    )
                terminal_manager.remove(session_id)
                try:
                    service.delete_record(session_id)
                except Exception:
                    logger.exception("Failed to delete DB session record")
            client_sessions.clear()
            socket_manager.untrack_task(task)

    return sockets
