#!/usr/bin/env python3
"""Live verification for the Morrow error translation layer.

Runs real, read-only (or fully-cleaned-up) probes through the local
login helper at 127.0.0.1:8901 and feeds the REAL provider responses
through failures.translate(), asserting the expected catalog modes and
message quality.

Auth model: Canvas auth stays in the browser. This script only talks
to the loopback helper (open GET /status, token-authenticated /cdp/*
page-context fetch). The helper token is read in-process and used only
as the X-Helper-Token header; it is never printed or logged.

Steps:
  a. GET a canonical Item Bank route that 404s -> ib-canonical-item-get-404
  b. GET a literal IB /api/items route that 401s -> ib-literal-item-401-scope-refusal
  c. Disposable wiki-page lifecycle on course 89585: create, no-change PUT
     with a deliberately missing/invalid CSRF token (expect the real
     Canvas 422 unprocessable_content) -> canvas-csrf-422-writes-only,
     then DELETE the page and verify deletion. Zero leftovers.
  d. The helper /status read path (exercised first; gates everything).

Never attempted: session death (the live profile is never touched),
deliberate 429s, anything on real content. Any live failure is recorded
as a finding with evidence; nothing is retried destructively.

Exit 0 when every live assertion passes; exit 1 with findings otherwise.
Stdlib only.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request

TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE_ROOT not in sys.path:
    sys.path.insert(0, TREE_ROOT)

# Point the transport at the LIVE helper tree's state dir so _helper_request
# picks up the live helper's auth token (this tree's own token file belongs
# to a different, non-running helper instance). Set before the import.
os.environ["MORROW_TREE_STATE_DIR"] = os.path.expanduser(
    "~/.morrow/canvas-login-helper")

from transport.local_chromium import (  # noqa: E402
    ProxyCDP, is_tenant_url, tree_helper_port,
)
from failures import translate, load_catalog  # noqa: E402

HELPER_HOST = "127.0.0.1"
HELPER_PORT = 8901
COURSE_ID = "89585"
ANCHORS = ("what was attempted", "what the evidence showed",
           "what happens next")
PLACEHOLDER_RE = re.compile(r"\{[^{}]*\}")
EM_DASH = "\u2014"

CATALOG = load_catalog()
findings = []


def note(ok, step, detail, evidence=None):
    findings.append({"ok": bool(ok), "step": step, "detail": detail,
                     "evidence": evidence or {}})
    print("[%s] %s: %s" % ("PASS" if ok else "FAIL", step, detail),
          flush=True)


def helper_get(path, timeout=15):
    req = urllib.request.Request(
        "http://%s:%d%s" % (HELPER_HOST, HELPER_PORT, path), method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")


_FETCH_JS = """(async function(m, u, p, c) {
  var headers = {'Accept': 'application/json',
                 'X-Requested-With': 'XMLHttpRequest'};
  var body = null;
  if (p) {
    body = new URLSearchParams(p).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if (c === 'valid') {
    var mm = document.cookie.match(/(?:^|;\\s*)_csrf_token=([^;]*)/);
    if (mm) headers['X-CSRF-Token'] = decodeURIComponent(mm[1]);
  } else if (c === 'invalid') {
    headers['X-CSRF-Token'] = 'deliberately-invalid-csrf-token';
  }
  var r = await fetch(u, {method: m, headers: headers, body: body,
                          credentials: 'same-origin', redirect: 'manual'});
  if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) {
    return JSON.stringify({status: 0, redirected: true, url: '',
                           body: '', rateLimit: null, retryAfter: null});
  }
  var t = await r.text();
  var rl = null, ra = null;
  try { rl = r.headers.get('x-rate-limit-remaining'); } catch (e) {}
  try { ra = r.headers.get('retry-after'); } catch (e) {}
  return JSON.stringify({status: r.status, redirected: false, url: r.url,
                         body: t.slice(0, 4000),
                         rateLimit: rl, retryAfter: ra});
})(%s, %s, %s, %s)"""


def page_fetch(cdp, tab, ctx, method, url, params=None, csrf="valid",
               timeout=60):
    expr = _FETCH_JS % (json.dumps(method), json.dumps(url),
                        json.dumps(params), json.dumps(csrf))
    raw = cdp.evaluate(tab, expr, await_promise=True, timeout=timeout,
                       context_id=ctx)
    return json.loads(raw)


def check_message_quality(tr, entry):
    lowered = tr.agent_message.lower()
    for anchor in ANCHORS:
        assert anchor in lowered, "missing anchor %r" % anchor
    assert ("what this means" in lowered or "what it means" in lowered), \
        "missing meaning anchor"
    leftovers = PLACEHOLDER_RE.findall(tr.agent_message)
    assert not leftovers, "unfilled placeholders: %r" % leftovers
    assert EM_DASH not in tr.agent_message, "em dash in message"
    expected_escalate = (
        entry.get("fallback") is True
        or entry.get("severity_hint") == "critical"
        or tr.evidence.get("escalate") is True
    )
    assert tr.escalate == expected_escalate, "escalate flag mismatch"


def main():
    # ---- step d (gates everything): /status read path ----
    try:
        code, raw = helper_get("/status")
        status = json.loads(raw)
    except Exception as exc:
        note(False, "d-status", "GET /status failed: %r" % exc)
        return 1
    logged_in = status.get("logged_in") is True
    chromium_alive = status.get("chromium_alive") is True
    note(logged_in and chromium_alive and code == 200, "d-status",
         "GET /status -> %s; logged_in=%r chromium_alive=%r url=%r"
         % (code, status.get("logged_in"), status.get("chromium_alive"),
            status.get("url")),
         {"logged_in": status.get("logged_in"),
          "chromium_alive": status.get("chromium_alive"),
          "url": status.get("url")})
    if not (logged_in and chromium_alive):
        note(False, "abort", "helper not healthy; live work aborted")
        return 1
    base = status.get("url", "").rstrip("/")
    origin = base.split("/", 3)
    base = "/".join(origin[:3])  # scheme://host

    # ---- browser plumbing: tenant tab + isolated world ----
    cdp = ProxyCDP(port=19223, owner="live-verify",
                   server_port=tree_helper_port())
    tabs = cdp.tabs()
    tab = next((t for t in tabs
                if t.get("type") == "page"
                and is_tenant_url(str(t.get("url", "")), base)), None)
    created_tab = None
    if tab is None:
        created_tab = cdp.new_tab(base + "/")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                href = cdp.evaluate(created_tab, "location.href",
                                    await_promise=False, timeout=15)
            except Exception:
                href = ""
            if isinstance(href, str) and is_tenant_url(href, base):
                break
            time.sleep(1)
        tab = created_tab
    ctx = cdp.create_isolated_world(tab, "morrow_live_verify")
    note(True, "browser-plumbing",
         "tenant tab ready, isolated world created (created_tab=%r)"
         % (created_tab is not None,))

    # ---- step a: canonical IB route that 404s ----
    route_a = "/api/banks/999999999/items/999999999"
    resp_a = page_fetch(cdp, tab, ctx, "GET", base + route_a)
    ev_a = {"provider": "item-banks", "http_status": resp_a["status"],
            "route_path": route_a, "route_kind": "canonical",
            "operation_kind": "read", "body_text": resp_a["body"],
            "tenant": base, "session_logged_in": True}
    tr_a = translate("live verify canonical item GET (IB-11)", ev_a)
    ok_a = resp_a["status"] == 404 and tr_a.mode_id == "ib-canonical-item-get-404"
    try:
        if ok_a:
            check_message_quality(tr_a, CATALOG.get(tr_a.mode_id))
    except AssertionError as exc:
        ok_a = False
        note(False, "a-quality", "message quality failed: %s" % exc)
    note(ok_a, "a-canonical-404",
         "GET %s -> HTTP %s; translate() -> %s"
         % (route_a, resp_a["status"], tr_a.mode_id),
         {"http_status": resp_a["status"], "mode_id": tr_a.mode_id,
          "body_head": resp_a["body"][:160],
          "escalate": tr_a.escalate})

    # ---- step b: literal IB route that 401s ----
    # The catalog's 401 was verified live on the SDK lane (wave-2 battery):
    # GET https://chcp.quiz-api-iad-prod.instructure.com/api/items/11242724
    # with the banks.build token -> 401 "does not have a valid policy for
    # scope: banks.build". The token is read from the banks tab's
    # sessionStorage and attached INSIDE page context; only (status, body)
    # cross back into Python (the wave-2 recipe; no token values recorded).
    route_b = "/api/items/11242724"
    sdk_js = """(async function() {
      var token = null;
      try { token = sessionStorage.getItem('banks.build_token'); } catch (e) {}
      if (!token) return JSON.stringify({status: -1, body: 'no banks.build token in sessionStorage'});
      var H = {'Accept': 'application/json', 'Content-Type': 'application/json',
               'Authorization': token, 'AuthType': 'Signature'};
      var r = await fetch('https://chcp.quiz-api-iad-prod.instructure.com/api/items/11242724', {headers: H});
      var t = await r.text();
      return JSON.stringify({status: r.status, body: t.slice(0, 600)});
    })()"""
    banks_tab = next((t for t in tabs
                      if t.get("type") == "page"
                      and "/banks" in str(t.get("url", ""))), None)
    resp_b = {"status": None, "body": ""}
    sdk_note = ""
    if banks_tab is not None:
        try:
            banks_ctx = cdp.create_isolated_world(banks_tab,
                                                  "morrow_live_verify_b")
            raw_b = cdp.evaluate(banks_tab, sdk_js, await_promise=True,
                                 timeout=60, context_id=banks_ctx)
            resp_b = json.loads(raw_b)
            sdk_note = "sdk-lane"
        except Exception as exc:
            sdk_note = "sdk-lane eval failed: %r" % exc
    else:
        sdk_note = "no banks tab open; sdk-lane probe skipped"
    # Fallback: plain session-lane GET (expected 404; documents the lane
    # difference rather than the 401 mode).
    resp_b_session = page_fetch(cdp, tab, ctx, "GET",
                                base + "/api/items/999999999")
    if resp_b["status"] == 401:
        ev_b = {"provider": "item-banks", "http_status": 401,
                "route_path": route_b, "operation_kind": "read",
                "body_text": resp_b["body"], "tenant": base,
                "session_logged_in": True}
        tr_b = translate("live verify literal item GET (IB-11x)", ev_b)
        ok_b = tr_b.mode_id == "ib-literal-item-401-scope-refusal"
        try:
            if ok_b:
                check_message_quality(tr_b, CATALOG.get(tr_b.mode_id))
        except AssertionError as exc:
            ok_b = False
            note(False, "b-quality", "message quality failed: %s" % exc)
        note(bool(ok_b), "b-literal-401",
             "SDK-lane GET %s -> HTTP 401 (%s); translate() -> %s"
             % (route_b, sdk_note, tr_b.mode_id),
             {"http_status": 401, "mode_id": tr_b.mode_id,
              "body_head": resp_b["body"][:200],
              "escalate": tr_b.escalate,
              "session_lane_status": resp_b_session["status"]})
    else:
        ev_b = {"provider": "item-banks",
                "http_status": resp_b_session["status"],
                "route_path": "/api/items/999999999",
                "operation_kind": "read",
                "body_text": resp_b_session["body"], "tenant": base,
                "session_logged_in": True}
        tr_b = translate("live verify literal item GET (IB-11x)", ev_b)
        note(False, "b-literal-401",
             "sdk-lane probe did not yield the 401 (%s; status=%r); "
             "session-lane GET /api/items/999999999 -> HTTP %s, "
             "translate() -> %s (correctly NOT the 401 mode: no false "
             "positive). The 401 mode's live proof stands on the wave-2 "
             "SDK-lane evidence (proof-battery/evidence/nq-item-bank-wave2/)."
             % (sdk_note, resp_b["status"], resp_b_session["status"],
                tr_b.mode_id),
             {"sdk_status": resp_b["status"],
              "session_lane_status": resp_b_session["status"],
              "mode_id": tr_b.mode_id})

    # ---- step c: disposable wiki-page lifecycle ----
    page_url = None
    try:
        title = "morrow-disposable-verify-20260922"
        resp_post = page_fetch(
            cdp, tab, ctx, "POST",
            base + "/api/v1/courses/%s/pages" % COURSE_ID,
            {"wiki_page[title]": title,
             "wiki_page[body]": "disposable verification page for the "
                               "error-translation live battery; safe to delete."},
            csrf="valid")
        created = False
        if resp_post["status"] in (200, 201):
            try:
                page_url = json.loads(resp_post["body"]).get("url")
                created = page_url is not None
            except ValueError:
                created = False
        note(created, "c-create",
             "POST wiki page -> HTTP %s; page url=%r"
             % (resp_post["status"], page_url),
             {"http_status": resp_post["status"], "page_url": page_url})
        if not created:
            note(False, "c-abort", "page creation failed; skipping PUT/DELETE")
            return 1

        put_route = "/api/v1/courses/%s/pages/%s" % (COURSE_ID, page_url)
        # Probe 1: no-change PUT with the CSRF token missing entirely.
        resp_put = page_fetch(cdp, tab, ctx, "PUT", base + put_route,
                              {"wiki_page[title]": title}, csrf="missing")
        # Probe 2 (only if probe 1 did not 422): deliberately invalid token.
        resp_put2 = None
        if resp_put["status"] != 422:
            resp_put2 = page_fetch(cdp, tab, ctx, "PUT", base + put_route,
                                   {"wiki_page[title]": title},
                                   csrf="invalid")
        real_422 = resp_put if resp_put["status"] == 422 else resp_put2
        if real_422 is None:
            note(False, "c-csrf-422",
                 "neither missing nor invalid CSRF produced a 422 "
                 "(missing->%s, invalid->%s); feeding the missing-token "
                 "response through translate() anyway"
                 % (resp_put["status"],
                    resp_put2["status"] if resp_put2 else "n/a"),
                 {"missing_status": resp_put["status"],
                  "invalid_status": resp_put2["status"] if resp_put2 else None,
                  "missing_body": resp_put["body"][:200]})
            real_422 = resp_put
            expect_mode = None
        else:
            expect_mode = "canvas-csrf-422-writes-only"

        rl = real_422.get("rateLimit")
        ra = real_422.get("retryAfter")
        ev_c = {"provider": "canvas", "http_status": real_422["status"],
                "body_text": real_422["body"], "route_path": put_route,
                "operation_kind": "write", "tenant": base,
                "writes_fail": True, "reads_ok": True,
                "session_logged_in": True}
        if rl is not None:
            ev_c["rate_limit_remaining"] = rl
        ev_c["retry_after_present"] = ra is not None and str(ra).strip() != ""
        tr_c = translate("live verify no-change wiki PUT without CSRF", ev_c)
        ok_c = (expect_mode is None and tr_c.mode_id) or \
               tr_c.mode_id == expect_mode
        try:
            check_message_quality(tr_c, CATALOG.get(tr_c.mode_id))
        except AssertionError as exc:
            ok_c = False
            note(False, "c-quality", "message quality failed: %s" % exc)
        note(bool(ok_c), "c-csrf-422",
             "PUT %s (no CSRF) -> HTTP %s (invalid-token probe -> %s); "
             "rate_limit=%r retry_after=%r; translate() -> %s"
             % (put_route, resp_put["status"],
                resp_put2["status"] if resp_put2 else "n/a",
                rl, ra, tr_c.mode_id),
             {"http_status": real_422["status"], "mode_id": tr_c.mode_id,
              "body_head": real_422["body"][:200],
              "rate_limit_remaining": rl, "retry_after": ra,
              "escalate": tr_c.escalate})
    finally:
        # ---- cleanup: DELETE the disposable page, verify deletion ----
        if page_url:
            del_route = "/api/v1/courses/%s/pages/%s" % (COURSE_ID, page_url)
            try:
                resp_del = page_fetch(cdp, tab, ctx, "DELETE",
                                      base + del_route, csrf="valid")
                resp_get = page_fetch(cdp, tab, ctx, "GET",
                                      base + del_route)
                deleted = resp_get["status"] == 404
                note(resp_del["status"] in (200, 204) and deleted,
                     "c-cleanup",
                     "DELETE %s -> HTTP %s; verification GET -> HTTP %s "
                     "(deleted=%r)"
                     % (del_route, resp_del["status"],
                        resp_get["status"], deleted),
                     {"delete_status": resp_del["status"],
                      "verify_get_status": resp_get["status"]})
            except Exception as exc:
                note(False, "c-cleanup",
                     "cleanup raised: %r; page_url=%r (manual check needed)"
                     % (exc, page_url))
                raise

    if created_tab is not None:
        try:
            cdp.close_tab(created_tab)
        except Exception:
            pass

    failed = [f for f in findings if not f["ok"]]
    print("\n%d/%d live checks passed" % (len(findings) - len(failed),
                                         len(findings)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
