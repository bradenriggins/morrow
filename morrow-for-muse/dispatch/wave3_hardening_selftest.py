#!/usr/bin/env python3
"""Wave-3 adversarial hardening selftest (dispatch/wave3_hardening_selftest.py).

Pins the fixes for the worker-A findings from the 2026-09-21 wave-3 audit:

  W3-P0-6  effect-class downgrade: the caller-supplied effect_class is an
           optional cross-check, never the classifier; the catalog R/W
           column is authoritative for every catalog row (C- and IB-).
  W3-P0-5  learner-data coverage gaps: policy + catalog-flagged rows cover
           every Lane 8 learner-bearing path (the 42-path gap scan).
  W3-P0-9  catalog drift: a scan-consistency test reruns the Lane 8 scan
           logic over every catalog row so drift cannot silently reopen
           a gap.
  W3-P0-15 users_self (C-436): the educator's own profile read, exempt
           from the learner-data gate, pending a live proof battery.
  W3-P1-44 reveal consent provenance: the bare
           MORROW_REVEAL_STUDENT_PII_REASON env var is ignored; consent
           comes only from the educator's hand-created consent file.
  W3-P1-45 query/body blindness: request query/body (and multi-step
           blocks) are scanned for learner tokens, not just the URL.
  W3-P2-5  raw verification detail: verify details go through the same
           learner privacy boundary as receipts before journaling.

Hygiene: hermetic scratch lives under this file's directory (never /tmp),
or under MORROW_SELFTEST_SCRATCH during the audit wave;
environment is saved and restored around every consent/vault test.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import os
import sys
import json

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)                       # dispatch/
sys.path.insert(1, os.path.join(_HERE, ".."))   # repo root

from dispatch.admission import (
    check_learner_data,
    extract_urls,
    load_policy,
    touches_learner_data,
    LearnerDataGated,
)
import dispatch.admission as _admission_mod
import executor as ex

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

TENANT = "https://school.instructure.com"
# Wave-3 hygiene: MORROW_SELFTEST_SCRATCH redirects test scratch to the
# wave's authorized scratch area (never /tmp); the repo-local default
# keeps the suite hermetic outside the audit.
_SCRATCH_ROOT = os.environ.get("MORROW_SELFTEST_SCRATCH")
SCRATCH = (os.path.join(_SCRATCH_ROOT, "wave3-hardening")
           if _SCRATCH_ROOT else os.path.join(_HERE, ".selftest-work"))
os.makedirs(SCRATCH, exist_ok=True)

PASS = []
FAIL = []


def check(name, fn):
    try:
        fn()
    except AssertionError as exc:
        FAIL.append("%s: %s" % (name, exc))
    except Exception as exc:  # noqa: BLE001 - the test wants the message
        FAIL.append("%s: unexpected %r" % (name, exc))
    else:
        PASS.append(name)


def expect_raises(exc_type, fn):
    try:
        fn()
    except exc_type:
        return
    except Exception as exc:  # noqa: BLE001
        raise AssertionError("expected %s, got %r" % (exc_type.__name__, exc))
    raise AssertionError("expected %s, nothing raised" % exc_type.__name__)


POLICY = load_policy()
CATALOG = ex._load_operation_catalog()


def req_entry(url, query=None, body=None, name="t", steps=None):
    request = {"method": "GET", "url": url}
    if query is not None:
        request["query"] = query
    if body is not None:
        request["body"] = body
    entry = {"name": name, "request": request}
    if steps is not None:
        entry["multi_step"] = {"steps": steps}
    return entry


def gated(entry):
    """The learner-data gate fires for this entry (no vault)."""
    try:
        check_learner_data(entry, POLICY, False)
    except LearnerDataGated:
        return True
    return False


# ---------------------------------------------------------------------------
# W3-P0-6: effect-class downgrade
# ---------------------------------------------------------------------------

def t_downgrade_refused():
    # The L8-3 defect: canvas_delete_assignment (catalog W) declared as
    # caller "read" was dispatched as a read, dodging write approval.
    expect_raises(
        ex.CatalogEffectMismatch,
        lambda: ex.catalog_descriptor_to_entry(
            "canvas_delete_assignment", "DELETE",
            "/api/v1/courses/{course_id}/assignments/{id}", "read"))
check("P0-6: effect downgrade (write declared read) refused",
      t_downgrade_refused)


def t_upgrade_refused():
    # The reverse direction is also a contradiction, not a promotion.
    expect_raises(
        ex.CatalogEffectMismatch,
        lambda: ex.catalog_descriptor_to_entry(
            "canvas_list_students", "GET",
            "/api/v1/courses/{course_id}/students", "write"))
check("P0-6: effect upgrade (read declared write) refused", t_upgrade_refused)


def t_omitted_class_uses_catalog():
    # Omitted class: the catalog row's R/W is authoritative.
    e = ex.catalog_descriptor_to_entry(
        "canvas_delete_assignment", "DELETE",
        "/api/v1/courses/{course_id}/assignments/{id}")
    assert e["effects"] == "write", e["effects"]
    e = ex.catalog_descriptor_to_entry(
        "canvas_list_students", "GET",
        "/api/v1/courses/{course_id}/students")
    assert e["effects"] == "read", e["effects"]
check("P0-6: omitted class derives from the catalog row", t_omitted_class_uses_catalog)


def t_matching_class_passes():
    e = ex.catalog_descriptor_to_entry(
        "canvas_delete_assignment", "DELETE",
        "/api/v1/courses/{course_id}/assignments/{id}", "write")
    assert e["effects"] == "write"
check("P0-6: matching declared class is accepted", t_matching_class_passes)


def t_ib_rows_parsed():
    ib = [v for v in CATALOG.values() if v["id"].startswith("IB-")]
    assert len(ib) == 20, "expected 20 IB rows, got %d" % len(ib)
    for row in ib:
        assert row["effect"] in ("read", "write"), row
    e = ex.catalog_descriptor_to_entry(
        "canvas_item_bank_archive_bank", "DELETE", "/api/banks/{bank_id}")
    assert e["effects"] == "write", e["effects"]
check("P0-6: IB rows parse with catalog-derived effects", t_ib_rows_parsed)


def t_unknown_requires_class():
    # Noncatalog synthetic fixtures still need an explicit class.
    expect_raises(ex.ExecutorError,
                  lambda: ex.catalog_descriptor_to_entry(
                      "not_a_real_op", "GET", "/x"))
    e = ex.catalog_descriptor_to_entry("not_a_real_op", "GET", "/x", "read")
    assert e["effects"] == "read"
check("P0-6: noncatalog names still require an explicit class",
      t_unknown_requires_class)


def t_all_rows_have_valid_effect():
    for name, row in CATALOG.items():
        assert row["effect"] in ("read", "write"), (name, row)
        assert row["effect_rw"] in ("R", "W"), (name, row)
check("P0-6: every catalog row carries a valid derived effect",
      t_all_rows_have_valid_effect)


def t_catalog_row_count():
    c = [v for v in CATALOG.values() if v["id"].startswith("C-")]
    # LANE6: bumped 436 -> 437 for lane 5's C-437 (canvas_list_courses,
    # first-run audit 2026-09-22; live-proven read row, well-formed).
    # Lane 5's report was still pending when this pin was updated; if
    # lane 5 renumbers or removes the row, this pin must move with it.
    assert len(c) == 437, "expected 437 C rows (C-437 added), got %d" % len(c)
check("P0-15: catalog carries 437 C rows", t_catalog_row_count)


# ---------------------------------------------------------------------------
# W3-P0-15: users_self (C-436)
# ---------------------------------------------------------------------------

def t_users_self_catalog_row():
    row = CATALOG["users_self"]
    assert row["id"] == "C-436", row
    assert row["method"] == "GET"
    assert row["path"] == "/api/v1/users/self"
    assert row["effect"] == "read", row
    assert row["effect_rw"] == "R", row
    assert row["learner_data"] is False, "users_self is the educator, not a learner"
check("P0-15: users_self is catalog row C-436, read, not learner data",
      t_users_self_catalog_row)


def t_users_self_entry_exempt():
    e = ex.catalog_descriptor_to_entry("users_self", "GET", "/api/v1/users/self")
    assert e["effects"] == "read"
    assert not touches_learner_data(e), "educator-self read must not touch learner data"
    assert not gated(e), "/users/self must stay exempt from the learner gate"
check("P0-15: users_self entry is a read and stays gate-exempt",
      t_users_self_entry_exempt)


def t_users_self_favorites_exempt():
    e = req_entry(TENANT + "/api/v1/users/self/favorites/courses/1")
    assert not gated(e), "educator-self favorites must stay exempt"
check("P0-15: /users/self/favorites stays gate-exempt",
      t_users_self_favorites_exempt)


# ---------------------------------------------------------------------------
# W3-P0-5 / W3-P0-9: learner-data coverage + scan consistency
# ---------------------------------------------------------------------------

# The 42-path Lane 8 gap scan (scratch/lane8/learner_gap_scan.txt): every
# path the scan flagged as learner-bearing but ungated must now be gated.
SCAN_PATHS = [
    "/api/v1/courses/{course_id}/students",
    "/api/v1/courses/{course_id}/recent_students",
    "/api/v1/courses/{course_id}/gradeable_students",
    "/api/v1/courses/{course_id}/moderated_students",
    "/api/v1/courses/{course_id}/student_view_student",
    "/api/v1/courses/{course_id}/search_users",
    "/api/v1/courses/{course_id}/bulk_user_tags",
    "/api/v1/courses/{course_id}/bulk_user_progress",
    "/api/v1/courses/{course_id}/provisional_grades",
    "/api/v1/courses/{course_id}/custom_gradebook_columns",
    "/api/v1/courses/{course_id}/rubric_associations/{assoc_id}/rubric_assessments",
    "/api/v1/courses/{course_id}/peer_reviews",
    "/api/v1/courses/{course_id}/outcome_results",
    "/api/v1/courses/{course_id}/quizzes/{quiz_id}/submission",
    "/api/v1/courses/{course_id}/quizzes/{quiz_id}/anonymous_submissions/{id}",
    "/api/v1/courses/{course_id}/collaborations",
    "/api/v1/courses/{course_id}/conferences",
    "/api/v1/courses/{course_id}/content_share_users",
    "/api/v1/courses/{course_id}/groups/{group_id}/content_share_users",
    "/api/v1/courses/{course_id}/what_if_grades/reset",
    "/api/v1/audit/course/courses/{course_id}",
    "/api/v1/courses/{course_id}/enrollments",
]


def t_scan_paths_gated():
    misses = [p for p in SCAN_PATHS
              if not gated(req_entry(TENANT + p.replace("{course_id}", "1")
                                     .replace("{assoc_id}", "2")
                                     .replace("{quiz_id}", "3")
                                     .replace("{id}", "4")
                                     .replace("{group_id}", "5")))]
    assert not misses, "ungated scan paths: %r" % (misses,)
check("P0-5: all 22 Lane 8 scan paths are gated", t_scan_paths_gated)


def t_previously_gated_still_gated():
    for url in (TENANT + "/api/v1/courses/1/enrollments",
                TENANT + "/api/v1/users/2"):
        assert gated(req_entry(url)), url
check("P0-5: previously gated paths still gated", t_previously_gated_still_gated)


def t_catalog_flagged_rows_gated():
    # Every catalog [LEARNER-DATA] row must fire the gate even when the
    # URL template carries no policy substring.
    misses = []
    for name, row in sorted(CATALOG.items()):
        if not row["learner_data"]:
            continue
        e = ex.catalog_descriptor_to_entry(name, row["method"], row["path"])
        assert e.get("catalog_learner_data") is True, name
        if not gated(e):
            misses.append(name)
    assert not misses, "flagged rows not gated: %r" % (misses,)
check("P0-5: every catalog [LEARNER-DATA] row fires the gate",
      t_catalog_flagged_rows_gated)


def t_vault_ready_admits():
    # The gate is a deferral, not a ban: a ready vault admits.
    check_learner_data(
        req_entry(TENANT + "/api/v1/courses/1/students"), POLICY, True)
check("P0-5: vault-ready learner ops still admit", t_vault_ready_admits)


# Hint fragments from the Lane 8 gap scanner
# (scratch/lane8/scan_learner_gap.py LEARNER_HINTS). The consistency test
# below reruns that scan's logic over the live catalog: any catalog row
# whose path carries a hint must be gated (or be the educator-self
# exception), so catalog drift cannot silently reopen a coverage gap.
SCAN_HINTS = [
    "student", "user", "grade", "enrollment", "submission", "membership",
    "participant", "observee", "observer", "peer_review", "provisional",
    "moderated", "gradeable", "appointment", "conference", "collaboration",
    "outcome_result", "rubric_assessment", "quiz_submission", "audit",
    "login", "page_view", "grade_change", "gradebook", "roster",
]


def t_scan_consistency():
    misses = []
    exempt_but_gated = []
    for name, row in sorted(CATALOG.items()):
        hints = [h for h in SCAN_HINTS if h in row["path"].lower()]
        if not hints:
            continue
        e = ex.catalog_descriptor_to_entry(name, row["method"], row["path"])
        is_gated = gated(e)
        if "/users/self" in row["path"]:
            if is_gated:
                exempt_but_gated.append(name)
        elif not is_gated:
            misses.append((name, hints, row["path"]))
    assert not misses, "scan-consistency gaps: %r" % (misses,)
    assert not exempt_but_gated, "exempt rows gated: %r" % (exempt_but_gated,)
check("P0-9: scan-consistency over all 456 catalog rows", t_scan_consistency)


# ---------------------------------------------------------------------------
# W3-P1-45: query/body blindness
# ---------------------------------------------------------------------------

def t_query_enrollments_gated():
    # L8-5 replication: canvas_list_modules with
    # extra.query={"include[]": "enrollments"} bypassed the URL-only gate.
    e = ex.catalog_descriptor_to_entry(
        "canvas_list_modules", "GET", "/api/v1/courses/{course_id}/modules",
        extra={"query": {"include[]": "enrollments"}})
    assert e["request"]["query"] == {"include[]": "enrollments"}
    assert gated(e), "include[]=enrollments in query must fire the gate"
check("P1-45: L8-5 modules include[]=enrollments bypass is gated",
      t_query_enrollments_gated)


def t_query_students_users_gated():
    base = TENANT + "/api/v1/courses/1/modules"
    assert gated(req_entry(base, query={"include[]": "students"})), "students"
    assert gated(req_entry(base, query={"include[]": "users"})), "users"
check("P1-45: query include[]=students/users gated", t_query_students_users_gated)


def t_body_tokens_gated():
    base = TENANT + "/api/v1/courses/1/modules"
    assert gated(req_entry(base, body={"student_ids": [1, 2]})), "student_ids"
    assert gated(req_entry(base, body={"user_id": 7})), "user_id"
    assert gated(req_entry(base, body={"user": {"name": "Ada"}})), "user"
    assert gated(req_entry(base, body={"enrollments": [{"id": 1}]})), "enrollments"
check("P1-45: body learner tokens gated", t_body_tokens_gated)


def t_benign_body_prose_not_gated():
    # The key-aware body scan must not fire on prose that merely mentions
    # the word "user": the key regex only matches JSON keys, and the
    # value-token scan only matches the plural/identifier tokens.
    base = TENANT + "/api/v1/courses/1/modules"
    e = req_entry(base, body={"description": "user guide for the course",
                              "title": "Syllabus"})
    assert not gated(e), "prose mentioning 'user' must not fire the gate"
    e2 = req_entry(base, body={"comment": "end user documentation",
                               "points": 10})
    assert not gated(e2), "prose 'end user' must not fire the gate"
check("P1-45: benign body prose does not fire the gate",
      t_benign_body_prose_not_gated)


def t_multistep_query_gated():
    # multi_step is a list of flat step blocks (build_request reads
    # step["url"]/step["query"] directly, same as executor.py).
    e = req_entry(TENANT + "/api/v1/courses/1/pages")
    e["multi_step"] = [
        {"method": "GET", "url": TENANT + "/api/v1/courses/1/x",
         "query": {"include[]": "enrollments"}},
    ]
    assert gated(e), "multi-step query blocks must be scanned"
    # A learner-bearing step URL is caught too.
    e2 = req_entry(TENANT + "/api/v1/courses/1/pages")
    e2["multi_step"] = [
        {"method": "GET",
         "url": TENANT + "/api/v1/courses/1/students"},
    ]
    assert gated(e2), "multi-step step URLs must be scanned"
check("P1-45: multi-step query blocks are scanned", t_multistep_query_gated)


def t_query_template_in_scanned_url():
    # Query templates ({?include[]}) are appended to the URL before scanning.
    urls = extract_urls(req_entry(
        TENANT + "/api/v1/courses/1/modules",
        query={"include[]": "enrollments"}))
    assert any("include" in u and "enrollments" in u for u in urls), urls
check("P1-45: query templates are appended to scanned URLs",
      t_query_template_in_scanned_url)


def t_benign_query_not_gated():
    e = req_entry(TENANT + "/api/v1/courses/1/modules",
                  query={"include[]": "items"})
    assert not gated(e), "benign include[]=items must not fire the gate"
check("P1-45: benign query params do not fire the gate",
      t_benign_query_not_gated)


# ---------------------------------------------------------------------------
# W3-P1-44: reveal consent provenance
# ---------------------------------------------------------------------------

def _isolate_env():
    saved = {k: os.environ.get(k) for k in (
        "MORROW_TREE_STATE_DIR", "MORROW_SOURCE_VAULT_PATH",
        "MORROW_REVEAL_STUDENT_PII_REASON")}
    d = os.path.join(SCRATCH, "wave3-tree-state")
    os.makedirs(d, exist_ok=True)
    for f in os.listdir(d):
        os.remove(os.path.join(d, f))
    os.environ["MORROW_TREE_STATE_DIR"] = d
    os.environ["MORROW_SOURCE_VAULT_PATH"] = os.path.join(
        SCRATCH, "wave3-source-vault.json")
    os.environ.pop("MORROW_REVEAL_STUDENT_PII_REASON", None)
    try:
        os.unlink(os.environ["MORROW_SOURCE_VAULT_PATH"])
    except FileNotFoundError:
        pass
    return saved


def _restore_env(saved):
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _write_consent(reason_bytes, mode=0o600):
    from privacy import executor_wire as _wire
    path = _wire.consent_path()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, reason_bytes)
    finally:
        os.close(fd)
    os.chmod(path, mode)
    return path


def t_env_var_ignored_by_wire():
    from privacy import executor_wire as _wire
    saved = _isolate_env()
    os.environ["MORROW_REVEAL_STUDENT_PII_REASON"] = \
        "grading review with the course TA before posting finals"
    try:
        assert _wire.pii_reveal_audit(Exception) is None, \
            "bare env var must be ignored without a consent file"
    finally:
        _restore_env(saved)
check("P1-44: bare env var is ignored by the wire", t_env_var_ignored_by_wire)


def t_consent_stub_refused():
    from privacy import executor_wire as _wire
    saved = _isolate_env()
    try:
        _write_consent(b"test")
        expect_raises(Exception, lambda: _wire.pii_reveal_audit(Exception))
    finally:
        _restore_env(saved)
check("P1-44: stub consent reason fails closed", t_consent_stub_refused)


def t_consent_wrong_mode_refused():
    from privacy import executor_wire as _wire
    saved = _isolate_env()
    try:
        _write_consent(b"a documented instructional purpose here", mode=0o644)
        try:
            _wire.pii_reveal_audit(Exception)
        except Exception as exc:
            assert "0600" in str(exc), str(exc)
        else:
            raise AssertionError("world-readable consent must fail closed")
    finally:
        _restore_env(saved)
check("P1-44: world-readable consent fails closed", t_consent_wrong_mode_refused)


def t_consent_valid_reveals():
    from privacy import executor_wire as _wire
    saved = _isolate_env()
    reason = "grading review with the course TA before posting finals"
    try:
        _write_consent(reason.encode())
        audit = _wire.pii_reveal_audit(Exception)
    finally:
        _restore_env(saved)
    assert audit["revealed_by"] == "educator-consent-file", audit
    assert audit["reason"] == reason, audit
    assert audit["at"], "audit carries a timestamp"
check("P1-44: valid consent reveals with exact attribution",
      t_consent_valid_reveals)


def t_browser_delegates_consent():
    sys.path.insert(0, os.path.join(_HERE, "..", "transport"))
    import browser_backend as bb
    from privacy import executor_wire as _wire
    saved = _isolate_env()
    os.environ["MORROW_REVEAL_STUDENT_PII_REASON"] = \
        "grading review with the course TA before posting finals"
    try:
        assert bb._pii_reveal_audit() is None, "env-only must not reveal"
        _write_consent(b"documented instructional purpose for review")
        audit = bb._pii_reveal_audit()
        assert audit["revealed_by"] == "educator-consent-file", audit
    finally:
        _restore_env(saved)
check("P1-44: browser backend delegates to the wire", t_browser_delegates_consent)


# ---------------------------------------------------------------------------
# W3-P2-5: raw verification detail through the learner privacy boundary
# ---------------------------------------------------------------------------

def _learner_entry():
    return {"name": "t_students", "provider": "canvas",
            "request": {"method": "GET",
                        "url": TENANT + "/api/v1/courses/1/students"}}


def t_verification_detail_projected():
    # A synthetic readback mismatch carrying a learner name, id, and
    # email: none of them may survive in the journaled detail.
    saved = _isolate_env()
    try:
        detail = ("write readback mismatch on field 'name': requested "
                  "'Assignment 1', provider returned 'Ada Lovelace' "
                  "(user 8675309, ada@example.edu)")
        raw = {"id": 99, "user_id": 8675309, "name": "Ada Lovelace",
               "email": "ada@example.edu"}
        verification = {"ok": False, "detail": detail,
                        "mismatched_fields": ["name"]}
        out = ex._project_verification_detail(
            _learner_entry(), verification, raw, TENANT, "t_students")
    finally:
        _restore_env(saved)
    assert out is not verification, "input dict must not be mutated"
    assert verification["detail"] == detail, "input dict must not be mutated"
    for secret in ("Ada Lovelace", "ada@example.edu", "8675309"):
        assert secret not in out["detail"], \
            "learner PII leaked into verification detail: %r" % secret
    assert out["mismatched_fields"] == ["name"], "other keys preserved"
check("P2-5: verification detail projected, no learner PII survives",
      t_verification_detail_projected)


def t_consent_nonregular_fails_closed():
    # A FIFO (or any nonregular file) at the consent path is not consent:
    # the wire fails closed instead of reading it.
    from privacy import executor_wire as _wire
    saved = _isolate_env()
    try:
        path = _wire.consent_path()
        os.mkfifo(path)
        try:
            audit = _wire.pii_reveal_audit(ex.ExecutorError)
        except ex.ExecutorError:
            pass  # fail-closed refusal is the correct outcome
        else:
            assert audit is None, "nonregular consent must never audit"
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
        _restore_env(saved)
check("P1-44: nonregular consent file fails closed",
      t_consent_nonregular_fails_closed)


def t_consent_symlink_rejected():
    # A symlink at the consent path is rejected even when it points at a
    # well-formed consent file: lstat, not stat, decides.
    from privacy import executor_wire as _wire
    saved = _isolate_env()
    try:
        target = os.path.join(os.environ["MORROW_TREE_STATE_DIR"],
                              "consent-target")
        with open(target, "wb") as fh:
            fh.write(b"documented instructional purpose for review")
        os.chmod(target, 0o600)
        path = _wire.consent_path()
        os.symlink(target, path)
        try:
            audit = _wire.pii_reveal_audit(ex.ExecutorError)
        except ex.ExecutorError:
            pass  # fail-closed refusal is the correct outcome
        else:
            assert audit is None, "symlink consent must never audit"
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
        _restore_env(saved)
check("P1-44: symlink consent file is rejected",
      t_consent_symlink_rejected)


def t_write_omitted_class_reaches_approval_gate():
    # Actual dispatch, not descriptor construction: the catalog-derived
    # write with the effect class omitted must reach WriteApprovalMissing
    # when no approval is presented.
    entry = ex.catalog_descriptor_to_entry(
        "canvas_delete_assignment", "DELETE",
        "/api/v1/courses/{course_id}/assignments/{id}", None,
        provider="canvas")
    assert entry["effects"] == "write", entry["effects"]
    # The selftest imports dispatch.admission package-qualified, the same
    # module object executor uses, so the exception class is identical
    # across the boundary: match by identity, not by name.
    try:
        ex.dispatch_entry(
            entry, {"course_id": "1", "id": "2"}, None,
            {"credential_slots": {}}, plan=None, op_id=None,
            approval=None)
    except _admission_mod.WriteApprovalMissing:
        pass
    else:
        raise AssertionError("expected WriteApprovalMissing, nothing raised")
check("P0-6: omitted-class catalog write reaches WriteApprovalMissing",
      t_write_omitted_class_reaches_approval_gate)


def t_verification_detail_consent_reveals():
    # With valid educator consent the detail passes through raw and the
    # reveal audit rides with the verification so the journal records it.
    saved = _isolate_env()
    try:
        _write_consent(b"documented instructional purpose for review")
        detail = "provider returned 'Ada Lovelace'"
        out = ex._project_verification_detail(
            _learner_entry(), {"ok": False, "detail": detail},
            {"user_id": 1, "name": "Ada Lovelace"}, TENANT, "t_students")
    finally:
        _restore_env(saved)
    assert out["detail"] == detail, "consent passes the detail through raw"
    assert out["pii_reveal"]["revealed_by"] == "educator-consent-file", \
        "consent must be journaled with the verification"
check("P2-5: educator consent passes verification detail through",
      t_verification_detail_consent_reveals)
def t_verification_detail_inplace_label_shape():
    # List payloads are labeled in place (id/name replaced with
    # "Student A<n>"), not collapsed to learnerToken: the scrub must
    # pair against that shape too.
    out = ex._project_verification_detail(
        _learner_entry(),
        {"ok": False,
         "detail": "expected id 99, provider showed id 100"},
        [{"id": 99, "name": "Ada Lovelace", "email": "ada@example.edu"},
         {"id": 100, "name": "Grace Hopper", "email": "grace@example.edu"}],
        TENANT, "t_users")
    assert "Ada Lovelace" not in out["detail"], out["detail"]
    assert "Grace Hopper" not in out["detail"], out["detail"]
    assert "Student A1" in out["detail"], out["detail"]
    assert "Student A2" in out["detail"], out["detail"]
    assert "99" not in out["detail"] and "100" not in out["detail"], \
        out["detail"]
check("P2-5: in-place label shape pairs raw roster correctly",
      t_verification_detail_inplace_label_shape)


def t_verification_detail_roster_mismatch_fails_closed():
    # If the projected roster cannot be paired one-to-one with the raw
    # roster, the scrub refuses rather than risk mislabeled identifiers.
    raw = [{"user_id": 1, "name": "Ada Lovelace"},
           {"user_id": 2, "name": "Grace Hopper"}]
    proj = {"provider_payload": [{"learnerToken": "Student A1"}]}
    try:
        ex._scrub_residual_identifiers("t_e", raw, proj,
                                       "detail 1 and 2")
    except ex.ExecutorError:
        return
    raise AssertionError("expected fail-closed on roster mismatch")
check("P2-5: roster mismatch fails closed, never mislabels",
      t_verification_detail_roster_mismatch_fails_closed)

class _FakeReadbackSession:
    def __init__(self, body):
        self._body = body
    def raw_request(self, method, url, headers, body_bytes, is_write=False,
                    max_bytes=None):
        body = self._body
        if isinstance(body, str):
            body = body.encode("utf-8")
        return 200, {}, body, 1
    def base_for(self, provider):
        return TENANT


def t_multistep_mismatch_carries_readback_payload():
    # run_write_readback attaches the raw readback payload to the
    # WriteFieldMismatch so the journal handler can pair the roster.
    # (Readback targets only cover non-learner surfaces, so this half
    # uses an assignment route; the projection half below uses a
    # learner entry.)
    entry = {"name": "t_ms", "provider": "canvas", "effects": "write",
             "request": {"method": "PUT",
                         "url": TENANT + "/api/v1/courses/1/assignments/5"}}
    sess = _FakeReadbackSession(json.dumps({"id": 5, "name": "Y"}))
    try:
        ex.run_write_readback(
            entry, sess, {}, {"canvas_base": TENANT}, {}, {},
            "PUT", TENANT + "/api/v1/courses/1/assignments/5",
            {"name": "X"}, {"id": 5, "name": "X"})
    except ex.WriteFieldMismatch as exc:
        assert exc.readback_payload == {"id": 5, "name": "Y"}, \
            "raw readback payload must ride the exception"
        return exc
    raise AssertionError("expected WriteFieldMismatch")
check("P2-5: WriteFieldMismatch carries the readback payload",
      t_multistep_mismatch_carries_readback_payload)


def t_multistep_mismatch_detail_projected():
    # The multi-step handler projects the mismatch detail through the
    # learner boundary using the exception-carried payload: the detail
    # formats raw readback values with %r, which can be learner names
    # or identifiers, so none may survive in the journaled detail.
    saved = _isolate_env()
    try:
        entry = _learner_entry()
        payload = {"id": 99, "user_id": 99, "name": "Ada Lovelace",
                   "email": "ada@example.edu"}
        detail = ("write readback mismatch on PUT %s (readback %s): "
                  "name: requested 'X', persisted 'Ada Lovelace' "
                  "(user 99, ada@example.edu)"
                  % (TENANT + "/api/v1/courses/1/assignments/5",
                     TENANT + "/api/v1/courses/1/assignments/5"))
        out = ex._project_verification_detail(
            entry, {"status": "fail", "detail": detail},
            payload, TENANT, "t_ms")
    finally:
        _restore_env(saved)
    assert "Ada Lovelace" not in out["detail"], out["detail"]
    assert "ada@example.edu" not in out["detail"], out["detail"]
    assert "Student A1" in out["detail"], out["detail"]
check("P2-5: multi-step mismatch detail projected, no learner PII",
      t_multistep_mismatch_detail_projected)




def t_verification_detail_nonlearner_passthrough():
    # Entries that do not touch learner data keep their detail content;
    # no reveal is journaled.
    entry = {"name": "t_course", "provider": "canvas",
             "request": {"method": "GET",
                         "url": TENANT + "/api/v1/courses/1"}}
    saved = _isolate_env()
    try:
        verification = {"ok": True, "detail": "readback matched"}
        out = ex._project_verification_detail(
            entry, verification, {"id": 1}, TENANT, "t_course")
    finally:
        _restore_env(saved)
    assert out == verification, "non-learner detail content must be unchanged"
    assert verification == {"ok": True, "detail": "readback matched"}, \
        "input dict must not be mutated"
    assert "pii_reveal" not in out
check("P2-5: non-learner verification details pass through",
      t_verification_detail_nonlearner_passthrough)


def t_verification_detail_empty_passthrough():
    # No detail string: nothing to project.
    saved = _isolate_env()
    try:
        verification = {"ok": True}
        out = ex._project_verification_detail(
            _learner_entry(), verification, {}, TENANT, "t_students")
    finally:
        _restore_env(saved)
    assert out is verification
check("P2-5: missing detail passes through", t_verification_detail_empty_passthrough)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def main():
    print("pass: %d" % len(PASS))
    for name in PASS:
        print("  ok %s" % name)
    if FAIL:
        print("FAIL: %d" % len(FAIL))
        for name in FAIL:
            print("  FAIL %s" % name)
        sys.exit(1)
    print("wave-3 hardening selftest: %d passed, %d failed"
          % (len(PASS), len(FAIL)))
    print("all wave-3 hardening selftests passed")


if __name__ == "__main__":
    main()
