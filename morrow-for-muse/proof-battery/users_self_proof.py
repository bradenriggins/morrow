#!/usr/bin/env python3
"""Live proof: GET /api/v1/users/self through the helper Chromium.

Navigates a dedicated helper-Chromium tab to the educator's own
profile endpoint and captures the JSON response through CDP network
interception. Records HTTP status plus the id, name, and login fields.
Read-only; creates nothing.

Evidence: proof-battery/evidence/users_self_proof_<stamp>.json
Stdlib only.
"""
import datetime
import json
import os
import sys
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
for _p in (_REPO, os.path.join(_REPO, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# W4-P2-16: bare CDP(port) construction is refused. This proof runs
# as a same-tree Morrow process, so it attaches through the verified
# launcher: start() either binds a private --remote-debugging-pipe
# browser or a token-authenticated ProxyCDP to the serving helper
# (after the holder proof). No TCP CDP exists in either mode.
from local_chromium import (  # noqa: E402
    ChromiumLauncher, default_binary, tree_cdp_port,
    tree_helper_profile_dir)

CANVAS_BASE = os.environ.get("CANVAS_BASE")
HELPER_STATUS = "http://127.0.0.1:8901/status"
EVIDENCE_DIR = os.path.join(_HERE, "evidence")

STAMP = "USERS-SELF-" + datetime.datetime.now(
    datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def main():
    if not CANVAS_BASE:
        raise SystemExit("FATAL: set CANVAS_BASE (no default)")
    try:
        with urllib.request.urlopen(HELPER_STATUS, timeout=10) as resp:
            status = json.load(resp)
    except Exception as exc:
        raise SystemExit("FATAL: helper status unreachable (%s)" % exc)
    if not status.get("logged_in"):
        raise SystemExit("FATAL: helper reports logged_in:false")

    launcher = ChromiumLauncher(
        default_binary(), tree_helper_profile_dir(),
        cdp_port=tree_cdp_port())
    mode = launcher.start()  # "attached" or "launched"; raises on a
    # foreign helper (holder proof), never adopts it
    cdp = launcher.cdp
    tab = cdp.new_tab("about:blank")
    try:
        url = "%s/api/v1/users/self" % CANVAS_BASE.rstrip("/")
        resp_url, body = cdp.capture_network_response(
            tab, url, "/api/v1/users/self", timeout=60)
        try:
            payload = json.loads(body) if body else {}
        except ValueError:
            payload = {}
        ok = isinstance(payload, dict) and payload.get("id") \
            and payload.get("name")
        # This tenant's /users/self response carries no login_id field;
        # the account identifier it returns is email.
        record = {
            "stamp": STAMP,
            "url": url,
            "http_status": 200 if ok else "non-200-or-unparseable",
            "id": payload.get("id"),
            "name": payload.get("name"),
            "login": payload.get("login_id") or payload.get("email"),
            "login_id_absent_note": "login_id not present in this "
                                    "tenant's /users/self response; "
                                    "email used as the login identifier",
            "proven": bool(ok),
        }
    finally:
        try:
            cdp.close_tab(tab)
        except Exception:
            pass
        # Never stop the helper's browser out from under it; only tear
        # down a private browser this proof launched itself.
        if mode == "launched":
            try:
                launcher.stop()
            except Exception:
                pass

    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    out_path = os.path.join(EVIDENCE_DIR, "users_self_proof_%s.json" % STAMP)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=1)
    print(json.dumps({"evidence": out_path, "record": record}, indent=1))


if __name__ == "__main__":
    main()
