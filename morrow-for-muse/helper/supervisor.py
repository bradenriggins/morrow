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

State lives in <tree>/helper/keepalive-supervisor.json: {"method":
"loop", "installed": true, "pid": <loop pid or null>}. The loop's log
is <tree>/helper/keepalive-supervisor.log.

CLI (prints one JSON object, or one word for detect):
  supervisor.py detect                 "cron" or "loop"
  supervisor.py install-loop           record loop supervision, start it
  supervisor.py ensure                 start the loop if it is not running
  supervisor.py ensure-if-installed    restart it only if install chose it
  supervisor.py status
  supervisor.py stop                   stop the loop (still installed)
  supervisor.py uninstall              stop the loop and forget it
  supervisor.py run --tree T ...       the loop itself (started by ensure)

Stdlib only.
"""

import argparse
import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import time

INTERVAL_SECONDS = 300
STATE_NAME = "keepalive-supervisor.json"
LOG_NAME = "keepalive-supervisor.log"
_CRON_DAEMONS = frozenset({"cron", "crond", "cronie"})


def _helper_dir(tree):
    return os.path.join(os.path.realpath(tree), "helper")


def _state_path(tree):
    return os.path.join(_helper_dir(tree), STATE_NAME)


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


def _read_state(tree):
    try:
        with open(_state_path(tree), "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _write_state(tree, doc):
    path = _state_path(tree)
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
        log = open(os.path.join(_helper_dir(tree), LOG_NAME), "a")
        try:
            proc = subprocess.Popen(
                [sys.executable, os.path.join(_helper_dir(tree),
                                              "supervisor.py"),
                 "run", "--tree", tree, "--interval", str(interval),
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
    doc = _read_state(tree)
    if doc.get("method") != "loop" or not doc.get("installed"):
        return None
    if _is_our_loop(doc.get("pid"), tree):
        return None
    return ensure(tree, interval=interval, first_delay=first_delay)


def stop(tree, forget=False):
    """Stop this tree's loop (exact PID, verified to be ours). With
    forget=True the loop is also no longer installed."""
    tree = os.path.realpath(tree)
    with _Lock(tree):
        doc = _read_state(tree)
        pid = doc.get("pid")
        stopped = False
        if _is_our_loop(pid, tree):
            os.kill(pid, signal.SIGTERM)
            for _ in range(50):
                if not _is_our_loop(pid, tree):
                    break
                time.sleep(0.1)
            if _is_our_loop(pid, tree):
                os.kill(pid, signal.SIGKILL)
            stopped = True
        doc["pid"] = None
        if forget:
            try:
                os.unlink(_state_path(tree))
            except OSError:
                pass
        elif doc:
            _write_state(tree, doc)
    return {"stopped": stopped, "pid": pid if stopped else None}


def run(tree, interval=INTERVAL_SECONDS, first_delay=INTERVAL_SECONDS):
    """The loop: run keepalive.sh every interval seconds while this
    process is the tree's recorded loop and the tree exists."""
    tree = os.path.realpath(tree)
    me = os.getpid()
    deadline = time.time() + 10
    while _read_state(tree).get("pid") != me:
        if time.time() > deadline:
            return 0  # never recorded: another loop won the start
        time.sleep(0.05)
    time.sleep(max(0.0, first_delay))
    while True:
        if _read_state(tree).get("pid") != me:
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
        "stop", "uninstall", "run"))
    parser.add_argument("--tree", default=os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))))
    parser.add_argument("--interval", type=float, default=INTERVAL_SECONDS)
    parser.add_argument("--first-delay", type=float, default=None)
    args = parser.parse_args(argv)
    if args.command == "detect":
        print(detect())
        return 0
    if args.command == "run":
        first = args.interval if args.first_delay is None \
            else args.first_delay
        return run(args.tree, args.interval, first)
    if args.command == "install-loop":
        mark_installed(args.tree)
        out = ensure(args.tree, args.interval, args.first_delay)
    elif args.command == "ensure":
        out = ensure(args.tree, args.interval, args.first_delay)
    elif args.command == "ensure-if-installed":
        out = ensure_if_installed(args.tree, args.interval, args.first_delay)
    elif args.command == "status":
        out = status(args.tree)
    else:
        out = stop(args.tree, forget=(args.command == "uninstall"))
    print(json.dumps(out, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
