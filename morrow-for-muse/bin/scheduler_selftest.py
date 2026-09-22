#!/usr/bin/env python3
"""Selftest for bin/scheduler.py log rotation (W5-P2-2).

Covers: under-cap logs are untouched; over-cap logs are copy-truncated
(the daemon's long-held fd keeps writing to the same inode); archives
shift .1 -> .2 -> .3 with the oldest dropped; only SCHED_LOG_KEEP
archives survive.

Run: python3 bin/scheduler_selftest.py
"""
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


if __name__ == "__main__":
    main()
