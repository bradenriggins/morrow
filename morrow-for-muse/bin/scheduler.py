#!/usr/bin/env python3
"""Morrow keepalive scheduler: runs the Canvas and Moodle keepalives.

Canvas: once daily. Moodle: every 6 hours (dormant until a session bundle
exists; the script exits 0 and logs IDLE in that case).

This is a userspace scheduler because the VM has no cron daemon and only
/home/hatch survives restarts. It persists under the deploy directory.

Usage:
  scheduler.py start    # daemonize (writes pid file, logs to logs/)
  scheduler.py stop     # stop the daemon
  scheduler.py status   # check if running
  scheduler.py run-once # run both keepalives immediately (for testing)

After a VM restart, re-run `scheduler.py start`. The pid file is stale-checked.
"""
import os
import sys
import time
import json
import subprocess
import signal
from datetime import datetime, timezone

DEPLOY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN_DIR = os.path.join(DEPLOY_DIR, "bin")
LOG_DIR = os.path.join(DEPLOY_DIR, "logs")
PID_FILE = os.path.join(DEPLOY_DIR, "logs", "scheduler.pid")
SCHED_LOG = os.path.join(DEPLOY_DIR, "logs", "scheduler.log")

CANVAS_SCRIPT = os.path.join(BIN_DIR, "keepalive-canvas.sh")
MOODLE_SCRIPT = os.path.join(BIN_DIR, "keepalive-moodle.sh")

CANVAS_INTERVAL = 24 * 3600   # daily
MOODLE_INTERVAL = 6 * 3600    # every 6 hours

# W5-P2-2: scheduler.log rotation. Copy-truncate (not rename) so the
# daemon's long-held stdout/stderr fd (O_APPEND, dup2'd at start) keeps
# writing to the same inode after a rotation.
SCHED_LOG_MAX_BYTES = 1 * 1024 * 1024
SCHED_LOG_KEEP = 3


def _rotate_sched_log():
    try:
        if os.path.getsize(SCHED_LOG) <= SCHED_LOG_MAX_BYTES:
            return
    except OSError:
        return
    try:
        oldest = "%s.%d" % (SCHED_LOG, SCHED_LOG_KEEP)
        try:
            os.remove(oldest)
        except OSError:
            pass
        for i in range(SCHED_LOG_KEEP - 1, 0, -1):
            src = "%s.%d" % (SCHED_LOG, i)
            dst = "%s.%d" % (SCHED_LOG, i + 1)
            try:
                os.replace(src, dst)
            except OSError:
                pass
        import shutil
        shutil.copyfile(SCHED_LOG, SCHED_LOG + ".1")
        with open(SCHED_LOG, "r+b") as fh:
            fh.truncate(0)
    except OSError:
        pass


def log(msg):
    _rotate_sched_log()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"{ts} [scheduler] {msg}\n"
    with open(SCHED_LOG, "a", encoding="utf-8") as fh:
        fh.write(line)
    print(line, end="")


def run_keepalive(name, script):
    log(f"running {name} keepalive")
    try:
        proc = subprocess.run(
            ["bash", script],
            capture_output=True, text=True, timeout=300)
        log(f"{name} keepalive exit={proc.returncode}")
        if proc.returncode not in (0,):
            # Nonzero is already logged by the script itself; note it here.
            log(f"{name} keepalive nonzero exit: {proc.returncode}")
        return proc.returncode
    except subprocess.TimeoutExpired:
        log(f"{name} keepalive TIMED OUT after 300s")
        return 99
    except Exception as e:
        log(f"{name} keepalive failed to start: {type(e).__name__}: {e}")
        return 98


def daemon_loop():
    # Stagger first runs: Canvas in 60s (so a manual start proves quickly),
    # Moodle in 120s. Then each on its own interval.
    # W5-P2-1: interval math on the monotonic clock. Wall-clock jumps
    # (NTP step, VM suspend/resume) must not fire keepalives early or
    # stall them for hours.
    next_canvas = time.monotonic() + 60
    next_moodle = time.monotonic() + 120
    log(f"scheduler started (pid {os.getpid()}); "
        f"canvas every {CANVAS_INTERVAL}s, moodle every {MOODLE_INTERVAL}s")
    while True:
        now = time.monotonic()
        if now >= next_canvas:
            run_keepalive("canvas", CANVAS_SCRIPT)
            next_canvas = now + CANVAS_INTERVAL
        if now >= next_moodle:
            run_keepalive("moodle", MOODLE_SCRIPT)
            next_moodle = now + MOODLE_INTERVAL
        # Sleep until the next due time (capped at 60s for responsiveness).
        wake = min(next_canvas, next_moodle)
        time.sleep(max(1, min(60, wake - time.monotonic())))


def is_running():
    if not os.path.exists(PID_FILE):
        return None
    try:
        with open(PID_FILE, "r", encoding="utf-8") as fh:
            pid = int(fh.read().strip())
    except (ValueError, OSError):
        return None
    try:
        os.kill(pid, 0)
        return pid
    except (OSError, ProcessLookupError):
        return None


def cmd_start():
    pid = is_running()
    if pid:
        print(f"scheduler already running (pid {pid})")
        return
    # Daemonize with double fork.
    if os.fork() > 0:
        sys.exit(0)
    os.setsid()
    if os.fork() > 0:
        sys.exit(0)
    sys.stdout.flush()
    sys.stderr.flush()
    with open(os.devnull, "r") as dn:
        os.dup2(dn.fileno(), sys.stdin.fileno())
    with open(SCHED_LOG, "a", encoding="utf-8") as out:
        os.dup2(out.fileno(), sys.stdout.fileno())
        os.dup2(out.fileno(), sys.stderr.fileno())
    with open(PID_FILE, "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))
    try:
        daemon_loop()
    finally:
        try:
            os.remove(PID_FILE)
        except OSError:
            pass


def cmd_stop():
    pid = is_running()
    if not pid:
        print("scheduler not running")
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(20):
        time.sleep(0.25)
        if not is_running():
            print("scheduler stopped")
            return
    print(f"scheduler pid {pid} did not stop; kill -9 it manually")


def cmd_status():
    pid = is_running()
    if pid:
        print(f"scheduler running (pid {pid})")
        # Show last few log lines.
        try:
            with open(SCHED_LOG, "r", encoding="utf-8") as fh:
                lines = fh.readlines()[-5:]
            for l in lines:
                print("  " + l.rstrip())
        except OSError:
            pass
    else:
        print("scheduler not running")


def cmd_run_once():
    run_keepalive("canvas", CANVAS_SCRIPT)
    run_keepalive("moodle", MOODLE_SCRIPT)


if __name__ == "__main__":
    os.makedirs(LOG_DIR, exist_ok=True)
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    # W6-P2-E1/H2: --help/-h print usage; an unknown command prints
    # usage to stderr and exits 2. The old bare dict lookup raised
    # KeyError with a full traceback, leaking internal absolute
    # paths on a typo.
    if cmd in ("--help", "-h", "help"):
        print(__doc__.strip())
        sys.exit(0)
    commands = {"start": cmd_start, "stop": cmd_stop, "status": cmd_status,
                "run-once": cmd_run_once}
    if cmd not in commands:
        print("unknown command %r" % (cmd,), file=sys.stderr)
        print(__doc__.strip(), file=sys.stderr)
        sys.exit(2)
    commands[cmd]()
