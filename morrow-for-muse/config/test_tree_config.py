#!/usr/bin/env python3
"""Agent-side commands read the tree's helper/env, and the helper token
where keepalive writes it.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-22):
  1. `morrow query` read the helper token from the retired dev path
     ~/.morrow/canvas-login-helper/helper_token. keepalive writes it to
     <MORROW_HOME>/trees/<tree id>/helper_token, so the query failed in
     every installed tree ("the live read failed ... token file").
  2. INSTALL.md puts CANVAS_BASE in helper/env and install.sh refuses a
     shell-only value, so the agent's shell has none. reauth pin and
     resume refused ("CANVAS_BASE is not set"), `morrow query` said
     Canvas is not connected, `morrow students find` said "Set
     --canvas-base or CANVAS_BASE", and `morrow audit` refused too.
  3. The same commands ignored LOGIN_HELPER_PORT from helper/env and
     talked to port 8901 (query, students find, doctor), or read the
     port from the shell only (reauth, the executor's helper client).

Resolution order, as keepalive.sh and helper/server.py resolve it: the
process environment, then <tree>/helper/env, then (CANVAS_BASE only)
the legacy <MORROW_HOME>/env. A fake helper answers on an ephemeral
port named only in helper/env.
"""

import http.server
import json
import os
import sys
import threading

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from config import tree_config  # noqa: E402
# The executor binds its journal to the session's scratch state dir at
# import; the fixtures below point only the helper token elsewhere.
from dispatch import executor  # noqa: E402,F401

TENANT = "https://myschool.example.edu"
TOKEN = "ab" * 32


class _FakeHelper(http.server.BaseHTTPRequestHandler):
    status_doc = {"logged_in": True, "chromium_alive": True,
                  "starting": False}
    seen = []

    def log_message(self, *args):
        pass

    def _reply(self, code, doc):
        raw = json.dumps(doc).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        type(self).seen.append(("GET", self.path,
                                self.headers.get("X-Helper-Token")))
        self._reply(200, type(self).status_doc)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        token = self.headers.get("X-Helper-Token")
        type(self).seen.append(("POST", self.path, token))
        if token != TOKEN:
            self._reply(403, {"error": "forbidden"})
            return
        self._reply(200, {"tabs": []})


@pytest.fixture
def fake_helper():
    _FakeHelper.seen = []
    _FakeHelper.status_doc = {"logged_in": True, "chromium_alive": True,
                              "starting": False}
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeHelper)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield srv.server_address[1]
    finally:
        srv.shutdown()
        srv.server_close()


@pytest.fixture
def tree_env(tmp_path, monkeypatch):
    """helper/env (via its test seam) and a tree state dir holding the
    helper token where keepalive writes it. The shell has neither
    CANVAS_BASE nor a helper port."""
    for name in ("CANVAS_BASE", "LOGIN_HELPER_PORT", "LOGIN_HELPER_CDP_PORT",
                 "LOGIN_HELPER_TLS_CERT", "LOGIN_HELPER_TLS_KEY",
                 "MORROW_HELPER_STATUS_URL"):
        monkeypatch.delenv(name, raising=False)
    env_file = tmp_path / "helper-env"
    state = tmp_path / "tree-state"
    state.mkdir()
    (state / "helper_token").write_text(TOKEN + "\n")
    monkeypatch.setenv("MORROW_HELPER_ENV_FILE", str(env_file))
    monkeypatch.setenv("MORROW_TREE_STATE_DIR", str(state))
    monkeypatch.setenv("MORROW_HOME", str(tmp_path / "home"))

    def write(**values):
        lines = ["# Morrow for Muse: educator config for THIS tree."]
        lines += ["%s=%s" % kv for kv in values.items()]
        env_file.write_text("\n".join(lines) + "\n")
        env_file.chmod(0o600)
    write(CANVAS_BASE=TENANT)
    return write


# ------------------------------------------------------------ resolver --

def test_resolution_order(tree_env, tmp_path, monkeypatch):
    tree_env(CANVAS_BASE='"%s/"' % TENANT, LOGIN_HELPER_PORT="18999")
    assert tree_config.canvas_base() == TENANT
    assert tree_config.helper_port() == 18999
    monkeypatch.setenv("LOGIN_HELPER_PORT", "18998")
    assert tree_config.helper_port() == 18998
    tree_env()
    home = tmp_path / "home"
    home.mkdir()
    (home / "env").write_text("export CANVAS_BASE=https://legacy.example.edu"
                              "\nLOGIN_HELPER_CDP_PORT=19999\n")
    assert tree_config.canvas_base() == "https://legacy.example.edu"
    assert tree_config.setting("LOGIN_HELPER_CDP_PORT") is None
    monkeypatch.delenv("LOGIN_HELPER_PORT")
    assert tree_config.helper_port() == 8901


def test_transport_helper_ports_come_from_helper_env(tree_env):
    import local_chromium as lc
    tree_env(CANVAS_BASE=TENANT, LOGIN_HELPER_PORT="18997",
             LOGIN_HELPER_CDP_PORT="19997")
    assert lc.tree_helper_port() == 18997
    assert lc.tree_cdp_port() == 19997


# -------------------------------------------------------- morrow query --

def test_query_helper_client_uses_the_tree_token_and_port(tree_env,
                                                          fake_helper):
    from query import live_read
    tree_env(CANVAS_BASE=TENANT, LOGIN_HELPER_PORT=str(fake_helper))
    client = live_read._HelperClient()
    assert client.status()["logged_in"] is True
    assert client.tabs() == []
    assert ("POST", "/cdp/tabs", TOKEN) in _FakeHelper.seen


def test_query_reports_an_unreadable_token_by_its_real_path(tree_env,
                                                           tmp_path):
    from query import live_read
    os.unlink(str(tmp_path / "tree-state" / "helper_token"))
    with pytest.raises(live_read.LiveReadError) as exc:
        live_read._HelperClient()
    assert str(tmp_path / "tree-state" / "helper_token") in str(exc.value)


def test_query_chain_takes_the_tenant_from_helper_env(tree_env,
                                                      monkeypatch):
    from query import chain, live_read
    seen = {}

    class _Reader:
        def __init__(self, tenant_base):
            seen["tenant"] = tenant_base

        def health_check(self):
            raise live_read.LiveReadError("helper Chromium is not alive")

        def close(self):
            pass
    monkeypatch.setattr(live_read, "LiveReader", _Reader)
    with pytest.raises(chain.ChainFailure) as exc:
        chain.run_query("101", "last_week")
    assert seen["tenant"] == TENANT
    assert exc.value.translated.mode_id == "canvas-session-dead"


# ----------------------------------------------- morrow students find --

def test_students_find_takes_the_tenant_from_helper_env(tree_env,
                                                        monkeypatch,
                                                        capsys):
    from learners import find
    seen = {}

    def _find(fetcher, tenant_base, course_id, query, **kw):
        seen["tenant"] = tenant_base
        return {"ok": True, "status": "not_found", "message": "none"}
    monkeypatch.setattr(find, "find_student", _find)
    rc = find.main(["--course", "101", "Jane", "Doe"],
                   fetcher=lambda url: (200, {}, "[]"))
    assert "Set --canvas-base" not in capsys.readouterr().out
    assert rc == 0 and seen["tenant"] == TENANT


def test_students_find_checks_the_helper_on_the_tree_port(tree_env,
                                                          fake_helper):
    from learners import resolve_student
    tree_env(CANVAS_BASE=TENANT, LOGIN_HELPER_PORT=str(fake_helper))
    _FakeHelper.status_doc = {"logged_in": False}
    with pytest.raises(RuntimeError, match="logged_in:false"):
        resolve_student.helper_fetch_factory(TENANT)
    assert ("GET", "/status", TOKEN) in _FakeHelper.seen


# ---------------------------------------------------- reauth pin/resume --

def test_reauth_reads_the_live_account_with_the_helper_env_tenant(
        tree_env, fake_helper, monkeypatch):
    from reauth import state_machine as rsm
    from transport import chromium_session as cs
    tree_env(CANVAS_BASE=TENANT, LOGIN_HELPER_PORT=str(fake_helper))
    seen = {}

    class _Session:
        def __init__(self, base):
            seen["base"] = base

        def base_for(self, provider):
            return seen["base"]

        def slot_secret(self, slot):
            return False, None

        def raw_request(self, method, url, headers, body, is_write=False):
            seen["url"] = url
            return 200, {}, b'{"id": 7, "name": "Ada Teacher"}', 1
    monkeypatch.setattr(cs, "ChromiumSession", _Session)
    assert rsm.read_live_principal() == (7, "Ada Teacher", TENANT)
    assert seen["url"] == TENANT + "/api/v1/users/self"
    assert ("GET", "/status", TOKEN) in _FakeHelper.seen


def test_reauth_names_helper_env_when_no_tenant_is_set(tree_env,
                                                       fake_helper):
    from reauth import state_machine as rsm
    tree_env(LOGIN_HELPER_PORT=str(fake_helper))
    with pytest.raises(rsm.PrincipalPinError) as exc:
        rsm.read_live_principal()
    assert "helper/env" in str(exc.value)


# ------------------------------------------------ morrow audit, doctor --

def test_audit_runner_takes_the_tenant_from_helper_env(tree_env,
                                                       monkeypatch):
    from catalog.a11y import runner
    import chromium_session
    seen = {}
    monkeypatch.setattr(chromium_session.ChromiumSession, "load",
                        classmethod(lambda cls, base_url=None:
                                    seen.setdefault("base", base_url)))
    runner._need_chromium_session()
    assert seen["base"] == TENANT


def test_doctor_checks_the_helper_on_the_tree_port(tree_env, fake_helper,
                                                    capsys):
    import importlib.machinery
    import importlib.util
    tree_env(CANVAS_BASE=TENANT, LOGIN_HELPER_PORT=str(fake_helper))
    loader = importlib.machinery.SourceFileLoader(
        "morrow_cli_tree_config", os.path.join(TREE, "bin", "morrow"))
    spec = importlib.util.spec_from_loader("morrow_cli_tree_config", loader)
    cli = importlib.util.module_from_spec(spec)
    loader.exec_module(cli)
    cli._doctor()
    out = capsys.readouterr().out
    assert "helper: reachable (http://127.0.0.1:%d/status)" % fake_helper \
        in out
