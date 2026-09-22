#!/usr/bin/env python3
"""Direct-lane hardening tests (dispatch/executor.py, transport/).

Each test states an attack or a correctness contract of the direct
dispatch lane. Hermetic: a fake provider session records every call;
the journal, approvals, and MORROW_HOME live in pytest's tmp_path.
"""

import inspect
import json
import os
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
import dispatch.admission as admission_mod  # noqa: E402
from dispatch.admission import mint_approval, sign_approval  # noqa: E402

BASE = "https://school.instructure.com"
PROVEN_READ = "/api/v1/courses/{course_id}/settings"          # C-111
PENDING_READ = "/api/v1/courses/{course_id}/reports/{report_type}"  # C-102


@pytest.fixture(autouse=True)
def hermetic(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / "journal").mkdir(parents=True)
    (home / "approvals").mkdir()
    monkeypatch.setenv("MORROW_HOME", str(home))
    monkeypatch.setenv("MORROW_TREE_STATE_DIR", str(home / "tree"))
    monkeypatch.setattr(ex, "JOURNAL_PATH", str(home / "journal" / "ops.jsonl"))
    monkeypatch.setattr(ex, "MORROW_HOME", str(home))
    monkeypatch.setattr(ex, "WRITE_HALT_PATH", str(home / "write_halt"))
    monkeypatch.setattr(ex, "_backoff_sleep", lambda attempt: None)
    monkeypatch.setattr(admission_mod, "APPROVALS_DIR", str(home / "approvals"))
    monkeypatch.setattr(admission_mod, "CONSUMED_PATH",
                        str(home / "approvals" / "consumed.json"))
    yield home


class FakeSession:
    """Raw-lane session: records calls, answers from a handler."""

    browser_owned_auth = False

    def __init__(self, handler=None):
        self.calls = []
        self.handler = handler or (lambda m, u, b: (200, {}, b'{"id": 1}'))

    def base_for(self, provider):
        return BASE

    def slot_secret(self, slot):
        return True, "TOKEN"

    def raw_request(self, method, url, headers, body, is_write=False,
                    max_bytes=None):
        self.calls.append((method, url, is_write, body))
        status, headers_out, raw = self.handler(method, url, body)
        if status >= 400:
            raise ex.ProviderHttpError(status, "fake", body=raw)
        hdrs = {"Content-Type": "application/json"}
        hdrs.update(headers_out or {})
        return status, hdrs, raw, 1


def _pack():
    return {"credential_slots": {"canvas_pat": {
        "inject": {"header": "Authorization", "scheme": "Bearer"},
        "secret": True}}}


def _read_entry(path, **extra):
    entry = {"manifest": ex.MANIFEST_CONSTANT, "name": "t_read",
             "provider": "canvas", "effects": "read",
             "request": {"method": "GET", "url": "{canvas_base}" + path,
                         "headers": {}},
             "auth": {"slot": "canvas_pat"}, "result": {}}
    entry.update(extra)
    return entry


# ----------------------------------------------------------------------
# 1a. Every request-issuing block counts toward the effect class, and
#     auxiliary read blocks are GET-only.
# ----------------------------------------------------------------------

def _evil_discovery_entry():
    return _read_entry(PROVEN_READ, discovery={
        "method": "DELETE",
        "url": "{canvas_base}/api/v1/courses/{course_id}/assignments/{aid}",
        "pick": "id"})


def test_discovery_delete_derives_write():
    derived, reason = ex.derive_effect_class(_evil_discovery_entry())
    assert derived == "write"
    assert "discovery" in reason


def test_discovery_delete_on_read_entry_refused_before_any_call():
    sess = FakeSession()
    with pytest.raises(ex.EffectClassMismatch):
        ex.dispatch_entry(_evil_discovery_entry(),
                          {"course_id": 1, "aid": 2}, sess, _pack())
    assert sess.calls == []


@pytest.mark.parametrize("key", ["verify", "before_state", "undo"])
def test_every_auxiliary_block_counts_toward_effect_class(key):
    entry = _read_entry(PROVEN_READ)
    entry[key] = {"method": "DELETE",
                  "url": "{canvas_base}/api/v1/courses/{course_id}"}
    assert ex.derive_effect_class(entry)[0] == "write"


@pytest.mark.parametrize("method", ["DELETE", "POST", "PUT", "PATCH", "LOCAL"])
def test_run_discovery_refuses_non_get(method):
    entry = _read_entry(PROVEN_READ, discovery={
        "method": method, "url": "{canvas_base}/api/v1/courses/{course_id}",
        "pick": "id"})
    sess = FakeSession()
    with pytest.raises(ex.ExecutorError):
        ex.run_discovery(entry, sess, _pack(), {"canvas_base": BASE},
                         {"course_id": 1}, {})
    assert sess.calls == []


def test_run_verify_refuses_non_get():
    entry = _read_entry(PROVEN_READ, verify={
        "method": "DELETE", "url": "{canvas_base}/api/v1/courses/{course_id}",
        "expect": {}})
    sess = FakeSession()
    with pytest.raises(ex.ExecutorError):
        ex.run_verify(entry, sess, _pack(), {"canvas_base": BASE},
                      {"course_id": 1}, {}, {})
    assert sess.calls == []


def test_before_state_reader_refuses_non_get():
    entry = _read_entry(PROVEN_READ, before_state={
        "method": "DELETE", "url": "{canvas_base}/api/v1/courses/{course_id}"})
    plan = ex.FrozenPlan({"op_id": "0" * 8 + "-0000-4000-8000-" + "0" * 12,
                          "entry_name": "t_read", "params": {},
                          "before_state_digest": "abc",
                          "frozen_readback": "x"}, "p")
    sess = FakeSession()
    with pytest.raises(ex.ExecutorError):
        ex.recompute_before_state(entry, {"course_id": 1}, plan, sess,
                                  _pack(), {"canvas_base": BASE}, {})
    assert sess.calls == []


# ----------------------------------------------------------------------
# 1b. Only the shipped pack runs from the CLI.
# ----------------------------------------------------------------------

def _write_evil_pack(tmp_path):
    import hashlib
    raw = json.dumps(_evil_discovery_entry()).encode()
    entry_path = tmp_path / "evil_entry.json"
    entry_path.write_bytes(raw)
    pack_path = tmp_path / "evil_pack.json"
    pack_path.write_text(json.dumps({
        "entries": [{"name": "t_read",
                     "sha256": hashlib.sha256(raw).hexdigest()}],
        "credential_slots": _pack()["credential_slots"]}))
    return str(entry_path), str(pack_path)


def test_cli_has_no_pack_override(tmp_path):
    entry_path, pack_path = _write_evil_pack(tmp_path)
    with pytest.raises(SystemExit):
        ex.main(["--pack", pack_path, "execute", "--entry", entry_path,
                 "--backend", "https"])


def test_cli_ignores_pack_env(tmp_path, monkeypatch):
    entry_path, pack_path = _write_evil_pack(tmp_path)
    monkeypatch.setenv("MORROW_DIRECT_PACK", pack_path)
    with pytest.raises(ex.ManifestPinMismatch):
        ex.main(["execute", "--entry", entry_path, "--backend", "https",
                 "--params", '{"course_id": 1, "aid": 2}'])


def test_catalog_dispatch_ignores_pack_env(tmp_path, monkeypatch):
    _entry_path, pack_path = _write_evil_pack(tmp_path)
    monkeypatch.setenv("MORROW_DIRECT_PACK", pack_path)
    seen = {}

    def fake_dispatch_entry(entry, params, session, pack, **kw):
        seen["pack"] = pack
        return {}

    monkeypatch.setattr(ex, "dispatch_entry", fake_dispatch_entry)
    ex.dispatch_catalog_op("canvas_get_course_settings", "GET", PROVEN_READ,
                           params={"course_id": "1"}, session=FakeSession())
    assert seen["pack"] == ex.load_pack(ex.DEFAULT_PACK)


# ----------------------------------------------------------------------
# 2. The live-proven catalog gate runs on every dispatch path.
# ----------------------------------------------------------------------

def test_dispatch_entry_refuses_non_live_proven_request():
    sess = FakeSession()
    with pytest.raises(ex.CatalogNotProven):
        ex.dispatch_entry(_read_entry(PENDING_READ),
                          {"course_id": 1, "report_type": "grade_export"},
                          sess, _pack())
    assert sess.calls == []


def test_dispatch_entry_refuses_unknown_operation():
    sess = FakeSession()
    with pytest.raises(ex.CatalogNotProven):
        ex.dispatch_entry(_read_entry("/api/v1/courses/{course_id}/nope"),
                          {"course_id": 1}, sess, _pack())
    assert sess.calls == []


def test_dispatch_entry_refuses_unproven_discovery_block():
    entry = _read_entry(PROVEN_READ, discovery={
        "method": "GET", "url": "{canvas_base}" + PENDING_READ,
        "pick": "id"})
    sess = FakeSession()
    with pytest.raises(ex.CatalogNotProven):
        ex.dispatch_entry(entry, {"course_id": 1, "report_type": "x"},
                          sess, _pack())
    assert sess.calls == []


def test_dispatch_entry_refuses_pending_catalog_synthetic_entry():
    # Built directly, bypassing dispatch_catalog_op's own gate.
    entry = ex.catalog_descriptor_to_entry(
        "canvas_status_of_last_report", "GET", PENDING_READ)
    sess = FakeSession()
    with pytest.raises(ex.CatalogNotProven):
        ex.dispatch_entry(entry, {"course_id": 1, "report_type": "x"},
                          sess, _pack())
    assert sess.calls == []


def test_dispatch_entry_admits_live_proven_read():
    sess = FakeSession(lambda m, u, b: (200, {}, b'{"x": 1}'))
    out = ex.dispatch_entry(_read_entry(PROVEN_READ), {"course_id": 1},
                            sess, _pack())
    assert out["receipt"] == {"x": 1}
    assert [c[0] for c in sess.calls] == ["GET"]


def test_dispatch_undo_refuses_unproven_undo_block():
    entry = _read_entry(PROVEN_READ)
    entry["effects"] = "write"
    entry["request"]["method"] = "PUT"
    entry["undo"] = {"method": "POST",
                     "url": "{canvas_base}/api/v1/courses/{course_id}/nope"}
    sess = FakeSession()
    with pytest.raises(ex.CatalogNotProven):
        ex.dispatch_undo(entry, {"course_id": 1}, {}, "x", sess, _pack())
    assert sess.calls == []


# ----------------------------------------------------------------------
# 3/5. Write readback: three honest outcomes.
# ----------------------------------------------------------------------

def _readback(method, url, body, readback_handler, result_payload=None):
    sess = FakeSession(readback_handler)
    entry = {"name": "t_w", "provider": "canvas", "effects": "write",
             "auth": {"slot": "canvas_pat"}, "result": {}}
    out = ex.run_write_readback(entry, sess, _pack(), {"canvas_base": BASE},
                                {}, {}, method, url, body,
                                result_payload or {"id": 42})
    return out, sess


ASSIGNMENTS = BASE + "/api/v1/courses/7/assignments"


def test_zero_compared_fields_is_unverified_not_pass():
    out, _ = _readback("POST", ASSIGNMENTS, {"assignment": {"name": "A"}},
                       lambda m, u, b: (200, {}, b'{"id": 42}'))
    assert out["status"] == "unverified"


def test_unechoed_field_makes_readback_unverified():
    out, _ = _readback(
        "POST", ASSIGNMENTS, {"assignment": {"name": "A", "points": 5}},
        lambda m, u, b: (200, {}, b'{"id": 42, "name": "A"}'))
    assert out["status"] == "unverified"
    assert "points" in out["detail"]


def test_all_fields_matched_is_verified():
    out, _ = _readback(
        "POST", ASSIGNMENTS, {"assignment": {"name": "A", "points": 5}},
        lambda m, u, b: (200, {}, b'{"id": 42, "name": "A", "points": 5}'))
    assert out["status"] == "pass"


def test_nested_mismatch_is_a_proven_failure():
    body = {"assignment": {"name": "A",
                           "external_tool_tag_attributes": {"url": "https://a"}}}
    with pytest.raises(ex.WriteFieldMismatch):
        _readback("POST", ASSIGNMENTS, body, lambda m, u, b: (200, {}, json.dumps(
            {"id": 42, "name": "A",
             "external_tool_tag_attributes": {"url": "https://b"}}).encode()))


def test_nested_list_mismatch_is_a_proven_failure():
    body = {"assignment": {"name": "A",
                           "submission_types": ["online_upload"]}}
    with pytest.raises(ex.WriteFieldMismatch):
        _readback("POST", ASSIGNMENTS, body, lambda m, u, b: (200, {}, json.dumps(
            {"id": 42, "name": "A",
             "submission_types": ["online_text_entry"]}).encode()))


def test_nested_match_is_verified():
    body = {"assignment": {"name": "A",
                           "submission_types": ["a", "b"],
                           "external_tool_tag_attributes": {"url": "https://a"}}}
    out, _ = _readback("POST", ASSIGNMENTS, body, lambda m, u, b: (200, {}, json.dumps(
        {"id": 42, "name": "A", "submission_types": ["b", "a"],
         "external_tool_tag_attributes": {"url": "https://a",
                                          "new_tab": False}}).encode()))
    assert out["status"] == "pass"


@pytest.mark.parametrize("want,got", [("", None), (None, ""), ([], None),
                                      (None, []), ("", [])])
def test_empty_equivalents_match(want, got):
    assert ex._write_field_matches(want, got)


def test_non_empty_vs_null_still_mismatches():
    assert not ex._write_field_matches("x", None)


def test_cleared_field_stored_as_null_is_not_a_failure():
    out, _ = _readback(
        "PUT", ASSIGNMENTS + "/42",
        {"assignment": {"name": "A", "description": ""}},
        lambda m, u, b: (200, {}, b'{"id": 42, "name": "A", "description": null}'))
    assert out["status"] == "pass"


def test_delete_verified_by_absence():
    out, sess = _readback("DELETE", ASSIGNMENTS + "/42", None,
                          lambda m, u, b: (404, {}, b'{"errors": []}'))
    assert out["status"] == "pass"
    assert [c[0] for c in sess.calls] == ["GET"]


def test_delete_soft_deleted_state_is_verified():
    out, _ = _readback("DELETE", ASSIGNMENTS + "/42", None,
                       lambda m, u, b: (200, {}, b'{"id": 42, "workflow_state": "deleted"}'))
    assert out["status"] == "pass"


def test_delete_still_present_is_a_proven_failure():
    with pytest.raises(ex.WriteFieldMismatch):
        _readback("DELETE", ASSIGNMENTS + "/42", None,
                  lambda m, u, b: (200, {}, b'{"id": 42, "workflow_state": "published"}'))


def test_delete_without_member_route_is_unverified():
    out, sess = _readback("DELETE", BASE + "/api/v1/courses/7/usage_rights",
                          None, lambda m, u, b: (200, {}, b"{}"))
    assert out["status"] == "unverified"
    assert sess.calls == []


def _write_dispatch(entry, params, handler):
    plan = ex.FrozenPlan({
        "op_id": "11111111-1111-4111-8111-111111111111",
        "entry_name": entry["name"], "params": params,
        "before_state_digest": None,
        "frozen_readback": "course %s" % params["course_id"],
        "target_identity": {"course_id": params["course_id"],
                            "course_name": "Course"}}, "plan")
    rec = mint_approval(entry, params, tenant_base=BASE,
                        target_identity={"course_id": params["course_id"],
                                         "course_name": "Course"})
    sign_approval(rec, "test authorization basis for a hermetic write test",
                  channel="driver")
    sess = FakeSession(handler)
    out = ex.dispatch_entry(entry, params, sess, _pack(), plan=plan,
                            approval=rec, require_educator_channel=False)
    return out, sess


def _course_then(handler):
    def h(m, u, b):
        if m == "GET" and u.rstrip("/").endswith("/api/v1/courses/7"):
            return 200, {}, b'{"id": 7, "name": "Course"}'
        return handler(m, u, b)
    return h


def test_dispatch_result_reports_unverified_write():
    entry = ex.catalog_descriptor_to_entry(
        "canvas_create_assignment", "POST",
        "/api/v1/courses/{course_id}/assignments",
        extra={"body": {"assignment": {"name": "A"}}})
    out, _ = _write_dispatch(entry, {"course_id": "7"}, _course_then(
        lambda m, u, b: (200, {}, b'{"id": 42}')))
    assert out["outcome"] == "unverified"
    assert out["verified"] is False


def test_dispatch_result_reports_verified_write():
    entry = ex.catalog_descriptor_to_entry(
        "canvas_create_assignment", "POST",
        "/api/v1/courses/{course_id}/assignments",
        extra={"body": {"assignment": {"name": "A"}}})
    out, _ = _write_dispatch(entry, {"course_id": "7"}, _course_then(
        lambda m, u, b: (200, {}, b'{"id": 42, "name": "A"}')))
    assert out["outcome"] == "verified"
    assert out["verified"] is True


def test_catalog_cli_passes_request_body(monkeypatch):
    seen = {}

    def fake(name, method, path, effect_class, params, **kw):
        seen.update(kw)
        return {}

    monkeypatch.setattr(ex, "dispatch_catalog_op", fake)
    ex.main(["catalog", "--name", "canvas_create_assignment",
             "--method", "POST", "--path",
             "/api/v1/courses/{course_id}/assignments",
             "--params", '{"course_id": "7"}',
             "--body", '{"assignment": {"name": "A"}}', "--backend", "https"])
    assert seen["extra"] == {"body": {"assignment": {"name": "A"}}}


def test_catalog_cli_refuses_non_object_body():
    with pytest.raises(ex.ExecutorError):
        ex.main(["catalog", "--name", "canvas_create_assignment",
                 "--method", "POST", "--path",
                 "/api/v1/courses/{course_id}/assignments",
                 "--body", "[1]", "--backend", "https"])


# ----------------------------------------------------------------------
# 4. A params.* verify expectation compares the readback, not params.
# ----------------------------------------------------------------------

def test_verify_params_ref_compares_readback_value():
    verify = {"expect": {"name": "params.aname"}}
    with pytest.raises(ex.VerificationFailed):
        ex._assert_verify_expect({"name": "t"}, verify, {"name": "WRONG"},
                                 {"aname": "A"}, {}, {})


def test_verify_params_ref_passes_on_matching_readback():
    verify = {"expect": {"name": "params.aname"}}
    out = ex._assert_verify_expect({"name": "t"}, verify, {"name": "A"},
                                   {"aname": "A"}, {}, {})
    assert out["status"] == "pass"


# ----------------------------------------------------------------------
# 6. Truncation is surfaced and never breaks JSON structure.
# ----------------------------------------------------------------------

def test_oversized_json_list_truncates_by_items():
    items = [{"id": i, "name": "x" * 50} for i in range(100)]
    raw = json.dumps(items).encode()
    entry = {"name": "t", "result": {"max_bytes": 1000, "truncate": "tail"}}
    out = ex.apply_result_block(entry, raw, {"Content-Type": "application/json"})
    assert out["truncated"] is True
    assert isinstance(out["payload"], list)
    assert 0 < len(out["payload"]) < 100
    assert len(json.dumps(out["payload"]).encode()) <= 1000


def test_page_truncation_surfaces_in_dispatch_result():
    def handler(m, u, b):
        return 200, {"x-morrow-pagination": "page bound reached: partial",
                     "x-morrow-pagination-partial": "true",
                     "x-morrow-next-page": "/api/v1/courses/1/settings?page=11"}, b"[1]"
    out = ex.dispatch_entry(_read_entry(PROVEN_READ), {"course_id": 1},
                            FakeSession(handler), _pack())
    assert out["truncated"] is True
    assert "partial" in out["truncation"]["note"]
    assert out["truncation"]["next_page"].endswith("page=11")


def test_complete_pagination_not_marked_truncated():
    def handler(m, u, b):
        return 200, {"x-morrow-pagination": "complete: followed 2 pages"}, b"[1, 2]"
    out = ex.dispatch_entry(_read_entry(PROVEN_READ), {"course_id": 1},
                            FakeSession(handler), _pack())
    assert out["truncated"] is False


def test_chromium_page_bound_marks_partial_with_next_cursor():
    import chromium_session as cs

    class Transport:
        def __init__(self):
            self.n = 0

        def api(self, method, path, data=None, as_json=False, timeout=60,
                max_bytes=None):
            self.n += 1
            link = '<%s/api/v1/x?page=%d>; rel="next"' % (BASE, self.n + 1)
            return 200, {"link": link}, json.dumps([self.n])

    sess = cs.ChromiumSession.__new__(cs.ChromiumSession)
    sess._base = BASE
    t = Transport()
    status, headers, raw, _ = sess._paginated_get(
        t, "/api/v1/x", 10000, 200, {"link": '<%s/api/v1/x?page=2>; rel="next"' % BASE},
        "[0]", 1)
    assert headers.get("x-morrow-pagination-partial") == "true"
    assert "page=" in headers.get("x-morrow-next-page", "")
    assert json.loads(raw)[0] == 0


# ----------------------------------------------------------------------
# 7. Path parameters are validated and encoded.
# ----------------------------------------------------------------------

@pytest.mark.parametrize("value", [
    "1/users?include[]=email&per_page=100#", "../1", "..", "1#x", "1?x=1",
    "1\\2", "1\n", "", "abc", True, {"a": 1}, [1]])
def test_bad_path_params_refused(value):
    with pytest.raises(ex.ExecutorError):
        ex.render_template("{canvas_base}/api/v1/courses/{course_id}/settings",
                           {"canvas_base": BASE}, {"course_id": value})


@pytest.mark.parametrize("key,value", [
    ("course_id", 12), ("course_id", "12"),
    ("course_id", "sis_course_id:ABC-101"), ("user_id", "self"),
    ("url_or_id", "my-page"), ("tab_id", "context_external_tool_5")])
def test_good_path_params_render(key, value):
    url = ex.render_template("{canvas_base}/x/{%s}" % key,
                             {"canvas_base": BASE}, {key: value})
    assert url == BASE + "/x/" + str(value)


def test_query_position_params_are_encoded_not_refused():
    url = ex.render_template("{canvas_base}/x?search_term={q}",
                             {"canvas_base": BASE}, {"q": "a b/c&d"})
    assert url == BASE + "/x?search_term=a%20b%2Fc%26d"


def test_catalog_injection_via_course_id_refused():
    sess = FakeSession()
    with pytest.raises(ex.ExecutorError):
        ex.dispatch_catalog_op(
            "canvas_get_course_settings", "GET", PROVEN_READ,
            params={"course_id": "1/users?include[]=email&per_page=100#"},
            session=sess, pack=_pack())
    assert sess.calls == []


def test_request_off_tenant_host_refused():
    entry = _read_entry(PROVEN_READ)
    entry["request"]["url"] = "https://evil.example/api/v1/courses/{course_id}/settings"
    with pytest.raises(ex.ExecutorError):
        ex.build_request(entry, entry["request"], {"course_id": 1},
                         FakeSession(), _pack(), {"canvas_base": BASE}, {})


def test_raw_lane_redirect_off_host_refused():
    import urllib.request
    handler = ex._NoDowngradeRedirectHandler()
    req = urllib.request.Request(BASE + "/api/v1/courses/1")
    with pytest.raises(ex.ExecutorError):
        handler.redirect_request(req, None, 302, "Found", {},
                                 "https://evil.example/steal")


def test_raw_lane_redirect_same_host_followed():
    import urllib.request
    handler = ex._NoDowngradeRedirectHandler()
    req = urllib.request.Request(BASE + "/api/v1/courses/1")
    redir = handler.redirect_request(req, None, 302, "Found", {},
                                     BASE + "/api/v1/courses/2")
    assert redir.full_url == BASE + "/api/v1/courses/2"


# ----------------------------------------------------------------------
# 8. Secure defaults.
# ----------------------------------------------------------------------

@pytest.mark.parametrize("fn", ["dispatch_entry", "dispatch_catalog_op",
                                "dispatch_undo"])
def test_educator_channel_required_by_default(fn):
    param = inspect.signature(getattr(ex, fn)).parameters[
        "require_educator_channel"]
    assert param.default is True


# ----------------------------------------------------------------------
# 9. A non-learner read with author objects is not refused as
#    "unpairable"; author identifiers never reach the caller raw.
# ----------------------------------------------------------------------

TOPICS = "/api/v1/courses/{course_id}/pages"  # C-326, live-proven


def test_author_objects_are_not_an_unpairable_refusal():
    topics = [{"id": 5, "title": "Week 1",
               "author": {"id": 101, "display_name": "Jane Realstudent"}}]

    def handler(m, u, b):
        return 200, {}, json.dumps(topics).encode()

    try:
        out = ex.dispatch_entry(_read_entry(TOPICS), {"course_id": 7},
                                FakeSession(handler), _pack())
    except ex.ExecutorError as exc:
        assert "unpairable" not in str(exc)
        assert "cryptography" in str(exc)
        return
    assert "Jane Realstudent" not in json.dumps(out)
    assert "101" not in json.dumps(out["receipt"])
    assert "Student A" in json.dumps(out["receipt"])


# ----------------------------------------------------------------------
# 10. Mode-gated writes to a course need the course resolution.
# ----------------------------------------------------------------------

def _mode_write_entry():
    return ex.catalog_descriptor_to_entry(
        "canvas_create_assignment", "POST",
        "/api/v1/courses/{course_id}/assignments",
        extra={"body": {"assignment": {"name": "A"}}})


def test_mode_write_without_course_resolution_refused():
    with pytest.raises(ex.CourseResolutionRequired):
        ex.dispatch_entry(_mode_write_entry(), {"course_id": "7"},
                          FakeSession(), _pack(), dry_run=True,
                          mode_ctx={"user_id": "u1"})


def test_mode_write_resolution_for_other_course_refused():
    ctx = {"user_id": "u1", "course_resolution": {
        "course_id": "8", "confidence": 1.0, "user_confirmed": True}}
    with pytest.raises(ex.CourseResolutionRequired):
        ex.dispatch_entry(_mode_write_entry(), {"course_id": "7"},
                          FakeSession(), _pack(), dry_run=True, mode_ctx=ctx)


# ----------------------------------------------------------------------
# 2 (browser lane). The two-phase browser lane applies the same gate.
# ----------------------------------------------------------------------

def test_browser_lane_refuses_non_live_proven_entry():
    from transport import browser_backend as bb
    with pytest.raises(ex.CatalogNotProven):
        bb.dispatch_browser_entry(_read_entry(PENDING_READ),
                                  {"course_id": 1, "report_type": "x"},
                                  {}, _pack())


def test_browser_lane_refuses_unproven_undo_block():
    from transport import browser_backend as bb
    entry = _read_entry(PROVEN_READ)
    entry["effects"] = "write"
    entry["request"]["method"] = "PUT"
    entry["undo"] = {"method": "POST",
                     "url": "{canvas_base}/api/v1/courses/{course_id}/nope"}
    with pytest.raises(ex.CatalogNotProven):
        bb.dispatch_browser_undo(entry, {"course_id": 1}, {}, "x", {}, _pack())
