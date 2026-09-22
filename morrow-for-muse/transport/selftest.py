#!/usr/bin/env python3
"""Selftest for the browser-task transport: render + parse + state.

No browser needed. Run: python3 transport/selftest.py
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import batch
import state


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (" : " + detail if detail and not cond else ""))
    if not cond:
        raise SystemExit("selftest failed at: " + name)


def main():
    get_ops = [
        {"op_id": "op-get-self", "method": "GET", "path": "/api/v1/users/self"},
        {"op_id": "op-get-assign", "method": "GET",
         "path": "/api/v1/courses/89585/assignments"},
    ]
    write_ops = [
        {"op_id": "op-create", "method": "POST",
         "path": "/api/v1/courses/89585/assignments",
         "fields": {"assignment[name]": "Weasel Batch Proof (delete me)"}},
        {"op_id": "op-rename", "method": "PUT",
         "path": "/api/v1/courses/89585/assignments/1",
         "fields": {"assignment[name]": "Renamed"}},
        {"op_id": "op-delete", "method": "DELETE",
         "path": "/api/v1/courses/89585/assignments/1"},
    ]

    # ---- FAIL-CLOSED: the form lane is retired; every form write raises ----
    for wop in write_ops:
        try:
            batch.render_brief([wop], "https://chcp.instructure.com",
                               batch_id="fail-closed")
            check("form write fails closed: %s" % wop["method"], False)
        except batch.FormTransportUnavailable as exc:
            msg = str(exc)
            check("form write fails closed: %s" % wop["method"], True)
            check("blocker names the retired lane",
                  "retired" in msg)
            check("blocker points at the live Chromium lane",
                  "helper Chromium" in msg)
    # Mixed batch (GET + write) also fails closed: no partial brief.
    try:
        batch.render_brief(get_ops + write_ops[:1],
                           "https://chcp.instructure.com",
                           batch_id="fail-closed-mixed")
        check("mixed batch fails closed", False)
    except batch.FormTransportUnavailable:
        check("mixed batch fails closed", True)

    # ---- relay_url is gone: the kwarg no longer exists ----
    try:
        batch.render_brief(write_ops[:1], "https://chcp.instructure.com",
                           batch_id="dead-relay-kwarg",
                           relay_url="https://meetmorrow.app/morrow/form-relay/")
        check("relay_url kwarg is rejected", False)
    except TypeError:
        check("relay_url kwarg is rejected", True)

    # ---- LANE2-D4: the fetch brief fails closed on a missing CSRF token ----
    _csrf_op = [{"op_id": "f-csrf", "kind": "fetch", "method": "POST",
                 "url": "https://chcp.instructure.com/api/v1/x",
                 "headers": {"X-CSRF-Token": {"harvest": "csrf_token"}},
                 "body": None}]
    _csrf_brief = batch.render_brief(_csrf_op, "https://chcp.instructure.com",
                                     batch_id="csrf-instruction")
    check("brief instructs CSRF_MISSING when the token cookie is absent",
          "CSRF_MISSING" in _csrf_brief
          and "do NOT send the" in _csrf_brief)

    # ---- FETCH ops: a mixed batch with a form write fails closed ----
    mixed_fetch = [{"op_id": "f1", "kind": "fetch", "method": "GET",
                    "url": "https://chcp.instructure.com/api/v1/x",
                    "headers": {}}] + write_ops[:1]
    try:
        batch.render_brief(mixed_fetch, "https://chcp.instructure.com",
                           batch_id="fetch-write-mix")
        check("fetch+write mix fails closed", False)
    except batch.FormTransportUnavailable:
        check("fetch+write mix fails closed", True)

    # ---- GET-only brief still renders: reads work through the browser ----
    brief = batch.render_brief(get_ops, "https://chcp.instructure.com",
                               principal={"id": 28206, "name": "Braden Riggins"},
                               batch_id="selftest-1")
    check("brief contains base", "https://chcp.instructure.com" in brief)
    check("brief contains all op_ids",
          all(o["op_id"] in brief for o in get_ops))
    check("brief navigates for GET",
          "https://chcp.instructure.com/api/v1/courses/89585/assignments" in brief)
    check("brief has session check", "users/self" in brief and "session_dead" in brief)
    check("brief forbids credential reporting",
          "NEVER report cookie values" in brief)
    check("brief forbids UI automation", "not UI automation" in brief)
    check("brief has RESULTS_JSON contract", "RESULTS_JSON" in brief)
    check("brief has principal", "28206" in brief and "Braden Riggins" in brief)
    check("brief has no hosted form-helper URL",
          "form-helper.meetmorrow.app" not in brief)
    check("brief has no third-party form builder", "squarefree" not in brief)
    check("brief never mentions a form renderer",
          "EDITOR CHAIN" not in brief and "tryit" not in brief
          and "w3schools" not in brief)

    # form_host is deprecated and ignored: any value is accepted and
    # never appears in the brief.
    for host in ("https://forms.example/x", "bogus://ignored",
                 "http://10.0.0.1:8080/"):
        brief_h = batch.render_brief(get_ops[:1], "https://x.instructure.com",
                                     form_host=host)
        check("form_host ignored: %s" % host, host not in brief_h)

    # principal=None variant (fresh educator, unknown principal)
    brief2 = batch.render_brief(get_ops[:1], "https://x.instructure.com")
    check("brief works without principal", "user profile" in brief2)

    # batch splitting
    many = [{"op_id": "op-%d" % i, "method": "GET",
             "path": "/api/v1/users/self"} for i in range(40)]
    chunks = batch.split_batches(many)
    check("split_batches chunks", len(chunks) == 3 and len(chunks[0]) == 15
          and len(chunks[2]) == 10, str([len(c) for c in chunks]))

    # oversize batch refused
    try:
        batch.render_brief(many, "https://x.instructure.com")
        check("oversize batch refused", False)
    except ValueError:
        check("oversize batch refused", True)

    # destination confinement: base must be https with a host
    for bad_base in ("http://chcp.instructure.com", "chcp.instructure.com",
                     "https://", "", "ftp://x.example/y"):
        try:
            batch.render_brief(get_ops[:1], bad_base)
            check("non-https base refused: %r" % bad_base, False)
        except ValueError:
            check("non-https base refused: %r" % bad_base, True)

    # destination confinement: every rendered op URL stays on the base origin
    check("op urls confined to tenant origin",
          "https://chcp.instructure.com/api/v1/courses/89585/assignments"
          in brief)

    # _confine_action fails closed on an escaping action
    try:
        batch._confine_action("https://evil.example/x",
                              batch._origin_of("https://chcp.instructure.com"))
        check("escaping action refused", False)
    except ValueError:
        check("escaping action refused", True)
    check("same-origin action allowed",
          batch._confine_action(
              "https://chcp.instructure.com/api/v1/x",
              batch._origin_of("https://chcp.instructure.com/"))
          == "https://chcp.instructure.com/api/v1/x")

    # bad method refused
    try:
        batch.render_brief([{"op_id": "x", "method": "PATCH", "path": "/a"}],
                           "https://x.instructure.com")
        check("bad method refused", False)
    except ValueError:
        check("bad method refused", True)

    # parse: RESULTS_JSON path
    report = (
        "op-get-self | 200 | {\"id\": 28206}\n"
        "op-get-assign | 200 | [{\"id\": 99}]\n"
        "RESULTS_JSON\n"
        + json.dumps([{"op_id": "op-get-self", "status": 200, "body": "{\"id\": 28206}"},
                      {"op_id": "op-get-assign", "status": 200, "body": "[{\"id\": 99}]"}])
    )
    parsed = batch.parse_results(report)
    check("parse RESULTS_JSON", not parsed["session_dead"]
          and len(parsed["results"]) == 2
          and parsed["results"][1]["op_id"] == "op-get-assign"
          and parsed["results"][1]["status"] == 200)

    # parse: line fallback
    parsed2 = batch.parse_results("op-a | 404 | {\"errors\": []}\n")
    check("parse line fallback", len(parsed2["results"]) == 1
          and parsed2["results"][0]["status"] == 404)

    # parse: session_dead
    parsed3 = batch.parse_results("session_dead")
    check("parse session_dead", parsed3["session_dead"] is True)

    # parse: garbage never raises
    parsed4 = batch.parse_results("totally unstructured prose about nothing")
    check("parse garbage safe", parsed4["results"] == []
          and parsed4["session_dead"] is False)

    # parse: CSRF_MISSING sentinel (LANE2-D4)
    _csrf_json = ("op-c | 000 | whatever\nRESULTS_JSON\n"
                  + json.dumps([{"op_id": "op-c", "status": 0,
                                 "body": "CSRF_MISSING"}]))
    _csrf_parsed = batch.parse_results(_csrf_json)
    check("parse marks CSRF_MISSING sentinel",
          len(_csrf_parsed["results"]) == 1
          and _csrf_parsed["results"][0]["csrf_missing"] is True)
    _csrf_line = batch.parse_results("op-c | 000 | CSRF_MISSING\n")
    check("parse marks CSRF_MISSING on line fallback",
          len(_csrf_line["results"]) == 1
          and _csrf_line["results"][0]["csrf_missing"] is True)
    check("parse leaves ordinary bodies unmarked",
          parsed["results"][0]["csrf_missing"] is False)

    # state: secrets refused
    try:
        state._reject_secrets({"canvas": {"cookies": {"a": "b"}}})
        check("state rejects cookie keys", False)
    except ValueError:
        check("state rejects cookie keys", True)
    try:
        state._reject_secrets({"x": "y", "auth_token": "zzz"})
        check("state rejects token keys", False)
    except ValueError:
        check("state rejects token keys", True)

    # LANE2-D5: concurrent writers must not share one staging path.
    # Threads of a process share a pid, so the staging name is pid-
    # AND thread-unique. The hammer below redirects STATE_PATH into
    # scratch (never the real lane state) and proves the file stays
    # valid JSON under thread contention.
    import threading as _st_threading
    _st_tmp_paths = set()
    # A barrier keeps all workers alive while they record: thread
    # idents are only unique among living threads.
    _st_ub = _st_threading.Barrier(8)

    def _st_collect():
        _st_ub.wait()
        _st_tmp_paths.add(state._tmp_path())
        _st_ub.wait()

    _st_threads = [_st_threading.Thread(target=_st_collect) for _ in range(8)]
    for _t in _st_threads:
        _t.start()
    for _t in _st_threads:
        _t.join()
    check("state staging path is unique per thread", len(_st_tmp_paths) == 8)

    # Scratch lives under ~/workspace (never /tmp): honor the
    # campaign scratch env when present.
    _st_root = (os.environ.get("MORROW_SELFTEST_SCRATCH")
                or os.path.expanduser("~/workspace/audits/earthshake-2026-09-22/scratch-lane2-b"))
    _st_dir = os.path.join(_st_root, "state-concurrency")
    os.makedirs(_st_dir, exist_ok=True)
    _st_real_path = state.STATE_PATH
    state.STATE_PATH = os.path.join(_st_dir, "browser_lane.json")
    try:
        _st_barrier = _st_threading.Barrier(16)

        def _st_saver(i):
            _st_barrier.wait()
            for _n in range(10):
                # Varying name lengths: records of different byte
                # lengths are what turned a shared staging path into
                # corrupt JSON (mixed record bytes).
                state.save("https://chcp.instructure.com", 28206,
                           "Name-%d-%s" % (i, "x" * (i % 7)))

        _st_savers = [_st_threading.Thread(target=_st_saver, args=(_i,))
                      for _i in range(16)]
        for _t in _st_savers:
            _t.start()
        for _t in _st_savers:
            _t.join(timeout=120)
        _st_loaded = state.load()
        check("concurrent state saves never corrupt the state file",
              isinstance(_st_loaded, dict)
              and "canvas" in _st_loaded
              and _st_loaded["canvas"]["base"] == "https://chcp.instructure.com")
        _st_leftovers = [n for n in os.listdir(_st_dir)
                         if ".new." in n]
        check("no state staging files leak after concurrent saves",
              _st_leftovers == [], str(_st_leftovers))
    finally:
        state.STATE_PATH = _st_real_path

    # LANE2-D13: mark_verified() is a load-modify-write; under
    # save()/mark_verified() contention the save must never be lost.
    # Each round runs mark_verified() loopers while the main thread
    # saves a new base; without the state lock a looper loads the
    # pre-save record and writes it back over the save, resurrecting
    # the old base (and the corruption persists: later loopers just
    # re-stamp the stale base).
    _mv_dir = os.path.join(_st_root, "state-markverified")
    os.makedirs(_mv_dir, exist_ok=True)
    _mv_real_path = state.STATE_PATH
    state.STATE_PATH = os.path.join(_mv_dir, "browser_lane.json")
    try:
        # Hermetic start: an initial save establishes known state so
        # round-0 loopers never hit "no lane state".
        state.save("https://round-init.example", 0, "Init")
        _mv_rounds = 20
        for _r in range(_mv_rounds):
            _base_r = "https://round%d.example" % _r
            _stop = _st_threading.Event()

            def _mv_looper():
                while not _stop.is_set():
                    state.mark_verified()

            _mv_threads = [_st_threading.Thread(target=_mv_looper)
                           for _ in range(4)]
            for _t in _mv_threads:
                _t.start()
            _st_threading.Event().wait(0.005)
            state.save(_base_r, 1000 + _r, "Round-%d" % _r)
            _stop.set()
            for _t in _mv_threads:
                _t.join(timeout=120)
            _rec = state.load()
            check("save() never lost under mark_verified() contention "
                  "(round %d)" % _r,
                  _rec["canvas"]["base"] == _base_r
                  and _rec["canvas"]["principal"]["id"] == 1000 + _r
                  and _rec["canvas"]["last_verified_at"]
                  >= _rec["canvas"]["established_at"],
                  str(_rec["canvas"].get("base")))
        _mv_mode = state.load()
        check("state file stays valid JSON with 0600 mode after contention",
              isinstance(_mv_mode, dict) and "canvas" in _mv_mode)
        import stat as _st_stat
        check("state file mode is 0600 after contention",
              _st_stat.S_IMODE(os.stat(state.STATE_PATH).st_mode) == 0o600)
        _mv_leftovers = [n for n in os.listdir(_mv_dir) if ".new." in n]
        check("no state staging files leak after contention",
              _mv_leftovers == [], str(_mv_leftovers))
    finally:
        state.STATE_PATH = _mv_real_path
        for _sfx in (".lock",):
            try:
                os.unlink(os.path.join(_mv_dir, "browser_lane.json" + _sfx))
            except FileNotFoundError:
                pass

    # ---- FETCH ops: validation ----
    # LANE2-D10: literal authentication headers are refused at render
    # time (they would persist credential material in the brief). The
    # valid fetch op below carries only non-secret headers.
    good_fetch = {"kind": "fetch", "op_id": "f1", "method": "POST",
                  "url": "https://quiz-api.example/v1/banks",
                  "headers": {"AuthType": "Signature", "X-Custom": "v"},
                  "body": '{"a": 1}'}
    v = batch._validate_op(good_fetch)
    check("fetch op validates", v["kind"] == "fetch" and v["method"] == "POST"
          and v["url"].startswith("https://")
          and v["headers"]["AuthType"] == "Signature"
          and v["body"] == '{"a": 1}')
    try:
        batch._validate_op({"kind": "fetch", "op_id": "f9", "method": "POST",
                            "url": "https://quiz-api.example/v1/banks",
                            "headers": {"Authorization": "Bearer T"},
                            "body": '{"a": 1}'})
        check("fetch refuses literal Authorization header", False)
    except batch.SecretEgressRefused:
        check("fetch refuses literal Authorization header", True)
    for bad, name in [
        ({"kind": "fetch", "method": "GET", "url": "https://x.example/"}, "missing op_id"),
        ({"kind": "fetch", "op_id": "x", "url": "https://x.example/"}, "missing method"),
        ({"kind": "fetch", "op_id": "x", "method": "GET"}, "missing url"),
        ({"kind": "fetch", "op_id": "x", "method": "OPTIONS", "url": "https://x.example/"}, "bad fetch method"),
        ({"kind": "fetch", "op_id": "x", "method": "GET", "url": "http://x.example/"}, "non-https fetch url"),
        ({"kind": "fetch", "op_id": "x", "method": "GET", "url": "https://x.example/",
          "headers": {"": "v"}}, "empty fetch header name"),
        ({"kind": "fetch", "op_id": "x", "method": "GET", "url": "https://x.example/",
          "headers": {"X-A": ""}}, "empty fetch header value"),
        ({"kind": "fetch", "op_id": "x", "method": "GET", "url": "https://x.example/",
          "headers": ["X-A"]}, "non-dict fetch headers"),
    ]:
        try:
            batch._validate_op(bad)
            check("fetch refused: %s" % name, False)
        except ValueError:
            check("fetch refused: %s" % name, True)

    # ---- FETCH ops: fetch-only brief is independent of the form host ----
    fetch_ops = [good_fetch,
                 {"kind": "fetch", "op_id": "f2", "method": "GET",
                  "url": "https://quiz-api.example/v1/banks",
                  "headers": {"AuthType": "Signature"}}]
    fbrief = batch.render_brief(fetch_ops, "https://chcp.instructure.com",
                                form_host="bogus://ignored",
                                batch_id="fetch-only")
    check("fetch-only brief ignores bad form_host", True)  # no raise above
    check("fetch-only brief never mentions form-host", "form-host" not in fbrief)
    check("fetch-only brief never mentions the editor chain",
          "EDITOR CHAIN" not in fbrief and "tryit" not in fbrief)
    check("fetch-only brief has no CSRF harvest step", "CSRF TOKEN" not in fbrief)
    check("fetch-only brief forbids forms",
          "Do NOT use any form" in fbrief)
    check("fetch-only brief has non-reporting rule",
          "NEVER write any header name or value into your report" in fbrief)
    check("fetch-only brief renders fetch urls",
          "https://quiz-api.example/v1/banks" in fbrief)
    check("fetch-only brief keeps session check",
          "users/self" in fbrief and "session_dead" in fbrief)
    check("fetch-only brief keeps RESULTS_JSON contract",
          "RESULTS_JSON" in fbrief)
    check("fetch-only brief stays on the provider page",
          "never navigate away" in fbrief)

    # ---- FETCH ops: a mixed batch with a form write fails closed ----
    mixed = [good_fetch,
             {"op_id": "m1", "method": "POST", "path": "/api/v1/x",
              "fields": {"a": "b"}}]
    try:
        batch.render_brief(mixed, "https://chcp.instructure.com",
                           form_host="https://forms.example/x",
                           batch_id="mixed")
        check("mixed batch fails closed", False)
    except batch.FormTransportUnavailable:
        check("mixed batch fails closed", True)

    # ---- FETCH ops: report parse round-trip ----
    freport = ("f1 | 201 | {\"id\": 7}\n"
               "f2 | 200 | {\"banks\": []}\n"
               "RESULTS_JSON\n"
               + json.dumps([{"op_id": "f1", "status": 201, "body": "{\"id\": 7}"},
                             {"op_id": "f2", "status": 200, "body": "{\"banks\": []}"}]))
    fparsed = batch.parse_results(freport)
    check("fetch report parses",
          not fparsed["session_dead"] and len(fparsed["results"]) == 2
          and fparsed["results"][0]["status"] == 201)

    # ---- FETCH ops: page-harvested headers ----
    hop = {"op_id": "h1", "method": "POST",
           "url": "https://chcp.instructure.com/api/v1/jwts",
           "headers": {"X-CSRF-Token": {"harvest": "csrf_token"},
                       "Accept": "application/json"}}
    hclean = batch._validate_fetch_op(hop)
    check("harvest header survives validation",
          hclean["headers"]["X-CSRF-Token"] == {"harvest": "csrf_token"})
    try:
        batch._validate_fetch_op({"op_id": "h2", "method": "POST",
                                  "url": "https://chcp.instructure.com/api/v1/jwts",
                                  "headers": {"X-CSRF-Token": {"harvest": "nope"}}})
        check("bad harvest source refused", False)
    except ValueError:
        check("bad harvest source refused", True)
    hbrief = batch.render_brief([dict(hop, kind="fetch")],
                                "https://chcp.instructure.com",
                                batch_id="harvest")
    check("harvest brief instructs page harvest",
          "HARVEST from the current page" in hbrief
          and "_csrf_token" in hbrief
          and "document.cookie" in hbrief)
    check("harvest brief carries no token value",
          "HARVEST from the current page" in hbrief
          and "_csrf_token cookie" in hbrief)

    # ---- render_form_html: the renderer-agnostic payload (unit-tested, ready
    # for the future data: renderer; never rendered into a brief today) ----
    ehtml = batch.render_form_html(
        "https://chcp.instructure.com/api/v1/courses/89585/assignments",
        {"assignment[name]": 'Weasel "Batch" <Proof>',
         "assignment[published]": False,
         "ids[]": ["1", "2"]},
        "POST", "authenticity_token")
    check("form html escapes quotes and angle brackets",
          'value="Weasel &quot;Batch&quot; &lt;Proof&gt;"' in ehtml)
    check("form html renders booleans as true/false",
          'name="assignment[published]" value="false"' in ehtml)
    check("form html renders list fields as repeated inputs",
          ehtml.count('name="ids[]"') == 2)
    check("form html targets top frame",
          'target="_top"' in ehtml and 'method="POST"' in ehtml)
    check("form html confines action to the tenant",
          'action="https://chcp.instructure.com/api/v1/courses/89585/assignments"'
          in ehtml)
    check("form html carries only the CSRF placeholder",
          'name="authenticity_token" value="HARVESTED_CSRF_TOKEN"' in ehtml
          and "authenticity_token" in ehtml)
    dhtml = batch.render_form_html(
        "https://chcp.instructure.com/api/v1/courses/89585/assignments/4045371",
        {}, "DELETE", "authenticity_token")
    check("form html DELETE carries _method override",
          '<input type="hidden" name="_method" value="DELETE">' in dhtml)
    check("form html DELETE keeps the resource URL",
          "assignments/4045371" in dhtml)
    phtml = batch.render_form_html("https://x.example/a", {}, "PUT",
                                   "authenticity_token")
    check("form html PUT carries _method override",
          'name="_method" value="PUT"' in phtml)
    patch_html = batch.render_form_html("https://x.example/a", {}, "PATCH",
                                        "authenticity_token")
    check("form html PATCH carries _method override",
          'name="_method" value="PATCH"' in patch_html)
    mhtml = batch.render_form_html("https://m.example/webservice/rest/server.php",
                                   {"sesskey": "x"}, "POST", "sesskey")
    check("form html speaks the moodle sesskey dialect",
          'name="sesskey" value="HARVESTED_CSRF_TOKEN"' in mhtml)
    # Secret hygiene: render_form_html output carries the literal placeholder
    # and no token-shaped value anywhere near the CSRF field.
    check("hygiene: placeholder present in form html",
          "HARVESTED_CSRF_TOKEN" in ehtml)
    check("hygiene: no 40-plus-char token-shaped value in form html",
          not re.search(r'value="[A-Za-z0-9+/=_-]{40,}"', ehtml))

    print("selftest: all passed")


if __name__ == "__main__":
    main()
