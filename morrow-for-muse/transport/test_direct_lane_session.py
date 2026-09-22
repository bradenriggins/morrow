#!/usr/bin/env python3
"""Session expiry on the Chromium lane: a Canvas 401 "unauthenticated"
is a dead session (re-auth path), never a plain provider refusal, never
a retry loop, and never an uncertain write (the provider applied
nothing). A 401 "unauthorized" (permission) stays a provider refusal.
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
import local_chromium as lc  # noqa: E402
import chromium_session as cs  # noqa: E402

BASE = "https://school.instructure.com"
UNAUTHENTICATED = json.dumps({"status": "unauthenticated", "errors": [
    {"message": "user authorization required"}]})
UNAUTHORIZED = json.dumps({"status": "unauthorized", "errors": [
    {"message": "user not authorized to perform that action"}]})


class FakeCdp:
    def __init__(self, status, body):
        self.status, self.body = status, body
        self.evaluations = 0

    def create_isolated_world(self, tab, name):
        return 1

    def evaluate(self, tab, js, await_promise=True, timeout=60,
                 context_id=None):
        self.evaluations += 1
        return json.dumps({"status": self.status, "url": BASE + "/api/x",
                           "body": self.body, "link": None,
                           "retryAfter": None, "truncated": False,
                           "redirected": False})


def _transport(status, body):
    t = lc.LocalChromiumTransport.__new__(lc.LocalChromiumTransport)
    t.base = BASE
    t.cdp = FakeCdp(status, body)
    t._api_worlds = {}
    return t


def test_unauthenticated_401_is_session_dead():
    t = _transport(401, UNAUTHENTICATED)
    with pytest.raises(lc.SessionDead):
        t.api("GET", "/api/v1/courses/1", _tab={"id": "t"})


def test_unauthorized_401_is_a_provider_answer():
    t = _transport(401, UNAUTHORIZED)
    status, _h, _b = t.api("GET", "/api/v1/courses/1", _tab={"id": "t"})
    assert status == 401


class _Transport:
    def __init__(self, status, body):
        self.status, self.body, self.calls = status, body, 0

    def api(self, method, path, data=None, as_json=False, timeout=60,
            max_bytes=None):
        self.calls += 1
        if self.status == 401 and '"unauthenticated"' in self.body:
            raise lc.SessionRejected("401 unauthenticated")
        return self.status, {}, self.body


@pytest.fixture
def no_reauth(monkeypatch):
    monkeypatch.setattr(cs.ChromiumSession, "_notify_reauth_machine",
                        lambda self, exc: None)
    # A pinned account, so the write reaches the session (the pinned
    # account check reads users/self first; see test_principal_check).
    from reauth import state_machine as rsm
    monkeypatch.setattr(rsm, "pinned_principal",
                        lambda: {"id": 1, "name": "Edu", "base": BASE})


def _session(transport):
    sess = cs.ChromiumSession(BASE, transport=transport)
    sess._check_expiry_warning = lambda: None
    return sess


def test_expired_session_read_raises_session_dead_once(no_reauth):
    t = _Transport(401, UNAUTHENTICATED)
    sess = _session(t)
    with pytest.raises(cs.ChromiumSessionDead):
        sess.raw_request("GET", BASE + "/api/v1/courses/1", {}, None)
    assert t.calls == 1
    with pytest.raises(cs.ChromiumSessionDead):
        sess.raw_request("GET", BASE + "/api/v1/courses/1", {}, None)
    assert t.calls == 1


def test_expired_session_write_is_not_uncertain(no_reauth):
    t = _Transport(401, UNAUTHENTICATED)
    sess = _session(t)
    with pytest.raises(cs.ChromiumSessionDead) as info:
        sess.raw_request("PUT", BASE + "/api/v1/courses/1", {},
                         b'{"course": {"name": "x"}}', is_write=True)
    assert not isinstance(info.value, ex.UncertainWrite)
    assert t.calls == 1
