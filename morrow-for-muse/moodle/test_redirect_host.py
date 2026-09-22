#!/usr/bin/env python3
"""The Moodle lane follows redirects only on the Moodle host.

A 307/308 redirect re-sends the request body, so following one off the
host would re-post the login form (with the password) to another site.
"""

import os
import sys

import pytest

requests = pytest.importorskip("requests")

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from moodle import session as ms  # noqa: E402


def _redirect(from_url, location, status=307):
    resp = requests.Response()
    resp.status_code = status
    resp.headers["Location"] = location
    resp.url = from_url
    resp.request = requests.Request("POST", from_url).prepare()
    return resp


def test_off_host_redirect_refused():
    sess = ms.SafeRedirectSession()
    with pytest.raises(ms.MoodleLaneError):
        sess.get_redirect_target(_redirect(
            "https://moodle.school.edu/login/index.php",
            "https://evil.example/collect"))


def test_same_host_redirect_followed():
    sess = ms.SafeRedirectSession()
    target = sess.get_redirect_target(_redirect(
        "https://moodle.school.edu/login/index.php", "/my/"))
    assert target == "/my/"
