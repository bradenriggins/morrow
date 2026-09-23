#!/usr/bin/env python3
"""Every failure message the shipped product can show is plain and true.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  1. Messages the Chromium lane reaches told the educator that Morrow
     was "resending through the normal page-context path with a fresh
     token harvest, then verifying with a readback" (canvas 422) or
     "re-harvesting the token ... resending the write" (missing CSRF
     token). No code resends after a refused write, and in plan mode the
     approval is already used. Others promised an "evidence bundle for
     engineering review" (the unknown fallback) or "reconciling with a
     terminal readback ... under a fresh claim".
  2. They used developer words: HTTP 422, unprocessable_content, CSRF,
     _csrf_token cookie, provider, payload, the signed-in browser lane,
     a validated plan, "plan (no plan id)", the journal, the catalog, the
     safety gate, identifier levels, interaction ids, PUT and PATCH.
  3. learner-data-gated told the educator student data "runs only
     through the signed-in browser lane with the encrypted student vault
     installed", with no step anyone could take. It now names the
     operator's pip command.
  4. The catalog kept modes for lanes that do not ship (the raw HTTPS
     lane's access token, the retired form and browser-task lanes, and
     Moodle). They are retired.

Each reachable mode below is produced from the exception class (or the
evidence dict) the shipped code raises or builds, so the test proves the
mode is reachable, then checks the rendered message. A mode whose
signature only needs evidence the shipped code produces must be listed
here, so a new reachable mode cannot skip the check.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
from dispatch import admission  # noqa: E402
from failures import translator  # noqa: E402
from failures.catalog import load_catalog  # noqa: E402
from modes import errors as mode_errors  # noqa: E402
from query import chain, live_read, quiz_resolve, thresholds  # noqa: E402

OPERATION = 'changing a page in the course "Biology 101"'
CSRF_BODY = ('{"errors":[{"message":"An error occurred.",'
             '"error_code":"unprocessable_content"}]}')


def _http(status, body, kind="write"):
    exc = ex.ProviderHttpError(status, "refused", body=body)
    # dispatch/executor.py sets these on a refused request before the
    # error reaches the funnel.
    exc.provider = "canvas"
    exc.operation_kind = kind
    return exc


def _halt(cause):
    exc = ex.WriteHaltActive("write halt active; refusing write")
    exc.halt_cause = cause
    return exc


def _students(names):
    from learners.resolve_student import resolve_in_course
    body = json.dumps([
        {"id": 5550100 + i, "name": name, "sortable_name": None,
         "short_name": None, "sis_user_id": None, "sis_login_id": None,
         "login_id": "s%d" % i, "email": None,
         "enrollments": [{"type": "StudentEnrollment",
                          "role": "StudentEnrollment",
                          "enrollment_state": "active",
                          "course_section_id": 11 + i}]}
        for i, name in enumerate(names)])

    def fetch(url):
        return 200, {}, body
    try:
        resolve_in_course(fetch, "https://canvas.example.edu", "89585",
                          "Jane Doe",
                          label_for=lambda uid: "Student A%d" % (uid % 10))
    except Exception as exc:  # noqa: BLE001
        return exc
    raise AssertionError("the lookup resolved")


def _quizzes(count):
    tz = timezone.utc
    start = datetime(2026, 9, 14, tzinfo=tz)
    end = datetime(2026, 9, 20, 23, 59, tzinfo=tz)
    if count == 0:
        return quiz_resolve.QuizNotFound(
            start, end, 4, 1, 1,
            [("Quiz C", 7, "2026-09-02T23:59:00Z", "assignment.due_at")], tz)
    return quiz_resolve.QuizAmbiguous(
        start, end,
        [("Quiz A", 1, "2026-09-15T23:59:00Z", "assignment.due_at", 10.0),
         ("Quiz B", 2, "2026-09-16T23:59:00Z", "quiz.lock_at", 20.0)], tz)


def _new_quiz(text):
    return ex.NewQuizRefused(text)


def _cli(exc_factory):
    from transport import chromium_session as cs
    return exc_factory(cs)


def _never_dispatch(name):
    desc = ex.catalog_descriptor_for(name)
    entry = ex.catalog_descriptor_to_entry(name, desc["method"],
                                           desc["path"])
    try:
        admission.check_never_dispatch(entry, admission.load_policy())
    except admission.NeverDispatch as exc:
        return exc
    raise AssertionError("%s was admitted" % name)


def _name_refusal(name, method, path):
    try:
        ex.catalog_descriptor_to_entry(name, method, path)
    except ex.CatalogNotProven as exc:
        return exc
    raise AssertionError("%s was accepted" % name)


def _approval_refusal(status):
    """The evidence reauth/state_machine.py cmd_approve passes when an op
    is not awaiting approval."""
    from reauth import state_machine as rsm
    return rsm.approval_refusal_evidence("op-12345678", status)


def _before_the_claim(exc):
    """What dispatch/executor.py main marks on a failure raised before
    it claimed a write."""
    exc.nothing_sent = True
    return exc


REACHABLE = {
    "canvas-csrf-token-missing": lambda: __import__(
        "transport.local_chromium", fromlist=["x"]).CsrfTokenMissing(
            "refusing POST https://x.instructure.com/api/v1/courses/1/pages:"
            " no _csrf_token in the live document.cookie, so no CSRF header "
            "could be built; the write was not sent"),
    "canvas-422-unprocessable": lambda: _http(422, CSRF_BODY),
    "canvas-write-refused-invalid": lambda: _http(
        400, '{"errors":{"title":[{"message":"is too long"}]}}'),
    "canvas-session-dead": lambda: _cli(
        lambda cs: cs.ChromiumSessionDead("Canvas answered with /login")),
    "evidence-hold": lambda: admission.EvidenceHold(
        "operation 'canvas_update_discussion' is on evidence hold"),
    "never-dispatch": lambda: admission.NeverDispatch(
        "operation posts an announcement"),
    "never-dispatch-read": lambda: _never_dispatch(
        "canvas_get_blueprint_information"),
    "catalog-name-mismatch": lambda: _name_refusal(
        "get_settings", "GET", "/api/v1/courses/{course_id}/settings"),
    "paused-change-not-resumed": lambda: _approval_refusal("quarantined"),
    "paused-change-already-approved": lambda: _approval_refusal("approved"),
    "paused-change-not-waiting": lambda: _approval_refusal(None),
    "unknown-nothing-sent": lambda: _before_the_claim(RuntimeError("boom")),
    "course-roster-unavailable": lambda: ex.CourseRosterUnavailable(
        "the course roster read failed"),
    "catalog-not-proven": lambda: ex.CatalogNotProven(
        "operation 'canvas_delete_module_item' is marked 'pending'"),
    "manifest-entry-not-pinned": lambda: ex.ManifestPinMismatch(
        "entry is not pinned in the pack"),
    "caller-input-refused": lambda: ex.CallerInputError(
        "--body is not a JSON object"),
    "helper-down": lambda: {
        "error": "ExecutorError", "provider": "helper",
        "detail": "login helper endpoint is down: connection refused"},
    "canvas-account-mismatch": lambda: _cli(
        lambda cs: cs.PrincipalMismatch("signed-in account differs")),
    "canvas-account-not-pinned": lambda: _cli(
        lambda cs: cs.PrincipalNotPinned("no pinned account")),
    "write-halt-active": lambda: _halt("manual"),
    "write-halt-session-expired": lambda: _halt("session_expired"),
    "write-approval-missing": lambda: admission.WriteApprovalMissing(
        "no approval record"),
    "learner-data-gated": lambda: admission.LearnerDataGated(
        "operation touches learner data"),
    "catalog-effect-mismatch": lambda: ex.CatalogEffectMismatch(
        "caller declared read for a write row"),
    "journal-torn-fail-closed": lambda: ex.JournalTorn("torn line 7"),
    "uncertain-write-ambiguous": lambda: ex.UncertainWrite(
        "connection reset after the write was sent"),
    "write-readback-unconfirmed": lambda: ex.UncertainWrite(
        "write answered 200 but the readback could not confirm it"),
    "write-readback-mismatch": lambda: ex.VerificationFailed(
        "verify block failed: title is 'A', expected 'B'"),
    "write-not-attempted": lambda: ex.WriteNotAttempted(
        "DNS failed before the request was sent"),
    "student-resolution-ambiguous": lambda: _students(
        ["Jane Doe", "Jane Doe"]),
    "student-resolution-no-match": lambda: _students(["Omar Haddad"]),
    "edit_self_grant_refused": lambda: mode_errors.ModeSelfGrantRefused(
        "the agent cannot grant edit mode"),
    "plan_mode_write_without_approval": lambda:
        mode_errors.PlanModeWriteWithoutApproval(
            "plan mode: no educator-approved validated plan on file",
            course_id="89585"),
    "settings_tamper_refused": lambda: mode_errors.ModeSettingsTamper(
        "invalid stored value", setting_name="default_mode"),
    "ambiguous_course_write_refused": lambda:
        mode_errors.AmbiguousCourseWriteRefused(
            "course target is ambiguous", query=None,
            candidates_public="Biology 101 (Fall 2026); Biology 101 "
                              "(Spring 2026)", course_id="89585"),
    "destructive_write_confirmation_required": lambda:
        mode_errors.DestructiveConfirmationRequired(
            "this write destroys data", entry_name="canvas_delete_page",
            course_id="89585"),
    "course_resolution_required": lambda: ex.CourseResolutionRequired(
        "write has no course resolution"),
    "effect_class_mismatch": lambda: ex.EffectClassMismatch(
        "declared read, derived write"),
    "write_field_mismatch": lambda: ex.WriteFieldMismatch(
        "readback title differs"),
    "unknown": lambda: RuntimeError("boom"),
    "quiz-resolution-no-match": lambda: _quizzes(0),
    "quiz-resolution-ambiguous": lambda: _quizzes(2),
    "query-arguments-invalid": lambda: chain.QueryArgumentsInvalid(
        "unknown quiz window 'yesterday'"),
    "query-timezone-unknown": lambda: chain.TimezoneUnknown("no timezone"),
    "query-threshold-undefined": lambda: thresholds.ThresholdUndefined(
        "no points possible"),
    "quiz-reference-unsupported": lambda: quiz_resolve.UnsupportedQuizRef(
        "yesterday"),
    "query-live-read-failed": lambda: live_read.LiveReadError(
        "a read was refused"),
    "query-course-id-invalid": lambda: chain.InvalidCourseId("abc"),
    "setup-tenant-not-configured": lambda: ex.SessionMissing(
        "chromium backend needs a Canvas base URL: pass base_url, set "
        "CANVAS_BASE in this tree's helper/env, or onboard the browser "
        "lane state"),
    "new-quiz-put-refused": lambda: _new_quiz(
        "PUT is never used on New Quiz paths (/api/quiz/v1); use PATCH"),
    "new-quiz-delete-via-assignment-refused": lambda: _new_quiz(
        "refusing delete (it orphans the quiz backend object)"),
    "new-quiz-stimulus-write-refused": lambda: _new_quiz(
        "stimulus items are authored in the UI"),
    "new-quiz-settings-stale-refused": lambda: _new_quiz(
        "refusing settings write: the saved quiz_settings block is missing"),
    "new-quiz-interaction-rename-refused": lambda: _new_quiz(
        "refusing an interaction-id rename"),
    "new-quiz-protected-quiz-refused": lambda: _new_quiz(
        "refusing write to New Quiz 506477: this quiz is never touched"),
    "new-quiz-guard-refused": lambda: _new_quiz("New Quiz guard refused"),
    "canvas-not-permitted": lambda: _http(
        403, '{"errors":[{"message":"user not authorized to perform that '
             'action"}]}'),
    "canvas-not-found": lambda: _http(
        404, '{"errors":[{"message":"The specified resource does not '
             'exist."}]}'),
    "canvas-refused-request": lambda: _http(
        409, '{"errors":[{"message":"conflict"}]}'),
    "helper-browser-not-reached": lambda: _cli(
        lambda cs: cs.HelperNotReached("no Chromium binary found")),
    "canvas-account-check-failed": lambda: _cli(
        lambda cs: cs.AccountCheckFailed("users/self answered 500")),
    "item-banks-not-reached": lambda: _cli(
        lambda cs: cs.ItemBanksNotReached(
            "Item Banks SDK lane failed (no tool); no provider call was "
            "attempted")),
    "write-halt-account-mismatch": lambda: _halt("account_mismatch"),
    "prepared-write-already-used": lambda: ex.PreparedWriteMissing(
        "no prepared write for op-12345678", already_used=True),
    "prepared-write-not-waiting": lambda: ex.PreparedWriteMissing(
        "no prepared write for op-12345678", already_used=False),
}

# Developer words an educator should never read. Case-insensitive unless
# listed in CASED (those are ordinary words in lower case).
DEVELOPER_WORDS = (
    "http", "json", "csrf", "cookie", "token", "harvest", "provider",
    "payload", "lane", "readback", "journal", "journaled", "endpoint",
    "catalog", "gate", "admission", "dispatch", "dispatcher", "executor",
    "manifest", "chromium", "tenant", "principal", "pinned", "quarantine",
    "backend", "engineering", "unprocessable", "effect class",
    "effect-class", "validated plan", "interaction", "orphan", "ghost",
    "keepalive", "cron", "vault", "op id", "evidence bundle",
    "classified", "identifier level", "sis",
)
CASED = ("API", "PUT", "PATCH", "CDP")
FALLBACK_VALUES = ("(unknown", "(no plan id)", "(unnamed", "(no ")
UNDONE_PROMISES = ("resending", "re-harvest", "fresh token", "under a fresh "
                   "claim", "engineering review", "parking the operation")


def _render(mode_id):
    tr = translator.translate(OPERATION, REACHABLE[mode_id]())
    assert tr.mode_id == mode_id, (mode_id, tr.mode_id)
    return tr.agent_message


@pytest.mark.parametrize("mode_id", sorted(REACHABLE))
def test_a_reachable_message_uses_plain_words(mode_id):
    text = _render(mode_id)
    lowered = text.lower()
    found = [w for w in DEVELOPER_WORDS
             if re.search(r"(?<![\w-])%s(?![\w-])" % re.escape(w), lowered)]
    found += [w for w in CASED if re.search(r"\b%s\b" % w, text)]
    # Class and role names such as LearnerDataGated or StudentEnrollment.
    found += re.findall(r"\b[A-Z][a-z]+[A-Z][A-Za-z]*\b", text)
    assert found == [], (mode_id, found, text)
    assert [v for v in FALLBACK_VALUES if v in text] == [], text
    assert [p for p in UNDONE_PROMISES if p in lowered] == [], text
    assert "—" not in text


def test_learner_data_gated_names_the_operator_step():
    text = _render("learner-data-gated")
    assert ("python3 -m pip install --require-hashes -r "
            "requirements-optional.txt") in text
    assert "person who looks after your Morrow setup" in text


@pytest.mark.parametrize("mode_id", ["canvas-csrf-token-missing",
                                     "canvas-422-unprocessable",
                                     "write-not-attempted",
                                     "helper-browser-not-reached",
                                     "canvas-account-check-failed",
                                     "item-banks-not-reached"])
def test_a_refused_change_is_prepared_again_only_on_request(mode_id):
    text = _render(mode_id)
    assert "nothing changed" in text.lower()
    assert "say the word and I will prepare the change again" in text


def test_no_mode_is_left_for_a_lane_that_does_not_ship():
    for entry in load_catalog().entries:
        sig = json.dumps(entry.get("signature") or {})
        assert "moodle" not in (entry["id"]
                                + entry.get("surface", "")).lower()
        assert '"provider": "moodle"' not in sig, entry["id"]
        assert '"lane": "https"' not in sig, entry["id"]
        assert "browser-task" not in entry["id"] + sig, entry["id"]
        assert "FormTransportUnavailable" not in sig, entry["id"]


# Evidence keys the shipped code produces: failures/translator.py
# _coerce_evidence on the exceptions dispatch/, transport/, modes/,
# settings/, learners/, and query/ raise (with the attributes the
# executor sets on a refused request), plus the dicts query/chain.py and
# reauth/state_machine.py build. None means any value.
PRODUCED = {
    "error_class": None, "error_text": None, "body_text": None,
    "http_status": None, "provider": ("canvas", "item-banks", "helper",
                                      "unknown"),
    "operation_kind": ("read", "write"), "route_kind": ("unknown",),
    "halt_cause": ("manual", "session_expired", "account_mismatch"),
    "prepared_write_used": (True, False),
    "stale_command": None, "session_dead_signal": None,
    "write_halt_active": None, "uncertain_write": None,
    "write_not_attempted": None, "validation_messages": None,
    "helper_reachable": None, "chromium_alive": None,
    "match_kind": None, "match_count": None, "candidates_public": None,
    "course_id": None, "query": None, "entry_name": None,
    "setting_name": None, "mode_self_grant_refused": None,
    "plan_mode_write_without_approval": None,
    "ambiguous_course_write_refused": None, "mode_settings_tamper": None,
    "destructive_write_confirmation_required": None,
    "nothing_sent": (True,), "catalog_name": None, "catalog_method": None,
    "catalog_path": None,
    "quarantine_status": ("quarantined", "approved", "none",
                          "session_quarantined"),
}
# Signatures whose keys the shipped code produces, but never together.
NEVER_TOGETHER = {
    # session_dead_signal comes only from the session-death classes and
    # uncertain_write only from UncertainWrite: one exception is never
    # both.
    "canvas-session-dead-mid-write-uncertain",
}


def _satisfiable(branch):
    for key, spec in branch.items():
        if key not in PRODUCED:
            return False
        values = PRODUCED[key]
        if values is not None and not any(
                translator._predicate_matches(spec, v) for v in values):
            return False
    return True


def test_every_reachable_mode_is_checked():
    unlisted = []
    for entry in load_catalog().entries:
        sig = dict(entry.get("signature") or {})
        branches = sig.pop("__any_of", None)
        reachable = _satisfiable(sig) and (
            branches is None or any(_satisfiable(b) for b in branches))
        if reachable and entry["id"] not in REACHABLE \
                and entry["id"] not in NEVER_TOGETHER:
            unlisted.append(entry["id"])
    assert unlisted == []
