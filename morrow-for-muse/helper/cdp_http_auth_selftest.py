#!/usr/bin/env python3
"""Standalone selftest: every /cdp/* HTTP route requires the launch token.

Covers all seven /cdp/* routes through the REAL Handler on an ephemeral
loopback port with a stubbed BROWSER (no Chromium, no external network):
  POST /cdp/tabs, /cdp/new-tab, /cdp/call, /cdp/evaluate, /cdp/navigate,
  /cdp/close-tab, and GET /cdp/events.

For each route: missing token -> 403 {"error":"forbidden"}, wrong token ->
403, correct token -> 200 with the expected JSON shape. Wave 4: the /cdp/*
proxy is the only cross-process CDP path (no TCP CDP listener exists), so
its token gate is the security boundary.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import json
import os
import sys
import threading
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Keep the import hermetic: no tree helper/env, no real HOME leakage, and a
# generous rate-limit budget for the probe requests. The module-level
# guards require an explicit scratch profile and non-production ports.
os.environ["MORROW_HELPER_ENV_FILE"] = os.path.join(HERE, ".selftest-empty-env")
with open(os.environ["MORROW_HELPER_ENV_FILE"], "w", encoding="utf-8") as fh:
    fh.write("# empty: cdp_http_auth_selftest isolation\n")
os.environ["LOGIN_HELPER_RATE_LIMIT_BURST"] = "1000"
os.environ["LOGIN_HELPER_RATE_LIMIT_RPS"] = "1000"
os.environ["LOGIN_HELPER_PORT"] = "18901"
os.environ["LOGIN_HELPER_CDP_PORT"] = "19224"
os.environ["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(
    HERE, ".selftest-cdp-auth-profile")

import server as S  # noqa: E402

TOKEN = "c" * 64
# W6-P2-7: HELPER_TOKEN is a zeroizable SecretBytes now; the harness
# wraps the monkeypatched value the same way the loader does.
S.HELPER_TOKEN = S.secret_bytes(TOKEN.encode("ascii"))
assert S._token_ok(TOKEN) and not S._token_ok("wrong")

CALLS = []


class _StubBrowser:
    def cdp_proxy_tabs(self):
        return [{"id": "T1", "type": "page",
                 "url": "https://tenant.instructure.com/"}]

    def cdp_proxy_new_tab(self, url):
        CALLS.append(("new-tab", url))
        return {"id": "T9", "type": "page", "url": url}

    def cdp_proxy_call(self, target_id, method, params, timeout=30):
        CALLS.append(("call", method))
        return {"frameTree": {}}

    def cdp_proxy_evaluate(self, target_id, expression, await_promise,
                           context_id, timeout=30):
        CALLS.append(("evaluate", expression[:20]))
        return {"ok": True, "value": 1}

    def cdp_proxy_navigate(self, target_id, url, timeout=30):
        CALLS.append(("navigate", url))
        return {"ok": True}

    def cdp_proxy_close_tab(self, target_id):
        CALLS.append(("close-tab", target_id))
        return {"ok": True}

    def cdp_proxy_events(self, target_id, timeout_s):
        return {"events": []}


S.BROWSER = _StubBrowser()
srv = S.BoundedThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        FAILURES.append(name)
    print(("PASS " if cond else "FAIL ") + name)


def req(method, path, headers=None, body=None):
    r = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (PORT, path), data=body,
        headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


H = {"X-Helper-Token": TOKEN}
WRONG = {"X-Helper-Token": "0" * 64}
JSON_BODY = json.dumps({}).encode()


def post(path, payload):
    return req("POST", path, headers=dict(H),
               body=json.dumps(payload).encode())


# (route, method, auth-path-or-payload, positive-payload, shape-check)
ROUTES = [
    ("POST /cdp/tabs", "POST", "/cdp/tabs", {},
     lambda c, b: c == 200 and "tabs" in json.loads(b)),
    ("POST /cdp/new-tab", "POST", "/cdp/new-tab", {"url": "about:blank"},
     lambda c, b: c == 200 and json.loads(b)["id"] == "T9"),
    ("POST /cdp/call", "POST", "/cdp/call",
     {"target_id": "T1", "method": "Page.getFrameTree", "params": {}},
     lambda c, b: c == 200 and "result" in json.loads(b)),
    ("POST /cdp/evaluate", "POST", "/cdp/evaluate",
     {"target_id": "T1", "expression": "1+1"},
     lambda c, b: c == 200 and json.loads(b).get("ok") is True),
    ("POST /cdp/navigate", "POST", "/cdp/navigate",
     {"target_id": "T1", "url": "https://tenant.instructure.com/"},
     lambda c, b: c == 200 and json.loads(b).get("ok") is True),
    ("POST /cdp/close-tab", "POST", "/cdp/close-tab", {"target_id": "T1"},
     lambda c, b: c == 200 and json.loads(b).get("ok") is True),
    ("GET /cdp/events", "GET", "/cdp/events?target_id=T1&timeout_s=1", None,
     lambda c, b: c == 200 and "events" in json.loads(b)),
]

for name, method, path, payload, shape in ROUTES:
    # Missing token.
    if method == "POST":
        code, body = req("POST", path, body=json.dumps(payload).encode())
    else:
        code, body = req("GET", path)
    check("%s without token -> 403" % name, code == 403)
    check("%s 403 body is forbidden JSON" % name,
          code == 403 and json.loads(body) == {"error": "forbidden"})
    # Wrong token.
    if method == "POST":
        code, _ = req("POST", path, headers=dict(WRONG),
                      body=json.dumps(payload).encode())
    else:
        code, _ = req("GET", path, headers=dict(WRONG))
    check("%s with wrong token -> 403" % name, code == 403)
    # Authenticated positive path.
    if method == "POST":
        code, body = post(path, payload)
    else:
        code, body = req("GET", path, headers=dict(H))
    check("%s with token -> 200 and expected shape" % name,
          shape(code, body))

# The stub saw exactly the six POST proxy calls (events is a GET drain).
check("authenticated calls reached the stub browser",
      CALLS == [("new-tab", "about:blank"),
                ("call", "Page.getFrameTree"),
                ("evaluate", "1+1"),
                ("navigate", "https://tenant.instructure.com/"),
                ("close-tab", "T1")])

srv.shutdown()
for _p in (os.environ["MORROW_HELPER_ENV_FILE"],
           os.environ["LOGIN_HELPER_PROFILE_DIR"]):
    try:
        if os.path.isdir(_p):
            import shutil
            shutil.rmtree(_p, ignore_errors=True)
        else:
            os.unlink(_p)
    except OSError:
        pass
print("cdp http auth selftest: %d pass, %d fail" % (PASS, FAIL))
if FAILURES:
    print("failures: %s" % "; ".join(FAILURES))
sys.exit(1 if FAIL else 0)
