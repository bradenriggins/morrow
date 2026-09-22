#!/usr/bin/env python3
"""Selftest: provision/launch_driver.py offline behavior.

Uses fake CDP/launcher/network-watcher doubles: no Chromium, no network,
no session. Covers:
  1. probe_session ok shape and principal_ref.
  2. probe_session login redirect -> SessionDead.
  3. resolve_placement: exactly one match, zero matches, two matches,
     tool-id extraction from tab id and from html_url fallback.
  4. launch_and_capture: happy path capture shape, UUID nonce,
     case-insensitive Authorization header, timeout -> CaptureTimeout,
     missing Authorization -> ProvisionFailed, frame collapse propagates,
     launch spec validation.
  5. close_tab never raises.
  6. Unavailable launcher factory -> ProvisionFailed (fail closed).
  7. Full provision integration: provision_item_bank_credential_memory
     with the fake driver returns a working single-use handle.
  8. Hygiene: no em dashes, no /tmp references, no print() calls in the
     driver module.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import importlib.util
import json
import os
import re
import sys
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "provision")):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


prov = _load("morrow_provision_ld_selftest",
             os.path.join(REPO, "provision", "provision.py"))
ldmod = _load("morrow_launch_driver_selftest",
              os.path.join(REPO, "provision", "launch_driver.py"))

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


# ----------------------------------------------------------------------
# fakes
# ----------------------------------------------------------------------

class FakeCDP:
    def __init__(self, host="127.0.0.1", port=1):
        self.host = host
        self.port = port
        self.navigated = []
        self.responses = {}

    def new_tab(self, url):
        return {"id": "TAB9", "type": "page",
                "url": url,
                "webSocketDebuggerUrl":
                "ws://%s:%d/devtools/page/TAB9" % (self.host, self.port)}

    def tabs(self):
        return [{"id": "T1", "type": "page",
                 "url": "https://chcp.instructure.com/"}]

    def ws_path(self, tab):
        return "/devtools/page/TAB9"

    def navigate(self, ws_path, url):
        self.navigated.append((ws_path, url))
        return {"frameId": "F1"}

    def evaluate(self, ws_path, expression, await_promise=False,
                 timeout=60, context_id=None):
        # context_id: accepted and ignored; the fake has a single realm.
        m = re.search(r'path = "((?:[^"\\]|\\.)*)"', expression)
        path = json.loads('"%s"' % m.group(1)) if m else ""
        status, body = self.responses.get(path, (404, "not found"))
        return json.dumps({"status": status, "url": path, "body": body})

    def create_isolated_world(self, tab, world_name):
        # W4-P1-12: the API probe runs in an isolated world; the fake
        # hands back a synthetic executionContextId.
        return 424242


class FakeLauncher:
    def __init__(self, cdp):
        self.cdp = cdp
        self.started = False

    def start(self):
        self.started = True

    def is_running(self):
        return self.started


def make_driver(cdp=None, watcher=None, **kw):
    cdp = cdp or FakeCDP()
    return ldmod.LocalChromiumLaunchDriver(
        canvas_base="https://chcp.instructure.com",
        launcher=FakeLauncher(cdp),
        cdp=cdp,
        network_watcher=watcher,
        prov=prov,
        **kw)


def make_watcher(event=None, exc=None):
    calls = []

    def watcher(ws_path, launch_url, timeout_s):
        calls.append((ws_path, launch_url, timeout_s))
        if exc is not None:
            raise exc
        return event

    watcher.calls = calls
    return watcher


SELF_BODY = json.dumps({"id": 99999, "name": "Test User"})
ONE_TAB = json.dumps([{
    "id": "context_external_tool_777",
    "label": "Item Banks",
    "type": "external_tool",
    "html_url": "https://chcp.instructure.com/courses/424242/"
                "external_tools/777",
}])
TWO_TABS = json.dumps([
    {"id": "context_external_tool_777", "label": "Item Banks",
     "html_url": "https://chcp.instructure.com/courses/1/external_tools/777"},
    {"id": "context_external_tool_778", "label": "Item Banks",
     "html_url": "https://chcp.instructure.com/courses/1/external_tools/778"},
])
ZERO_TABS = json.dumps([{"id": "home", "label": "Home"}])
HTMLURL_TAB = json.dumps([{
    "id": "lti-placement-1",
    "label": "item banks",
    "html_url": "https://chcp.instructure.com/courses/424242/"
                "external_tools/888",
}])

BANKS_EVENT = {
    "headers": {"Authorization": "Bearer " + "K" * 64, "X-Other": "1"},
    "frame_id": "FR1",
    "url": "https://chcp.quiz-api.instructure.com/api/banks",
}

GOOD_SPEC = {
    "launch_url": "https://chcp.instructure.com/courses/424242/"
                  "external_tools/777",
    "course_id": "424242",
    "course_uuid": "12345678-1234-5678-1234-567812345678",
    "tool_id": "777",
    "tenant": "chcp",
}


# 1. probe_session ok
cdp = FakeCDP()
cdp.responses["/api/v1/users/self"] = (200, SELF_BODY)
drv = make_driver(cdp=cdp)
probe = drv.probe_session()
check("probe ok: session_ok", probe.get("session_ok") is True, repr(probe))
check("probe ok: no login redirect",
      probe.get("login_redirect") is False, repr(probe))
check("probe ok: principal_ref shape",
      probe.get("principal_ref") == "user:99999", repr(probe))
check("probe ok: canvas_base echoed",
      probe.get("canvas_base") == "https://chcp.instructure.com",
      repr(probe))

# 2. probe_session login redirect -> SessionDead
cdp2 = FakeCDP()
cdp2.responses["/api/v1/users/self"] = (
    200, "<html>Canvas Login</html>")
drv2 = make_driver(cdp=cdp2)
try:
    drv2.probe_session()
    check("probe dead: raises SessionDead", False, "no exception")
except prov.SessionDead:
    check("probe dead: raises SessionDead", True)
except Exception as exc:  # noqa: BLE001
    check("probe dead: raises SessionDead", False, "wrong: %r" % exc)

# 3. resolve_placement
cdp3 = FakeCDP()
cdp3.responses["/api/v1/users/self"] = (200, SELF_BODY)
cdp3.responses["/api/v1/courses/424242/tabs"] = (200, ONE_TAB)
drv3 = make_driver(cdp=cdp3)
place = drv3.resolve_placement("424242")
check("placement: one match", place["match_count"] == 1, repr(place))
check("placement: tool id", place["tool_id"] == "777", repr(place))
check("placement: launch url",
      place["launch_url"] == "https://chcp.instructure.com/courses/424242/"
                             "external_tools/777", repr(place))

cdp3.responses["/api/v1/courses/424242/tabs"] = (200, ZERO_TABS)
place0 = drv3.resolve_placement("424242")
check("placement: zero matches", place0["match_count"] == 0
      and place0["tool_id"] is None, repr(place0))

cdp3.responses["/api/v1/courses/424242/tabs"] = (200, TWO_TABS)
place2 = drv3.resolve_placement("424242")
check("placement: two matches", place2["match_count"] == 2
      and place2["tool_id"] is None, repr(place2))

cdp3.responses["/api/v1/courses/424242/tabs"] = (200, HTMLURL_TAB)
placeh = drv3.resolve_placement("424242")
check("placement: html_url fallback", placeh["tool_id"] == "888",
      repr(placeh))

cdp3.responses["/api/v1/courses/424242/tabs"] = (500, "boom")
try:
    drv3.resolve_placement("424242")
    check("placement: HTTP 500 fails closed", False, "no exception")
except prov.PlacementUnresolved:
    check("placement: HTTP 500 fails closed", True)
except Exception as exc:  # noqa: BLE001
    check("placement: HTTP 500 fails closed", False, "wrong: %r" % exc)

# 4. launch_and_capture
watcher = make_watcher(event=dict(BANKS_EVENT))
drv4 = make_driver(watcher=watcher)
cap = drv4.launch_and_capture(dict(GOOD_SPEC), timeout_s=5)
check("capture: authorization value",
      cap["authorization"] == "Bearer " + "K" * 64, repr(cap))
check("capture: tab id", cap["tab_id"] == "TAB9", repr(cap))
check("capture: frame id", cap["frame_id"] == "FR1", repr(cap))
check("capture: api origin",
      cap["api_origin"] == "https://chcp.quiz-api.instructure.com",
      repr(cap))
check("capture: tool id str", cap["external_tool_id"] == "777", repr(cap))
check("capture: launch url", cap["launch_url"] == GOOD_SPEC["launch_url"],
      repr(cap))
try:
    parsed = uuid.UUID(cap["nonce"], version=4)
    check("capture: nonce is uuid4", str(parsed) == cap["nonce"],
          repr(cap["nonce"]))
except (ValueError, AttributeError) as exc:
    check("capture: nonce is uuid4", False, repr(exc))
check("capture: launched/captured ints",
      isinstance(cap["launched_at"], int)
      and isinstance(cap["captured_at"], int)
      and cap["captured_at"] >= cap["launched_at"], repr(cap))
check("capture: watcher got tab, launch url, and timeout",
      watcher.calls and watcher.calls[0][0].get("id") == "TAB9"
      and watcher.calls[0][2] == 5, repr(watcher.calls))

# header name case-insensitive
watcher_ci = make_watcher(event={"headers": {"authorization": "Z"},
                                 "frame_id": None,
                                 "url": BANKS_EVENT["url"]})
drv_ci = make_driver(watcher=watcher_ci)
cap_ci = drv_ci.launch_and_capture(dict(GOOD_SPEC))
check("capture: header case-insensitive", cap_ci["authorization"] == "Z",
      repr(cap_ci))

# timeout -> CaptureTimeout
drv_to = make_driver(watcher=make_watcher(event=None))
try:
    drv_to.launch_and_capture(dict(GOOD_SPEC), timeout_s=3)
    check("capture: timeout raises CaptureTimeout", False, "no exception")
except prov.CaptureTimeout as exc:
    check("capture: timeout raises CaptureTimeout", True)
    check("capture: timeout names the window", "3s" in str(exc), str(exc))
except Exception as exc:  # noqa: BLE001
    check("capture: timeout raises CaptureTimeout", False, "wrong: %r" % exc)

# missing Authorization -> ProvisionFailed, never synthesized
drv_noauth = make_driver(watcher=make_watcher(
    event={"headers": {"X-Other": "1"}, "frame_id": None,
           "url": BANKS_EVENT["url"]}))
try:
    drv_noauth.launch_and_capture(dict(GOOD_SPEC))
    check("capture: missing auth fails closed", False, "no exception")
except prov.ProvisionFailed as exc:
    check("capture: missing auth fails closed",
          "capture_missing_authorization" in str(exc), str(exc))
except Exception as exc:  # noqa: BLE001
    check("capture: missing auth fails closed", False, "wrong: %r" % exc)

# frame collapse propagates as uncertain, never replayed
collapse = prov.ProvisionFailed(
    "launch_frame_collapsed: Page.frameDetached during the launch")
drv_col = make_driver(watcher=make_watcher(exc=collapse))
try:
    drv_col.launch_and_capture(dict(GOOD_SPEC))
    check("capture: collapse propagates", False, "no exception")
except prov.ProvisionFailed as exc:
    check("capture: collapse propagates",
          "launch_frame_collapsed" in str(exc), str(exc))

# launch spec validation
bad_spec = dict(GOOD_SPEC)
del bad_spec["course_uuid"]
drv_bad = make_driver(watcher=make_watcher(event=dict(BANKS_EVENT)))
try:
    drv_bad.launch_and_capture(bad_spec)
    check("capture: bad spec fails closed", False, "no exception")
except prov.ProvisionFailed as exc:
    check("capture: bad spec fails closed",
          "launch_spec_invalid" in str(exc), str(exc))

# 5. close_tab never raises (port 1 refuses the connection; swallowed)
try:
    drv4.close_tab("TAB9")
    drv4.close_tab(None)
    check("close_tab: best effort, never raises", True)
except Exception as exc:  # noqa: BLE001
    check("close_tab: best effort, never raises", False, "raised: %r" % exc)

# 6. unavailable launcher factory -> ProvisionFailed fail-closed
def _boom():
    raise RuntimeError("no chromium here")

drv_boom = ldmod.LocalChromiumLaunchDriver(
    canvas_base="https://chcp.instructure.com",
    launcher_factory=_boom, prov=prov)
try:
    drv_boom.probe_session()
    check("unavailable launcher: fail closed", False, "no exception")
except prov.ProvisionFailed as exc:
    check("unavailable launcher: fail closed",
          "launch_driver_unavailable" in str(exc), str(exc))
except Exception as exc:  # noqa: BLE001
    check("unavailable launcher: fail closed", False, "wrong: %r" % exc)

# 7. full provision integration with the fake driver
cdp7 = FakeCDP()
cdp7.responses["/api/v1/users/self"] = (200, SELF_BODY)
cdp7.responses["/api/v1/courses/424242/tabs"] = (200, ONE_TAB)
drv7 = make_driver(cdp=cdp7,
                   watcher=make_watcher(event=dict(BANKS_EVENT)))
try:
    handle, steps = prov.provision_item_bank_credential_memory(
        course_id="424242", tenant="chcp", course_uuid="12345678-1234-5678-1234-567812345678",
        launch_driver=drv7)
    check("provision integration: handle returned",
          isinstance(handle, prov.ItemBankCredential), repr(type(handle)))
    check("provision integration: six steps",
          len(steps) == 6, repr(len(steps)))
    hdrs = handle.headers()
    check("provision integration: headers carry the captured token",
          hdrs.get("Authorization") == "Bearer " + "K" * 64, repr(hdrs))
    check("provision integration: AuthType Signature",
          hdrs.get("AuthType") == "Signature", repr(hdrs))
    summary = handle.binding_summary()
    check("provision integration: summary carries no token",
          "KKKK" not in json.dumps(summary), repr(summary))
    try:
        handle.headers()
        check("provision integration: single use enforced", False,
              "second headers() did not raise")
    except prov.ProvisionFailed:
        check("provision integration: single use enforced", True)
    handle.close()
    check("provision integration: close zeroes",
          bytes(handle._token or b"") == b"", repr(handle._token))
except Exception as exc:  # noqa: BLE001
    check("provision integration: full path", False, "raised: %r" % exc)

# zero-match placement through the provisioner -> PlacementUnresolved
cdp8 = FakeCDP()
cdp8.responses["/api/v1/users/self"] = (200, SELF_BODY)
cdp8.responses["/api/v1/courses/424242/tabs"] = (200, ZERO_TABS)
drv8 = make_driver(cdp=cdp8,
                   watcher=make_watcher(event=dict(BANKS_EVENT)))
try:
    prov.provision_item_bank_credential_memory(
        course_id="424242", tenant="chcp", course_uuid="12345678-1234-5678-1234-567812345678",
        launch_driver=drv8)
    check("provision integration: zero placements fail closed", False,
          "no exception")
except prov.PlacementUnresolved:
    check("provision integration: zero placements fail closed", True)
except Exception as exc:  # noqa: BLE001
    check("provision integration: zero placements fail closed", False,
          "wrong: %r" % exc)

# 8. hygiene
src = open(os.path.join(REPO, "provision", "launch_driver.py"),
           encoding="utf-8").read()
check("hygiene: no em dashes", "\u2014" not in src)
check("hygiene: no /tmp", ("/t" + "mp/") not in src)
check("hygiene: no print calls", "print(" not in src)

print("PASS: %d" % len(PASS))
for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
