#!/usr/bin/env python3
"""A change the Chromium lane refuses before sending is reported as not sent.

Failure mode this suite pins down (written before the fix; round-2
finding, 2026-09-23, probe final-sweep/muse-engine/tests/
test_presend_refusals.py): the executor marks a write attempted just
before it calls the lane, so a refusal the lane raises before its fetch
was classified as a write that may have applied. The claim stayed
pending for reconciliation (or the op was journaled uncertain), and the
educator heard that Canvas may have applied the change. The refusals:

  - the page had no _csrf_token cookie (wrapped as UncertainWrite, so
    the canvas-csrf-token-missing mode could never match);
  - no Canvas account is pinned (PrincipalNotPinned);
  - the account check before the write got no account back (HTTP 500);
  - another account is signed in to the helper (PrincipalMismatch);
  - the helper browser could not be reached for the first call of a
    course-less write;
  - Item Banks could not be opened for the course (ItemBankSdkError).

Each is now a WriteNotAttempted: the claim is released, nothing is
journaled as possibly applied, and the educator hears that nothing was
sent, with the cause's own plain message.

Hermetic: a fake browser tab; journal, settings, and the re-auth store
live in pytest's tmp_path.
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
    BASE, _pack, hermetic)
from failures.funnel import agent_error_payload  # noqa: E402
from reauth import state_machine as rsm  # noqa: E402
from transport import state as lane_state  # noqa: E402

USER = "muse:presend@school.edu"
CONV = "conv-presend"
PAGE = ("canvas_update_create_page_courses", "PUT",
        "/api/v1/courses/{course_id}/pages/{url_or_id}",
        {"course_id": "101", "url_or_id": "week-1"},
        {"wiki_page": {"title": "New"}})
FAVORITE = ("canvas_add_course_to_favorites", "POST",
            "/api/v1/users/self/favorites/courses/{id}", {"id": "101"}, None)
TEACHER = 777


@pytest.fixture(autouse=True)
def reauth_home(tmp_path, monkeypatch):
    root = tmp_path / "reauth"
    root.mkdir()
    monkeypatch.setattr(rsm, "STORE_DIR", str(root))
    for name in ("STATE_PATH", "HALT_PATH", "QUAR_PATH", "NOTIFY_PATH",
                 "APPROVAL_PATH", "SESSION_PATH", "SESSION_PREV",
                 "LAST_DEATH_PATH", "SESSION_PREV_MONO"):
        monkeypatch.setattr(rsm, name, str(
            root / os.path.basename(getattr(rsm, name))))
    monkeypatch.setattr(lane_state, "STATE_PATH",
                        str(root / "browser_lane.json"))
    lane_state.save(BASE, TEACHER, "Edu T. Or")
    from settings import store
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)
    return root


class Tab:
    """The helper's Canvas tab. `refuse` picks the pre-send refusal."""

    def __init__(self, refuse):
        self.refuse = refuse
        self.calls = []

    def api(self, method, path, data=None, as_json=False, timeout=60,
            max_bytes=None):
        bare = path.split("?")[0]
        if method == "PUT" and self.refuse == "csrf":
            # The page refuses before its fetch: nothing leaves the tab.
            raise ex._chromium_session_mod().lc.CsrfTokenMissing(
                "refusing PUT %s: no _csrf_token in the live "
                "document.cookie; the write was not sent" % path)
        self.calls.append((method, path))
        ok = lambda obj: (200, {}, json.dumps(obj))  # noqa: E731
        if bare == "/api/v1/users/self":
            checks = [c for c in self.calls if c[1].split("?")[0] == bare]
            if len(checks) > 1 and self.refuse == "account-check-500":
                return 500, {}, "{}"
            if len(checks) > 1 and self.refuse == "other-account":
                return ok({"id": 999, "name": "Someone Else"})
            return ok({"id": TEACHER, "name": "Edu T. Or"})
        if bare.endswith(("/users", "/enrollments")):
            return ok([])
        if bare == "/api/v1/courses/101":
            return ok({"id": 101, "name": "Bio 101"})
        if bare.endswith("/pages/week-1"):
            if method == "PUT":
                raise AssertionError("the change was sent")
            return ok({"url": "week-1", "title": "Old"})
        raise AssertionError("unexpected call %s %s" % (method, path))


class DownLauncher:
    """The helper browser cannot be started or attached."""

    attached = False
    proc = None

    def start(self):
        raise RuntimeError("no Chromium on this tree's CDP port")


def _session(tab=None, launcher=None):
    cs = ex._chromium_session_mod()
    sess = cs.ChromiumSession(BASE, launcher=launcher, transport=tab)
    sess._check_expiry_warning = lambda: None
    sess._helper_http_up = lambda: False
    return sess


def _dispatch(op, sess):
    name, method, path, params, body = op
    extra = {"body": body} if body is not None else None
    ctx = {"user_id": USER, "conversation_id": CONV}
    if "course_id" in params:
        ctx["course_resolution"] = {"course_id": params["course_id"],
                                    "confidence": 1.0,
                                    "user_confirmed": True}
    with pytest.raises(ex.ExecutorError) as info:
        ex.dispatch_catalog_op(name, method, path, None, dict(params),
                               pack=_pack(), session=sess, extra=extra,
                               mode_ctx=ctx)
    return info.value


def _journaled_as_possibly_applied():
    records = []
    try:
        with open(ex.JOURNAL_PATH, encoding="utf-8") as fh:
            records = [json.loads(line) for line in fh if line.strip()]
    except FileNotFoundError:
        pass
    return [r for r in records if r.get("uncertain") is True
            or (r.get("result") or {}).get("status") == "uncertain"]


@pytest.mark.parametrize("refuse, error_class, mode_id", [
    ("csrf", "CsrfWriteNotSent", "canvas-csrf-token-missing"),
    ("not-pinned", "PrincipalNotPinned", "canvas-account-not-pinned"),
    ("account-check-500", "AccountCheckFailed",
     "canvas-account-check-failed"),
    ("other-account", "PrincipalMismatch", "canvas-account-mismatch"),
])
def test_a_course_change_refused_before_sending_is_not_pending(
        refuse, error_class, mode_id, monkeypatch):
    if refuse == "not-pinned":
        monkeypatch.setattr(rsm, "pinned_principal", lambda: None)
    tab = Tab(refuse)
    exc = _dispatch(PAGE, _session(tab))
    assert type(exc).__name__ == error_class
    assert isinstance(exc, ex.WriteNotAttempted)
    assert ("PUT", "/api/v1/courses/101/pages/week-1") not in tab.calls
    assert ex.journal_pending_ops() == []
    assert _journaled_as_possibly_applied() == []
    payload = agent_error_payload("changing a page", exc)
    assert payload["mode_id"] == mode_id
    message = payload["message"].lower()
    assert "nothing was sent" in message or "did not send" in message
    for phrase in ("may have", "cannot tell whether", "might have applied"):
        assert phrase not in message


def test_a_course_less_change_the_helper_cannot_reach_is_not_pending():
    exc = _dispatch(FAVORITE, _session(launcher=DownLauncher()))
    assert type(exc).__name__ == "HelperNotReached"
    assert isinstance(exc, ex.WriteNotAttempted)
    assert ex.journal_pending_ops() == []
    assert _journaled_as_possibly_applied() == []
    payload = agent_error_payload("adding a course to your favorites", exc)
    assert payload["mode_id"] == "helper-down"


def test_a_helper_browser_failure_names_the_helper(monkeypatch):
    sess = _session(launcher=DownLauncher())
    sess._helper_http_up = lambda: True
    exc = _dispatch(FAVORITE, sess)
    payload = agent_error_payload("adding a course to your favorites", exc)
    assert payload["mode_id"] == "helper-browser-not-reached"
    assert "did not send" in payload["message"]


def test_an_item_banks_launch_failure_is_not_sent(monkeypatch):
    cs = ex._chromium_session_mod()
    sess = _session(Tab("none"))
    sess.set_sdk_course("101")

    class NoLaunch:
        def request(self, *args, **kwargs):
            raise cs.ibsdk.ItemBankSdkError(
                "refusing ambiguous Item Banks launch: 2 external tools "
                "match 'Item Banks'")

    monkeypatch.setattr(sess, "_sdk_for_course", lambda course: NoLaunch())
    with pytest.raises(ex.WriteNotAttempted) as info:
        sess.raw_request("POST", BASE + "/api/banks/7/items",
                         {"Content-Type": "application/json"},
                         b'{"item": {}}', is_write=True)
    assert type(info.value).__name__ == "ItemBanksNotReached"
    payload = agent_error_payload("adding an Item Bank item", info.value)
    assert payload["mode_id"] == "item-banks-not-reached"
    assert "did not send" in payload["message"]


def test_an_item_banks_outcome_lost_after_dispatch_stays_uncertain():
    # Only a failure before the page-context program is dispatched is
    # "not sent"; an outcome the program never returns is not proof.
    cs = ex._chromium_session_mod()
    sdk = cs.ibsdk.ItemBankSdk.__new__(cs.ibsdk.ItemBankSdk)
    sdk._course_id = "101"
    sdk._token, sdk._auth_type, sdk._api_origin = "t", "Bearer", "https://q"
    sdk._context_id = 1
    sdk.launch = lambda: None
    sdk._get_tab = lambda: {"id": "tab"}

    class Cdp:
        def evaluate(self, *args, **kwargs):
            return None

    sdk._cdp = Cdp()
    with pytest.raises(cs.ibsdk.ItemBankSdkMaybeAttempted):
        sdk.request("POST", "/api/banks/7/items", {"item": {}},
                    course_id="101")
