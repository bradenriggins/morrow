"""Read-only Moodle session check for a caller holding a live session.

The scheduled shell process cannot load a browser session from JSON. Call
``probe_session`` only inside the process that owns the in-memory
``MoodleSession``. This module never reads or writes a credential file.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional
from urllib.parse import urljoin, urlparse

from .login import SESSKEY_RE, USERID_RE
from .session import MoodleSession


# Viewer-chrome principal markers, in preference order. M.cfg's
# "userid" is authoritative where the theme serializes it; some
# themes (e.g. the stock Moodle 5.2 theme on sandbox.moodledemo.net)
# omit it, in which case the viewer's own chrome carries the same id
# (data-userid on the notification popover / user menu). Every marker
# used here is viewer-specific: a page never renders another user's
# id in these spots.
_DATA_USERID_RE = re.compile(r'data-userid="(\d+)"')


def _extract_principal_id(body: str) -> Optional[int]:
    """Best-effort viewer id from viewer-specific chrome markers.

    Returns None when no marker is present or when markers disagree
    (ambiguous: the caller must stay fail-closed and report
    unverified, never guess).
    """
    candidates = []
    m = USERID_RE.search(body)
    if m:
        candidates.append(int(m.group(1)))
    chrome_ids = {int(dm.group(1))
                  for dm in _DATA_USERID_RE.finditer(body)}
    if len(chrome_ids) == 1:
        candidates.append(next(iter(chrome_ids)))
    elif len(chrome_ids) > 1:
        return None  # conflicting chrome markers: ambiguous
    if not candidates:
        return None
    if len(set(candidates)) != 1:
        return None  # markers disagree: ambiguous
    return candidates[0]


def _result(state: str, status: int | None = None,
            principal_id: int | None = None) -> Dict[str, Any]:
    return {"state": state, "http_status": status,
            "principal_id": principal_id}


def probe_session(sess: MoodleSession) -> Dict[str, Any]:
    """GET the signed-in page once; report only status and pinned identity.

    No redirect is followed. A 200 is healthy only when the page contains
    the same principal id and sesskey that the live session already holds.
    The response body and session values never enter the result.
    """
    try:
        pinned_id = int(sess.principal.get("id"))
    except (TypeError, ValueError, AttributeError):
        return _result("unverified")

    requested_url = sess.base + "/my/"
    try:
        resp = sess.session.get(requested_url, timeout=sess.timeout,
                                allow_redirects=False)
    except Exception:
        return _result("unverified")

    status = resp.status_code
    expected = urlparse(sess.base)
    actual = urlparse(resp.url)
    login_path = expected.path.rstrip("/") + "/login"

    def is_login_path(path: str) -> bool:
        return path == login_path or path.startswith(login_path + "/")

    if (actual.scheme, actual.netloc) != (expected.scheme, expected.netloc):
        return _result("unverified", status)
    if status in (401, 403) or is_login_path(actual.path):
        return _result("expired", status)
    requested = urlparse(requested_url)
    if (actual.path != requested.path or actual.query or actual.fragment):
        return _result("unverified", status)
    if 300 <= status < 400:
        location = urlparse(urljoin(requested_url,
                                   resp.headers.get("Location", "")))
        if ((location.scheme, location.netloc) ==
                (expected.scheme, expected.netloc)
                and is_login_path(location.path)):
            return _result("expired", status)
        return _result("unverified", status)
    if status != 200:
        return _result("unverified", status)

    body = resp.text
    if re.search(r"<form\b[^>]*\baction=[\"'][^\"']*login", body,
                 re.IGNORECASE):
        return _result("expired", status)
    principal_id = _extract_principal_id(body)
    sesskey = SESSKEY_RE.search(body)
    if principal_id is None or sesskey is None:
        return _result("unverified", status)
    if principal_id != pinned_id:
        return _result("principal_mismatch", status)
    if sesskey.group(1) != sess.sesskey:
        return _result("session_changed", status)
    return _result("healthy", status, pinned_id)
