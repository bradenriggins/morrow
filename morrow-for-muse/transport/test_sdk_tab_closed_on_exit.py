#!/usr/bin/env python3
"""Closing a Chromium session closes its Item Banks tabs.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22, probe final-sweep/muse-engine/p6_sdk_tab.py):
  ChromiumSession.close() never closed the Item Banks SDK sessions it
  cached. On the normal helper path (an attached launcher, which close()
  must never stop) each executor run with an Item Bank operation left a
  tab open in the long-lived helper Chromium, running the New Quizzes
  app at /courses/<id>/banks. The idle-tab reaper skips tabs that are
  not blank, so the tabs piled up, and the captured credential stayed in
  memory until the process ended. close() now closes every cached SDK
  session (its tab and its credential) first, whatever the launcher.

Hermetic: a fake CDP client and launcher; no browser.
"""

import os
import sys

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from transport import chromium_session as cs  # noqa: E402

BASE = "https://school.instructure.com"


class _FakeCDP:
    def __init__(self):
        self.open = {}
        self.count = 0

    def new_tab(self, url="about:blank"):
        self.count += 1
        tab = {"id": "T%d" % self.count, "url": url}
        self.open[tab["id"]] = tab
        return tab

    def close_tab(self, tab):
        self.open.pop(tab["id"], None)


class _Launcher:
    def __init__(self, attached):
        self.attached = attached
        self.proc = None if attached else object()
        self.cdp = _FakeCDP()
        self.stopped = False

    def start(self):
        pass

    def stop(self):
        assert not self.attached, "the helper browser is never stopped"
        self.stopped = True


def _session_with_sdk_tab(attached):
    launcher = _Launcher(attached)
    session = cs.ChromiumSession(BASE, launcher=launcher)
    session.set_sdk_course("101")
    sdk = session._sdk_for_course("101")
    tab = sdk._get_tab()
    launcher.cdp.open[tab["id"]]["url"] = BASE + "/courses/101/banks"
    sdk._token = "captured-credential"
    return session, launcher, sdk


def test_close_on_the_helper_browser_closes_the_sdk_tab():
    session, launcher, sdk = _session_with_sdk_tab(attached=True)
    assert launcher.cdp.open
    session.close()
    assert launcher.cdp.open == {}
    assert sdk._token is None
    assert session._sdk_sessions == {}
    assert launcher.stopped is False


def test_close_on_an_owned_browser_closes_the_sdk_tab_and_stops_it():
    session, launcher, sdk = _session_with_sdk_tab(attached=False)
    session.close()
    assert launcher.cdp.open == {}
    assert sdk._token is None
    assert launcher.stopped is True


def test_close_without_a_launcher_is_harmless():
    cs.ChromiumSession(BASE).close()
