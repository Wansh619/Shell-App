import base64
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import time

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _read_exact(connection, size):
    chunks = bytearray()
    while len(chunks) < size:
        chunk = connection.recv(size - len(chunks))
        if not chunk:
            raise ConnectionError("WebSocket closed before a complete frame arrived")
        chunks.extend(chunk)
    return bytes(chunks)


def _send_websocket_message(connection, message):
    payload = json.dumps(message).encode()
    mask = secrets.token_bytes(4)
    masked_payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    length = len(payload)
    if length < 126:
        header = bytes((0x81, 0x80 | length))
    elif length < 65536:
        header = bytes((0x81, 0x80 | 126)) + length.to_bytes(2, "big")
    else:
        header = bytes((0x81, 0x80 | 127)) + length.to_bytes(8, "big")
    connection.sendall(header + mask + masked_payload)


def _receive_websocket_message(connection):
    first, second = _read_exact(connection, 2)
    length = second & 0x7F
    if length == 126:
        length = int.from_bytes(_read_exact(connection, 2), "big")
    elif length == 127:
        length = int.from_bytes(_read_exact(connection, 8), "big")

    payload = _read_exact(connection, length)
    if second & 0x80:
        mask = _read_exact(connection, 4)
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return first & 0x0F, payload.decode(errors="replace")


def test_sigint_stops_server_with_an_active_terminal_session():
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]

    startup = (
        "import asyncio, app; "
        "app.init_db = lambda: None; "
        "app.clear_sessions = lambda: None; "
        "app.create_session = lambda *_: None; "
        "app.delete_session = lambda *_: None; "
        f"asyncio.run(app.run_server(port={port}))"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", startup],
        cwd=PROJECT_ROOT,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    connection = socket.socket()
    connection.settimeout(2)

    try:
        deadline = time.monotonic() + 8
        while True:
            try:
                connection.connect(("127.0.0.1", port))
                break
            except OSError:
                if process.poll() is not None or time.monotonic() >= deadline:
                    pytest.fail("The app server did not start")
                time.sleep(0.1)

        key = base64.b64encode(secrets.token_bytes(16)).decode()
        connection.sendall(
            (
                f"GET /terminal HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{port}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )

        response = bytearray()
        while b"\r\n\r\n" not in response:
            response.extend(connection.recv(4096))
        assert response.startswith(b"HTTP/1.1 101")

        _send_websocket_message(
            connection,
            {"session_id": "shutdown-test", "value": "__CTRL__:CREATE"},
        )
        _send_websocket_message(
            connection,
            {"session_id": "shutdown-test", "value": "printf '__pty_ready__\\n'\n"},
        )

        output = ""
        deadline = time.monotonic() + 5
        while "__pty_ready__" not in output and time.monotonic() < deadline:
            opcode, message = _receive_websocket_message(connection)
            if opcode == 1:
                output += message
        assert "__pty_ready__" in output

        process.send_signal(signal.SIGINT)
        assert process.wait(timeout=5) == 0
    finally:
        connection.close()
        if process.poll() is None:
            process.kill()
            process.wait()
