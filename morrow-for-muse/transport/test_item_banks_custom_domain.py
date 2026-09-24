#!/usr/bin/env python3
"""Item Banks work for a school whose Canvas runs on its own domain.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22, probe final-sweep/muse-engine/p11_custom_domain.py):
  The Item Banks lane required the quiz-lti and quiz-api hosts, and the
  Item Banks tool URL, to share the Canvas host's first label and parent
  domain. Instructure hosts New Quizzes for every tenant under
  instructure.com, so for a supported custom-domain tenant
  (canvas.harvard.edu, with New Quizzes at
  harvard.quiz-api-iad-prod.instructure.com) no host could pass: the
  Item Banks tool was refused as "outside the tenant domain family" and
  the /banks fallback never captured a credential. Every Item Bank
  operation failed on those tenants, which breaks the rule that an
  operation works on every tenant or on none.

  A New Quizzes host is accepted only when it is
  <account>.quiz-lti|quiz-api[-region].instructure.com, and <account> is
  the tenant's own: the first label of a *.instructure.com Canvas host,
  or the account a New Quizzes tool in the tenant's own external tools
  list names.

Hermetic: a fake CDP client; no browser.
"""

import os
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import item_bank_sdk as sdk  # noqa: E402

CUSTOM = "canvas.harvard.edu"
LTI = "harvard.quiz-lti-iad-prod.instructure.com"
API = "harvard.quiz-api-iad-prod.instructure.com"
NQ_TOOL = {"id": 31, "name": "Quizzes 2",
           "url": "https://%s/lti/launch" % LTI,
           "domain": LTI}
IB_TOOL = {"id": 9, "name": "Item Banks",
           "url": "https://%s/lti/launch" % LTI}


# ------------------------------------------------------- host checks --

def test_tenant_labels_come_from_the_instructure_host_and_the_tools():
    assert sdk.quiz_account_labels("school.instructure.com") == {"school"}
    assert sdk.quiz_account_labels(CUSTOM) == frozenset()
    assert sdk.quiz_account_labels(CUSTOM, [NQ_TOOL]) == {"harvard"}
    # a tool that is not a New Quizzes host names no account
    assert sdk.quiz_account_labels(
        CUSTOM, [{"id": 2, "name": "Zoom",
                  "url": "https://applications.zoom.us/lti"}]) == frozenset()


def test_custom_domain_accepts_its_own_new_quizzes_hosts():
    labels = sdk.quiz_account_labels(CUSTOM, [NQ_TOOL])
    assert sdk._is_quiz_api_host(API, CUSTOM, labels)
    assert sdk._is_quiz_lti_host(LTI, CUSTOM, labels)


@pytest.mark.parametrize("host", [
    "other.quiz-api-iad-prod.instructure.com",        # another account
    API + ".evil.example",                            # suffix trick
    "harvard.quiz-api-iad-prod.harvard.edu",          # not Instructure
    "harvard.quiz-lti-iad-prod.instructure.com",      # the lti host
    "quiz-api-iad-prod.instructure.com",              # no account
    "evil.example",
    "",
])
def test_custom_domain_refuses_every_other_host(host):
    labels = sdk.quiz_account_labels(CUSTOM, [NQ_TOOL])
    assert not sdk._is_quiz_api_host(host, CUSTOM, labels)


def test_without_a_known_account_a_custom_domain_accepts_nothing():
    assert not sdk._is_quiz_api_host(API, CUSTOM)


def test_instructure_tenant_still_binds_to_its_own_account():
    assert sdk._is_quiz_api_host("school.quiz-api-iad-prod.instructure.com",
                                 "school.instructure.com")
    assert not sdk._is_quiz_api_host(
        "other.quiz-api-iad-prod.instructure.com", "school.instructure.com")


def test_item_banks_tool_hosted_by_instructure_is_accepted():
    assert sdk.find_item_banks_tool_id([IB_TOOL], CUSTOM) == 9
    assert sdk.find_item_banks_tool_id(
        [dict(IB_TOOL, domain="quiz-lti-iad-prod.instructure.com")],
        CUSTOM) == 9


def test_foreign_item_banks_tool_is_still_refused():
    with pytest.raises(sdk.ItemBankSdkError):
        sdk.find_item_banks_tool_id(
            [{"id": 9, "name": "Item Banks",
              "url": "https://evil.example/lti/launch"}], CUSTOM)


# ------------------------------------------------------------ launch --

class _FakeCDP:
    """Serves the tool lists, the session probe, and the frame tree; the
    capture step runs the real request matcher against the tenant's
    quiz-api request."""

    def __init__(self, tools, account_tools, capture_url):
        self.tools = tools
        self.account_tools = account_tools
        self.capture_url = capture_url
        self.captured = []

    def new_tab(self, url="about:blank"):
        return {"id": "tab-1", "type": "page", "url": url}

    def close_tab(self, tab):
        return {}

    def create_isolated_world(self, tab, world_name):
        return 42

    def navigate(self, tab, url, timeout=30):
        return {}

    def capture_request_headers(self, tab, url, match, timeout=120):
        self.captured.append((url, match))
        headers = {"Authorization": "tok", "AuthType": "Signature"}
        if not match(self.capture_url, headers):
            raise TimeoutError("no matching request observed")
        return self.capture_url, headers

    def call(self, tab, method, params=None, timeout=30):
        if method == "Page.getFrameTree":
            return {"frameTree": {"frame": {"id": "F-top",
                                            "url": "https://%s/" % CUSTOM},
                                  "childFrames": []}}
        if method == "Page.createIsolatedWorld":
            return {"executionContextId": 42}
        raise AssertionError("unexpected CDP call %s" % method)

    def evaluate(self, tab, expression, await_promise=False, timeout=30,
                 context_id=None):
        if "external_tools" in expression:
            return {"ok": True, "tools": self.tools,
                    "account_tools": self.account_tools}
        if "users/self" in expression:
            return 200
        if "location.href" in expression:
            return "https://%s/" % CUSTOM
        raise AssertionError("unexpected evaluation")


def _launch(cdp):
    session = sdk.ItemBankSdk(cdp, "https://%s" % CUSTOM, "101")
    session.launch()
    return session


def test_custom_domain_launches_through_the_item_banks_tool():
    cdp = _FakeCDP([IB_TOOL], [], "https://%s/api/features" % API)
    session = _launch(cdp)
    assert "/external_tools/9" in cdp.captured[0][0]
    assert session._api_origin == "https://%s" % API
    session.close()


def test_custom_domain_banks_fallback_learns_the_account_from_new_quizzes():
    cdp = _FakeCDP([], [NQ_TOOL], "https://%s/api/features" % API)
    session = _launch(cdp)
    assert cdp.captured[0][0].endswith("/courses/101/banks")
    assert session._api_origin == "https://%s" % API
    # the matcher still refuses another account's quiz-api host
    assert not cdp.captured[0][1](
        "https://other.quiz-api-iad-prod.instructure.com/api/x",
        {"Authorization": "z"})
    session.close()


def test_custom_domain_with_no_new_quizzes_tool_fails_before_capture():
    cdp = _FakeCDP([], [], "https://%s/api/features" % API)
    session = sdk.ItemBankSdk(cdp, "https://%s" % CUSTOM, "101")
    with pytest.raises(sdk.ItemBankSdkError) as info:
        session.launch()
    assert cdp.captured == []
    assert "New Quizzes" in str(info.value)
    session.close()


def test_the_tools_program_also_reads_the_account_tools():
    program = sdk._LAUNCH_TOOLS_JS % {"course_id": '"101"'}
    assert "include_parents=true" in program
