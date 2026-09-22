"""CDP access for the session-capture rig, through the login helper's
token-authenticated /cdp/* proxy (W4-P0-3).

The old client in this file spoke raw unauthenticated TCP CDP
(websocket handshake + /json/list) to a manually launched rig Chrome on
127.0.0.1:9222. That listener no longer exists anywhere: Chromium runs
with --remote-debugging-pipe, whose file descriptors are private to the
browser-owning process, so no other local process can reach CDP over
TCP at all. Nothing in this file opens a CDP socket.

The rig flow now attaches through the login helper, which owns the
browser: the educator signs in through the helper page, and capture.py
reaches the helper's browser through its /cdp/* proxy. Every request
carries the tree's X-Helper-Token (0600 token file); the proxied CDP
method must be on the server's allowlist and the target must be a live
tab id. This is the only cross-process CDP path.

Fail-closed: when the helper is not serving, the token is absent, or
no tenant tab exists, these functions raise instead of guessing.
"""
import json
import os
import sys

_TRANSPORT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "transport")
if _TRANSPORT_DIR not in sys.path:
    sys.path.insert(0, _TRANSPORT_DIR)

import local_chromium as lc


def _proxy_post(path, body, timeout):
    code, raw = lc._helper_request("POST", path, body, timeout=timeout)
    if code != 200:
        raise RuntimeError(
            "helper CDP proxy %s failed: HTTP %d %s"
            % (path, code, raw[:160].decode("utf-8", "replace")))
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise RuntimeError(
            "helper CDP proxy %s returned non-JSON" % path)


def cdp_call(target_id, method, params, timeout=30):
    """One CDP call on a live target through the helper proxy."""
    data = _proxy_post("/cdp/call",
                       {"target_id": target_id, "method": method,
                        "params": params or {}, "timeout": timeout},
                       timeout=timeout + 5)
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError("CDP %s failed: %s"
                           % (method, data["error"]))
    return (data or {}).get("result", {})


def _isolated_world(target_id, timeout=30):
    """An isolated world in the target for unforgeable probes (W4-P1-12):
    page JS can replace window.fetch, so fetch/document reads that decide
    anything run here, never in the page's default realm."""
    # Page.createIsolatedWorld requires the frame that hosts the world.
    # The root frame id comes from Page.getFrameTree first (both methods
    # are on the helper's proxy allowlist); a missing frameId would make
    # Chromium reject the call.
    tree = cdp_call(target_id, "Page.getFrameTree", {}, timeout=timeout)
    try:
        frame_id = tree["frameTree"]["frame"]["id"]
    except (KeyError, TypeError):
        raise RuntimeError(
            "Page.getFrameTree returned no root frame id")
    if not frame_id or not isinstance(frame_id, str):
        raise RuntimeError(
            "Page.getFrameTree returned no root frame id")
    data = _proxy_post("/cdp/call",
                       {"target_id": target_id,
                        "method": "Page.createIsolatedWorld",
                        "params": {"frameId": frame_id,
                                   "worldName": "morrow_rig_probe"},
                        "timeout": timeout},
                       timeout=timeout + 5)
    result = (data or {}).get("result") or {}
    context_id = result.get("executionContextId")
    if context_id is None:
        raise RuntimeError(
            "Page.createIsolatedWorld returned no executionContextId")
    return context_id


def _evaluate_world(target_id, expression, timeout=30):
    data = _proxy_post(
        "/cdp/evaluate",
        {"target_id": target_id, "expression": expression,
         "await_promise": True,
         "context_id": _isolated_world(target_id, timeout=timeout),
         "timeout": timeout},
        timeout=timeout + 5)
    if not isinstance(data, dict) or not data.get("ok"):
        raise RuntimeError((data or {}).get("error")
                           or "CDP evaluate failed")
    return data.get("value")


def find_tab(base):
    """Target id of a page tab on the tenant origin (never a hardcoded
    tab id). Exact-origin match, never a prefix match."""
    data = _proxy_post("/cdp/tabs", {}, timeout=30)
    tabs = (data or {}).get("tabs") or []
    origin = base.rstrip("/")
    base_origin = lc._origin_of(origin)
    if base_origin is None:
        raise RuntimeError("unusable tenant base %r" % base)
    for t in tabs:
        if t.get("type") != "page":
            continue
        if lc._origin_of(t.get("url", "")) == base_origin:
            return t.get("id")
    raise RuntimeError(
        "no tab on %s in the helper browser; the educator must have the "
        "tenant open (signed in through the helper page)" % origin)


def tab_fetch(base, path):
    """GET path inside the authenticated tab. Returns (status, body_text).

    The fetch runs in an isolated world (W4-P1-12), so page JS cannot
    forge the response by replacing window.fetch. Read-only for GET
    paths.
    """
    target_id = find_tab(base)
    js = ("fetch(%s, {headers: {'Accept': 'application/json'}})"
          ".then(r => r.text().then(t => JSON.stringify("
          "{status: r.status, url: r.url, body: t})))"
          % json.dumps(path))
    value = _evaluate_world(target_id, js, timeout=60)
    try:
        resp = json.loads(value) if isinstance(value, str) else {}
    except ValueError:
        resp = {}
    return resp.get("status"), resp.get("body", "")


def read_document_cookie(target_id, timeout=30):
    """Live document.cookie from the isolated world (W4-P1-12): the
    isolated world shares the DOM but page-realm JS cannot redefine
    what this read sees, so a hostile page cannot hide the CSRF."""
    value = _evaluate_world(target_id, "document.cookie", timeout=timeout)
    return value if isinstance(value, str) else ""
