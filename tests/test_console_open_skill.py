import asyncio
import json
from dataclasses import is_dataclass
from pathlib import Path

from app import create_app
from app.plugins.console.skills import Skill, create_default_skill_registry
from app.plugins.console.skills.open_skill import OpenSkill


def test_open_skill_is_dataclass_and_auto_registered():
    skill = OpenSkill()
    assert is_dataclass(OpenSkill)
    assert isinstance(skill, Skill)
    assert skill.name == "open"
    assert skill.panel_state == "editor panel"

    registry = create_default_skill_registry()
    registered = registry.get("open")
    assert isinstance(registered, OpenSkill)
    skill_names = [entry["name"] for entry in registry.list_skills()]
    assert "open" in skill_names


def test_open_skill_read_existing_file_relative_and_absolute(tmp_path: Path):
    sample = tmp_path / "notes.txt"
    sample.write_text("line one\nline two\nline three", encoding="utf-8")
    skill = OpenSkill()

    async def run():
        rel_result = await skill.execute(
            session_id="sess-1",
            args="notes.txt",
            action="read",
            cwd=str(tmp_path),
        )
        assert rel_result.status == "ok"
        assert rel_result.panel_state == "editor panel"
        assert rel_result.skill == "open"
        assert rel_result.data["filepath"] == str(sample.resolve())
        assert rel_result.data["filename"] == "notes.txt"
        assert rel_result.data["content"] == "line one\nline two\nline three"
        assert rel_result.data["exists"] is True
        assert rel_result.data["writable"] is True
        assert rel_result.data["line_count"] == 3
        assert rel_result.data["action"] == "read"

        abs_result = await skill.execute(
            session_id="sess-1",
            args=f'"{sample}"',
            action="read",
        )
        assert abs_result.status == "ok"
        assert abs_result.data["filepath"] == str(sample.resolve())
        assert abs_result.data["line_count"] == 3

    asyncio.run(run())


def test_open_skill_read_nonexistent_file_creates_empty_buffer(tmp_path: Path):
    skill = OpenSkill()

    async def run():
        result = await skill.execute(
            session_id="sess-2",
            args="new_script.py",
            action="read",
            cwd=str(tmp_path),
        )
        assert result.status == "ok"
        assert result.panel_state == "editor panel"
        assert result.data["filename"] == "new_script.py"
        assert result.data["content"] == ""
        assert result.data["exists"] is False
        assert result.data["line_count"] == 1
        assert result.data["action"] == "read"

    asyncio.run(run())


def test_open_skill_write_creates_and_updates_file(tmp_path: Path):
    skill = OpenSkill()
    nested_rel = "subdir/config.yaml"
    expected_path = (tmp_path / nested_rel).resolve()

    async def run():
        write_result = await skill.execute(
            session_id="sess-3",
            args=nested_rel,
            action="write",
            content="host: localhost\nport: 8080\n",
            cwd=str(tmp_path),
        )
        assert write_result.status == "ok"
        assert write_result.panel_state == "editor panel"
        assert write_result.data["action"] == "write"
        assert write_result.data["exists"] is True
        assert write_result.data["line_count"] == 3
        assert expected_path.read_text(encoding="utf-8") == "host: localhost\nport: 8080\n"

    asyncio.run(run())


def test_open_skill_rejects_empty_path_directory_binary_and_unknown_action(
    tmp_path: Path,
):
    skill = OpenSkill()
    binary_file = tmp_path / "blob.bin"
    binary_file.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")

    async def run():
        empty_res = await skill.execute(session_id="s1", args="   ")
        assert empty_res.status == "error"
        assert empty_res.panel_state == "terminal"
        assert "required" in empty_res.message

        dir_res = await skill.execute(
            session_id="s1", args=str(tmp_path), action="read"
        )
        assert dir_res.status == "error"
        assert "Cannot open directory" in dir_res.message

        bin_res = await skill.execute(
            session_id="s1", args="blob.bin", action="read", cwd=str(tmp_path)
        )
        assert bin_res.status == "error"
        assert "binary" in bin_res.message.lower()

        bad_action_res = await skill.execute(
            session_id="s1", args="notes.txt", action="delete", cwd=str(tmp_path)
        )
        assert bad_action_res.status == "error"
        assert "Unsupported action" in bad_action_res.message

    asyncio.run(run())


def test_open_skill_http_and_websocket_dispatch(tmp_path: Path):
    target_file = tmp_path / "hello.txt"
    target_file.write_text("hello world", encoding="utf-8")
    application = create_app()

    async def run():
        async with application.test_client() as client:
            # HTTP read
            read_resp = await client.post(
                "/console/skills/open",
                json={
                    "session_id": "http-sess",
                    "action": "read",
                    "args": str(target_file),
                },
            )
            assert read_resp.status_code == 200
            read_json = await read_resp.get_json()
            assert read_json["status"] == "ok"
            assert read_json["panel_state"] == "editor panel"
            assert read_json["data"]["content"] == "hello world"
            assert read_json["data"]["action"] == "read"

            # HTTP write
            write_resp = await client.post(
                "/console/skills/open",
                json={
                    "session_id": "http-sess",
                    "action": "write",
                    "args": str(target_file),
                    "content": "updated via http\nsecond line",
                },
            )
            assert write_resp.status_code == 200
            write_json = await write_resp.get_json()
            assert write_json["status"] == "ok"
            assert write_json["data"]["action"] == "write"
            assert write_json["data"]["line_count"] == 2
            assert target_file.read_text(encoding="utf-8") == "updated via http\nsecond line"

            # WebSocket read & write
            async with client.websocket("/console/ws") as ws:
                await ws.send(
                    json.dumps(
                        {
                            "session_id": "ws-sess",
                            "type": "skill",
                            "skill": "open",
                            "action": "read",
                            "args": str(target_file),
                        }
                    )
                )
                raw_reply = await ws.receive()
                reply = json.loads(raw_reply)
                assert reply["type"] == "skill_result"
                assert reply["skill"] == "open"
                assert reply["status"] == "ok"
                assert reply["panel_state"] == "editor panel"
                assert reply["data"]["content"] == "updated via http\nsecond line"

                await ws.send(
                    json.dumps(
                        {
                            "session_id": "ws-sess",
                            "type": "skill",
                            "skill": "open",
                            "action": "write",
                            "args": str(target_file),
                            "content": "updated via ws",
                        }
                    )
                )
                raw_write_reply = await ws.receive()
                write_reply = json.loads(raw_write_reply)
                assert write_reply["status"] == "ok"
                assert write_reply["data"]["action"] == "write"
                assert target_file.read_text(encoding="utf-8") == "updated via ws"

    asyncio.run(run())
