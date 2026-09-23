#!/usr/bin/env python3
"""Selftest for transport/item_bank_sdk.py. Mocked CDP; no browser needed."""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_HERE, os.path.dirname(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import item_bank_sdk as sdk

PASS = []
FAIL = []


def check(name, fn):
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, "%s: %s" % (type(exc).__name__, exc)))
    else:
        PASS.append(name)


def expect_raises(name, fn, exc_type):
    def _run():
        try:
            fn()
        except exc_type:
            return
        raise AssertionError("expected %s" % exc_type.__name__)
    check(name, _run)


# -- path classification ----------------------------------------------------

def _t_paths():
    assert sdk.is_sdk_item_path("/api/banks/123/items")
    assert sdk.is_sdk_item_path("/api/banks/123/items/456")
    assert sdk.is_sdk_item_path("/api/banks/123")
    assert sdk.is_sdk_item_path("/api/banks/123/bank_entries")
    assert sdk.is_sdk_item_path("/api/banks/123/shared_banks/9")
    # LANE2-D14: absolute URLs are refused outright: the lane's contract
    # is a relative path. The old code accepted these and only the JS
    # string concatenation kept the token on-origin by accident.
    assert not sdk.is_sdk_item_path(
        "https://x.quiz-api-1.instructure.com/api/banks/1/items")
    assert not sdk.is_sdk_item_path(
        "https://x.quiz-api-1.instructure.com/api/banks/../admin")
    assert not sdk.is_sdk_item_path("//x.quiz-api-1.instructure.com/api/banks/1")
    assert not sdk.is_sdk_item_path(
        "https://user:pass@x.quiz-api-1.instructure.com/api/banks/1/items")
    # Backslash is a separator for the https api_origin: these resolve
    # outside /api/banks/ in the browser (verified with node's URL
    # parser), so the gate refuses them.
    assert not sdk.is_sdk_item_path("/api/banks\\../admin")
    assert not sdk.is_sdk_item_path("/api/banks/..\\admin")
    # Backslashes that normalize to an in-namespace path stay accepted:
    # the browser resolves "/api\banks\123" to "/api/banks/123".
    assert sdk.is_sdk_item_path("/api\\banks\\123")
    # Tab/newline are stripped by the URL parser before parsing: these
    # also resolve outside /api/banks/.
    assert not sdk.is_sdk_item_path("/api/banks/\n../admin")
    assert not sdk.is_sdk_item_path("/api/banks/\t../admin")
    assert not sdk.is_sdk_item_path("/api/banks/\r\n../admin")
    # Encoded backslash is NOT a separator (the parser keeps %5C
    # encoded), so "%5c.." is an ordinary in-namespace segment, not a
    # traversal: these stay accepted.
    assert sdk.is_sdk_item_path("/api/banks/%5c../admin")
    assert sdk.is_sdk_item_path("/api/banks/%5c123")
    assert not sdk.is_sdk_item_path("/api/v1/courses/1/assignments")
    assert not sdk.is_sdk_item_path("/api/quizzes/1/quiz_entries")
    assert not sdk.is_sdk_item_path("/api/bankss/1")
    assert not sdk.is_sdk_item_path("")
    # LANE2-D17: fragments never reach the server, so a raw "#" is
    # refused outright; query strings stay accepted (the chromium backend
    # reattaches parsed.query when routing SDK paths, e.g. pagination,
    # and the gate validates the path component).
    assert not sdk.is_sdk_item_path("/api/banks/123#section")
    assert not sdk.is_sdk_item_path("/api/banks/123/items#x")
    assert sdk.is_sdk_item_path("/api/banks/123/items?per_page=100")
    assert sdk.is_sdk_item_path("/api/banks/123?per_page=100&page=2")
    # LANE2-D9: dot segments are normalized the way fetch() normalizes
    # the concatenated api_origin + path. Traversal out of /api/banks/
    # is not an SDK path, including percent-encoded dots.
    assert not sdk.is_sdk_item_path("/api/banks/../admin")
    assert not sdk.is_sdk_item_path("/api/banks/1/../../api/v1/users")
    assert not sdk.is_sdk_item_path("/api/banks/%2e%2e/admin")
    assert not sdk.is_sdk_item_path("/api/banks/%2E%2E/admin")
    # ("..%2f..%2fadmin" is left unasserted: fetch() does not treat an
    # encoded slash as a separator, verified with node's URL parser, so
    # its server-side meaning cannot be decided from the gate.)
    assert not sdk.is_sdk_item_path(
        "https://x.quiz-api-1.instructure.com/api/banks/../admin")
    # Harmless dot segments that stay inside the namespace still match.
    assert sdk.is_sdk_item_path("/api/banks/./123")
    assert sdk.is_sdk_item_path("/api/banks/123/../456/items")


# -- host derivation --------------------------------------------------------

def _t_derive():
    assert sdk.derive_api_origin(
        "https://school.quiz-lti-iad-prod.instructure.com") == \
        "https://school.quiz-api-iad-prod.instructure.com"
    assert sdk.derive_api_origin(
        "https://school.quiz-lti.eu-west-1.instructure.com") == \
        "https://school.quiz-api.eu-west-1.instructure.com"
    assert sdk.derive_api_origin(
        "https://school.quiz-api-iad-prod.instructure.com"
        .replace("quiz-api", "quiz-lti")) == \
        "https://school.quiz-api-iad-prod.instructure.com"


def _t_derive_refuses():
    expect_raises("derive_refuses_plain", lambda: sdk.derive_api_origin(
        "https://school.instructure.com"), sdk.ItemBankSdkError)


def _t_origin_of():
    assert sdk.origin_of(
        "https://school.quiz-lti-iad-prod.instructure.com/api/sdk_tokens/x"
    ) == "https://school.quiz-lti-iad-prod.instructure.com"
    expect_raises("origin_bad", lambda: sdk.origin_of("not a url"),
                  sdk.ItemBankSdkError)


# -- frame tree --------------------------------------------------------------

def _t_frame_id():
    tree = {"frameTree": {
        "frame": {"id": "F1", "url": "https://school.instructure.com/"},
        "childFrames": [
            {"frame": {"id": "F2",
                       "url": "https://other.example.com/"},
             "childFrames": []},
            {"frame": {"id": "F3",
                       "url": "https://school.quiz-lti-iad-prod"
                              ".instructure.com"
                              "/lti/launch"},
             "childFrames": []},
        ]}}
    assert sdk.find_quiz_lti_frame_id(tree) == "F3"
    assert sdk.find_quiz_lti_frame_id({"frameTree": {
        "frame": {"id": "F1", "url": "https://school.instructure.com/"},
        "childFrames": []}}) is None
    assert sdk.find_quiz_lti_frame_id({}) is None
    assert sdk.find_quiz_lti_frame_id(None) is None


def _t_frame_rejects_sibling_host():
    tree = {"frameTree": {
        "frame": {"id": "F1",
                  "url": "https://school.quiz-lti-iad-prod.instructure.com"
                         ".evil.example/lti/launch"},
        "childFrames": []}}
    assert sdk.find_quiz_lti_frame_id(
        tree, "school.instructure.com") is None


def _t_frame_rejects_fragment_in_query():
    tree = {"frameTree": {
        "frame": {"id": "F1", "url": "https://evil.example/?x=quiz-lti"},
        "childFrames": []}}
    assert sdk.find_quiz_lti_frame_id(tree) is None
    assert sdk.find_quiz_lti_frame_id(
        tree, "school.instructure.com") is None


def _t_frame_rejects_non_https():
    tree = {"frameTree": {
        "frame": {"id": "F1",
                  "url": "http://school.quiz-lti-iad-prod.instructure.com"
                         "/lti"},
        "childFrames": []}}
    assert sdk.find_quiz_lti_frame_id(
        tree, "school.instructure.com") is None


def _t_frame_tenant_bound_variants():
    for url in ("https://school.quiz-lti-iad-prod.instructure.com/lti/launch",
                "https://school.quiz-lti.eu-west-1.instructure.com"
                "/lti/launch"):
        tree = {"frameTree": {
            "frame": {"id": "F1", "url": url}, "childFrames": []}}
        assert sdk.find_quiz_lti_frame_id(
            tree, "school.instructure.com") == "F1", url
    # wrong tenant first label: refused
    tree = {"frameTree": {
        "frame": {"id": "F1",
                  "url": "https://other.quiz-lti-iad-prod.instructure.com"
                         "/lti"},
        "childFrames": []}}
    assert sdk.find_quiz_lti_frame_id(
        tree, "school.instructure.com") is None


# -- token payload parsing ---------------------------------------------------

def _t_parse_token():
    token, auth = sdk.parse_sdk_token_payload(
        {"token": "abc", "authType": "Signature"})
    assert (token, auth) == ("abc", "Signature")
    token, auth = sdk.parse_sdk_token_payload(
        json.dumps({"access_token": "xyz"}))
    assert (token, auth) == ("xyz", "Signature")
    token, auth = sdk.parse_sdk_token_payload(
        {"jwt": "j", "auth_type": "Custom"})
    assert (token, auth) == ("j", "Custom")
    token, auth = sdk.parse_sdk_token_payload({"value": "v"})
    assert (token, auth) == ("v", "Signature")


def _t_parse_token_missing():
    expect_raises("parse_missing", lambda: sdk.parse_sdk_token_payload({}),
                  sdk.ItemBankSdkError)
    expect_raises("parse_nonjson", lambda: sdk.parse_sdk_token_payload("nope"),
                  sdk.ItemBankSdkError)


# -- tool id resolution ------------------------------------------------------

def _t_tool_id():
    tools = [{"id": 1, "name": "Zoom"},
             {"id": 54065, "name": "Item Banks"}]
    assert sdk.find_item_banks_tool_id(tools) == 54065
    assert sdk.find_item_banks_tool_id(
        [{"id": 7, "name": "item banks (LTI)"}]) == 7
    assert sdk.find_item_banks_tool_id([]) is None
    assert sdk.find_item_banks_tool_id([{"id": 2, "name": "Quizzes"}]) is None


def _t_tool_duplicate_refused():
    tools = [{"id": 1, "name": "Item Banks"},
             {"id": 2, "name": "Item Banks (copy)"}]
    expect_raises("dup_tools",
                  lambda: sdk.find_item_banks_tool_id(tools),
                  sdk.ItemBankSdkError)


def _t_tool_foreign_domain_refused():
    tools = [{"id": 9, "name": "Item Banks",
              "domain": "evil.example",
              "url": "https://evil.example/lti/launch"}]
    expect_raises("foreign_tool",
                  lambda: sdk.find_item_banks_tool_id(
                      tools, "school.instructure.com"),
                  sdk.ItemBankSdkError)


def _t_tool_tenant_domain_ok():
    tools = [{"id": 9, "name": "Item Banks",
              "domain": "school.quiz-lti-iad-prod.instructure.com"}]
    assert sdk.find_item_banks_tool_id(
        tools, "school.instructure.com") == 9
    # no url/domain carried: nothing to validate, still resolves
    assert sdk.find_item_banks_tool_id(
        [{"id": 9, "name": "Item Banks"}], "school.instructure.com") == 9


# -- course scoping ----------------------------------------------------------

def _t_scope_ok():
    sdk.check_course_scope("89585", "89585")
    sdk.check_course_scope("89585", None)


def _t_scope_refuses():
    expect_raises("scope_cross_course",
                  lambda: sdk.check_course_scope("89585", "12345"),
                  sdk.ItemBankSdkError)


# -- disposable payload ------------------------------------------------------

def _t_payload():
    body = sdk.build_disposable_choice_item("Q?")
    item = body["item"]
    assert item["item_body"] == "<p>Q?</p>"
    assert item["scoring_algorithm"] == "Equivalence"
    assert len(item["interaction_data"]["choices"]) == 2
    assert item["scoring_data"]["value"] == "c-1"


# -- launch / request flow with a mocked CDP ---------------------------------

_QZ_LTI = "https://school.quiz-lti-iad-prod.instructure.com"
_QZ_API = "https://school.quiz-api-iad-prod.instructure.com"


class _FakeCDP:
    """CDP double for the interception mechanism.

    capture_request_headers scripts the authorized quiz-api request;
    call() serves Page.getFrameTree / Page.createIsolatedWorld;
    evaluate() serves the tool list, the session probe, and the item
    fetch program, recording the execution context used.
    """

    def __init__(self):
        self.port = 19223
        self.tools = [{"id": 4242, "name": "Item Banks"}]
        self.session_alive = True
        self.capture_url = _QZ_API + "/api/features?per_page=100"
        self.capture_headers = {"Authorization": "tok-abc-123",
                                "AuthType": "Signature"}
        self.capture_error = None
        self.last_match = None
        self.frame_tree = {"frameTree": {
            "frame": {"id": "F-top",
                      "url": "https://school.instructure.com/courses/1"},
            "childFrames": []}}
        self.api_status = 201
        self.api_body = '{"item":{"id":777}}'
        self.eval_error = None
        # LANE6-9: when positive, capture_request_headers raises
        # TimeoutError this many times before serving the canned capture.
        self.capture_fail_times = 0
        # LANE6-8: when set, the item fetch program returns this outcome
        # verbatim instead of the canned ok:true response.
        self.item_outcome = None
        # observations
        self.captured = []       # (url, match) interception requests
        self.calls = []          # (method, params) CDP calls
        self.evaluations = []    # (expression, context_id)
        self.navigated = []
    def new_tab(self, url="about:blank"):
        return {"id": "fake-tab-1", "type": "page", "url": url}

    def close_tab(self, tab):
        self.calls.append(("close_tab", tab))
        return {}

    def create_isolated_world(self, tab, world_name):
        # The SDK's session probe and item fetch both run in an isolated
        # world (W4-P1-12); the fake mints context 42 like its
        # Page.createIsolatedWorld call stub below.
        assert isinstance(tab, dict) and tab.get("id"), tab
        return 42

    def navigate(self, tab, url, timeout=30):
        self.navigated.append(url)
        return {}

    # -- interception --

    def capture_request_headers(self, tab, url, match, timeout=120):
        self.captured.append((url, match))
        self.last_match = match
        if self.capture_fail_times > 0:
            self.capture_fail_times -= 1
            raise TimeoutError("no matching request observed")
        if self.capture_error is not None:
            raise self.capture_error
        # the real matcher must accept the tenant's authorized quiz-api
        # request, reject foreign hosts, and require the Authorization
        # header (the CORS preflight has none).
        assert match(self.capture_url, self.capture_headers), \
            "matcher must accept the tenant quiz-api request"
        assert not match("https://evil.example.com/api/features",
                         self.capture_headers), \
            "matcher must reject foreign hosts"
        assert not match(self.capture_url, {"Accept": "application/json"}), \
            "matcher must require the Authorization header"
        return self.capture_url, dict(self.capture_headers)
    def call(self, tab, method, params=None, timeout=30):
        self.calls.append((method, params or {}))
        if method == "Page.getFrameTree":
            return self.frame_tree
        if method == "Page.createIsolatedWorld":
            assert (params or {}).get("frameId") == "F-top", params
            return {"executionContextId": 42}
        raise AssertionError("unexpected CDP call %s" % method)

    # -- JS evaluation --

    def evaluate(self, tab, expression, await_promise=False, timeout=30,
                 context_id=None):
        self.evaluations.append((expression, context_id))
        if self.eval_error is not None:
            raise self.eval_error
        if "external_tools" in expression:
            return {"ok": True, "tools": self.tools}
        if "users/self" in expression:
            return 200 if self.session_alive else 401
        if "location.href" in expression:
            return "https://school.instructure.com/"
        # the item fetch program: runs in the tab root frame's world
        assert context_id == 42, \
            "fetch must evaluate in the quiz-lti frame context"
        if self.item_outcome is not None:
            return self.item_outcome
        assert '"tok-abc-123"' in expression, "captured token must be used"
        assert '"Signature"' in expression
        assert ('"%s"' % _QZ_API) in expression, \
            "quiz-api origin must be derived from the capture"
        assert self.api_body not in expression
        return {"ok": True, "status": self.api_status, "body": self.api_body}


def _t_api_host():
    assert sdk._is_quiz_api_host(
        "school.quiz-api-iad-prod.instructure.com", "school.instructure.com")
    assert sdk._is_quiz_api_host(
        "school.quiz-api.instructure.com", "school.instructure.com")
    assert not sdk._is_quiz_api_host(
        "other.quiz-api-iad-prod.instructure.com", "school.instructure.com")
    assert not sdk._is_quiz_api_host(
        "school.quiz-lti-iad-prod.instructure.com", "school.instructure.com")
    assert not sdk._is_quiz_api_host(
        "school.quiz-api-iad-prod.instructure.com.evil.example",
        "school.instructure.com")
    assert not sdk._is_quiz_api_host("evil.example.com",
                                     "school.instructure.com")
    assert not sdk._is_quiz_api_host("", "school.instructure.com")


def _t_launch_captures_auth_headers():
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    assert len(cdp.captured) == 1
    url, _match = cdp.captured[0]
    assert "/external_tools/4242" in url, url
    # credential material captured from the request headers, memory-only
    assert s._token == "tok-abc-123"
    assert s._auth_type == "Signature"
    assert s._api_origin == _QZ_API, s._api_origin
    assert s._context_id == 42
    s.close()
def _t_launch_auth_type_defaults():
    cdp = _FakeCDP()
    cdp.capture_headers = {"Authorization": "tok-x"}
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    assert s._token == "tok-x"
    assert s._auth_type == "Signature", "auth type must default"
    s.close()
def _t_launch_auth_type_variant():
    cdp = _FakeCDP()
    cdp.capture_headers = {"Authorization": "t", "AuthType": "CustomScheme"}
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    assert s._auth_type == "CustomScheme"
    s.close()
def _t_launch_region_variant():
    cdp = _FakeCDP()
    cdp.capture_url = ("https://school.quiz-api.eu-west-1.instructure.com"
                       "/api/features")
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    assert s._api_origin == \
        "https://school.quiz-api.eu-west-1.instructure.com", s._api_origin
    # the real matcher (kept by the fake) binds to the tenant: a sibling
    # tenant's quiz-api host is refused.
    assert not cdp.last_match(
        "https://other.quiz-api-eu-west-1.instructure.com/api/x",
        {"Authorization": "z"})
    s.close()
def _t_launch_matcher_rejects_foreign_host():
    # the matcher launch() builds is the trust boundary: drive it
    # directly against hostile inputs.
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    m = cdp.last_match
    good = {"Authorization": "z"}
    assert m("https://school.quiz-api-iad-prod.instructure.com/api/banks",
             good)
    assert not m("https://school.quiz-lti-iad-prod.instructure.com/api/x",
                 good), "quiz-lti host is not the item API host"
    assert not m("https://school.quiz-api-iad-prod.instructure.com"
                 ".evil.example/"
                 "api/x", good), "suffix trick"
    assert not m("https://school.quiz-api-iad-prod.instructure.com/api/x",
                 {"Accept": "application/json"}), "no Authorization"
    assert not m("not a url", good)
    s.close()


def _t_launch_retries_capture_timeout_once():
    # LANE6-9: one transient capture timeout is retried (fresh page
    # load); two consecutive timeouts raise the hard not-attempted
    # error.
    cdp = _FakeCDP()
    cdp.capture_fail_times = 1
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    assert len(cdp.captured) == 2, cdp.captured
    assert s._launched is True
    s.close()

    cdp = _FakeCDP()
    cdp.capture_fail_times = 2
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    try:
        s.launch()
    except sdk.ItemBankSdkError as exc:
        assert "two attempts" in str(exc), str(exc)[:160]
    else:
        raise AssertionError("two timeouts must raise")
    assert len(cdp.captured) == 2, cdp.captured
    assert s._launched is False
    s.close()


def _t_launch_course_id_json_encoded():
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    prog = [e for e in cdp.evaluations if "external_tools" in e[0]][0][0]
    assert "'/api/v1/courses/' + \"89585\" + '/external_tools'" in prog, prog
    assert "%(course_id)s" not in prog
    s.close()


def _t_ids_rejected_at_boundary():
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    expect_raises("none_bank",
                  lambda: s.create_item(None, {"item": {}}),
                  sdk.ItemBankSdkError)
    expect_raises("empty_bank",
                  lambda: s.get_item("   ", "1"), sdk.ItemBankSdkError)
    expect_raises("none_item",
                  lambda: s.get_item("1", None), sdk.ItemBankSdkError)
    expect_raises("slash_bank",
                  lambda: s.delete_item("../x", "1"), sdk.ItemBankSdkError)
    expect_raises("slash_item",
                  lambda: s.update_item("1", "a/b", {"item": {}}),
                  sdk.ItemBankSdkError)
    # LANE2-D14: backslash, controls, and encoded separators are not
    # single segments either (the URL parser treats backslash as a
    # separator and strips tab/newline before resolving).
    expect_raises("backslash_bank",
                  lambda: s.get_item("..\\..\\admin", "1"),
                  sdk.ItemBankSdkError)
    expect_raises("newline_item",
                  lambda: s.get_item("1", "1\n../admin"),
                  sdk.ItemBankSdkError)
    expect_raises("tab_bank",
                  lambda: s.get_item("1\t../x", "1"), sdk.ItemBankSdkError)
    expect_raises("encoded_slash_bank",
                  lambda: s.get_item("..%2f..%2fadmin", "1"),
                  sdk.ItemBankSdkError)
    expect_raises("encoded_backslash_item",
                  lambda: s.get_item("1", "1%5c..%5cadmin"),
                  sdk.ItemBankSdkError)
    expect_raises("control_bank",
                  lambda: s.get_item("1\x01", "1"), sdk.ItemBankSdkError)
    # course_id is interpolated into URL paths too: it gets the same
    # single-segment validation at construction.
    expect_raises("slash_course",
                  lambda: sdk.ItemBankSdk(
                      _FakeCDP(), "https://school.instructure.com", "../x"),
                  sdk.ItemBankSdkError)
    expect_raises("backslash_course",
                  lambda: sdk.ItemBankSdk(
                      _FakeCDP(), "https://school.instructure.com", "1\\2"),
                  sdk.ItemBankSdkError)
    # numeric ids still work
    status, body = s.create_item(
        123, sdk.build_disposable_choice_item("Q"))
    assert status == 201, status
    s.close()


def _t_launch_needs_no_quiz_lti_frame():
    # the /banks route has no quiz-lti frame (the app runs in a worker);
    # launch must not require one.
    cdp = _FakeCDP()
    cdp.frame_tree = {"frameTree": {
        "frame": {"id": "F-top", "url": "https://school.instructure.com/"},
        "childFrames": []}}
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    s.close()
def _t_launch_capture_timeout():
    cdp = _FakeCDP()
    cdp.capture_error = TimeoutError("never fired")
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585",
                        token_wait_s=5)
    expect_raises("capture_timeout", s.launch, sdk.ItemBankSdkError)
    s.close()


def _t_launch_falls_back_to_banks_route():
    cdp = _FakeCDP()
    cdp.tools = [{"id": 9, "name": "Zoom"}]
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    url, _match = cdp.captured[0]
    assert url.endswith("/courses/89585/banks"), url
    s.close()
def _t_launch_dead_session():
    cdp = _FakeCDP()
    cdp.session_alive = False
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    expect_raises("launch_dead", s.launch, sdk.ItemBankSdkSessionDead)
    assert cdp.captured == [], "no capture without a live session"
    s.close()


def _t_request_roundtrip():
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    status, body = s.create_item("123", sdk.build_disposable_choice_item("Q"))
    assert status == 201, status
    assert json.loads(body)["item"]["id"] == 777
    # the fetch program ran in the quiz-lti frame's execution context
    fetch_evals = [e for e in cdp.evaluations if "'Authorization'" in e[0]]
    assert len(fetch_evals) == 1 and fetch_evals[0][1] == 42
    # results carry no credential material
    assert "tok-abc-123" not in body
    s.close()


def _t_request_no_token_in_results():
    cdp = _FakeCDP()
    cdp.api_body = '{"item":{"id":1},"echo":"none"}'
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    status, body = s.get_item("123", "456")
    assert status == 201
    assert "tok-abc-123" not in body
    s.close()


def _t_request_context_loss_resets():
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    cdp.eval_error = RuntimeError(
        "Cannot find context with specified id")
    # LANE6-8: context loss after dispatch is MaybeAttempted (the fetch
    # may already have executed), not a plain not-attempted error.
    expect_raises("ctx_lost", lambda: s.get_item("1", "2"),
                  sdk.ItemBankSdkMaybeAttempted)
    assert s._launched is False, "context loss must reset the launch"
    assert s._token is None, "context loss must drop the token"
    s.close()


def _t_request_fetch_error_is_maybe_attempted():
    # LANE6-8: a page-level fetch that throws may still have reached
    # the provider, so it surfaces as MaybeAttempted. A non-fetch
    # program failure stays a plain (not-attempted) ItemBankSdkError.
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    cdp.item_outcome = {"ok": False,
                        "error": "fetch_error: connection reset"}
    try:
        s.get_item("1", "2")
        raise AssertionError("expected MaybeAttempted")
    except sdk.ItemBankSdkMaybeAttempted:
        pass
    assert isinstance(sdk.ItemBankSdkMaybeAttempted("x"),
                      sdk.ItemBankSdkError)
    cdp.item_outcome = {"ok": False, "error": "weird program bug"}
    expect_raises("nonfetch", lambda: s.get_item("1", "2"),
                  sdk.ItemBankSdkError)
    try:
        s.get_item("1", "2")
    except sdk.ItemBankSdkMaybeAttempted:
        raise AssertionError("non-fetch failure must not be MaybeAttempted")
    except sdk.ItemBankSdkError:
        pass
    s.close()


def _t_close_wipes_token():
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    assert s._token == "tok-abc-123"
    s.close()
    assert s._token is None
    assert s._api_origin is None
    assert s._context_id is None


def _t_request_refuses_cross_course():
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    expect_raises("xcourse", lambda: s.get_item("1", "2", course_id="999"),
                  sdk.ItemBankSdkError)
    s.close()


def _t_request_refuses_non_sdk_path():
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")

    def _refused(path):
        n_calls = len(cdp.calls)
        n_evals = len(cdp.evaluations)
        expect_raises("nonpath:%s" % path[:24], lambda: s.request(
            "GET", path), sdk.ItemBankSdkError)
        # LANE2-D14: the refusal lands before launch: no CDP call and no
        # JS evaluation (no provider activity, token never minted).
        assert len(cdp.calls) == n_calls, "CDP call on refused path"
        assert len(cdp.evaluations) == n_evals, "evaluate on refused path"
        assert s._launched is False

    _refused("/api/v1/courses/1")
    # LANE2-D9: dot-segment traversal that fetch() would resolve outside
    # /api/banks/ is refused at the SDK boundary, before any launch.
    _refused("/api/banks/../admin")
    _refused("/api/banks/%2e%2e/admin")
    # LANE2-D14: absolute URLs are URL/path confusion: refused even
    # though the old gate accepted them.
    _refused("https://x.quiz-api-1.instructure.com/api/banks/1/items")
    _refused("https://x.quiz-api-1.instructure.com/api/banks/../admin")
    _refused("//x.quiz-api-1.instructure.com/api/banks/1")
    # Backslash / tab / newline traversals: the browser's URL parser
    # resolves all of these outside /api/banks/.
    _refused("/api/banks\\../admin")
    _refused("/api/banks/..\\admin")
    _refused("/api/banks/\n../admin")
    _refused("/api/banks/\t../admin")
    s.close()


def _t_create_requires_item_nesting():
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    expect_raises("nesting", lambda: s.create_item("1", {"title": "x"}),
                  sdk.ItemBankSdkError)
    s.close()


def _t_update_requires_item_nesting():
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    expect_raises("nesting_upd", lambda: s.update_item(
        "1", "2", {"title": "x"}), sdk.ItemBankSdkError)
    s.close()


def _t_no_course_refused():
    expect_raises("nocourse", lambda: sdk.ItemBankSdk(
        _FakeCDP(), "https://school.instructure.com", None),
        sdk.ItemBankSdkError)


def _t_request_rejects_unsupported_method():
    # LANE6-4: the method boundary admits only GET/POST/PATCH/DELETE.
    # PUT is refused in particular (item updates are PATCH-only).
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    for bad in ("PUT", "put", "OPTIONS", "HEAD", "TRACE"):
        expect_raises("method_%s" % bad,
                      lambda m=bad: s.request(
                          m, "/api/banks/123/items/456"),
                      sdk.ItemBankSdkError)
    # An empty/None method keeps the pre-existing GET default.
    status, _ = s.request("", "/api/banks/123")
    assert status == 201, status
    n_launches = len(cdp.captured)
    # The refusals above happened at the boundary: no launch, no
    # provider call for any of them.
    assert n_launches == 1, n_launches
    # All four contract methods are still admitted (each relaunches once).
    for good in ("GET", "post", "Patch", "DELETE"):
        s2 = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
        status, _ = s2.request(good, "/api/banks/123")
        assert status == 201, (good, status)
        s2.close()
    s.close()


def _t_drop_credential_forces_relaunch():
    # LANE6-5: drop_credential wipes the launch state so the next
    # request() recaptures a fresh credential (the 401 recovery path).
    cdp = _FakeCDP()
    s = sdk.ItemBankSdk(cdp, "https://school.instructure.com", "89585")
    assert s.launch() is True
    assert s._launched is True
    assert s._token is not None, "expected a captured token after launch"
    s.drop_credential()
    assert s._launched is False
    # LANE6-5 follow-up: the rejected token material itself must be wiped,
    # not just the launch flag; otherwise the old token could be reused.
    assert s._token is None, "drop_credential must clear the captured token"
    status, _ = s.get_item("123", "456")
    assert status == 201, status
    assert s._launched is True
    assert s._token is not None, "expected a fresh token after relaunch"
    # a fresh capture ran (the launch navigated and intercepted again)
    assert len(cdp.captured) == 2, len(cdp.captured)
    s.close()


TESTS = [
    ("sdk_paths_classified", _t_paths),
    ("sdk_derive_api_origin", _t_derive),
    ("sdk_derive_refuses_non_lti", _t_derive_refuses),
    ("sdk_origin_of", _t_origin_of),
    ("sdk_quiz_lti_frame_id", _t_frame_id),
    ("sdk_frame_rejects_sibling_host", _t_frame_rejects_sibling_host),
    ("sdk_frame_rejects_fragment_in_query",
     _t_frame_rejects_fragment_in_query),
    ("sdk_frame_rejects_non_https", _t_frame_rejects_non_https),
    ("sdk_frame_tenant_bound_variants", _t_frame_tenant_bound_variants),
    ("sdk_parse_token_payload", _t_parse_token),
    ("sdk_parse_token_missing", _t_parse_token_missing),
    ("sdk_tool_id_dynamic", _t_tool_id),
    ("sdk_tool_duplicate_refused", _t_tool_duplicate_refused),
    ("sdk_tool_foreign_domain_refused", _t_tool_foreign_domain_refused),
    ("sdk_tool_tenant_domain_ok", _t_tool_tenant_domain_ok),
    ("sdk_scope_same_course", _t_scope_ok),
    ("sdk_scope_cross_course_refused", _t_scope_refuses),
    ("sdk_disposable_payload", _t_payload),
    ("sdk_quiz_api_host", _t_api_host),
    ("sdk_launch_captures_auth_headers", _t_launch_captures_auth_headers),
    ("sdk_launch_auth_type_defaults", _t_launch_auth_type_defaults),
    ("sdk_launch_auth_type_variant", _t_launch_auth_type_variant),
    ("sdk_launch_region_variant", _t_launch_region_variant),
    ("sdk_launch_matcher_rejects_foreign_host",
     _t_launch_matcher_rejects_foreign_host),
    ("sdk_launch_retries_capture_timeout_once",
     _t_launch_retries_capture_timeout_once),
    ("sdk_launch_course_id_json_encoded",
     _t_launch_course_id_json_encoded),
    ("sdk_ids_rejected_at_boundary",
     _t_ids_rejected_at_boundary),
    ("sdk_launch_needs_no_quiz_lti_frame", _t_launch_needs_no_quiz_lti_frame),
    ("sdk_launch_capture_timeout", _t_launch_capture_timeout),
    ("sdk_launch_banks_fallback", _t_launch_falls_back_to_banks_route),
    ("sdk_launch_dead_session", _t_launch_dead_session),
    ("sdk_request_roundtrip", _t_request_roundtrip),
    ("sdk_request_no_token_in_results", _t_request_no_token_in_results),
    ("sdk_request_context_loss_resets", _t_request_context_loss_resets),
    ("sdk_request_fetch_error_is_maybe_attempted",
     _t_request_fetch_error_is_maybe_attempted),
    ("sdk_close_wipes_token", _t_close_wipes_token),
    ("sdk_request_cross_course_refused", _t_request_refuses_cross_course),
    ("sdk_request_non_sdk_path_refused", _t_request_refuses_non_sdk_path),
    ("sdk_create_requires_item_nesting", _t_create_requires_item_nesting),
    ("sdk_update_requires_item_nesting", _t_update_requires_item_nesting),
    ("sdk_no_course_refused", _t_no_course_refused),
    ("sdk_request_rejects_unsupported_method",
     _t_request_rejects_unsupported_method),
    ("sdk_drop_credential_forces_relaunch",
     _t_drop_credential_forces_relaunch),
]


def main():
    for name, fn in TESTS:
        check(name, fn)
    print("item_bank_sdk selftest: %d passed, %d failed"
          % (len(PASS), len(FAIL)))
    for name, detail in FAIL:
        print("FAIL %s: %s" % (name, detail))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
