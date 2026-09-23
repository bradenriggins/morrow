#!/usr/bin/env python3
"""Selftest for the ephemeral localhost form-host server
(transport/form_host_server.py).

Covers: on-demand start, loopback-only serving of the bundled page,
404 on any other path, the CSP header, idempotent ensure_server, and
clean stop. The server under test is the real daemon; it is stopped at
the end.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import os
import sys
import json
import subprocess
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from transport import form_host_server as fhs  # noqa: E402

# The daemon's identity check reads /proc/<pid>/cmdline, so without /proc
# stop_server() can never stop the daemons this suite starts. Refuse
# before starting any.
if not os.path.isdir("/proc"):
    print("FAIL: form_host_server selftest needs Linux (/proc); nothing "
          "was started")
    sys.exit(1)

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


def _open(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(urllib.request.Request(url, method="GET"), timeout=5)


try:
    fhs.stop_server()  # start from a clean slate

    url = fhs.ensure_server()
    check("ensure_server returns loopback URL",
          url.startswith("http://127.0.0.1:"))
    port = int(url.rsplit(":", 1)[1])

    # W5-P2-4: a stalled connection (client connects, sends a partial
    # request, then goes silent) must not block a second request. The
    # threaded server handles the stall on its own worker; the socket
    # timeout bounds how long that worker is held.
    import socket as _socket
    import threading as _threading
    import time as _time
    stall = _socket.create_connection(("127.0.0.1", port), timeout=5)
    try:
        stall.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n")  # partial, then stall
        t0 = _time.monotonic()
        with _open(url + "/") as resp:
            body = resp.read()
        dt = _time.monotonic() - t0
        check("W5-P2-4: stalled connection does not block a second request",
              b"Morrow API form helper" in body and dt < 10,
              "took %.1fs" % dt)
        check("W5-P2-4: worker threads are daemon (no wedged shutdown)",
              fhs._ThreadingHTTPServer.daemon_threads is True)
    finally:
        stall.close()

    with _open(url + "/") as resp:
        body = resp.read()
        csp = resp.headers.get("Content-Security-Policy", "")
        ctype = resp.headers.get("Content-Type", "")
    check("GET / returns 200 with the bundled page",
          b"Morrow API form helper" in body)
    check("page is HTML", ctype.startswith("text/html"))
    check("CSP confines form posts to https",
          "form-action https:" in csp and "frame-ancestors 'none'" in csp)
    check("served bytes match the bundle",
          body == fhs.page_bytes())

    with _open(url + "/index.html") as resp2:
        check("GET /index.html also serves the page",
              resp2.status == 200)

    try:
        _open(url + "/nope")
        check("unknown path 404s", False)
    except urllib.error.HTTPError as exc:
        check("unknown path 404s", exc.code == 404)

    url2 = fhs.ensure_server()
    check("ensure_server is idempotent", url2 == url)

    # LANE2-D6: concurrent ensure_server() calls serialize on the spawn
    # lock: exactly one daemon is spawned and every caller gets the
    # same URL (no orphaned loser daemon, no torn state file).
    import threading as _threading2
    fhs.stop_server()
    _urls = []
    _barrier = _threading2.Barrier(6)

    def _ensurer():
        _barrier.wait()
        _urls.append(fhs.ensure_server())

    _workers = [_threading2.Thread(target=_ensurer) for _ in range(6)]
    for _w in _workers:
        _w.start()
    for _w in _workers:
        _w.join(timeout=60)
    check("concurrent ensure_server returns one URL",
          len(_urls) == 6 and len(set(_urls)) == 1, str(sorted(set(_urls))))

    def _daemon_pids():
        found = []
        for _pid in os.listdir("/proc"):
            if not _pid.isdigit() or int(_pid) == os.getpid():
                continue
            try:
                with open("/proc/%s/cmdline" % _pid, "rb") as _fh:
                    _toks = _fh.read().replace(b"\0", b" ").decode(
                        "utf-8", "replace").split()
            except OSError:
                continue
            if "serve" in _toks and any("form_host_server" in _t
                                       and "selftest" not in _t
                                       for _t in _toks):
                found.append(int(_pid))
        return sorted(found)

    _cstate = fhs._read_state()
    _cdpids = _daemon_pids()
    check("concurrent ensure_server spawns exactly one daemon",
          _cstate is not None
          and _cdpids == [int(_cstate["pid"])],
          "state=%s daemons=%s" % (_cstate, _cdpids))
    url = _urls[0]
    port = int(url.rsplit(":", 1)[1])

    # W5-P2-1: Host-header validation (DNS-rebinding defense in depth).
    # A foreign Host must be refused before the page is served; the
    # loopback literals keep working.
    import socket as _socket
    import urllib.error as _urlerror

    def _raw_request(host, method="GET", skip_host=False):
        s = _socket.create_connection(("127.0.0.1", port), timeout=5)
        req = "%s / HTTP/1.1\r\n" % method
        if not skip_host:
            req += "Host: %s\r\n" % host
        req += "Connection: close\r\n\r\n"
        s.sendall(req.encode("latin1"))
        resp = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            resp += chunk
        s.close()
        # BaseHTTPRequestHandler answers "HTTP/1.0 <code> ..."; parse the
        # numeric status, not the version token.
        status_line = resp.partition(b"\r\n\r\n")[0].split(b"\r\n", 1)[0]
        parts = status_line.decode("latin1").split(" ")
        return parts[1] if len(parts) > 1 else ""

    check("foreign Host refused with 403",
          _raw_request("evil-rebind.example") == "403")
    check("missing Host refused with 403",
          _raw_request("", skip_host=True) == "403")
    check("Host localhost still served",
          _raw_request("localhost:%d" % port) == "200")
    check("Host [::1] still served",
          _raw_request("[::1]:%d" % port) == "200")
    check("foreign Host HEAD refused with 403",
          _raw_request("evil-rebind.example", method="HEAD") == "403")

    # Loopback-only bind, evidenced from the kernel's socket table
    # (/proc/net/tcp): every LISTEN entry for our port must sit on
    # 127.0.0.1. (A connect() probe is invalid in this sandbox: outbound
    # TCP is transparently proxied, so even refused ports "accept".)
    bound_addrs = set()
    try:
        with open("/proc/net/tcp", "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()[1:]
        for ln in lines:
            parts = ln.split()
            if len(parts) < 4 or parts[3] != "0A":  # LISTEN
                continue
            ip_hex, port_hex = parts[1].split(":")
            if int(port_hex, 16) == port:
                raw = bytes.fromhex(ip_hex)
                bound_addrs.add(".".join(str(b) for b in reversed(raw)))
    except OSError:
        pass
    check("server bound to 127.0.0.1 only (kernel socket table: %s)"
          % sorted(bound_addrs),
          bool(bound_addrs) and bound_addrs == {"127.0.0.1"})

    check("status reports running",
          os.path.exists(fhs.STATE_PATH))

    # LANE2-D16: stop_server() must never SIGTERM a recycled pid. Plant
    # a stale state file pointing at this very test process (alive, but
    # not the form-host daemon) and stop: the process must survive, the
    # state file must go, and the real daemon must keep serving.
    real_state = fhs._read_state()
    try:
        with open(fhs.STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump({"pid": os.getpid(), "port": 1,
                       "started_at": "2000-01-01T00:00:00Z"}, fh)
        check("stop_server reports nothing stopped for a foreign pid",
              fhs.stop_server() is False)
        check("stop_server does not kill the foreign pid (self alive)",
              fhs._pid_alive(os.getpid()))
        check("stop_server still removes the stale state file",
              not os.path.exists(fhs.STATE_PATH))
    finally:
        fhs._write_state(real_state["pid"], real_state["port"])
    check("real daemon still serving after foreign-pid stop",
          fhs._probe(int(real_state["port"])))

    # LANE2-D16b: the tree binding. A live process whose cmdline
    # carries the form-host markers but whose cwd is a different tree
    # is not ours: the cmdline-only check accepts it (this is what D16b
    # closes), the repo-bound check refuses it, and stop_server() with
    # a state file naming this tree's repo must not signal it.
    state_dir = os.path.dirname(fhs.STATE_PATH)
    # Note: the script filename itself must carry the form-host marker:
    # the kernel's shebang rewriting replaces the exec -a argv[0] with
    # the script path, so the marker has to survive in argv[1].
    spoof_sh = os.path.join(state_dir, "form_host_server_sibling.sh")
    with open(spoof_sh, "w", encoding="utf-8") as fh:
        fh.write("#!/bin/bash\nsleep 60\n")
    os.chmod(spoof_sh, 0o755)
    spoof = subprocess.Popen(
        ["bash", "-c",
         "exec -a 'x transport.form_host_server' \"$0\" serve",
         spoof_sh],
        cwd=state_dir,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 10
        while (time.monotonic() < deadline
               and not fhs._pid_is_form_host(spoof.pid)):
            time.sleep(0.1)
        check("sibling-tree spoof passes the cmdline-only check "
              "(what D16b closes)",
              fhs._pid_is_form_host(spoof.pid) is True)
        check("sibling-tree spoof fails the repo-bound check",
              fhs._pid_is_form_host(spoof.pid, fhs.REPO) is False)
        check("real daemon passes the repo-bound check",
              fhs._pid_is_form_host(int(real_state["pid"]),
                                    fhs.REPO) is True)
        try:
            with open(fhs.STATE_PATH, "w", encoding="utf-8") as fh:
                json.dump({"pid": spoof.pid, "port": 1,
                           "repo": fhs.REPO,
                           "started_at": "2000-01-01T00:00:00Z"}, fh)
            check("stop_server reports nothing stopped for a "
                  "sibling-tree pid",
                  fhs.stop_server() is False)
            check("stop_server does not kill the sibling-tree pid",
                  fhs._pid_alive(spoof.pid))
        finally:
            fhs._write_state(real_state["pid"], real_state["port"])
    finally:
        spoof.terminate()
        try:
            spoof.wait(timeout=5)
        except subprocess.TimeoutExpired:
            spoof.kill()
        try:
            os.remove(spoof_sh)
        except OSError:
            pass
    check("real daemon still serving after sibling-tree stop",
          fhs._probe(int(real_state["port"])))

    # LANE2-D16: a spawned daemon that never becomes ready must be
    # terminated on the terminal path, not leaked. Simulate with a
    # fake spawn whose "daemon" just sleeps.
    class _NeverReady(object):
        def __init__(self):
            self.terminated = False
            self.killed = False
            self._proc = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(30)"])

        def poll(self):
            return self._proc.poll()

        def terminate(self):
            self.terminated = True
            self._proc.terminate()

        def kill(self):
            self.killed = True
            self._proc.kill()

        def wait(self, timeout=None):
            return self._proc.wait(timeout=timeout)

    spawned = []
    real_spawn = fhs._spawn_daemon
    real_read_state = fhs._read_state

    def _fake_spawn():
        proc = _NeverReady()
        spawned.append(proc)
        return proc

    fhs._spawn_daemon = _fake_spawn
    fhs._read_state = lambda: None  # never becomes ready
    try:
        try:
            fhs._ensure_server_locked()
            check("unready daemon raises RuntimeError", False)
        except RuntimeError:
            check("unready daemon raises RuntimeError", True)
    finally:
        fhs._spawn_daemon = real_spawn
        fhs._read_state = real_read_state
        # _ensure_server_locked removed the state file before spawning;
        # restore the real daemon's state.
        fhs._write_state(real_state["pid"], real_state["port"])
    check("unready daemon's process was terminated",
          bool(spawned) and spawned[0].terminated
          and spawned[0].poll() is not None)
    check("real daemon still serving after unready-spawn failure",
          fhs._probe(int(real_state["port"])))
finally:
    stopped = fhs.stop_server()

check("stop halts the daemon", stopped and not os.path.exists(fhs.STATE_PATH))
check("stopped server refuses connections",
      not fhs._probe(port) if "port" in dir() else True)

print("pass: %d" % len(PASS))
for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("all form_host_server selftests passed")
