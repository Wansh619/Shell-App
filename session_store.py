import sqlite3
from datetime import datetime, timezone
from pathlib import Path


DB_PATH = Path(__file__).resolve().parent / "terminal_sessions.db"


def _get_connection():
    return sqlite3.connect(DB_PATH)


def init_db():
    with _get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS terminal_sessions (
                session_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                status TEXT NOT NULL
            )
            """
        )
        conn.commit()


def create_session(session_id):
    created_at = datetime.now(timezone.utc).isoformat()
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO terminal_sessions (session_id, created_at, status)
            VALUES (?, ?, ?)
            """,
            (session_id, created_at, "active"),
        )
        conn.commit()


def delete_session(session_id):
    with _get_connection() as conn:
        conn.execute(
            "DELETE FROM terminal_sessions WHERE session_id = ?",
            (session_id,),
        )
        conn.commit()


def list_sessions():
    with _get_connection() as conn:
        cursor = conn.execute(
            "SELECT session_id, created_at, status FROM terminal_sessions"
        )
        return cursor.fetchall()


def clear_sessions():
    with _get_connection() as conn:
        conn.execute("DELETE FROM terminal_sessions")
        conn.commit()
