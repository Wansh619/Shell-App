from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
import struct

from quart import Quart

from app.core.socket_manager import SocketManager
from app.plugins.console.plugin import ConsolePlugin
from app.plugins.console.skills import create_default_skill_registry
from app.plugins.console.skills.image_skill import ImageSkill, extract_image_dimensions
from app.plugins.console.utils.manager import ConsoleManager
from app.plugins.console.utils.services import ConsoleService


def _build_minimal_png(width: int = 16, height: int = 12) -> bytes:
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    ihdr_chunk = struct.pack(">I", len(ihdr_data)) + b"IHDR" + ihdr_data + b"\x00\x00\x00\x00"
    iend_chunk = struct.pack(">I", 0) + b"IEND" + b"\xaeB`\x82"
    return b"\x89PNG\r\n\x1a\n" + ihdr_chunk + iend_chunk


def _build_minimal_gif(width: int = 24, height: int = 18) -> bytes:
    return b"GIF89a" + struct.pack("<HH", width, height) + b"\x00\x00\x00;"


def _build_minimal_jpeg(width: int = 32, height: int = 20) -> bytes:
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof0_payload = b"\x08" + struct.pack(">HH", height, width) + b"\x03\x01\x11\x00\x02\x11\x01\x03\x11\x01"
    sof0 = b"\xff\xc0" + struct.pack(">H", len(sof0_payload) + 2) + sof0_payload
    return b"\xff\xd8" + app0 + sof0 + b"\xff\xd9"


def _build_test_app() -> Quart:
    app = Quart(__name__)
    service = ConsoleService(
        create_record=lambda _sid: None,
        delete_record=lambda _sid: None,
        list_records=lambda: [],
    )
    plugin = ConsolePlugin(
        console_manager=ConsoleManager(),
        socket_manager=SocketManager(),
        service=service,
    )
    plugin.register(app)
    return app


def test_default_registry_includes_image_skill():
    registry = create_default_skill_registry()
    skill = registry.get("image")

    assert isinstance(skill, ImageSkill)
    assert skill.name == "image"
    assert skill.panel_state == "image panel"


def test_image_skill_reads_png_and_extracts_dimensions(tmp_path: Path):
    png_bytes = _build_minimal_png(width=64, height=48)
    png_file = tmp_path / "sample.png"
    png_file.write_bytes(png_bytes)

    skill = ImageSkill()
    result = asyncio.run(
        skill.execute(
            session_id="sess-png",
            args="sample.png",
            action="read",
            cwd=str(tmp_path),
        )
    )

    assert result.status == "ok"
    assert result.skill == "image"
    assert result.panel_state == "image panel"
    assert result.message == "Loaded image sample.png"
    assert result.data["filepath"] == str(png_file.resolve())
    assert result.data["filename"] == "sample.png"
    assert result.data["mime_type"] == "image/png"
    assert result.data["size_bytes"] == len(png_bytes)
    assert result.data["width"] == 64
    assert result.data["height"] == 48
    assert result.data["panel_state"] == "image panel"
    assert result.data["action"] == "read"
    expected_b64 = base64.b64encode(png_bytes).decode("ascii")
    assert result.data["data_url"] == f"data:image/png;base64,{expected_b64}"
    assert "/console/skills/image/raw?session_id=sess-png&path=" in result.data["raw_url"]


def test_image_skill_reads_svg_with_attributes_and_viewbox(tmp_path: Path):
    svg_content = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 135"><rect width="240" height="135"/></svg>'
    svg_file = tmp_path / "vector.svg"
    svg_file.write_text(svg_content, encoding="utf-8")

    skill = ImageSkill()
    result = asyncio.run(
        skill.execute(
            session_id="sess-svg",
            args=f'"{svg_file.name}"',
            action="read",
            cwd=str(tmp_path),
        )
    )

    assert result.status == "ok"
    assert result.panel_state == "image panel"
    assert result.data["mime_type"] == "image/svg+xml"
    assert result.data["width"] == 240
    assert result.data["height"] == 135
    assert result.data["data_url"].startswith("data:image/svg+xml;base64,")


def test_extract_dimensions_for_gif_jpeg_and_malformed_bytes():
    assert extract_image_dimensions(_build_minimal_gif(30, 15), "image/gif") == (30, 15)
    assert extract_image_dimensions(_build_minimal_jpeg(128, 96), "image/jpeg") == (128, 96)
    assert extract_image_dimensions(b"not-an-image-header", "image/png") == (None, None)


def test_image_skill_error_cases(tmp_path: Path):
    skill = ImageSkill()

    # Unsupported action
    bad_action = asyncio.run(
        skill.execute(session_id="s1", args="foo.png", action="write", cwd=str(tmp_path))
    )
    assert bad_action.status == "error"
    assert bad_action.panel_state == "terminal"
    assert "Unsupported action for image skill: write" in bad_action.message

    # Empty args
    empty_args = asyncio.run(
        skill.execute(session_id="s1", args="   ", action="read", cwd=str(tmp_path))
    )
    assert empty_args.status == "error"
    assert empty_args.panel_state == "terminal"
    assert "Image file path is required" in empty_args.message

    # Non-existent file
    missing_file = asyncio.run(
        skill.execute(session_id="s1", args="missing.png", action="read", cwd=str(tmp_path))
    )
    assert missing_file.status == "error"
    assert missing_file.panel_state == "terminal"
    assert "Image file not found" in missing_file.message

    # Directory instead of file
    sub_dir = tmp_path / "subdir.png"
    sub_dir.mkdir()
    dir_result = asyncio.run(
        skill.execute(session_id="s1", args="subdir.png", action="read", cwd=str(tmp_path))
    )
    assert dir_result.status == "error"
    assert "Image file not found" in dir_result.message

    # Non-image file extension
    txt_file = tmp_path / "notes.txt"
    txt_file.write_text("hello world", encoding="utf-8")
    unsupported_ext = asyncio.run(
        skill.execute(session_id="s1", args="notes.txt", action="read", cwd=str(tmp_path))
    )
    assert unsupported_ext.status == "error"
    assert unsupported_ext.panel_state == "terminal"
    assert "Unsupported image format: .txt" in unsupported_ext.message


def test_console_image_skill_http_and_websocket_routes(tmp_path: Path):
    png_bytes = _build_minimal_png(width=40, height=30)
    png_file = tmp_path / "diagram.png"
    png_file.write_bytes(png_bytes)

    app = _build_test_app()

    async def run_client_checks():
        client = app.test_client()

        # 1. Verify /console/skills lists image skill
        skills_resp = await client.get("/console/skills")
        assert skills_resp.status_code == 200
        skills_data = await skills_resp.get_json()
        skill_names = {entry["name"]: entry for entry in skills_data["skills"]}
        assert "image" in skill_names
        assert skill_names["image"]["panel_state"] == "image panel"

        # 2. Verify POST /console/skills/image
        post_resp = await client.post(
            "/console/skills/image",
            json={
                "session_id": "http-sess",
                "action": "read",
                "args": str(png_file),
            },
        )
        assert post_resp.status_code == 200
        post_payload = await post_resp.get_json()
        assert post_payload["status"] == "ok"
        assert post_payload["panel_state"] == "image panel"
        assert post_payload["data"]["width"] == 40
        assert post_payload["data"]["height"] == 30

        # 3. Verify GET /console/skills/image/raw using raw_url returned by skill
        raw_resp = await client.get(post_payload["data"]["raw_url"])
        assert raw_resp.status_code == 200
        assert raw_resp.mimetype == "image/png"
        raw_body = await raw_resp.get_data()
        assert raw_body == png_bytes

        # 4. Verify WebSocket /console/ws skill execution
        async with client.websocket("/console/ws") as ws:
            await ws.send(
                json.dumps(
                    {
                        "session_id": "ws-sess",
                        "type": "skill",
                        "skill": "image",
                        "action": "read",
                        "args": str(png_file),
                    }
                )
            )
            ws_raw = await ws.receive()
            ws_payload = json.loads(ws_raw)
            assert ws_payload["type"] == "skill_result"
            assert ws_payload["session_id"] == "ws-sess"
            assert ws_payload["skill"] == "image"
            assert ws_payload["status"] == "ok"
            assert ws_payload["panel_state"] == "image panel"
            assert ws_payload["data"]["filename"] == "diagram.png"
            assert ws_payload["data"]["width"] == 40
            assert ws_payload["data"]["height"] == 30

    asyncio.run(run_client_checks())
