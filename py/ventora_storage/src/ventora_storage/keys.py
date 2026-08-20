from __future__ import annotations

import re

_SAFE_CHAR_RE = re.compile(r"[^a-zA-Z0-9._\-]")
_VALID_TENANT_RE = re.compile(r"^[a-zA-Z0-9\-]+$")

MAX_FILENAME_LENGTH = 200


def sanitize_filename(name: str) -> str:
    """Normalize a filename to safe characters only."""
    name = name.replace("/", "_").replace("\\", "_").lstrip("_")
    name = _SAFE_CHAR_RE.sub("_", name)
    name = re.sub(r"_+", "_", name)
    name = re.sub(r"\.{2,}", ".", name)
    name = name[:MAX_FILENAME_LENGTH]
    name = name.strip("._")
    return name if name else "file"


def build_tenant_key(tenant_id: str, *segments: str) -> str:
    """Build a storage key scoped to a tenant. Prevents path traversal."""
    if not tenant_id or not _VALID_TENANT_RE.match(tenant_id):
        raise ValueError(f"Invalid tenant_id: {tenant_id!r}")
    if not segments:
        raise ValueError("At least one path segment is required.")
    for segment in segments:
        if ".." in segment:
            raise ValueError(f"Path traversal detected in segment: {segment!r}")
    sanitized = [sanitize_filename(segment) for segment in segments]
    path = f"{tenant_id}/{'/'.join(sanitized)}"
    return path
