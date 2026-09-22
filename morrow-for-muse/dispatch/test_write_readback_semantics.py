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
