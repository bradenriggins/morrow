#!/usr/bin/env python3
"""The live-proven reads SCOPE.md counts all ship, and a read Morrow never
does is told as a read.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23, item csp-settings-read-refused-but-counted):
  1. C-94 (GET /api/v1/courses/{course_id}/csp_settings) is live-proven
     and counted in SCOPE.md's live-proven reads, but the never-dispatch
     URL rule '/csp_settings' refused it, so only 114 of the 115 reads
     SCOPE.md and the operations runbook promise could run. The rule's
     reason is that changing CSP settings affects account security; a
     read changes nothing.
  2. The CSP rule must still refuse every change to CSP settings: the
     C-93 PUT by name, and a change on any other route by its URL.
  3. A read the never-dispatch rules do refuse (a blueprint read) told
     the educator it was "changing settings that reach beyond your
     courses" and offered "I can help you write it first".
"""

import json
import os
import re
import sys
from types import SimpleNamespace

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from dispatch import admission  # noqa: E402
from dispatch import executor as ex  # noqa: E402
from failures import translator  # noqa: E402
from dispatch.test_round4_write_ceremony import (  # noqa: E402,F401
    FakeSession, _canvas, _cli, _fake_store, hermetic, hermetic_keys)

CSP_READ = "canvas_get_current_settings_for_account_or_course_courses"
CSP_WRITE = "canvas_enable_disable_or_clear_explicit_csp_setting_courses"
CSP_PATH = "/api/v1/courses/{course_id}/csp_settings"


def _entry(name):
    desc = ex.catalog_descriptor_for(name)
    return ex.catalog_descriptor_to_entry(name, desc["method"],
                                          desc["path"]), desc


def _synthetic(method, url):
    return {"name": "hand_built", "effects":
            "read" if method == "GET" else "write",
            "request": {"method": method, "url": "{canvas_base}" + url}}


def test_the_course_csp_read_is_admitted():
    entry, desc = _entry(CSP_READ)
    assert desc["id"] == "C-94" and desc["status"] == "live-proven"
    assert ex._catalog_provenance_gate(
        entry, CSP_READ, desc["method"], desc["path"], {},
        session=SimpleNamespace(browser_owned_auth=True)) == "live-proven"


def test_the_course_csp_read_runs_from_the_cli(monkeypatch):
    canvas = _canvas()

    def handler(method, url, body):
        if method == "GET" and url.endswith("/courses/101/csp_settings"):
            return 200, {}, json.dumps({"enabled": False}).encode()
        return canvas(method, url, body)
    session = FakeSession(handler)
    _fake_store(monkeypatch, session)
    code, out = _cli(["catalog", "--name", CSP_READ, "--method", "GET",
                      "--path", CSP_PATH, "--params",
                      json.dumps({"course_id": "101"}),
                      "--backend", "https"])
    assert code == 0, out
    assert any(c[0] == "GET" and c[1].endswith("/csp_settings")
               for c in session.calls)
    assert [c for c in session.calls if c[0] != "GET"] == []


@pytest.mark.parametrize("method", ["PUT", "POST", "PATCH", "DELETE"])
def test_every_change_to_csp_settings_is_still_refused(method):
    policy = admission.load_policy()
    entry, _desc = _entry(CSP_WRITE)
    with pytest.raises(admission.NeverDispatch):
        admission.check_never_dispatch(entry, policy)
    for url in (CSP_PATH.replace("{course_id}", "101"),
                "/api/v1/accounts/1/csp_settings"):
        with pytest.raises(admission.NeverDispatch):
            admission.check_never_dispatch(_synthetic(method, url), policy)
    admission.check_never_dispatch(
        _synthetic("GET", "/api/v1/accounts/1/csp_settings"), policy)


def test_a_change_hidden_in_a_later_step_is_still_refused():
    policy = admission.load_policy()
    entry = _synthetic("GET", "/api/v1/courses/101")
    entry["multi_step"] = [{"method": "PUT",
                            "url": "{canvas_base}/api/v1/courses/101/"
                                   "csp_settings"}]
    with pytest.raises(admission.NeverDispatch):
        admission.check_never_dispatch(entry, policy)


def test_every_live_proven_read_passes_the_gate():
    """SCOPE.md's live-proven read count is the number of reads that
    run: on the Chromium lane with the learner vault, every live-proven
    read row passes the provenance gate. Without the learner vault's
    package the people-bearing reads are refused, as documented."""
    pytest.importorskip("cryptography")
    lane = SimpleNamespace(browser_owned_auth=True)
    refused = []
    reads = 0
    for name, desc in sorted(ex._load_operation_catalog().items()):
        if desc["status"] != "live-proven" or desc["effect"] != "read":
            continue
        reads += 1
        entry = ex.catalog_descriptor_to_entry(name, desc["method"],
                                               desc["path"])
        try:
            ex._catalog_provenance_gate(entry, name, desc["method"],
                                        desc["path"], {}, session=lane)
        except Exception as exc:  # noqa: BLE001
            refused.append((desc["id"], type(exc).__name__))
    assert refused == []
    with open(os.path.join(TREE, "SCOPE.md"), encoding="utf-8") as fh:
        scope = " ".join(fh.read().split())
    assert int(re.search(r"(\d+) live-proven reads", scope).group(1)) \
        == reads


def test_a_never_dispatch_read_is_told_as_a_read():
    policy = admission.load_policy()
    entry, desc = _entry("canvas_get_blueprint_information")
    assert desc["method"] == "GET"
    with pytest.raises(admission.NeverDispatch) as caught:
        admission.check_never_dispatch(entry, policy)
    tr = translator.translate('reading a blueprint template in the course '
                              '"Biology 101"', caught.value)
    assert tr.mode_id == "never-dispatch-read"
    text = tr.agent_message
    assert "write it" not in text
    assert "changing" not in text
    assert "nothing was sent" in text.lower()
    assert "\u2014" not in text


def test_a_never_dispatch_change_keeps_the_change_message():
    policy = admission.load_policy()
    entry, _desc = _entry(CSP_WRITE)
    with pytest.raises(admission.NeverDispatch) as caught:
        admission.check_never_dispatch(entry, policy)
    tr = translator.translate("changing a setting", caught.value)
    assert tr.mode_id == "never-dispatch"
