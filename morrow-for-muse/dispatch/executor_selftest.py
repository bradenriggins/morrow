#!/usr/bin/env python3
"""Selftest: no default-course fallback in provisioning.

Regression test for the 2026-09-20 audit finding: provision/provision.py
used to fall back to course 89585 (a real course) when no course_id
resolved. A failed resolution must now fail closed with an error, never
provision into a default course.

Covers (provision/provision.py fail-closed behavior only; the executor's
PROVISION step integration was removed 2026-09-21 under the standing
exclusions, so there is no executor-side provision path left to test):
  1. provision_build_token_memory() with no course_id -> ProvisionFailed.
  2. provision CLI with no --course-id -> exit 2, fail-closed report.
  3. The CLI parser carries no default course.
"""
import io
import json
import os
import sys
from contextlib import redirect_stdout

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "dispatch"), os.path.join(REPO, "provision")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402

import importlib.util as _ilu  # noqa: E402
_prov_spec = _ilu.spec_from_file_location(
    "morrow_provision_selftest",
    os.path.join(REPO, "provision", "provision.py"))
prov = _ilu.module_from_spec(_prov_spec)
_prov_spec.loader.exec_module(prov)

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


# 1. In-memory entry point: no course_id must raise ProvisionFailed.
try:
    prov.provision_build_token_memory()
    check("provision_build_token_memory() raises ProvisionFailed", False,
          "no exception raised")
except prov.ProvisionFailed as exc:
    check("provision_build_token_memory() raises ProvisionFailed", True)
    check("provision failure refuses a default course",
          "refusing to provision into a default course" in str(exc))
except Exception as exc:  # noqa: BLE001
    check("provision_build_token_memory() raises ProvisionFailed", False,
          "wrong exception: %r" % exc)

# 2. CLI: no --course-id must exit 2 with a fail-closed report.
buf = io.StringIO()
with redirect_stdout(buf):
    rc = prov.main([])
try:
    report = json.loads(buf.getvalue())
except ValueError:
    report = {}
check("CLI without --course-id exits 2", rc == 2, "rc=%r" % rc)
check("CLI report names the blocker",
      "refusing to provision into a default course" in report.get("blocker", ""),
      report.get("blocker", ""))

# 3. The parser carries no default course.
default = prov.build_parser().get_default("course_id")
check("CLI --course-id has no default", default is None, "default=%r" % default)

# 4. Journal dir/file modes: ensure_journal_dir tightens pre-existing
# loose paths (dir 0700, journal file 0600).
# Hygiene: never /tmp. Test scratch lives under this file's directory so it
# survives on the persistent workspace volume.
import stat as _stat
import tempfile as _tf
_SELFTEST_WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              ".selftest-work")
os.makedirs(_SELFTEST_WORK, exist_ok=True)
_hj = _tf.mkdtemp(prefix="morrow-journal-selftest-", dir=_SELFTEST_WORK)
_old_home, _old_journal = ex.MORROW_HOME, ex.JOURNAL_PATH
ex.MORROW_HOME = _hj
ex.JOURNAL_PATH = os.path.join(_hj, "journal", "ops.jsonl")
try:
    os.makedirs(os.path.join(_hj, "journal"), mode=0o755, exist_ok=True)
    os.chmod(_hj, 0o755)
    os.chmod(os.path.join(_hj, "journal"), 0o755)
    with open(ex.JOURNAL_PATH, "w", encoding="utf-8") as fh:
        fh.write("")
    os.chmod(ex.JOURNAL_PATH, 0o644)
    ex.ensure_journal_dir()
    check("journal home tightened to 0700",
          _stat.S_IMODE(os.stat(_hj).st_mode) == 0o700)
    check("journal dir tightened to 0700",
          _stat.S_IMODE(os.stat(os.path.join(_hj, "journal")).st_mode) == 0o700)
    check("journal file tightened to 0600",
          _stat.S_IMODE(os.stat(ex.JOURNAL_PATH).st_mode) == 0o600)
    ex.journal_append({"op_id": "mode-test", "entry_name": "t"})
    check("journal file stays 0600 after append",
          _stat.S_IMODE(os.stat(ex.JOURNAL_PATH).st_mode) == 0o600)
finally:
    ex.MORROW_HOME, ex.JOURNAL_PATH = _old_home, _old_journal

# 5. Quiz-api host derivation lives in provision.py (the deleted mint
#    chain's region infix is gone with it); the executor's PROVISION step
#    uses provision.quiz_api_base verbatim.
check("quiz-api host uses the provision derivation",
      prov.quiz_api_base("chcp") == "https://chcp.quiz-api.instructure.com")
try:
    prov.quiz_api_base("")
    check("quiz-api host rejects an empty tenant", False, "no exception")
except prov.ProvisionFailed:
    check("quiz-api host rejects an empty tenant", True)

# 6. Global default redaction (desktop defect audit item 15, 2026-09-20):
#    secret-ish keys are masked in every receipt even when the entry
#    declares no redact patterns.
_spec_noredact = {"name": "x"}
_body = json.dumps({
    "id": 4045372, "name": "Morrow Relay Proof (delete me)",
    "workflow_state": "unpublished",
    "secure_params": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.SIGNED",
    "sesskey": "abc123sessionkey",
    "lti_context_id": "4005c9ae-0180-4287-800a-b0339c8001e7",
}).encode("utf-8")
_res = ex.apply_result_block(_spec_noredact, _body, {})
_rc = _res["receipt"]
check("secure_params masked with no entry redact list",
      _rc.get("secure_params") == ex.REDACTED, _rc.get("secure_params"))
check("sesskey masked with no entry redact list",
      _rc.get("sesskey") == ex.REDACTED, _rc.get("sesskey"))
check("non-secret fields survive default redaction",
      _rc.get("id") == 4045372
      and _rc.get("workflow_state") == "unpublished"
      and _rc.get("lti_context_id") == "4005c9ae-0180-4287-800a-b0339c8001e7",
      _rc)
check("default redact list is non-empty and covers token-ish keys",
      len(ex.DEFAULT_REDACT_PATTERNS) > 0
      and "secure_params" in ex.DEFAULT_REDACT_PATTERNS
      and "token" in ex.DEFAULT_REDACT_PATTERNS)

# ----------------------------------------------------------------------
# New Quiz lane (P0-2, P0-4, P0-7): unit checks, no live network.
# ----------------------------------------------------------------------

_QZ = "https://courses.example.test"


def _refused(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except ex.NewQuizRefused:
        return True
    except Exception:  # noqa: BLE001 - any other outcome is not a refusal
        return False
    return False


# 1. PUT guard: New Quiz updates use PATCH, never PUT.
_put_url = _QZ + "/quiz/v1/courses/89585/quizzes/4045374/items/11028169"
check("PUT on New Quiz path raises NewQuizRefused",
      _refused(ex.guard_new_quiz_request, {"name": "canvas_update_quiz_item"},
               "PUT", _put_url, {}))
check("PUT on quiz-API draw path raises NewQuizRefused",
      _refused(ex.guard_new_quiz_request, {"name": "draw"},
               "PUT", "https://chcp.quiz-api-iad-prod.instructure.com/api/quizzes/b1/quiz_entries/e1", {}))
try:
    ex.guard_new_quiz_request({"name": "canvas_update_quiz_item"}, "PATCH", _put_url, {})
    check("PATCH on New Quiz path passes the guard", True)
except ex.NewQuizRefused as exc:
    check("PATCH on New Quiz path passes the guard", False, str(exc))
try:
    ex.guard_new_quiz_request({"name": "canvas_edit_assignment"}, "PUT",
                              _QZ + "/api/v1/courses/89585/assignments/4045373", {})
    check("PUT on a classic assignment path passes the guard", True)
except ex.NewQuizRefused as exc:
    check("PUT on a classic assignment path passes the guard", False, str(exc))
try:
    ex.guard_new_quiz_request({"name": "canvas_get_new_quiz"}, "GET", _put_url, {})
    check("GET reads pass the guard untouched", True)
except ex.NewQuizRefused as exc:
    check("GET reads pass the guard untouched", False, str(exc))

# The guard also fires inside build_request (https lane choke point),
# before any session or network use.
_try_block = {"method": "PUT", "url": _put_url}
try:
    ex.build_request({"name": "canvas_update_quiz_item"}, _try_block,
                     {}, None, {}, {}, {})
    check("build_request refuses PUT on a New Quiz path", False, "no exception")
except ex.NewQuizRefused:
    check("build_request refuses PUT on a New Quiz path", True)
except Exception as exc:  # noqa: BLE001
    check("build_request refuses PUT on a New Quiz path", False,
          "wrong exception: %r" % exc)

# 2. Settings: complete merged block, stale settings refuse.
_saved = {"title": "Q1", "shuffle_answers": True,
          "session_time_limit_in_seconds": 60,
          "filters": {"ips": ["10.0.0.1"], "lockdown_browser": False},
          "multiple_attempts": {"allowed_attempts": 2},
          "result_view_settings": {"show_correct_answers": True}}
_requested = {"shuffle_answers": False,
              "session_time_limit_in_seconds": None,
              "filters": {"ips": None}}
_plan = ex.plan_new_quiz_settings(_saved, _requested)
_block = _plan["block"]
check("settings merge keeps unrequested keys",
      _block["title"] == "Q1" and _block["result_view_settings"]["show_correct_answers"] is True)
check("settings merge applies the reviewed change",
      _block["shuffle_answers"] is False)
check("settings cleared top-level value uses the saved form (0)",
      _block["session_time_limit_in_seconds"] == 0)
check("settings cleared nested value uses the saved form ([])",
      _block["filters"]["ips"] == [])
check("settings nested merge preserves untouched leaves",
      _block["filters"]["lockdown_browser"] is False
      and _block["multiple_attempts"]["allowed_attempts"] == 2)
check("settings report names carried-over keys",
      "title" in _plan["preserved"] and "result_view_settings.show_correct_answers" in _plan["preserved"],
      _plan["preserved"])
check("settings report names changed keys",
      "shuffle_answers" in _plan["changed"]
      and "session_time_limit_in_seconds" in _plan["changed"]
      and "filters.ips" in _plan["changed"],
      _plan["changed"])
check("settings saved block is not mutated",
      _saved["shuffle_answers"] is True and _saved["filters"]["ips"] == ["10.0.0.1"])
for _bad in (None, {}, "settings", []):
    check("unreadable saved settings refuse (%r)" % (_bad,),
          _refused(ex.plan_new_quiz_settings, _bad, {"title": "x"}))
_req = ex.new_quiz_settings_request("89585", "4045374", _block)
check("settings request uses PATCH on the quiz route",
      _req["method"] == "PATCH"
      and _req["path"] == "/quiz/v1/courses/89585/quizzes/4045374")
check("settings request carries the complete merged block under quiz.quiz_settings",
      _req["body"]["quiz"]["quiz_settings"] == _block)
_ok, _mm = ex.new_quiz_settings_match(
    {"session_time_limit_in_seconds": None, "filters": {"ips": None}, "shuffle_answers": False},
    {"session_time_limit_in_seconds": 0, "filters": {"ips": []}, "shuffle_answers": False})
check("readback accepts the saved form of cleared values", _ok and not _mm, _mm)
_ok2, _mm2 = ex.new_quiz_settings_match({"shuffle_answers": False}, {"shuffle_answers": True})
check("readback mismatch is reported", not _ok2 and _mm2, _mm2)
_ok3, _mm3 = ex.new_quiz_settings_match(
    {"shuffle_answers": True},
    {"shuffle_answers": True, "filters": {"ips": []}})
check("readback-only empty provider default is tolerated",
      _ok3 and not _mm3, _mm3)
_ok4, _mm4 = ex.new_quiz_settings_match(
    {"shuffle_answers": True},
    {"shuffle_answers": True, "filters": {"ips": ["10.0.0.1"]}})
check("readback-only non-empty key is still flagged",
      not _ok4 and _mm4, _mm4)


class _FakeSettingsReadbackSession:
    def __init__(self, body):
        self._body = body

    def raw_request(self, method, url, headers, body_bytes,
                    is_write=False, max_bytes=None):
        import json as _json
        return 200, {}, _json.dumps(self._body).encode("utf-8"), 1

    def base_for(self, provider):
        return _QZ


_settings_entry = {"name": "canvas_update_single_quiz", "provider": "canvas",
                   "effects": "write",
                   "request": {"method": "PATCH",
                               "url": _QZ + "/api/quiz/v1/courses/89585/quizzes/4045374"}}
_settings_url = _QZ + "/api/quiz/v1/courses/89585/quizzes/4045374"
_settings_body = {"quiz": {"quiz_settings": {"shuffle_answers": True,
                                             "one_question_at_a_time": False}}}


def _settings_readback(readback_body, body=_settings_body, url=_settings_url):
    sess = _FakeSettingsReadbackSession(readback_body)
    return ex.run_write_readback(
        dict(_settings_entry, request={"method": "PATCH", "url": url}),
        sess, {}, {"canvas_base": _QZ}, {}, {},
        "PATCH", url, body, {"id": 4045374})


_r = _settings_readback({"id": 4045374, "quiz_settings": {"shuffle_answers": True,
                                                          "one_question_at_a_time": False}})
check("settings write readback verifies the echoed quiz_settings block",
      _r["status"] == "pass" and "quiz_settings" in _r["detail"], _r)
try:
    _settings_readback({"id": 4045374, "quiz_settings": {"shuffle_answers": False,
                                                        "one_question_at_a_time": False}})
    check("settings readback mismatch raises WriteFieldMismatch", False,
          "no exception")
except ex.WriteFieldMismatch as _exc:
    check("settings readback mismatch raises WriteFieldMismatch",
          "quiz_settings" in str(_exc), str(_exc)[:120])
_r = _settings_readback({"id": 4045374, "title": "T"})
check("settings readback skips when the provider does not echo quiz_settings",
      _r["status"] == "pass" and "quiz_settings" not in _r["detail"], _r)
_item_url = _settings_url + "/items/11028169"
_r = _settings_readback({"id": 11028169, "title": "I"},
                        body={"item": {"title": "I"}}, url=_item_url)
check("item PATCH is not treated as a settings write", _r["status"] == "pass"
      and "quiz_settings" not in _r["detail"], _r)
_planned = ex.plan_new_quiz_settings({"access_code": "ABC", "shuffle_answers": True},
                                     {"access_code": None})
_r = _settings_readback({"id": 4045374, "quiz_settings": {"access_code": None,
                                                         "shuffle_answers": True}},
                        body={"quiz": {"quiz_settings": _planned["block"]}})
check("settings readback accepts the cleared form of a cleared leaf",
      _r["status"] == "pass", _r)

# 3. Interaction-id preservation: only an exactly-unchanged id set
# passes; any membership change (add, remove, or rename) is refused
# (ghost-stub production finding).
_ids = {"c1", "c2", "c3"}
check("add-only id change is refused",
      _refused(ex.check_interaction_ids_preserved,
               _ids, {"c1", "c2", "c3", "c4"}))
check("remove-only id change is refused",
      _refused(ex.check_interaction_ids_preserved, _ids, {"c1", "c2"}))
check("unchanged ids pass",
      ex.check_interaction_ids_preserved(_ids, {"c1", "c2", "c3"}) == "unchanged")
check("rename (add plus remove) is refused",
      _refused(ex.check_interaction_ids_preserved, _ids, {"c1", "c2", "c9"}))
_gathered = ex.collect_interaction_ids(
    {"choices": [{"id": "c1", "item_body": "a"}, {"id": 7, "item_body": "b"}],
     "questions": [{"id": "q1", "answers": [{"id": "a1"}, {"id": "a2"}]}],
     "blanks": [{"children": [{"id": "b1"}]}]})
check("interaction ids are collected from nested sub-elements",
      _gathered == {"c1", "7", "q1", "a1", "a2", "b1"}, _gathered)

# 4. 506477 refusal on every New Quiz write path.
_bad_quiz = _QZ + "/quiz/v1/courses/89585/quizzes/506477"
check("PATCH to 506477 is refused",
      _refused(ex.guard_new_quiz_request, {"name": "canvas_update_single_quiz"},
               "PATCH", _bad_quiz, {}))
check("DELETE of 506477 via the quiz route is refused",
      _refused(ex.guard_new_quiz_request, {"name": "canvas_delete_new_quiz"},
               "DELETE", _bad_quiz, {}))
check("506477 in params is refused on a New Quiz path",
      _refused(ex.guard_new_quiz_request, {"name": "canvas_update_quiz_item"},
               "PATCH", _put_url, {"quiz_id": 506477}))
check("draw write against 506477 is refused",
      _refused(ex.build_quiz_draw_update, "506477", "e1", 5, 3, "synthetic-token"))
try:
    ex.guard_new_quiz_request({"name": "canvas_get_new_quiz"}, "GET", _bad_quiz, {})
    check("GET read of 506477 still passes", True)
except ex.NewQuizRefused as exc:
    check("GET read of 506477 still passes", False, str(exc))

# 5. Canonical delete: quiz API route only; assignment-endpoint refused.
_del = ex.new_quiz_delete_request("89585", "4045374")
check("canonical delete is DELETE on the quiz API route",
      _del["method"] == "DELETE"
      and _del["path"] == "/quiz/v1/courses/89585/quizzes/4045374")
check("assignment-endpoint delete of a quiz is refused",
      _refused(ex.guard_new_quiz_request,
               {"name": "canvas_delete_new_quiz", "new_quiz": True}, "DELETE",
               _QZ + "/api/v1/courses/89585/assignments/4045374",
               {"is_quiz_lti_assignment": True}))
try:
    ex.guard_new_quiz_request({"name": "canvas_delete_new_quiz"}, "DELETE",
                              _QZ + "/quiz/v1/courses/89585/quizzes/4045374", {})
    check("quiz API route delete passes the guard", True)
except ex.NewQuizRefused as exc:
    check("quiz API route delete passes the guard", False, str(exc))
try:
    ex.guard_new_quiz_request({"name": "canvas_delete_assignment"}, "DELETE",
                              _QZ + "/api/v1/courses/89585/assignments/4045373", {})
    check("classic assignment delete passes the guard", True)
except ex.NewQuizRefused as exc:
    check("classic assignment delete passes the guard", False, str(exc))

# 6. Stimulus create/update stays refused as targets.
check("stimulus item create is refused",
      _refused(ex.guard_new_quiz_request, {"name": "canvas_create_stimulus"},
               "POST", _QZ + "/quiz/v1/courses/89585/quizzes/4045374/items", {}))
check("stimulus item update is refused",
      _refused(ex.guard_new_quiz_request, {"name": "canvas_update_stimulus"},
               "PATCH", _put_url, {}))

# 7. Draw flow: build_token assertion and PATCH payload contract.
_draw = ex.build_quiz_draw_update("builder-9", "entry-3", 5, 3, "synthetic-token")
check("draw request is PATCH on quiz_entries",
      _draw["method"] == "PATCH"
      and _draw["path"] == "/api/quizzes/builder-9/quiz_entries/entry-3")
check("draw payload carries the exact contract",
      _draw["body"] == {"quiz_entry": {"points_possible": 5,
                                       "properties": {"sample_num": 3}}},
      _draw["body"])
check("draw credential is the build token descriptor, never placeholder material",
      _draw["credential"] == "quiz.build_token")
check("missing build token refuses the draw dispatch",
      _refused(ex.build_quiz_draw_update, "builder-9", "entry-3", 5, 3, ""))
for _bad_n in (0, -1, 1.5, True, "3", None):
    check("non positive whole sample_num refuses (%r)" % (_bad_n,),
          _refused(ex.build_quiz_draw_update, "builder-9", "entry-3", 5, _bad_n, "t"))
try:
    ex.assert_draw_row_allowed({"entry_type": "Bank", "bank_id": "b1"}, "b1")
    check("draw row from the named bank passes", True)
except ex.NewQuizRefused as exc:
    check("draw row from the named bank passes", False, str(exc))
check("question row draw update is refused",
      _refused(ex.assert_draw_row_allowed, {"entry_type": "Item"}, "b1"))
check("draw row from another bank is refused",
      _refused(ex.assert_draw_row_allowed,
               {"entry_type": "BankEntry", "entry": {"bank_id": "b2"}}, "b1"))

# 8. Move-from-quiz-entry: question-row check and same-course guard.
_row = {"entry_type": "Item", "entry_id": "q-44"}
_mv = ex.build_move_from_quiz_entry("bank-7", "quiz-9", _row, "q-44",
                                    "89585", "89585", {"quiz_entry_id": "q-44"})
check("move request posts to the move_from_quiz_entry route",
      _mv["method"] == "POST"
      and _mv["path"] == "/api/banks/bank-7/bank_entries/move_from_quiz_entry"
      and _mv["query"] == {"source_quiz_id": "quiz-9"})
check("move row of the wrong type is refused",
      _refused(ex.build_move_from_quiz_entry, "bank-7", "quiz-9",
               {"entry_type": "Bank"}, "q-44", "89585", "89585", {}))
check("move of a different question id is refused",
      _refused(ex.build_move_from_quiz_entry, "bank-7", "quiz-9",
               _row, "q-99", "89585", "89585", {}))
check("move across courses is refused by the same-course guard",
      _refused(ex.build_move_from_quiz_entry, "bank-7", "quiz-9",
               _row, "q-44", "11111", "89585", {}))
check("move without a frozen reviewed body is refused",
      _refused(ex.build_move_from_quiz_entry, "bank-7", "quiz-9",
               _row, "q-44", "89585", "89585", None))
check("move touching 506477 is refused",
      _refused(ex.build_move_from_quiz_entry, "bank-7", "506477",
               _row, "q-44", "89585", "89585", {}))

# 9. Tag pre-send checks (defect #529): resolve by value, refuse when absent.
_tags = [{"value": "chapter-3", "id": "t1"}, {"value": "review", "id": "t2"}]
check("tag resolves by value from the account list",
      ex.resolve_tag_by_value(_tags, "chapter-3") == {"value": "chapter-3", "id": "t1"})
check("absent tag value refuses before send",
      _refused(ex.resolve_tag_by_value, _tags, "nope"))
check("ambiguous tag value refuses before send",
      _refused(ex.resolve_tag_by_value,
               _tags + [{"value": "review", "id": "t3"}], "review"))
try:
    ex.assert_question_carries_tag(_tags, "review")
    check("carried tag passes the pre-send check", True)
except ex.NewQuizRefused as exc:
    check("carried tag passes the pre-send check", False, str(exc))
check("tag the question does not carry refuses before send",
      _refused(ex.assert_question_carries_tag, _tags, "finals"))

print("pass: %d" % len(PASS))
# W2-P2-7: Retry-After parsing, numeric and HTTP-date forms.
check("retry_after numeric seconds",
      ex._retry_after_delay({"Retry-After": "7"}) == 7.0)
check("retry_after header name case-insensitive",
      ex._retry_after_delay({"retry-after": "7"}) == 7.0)
check("retry_after clamped to cap",
      ex._retry_after_delay({"Retry-After": "9999"}) == float(ex.RETRY_AFTER_CAP_S))
check("retry_after absent returns None",
      ex._retry_after_delay({}) is None)
check("retry_after garbage returns None",
      ex._retry_after_delay({"Retry-After": "soon"}) is None)
from datetime import timedelta as _td
_future = (ex.datetime.now(ex.timezone.utc)
           + _td(seconds=30)).strftime("%a, %d %b %Y %H:%M:%S GMT")
_d = ex._retry_after_delay({"Retry-After": _future})
check("retry_after http-date parsed",
      _d is not None and 0 < _d <= 30, repr(_d))
_past = (ex.datetime.now(ex.timezone.utc)
         - _td(seconds=30)).strftime("%a, %d %b %Y %H:%M:%S GMT")
check("retry_after http-date in past clamps to zero",
      ex._retry_after_delay({"Retry-After": _past}) == 0.0)

# W4-P2-7: redirect policy on the provider HTTPS lane. The handler's
# redirect_request is the pre-send hook (http_error_30x calls it
# before opening the redirected URL), so refusing there means no
# request bytes ever reach the downgraded target. In the real flow
# http_error_30x absolutizes Location via urljoin first, so these
# unit calls use absolute targets, exactly what the handler sees.
import email.message as _em
import urllib.request as _urlreq
_redir_handler = ex._NoDowngradeRedirectHandler()
_fake_headers = _em.Message()


def _redir(url, target):
    return _redir_handler.redirect_request(
        _urlreq.Request(url), None, 302, "Found", _fake_headers, target)


def _refuses(url, target):
    try:
        _redir(url, target)
    except ex.RedirectDowngradeRefused:
        return True
    except Exception:  # noqa: BLE001 - any other outcome is not a refusal
        return False
    return False


check("https->http downgrade is refused",
      _refuses("https://provider.example/v1/x", "http://provider.example/v1/y"))
check("https->http downgrade to another host is refused",
      _refuses("https://provider.example/v1/x", "http://evil.example/y"))
check("https->https redirect is still followed",
      (lambda r: r is not None
       and r.full_url == "https://provider.example/v1/y")(
          _redir("https://provider.example/v1/x",
                 "https://provider.example/v1/y")))
_r = _redir_handler.redirect_request(
    _urlreq.Request("https://provider.example/v1/x",
                    headers={"Authorization": "Bearer FAKE",
                             "Proxy-Authorization": "Basic RkFLRQ=="}),
    None, 302, "Found", _fake_headers, "https://other.example/v1/y")
check("cross-host redirect strips Authorization",
      _r.get_header("Authorization") is None)
check("cross-host redirect strips Proxy-Authorization",
      _r.get_header("Proxy-Authorization") is None)
_r = _redir_handler.redirect_request(
    _urlreq.Request("https://provider.example/v1/x",
                    headers={"Authorization": "Bearer FAKE"}),
    None, 302, "Found", _fake_headers, "https://provider.example/v1/y")
check("same-host same-scheme redirect keeps Authorization",
      _r.get_header("Authorization") == "Bearer FAKE")
check("http->http redirect is followed (plaintext stays plaintext)",
      (lambda r: r is not None
       and r.full_url == "http://provider.example/v1/y")(
          _redir("http://provider.example/v1/x",
                 "http://provider.example/v1/y")))

# LANE2-D1: a deterministic non-retryable read failure must fail fast
# (exactly one attempt), not burn all MAX_ATTEMPTS on retries.
_attempts = {"n": 0}
_real_do_request = ex._do_request


def _boom(*a, **k):
    _attempts["n"] += 1
    raise ValueError("boom: deterministic non-retryable error")


ex._do_request = _boom
try:
    ex.request_with_retry("GET", "https://example.invalid/x", {}, None,
                          is_write=False)
    check("non-retryable read error raises", False, "no exception raised")
except ex.ExecutorError:
    check("non-retryable read error raises ExecutorError", True)
except Exception as exc:  # noqa: BLE001
    check("non-retryable read error raises ExecutorError", False,
          "wrong exception: %r" % exc)
finally:
    ex._do_request = _real_do_request
check("non-retryable read error is not retried",
      _attempts["n"] == 1, "attempts=%d" % _attempts["n"])

# ... and a genuinely retryable read failure still retries.
_attempts2 = {"n": 0}


def _flaky(*a, **k):
    _attempts2["n"] += 1
    if _attempts2["n"] < 3:
        raise ConnectionRefusedError("refused")
    return 200, {}, b"{}"


_real_backoff = ex._backoff_sleep
ex._do_request = _flaky
ex._backoff_sleep = lambda attempt: None
try:
    st, _h, _b, _n = ex.request_with_retry(
        "GET", "https://example.invalid/x", {}, None, is_write=False)
    check("retryable read error recovers", st == 200)
except Exception as exc:  # noqa: BLE001
    check("retryable read error recovers", False, "raised %r" % exc)
finally:
    ex._do_request = _real_do_request
    ex._backoff_sleep = _real_backoff
check("retryable read error is retried",
      _attempts2["n"] == 3, "attempts=%d" % _attempts2["n"])

for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("all executor selftests passed")
