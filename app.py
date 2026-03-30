from quart import Quart, websocket, render_template, jsonify
import json
from term import TerminalSession
from session_store import (
    init_db,
    create_session,
    delete_session,
    list_sessions,
    clear_sessions,
)

app = Quart(__name__)

sessions = {}


@app.before_serving
async def startup():
    init_db()
    # Remove stale rows from previous unclean exits.
    clear_sessions()


@app.after_serving
async def shutdown():
    # Ensure local session table is empty on graceful app stop.
    clear_sessions()


@app.websocket("/terminal")
async def terminal():
    client_sessions = {}

    async def send_output(session_id, value):
        payload = {"session_id": session_id, "value": value}
        await websocket.send(json.dumps(payload))

    try:
        while True:
            raw = await websocket.receive()
            try:
                message = json.loads(raw)
            except Exception:
                continue

            session_id = (message.get("session_id") or "").strip()
            value = message.get("value")

            if not session_id:
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
                    except Exception as error:
                        print(f"Failed to create DB session record: {error}")
                    await session.start()
                    continue

                if command == "CLOSE":
                    session = client_sessions.pop(session_id, None)
                    if session:
                        session.close()
                    sessions.pop(session_id, None)
                    try:
                        delete_session(session_id)
                    except Exception as error:
                        print(f"Failed to delete DB session record: {error}")
                    continue

                continue

            session = client_sessions.get(session_id)
            if not session:
                continue

            if isinstance(value, str):
                await session.write(value)
    except Exception:
        print("Client disconnected")
    finally:
        for session_id, session in list(client_sessions.items()):
            try:
                session.close()
            except Exception:
                pass
            sessions.pop(session_id, None)
            try:
                delete_session(session_id)
            except Exception as error:
                print(f"Failed to delete DB session record: {error}")
        client_sessions.clear()


@app.route("/")
async def index():
    return await render_template("index.html")


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


if __name__ == "__main__":
    app.run(debug=True)