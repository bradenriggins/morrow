#!/usr/bin/env python3
"""Translated + adversarial selftests for the source privacy boundary.

Run: python3 privacy/source_privacy_selftest.py
(from ~/workspace/morrow-for-muse-deploy)

Part 1 translates all 17 test declarations (23 concrete cases after the
it.each expansions) from
origin-morrow/packages/gateway-core/test/source-mcp-privacy.test.ts
against privacy/boundary.py + privacy/core.py.

Part 2 is a hostile leak battery: deep nested JSON, unicode variants,
free-text emails, grade CSV dumps, paginated users, SIS ids, LTI launch
parameters, base64/opaque blobs, and dispatch-bypass attempts. ANY
surviving recognizable learner identifier, or any bypass of the binding
checks, fails the suite.

Part 3 ports the ingress-detection doctrine from the Meridian JS
privacy boundary (chcp-team-agent-kit/scripts/team/privacy_boundary.js):
course titles preserved, education-record facts redacted, email-in-gradebook
redacted, /users/ URLs redacted, unknown-label spoof refused, known labels
round-trip, routine course copy untouched byte-identical, plus three
pinned documented gaps (initial-last names, "canvas id N" context, bare
DOB) where the egress port is weaker than the JS ingress layer.

Vault scratch lives under privacy/.selftest-work/, never /tmp and never
the educator's real state files. No live sessions; all fixtures are
synthetic and live in this file.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import json
import os
import re
import shutil
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
for _p in (_REPO, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from privacy.boundary import (  # noqa: E402
    INTERNAL_SOURCE_CAPABILITY_META,
    SourceMcpPrivacyBoundary,
    canvas_privacy_roster,
    moodle_source_history_available,
    source_privacy_input_schema,
    source_privacy_roster,
)
from privacy.core import PrivacyError  # noqa: E402

# Optional dependency (P1-24): the encrypted file-backed vault needs the
# ``cryptography`` package (pinned in requirements-optional.txt). The
# in-memory vault used by almost every test below never touches AES, so
# only the file-backed vault tests are skipped when it is missing; the
# suite reports the skip loudly instead of failing.
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: F401
    HAVE_CRYPTO = True
except ImportError:
    HAVE_CRYPTO = False

VAULT_FILE_TESTS = frozenset({"test_vault_persists_across_restarts",
                               "test_w3_cross_op_vault_seeding",
                               "test_shipped_vault_purge_tenant",
                               "test_shipped_vault_purge_course",
                               "test_executor_wire_purge_tenant",
                               "test_executor_wire_purge_all",
                               "test_executor_wire_cli_purge_course"})

# Wave-3 hygiene: MORROW_SELFTEST_SCRATCH redirects test scratch to the
# wave's authorized scratch area (never /tmp); the repo-local default
# keeps the suite hermetic outside the audit.
_SCRATCH_ROOT = os.environ.get("MORROW_SELFTEST_SCRATCH")
SCRATCH = (os.path.join(_SCRATCH_ROOT, "source-privacy")
           if _SCRATCH_ROOT else os.path.join(_HERE, ".selftest-work"))
os.makedirs(SCRATCH, exist_ok=True)

BINDING = {
    "sourceBindingId": "binding-42",
    "provider": "canvas",
    "courseId": "42",
    "origin": "https://canvas.example.edu",
    "runtimeVerified": True,
    "principalFingerprint": "b" * 64,
    "sessionGeneration": 1,
    "catalogDigest": "c" * 64,
}
LEARNERS = source_privacy_roster([{
    "id": 912345,
    "name": "Mary Jackson",
    "email": "mary@example.edu",
    "login_id": "mjackson",
    "sis_user_id": "SIS-987654",
    "short_name": "MJ",
    "sortable_name": "Jackson, Mary",
    "aliases": ["Mary J."],
}])
REQUEST = {"course_id": 42, "_morrow": {"source_binding_id": "binding-42"}}

IDENTIFIERS = ["Mary", "Jackson", "mary@example.edu", "mjackson",
               "SIS-987654", "912345", "MJ"]


def envelope(value):
    return {"content": [{"type": "text", "text": "Read complete."}],
            "structuredContent": {"ok": True, "value": value}}


def setup(**options):
    args = {"source": "test", "bindings": lambda: [BINDING],
            "load_roster": lambda binding: LEARNERS}
    args.update(options)
    return SourceMcpPrivacyBoundary(args)


def text(value):
    return json.dumps(value)


def token_of(result):
    match = re.search(r"Student A[1-9][0-9]*", text(result))
    assert match, "expected a Student A<n> label in %s" % text(result)[:200]
    return match.group(0)


def assert_no_identifiers(result, extra=()):
    blob = text(result)
    for identifier in list(IDENTIFIERS) + list(extra):
        assert identifier not in blob, \
            "identifier leaked: %r" % identifier


# ---------------------------------------------------------------------------
# Part 1: translated source tests
# ---------------------------------------------------------------------------

def test_complete_roster_all_surfaces():
    result = setup().invoke("canvas_read", REQUEST, None, lambda args: envelope({
        "cache": {"mary@example.edu":
                  "MJ, please ask Mary J. and mjackson. SIS-987654"},
        "comments": ["Mary Jackson posted. Mary answered. Jackson, Mary."],
        "custom": 912345,
        "problem": {"message": "Mary Jackson at mary@example.edu"},
    }))
    assert result.get("isError") is not True, text(result)[:300]
    assert_no_identifiers(result)
    assert "Student A" in text(result)


def test_write_resolves_pseudonyms_no_raw_readback():
    boundary = setup()
    read = boundary.invoke("canvas_read", REQUEST, None,
                           lambda args: envelope("Mary Jackson"))
    token = token_of(read)
    calls = []

    def handler(args):
        calls.append(args)
        return envelope(args)

    response = boundary.invoke(
        "canvas_write",
        dict(REQUEST, user_id=token, recipients=[token],
             body="Hello %s" % token),
        None, handler)
    assert calls and calls[0]["user_id"] == "912345", calls
    assert calls[0]["recipients"] == ["912345"], calls
    assert calls[0]["body"] == "Hello Mary Jackson", calls
    assert "Mary" not in text(response)
    assert "912345" not in text(response)
    assert token in text(response)


def _accommodation_case(provider_result):
    boundary = setup()
    label_read = boundary.invoke("canvas_read", REQUEST, None,
                                 lambda args: envelope("Mary Jackson"))
    token = token_of(label_read)
    seen = {}

    def handler(resolved):
        seen.update(resolved)
        return envelope(provider_result)

    response = boundary.invoke(
        "canvas_set_quiz_level_accommodations",
        dict(REQUEST, user_id=token, extra_time=15), None, handler)
    assert response.get("isError") is not True, text(response)[:300]
    assert seen.get("user_id") == "912345", seen
    assert token in text(response)
    for value in ("912345", "Mary", "Jackson"):
        assert value not in text(response), value


def test_accommodation_success_row():
    _accommodation_case({"successful": [{"user_id": "912345",
                                         "extra_time": 15}], "failed": []})


def test_accommodation_failure_row():
    _accommodation_case({"successful": [], "failed": [
        {"user_id": "912345",
         "message": "Mary Jackson cannot receive this accommodation."}]})


def test_pseudonyms_across_refreshes_refuse_cross_course():
    second = dict(BINDING, sourceBindingId="binding-43", courseId="43")
    boundary = setup(bindings=lambda: [BINDING, second])

    def read():
        return boundary.invoke("canvas_read", REQUEST, None,
                               lambda args: envelope("Mary Jackson"))

    first = read()
    assert read() == first
    token = token_of(first)
    calls = []
    response = boundary.invoke(
        "canvas_write",
        {"course_id": 43,
         "_morrow": {"source_binding_id": "binding-43"}, "body": token},
        None, lambda args: calls.append(args) or envelope(args))
    assert response.get("isError") is True, text(response)[:200]
    assert calls == []


def test_refuses_ambiguous_incomplete_changed_donor():
    ambiguous = setup(load_roster=lambda binding: list(LEARNERS) + [
        {"id": "991199", "name": "Mary Johnson"}])
    result = ambiguous.invoke("canvas_read", REQUEST, None,
                              lambda args: envelope("Mary replied"))
    assert result.get("isError") is True, text(result)[:200]

    def broken_roster(binding):
        raise RuntimeError("Mary Jackson roster incomplete")

    denied = setup(load_roster=broken_roster)
    calls = []
    result = denied.invoke("canvas_write", REQUEST, None,
                           lambda args: calls.append(args))
    assert result.get("isError") is True
    assert calls == []

    current = [BINDING]
    changing = setup(bindings=lambda: current)

    def mutating(args):
        current[0] = dict(BINDING, sessionGeneration=2)
        return envelope("Mary Jackson")

    result = changing.invoke("canvas_read", REQUEST, None, mutating)
    assert result.get("isError") is True, text(result)[:200]

    result = setup().invoke("legacy_read", REQUEST, None,
                            lambda args: envelope("Student_deadbeef"))
    assert result.get("isError") is True


def test_no_argument_raw_mode():
    secret = "a" * 64
    calls = []
    boundary = setup(internal_source_capability=secret)

    def handler(args):
        calls.append(args)
        return envelope("Mary Jackson")

    for extra in ({"raw": True},
                  {"internalSourceCapability": secret},
                  {"_meta": {INTERNAL_SOURCE_CAPABILITY_META: secret}}):
        result = boundary.invoke("canvas_read", dict(REQUEST, **extra),
                                 None, handler)
        assert "Mary" not in text(result), extra
        assert secret not in text(result), extra
    result = boundary.invoke("canvas_read", REQUEST,
                             {INTERNAL_SOURCE_CAPABILITY_META: "b" * 64},
                             handler)
    assert result.get("isError") is True
    result = setup().invoke("canvas_read", REQUEST,
                            {INTERNAL_SOURCE_CAPABILITY_META: secret},
                            handler)
    assert result.get("isError") is True
    raw = boundary.invoke("canvas_read", {},
                          {INTERNAL_SOURCE_CAPABILITY_META: secret}, handler)
    assert "Mary Jackson" in text(raw)
    assert secret not in text(raw)


def test_refuses_unscoped_private_unsafe_malformed():
    boundary = setup()
    calls = []

    def throwing(args):
        calls.append(args)
        raise RuntimeError("Mary Jackson raw failure")

    assert boundary.invoke("canvas_read", {}, None,
                           throwing).get("isError") is True
    before = len(calls)
    assert boundary.invoke("canvas_send_private_conversation", REQUEST, None,
                           throwing).get("isError") is True
    assert len(calls) == before
    result = boundary.invoke("canvas_read", REQUEST, None, throwing)
    assert result.get("isError") is True
    assert "Mary" not in text(result)
    try:
        source_privacy_roster([{"id": "1", "aliases": [17]}])
    except (PrivacyError, TypeError):
        pass
    else:
        raise AssertionError("malformed aliases were accepted")


def test_vault_persists_across_restarts():
    directory = os.path.join(SCRATCH, "source-vault")
    shutil.rmtree(directory, ignore_errors=True)
    os.makedirs(directory)
    try:
        path = os.path.join(directory, "vault.json")
        first = setup(learner_vault_path=path).invoke(
            "canvas_read", REQUEST, None,
            lambda args: envelope("Mary Jackson"))
        restarted = setup(learner_vault_path=path)
        second = restarted.invoke(
            "canvas_read", REQUEST, None,
            lambda args: envelope("Mary Jackson"))
        assert second == first, (text(first)[:120], text(second)[:120])
        with open(path, "r", encoding="utf-8") as handle:
            assert "Mary Jackson" not in handle.read()
        label = token_of(first)
        calls = []
        restarted.invoke("canvas_write", dict(REQUEST, user_id=label), None,
                         lambda args: calls.append(args) or envelope(args))
        assert calls and calls[0]["user_id"] == "912345", calls
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def test_input_schema_learner_id_positions():
    schema = source_privacy_input_schema({
        "type": "object",
        "properties": {
            "user_id": {"type": "integer"},
            "course_id": {"type": "integer"},
            "recipients": {"type": "array", "items": {"type": "integer"}},
        },
    })
    props = schema["properties"]
    assert isinstance(props["user_id"].get("anyOf"), list)
    assert props["course_id"] == {"type": "integer"}
    # Faithful to the source: items under a learner-keyed array position
    # also gain the label alternative (the source test only pins user_id
    # and course_id).
    assert isinstance(props["recipients"]["items"].get("anyOf"), list)
    assert INTERNAL_SOURCE_CAPABILITY_META not in text(schema)


def test_input_schema_caller_identified_field():
    schema = source_privacy_input_schema({
        "type": "object",
        "properties": {
            "id": {"type": "string", "pattern": "^[1-9][0-9]*$"},
            "rubric_id": {"type": "string", "pattern": "^[1-9][0-9]*$"},
        },
    }, ["id"])
    props = schema["properties"]
    assert isinstance(props["id"].get("anyOf"), list)
    assert props["rubric_id"] == {"type": "string",
                                  "pattern": "^[1-9][0-9]*$"}
    try:
        source_privacy_input_schema({}, ["bad field"])
    except TypeError as exc:
        assert str(exc) == "privacy learner identifier field is invalid"
    else:
        raise AssertionError("bad identifier field was accepted")


def test_resolves_caller_identified_field():
    boundary = setup()
    label_read = boundary.invoke("canvas_read", REQUEST, None,
                                 lambda args: envelope("Mary Jackson"))
    token = token_of(label_read)
    calls = []
    boundary.invoke("canvas_get_single_user",
                    dict(REQUEST, id=token, rubric_id=token), None,
                    lambda args: calls.append(args) or envelope(args))
    assert calls, "handler was not called"
    assert calls[0]["id"] == "912345", calls[0]
    assert calls[0]["rubric_id"] == "Mary Jackson", calls[0]


def test_historical_dedup_removes_aliases():
    former = {"id": "818181", "name": "Alice Former", "short_name": "Ali",
              "email": "alice@example.edu", "login_id": "aformer"}
    enrollment = {"course_id": "42", "type": "StudentEnrollment",
                  "enrollment_state": "deleted", "user_id": former["id"],
                  "sis_user_id": "SIS-818181", "user": former}
    roster = canvas_privacy_roster([], [enrollment, enrollment], "42")
    assert len(roster) == 1
    boundary = setup(load_roster=lambda binding: roster)
    projected = boundary.invoke(
        "canvas_read", REQUEST, None, lambda args: envelope({
            "posts": ["Alice Former was unenrolled. Ali sent "
                      "alice@example.edu and aformer"],
            "cache": {"SIS-818181": former["id"]},
        }))
    assert projected.get("isError") is not True, text(projected)[:300]
    assert "Student A1" in text(projected)
    for name in ("Alice", "Former", "Ali", "alice@example.edu", "aformer",
                 "818181", "SIS-818181"):
        assert name not in text(projected), name
    calls = []
    boundary.invoke("canvas_write", dict(REQUEST, user_id="Student A1"),
                    None, lambda args: calls.append(args) or envelope(args))
    assert calls and calls[0]["user_id"] == former["id"], calls


def test_historical_merge_same_label():
    former = {"id": "818181", "name": "Alice Former", "short_name": "Ali",
              "email": "alice@example.edu", "login_id": "aformer"}
    enrollment = {"course_id": "42", "type": "StudentEnrollment",
                  "enrollment_state": "deleted", "user_id": former["id"],
                  "sis_user_id": "SIS-818181", "user": former}
    roster = canvas_privacy_roster(
        [former],
        [enrollment, dict(enrollment,
                          user=dict(former, aliases=["Alice F."]))],
        "42")
    assert len(roster) == 1
    assert roster[0]["id"] == former["id"]
    assert roster[0]["sisUserId"] == "SIS-818181"
    assert "Alice F." in roster[0]["aliases"]


def _mismatch_case(change):
    former = {"id": "818181", "name": "Alice Former"}
    enrollment = {"course_id": "42", "type": "StudentEnrollment",
                  "enrollment_state": "deleted", "user_id": former["id"],
                  "user": former}
    try:
        canvas_privacy_roster([], [dict(enrollment, **change)], "42")
    except (PrivacyError, TypeError, KeyError):
        return
    raise AssertionError("mismatched evidence accepted: %r" % (change,))


def test_historical_refuses_wrong_course():
    _mismatch_case({"course_id": "43"})


def test_historical_refuses_wrong_type():
    _mismatch_case({"type": "TeacherEnrollment"})


def test_historical_refuses_active_state():
    _mismatch_case({"enrollment_state": "active"})


def test_historical_refuses_user_mismatch():
    _mismatch_case({"user_id": "999"})


def test_historical_refuses_null_user():
    _mismatch_case({"user": None})


def test_historical_refuses_nameless_user():
    _mismatch_case({"user": {"id": "818181"}})


def test_historical_refuses_conflict():
    former = {"id": "818181", "name": "Alice Former"}
    enrollment = {"course_id": "42", "type": "StudentEnrollment",
                  "enrollment_state": "deleted", "user_id": former["id"],
                  "user": former}
    try:
        canvas_privacy_roster([dict(former, name="Different Learner")],
                              [enrollment], "42")
    except PrivacyError as exc:
        assert "privacy_roster_history_conflict" in str(exc), exc
    else:
        raise AssertionError("conflicting identity was accepted")


def test_historical_unavailable_no_read():
    calls = []

    def broken(binding):
        raise RuntimeError("privacy_roster_history_incomplete")

    boundary = setup(load_roster=broken)
    result = boundary.invoke("canvas_read", REQUEST, None,
                             lambda args: calls.append(args)
                             or envelope("Alice Former posted this"))
    assert result.get("isError") is True
    assert calls == []


def test_moodle_history_availability():
    assert moodle_source_history_available("moodle_get_forum_posts",
                                           "learner") is False
    assert moodle_source_history_available("moodle_get_assignment_submission",
                                           "learner") is False
    assert moodle_source_history_available("moodle_get_course_log_summary",
                                           "learner") is False
    assert moodle_source_history_available("moodle_get_wiki_page",
                                           "course") is False
    assert moodle_source_history_available("moodle_get_page",
                                           "course") is True
    assert moodle_source_history_available(
        "moodle_get_course_participant_roster", "learner") is True


# ---------------------------------------------------------------------------
# Part 2: hostile leak battery
# ---------------------------------------------------------------------------

def _hostile_boundary():
    return setup()


def test_hostile_deep_nested_json():
    nested = {"level": "Mary Jackson"}
    for _ in range(12):
        nested = {"deeper": nested, "sibling": ["mjackson"]}
    leaf = {"v": "SIS-987654"}
    cells = [nested, {"email": "mary@example.edu",
                      "nested_list": [[[leaf]]]}]
    payload = {"report": {"sections": [{"rows": [{"cells": cells}]}]}}
    result = _hostile_boundary().invoke("canvas_read", REQUEST, None,
                                        lambda args: envelope(payload))
    assert result.get("isError") is not True, text(result)[:200]
    assert_no_identifiers(result)


def test_hostile_unicode_variants():
    fullwidth = "\uff2d\uff41\uff52\uff59 \uff2a\uff41\uff43\uff4b\uff53\uff4f\uff4e"
    payload = {"posts": [
        "Hello %s" % fullwidth,
        "Mary&#x20;Jackson wrote this",
        "Contact Mary%20Jackson or mary%40example.edu",
        "MARY JACKSON submitted late",
    ]}
    result = _hostile_boundary().invoke("canvas_read", REQUEST, None,
                                        lambda args: envelope(payload))
    assert result.get("isError") is not True, text(result)[:200]
    blob = text(result)
    assert "Mary" not in blob and "Jackson" not in blob, blob[:300]
    assert "mary@example.edu" not in blob
    assert "Student A" in blob


def test_hostile_emails_in_free_text_submissions():
    payload = {"submissions": [
        {"user_id": "912345",
         "body": "Please email mary@example.edu or mjackson about grading. "
                 "My SIS is SIS-987654."},
    ]}
    result = _hostile_boundary().invoke("canvas_read", REQUEST, None,
                                        lambda args: envelope(payload))
    assert result.get("isError") is not True, text(result)[:200]
    assert_no_identifiers(result)


def test_hostile_grade_csv_text():
    # Names and emails inside a CSV dump are redacted. Bare numeric ids in
    # prose are NOT: the boundary only resolves whole-string ids and
    # contextual references (user_id=..., /users/...), same as the source.
    # That is a documented limitation, not a regression.
    csv = ("user_id,name,grade\n"
           "user_id=912345,Mary Jackson,A\n"
           "912345 <mary@example.edu>,B\n")
    result = _hostile_boundary().invoke("canvas_read", REQUEST, None,
                                        lambda args: envelope({"export": csv}))
    assert result.get("isError") is not True, text(result)[:200]
    blob = text(result)
    for identifier in ("Mary", "Jackson", "mary@example.edu"):
        assert identifier not in blob, identifier
    assert "Student A" in blob


def test_hostile_paginated_users():
    payload = {
        "users": [
            {"id": "912345", "name": "Mary Jackson",
             "email": "mary@example.edu", "login_id": "mjackson"},
        ],
        "next_page": "https://canvas.example.edu/api/v1/courses/42/users?page=2",
        "per_page": 50,
    }
    result = _hostile_boundary().invoke("canvas_read", REQUEST, None,
                                        lambda args: envelope(payload))
    assert result.get("isError") is not True, text(result)[:200]
    assert_no_identifiers(result)


def test_hostile_sis_ids_in_enrollments():
    # A /users/<id> path segment is a contextual identity reference and is
    # redacted. Other numeric path segments (e.g. /grades/<id>) are not
    # recognized by the source boundary either; documented limitation.
    payload = {"enrollments": [
        {"user_id": "912345", "sis_user_id": "SIS-987654",
         "user": {"id": "912345", "name": "Mary Jackson"},
         "html_url": "https://canvas.example.edu/courses/42/users/912345"},
    ]}
    result = _hostile_boundary().invoke("canvas_read", REQUEST, None,
                                        lambda args: envelope(payload))
    assert result.get("isError") is not True, text(result)[:200]
    assert_no_identifiers(result)


def test_hostile_lti_launch_parameters():
    payload = {"launch": {
        "lis_person_name_full": "Mary Jackson",
        "lis_person_contact_email_primary": "mary@example.edu",
        "custom_canvas_user_id": "912345",
        "oauth_consumer_key": "key-for-course-42",
        "launch_presentation_return_url":
            "https://canvas.example.edu/courses/42?token=abc",
    }}
    result = _hostile_boundary().invoke("canvas_read", REQUEST, None,
                                        lambda args: envelope(payload))
    # Secret-shaped values fail closed rather than leak partially.
    # W2-P1-1: a SHORT token= value is instructional-shaped, not
    # credential-shaped: it is redacted in place and the read succeeds,
    # while roster identifiers still de-identify. A credential-length
    # token= value (20+ chars) still refuses loudly (see
    # test_sensitive_hard_token_value_refused).
    assert result.get("isError") is not True, text(result)[:200]
    assert "token=abc" not in text(result)
    assert "[redacted]" in text(result)
    assert "Mary" not in text(result)
    assert "mary@example.edu" not in text(result)


def test_hostile_base64_opaque_blobs():
    import base64
    blob = base64.b64encode(b"Mary Jackson mary@example.edu").decode()
    payload = {"attachment": {"encoding": "base64", "data": blob,
                              "content_type": "text/plain"}}
    result = _hostile_boundary().invoke("canvas_read", REQUEST, None,
                                        lambda args: envelope(payload))
    assert result.get("isError") is True, text(result)[:200]
    sneaky = {"note": "data:text/plain;base64,%s" % blob}
    result = _hostile_boundary().invoke("canvas_read", REQUEST, None,
                                        lambda args: envelope(sneaky))
    assert result.get("isError") is True, text(result)[:200]


def test_hostile_dispatch_bypass_attempts():
    boundary = setup()
    calls = []
    other = dict(BINDING, sourceBindingId="binding-9", courseId="9")
    multi = setup(bindings=lambda: [BINDING, other])
    # Wrong course for the binding id.
    result = multi.invoke(
        "canvas_read", {"course_id": 9,
                        "_morrow": {"source_binding_id": "binding-42"}},
        None, lambda args: calls.append(args) or envelope("Mary Jackson"))
    assert result.get("isError") is True
    assert calls == []
    # accepts_course_request veto.
    veto = setup(accepts_course_request=lambda name, args, binding: False)
    result = veto.invoke("canvas_read", REQUEST, None,
                         lambda args: calls.append(args)
                         or envelope("Mary Jackson"))
    assert result.get("isError") is True
    assert calls == []
    # Unverified binding.
    unverified = dict(BINDING, runtimeVerified=False)
    bad = setup(bindings=lambda: [unverified])
    result = bad.invoke("canvas_read", REQUEST, None,
                        lambda args: calls.append(args)
                        or envelope("Mary Jackson"))
    assert result.get("isError") is True
    assert calls == []
    # Write with a label the vault never issued.
    result = boundary.invoke("canvas_write", dict(REQUEST, user_id="Student A9"),
                             None, lambda args: calls.append(args))
    assert result.get("isError") is True
    assert calls == []


def test_hostile_secret_shaped_text_refused():
    payload = {"config": "Authorization: Bearer abcdefgh12345678 "
                         "for Mary Jackson"}
    result = _hostile_boundary().invoke("canvas_read", REQUEST, None,
                                        lambda args: envelope(payload))
    assert result.get("isError") is True
    assert "Mary" not in text(result)
    assert "Bearer" not in text(result)


# ---------------------------------------------------------------------------
# Part 3: ingress-detection patterns ported from the Meridian JS privacy
# boundary (chcp-team-agent-kit/scripts/team/privacy_boundary.js).
#
# That layer is production student-PII DETECTION / spoof-gating on
# INGRESS; this port is pseudonymization on EGRESS. They are two halves
# of one boundary (block PII ingress + pseudonymize outputs), not
# duplicates. The portable doctrine, with its false-positive lessons:
#
# - Detection must be STRONG-context gated. Aggressive keyword gating
#   caused real false positives on routine course content (audit
#   2026-05-11: every teammate message about a MindTap/Cengage chapter
#   fired the name heuristic on phrases like "Word Parts in Action";
#   2026-05-12: bare "students?" fired on "lock students out" /
#   "all students see this"). The JS layer now requires a STRONG
#   student-data signal (possessive, record-word follow-on, roster /
#   gradebook / SIS / FERPA language) in the SAME paragraph as the
#   person identifier before treating it as student data.
# - The egress half answers the same lesson structurally: redaction
#   here is roster-driven, never keyword-driven. Routine course
#   content can never be relabeled because the harvester only admits
#   records carrying an unambiguous identity field (email, login_id,
#   sis_user_id, sortable_name, short_name, or a user-ish key) - the
#   same discriminator the JS layer landed on 2026-05-23
#   (objectLooksLikeCanvasUser: {id, name, position, items_count} is a
#   Canvas module, not a person).
#
# These tests pin both directions: real student identifiers are
# caught, routine course content passes through byte-identical.
# ---------------------------------------------------------------------------

def test_detect_course_titles_preserved():
    # Ported from test-privacy-filter-precision.js: a person's name must
    # never survive egress, and a Canvas course title is not a person.
    courses = [
        {"id": 32562, "name": "DAC 110 (Master 2026)",
         "course_code": "DAC110"},
        {"id": 92018,
         "name": "DA 118 Dental Skills and Procedures - 2026 BP Master",
         "enrollment_term_id": 7},
        {"id": 949152, "name": "Week 4 Overview", "position": 4,
         "workflow_state": "active"},
        {"id": 1789608, "display_name": "Rubric.pdf",
         "filename": "rubric.pdf", "mime_class": "pdf"},
    ]
    result = setup().invoke("canvas_read", REQUEST, None,
                            lambda args: envelope(courses))
    assert result.get("isError") is not True, text(result)[:300]
    blob = text(result)
    for course in courses:
        title = course.get("name") or course.get("display_name")
        if "display_name" in course:
            # DIVERGENCE FROM THE JS LAYER, FAITHFUL TO THE PORT SOURCE:
            # the desktop boundary treats display_name as an identity
            # value field and drops it (privacy.ts IDENTITY_VALUE_FIELDS
            # includes "displayname"), while the Meridian ingress
            # redactForEgress preserves file display names. The file's
            # other fields still pass through.
            assert title not in blob, \
                "display_name is dropped by the faithful port: %r" % title
            continue
        assert title in blob, "course title must survive: %r" % title
    assert "rubric.pdf" in blob, "file filename must survive"
    assert "Student A" not in blob, \
        "no course object may be relabeled: %s" % blob[:300]


def test_detect_person_shapes_still_caught():
    # The other direction of the same JS test: person-shaped records
    # are caught even when course-shaped records sit beside them.
    mixed = [
        {"id": 32562, "name": "DAC 110 (Master 2026)",
         "course_code": "DAC110"},
        {"id": 912345, "name": "Mary Jackson",
         "sortable_name": "Jackson, Mary", "login_id": "mjackson"},
        {"user_id": 912345,
         "user": {"id": 912345, "name": "Mary Jackson",
                  "sortable_name": "Jackson, Mary"}},
    ]
    result = setup().invoke("canvas_read", REQUEST, None,
                            lambda args: envelope(mixed))
    assert result.get("isError") is not True, text(result)[:300]
    blob = text(result)
    assert "DAC 110 (Master 2026)" in blob
    assert_no_identifiers(result)
    assert "Student A" in blob


def test_detect_education_record_fact_redacted():
    # Ported from the JS contextualStudentPiiFindings gap closure
    # (2026-05-11): protected education-record facts often omit the
    # literal word "student" ("Jane Doe scored 88 on the MindTap
    # quiz"). A roster name plus a record fact must still redact.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope(
            "Mary Jackson scored 88 on the quiz. MJ is missing Module 4."))
    assert result.get("isError") is not True, text(result)[:300]
    assert_no_identifiers(result)
    assert "Student A" in text(result)


def test_detect_email_in_gradebook_context():
    # Ported from test-student-privacy-boundary.js: "Analyze student
    # jane.doe@example.edu in the gradebook" is blocked on ingress;
    # on egress the email must become the label.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope(
            "Analyze student mary@example.edu in the gradebook"))
    assert result.get("isError") is not True, text(result)[:300]
    assert "mary@example.edu" not in text(result)
    assert "Student A" in text(result)


def test_detect_user_id_url_redacted():
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope("see /users/912345 for details"))
    assert result.get("isError") is not True, text(result)[:300]
    assert "912345" not in text(result)
    assert "Student A" in text(result)


def test_detect_unknown_label_spoof_refused():
    # Spoof-gating analog of the JS privacyStampFields lesson: a label
    # the vault never issued ("Student A99") is refused, never passed
    # through as if it were a real pseudonym.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope("Student A99 submitted the assignment"))
    assert result.get("isError") is True, text(result)[:200]


def test_detect_known_label_roundtrips():
    # A label the vault DID issue is stable and idempotent across
    # reads: re-projection must not leak and must not relabel.
    boundary = setup()
    first = boundary.invoke("canvas_read", REQUEST, None,
                            lambda args: envelope("Mary Jackson"))
    assert first.get("isError") is not True, text(first)[:200]
    token = token_of(first)
    second = boundary.invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope("%s submitted the assignment" % token))
    assert second.get("isError") is not True, text(second)[:200]
    assert token in text(second)
    assert_no_identifiers(second)


def test_detect_routine_course_copy_untouched():
    # The STRONG-context lesson as an egress pin: routine
    # course-authoring copy must pass through byte-identical, even
    # when it contains the weak signals ("students", "progress",
    # "attempts", Title-Case pairs) that used to cause false
    # positives in the JS layer (audits 2026-05-11, 2026-05-12,
    # 2026-05-27, 2026-05-28).
    routine = [
        "lock students out after the deadline; all students see this",
        "each student gets three attempts on the quiz",
        "B. Disinfect the completed cast",
        "Match the term to its definition",
        "Word Parts in Action",
        "Clinical Connections",
    ]
    for line in routine:
        result = setup().invoke("canvas_read", REQUEST, None,
                                lambda args: envelope(line))
        assert result.get("isError") is not True, text(result)[:200]
        assert json.loads(text(result))["structuredContent"]["value"] \
            == line, "routine course copy must survive: %r" % line


def test_documented_gap_initial_last_name():
    # W2-P1-2 closed this documented gap: the port's alias set now
    # includes the bare surname, so "M. Jackson" redacts the surname
    # rather than surviving. (The JS ingress layer has no such gap: it
    # blocks on the education-record fact.) Pinned so any future alias
    # regression is visible here.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope("M. Jackson is missing Module 4"))
    assert result.get("isError") is not True, text(result)[:300]
    assert "Jackson" not in text(result), \
        "surname must redact: %s" % text(result)[:200]
    assert "Student A" in text(result)


def test_documented_gap_canvas_id_context():
    # DOCUMENTED GAP: "canvas id 912345" is not one of the boundary's
    # contextual id patterns (/users/<id>, user_id=<id>, whole-string
    # ids are). The JS layer flags it via CANVAS_ID_CONTEXT_PATTERN.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope("canvas id 912345 submitted late"))
    assert result.get("isError") is not True, text(result)[:300]
    assert "912345" in text(result), \
        "canvas-id context currently survives: %s" % text(result)[:200]


def test_documented_gap_bare_dob():
    # DOCUMENTED GAP: the JS layer flags a 1900-2099 date adjacent to
    # a DOB indicator (bare_dob_context); the egress port redacts the
    # roster name but has no DOB detector, so the date survives.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope("Mary Jackson, DOB 05/22/2006, needs outreach"))
    assert result.get("isError") is not True, text(result)[:300]
    assert "Mary Jackson" not in text(result)
    assert "05/22/2006" in text(result), \
        "bare DOB currently survives: %s" % text(result)[:200]


# Part 4: wave-2 adversarial regressions (2026-09-21)
# ----------------------------------------------------------------------
# W2-P0-12 homoglyph-resistant matching, W2-P0-13 zero-width and
# partial-name leakage, W2-P1-1 surgical sensitive-text redaction,
# W2-P1-2 bare-surname redaction, W2-P2-4 URL-safe de-identification.
# All fixtures are synthetic. The Alice roster exercises multi-part
# names (given + middle initial + surname) so partial-name behavior is
# pinned.

ALICE_BINDING = {
    "sourceBindingId": "binding-43",
    "provider": "canvas",
    "courseId": "43",
    "origin": "https://canvas.example.edu",
    "runtimeVerified": True,
    "principalFingerprint": "c" * 64,
    "sessionGeneration": 1,
    "catalogDigest": "d" * 64,
}
ALICE_LEARNERS = source_privacy_roster([{
    "id": 777001,
    "name": "Alice B. Thornton",
    "email": "alice.thornton@example.com",
    "login_id": "athornton",
    "sis_user_id": "SIS-111222",
}])
ALICE_REQUEST = {"course_id": 43,
                 "_morrow": {"source_binding_id": "binding-43"}}


def alice_setup(**options):
    args = {"source": "test", "bindings": lambda: [ALICE_BINDING],
            "load_roster": lambda binding: ALICE_LEARNERS}
    args.update(options)
    return SourceMcpPrivacyBoundary(args)


def test_w2_homoglyph_cyrillic_a_redacted():
    # W2-P0-12: Cyrillic A (U+0410) looks identical to Latin A; the
    # confusable fold must still match the alias.
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope("Аlice B. Thornton submitted"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "Аlice" not in text(result)
    assert "Thornton" not in text(result)
    assert "Student A1" in text(result)


def test_w2_homoglyph_cyrillic_ie_redacted():
    # W2-P0-12: Cyrillic ie (U+0435) looks identical to Latin e.
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope("Alicе B. Thornton submitted"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "Alicе" not in text(result)
    assert "Thornton" not in text(result)
    assert "Student A1" in text(result)


def test_w2_zero_width_full_name_redacted():
    # W2-P0-13: zero-width space (U+200B) / non-joiner (U+200C) inside
    # the name must not defeat matching, and the invisible characters
    # must not survive in the output next to the pseudonym.
    sneaky = ("Ali\u200bce B. Thor\u200cnton submitted")
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope(sneaky))
    assert result.get("isError") is not True, text(result)[:200]
    assert "Thornton" not in text(result)
    assert "\u200b" not in text(result) and "\u200c" not in text(result)
    assert "alice" not in text(result).lower().replace("student a1", "")
    assert "Student A1" in text(result)


def test_w2_zero_width_reversed_name_redacted():
    # W2-P0-13: reversed surname/given form ("Jackson Mary", an alias
    # of "Mary Jackson") with a zero-width non-joiner (U+200C) inside
    # the surname still redacts.
    sneaky = "J\u200cackson Mary is missing Module 4"
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope(sneaky))
    assert result.get("isError") is not True, text(result)[:200]
    assert "ackson" not in text(result)
    assert "Mary" not in text(result).replace("Student A1", "")
    assert "Student A1" in text(result)


def test_accented_spelling_of_a_roster_name_redacted():
    # Muse engine audit 2026-09-23: the roster spells "Alice B.
    # Thornton"; text written with accents ("Álice B. Thörnton") or a
    # word processor's apostrophe must still match.
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope("Álice B. Thörnton submitted; Thörnton "
                              "agreed"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "Thörnton" not in text(result), text(result)[:200]
    assert "Álice" not in text(result), text(result)[:200]
    assert "Student A1" in text(result)


def test_curly_apostrophe_spelling_of_a_roster_name_redacted():
    learners = source_privacy_roster([{"id": 777002,
                                       "name": "Liam O'Brien"}])
    result = alice_setup(load_roster=lambda binding: learners).invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope("Liam O\u2019Brien wrote; O\u2019Brien "
                              "agreed"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "Brien" not in text(result), text(result)[:200]
    assert "Student A1" in text(result)


def test_w2_bare_surname_redacted():
    # W2-P1-2: the surname alone is identifying within a course roster.
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope("Thornton said the quiz was easy"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "Thornton" not in text(result)
    assert "Student A1" in text(result)


def test_w2_partial_name_no_surname_leak():
    # W2-P0-13: "Alice Thornton" (given + surname, no middle initial)
    # must redact as a unit. Emitting "Student A1 Thornton" would pair
    # the stable pseudonym with the real surname.
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope("Alice Thornton submitted the assignment"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "Thornton" not in text(result), text(result)[:200]
    assert "Student A1 Thornton" not in text(result)
    assert "Student A1 submitted" in text(result)


def test_w2_url_percent_encoded_name_redacted():
    # W2-P2-4: a percent-encoded name inside a URL redacts to a
    # percent-encoded pseudonym; the URL stays syntactically intact and
    # no "Student A1" with a raw space ever lands inside the token.
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope(
            "see https://canvas.example.edu/users/Alice%20B.%20Thornton "
            "for details"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "Alice" not in text(result)
    assert "Thornton" not in text(result)
    assert "users/Student%20A1" in text(result)


def test_w2_mailto_token_stays_intact():
    # W2-P2-4: a roster email inside a mailto: token redacts without
    # producing a malformed "mailto:Student A1" token.
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope(
            "contact mailto:alice.thornton@example.com for help"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "alice.thornton@example.com" not in text(result)
    assert "mailto:Student A1" not in text(result)
    assert "mailto:Student%20A1" in text(result)


def test_w2_sensitive_csrf_token_surgically_redacted():
    # W2-P1-1: instructional "csrf"/"token=" shapes redact the span;
    # the read succeeds.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope(
            "set the csrf token in the request header before posting"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "csrf" not in text(result).lower()
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope("pass token=abc123 to the widget"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "token=abc123" not in text(result)
    assert "[redacted]" in text(result)


def test_w2_sensitive_hidden_html_surgically_redacted():
    # W2-P1-1: hidden-field / display:none teaching examples redact the
    # tag span instead of refusing the whole read.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope(
            'example: <input type="hidden" name="x" value="1"> hides a field'))
    assert result.get("isError") is not True, text(result)[:200]
    assert 'type="hidden"' not in text(result)
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope(
            'note <div style="display:none">secret</div> done'))
    assert result.get("isError") is not True, text(result)[:200]
    assert "display:none" not in text(result)


def test_w2_sensitive_short_data_url_surgically_redacted():
    # W2-P1-1: a short teaching data: URL redacts in place.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope(
            "embed data:image/png;base64,iVBORw0KGgo= as a tiny example"))
    assert result.get("isError") is not True, text(result)[:200]
    assert "iVBORw0KGgo=" not in text(result)


def test_w2_sensitive_hard_bearer_still_refused():
    # W2-P1-1: an actual bearer credential still refuses loudly.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope(
            "Authorization: Bearer abcdefgh12345678 leaked in the post"))
    assert result.get("isError") is True, text(result)[:200]
    assert "abcdefgh12345678" not in text(result)


def test_w2_sensitive_hard_token_value_still_refused():
    # W2-P1-1: token= with a credential-length value still refuses.
    # Fixture token built by concatenation so the literal sk_live_... shape
    # never appears in source (GitHub push protection flags it otherwise).
    probe = "sk_" + "live_abcdefghij1234567890"
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope(
            "token=" + probe + " was pasted in the page"))
    assert result.get("isError") is True, text(result)[:200]
    assert probe not in text(result)


def test_w2_sensitive_hard_data_url_still_refused():
    # W2-P1-1: a data: URL carrying a real base64 payload still refuses.
    result = setup().invoke(
        "canvas_read", REQUEST, None,
        lambda args: envelope(
            "data:image/png;base64," + "QUJD" * 12 + " pasted as content"))
    assert result.get("isError") is True, text(result)[:200]


# ----------------------------------------------------------------------
# Part 5: wave-3 adversarial regressions (2026-09-21)
# ----------------------------------------------------------------------
# W3-P0-10 bare base64 blobs in ordinary text, W3-P0-11 cross-op vault
# seeding, W3-P0-12 unresolvable author projection, W3-P1-8 unrostered
# LTI spec-typed identity fields. All fixtures are synthetic.

def test_w3_b64_blob_with_identity_masked():
    # W3-P0-10 (lane 2 L2-T1): a bare base64 blob decoding to roster
    # identifiers is masked inside and re-encoded; the original blob
    # never survives in the projected output.
    import base64
    blob = base64.b64encode(
        b"Alice B. Thornton alice.thornton@example.com").decode()
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"submission": {
            "user_id": 777001,
            "body": "see attached: %s" % blob}}))
    assert result.get("isError") is not True, text(result)[:200]
    assert blob not in text(result), "original blob survived"
    assert "Alice B. Thornton" not in text(result)
    assert "alice.thornton@example.com" not in text(result)
    assert "Student A1" in text(result)


def test_w3_b64_blob_without_identity_untouched():
    # W3-P0-10: a blob whose decoded text carries no roster identity
    # comes back byte-identical.
    import base64
    blob = base64.b64encode(
        b"The quick brown fox jumps over the lazy dog. Again!").decode()
    assert len(blob) >= 40
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"submission": {
            "user_id": 777001, "body": "note: %s" % blob}}))
    assert result.get("isError") is not True, text(result)[:200]
    assert blob in text(result), "identity-free blob was altered"


def test_w3_b64_non_decodable_untouched():
    # W3-P0-10: base64-alphabet runs that do not strict-decode (bad
    # length) or are not UTF-8 text stay byte-identical.
    import base64
    bad_length = "A" * 41
    not_text = base64.b64encode(bytes(range(256))).decode()
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"submission": {
            "user_id": 777001,
            "body": "tag %s bin %s end" % (bad_length, not_text)}}))
    assert result.get("isError") is not True, text(result)[:200]
    assert bad_length in text(result), "non-decodable run was altered"
    assert not_text in text(result), "non-UTF8 blob was altered"


def test_w3_cross_op_vault_seeding():
    # W3-P0-11 (lane 2 L2-T2): op 1 registers Alice in the file-backed
    # vault; op 2's receipt carries only Bob, but its free text names
    # Alice. She must project to her stable op-1 label, not leak.
    directory = os.path.join(SCRATCH, "w3-vault-seed")
    shutil.rmtree(directory, ignore_errors=True)
    os.makedirs(directory)
    try:
        path = os.path.join(directory, "vault.json")
        bob_roster = source_privacy_roster([{
            "id": 777002, "name": "Bob K. Rivera",
            "email": "bob@example.edu"}])
        first = alice_setup(learner_vault_path=path).invoke(
            "canvas_read", ALICE_REQUEST, None,
            lambda args: envelope([{"user_id": 777001,
                                    "name": "Alice B. Thornton"}]))
        label = token_of(first)
        assert label == "Student A1", label
        op2 = SourceMcpPrivacyBoundary({
            "source": "test", "bindings": lambda: [ALICE_BINDING],
            "load_roster": lambda binding: bob_roster,
            "learner_vault_path": path})
        second = op2.invoke(
            "canvas_read", ALICE_REQUEST, None,
            lambda args: envelope({
                "users": [{"id": 777002, "name": "Bob K. Rivera",
                           "email": "bob@example.edu"}],
                "announcement": "Alice B. Thornton praised this module "
                                "in her review"}))
        assert second.get("isError") is not True, text(second)[:200]
        assert "Alice B. Thornton" not in text(second), \
            "vault-known learner leaked from later-page free text"
        assert label in text(second), text(second)[:300]
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def test_w3_unresolvable_author_projects():
    # W3-P0-12 (lane 2 L2-T7): the standard Canvas submission-comment
    # shape with an author the roster cannot resolve. The read must
    # succeed: the author's display name becomes the generic "Staff"
    # label, roster names in the body still project to labels, and
    # nothing leaks.
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"submission_comments": [{
            "author": {"id": 9, "display_name": "Prof X"},
            "comment": "Alice B. Thornton needs to redo question 3"}]}))
    assert result.get("isError") is not True, text(result)[:300]
    value = result["structuredContent"]["value"]
    comment = value["submission_comments"][0]
    assert comment["author"]["display_name"] == "Staff", comment["author"]
    assert "Prof X" not in text(result)
    assert "Alice B. Thornton" not in text(result)
    assert "Student A1" in comment["comment"], comment["comment"]


def test_w3_unrostered_lti_spec_fields_redacted():
    # W3-P1-8 (lane 2 L2-6): LTI identity fields are identity BY SPEC.
    # An unrostered person's name must not pass through as opaque text.
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"launch": {
            "lis_person_name_full": "Zed Q. Unknown",
            "lis_person_name_given": "Zed",
            "lis_person_name_family": "Unknown"}}))
    assert result.get("isError") is not True, text(result)[:200]
    assert "Zed Q. Unknown" not in text(result)
    assert "[redacted]" in text(result)
    # The rostered-name control still projects to the stable label.
    control = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"launch": {
            "lis_person_name_full": "Alice B. Thornton"}}))
    assert control.get("isError") is not True, text(control)[:200]
    assert "Alice B. Thornton" not in text(control)
    assert "Student A1" in text(control)


# Wave-3 D2 follow-ups (2026-09-21): base64 threshold, bare-surname
# context awareness, id-less submission shapes. All fixtures synthetic.
# ----------------------------------------------------------------------

TEACHER_BINDING = {
    "sourceBindingId": "binding-44",
    "provider": "canvas",
    "courseId": "44",
    "origin": "https://canvas.example.edu",
    "runtimeVerified": True,
    "principalFingerprint": "d" * 64,
    "sessionGeneration": 1,
    "catalogDigest": "e" * 64,
}
# The rostered surname "Teacher" is also a Canvas role label: the
# adversarial case for bare-surname over-redaction.
TEACHER_LEARNERS = source_privacy_roster([{
    "id": 888002,
    "name": "Sam Teacher",
    "email": "sam.teacher@example.com",
    "login_id": "steacher",
}])
TEACHER_REQUEST = {"course_id": 44,
                   "_morrow": {"source_binding_id": "binding-44"}}


def teacher_setup(**options):
    args = {"source": "test", "bindings": lambda: [TEACHER_BINDING],
            "load_roster": lambda binding: TEACHER_LEARNERS}
    args.update(options)
    return SourceMcpPrivacyBoundary(args)


def test_w3d2_b64_threshold_catches_short_identity_blob():
    # Defect 1: the scan starts at 20 encoded chars. A 24-char blob
    # ("Alice B. Thornton" alone) passed through unredacted at the old
    # 40-char threshold; it is now masked inside and re-encoded.
    import base64
    blob = base64.b64encode(b"Alice B. Thornton").decode()
    assert 20 <= len(blob) < 40, len(blob)
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"submission": {
            "user_id": 777001, "body": "see attached: %s" % blob}}))
    assert result.get("isError") is not True, text(result)[:200]
    assert blob not in text(result), "short identity blob survived"
    assert "Alice B. Thornton" not in text(result)
    assert "Student A1" in text(result)
    # An email-only blob (also 24 chars) is masked too.
    email_blob = base64.b64encode(b"alice.thornton@example.com").decode()
    assert 20 <= len(email_blob) < 40, len(email_blob)
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"submission": {
            "user_id": 777001, "body": "contact %s" % email_blob}}))
    assert result.get("isError") is not True, text(result)[:200]
    assert email_blob not in text(result)
    assert "alice.thornton@example.com" not in text(result)


def test_w3d2_b64_sub_threshold_residual_pinned():
    # Defect 1 residual (documented in privacy/core.py): blobs under 20
    # encoded chars are not scanned. A lone short given name ("Amy" is
    # 8 chars) encoded by itself still passes through. This test pins
    # the documented boundary so a future threshold change updates it
    # deliberately.
    import base64
    blob = base64.b64encode(b"Alice").decode()
    assert len(blob) < 20, len(blob)
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"submission": {
            "user_id": 777001, "body": "tag %s end" % blob}}))
    assert result.get("isError") is not True, text(result)[:200]
    assert blob in text(result), "sub-threshold blob was altered"


def test_w3d2_surname_teacher_role_values_untouched():
    # Defect 2: rostered surname "Teacher" must not rewrite role labels.
    # Structured role fields pass through byte-identical, in both
    # singular and plural key shapes and any letter case.
    for payload in ({"role": "teacher"}, {"roles": "teacher"},
                    {"roles": "Teacher"}, {"role": "TEACHER"},
                    {"enrollment": {"type": "TeacherEnrollment",
                                    "role": "teacher"}}):
        result = teacher_setup().invoke(
            "canvas_read", TEACHER_REQUEST, None,
            lambda args: envelope(payload))
        assert result.get("isError") is not True, text(result)[:200]
        value = result["structuredContent"]["value"]
        assert value == payload, \
            "role-shaped value was rewritten: %r -> %r" % (payload, value)


def test_w3d2_surname_teacher_prose_context_aware():
    # Defect 2: a lowercase "teacher" in free text is an ordinary word,
    # not a surname mention, and survives. A capitalized surname mention
    # still redacts to the stable label.
    result = teacher_setup().invoke(
        "canvas_read", TEACHER_REQUEST, None,
        lambda args: envelope(
            {"body": "The teacher posted an announcement."}))
    assert result.get("isError") is not True, text(result)[:200]
    assert "The teacher posted an announcement." in text(result), \
        text(result)[:200]
    result = teacher_setup().invoke(
        "canvas_read", TEACHER_REQUEST, None,
        lambda args: envelope({"body": "Teacher said the quiz was easy."}))
    assert result.get("isError") is not True, text(result)[:200]
    assert "Teacher said" not in text(result), text(result)[:200]
    assert "Student A1 said the quiz was easy." in text(result), \
        text(result)[:200]


def test_w3d2_idless_submission_projects():
    # Defect 3: an id-less submission record carrying no identity fields
    # is not a person record; the read must project instead of refusing
    # with privacy_identity_record_unresolved.
    result = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"submissions": [
            {"submitted_at": "2026-09-21T10:00:00Z",
             "score": 85, "grade": "B"}]}))
    assert result.get("isError") is not True, text(result)[:200]
    value = result["structuredContent"]["value"]
    assert value["submissions"][0]["score"] == 85, text(result)[:200]
    assert value["submissions"][0]["grade"] == "B", text(result)[:200]
    # Fail-closed is preserved: a user record naming a roster person but
    # carrying no id still refuses.
    refused = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"users": [{"name": "Alice B. Thornton"}]}))
    assert refused.get("isError") is True, text(refused)[:200]
    # A submission that DOES name a roster learner still tokenizes.
    tokenized = alice_setup().invoke(
        "canvas_read", ALICE_REQUEST, None,
        lambda args: envelope({"submissions": [
            {"user_id": 777001, "score": 85}]}))
    assert tokenized.get("isError") is not True, text(tokenized)[:200]
    assert "777001" not in text(tokenized)
    assert "Student A1" in text(tokenized)


def _wipe_vault_files(path):
    for sfx in ("", ".key", ".lock"):
        try:
            os.unlink(path + sfx)
        except FileNotFoundError:
            pass


def _synthetic_scope(origin, course):
    return {"canvasOrigin": origin, "account": "acct-%s" % origin,
            "course": str(course), "principal": "test-principal",
            "profile": "source:test"}


def _synthetic_identity(uid, name):
    return {"id": str(uid), "name": name,
            "email": "%s@example.test" % name.lower().replace(" ", ".")}


def test_shipped_vault_purge_tenant():
    """W4-P2-10: the shipped vault supports per-tenant purge. Tenant A's
    records go (atomic rewrite, labels stop resolving); tenant B is
    untouched; the vault file stays valid across a reopen."""
    from privacy.core import LearnerVault, PrivacyError
    path = os.path.join(SCRATCH, "purge-tenant-vault.json")
    _wipe_vault_files(path)
    vault = LearnerVault(path)
    scope_a = _synthetic_scope("https://a.example.edu", "101")
    scope_b = _synthetic_scope("https://b.example.edu", "202")
    id_a = _synthetic_identity("9001001", "Zeldana Fakeington")
    id_b = _synthetic_identity("9001002", "Yolanda Fakename")
    labels_a = vault.prepare_text_references(scope_a, [id_a])["labels"]
    labels_b = vault.prepare_text_references(scope_b, [id_b])["labels"]
    # Labels are scope-exact: both tenants legitimately mint "Student A1".
    assert labels_a and labels_b
    assert vault.purge_tenant("https://a.example.edu") == 1
    assert vault.identities_for_scope(scope_a) == []
    assert len(vault.identities_for_scope(scope_b)) == 1
    try:
        vault.resolve(scope_a, labels_a[0])
    except PrivacyError:
        pass
    else:
        raise AssertionError("purged tenant label still resolves")
    # Reopen: the rewritten file is valid and B survives it.
    vault2 = LearnerVault(path)
    assert vault2.identities_for_scope(scope_a) == []
    assert len(vault2.identities_for_scope(scope_b)) == 1
    assert vault2.resolve(scope_b, labels_b[0])["id"] == "9001002"
    assert vault2.purge_tenant("https://a.example.edu") == 0
    # Case-insensitive host / default-port normalization still matches.
    assert vault2.purge_tenant("https://B.EXAMPLE.EDU:443") == 1
    assert vault2.identities_for_scope(scope_b) == []


def test_shipped_vault_purge_course():
    """W4-P2-10: per-course purge on the shipped vault."""
    from privacy.core import LearnerVault
    path = os.path.join(SCRATCH, "purge-course-vault.json")
    _wipe_vault_files(path)
    vault = LearnerVault(path)
    origin = "https://a.example.edu"
    scope101 = _synthetic_scope(origin, "101")
    scope102 = _synthetic_scope(origin, "102")
    vault.prepare_text_references(
        scope101, [_synthetic_identity("9001001", "Zeldana Fakeington")])
    vault.prepare_text_references(
        scope102, [_synthetic_identity("9001002", "Yolanda Fakename")])
    assert vault.purge_course(origin, "101") == 1
    assert vault.identities_for_scope(scope101) == []
    assert len(vault.identities_for_scope(scope102)) == 1
    vault2 = LearnerVault(path)
    assert len(vault2.identities_for_scope(scope102)) == 1


def test_executor_wire_purge_tenant():
    """W4-P2-10 + W4-P0-4/W4-P0-5: the shipped lane's purge_tenant drops
    the tenant's vault records AND purges all browser transient state
    (pending envelope with raw learner payload, orphan brief)."""
    from privacy import executor_wire as _ew
    from privacy.core import LearnerVault
    from transport import browser_backend as _bb
    svault = os.path.join(SCRATCH, "wire-purge-vault.json")
    _wipe_vault_files(svault)
    pend = os.path.join(SCRATCH, "wire-pending")
    brief = os.path.join(SCRATCH, "wire-briefs")
    for d in (pend, brief):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
    raw = {"submissions": [{"user": {
        "id": "9001001", "name": "Zeldana Fakeington",
        "email": "zeldana.fakeington@example.test"}, "score": 91.5}]}
    # W5-P1-2: in-flight envelopes (younger than the TTL) are never
    # silently destroyed, so the planted envelope is aged past the TTL.
    # W6-P2-4: purge dates envelopes by internal created_at, not mtime.
    import time as _t
    from datetime import datetime, timezone
    _old = _t.time() - 8 * 86400
    _old_iso = datetime.fromtimestamp(_old, tz=timezone.utc).isoformat()
    raw["op_id"] = "op-0001"
    raw["created_at"] = _old_iso
    with open(os.path.join(pend, "op-0001.json"), "w",
              encoding="utf-8") as fh:
        json.dump(raw, fh)
    os.utime(os.path.join(pend, "op-0001.json"), (_old, _old))
    with open(os.path.join(brief, "orphan-op-request.txt"), "w",
              encoding="utf-8") as fh:
        fh.write("brief: post comment to submission of Zeldana Fakeington")
    old_sv = os.environ.get(_ew.SOURCE_VAULT_ENV_VAR)
    os.environ[_ew.SOURCE_VAULT_ENV_VAR] = svault
    old_pend, old_brief = _bb.PENDING_DIR, _bb.BRIEF_DIR
    _bb.PENDING_DIR, _bb.BRIEF_DIR = pend, brief
    try:
        vault = LearnerVault(svault)
        scope = _synthetic_scope("https://a.example.edu", "101")
        vault.prepare_text_references(
            scope, [_synthetic_identity("9001001", "Zeldana Fakeington")])
        report = _ew.purge_tenant("https://a.example.edu")
    finally:
        _bb.PENDING_DIR, _bb.BRIEF_DIR = old_pend, old_brief
        if old_sv is None:
            os.environ.pop(_ew.SOURCE_VAULT_ENV_VAR, None)
        else:
            os.environ[_ew.SOURCE_VAULT_ENV_VAR] = old_sv
    assert report["tenant"] == "https://a.example.edu", report
    assert report["vault_records_purged"] == 1, report
    assert report["pending_envelopes_removed"] == 1, report
    assert report["briefs_removed"] == 1, report
    assert os.listdir(pend) == [] and os.listdir(brief) == []
    assert LearnerVault(svault).identities_for_scope(scope) == []


def test_executor_wire_purge_all():
    """W4-P0-6: purge_all deletes the vault + key, transient state, and
    the profile's learner stores while keeping session cookies."""
    from privacy import executor_wire as _ew
    from privacy.core import LearnerVault
    from transport import browser_backend as _bb
    svault = os.path.join(SCRATCH, "wire-purgeall-vault.json")
    _wipe_vault_files(svault)
    prof = os.path.join(SCRATCH, "wire-profile")
    shutil.rmtree(prof, ignore_errors=True)
    hist = os.path.join(prof, "Default", "History")
    os.makedirs(os.path.dirname(hist), exist_ok=True)
    with open(hist, "w", encoding="utf-8") as fh:
        fh.write("Zeldana Fakeington - People - Fake Course")
    cookies = os.path.join(prof, "Default", "Cookies")
    with open(cookies, "w", encoding="utf-8") as fh:
        fh.write("canvas_session=abc123")
    old_sv = os.environ.get(_ew.SOURCE_VAULT_ENV_VAR)
    os.environ[_ew.SOURCE_VAULT_ENV_VAR] = svault
    old_prof = os.environ.get("LOGIN_HELPER_PROFILE_DIR")
    os.environ["LOGIN_HELPER_PROFILE_DIR"] = prof
    pend = os.path.join(SCRATCH, "wire-purgeall-pending")
    brief = os.path.join(SCRATCH, "wire-purgeall-briefs")
    for d in (pend, brief):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
    old_pend, old_brief = _bb.PENDING_DIR, _bb.BRIEF_DIR
    _bb.PENDING_DIR, _bb.BRIEF_DIR = pend, brief
    try:
        vault = LearnerVault(svault)
        vault.prepare_text_references(
            _synthetic_scope("https://a.example.edu", "101"),
            [_synthetic_identity("9001001", "Zeldana Fakeington")])
        report = _ew.purge_all()
    finally:
        _bb.PENDING_DIR, _bb.BRIEF_DIR = old_pend, old_brief
        if old_sv is None:
            os.environ.pop(_ew.SOURCE_VAULT_ENV_VAR, None)
        else:
            os.environ[_ew.SOURCE_VAULT_ENV_VAR] = old_sv
        if old_prof is None:
            os.environ.pop("LOGIN_HELPER_PROFILE_DIR", None)
        else:
            os.environ["LOGIN_HELPER_PROFILE_DIR"] = old_prof
    assert report["vault_removed"] is True, report
    assert report["vault_key_removed"] is True, report
    assert not os.path.exists(svault) and not os.path.exists(svault + ".key")
    assert not os.path.exists(hist), "learner History survived purge_all"
    assert os.path.exists(cookies), "session cookies must survive"
    assert report["profile"]["mode"] == "selective", report


def test_executor_wire_cli_purge_course():
    """W4-P2-10: the shipped-lane purge CLI exposes --tenant / --course-id
    filters. purge-course drops only that course's vault records on that
    tenant AND purges all browser transient state (W4-P0-4/W4-P0-5: the
    pending envelope holding a raw learner payload and the orphan brief
    go on every purge path, unscopable)."""
    import io
    from contextlib import redirect_stdout
    from privacy import executor_wire as _ew
    from privacy.core import LearnerVault
    from transport import browser_backend as _bb
    svault = os.path.join(SCRATCH, "wire-cli-course-vault.json")
    _wipe_vault_files(svault)
    pend = os.path.join(SCRATCH, "wire-cli-pending")
    brief = os.path.join(SCRATCH, "wire-cli-briefs")
    for d in (pend, brief):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
    raw = {"submissions": [{"user": {
        "id": "9001001", "name": "Zeldana Fakeington",
        "email": "zeldana.fakeington@example.test"}, "score": 91.5}]}
    # W5-P1-2: in-flight envelopes (younger than the TTL) are never
    # silently destroyed, so the planted envelope is aged past the TTL.
    # W6-P2-4: purge dates envelopes by internal created_at, not mtime.
    import time as _t
    from datetime import datetime, timezone
    _old = _t.time() - 8 * 86400
    _old_iso = datetime.fromtimestamp(_old, tz=timezone.utc).isoformat()
    raw["op_id"] = "op-0001"
    raw["created_at"] = _old_iso
    with open(os.path.join(pend, "op-0001.json"), "w",
              encoding="utf-8") as fh:
        json.dump(raw, fh)
    os.utime(os.path.join(pend, "op-0001.json"), (_old, _old))
    with open(os.path.join(brief, "orphan-op-request.txt"), "w",
              encoding="utf-8") as fh:
        fh.write("brief: post comment to submission of Zeldana Fakeington")
    old_sv = os.environ.get(_ew.SOURCE_VAULT_ENV_VAR)
    os.environ[_ew.SOURCE_VAULT_ENV_VAR] = svault
    old_pend, old_brief = _bb.PENDING_DIR, _bb.BRIEF_DIR
    _bb.PENDING_DIR, _bb.BRIEF_DIR = pend, brief
    try:
        vault = LearnerVault(svault)
        scope101 = _synthetic_scope("https://a.example.edu", "101")
        scope102 = _synthetic_scope("https://a.example.edu", "102")
        vault.prepare_text_references(
            scope101, [_synthetic_identity("9001001", "Zeldana Fakeington")])
        vault.prepare_text_references(
            scope102, [_synthetic_identity("9001002", "Keziah Realborn")])
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = _ew._cli(["purge-course", "--tenant",
                           "https://a.example.edu", "--course-id", "101"])
    finally:
        _bb.PENDING_DIR, _bb.BRIEF_DIR = old_pend, old_brief
        if old_sv is None:
            os.environ.pop(_ew.SOURCE_VAULT_ENV_VAR, None)
        else:
            os.environ[_ew.SOURCE_VAULT_ENV_VAR] = old_sv
    assert rc == 0, "CLI exited %d" % rc
    report = json.loads(buf.getvalue())
    assert report["command"] == "purge-course", report
    assert report["tenant"] == "https://a.example.edu", report
    assert report["course_id"] == "101", report
    assert report["vault_records_purged"] == 1, report
    assert report["pending_envelopes_removed"] == 1, report
    assert report["briefs_removed"] == 1, report
    assert os.listdir(pend) == [] and os.listdir(brief) == []
    reopened = LearnerVault(svault)
    assert reopened.identities_for_scope(scope101) == []
    assert len(reopened.identities_for_scope(scope102)) == 1, \
        "other course's records must survive a per-course purge"


# ----------------------------------------------------------------------
# W4-P2-20: cryptography floor. The pin in requirements-optional.txt
# is documentation-only once installation is done, so privacy/core.py
# re-enforces the floor at vault time. These tests inject fake
# `cryptography` modules with chosen __version__ values and re-import
# privacy.core against them (sys.modules is saved and restored, so
# the real installed package is untouched for the other tests).
# ----------------------------------------------------------------------
def _fresh_core_with_fake_crypto(fake_version):
    """Import a fresh privacy.core bound to a fake cryptography module.

    Returns (core_module, restore). The fake exposes only what the
    import needs (hazmat...aead.AESGCM); the version check runs before
    any real crypto is touched.
    """
    import types
    saved = {k: v for k, v in sys.modules.items()
             if k == "privacy.core" or k.startswith("cryptography")}
    for k in list(saved):
        del sys.modules[k]
    fake = types.ModuleType("cryptography")
    fake.__version__ = fake_version
    chain = ["cryptography.hazmat", "cryptography.hazmat.primitives",
             "cryptography.hazmat.primitives.ciphers",
             "cryptography.hazmat.primitives.ciphers.aead"]
    prev = fake
    for name in chain:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
        short = name.rsplit(".", 1)[-1]
        setattr(prev, short, mod)
        prev = mod
    prev.AESGCM = type("AESGCM", (), {})
    sys.modules["cryptography"] = fake
    import importlib
    import privacy as _pkg
    _orig_attr = _pkg.core
    core = importlib.import_module("privacy.core")

    def restore():
        for k in [m for m in sys.modules
                  if m == "privacy.core" or m.startswith("cryptography")]:
            del sys.modules[k]
        sys.modules.update(saved)
        # Re-importing privacy.core as a submodule rebinds the
        # `core` attribute on the parent `privacy` package to the
        # fake; `import privacy.core as x` / `from privacy.core
        # import y` resolve through that attribute, not sys.modules.
        _pkg.core = _orig_attr
    return core, restore


def test_crypto_floor_rejects_48_0_1():
    core, restore = _fresh_core_with_fake_crypto("48.0.1")
    try:
        try:
            core._require_aesgcm()
        except core.PrivacyError as exc:
            msg = str(exc)
            assert "48.0.1" in msg, msg
            assert "50.0.1" in msg, msg
            assert "CVE-2026-69247" in msg, msg
        else:
            raise AssertionError("48.0.1 did not raise PrivacyError")
    finally:
        restore()


def test_crypto_floor_rejects_single_digit_major():
    # Guards the string-comparison trap: "9.0.0" > "50.0.1"
    # lexicographically, but the numeric floor must still refuse it.
    core, restore = _fresh_core_with_fake_crypto("9.0.0")
    try:
        try:
            core._require_aesgcm()
        except core.PrivacyError:
            pass
        else:
            raise AssertionError("9.0.0 did not raise PrivacyError")
    finally:
        restore()


def test_crypto_floor_accepts_pinned_release():
    core, restore = _fresh_core_with_fake_crypto("50.0.1")
    try:
        assert core._require_aesgcm() is not None
    finally:
        restore()


def test_version_tuple_orders_numerically():
    from privacy.core import _version_tuple
    assert _version_tuple("50.0.1") == (50, 0, 1)
    assert _version_tuple("9.0.0") < _version_tuple("50.0.1")
    assert _version_tuple("48.0.1") < _version_tuple("50.0.1")
    # A post-release sorts at-or-above the bare release (never below
    # the floor); exact trailing-component shape is not promised.
    assert _version_tuple("50.0.1.post1") >= _version_tuple("50.0.1")


def main():
    tests = [value for key, value in sorted(globals().items())
             if key.startswith("test_") and callable(value)]
    skipped = []
    if not HAVE_CRYPTO:
        print("WARNING: 'cryptography' is not installed; skipping %d "
              "file-backed vault test(s) (pip install -r "
              "requirements-optional.txt to run them)" % len(VAULT_FILE_TESTS))
        skipped = [t for t in tests if t.__name__ in VAULT_FILE_TESTS]
        tests = [t for t in tests if t.__name__ not in VAULT_FILE_TESTS]
    failed = 0
    for test in tests:
        try:
            test()
        except Exception as exc:
            failed += 1
            print("FAIL %s: %s: %s" % (test.__name__, type(exc).__name__, exc))
        else:
            print("ok %s" % test.__name__)
    for test in skipped:
        print("SKIP %s: needs the 'cryptography' package" % test.__name__)
    print("%d/%d PASS%s" % (len(tests) - failed, len(tests),
                            " (%d skipped: no cryptography)" % len(skipped)
                            if skipped else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()


# ----------------------------------------------------------------------
