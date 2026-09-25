"""Regression cases for the retired persisted Moodle keepalive path.

Failure modes recorded before the fix:
1. The scheduled script passed a JSON dictionary to from_bundle, which needs
   a live requests.Session, then called a nonexistent MoodleSession.get.
2. A stored JSON bundle could hold session secrets, but login.bootstrap keeps
   them in memory and never creates a safe, usable persisted bundle.
3. A 200 login page, changed principal, changed sesskey, or cross-site response
   must never be reported as a healthy authenticated keepalive.
4. A Moodle site under /moodle must keep that path for login, dispatch,
   detection, the capability probe, and the health probe. A response from
   another path, port, scheme, or host cannot prove the session healthy.
5. A base with URL credentials, query, fragment, traversal, or encoded
   path segments must fail before a session or journal is created.

All provider responses below are local fakes. The shell checks run a copied
script against a disposable directory; they never contact Moodle.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from moodle.session import MoodleSession


TREE = Path(__file__).resolve().parents[1]
SCRIPT = TREE / "bin" / "keepalive-moodle.sh"
SESSKEY = "0123456789"


class FakeResponse:
    def __init__(self, status=200, body=None, url="https://m.edu/my/",
                 location=None, payload=None):
        self.status_code = status
        self.text = (body if body is not None else
                     '<script>M.cfg={"sesskey":"%s","userid":7}</script>'
                     % SESSKEY)
        self.url = url
        self.headers = {"Location": location} if location else {}
        self.payload = payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError("HTTP %d" % self.status_code)

    def json(self):
        return self.payload


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.gets = []
        self.posts = []
        self.cookies = {}

    def get(self, url, **kwargs):
        self.gets.append((url, kwargs))
        return self.response

    def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        raise AssertionError("keepalive must not POST")


def _probe(tmp_path, response=None, principal=None, sesskey=SESSKEY,
           base="https://m.edu"):
    from moodle.keepalive import probe_session

    transport = FakeSession(response or FakeResponse())
    sess = MoodleSession(base, transport, sesskey,
                         principal=({"id": 7} if principal is None else
                                    principal),
                         journal_dir=str(tmp_path / "journal"))
    return probe_session(sess), transport


def test_live_bundle_is_required_before_journal_or_network(tmp_path):
    journal = tmp_path / "journal"
    bundle = {"base": "https://m.edu",
              "session": {"cookie": "SECRET-CANARY"},
              "sesskey": SESSKEY}
    with pytest.raises(TypeError, match="live.*session|in.memory"):
        MoodleSession.from_bundle(bundle, journal_dir=str(journal))
    assert not journal.exists()


def test_in_memory_bundle_supports_read_only_keepalive(tmp_path):
    from moodle.keepalive import probe_session

    transport = FakeSession(FakeResponse())
    bundle = {"base": "https://m.edu", "session": transport,
              "sesskey": SESSKEY, "principal": {"id": 7}}
    sess = MoodleSession.from_bundle(bundle,
                                     journal_dir=str(tmp_path / "journal"))
    result = probe_session(sess)
    assert result == {"state": "healthy", "http_status": 200,
                      "principal_id": 7}
    assert transport.gets == [("https://m.edu/my/",
                               {"timeout": sess.timeout,
                                "allow_redirects": False})]
    assert transport.posts == []
    assert "sesskey" not in repr(result).lower()


@pytest.mark.parametrize("response,expected", [
    (FakeResponse(status=401), "expired"),
    (FakeResponse(status=403), "expired"),
    (FakeResponse(status=302, location="https://m.edu/login/index.php"),
     "expired"),
    (FakeResponse(status=302, location="https://other.example/my/"),
     "unverified"),
    (FakeResponse(status=200, body="<form action='/login/index.php'>"),
     "expired"),
    (FakeResponse(status=200, url="https://other.example/my/"),
     "unverified"),
    (FakeResponse(status=500), "unverified"),
])
def test_probe_never_follows_redirect_or_posts(tmp_path, response, expected):
    result, transport = _probe(tmp_path, response)
    assert result["state"] == expected
    assert len(transport.gets) == 1
    assert transport.gets[0][1]["allow_redirects"] is False
    assert transport.posts == []


def test_probe_rejects_changed_or_unknown_identity(tmp_path):
    changed_id = FakeResponse(body='<script>M.cfg={"sesskey":"%s",'
                              '"userid":8}</script>' % SESSKEY)
    result, _ = _probe(tmp_path / "id", changed_id)
    assert result["state"] == "principal_mismatch"

    result, _ = _probe(tmp_path / "pin", principal={})
    assert result["state"] == "unverified"

    changed_key = FakeResponse(body='<script>M.cfg={"sesskey":'
                               '"ABCDEFGHIJ","userid":7}</script>')
    result, _ = _probe(tmp_path / "key", changed_key)
    assert result["state"] == "session_changed"

    no_identity = FakeResponse(body="<html>ordinary page</html>")
    result, _ = _probe(tmp_path / "missing", no_identity)
    assert result["state"] == "unverified"


@pytest.mark.parametrize("bad", [
    "https://user:pass@m.edu/moodle",
    "https://m.edu/moodle?session=secret",
    "https://m.edu/moodle#fragment",
    "https://m.edu/moodle/../other",
    "https://m.edu/moodle/./other",
    "https://m.edu/moodle%2fother",
    "https://m.edu/moodle\\other",
    "https://m.edu/moodle//other",
])
def test_unsafe_prefixed_base_rejected_before_journal(tmp_path, bad):
    from moodle.session import normalize_moodle_base

    with pytest.raises(ValueError):
        normalize_moodle_base(bad)
    journal = tmp_path / "journal"
    with pytest.raises(ValueError):
        MoodleSession(bad, FakeSession(FakeResponse()), SESSKEY,
                      journal_dir=str(journal))
    assert not journal.exists()


def test_prefixed_base_normalizes_for_detection():
    from lanes import detect
    from moodle.session import normalize_moodle_base

    base = "https://m.edu:8443/moodle"
    assert normalize_moodle_base(base + "/") == base
    assert detect._normalize_base_url(base + "/") == base


def test_prefixed_base_reaches_login_and_authenticated_pages(monkeypatch):
    from moodle import login

    base = "https://m.edu/moodle"
    class Cookies:
        def get_dict(self):
            return {"MoodleSession": "SECRET-CANARY"}

    class LoginTransport:
        def __init__(self):
            self.headers = {}
            self.cookies = Cookies()
            self.gets = []
            self.posts = []

        def get(self, url, **kwargs):
            self.gets.append(url)
            if url == base + "/login/index.php":
                return FakeResponse(url=url, body='<input name="logintoken" value="t">')
            return FakeResponse(url=url)

        def post(self, url, **kwargs):
            self.posts.append((url, kwargs))
            return FakeResponse(url=base + "/my/")

    transport = LoginTransport()
    monkeypatch.setattr(login, "SafeRedirectSession", lambda: transport)
    bundle = login.bootstrap(base + "/", "teacher", "SECRET-PASSWORD")
    assert bundle["base"] == base
    assert transport.gets == [base + "/login/index.php"] + [
        base + "/my/"] * 3
    assert [url for url, _ in transport.posts] == [base + "/login/index.php"]
    assert bundle["principal"]["id"] == 7
    assert bundle["sesskey"] == SESSKEY


def test_prefixed_base_reaches_ajax_and_form_paths(tmp_path):
    class DispatchTransport(FakeSession):
        def post(self, url, **kwargs):
            self.posts.append((url, kwargs))
            if url.endswith("/lib/ajax/service.php"):
                return FakeResponse(url=url, payload=[{"error": False,
                                                       "data": {"id": 7}}])
            return FakeResponse(url=url)

    transport = DispatchTransport(FakeResponse())
    base = "https://m.edu:8443/moodle"
    sess = MoodleSession(base, transport, SESSKEY,
                         journal_dir=str(tmp_path / "journal"))
    assert sess.ajax("core_user_get_users", {})["data"] == {"id": 7}
    assert sess.form_write("/mod/forum/post.php", {"subject": "local"})[
        "http"] == 200
    assert [url for url, _ in transport.posts] == [
        base + "/lib/ajax/service.php", base + "/mod/forum/post.php"]


def test_prefixed_capability_probe_reads_site_front_page_once():
    from moodle.probe import scrape_version

    base = "https://m.edu/moodle"
    transport = FakeSession(FakeResponse(body="Moodle 5.2", url=base + "/"))
    assert scrape_version(transport, base + "/", 5) == "5.2"
    assert transport.gets == [(base + "/", {"timeout": 5})]


@pytest.mark.parametrize("response,expected", [
    (FakeResponse(url="https://m.edu/moodle/my/"), "healthy"),
    (FakeResponse(status=302, url="https://m.edu/moodle/my/",
                  location="/moodle/login/index.php"), "expired"),
    (FakeResponse(status=200, url="https://m.edu/moodle/login/index.php"),
     "expired"),
    (FakeResponse(url="https://m.edu/moodle/other"), "unverified"),
    (FakeResponse(url="https://m.edu:8443/moodle/my/"), "unverified"),
    (FakeResponse(url="http://m.edu/moodle/my/"), "unverified"),
    (FakeResponse(url="https://other.example/moodle/my/"), "unverified"),
    (FakeResponse(status=302, url="https://m.edu/moodle/my/",
                  location="https://other.example/moodle/login/index.php"),
     "unverified"),
])
def test_prefixed_probe_requires_exact_origin_and_path(tmp_path, response,
                                                        expected):
    base = "https://m.edu/moodle"
    result, transport = _probe(tmp_path, response, base=base)
    assert result["state"] == expected
    assert transport.gets[0][0] == base + "/my/"
    assert transport.posts == []


def _run_copied_script(tmp_path, bundle_text=None):
    tree = tmp_path / "tree"
    (tree / "bin").mkdir(parents=True)
    (tree / "logs").mkdir()
    shutil.copy2(SCRIPT, tree / "bin" / SCRIPT.name)
    state = tmp_path / "state"
    state.mkdir()
    if bundle_text is not None:
        (state / "moodle-session.json").write_text(bundle_text)
    proc = subprocess.run(["bash", str(tree / "bin" / SCRIPT.name)],
                          capture_output=True, text=True, timeout=10,
                          env=dict(os.environ, MORROW_HOME=str(state)))
    log = (tree / "logs" / "keepalive-moodle.log").read_text()
    return proc, log


def test_scheduler_without_live_session_is_honestly_idle(tmp_path):
    proc, log = _run_copied_script(tmp_path)
    assert proc.returncode == 0
    assert "IDLE" in log
    assert "bootstrap with moodle/login.py" not in log
    assert proc.stdout == proc.stderr == ""


def test_legacy_json_bundle_fails_closed_without_reading_secrets(tmp_path):
    proc, log = _run_copied_script(tmp_path, "SECRET-CANARY { invalid json")
    assert proc.returncode != 0
    assert "BLOCKED" in log
    assert "SECRET-CANARY" not in log + proc.stdout + proc.stderr
    assert "JSONDecodeError" not in log + proc.stdout + proc.stderr
    assert "PROBE_ERROR" not in log + proc.stdout + proc.stderr


def test_demo_login_cli_says_it_does_not_activate_keepalive(
        tmp_path, monkeypatch, capsys):
    from moodle import login

    monkeypatch.setenv("MORROW_HOME", str(tmp_path))
    monkeypatch.setattr(login, "bootstrap", lambda *_args: {
        "landed_url": "https://sandbox.moodledemo.net/my/",
        "principal": {"id": 7}, "sesskey_len": 10,
        "sesskey_stable": True, "cookie_names": ["MoodleSession"],
        "cookie_value_len": {"MoodleSession": 13},
        "session": object(), "sesskey": "SECRET-CANARY",
    })
    assert login.main(["--base", "https://sandbox.moodledemo.net"]) == 0
    output = capsys.readouterr().out
    assert "does not activate" in output
    assert "scheduled keepalive" in output
    assert "SECRET-CANARY" not in output
    assert not (tmp_path / "moodle-session.json").exists()
