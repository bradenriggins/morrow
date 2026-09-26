"""Read Moodle courses through a tenant-pinned, browser-owned VM session.

This module has no write operation. Browser cookies and Moodle's sesskey stay
inside Chromium; the helper returns only validated course identifiers/names.
"""

import argparse
import hashlib
import json
import os
import secrets
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from moodle.session import normalize_moodle_base


DEFAULT_PORT = 8903
MAX_COURSES = 500
MAX_NAME = 240


class CourseReadError(RuntimeError):
    """The Moodle session or course-list response is not usable."""


def normalize_site_base(base, expected_host=None):
    if not isinstance(base, str):
        raise ValueError("Moodle site must be an HTTPS URL")
    parts = urllib.parse.urlsplit(base)
    if (parts.scheme.lower() != "https" or not parts.hostname
            or parts.username is not None or parts.password is not None
            or parts.query or parts.fragment):
        raise ValueError("Moodle site must be an HTTPS host and site path")
    if expected_host and parts.hostname.lower() != expected_host.lower():
        raise ValueError("Moodle site host differs from the pinned host")
    return normalize_moodle_base(base)


@dataclass(frozen=True)
class BrowserConfig:
    base: str
    state_dir: str
    profile_dir: str
    token_path: str
    config_path: str
    port: int
    cdp_port: int

    @property
    def connection_id(self):
        return hashlib.sha256(
            os.fsencode(os.path.realpath(self.profile_dir))).hexdigest()[:16]

    @classmethod
    def for_tree(cls, tree_root, base, state_root=None, port=DEFAULT_PORT):
        from transport import local_chromium as lc

        base = normalize_site_base(base)
        port = int(port)
        if port in (8901, 8902) or not 1024 <= port < 12446:
            raise ValueError("Moodle helper port must be 1024..12445, excluding Canvas ports")
        root = state_root or lc.tree_state_dir(tree_root)
        state = os.path.join(root, "moodle")
        return cls(base, state, os.path.join(state, "profile"),
                   os.path.join(state, "helper_token"),
                   os.path.join(state, "connection.json"),
                   port, port + 10322)


def validate_course_result(value):
    if not isinstance(value, dict) or value.get("ok") is not True:
        code = value.get("code") if isinstance(value, dict) else None
        if not isinstance(code, str) or len(code) > 50:
            code = "unavailable"
        raise CourseReadError("Moodle course read failed: " + code)
    principal = value.get("principal_id")
    courses = value.get("courses")
    if (isinstance(principal, bool) or not isinstance(principal, int)
            or principal <= 0 or not isinstance(courses, list)
            or len(courses) > MAX_COURSES):
        raise CourseReadError("Moodle course read returned an invalid shape")
    clean = []
    seen = set()
    for course in courses:
        if not isinstance(course, dict):
            raise CourseReadError("Moodle course read returned an invalid shape")
        course_id, name = course.get("id"), course.get("name")
        if (isinstance(course_id, bool) or not isinstance(course_id, int)
                or course_id <= 0 or course_id in seen
                or not isinstance(name, str) or not name.strip()
                or len(name) > MAX_NAME or "\x00" in name):
            raise CourseReadError("Moodle course read returned an invalid shape")
        seen.add(course_id)
        clean.append({"id": course_id, "name": name.strip()})
    return {"principal_id": principal, "courses": clean}


def course_list_expression(site_base):
    """One isolated-world read. No secret value is interpolated or returned."""
    base = normalize_site_base(site_base)
    quoted_base = json.dumps(base)
    return r"""(async () => {
      const site = new URL(__SITE_BASE__);
      const here = new URL(location.href);
      if (here.origin !== site.origin ||
          !(here.pathname === site.pathname ||
            here.pathname.startsWith(site.pathname.replace(/\/$/, '') + '/')))
        return {ok: false, code: 'off_site'};
      let cfg = null;
      for (const script of document.scripts) {
        if (script.type && script.type !== 'text/javascript' &&
            script.type !== 'application/javascript') continue;
        const match = script.textContent.match(/\bM\.cfg\s*=\s*(\{[^;]*\})\s*;/);
        if (!match) continue;
        try {
          const candidate = JSON.parse(match[1]);
          if (new URL(candidate.wwwroot).href.replace(/\/$/, '') ===
              site.href.replace(/\/$/, '')) {
            cfg = candidate;
            break;
          }
        } catch (_) { continue; }
      }
      if (!cfg || typeof cfg.sesskey !== 'string' ||
          !/^[A-Za-z0-9]{10,}$/.test(cfg.sesskey) ||
          !Number.isSafeInteger(Number(cfg.userid)) || Number(cfg.userid) <= 0)
        return {ok: false, code: 'login_required'};
      const endpoint = new URL(site.pathname.replace(/\/$/, '') +
        '/lib/ajax/service.php', site.origin);
      endpoint.searchParams.set('sesskey', cfg.sesskey);
      endpoint.searchParams.set('info',
        'core_course_get_enrolled_courses_by_timeline_classification');
      const body = JSON.stringify([{index: 0,
        methodname: 'core_course_get_enrolled_courses_by_timeline_classification',
        args: {classification: 'all'}}]);
      try {
        const response = await fetch(endpoint.href, {
          method: 'POST', credentials: 'same-origin', redirect: 'manual',
          cache: 'no-store', referrerPolicy: 'no-referrer',
          headers: {'Content-Type': 'application/json'}, body
        });
        const final = new URL(response.url);
        if (response.status !== 200 || response.redirected ||
            final.origin !== site.origin || final.pathname !== endpoint.pathname)
          return {ok: false, code: 'session_or_site_unavailable'};
        const reader = response.body && response.body.getReader();
        if (!reader) return {ok: false, code: 'response_unavailable'};
        const decoder = new TextDecoder('utf-8', {fatal: true});
        let raw = '', bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 262144) {
            await reader.cancel();
            return {ok: false, code: 'response_too_large'};
          }
          raw += decoder.decode(chunk.value, {stream: true});
        }
        raw += decoder.decode();
        const envelope = JSON.parse(raw);
        if (!Array.isArray(envelope) || envelope.length !== 1 ||
            envelope[0].error !== false ||
            !envelope[0].data || !Array.isArray(envelope[0].data.courses))
          return {ok: false, code: 'course_api_unavailable'};
        const source = envelope[0].data.courses;
        if (source.length > 500)
          return {ok: false, code: 'too_many_courses'};
        const courses = source.map(c => ({id: c.id, name: c.fullname}));
        return {ok: true, principal_id: Number(cfg.userid), courses};
      } catch (_) {
        return {ok: false, code: 'course_read_failed'};
      }
    })()""".replace("__SITE_BASE__", quoted_base)


def _private_dir(path):
    if os.path.lexists(path) and (os.path.islink(path) or not os.path.isdir(path)):
        raise RuntimeError("Moodle state path is not a directory")
    os.makedirs(path, mode=0o700, exist_ok=True)
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        os.chmod(path, 0o700)


def _atomic_private_json(path, payload):
    temp = path + "." + secrets.token_hex(8) + ".tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _load_config(tree_root):
    from transport import local_chromium as lc

    path = os.path.join(lc.tree_state_dir(tree_root), "moodle", "connection.json")
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return BrowserConfig.for_tree(tree_root, data["base"],
                                  state_root=lc.tree_state_dir(tree_root),
                                  port=data["port"])


def _request(config, path, token=False, timeout=45):
    headers = {}
    if token:
        try:
            with open(config.token_path, "r", encoding="ascii") as fh:
                headers["X-Helper-Token"] = fh.read().strip()
        except OSError:
            raise CourseReadError("Moodle helper token is unavailable") from None
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (config.port, path), headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise CourseReadError("Moodle helper response is too large")
        return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise CourseReadError("Moodle helper returned HTTP %d" % exc.code) from None
    except (urllib.error.URLError, TimeoutError):
        raise CourseReadError("Moodle helper is unavailable") from None


def serve(tree_root, base, port=DEFAULT_PORT):
    config = BrowserConfig.for_tree(tree_root, base, port=port)
    _private_dir(config.state_dir)
    _private_dir(config.profile_dir)
    if os.path.exists(config.config_path):
        old = _load_config(tree_root)
        if old.base != config.base or old.port != config.port:
            raise RuntimeError("Moodle tenant or port differs from the pinned connection")
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(("127.0.0.1", config.port)) == 0:
            raise RuntimeError("Moodle helper port is already in use")
    _atomic_private_json(config.config_path,
                         {"base": config.base, "port": config.port})
    token = secrets.token_hex(32)
    temp = config.token_path + "." + secrets.token_hex(8) + ".tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as fh:
            fh.write(token + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temp, config.token_path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    env = dict(os.environ)
    for key in ("HELPER_AUTH_TOKEN", "LOGIN_HELPER_BIND_PUBLIC",
                "LOGIN_HELPER_TLS_CERT", "LOGIN_HELPER_TLS_KEY",
                "MORROW_FORWARDER_PORT"):
        env.pop(key, None)
    env.update({
        "LOGIN_HELPER_PROVIDER": "moodle",
        "MOODLE_BASE": config.base,
        "MORROW_TREE_STATE_DIR": config.state_dir,
        "MORROW_HELPER_ENV_FILE": os.path.join(config.state_dir, "helper-env"),
        "LOGIN_HELPER_PROFILE_DIR": config.profile_dir,
        "HELPER_AUTH_TOKEN_FILE": config.token_path,
        "LOGIN_HELPER_PORT": str(config.port),
        "LOGIN_HELPER_CDP_PORT": str(config.cdp_port),
        "LOGIN_HELPER_BIND": "127.0.0.1",
    })
    helper = os.path.join(tree_root, "helper", "server.py")
    os.execve(sys.executable, [sys.executable, helper, config.base], env)


def read(tree_root):
    config = _load_config(tree_root)
    status = _request(config, "/moodle/ping", token=True)
    if (status.get("provider") != "moodle"
            or status.get("site_base") != config.base
            or status.get("connection_id") != config.connection_id):
        raise CourseReadError("Moodle helper identity does not match this connection")
    result = validate_course_result(_request(config, "/moodle/courses", token=True))
    return {"provider": "moodle", "site": config.base, **result}


def start(tree_root, base, port=DEFAULT_PORT):
    config = BrowserConfig.for_tree(tree_root, base, port=port)
    _private_dir(config.state_dir)
    if os.path.exists(config.config_path):
        pinned = _load_config(tree_root)
        if pinned.base != config.base or pinned.port != config.port:
            raise RuntimeError("Moodle tenant or port differs from the pinned connection")
    try:
        status = _request(config, "/moodle/ping", token=True, timeout=2)
    except CourseReadError:
        status = None
    if status is not None:
        if (status.get("provider") == "moodle"
                and status.get("site_base") == config.base
                and status.get("connection_id") == config.connection_id
                and status.get("chromium_alive")):
            return {"site": config.base,
                    "helper_url": "http://127.0.0.1:%d/" % config.port,
                    "running": True}
        raise RuntimeError("Moodle helper port is occupied by another service")
    log_path = os.path.join(config.state_dir, "helper.log")
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("HELPER_AUTH_TOKEN", None)
    with os.fdopen(fd, "a", encoding="utf-8") as log:
        child = subprocess.Popen(
            [sys.executable, "-m", "moodle.browser_read", "serve",
             "--base", config.base, "--port", str(config.port)],
            cwd=tree_root, env=env, stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError("Moodle helper exited during startup; see %s" % log_path)
        try:
            status = _request(config, "/moodle/ping", token=True, timeout=2)
            if (status.get("provider") == "moodle"
                    and status.get("site_base") == config.base
                    and status.get("connection_id") == config.connection_id
                    and status.get("chromium_alive")):
                return {"site": config.base,
                        "helper_url": "http://127.0.0.1:%d/" % config.port,
                        "running": True}
        except CourseReadError:
            pass
        time.sleep(0.5)
    raise RuntimeError("Moodle helper did not become ready; see %s" % log_path)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Browser-owned Moodle course read")
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("start", help="start the Moodle sign-in helper")
    s.add_argument("--base", required=True)
    s.add_argument("--port", type=int, default=DEFAULT_PORT)
    s = sub.add_parser("serve", help="show educator-controlled Moodle sign-in")
    s.add_argument("--base", required=True)
    s.add_argument("--port", type=int, default=DEFAULT_PORT)
    sub.add_parser("courses", help="read only course IDs and names")
    args = parser.parse_args(argv)
    tree = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    try:
        if args.command == "start":
            print(json.dumps(start(tree, args.base, args.port), sort_keys=True))
        elif args.command == "serve":
            serve(tree, args.base, args.port)
        else:
            print(json.dumps(read(tree), ensure_ascii=False, sort_keys=True))
    except (ValueError, RuntimeError, OSError, KeyError, json.JSONDecodeError) as exc:
        print("Moodle connection: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
