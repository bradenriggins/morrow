#!/usr/bin/env python3
"""Sweep-4 dispatch-lane regressions: URL exception boundaries, high-water fail-closed.

Finding 12: the learner-data URL exception ("/users/self") was a raw
substring match over the whole URL template (query included) that
skipped every URL signal check, so "/users/selfish" or a query value
smuggling "/users/self" exempted a learner-bearing URL. The exception
now matches the path at segment boundaries only.

Finding 11: a high-water persist failure only warned while admission
continued, degrading clock-rollback replay defense to fail-open. The
gate now refuses admission when the mark cannot be recorded.
"""

import datetime
import os
import sys

import pytest

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE not in sys.path:
    sys.path.insert(0, _TREE)

from dispatch import admission  # noqa: E402


def _entry(path):
    return {"name": "probe", "request": {"method": "GET", "url": path}}


def test_users_self_stays_exempt():
    assert not admission.touches_learner_data(
        _entry("{canvas_base}/api/v1/users/self"))
    assert not admission.touches_learner_data(
        _entry("{canvas_base}/api/v1/users/self/favorites/courses/1"))


def test_partial_segment_does_not_exempt():
    assert admission.touches_learner_data(
        _entry("{canvas_base}/api/v1/users/selfish"))
    assert admission.touches_learner_data(
        _entry("{canvas_base}/api/v1/users/self-service"))


def test_query_or_fragment_cannot_smuggle_the_exception():
    assert admission.touches_learner_data(
        _entry("{canvas_base}/api/v1/courses/1/users?next=/users/self"))
    assert admission.touches_learner_data(
        _entry("{canvas_base}/api/v1/courses/1/users#x/users/self"))


def test_exception_matcher_boundaries():
    hit = admission._url_exception_hit
    assert hit("https://t/api/v1/users/self", ["/users/self"])
    assert hit("https://t/api/v1/users/self/", ["/users/self"])
    assert hit("https://t/api/v1/users/self/tokens", ["/users/self"])
    assert hit("{canvas_base}/api/v1/users/self", ["/users/self"])
    assert not hit("https://t/api/v1/users/selfish", ["/users/self"])
    assert not hit("https://t/api/v1/courses/1/users?x=/users/self",
                   ["/users/self"])
    assert not hit("https://t/api/v1/courses/1/users", ["/users/self"])
    assert not hit("https://t/api/v1/users/self", [])
    assert not hit("https://t/api/v1/users/self", [""])


def test_highwater_persist_failure_refuses_admission(monkeypatch):
    real_replace = os.replace

    def boom(src, dst):
        if str(dst).endswith("time.highwater"):
            raise OSError("disk full (test)")
        return real_replace(src, dst)

    monkeypatch.setattr(admission.os, "replace", boom)
    now = datetime.datetime.now(datetime.timezone.utc)
    with pytest.raises(admission.ApprovalMismatch, match="high-water mark"):
        admission._check_clock_rollback(now)


def test_highwater_still_advances_normally():
    now = datetime.datetime.now(datetime.timezone.utc)
    admission._check_clock_rollback(now)
    assert admission._read_time_highwater() is not None
    # Within tolerance behind the mark still passes (no write needed).
    admission._check_clock_rollback(now - datetime.timedelta(seconds=30))
