#!/usr/bin/env python3
"""Adversarial wave-4 dispatch-integrity selftest (W4-P0-10, W4-P0-11,
W4-P1-14, W4-P1-15, W4-P2-26, W4-P2-27).

Runs entirely on synthetic fixtures: a scripted fake transport, a
ChromiumSession pointed at fake tenants, and the wave-4 scratch tree
(MORROW_SELFTEST_SCRATCH). No real credentials, no learner data, no
provider calls, no live browser.

Proves, per finding:
  W4-P0-10: a manifest declaring read/plan while carrying a PUT/POST/
    PATCH/DELETE (request or multi_step) is refused as
    EffectClassMismatch before any provider call or journal write.
  W4-P0-11: course writes need a frozen target identity (course_id,
    course_name, term when known); the provider's course GET must
    agree on id, name, and term before any write; whole-token
    corroboration (course 12 never matches 312); the signed
    approval's target block is cross-checked against the dispatch.
  W4-P1-14/W4-P2-27: dispatch-tenant vs helper-tenant binding names
    both tenants on mismatch.
  W4-P1-15: before_state_digest is recomputed from a fresh provider
    read; changed state fails closed (StaleBeforeState); a digest
    with no declared reader fails closed (misconfiguration); an
    explicitly unsupported family proceeds with an honest journal.
  W4-P2-26: dry-run renders the exact request (secrets redacted) with
    zero provider calls, zero journal changes, zero claims, and zero
    approval consumption.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)

import json
import os
import shutil
import sys
import uuid as _uuid_mod

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "dispatch"),
           os.path.join(REPO, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# NOTE: import the dispatch.* package modules, not the top-level names:
# transport/chromium_session.py does `from dispatch import executor`,
# so `dispatch.executor` is the module whose exceptions the session
# raises. Importing plain `executor`/`admission` would create second
# module objects whose exception classes never match.
from dispatch import executor as ex

# Selftest harness: the approvals here are minted on the driver
# channel, so dispatch runs with require_educator_channel=False (the
# production default is True).
def _driver_channel(fn):
    def call(*a, **k):
        k.setdefault("require_educator_channel", False)
        return fn(*a, **k)
    return call


ex.dispatch_entry = _driver_channel(ex.dispatch_entry)
ex.dispatch_catalog_op = _driver_channel(ex.dispatch_catalog_op)
ex.dispatch_undo = _driver_channel(ex.dispatch_undo)

# The scenarios use literal ids and synthetic paths that are not
# catalog path templates; the live-proven catalog gate is covered by
# dispatch/test_direct_lane_hardening.py and is a no-op here.
ex.live_proven_gate = lambda *a, **k: None  # noqa: E731
from dispatch import admission as ad
import chromium_session as _cs_mod
from chromium_session import ChromiumSession
TenantBindingMismatch = ex.TenantBindingMismatch

# W4-P1-14/W4-P2-27: the dispatch tenant is bound against the helper's
# configured tenant from the lane state store. Stub the store to the
# fake tenant so this hermetic selftest stays self-consistent (the
# real lane state on a dev machine names a different tenant).
_cs_mod._lane_state_base = lambda: BASE  # noqa: E731
# The signed-in account check (final muse audit M3) reads users/self
# before writes; these fakes script every provider call, so it is a
# no-op here. It is covered by transport/test_principal_check.py.
_cs_mod.ChromiumSession._verify_principal = lambda *a, **k: None  # noqa: E731


BASE = "https://canvas.example.edu"
WRONG = "https://wrong-tenant.example.edu"


class FakeTransport:
    """Scripted stand-in for LocalChromiumTransport (the CDP layer).

    Script items are ("ok", status, body_text) or ("raise", exc).
    Records (method, path) calls like the write-hardening selftest."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def ensure_session(self):
        return (1, "Test User")

    def api(self, method, path, data=None, _ws=None, timeout=60,
            as_json=False, max_bytes=None):
        self.calls.append((method, path))
        if not self.script:
            return 200, {}, "{}"
        kind = self.script.pop(0)
        if kind[0] == "raise":
            raise kind[1]
        headers = kind[3] if len(kind) > 3 else {}
        return kind[1], headers, kind[2]


def _session(script, base=BASE):
    transport = FakeTransport(script)
    cs = ChromiumSession(base, transport=transport)
    cs._fake_transport = transport
    cs._browser_owned = True
    cs._auth_state = "ready"
    return cs


def _pack():
    return {"max_body_bytes": 262144}


def _oid(label):
    """Deterministic UUID for a test label (FrozenPlan.check_uuid)."""
    return str(_uuid_mod.uuid5(_uuid_mod.NAMESPACE_DNS, label))


def _plan(entry_name, params, op_id, target_identity=None,
          readback=None, digest=None):
    plan_data = {
        "op_id": _oid(op_id),
        "entry_name": entry_name,
        "params": params,
        "before_state_digest": digest,
        "frozen_readback": readback,
        "target_identity": target_identity,
    }
    return ex.FrozenPlan(plan_data, "wave4-selftest-plan")


def _entry(name, method, path, before_state=None):
    entry = ex.catalog_descriptor_to_entry(
        name, method, path, "write", provider="canvas",
        extra={"before_state": (before_state if before_state is not None
                                else {"unsupported": True,
                                      "reason": "wave-4 selftest"})})
    entry["request"]["body"] = {"assignment_group": {"name": "W4"}}
    return entry


def _approve(entry, params, tenant, target_identity=None):
    record = ad.mint_approval(entry, params, tenant,
                              target_identity=target_identity)
    ad.sign_approval(
        record,
        "I, the educator, authorize this exact wave-4 selftest action on the "
        "named course",
        # W6-P1-A2: the harness simulates a genuine educator approval.
        channel="educator-chat")
    return record


def _journal_ops(journal):
    ops = []
    if os.path.exists(journal):
        with open(journal) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        ops.append(json.loads(line))
                    except ValueError:
                        pass
    return ops


def _find_journal(journal, op_id):
    found = None
    for op in _journal_ops(journal):
        if op.get("op_id") == op_id:
            found = op
    return found


def _find_outcome_journal(journal, op_id):
    """Outcome records only: WAL claim/release rows are bookkeeping the
    release leaves behind so the op_id stays reusable, not outcomes."""
    for op in _journal_ops(journal):
        if op.get("op_id") == op_id and op.get("wal") not in (
                ex._NON_OUTCOME_WAL):
            return op
    return None


def _check(cond, label, failures):
    if cond:
        print("  ok", label)
    else:
        print("  FAIL", label)
        failures.append(label)


def main():
    failures = []
    scratch = os.environ.get("MORROW_SELFTEST_SCRATCH",
                             os.path.expanduser("~/.morrow/selftest"))
    os.makedirs(scratch, exist_ok=True)

    # Hermetic re-auth halt: the write-halt gate reads the reauth
    # state machine's HALT_PATH (ambient ~/.morrow may carry a halt from
    # other testing; never touch it, just point the test elsewhere).
    from reauth import state_machine as _rsm

    def setup(tag):
        d = os.path.join(scratch, "wave4-%s" % tag)
        # Start hermetic: remove the whole section dir (journal, secret,
        # approvals) so stale WAL rows from a previous run cannot pollute
        # "nothing journaled" assertions. Removing the dir (not just the
        # journal file) keeps the journal-deletion tripwire honest: a
        # missing journal WITH a surviving secret still fails closed.
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(os.path.join(d, "journal"), exist_ok=True)
        os.makedirs(os.path.join(d, "approvals"), exist_ok=True)
        ex.JOURNAL_PATH = os.path.join(d, "journal", "ops.jsonl")
        ex.MORROW_HOME = d
        ad.APPROVALS_DIR = os.path.join(d, "approvals")
        ad.CONSUMED_PATH = os.path.join(d, "approvals", "consumed.json")
        ad.SIGNING_KEY_PATH = os.path.join(d, "approvals", ".signing.key")
        _rsm.HALT_PATH = os.path.join(d, "write_halt")
        return ex.JOURNAL_PATH

    # ---- A. W4-P0-10: effect-class bypass ----
    print("A: effect-class enforcement (W4-P0-10)")
    journal = setup("a")
    try:
        for idx, declared in enumerate(("read", "plan")):
            entry = _entry("w4-write", "PUT",
                           "/api/v1/courses/112/assignment_groups/5")
            entry["effects"] = declared
            params = {"course_id": "112"}
            plan = _plan("w4-write", params, "w4-a%d" % idx)
            session = _session([])
            try:
                ex.dispatch_entry(entry, params, session, _pack(), plan,
                                  op_id=_oid("w4-a%d" % idx)
)
                _check(False, "declared %s + PUT must be refused" % declared,
                       failures)
            except ex.EffectClassMismatch as e:
                msg = str(e)
                _check(msg.startswith(
                    "entry 'w4-write' declares effects='%s'" % declared),
                       "exact EffectClassMismatch for declared %s" % declared,
                       failures)
                _check("perform a write" in msg,
                       "message names the write the entry performs",
                       failures)
            _check(session._fake_transport.calls == [],
                   "declared %s + PUT: zero provider calls" % declared,
                   failures)
            _check(_find_outcome_journal(journal, _oid("w4-a%d" % idx)) is None,
                   "declared %s + PUT: nothing journaled" % declared,
                   failures)
            token = ex.claim_op_id(_oid("w4-a%d" % idx), "write", "w4-write",
                                   "write",
                                   ex.digest_of({}))
            _check(bool(token), "declared %s refusal leaves op_id reusable"
                   % declared, failures)
            ex.release_op_id(_oid("w4-a%d" % idx), token, "selftest cleanup")
        # Multi-step read carrying a POST step is refused too.
        entry = ex.catalog_descriptor_to_entry(
            "w4-ms", "GET", "/api/v1/courses/112/pages", "read",
            provider="canvas",
            extra={"before_state": {"unsupported": True, "reason": "w4"}})
        entry["effects"] = "read"
        entry["multi_step"] = [
            {"name": "step1", "method": "POST",
             "url": "{canvas_base}/api/v1/courses/112/assignment_groups",
             "body": {"assignment_group": {"name": "W4"}}}]
        entry.pop("request", None)
        plan = _plan("w4-ms", {"course_id": "112"}, "w4-a2")
        session = _session([])
        try:
            ex.dispatch_entry(entry, {"course_id": "112"}, session, _pack(),
                              plan, op_id=_oid("w4-a2")
)
            _check(False, "read + multi_step POST must be refused", failures)
        except ex.EffectClassMismatch as e:
            _check("multi_step" in str(e),
                   "multi_step write named in the refusal", failures)
        _check(session._fake_transport.calls == [],
               "multi_step refusal: zero provider calls", failures)
        # A browser block with an unknown action fails closed as a write.
        entry = ex.catalog_descriptor_to_entry(
            "w4-br", "GET", "/api/v1/courses/112/pages", "read",
            provider="canvas")
        entry["effects"] = "read"
        entry["request"] = {"method": "GET",
                            "url": "{canvas_base}/api/v1/courses/112/pages",
                            "browser": {"action": "execute_script",
                                        "script": "document.title"}}
        entry.pop("multi_step", None)
        plan = _plan("w4-br", {"course_id": "112"}, "w4-a3")
        session = _session([])
        try:
            ex.dispatch_entry(entry, {"course_id": "112"}, session, _pack(),
                              plan, op_id=_oid("w4-a3"))
            _check(False, "read + unknown browser action must be refused",
                   failures)
        except ex.EffectClassMismatch as e:
            _check("not a known read-only action" in str(e),
                   "unknown browser action fails closed as a write",
                   failures)
        _check(session._fake_transport.calls == [],
               "unknown browser action: zero provider calls", failures)
        # A browser block with a known read-only action stays a read.
        entry2 = ex.catalog_descriptor_to_entry(
            "w4-br2", "GET", "/api/v1/courses/112/pages", "read",
            provider="canvas")
        entry2["effects"] = "read"
        entry2["request"] = {"method": "GET",
                             "url": "{canvas_base}/api/v1/courses/112/pages",
                             "browser": {"action": "navigate"}}
        derived, _reason = ex.derive_effect_class(entry2)
        _check(derived == "read",
               "known read-only browser action (navigate) derives as read",
               failures)
        # Control: declared write reaches the normal gates, not the
        # effect-class refusal.
        entry = _entry("w4-write", "PUT",
                       "/api/v1/courses/112/assignment_groups/5")
        plan = _plan("w4-write", {"course_id": "112"}, "w4-a3")
        session = _session([])
        try:
            ex.dispatch_entry(entry, {"course_id": "112"}, session, _pack(),
                              plan, op_id=_oid("w4-a3"),
                               approval=None)
            _check(False, "write without approval must be refused",
                   failures)
        except ad.WriteApprovalMissing:
            _check(True, "declared write reaches approval gate "
                   "(WriteApprovalMissing, not EffectClassMismatch)",
                   failures)
    finally:
        pass

    # ---- B. W4-P0-11: target identity ----
    print("B: write target identity (W4-P0-11)")
    journal = setup("b")
    try:
        ti = {"course_id": "112", "course_name": "Intended Course"}
        # B1: provider names a different course -> refused, no write sent.
        entry = _entry("w4-ag", "POST",
                       "/api/v1/courses/112/assignment_groups")
        params = {"course_id": "112"}
        plan = _plan("w4-ag", params, "w4-b1", target_identity=ti,
                     readback="frozen (course 112) Intended Course")
        session = _session([("ok", 200, json.dumps(
            {"id": 112, "name": "Other Course"}))])
        approval = _approve(entry, params, BASE, target_identity=ti)
        try:
            ex.dispatch_entry(entry, params, session, _pack(), plan,
                              op_id=_oid("w4-b1"),
                               approval=approval)
            _check(False, "provider course-name mismatch must be refused",
                   failures)
        except ex.TargetIdentityMismatch as e:
            msg = str(e)
            _check("Other Course" in msg and "Intended Course" in msg,
                   "refusal names both the provider course and the plan "
                   "course", failures)
        _check(len(session._fake_transport.calls) == 1 and
               session._fake_transport.calls[0][0] == "GET",
               "typoed course: only the course GET was sent; the write "
               "never went out", failures)
        _check(_find_outcome_journal(journal, _oid("w4-b1")) is None,
               "typoed course: no outcome journal record", failures)
        token = ex.claim_op_id(_oid("w4-b1"), "write", "w4-ag", "write",
                                ex.digest_of({}))
        _check(bool(token),
               "typoed course: claim released, op_id reusable", failures)
        ex.release_op_id(_oid("w4-b1"), token, "selftest cleanup")
        # W4 approval ordering: the refused attempt did NOT burn the
        # approval; the same signed record admits a corrected retry.
        plan_ok = _plan("w4-ag", params, "w4-b1r", target_identity=ti,
                        readback="frozen (course 112) Intended Course")
        session2 = _session([
            ("ok", 200, json.dumps({"id": 112, "name": "Intended Course"})),
            ("ok", 201, json.dumps({"id": 7, "name": "W4"})),
            ("ok", 200, json.dumps({"id": 7, "name": "W4"})),
        ])
        ex.dispatch_entry(entry, params, session2, _pack(), plan_ok,
                          op_id=_oid("w4-b1r"), approval=approval)
        rec = _find_journal(journal, _oid("w4-b1r"))
        _check(rec is not None and rec.get("wal") == "complete",
               "refused target: same approval admits a corrected retry",
               failures)
        # B2: declared target != write target -> refused at the gate, no
        # provider calls at all.
        # The approval is consistent with the dispatch (course 112);
        # it is the FROZEN PLAN that declares a different reviewed target
        # (course 111), so the dispatch-entry gate must refuse.
        # B2 needs its own entry name: the B1/B1r digest is consumed
        # by the corrected retry above, and approvals are single-use.
        entry_b2 = _entry("w4-agb2", "POST",
                          "/api/v1/courses/112/assignment_groups")
        plan = _plan("w4-agb2", {"course_id": "112"}, "w4-b2",
                     target_identity={"course_id": "111",
                                      "course_name": "Intended Course"})
        session = _session([])
        approval = _approve(entry_b2, {"course_id": "112"}, BASE,
                            target_identity=ti)
        try:
            ex.dispatch_entry(entry_b2, {"course_id": "112"}, session,
                              _pack(), plan, op_id=_oid("w4-b2"),
                               approval=approval)
            _check(False, "declared/write target mismatch must be refused",
                   failures)
        except ex.TargetIdentityMismatch as e:
            _check("111" in str(e) and "112" in str(e),
                   "gate refusal names the declared and actual course ids",
                   failures)
        _check(session._fake_transport.calls == [],
               "gate mismatch: zero provider calls", failures)
        # B3: no declared target identity -> fail closed.
        # B3 needs its own entry name: the w4-ag digest is consumed by the
        # B1r retry. The approval carries a target block (so admission
        # passes); it is the FROZEN PLAN that declares no target, and the
        # dispatch-entry gate must refuse.
        entry_b3 = _entry("w4-agb3", "POST",
                          "/api/v1/courses/112/assignment_groups")
        plan = _plan("w4-agb3", {"course_id": "112"}, "w4-b3",
                     readback="frozen (course 112) Intended Course")
        session = _session([])
        approval = _approve(entry_b3, {"course_id": "112"}, BASE,
                            target_identity=ti)
        try:
            ex.dispatch_entry(entry_b3, {"course_id": "112"}, session,
                              _pack(), plan, op_id=_oid("w4-b3"),
                               approval=approval)
            _check(False, "missing target_identity must be refused",
                   failures)
        except ex.TargetIdentityMismatch as e:
            _check("declares no target_identity" in str(e),
                   "missing target_identity fails closed", failures)
        _check(session._fake_transport.calls == [],
               "missing target: zero provider calls", failures)
        # B4 control: agreeing target -> dispatch proceeds; the DELETE is
        # then verified by the member GET answering 404.
        del_entry = ex.catalog_descriptor_to_entry(
            "w4-del", "DELETE",
            "/api/v1/courses/112/assignment_groups/5", "write",
            provider="canvas",
            extra={"before_state": {"unsupported": True, "reason": "w4"}})
        params = {"course_id": "112"}
        plan = _plan("w4-del", params, "w4-b4", target_identity=ti,
                     readback="frozen (course 112) Intended Course")
        session = _session([("ok", 200, json.dumps(
            {"id": 112, "name": "Intended Course"})),
            ("ok", 200, json.dumps({"id": 5})),
            ("ok", 404, json.dumps({"errors": []}))])
        approval = _approve(del_entry, params, BASE, target_identity=ti)
        ex.dispatch_entry(del_entry, params, session, _pack(), plan,
                            op_id=_oid("w4-b4"),
                             approval=approval)
        rec = _find_journal(journal, _oid("w4-b4"))
        _check(rec is not None and rec.get("wal") == "complete",
               "agreeing target: write dispatches (journaled complete)",
               failures)
        methods = [m for m, _u in session._fake_transport.calls]
        _check(methods == ["GET", "DELETE", "GET"],
               "agreeing target: course GET precheck, the write, then "
               "the absence readback",
               failures)
        rec = _find_journal(journal, _oid("w4-b4"))
        verified = (rec or {}).get("target") or {}
        _check(str(verified.get("course_id")) == "112" and
               verified.get("course_name") == "Intended Course",
               "journal carries the provider-verified target identity",
               failures)
        # B5: whole-token corroboration: frozen readback for course 312
        # does not corroborate a write to course 12.
        entry12 = ex.catalog_descriptor_to_entry(
            "w4-del12", "DELETE",
            "/api/v1/courses/12/assignment_groups/5", "write",
            provider="canvas",
            extra={"before_state": {"unsupported": True, "reason": "w4"}})
        params12 = {"course_id": "12"}
        ti12 = {"course_id": "12", "course_name": "Twelve Course"}
        plan = _plan("w4-del12", params12, "w4-b5", target_identity=ti12,
                     readback="frozen (course 312) Twelve Course")
        session = _session([])
        approval = _approve(entry12, params12, BASE, target_identity=ti12)
        try:
            ex.dispatch_entry(entry12, params12, session, _pack(), plan,
                              op_id=_oid("w4-b5"),
                               approval=approval)
            _check(False, "312 readback must not corroborate course 12",
                   failures)
        except ex.TargetIdentityMismatch:
            _check(True, "312 readback rejected for course 12 (whole-token "
                   "corroboration)", failures)
        _check(session._fake_transport.calls == [],
               "312/12 mismatch: zero provider calls", failures)
    finally:
        pass

    # ---- C. W4-P1-14/W4-P2-27: helper-tenant binding ----
    print("C: helper-tenant binding (W4-P1-14/W4-P2-27)")
    journal = setup("c")
    try:
        entry = _entry("w4-agc", "POST",
                       "/api/v1/courses/112/assignment_groups")
        params = {"course_id": "112"}
        ti = {"course_id": "112", "course_name": "Intended Course"}
        plan = _plan("w4-agc", params, "w4-c1", target_identity=ti)
        # Helper lane is bound to BASE; the dispatch session is on WRONG.
        session = _session([], base=WRONG, )
        approval = _approve(entry, params, WRONG, target_identity=ti)
        try:
            ex.dispatch_entry(entry, params, session, _pack(), plan,
                              op_id=_oid("w4-c1"),
                               approval=approval)
            _check(False, "wrong helper tenant must be refused", failures)
        except TenantBindingMismatch as e:
            msg = str(e)
            _check("dispatch tenant" in msg and "helper tenant" in msg,
                   "refusal says dispatch tenant differs from helper "
                   "tenant", failures)
            _check(WRONG in msg and BASE in msg,
                   "refusal names BOTH tenant URLs", failures)
        _check(session._fake_transport.calls == [],
               "tenant mismatch: zero provider calls", failures)
        _check(_find_outcome_journal(journal, _oid("w4-c1")) is None,
               "tenant mismatch: nothing journaled", failures)
        # Control: matching tenants pass the binding (then reach the
        # approval gate normally).
        session = _session([], base=BASE, )
        approval = _approve(entry, params, BASE, target_identity=ti)
        plan = _plan("w4-agc", params, "w4-c2", target_identity=ti,
                     readback="frozen (course 112) Intended Course")
        session._fake_transport.script.append(
            ("ok", 200, json.dumps({"id": 112, "name": "Intended Course"})))
        session._fake_transport.script.append(
            ("ok", 201, json.dumps({"id": 7, "name": "W4"})))
        session._fake_transport.script.append(
            ("ok", 200, json.dumps({"id": 7, "name": "W4"})))
        ex.dispatch_entry(entry, params, session, _pack(), plan,
                            op_id=_oid("w4-c2"),
                             approval=approval)
        rec = _find_journal(journal, _oid("w4-c2"))
        _check(rec is not None and rec.get("wal") == "complete",
               "matching tenants: binding passes and the write dispatches",
               failures)
    finally:
        pass

    # ---- D. W4-P1-15: before-state freshness ----
    print("D: before-state freshness (W4-P1-15)")
    journal = setup("d")
    try:
        snapshot = {"id": 5, "name": "W4 group"}
        reader = {"method": "GET",
                  "url": "{canvas_base}/api/v1/courses/112/"
                         "assignment_groups/5"}
        ti = {"course_id": "112", "course_name": "Intended Course"}
        params = {"course_id": "112"}

        def d_entry(tag):
            e = ex.catalog_descriptor_to_entry(
                "w4-ds%s" % tag, "DELETE",
                "/api/v1/courses/112/assignment_groups/5", "write",
                provider="canvas",
                extra={"before_state": dict(reader)})
            return e

        def d_script(world):
            return [("ok", 200, json.dumps(
                {"id": 112, "name": "Intended Course"})),
                ("ok", 200, json.dumps(world)),
                ("ok", 200, json.dumps({"id": 5}))]

        # D1: fresh read matches the frozen digest -> verified, dispatch.
        entry = d_entry("1")
        plan = _plan("w4-ds1", params, "w4-d1", target_identity=ti,
                     readback="frozen (course 112) Intended Course",
                     digest=ex.digest_of(snapshot))
        session = _session(d_script(snapshot))
        approval = _approve(entry, params, BASE, target_identity=ti)
        ex.dispatch_entry(entry, params, session, _pack(), plan,
                            op_id=_oid("w4-d1"),
                             approval=approval)
        rec = _find_journal(journal, _oid("w4-d1")) or {}
        _check(rec.get("wal") == "complete",
               "matching before-state: write dispatches", failures)
        rec = _find_journal(journal, _oid("w4-d1")) or {}
        _check((rec.get("before_state") or {}).get("status") == "verified",
               "journal records before-state as verified", failures)
        # D2: the world moved -> StaleBeforeState, write never sent.
        entry = d_entry("2")
        plan = _plan("w4-ds2", params, "w4-d2", target_identity=ti,
                     readback="frozen (course 112) Intended Course",
                     digest=ex.digest_of(snapshot))
        moved = {"id": 5, "name": "W4 group (renamed by someone else)"}
        session = _session(d_script(moved))
        approval = _approve(entry, params, BASE, target_identity=ti)
        try:
            ex.dispatch_entry(entry, params, session, _pack(), plan,
                              op_id=_oid("w4-d2"),
                               approval=approval)
            _check(False, "moved before-state must be refused", failures)
        except ex.StaleBeforeState as e:
            _check("moved since the plan was frozen" in str(e),
                   "StaleBeforeState names the stale plan", failures)
        methods = [m for m, _u in session._fake_transport.calls]
        _check(methods == ["GET", "GET"],
               "stale before-state: target GET + re-read only; the write "
               "never went out", failures)
        _check(_find_outcome_journal(journal, _oid("w4-d2")) is None,
               "stale before-state: no outcome journal record", failures)
        token = ex.claim_op_id(_oid("w4-d2"), "write", "w4-ds2", "write",
                                ex.digest_of({}))
        _check(bool(token),
               "stale before-state: claim released, op_id reusable",
               failures)
        ex.release_op_id(_oid("w4-d2"), token, "selftest cleanup")
        # W4 approval ordering: the stale refusal did NOT burn the
        # approval; the same signed record admits a re-frozen retry.
        plan_ok = _plan("w4-ds2", params, "w4-d2r", target_identity=ti,
                        readback="frozen (course 112) Intended Course",
                        digest=ex.digest_of("fresh"))
        session2 = _session(d_script("fresh"))
        ex.dispatch_entry(entry, params, session2, _pack(), plan_ok,
                          op_id=_oid("w4-d2r"), approval=approval)
        rec = _find_journal(journal, _oid("w4-d2r"))
        _check(rec is not None and rec.get("wal") == "complete",
               "stale refusal: same approval admits a re-frozen retry",
               failures)
        # D3: digest with no declared reader -> fail closed. The target
        # precheck passes first (one GET), then the freshness guard
        # refuses; the write is never sent.
        entry = ex.catalog_descriptor_to_entry(
            "w4-ds3", "DELETE",
            "/api/v1/courses/112/assignment_groups/5", "write",
            provider="canvas")
        plan = _plan("w4-ds3", params, "w4-d3", target_identity=ti,
                     readback="frozen (course 112) Intended Course",
                     digest=ex.digest_of(snapshot))
        session = _session([("ok", 200, json.dumps(
            {"id": 112, "name": "Intended Course"}))])
        approval = _approve(entry, params, BASE, target_identity=ti)
        try:
            ex.dispatch_entry(entry, params, session, _pack(), plan,
                              op_id=_oid("w4-d3"),
                               approval=approval)
            _check(False, "digest without reader must fail closed",
                   failures)
        except ex.ExecutorError as e:
            _check("declares no before_state reader" in str(e),
                   "digest without reader: misconfiguration refusal",
                   failures)
        _check([m for m, _u in session._fake_transport.calls] == ["GET"],
               "digest without reader: target GET only; the write never "
               "went out", failures)
        # D4: explicitly unsupported family -> proceeds with an honest
        # journal.
        entry = ex.catalog_descriptor_to_entry(
            "w4-ds4", "DELETE",
            "/api/v1/courses/112/assignment_groups/5", "write",
            provider="canvas",
            extra={"before_state": {
                "unsupported": True,
                "reason": "Canvas has no stable re-read for this family"}})
        plan = _plan("w4-ds4", params, "w4-d4", target_identity=ti,
                     readback="frozen (course 112) Intended Course",
                     digest=ex.digest_of(snapshot))
        session = _session([("ok", 200, json.dumps(
            {"id": 112, "name": "Intended Course"})),
            ("ok", 200, json.dumps({"id": 5}))])
        approval = _approve(entry, params, BASE, target_identity=ti)
        ex.dispatch_entry(entry, params, session, _pack(), plan,
                            op_id=_oid("w4-d4"),
                             approval=approval)
        rec = _find_journal(journal, _oid("w4-d4")) or {}
        _check(rec.get("wal") == "complete",
               "explicitly unsupported family: write proceeds", failures)
        rec = _find_journal(journal, _oid("w4-d4")) or {}
        _check((rec.get("before_state") or {}).get("status") == "unsupported",
               "journal records before-state as unsupported with its "
               "reason", failures)
    finally:
        pass

    # ---- E. W4-P2-26: dry-run ----
    print("E: dry-run semantics (W4-P2-26)")
    journal = setup("e")
    try:
        entry = _entry("w4-age", "PUT",
                       "/api/v1/courses/112/assignment_groups/5")
        entry["request"]["headers"] = {
            "Authorization": "Bearer {credential:canvas_pat}"}
        params = {"course_id": "112"}
        ti = {"course_id": "112", "course_name": "Intended Course"}
        plan = _plan("w4-age", params, "w4-e1", target_identity=ti,
                     readback="frozen (course 112) Intended Course")
        session = _session([])
        approval = _approve(entry, params, BASE, target_identity=ti)
        report = ex.dispatch_entry(entry, params, session, _pack(), plan,
                                   op_id=_oid("w4-e1"),
                                    approval=approval,
                                   dry_run=True)
        _check(report.get("dry_run") is True,
               "dry-run returns a dry-run report", failures)
        _check(report.get("provider_calls") == 0 and
               report.get("journaled") is False and
               report.get("approval_consumed") is False,
               "dry-run reports zero provider calls, no journal, no "
               "consumption", failures)
        _check(session._fake_transport.calls == [],
               "dry-run: zero provider calls observed", failures)
        _check(not os.path.exists(journal),
               "dry-run: journal file never created", failures)
        reqs = report.get("requests") or []
        _check(len(reqs) == 1 and reqs[0].get("method") == "PUT",
               "dry-run renders the PUT request", failures)
        headers = (reqs[0].get("headers") or {})
        _check(headers.get("Authorization") == "***REDACTED***",
               "dry-run redacts the credential header", failures)
        _check(reqs[0].get("body", {}).get("assignment_group",
                                           {}).get("name") == "W4",
               "dry-run renders the request body", failures)
        _check(BASE in (reqs[0].get("url") or ""),
               "dry-run renders the resolved tenant URL", failures)
        # W4-P2-26: dry-run never resolves actual secret material. Use a
        # dict-spec credential header and a session that records slot
        # access; the rendered header must be a placeholder and the slot
        # must never be touched.
        entry2 = _entry("w4-e2", "PUT",
                        "/api/v1/courses/112/assignment_groups/5")
        entry2["request"]["headers"] = {
            "X-API-Key": {"credential": "w4_test_slot"}}
        plan2 = _plan("w4-e2", params, "w4-e2", target_identity=ti,
                      readback="frozen (course 112) Intended Course")
        session2 = _session([])
        slot_accesses = []
        _orig_slot_secret = session2.slot_secret
        def _tracking_slot_secret(slot):
            slot_accesses.append(slot)
            return _orig_slot_secret(slot)
        session2.slot_secret = _tracking_slot_secret
        approval2 = _approve(entry2, params, BASE, target_identity=ti)
        report2 = ex.dispatch_entry(entry2, params, session2, _pack(), plan2,
                                    op_id=_oid("w4-e2"),
                                    approval=approval2,
                                    dry_run=True)
        reqs2 = report2.get("requests") or []
        h2 = (reqs2[0].get("headers") or {}) if reqs2 else {}
        _check(h2.get("X-API-Key") == "***REDACTED***",
               "dry-run renders credential slot as a placeholder", failures)
        _check(slot_accesses == [],
               "dry-run never touches the secret slot", failures)
        # The op_id was never claimed: claiming it now must succeed.
        token = ex.claim_op_id(_oid("w4-e1"), "write", "w4-age", "write",
                                ex.digest_of({}))
        _check(bool(token), "dry-run: op_id never claimed, still free",
               failures)
        ex.release_op_id(_oid("w4-e1"), token, "selftest cleanup")
        # The approval was not consumed: admitting it again still works.
        try:
            ad.check_write_approval(entry, params, approval, _oid("w4-e1"),
                                    tenant_base=BASE)
            _check(True, "dry-run: approval NOT consumed (still admits)",
                   failures)
        except Exception as e:
            _check(False,
                   "dry-run: approval NOT consumed (still admits); got %r"
                   % e, failures)
        print("  --- exact dry-run report ---")
        print(json.dumps(report, indent=2, sort_keys=True))
        print("  --- end dry-run report ---")
    finally:
        pass

    # ---- G. undo effect / target / approval ordering ----
    print("G: undo integrity (W4-P0-10/W4-P0-11)")
    journal = setup("g")
    try:
        # G1: an undo block that is not a write is refused outright.
        entry = _entry("w4-gu1", "DELETE",
                       "/api/v1/courses/112/assignment_groups/5")
        entry["undo"] = {"method": "GET",
                         "url": "{canvas_base}/api/v1/courses/112/"
                                "assignment_groups/5"}
        try:
            ex.dispatch_undo(entry, {"course_id": "112"}, {},
                             _oid("w4-g-orig1"), _session([]), _pack(),
                             approval=None)
            _check(False, "non-write undo block must be refused", failures)
        except ex.EffectClassMismatch:
            _check(True, "non-write undo block refused (EffectClassMismatch)",
                   failures)
        # G2/G3 need a journaled write to undo: run one.
        w_entry = _entry("w4-gw", "POST",
                         "/api/v1/courses/112/assignment_groups")
        w_params = {"course_id": "112"}
        w_ti = {"course_id": "112", "course_name": "Intended Course"}
        w_plan = _plan("w4-gw", w_params, "w4-gw", target_identity=w_ti,
                       readback="frozen (course 112) Intended Course")
        w_session = _session([
            ("ok", 200, json.dumps({"id": 112, "name": "Intended Course"})),
            ("ok", 201, json.dumps({"id": 7, "name": "W4"})),
            ("ok", 200, json.dumps({"id": 7, "name": "W4"})),
        ])
        w_approval = _approve(w_entry, w_params, BASE, target_identity=w_ti)
        ex.dispatch_entry(w_entry, w_params, w_session, _pack(), w_plan,
                          op_id=_oid("w4-gw"), approval=w_approval)
        # G2: undo whose provider target disagrees -> refused, approval
        # reusable, nothing sent.
        u_entry = _entry("w4-gw", "POST",
                         "/api/v1/courses/112/assignment_groups")
        u_entry["undo"] = {"method": "DELETE",
                           "url": "{canvas_base}/api/v1/courses/112/"
                                  "assignment_groups/7"}
        u_params = {"course_id": "112"}
        u_approval = _approve(*ex.undo_approval_subject(
            u_entry, u_params, _oid("w4-gw"), {}), BASE,
            target_identity=w_ti)
        u_session = _session([("ok", 200, json.dumps(
            {"id": 112, "name": "Other Course"}))])
        try:
            ex.dispatch_undo(u_entry, u_params, {}, _oid("w4-gw"),
                             u_session, _pack(), approval=u_approval)
            _check(False, "undo target mismatch must be refused", failures)
        except ex.TargetIdentityMismatch:
            _check(True, "undo target mismatch refused", failures)
        _check([m for m, _u in u_session._fake_transport.calls] == ["GET"],
               "refused undo: target GET only; the undo was never sent",
               failures)
        try:
            ad.check_write_approval(*ex.undo_approval_subject(
                u_entry, u_params, _oid("w4-gw"), {}), u_approval,
                _oid("w4-gu2b"), tenant_base=BASE)
            _check(True, "refused undo: approval NOT consumed (reusable)",
                   failures)
        except Exception as e:
            _check(False, "refused undo: approval reusable; got %r" % e,
                   failures)
        # G3: undo with agreeing target -> dispatches and journals.
        u_entry3 = _entry("w4-gw", "POST",
                          "/api/v1/courses/112/assignment_groups")
        u_entry3["undo"] = {"method": "DELETE",
                            "url": "{canvas_base}/api/v1/courses/112/"
                                   "assignment_groups/7"}
        u_approval3 = _approve(*ex.undo_approval_subject(
            u_entry3, u_params, _oid("w4-gw"), {}), BASE,
            target_identity=w_ti)
        u_session3 = _session([
            ("ok", 200, json.dumps({"id": 112, "name": "Intended Course"})),
            ("ok", 200, json.dumps({"id": 5})),
            ("ok", 404, json.dumps({})),
        ])
        out = ex.dispatch_undo(u_entry3, u_params, {}, _oid("w4-gw"),
                               u_session3, _pack(), approval=u_approval3)
        undo_op = out.get("op_id")
        rec = _find_journal(journal, undo_op)
        _check(rec is not None and rec.get("kind") == "undo",
               "agreeing undo: dispatched and journaled as undo", failures)
        methods = [m for m, _u in u_session3._fake_transport.calls]
        _check(methods == ["GET", "DELETE"],
               "agreeing undo: target GET then undo DELETE (no readback: "
               "the undo carries no before_state)",
               failures)
    finally:
        pass

    # ---- H. multi-step: malformed step refuses before the burn ----
    print("H: multi-step pre-burn prevalidation (W4 approval ordering)")
    journal = setup("h")
    try:
        entry = ex.catalog_descriptor_to_entry(
            "w4-ms-bad", "POST", "/api/v1/courses/112/assignment_groups",
            "write", provider="canvas",
            extra={"before_state": {"unsupported": True, "reason": "w4"}})
        entry["multi_step"] = [
            {"name": "step1", "method": "POST",
             "url": "{canvas_base}/api/v1/courses/112/assignment_groups",
             "body": {"name": "Step One"}},
            {"name": "step2", "method": "POST",
             "url": "{canvas_base}/api/v1/courses/112/assignment_groups",
             "body": {}},
        ]
        params = {"course_id": "112"}
        ti = {"course_id": "112", "course_name": "Intended Course"}
        plan = _plan("w4-ms-bad", params, "w4-h1", target_identity=ti,
                     readback="frozen (course 112) Intended Course")
        approval = _approve(entry, params, BASE, target_identity=ti)
        session = _session([
            ("ok", 200, json.dumps({"id": 112, "name": "Intended Course"})),
        ])
        try:
            ex.dispatch_entry(entry, params, session, _pack(), plan,
                              op_id=_oid("w4-h1"), approval=approval)
            _check(False, "malformed multi-step step must be refused",
                   failures)
        except ex.WritePrevalidationFailed:
            _check(True, "malformed step 2 refused pre-burn "
                         "(WritePrevalidationFailed)", failures)
        _check([m for m, _u in session._fake_transport.calls] == ["GET"],
               "pre-burn refusal: target GET only; no step was sent",
               failures)
        try:
            ad.check_write_approval(entry, params, approval,
                                    _oid("w4-h1b"), tenant_base=BASE)
            _check(True, "pre-burn refusal: approval NOT consumed (reusable)",
                   failures)
        except Exception as e:
            _check(False, "pre-burn refusal: approval reusable; got %r" % e,
                   failures)
        _check(_find_outcome_journal(journal, _oid("w4-h1")) is None,
               "pre-burn refusal: no outcome journaled", failures)
    finally:
        pass

    # ---- F. approval record target block ----
    print("F: signed approval target binding (W4-P0-11)")
    entry = _entry("w4-ag", "POST", "/api/v1/courses/112/assignment_groups")
    params = {"course_id": "112"}
    ti = {"course_id": "112", "course_name": "Intended Course"}
    record = ad.mint_approval(entry, params, BASE, target_identity=ti)
    tgt = record.get("target") or {}
    _check(tgt.get("tenant") == BASE and tgt.get("course_id") == "112"
           and tgt.get("course_name") == "Intended Course",
        "signed record visibly carries tenant/course_id/course_name "
        "in target", failures)
    ad.sign_approval(
        record,
        "I, the educator, authorize this exact wave-4 selftest action on the "
        "named course",
        # W6-P1-A2: the harness simulates a genuine educator approval.
        channel="educator-chat")
    try:
        ad._verify_seal(record)
        _check(True, "signed record passes the tamper seal", failures)
    except Exception as e:
        _check(False, "signed record passes the tamper seal (%r)" % e,
               failures)
    tampered = json.loads(json.dumps(record))
    tampered["target"]["course_name"] = "Some Other Course"
    try:
        ad._verify_seal(tampered)
        _check(False, "tampered target.course_name must break the seal",
               failures)
    except ad.ApprovalMismatch:
        _check(True, "tampering with target.course_name breaks the seal",
               failures)
    # The record's target block is cross-checked against the dispatch:
    # course 112's record cannot authorize a course-113 dispatch.
    try:
        ad._verify_record_target(record, {"course_id": "113"}, BASE,
                                 {"name": "w4-ag"})
        _check(False, "target.course_id 112 vs params 113 must be refused",
               failures)
    except ad.ApprovalMismatch as e:
        _check("cannot be retargeted" in str(e),
               "retargeted approval refused (course)", failures)
    try:
        ad._verify_record_target(record, {"course_id": "112"}, WRONG,
                                 {"name": "w4-ag"})
        _check(False, "target tenant BASE vs dispatch WRONG must be "
               "refused", failures)
    except ad.ApprovalMismatch as e:
        _check("cannot be retargeted" in str(e),
               "retargeted approval refused (tenant)", failures)

    if failures:
        print("wave-4 dispatch-integrity selftest: %d FAILURES: %s"
              % (len(failures), failures))
        sys.exit(1)
    print("all wave-4 dispatch-integrity selftests passed")


if __name__ == "__main__":
    main()
