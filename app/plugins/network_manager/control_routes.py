"""Thin cached network API; mutation request integrity is not authentication."""

import json
from urllib.parse import urlsplit

from quart import Blueprint, current_app, jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from app.plugins.network_manager.controller import NetworkControlError


def _origin_parts(value):
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.path not in {"", "/"}
                or parsed.query or parsed.fragment):
            return None
        return parsed.scheme, parsed.hostname.lower(), parsed.port or (
            443 if parsed.scheme == "https" else 80)
    except (ValueError, AttributeError):
        return None


def _same_origin():
    if request.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
        return False
    origin = request.headers.get("Origin")
    if origin is None:
        return True  # Non-browser CLI; no CORS response headers are added.
    candidate = _origin_parts(origin)
    if candidate is None:
        return False
    configured = current_app.config.get("SHELL_APP_NETWORK_PUBLIC_ORIGIN")
    if configured and candidate == _origin_parts(configured):
        return True
    # Host is trusted by deployment routing, not X-Forwarded-Host/Proto. Accept
    # either web scheme for TLS-terminating reverse proxies using the same host.
    return any(candidate == _origin_parts(f"{scheme}://{request.host}")
               for scheme in ("http", "https"))


def create_control_routes(controller):
    routes = Blueprint("network_manager_control", __name__)

    def error(code, message, status):
        return jsonify({"error": {"code": code, "message": message}}), status

    @routes.get("/api/network-manager/control")
    async def control():
        return jsonify(controller.snapshot())

    @routes.get("/api/network-manager/operations/<operation_id>")
    async def operation(operation_id):
        record = controller.get_operation(operation_id)
        if record is None:
            return error("not_found", "Network operation not found.", 404)
        return jsonify(record)

    @routes.post("/api/network-manager/actions")
    async def actions():
        if request.headers.get("X-Network-Control") != "1" or not _same_origin():
            return error("origin", "Network control request integrity check failed.", 403)
        if request.mimetype != "application/json":
            return error("invalid", "Content-Type must be application/json.", 400)
        request.max_content_length = 8192
        try:
            if request.content_length is not None and request.content_length > 8192:
                raise RequestEntityTooLarge()
            raw = await request.get_data()
            if len(raw) > 8192:
                raise RequestEntityTooLarge()

            def unique_object(pairs):
                obj = {}
                for key, value in pairs:
                    if key in obj:
                        raise ValueError("Duplicate JSON field")
                    obj[key] = value
                return obj

            payload = json.loads(raw, object_pairs_hook=unique_object,
                                 parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))
            record = await controller.submit(payload)
        except NetworkControlError as exc:
            return error(exc.code, exc.message, exc.http_status)
        except (BadRequest, RequestEntityTooLarge, ValueError, UnicodeError, RecursionError):
            return error("invalid", "Invalid or oversized JSON action payload.", 400)
        return jsonify({"operation": record}), 202

    return routes
