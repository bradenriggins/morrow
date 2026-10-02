#!/usr/bin/env python3
"""Selftest for bin/scheduler.py log rotation (W5-P2-2).

Covers: under-cap logs are untouched; over-cap logs are copy-truncated
(the daemon's long-held fd keeps writing to the same inode); archives
shift .1 -> .2 -> .3 with the oldest dropped; only SCHED_LOG_KEEP
archives survive.

Run: python3 bin/scheduler_selftest.py
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import os
import shutil
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "..", "bin"))
import scheduler as sched

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    ".selftest-work", "scheduler-rotation")

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


def main():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)
    sched.SCHED_LOG = os.path.join(WORK, "scheduler.log")
    sched.SCHED_LOG_MAX_BYTES = 100
    sched.SCHED_LOG_KEEP = 3

    # 1. Under-cap log is untouched.
    with open(sched.SCHED_LOG, "w", encoding="utf-8") as fh:
        fh.write("small\n")
    sched._rotate_sched_log()
    with open(sched.SCHED_LOG, encoding="utf-8") as fh:
        check("W5-P2-2: under-cap log untouched", fh.read() == "small\n")

    # 2. Over-cap: copy-truncate, content archived to .1, .1 -> .2.
    with open(sched.SCHED_LOG, "w", encoding="utf-8") as fh:
        fh.write("x" * 200)
    with open(sched.SCHED_LOG + ".1", "w", encoding="utf-8") as fh:
        fh.write("old1\n")
    with open(sched.SCHED_LOG + ".2", "w", encoding="utf-8") as fh:
        fh.write("old2\n")
    sched._rotate_sched_log()
    with open(sched.SCHED_LOG, encoding="utf-8") as fh:
        check("W5-P2-2: over-cap log truncated", fh.read() == "")
    with open(sched.SCHED_LOG + ".1", encoding="utf-8") as fh:
        check("W5-P2-2: content archived to .1", fh.read() == "x" * 200)
    with open(sched.SCHED_LOG + ".2", encoding="utf-8") as fh:
        check("W5-P2-2: .1 shifts to .2", fh.read() == "old1\n")
    with open(sched.SCHED_LOG + ".3", encoding="utf-8") as fh:
        check("W5-P2-2: .2 shifts to .3", fh.read() == "old2\n")

    # 3. Copy-truncate preserves the inode (the daemon's dup2'd
    # stdout/stderr fd keeps working after rotation).
    ino_before = os.stat(sched.SCHED_LOG).st_ino
    with open(sched.SCHED_LOG, "w", encoding="utf-8") as fh:
        fh.write("y" * 200)
    sched._rotate_sched_log()
    ino_after = os.stat(sched.SCHED_LOG).st_ino
    check("W5-P2-2: rotation preserves inode (copy-truncate)",
          ino_before == ino_after)

    # 4. Only SCHED_LOG_KEEP archives survive.
    with open(sched.SCHED_LOG, "w", encoding="utf-8") as fh:
        fh.write("z" * 200)
    sched._rotate_sched_log()
    archives = [p for p in os.listdir(WORK)
                if p.startswith("scheduler.log.")]
    check("W5-P2-2: only KEEP archives survive",
          sorted(archives) == ["scheduler.log.1", "scheduler.log.2",
                               "scheduler.log.3"],
          repr(sorted(archives)))

    # 5. Missing log: no crash.
    os.remove(sched.SCHED_LOG)
    try:
        sched._rotate_sched_log()
        check("W5-P2-2: missing log does not raise", True)
    except Exception as e:  # noqa: BLE001
        check("W5-P2-2: missing log does not raise", False, repr(e))

    shutil.rmtree(WORK, ignore_errors=True)

    _t_wave6_cli_behavior()
    _t_s4_pid_identity()

    print("pass: %d" % len(PASS))
    for name in PASS:
        print("  ok %s" % name)
    if FAIL:
        print("FAIL: %d" % len(FAIL))
        for name in FAIL:
            print("  FAIL %s" % name)
        sys.exit(1)
    print("all scheduler selftests passed")


def _t_wave6_cli_behavior():
    """W6-P2-E1/H2: CLI behavior via subprocess (real exit codes/streams).

    E1: an unknown command must not raise a bare KeyError with a
    traceback (which leaked absolute paths); it prints a concise
    error plus usage to stderr and exits 2.
    H2: --help/-h/help print usage and exit 0.
    """
    import subprocess
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "scheduler.py")

    def run(*args):
        return subprocess.run([sys.executable, script] + list(args),
                              capture_output=True, text=True, timeout=60)

    for flag in ("--help", "-h", "help"):
        p = run(flag)
        check("w6p2h2: %s exits 0" % flag, p.returncode == 0,
              "exit=%d" % p.returncode)
        check("w6p2h2: %s prints usage" % flag,
              "usage" in p.stdout.lower() or "scheduler" in p.stdout.lower(),
              p.stdout[:80])
        check("w6p2h2: %s emits no traceback" % flag,
              "Traceback" not in p.stdout and "Traceback" not in p.stderr)

    p = run("frobnicate")
    check("w6p2e1: unknown command exits 2", p.returncode == 2,
          "exit=%d" % p.returncode)
    check("w6p2e1: unknown command names the bad command on stderr",
          "frobnicate" in p.stderr, p.stderr[:120])
    check("w6p2e1: unknown command prints usage to stderr",
          "usage" in p.stderr.lower() or "scheduler" in p.stderr.lower(),
          p.stderr[:120])
    check("w6p2e1: unknown command emits no traceback",
          "Traceback" not in p.stdout and "Traceback" not in p.stderr)
    check("w6p2e1: unknown command leaks no traceback frames",
          'File "' not in p.stderr and "line " not in p.stderr,
          p.stderr[:200])


def _t_s4_pid_identity():
    """S4: a pid file is not identity; only a live `scheduler.py
    start` process counts as running.

    A recycled pid (this selftest's own live pid, which is not the
    daemon) must not make is_running() claim the scheduler runs, and
    cmd_stop must not signal it. A dead pid must read as stopped.
    """
    import subprocess
    work = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        ".selftest-work", "scheduler-pid")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    real_pid_file = sched.PID_FILE
    sched.PID_FILE = os.path.join(work, "scheduler.pid")
    try:
        # 1. Our own live pid is not the daemon: the old kill(pid, 0)
        # check claimed it was running.
        with open(sched.PID_FILE, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
        check("s4: live foreign pid is not running",
              sched.is_running() is None, repr(sched.is_running()))

        # 2. A spawned sleep is not the daemon either.
        proc = subprocess.Popen(["sleep", "30"])
        try:
            with open(sched.PID_FILE, "w", encoding="utf-8") as fh:
                fh.write(str(proc.pid))
            check("s4: spawned foreign pid is not running",
                  sched.is_running() is None, repr(sched.is_running()))
        finally:
            proc.terminate()
            proc.wait()

        # 3. A dead pid reads as stopped.
        with open(sched.PID_FILE, "w", encoding="utf-8") as fh:
            fh.write("424242")
        check("s4: dead pid is not running",
              sched.is_running() is None, repr(sched.is_running()))

        # 4. A live `scheduler.py start` cmdline IS the daemon (the
        # cmdline reader is stubbed; liveness is this real process).
        real_reader = sched._read_cmdline
        sched._read_cmdline = lambda pid: "%s /x/scheduler.py start" \
            % sys.executable
        try:
            with open(sched.PID_FILE, "w", encoding="utf-8") as fh:
                fh.write(str(os.getpid()))
            check("s4: live scheduler cmdline is running",
                  sched.is_running() == os.getpid(),
                  repr(sched.is_running()))
            # ... but a transient `scheduler.py status` is not.
            sched._read_cmdline = lambda pid: "%s /x/scheduler.py status" \
                % sys.executable
            check("s4: transient scheduler.py status is not running",
                  sched.is_running() is None, repr(sched.is_running()))
        finally:
            sched._read_cmdline = real_reader

        # 5. cmd_stop refuses to signal a foreign pid.
        with open(sched.PID_FILE, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            sched.cmd_stop()
        check("s4: stop on a foreign pid signals nothing",
              "not running" in buf.getvalue(), buf.getvalue()[:120])
    finally:
        sched.PID_FILE = real_pid_file
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
