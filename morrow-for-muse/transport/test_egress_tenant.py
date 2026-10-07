#!/usr/bin/env python3
"""The egress probe uses only the selected, validated LMS host.

Failure mode pinned down (written before the fix; final sweep
2026-09-23, item probe-ignores-helper-env-tenant): INSTALL.md step 4
says the probe handshakes with "your tenant host". default_test_host
read only the shell's CANVAS_BASE, but every documented step sets it in
helper/env, so installs probed example.com. A VM that reaches
example.com directly but needs a proxy for the school's host passed
step 4 as mode=direct, a mode that does not fit the Canvas address.

The tenant resolves the way every agent-side reader resolves it
(config/tree_config): the environment, then helper/env, then the legacy
global env.
"""

import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
for _p in (TREE, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import egress  # noqa: E402


@pytest.fixture
def config(tmp_path, monkeypatch):
    env_file = tmp_path / "helper-env"
    monkeypatch.setenv("MORROW_HELPER_ENV_FILE", str(env_file))
    monkeypatch.setenv("MORROW_HOME", str(tmp_path / "morrow"))
    for name in ("CANVAS_BASE", "MOODLE_BASE", "MORROW_LMS_PROVIDER",
                 "CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED", "https_proxy", "HTTPS_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(egress.socket, "create_connection",
                        lambda *a, **kw: pytest.fail("unexpected network request"))
    (tmp_path / "morrow").mkdir()
    return env_file, tmp_path / "morrow" / "env"


def test_the_probe_uses_the_tenant_in_helper_env(config):
    env_file, _legacy = config
    env_file.write_text("CANVAS_BASE=https://school.instructure.com/\n")
    assert egress.default_test_host() == "school.instructure.com"


def test_the_probe_uses_the_legacy_global_env(config):
    _env_file, legacy = config
    legacy.write_text("export CANVAS_BASE='https://legacy.instructure.com'\n")
    assert egress.default_test_host() == "legacy.instructure.com"


def test_the_environment_wins(config, monkeypatch):
    env_file, _legacy = config
    env_file.write_text("CANVAS_BASE=https://school.instructure.com\n")
    monkeypatch.setenv("CANVAS_BASE", "https://shell.instructure.com")
    assert egress.default_test_host() == "shell.instructure.com"


def test_no_tenant_blocks_without_network(config):
    env_file, _legacy = config
    env_file.write_text("# CANVAS_BASE=https://myschool.instructure.com\n")
    assert egress.default_test_host() is None
    result = egress.probe_egress()
    assert result["mode"] == "blocked"
    assert "no network request was made" in result["detail"]


def test_install_step_4_reads_the_tree_env(tmp_path):
    """install.sh imports egress with only transport/ on sys.path and
    the working directory outside the tree; the tree's helper/env still
    names the host."""
    env_file = tmp_path / "helper-env"
    env_file.write_text("CANVAS_BASE=https://school.instructure.com\n")
    env = dict(os.environ, MORROW_HELPER_ENV_FILE=str(env_file),
               MORROW_HOME=str(tmp_path / "morrow"), HOME=str(tmp_path),
               PYTHONDONTWRITEBYTECODE="1")
    env.pop("CANVAS_BASE", None)
    code = ("import sys\n"
            "sys.path.insert(0, %r)\n"
            "import egress\n"
            "print(egress.default_test_host())\n" % HERE)
    proc = subprocess.run([sys.executable, "-c", code], cwd="/",
                          env=env, capture_output=True, text=True,
                          timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "school.instructure.com"


@pytest.mark.parametrize("settings,host", [
    ("CANVAS_BASE=https://school.instructure.com\n", "school.instructure.com"),
    ("CANVAS_BASE=https://canvas.school.edu\n", "canvas.school.edu"),
    ("MOODLE_BASE=https://school.example.edu/moodle\n", "school.example.edu"),
    ("CANVAS_BASE=https://school.instructure.com\nMOODLE_BASE=https://moodle.example.edu/moodle\nMORROW_LMS_PROVIDER=moodle\n", "moodle.example.edu"),
    ("CANVAS_BASE=https://school.instructure.com\nMOODLE_BASE=https://moodle.example.edu/moodle\nMORROW_LMS_PROVIDER=canvas\n", "school.instructure.com"),
])
def test_selected_tenant_is_the_only_direct_probe(config, monkeypatch, settings, host):
    config[0].write_text(settings)
    if host == "canvas.school.edu":
        monkeypatch.setenv("CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED", host)
    calls = []
    monkeypatch.setattr(egress, "direct_egress_ok",
                        lambda target, timeout, port: (calls.append((target, port)) or True, "ok"))
    assert egress.probe_egress()["mode"] == "direct"
    assert calls == [(host, 443)]


@pytest.mark.parametrize("settings", [
    "CANVAS_BASE=https://example.com\n",
    "CANVAS_BASE=http://school.instructure.com\n",
    "CANVAS_BASE=https://secret:password@school.instructure.com\n",
    "CANVAS_BASE=https://127.0.0.1\n",
    "MOODLE_BASE=http://school.example.edu/moodle\n",
    "CANVAS_BASE=https://school.instructure.com\nMOODLE_BASE=https://moodle.example.edu\n",
    "MORROW_LMS_PROVIDER=invalid\n",
])
def test_invalid_or_ambiguous_tenant_blocks_without_network(config, settings):
    config[0].write_text(settings)
    result = egress.probe_egress()
    assert result["mode"] == "blocked"
    assert "secret" not in result["detail"]
    assert "password" not in result["detail"]


def test_explicit_probe_host_remains_supported(config, monkeypatch):
    calls = []
    monkeypatch.setattr(egress, "direct_egress_ok",
                        lambda host, timeout, port: (calls.append((host, port)) or True, "ok"))
    assert egress.probe_egress(test_host="school.instructure.com")["mode"] == "direct"
    assert calls == [("school.instructure.com", 443)]


def test_proxy_selection_needs_no_network_or_tenant(config):
    result = egress.probe_egress(proxy_url="http://user:password@proxy.example.edu:3128")
    assert result["mode"] == "proxy_auth"
    assert "password" not in result["detail"]


@pytest.mark.parametrize("provider", ["canvas", "moodle"])
@pytest.mark.parametrize("port", [443, 8443])
@pytest.mark.parametrize("pin_matches", [True, False])
def test_direct_probe_preserves_tls_hostname_and_certificate_pin(config, monkeypatch,
                                                                 pin_matches, port, provider):
    import base64
    import hashlib
    import ssl

    name = "CANVAS_BASE" if provider == "canvas" else "MOODLE_BASE"
    config[0].write_text("%s=https://school.instructure.com:%s\n" % (name, port))
    cert = b"synthetic-leaf-certificate"
    digest = hashlib.sha256(cert if pin_matches else b"other-cert").digest()
    monkeypatch.setenv("MORROW_EGRESS_PIN", base64.b64encode(digest).decode())
    context = ssl.create_default_context()
    assert context.check_hostname is True
    assert context.verify_mode == ssl.CERT_REQUIRED
    calls = []

    class FakeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def getpeercert(self, binary_form):
            assert binary_form is True
            return cert

    def connect(address, timeout):
        calls.append(address)
        return FakeSocket()

    class FakeContext:
        def wrap_socket(self, sock, server_hostname):
            assert server_hostname == "school.instructure.com"
            return sock

    monkeypatch.setattr(egress.socket, "create_connection", connect)
    monkeypatch.setattr(egress.ssl, "create_default_context", lambda: FakeContext())
    result = egress.probe_egress()
    assert (result["mode"] == "direct") is pin_matches
    detail = result["detail"]
    assert calls == [("school.instructure.com", port)]
    assert "school.instructure.com:%s" % port in detail
    if not pin_matches:
        assert "CertPinMismatch" in detail


def test_malformed_certificate_pin_blocks_before_connection(config, monkeypatch):
    monkeypatch.setenv("MORROW_EGRESS_PIN", "invalid")
    assert egress.direct_egress_ok("school.instructure.com")[0] is False


@pytest.mark.parametrize("provider", ["canvas", "moodle"])
@pytest.mark.parametrize("port", ["0", "65536", "-1", "bad"])
def test_invalid_configured_port_blocks_before_socket(config, provider, port):
    name = "CANVAS_BASE" if provider == "canvas" else "MOODLE_BASE"
    config[0].write_text("%s=https://school.instructure.com:%s\n" % (name, port))
    result = egress.probe_egress()
    assert result["mode"] == "blocked"
    assert "no network request was made" in result["detail"]


@pytest.mark.parametrize("confirmation,expected", [
    ("canvas.school.edu", "direct"),
    ("other.school.edu", "blocked"),
])
def test_custom_canvas_file_confirmation_governs_probe(config, monkeypatch,
                                                       confirmation, expected):
    config[0].write_text(
        "CANVAS_BASE=https://canvas.school.edu:8443\n"
        "CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED=%s\n" % confirmation)
    calls = []
    monkeypatch.setattr(egress, "direct_egress_ok",
                        lambda host, timeout, port: (calls.append((host, port)) or True, "ok"))
    assert egress.probe_egress()["mode"] == expected
    assert calls == ([("canvas.school.edu", 8443)] if expected == "direct" else [])
