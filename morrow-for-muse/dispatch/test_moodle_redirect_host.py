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
# Lives outside moodle/: pytest would put moodle/ (no __init__.py) on
# sys.path, where moodle/reauth.py shadows the reauth package.
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


@pytest.mark.parametrize("from_url,location", [
    ("https://moodle.school.edu/my/?sesskey=SOURCE-CANARY",
     "https://evil.example/collect?code=TARGET-CANARY#FRAGMENT-CANARY"),
    ("https://moodle.school.edu/my/?sesskey=SOURCE-CANARY",
     "http://moodle.school.edu/my/?code=TARGET-CANARY#FRAGMENT-CANARY"),
    ("https://moodle.school.edu/my/?sesskey=SOURCE-CANARY",
     "https://user:PASSWORD-CANARY@evil.example/collect"),
])
def test_refused_redirect_never_discloses_url_auth_material(from_url, location):
    # Failure case: a refused SSO or downgrade URL enters a probe's error
    # result verbatim, including its source sesskey and destination code.
    sess = ms.SafeRedirectSession()
    with pytest.raises(ms.MoodleLaneError) as caught:
        sess.get_redirect_target(_redirect(from_url, location))
    message = str(caught.value)
    assert "CANARY" not in message
    assert "moodle.school.edu" in message
