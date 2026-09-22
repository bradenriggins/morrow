#!/usr/bin/env python3
"""Selftest for the egress/cert probe module, the proxy forwarder's graceful
degradation, and the launcher's single-profile attach story.

No real Canvas traffic. The only real network allowed is one optional
direct-egress TLS check (3s timeout) inside the forwarder subprocess test.
Cert fixtures are generated under transport/.selftest-work/ (never /tmp).

Run: python3 transport/egress_selftest.py
"""
import contextlib
import os
import shutil
import subprocess
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import egress
import local_chromium as lc

WORK = os.path.join(_HERE, ".selftest-work")
FAKE_USER = "selftestuser"
FAKE_PASS = "selftestpass"
FAKE_PROXY_AUTH = "http://%s:%s@proxy.example:3128" % (FAKE_USER, FAKE_PASS)
FAKE_PROXY_BARE = "http://proxy.example:3128"

passed = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name
          + (" : " + detail if detail and not cond else ""))
    if not cond:
        raise SystemExit("selftest failed at: " + name)
    passed.append(name)


@contextlib.contextmanager
def fake_env(**overrides):
    """Temporarily replace the process environment. A value of None
    removes the variable."""
    saved = dict(os.environ)
    try:
        for k, v in overrides.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


def no_proxy_env():
    return fake_env(https_proxy=None, HTTPS_PROXY=None,
                    http_proxy=None, HTTP_PROXY=None,
                    MORROW_EGRESS_CA_PEM=None)


def openssl_pin(pem_path):
    """Independent SPKI pin via openssl (not via the module under test)."""
    p1 = subprocess.run(
        ["openssl", "x509", "-in", pem_path, "-noout", "-pubkey"],
        capture_output=True, text=True, check=True)
    p2 = subprocess.run(
        ["openssl", "pkey", "-pubin", "-outform", "DER"],
        input=p1.stdout.encode(), capture_output=True, check=True)
    p3 = subprocess.run(
        ["openssl", "dgst", "-sha256", "-binary"],
        input=p2.stdout, capture_output=True, check=True)
    p4 = subprocess.run(
        ["openssl", "base64", "-A"],
        input=p3.stdout, capture_output=True, check=True)
    return p4.stdout.decode().strip()


def make_throwaway_ca():
    os.makedirs(WORK, exist_ok=True)
    ca = os.path.join(WORK, "throwaway-ca.pem")
    key = os.path.join(WORK, "throwaway-ca.key")
    if os.path.isfile(ca):
        return ca
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048",
         "-keyout", key, "-out", ca, "-days", "2", "-nodes",
         "-subj", "/CN=egress-selftest-throwaway"],
        check=True, capture_output=True)
    return ca


def main():
    # ---- 0. default test host (P0-11) ----------------------------------
    with fake_env(CANVAS_BASE=None):
        check("default_test_host falls back to example.com",
              egress.default_test_host() == "example.com",
              egress.default_test_host())
    with fake_env(CANVAS_BASE="https://myschool.instructure.com"):
        check("default_test_host prefers configured CANVAS_BASE",
              egress.default_test_host() == "myschool.instructure.com",
              egress.default_test_host())

    # ---- 1. proxy URL redaction --------------------------------------
    r = egress.redact_proxy_url(FAKE_PROXY_AUTH)
    check("redact strips credentials", r == "http://proxy.example:3128", r)
    check("redact output has no user", FAKE_USER not in r)
    check("redact output has no pass", FAKE_PASS not in r)

    # ---- 2. probe: authenticated proxy --------------------------------
    with fake_env(https_proxy=FAKE_PROXY_AUTH, HTTPS_PROXY=None):
        p = egress.probe_egress()
    check("probe auth mode", p["mode"] == "proxy_auth", p["mode"])
    check("probe auth needs forwarder", p["needs_forwarder"] is True)
    check("probe auth proxy redacted",
          p["proxy"] == "http://proxy.example:3128", p["proxy"])
    check("probe auth detail clean",
          FAKE_USER not in p["detail"] and FAKE_PASS not in p["detail"])
    check("probe auth proxy field clean",
          FAKE_USER not in p["proxy"] and FAKE_PASS not in p["proxy"])

    # ---- 3. probe: unauthenticated proxy -------------------------------
    with fake_env(https_proxy=FAKE_PROXY_BARE, HTTPS_PROXY=None):
        p = egress.probe_egress()
    check("probe bare mode", p["mode"] == "proxy", p["mode"])
    check("probe bare needs no forwarder", p["needs_forwarder"] is False)
    check("probe bare proxy value",
          p["proxy"] == "http://proxy.example:3128", p["proxy"])

    # ---- 4. probe: direct / blocked (no proxy env) ----------------------
    real_direct = egress.direct_egress_ok
    try:
        with no_proxy_env():
            egress.direct_egress_ok = lambda host, timeout=3: (True, "ok")
            p = egress.probe_egress()
        check("probe direct mode", p["mode"] == "direct", p["mode"])
        check("probe direct needs no forwarder",
              p["needs_forwarder"] is False)
        check("probe direct has no upstream", p["upstream"] is None)

        with no_proxy_env():
            egress.direct_egress_ok = (
                lambda host, timeout=3: (False, "boom"))
            p = egress.probe_egress()
        check("probe blocked mode", p["mode"] == "blocked", p["mode"])
        check("probe blocked names proxy try",
              "https_proxy" in p["detail"], p["detail"][:120])
        check("probe blocked names direct try",
              "direct TLS" in p["detail"], p["detail"][:120])
        check("probe blocked no creds",
              FAKE_USER not in p["detail"] and FAKE_PASS not in p["detail"])
    finally:
        egress.direct_egress_ok = real_direct

    # ---- 5. cert derivation --------------------------------------------
    ca = make_throwaway_ca()
    with fake_env(MORROW_EGRESS_CA_PEM=ca):
        found = egress.find_egress_ca_pem()
        check("env override wins", found == ca, str(found))
        args = egress.chrome_spki_args()
        check("spki args has one flag", len(args) == 1, str(args))
        check("spki flag shape",
              args[0].startswith("--ignore-certificate-errors-spki-list="),
              args[0][:60])
        pin = args[0].split("=", 1)[1]
        expected = openssl_pin(ca)
        check("throwaway pin matches openssl", pin == expected,
              "module=%s openssl=%s" % (pin[:20], expected[:20]))
        check("ca_found boolean", egress.ca_found() is True)

    # Real sandbox CA: derivation must reproduce the proven pin, computed
    # independently via openssl (no pin literal anywhere in this file).
    real_ca = "/etc/ssl/certs/hatch-egress-ca.pem"
    if os.path.isfile(real_ca):
        with no_proxy_env():
            found = egress.find_egress_ca_pem()
            check("sandbox CA discovered", found == real_ca, str(found))
            pin = egress.spki_pin_for_pem(real_ca)
            check("sandbox pin matches openssl",
                  pin == openssl_pin(real_ca))
    else:
        print("SKIP sandbox CA checks (file absent on this VM)")

    # No CA anywhere: flag omitted entirely.
    with fake_env(MORROW_EGRESS_CA_PEM="/nonexistent-ca.pem"):
        orig = egress.CA_PEM_CANDIDATES
        egress.CA_PEM_CANDIDATES = ()
        try:
            check("no CA -> no spki flag",
                  egress.chrome_spki_args() == [])
            check("no CA -> ca_found False",
                  egress.ca_found() is False)
        finally:
            egress.CA_PEM_CANDIDATES = orig

    # ---- 6. launcher defaults: explicit profile, canonical port -------
    helper_profile = lc.tree_helper_profile_dir()
    check("helper_profile_dir is this tree's helper profile",
          lc.helper_profile_dir() == helper_profile,
          lc.helper_profile_dir())
    check("no morrow-chromium default",
          "morrow-chromium" not in lc.helper_profile_dir())
    try:
        lc.default_profile_dir()
        retired_raised = False
    except RuntimeError:
        retired_raised = True
    check("retired default_profile_dir() raises (pass an explicit profile)",
          retired_raised)
    check("canonical CDP port",
          lc.HELPER_CDP_PORT == 19223, str(lc.HELPER_CDP_PORT))
    launcher = lc.ChromiumLauncher(
        lc.default_binary(), lc.helper_profile_dir())
    check("launcher default port is 19223",
          launcher.cdp_port == 19223, str(launcher.cdp_port))

    # ---- 7. launcher egress probe (no browser needed) --------------------
    # The old section attached to a helper browser found via the
    # remote-debugging-port flag. That flag no longer exists (pipe era),
    # and a selftest must never attach to the live helper's browser.
    # The egress-relevant assertions survive without any browser: the
    # launcher's probe reports proxy_auth, wants the forwarder, and
    # never leaks credentials into detail/proxy.
    probe_profile = os.path.join(
        os.path.expanduser(
            "~/workspace/audits/adversarial-wave-4-2026-09-21/scratch/worker-browser"),
        ".egress-selftest-probe-profile")
    with fake_env(https_proxy=FAKE_PROXY_AUTH, HTTPS_PROXY=None):
        launcher = lc.ChromiumLauncher(
            lc.default_binary(), probe_profile)
        probe = launcher._probe()
        check("launcher probe mode here", probe["mode"] == "proxy_auth",
              probe["mode"])
        check("launcher probe wants forwarder", launcher._needs_forwarder())
        check("launcher probe detail clean",
              FAKE_USER not in probe["detail"] and "@" not in probe["proxy"])
        check("launcher never started a browser", launcher.proc is None
              and launcher.cdp is None)

    # ---- 8. forwarder graceful degradation -------------------------------
    fw = os.path.join(_HERE, "proxy_forwarder.py")

    def run_forwarder_module_with_probe(probe):
        """Execute proxy_forwarder.py's module-level startup with a stubbed
        egress probe (no network, no real env). Returns
        (system_exit_code, stdout_text, stderr_or_exit_message)."""
        import io
        import types
        fake = types.ModuleType("egress")
        fake.probe_egress = lambda: probe
        # W6-P2-6: the forwarder reads the pin env var name and the pin
        # parser off the egress module at startup; the fake must carry
        # them too (values delegate to the real module).
        fake.PROXY_PIN_ENV_VAR = egress.PROXY_PIN_ENV_VAR
        fake.parse_cert_pins = egress.parse_cert_pins
        saved = sys.modules.get("egress")
        sys.modules["egress"] = fake
        # The forwarder reads sys.argv[1] as the listen port at import.
        saved_argv = sys.argv[:]
        sys.argv = [fw, "18999"]
        buf = io.StringIO()
        code, msg = None, ""
        try:
            with contextlib.redirect_stdout(buf):
                exec(compile(open(fw).read(), fw, "exec"),
                     {"__name__": "fw_selftest", "__file__": fw})
        except SystemExit as e:
            code = e.code
            msg = "" if e.code in (0, None) else str(e.code)
        finally:
            sys.argv = saved_argv
            if saved is not None:
                sys.modules["egress"] = saved
            else:
                sys.modules.pop("egress", None)
        return code, buf.getvalue(), msg

    direct_probe = {"mode": "direct", "proxy": None,
                    "needs_forwarder": False, "upstream": None,
                    "detail": "direct egress works"}
    code, out, msg = run_forwarder_module_with_probe(direct_probe)
    check("forwarder direct exits 0", code == 0, "code=%r" % code)
    check("forwarder direct message",
          "direct egress, no forwarder needed" in out, out[:200])

    blocked_probe = {"mode": "blocked", "proxy": None,
                     "needs_forwarder": False, "upstream": None,
                     "detail": "no usable egress. Tried: authenticated proxy "
                               "(no https_proxy/HTTPS_PROXY in environment); "
                               "direct TLS to example.com:443 (failed: boom)"}
    code, out, msg = run_forwarder_module_with_probe(blocked_probe)
    # sys.exit("message") surfaces as a string code in-process; the real
    # process exits 1 and prints the message to stderr.
    exited_nonzero = (isinstance(code, int) and code != 0) or isinstance(code, str)
    check("forwarder blocked exits non-zero", exited_nonzero,
          "code=%r" % (code[:60] if isinstance(code, str) else code))
    diag = msg if isinstance(code, str) else out
    check("forwarder blocked diagnostic names tries",
          "Tried:" in diag and "https_proxy" in diag, diag[:200])
    check("forwarder blocked has no @-leak", "@" not in diag, diag[:200])

    # (a) no proxy env: one real 3s direct-egress check inside the child.
    # Either outcome is graceful: exit 0 with the direct message, or
    # non-zero with a diagnostic naming what was tried.
    env = {k: v for k, v in os.environ.items()
           if k not in ("https_proxy", "HTTPS_PROXY",
                        "http_proxy", "HTTP_PROXY")}
    r = subprocess.run([sys.executable, fw, "18099"],
                       capture_output=True, text=True, timeout=30, env=env)
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode == 0:
        check("forwarder no-proxy exits 0",
              "direct egress, no forwarder needed" in r.stdout, r.stdout[:200])
    else:
        check("forwarder no-proxy exits non-zero with diagnostic",
              r.returncode != 0 and "Tried:" in out, out[:300])
    check("forwarder no-proxy output has no @-leak", "@" not in out, out[:200])

    # (b) authenticated proxy env: serves on a scratch port, redacted logs.
    # W4-P2-9: the forwarder now requires MORROW_FORWARDER_LAUNCHER_PID;
    # the selftest passes its own PID (it spawns no authorized client
    # here, it only checks the serving line).
    fw_env = dict(os.environ)
    fw_env["MORROW_FORWARDER_LAUNCHER_PID"] = str(os.getpid())
    r = subprocess.Popen(
        [sys.executable, fw, "18098"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, start_new_session=True, env=fw_env)
    try:
        line = r.stdout.readline()
        deadline = time.time() + 15
        serving = "forwarder on 127.0.0.1:18098" in line
        while not serving and time.time() < deadline:
            line = r.stdout.readline()
            serving = "forwarder on 127.0.0.1:18098" in line
        check("forwarder serves with auth proxy", serving, line[:200])
        check("forwarder startup line redacted",
              "@" not in line and FAKE_USER not in line, line[:200])
    finally:
        r.terminate()
        r.wait(timeout=10)

    # (c) W4-P2-9: without MORROW_FORWARDER_LAUNCHER_PID the forwarder
    # fails closed instead of serving an open relay.
    env_nc = {k: v for k, v in os.environ.items()
              if k != "MORROW_FORWARDER_LAUNCHER_PID"}
    env_nc["https_proxy"] = FAKE_PROXY_AUTH
    env_nc["HTTPS_PROXY"] = FAKE_PROXY_AUTH
    r = subprocess.run([sys.executable, fw, "18097"],
                       capture_output=True, text=True, timeout=30,
                       env=env_nc)
    out_nc = (r.stdout or "") + (r.stderr or "")
    check("forwarder without launcher PID fails closed",
          r.returncode != 0
          and "MORROW_FORWARDER_LAUNCHER_PID" in out_nc, out_nc[:200])

    # (W5-P2-4) plaintext proxy-auth warning: proxy_auth + http://
    # upstream to a non-loopback host must warn LOUDLY on stderr (the
    # credential crosses the network unencrypted); https:// upstream
    # must stay silent. The warning names no credential.
    def run_forwarder_with_stderr(probe):
        import io
        import types
        fake = types.ModuleType("egress")
        fake.probe_egress = lambda: probe
        # W6-P2-6: the forwarder reads the pin env var name and the pin
        # parser off the egress module at startup; the fake must carry
        # them too (values delegate to the real module).
        fake.PROXY_PIN_ENV_VAR = egress.PROXY_PIN_ENV_VAR
        fake.parse_cert_pins = egress.parse_cert_pins
        saved = sys.modules.get("egress")
        sys.modules["egress"] = fake
        saved_argv = sys.argv[:]
        saved_pid = os.environ.get("MORROW_FORWARDER_LAUNCHER_PID")
        os.environ["MORROW_FORWARDER_LAUNCHER_PID"] = str(os.getpid())
        sys.argv = [fw, "18998"]
        out_buf, err_buf = io.StringIO(), io.StringIO()
        code = None
        try:
            with contextlib.redirect_stdout(out_buf), \
                    contextlib.redirect_stderr(err_buf):
                exec(compile(open(fw).read(), fw, "exec"),
                     {"__name__": "fw_selftest_warn", "__file__": fw})
        except SystemExit as e:
            code = e.code
        finally:
            sys.argv = saved_argv
            if saved_pid is None:
                os.environ.pop("MORROW_FORWARDER_LAUNCHER_PID", None)
            else:
                os.environ["MORROW_FORWARDER_LAUNCHER_PID"] = saved_pid
            if saved is not None:
                sys.modules["egress"] = saved
            else:
                sys.modules.pop("egress", None)
        return code, out_buf.getvalue(), err_buf.getvalue()

    W5_USER, W5_PASS = "w5selftestuser", "w5selftestpass"
    auth_http_probe = {"mode": "proxy_auth",
                       "proxy": "http://proxy.example:3128",
                       "needs_forwarder": True,
                       "upstream": "http://%s:%s@proxy.example:3128"
                                   % (W5_USER, W5_PASS),
                       "detail": ""}
    code, out, err = run_forwarder_with_stderr(auth_http_probe)
    check("forwarder warns loudly on plaintext proxy auth",
          code is None and "WARNING" in err
          and "Proxy-Authorization" in err and "PLAINTEXT" in err,
          err[:200])
    check("plaintext warning leaks no credential",
          W5_USER not in err and W5_PASS not in err and "@" not in err,
          err[:200])
    auth_https_probe = {"mode": "proxy_auth",
                        "proxy": "https://proxy.example:3128",
                        "needs_forwarder": True,
                        "upstream": "https://%s:%s@proxy.example:3128"
                                    % (W5_USER, W5_PASS),
                        "detail": ""}
    code, out, err = run_forwarder_with_stderr(auth_https_probe)
    check("forwarder silent on https proxy auth",
          code is None and "WARNING" not in err, err[:200])

    # (d) W4-P2-9: client authentication. The spawner itself is NOT a
    # strict descendant of its own PID, so a direct CONNECT from this
    # process must get 403. A child process (strict descendant) passes
    # auth; with a dummy upstream that accepts and immediately closes,
    # the child then gets 502 (auth passed, upstream refused).
    import socket as _socket
    dummy = _socket.socket()
    dummy.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
    dummy.bind(("127.0.0.1", 18095))
    dummy.listen(5)
    dummy.settimeout(10)

    def _dummy_accept_close():
        # A real proxy reads the CONNECT request before replying. The
        # dummy must drain it too: closing with the request still
        # unread in the receive buffer makes the kernel RST the
        # forwarder, which fail-closes the client (flaky b'').
        try:
            c, _ = dummy.accept()
            c.settimeout(10)
            buf = b""
            try:
                while b"\r\n\r\n" not in buf and len(buf) < 65536:
                    chunk = c.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
            except Exception:
                pass
            c.close()
        except Exception:
            pass
    fw_env2 = dict(os.environ)
    # W4-P2-19: use format-string credentials (not a literal user:pass@ URL)
    # so the packaging secrets gate does not flag this selftest.
    fw_env2["https_proxy"] = "http://%s:%s@127.0.0.1:18095" % (FAKE_USER, FAKE_PASS)
    fw_env2["HTTPS_PROXY"] = "http://%s:%s@127.0.0.1:18095" % (FAKE_USER, FAKE_PASS)
    fw_env2["MORROW_FORWARDER_LAUNCHER_PID"] = str(os.getpid())
    r = subprocess.Popen(
        [sys.executable, fw, "18096"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, start_new_session=True, env=fw_env2)
    try:
        line = ""
        deadline = time.time() + 15
        while "forwarder on 127.0.0.1:18096" not in line:
            line = r.stdout.readline()
            if not line or time.time() > deadline:
                raise SystemExit("selftest failed at: forwarder serve (d)")
        # Direct CONNECT from this (non-descendant) process -> 403.
        s = _socket.create_connection(("127.0.0.1", 18096), timeout=10)
        try:
            s.sendall(b"CONNECT example.com:443 HTTP/1.1\r\n"
                      b"Host: example.com:443\r\n\r\n")
            resp = s.recv(32)
        finally:
            s.close()
        check("forwarder refuses non-descendant client with 403",
              resp.startswith(b"HTTP/1.1 403"), resp[:32])
        # CONNECT from a child (strict descendant) -> auth passes;
        # dummy upstream closes -> 502 from the forwarder.
        import threading as _threading
        t = _threading.Thread(target=_dummy_accept_close, daemon=True)
        t.start()
        child_code = (
            "import socket,sys;"
            "s=socket.create_connection(('127.0.0.1',18096),timeout=10);"
            "s.sendall(b'CONNECT example.com:443 HTTP/1.1\\r\\n"
            "Host: example.com:443\\r\\n\\r\\n');"
            "d=s.recv(32);"
            "sys.stdout.write(d.decode('latin1'))")
        cr = subprocess.run([sys.executable, "-c", child_code],
                            capture_output=True, text=True, timeout=20)
        t.join(timeout=10)
        check("forwarder serves descendant client (502 past auth)",
              cr.stdout.startswith("HTTP/1.1 502"), cr.stdout[:32])
    finally:
        r.terminate()
        r.wait(timeout=10)
        dummy.close()

    # (e) W4-P1-3: an https:// upstream proxy gets a real TLS handshake
    # before CONNECT/Proxy-Authorization bytes are written. Fake TLS
    # proxy with a throwaway self-signed cert (SAN IP:127.0.0.1);
    # the forwarder trusts it via SSL_CERT_FILE. The fake records
    # whether the first bytes were a TLS ClientHello (0x16 0x03) and
    # whether Proxy-Authorization arrived inside the tunnel.
    import ssl as _ssl
    tls_cert = os.path.join(WORK, "tls-proxy.pem")
    tls_key = os.path.join(WORK, "tls-proxy.key")
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048",
         "-keyout", tls_key, "-out", tls_cert, "-days", "2", "-nodes",
         "-subj", "/CN=127.0.0.1",
         "-addext", "subjectAltName=IP:127.0.0.1"],
        check=True, capture_output=True)
    tls_seen = {}

    def _fake_tls_proxy():
        ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(tls_cert, tls_key)
        ls = _socket.socket()
        ls.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
        ls.bind(("127.0.0.1", 18094))
        ls.listen(1)
        ls.settimeout(20)
        try:
            raw, _ = ls.accept()
        except Exception:
            tls_seen["error"] = "no accept"
            ls.close()
            return
        try:
            first = raw.recv(5, _socket.MSG_PEEK)
            tls_seen["client_hello"] = first[:2] == b"\x16\x03"
            if not tls_seen["client_hello"]:
                tls_seen["plaintext_prefix"] = first
                raw.close()
                return
            conn = ctx.wrap_socket(raw, server_side=True)
            conn.settimeout(10)
            buf = b""
            while b"\r\n\r\n" not in buf and len(buf) < 65536:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
            head = buf.split(b"\r\n\r\n", 1)[0].decode("latin1")
            tls_seen["connect_seen"] = head.startswith("CONNECT ")
            tls_seen["auth_inside_tls"] = (
                "Proxy-Authorization: Basic " in head)
            conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            conn.close()
        except Exception as exc:
            tls_seen["error"] = "%s: %s" % (type(exc).__name__, exc)
        finally:
            ls.close()
    pt = _threading.Thread(target=_fake_tls_proxy, daemon=True)
    pt.start()
    fw_env3 = dict(os.environ)
    fw_env3["https_proxy"] = (
        "https://%s:%s@127.0.0.1:18094" % (FAKE_USER, FAKE_PASS))
    fw_env3["HTTPS_PROXY"] = fw_env3["https_proxy"]
    fw_env3["SSL_CERT_FILE"] = tls_cert
    fw_env3["MORROW_FORWARDER_LAUNCHER_PID"] = str(os.getpid())
    r = subprocess.Popen(
        [sys.executable, fw, "18093"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, start_new_session=True, env=fw_env3)
    try:
        line = ""
        boot_lines = ""
        deadline = time.time() + 15
        while "forwarder on 127.0.0.1:18093" not in line:
            line = r.stdout.readline()
            boot_lines += line
            if not line or time.time() > deadline:
                raise SystemExit("selftest failed at: forwarder serve (e)")
        check("forwarder https upstream logs tls: yes",
              "tls: yes" in boot_lines, boot_lines[:200])
        child_code = (
            "import socket,sys;"
            "s=socket.create_connection(('127.0.0.1',18093),timeout=15);"
            "s.sendall(b'CONNECT example.com:443 HTTP/1.1\\r\\n"
            "Host: example.com:443\\r\\n\\r\\n');"
            "d=s.recv(64);"
            "sys.stdout.write(d.decode('latin1'))")
        cr = subprocess.run([sys.executable, "-c", child_code],
                            capture_output=True, text=True, timeout=30)
        check("forwarder relays through https upstream (200)",
              cr.stdout.startswith("HTTP/1.1 200"), cr.stdout[:64])
    finally:
        r.terminate()
        r.wait(timeout=10)
    pt.join(timeout=25)
    check("https upstream saw a TLS ClientHello (not plaintext)",
          tls_seen.get("client_hello") is True, str(tls_seen)[:200])
    check("https upstream saw CONNECT inside the tunnel",
          tls_seen.get("connect_seen") is True, str(tls_seen)[:200])
    check("Proxy-Authorization arrived inside TLS, never plaintext",
          tls_seen.get("auth_inside_tls") is True, str(tls_seen)[:200])

    # (f) W5-P2-3: connection shedding, header caps/timeouts, /proc snapshot.
    # Load the forwarder module in-process with a stubbed egress probe
    # (proxy_auth mode: module-level startup runs, no exit, no network).
    import asyncio as _asyncio
    import io as _io
    import types as _types

    def _load_forwarder():
        fw = os.path.join(_HERE, "proxy_forwarder.py")
        fake = _types.ModuleType("egress")
        fake.probe_egress = lambda: {
            "mode": "proxy_auth",
            "proxy": "http://proxy.example:3128",
            "needs_forwarder": True,
            "upstream": "http://proxy.example:3128",
            "detail": ""}
        # W6-P2-6: the forwarder reads the pin env var name and the pin
        # parser off the egress module at startup; the fake must carry
        # them too (values delegate to the real module).
        fake.PROXY_PIN_ENV_VAR = egress.PROXY_PIN_ENV_VAR
        fake.parse_cert_pins = egress.parse_cert_pins
        saved = sys.modules.get("egress")
        sys.modules["egress"] = fake
        saved_argv = sys.argv[:]
        saved_pid = os.environ.get("MORROW_FORWARDER_LAUNCHER_PID")
        os.environ["MORROW_FORWARDER_LAUNCHER_PID"] = str(os.getpid())
        mod = _types.ModuleType("fw_w5p23")
        mod.__dict__["__file__"] = fw
        try:
            with contextlib.redirect_stdout(_io.StringIO()):
                exec(compile(open(fw).read(), fw, "exec"),
                     mod.__dict__)
        finally:
            sys.argv = saved_argv
            if saved_pid is None:
                os.environ.pop("MORROW_FORWARDER_LAUNCHER_PID", None)
            else:
                os.environ["MORROW_FORWARDER_LAUNCHER_PID"] = saved_pid
            if saved is not None:
                sys.modules["egress"] = saved
            else:
                sys.modules.pop("egress", None)
        return mod

    fwmod = _load_forwarder()

    # f1. _read_headers: normal headers pass through.
    class _FakeReader:
        def __init__(self, chunks, delay=0):
            self._chunks = list(chunks)
            self._delay = delay

        async def read(self, n):
            if self._delay:
                await _asyncio.sleep(self._delay)
            if not self._chunks:
                return b""
            return self._chunks.pop(0)

    async def _t_headers_normal():
        r = _FakeReader([b"CONNECT x:443 HTTP/1.1\r\n",
                         b"Host: x\r\n\r\n"])
        return await fwmod._read_headers(r)

    got = _asyncio.run(_t_headers_normal())
    check("W5-P2-3: _read_headers returns normal headers",
          got == b"CONNECT x:443 HTTP/1.1\r\nHost: x\r\n\r\n", repr(got))

    # f2. _read_headers: over 64KB of headers -> None (bounded).
    async def _t_headers_overcap():
        r = _FakeReader([b"X: " + b"y" * 70000 + b"\r\n\r\n"])
        return await fwmod._read_headers(r)

    got = _asyncio.run(_t_headers_overcap())
    check("W5-P2-3: _read_headers caps at 64KB (over-cap -> None)",
          got is None, repr((got or b"")[:32]))

    # f3. _read_headers: stalled peer -> None within the timeout
    # (patched to 0.2s so the test stays fast).
    async def _t_headers_stall():
        r = _FakeReader([], delay=5)
        return await fwmod._read_headers(r)

    saved_timeout = fwmod.HEADER_READ_TIMEOUT_S
    fwmod.HEADER_READ_TIMEOUT_S = 0.2
    try:
        t0 = time.monotonic()
        got = _asyncio.run(_t_headers_stall())
        dt = time.monotonic() - t0
    finally:
        fwmod.HEADER_READ_TIMEOUT_S = saved_timeout
    check("W5-P2-3: _read_headers times out on stalled peer",
          got is None and dt < 5, "got=%r dt=%.1f" % (got, dt))

    # f4. PID hints: after one verified lookup, the pid becomes a hint,
    # so a second connection from the same process is found without a
    # full /proc scan.
    import socket as _sock3
    srv = _sock3.socket()
    srv.setsockopt(_sock3.SOL_SOCKET, _sock3.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    srv_port = srv.getsockname()[1]
    holder = subprocess.Popen(
        [sys.executable, "-c",
         "import socket,time;"
         "a=socket.create_connection(('127.0.0.1',%d));"
         "b=socket.create_connection(('127.0.0.1',%d));"
         "time.sleep(10)" % (srv_port, srv_port)],
        start_new_session=True)
    try:
        srv.settimeout(10)
        c1, _ = srv.accept()
        c2, _ = srv.accept()
        fwmod._PID_HINTS.clear()

        def _inode_of(sock):
            tgt = os.readlink("/proc/self/fd/%d" % sock.fileno())
            assert tgt.startswith("socket:["), tgt
            return int(tgt[8:-1])

        # Server-side inodes differ from the holder's; find the
        # holder's inodes via the snapshot instead.
        snap = fwmod._proc_socket_snapshot()
        holder_inodes = [ino for ino, (p, _st) in snap.items()
                         if p == holder.pid]
        assert len(holder_inodes) >= 2, \
            "expected 2 holder sockets, got %d" % len(holder_inodes)

        # First lookup: hint miss -> snapshot scan -> pid remembered.
        scans_before = len(fwmod._PID_HINTS)
        p1 = fwmod._socket_holder_pid_verified(holder_inodes[0])
        check("W5-P2-3: verified lookup finds the holder pid",
              p1 == holder.pid, repr(p1))
        check("W5-P2-3: holder pid becomes a hint",
              len(fwmod._PID_HINTS) == scans_before + 1)

        # Second lookup (different inode, same pid): served from the
        # hint. Prove no full scan by breaking the snapshot builder.
        orig_snap = fwmod._proc_socket_snapshot
        fwmod._proc_socket_snapshot = lambda: (_ for _ in ()).throw(
            AssertionError("full scan on hint hit"))
        try:
            p2 = fwmod._socket_holder_pid_verified(holder_inodes[1])
        finally:
            fwmod._proc_socket_snapshot = orig_snap
        check("W5-P2-3: second connection served from pid hint (no scan)",
              p2 == holder.pid, repr(p2))
    finally:
        holder.terminate()
        holder.wait(timeout=10)
        srv.close()

    # f5. _socket_holder_pid_verified: this process's own sockets are
    # never attributed (the snapshot excludes self: fail closed).
    import socket as _sock2
    a, b = _sock2.socketpair()
    try:
        inode = None
        for fd in (a.fileno(), b.fileno()):
            try:
                tgt = os.readlink("/proc/self/fd/%d" % fd)
            except OSError:
                continue
            if tgt.startswith("socket:["):
                inode = int(tgt[8:-1])
                break
        assert inode is not None, "no socket inode found"
        found = fwmod._socket_holder_pid_verified(inode)
        check("W5-P2-3: verified lookup excludes own process (fail closed)",
              found is None, repr(found))
    finally:
        a.close()
        b.close()

    # f6. Connection shedding: a full semaphore gets an immediate 503
    # and never reaches the inner handler.
    class _FakeWriter:
        def __init__(self):
            self.data = b""
            self.closed = False

        def write(self, d):
            self.data += d

        async def drain(self):
            pass

        def close(self):
            self.closed = True

        def get_extra_info(self, name):
            return None

    async def _t_shed():
        fwmod._CONN_SEM = _asyncio.Semaphore(1)
        await fwmod._CONN_SEM.acquire()  # fill the single slot
        w = _FakeWriter()
        inner_called = []
        orig_inner = fwmod._handle_inner

        async def _spy_inner(r, ww):
            inner_called.append(True)

        fwmod._handle_inner = _spy_inner
        try:
            await fwmod.handle(_FakeReader([]), w)
        finally:
            fwmod._handle_inner = orig_inner
            fwmod._CONN_SEM.release()
        return w, inner_called

    w, inner_called = _asyncio.run(_t_shed())
    check("W5-P2-3: over-capacity connection gets immediate 503",
          w.data.startswith(b"HTTP/1.1 503") and w.closed,
          repr(w.data[:32]))
    check("W5-P2-3: over-capacity never reaches the inner handler",
          inner_called == [])

    # f7. Admitted connection reaches the inner handler and releases
    # the slot.
    async def _t_admit():
        fwmod._CONN_SEM = _asyncio.Semaphore(1)
        w = _FakeWriter()
        inner_called = []

        async def _spy_inner(r, ww):
            inner_called.append(True)

        orig_inner = fwmod._handle_inner
        fwmod._handle_inner = _spy_inner
        try:
            await fwmod.handle(_FakeReader([]), w)
        finally:
            fwmod._handle_inner = orig_inner
        return inner_called, fwmod._CONN_SEM.locked()

    inner_called, still_locked = _asyncio.run(_t_admit())
    check("W5-P2-3: admitted connection reaches inner handler",
          inner_called == [True])
    check("W5-P2-3: slot released after handling",
          not still_locked)

    # ---- W6-P2-6: certificate pinning ----------------------------------
    # Pins are SHA-256 leaf-certificate hashes ("sha256/<base64>").
    import base64 as _b64
    import hashlib as _hl
    _der = b"fake-cert-der-bytes-for-pin-test"
    _digest = _hl.sha256(_der).digest()
    _pin_b64 = _b64.b64encode(_digest).decode("ascii").rstrip("=")
    # Parse accepts sha256/<base64> and bare base64.
    _pins = egress.parse_cert_pins("sha256/" + _pin_b64)
    check("W6-P2-6: parse_cert_pins accepts sha256/<base64>",
          _pins == [_digest])
    _pins2 = egress.parse_cert_pins(_pin_b64)
    check("W6-P2-6: parse_cert_pins accepts bare base64",
          _pins2 == [_digest])
    _pins3 = egress.parse_cert_pins("sha256/%s, sha256/%s" % (
        _pin_b64, _b64.b64encode(b"\x01" * 32).decode("ascii")))
    check("W6-P2-6: parse_cert_pins handles comma-separated lists",
          len(_pins3) == 2)
    # Malformed pins fail closed (ValueError, never a misparsed pin).
    for _bad in ("sha512/" + _pin_b64, "not-base64!!!",
                 _b64.b64encode(b"short").decode("ascii"), ""):
        try:
            _r = egress.parse_cert_pins(_bad)
            _bad_ok = (_bad == "" and _r == [])
        except ValueError:
            _bad_ok = True
        check("W6-P2-6: malformed pin fails closed (%r)" % (_bad[:20],),
              _bad_ok)
    # check_cert_pin: match passes, mismatch raises, no pins = no check.
    egress.check_cert_pin(_der, [_digest], "test")
    check("W6-P2-6: matching pin passes", True)
    try:
        egress.check_cert_pin(_der, [b"\x02" * 32], "test")
        _mm_ok = False
    except egress.CertPinMismatch:
        _mm_ok = True
    check("W6-P2-6: mismatched pin raises CertPinMismatch", _mm_ok)
    egress.check_cert_pin(_der, [], "test")
    check("W6-P2-6: no pins configured means no check", True)
    try:
        egress.check_cert_pin(b"", [_digest], "test")
        _nc_ok = False
    except egress.CertPinMismatch:
        _nc_ok = True
    check("W6-P2-6: missing peer cert fails closed", _nc_ok)

    # Self-clean: throwaway CA material is deny-list-matching residue
    # (*.key/*.pem) and must not linger in the tree.
    for _f in ("throwaway-ca.pem", "throwaway-ca.key",
               "tls-proxy.pem", "tls-proxy.key"):
        try:
            os.unlink(os.path.join(WORK, _f))
        except FileNotFoundError:
            pass

    print("\nAll %d checks passed." % len(passed))


if __name__ == "__main__":
    main()
