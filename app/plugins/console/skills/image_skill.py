from __future__ import annotations

import base64
from dataclasses import dataclass
import os
from pathlib import Path
import re
import struct
from urllib.parse import quote

from app.plugins.console.skills.base import Skill
from app.plugins.console.skills.models import ImageViewModel, SkillResultPayload

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

_SVG_TAG_RE = re.compile(r"<svg\b[^>]*>", re.IGNORECASE | re.DOTALL)
_SVG_WIDTH_RE = re.compile(r'\bwidth\s*=\s*["\']\s*([0-9]+(?:\.[0-9]+)?)\s*(?:px)?\s*["\']', re.IGNORECASE)
_SVG_HEIGHT_RE = re.compile(r'\bheight\s*=\s*["\']\s*([0-9]+(?:\.[0-9]+)?)\s*(?:px)?\s*["\']', re.IGNORECASE)
_SVG_VIEWBOX_RE = re.compile(
    r'\bviewBox\s*=\s*["\']\s*[-+0-9.]+\s*[, ]\s*[-+0-9.]+\s*[, ]\s*([0-9]+(?:\.[0-9]+)?)\s*[, ]\s*([0-9]+(?:\.[0-9]+)?)\s*["\']',
    re.IGNORECASE,
)


def _strip_Wrapping_quotes(value: str) -> str:
    cleaned = (value or "").strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {"'", '"'}:
        return cleaned[1:-1].strip()
    return cleaned


def _parse_jpeg_dimensions(data: bytes) -> tuple[int | None, int | None]:
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None, None

    index = 2
    length = len(data)
    sof_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }

    while index < length:
        while index < length and data[index] != 0xFF:
            index += 1
        while index < length and data[index] == 0xFF:
            index += 1
        if index >= length:
            break

        marker = data[index]
        index += 1

        if marker in {0xD8, 0xD9, 0x01} or 0xD0 <= marker <= 0xD7:
            continue

        if index + 2 > length:
            break
        segment_length = struct.unpack(">H", data[index : index + 2])[0]
        if segment_length < 2 or index + segment_length > length:
            break

        if marker in sof_markers and segment_length >= 7:
            height, width = struct.unpack(">HH", data[index + 3 : index + 7])
            if width > 0 and height > 0:
                return width, height
            return None, None

        index += segment_length

    return None, None


def _parse_svg_dimensions(data: bytes) -> tuple[int | None, int | None]:
    text = data[:8192].decode("utf-8", errors="ignore")
    tag_match = _SVG_TAG_RE.search(text)
    if not tag_match:
        return None, None

    svg_tag = tag_match.group(0)
    width: int | None = None
    height: int | None = None

    width_match = _SVG_WIDTH_RE.search(svg_tag)
    height_match = _SVG_HEIGHT_RE.search(svg_tag)
    if width_match:
        width = int(round(float(width_match.group(1))))
    if height_match:
        height = int(round(float(height_match.group(1))))

    if width is None or height is None:
        viewbox_match = _SVG_VIEWBOX_RE.search(svg_tag)
        if viewbox_match:
            if width is None:
                width = int(round(float(viewbox_match.group(1))))
            if height is None:
                height = int(round(float(viewbox_match.group(2))))

    if width is not None and height is not None and width > 0 and height > 0:
        return width, height
    return None, None


def _parse_webp_dimensions(data: bytes) -> tuple[int | None, int | None]:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None, None

    chunk_type = data[12:16]
    if chunk_type == b"VP8 " and len(data) >= 30 and data[23:26] == b"\x9d\x01\x2a":
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if chunk_type == b"VP8L" and len(data) >= 25 and data[20] == 0x2F:
        bits = struct.unpack("<I", data[21:25])[0]
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
        return width, height
    if chunk_type == b"VP8X" and len(data) >= 30:
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    return None, None


def extract_image_dimensions(
    data: bytes, mime_type: str = ""
) -> tuple[int | None, int | None]:
    try:
        if mime_type == "image/svg+xml" or data.lstrip().startswith((b"<svg", b"<?xml")):
            width, height = _parse_svg_dimensions(data)
            if width is not None and height is not None:
                return width, height

        if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
            width, height = struct.unpack(">II", data[16:24])
            if width > 0 and height > 0:
                return width, height

        if len(data) >= 10 and data[:6] in {b"GIF87a", b"GIF89a"}:
            width, height = struct.unpack("<HH", data[6:10])
            if width > 0 and height > 0:
                return width, height

        if len(data) >= 4 and data[:2] == b"\xff\xd8":
            width, height = _parse_jpeg_dimensions(data)
            if width is not None and height is not None:
                return width, height

        if len(data) >= 26 and data[:2] == b"BM":
            width, height = struct.unpack("<ii", data[18:26])
            height = abs(height)
            if width > 0 and height > 0:
                return width, height

        if len(data) >= 8 and data[:4] == b"\x00\x00\x01\x00":
            width = data[6] or 256
            height = data[7] or 256
            return width, height

        if len(data) >= 30 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            width, height = _parse_webp_dimensions(data)
            if width is not None and height is not None:
                return width, height
    except Exception:
        return None, None

    return None, None


@dataclass
class ImageSkill(Skill):
    name: str = "image"
    panel_state: str = "image panel"
    description: str = "Open and preview image files in the console image panel."

    async def execute(
        self,
        session_id: str,
        args: str = "",
        action: str = "read",
        content: str | None = None,
        cwd: str | None = None,
    ) -> SkillResultPayload:
        normalized_action = (action or "read").strip().lower() or "read"
        if normalized_action != "read":
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state="terminal",
                status="error",
                message=f"Unsupported action for image skill: {action}",
            )

        raw_arg = _strip_Wrapping_quotes(args)
        if not raw_arg:
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state="terminal",
                status="error",
                message="Image file path is required for the image skill.",
            )

        expanded_path = Path(raw_arg).expanduser()
        base_dir = Path(cwd or os.getcwd()).expanduser()
        try:
            target = (
                expanded_path
                if expanded_path.is_absolute()
                else (base_dir / expanded_path)
            ).resolve()
        except OSError as error:
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state="terminal",
                status="error",
                message=f"Invalid image file path: {error}",
            )

        if not target.exists() or not target.is_file():
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state="terminal",
                status="error",
                message=f"Image file not found: {target}",
            )

        ext = target.suffix.lower()
        mime_type = SUPPORTED_IMAGE_MIME_TYPES.get(ext)
        if not mime_type:
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state="terminal",
                status="error",
                message=f"Unsupported image format: {target.suffix or target.name}",
            )

        try:
            raw_bytes = target.read_bytes()
        except OSError as error:
            return SkillResultPayload(
                session_id=session_id,
                skill=self.name,
                panel_state="terminal",
                status="error",
                message=f"Unable to read image file {target.name}: {error}",
            )

        size_bytes = len(raw_bytes)
        b64_str = base64.b64encode(raw_bytes).decode("ascii")
        data_url = f"data:{mime_type};base64,{b64_str}"
        raw_url = (
            f"/console/skills/image/raw?session_id={quote(session_id)}"
            f"&path={quote(str(target))}"
        )
        width, height = extract_image_dimensions(raw_bytes, mime_type)

        view_model = ImageViewModel(
            filepath=str(target),
            filename=target.name,
            mime_type=mime_type,
            size_bytes=size_bytes,
            data_url=data_url,
            raw_url=raw_url,
            width=width,
            height=height,
            panel_state=self.panel_state,
        )

        return SkillResultPayload(
            session_id=session_id,
            skill=self.name,
            panel_state=self.panel_state,
            status="ok",
            data={**view_model.to_dict(), "action": "read"},
            message=f"Loaded image {target.name}",
        )
