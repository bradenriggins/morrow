#!/usr/bin/env python3
"""Ephemeral localhost server for the bundled form-host page.

The managed browser environment cannot load file:// URLs (navigating to
one crashes the browser automation process), so the form-host page that
ships inside the connector bundle (transport/form-host/index.html) is
served over loopback HTTP instead. This module owns that server:

  - binds 127.0.0.1 only, on an ephemeral port,
  - serves ONLY the bundled index.html (GET / and /index.html; 404 else),
  - sends a tight Content-Security-Policy with the page,
  - runs as a detached daemon tracked by a state file, so it outlives
    the dispatch call and is still up when the async browser task runs.

Lifecycle: the browser backend starts the server lazily on dispatch
(ensure_server) and stops it (stop_server) when a run reaches a
terminal complete state -- receipt journaled, or a failure mode where
any retry re-dispatches with a fresh brief. The server is left running
across the session-dead / retryable / awaiting-verify paths, because
those re-run a browser task against the saved brief, which carries the
server's current port. Product runs are sequential.

Nothing is hosted anywhere: the page bytes come from the connector
bundle, the listener is loopback-only, and the form spec still travels
in the URL fragment, which never leaves the browser.

Usage:
    python3 -m transport.form_host_server serve    # foreground (used by ensure_server)
    python3 -m transport.form_host_server start    # detached daemon
    python3 -m transport.form_host_server stop
    python3 -m transport.form_host_server status
    python3 -m transport.form_host_server url      # print the base URL

Product code should use ensure_server(), which starts the daemon on
demand and returns its base URL (e.g. http://127.0.0.1:54321).
"""
from __future__ import annotations

import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO not in sys.path:
    sys.path.insert(0, REPO)
from config.paths import morrow_home  # noqa: E402
PAGE_PATH = os.path.join(REPO, "transport", "form-host", "index.html")
# W4-P1-17: single source of truth for the morrow state root.
STATE_DIR = os.path.join(morrow_home(), "form-host")
STATE_PATH = os.path.join(STATE_DIR, "server.json")
MARKER = b"Morrow API form helper"

# Tight CSP for the served page: it needs inline script/style, posts
# forms to https tenants only, and must not be framed.
CSP = ("default-src 'none'; script-src 'unsafe-inline'; "
       "style-src 'unsafe-inline'; form-action https:; "
       "frame-ancestors 'none'; base-uri 'none'")


def page_bytes() -> bytes:
    with open(PAGE_PATH, "rb") as f:
        return f.read()


class _Handler(BaseHTTPRequestHandler):
    server_version = "MorrowFormHost/1.0"

    # W5-P2-1: DNS-rebinding defense in depth. The form-host page is
    # loopback-only; a rebound attacker page must not be able to read it
    # same-origin. Reject any Host that is not a loopback literal, before
    # serving anything. (The page carries no token and the spec travels
    # in the fragment, so this is defense in depth, not a live leak.)
    def _host_ok(self):
        raw = self.headers.get("Host") or ""
        host = raw.strip()
        if not host:
            return False  # HTTP/1.1 requires Host; missing fails closed
        if host.startswith("["):
            # bracketed IPv6 literal: [::1]:54321
            host = host[1:].split("]", 1)[0]
        else:
            host = host.split(":", 1)[0]
        return host.strip().lower() in ("127.0.0.1", "localhost", "::1")

    def _serve_page(self):
        try:
            body = page_bytes()
        except OSError:
            self.send_error(500, "bundled page missing")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command == "GET":
            self.wfile.write(body)

    def do_GET(self):
        if not self._host_ok():
            self.send_error(403, "forbidden: unrecognized Host header")
            return
        if self.path.split("?", 1)[0] in ("/", "/index.html"):
            self._serve_page()
        else:
            self.send_error(404, "not found")

    do_HEAD = do_GET

    def log_message(self, fmt, *args):  # keep the daemon quiet
        pass


def _write_state(pid: int, port: int) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    # LANE2-D6: pid-unique staging path. The old fixed ".tmp" was shared
    # by two racing daemons (two ensure_server() calls spawning at once):
    # one process's open("w") truncated the other's in-progress bytes and
    # readers could see torn JSON. os.replace keeps the swap atomic; pid
    # uniqueness keeps the staging private (one _write_state per process).
    tmp = "%s.tmp.%d" % (STATE_PATH, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"pid": pid, "port": port,
                   # LANE2-D16b: bind the daemon to this tree. The
                   # cmdline markers alone also match another checkout's
                   # same module; stop_server() verifies /proc/<pid>/cwd
                   # against this repo root before signaling.
                   "repo": REPO,
                   "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                               time.gmtime())}, f)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(STATE_DIR, 0o700)
    os.replace(tmp, STATE_PATH)


def _read_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict) and data.get("pid") and data.get("port"):
                return data
    except (OSError, ValueError):
        pass
    return None


def _probe(port: int) -> bool:
    """True when the form-host server answers on 127.0.0.1:port."""
    try:
        # Bypass any egress proxy: this is a loopback probe.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        req = urllib.request.Request("http://127.0.0.1:%d/" % port,
                                     method="GET")
        with opener.open(req, timeout=3) as resp:
            return (resp.status == 200
                    and MARKER in resp.read(65536))
    except Exception:
        return False


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def _pid_cwd(pid: int):
    """Realpath of /proc/<pid>/cwd, or None when it cannot be read."""
    try:
        return os.path.realpath("/proc/%d/cwd" % pid)
    except OSError:
        return None


def _pid_is_form_host(pid: int, expected_repo=None) -> bool:
    """True when pid's command line is this form-host daemon.

    LANE2-D16: stop_server() must never SIGTERM a recycled pid. The
    state file is only a (pid, port) pair; if the daemon died without
    stop_server() running, the pid may now belong to an unrelated
    process. The daemon is `python -m transport.form_host_server serve`
    from this tree, so its cmdline is unmistakable; anything else (or
    an unreadable cmdline) fails closed to "not ours".

    LANE2-D16b: when expected_repo is given, the daemon must also run
    with that directory as its working directory (the daemon is spawned
    with cwd=REPO). The cmdline markers alone also match another
    checkout's identical module; without the tree binding, this tree's
    stop_server() could SIGTERM a sibling tree's daemon after a pid
    collision in a shared state dir. A state file predating the "repo"
    field passes None and keeps the cmdline-only check.
    """
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            parts = fh.read().split(b"\0")
    except OSError:
        return False
    if not (any(b"form_host_server" in p for p in parts)
            and b"serve" in parts):
        return False
    if expected_repo is not None:
        cwd = _pid_cwd(pid)
        if cwd is None or cwd != os.path.realpath(expected_repo):
            return False
    return True


@contextmanager
def _ensure_locked():
    """LANE2-D6: serialize the ensure_server() check-then-spawn across
    processes and threads. Without it, two concurrent callers both see
    "no live server", both spawn a daemon, and the loser leaks an
    orphaned daemon its state file no longer points at."""
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    with open(os.path.join(STATE_DIR, "ensure.lock"), "a+b") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def ensure_server() -> str:
    """Return the base URL of a running form-host server, starting one if needed."""
    with _ensure_locked():
        return _ensure_server_locked()


def _spawn_daemon():
    """Spawn the detached daemon. Factored for testability: tests
    replace this to simulate a daemon that never becomes ready."""
    return subprocess.Popen(
        [sys.executable, "-m", "transport.form_host_server", "serve"],
        cwd=REPO, start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _ensure_server_locked() -> str:
    state = _read_state()
    if state and _pid_alive(int(state["pid"])) and _probe(int(state["port"])):
        return "http://127.0.0.1:%d" % int(state["port"])
    # Stale or missing: spawn a detached daemon and wait for readiness.
    try:
        if os.path.exists(STATE_PATH):
            os.remove(STATE_PATH)
    except OSError:
        pass
    proc = _spawn_daemon()
    ready_url = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        time.sleep(0.2)
        state = _read_state()
        if state and _probe(int(state["port"])):
            ready_url = "http://127.0.0.1:%d" % int(state["port"])
            break
        if proc.poll() is not None:
            break
    if ready_url is None:
        # LANE2-D16: terminal path. The daemon we spawned never became
        # ready (or died starting). It is our child, so there is no
        # ownership ambiguity: terminate it rather than leaking a daemon
        # no caller will adopt.
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
        except Exception:
            pass
        raise RuntimeError("form-host server did not become ready")
    return ready_url


def stop_server() -> bool:
    """Stop the daemon if running. Returns True when something was stopped."""
    state = _read_state()
    stopped = False
    if state:
        pid = int(state["pid"])
        # LANE2-D16: signal only when the pid is actually our daemon. A
        # stale state file plus a recycled pid must never SIGTERM an
        # unrelated process. LANE2-D16b: the repo recorded in the state
        # file binds the daemon to this tree; a sibling checkout's
        # identical module fails the cwd check.
        if _pid_alive(pid) and _pid_is_form_host(pid, state.get("repo")):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            else:
                stopped = True
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and _pid_alive(pid):
                    time.sleep(0.2)
    try:
        os.remove(STATE_PATH)
    except OSError:
        pass
    return stopped


# W5-P2-4: threaded server (one stalled connection must not block all
# requests) with daemon threads (a wedged worker never blocks shutdown)
# and a per-connection socket timeout (a stalled client cannot hold a
# worker thread forever: recv raises socket.timeout and the connection
# closes).
_CONN_TIMEOUT_S = 30


class _ThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def get_request(self):
        sock, addr = super().get_request()
        sock.settimeout(_CONN_TIMEOUT_S)
        return sock, addr


def _serve_forever() -> None:
    if not os.path.isfile(PAGE_PATH):
        sys.stderr.write("bundled form-host page missing: %s\n" % PAGE_PATH)
        sys.exit(1)
    httpd = _ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    port = httpd.server_address[1]
    _write_state(os.getpid(), port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


def main(argv) -> int:
    cmd = argv[1] if len(argv) > 1 else "status"
    if cmd == "serve":
        _serve_forever()
        return 0
    if cmd == "start":
        print(ensure_server())
        return 0
    if cmd == "stop":
        print("stopped" if stop_server() else "not running")
        return 0
    if cmd == "status":
        state = _read_state()
        if state and _pid_alive(int(state["pid"])) and _probe(int(state["port"])):
            print("running http://127.0.0.1:%d (pid %d)"
                  % (int(state["port"]), int(state["pid"])))
        else:
            print("not running")
        return 0
    if cmd == "url":
        print(ensure_server())
        return 0
    sys.stderr.write("unknown command: %s\n" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
