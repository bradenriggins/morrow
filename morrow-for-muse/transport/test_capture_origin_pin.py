#!/usr/bin/env python3
"""capture_network_response pins its match to the expected origin.

Failure mode pinned down (written before the fix): responses were
matched by a bare substring (url_fragment in rurl) with no origin pin,
contradicting the CHANGELOG W3-P2-17 promised expected_origin pin. A
response from any other origin carrying the fragment (an ad, an IdP,
an attacker page racing the navigation) would be returned as the
tenant's. The optional expected_origin pin skips those; unpinned
calls keep the old first-match behavior.
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import local_chromium as lc  # noqa: E402

TENANT = "https://tenant.instructure.com"
EVIL = "https://tenant.instructure.com.evil.example"


def _response_received(rid, url):
    return {"method": "Network.responseReceived",
            "params": {"requestId": rid,
                       "response": {"url": url}}}


def _loading_finished(rid):
    return {"method": "Network.loadingFinished",
            "params": {"requestId": rid}}


class _FakeCDP:
    """A CDP scripted with network events, no browser."""

    def __init__(self, events):
        self._events = list(events)
        self.cdp = lc.CDP.__new__(lc.CDP)

    def tab_session(self, tab):
        return "sess"

    def navigate(self, tab, url, timeout=60):
        return None

    def call(self, tab, method, params=None, timeout=30):
        if method == "Network.getResponseBody":
            return {"body": "BODY-FOR-%s" % (params or {}).get(
                "requestId")}
        return {}

    def poll_session_events(self, session, timeout=5):
        if self._events:
            return [self._events.pop(0)]
        return []


def _capture(events, expected_origin, timeout=5):
    fake = _FakeCDP(events)
    bound = lc.CDP.capture_network_response.__get__(fake, _FakeCDP)
    return bound({"id": "tab"}, TENANT + "/api/v1/users/self",
                 "/api/v1/users/self", timeout=timeout,
                 expected_origin=expected_origin)


def test_off_origin_match_is_skipped_when_pinned():
    events = [_response_received("evil", EVIL + "/api/v1/users/self"),
              _loading_finished("evil"),
              _response_received("good", TENANT + "/api/v1/users/self"),
              _loading_finished("good")]
    rurl, text = _capture(events, TENANT)
    assert rurl == TENANT + "/api/v1/users/self"
    assert text == "BODY-FOR-good"


def test_unpinned_call_keeps_first_match():
    events = [_response_received("evil", EVIL + "/api/v1/users/self"),
              _loading_finished("evil"),
              _response_received("good", TENANT + "/api/v1/users/self"),
              _loading_finished("good")]
    rurl, _text = _capture(events, None)
    assert rurl == EVIL + "/api/v1/users/self"


def test_only_off_origin_match_times_out_when_pinned():
    events = [_response_received("evil", EVIL + "/api/v1/users/self"),
              _loading_finished("evil")]
    with pytest.raises(TimeoutError):
        _capture(events, TENANT, timeout=1)
