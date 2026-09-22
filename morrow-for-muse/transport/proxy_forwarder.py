"""Local CONNECT proxy forwarder for the Morrow Chromium transport.

Chrome's --proxy-server flag does not handle embedded proxy credentials
(ERR_NO_SUPPORTED_PROXIES). This forwarder listens on 127.0.0.1, accepts
CONNECT requests from the local Chromium, and relays them to the upstream
egress proxy with the Proxy-Authorization header injected.

The upstream proxy URL's scheme is honored (W4-P1-3): "https://" wraps
the upstream connection in verified TLS before CONNECT (and the
credential) is written; "http://" keeps plaintext. The startup log
states the tls state explicitly ("tls: yes/no").

CLIENT AUTHENTICATION (W4-P2-9): the relay is not an open CONNECT proxy.
Chromium's --proxy-server takes no client credential, so the forwarder
authenticates by process ancestry instead. The launcher passes its own
PID in MORROW_FORWARDER_LAUNCHER_PID; every accepted connection is
authorized only when the peer socket belongs to a STRICT descendant of
that PID (resolved via /proc/net/tcp and /proc/<pid>/stat, kernel-owned
data a client process cannot forge; where there is no /proc, via lsof
and ps, which read the same kernel tables). Any lookup failure refuses
the client. Anything else, including the
launcher process itself, gets HTTP 403 and a log line. Without the env
var the forwarder refuses to serve at all (fail closed). Consequence:
one forwarder serves exactly one launcher's Chromium; a second
launcher's browser can never be adopted onto it (the launcher's
_adopt_or_refuse fails closed on a foreign forwarder instead).

Egress is probed at startup (see transport/egress.py), in this order:
  (a) authenticated proxy from https_proxy/HTTPS_PROXY: forward with
      Proxy-Authorization injected (this process's original purpose);
  (b) unauthenticated proxy from the same env: forward without injecting
      any Proxy-Authorization header;
  (c) no proxy env at all: test direct egress with a short timeout. When
      direct works the forwarder exits 0 printing "direct egress, no
      forwarder needed" so the launcher skips it; when direct fails it
      exits non-zero with a diagnostic naming everything that was tried.

The upstream proxy URL (with credentials) comes from the HTTPS_PROXY /
https_proxy environment variable. The credentials never appear in Chrome's
command line, this process's argv, logs, or error messages; they live only
in this process's memory. All output redacts proxy URLs to
scheme://host:port.

Usage:
    python3 proxy_forwarder.py [listen_port]  # default 18080
In production the launcher always passes an explicit per-tree port
(CDP port + 10000, or MORROW_FORWARDER_PORT); the 18080 default only
applies to manual runs.
"""
import asyncio
import base64
import os
import ssl
import subprocess
import sys
import time
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import egress

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18080


def decide_startup(probe):
    """Map an egress.probe_egress() result to a startup action.

    Returns (action, message, exit_code) where action is "serve",
    "direct" (exit 0, no forwarder needed), or "blocked" (exit non-zero).
    The message is always credential-free.
    """
    mode = probe["mode"]
    if mode == "direct":
        return ("direct", "direct egress, no forwarder needed", 0)
    if mode == "blocked":
        return ("blocked",
                "egress probe failed, not starting forwarder: "
                + probe["detail"], 2)
    # "proxy" or "proxy_auth": serve. The redacted URL is safe to print.
    # W4-P1-3: the tls flag is derived from the upstream scheme so the
    # log line never claims TLS it is not doing.
    tls = urlparse(probe["upstream"] or "").scheme.lower() == "https"
    return ("serve", "upstream proxy: %s (auth: %s, tls: %s)" % (
        probe["proxy"], "yes" if mode == "proxy_auth" else "no",
        "yes" if tls else "no"), None)


def _build_upstream(probe):
    """Split the probe's raw upstream URL into (scheme, host, port, auth_header).

    W4-P1-3: the scheme is honored, not discarded. scheme "https" means
    the upstream connection is wrapped in TLS (verified against the
    system trust store, SNI from the proxy host) BEFORE the CONNECT
    request and any Proxy-Authorization bytes are written. Scheme
    "http" (or empty/unknown) keeps the historical plaintext behavior;
    the startup log names the tls state explicitly so it never claims
    TLS it is not doing. The default port follows the scheme: 443 for
    https, 3128 for http.
    auth_header is None for unauthenticated proxies. Credentials are held
    only in local variables and the returned header value.
    """
    upstream = probe["upstream"]
    u = urlparse(upstream)
    scheme = (u.scheme or "http").lower()
    default_port = 443 if scheme == "https" else 3128
    host, port = u.hostname, u.port or default_port
    auth = None
    if probe["mode"] == "proxy_auth" and u.username:
        creds = "%s:%s" % (u.username, u.password or "")
        auth = "Basic " + base64.b64encode(creds.encode()).decode()
        # Drop the credentials from memory as soon as the header is built.
        del creds
    return scheme, host, port, auth


def _tls_context():
    """TLS client context for an https:// upstream proxy (W4-P1-3).

    Verifies the proxy's certificate against the system trust store
    with hostname checking: the Proxy-Authorization credential must
    not be offered to an unauthenticated endpoint. A private-CA proxy
    needs its CA in the system store (same requirement Chromium has
    for --proxy-server=https://...).
    """
    return ssl.create_default_context()


def _verify_upstream_pin(up_w):
    """W6-P2-6: check the negotiated upstream cert against the pins.

    Returns True when the leaf certificate matches a configured pin.
    Logs and returns False otherwise: fail closed, the
    Proxy-Authorization credential is never written to a mismatched
    endpoint. No pins configured means no check (system-CA + hostname
    verification from _tls_context still applies).
    """
    ssl_obj = up_w.get_extra_info("ssl_object")
    der = ssl_obj.getpeercert(binary_form=True) if ssl_obj else None
    try:
        egress.check_cert_pin(der, _UPSTREAM_PINS,
                              "upstream proxy %s:%d" % (UPSTREAM_HOST,
                                                        UPSTREAM_PORT))
    except egress.CertPinMismatch as exc:
        print("forwarder: %s" % exc, file=sys.stderr, flush=True)
        return False
    return True


LAUNCHER_PID_ENV = "MORROW_FORWARDER_LAUNCHER_PID"


def _require_launcher_pid():
    """W4-P2-9: the launcher PID authorizing this relay's clients.

    Fail closed: without a positive integer PID the forwarder refuses
    to serve. The value comes from the launcher's environment (child
    process env, never argv), so it never appears in ps output.
    """
    raw = os.environ.get(LAUNCHER_PID_ENV, "").strip()
    try:
        pid = int(raw)
    except ValueError:
        pid = 0
    if pid <= 0:
        sys.stderr.write(
            "forwarder: refusing to serve: %s is not set to the "
            "launcher's PID (W4-P2-9: the CONNECT relay authenticates "
            "clients by launcher-PID ancestry and fails closed without "
            "it)\n" % LAUNCHER_PID_ENV)
        sys.exit(2)
    return pid


def _hex_ip_port(addr):
    """'0100007F:1F90' -> ('127.0.0.1', 8080). Raises ValueError on junk."""
    ip_hex, port_hex = addr.split(":")
    ip = ".".join(str(int(ip_hex[i:i + 2], 16)) for i in (6, 4, 2, 0))
    return ip, int(port_hex, 16)


def _client_socket_inode(peer_port):
    """Inode of the CLIENT side of the accepted loopback connection.

    /proc/net/tcp lists each direction separately; the client side is
    the entry with local=127.0.0.1:peer_port, rem=127.0.0.1:LISTEN_PORT
    in ESTABLISHED state (st 01; 0A is LISTEN). None when unresolvable:
    fail closed.
    """
    try:
        with open("/proc/net/tcp") as fh:
            lines = fh.read().splitlines()[1:]
    except OSError:
        return None
    for line in lines:
        parts = line.split()
        if len(parts) < 10 or parts[3] != "01":
            continue
        try:
            local = _hex_ip_port(parts[1])
            rem = _hex_ip_port(parts[2])
            inode = int(parts[9])
        except ValueError:
            continue
        if (local == ("127.0.0.1", peer_port)
                and rem == ("127.0.0.1", LISTEN_PORT)):
            return inode
    return None



def _stat_after_comm(pid):
    """Fields of /proc/<pid>/stat after the (comm) field, or None.

    comm may itself contain spaces and parentheses, so fields are
    split after the LAST ')'.
    """
    try:
        with open("/proc/%d/stat" % pid) as fh:
            data = fh.read()
    except OSError:
        return None
    return data.rsplit(")", 1)[-1].split()


def _ppid(pid):
    fields = _stat_after_comm(pid)
    if not fields or len(fields) < 2:
        return None
    try:
        return int(fields[1])
    except ValueError:
        return None


def _starttime(pid):
    """Kernel starttime of a pid (field 22), for PID-reuse-safe caching."""
    fields = _stat_after_comm(pid)
    if not fields or len(fields) < 20:
        return None
    try:
        return int(fields[19])
    except ValueError:
        return None


def _strict_ancestors(pid):
    """Strict ancestor PIDs of pid via the kernel ppid chain."""
    seen = set()
    cur = _ppid(pid)
    while cur and cur not in seen:
        seen.add(cur)
        if cur == 1:
            break
        cur = _ppid(cur)
    return seen


_AUTH_CACHE = {}  # (pid, starttime) -> bool; PID reuse re-verifies.
_AUTH_CACHE_MAX = 4096  # W5-P2-3: bound the auth cache.


def _auth_cache_store(key, ok):
    """Bounded insert into _AUTH_CACHE (W5-P2-3)."""
    if key not in _AUTH_CACHE and len(_AUTH_CACHE) >= _AUTH_CACHE_MAX:
        # FIFO eviction: dicts are insertion-ordered; the oldest key
        # goes first. Evicted pids simply re-verify on next CONNECT.
        _AUTH_CACHE.pop(next(iter(_AUTH_CACHE)))
    _AUTH_CACHE[key] = ok


# W5-P2-3: the inode->pid lookup scans /proc/<pid>/fd for every process
# on the machine. Two-tier design:
#
# 1. PID hints (fast path): pids that previously held a client socket
#    are checked first. Chromium reuses one process for many CONNECTs,
#    so the common case is O(that pid's fds), not O(processes x fds).
#    A hint is only trusted while the pid's starttime is unchanged
#    (defeats PID reuse) and the pid still holds that exact socket
#    inode (defeats inode reuse).
# 2. Fresh snapshot (slow path): on hint miss, build an inode->PID map
#    from ONE /proc pass. The snapshot is never cached across
#    connections: a new connection's inode cannot be in a snapshot
#    built before it connected, so caching it would fail closed on
#    every new client (and fail open is not an option).
_PID_HINTS = []  # [(pid, starttime)], bounded below
_PID_HINTS_MAX = 32


def _proc_socket_snapshot():
    """{socket_inode: (pid, starttime)} from a single /proc pass.

    Uncached by design (see above). Callers must verify a hit
    (starttime + live inode) before trusting it.
    """
    snap = {}
    me = str(os.getpid())
    try:
        pids = os.listdir("/proc")
    except OSError:
        return {}
    for pid in pids:
        if not pid.isdigit() or pid == me:
            continue
        try:
            pid_int = int(pid)
            starttime = _starttime(pid_int)
            if starttime is None:
                continue
            fds = os.listdir("/proc/%s/fd" % pid)
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink("/proc/%s/fd/%s" % (pid, fd))
            except OSError:
                continue
            if target.startswith("socket:[") and target.endswith("]"):
                try:
                    inode = int(target[8:-1])
                except ValueError:
                    continue
                # First pid wins; a socket is normally held by one
                # process (forked children may share it).
                snap.setdefault(inode, (pid_int, starttime))
    return snap


def _pid_holds_inode(pid, inode):
    """True when /proc/<pid>/fd still references socket:[inode]."""
    want = "socket:[%s]" % inode
    try:
        fds = os.listdir("/proc/%d/fd" % pid)
    except OSError:
        return False
    for fd in fds:
        try:
            if os.readlink("/proc/%d/fd/%s" % (pid, fd)) == want:
                return True
        except OSError:
            continue
    return False


def _socket_holder_pid_verified(inode):
    """PID holding socket:[inode], verified at use (W5-P2-3).

    Fast path first: pids that held a client socket before are
    re-checked directly (O(their fds)). On miss, one fresh /proc
    snapshot maps the inode; the hit is verified (pid starttime
    unchanged, live fd still references the inode) before trusting,
    so the authorization decision is exactly as strict as a fresh
    full scan. Newly-seen pids become hints for the next connection.
    """
    for pid, starttime in list(_PID_HINTS):
        if (_starttime(pid) == starttime
                and _pid_holds_inode(pid, inode)):
            return pid
    hit = _proc_socket_snapshot().get(inode)
    if hit is None:
        return None
    pid, starttime = hit
    if _starttime(pid) != starttime:
        return None  # pid reused since the snapshot
    if not _pid_holds_inode(pid, inode):
        return None  # inode closed/reused since the snapshot
    if (pid, starttime) not in _PID_HINTS:
        _PID_HINTS.append((pid, starttime))
        del _PID_HINTS[:-_PID_HINTS_MAX]
    return pid


def _ps_value(pid, field):
    """One ps field for pid (e.g. "ppid", "lstart"), or None."""
    try:
        out = subprocess.run(["ps", "-o", "%s=" % field, "-p", str(pid)],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    value = out.stdout.strip()
    return value if out.returncode == 0 and value else None


def _lsof_client_pid(peer_port):
    """PID owning the client side of 127.0.0.1:peer_port ->
    127.0.0.1:LISTEN_PORT, read with lsof (no /proc). None when it
    cannot be resolved to exactly one other process: fail closed."""
    try:
        out = subprocess.run(
            ["lsof", "-nP", "-iTCP@127.0.0.1:%d" % peer_port,
             "-sTCP:ESTABLISHED", "-Fpn"],
            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    want = "n127.0.0.1:%d->127.0.0.1:%d" % (peer_port, LISTEN_PORT)
    pid, owners = None, set()
    for line in out.stdout.splitlines():
        if line.startswith("p"):
            try:
                pid = int(line[1:])
            except ValueError:
                pid = None
        elif line == want and pid is not None and pid != os.getpid():
            owners.add(pid)
    return owners.pop() if len(owners) == 1 else None


def _client_authorized_no_proc(peer_port):
    """_client_authorized where there is no /proc (macOS): the same
    strict-descendant rule, with lsof and ps as the kernel readers."""
    pid = _lsof_client_pid(peer_port)
    if pid is None:
        return False
    key = (pid, _ps_value(pid, "lstart"))
    if key[1] is None:
        return False
    if key in _AUTH_CACHE:
        return _AUTH_CACHE[key]
    seen = set()
    cur = pid
    ok = False
    while cur and cur not in seen and cur != 1:
        seen.add(cur)
        raw = _ps_value(cur, "ppid")
        try:
            cur = int(raw) if raw is not None else None
        except ValueError:
            cur = None
        if cur == _LAUNCHER_PID:
            ok = True
            break
    _auth_cache_store(key, ok)
    return ok


def _client_authorized(peer_port):
    """W4-P2-9: True when the connecting client is a strict descendant
    of the launcher PID. Every lookup failure fails closed (False)."""
    if not peer_port:
        return False
    if not os.path.exists("/proc/net/tcp"):
        return _client_authorized_no_proc(peer_port)
    inode = _client_socket_inode(peer_port)
    if inode is None:
        return False
    # W5-P2-3: verified inode->pid snapshot instead of a full /proc scan
    # per CONNECT.
    pid = _socket_holder_pid_verified(inode)
    if pid is None:
        return False
    key = (pid, _starttime(pid))
    if key in _AUTH_CACHE:
        return _AUTH_CACHE[key]
    ok = _LAUNCHER_PID in _strict_ancestors(pid)
    _auth_cache_store(key, ok)
    return ok


# W5-P2-3: connection and resource caps. Each admitted CONNECT holds two
# relay tasks for the session lifetime; past MAX_CONNECTIONS new clients
# get an immediate 503 instead of queueing unboundedly.
MAX_CONNECTIONS = 64
MAX_HEADER_BYTES = 65536  # client AND upstream response header cap
HEADER_READ_TIMEOUT_S = 10.0
UPSTREAM_CONNECT_TIMEOUT_S = 10.0
_CONN_SEM = None  # asyncio.Semaphore, created in main()


PROBE = egress.probe_egress()
_ACTION, _MESSAGE, _EXIT = decide_startup(PROBE)
if _ACTION == "direct":
    print(_MESSAGE, flush=True)
    sys.exit(0)
if _ACTION == "blocked":
    sys.exit(_MESSAGE)
# W4-P2-9: required before serving. _require_launcher_pid exits 2 when
# the launcher did not pass its PID; the relay never runs open.
_LAUNCHER_PID = _require_launcher_pid()
UPSTREAM_SCHEME, UPSTREAM_HOST, UPSTREAM_PORT, AUTH = _build_upstream(PROBE)
# W6-P2-6: optional upstream-proxy certificate pinning. Parse at
# startup and fail closed on a malformed pin list: a misconfigured pin
# must never silently become "no pinning". A pin without TLS is
# meaningless, so that combination gets a loud warning.
_UPSTREAM_PINS = []
_PIN_RAW = os.environ.get(egress.PROXY_PIN_ENV_VAR, "").strip()
if _PIN_RAW:
    try:
        _UPSTREAM_PINS = egress.parse_cert_pins(_PIN_RAW)
    except ValueError as exc:
        sys.stderr.write(
            "forwarder: refusing to serve: %s is malformed (%s); fix "
            "the pin list or unset it\n" % (egress.PROXY_PIN_ENV_VAR, exc))
        sys.exit(2)
    if UPSTREAM_SCHEME != "https":
        print("forwarder WARNING: %s is set but the upstream scheme is "
              "%s (no TLS): the pin is not checked. Use an https:// "
              "upstream proxy URL for the pin to apply."
              % (egress.PROXY_PIN_ENV_VAR, UPSTREAM_SCHEME),
              file=sys.stderr, flush=True)
# W5-P2-4: Proxy-Authorization over plaintext HTTP is operator residual
# risk, but it deserves a loud warning, not just a "tls: no" log line.
# The credential crosses the network unencrypted to any party able to
# observe traffic between this machine and the proxy. (A loopback proxy
# is exempt: the bytes never leave the machine.)
if PROBE["mode"] == "proxy_auth" and UPSTREAM_SCHEME == "http" \
        and UPSTREAM_HOST not in ("127.0.0.1", "localhost", "::1"):
    print("forwarder WARNING: sending Proxy-Authorization to %s over "
          "PLAINTEXT HTTP (upstream scheme http, no TLS). Anyone able to "
          "observe traffic between this machine and the proxy can capture "
          "the proxy credential. Prefer an https:// upstream proxy URL, "
          "which wraps CONNECT and Proxy-Authorization in verified TLS "
          "before any credential bytes are written." % UPSTREAM_HOST,
          file=sys.stderr, flush=True)
# Log line is redacted: host and port only, never credentials. The
# tls flag (from the upstream scheme) is part of the message built in
# decide_startup, so the log states the real transport. W6-P2-6: the pin
# state is logged too (count only, never the pin values).
print("forwarder config: %s (mode=%s, cert_pins=%d)" % (
    _MESSAGE, PROBE["mode"], len(_UPSTREAM_PINS)),
    flush=True)
del PROBE, _ACTION, _MESSAGE, _EXIT


async def relay(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(client_r, client_w):
    """Per-connection entry point: shed load past the cap (W5-P2-3)."""
    # Non-blocking acquire: past MAX_CONNECTIONS the client gets an
    # immediate 503 instead of queueing unboundedly behind the relay
    # tasks of already-admitted connections. locked() followed by
    # acquire() with no await between is race-free on this
    # single-threaded loop. (asyncio.wait_for(..., timeout=0) is NOT a
    # non-blocking acquire: a fresh Task is never done at the first
    # check, so it times out even with free slots and 503s every
    # client.)
    over_cap = _CONN_SEM.locked()
    if not over_cap:
        await _CONN_SEM.acquire()
    if over_cap:
        try:
            client_w.write(b"HTTP/1.1 503 Service Unavailable\r\n"
                           b"Retry-After: 1\r\n\r\n")
            await client_w.drain()
        except Exception:
            pass
        try:
            client_w.close()
        except Exception:
            pass
        return
    try:
        await _handle_inner(client_r, client_w)
    finally:
        _CONN_SEM.release()


async def _read_headers(reader):
    """Read until end-of-headers. Returns bytes, or None on EOF,
    over-cap, or timeout (W5-P2-3: a stalled peer must not hold a
    connection slot forever)."""
    async def _fill():
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = await reader.read(4096)
            if not chunk:
                break
            buf += chunk
            if len(buf) > MAX_HEADER_BYTES:
                return None
        return buf
    try:
        return await asyncio.wait_for(_fill(), HEADER_READ_TIMEOUT_S)
    except (asyncio.TimeoutError, TimeoutError):
        return None


async def _handle_inner(client_r, client_w):
    try:
        # W4-P2-9: authenticate the client BEFORE reading any bytes.
        # Only the launcher's Chromium (a strict descendant of the
        # launcher PID) may use the relay. Any other local process,
        # including the launcher itself, gets 403 and a log line.
        peer = client_w.get_extra_info("peername")
        peer_port = peer[1] if peer else None
        if not _client_authorized(peer_port):
            print("forwarder: refusing unauthenticated client "
                  "(peer port %s)" % (peer_port,), flush=True)
            client_w.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            await client_w.drain()
            client_w.close()
            return
        # Read the CONNECT request headers (bounded: W5-P2-3).
        buf = await _read_headers(client_r)
        if buf is None or b"\r\n\r\n" not in buf:
            client_w.close()
            return
        head = buf.split(b"\r\n\r\n", 1)[0].decode("latin1")
        lines = head.split("\r\n")
        method, target, _ = lines[0].split(" ", 2)
        if method.upper() != "CONNECT":
            client_w.write(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            await client_w.drain()
            client_w.close()
            return

        # Open upstream and issue CONNECT with auth.
        # W4-P1-3: honor the proxy URL scheme. An https:// upstream gets
        # a TLS-wrapped connection (verified, SNI from the proxy host)
        # before CONNECT and Proxy-Authorization are written; http://
        # keeps the plaintext behavior. The credential never crosses
        # the wire before the TLS handshake completes.
        # W5-P2-3: bound the upstream connect (a hung proxy must not
        # hold the client's connection slot forever).
        try:
            if UPSTREAM_SCHEME == "https":
                up_r, up_w = await asyncio.wait_for(
                    asyncio.open_connection(
                        UPSTREAM_HOST, UPSTREAM_PORT, ssl=_tls_context()),
                    UPSTREAM_CONNECT_TIMEOUT_S)
            else:
                up_r, up_w = await asyncio.wait_for(
                    asyncio.open_connection(UPSTREAM_HOST, UPSTREAM_PORT),
                    UPSTREAM_CONNECT_TIMEOUT_S)
        except (asyncio.TimeoutError, TimeoutError, OSError):
            client_w.write(b"HTTP/1.1 504 Gateway Timeout\r\n\r\n")
            await client_w.drain()
            client_w.close()
            return
        # W6-P2-6: when pins are configured, the upstream's leaf
        # certificate must match BEFORE CONNECT and Proxy-Authorization
        # are written. A mismatch answers 502 and closes both sides.
        if _UPSTREAM_PINS and UPSTREAM_SCHEME == "https" \
                and not _verify_upstream_pin(up_w):
            up_w.close()
            client_w.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            await client_w.drain()
            client_w.close()
            return
        req = f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n"
        if AUTH:
            req += f"Proxy-Authorization: {AUTH}\r\n"
        req += "Proxy-Connection: keep-alive\r\n\r\n"
        up_w.write(req.encode("latin1"))
        await up_w.drain()

        # Read upstream response headers (bounded like the client side:
        # W5-P2-3; the old loop had no cap at all). An upstream that
        # closes before sending headers (or stalls past the cap) is a
        # bad gateway: answer 502, never a silent close.
        ubuf = await _read_headers(up_r)
        if ubuf is None or b"\r\n\r\n" not in ubuf:
            up_w.close()
            try:
                client_w.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                await client_w.drain()
            except Exception:
                pass
            client_w.close()
            return
        if b" 200" not in ubuf.split(b"\r\n", 1)[0]:
            client_w.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            await client_w.drain()
            client_w.close()
            up_w.close()
            return
        client_w.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await client_w.drain()

        await asyncio.gather(relay(client_r, up_w), relay(up_r, client_w))
    except Exception:
        try:
            client_w.close()
        except Exception:
            pass


async def main():
    global _CONN_SEM
    # W5-P2-3: bound concurrent CONNECT sessions; past the cap new
    # clients get an immediate 503 (see handle()).
    _CONN_SEM = asyncio.Semaphore(MAX_CONNECTIONS)
    server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
    # Redacted: host and port only, never credentials.
    print("forwarder on %s:%d -> %s://%s:%d" % (
        LISTEN_HOST, LISTEN_PORT, UPSTREAM_SCHEME, UPSTREAM_HOST,
        UPSTREAM_PORT), flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except OSError as exc:
        # W2-P2-23: spawn race. Two launchers raced for the port; the
        # loser exits with a clean line (exit 3), not a traceback. The
        # winner's listener serves both.
        import errno
        if exc.errno == errno.EADDRINUSE:
            print("forwarder port %d already in use: another instance won "
                  "the race; exiting cleanly" % LISTEN_PORT, flush=True)
            sys.exit(3)
        raise
