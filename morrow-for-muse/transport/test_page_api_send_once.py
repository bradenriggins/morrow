#!/usr/bin/env python3
"""The page-context API call sends a change at most once, and a course
page named for logging in is a course page.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  1. LocalChromiumTransport.api() ran the page-context program again
     after any CDP error that mentioned a "context" or said the target
     "navigated or closed", for POST, PUT, PATCH, and DELETE too. When
     the tab navigated while a change was in flight, Chrome answered
     "Execution context was destroyed." after the fetch had left the
     browser, and the change was sent a second time (two assignments in
     Canvas, the second reported as verified).
  2. Only a world that was gone before the program ran ("Cannot find
     context with specified id") proves nothing was sent; that case may
     retry with a fresh world. A read may always retry.
  3. A change that may have been sent reaches the executor as an
     uncertain write (journaled, never sent again), not a retry.
  4. api() read any response URL containing "/login" as a dead Canvas
     session. With redirect: 'manual' the URL is the one requested, so
     reading or changing a course page whose address starts with
     "login" (a page titled "Login Help") stopped every change and told
     the educator their Canvas connection expired. Only Canvas's own
     sign-in path (/login, /login/...) means a dead session.
  5. api() read any answer whose first 8 KB held "pseudonym_session"
     as Canvas's sign-in page, JSON included. A course page, quiz
     question, or discussion that shows the sign-in form's field names
     (a login-help page) halted every change, quarantined the session,
     and told the educator their Canvas connection expired, and the
     page could never be read. Login markers count only in an HTML
     document; an answer that is valid JSON is never a sign-in page.

Stdlib only; a fake CDP stands in for the browser.
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
import chromium_session as cs  # noqa: E402
import local_chromium as lc  # noqa: E402
# Scratch re-auth state: a dead-session verdict writes its halt there.
from transport.test_principal_check import home  # noqa: E402,F401

BASE = "https://school.instructure.com"
DESTROYED = "CDP Runtime.evaluate failed: Execution context was destroyed."
NAVIGATED = "Inspected target navigated or closed"
STALE_WORLD = "CDP Runtime.evaluate failed: Cannot find context with " \
              "specified id"


def _program_method(js):
    return json.loads(js.split("const method = ", 1)[1]
                      .split(", path = ", 1)[0])


def _program_path(js):
    return json.loads(js.split(", path = ", 1)[1].split(", data = ", 1)[0])


class FakeCDP(lc.CDP):
    """Runs the page-context program once per evaluate; `fail` scripts
    the error the first evaluate raises (after the program ran, unless
    the error says the world was already gone)."""

    def __init__(self, fail=None, error_cls=lc.CDPError, url=None,
                 body=None, content_type="application/json"):
        super().__init__(port=19223, owner="test")
        self.fail = fail
        self.error_cls = error_cls
        self.url = url
        self.body = body
        self.content_type = content_type
        self.worlds = 0
        self.programs_run = []

    def create_isolated_world(self, tab, world_name):
        self.worlds += 1
        return self.worlds

    def tabs(self):
        return [{"id": "tab-1", "type": "page", "url": BASE + "/"}]

    def evaluate(self, tab, expression, await_promise=False, timeout=30,
                 context_id=None):
        if self.fail and not self.programs_run and self.fail != STALE_WORLD:
            self.programs_run.append(_program_method(expression))
            raise self.error_cls(self.fail)
        if self.fail == STALE_WORLD and context_id == 1:
            raise self.error_cls(self.fail)
        self.programs_run.append(_program_method(expression))
        path = _program_path(expression)
        body = self.body if self.body is not None else \
            json.dumps({"id": 2, "url": "login-help"})
        return json.dumps({"status": 200, "url": self.url or path,
                           "body": body, "contentType": self.content_type,
                           "link": None, "retryAfter": None,
                           "truncated": False, "redirected": False})


class Launcher:
    def __init__(self, cdp):
        self.cdp = cdp


def _transport(cdp):
    return lc.LocalChromiumTransport(BASE, Launcher(cdp))


WRITES = ("POST", "PUT", "PATCH", "DELETE")


@pytest.mark.parametrize("method", WRITES)
@pytest.mark.parametrize("error", [DESTROYED, NAVIGATED])
@pytest.mark.parametrize("error_cls", [lc.CDPError, RuntimeError])
def test_a_change_in_flight_when_the_tab_navigates_is_not_sent_again(
        method, error, error_cls):
    # RuntimeError is how ProxyCDP.evaluate passes the helper's CDP error.
    cdp = FakeCDP(fail=error, error_cls=error_cls)
    with pytest.raises(lc.ApiCallMaybeSent) as info:
        _transport(cdp).api(method, "/api/v1/courses/1/assignments",
                            {"assignment": {"name": "Essay"}}, as_json=True)
    assert cdp.programs_run == [method]
    assert "not sent again" in str(info.value)


@pytest.mark.parametrize("method", WRITES)
def test_a_world_gone_before_the_change_ran_is_retried_once(method):
    cdp = FakeCDP(fail=STALE_WORLD)
    status, _h, _body = _transport(cdp).api(
        method, "/api/v1/courses/1/assignments",
        {"assignment": {"name": "Essay"}}, as_json=True)
    assert status == 200
    assert cdp.programs_run == [method]
    assert cdp.worlds == 2


@pytest.mark.parametrize("error", [DESTROYED, NAVIGATED, STALE_WORLD])
def test_a_read_retries_once_with_a_fresh_world(error):
    cdp = FakeCDP(fail=error)
    status, _h, _body = _transport(cdp).api("GET", "/api/v1/courses/1")
    assert status == 200
    assert cdp.worlds == 2


class PageTransport:
    """ChromiumSession's transport: the real api() over a fake CDP."""

    def __init__(self, cdp):
        self.inner = _transport(cdp)

    def api(self, method, path, data=None, as_json=False, timeout=60,
            max_bytes=None):
        if path.startswith("/api/v1/users/self"):
            return 200, {}, json.dumps({"id": 1, "name": "Teacher"})
        return self.inner.api(method, path, data, as_json=as_json,
                              timeout=timeout, max_bytes=max_bytes)


@pytest.fixture
def pinned(home, monkeypatch):
    from reauth import state_machine as rsm
    monkeypatch.setattr(rsm, "pinned_principal",
                        lambda: {"id": 1, "name": "Teacher", "base": BASE})


def _session(cdp):
    sess = cs.ChromiumSession(BASE, transport=PageTransport(cdp))
    sess._check_expiry_warning = lambda: None
    return sess


def test_the_executor_sees_an_uncertain_write_and_sends_nothing_more(
        pinned):
    cdp = FakeCDP(fail=DESTROYED)
    with pytest.raises(ex.UncertainWrite):
        _session(cdp).raw_request(
            "POST", BASE + "/api/v1/courses/1/assignments",
            {"Content-Type": "application/json"},
            b'{"assignment": {"name": "Essay"}}', is_write=True)
    assert cdp.programs_run == ["POST"]


@pytest.mark.parametrize("slug", ["login-help", "login", "login-instructions"])
def test_a_page_named_for_logging_in_is_read_and_changed(pinned, slug):
    path = "/api/v1/courses/1/pages/%s" % slug
    status, _h, body = _transport(FakeCDP()).api("GET", path)
    assert status == 200 and json.loads(body)["id"] == 2
    sess = _session(FakeCDP())
    status, _h, _raw, _n = sess.raw_request(
        "PUT", BASE + path, {"Content-Type": "application/json"},
        b'{"wiki_page": {"title": "Login Help"}}', is_write=True)
    assert status == 200
    assert sess._session_dead is False


@pytest.mark.parametrize("url", [BASE + "/login", BASE + "/login?x=1",
                                 BASE + "/login/canvas", "/login/saml"])
def test_canvas_sign_in_path_still_means_a_dead_session(url):
    with pytest.raises(lc.SessionDead):
        _transport(FakeCDP(url=url)).api("GET", "/api/v1/courses/1")


LOGIN_HELP = json.dumps({
    "id": 2, "url": "login-help", "title": "How to sign in",
    "body": "<p>The sign-in form has a box named <code>pseudonym_session"
            "[unique_id]</code> for your username and <input "
            "type=\"password\" name=\"pseudonym_session[password]\"> "
            "for your password.</p><title>Log in</title>"})


def test_a_page_that_shows_the_sign_in_form_is_read_and_changed(pinned):
    path = "/api/v1/courses/1/pages/login-help"
    status, _h, body = _transport(FakeCDP(body=LOGIN_HELP)).api("GET", path)
    assert status == 200 and json.loads(body)["title"] == "How to sign in"
    sess = _session(FakeCDP(body=LOGIN_HELP))
    status, _h, raw, _n = sess.raw_request("GET", BASE + path,
                                           {"Accept": "application/json"},
                                           None)
    assert status == 200 and b"pseudonym_session" in raw
    status, _h, _raw, _n = sess.raw_request(
        "PUT", BASE + path, {"Content-Type": "application/json"},
        b'{"wiki_page": {"title": "How to sign in"}}', is_write=True)
    assert status == 200
    assert sess._session_dead is False


def test_json_is_never_a_sign_in_page_even_when_labeled_html():
    status, _h, _b = _transport(FakeCDP(
        body=LOGIN_HELP, content_type="text/html; charset=utf-8")).api(
            "GET", "/api/v1/courses/1/pages/login-help")
    assert status == 200


SIGN_IN_FORM = ('<form action="/login/canvas"><input name="pseudonym_session'
                '[unique_id]"><input type="password" name="pseudonym_session'
                '[password]"></form>')


@pytest.mark.parametrize("body, content_type", [
    ("<!DOCTYPE html><html><body>%s</body></html>" % SIGN_IN_FORM,
     "text/html"),
    ("\ufeff  <html><body>%s</body></html>" % SIGN_IN_FORM, None),
    # A comment before the doctype: the content type says HTML.
    ("<!-- sso --><!DOCTYPE html><body>%s</body>" % SIGN_IN_FORM,
     "text/html; charset=utf-8"),
])
def test_the_sign_in_page_served_with_200_is_still_a_dead_session(
        body, content_type):
    with pytest.raises(lc.SessionDead):
        _transport(FakeCDP(body=body, content_type=content_type)).api(
            "GET", "/api/v1/courses/1")
