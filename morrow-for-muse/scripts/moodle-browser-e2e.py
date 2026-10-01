"""Installed Chromium -> disposable Moodle fixture; no real login state."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TREE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TREE))
from moodle.browser_transport import MoodleBrowserTransport
from transport.local_chromium import ChromiumLauncher

out = Path(sys.argv[1])
binary = sys.argv[2]
report = {"test": "installed-Chromium-Moodle-browser-session", "checks": {}}
state = {"id": 42, "login": 123456, "badroot": False, "mode": "ok", "calls": 0}
secret = "DUMMY_BROWSER_ONLY_SESSKEY"
courses = [{"id": n, "fullname": "Course %d" % n,
            "learner_secret": "DO_NOT_RETURN"} for n in range(1, 258)]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, body, content="text/html"):
        self.send_response(status)
        self.send_header("Content-Type", content)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", "fixture=owned; HttpOnly; SameSite=Lax; Path=/lms")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if state["mode"] == "login":
            self.send_response(302)
            self.send_header("Location", "/idp/login")
            self.end_headers()
            return
        cfg = {"wwwroot": base + ("/other" if state["badroot"] else ""),
               "userId": state["id"], "currentlogin": state["login"],
               "sesskey": secret, "theme": "semicolon; braces } and escaped \\\""}
        html = '<script>var M={}; M.cfg=' + json.dumps(cfg) + ';</script>'
        if state["mode"] == "malformed":
            html = '<script>M.cfg={not_json};</script>'
        if state["mode"] == "duplicate":
            html += '<script>M.cfg=' + json.dumps(cfg) + ';</script>'
        if state["mode"] == "hugeconfig":
            html += 'x' * 2200000
        html += '<script>window.fetch=()=>Promise.resolve(new Response("forged"));M.cfg.userId=999;</script>'
        self.send(200, html.encode())

    def do_POST(self):
        state["calls"] += 1
        assert urlparse(self.path).path == "/lms/lib/ajax/service.php"
        assert parse_qs(urlparse(self.path).query)["sesskey"] == [secret]
        assert "fixture=owned" in self.headers.get("Cookie", "")
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body[0]["methodname"] == "core_course_get_enrolled_courses_by_timeline_classification"
        args = body[0]["args"]
        rows = courses[args["offset"]:args["offset"] + args["limit"]]
        if state["mode"] == "badrow":
            rows = [{"id": 0, "fullname": "Invalid"}]
        payload = [{"error": False, "data": {"courses": rows}}]
        if state["mode"] == "error":
            payload = [{"error": True, "exception": {"errorcode": "servicerequireslogin", "message": secret}}]
        if state["mode"] == "huge":
            payload = [{"error": False, "data": {"courses": [{"id": 1, "fullname": "x" * 2200000}]}}]
        self.send(200, json.dumps(payload).encode(), "application/json")

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
base = "http://127.0.0.1:%d/lms" % server.server_port
threading.Thread(target=server.serve_forever, daemon=True).start()

def check(name, condition):
    report["checks"][name] = bool(condition)
    assert condition, name

def refused(name, call, calls_unchanged=False):
    before = state["calls"]
    try:
        call()
    except Exception as exc:
        check(name, secret not in str(exc))
    else:
        check(name, False)
    if calls_unchanged:
        check(name + "_before_ajax", state["calls"] == before)

launcher = None
try:
    with tempfile.TemporaryDirectory(prefix="morrow-moodle-browser-e2e-") as scratch:
        os.environ["MOODLE_BASE_ALLOW_HTTP"] = "1"
        os.environ["LOGIN_HELPER_OWN_BROWSER"] = "1"
        launcher = ChromiumLauncher(binary, str(Path(scratch) / "profile"), cdp_port=19387,
                                    extra_args=["--disable-features=LocalNetworkAccessChecks"])
        launcher.start()
        other = launcher.cdp.new_tab("about:blank")
        launcher.cdp.call(other, "Page.navigate", {"url": base.rsplit('/lms', 1)[0] + "/other/"}, timeout=10)
        for _ in range(100):
            if launcher.cdp.evaluate(other, "location.pathname", await_promise=False) == "/other/":
                break
            threading.Event().wait(0.05)
        tab = launcher.cdp.new_tab("about:blank")
        report["fixture_navigation"] = launcher.cdp.call(tab, "Page.navigate", {"url": base + "/"}, timeout=10)
        for _ in range(100):
            if launcher.cdp.evaluate(tab, "location.pathname", await_promise=False) == "/lms/":
                break
            threading.Event().wait(0.05)
        transport = MoodleBrowserTransport(base, launcher, principal_id="42")
        report["fixture_location"] = launcher.cdp.evaluate(tab, "location.href", await_promise=False)
        report["transport_base"] = transport.base
        check("browser_identity_ignores_main_realm", transport.identity() == {"id": "42", "site_url": base})
        result = []
        offset = 0
        while True:
            page = transport.courses_page(offset=offset, limit=100)
            result.extend(page["courses"])
            if page["complete"]:
                break
            check("offset_progress_%d" % offset, page["next_offset"] > offset)
            offset = page["next_offset"]
        check("all_257_courses", [r["id"] for r in result] == [str(n) for n in range(1, 258)])
        encoded = json.dumps(result)
        check("no_credentials_or_extra_fields", secret not in encoded and "DO_NOT_RETURN" not in encoded)
        for args in ({"offset": -1}, {"limit": 0}, {"limit": 101}, {"offset": True}):
            refused("invalid_page_%s" % args, lambda: transport.courses_page(**args), True)
        state["id"] = 43
        refused("account_change", transport.courses_page, True)
        state["id"] = 42
        state["badroot"] = True
        refused("site_prefix_change", transport.courses_page, True)
        state["badroot"] = False
        state["login"] = None
        refused("guest", transport.courses_page, True)
        state["login"] = 123456
        state["mode"] = "login"
        refused("login_redirect", transport.courses_page, True)
        for mode in ("malformed", "duplicate", "hugeconfig"):
            state["mode"] = mode
            refused(mode, transport.courses_page, True)
        for mode in ("badrow", "error", "huge"):
            state["mode"] = mode
            refused(mode, transport.courses_page)
        report["provider_calls"] = state["calls"]
        report["profile_disposable"] = True
finally:
    if launcher:
        launcher.stop()
    server.shutdown()
    out.write_text(json.dumps(report, indent=2) + "\n")
