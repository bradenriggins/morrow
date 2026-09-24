#!/usr/bin/env python3
"""Selftest for the helper's educator-visible surface (wave 6).

W6-P1-S2: /status must expose the pending session notice and the
write-halt flag so the educator sees session-death notifications
without the agent's help.
W6-P2-A4: /status must expose the pinned principal name so the helper
UI can show WHO is signed in.
W6-P2-S4: tab-protection failures must warn loudly (see the keepalive
and server failure paths; the UI banner is covered by the ad hoc
check in the wave-6 report).

Covers the read-only helpers that feed /status: they must return the
educator's data when present and None/False (never a crash) when the
store is absent.

Run: python3 helper/educator_surface_selftest.py (from the tree root)
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import importlib.util
import json
import os
import sys
import tempfile

FAIL = []
PASS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name +
          (" (%s)" % detail if detail and not cond else ""))
    (PASS if cond else FAIL).append(name)


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

scratch = os.path.join(os.path.expanduser("~"), "workspace",
                       "audits", "wave6-scratch",
                       "educator-surface-selftest")
os.makedirs(scratch, exist_ok=True)
# The server module refuses to import without an explicit profile dir
# (fail-closed against production ports); point it at scratch.
os.environ["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(scratch, "profile")
os.makedirs(os.environ["LOGIN_HELPER_PROFILE_DIR"], exist_ok=True)

# Point config.paths.morrow_home at the scratch store before the
# server module reads it.
import config.paths as _cp
_real_morrow_home = _cp.morrow_home
_cp.morrow_home = lambda: scratch

spec = importlib.util.spec_from_file_location(
    "helper_server_w6", os.path.join(HERE, "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

try:
    # --- principal name -------------------------------------------------
    with open(os.path.join(scratch, "session.json"), "w",
              encoding="utf-8") as fh:
        json.dump({"canvas": {"principal": {"name": "Ada Lovelace"}}}, fh)
    check("w6p2a4: pinned principal name surfaces",
          srv._educator_principal_name() == "Ada Lovelace",
          repr(srv._educator_principal_name()))
    os.remove(os.path.join(scratch, "session.json"))
    check("w6p2a4: no session yields None, not a crash",
          srv._educator_principal_name() is None)

    # --- session notice --------------------------------------------------
    notice = ("Canvas session died at 2026-09-21T10:00:00Z; 2 write op(s) "
              "paused. Re-sign in, then run: reauth notify")
    with open(os.path.join(scratch, "notify.txt"), "w",
              encoding="utf-8") as fh:
        fh.write(notice)
    check("w6p1s2: pending session notice surfaces verbatim",
          srv._educator_session_notice() == notice)
    # Start clean: a halt file left by a previous run must not pollute
    # the inactive case.
    try:
        os.remove(os.path.join(scratch, "write_halt"))
    except OSError:
        pass
    check("w6p1s2: write halt inactive without the halt file",
          srv._educator_write_halt_active() is False)
    with open(os.path.join(scratch, "write_halt"), "w",
              encoding="utf-8") as fh:
        fh.write("halt")
    check("w6p1s2: write halt active with the halt file",
          srv._educator_write_halt_active() is True)
    os.remove(os.path.join(scratch, "notify.txt"))
    check("w6p1s2: cleared notice yields None, not a crash",
          srv._educator_session_notice() is None)

    # --- the /status payload carries the educator fields ------------------
    # (field presence is asserted against the handler source: the
    # status() method must include session_notice, write_halt_active
    # and principal_name in its JSON body.)
    src = open(os.path.join(HERE, "server.py"), encoding="utf-8").read()
    for field in ("session_notice", "write_halt_active", "principal_name",
                  "session_expiry_unknown"):
        check("w6 educator surface: /status carries %r" % field,
              ('"%s"' % field) in src)

    # --- the badge names the connected (pinned) account -------------------
    # (muse UX audit 3, muse-ux3/helper-badge-shows-pinned-not-signed-in-
    # account, written before the fix): the badge said "signed in as
    # <name>" where the name is the account pinned at first sign-in
    # (browser_lane.json), never the account signed in to the tab, and
    # the banner told the educator to use it to detect an SSO account
    # switch. After a switch the badge still showed the pinned name, so
    # the check always passed.
    html_src = open(os.path.join(HERE, "index.html"),
                    encoding="utf-8").read()
    check("badge does not claim the pinned name is the signed-in account",
          '"signed in as " + st.principal_name' not in html_src)
    check("banner does not use the badge to detect an account switch",
          "Check the signed-in name above matches your Canvas account"
          not in html_src)
    check("badge names the connected account",
          "Morrow is connected to " in html_src
          and "st.principal_name" in html_src)

    # --- W6-P2-S4: failed tab protection warns loudly --------------------
    # A failed set_tab_protected used to vanish silently (bare except:
    # pass). The HelperBrowser._protect_primary_tab method must print
    # a loud warning to stderr when protection fails.
    import io
    from unittest import mock
    hb = srv.HelperBrowser.__new__(srv.HelperBrowser)
    hb.launcher = mock.MagicMock()
    hb.launcher.set_tab_protected.side_effect = RuntimeError("nope")
    hb.tab = {"id": "tab-1"}
    err = io.StringIO()
    with mock.patch.object(srv.sys, "stderr", err):
        hb._protect_primary_tab()
    out = err.getvalue()
    check("w6p2s4: failed tab protection warns on stderr",
          "MORROW HELPER WARNING" in out and "idle-tab reaping" in out,
          out[:150])
    # Success path: no warning, protection called.
    hb2 = srv.HelperBrowser.__new__(srv.HelperBrowser)
    hb2.launcher = mock.MagicMock()
    hb2.tab = {"id": "tab-2"}
    err2 = io.StringIO()
    with mock.patch.object(srv.sys, "stderr", err2):
        hb2._protect_primary_tab()
    check("w6p2s4: successful tab protection is silent",
          err2.getvalue() == "" and
          hb2.launcher.set_tab_protected.call_count == 1)
finally:
    _cp.morrow_home = _real_morrow_home

print("PASS: %d" % len(PASS))
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("all educator-surface selftests passed")
