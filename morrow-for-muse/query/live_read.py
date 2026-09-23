#!/usr/bin/env python3
"""Live read path for the failed-students query chain.

Every real API call in the chain runs through the Canvas login
helper's authenticated browser context (this tree's helper port,
LOGIN_HELPER_PORT, default 8901): the helper's Chromium session fetches
/api/v1 URLs in-page, so Canvas auth never leaves the browser. Helper
calls go through transport/local_chromium's helper client, the same
one the executor uses: it reads the tree's helper token where
keepalive writes it (<MORROW_HOME>/trees/<tree id>/helper_token) and
the port and TLS settings from the environment, then helper/env. This
module never performs shell-side HTTP with credentials and never logs
the token.

Pagination: Canvas collection endpoints paginate via Link
rel="next" headers. fetch_paginated follows them (same origin only),
merges JSON-array pages, and reports truncation loudly instead of
silently returning a partial collection.

Stdlib only.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.parse

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

from config import tree_config as _tree_config  # noqa: E402
from transport import local_chromium as _lc  # noqa: E402


def tenant_base():
    """The educator's Canvas origin: CANVAS_BASE from the environment,
    then helper/env, then the legacy global env; "" when none is set
    (the chain then fails closed with the setup message). Never
    hardcoded."""
    return _tree_config.canvas_base()


MAX_PAGES = 20          # bound on pagination, fail-loud past it
MAX_BODY_BYTES = 500000  # bound on a single page body read in-page


def _pinned_principal_id():
    """The educator's Canvas user id pinned at onboarding.

    Read from the lane state (transport/state.py); None when no
    onboarding has pinned a principal yet. Never hardcoded.
    """
    try:
        from transport import state as _lane_state
    except Exception:
        return None
    try:
        lane = _lane_state.load()
    except Exception:
        return None
    if not isinstance(lane, dict):
        return None
    # transport/state.py persists {"canvas": {"principal": {"id": N,
    # "name": ...}}}; accept a legacy flat {"principal": ...} shape too.
    canvas = lane.get("canvas") if isinstance(lane.get("canvas"), dict) else {}
    principal = canvas.get("principal") or lane.get("principal") or {}
    pid = principal.get("id")
    return pid if isinstance(pid, int) else None


class LiveReadError(Exception):
    """A read through the helper failed or the helper is unhealthy."""


def _check_token():
    """The tree's helper token must exist and be well formed (0600,
    never logged); the helper client sends it on every call."""
    path = _lc.helper_token_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError as exc:
        raise LiveReadError(
            "helper token file %r is unreadable: %s" % (path, exc))
    if not (len(token) == 64
            and all(c in "0123456789abcdef" for c in token)):
        raise LiveReadError(
            "helper token file %r is malformed; refusing unauthenticated "
            "helper calls" % path)


class _HelperClient:
    """Token-authenticated client for the helper's CDP routes."""

    def __init__(self, timeout=45):
        _check_token()
        self._timeout = timeout

    def _post(self, path, payload):
        try:
            status, raw = _lc._helper_request("POST", path, payload,
                                              timeout=self._timeout)
        except RuntimeError as exc:
            raise LiveReadError("helper %s failed: %s" % (path, exc))
        try:
            return status, json.loads(raw.decode("utf-8"))
        except ValueError:
            raise LiveReadError(
                "helper %s returned a body that is not JSON" % path)

    def status(self):
        try:
            return _lc.helper_status(timeout=15)
        except (RuntimeError, ValueError) as exc:
            raise LiveReadError("helper /status failed: %s" % exc)

    def tabs(self):
        _, data = self._post("/cdp/tabs", {})
        return data.get("tabs") or []

    def evaluate(self, target_id, expression, timeout=30):
        _, data = self._post("/cdp/evaluate", {
            "target_id": target_id,
            "expression": expression,
            "await_promise": True,
            "timeout": timeout,
        })
        if not data.get("ok"):
            raise LiveReadError(
                "in-page evaluate failed: %s" % data.get("error"))
        return data.get("value")


_FETCH_JS = """(async () => {
  const url = %s;
  const resp = await fetch(url, {headers: {"Accept": "application/json"}});
  const headers = {};
  resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const text = await resp.text();
  return {status: resp.status, headers: headers,
          body: text.slice(0, %d), truncated_body: text.length > %d};
})()"""


def _js_get(url):
    return _FETCH_JS % (json.dumps(url), MAX_BODY_BYTES, MAX_BODY_BYTES)


_NEXT_LINK_RE = re.compile(r"<([^>]+)>\s*;\s*rel=\"next\"", re.IGNORECASE)


def _next_link(link_header):
    if not link_header:
        return None
    for part in str(link_header).split(","):
        m = _NEXT_LINK_RE.search(part.strip())
        if m:
            return m.group(1)
    return None


def _same_origin(url, tenant):
    try:
        return urllib.parse.urlsplit(url).netloc.lower() == \
            urllib.parse.urlsplit(tenant).netloc.lower()
    except ValueError:
        return False


def _scratch_tab(client, tenant):
    """Create a dedicated scratch tab on the tenant for API reads.

    The educator's existing tabs are never navigated or evaluated in;
    the scratch tab is closed when the reader is closed. The tab is
    polled until its location settles on the tenant (a fresh tab's
    execution context cannot fetch until the navigation completes).
    """
    _, data = client._post("/cdp/new-tab", {"url": tenant + "/"})
    tab_id = data.get("id") or data.get("targetId")
    if not tab_id:
        raise LiveReadError("helper did not return a tab id for the "
                            "scratch tab")
    import time as _time
    for _ in range(20):
        try:
            href = client.evaluate(tab_id, "location.href", timeout=10)
        except LiveReadError:
            href = ""
        if isinstance(href, str) and href.startswith(tenant):
            return tab_id
        _time.sleep(1)
    raise LiveReadError("scratch tab never settled on the tenant; "
                        "refusing to read on a half-loaded tab")


class LiveReader:
    """Authenticated read client bound to one helper session.

    Usage:
        reader = LiveReader(tenant_base())
        reader.health_check()          # session alive + Canvas logged in
        status, rows, note = reader.get_paginated("/api/v1/courses/89585/quizzes?per_page=100")
    """

    def __init__(self, tenant):
        self._tenant = str(tenant or "").rstrip("/")
        if not self._tenant:
            raise LiveReadError("no Canvas base URL to read from")
        self._client = _HelperClient()
        self._tab_id = None
        self.principal = None

    def health_check(self):
        st = self._client.status()
        if not st.get("chromium_alive"):
            raise LiveReadError("helper Chromium is not alive")
        if not st.get("logged_in"):
            raise LiveReadError("helper session is not logged in to Canvas")
        # In-page principal check: users/self must be the educator.
        # In-page principal check: users/self must be the educator pinned
        # in the lane state. The pinned principal comes from onboarding;
        # it is never hardcoded. (2026-09-22 first-run audit: this was a
        # hardcoded dev user id.)
        tab = _scratch_tab(self._client, self._tenant)
        self._tab_id = tab
        me = self.get_json("/api/v1/users/self")
        pinned_id = _pinned_principal_id()
        if (not isinstance(me, dict) or pinned_id is None
                or me.get("id") != pinned_id):
            raise LiveReadError(
                "in-page principal check failed: users/self is not the "
                "pinned educator%s; refusing to read on this session"
                % (" (id %s)" % pinned_id if pinned_id is not None else ""))
        self.principal = me.get("name")
        return True

    def close(self):
        """Close the scratch tab; never touches the educator's tabs."""
        if self._tab_id:
            try:
                self._client._post("/cdp/close-tab",
                                   {"target_id": self._tab_id})
            except Exception:
                pass
            self._tab_id = None

    def get_json(self, path):
        """Single GET, returns the parsed JSON body (raises on non-200)."""
        status, payload, _headers = self._fetch(path)
        if status != 200:
            raise LiveReadError(
                "GET %s returned HTTP %s" % (path, status))
        return payload

    def _fetch(self, url):
        if self._tab_id is None:
            raise LiveReadError(
                "reader used before health_check(); the scratch tab does "
                "not exist yet")
        if url.startswith("/"):
            url = self._tenant + url
        value = self._client.evaluate(self._tab_id, _js_get(url))
        status = value.get("status")
        headers = value.get("headers") or {}
        body = value.get("body") or ""
        try:
            payload = json.loads(body) if body else None
        except ValueError:
            raise LiveReadError(
                "GET %s returned non-JSON body (HTTP %s); first 200 chars: %r"
                % (url, status, body[:200]))
        if value.get("truncated_body"):
            raise LiveReadError(
                "GET %s body exceeded the %d-byte in-page cap; refusing to "
                "interpret a partial body" % (url, MAX_BODY_BYTES))
        return status, payload, headers

    def get_paginated(self, first_path):
        """Follow Link rel=next; merge JSON-array pages into one list.

        Returns (status, rows, note): status is the final page status,
        rows the merged list, note None on clean completion or a loud
        truncation/partial warning when the read did not finish.
        Never returns a silently-partial collection.
        """
        all_rows = []
        url = first_path
        note = None
        pages = 0
        while url is not None:
            status, payload, headers = self._fetch(url)
            if status != 200:
                note = ("stopped: page %d returned HTTP %s; %d rows "
                        "collected before the failure" % (pages + 1, status,
                                                          len(all_rows)))
                return status, all_rows, note
            if not isinstance(payload, list):
                note = ("stopped: page %d did not return a JSON array "
                        "(got %s); refusing to merge" %
                        (pages + 1, type(payload).__name__))
                return status, all_rows, note
            all_rows.extend(payload)
            pages += 1
            nxt = _next_link(headers.get("link"))
            if nxt is None:
                break
            if not _same_origin(nxt, self._tenant):
                note = ("stopped: pagination left the tenant origin; %d "
                        "pages merged before the stop" % pages)
                break
            if pages >= MAX_PAGES:
                note = ("stopped: hit the %d-page bound with more pages "
                        "remaining; collection is PARTIAL" % MAX_PAGES)
                break
            url = nxt
        return 200, all_rows, note
