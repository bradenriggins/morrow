"""Browser-level sign-in and read proof against a local HTTPS Moodle fixture."""

import json
import os
import shutil
import ssl
import subprocess
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

from moodle.browser_read import course_list_expression, validate_course_result


CHROME_FOR_TESTING = (
    "/Users/Braden/Library/Caches/ms-playwright/chromium-1243/"
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/"
    "Google Chrome for Testing"
)


def _test_chromium():
    requested = os.environ.get("MORROW_TEST_CHROMIUM_BIN")
    if requested:
        if not Path(requested).is_file():
            pytest.skip("MORROW_TEST_CHROMIUM_BIN is unavailable")
        return requested
    if Path(CHROME_FOR_TESTING).is_file():
        return CHROME_FOR_TESTING
    for name in ("chromium", "chromium-browser"):
        candidate = shutil.which(name)
        if candidate:
            return candidate
    pytest.skip("Chrome for Testing or Chromium is unavailable")


class MoodleFixture(BaseHTTPRequestHandler):
    mode = "ok"
    calls = 0

    def log_message(self, *_args):
        pass

    def _send(self, code, body=b"", content_type="text/html", headers=()):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/moodle":
            if "MoodleSession=fixture" not in self.headers.get("Cookie", ""):
                self._send(302, headers=(("Location", "/moodle/login"),))
                return
            html = ("<html><script type='application/json'>"
                    "{\"sesskey\":\"FORGEDSESSKEY\",\"userid\":99}"
                    "</script><script>M.cfg = {\"wwwroot\":"
                    "\"https://127.0.0.1:%d/moodle\",\"sesskey\":"
                    "\"ABCDEFGHIJ\",\"userid\":7};</script>"
                    "<body>Teacher dashboard</body></html>")
            self._send(200, (html % self.server.server_port).encode())
        elif path == "/moodle/login":
            self._send(200, b'<form method="post"><input id="username" '
                       b'name="username"><input id="password" '
                       b'name="password" type="password"><button>Sign in</button>'
                       b'</form>')
        else:
            self._send(404)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        size = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(size)
        if path == "/moodle/login":
            fields = urllib.parse.parse_qs(body.decode())
            if fields.get("username") == ["teacher"] and fields.get("password") == ["testonly"]:
                self._send(302, headers=(("Location", "/moodle"),
                                          ("Set-Cookie", "MoodleSession=fixture; Secure; HttpOnly; SameSite=Lax; Path=/moodle")))
            else:
                self._send(403)
            return
        if path == "/moodle/lib/ajax/service.php":
            MoodleFixture.calls += 1
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if ("MoodleSession=fixture" not in self.headers.get("Cookie", "")
                    or query.get("sesskey") != ["ABCDEFGHIJ"]):
                self._send(403)
                return
            if MoodleFixture.mode == "redirect":
                self._send(302, headers=(("Location", "/moodle/login"),))
                return
            payload = ([{"error": False, "data": {"courses": [
                {"id": 2, "fullname": "My first course",
                 "enrolled": 26, "student_name": "Never return"}]}}]
                if MoodleFixture.mode == "ok" else
                [{"error": True, "errorcode": "servicenotavailable"}])
            self._send(200, json.dumps(payload).encode(), "application/json")
            return
        self._send(404)


def _isolated_eval(page, expression):
    client = page.context.new_cdp_session(page)
    frame = client.send("Page.getFrameTree")["frameTree"]["frame"]["id"]
    context_id = client.send("Page.createIsolatedWorld", {
        "frameId": frame, "worldName": "morrow_moodle_e2e"})["executionContextId"]
    result = client.send("Runtime.evaluate", {
        "expression": expression, "contextId": context_id,
        "awaitPromise": True, "returnByValue": True})
    assert "exceptionDetails" not in result, result.get("exceptionDetails")
    return result["result"].get("value")


def test_browser_owned_signin_and_course_read(tmp_path):
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048",
                    "-nodes", "-keyout", str(key), "-out", str(cert),
                    "-days", "1", "-subj", "/CN=127.0.0.1"],
                   check=True, capture_output=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), MoodleFixture)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(str(cert), str(key))
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = "https://127.0.0.1:%d/moodle" % server.server_port
    out_dir = Path(os.environ.get("MORROW_MOODLE_E2E_ARTIFACT_DIR",
                                  str(tmp_path / "artifacts")))
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=_test_chromium(), headless=True)
            context = browser.new_context(ignore_https_errors=True)
            page = context.new_page()
            page.goto(base)
            before = _isolated_eval(page, course_list_expression(base))
            assert before == {"ok": False, "code": "login_required"}
            page.locator("#username").fill("teacher")
            page.locator("#password").fill("testonly")
            page.get_by_role("button", name="Sign in").click()
            page.wait_for_url(base)
            assert page.evaluate("document.cookie") == ""
            result = _isolated_eval(page, course_list_expression(base))
            clean = validate_course_result(result)
            assert clean == {"principal_id": 7, "courses": [
                {"id": 2, "name": "My first course"}]}
            assert MoodleFixture.calls == 1
            page.screenshot(path=str(out_dir / "signed-in.png"))
            MoodleFixture.mode = "error"
            unavailable = _isolated_eval(page, course_list_expression(base))
            assert unavailable == {"ok": False, "code": "course_api_unavailable"}
            MoodleFixture.mode = "redirect"
            redirected = _isolated_eval(page, course_list_expression(base))
            assert redirected == {"ok": False, "code": "session_or_site_unavailable"}
            artifact = {"before_signin": before,
                        "course_read": clean,
                        "api_unavailable": unavailable,
                        "redirect": redirected,
                        "http_only_cookie_in_page": False}
            (out_dir / "result.json").write_text(
                json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        MoodleFixture.mode = "ok"
        MoodleFixture.calls = 0
