#!/usr/bin/env python3
"""Live verification of the student-resolution READ PATH (workstream 2).

Read-only. Uses the Canvas login helper's Chromium (auth stays in the
browser/page context; this process never sees credentials and never
performs shell-side HTTPS to Canvas). Mirrors
proof-battery/users_self_proof.py: attaches through the verified
launcher (W4-P2-16), opens one tab, captures each JSON response via CDP
network interception, then closes the tab.

Reads verified on the real tenant (course 89585, the authorized test
course, which has ZERO students):

  1. GET /api/v1/users/self -> dict shape; records which identifier
     fields this tenant returns (login_id, sis_user_id, sis_login_id,
     email, sortable_name, short_name present or absent).
  2. GET /api/v1/courses/89585 -> dict shape, id echo.
  3. GET /api/v1/courses/89585/users?enrollment_type[]=student&
     include[]=enrollments&per_page=100 -> list shape (live: one LMS
     test account enrolled as a regular active StudentEnrollment);
     records the Link header so the resolver's pagination handling is
     checked against a real response.
  4. GET /api/v1/courses/89585/enrollments?per_page=100&
     type[]=StudentEnrollment -> list shape (live: the same one
     record).
  5. GET /api/v1/courses/89585/search_users?search_term=<no-match>&
     per_page=10 -> list shape (expected: empty).

Resolution logic itself is proven by the synthetic unit suite
(learners/test_resolve_student.py): with zero real students, any
"live resolution" claim would be fabricated, so this script proves the
reads the resolver depends on and labels the logic proofs synthetic.

Evidence: learners/evidence/live_reads_<stamp>.json
Stdlib only.
"""

import base64
import datetime
import json
import os
import sys
import time
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)

# Sanctioned in-tree pattern (failures/live_verify.py): point the
# transport at the LIVE helper tree's state dir so _helper_request picks
# up the live helper's auth token (this tree's own token file belongs to
# a different, non-running helper instance). Set before the import. The
# token is read transiently for the X-Helper-Token header only; it is
# never printed, logged, or written anywhere by this script.
os.environ["MORROW_TREE_STATE_DIR"] = os.path.expanduser(
    "~/.morrow/canvas-login-helper")

for _p in (_REPO, os.path.join(_REPO, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# W4-P2-16: bare CDP(port) construction is refused. Same-tree Morrow
# process, so attach through the verified launcher.
from local_chromium import (  # noqa: E402
    CDPError, ChromiumLauncher, default_binary, tree_cdp_port,
    tree_helper_profile_dir)

HELPER_STATUS = "http://127.0.0.1:8901/status"
EVIDENCE_DIR = os.path.join(_HERE, "evidence")
COURSE_ID = "89585"

STAMP = "LIVE-READS-" + datetime.datetime.now(
    datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def capture_with_headers(cdp, tab, url, url_fragment, timeout=60):
    """Like CDP.capture_network_response but also returns HTTP status
    and response headers (needed to verify the Link pagination header
    the resolver follows). Returns (status, headers, body_text)."""
    session = cdp.tab_session(tab)
    cdp.call(tab, "Network.enable", {}, timeout=30)
    try:
        cdp.navigate(tab, url, timeout=60)
        deadline = time.monotonic() + timeout
        pending = {}
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    "no response for %r observed within %ds"
                    % (url_fragment, timeout))
            for ev in cdp.poll_session_events(session, min(remaining, 5)):
                if not isinstance(ev, dict):
                    continue
                method = ev.get("method")
                if method == "Inspector.targetCrashed":
                    raise CDPError("the tab crashed during the read")
                params = ev.get("params") or {}
                if method == "Network.responseReceived":
                    response = params.get("response") or {}
                    rurl = str(response.get("url") or "")
                    if url_fragment in rurl:
                        pending[params.get("requestId")] = (
                            rurl, response.get("status"),
                            dict(response.get("headers") or {}))
                elif method == "Network.loadingFinished":
                    rid = params.get("requestId")
                    if rid in pending:
                        rurl, status, headers = pending.pop(rid)
                        try:
                            body = cdp.call(
                                tab, "Network.getResponseBody",
                                {"requestId": rid}, timeout=30)
                        except CDPError:
                            continue
                        text = body.get("body", "")
                        if body.get("base64Encoded"):
                            text = base64.b64decode(
                                text.encode("ascii")).decode(
                                    "utf-8", "replace")
                        return status, headers, text
    finally:
        try:
            cdp.call(tab, "Network.disable", {}, timeout=10)
        except Exception:
            pass


def read(cdp, tab, base, path, fragment):
    url = "%s%s" % (base.rstrip("/"), path)
    status, headers, body = capture_with_headers(
        cdp, tab, url, fragment, timeout=60)
    try:
        payload = json.loads(body) if body else None
    except ValueError:
        payload = None
    link = None
    for key, value in headers.items():
        if str(key).lower() == "link":
            link = value
    return {
        "url": url,
        "http_status": status,
        "is_list": isinstance(payload, list),
        "is_dict": isinstance(payload, dict),
        "length": len(payload) if isinstance(payload, list) else None,
        "link_header": link,
        "payload": payload,
    }


def main():
    try:
        with urllib.request.urlopen(HELPER_STATUS, timeout=10) as resp:
            status_doc = json.load(resp)
    except Exception as exc:
        raise SystemExit("FATAL: helper status unreachable (%s)" % exc)
    if not status_doc.get("logged_in"):
        raise SystemExit("FATAL: helper reports logged_in:false")
    base = str(status_doc.get("url") or "").rstrip("/")
    if not base:
        raise SystemExit("FATAL: helper status carries no tenant url")

    launcher = ChromiumLauncher(
        default_binary(), tree_helper_profile_dir(),
        cdp_port=tree_cdp_port())
    mode = launcher.start()
    cdp = launcher.cdp
    tab = cdp.new_tab("about:blank")
    checks = []
    try:
        # 1. users/self: identifier field presence/absence on this tenant.
        me = read(cdp, tab, base, "/api/v1/users/self", "/api/v1/users/self")
        payload = me.pop("payload") or {}
        me["shape_ok"] = me["is_dict"] and bool(payload.get("id"))
        me["fields"] = {
            field: (field in payload)
            for field in ("id", "name", "sortable_name", "short_name",
                          "login_id", "sis_user_id", "sis_login_id",
                          "email", "avatar_url")
        }
        me["id"] = payload.get("id")
        me["name"] = payload.get("name")
        checks.append(("users_self", me))

        # 2. Course show: anchor the authorized test course.
        course = read(cdp, tab, base,
                      "/api/v1/courses/%s" % COURSE_ID,
                      "/api/v1/courses/%s" % COURSE_ID)
        cpayload = course.pop("payload") or {}
        course["shape_ok"] = course["is_dict"] and \
            str(cpayload.get("id")) == COURSE_ID
        checks.append(("course_show", course))

        # 3. Users-in-course (the resolver's primary read).
        users = read(
            cdp, tab, base,
            "/api/v1/courses/%s/users?enrollment_type%%5B%%5D=student"
            "&include%%5B%%5D=enrollments&per_page=100" % COURSE_ID,
            "/api/v1/courses/%s/users" % COURSE_ID)
        upayload = users.pop("payload")
        users["shape_ok"] = users["is_list"]
        users["expected_empty"] = upayload == []
        if isinstance(upayload, list) and upayload:
            first = upayload[0]
            users["first_user_fields"] = sorted(first.keys()) \
                if isinstance(first, dict) else []
        checks.append(("course_users_student", users))

        # 4. Enrollments list (supplementary read).
        enrollments = read(
            cdp, tab, base,
            "/api/v1/courses/%s/enrollments?per_page=100"
            "&type%%5B%%5D=StudentEnrollment" % COURSE_ID,
            "/api/v1/courses/%s/enrollments" % COURSE_ID)
        epayload = enrollments.pop("payload")
        enrollments["shape_ok"] = enrollments["is_list"]
        enrollments["expected_empty"] = epayload == []
        checks.append(("course_enrollments", enrollments))

        # 5. search_users with a no-match term.
        search = read(
            cdp, tab, base,
            "/api/v1/courses/%s/search_users?search_term=%s&per_page=10"
            % (COURSE_ID, "zzz_no_such_student_zzz"),
            "/api/v1/courses/%s/search_users" % COURSE_ID)
        spayload = search.pop("payload")
        search["shape_ok"] = search["is_list"]
        search["expected_empty"] = spayload == []
        checks.append(("course_search_users_no_match", search))
    finally:
        try:
            cdp.close_tab(tab)
        except Exception:
            pass
        if mode == "launched":
            try:
                launcher.stop()
            except Exception:
                pass

    record = {
        "stamp": STAMP,
        "tenant_base": base,
        "course_id": COURSE_ID,
        "note": "Read-only GETs through the helper browser. Course "
                "89585 holds zero real students and one LMS test account "
                "enrolled as a regular active StudentEnrollment, so the "
                "list reads return that one record; search_users with a "
                "no-match term returns []. Resolution logic is proven by "
                "the synthetic unit suite plus live_verify_resolution.py, "
                "not by these reads alone.",
        "checks": checks,
        "all_shape_ok": all(check["shape_ok"] for _name, check in checks),
    }
    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    out_path = os.path.join(EVIDENCE_DIR, "live_reads_%s.json" % STAMP)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=1)
    summary = {
        name: {"http_status": check["http_status"],
               "shape_ok": check["shape_ok"],
               "is_list": check["is_list"],
               "length": check["length"],
               "link_header_present": check["link_header"] is not None}
        for name, check in checks
    }
    summary["users_self_fields"] = checks[0][1]["fields"]
    print(json.dumps({"evidence": out_path, "summary": summary,
                      "all_shape_ok": record["all_shape_ok"]}, indent=1))
    if not record["all_shape_ok"]:
        raise SystemExit("FATAL: one or more read shapes failed")


if __name__ == "__main__":
    main()
