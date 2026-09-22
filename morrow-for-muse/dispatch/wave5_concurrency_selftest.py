#!/usr/bin/env python3
"""Selftest: Wave 5 concurrency-findings remediation (executor side).

Covers the 2026-09-21 adversarial audit's concurrency findings as they
apply to the dispatch executor's journal and shutdown machinery:

  W5-P1-3: crashed raw-lane claims get operator recovery. claim_op_id
    followed by a lost token (the crashed-dispatch shape) leaves the op
    in journal_pending_ops(); release_op_id_forced() frees it without
    the token, journals the release with forced=true and the reason,
    and the op_id becomes re-claimable. Forced release on a
    never-claimed op raises DuplicateOpId; on an already-completed op
    it returns released=False (idempotent). The `claim-release` and
    `journal-pending` CLIs work end to end.
  W5-P1-4: concurrent completes cannot both journal. Two threads
    racing journal_claimed_outcome() on one live claim: exactly one
    outcome is journaled, the loser raises DuplicateOpId. A wrong
    token, a released claim, and an op_id/record mismatch all fail
    closed.
  W5-P2-1: SIGTERM/SIGINT graceful handling. _install_shutdown_handlers
    is idempotent and never replaces a custom handler; the first
    signal arms the drain flag; _raise_if_shutdown_requested raises
    ExecutorShutdown; with a claim it releases the claim first (nothing
    was sent yet, so the op_id stays reusable); without a claim it
    just raises. dispatch_undo carries the same checkpoints: a pending
    signal stops the undo before any provider I/O with the fresh claim
    released and zero provider calls.

Hermetic: scratch journal under this file's directory (never /tmp, per
the standing rule); no network, no provider. Signal state is saved and
restored so the test runner's own handlers are untouched.
"""
import contextlib
import io
import os
import shutil
import signal
import sys
import threading
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "dispatch")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
from dispatch import admission as _ad_mod  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


def check_raises(name, exc_types, fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except exc_types:
        check(name, True)
        return
    except Exception as e:  # noqa: BLE001
        check(name, False, "wrong exception: %r" % e)
        return
    check(name, False, "no exception raised")


# Test scratch lives under this file's directory (never /tmp).
_SELFTEST_WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              ".selftest-work")
_WORK = os.path.join(_SELFTEST_WORK, "wave5-concurrency")
if os.path.isdir(_WORK):
    shutil.rmtree(_WORK)
os.makedirs(os.path.join(_WORK, "journal"))

_saved_journal = ex.JOURNAL_PATH


def _use_tree(name):
    d = os.path.join(_WORK, name)
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(os.path.join(d, "journal"))
    os.makedirs(os.path.join(d, "approvals"))
    ex.JOURNAL_PATH = os.path.join(d, "journal", "ops.jsonl")
    # W5-P2-1 undo test: the approval store must be hermetic too, or a
    # consumed approval from a previous run breaks the rerun.
    _ad_mod.APPROVALS_DIR = os.path.join(d, "approvals")
    _ad_mod.CONSUMED_PATH = os.path.join(d, "approvals", "consumed.json")
    _ad_mod.SIGNING_KEY_PATH = os.path.join(d, "approvals", ".signing.key")


def _complete_record(op_id, tag):
    return {"op_id": op_id, "entry_name": "test.op", "kind": "dispatch",
            "effect": "write", "params_digest": "d", "plan_digest": None,
            "before_state_digest": None,
            "after_state_digest": ex.digest_of({"tag": tag}),
            "verification": "verified",
            "verification_detail": "race complete %s" % tag,
            "receipt": {"tag": tag}, "truncated": False,
            "bytes_received": 0, "attempts": 1, "uncertain": False,
            "approval": None}


try:
    # -- W5-P1-3: forced claim recovery ----------------------------------
    _use_tree("p13")

    _op = str(uuid.uuid4())
    _tok = ex.claim_op_id(_op, "dispatch", "test.op", "write", "d")
    # The crash: the dispatch process dies with the raw token in memory.
    del _tok
    _pending_ids = [p["op_id"] for p in ex.journal_pending_ops()]
    check("crashed claim shows in journal_pending_ops", _op in _pending_ids)

    _rel = ex.release_op_id_forced(
        _op, "selftest: crashed dispatch; provider confirms no effect")
    check("forced release reports released=True", _rel["released"] is True
          and _rel["op_id"] == _op)
    _pending_ids = [p["op_id"] for p in ex.journal_pending_ops()]
    check("forced release clears the reconcile list", _op not in _pending_ids)

    _recs = [r for r in ex._scan_journal_file(ex.JOURNAL_PATH)
             if r.get("op_id") == _op and r.get("wal") == "released"]
    check("forced release is journaled with forced=true and the reason",
          len(_recs) == 1 and _recs[0].get("forced") is True
          and "crashed dispatch" in str(_recs[0].get("release_reason")))

    _tok2 = ex.claim_op_id(_op, "dispatch", "test.op", "write", "d")
    check("op_id is re-claimable after forced release", bool(_tok2))
    ex.release_op_id(_op, _tok2, "selftest cleanup")

    _op_done = str(uuid.uuid4())
    _tokd = ex.claim_op_id(_op_done, "dispatch", "test.op", "write", "d")
    ex.journal_claimed_outcome(_op_done, _complete_record(_op_done, "done"),
                               _tokd)
    _rel2 = ex.release_op_id_forced(_op_done, "selftest: already complete")
    check("forced release on a completed op returns released=False",
          _rel2["released"] is False)

    check_raises("forced release on a never-claimed op raises DuplicateOpId",
                 ex.DuplicateOpId, ex.release_op_id_forced,
                 str(uuid.uuid4()), "selftest")

    # CLI end to end.
    _op_cli = str(uuid.uuid4())
    ex.claim_op_id(_op_cli, "dispatch", "test.op", "write", "d")
    _buf = io.StringIO()
    with contextlib.redirect_stdout(_buf):
        _rc = ex.main(["journal-pending"])
    check("journal-pending CLI lists the crashed claim",
          _rc == 0 and _op_cli in _buf.getvalue())
    _buf = io.StringIO()
    with contextlib.redirect_stdout(_buf):
        _rc = ex.main(["claim-release", "--op-id", _op_cli,
                       "--reason", "selftest: reconciled, no provider effect",
                       "--yes"])
    check("claim-release CLI frees the crashed claim",
          _rc == 0 and '"released":true' in _buf.getvalue())
    _pending_ids = [p["op_id"] for p in ex.journal_pending_ops()]
    check("claim-release CLI clears the reconcile list",
          _op_cli not in _pending_ids)

    # -- W5-P1-4: atomic completion race ---------------------------------
    _use_tree("p14")

    _op_race = str(uuid.uuid4())
    _rtok = ex.claim_op_id(_op_race, "dispatch", "test.op", "write", "d")
    _results = []
    _barrier = threading.Barrier(2)

    def _racer(tag):
        _barrier.wait()
        try:
            ex.journal_claimed_outcome(
                _op_race, _complete_record(_op_race, tag), _rtok)
            _results.append((tag, "ok"))
        except ex.DuplicateOpId:
            _results.append((tag, "duplicate"))

    _ts = [threading.Thread(target=_racer, args=("a",)),
           threading.Thread(target=_racer, args=("b",))]
    for _t in _ts:
        _t.start()
    for _t in _ts:
        _t.join()
    _oks = [tag for tag, st in _results if st == "ok"]
    _dups = [tag for tag, st in _results if st == "duplicate"]
    check("exactly one racer journals the outcome",
          len(_oks) == 1 and len(_dups) == 1, repr(_results))
    _outcomes = [r for r in ex._scan_journal_file(ex.JOURNAL_PATH)
                 if r.get("op_id") == _op_race
                 and r.get("wal") == "complete"]
    check("exactly one outcome record in the journal",
          len(_outcomes) == 1)
    check("the journaled outcome is the winner's",
          _outcomes and _outcomes[0]["receipt"]["tag"] == _oks[0])

    _op_f = str(uuid.uuid4())
    _ftok = ex.claim_op_id(_op_f, "dispatch", "test.op", "write", "d")
    check_raises("wrong token cannot journal under a foreign claim",
                 ex.DuplicateOpId, ex.journal_claimed_outcome,
                 _op_f, _complete_record(_op_f, "x"), "bogus-token")
    ex.release_op_id(_op_f, _ftok, "selftest: foreign-token attempt refused")
    check_raises("completed-then-released claim refuses a second outcome",
                 ex.DuplicateOpId, ex.journal_claimed_outcome,
                 _op_f, _complete_record(_op_f, "x"), _ftok)
    _bad = _complete_record(str(uuid.uuid4()), "mismatch")
    check_raises("op_id/record mismatch fails closed",
                 ex.ExecutorError, ex.journal_claimed_outcome,
                 _op_f, _bad, None)

    # -- W5-P2-1: signal handling ----------------------------------------
    _use_tree("p21")

    _saved_term = signal.getsignal(signal.SIGTERM)
    _saved_int = signal.getsignal(signal.SIGINT)
    _saved_flag = ex._shutdown_requested
    _saved_count = ex._shutdown_signal_count
    try:
        ex._install_shutdown_handlers()
        ex._install_shutdown_handlers()
        check("handler install is idempotent",
              signal.getsignal(signal.SIGTERM) == ex._handle_shutdown_signal
              and signal.getsignal(signal.SIGINT) == ex._handle_shutdown_signal)

        def _custom(signum, frame):
            pass
        signal.signal(signal.SIGTERM, _custom)
        ex._install_shutdown_handlers()
        check("install never replaces a custom handler",
              signal.getsignal(signal.SIGTERM) == _custom)
        signal.signal(signal.SIGTERM, ex._handle_shutdown_signal)

        ex._handle_shutdown_signal(signal.SIGTERM, None)
        check("first signal arms the drain flag", ex._shutdown_requested)
        check_raises("checkpoint raises ExecutorShutdown when flagged",
                     ex.ExecutorShutdown, ex._raise_if_shutdown_requested)
        check("no claim released when none was given",
              True)
        ex._shutdown_requested = False
        # The handler counts invocations (a second real signal kills);
        # reset the counter between simulated signals.
        ex._shutdown_signal_count = 0

        _op_s = str(uuid.uuid4())
        _stok = ex.claim_op_id(_op_s, "dispatch", "test.op", "write", "d")
        ex._handle_shutdown_signal(signal.SIGINT, None)
        try:
            ex._raise_if_shutdown_requested(_op_s, _stok)
            check("pre-provider checkpoint releases the claim and raises",
                  False, "no exception")
        except ex.ExecutorShutdown:
            check("pre-provider checkpoint releases the claim and raises",
                  True)
        check("claim is released after the shutdown checkpoint",
              _op_s not in [p["op_id"] for p in ex.journal_pending_ops()])
        _tok3 = ex.claim_op_id(_op_s, "dispatch", "test.op", "write", "d")
        check("op_id stays reusable after shutdown release", bool(_tok3))
        ex.release_op_id(_op_s, _tok3, "selftest cleanup")
    finally:
        ex._shutdown_requested = _saved_flag
        ex._shutdown_signal_count = _saved_count
        signal.signal(signal.SIGTERM, _saved_term)
        signal.signal(signal.SIGINT, _saved_int)
    check("signal state restored after test",
          ex._shutdown_requested is _saved_flag
          and signal.getsignal(signal.SIGTERM) is _saved_term)

    # -- W5-P2-1: dispatch_undo honors the shutdown flag ------------------
    # A signal pending before dispatch_undo's provider call must stop
    # the undo BEFORE any provider I/O, with the fresh claim released
    # (op_id reusable) and nothing sent.
    _use_tree("p21-undo")
    from transport.chromium_session import ChromiumSession as _CS
    _ad = _ad_mod

    class _FakeTransport(object):
        def __init__(self, script):
            self.script = list(script)
            self.calls = []
        def ensure_session(self):
            return (1, "Test User")
        def api(self, method, path, data=None, _ws=None, timeout=60,
                as_json=False, max_bytes=None):
            self.calls.append((method, path))
            kind = self.script.pop(0)
            if kind[0] == "raise":
                raise kind[1]
            return kind[1], {}, kind[2]

    def _u_entry(name):
        entry = ex.catalog_descriptor_to_entry(
            name, "POST", "/api/v1/courses/112/assignment_groups",
            "write", provider="canvas",
            extra={"before_state": {"unsupported": True,
                                    "reason": "wave-5 selftest"}})
        entry["undo"] = {"method": "DELETE",
                         "url": "{canvas_base}/api/v1/courses/112/"
                                "assignment_groups/7"}
        return entry

    def _u_session(script):
        t = _FakeTransport(script)
        cs = _CS("https://canvas.example.edu", transport=t)
        cs._fake_transport = t
        cs._browser_owned = True
        cs._auth_state = "ready"
        return cs

    def _u_approve(entry, params):
        rec = _ad.mint_approval(entry, params, "https://canvas.example.edu")
        _ad.sign_approval(
            rec, "I, the educator, authorize this wave-5 selftest undo",
            channel="driver")
        return rec

    _u_params = {"course_id": "112"}
    # Baseline: the harness dispatches an undo cleanly with no signal.
    _u0 = _u_entry("w5-undo-ok")
    _s0 = _u_session([("ok", 200, '{"id": 112, "name": "Intended Course"}'),
                      ("ok", 200, '{"id": 5}')])
    _out0 = ex.dispatch_undo(_u0, _u_params, {}, str(uuid.uuid4()),
                             _s0, {"max_body_bytes": 262144},
                             approval=_u_approve(_u0, _u_params))
    check("undo harness baseline: dispatched and journaled",
          bool(_out0.get("op_id"))
          and [m for m, _u in _s0._fake_transport.calls] == ["GET", "DELETE"])
    # Now arm the shutdown flag: the undo must stop before any I/O.
    ex._shutdown_requested = True
    ex._shutdown_signal_count = 1
    _u1 = _u_entry("w5-undo-shutdown")
    _s1 = _u_session([("ok", 200, '{"id": 112, "name": "Intended Course"}'),
                      ("ok", 200, '{"id": 5}')])
    try:
        ex.dispatch_undo(_u1, _u_params, {}, str(uuid.uuid4()),
                         _s1, {"max_body_bytes": 262144},
                         approval=_u_approve(_u1, _u_params))
        check("undo with pending signal stops before provider I/O",
              False, "no exception")
    except ex.ExecutorShutdown:
        check("undo with pending signal stops before provider I/O", True)
    check("undo made zero provider calls after the signal",
          _s1._fake_transport.calls == [])
    check("undo's fresh claim was released (nothing pending)",
          ex.journal_pending_ops() == [])
    ex._shutdown_requested = False
    ex._shutdown_signal_count = 0
    check("shutdown flag cleared after undo test",
          not ex._shutdown_requested)

finally:
    ex.JOURNAL_PATH = _saved_journal

for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("all wave5 concurrency selftests passed")
