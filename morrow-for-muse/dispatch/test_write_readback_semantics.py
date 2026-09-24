#!/usr/bin/env python3
"""Write readback: compare by field meaning, and keep three outcomes apart.

Failure modes this suite pins down (written before the fix; re-audit
2026-09-22, probes reaudit/cmp_probe.py + vf_probe.py):
  1. Correct writes were reported as "did not land as intended"
     (WriteFieldMismatch) because the readback compared mismatched
     types as exact strings: a due_at sent with an offset vs Canvas's
     UTC "Z", ".000Z" vs "Z", "10" vs 10.0, 1 vs True, "<p>Hi" vs
     "<p>Hi</p>".
  2. A difference that could be the LMS's own normalization (HTML
     sanitizing, whitespace, a naive or date-only time Canvas reads in
     the user's zone) must be "unverified", never a definite failure.
  3. Real differences must still be proven failures.
  5. (third-pass re-audit, probe reaudit3/verdict3.py) Proven
     differences were softened to "uncertain": a naive or date-only
     value days or months off, an <img> removed, an href changed, an
     allowed tag (<strong>) lost, a bool read back as "banana" or 2.
     Only differences an LMS normalization could cause may be
     uncertain; sub-second truncation of an aware time is a match.
  4. A failed readback GET after a 2xx write became VerificationFailed
     "journaled as failed", which the failure catalog could not
     classify. It must surface as uncertain (the write may have
     landed), journaled as uncertain, with its own catalog message.

Hermetic: a fake provider session; journal and MORROW_HOME live in
pytest's tmp_path.
"""

import json
import os
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
from dispatch.test_direct_lane_hardening import (  # noqa: E402,F401
    BASE, FakeSession, _course_then, _pack, _write_dispatch, hermetic)

MEMBER = BASE + "/api/v1/courses/7/assignments/42"


def _readback(want, got):
    body = {"assignment": dict(want, name="A")}
    readback = dict(got, id=42, name="A")
    sess = FakeSession(lambda m, u, b: (200, {}, json.dumps(readback).encode()))
    entry = {"name": "t_w", "provider": "canvas", "effects": "write",
             "auth": {"slot": "canvas_pat"}, "result": {}}
    return ex.run_write_readback(entry, sess, _pack(), {"canvas_base": BASE},
                                 {}, {}, "PUT", MEMBER, body, {"id": 42})


SAME_VALUE = [
    ({"points_possible": "10"}, {"points_possible": 10.0}),
    ({"points_possible": 10}, {"points_possible": 10.0}),
    ({"points_possible": "10.50"}, {"points_possible": 10.5}),
    ({"due_at": "2026-10-01T23:59:00-05:00"},
     {"due_at": "2026-10-02T04:59:00Z"}),
    ({"due_at": "2026-10-02T04:59:00.000Z"},
     {"due_at": "2026-10-02T04:59:00Z"}),
    ({"due_at": "2026-10-02T04:59:00+00:00"},
     {"due_at": "2026-10-02T04:59:00Z"}),
    ({"published": "true"}, {"published": True}),
    ({"published": 1}, {"published": True}),
    ({"published": "1"}, {"published": True}),
    ({"published": 0}, {"published": False}),
    ({"published": False}, {"published": "false"}),
    ({"description": ""}, {"description": None}),
    ({"lock_at": None}, {"lock_at": ""}),
    ({"description": "<p>Hi"}, {"description": "<p>Hi</p>"}),
    ({"description": "<P CLASS='a'>Hi &amp; bye</P>"},
     {"description": '<p class="a">Hi &amp; bye</p>'}),
    ({"description": "<p>Hi\n  there</p>"},
     {"description": "<p>Hi there</p>"}),
    ({"submission_types": ["1", "2"]}, {"submission_types": [2, 1]}),
    # Canvas stores whole seconds: dropped milliseconds are the same time.
    ({"due_at": "2026-10-02T04:59:00.123Z"},
     {"due_at": "2026-10-02T04:59:00Z"}),
    ({"due_at": "2026-10-01T23:59:00.999-05:00"},
     {"due_at": "2026-10-02T04:59:00Z"}),
]

MAY_BE_NORMALIZATION = [
    # Canvas sanitizes HTML: a stripped attribute or wrapper is not proof.
    ({"description": "<p onclick='x()'>Hi</p>"},
     {"description": "<p>Hi</p>"}),
    ({"description": "Hi"}, {"description": "<p>Hi</p>"}),
    ({"description": "<p>Hi</p><script>alert(1)</script>"},
     {"description": "<p>Hi</p>"}),
    # A naive or date-only time is read in the educator's Canvas zone.
    ({"due_at": "2026-10-01T23:59:00"}, {"due_at": "2026-10-02T04:59:00Z"}),
    ({"due_at": "2026-10-01"}, {"due_at": "2026-10-02T04:59:59Z"}),
    # Canvas trims surrounding whitespace.
    ({"title": "Unit 1 "}, {"title": "Unit 1"}),
    # Naive and date-only values within any possible zone offset.
    ({"due_at": "2026-10-01T23:59:00"}, {"due_at": "2026-10-02T13:00:00Z"}),
    ({"due_at": "2026-10-01"}, {"due_at": "2026-09-30T23:00:00Z"}),
    # A midnight due time may be stored as 23:59:59 (not cited in this
    # repo's evidence, so it is unconfirmed, never verified).
    ({"due_at": "2026-10-01T00:00:00-05:00"},
     {"due_at": "2026-10-02T04:59:59Z"}),
    ({"due_at": "2026-10-01T00:00:00-05:00"},
     {"due_at": "2026-10-01T04:59:59Z"}),
    # Canvas rewrites same-course file links to relative paths.
    ({"description": '<a href="https://school.instructure.com/courses/7/'
                     'files/3">f</a>'},
     {"description": '<a href="/courses/7/files/3?wrap=1" '
                     'data-api-returntype="File">f</a>'}),
    # Event-handler attributes are stripped by the sanitizer.
    ({"description": '<img src="a.png" alt="x" onerror="y()">'},
     {"description": '<img src="a.png" alt="x">'}),
]

REAL_MISMATCH = [
    ({"points_possible": "10"}, {"points_possible": 5.0}),
    ({"points_possible": "ten"}, {"points_possible": 0.0}),
    ({"due_at": "2026-10-01T23:59:00-05:00"},
     {"due_at": "2026-10-01T23:59:00Z"}),
    ({"published": True}, {"published": False}),
    ({"published": 1}, {"published": False}),
    ({"title": "Unit 1"}, {"title": "Unit 2"}),
    ({"description": "<p>Hello</p>"}, {"description": "<p>Goodbye</p>"}),
    ({"submission_types": ["a"]}, {"submission_types": ["b"]}),
    ({"points_possible": 10}, {"points_possible": None}),
    # Beyond any timezone offset: a proven difference.
    ({"due_at": "2026-10-01T23:59:00"}, {"due_at": "2026-10-05T04:59:00Z"}),
    ({"due_at": "2026-10-01"}, {"due_at": "2027-01-01T05:59:00Z"}),
    ({"due_at": "2026-10-01T23:59"}, {"due_at": "2026-12-01T23:59"}),
    ({"due_at": "2026-10-01"}, {"due_at": "2026-10-03"}),
    ({"due_at": "2026-10-01"}, {"due_at": "2026-10-03T12:00:00Z"}),
    # HTML: removed media, changed links, and a lost allowed tag.
    ({"description": '<a href="https://good.edu/x">Syllabus</a>'},
     {"description": '<a href="https://other.example/x">Syllabus</a>'}),
    ({"description": '<p>See</p><img src="a.png" alt="chart">'},
     {"description": "<p>See</p>"}),
    ({"description": '<p>See</p><img src="a.png" alt="chart">'},
     {"description": '<p>See</p><img src="b.png" alt="chart">'}),
    ({"description": "<p>Due <strong>Friday</strong></p>"},
     {"description": "<p>Due Friday</p>"}),
    # A bool read back as something that is not a bool.
    ({"published": True}, {"published": "banana"}),
    ({"published": True}, {"published": 2}),
    ({"published": False}, {"published": "maybe"}),
]


@pytest.mark.parametrize("want,got", SAME_VALUE)
def test_representation_only_difference_is_verified(want, got):
    out = _readback(want, got)
    assert out["status"] == "pass", out


@pytest.mark.parametrize("want,got", MAY_BE_NORMALIZATION)
def test_possible_lms_normalization_is_unverified_never_failed(want, got):
    out = _readback(want, got)
    assert out["status"] == "unverified", out
    assert list(want)[0] in out["detail"]


@pytest.mark.parametrize("want,got", REAL_MISMATCH)
def test_real_difference_is_still_a_proven_failure(want, got):
    with pytest.raises(ex.WriteFieldMismatch):
        _readback(want, got)


def _assignment_entry():
    return ex.catalog_descriptor_to_entry(
        "canvas_create_assignment", "POST",
        "/api/v1/courses/{course_id}/assignments",
        extra={"body": {"assignment": {"name": "A"}}})


def test_failed_readback_get_is_uncertain_not_failed():
    def handler(m, u, b):
        if m == "POST":
            return 200, {}, b'{"id": 42, "name": "A"}'
        return 503, {}, b'{"errors": ["unavailable"]}'

    with pytest.raises(ex.UncertainWrite) as info:
        _write_dispatch(_assignment_entry(), {"course_id": "7"},
                        _course_then(handler))
    exc = info.value
    assert not isinstance(exc, ex.VerificationFailed)
    assert "journaled as failed" not in str(exc)
    rec = ex.find_journal_op("11111111-1111-4111-8111-111111111111")
    assert rec is not None
    assert rec.get("uncertain") is True
    assert rec.get("verification") == "uncertain", rec.get("verification")

    from failures.funnel import agent_error_payload
    payload = agent_error_payload("catalog canvas_create_assignment", exc)
    assert payload["error"] == "UncertainWrite"
    assert payload["mode_id"] == "write-readback-unconfirmed", payload
    message = payload["message"]
    assert "could not confirm" in message
    assert "not a failure" in message
    assert "—" not in message


@pytest.mark.parametrize("want,got,verdict", [
    ("2026-10-01T23:59:00", "2026-10-05T04:59:00Z", "mismatch"),
    ("2026-10-01", "2027-01-01T05:59:00Z", "mismatch"),
    ("2026-10-01T23:59", "2026-12-01T23:59", "mismatch"),
    ("2026-10-01T23:59:00-05:00", "2026-10-02T04:58:00Z", "mismatch"),
    ("2026-10-02T04:59:00.500Z", "2026-10-02T04:59:00Z", "match"),
    ("2026-10-02T04:59:00.500Z", "2026-10-02T04:59:01Z", "mismatch"),
    ('<a href="https://good.edu/x">S</a>',
     '<a href="https://other.example/x">S</a>', "mismatch"),
    ("<p>Due <strong>Friday</strong></p>", "<p>Due Friday</p>", "mismatch"),
    ('<p>See</p><img src="a.png" alt="chart">', "<p>See</p>", "mismatch"),
    (True, "banana", "mismatch"),
    (True, 2, "mismatch"),
    (True, "yes", "match"),
])
def test_field_verdict_table(want, got, verdict):
    assert ex._write_field_verdict(want, got) == verdict


# ----------------------------------------------------------------------
# H3 (third-pass re-audit): the declared verify block.
#   - A verify GET that fails (HTTP 503) after a 2xx write fell into the
#     failure path: "journaled as failed" with a message the failure
#     catalog could not classify. It must be uncertain, like the
#     readback GET.
#   - _assert_verify_expect compared str(actual) != str(expected):
#     10 vs "10.0" failed, True vs "true" failed. It must use the same
#     field verdict as the readback, on both lanes.
# ----------------------------------------------------------------------

VERIFY_URL = BASE + "/api/v1/courses/7/assignments/42?verify=1"


def _verified_entry():
    entry = _assignment_entry()
    entry["verify"] = {"method": "GET",
                       "url": "{canvas_base}/api/v1/courses/{course_id}/"
                              "assignments/{result.id}?verify=1",
                       "expect": {"name": "result.name"}}
    return entry


def test_declared_verify_http_error_is_uncertain_not_failed():
    def handler(m, u, b):
        if m == "POST":
            return 200, {}, b'{"id": 42, "name": "A"}'
        if u == VERIFY_URL:
            return 503, {}, b'{"errors": ["unavailable"]}'
        return 200, {}, b'{"id": 42, "name": "A"}'

    with pytest.raises(ex.UncertainWrite) as info:
        _write_dispatch(_verified_entry(), {"course_id": "7"},
                        _course_then(handler))
    exc = info.value
    assert not isinstance(exc, ex.VerificationFailed)
    assert "journaled as failed" not in str(exc)
    rec = ex.find_journal_op("11111111-1111-4111-8111-111111111111")
    assert rec.get("uncertain") is True
    assert rec.get("verification") == "uncertain", rec.get("verification")
    from failures.funnel import agent_error_payload
    payload = agent_error_payload("catalog canvas_create_assignment", exc)
    assert payload["mode_id"] == "write-readback-unconfirmed", payload


@pytest.mark.parametrize("expected,actual", [
    (10, "10.0"), ("10", 10.0), (True, "true"), (1, True),
    ("2026-10-01T23:59:00-05:00", "2026-10-02T04:59:00Z"),
    ("<p>Hi", "<p>Hi</p>"),
])
def test_verify_expect_uses_the_field_verdict(expected, actual):
    verify = {"expect": {"v": "params.v"}}
    out = ex._assert_verify_expect({"name": "t"}, verify, {"v": actual},
                                   {"v": expected}, {}, {})
    assert out["status"] == "pass", out


@pytest.mark.parametrize("expected,actual", [
    ("Unit 1 ", "Unit 1"), ("2026-10-01T23:59:00", "2026-10-02T04:59:00Z"),
])
def test_verify_expect_possible_normalization_is_unverified(expected,
                                                             actual):
    verify = {"expect": {"v": "params.v"}}
    out = ex._assert_verify_expect({"name": "t"}, verify, {"v": actual},
                                   {"v": expected}, {}, {})
    assert out["status"] == "unverified", out


@pytest.mark.parametrize("expected,actual", [
    (10, 5), (True, "banana"), ("Unit 1", "Unit 2"),
    ("2026-10-01", "2027-01-01T05:59:00Z"),
])
def test_verify_expect_proven_difference_fails(expected, actual):
    verify = {"expect": {"v": "params.v"}}
    with pytest.raises(ex.VerificationFailed):
        ex._assert_verify_expect({"name": "t"}, verify, {"v": actual},
                                 {"v": expected}, {}, {})


def test_unconfirmed_declared_verify_does_not_prove_the_write():
    def handler(m, u, b):
        if m == "POST":
            return 200, {}, b'{"id": 42, "name": "A "}'
        return 200, {}, b'{"id": 42, "name": "A "}'
    entry = _verified_entry()
    entry["verify"]["expect"] = {"name": "params.want"}
    out, _ = _write_dispatch(entry, {"course_id": "7", "want": "A"},
                             _course_then(handler))
    assert out["outcome"] == "unverified", out


# ----------------------------------------------------------------------
# Integrator follow-up: the declared-verify fallback for a dead session
# (and any other unconfirmed verify) said "journaled as failed" while the
# record was uncertain=True. It must say uncertain and raise
# UncertainWrite; only a proven verify mismatch is a failed write, and
# that one is journaled uncertain=False.
# ----------------------------------------------------------------------

class ChromiumSessionDead(ex.ExecutorError):
    """Name-matched lane session-death signal (see _SESSION_DEAD_NAMES)."""


def test_verify_session_death_is_uncertain_with_the_uncertain_message(
        monkeypatch):
    # The re-auth machinery is session-wide state; record that it is
    # armed instead of arming it for every later test.
    armed = []
    monkeypatch.setattr(ex, "_on_session_death",
                        lambda op_id, name, evidence, write_sent=False:
                        armed.append((op_id, write_sent)))

    def handler(m, u, b):
        if m == "POST":
            return 200, {}, b'{"id": 42, "name": "A"}'
        if u == VERIFY_URL:
            raise ChromiumSessionDead("session died during verify")
        return 200, {}, b'{"id": 42, "name": "A"}'

    with pytest.raises(ex.UncertainWrite) as info:
        _write_dispatch(_verified_entry(), {"course_id": "7"},
                        _course_then(handler))
    message = str(info.value)
    assert "journaled as failed" not in message
    assert "journaled as uncertain" in message
    assert "could not confirm" in message
    rec = ex.find_journal_op("11111111-1111-4111-8111-111111111111")
    assert rec.get("uncertain") is True
    assert rec.get("verification") == "uncertain"
    # The write was sent before the session died: the paused change is
    # recorded as one Canvas may already hold.
    assert armed == [("11111111-1111-4111-8111-111111111111", True)]


def test_proven_verify_mismatch_is_failed_and_not_uncertain():
    def handler(m, u, b):
        if m == "POST":
            return 200, {}, b'{"id": 42, "name": "A"}'
        if u == VERIFY_URL:
            return 200, {}, b'{"id": 42, "name": "Something else"}'
        return 200, {}, b'{"id": 42, "name": "A"}'

    entry = _verified_entry()
    entry["verify"]["expect"] = {"name": "params.want"}
    with pytest.raises(ex.VerificationFailed) as info:
        _write_dispatch(entry, {"course_id": "7", "want": "A"},
                        _course_then(handler))
    assert not isinstance(info.value, ex.UncertainWrite)
    rec = ex.find_journal_op("11111111-1111-4111-8111-111111111111")
    assert rec.get("verification") == "fail"
    assert rec.get("uncertain") is False
