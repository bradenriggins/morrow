#!/usr/bin/env python3
"""Selftest for session/cdp.py: the helper-proxy CDP client.

Covers W4-P1-12 (isolated-world creation carries the root frame id from
Page.getFrameTree) with a stubbed _proxy_post: no helper, no Chromium,
no network. Fails loudly on the first failure; prints a summary.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp as cdp_mod

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("PASS %s" % name)
    else:
        FAIL += 1
        FAILURES.append(name)
        print("FAIL %s" % name)


class _ProxyStub:
    """Stands in for the helper's /cdp/* proxy. Records calls."""

    def __init__(self, frame_id="FRAME1", context_id=7):
        self.calls = []
        self.frame_id = frame_id
        self.context_id = context_id

    def __call__(self, path, body, timeout):
        self.calls.append((path, dict(body)))
        method = body.get("method")
        if path == "/cdp/call" and method == "Page.getFrameTree":
            if self.frame_id is None:
                return {}
            return {"result": {"frameTree": {"frame": {"id": self.frame_id,
                                                       "url": "https://t/"}}}}
        if path == "/cdp/call" and method == "Page.createIsolatedWorld":
            if self.context_id is None:
                return {"result": {}}
            return {"result": {"executionContextId": self.context_id}}
        raise AssertionError("unexpected proxy call %r %r" % (path, body))


def _with_stub(stub):
    real = cdp_mod._proxy_post
    cdp_mod._proxy_post = stub
    return real


# 1. The happy path: getFrameTree first, then createIsolatedWorld with
# the root frame id.
stub = _ProxyStub()
real = _with_stub(stub)
try:
    ctx = cdp_mod._isolated_world("T1", timeout=5)
finally:
    cdp_mod._proxy_post = real
check("isolated world returns the executionContextId", ctx == 7)
check("getFrameTree is called before createIsolatedWorld",
      [c[1].get("method") for c in stub.calls]
      == ["Page.getFrameTree", "Page.createIsolatedWorld"])
check("both calls target the live tab id",
      all(c[1].get("target_id") == "T1" for c in stub.calls))
check("createIsolatedWorld carries the root frameId",
      stub.calls[1][1]["params"].get("frameId") == "FRAME1")
check("createIsolatedWorld names the probe world",
      stub.calls[1][1]["params"].get("worldName") == "morrow_rig_probe")

# 2. A frame tree with no root frame id fails closed.
stub2 = _ProxyStub(frame_id=None)
real = _with_stub(stub2)
try:
    try:
        cdp_mod._isolated_world("T1", timeout=5)
        raised = False
    except RuntimeError:
        raised = True
finally:
    cdp_mod._proxy_post = real
check("missing root frame id raises (never a frameless world)", raised)
check("no createIsolatedWorld call follows a bad frame tree",
      [c[1].get("method") for c in stub2.calls] == ["Page.getFrameTree"])

# 3. A missing executionContextId fails closed.
stub3 = _ProxyStub(context_id=None)
real = _with_stub(stub3)
try:
    try:
        cdp_mod._isolated_world("T1", timeout=5)
        raised3 = False
    except RuntimeError:
        raised3 = True
finally:
    cdp_mod._proxy_post = real
check("missing executionContextId raises", raised3)

# 4. The module opens no CDP socket itself: no websocket/json-list
# concepts remain in executable code (the docstring recounts the
# retired architecture, so strip it before scanning).
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "cdp.py"), encoding="utf-8").read()
doc_end = src.find('"""', 3)
code = src[doc_end + 3:] if doc_end != -1 else src
check("no websocket client in session/cdp.py",
      "websocket" not in code.lower())
check("no /json/list in session/cdp.py", "/json/list" not in code)
check("no hard-coded 9222 in session/cdp.py", "9222" not in code)
check("no raw socket use in session/cdp.py",
      "import socket" not in code and "socket.create_connection" not in code)

print("session/cdp selftest: %d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
