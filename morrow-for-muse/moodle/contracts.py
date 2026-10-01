"""Moodle site validation and safe operation errors."""
import os
import re
from typing import Dict, Optional
from urllib.parse import urlparse
from config.site_url import canonical_netloc


def normalize_moodle_base(raw):
    """Require HTTPS and keep a simple Moodle site path when provided.

    The lane carries the educator's session cookies, credentials, and
    sesskey, so a plaintext base would ship them unencrypted. An
    http:// base is refused loudly unless the educator explicitly sets
    MOODLE_BASE_ALLOW_HTTP=1 (test fixtures and LAN-only deployments
    only; never for a real tenant). Call this BEFORE any session is
    created or any cookie is attached, so no secret ever touches
    plaintext.
    """
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("Moodle base URL is empty")
    if any(ord(char) < 32 for char in raw):
        raise ValueError("Moodle base URL must not contain control characters")
    parsed = urlparse(raw if "://" in raw else "https://" + raw)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid Moodle base URL port") from exc
    if (parsed.username is not None or parsed.password is not None
            or "?" in raw or "#" in raw or "\\" in raw
            or "%" in raw or parsed.params):
        raise ValueError("Moodle base URL must contain only a site host and path")
    if parsed.scheme == "http" and os.environ.get(
            "MOODLE_BASE_ALLOW_HTTP") != "1":
        raise ValueError(
            "refusing plaintext http:// Moodle base: session cookies "
            "and credentials would cross the network unencrypted. Use "
            "https://, or set MOODLE_BASE_ALLOW_HTTP=1 to acknowledge "
            "the risk (test fixtures and LAN-only deployments only)."
        )
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("could not parse Moodle base URL")
    if not parsed.hostname or (port is not None and port == 0):
        raise ValueError("Moodle base URL must contain only a site host and path")
    path = parsed.path
    if path not in ("", "/"):
        if "//" in path or not path.startswith("/"):
            raise ValueError("Moodle base URL has an ambiguous site path")
        path = path.rstrip("/")
        segments = path[1:].split("/")
        if any(segment in (".", "..") or not re.fullmatch(
                r"[A-Za-z0-9._~-]+", segment) for segment in segments):
            raise ValueError("Moodle base URL has an unsafe site path")
    else:
        path = ""
    return parsed.scheme + "://" + canonical_netloc(parsed) + path



class MoodleLaneError(Exception):
    """Base lane error. Carries a machine-readable class and the raw signal."""

    def __init__(self, kind: str, detail: str, signal: Optional[Dict] = None):
        super().__init__("%s: %s" % (kind, detail))
        self.kind = kind          # "reauth" | "sesskey" | "provider" | "network"
        self.detail = detail
        self.signal = signal or {}
