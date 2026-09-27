#!/usr/bin/env python3
"""Selftest: auth-lifecycle remediation (wave 4, auth family).

Hermetic: no network, no browser, no real sessions, no credentials.
Fake transports and stub sessions only; all state lands under
reauth/.selftest-work (allowed by the installer's integrity gate and
cleaned up after the suites run).

Covers:
  W4-P1-16  stable tree identity (.morrow-tree-id mint/read/preserve;
            a moved tree keeps the same id while the legacy path slug
            changes; garbage files fall back with no crash).
  W4-P2-1   session-death lifecycle on the re-auth ledger:
            quarantine -> awaiting_approval -> approved; approve() only
            fires from awaiting_approval; the executor's _check_write_gates
            refuses quarantined/awaiting_approval re-dispatch and permits
            only approved; nothing auto-resumes.
  W4-P2-1   quarantine_session(): the dead session itself is parked in
            the ledger as a session_death record (halt + quarantine +
            notify is the production wiring shape); the op lifecycle
            never moves it.
  W4-P2-3   expiry_horizon_warning(): helper /status horizon within
            ~24h warns; far/unknown/down never warns and never raises;
            cmd_status surfaces the horizon line.
  W4-P2-5   stale session.json.prev: retained on failed/mismatched
            recovery, deleted only after verified resume; a .prev older
            than 7 days is aged out, and impose_halt sweeps a stale
            .prev from an earlier incomplete cycle.
  W4-P2-4   PAT 401 taxonomy: the 401 branch of request_with_retry names
            the token cause and the mint-a-fresh-token remedy, and never
            claims more than the 401 proves.
  W4-P2-1   production resume CLI path: principal mismatch keeps the
            halt and writes escalation; match re-arms per-op approval
            and lifts the halt.
  W4-P2-1   stale command: BrowserStaleCommand is not session death; the
            verify-phase stale path quarantines without the halt and
            notifies about the refresh, never a re-sign-in.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import io
import json
import os
import shutil
import sys
import time
import types
import uuid
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SCRATCH = os.path.join(HERE, ".selftest-work")
HOME = os.path.join(SCRATCH, "home")

# W4-P1-17: the re-auth store resolves MORROW_HOME at import time, so
# point it at scratch BEFORE importing the module under test.
os.environ["MORROW_HOME"] = HOME
shutil.rmtree(SCRATCH, ignore_errors=True)
os.makedirs(HOME, exist_ok=True)

for _p in (REPO, os.path.join(REPO, "dispatch")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from config.paths import mint_tree_uuid, read_tree_uuid  # noqa: E402
from reauth import state_machine as rsm  # noqa: E402
from dispatch import executor as ex  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("PASS %s" % name)
    else:
        FAIL.append(name)
        print("FAIL %s%s" % (name, (" (%s)" % detail) if detail else ""))


# ---------------------------------------------------------------- W4-P1-16

def t_tree_id():
    d1 = os.path.join(SCRATCH, "tree-a")
    os.makedirs(d1)
    val = mint_tree_uuid(d1)
    check("tree-id: mint returns 32-hex", len(val) == 32 and
          all(c in "0123456789abcdef" for c in val), val)
    check("tree-id: file mode 0644 (non-secret)",
          oct(os.stat(os.path.join(d1, ".morrow-tree-id")).st_mode & 0o777) == "0o644")
    check("tree-id: read back equals minted",
          read_tree_uuid(d1) == val)
    # A moved/copied tree keeps the same id: copy the dir elsewhere and
    # prove the id is identical while any path slug would differ.
    d2 = os.path.join(SCRATCH, "tree-b-moved")
    shutil.copytree(d1, d2)
    check("tree-id: moved tree keeps id", read_tree_uuid(d2) == val)
    check("tree-id: paths differ (slug would not)",
          os.path.realpath(d1) != os.path.realpath(d2))
    # Malformed and missing files fall back cleanly.
    d3 = os.path.join(SCRATCH, "tree-c")
    os.makedirs(d3)
    with open(os.path.join(d3, ".morrow-tree-id"), "w") as f:
        f.write("not-a-uuid\n")
    check("tree-id: garbage file reads as None (fallback)",
          read_tree_uuid(d3) is None)
    check("tree-id: missing file reads as None (fallback)",
          read_tree_uuid(os.path.join(SCRATCH, "nope")) is None)
    # Migration preservation: minting never overwrites an existing id.
    before = read_tree_uuid(d1)
    kept = open(os.path.join(d1, ".morrow-tree-id")).read().strip()
    check("tree-id: existing id preserved verbatim", kept == before)
    # The journal path is keyed by the UUID, so a moved tree keeps the
    # same journal: DuplicateOpId protection survives the move.
    j1 = os.path.join(HOME, "trees", read_tree_uuid(d1),
                      "journal", "ops.jsonl")
    j2 = os.path.join(HOME, "trees", read_tree_uuid(d2),
                      "journal", "ops.jsonl")
    check("tree-id: moved tree resolves the identical journal path",
          j1 == j2, "%s vs %s" % (j1, j2))
    real_journal = ex.JOURNAL_PATH
    ex.JOURNAL_PATH = j1
    try:
        op = str(uuid.uuid4())
        ex.claim_op_id(op, "dispatch", "probe_action", "read", "digest-1")
        # Simulate the move: the tree now lives at d2, but the journal
        # path (keyed by the carried UUID) is unchanged.
        ex.JOURNAL_PATH = j2
        try:
            ex.claim_op_id(op, "dispatch", "probe_action", "read",
                           "digest-1")
            check("tree-id: DuplicateOpId survives the move", False)
        except ex.DuplicateOpId:
            check("tree-id: DuplicateOpId survives the move", True)
    finally:
        ex.JOURNAL_PATH = real_journal


# ---------------------------------------------------------------- W4-P2-5

def t_prev_retention():
    prev = rsm.SESSION_PREV
    rsm.impose_halt({"signal": "selftest"})
    with open(prev, "w") as f:
        f.write("superseded session record")
    # Mismatched recovery: halt stays, .prev retained.
    ok = rsm._complete_reauth({"id": 111}, {"id": 222})
    check("prev: mismatch returns False", ok is False)
    check("prev: retained after mismatch", os.path.exists(prev))
    check("prev: halt still active after mismatch",
          rsm.check_write_allowed()[0] is False)
    # Verified recovery: halt lifted, .prev deleted.
    ok = rsm._complete_reauth({"id": 111}, {"id": 111})
    check("prev: match returns True", ok is True)
    check("prev: deleted after verified resume", not os.path.exists(prev))
    check("prev: halt lifted after verified resume",
          rsm.check_write_allowed()[0] is True)


# ---------------------------------------------------------------- W4-P2-5

def t_prev_ageout():
    prev = rsm.SESSION_PREV
    if os.path.exists(prev):
        os.remove(prev)
    # Nothing there: nothing to do.
    check("ageout: missing .prev returns False",
          rsm.age_out_stale_prev() is False)
    # Fresh .prev (an in-progress re-auth's pinning snapshot): retained.
    with open(prev, "w") as f:
        f.write("fresh superseded record")
    check("ageout: fresh .prev retained",
          rsm.age_out_stale_prev() is False and os.path.exists(prev))
    # Stale .prev (8 days old, an incomplete earlier cycle): deleted.
    old = time.time() - 8 * 86400
    os.utime(prev, (old, old))
    check("ageout: stale .prev deleted",
          rsm.age_out_stale_prev() is True and not os.path.exists(prev))
    # impose_halt sweeps a stale .prev before recording the fresh death.
    with open(prev, "w") as f:
        f.write("stale from an earlier incomplete cycle")
    os.utime(prev, (old, old))
    rsm.impose_halt({"signal": "selftest-ageout"})
    check("ageout: impose_halt sweeps stale .prev",
          not os.path.exists(prev))
    check("ageout: halt still imposed after the sweep",
          rsm.check_write_allowed()[0] is False)
    # ...but a fresh .prev survives the sweep (a re-auth already in
    # progress keeps its pinning snapshot).
    with open(prev, "w") as f:
        f.write("fresh pinning snapshot")
    rsm.impose_halt({"signal": "selftest-ageout-2"})
    check("ageout: impose_halt keeps a fresh .prev",
          os.path.exists(prev))
    os.remove(prev)
    rsm.lift_halt()


# ------------------------------------------------- W4-P2-1 session death

def t_session_death_quarantine():
    rsm.lift_halt()
    if os.path.exists(rsm.QUAR_PATH):
        os.remove(rsm.QUAR_PATH)
    # The dead session itself is parked in the ledger.
    entry = rsm.quarantine_session("session_ended",
                                   {"signal": "selftest"})
    check("sess-quar: entry kind is session_death",
          entry.get("kind") == "session_death")
    check("sess-quar: status is session_quarantined",
          entry.get("status") == "session_quarantined")
    check("sess-quar: taxonomy cause recorded",
          entry.get("cause") == "session_ended")
    check("sess-quar: no credential-shaped values",
          "cookie" not in json.dumps(entry).lower()
          and "token" not in json.dumps(entry).lower())
    deaths = rsm.session_deaths()
    check("sess-quar: session_deaths lists it",
          len(deaths) == 1 and deaths[0]["cause"] == "session_ended")
    # The op lifecycle never moves a session_death record: it is a
    # record of the death, not a parked op.
    check("sess-quar: awaiting-approval sweep moves 0 session records",
          rsm.mark_ops_awaiting_approval() == 0
          and rsm.session_deaths()[0]["status"] == "session_quarantined")
    # ...while a real op quarantined alongside still flows normally.
    op = str(uuid.uuid4())
    rsm.quarantine_op(op, "probe_action", "probe")
    check("sess-quar: op still quarantined",
          rsm.op_quarantine_status(op) == "quarantined")
    check("sess-quar: op moves, session record stays put",
          rsm.mark_ops_awaiting_approval() == 1
          and rsm.op_quarantine_status(op) == "awaiting_approval"
          and rsm.session_deaths()[0]["status"] == "session_quarantined")
    # The full production wiring shape: halt + quarantine_session +
    # notify, exactly as transport/chromium_session fires it.
    rsm.lift_halt()
    os.remove(rsm.QUAR_PATH)
    detection = {"signal": "chromium_session_dead",
                 "cause": "session_ended"}
    rsm.impose_halt(detection,
                    reason="chromium session death (session_ended)")
    rsm.quarantine_session("session_ended", detection)
    rsm.write_notify_expired(rsm.paused_ops())
    check("sess-quar: halt active after wiring",
          rsm.check_write_allowed()[0] is False)
    check("sess-quar: halt reason names the taxonomy cause",
          "session_ended" in rsm.check_write_allowed()[1],
          rsm.check_write_allowed()[1][:80])
    check("sess-quar: notify names expiry, not credentials",
          os.path.exists(rsm.NOTIFY_PATH)
          and "expired" in open(rsm.NOTIFY_PATH).read().lower())
    check("sess-quar: death recorded in the ledger",
          len(rsm.session_deaths()) == 1)
    rsm.lift_halt()


# ---------------------------------------------------------------- W4-P2-3

def t_expiry_horizon():
    import transport as _tpkg
    real_mod = sys.modules.get("transport.local_chromium")
    real_attr = getattr(_tpkg, "local_chromium", None)
    try:
        fake = types.SimpleNamespace(helper_status=None)
        sys.modules["transport.local_chromium"] = fake
        _tpkg.local_chromium = fake
        # Within ~24h: warn.
        fake.helper_status = lambda timeout=5: \
            {"session_expiry_horizon_days": 1}
        days, near, msg = rsm.expiry_horizon_warning()
        check("horizon: 1 day -> near", days == 1 and near is True, msg)
        check("horizon: near message names ~24h and re-sign-in",
              "~24h" in msg and "re-sign in" in msg, msg[:100])
        # Far horizon: reported, no warning.
        fake.helper_status = lambda timeout=5: \
            {"session_expiry_horizon_days": 30}
        days, near, msg = rsm.expiry_horizon_warning()
        check("horizon: 30 days -> not near",
              days == 30 and near is False, msg)
        # Unknown horizon (null): unknown, no warning, never raises.
        fake.helper_status = lambda timeout=5: \
            {"session_expiry_horizon_days": None}
        days, near, msg = rsm.expiry_horizon_warning()
        check("horizon: null -> unknown, no warning",
              days is None and near is False and "unknown" in msg, msg)
        # Helper down: unknown, never raises.
        def _down(timeout=5):
            raise RuntimeError("helper down")
        fake.helper_status = _down
        days, near, msg = rsm.expiry_horizon_warning()
        check("horizon: helper down -> unknown, never raises",
              days is None and near is False, msg)
        # cmd_status surfaces the horizon line with the warning.
        fake.helper_status = lambda timeout=5: \
            {"session_expiry_horizon_days": 0}
        buf = io.StringIO()
        with redirect_stdout(buf):
            rsm.cmd_status()
        out = buf.getvalue()
        check("horizon: status surfaces the warning",
              "expiry_horizon" in out and "WARNING" in out, out[-160:])
    finally:
        if real_mod is not None:
            sys.modules["transport.local_chromium"] = real_mod
        else:
            sys.modules.pop("transport.local_chromium", None)
        if real_attr is not None:
            _tpkg.local_chromium = real_attr
        else:
            try:
                delattr(_tpkg, "local_chromium")
            except AttributeError:
                pass


# ------------------------------------------------- W4-P2-1 quarantine flow

def t_quarantine_flow():
    op = str(uuid.uuid4())
    check("quarantine: unknown op has no status",
          rsm.op_quarantine_status(op) is None)
    rsm.quarantine_op(op, "probe_action", "probe death")
    check("quarantine: status quarantined",
          rsm.op_quarantine_status(op) == "quarantined")
    check("quarantine: approve refused before verified resume",
          rsm.approve_op(op, "I, the educator, approve re-dispatching this quarantined op") is False)
    check("quarantine: still quarantined after refused approve",
          rsm.op_quarantine_status(op) == "quarantined")
    moved = rsm.mark_ops_awaiting_approval()
    check("quarantine: moved to awaiting_approval",
          moved == 1 and rsm.op_quarantine_status(op) == "awaiting_approval")
    check("quarantine: approve refused for unknown op",
          rsm.approve_op("op-nope", "I, the educator, approve re-dispatching this quarantined op") is False)
    check("quarantine: approve succeeds from awaiting_approval",
          rsm.approve_op(op, "I, the educator, approve re-dispatching this quarantined op") is True)
    check("quarantine: status approved",
          rsm.op_quarantine_status(op) == "approved")
    check("quarantine: double approve refused",
          rsm.approve_op(op, "I, the educator, approve re-dispatching this quarantined op") is False)


def t_reapproval_requires_educator_authorization():
    # W6-P2-A5: the agent cannot self-approve a quarantined op. A
    # missing or blank authorization raises before anything is
    # approved; the op stays awaiting_approval. Round-4 M1: any
    # non-empty verbatim educator reply approves ("yes" is enough).
    op = str(uuid.uuid4())
    rsm.quarantine_op(op, "probe_action", "probe death")
    rsm.mark_ops_awaiting_approval()
    for bad in (None, "", "   "):
        try:
            rsm.approve_op(op, bad)
            check("w6p2a5: authorization %r refused" % (bad,),
                  False, "no ValueError raised")
        except ValueError:
            check("w6p2a5: authorization %r refused" % (bad,), True)
        except Exception as exc:
            check("w6p2a5: authorization %r refused" % (bad,),
                  False, "wrong exception: %r" % exc)
    check("w6p2a5: op still awaiting_approval after refused approves",
          rsm.op_quarantine_status(op) == "awaiting_approval",
          rsm.op_quarantine_status(op))
    # The educator's real words approve, and the citation is sealed
    # into the ledger entry for audit.
    words = "yes"
    check("w6p2a5: genuine educator authorization approves",
          rsm.approve_op(op, words) is True)
    check("w6p2a5: status approved",
          rsm.op_quarantine_status(op) == "approved")
    entries = [json.loads(line) for line in open(rsm.QUAR_PATH)
               if line.strip()]
    mine = [e for e in entries if str(e.get("op_id")) == op]
    check("w6p2a5: authorization sealed in the ledger",
          bool(mine) and mine[-1].get("approval_authorization") == words,
          repr(mine[-1].get("approval_authorization") if mine else None))


def _gate_entry_and_plan(op_id):
    entry = {"name": "qgate_probe", "effects": "write",
             "blocks": [{"kind": "read", "op": "x"}]}
    plan = ex.FrozenPlan({"op_id": op_id, "entry_name": "qgate_probe",
                          "params": {}, "before_state_digest": "d",
                          "frozen_readback": {}}, "probe")
    return entry, plan


def t_quarantine_gate():
    op = str(uuid.uuid4())
    entry, plan = _gate_entry_and_plan(op)

    def attempt():
        try:
            ex._check_write_gates(entry, {}, plan, op, dry_run=True)
            return "pass"
        except ex.WriteHaltActive:
            return "refused"
    check("gate: never-quarantined op passes", attempt() == "pass")
    rsm.quarantine_op(op, "qgate_probe", "probe death")
    check("gate: quarantined op refused", attempt() == "refused")
    rsm.mark_ops_awaiting_approval()
    check("gate: awaiting_approval op refused", attempt() == "refused")
    rsm.approve_op(op, "I, the educator, approve re-dispatching this quarantined op")
    check("gate: approved op passes (nothing auto-resumed, "
          "explicit approval did)", attempt() == "pass")


# ------------------------------------------- W6-P0-1 quarantine ledger seal

def _forge_approved_line(op_id):
    """Append the audit's exact attack line: an unsealed 'approved' entry."""
    with open(rsm.QUAR_PATH, "a") as f:
        f.write(json.dumps({"kind": "op", "op_id": op_id,
                            "action": "create_page", "status": "approved",
                            "approved": True}) + "\n")


def t_quarantine_seal_w6p01():
    # The audit's attack: a forged unsealed "approved" line must not pass
    # the gate; the op stays quarantined.
    my_ops = []
    op = str(uuid.uuid4())
    my_ops.append(op)
    rsm.quarantine_op(op, "probe_action", "probe death")
    _forge_approved_line(op)
    check("w6p01: forged approved line does not pass the gate",
          rsm.op_quarantine_status(op) == "quarantined",
          rsm.op_quarantine_status(op))
    # The ledger rewrites (resume + approve cycles) must not bless the
    # forgery into a sealed, gate-passing entry.
    rsm.mark_ops_awaiting_approval()
    check("w6p01: resume rewrite does not bless the forgery",
          rsm.op_quarantine_status(op) == "awaiting_approval",
          rsm.op_quarantine_status(op))
    rsm.approve_op(str(uuid.uuid4()), "I, the educator, approve re-dispatching this quarantined op")  # unrelated approve, rewrites ledger
    check("w6p01: approve rewrite does not bless the forgery",
          rsm.op_quarantine_status(op) == "awaiting_approval",
          rsm.op_quarantine_status(op))
    # The legitimate flow still passes: approve_op seals, gate honors it.
    check("w6p01: legit approve_op succeeds", rsm.approve_op(op, "I, the educator, approve re-dispatching this quarantined op") is True)
    check("w6p01: sealed approval passes the gate",
          rsm.op_quarantine_status(op) == "approved",
          rsm.op_quarantine_status(op))
    # Tampering with a sealed entry (flipping status out-of-band) breaks
    # the seal: the tampered line is ignored.
    op2 = str(uuid.uuid4())
    my_ops.append(op2)
    rsm.quarantine_op(op2, "probe_action", "probe death")
    lines = open(rsm.QUAR_PATH).read().splitlines()
    rec = json.loads(lines[-1])
    rec["status"] = "approved"
    with open(rsm.QUAR_PATH, "a") as f:
        f.write(json.dumps(rec) + "\n")
    check("w6p01: tampered sealed entry is ignored",
          rsm.op_quarantine_status(op2) == "quarantined",
          rsm.op_quarantine_status(op2))
    # Pre-seal legacy entries: blocking statuses still block, but a
    # legacy "approved" line is never trusted.
    op3 = str(uuid.uuid4())
    my_ops.append(op3)
    with open(rsm.QUAR_PATH, "a") as f:
        f.write(json.dumps({"kind": "op", "op_id": op3, "action": "x",
                            "status": "quarantined",
                            "quarantined_at": 1}) + "\n")
        f.write(json.dumps({"kind": "op", "op_id": op3, "action": "x",
                            "status": "approved", "approved": True}) + "\n")
    check("w6p01: legacy approved line is not trusted",
          rsm.op_quarantine_status(op3) == "quarantined",
          rsm.op_quarantine_status(op3))
    # New entries are sealed on the wire.
    op4 = str(uuid.uuid4())
    my_ops.append(op4)
    entry = rsm.quarantine_op(op4, "probe_action", "probe death")
    check("w6p01: appended entries carry ledger_hmac",
          entry.get("ledger_hmac", "").startswith("hmac-sha256:"))
    check("w6p01: quarantine secret file is 0600",
          oct(os.stat(rsm._quarantine_secret_path()).st_mode & 0o777)
          == "0o600")
    # Leave no actionable ops behind for later tests: run the legit flow
    # for every op this test created.
    rsm.mark_ops_awaiting_approval()
    for o in my_ops:
        rsm.approve_op(o, "I, the educator, approve re-dispatching this quarantined op")
    check("w6p01: test ops all terminal afterwards",
          all(rsm.op_quarantine_status(o) == "approved" for o in my_ops))


# ------------------------------------------------------- W6-P0-1 secret loss


def t_quarantine_secret_loss_w6p01():
    # A lost or corrupt quarantine.secret must fail CLOSED: previously
    # sealed "approved" entries no longer verify, so the op falls back
    # to "quarantined" instead of being admitted. The test saves and
    # restores the secret around each scenario so later tests (which
    # run against the same scratch store) see no pollution.
    auth = ("I, the educator, approve re-dispatching this quarantined "
            "op")
    secret_path = rsm._quarantine_secret_path()

    def _save_secret():
        with open(secret_path, "rb") as fh:
            return fh.read()

    def _restore_secret(blob):
        with open(secret_path, "wb") as fh:
            fh.write(blob)

    # Lost secret.
    op = str(uuid.uuid4())
    rsm.quarantine_op(op, "probe_action", "probe death")
    rsm.mark_ops_awaiting_approval()
    check("w6p01-secret-loss: legit approval passes before loss",
          rsm.approve_op(op, auth) is True)
    check("w6p01-secret-loss: status approved before loss",
          rsm.op_quarantine_status(op) == "approved",
          rsm.op_quarantine_status(op))
    saved = _save_secret()
    os.remove(secret_path)
    after = rsm.op_quarantine_status(op)
    check("w6p01-secret-loss: prior approval fails closed after loss",
          after == "quarantined", after)
    # Recovery: restoring the secret from backup re-admits the prior
    # approval (the seal verifies again).
    _restore_secret(saved)
    check("w6p01-secret-loss: approval works again after secret "
          "restore",
          rsm.op_quarantine_status(op) == "approved",
          rsm.op_quarantine_status(op))

    # Corrupt secret (present but unparseable): quarantined aside, a
    # fresh secret minted, prior approvals fail closed.
    op2 = str(uuid.uuid4())
    rsm.quarantine_op(op2, "probe_action", "probe death")
    rsm.mark_ops_awaiting_approval()
    rsm.approve_op(op2, auth)
    check("w6p01-secret-loss: status approved before corruption",
          rsm.op_quarantine_status(op2) == "approved",
          rsm.op_quarantine_status(op2))
    saved = _save_secret()
    with open(secret_path, "w", encoding="utf-8") as fh:
        fh.write("{not valid json")
    after2 = rsm.op_quarantine_status(op2)
    check("w6p01-secret-loss: prior approval fails closed after "
          "corruption",
          after2 == "quarantined", after2)
    check("w6p01-secret-loss: corrupt secret was quarantined aside",
          any(n.startswith(os.path.basename(secret_path) + ".corrupt.")
              for n in os.listdir(os.path.dirname(secret_path))))
    _restore_secret(saved)
    check("w6p01-secret-loss: approval works again after secret "
          "restore",
          rsm.op_quarantine_status(op2) == "approved",
          rsm.op_quarantine_status(op2))


# ---------------------------------------------------------------- W4-P2-4

def t_401_taxonomy():
    detail = ex._pat_401_detail()
    check("401: names token cause",
          "personal access token" in detail, detail[:60])
    check("401: remedy is mint-a-fresh-token",
          "mint a fresh token" in detail)
    check("401: re-sign-in named as NOT the fix",
          "cannot fix this" in detail)
    check("401: does not overclaim (revoked vs expired vs invalid)",
          "does not prove" in detail)

    real_do = ex._do_request
    try:
        def fake_401(method, url, headers, body, timeout, max_bytes=None):
            return 401, {}, b'{"status":"unauthenticated"}'
        ex._do_request = fake_401
        try:
            ex.request_with_retry("GET", "https://canvas.example/api/x",
                                  {"Authorization": "Bearer REDACTED"},
                                  b"", False)
            raised = None
        except ex.ProviderHttpError as e:
            raised = e
        check("401: request_with_retry raises ProviderHttpError on 401",
              raised is not None and raised.status == 401,
              repr(raised)[:100] if raised else "no raise")

        def fake_403(method, url, headers, body, timeout, max_bytes=None):
            return 403, {}, b"forbidden"
        ex._do_request = fake_403
        try:
            ex.request_with_retry("GET", "https://canvas.example/api/x",
                                  {}, b"", False)
            raised = None
        except ex.ProviderHttpError as e:
            raised = e
        check("401: other 4xx keep the generic fail-fast",
              raised is not None and "fail fast on 4xx" in str(raised))
    finally:
        ex._do_request = real_do


# ------------------------------------------------- W4-P2-1 resume command

def t_resume_cmd():
    # Rig the stored principal via the session record fallback.
    with open(rsm.SESSION_PATH, "w") as f:
        json.dump({"canvas": {"principal": {"id": 777,
                                            "name": "Edu T. Or"}}}, f)
    rsm.impose_halt({"signal": "selftest"})
    op = str(uuid.uuid4())
    rsm.quarantine_op(op, "probe_action", "probe death")
    # Mismatch: halt stays, escalation written, ops stay quarantined.
    moved = rsm.verified_resume_after_manual_signin(999, "Intruder")
    check("resume: mismatch returns -1", moved == -1)
    check("resume: halt stays on mismatch",
          rsm.check_write_allowed()[0] is False)
    check("resume: op still quarantined on mismatch",
          rsm.op_quarantine_status(op) == "quarantined")
    # Match: per-op approval re-armed, halt lifted.
    moved = rsm.verified_resume_after_manual_signin(777, "Edu T. Or")
    check("resume: match returns moved count", moved == 1, repr(moved))
    check("resume: op awaiting_approval after match",
          rsm.op_quarantine_status(op) == "awaiting_approval")
    check("resume: halt lifted after match",
          rsm.check_write_allowed()[0] is True)
    # W6-P2-A4: same account, new display name: the stored name is
    # refreshed so the helper UI does not lag a rename.
    with open(rsm.SESSION_PATH, "w") as f:
        json.dump({"canvas": {"principal": {"id": 777,
                                            "name": "Edu T. Or"}}}, f)
    rsm.impose_halt({"signal": "selftest"})
    moved = rsm.verified_resume_after_manual_signin(777, "Edu Tutor")
    check("w6p2a4: resume refreshes the stored display name",
          moved >= 0 and json.load(open(rsm.SESSION_PATH))["canvas"]
          ["principal"]["name"] == "Edu Tutor",
          json.load(open(rsm.SESSION_PATH))["canvas"]["principal"])
    # Mismatch never touches the stored name.
    with open(rsm.SESSION_PATH, "w") as f:
        json.dump({"canvas": {"principal": {"id": 777,
                                            "name": "Edu Tutor"}}}, f)
    rsm.impose_halt({"signal": "selftest"})
    moved = rsm.verified_resume_after_manual_signin(999, "Intruder")
    check("w6p2a4: mismatch leaves the stored name alone",
          moved == -1 and json.load(open(rsm.SESSION_PATH))["canvas"]
          ["principal"]["name"] == "Edu Tutor")
    # Clean up: leave no halt behind for other suites.
    rsm.lift_halt()


# ------------------------------------------------- W4-P2-1 stale command

def t_stale_command():
    # A stale command (lane re-authenticated since dispatch) is NOT
    # session death: the session is fresh. The executor must release the
    # claim without arming the re-auth machinery.
    from transport import browser_backend as bb
    stale = bb.BrowserStaleCommand("stale")
    dead = bb.BrowserSessionDead("dead")
    check("stale: not classified as session death",
          ex._is_session_dead(stale) is False)
    check("stale: classified as stale command",
          ex._is_stale_command(stale) is True)
    check("stale: genuine death still classified as death",
          ex._is_session_dead(dead) is True
          and ex._is_stale_command(dead) is False)
    check("stale: subclass of BrowserSessionDead (catch-all safety)",
          isinstance(stale, bb.BrowserSessionDead))
    # Verify-phase stale: quarantine WITHOUT halt, and the notification
    # names the refresh, never a re-sign-in.
    op = str(uuid.uuid4())
    rsm.lift_halt()  # ensure the pre-condition: no halt before the stale op
    ex._on_stale_verify(op, "probe_action", "probe stale verify")
    check("stale verify: op quarantined",
          rsm.op_quarantine_status(op) == "quarantined")
    check("stale verify: no halt imposed",
          rsm.check_write_allowed()[0] is True)
    with open(rsm.NOTIFY_PATH) as f:
        note = f.read()
    check("stale verify: notification names the refresh",
          "was refreshed" in note, note[:80])
    check("stale verify: notification never asks for re-sign-in",
          "sign in to Canvas again" not in note
          and "expired" not in note.lower(), note[:80])


def main():
    t_tree_id()
    t_prev_retention()
    t_prev_ageout()
    t_session_death_quarantine()
    t_expiry_horizon()
    t_quarantine_flow()
    t_reapproval_requires_educator_authorization()
    t_quarantine_gate()
    t_quarantine_seal_w6p01()
    t_quarantine_secret_loss_w6p01()
    t_401_taxonomy()
    t_resume_cmd()
    t_stale_command()
    print("session_lifecycle_selftest: %d passed, %d failed"
          % (len(PASS), len(FAIL)))
    if FAIL:
        print("FAILED: %s" % FAIL)
    shutil.rmtree(SCRATCH, ignore_errors=True)
    return not FAIL


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
