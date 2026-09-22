#!/usr/bin/env python3
"""Full test suite for the Morrow error translation layer.

Covers failures/translator.py + failures/catalog.py + failures/catalog.json:
  1. per-mode tests: every one of the 77 catalog modes gets a synthetic
     raw error; asserts the right mode_id, the four message anchors, all
     placeholders filled, no em dashes, no shrug language, and the
     escalate flag matching the catalog.
  2. adversarial tests: garbage inputs must all land on the structured
     unknown fallback (four anchors, correlation id, escalate=true,
     evidence-captured note, no crash, no raw traceback).
  3. tiebreaker tests: CSRF-422 vs 429 disambiguation, BrowserStaleCommand
     is not session death, write-integrity specificity ordering.
  4. regression test: scans the whole Morrow tree (.py + .md) for banned
     shrug phrasings in agent-facing strings.

Stdlib unittest only. Runnable as `python3 -m unittest` from the tree
root or directly (`python3 failures/test_error_translation.py`).
Exit 0 on pass.

NOTE: this file contains the banned shrug phrasings as the reference
list for the regression scan; it excludes itself from that scan.
"""

from __future__ import annotations

import ast
import io
import json
import os
import re
import sys
import tokenize
import unittest

TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE_ROOT not in sys.path:
    sys.path.insert(0, TREE_ROOT)

from failures import load_catalog, translate  # noqa: E402
from learners.resolve_student import (  # noqa: E402
    build_candidate as _build_candidate,
    match_query as _match_query,
)
from query import intent as _qintent  # noqa: E402
from query import quiz_resolve as _qresolve  # noqa: E402
from query import thresholds as _qthresholds  # noqa: E402
from query import live_read as _qliveread  # noqa: E402


def _student_ambiguous_case():
    """Real StudentAmbiguous from learners/resolve_student.py: the
    translator must merge its resolution_evidence and fill every
    placeholder in the student-resolution-ambiguous message."""
    cands = [
        _build_candidate({
            "id": 1, "name": "Casey Rivera", "enrollments": [
                {"type": "StudentEnrollment", "enrollment_state": "active",
                 "course_section_id": 11}]}),
        _build_candidate({
            "id": 2, "name": "Casey Rivera", "enrollments": [
                {"type": "StudentEnrollment", "enrollment_state": "active",
                 "course_section_id": 12}]}),
    ]
    try:
        _match_query(cands, "Casey Rivera")
    except Exception as exc:  # noqa: BLE001 - the point is the exception
        return exc
    raise AssertionError("expected StudentAmbiguous from duplicate names")


def _student_not_found_case():
    """Real StudentNotFound: no-match message must name the filters that
    excluded candidates."""
    try:
        _match_query([], "Nobody Here")
    except Exception as exc:  # noqa: BLE001 - the point is the exception
        exc.resolution_evidence.update({
            "course_id": "89585",
            "excluded_summary": "inactive=1",
        })
        return exc
    raise AssertionError("expected StudentNotFound from an empty pool")

CATALOG = load_catalog()

# ---------------------------------------------------------------------------
# Shared assertions
# ---------------------------------------------------------------------------

EM_DASH = "\u2014"
PLACEHOLDER_RE = re.compile(r"\{[^{}]*\}")
CORRELATION_RE = re.compile(r"^[0-9a-f]{12}$")

# Banned shrug phrasings (the regression reference list). The scan
# excludes this file itself plus the failures/ package's own banned-phrase
# validation lists (failures/catalog.py, failures/selftest_smoke.py).
BANNED_PHRASINGS = (
    "sorry, i don't know what happened",
    "i don't know what happened",
    "oh well",
    "canvas writes were working this morning",
    "writes were working",
    "unknown error",
    "no idea what",
)

SESSION_DEAD_FAMILY = {
    "canvas-session-dead",
    "canvas-session-dead-mid-write-uncertain",
    "session-expiry-no-warning",
    "browser-task-session-dead-transient",
    "session-flapping-multi-uncertain",
}


def assert_message_quality(testcase, tr, entry):
    """The rendered agent message contract every mode must satisfy."""
    msg = tr.agent_message
    lowered = msg.lower()
    testcase.assertIn("what was attempted", lowered,
                       "missing 'what was attempted' anchor")
    testcase.assertIn("what the evidence showed", lowered,
                       "missing 'what the evidence showed' anchor")
    testcase.assertTrue("what this means" in lowered or "what it means" in lowered,
                        "missing 'what it means' anchor")
    testcase.assertIn("what happens next", lowered,
                       "missing 'what happens next' anchor")
    leftovers = PLACEHOLDER_RE.findall(msg)
    testcase.assertEqual([], leftovers,
                         "unfilled placeholders remain: %r" % leftovers)
    testcase.assertNotIn(EM_DASH, msg, "message contains an em dash")
    for phrase in BANNED_PHRASINGS:
        testcase.assertNotIn(phrase, lowered,
                             "message contains shrug language %r" % phrase)
    testcase.assertNotIn("Traceback", msg, "raw traceback leaked into message")
    # Escalate flag matches the catalog (translator rule: fallback, or
    # critical severity, or explicit evidence escalate).
    expected_escalate = (
        entry.get("fallback") is True
        or entry.get("severity_hint") == "critical"
        or tr.evidence.get("escalate") is True
    )
    testcase.assertEqual(expected_escalate, tr.escalate,
                         "escalate=%r but catalog implies %r"
                         % (tr.escalate, expected_escalate))


# ---------------------------------------------------------------------------
# Synthetic raw errors, one per catalog mode
# ---------------------------------------------------------------------------

class ChromiumSessionDead(Exception):
    pass


class BrowserStaleCommand(Exception):
    pass


class WriteHaltActive(Exception):
    pass


class UncertainWrite(Exception):
    pass


class WriteNotAttempted(Exception):
    pass


class EvidenceHold(Exception):
    pass


class NewQuizRefused(Exception):
    """dispatch/executor.py New Quiz safety-guard refusal. Doubles carry
    the exact refusal message texts so the translator mapping is
    verifiable without a live Canvas session."""


class PathologicalStr(Exception):
    def __str__(self):
        raise RuntimeError("pathological __str__ refuses to render")


# Synthetic doubles for the workstream-A modes/ package exceptions and the
# workstream-B settings/ guard exception. Agent A's real classes do not
# exist in this tree yet; these doubles carry the exact class names and
# the documented evidence shapes, so the translator mapping is verifiable
# now and the real classes map identically when they land. See
# MODE_EVIDENCE_NOTES below for the full contract.
#
# The edit grant is blanket (Braden 2026-09-22): no course or category
# scopes exist, so there are no scope-related exceptions.
class ModeSelfGrantRefused(Exception):
    """modes/ admission gate: the agent tried to promote itself to edit
    mode without an educator-issued grant."""


class PlanModeWriteWithoutApproval(Exception):
    """modes/ admission gate: write attempted in plan mode with no
    educator-approved validated plan on file. Optional scalar attr:
    plan_id."""


class AmbiguousCourseWriteRefused(Exception):
    """modes/ admission gate: write refused because course resolution was
    ambiguous (multiple candidates or low confidence) and the educator
    never confirmed the target conversationally. Carries query and
    candidates_public."""


class ModeSettingsTamper(Exception):
    """settings/ package guard: agent-initiated settings change without
    educator confirmation. Carries setting_name."""


class DestructiveConfirmationRequired(Exception):
    """modes/ admission gate: destructive write in edit mode while
    confirm_destructive_writes is on, without a recorded educator yes
    for that action. Carries entry_name and course_id."""


MODE_EVIDENCE_NOTES = (
    "Workstream C evidence contract for the modes/ (agent A) and settings/ "
    "(agent B) systems. Each new catalog mode is reachable from the "
    "exception type and from raw dict evidence:\n"
    "- ModeSelfGrantRefused -> edit_self_grant_refused. Exception, or "
    '{"error": "ModeSelfGrantRefused"} (CLI funnel shape), or '
    '{"mode_self_grant_refused": True}.\n'
    "- PlanModeWriteWithoutApproval -> plan_mode_write_without_approval. "
    "Exception, funnel shape, or "
    '{"plan_mode_write_without_approval": True}.\n'
    "- AmbiguousCourseWriteRefused -> ambiguous_course_write_refused. "
    "Exception carrying query and candidates_public, funnel shape, or "
    '{"ambiguous_course_write_refused": True}.\n'
    "- ModeSettingsTamper -> settings_tamper_refused. Exception carrying "
    "setting_name, funnel shape, or "
    '{"mode_settings_tamper": True, "setting_name": "..."}.\n'
    "- DestructiveConfirmationRequired -> "
    "destructive_write_confirmation_required. Exception carrying "
    "entry_name and course_id, funnel shape, or "
    '{"destructive_write_confirmation_required": True}.\n'
    "Scalar exception attrs merged as evidence: course_id, grant_id, "
    "plan_id, setting_name, mode, query, candidates_public, match_count, "
    "match_kind, entry_name."
)


def _ambiguous_course_case():
    """Build an AmbiguousCourseWriteRefused double with the documented attrs."""
    exc = AmbiguousCourseWriteRefused("course target ambiguous: Bio 101")
    exc.query = "Bio 101"
    exc.candidates_public = "Biology 101 (Fall 2026), Biology 101 (Spring 2026)"
    return exc


def _mode_settings_tamper_case():
    exc = ModeSettingsTamper("agent changed a setting without confirmation")
    exc.setting_name = "default_due_time"
    return exc


def _destructive_confirmation_case():
    """Build a DestructiveConfirmationRequired double with the
    documented attrs."""
    exc = DestructiveConfirmationRequired(
        "destructive write needs explicit confirmation")
    exc.entry_name = "canvas_wiki_page_delete"
    exc.course_id = "89585"
    return exc


def _csrf_422_dict():
    return {
        "provider": "canvas",
        "http_status": 422,
        "body_text": '{"errors":[{"message":"unauthorized"}],"error":"unprocessable_content"}',
        "writes_fail": True,
        "reads_ok": True,
        "rate_limit_remaining": 700.0,
        "retry_after_present": False,
        "session_logged_in": True,
    }


# mode_id -> zero-arg factory returning the raw error to translate.
def _quiz_no_match_case():
    """Real QuizNotFound from query/quiz_resolve.py: the translator must
    merge its resolution_evidence and fill every quiz-resolution
    placeholder in the agent message."""
    from datetime import datetime, timezone
    return _qresolve.QuizNotFound(
        datetime(2026, 9, 14, 5, 0, tzinfo=timezone.utc),
        datetime(2026, 9, 21, 4, 59, 59, tzinfo=timezone.utc),
        214, 9, 157,
        [("Mid-Term Exam", 4045392, "2026-02-23T05:59:00+00:00",
          "assignment.due_at")],
        query="last week's quiz")


def _quiz_ambiguous_case():
    """Real QuizAmbiguous from query/quiz_resolve.py."""
    from datetime import datetime, timezone
    return _qresolve.QuizAmbiguous(
        datetime(2026, 9, 14, 5, 0, tzinfo=timezone.utc),
        datetime(2026, 9, 21, 4, 59, 59, tzinfo=timezone.utc),
        [("Pop Quiz #1", 1, "2026-09-15T05:00:00+00:00",
          "assignment.due_at", 50.0),
         ("Pop Quiz #2", 2, "2026-09-18T05:00:00+00:00",
          "assignment.due_at", 50.0)],
        query="last week's quiz")


MODE_CASES = {
    "query-intent-unrecognized":
        lambda: _qintent.IntentNotRecognized("what is the weather"),
    "query-threshold-undefined":
        lambda: _qthresholds.ThresholdUndefined("points_possible is None"),
    "quiz-reference-unsupported":
        lambda: _qresolve.UnsupportedQuizRef("yesterday"),
    "query-live-read-failed":
        lambda: _qliveread.LiveReadError("helper Chromium is not alive"),
    "quiz-resolution-ambiguous": _quiz_ambiguous_case,
    "quiz-resolution-no-match": _quiz_no_match_case,
    "canvas-csrf-422-writes-only": _csrf_422_dict,
    "canvas-rate-limit-429": lambda: {
        "provider": "canvas", "http_status": 429,
        "rate_limit_remaining": 0.0, "retry_after_present": True,
    },
    "canvas-session-dead": lambda: ChromiumSessionDead("browser gone"),
    "canvas-session-dead-mid-write-uncertain": lambda: {
        "session_dead_signal": True, "uncertain_write": True,
        "operation_kind": "write", "provider": "canvas",
    },
    "canvas-tenant-error-page": lambda: {
        "provider": "canvas", "tenant_error_page": True,
        "url_matches_tenant": False,
    },
    "canvas-soft-delete-quirk": lambda: {
        "provider": "canvas", "operation_kind": "delete",
        "delete_status": 200, "terminal_get_status": 200,
        "absence_evidence": True,
    },
    "canvas-stale-read-after-delete": lambda: {
        "provider": "canvas", "operation_kind": "delete",
        "immediate_terminal_get": 200, "later_terminal_get": 404,
    },
    "canvas-include-questions-not-embedded": lambda: {
        "provider": "canvas", "operation_kind": "read",
        "route_path": "/api/v1/courses/1/quizzes/2?include[]=questions",
        "embedded_count": 0, "dedicated_endpoint_count": 3,
    },
    "canvas-per-page-cap": lambda: {
        "provider": "canvas", "operation_kind": "read",
        "result_count": 100, "explicit_per_page": False,
    },
    "tenant-write-behavior-change": lambda: {
        "provider": "canvas", "http_status": 403,
        "body_text": "policy refusal: writes disabled by tenant config",
        "body_has_specific_message": True, "lane": "browser",
    },
    "https-lane-pat-revoked": lambda: {
        "provider": "canvas", "http_status": 401, "lane": "https",
        "session_logged_in": True,
    },
    "password-changed-mid-op": lambda: {
        "provider": "canvas", "http_status": 401, "lane": "https",
        "session_logged_in": False, "attempt_count": 1,
    },
    "ib-canonical-item-get-404": lambda: {
        "provider": "item-banks", "http_status": 404,
        "route_kind": "canonical", "operation_kind": "read",
    },
    "ib-literal-item-401-scope-refusal": lambda: {
        "provider": "item-banks", "http_status": 401,
        "route_kind": "literal",
    },
    "ib-canonical-item-delete-404": lambda: {
        "provider": "item-banks", "http_status": 404,
        "route_kind": "canonical", "operation_kind": "delete",
    },
    "ib-bank-link-401": lambda: {
        "provider": "item-banks", "http_status": 401,
        "operation_kind": "bank_link", "route_path": "/api/banks/1/link",
    },
    "ib-item-delete-200-soft": lambda: {
        "provider": "item-banks", "operation_kind": "delete",
        "delete_status": 200, "terminal_get_status": 200,
        "absence_evidence": True,
    },
    "grade-update-no-test-student": lambda: {
        "provider": "canvas", "operation_kind": "grade",
        "enrollment_count": 0,
    },
    "new-quiz-create-evidence-hold": lambda: EvidenceHold("held by gate"),
    # New Quiz safety-guard refusals (Lane 7): every NewQuizRefused text
    # below is the exact message raised by dispatch/executor.py.
    "new-quiz-put-refused": lambda: NewQuizRefused(
        "PUT is never used on New Quiz paths "
        "(https://tenant.test/quiz/v1/courses/1/quizzes/2); use PATCH"),
    "new-quiz-delete-via-assignment-refused": lambda: NewQuizRefused(
        "refusing to delete a New Quiz through the assignment endpoint "
        "(it orphans the quiz backend object); the quiz API route is "
        "the only delete path"),
    "new-quiz-stimulus-write-refused": lambda: NewQuizRefused(
        "stimulus create/update stays refused as targets until a proven "
        "contract lands (Canvas answers 422 on create)"),
    "new-quiz-settings-stale-refused": lambda: NewQuizRefused(
        "refusing settings write: the saved quiz_settings block is "
        "missing or unreadable; re-read before sending"),
    "new-quiz-interaction-rename-refused": lambda: NewQuizRefused(
        "interaction-id rename refused (added 2, removed 1): in-place "
        "PATCH would orphan ghost stubs; plan as delete plus create"),
    "new-quiz-protected-quiz-refused": lambda: NewQuizRefused(
        "refusing write to New Quiz 506477: this quiz is never touched"),
    # The general fallback: a guard text with no specific mode (the draw
    # guard text) must land on new-quiz-guard-refused, never unknown.
    "new-quiz-guard-refused": lambda: NewQuizRefused(
        "draw update requires a positive whole question count; got 0"),
    "catalog-not-proven": lambda: {"gate": "CatalogNotProven"},
    "helper-down": lambda: {
        "error_class": "ExecutorError",
        "error_text": "chromium backend: browser unavailable (boom); "
                      "the login helper endpoint is down too -- start it "
                      "with helper/keepalive.sh, then retry",
    },
    "setup-tenant-not-configured": lambda: {
        "error_class": "SessionMissing", "provider": "canvas",
        "error_text": "chromium backend needs a Canvas base URL: pass "
                      "base_url, set CANVAS_BASE, or onboard the browser "
                      "lane state (~/.morrow/browser_lane.json)",
    },
    "chromium-dead-masquerade": lambda: {
        "helper_reachable": True, "chromium_alive": False,
        "url_empty": True,
    },
    "forwarder-dead-no-navigation": lambda: {
        "chromium_alive": True, "session_logged_in": True,
        "forwarder_alive": False, "navigation_failed": True,
    },
    "keepalive-restart-path-broken": lambda: {
        "forwarder_alive": False, "forwarder_restart_attempted": True,
        "forwarder_restart_exit_code": 2,
    },
    "session-expiry-no-warning": lambda: {
        "session_dead_signal": True, "expiry_surprise": True,
        "first_failure_signal": True,
    },
    "reauth-principal-pin-vacuous": lambda: {
        "provider": "moodle", "principal_match": True,
        "principal_evidence_empty": True,
    },
    "moodle-stale-password": lambda: {
        "provider": "moodle", "moodle_kind": "login_failed",
    },
    "moodle-grade-delete-route-changed": lambda: {
        "provider": "moodle",
        "route_path": "/grade/edit.php?action=delete&id=7",
        "delete_noop": True,
    },
    "moodle-ajax-disabled-provider": lambda: {
        "provider": "moodle", "ajax_webservices_available": False,
    },
    "moodle-dead-session-200-login": lambda: {
        "provider": "moodle", "http_status": 200,
        "body_text": "<html><body>please login to continue</body></html>",
        "moodle_envelope_present": False,
    },
    "moodle-ajax-302-to-login": lambda: {
        "provider": "moodle", "http_status": 302,
        "redirect_location": "https://moodle.example.edu/login/index.php",
    },
    "moodle-sandbox-reset-transient": lambda: {
        "provider": "moodle", "sandbox_reset": True,
        "retry_succeeded": True,
    },
    "browser-task-session-dead-transient": lambda: {
        "session_dead_signal": True, "phase": "launch",
        "attempt_number": 2,
    },
    "browser-task-death-uncertain": lambda: {
        "uncertain_write": True, "transport": "browser-task",
        "operation_kind": "write",
    },
    "form-lane-fail-closed": lambda: {"gate": "FormTransportUnavailable"},
    "write-halt-active": lambda: WriteHaltActive("halt engaged"),
    "write-approval-missing": lambda: {"gate": "WriteApprovalMissing"},
    "learner-data-gated": lambda: {"gate": "LearnerDataGated"},
    "catalog-effect-mismatch": lambda: {"gate": "CatalogEffectMismatch"},
    "quarantine-op-id-collision": lambda: {"quarantine_id_collision": True},
    "journal-torn-fail-closed": lambda: {"journal_torn": True},
    "uncertain-write-ambiguous": lambda: UncertainWrite("ambiguous"),
    "write-not-attempted": lambda: WriteNotAttempted("never dispatched"),
    "session-flapping-multi-uncertain": lambda: {
        "session_dead_signal": True, "uncertain_count": 3,
        "single_dead_session": True,
    },
    "wrong-course-typo": lambda: {
        "operation_kind": "write", "course_identity_confirmed": False,
    },
    "wrong-tenant-global": lambda: {
        "operation_kind": "write", "tenant_identity_confirmed": False,
    },
    "helper-restart-loop": lambda: {
        "provider": "helper", "helper_reachable": True,
        "helper_restart_count": 5,
    },
    "keepalive-diagnostics-lost": lambda: {
        "provider": "helper", "keepalive_failed": True,
        "keepalive_output_bytes": 0,
    },
    "disk-full-upgrade-destroy": lambda: {
        "enospc": True, "installer_claimed_restore": True,
    },
    "session-principal-less-store": lambda: {
        "operation_kind": "reauth", "session_store_principal": False,
    },
    "browser-task-dead": lambda: {"task_state": "died"},
    "ib-provider-unserved": lambda: {
        "provider": "item-banks", "provider_served": False,
    },
    "moodle-route-changed": lambda: {
        "moodle_route_shape": "dead", "provider": "moodle",
    },
    "student-resolution-ambiguous": _student_ambiguous_case,
    "student-resolution-no-match": _student_not_found_case,
    # Workstream C: edit/plan-mode admission refusals. Synthetic doubles
    # carry the exact workstream-A/B exception names and documented attrs
    # (see MODE_EVIDENCE_NOTES); the per-mode test proves each matches.
    "edit_self_grant_refused":
        lambda: ModeSelfGrantRefused("agent tried to self-promote"),
    "plan_mode_write_without_approval":
        lambda: PlanModeWriteWithoutApproval(
            "write attempted in plan mode, no approved plan"),
    "ambiguous_course_write_refused": _ambiguous_course_case,
    "settings_tamper_refused": _mode_settings_tamper_case,
    "destructive_write_confirmation_required": _destructive_confirmation_case,
    # CSRF/422 tier: fail-closed missing-token exception, and the broad
    # 422 with unprocessable_content when the full CSRF evidence
    # (reads_ok, session health) is not available.
    "canvas-csrf-token-missing":
        lambda: {"error_class": "CsrfTokenMissing"},
    "canvas-422-unprocessable":
        lambda: {"http_status": 422,
                 "body_text": '{"error_code":"unprocessable_content"}'},
    "unknown": lambda: {"some": "weird", "unmatched": 1},
}


class PerModeTests(unittest.TestCase):
    def test_every_catalog_mode_has_a_case(self):
        catalog_ids = {e["id"] for e in CATALOG.entries}
        self.assertEqual(set(MODE_CASES), catalog_ids,
                         "MODE_CASES must cover every catalog mode exactly")

    def test_catalog_has_77_modes(self):
        self.assertEqual(77, len(CATALOG.entries))

    def test_each_mode_matches(self):
        for mode_id, factory in sorted(MODE_CASES.items()):
            with self.subTest(mode_id=mode_id):
                entry = CATALOG.get(mode_id)
                self.assertIsNotNone(entry, "catalog missing %r" % mode_id)
                tr = translate("per-mode probe for %s" % mode_id, factory())
                self.assertEqual(mode_id, tr.mode_id,
                                 "expected %r, matched %r" % (mode_id, tr.mode_id))
                assert_message_quality(self, tr, entry)
                # A correlation id is always minted, even when the mode's
                # template does not print it (only the unknown fallback
                # is required to carry it in the message).
                self.assertTrue(CORRELATION_RE.match(tr.correlation_id),
                                "bad correlation id %r" % tr.correlation_id)


# ---------------------------------------------------------------------------
# Adversarial tests
# ---------------------------------------------------------------------------

ADVERSARIAL_INPUTS = [
    ("none", None),
    ("int_zero", 0),
    ("int_negative", -7),
    ("float", 3.14),
    ("empty_dict", {}),
    ("empty_string", ""),
    ("whitespace_string", "   \n\t  "),
    ("unicode_garbage", "\ud800 lone-surrogate \x00 null \u2028 sep \U0001f4a5"),
    ("one_mb_body", {"body_text": "z" * (1024 * 1024), "http_status": 200}),
    ("pathological_str", PathologicalStr()),
    ("nested_junk", {"a": {"b": [1, {"c": None}]}, "http_status": {"nested": 1},
                    "list": [object()], "provider": ["x"]}),
    ("junk_exception_args", RuntimeError({"k": object()})),
    ("bytes_input", b"\xff\xfe binary \x00"),
    ("list_input", [1, "two", None]),
    ("bool_input", True),
    ("deep_nesting", {"l1": {"l2": {"l3": {"l4": [None, False, 0]}}}}),
]


class AdversarialTests(unittest.TestCase):
    def test_garbage_falls_back_structured(self):
        for name, raw in ADVERSARIAL_INPUTS:
            with self.subTest(input=name):
                try:
                    tr = translate("adversarial probe", raw)
                except Exception as exc:  # noqa: BLE001 - the point is no crash
                    self.fail("translate() crashed on %s: %r" % (name, exc))
                self.assertEqual("unknown", tr.mode_id,
                                 "%s matched %r instead of unknown" % (name, tr.mode_id))
                entry = CATALOG.get("unknown")
                assert_message_quality(self, tr, entry)
                self.assertTrue(tr.escalate, "unknown fallback must escalate")
                self.assertTrue(CORRELATION_RE.match(tr.correlation_id))
                self.assertIn(tr.correlation_id, tr.agent_message)
                lowered = tr.agent_message.lower()
                self.assertTrue("evidence" in lowered or "captured" in lowered,
                                "unknown message must note the captured evidence")

    def test_pathological_str_does_not_leak(self):
        tr = translate("pathological probe", PathologicalStr())
        self.assertEqual("unknown", tr.mode_id)
        self.assertNotIn("Traceback", tr.agent_message)
        self.assertNotIn("pathological __str__ refuses",
                         tr.agent_message)


# ---------------------------------------------------------------------------
# Tiebreaker tests
# ---------------------------------------------------------------------------

class TiebreakerTests(unittest.TestCase):
    def test_422_full_bucket_matches_csrf_not_429(self):
        raw = _csrf_422_dict()
        raw["rate_limit_remaining"] = ">0 (bucket full, e.g. 700.0)"
        tr = translate("write to Biology 101", raw)
        self.assertEqual("canvas-csrf-422-writes-only", tr.mode_id)
        self.assertNotEqual("canvas-rate-limit-429", tr.mode_id)

    def test_429_exhausted_bucket_matches_429_not_csrf(self):
        tr = translate("write to Biology 101", {
            "provider": "canvas", "http_status": 429,
            "body_text": '{"message":"Rate limit exceeded"}',
            "rate_limit_remaining": 0.0, "retry_after_present": True,
        })
        self.assertEqual("canvas-rate-limit-429", tr.mode_id)
        self.assertNotEqual("canvas-csrf-422-writes-only", tr.mode_id)

    def test_stale_command_is_not_session_dead(self):
        tr = translate("stale op", BrowserStaleCommand("stale command"))
        self.assertNotIn(tr.mode_id, SESSION_DEAD_FAMILY,
                         "stale command matched session death: %r" % tr.mode_id)
        self.assertNotEqual("canvas-session-dead", tr.mode_id)
        self.assertTrue(tr.evidence.get("stale_command"),
                        "stale_command flag must be set")
        self.assertIsNot(tr.evidence.get("session_dead_signal"), True,
                         "stale command must not raise session_dead_signal")
        # A stale command is a fresh session: the designed outcome is the
        # structured unknown fallback, never a session-death mode.
        self.assertEqual("unknown", tr.mode_id)

    def test_write_integrity_specificity_ordering(self):
        # Least specific: write was never attempted.
        tr = translate("write op", {"write_not_attempted": True,
                                    "provider": "canvas"})
        self.assertEqual("write-not-attempted", tr.mode_id)
        # Middle: uncertain write, no session signal.
        tr = translate("write op", UncertainWrite("ambiguous outcome"))
        self.assertEqual("uncertain-write-ambiguous", tr.mode_id)
        # Most specific: session died mid-write with uncertainty.
        tr = translate("write op", {
            "session_dead_signal": True, "uncertain_write": True,
            "operation_kind": "write", "provider": "canvas"})
        self.assertEqual("canvas-session-dead-mid-write-uncertain", tr.mode_id)
        # The mid-write mode still wins when the raw error also carries
        # the UncertainWrite class name (specificity beats class match).
        tr = translate("write op", {
            "session_dead_signal": True, "uncertain_write": True,
            "operation_kind": "write", "provider": "canvas",
            "error_class": "UncertainWrite"})
        self.assertEqual("canvas-session-dead-mid-write-uncertain", tr.mode_id)


# ---------------------------------------------------------------------------
# Workstream C: edit/plan-mode mapping tests (exception + raw evidence)
# ---------------------------------------------------------------------------

class ModeSystemMappingTests(unittest.TestCase):
    """Every new mode is reachable from its workstream-A/B exception type
    AND from representative raw dict evidence (CLI funnel shape
    {"error": "<ClassName>"} and translator-flag dicts). Evidence shapes
    are documented in MODE_EVIDENCE_NOTES."""

    def test_exception_and_dict_routes_match(self):
        routes = {
            "edit_self_grant_refused": [
                ModeSelfGrantRefused("self promotion"),
                {"error": "ModeSelfGrantRefused"},
                {"mode_self_grant_refused": True},
            ],
            "plan_mode_write_without_approval": [
                PlanModeWriteWithoutApproval("plan write"),
                {"error": "PlanModeWriteWithoutApproval"},
                {"plan_mode_write_without_approval": True},
            ],
            "ambiguous_course_write_refused": [
                _ambiguous_course_case(),
                {"error": "AmbiguousCourseWriteRefused",
                 "query": "Bio 101",
                 "candidates_public": "Biology 101 (Fall), Biology 101 (Spring)"},
                {"ambiguous_course_write_refused": True},
            ],
            "settings_tamper_refused": [
                _mode_settings_tamper_case(),
                {"error": "ModeSettingsTamper",
                 "setting_name": "default_due_time"},
                {"mode_settings_tamper": True,
                 "setting_name": "default_due_time"},
            ],
            "destructive_write_confirmation_required": [
                _destructive_confirmation_case(),
                {"error": "DestructiveConfirmationRequired",
                 "entry_name": "canvas_wiki_page_delete",
                 "course_id": "89585"},
                {"destructive_write_confirmation_required": True},
            ],
        }
        for mode_id, raws in routes.items():
            for raw in raws:
                with self.subTest(mode_id=mode_id, raw=type(raw).__name__):
                    entry = CATALOG.get(mode_id)
                    tr = translate("mode-system probe", raw)
                    self.assertEqual(mode_id, tr.mode_id,
                                     "expected %r, matched %r"
                                     % (mode_id, tr.mode_id))
                    assert_message_quality(self, tr, entry)

    def test_edit_is_not_timed_so_no_grant_ended_refusals(self):
        # Edit mode has no expiry, and an ended grant is plain plan mode
        # (the write asks for approval), so neither refusal can occur.
        for mode_id in ("edit_grant_expired", "edit_grant_revoked"):
            self.assertIsNone(CATALOG.get(mode_id), mode_id)
        from modes import errors as mode_errors
        for name in ("ModeGrantExpired", "ModeGrantRevoked"):
            self.assertFalse(hasattr(mode_errors, name), name)

    def test_exception_attrs_fill_placeholders(self):
        tr = translate("publish quiz", _ambiguous_course_case())
        self.assertEqual("ambiguous_course_write_refused", tr.mode_id)
        self.assertIn("Bio 101", tr.agent_message)
        self.assertIn("Biology 101 (Fall 2026)", tr.agent_message)

        tr = translate("change a setting", _mode_settings_tamper_case())
        self.assertEqual("settings_tamper_refused", tr.mode_id)
        self.assertIn("default_due_time", tr.agent_message)

    def test_new_modes_do_not_steal_old_modes(self):
        # The new exception names must not collide with existing modes.
        tr = translate("write op", {"write_halt_active": True})
        self.assertEqual("write-halt-active", tr.mode_id)
        tr = translate("write op", {"gate": "WriteApprovalMissing"})
        self.assertEqual("write-approval-missing", tr.mode_id)
        tr = translate("write op", {"gate": "FormTransportUnavailable"})
        self.assertEqual("form-lane-fail-closed", tr.mode_id)


# ---------------------------------------------------------------------------
# Regression test: banned shrug phrasings anywhere in the Morrow tree
# ---------------------------------------------------------------------------

def _docstring_line_numbers(tree):
    """Line numbers covered by module/class/function docstrings."""
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                             ast.AsyncFunctionDef)):
            body = node.body
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                start = body[0].lineno
                end = body[0].end_lineno or start
                out.update(range(start, end + 1))
    return out


def _scan_py(path):
    """Banned phrases inside real string literals (docstrings excluded)."""
    hits = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            src = fh.read()
        tree = ast.parse(src)
    except (SyntaxError, ValueError):
        return [("%s: unparseable" % path, 0, "unparseable", "")]
    doc_lines = _docstring_line_numbers(tree)
    fstring_middle = getattr(tokenize, "FSTRING_MIDDLE", None)
    try:
        tokens = tokenize.generate_tokens(io.StringIO(src).readline)
        for tok in tokens:
            is_string = tok.type == tokenize.STRING or (
                fstring_middle is not None and tok.type == fstring_middle)
            if not is_string:
                continue
            if tok.start[0] in doc_lines:
                continue
            lowered = tok.string.lower()
            for phrase in BANNED_PHRASINGS:
                if phrase in lowered:
                    hits.append((path, tok.start[0], phrase,
                                 tok.string.strip()[:80]))
    except tokenize.TokenError:
        pass
    return hits


def _scan_md(path):
    """Banned phrases in Markdown prose (fenced code blocks excluded)."""
    hits = []
    in_fence = False
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for lineno, line in enumerate(fh, 1):
            stripped = line.strip()
            if stripped.startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            lowered = line.lower()
            for phrase in BANNED_PHRASINGS:
                if phrase in lowered:
                    hits.append((path, lineno, phrase, stripped[:80]))
    return hits


class RegressionTests(unittest.TestCase):
    def test_no_shrug_phrasings_in_tree(self):
        this_file = os.path.abspath(__file__)
        excluded = {
            this_file,  # this file holds the reference list itself
            os.path.join(TREE_ROOT, "failures", "catalog.py"),
            os.path.join(TREE_ROOT, "failures", "selftest_smoke.py"),
        }
        excluded = {os.path.normpath(p) for p in excluded}
        hits = []
        for root, dirs, files in os.walk(TREE_ROOT):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for name in files:
                path = os.path.normpath(os.path.join(root, name))
                if path in excluded:
                    continue
                if name.endswith(".py"):
                    hits.extend(_scan_py(path))
                elif name.endswith(".md"):
                    hits.extend(_scan_md(path))
        self.assertEqual(
            [], hits,
            "banned shrug phrasings in agent-facing strings:\n%s"
            % "\n".join("%s:%s: %r in %r" % h for h in hits))


class InputContractTests(unittest.TestCase):
    """translate() matches on the NORMALIZED evidence namespace.

    The production funnel (failures/funnel.py) normalizes raw provider
    evidence into signature fields before calling translate(): e.g.
    http_status (not status), body_text (not body), plus the
    classification flags writes_fail, reads_ok, rate_limit_remaining,
    retry_after_present, session_logged_in, and provider.

    LANE2 (2026-09-22) resolved the direct-translate discrepancy: a raw
    422 with an unprocessable_content body no longer falls back to
    "unknown". It matches the hedged canvas-422-unprocessable mode,
    whose message explicitly says the CSRF cause is unverified from
    this evidence alone. The strict canvas-csrf-422-writes-only mode
    still requires the full normalized evidence and wins by
    specificity when it is present. Both directions are pinned here.
    """

    def test_normalized_422_matches_csrf_mode(self):
        tr = translate("page update", {
            "provider": "canvas",
            "http_status": 422,
            "body_text": '{"errors":[{"message":"An error occurred.",'
                         '"error_code":"unprocessable_content"}]}',
            "writes_fail": True,
            "reads_ok": True,
            "rate_limit_remaining": 700.0,
            "retry_after_present": False,
            "session_logged_in": True,
            "tenant": "https://myschool.instructure.com",
        })
        self.assertEqual(tr.mode_id, "canvas-csrf-422-writes-only")

    def test_raw_shaped_dict_matches_hedged_422_mode(self):
        # LANE2: the 2026-09-22 discrepancy probe. A raw dict with only
        # status and body must NOT fall back to "unknown" anymore: it
        # matches the hedged CSRF-aware mode, which is honest about the
        # unverified evidence instead of guessing.
        tr = translate("page.update", {
            "status": 422,
            "body": '{"errors":[{"message":"An error occurred.",'
                    '"error_code":"unprocessable_content"}]}',
        })
        self.assertEqual(tr.mode_id, "canvas-422-unprocessable")
        catalog = load_catalog()
        assert_message_quality(self, tr, catalog.get("canvas-422-unprocessable"))
        self.assertNotIn("Traceback", tr.agent_message)
        # The hedged message must not claim verified session health.
        self.assertNotIn("your sign-in is healthy", tr.agent_message)

    def test_rich_evidence_still_prefers_strict_csrf_mode(self):
        # Specificity: 8-predicate strict entry beats the 2-predicate
        # hedged entry when the full evidence is present.
        tr = translate("page.update", {
            "status": 422,
            "body": '{"errors":[{"message":"An error occurred.",'
                    '"error_code":"unprocessable_content"}]}',
            "provider": "canvas",
            "writes_fail": True,
            "reads_ok": True,
            "rate_limit_remaining": 700.0,
            "retry_after_present": False,
            "session_logged_in": True,
        })
        self.assertEqual(tr.mode_id, "canvas-csrf-422-writes-only")

    def test_csrf_token_missing_exception_translates(self):
        # LANE2: the fail-closed pre-send refusal must name the real
        # cause, never "unknown".
        from transport.local_chromium import CsrfTokenMissing
        tr = translate("update wiki page", CsrfTokenMissing(
            "refusing POST https://x.instructure.com/api/v1/courses/1/pages: "
            "no _csrf_token in the live document.cookie, so no CSRF header "
            "could be built; the write was not sent (check the helper "
            "session, not the provider)"))
        self.assertEqual(tr.mode_id, "canvas-csrf-token-missing")
        catalog = load_catalog()
        assert_message_quality(self, tr, catalog.get("canvas-csrf-token-missing"))
        self.assertNotIn("Traceback", tr.agent_message)

    def test_browser_csrf_token_missing_exception_translates(self):
        # LANE2-D12: the browser-task lane raises BrowserCsrfTokenMissing
        # (not CsrfTokenMissing) on the same pre-send refusal; it must
        # hit the same catalog entry, never "unknown".
        from transport.browser_backend import BrowserCsrfTokenMissing
        tr = translate("update wiki page", BrowserCsrfTokenMissing(
            "browser op 7 not sent: no _csrf_token in the live "
            "document.cookie, so the browser task refused to send the "
            "write (check the helper session, not the provider); the "
            "op_id stays reusable"))
        self.assertEqual(tr.mode_id, "canvas-csrf-token-missing")
        catalog = load_catalog()
        assert_message_quality(self, tr, catalog.get("canvas-csrf-token-missing"))
        self.assertNotIn("Traceback", tr.agent_message)

    def test_provider_http_error_carries_body_to_translator(self):
        # LANE2: ProviderHttpError must carry the response body so a
        # real provider 422 is classifiable.
        from dispatch.executor import ProviderHttpError
        exc = ProviderHttpError(
            422, "fail fast on 4xx",
            body='{"errors":[{"error_code":"unprocessable_content"}]}')
        self.assertIn("unprocessable_content", exc.body)
        tr = translate("update wiki page", exc)
        self.assertEqual(tr.mode_id, "canvas-422-unprocessable")

    def test_provider_http_error_body_defaults_none(self):
        # Backward compatibility: existing two-arg construction keeps
        # working and body stays None.
        from dispatch.executor import ProviderHttpError
        exc = ProviderHttpError(401, "x")
        self.assertIsNone(exc.body)
        self.assertEqual(exc.status, 401)

    def test_multi_operator_predicate_rejected_at_validation(self):
        # LANE2-A: _predicate_matches rejects multi-operator dicts at
        # match time, so validate_entry must reject them at authoring
        # time. A catalog must never validate while containing a
        # predicate that can never match.
        from failures.catalog import validate_entry
        entry = {
            "id": "lane2-probe",
            "title": "probe",
            "surface": "query/chain.py",
            "severity_hint": "low",
            "root_cause": "probe",
            "is_not": "probe",
            "agent_message": "What was attempted: {operation}. "
                             "What the evidence showed: probe. "
                             "What this means: probe. "
                             "What happens next: probe.",
            "auto_action": "probe",
            "escalate_when": "probe",
            "signature": {
                "error_class": "ProbeError",
                "error_text": {"contains": "x", "not_contains": "y"},
            },
        }
        problems = validate_entry(entry)
        self.assertTrue(
            any("exactly one operator" in p for p in problems),
            "multi-operator predicate accepted: %r" % (problems,))
        entry["signature"]["error_text"] = {"contains": "x"}
        self.assertEqual([], validate_entry(entry))


if __name__ == "__main__":
    unittest.main(verbosity=2)
