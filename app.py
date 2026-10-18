import asyncio
import json
import signal

from quart import Quart, websocket, render_template, jsonify
from term import TerminalSession
from utils.logging import logger
from session_store import (
    init_db,
    create_session,
    delete_session,
    list_sessions,
    clear_sessions,
)

app = Quart(__name__)

sessions = {}
active_terminal_tasks = set()


@app.before_serving
async def startup():
    init_db()
    # Remove stale rows from previous unclean exits.
    clear_sessions()


@app.after_serving
async def shutdown():
    for session_id, session in list(sessions.items()):
        try:
            await session.close()
        except Exception:
            logger.exception("Failed to close terminal session during shutdown")
        finally:
            sessions.pop(session_id, None)
    clear_sessions()


@app.websocket("/terminal")
async def terminal():
    client_sessions = {}
    task = asyncio.current_task()
    if task:
        active_terminal_tasks.add(task)

    async def send_output(session_id, value):
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

            # Control messages (minimal protocol): value is a string starting with "__CTRL__:"
            if isinstance(value, str) and value.startswith("__CTRL__:"):
                command = value[len("__CTRL__:") :].strip().upper()

                if command == "CREATE":
                    if session_id in client_sessions:
                        continue
                    session = TerminalSession(session_id, send_output)
                    client_sessions[session_id] = session
                    sessions[session_id] = session
                    try:
                        create_session(session_id)
                    except Exception:
                        logger.exception("Failed to create DB session record")
                    try:
                        await session.start()
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
                        sessions.pop(session_id, None)
                        await session.close()
                        try:
                            delete_session(session_id)
                        except Exception:
                            logger.exception("Failed to delete DB session record")
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
                    sessions.pop(session_id, None)
                    try:
                        delete_session(session_id)
                    except Exception:
                        logger.exception("Failed to delete DB session record")
                    continue

                continue

            session = client_sessions.get(session_id)
            if not session:
                continue

            if isinstance(value, str):
                await session.write(value)
    except Exception:
        logger.info("Client disconnected")
    finally:
        for session_id, session in list(client_sessions.items()):
            try:
                await session.close()
            except Exception:
                logger.exception("Failed to close terminal session after disconnect")
            sessions.pop(session_id, None)
            try:
                delete_session(session_id)
            except Exception:
                logger.exception("Failed to delete DB session record")
        client_sessions.clear()
        if task:
            active_terminal_tasks.discard(task)


@app.route("/")
async def index():
    return await render_template("index.html")


@app.route("/console")
async def console():
    return await render_template("console.html")


@app.route("/sessions")
async def get_sessions():
    try:
        rows = list_sessions()
        data = [
            {"session_id": row[0], "created_at": row[1], "status": row[2]}
            for row in rows
        ]
        return jsonify(data), 200
    except Exception as error:
        return jsonify({"error": f"Failed to fetch sessions: {error}"}), 500


async def run_server(host="127.0.0.1", port=5000):
    loop = asyncio.get_running_loop()
    shutdown_event = asyncio.Event()

    def request_shutdown():
        shutdown_event.set()
        for task in tuple(active_terminal_tasks):
            task.cancel()

    handled_signals = (signal.SIGINT, signal.SIGTERM)
    for handled_signal in handled_signals:
        loop.add_signal_handler(handled_signal, request_shutdown)

    try:
        await app.run_task(
            host=host,
            port=port,
            debug=True,
            shutdown_trigger=shutdown_event.wait,
        )
    finally:
        for handled_signal in handled_signals:
            loop.remove_signal_handler(handled_signal)


if __name__ == "__main__":
    asyncio.run(run_server())