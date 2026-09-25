"""Exercise Moodle helper HTTP routes with a controlled browser stub."""

import importlib.util
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path


def test_moodle_helper_routes_keep_cdp_and_navigation_closed(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[1]
    empty_env = tmp_path / "empty-env"
    empty_env.write_text("")
    empty_env.chmod(0o600)
    profile = tmp_path / "profile"
    profile.mkdir()
    token = "a" * 64
    for key, value in {
        "MORROW_HOME": str(tmp_path / "state"),
        "MORROW_HELPER_ENV_FILE": str(empty_env),
        "LOGIN_HELPER_PROFILE_DIR": str(profile),
        "LOGIN_HELPER_PORT": "10008",
        "LOGIN_HELPER_CDP_PORT": "20330",
        "LOGIN_HELPER_PROVIDER": "moodle",
        "MOODLE_BASE": "https://moodle.school.edu",
        "HELPER_AUTH_TOKEN": token,
    }.items():
        monkeypatch.setenv(key, value)
    spec = importlib.util.spec_from_file_location(
        "moodle_helper_route_e2e", root / "helper" / "server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)

    class Browser:
        def status(self):
            return {"provider": "moodle", "site_base": "https://moodle.school.edu",
                    "connection_id": "fixture", "chromium_alive": True,
                    "helper_version": "fixture"}

        def moodle_courses(self):
            return {"ok": True, "principal_id": 7,
                    "courses": [{"id": 2, "name": "My first course"}]}

    server.BROWSER = Browser()
    http = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(path, with_token=False):
        req = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (http.server_port, path),
            headers={"X-Helper-Token": token} if with_token else {})
        try:
            with opener.open(req, timeout=5) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def post(path):
        req = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (http.server_port, path),
            data=b"{}", method="POST",
            headers={"X-Helper-Token": token,
                     "Content-Type": "application/json"})
        try:
            with opener.open(req, timeout=5) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    try:
        assert get("/moodle/courses")[0] == 403
        assert get("/moodle/ping")[0] == 403
        code, body = get("/moodle/courses", with_token=True)
        assert code == 200
        assert json.loads(body) == {"ok": True, "principal_id": 7,
                                    "courses": [{"id": 2,
                                                 "name": "My first course"}]}
        assert get("/moodle/ping", with_token=True)[0] == 200
        assert get("/cdp/events", with_token=True)[0] == 404
        assert post("/cdp/evaluate")[0] == 403
        assert post("/navigate")[0] == 403
        code, body = get("/")
        assert code == 200
        assert b"Moodle Login Helper" in body
        assert b"Canvas Login Helper" not in body
    finally:
        http.shutdown()
        http.server_close()
