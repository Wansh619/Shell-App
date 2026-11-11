from __future__ import annotations

import mimetypes
import os
from pathlib import Path

from quart import Blueprint, Response, jsonify, request

from app.plugins.console.skills import SkillRegistry, create_default_skill_registry
from app.plugins.console.utils.manager import ConsoleManager
from app.plugins.console.utils.services import ConsoleService

SUPPORTED_IMAGE_MIME_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
}


def _resolve_session_cwd(
    console_manager: ConsoleManager | None, session_id: str
) -> str:
    if console_manager and session_id:
        session = console_manager.get(session_id)
        if session is not None and hasattr(session, "get_cwd"):
            return session.get_cwd()
    return os.getcwd()


def create_routes(
    service: ConsoleService,
    skill_registry: SkillRegistry | None = None,
    console_manager: ConsoleManager | None = None,
) -> Blueprint:
    routes = Blueprint("console_routes", __name__)
    registry = skill_registry or create_default_skill_registry()

    @routes.get("/sessions")
    async def get_sessions():
        try:
            return jsonify(service.list_sessions()), 200
        except Exception as error:
            return jsonify({"error": f"Failed to fetch sessions: {error}"}), 500

    @routes.get("/console/skills")
    async def list_console_skills():
        return jsonify({"skills": registry.list_skills()}), 200

    @routes.post("/console/skills/<skill_name>")
    async def execute_console_skill(skill_name: str):
        payload = await request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid JSON payload."}), 400

        session_id = str(payload.get("session_id") or "").strip()
        action = str(payload.get("action") or "read").strip()
        args = str(payload.get("args") or "")
        content = payload.get("content") if isinstance(payload.get("content"), str) else None
        cwd = _resolve_session_cwd(console_manager, session_id)

        result = await registry.execute(
            skill_name=skill_name,
            session_id=session_id,
            args=args,
            action=action,
            content=content,
            cwd=cwd,
        )
        status_code = 200 if result.status == "ok" else 400
        return jsonify(result.to_dict()), status_code

    @routes.get("/console/skills/image/raw")
    async def get_raw_skill_image():
        raw_path = (request.args.get("path") or "").strip()
        session_id = (request.args.get("session_id") or "").strip()
        if not raw_path:
            return jsonify({"error": "Missing image path."}), 400

        cwd = _resolve_session_cwd(console_manager, session_id)
        expanded = os.path.expanduser(raw_path)
        target = Path(expanded) if os.path.isabs(expanded) else Path(cwd) / expanded
        try:
            resolved = target.resolve()
        except OSError as error:
            return jsonify({"error": f"Invalid image path: {error}"}), 400

        if not resolved.exists() or not resolved.is_file():
            return jsonify({"error": "Image file not found."}), 404

        ext = resolved.suffix.lower()
        mime_type = SUPPORTED_IMAGE_MIME_TYPES.get(ext)
        if not mime_type:
            guessed, _ = mimetypes.guess_type(str(resolved))
            if guessed and guessed.startswith("image/"):
                mime_type = guessed

        if not mime_type:
            return jsonify({"error": "Unsupported image format."}), 400

        try:
            raw_bytes = resolved.read_bytes()
        except OSError as error:
            return jsonify({"error": f"Unable to read image file: {error}"}), 400

        return Response(raw_bytes, mimetype=mime_type)

    return routes
