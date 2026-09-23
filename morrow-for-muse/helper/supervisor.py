#!/usr/bin/env python3
"""Keepalive supervision that does not depend on cron.

The helper's keepalive (helper/keepalive.sh) must run every five
minutes. On a machine with cron, install.sh installs a per-tree cron
entry. On a machine without cron (the Muse VM image has no cron
daemon), this module runs a supervised background loop instead: one
process per tree that runs keepalive.sh, sleeps five minutes, and
repeats. `bin/morrow start` starts it, and after a reboot the first
`morrow` command restarts it (install.sh records that this tree uses
the loop). Uninstall and disconnect stop it.

State lives in the tree's state dir (<MORROW_HOME>/trees/<tree id>/,
the same place keepalive keeps its lock, logs, and helper token), never
in the tree: install.sh's secrets gate and integrity walk read the tree
as release content. keepalive-supervisor.json holds {"method": "loop",
"installed": true, "pid": <loop pid or null>}; the loop's log is
keepalive-supervisor.log beside it. Older releases wrote these files,
and keepalive's and the helper's logs, into <tree>/helper/;
retire-legacy stops a loop recorded there and moves the files out.

CLI (prints one JSON object, or one word for detect):
  supervisor.py detect                 "cron" or "loop"
  supervisor.py install-loop           record loop supervision, start it
  supervisor.py ensure                 start the loop if it is not running
  supervisor.py ensure-if-installed    restart it only if install chose it
  supervisor.py status
  supervisor.py stop                   stop the loop (still installed)
  supervisor.py uninstall              stop the loop and forget it
  supervisor.py retire-legacy          move an older release's runtime
                                       files out of helper/ (install.sh)
  supervisor.py run --tree T ...       the loop itself (started by ensure)

Stdlib only.
"""

import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

# Script mode (`python3 helper/supervisor.py`) puts helper/ first on
# sys.path; the tree root goes first so an installed package named
# `transport` is never imported in the tree's place.
_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

INTERVAL_SECONDS = 300
STATE_NAME = "keepalive-supervisor.json"
LOG_NAME = "keepalive-supervisor.log"
_CRON_DAEMONS = frozenset({"cron", "crond", "cronie"})
# What older releases left in <tree>/helper/: this module's state and
# log, keepalive.sh's log and its rotated archives, and the helper
# server's log and its rotated archives.
_LEGACY_RUNTIME = re.compile(
    r"^(?:(?:keepalive|server|keepalive-supervisor)\.log(?:\.[0-9]+)?"
    r"|keepalive-supervisor\.json(?:\.lock)?)$")


def _helper_dir(tree):
    return os.path.join(os.path.realpath(tree), "helper")


def _state_dir(tree):
    """This tree's state dir, resolved exactly as keepalive.sh and the
    transport resolve it (MORROW_TREE_STATE_DIR, else
    <MORROW_HOME>/trees/<tree id>)."""
    override = os.environ.get("MORROW_TREE_STATE_DIR")
    if override:
        return override
    from transport.local_chromium import tree_state_dir
    return tree_state_dir(os.path.realpath(tree))


def _state_path(tree, state_dir=None):
    return os.path.join(state_dir or _state_dir(tree), STATE_NAME)


def _keepalive(tree):
    return os.path.join(_helper_dir(tree), "keepalive.sh")


def cron_daemon_running():
    """True when a cron daemon is running. With /proc (Linux) the
    process table is scanned; without it (macOS) launchd starts cron on
    demand, so an installed crontab is enough."""
    if not os.path.isdir("/proc"):
        return True
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/%s/comm" % pid, "r", encoding="utf-8") as fh:
                if fh.read().strip() in _CRON_DAEMONS:
                    return True
        except OSError:
            continue
    return False


def detect(path=None):
    """"cron" when crontab is installed and a cron daemon runs, else
    "loop" (the supervised background loop)."""
    if shutil.which("crontab", path=path) and cron_daemon_running():
        return "cron"
    return "loop"


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _read_state(tree, state_dir=None):
    return _read_json(_state_path(tree, state_dir))


def _write_state(tree, doc):
    path = _state_path(tree)
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


class _Lock:
    def __init__(self, tree):
        self.path = _state_path(tree) + ".lock"
        self.fh = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        self.fh = open(self.path, "a")
        fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
        self.fh.close()


def _cmdline(pid):
    """The process's command line, or None when it cannot be read."""
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            return fh.read().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        pass
    try:
        out = subprocess.run(["ps", "-ww", "-o", "args=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def _is_our_loop(pid, tree):
    """True when pid is alive and is this tree's supervisor loop."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False
    try:
        done, _status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            return False  # our own child, now reaped
    except ChildProcessError:
        pass
    cmd = _cmdline(pid)
    if not cmd:
        return False
    return ("supervisor.py" in cmd and " run " in cmd + " "
            and os.path.realpath(tree) in cmd)


def status(tree):
    doc = _read_state(tree)
    pid = doc.get("pid")
    running = _is_our_loop(pid, tree)
    return {"method": doc.get("method", "loop"),
            "installed": bool(doc.get("installed")),
            "running": running, "pid": pid if running else None}


def mark_installed(tree):
    """Record that this tree is supervised by the loop (install.sh)."""
    with _Lock(tree):
        doc = _read_state(tree)
        doc.update({"method": "loop", "installed": True})
        _write_state(tree, doc)


def ensure(tree, interval=INTERVAL_SECONDS, first_delay=None):
    """Start this tree's loop unless it already runs. One loop per tree."""
    tree = os.path.realpath(tree)
    first_delay = interval if first_delay is None else first_delay
    with _Lock(tree):
        doc = _read_state(tree)
        pid = doc.get("pid")
        if _is_our_loop(pid, tree):
            return {"method": "loop", "started": False, "pid": pid}
        state_dir = _state_dir(tree)
        log = open(os.path.join(state_dir, LOG_NAME), "a")
        try:
            proc = subprocess.Popen(
                [sys.executable, os.path.join(_helper_dir(tree),
                                              "supervisor.py"),
                 "run", "--tree", tree, "--state-dir", state_dir,
                 "--interval", str(interval),
                 "--first-delay", str(first_delay)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                start_new_session=True, close_fds=True)
        finally:
            log.close()
        doc.update({"method": "loop", "installed": True, "pid": proc.pid,
                    "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                time.gmtime())})
        _write_state(tree, doc)
        return {"method": "loop", "started": True, "pid": proc.pid}


def ensure_if_installed(tree, interval=INTERVAL_SECONDS, first_delay=None):
    """Restart the loop only when install chose loop supervision for
    this tree and it is not running (after a reboot). Else None."""
    if not os.environ.get("MORROW_TREE_STATE_DIR") and not os.path.isfile(
            os.path.join(os.path.realpath(tree), ".morrow-tree-id")):
        return None  # install.sh mints the id on every install
    doc = _read_state(tree)
    if doc.get("method") != "loop" or not doc.get("installed"):
        return None
    if _is_our_loop(doc.get("pid"), tree):
        return None
    return ensure(tree, interval=interval, first_delay=first_delay)


def _group_alive(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _reap(pid):
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass


def _signal_loop(pid, pgid, sig):
    if pgid is not None:
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
    else:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def _loop_gone(pid, pgid):
    _reap(pid)
    return not (_group_alive(pgid) if pgid is not None else _is_alive(pid))


def _is_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _end_loop(pid, tree):
    """End this tree's loop pid and its process group (TERM, then KILL
    after five seconds) and wait until it is gone. False when pid is
    not this tree's loop."""
    if not _is_our_loop(pid, tree):
        return False
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        pgid = None
    if pgid != pid or pgid == os.getpgrp():
        pgid = None  # never signal a group the loop does not lead
    _signal_loop(pid, pgid, signal.SIGTERM)
    for _ in range(50):
        if _loop_gone(pid, pgid):
            break
        time.sleep(0.1)
    if not _loop_gone(pid, pgid):
        _signal_loop(pid, pgid, signal.SIGKILL)
        for _ in range(50):
            if _loop_gone(pid, pgid):
                break
            time.sleep(0.1)
    return True


def _move_log(src, dest):
    """Move src to dest; when dest already exists, append src to it."""
    if not os.path.exists(dest):
        shutil.move(src, dest)
        return
    with open(src, "rb") as fin, open(dest, "ab") as fout:
        shutil.copyfileobj(fin, fout)
    os.unlink(src)


def retire_legacy(tree):
    """Move an older release's runtime files out of <tree>/helper/.

    A loop recorded in the old state file reads only that file, so it
    is stopped here and its install choice is carried into the state
    dir (ensure starts a new loop). The logs move into the state dir,
    appended when a log of that name already exists there."""
    tree = os.path.realpath(tree)
    helper = _helper_dir(tree)
    legacy_state = os.path.join(helper, STATE_NAME)
    stopped = None
    try:
        names = os.listdir(helper)
    except OSError:
        names = []
    if not any(_LEGACY_RUNTIME.match(name) for name in names):
        return {"stopped_loop": None, "moved": []}
    with _Lock(tree):
        if os.path.isfile(legacy_state):
            old = _read_json(legacy_state)
            if _end_loop(old.get("pid"), tree):
                stopped = old.get("pid")
            doc = _read_state(tree)
            if old.get("installed") and not doc.get("installed"):
                doc.update({"method": old.get("method", "loop"),
                            "installed": True, "pid": doc.get("pid")})
                _write_state(tree, doc)
        state_dir = _state_dir(tree)
        moved = []
        for name in sorted(os.listdir(helper)):
            src = os.path.join(helper, name)
            if not _LEGACY_RUNTIME.match(name) or not os.path.isfile(src) \
                    or os.path.islink(src):
                continue
            if name.startswith(STATE_NAME):
                os.unlink(src)
            else:
                _move_log(src, os.path.join(state_dir, name))
            moved.append("helper/" + name)
    return {"stopped_loop": stopped, "moved": moved}


def stop(tree, forget=False):
    """Stop this tree's loop (exact PID, verified to be ours) and every
    process in its session: a keepalive run in progress would otherwise
    finish after stop and relaunch the helper. The loop starts its own
    session (ensure), so its process group id is its PID; the group
    gets SIGTERM, then SIGKILL after five seconds, and stop waits until
    the group is gone. With forget=True the loop is also no longer
    installed."""
    tree = os.path.realpath(tree)
    with _Lock(tree):
        doc = _read_state(tree)
        pid = doc.get("pid")
        stopped = _end_loop(pid, tree)
        doc["pid"] = None
        if forget:
            try:
                os.unlink(_state_path(tree))
            except OSError:
                pass
        elif doc:
            _write_state(tree, doc)
    return {"stopped": stopped, "pid": pid if stopped else None}


def run(tree, state_dir, interval=INTERVAL_SECONDS,
        first_delay=INTERVAL_SECONDS):
    """The loop: run keepalive.sh every interval seconds while this
    process is the tree's recorded loop and the tree exists. ensure
    passes the state dir, so the loop never resolves it again."""
    tree = os.path.realpath(tree)
    me = os.getpid()
    deadline = time.time() + 10
    while _read_state(tree, state_dir).get("pid") != me:
        if time.time() > deadline:
            return 0  # never recorded: another loop won the start
        time.sleep(0.05)
    time.sleep(max(0.0, first_delay))
    while True:
        if _read_state(tree, state_dir).get("pid") != me:
            return 0  # stopped or superseded
        keepalive = _keepalive(tree)
        if not os.path.isfile(keepalive):
            return 0  # the tree is gone
        try:
            subprocess.run([keepalive], stdin=subprocess.DEVNULL,
                           timeout=max(600, interval * 2))
        except (OSError, subprocess.SubprocessError) as exc:
            sys.stderr.write("supervisor: keepalive run failed: %s\n" % exc)
            sys.stderr.flush()
        time.sleep(max(0.05, interval))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("command", choices=(
        "detect", "install-loop", "ensure", "ensure-if-installed", "status",
        "stop", "uninstall", "retire-legacy", "run"))
    parser.add_argument("--tree", default=os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))))
    parser.add_argument("--state-dir", default=None)
    parser.add_argument("--interval", type=float, default=INTERVAL_SECONDS)
    parser.add_argument("--first-delay", type=float, default=None)
    args = parser.parse_args(argv)
    if args.command == "detect":
        print(detect())
        return 0
    if args.command == "run":
        first = args.interval if args.first_delay is None \
            else args.first_delay
        return run(args.tree, args.state_dir or _state_dir(args.tree),
                   args.interval, first)
    if args.command == "install-loop":
        mark_installed(args.tree)
        out = ensure(args.tree, args.interval, args.first_delay)
    elif args.command == "ensure":
        out = ensure(args.tree, args.interval, args.first_delay)
    elif args.command == "ensure-if-installed":
        out = ensure_if_installed(args.tree, args.interval, args.first_delay)
    elif args.command == "status":
        out = status(args.tree)
    elif args.command == "retire-legacy":
        out = retire_legacy(args.tree)
    else:
        out = stop(args.tree, forget=(args.command == "uninstall"))
    print(json.dumps(out, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
