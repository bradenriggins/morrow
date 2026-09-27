#!/usr/bin/env python3
"""Connect-time capability probe for the Moodle lane (Morrow Direct).

Answers, with live evidence, the questions the architecture says a
connector must answer at connect time (section 3.3):
  - Which Moodle version is this? (AJAX flag semantics drift per version:
    5.x renamed `ajax => true` to `allowed_from_ajax`, checked live in
    Moodle 5.2 source and confirmed live on the sandbox.)
  - Which functions of the lane's function set are AJAX-exposed here?
    (Per-function data, drifts per version: probed behaviorally, one
    benign call each, no writes.)
  - What does the session cookie look like (name, flags, value shape)?
  - Is the sesskey stable across page loads?
  - Which known deployment killers are observable from outside?
    (tracksessionip, limitconcurrentlogins, custom cookie names are
    config-gated: recorded as UNOBSERVABLE, not wished away.)

The probe is read-only by construction: GETs plus benign AJAX calls
with nonsense IDs that can only produce "not found" errors, never
writes. Output carries shapes, statuses, lengths, and IDs only.

Usage:
  probe.py --base https://sandbox.moodledemo.net --username teacher --password <published demo password>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore

try:  # package import, e.g. "from moodle.probe import ..."
    from .login import bootstrap, resolve_password
    from .session import MoodleSession, normalize_moodle_base
except ImportError:  # script usage: python3 probe.py (moodle/ on sys.path)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from login import bootstrap, resolve_password  # noqa: E402
    from session import MoodleSession, normalize_moodle_base  # noqa: E402

USER_AGENT = "morrow-moodle-prober/0.1 (read-only capability probe)"
DEFAULT_TIMEOUT = 25

# The lane's function set: (function, benign args, why the lane needs it).
# Benign args are chosen to be executable but side-effect-free; a
# "not found" provider error still proves the function is AJAX-exposed.
FUNCTION_SET = [
    ("core_course_get_enrolled_courses_by_timeline_classification",
     {"classification": "all"}, "course discovery (read)"),
    ("core_course_get_contents", {"courseid": 2},
     "course structure read (moodle.course.contents sample)"),
    ("core_user_get_users_by_field",
     {"field": "username", "values": ["teacher"]}, "principal extraction"),
    ("mod_forum_get_forums_by_courses", {"courseids": [2]},
     "forum discovery (read)"),
    ("mod_forum_get_forum_discussions", {"forumid": 1},
     "discussion listing readback"),
    ("mod_forum_add_discussion",
     {"forumid": 999999999, "subject": "probe", "message": "probe"},
     "discussion create (write; bogus forumid so the probe can only "
     "fail, never write; form-path fallback expected on 5.2)"),
    ("mod_forum_delete_discussion", {"discussionid": 999999999},
     "discussion delete (negative control: absent from the 5.2 registry, "
     "so the undo for a discussion create is the form-path delete)"),
]

VERSION_RE = re.compile(r"Moodle\s+(\d+\.\d+)")


def scrape_version(session: "requests.Session", base: str,
                   timeout: int) -> Optional[str]:
    base = normalize_moodle_base(base)
    resp = session.get(base + "/", timeout=timeout)
    resp.raise_for_status()
    hits = VERSION_RE.findall(resp.text)
    return hits[0] if hits else None


def probe_function(sess: MoodleSession, methodname: str,
                   args: Dict[str, Any]) -> Dict[str, Any]:
    """Classify one function: ajax_exposed / not_exposed / other error."""
    try:
        env = sess._ajax_call(methodname, args)
    except Exception as exc:  # MoodleLaneError or network
        kind = getattr(exc, "kind", "network")
        detail = getattr(exc, "detail", str(exc))
        if kind == "reauth":
            return {"function": methodname, "ajax": "unknown",
                    "signal": "reauth-during-probe", "detail": detail}
        if "servicenotavailable" in detail:
            return {"function": methodname, "ajax": False,
                    "signal": "servicenotavailable",
                    "detail": "not allowed_from_ajax on this deployment"}
        if kind == "not_registered":
            # Top-level invalidrecordunknown, verified identical to a
            # nonexistent function name: the function is absent from the
            # 5.2 registry (e.g. mod_forum_delete_discussion is not in
            # the forum plugin's db/services.php on 5.2).
            return {"function": methodname, "ajax": False,
                    "signal": "not_registered",
                    "detail": "no such webservice function on this deployment"}
        if kind == "provider":
            # The function executed and raised a domain error (e.g.
            # invalidrecordunknown on a bogus id): that proves it IS
            # ajax-exposed. The probe args are chosen to fail safely.
            return {"function": methodname, "ajax": True,
                    "signal": "executed-with-domain-error",
                    "detail": detail[:160]}
        return {"function": methodname, "ajax": "unknown",
                "signal": kind, "detail": detail[:160]}
    return {"function": methodname, "ajax": True,
            "signal": "executed",
            "detail": "envelope returned without error"}


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Read-only Moodle capability probe.")
    p.add_argument("--base", default="https://sandbox.moodledemo.net")
    p.add_argument("--username", default="teacher")
    p.add_argument("--password", default=None,
                   help="DISCOURAGED: visible in the process table and shell "
                        "history. Prefer the MOODLE_PASSWORD environment "
                        "variable or the stdin prompt. Never put a real "
                        "credential here; argv is for the published demo "
                        "password only.")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    password = resolve_password(args.password, args.base)
    bundle = bootstrap(args.base, args.username, password, args.timeout)
    sess = MoodleSession.from_bundle(bundle, timeout=args.timeout)

    # Authoritative principal from the AJAX layer (page scraping only
    # yields initials on this theme).
    try:
        princ = sess.ajax(
            "core_user_get_users_by_field",
            {"field": "username", "values": [args.username]},
            receipt_fields=["id", "username", "fullname"])
        users = princ["data"] or []
        ajax_principal = {k: users[0].get(k)
                          for k in ("id", "username", "fullname")} if users else {}
    except Exception as exc:
        ajax_principal = {"error": "%s: %s" % (getattr(exc, "kind", "?"),
                                               getattr(exc, "detail", exc)[:120])}
    sess.principal.update(ajax_principal)

    version = scrape_version(bundle["session"], args.base, args.timeout)
    functions = [probe_function(sess, fn, a) for fn, a, _ in FUNCTION_SET]

    report: Dict[str, Any] = {
        "tool": "morrow-moodle-prober",
        "version": "0.1",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "base": args.base,
        "moodle_version": version,
        "principal": sess.principal,
        "session_cookie": {
            "names": bundle["cookie_names"],
            "value_shapes": bundle["cookie_value_len"],
        },
        "sesskey": {"len": bundle["sesskey_len"],
                    "stable_across_page_loads": bundle["sesskey_stable"]},
        "functions": functions,
        "ajax_path": "lib/ajax/service.php (exists on 5.2; docroot is public/)",
        "deployment_killers": {
            "tracksessionip": "UNOBSERVABLE from outside (config-gated); "
                              "kills the session if the egress IP changes",
            "limitconcurrentlogins": "UNOBSERVABLE from outside (config-gated); "
                                     "a new login evicts the oldest session",
            "custom_cookie_name": "OBSERVED: %s" % ",".join(bundle["cookie_names"]),
            "hourly_sandbox_reset": "OBSERVED on moodledemo.net: the whole "
                                    "site resets hourly; sessions die on reset",
        },
    }
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("Moodle capability probe: %s (Moodle %s)" % (args.base, version))
        print("principal: %s" % sess.principal)
        print("sesskey: len=%d stable=%s" % (bundle["sesskey_len"],
                                            bundle["sesskey_stable"]))
        print("functions:")
        for f in functions:
            print("  %-55s ajax=%s (%s)" % (f["function"], f["ajax"],
                                            f["signal"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
