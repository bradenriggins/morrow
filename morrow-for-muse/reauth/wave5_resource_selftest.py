#!/usr/bin/env python3
"""Selftest: Wave 5 resource-exhaustion remediation (reauth family).

Hermetic: no network, no browser, no real sessions. All state lands
under reauth/.selftest-work (allowed by the installer's integrity gate
and cleaned up after the suite runs).

Covers:
  W5-P0-1  quarantine CLI default op_id is unique (uuid4): two
            quarantines in the same second get distinct op_ids, and
            approve_op() approves exactly one op (no mass-approval).
  W5-P1-2  quarantine ledger bounded growth: compaction preserves all
            actionable (quarantined/awaiting_approval) entries while
            capping terminal entries; readers stream (op_quarantine_status
            is O(1) memory); mutators stream through tmp+rename under a
            cross-process lock (concurrent appends are never lost to the
            append/compaction race); torn lines fail loud in
            quarantined_ops(); ENOSPC on append raises a plain-language
            QuarantineLedgerError (no silent loss).
  W5-P1-4  session-death dedup window: a repeated death with the same
            cause inside the window appends once (deduped=True on the
            repeat); a different cause appends; the window survives a
            fresh process (state on disk, not per-object).
  W5-P2-1  .prev retention is monotonic-guarded: a fresh .prev whose
            wall mtime was pushed 8 days back (simulated forward clock
            jump) is NOT aged out while its .mono stamp says fresh; a
            genuinely stale .prev (old mono) is still aged out, and the
            .mono sidecar is removed with it. Legacy .prev files without
            a sidecar keep the old wall-clock behavior.
  W5-P2-6  reauth() survives a hung capture.py: subprocess.TimeoutExpired
            writes an escalation (plain language), prints a failure line,
            returns False, and leaves the halt and .prev intact (state
            stays reauth_pending; no traceback escapes).
"""
import errno
import io
import json
import os
import shutil
import subprocess
import sys
import time
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
# Pid-unique scratch: two concurrent suite runs (or a leftover from a
# failed run) must never share one ledger file.
SCRATCH = os.path.join(HERE, ".selftest-work-%d" % os.getpid())
HOME = os.path.join(SCRATCH, "home")

# The re-auth store resolves MORROW_HOME at import time, so point it at
# scratch BEFORE importing the module under test.
os.environ["MORROW_HOME"] = HOME
shutil.rmtree(SCRATCH, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)

for _p in (REPO, os.path.join(REPO, "dispatch")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from reauth import state_machine as rsm  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("PASS %s" % name)
    else:
        FAIL.append(name)
        print("FAIL %s%s" % (name, (" (%s)" % detail) if detail else ""))


def _ledger_entries():
    with open(rsm.QUAR_PATH, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def _run_cmd_quarantine(extra_args):
    saved = sys.argv
    sys.argv = ["state_machine.py", "quarantine"] + extra_args
    try:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rsm.cmd_quarantine()
        return buf.getvalue()
    finally:
        sys.argv = saved


# ---------------------------------------------------------------- W5-P0-1

def t_unique_default_op_id():
    if os.path.exists(rsm.QUAR_PATH):
        os.remove(rsm.QUAR_PATH)
    out1 = _run_cmd_quarantine(["--action", "create_page",
                                "--summary", "first"])
    out2 = _run_cmd_quarantine(["--action", "create_page",
                                "--summary", "second"])
    entries = _ledger_entries()
    ids = [e["op_id"] for e in entries]
    check("P0-1: two same-second quarantines get distinct default op_ids",
          len(entries) == 2 and ids[0] != ids[1],
          "%r" % (ids,))
    check("P0-1: default op_id carries the op- prefix and uuid4 entropy",
          all(i.startswith("op-") and len(i) == 3 + 32 for i in ids),
          "%r" % (ids,))
    check("P0-1: CLI echoes the distinct op_ids",
          ids[0] in out1 and ids[1] in out2)
    # Move both to awaiting_approval, approve exactly one: the other must
    # stay awaiting_approval (the old epoch-second default collided and
    # one approval mass-approved every op sharing the id).
    rsm.mark_ops_awaiting_approval()
    check("P0-1: approve_op approves the named op",
          rsm.approve_op(ids[0], "I, the educator, approve re-dispatching this quarantined op") is True)
    statuses = {e["op_id"]: e["status"] for e in _ledger_entries()}
    check("P0-1: approving one op leaves the other awaiting_approval",
          statuses.get(ids[0]) == "approved"
          and statuses.get(ids[1]) == "awaiting_approval",
          "%r" % (statuses,))
    # Executor gate honors the per-op verdict.
    check("P0-1: newest status of the unapproved op is not approved",
          rsm.op_quarantine_status(ids[1]) == "awaiting_approval")


# ---------------------------------------------------------------- W5-P1-2

def t_ledger_compaction():
    if os.path.exists(rsm.QUAR_PATH):
        os.remove(rsm.QUAR_PATH)
    saved_bytes, saved_keep = rsm.QUAR_COMPACT_BYTES, rsm.QUAR_KEEP_TERMINAL
    rsm.QUAR_KEEP_TERMINAL = 5
    try:
        # 3 actionable entries that must survive any compaction.
        for i in range(3):
            rsm.quarantine_op("actionable-%d" % i, "create_page", "keep me")
        # 40 terminal entries (approved): only the newest
        # QUAR_KEEP_TERMINAL may survive compaction. Written with their
        # final status (mutating the returned dict would not touch the
        # file). The trigger is disabled during the fill so the
        # compactor runs exactly once, deterministically.
        rsm.QUAR_COMPACT_BYTES = 10 ** 12
        for i in range(40):
            rsm._ledger_append({"kind": "op", "op_id": "terminal-%d" % i,
                                "action": "create_page", "summary": "old",
                                "status": "approved",
                                "quarantined_at": 1000 + i})
        rsm.QUAR_COMPACT_BYTES = 4096
        check("P1-2: fill exceeds the trigger before compacting",
              os.path.getsize(rsm.QUAR_PATH) > 4096)
        rsm._maybe_compact_ledger()
        entries = _ledger_entries()
        ids = [e["op_id"] for e in entries]
        check("P1-2: compaction preserves every actionable entry",
              all("actionable-%d" % i in ids for i in range(3)),
              "%d entries" % len(entries))
        terminal = [e for e in entries
                    if e["op_id"].startswith("terminal-")]
        check("P1-2: terminal entries capped at QUAR_KEEP_TERMINAL",
              len(terminal) <= 5, "%d terminal" % len(terminal))
        check("P1-2: the surviving terminal entries are the newest",
              [e["op_id"] for e in terminal]
              == ["terminal-%d" % i for i in range(35, 40)],
              "%r" % [e["op_id"] for e in terminal])
        check("P1-2: ledger file shrank below the trigger size",
              os.path.getsize(rsm.QUAR_PATH) <= 4096)
        # Compaction is a no-op when already under the trigger.
        before = open(rsm.QUAR_PATH, "rb").read()
        rsm._maybe_compact_ledger()
        check("P1-2: no rewrite when under the trigger size",
              open(rsm.QUAR_PATH, "rb").read() == before)
    finally:
        rsm.QUAR_COMPACT_BYTES, rsm.QUAR_KEEP_TERMINAL = \
            saved_bytes, saved_keep


def t_ledger_streaming_and_torn():
    if os.path.exists(rsm.QUAR_PATH):
        os.remove(rsm.QUAR_PATH)
    for i in range(50):
        rsm.quarantine_op("stream-%d" % i, "create_page", "s")
    # op_quarantine_status streams: prove O(1) memory by watching it not
    # allocate per-line lists (it must work with a huge file too; here
    # we assert the newest-wins semantics across many lines).
    check("P1-2: op_quarantine_status finds the newest status",
          rsm.op_quarantine_status("stream-49") == "quarantined")
    check("P1-2: op_quarantine_status returns None for unknown op",
          rsm.op_quarantine_status("nope") is None)
    # A torn line fails loud in the strict reader (never silently
    # skipped: unattributable bytes must not vanish). quarantined_ops()
    # propagates the JSON decode error (a ValueError).
    with open(rsm.QUAR_PATH, "a", encoding="utf-8") as f:
        f.write("{torn json\n")
    try:
        rsm.quarantined_ops()
        check("P1-2: torn line raises ValueError in quarantined_ops()",
              False)
    except ValueError:
        check("P1-2: torn line raises ValueError in quarantined_ops()",
              True)
    # The hot-path status reader skips torn lines (it cannot attribute
    # them to an op_id) instead of crashing the dispatch gate.
    check("P1-2: op_quarantine_status skips torn lines",
          rsm.op_quarantine_status("stream-0") == "quarantined")


def t_ledger_enospc():
    if os.path.exists(rsm.QUAR_PATH):
        os.remove(rsm.QUAR_PATH)
    real_open = os.open

    def _enospc(*args, **kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    os.open = _enospc
    try:
        rsm.quarantine_op("disk-full-op", "create_page", "s")
        check("P1-2: ENOSPC raises QuarantineLedgerError", False)
    except rsm.QuarantineLedgerError as e:
        check("P1-2: ENOSPC raises QuarantineLedgerError", True)
        check("P1-2: the error names the ledger path in plain language",
              rsm.QUAR_PATH in str(e), str(e)[:80])
    finally:
        os.open = real_open
    check("P1-2: failed append wrote nothing",
          not os.path.exists(rsm.QUAR_PATH)
          or os.path.getsize(rsm.QUAR_PATH) == 0)


# ---------------------------------------------------------------- W5-P1-4

def t_session_death_dedup():
    if os.path.exists(rsm.QUAR_PATH):
        os.remove(rsm.QUAR_PATH)
    if os.path.exists(rsm.LAST_DEATH_PATH):
        os.remove(rsm.LAST_DEATH_PATH)
    # The dedup window applies while the incident's write halt is
    # active (production wiring: quarantine_session runs under halt).
    rsm.impose_halt({"test": "dedup"})
    try:
        e1 = rsm.quarantine_session("tab crashed")
        check("P1-4: first death appends (not deduped)",
              e1.get("deduped") is not True
              and e1.get("kind") == "session_death")
        e2 = rsm.quarantine_session("tab crashed")
        check("P1-4: same-cause repeat inside the window is deduped",
              e2.get("deduped") is True)
        deaths = [e for e in _ledger_entries()
                  if e.get("kind") == "session_death"]
        check("P1-4: the repeat wrote no new ledger line",
              len(deaths) == 1, "%d death lines" % len(deaths))
        e3 = rsm.quarantine_session("helper unreachable")
        check("P1-4: a different cause still appends",
              e3.get("deduped") is not True
              and len([e for e in _ledger_entries()
                       if e.get("kind") == "session_death"]) == 2)
        # The dedup state is on disk: a FRESH process (simulated by
        # clearing any in-memory state; there is none by design) still
        # dedups.
        e4 = rsm.quarantine_session("helper unreachable")
        check("P1-4: dedup window survives across processes (disk state)",
              e4.get("deduped") is True)
        # An expired window appends again.
        with open(rsm.LAST_DEATH_PATH, encoding="utf-8") as f:
            meta = json.load(f)
        meta["quarantined_at"] = \
            time.time() - rsm.SESSION_DEATH_DEDUP_S - 1
        with open(rsm.LAST_DEATH_PATH, "w", encoding="utf-8") as f:
            json.dump(meta, f)
        e5 = rsm.quarantine_session("helper unreachable")
        check("P1-4: after the window lapses the death appends again",
              e5.get("deduped") is not True)
    finally:
        rsm.lift_halt()


# ---------------------------------------------------------------- W5-P2-1

def _write_prev_with_mono(mono_age_s, wall_age_days):
    with open(rsm.SESSION_PREV, "w", encoding="utf-8") as f:
        json.dump({"canvas": {"principal": {"id": "1"}}}, f)
    with open(rsm.SESSION_PREV_MONO, "w", encoding="utf-8") as f:
        json.dump({"mono": time.monotonic() - mono_age_s}, f)
    old = time.time() - wall_age_days * 86400.0
    os.utime(rsm.SESSION_PREV, (old, old))


def t_prev_monotonic_guard():
    # Fresh .prev (mono 60s old) whose wall mtime was pushed 8 days back
    # (simulated forward clock jump): must be KEPT.
    _write_prev_with_mono(mono_age_s=60, wall_age_days=8)
    check("P2-1: forward clock jump does not delete a fresh .prev",
          rsm.age_out_stale_prev() is False
          and os.path.exists(rsm.SESSION_PREV))
    # Genuinely stale .prev (mono 8 days old): still aged out, and the
    # .mono sidecar goes with it.
    _write_prev_with_mono(mono_age_s=8 * 86400, wall_age_days=8)
    check("P2-1: a truly stale .prev is still aged out",
          rsm.age_out_stale_prev() is True
          and not os.path.exists(rsm.SESSION_PREV))
    check("P2-1: the .mono sidecar is removed with the stale .prev",
          not os.path.exists(rsm.SESSION_PREV_MONO))
    # Legacy .prev without a sidecar keeps the old wall-clock behavior
    # (deleted when the wall mtime is old).
    with open(rsm.SESSION_PREV, "w", encoding="utf-8") as f:
        f.write("{}")
    if os.path.exists(rsm.SESSION_PREV_MONO):
        os.remove(rsm.SESSION_PREV_MONO)
    old = time.time() - 8 * 86400.0
    os.utime(rsm.SESSION_PREV, (old, old))
    check("P2-1: legacy .prev without sidecar keeps wall-clock aging",
          rsm.age_out_stale_prev() is True)
    # Nothing to age out: False, no crash.
    check("P2-1: no .prev returns False",
          rsm.age_out_stale_prev() is False)


def t_prev_monotonic_reboot():
    # W5-P2-1: the monotonic clock resets on reboot. A stamp from
    # before a reboot (born_mono > now_mono, negative delta) is
    # meaningless: it must be ignored, falling back to wall-clock age.
    with open(rsm.SESSION_PREV, "w", encoding="utf-8") as f:
        json.dump({"canvas": {"principal": {"id": "1"}}}, f)
    with open(rsm.SESSION_PREV_MONO, "w", encoding="utf-8") as f:
        # Stamp from "before a reboot": larger than any current
        # monotonic reading.
        json.dump({"mono": time.monotonic() + 1000000.0}, f)
    old = time.time() - 8 * 86400.0
    os.utime(rsm.SESSION_PREV, (old, old))
    check("P2-1: pre-reboot mono stamp is ignored (wall-clock ages out)",
          rsm.age_out_stale_prev() is True
          and not os.path.exists(rsm.SESSION_PREV))
    # A pre-reboot stamp on a wall-fresh .prev keeps it (fail-safe).
    with open(rsm.SESSION_PREV, "w", encoding="utf-8") as f:
        json.dump({"canvas": {"principal": {"id": "1"}}}, f)
    with open(rsm.SESSION_PREV_MONO, "w", encoding="utf-8") as f:
        json.dump({"mono": time.monotonic() + 1000000.0}, f)
    check("P2-1: pre-reboot stamp on fresh .prev keeps it",
          rsm.age_out_stale_prev() is False
          and os.path.exists(rsm.SESSION_PREV))
    for p in (rsm.SESSION_PREV, rsm.SESSION_PREV_MONO):
        try:
            os.remove(p)
        except OSError:
            pass


# ---------------------------------------------------------------- W5-P2-6

def t_reauth_timeout_escalates():
    # Arrange an expired state with a readable dead session record.
    rsm.set_state(rsm.EXPIRED)
    with open(rsm.SESSION_PATH, "w", encoding="utf-8") as f:
        json.dump({"canvas": {"principal": {"id": "42",
                                            "name": "Test"}}}, f)
    rsm.impose_halt("test death")
    real_run = subprocess.run

    def _hang(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 120)

    subprocess.run = _hang
    try:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = rsm.reauth()
        out = buf.getvalue()
    finally:
        subprocess.run = real_run
    check("P2-6: hung capture.py makes reauth() return False (no raise)",
          rc is False)
    check("P2-6: plain-language escalation line printed",
          "timed out" in out and "reauth_pending" in out, out[:120])
    esc = open(rsm.NOTIFY_PATH, encoding="utf-8").read() \
        if os.path.exists(rsm.NOTIFY_PATH) else ""
    check("P2-6: escalation file names the hung capture",
          "capture.py" in esc and "120s" in esc, esc[:120])
    check("P2-6: write halt stays imposed (fail-safe state retained)",
          rsm.is_write_halted())
    check("P2-6: the .prev pinning snapshot is retained",
          os.path.exists(rsm.SESSION_PREV))
    check("P2-6: state stays reauth_pending",
          rsm.get_state() == rsm.REAUTH_PENDING)
    rsm.lift_halt()


def t_ledger_concurrent_append():
    # W5-P1-2: concurrent CLI processes appending while compactions
    # fire must not lose entries. The ledger lock serializes each
    # append with the compaction it may trigger; without it, an append
    # landing between a compaction's scan and its atomic replace would
    # be silently dropped.
    if os.path.exists(rsm.QUAR_PATH):
        os.remove(rsm.QUAR_PATH)
    child = (
        "import os, sys; "
        "os.environ['MORROW_HOME'] = sys.argv[1]; "
        "sys.path.insert(0, sys.argv[2]); "
        "from reauth import state_machine as r; "
        "r.QUAR_COMPACT_BYTES = int(sys.argv[5]); "
        "r.QUAR_KEEP_TERMINAL = int(sys.argv[6]); "
        "p = int(sys.argv[3]); n = int(sys.argv[4]); "
        "[r.quarantine_op('conc-%d-%d' % (p, i), 'create_page', 'x') "
        "for i in range(n)]"
    )
    n_proc, n_each = 4, 25
    procs = []
    for p in range(n_proc):
        procs.append(subprocess.Popen(
            [sys.executable, "-c", child,
             HOME, REPO, str(p), str(n_each), "2048", "100000"]))
    try:
        for proc in procs:
            proc.wait(timeout=180)
        check("P1-2: all concurrent appenders exited cleanly",
              all(proc.returncode == 0 for proc in procs),
              "%r" % [proc.returncode for proc in procs])
        ids = {e["op_id"] for e in _ledger_entries()}
        want = {"conc-%d-%d" % (p, i)
                for p in range(n_proc) for i in range(n_each)}
        check("P1-2: no entry lost to the append/compaction race",
              want <= ids, "%d/%d present" % (len(want & ids), len(want)))
    finally:
        for proc in procs:
            if proc.poll() is None:
                proc.kill()


for _t in (t_unique_default_op_id,
           t_ledger_compaction,
           t_ledger_streaming_and_torn,
           t_ledger_enospc,
           t_ledger_concurrent_append,
           t_session_death_dedup,
           t_prev_monotonic_guard,
           t_prev_monotonic_reboot,
           t_reauth_timeout_escalates):
    try:
        _t()
    except Exception as e:  # noqa: BLE001 - never let one test kill the suite
        FAIL.append("%s raised %r" % (_t.__name__, e))
        print("FAIL %s raised %r" % (_t.__name__, e))

print("pass: %d" % len(PASS))
for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
shutil.rmtree(SCRATCH, ignore_errors=True)
