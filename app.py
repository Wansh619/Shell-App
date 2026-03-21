from quart import Quart, websocket, render_template, jsonify
import uuid
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

    session_id = str(uuid.uuid4())
    session = TerminalSession(websocket)
    sessions[session_id] = session
    try:
        create_session(session_id)
    except Exception as error:
        print(f"Failed to create DB session record: {error}")

    try:
        await session.start()
        while True:
            data = await websocket.receive()
            await session.write(data)
    except Exception:
        print("Client disconnected")
    finally:
        session.close()
        sessions.pop(session_id, None)
        try:
            delete_session(session_id)
        except Exception as error:
            print(f"Failed to delete DB session record: {error}")


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