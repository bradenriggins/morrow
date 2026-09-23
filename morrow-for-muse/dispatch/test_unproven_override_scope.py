#!/usr/bin/env python3
"""Only live-proven operations run, and nothing overrides that.

Failure modes this suite pins down (each written before its fix):
  1. (third-pass re-audit 2026-09-22) The catalog provenance gate
     honored --allow-unproven for ANY known non-live-proven status, so a
     signed override dispatched rows the live battery proved FAILED, or
     marked unsupported (no working route).
  2. (final sweep 2026-09-23) The consent page promises that Morrow
     refuses anything we have not tested, even if the educator asks, but
     the executor still ran a pending row: `catalog --name
     canvas_delete_module_item ... --allow-unproven --approval <file>
     --dry-run` passed every gate and rendered the DELETE, with an
     approval the agent minted and signed itself. The override is gone:
     the CLI has no --allow-unproven, and a signed approval that carries
     allow_unproven: true authorizes nothing an approval without it does
     not.

Hermetic: fake session; approvals, settings, and the signing key live in
pytest's tmp_path.
"""

import contextlib
import io
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
from dispatch.test_direct_lane_hardening import (  # noqa: E402,F401
    BASE, FakeSession, _pack, hermetic)

USER = "muse:override@school.edu"
CONV = "conv-override"
DELETE_ITEM = ("canvas_delete_module_item", "DELETE",
               "/api/v1/courses/{course_id}/modules/{module_id}/items/{id}")
DELETE_PARAMS = {"course_id": "101", "module_id": "7", "id": "9"}
RESOLUTION = json.dumps({"course_id": "101", "confidence": 1.0,
                         "user_confirmed": True})


@pytest.fixture(autouse=True)
def hermetic_keys(hermetic, monkeypatch):
    monkeypatch.setattr(admission_mod, "SECRETS_DIR",
                        str(hermetic / "secrets"))
    monkeypatch.setattr(admission_mod, "SIGNING_KEY_PATH",
                        str(hermetic / "secrets" / "approval-signing.key"))
    monkeypatch.delenv("MORROW_APPROVAL_SIGNING_KEY", raising=False)
    monkeypatch.delenv("MORROW_USER_ID", raising=False)
    monkeypatch.delenv("MORROW_CONVERSATION_ID", raising=False)
    yield hermetic


def _rows(status):
    out = []
    for name, desc in ex._load_operation_catalog().items():
        if desc["status"] == status and desc["id"].startswith("C-") \
                and not desc.get("learner_data"):
            out.append((name, desc))
    return out


def _signed_with_the_old_flag(entry, params):
    """An approval carrying allow_unproven: true under the seal, the
    shape the retired override accepted."""
    rec = mint_approval(entry, params, tenant_base=BASE,
                        target_identity={"course_id": params["course_id"],
                                         "course_name": "Course"})
    rec["allow_unproven"] = True
    sign_approval(rec, "the educator signs this edge-case override",
                  channel="driver")
    return rec


def _dry_run(name, desc, session):
    entry = ex.catalog_descriptor_to_entry(name, desc["method"],
                                           desc["path"])
    params = {"course_id": "7"}
    rec = _signed_with_the_old_flag(entry, params)
    return ex.dispatch_catalog_op(
        name, desc["method"], desc["path"], params=params, pack=_pack(),
        approval=rec, session=session, dry_run=True,
        require_educator_channel=False)


@pytest.mark.parametrize("status",
                         ["pending", "failed", "unsupported", "excluded"])
def test_no_signed_approval_reaches_a_row_that_is_not_live_proven(status):
    rows = _rows(status)
    assert rows, status
    session = FakeSession()
    for name, desc in rows:
        with pytest.raises((ex.CatalogNotProven,
                            admission_mod.AdmissionRefused)):
            _dry_run(name, desc, session)
    assert session.calls == []


def test_a_pending_read_with_the_old_flag_sends_nothing():
    name, desc = next(
        (n, d) for n, d in _rows("pending")
        if d["method"] == "GET" and not admission_mod.touches_learner_data(
            ex.catalog_descriptor_to_entry(n, d["method"], d["path"])))
    entry = ex.catalog_descriptor_to_entry(name, desc["method"], desc["path"])
    params = {"course_id": "7"}
    rec = _signed_with_the_old_flag(entry, params)
    session = FakeSession()
    with pytest.raises(ex.CatalogNotProven) as info:
        ex.dispatch_catalog_op(name, desc["method"], desc["path"],
                               params=params, pack=_pack(), approval=rec,
                               session=session,
                               require_educator_channel=False)
    assert "only live-proven operations run" in str(info.value)
    assert "allow-unproven" not in str(info.value)
    assert session.calls == []


def _cli(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = ex.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


def _delete_argv(approval_path, *extra):
    name, method, path = DELETE_ITEM
    return ["catalog", "--name", name, "--method", method, "--path", path,
            "--params", json.dumps(DELETE_PARAMS), "--backend", "https",
            "--approval", str(approval_path), "--dry-run",
            "--allow-driver-channel",
            "--user-id", USER, "--conversation-id", CONV,
            "--course-resolution", RESOLUTION, *extra]


@pytest.fixture
def delete_approval(hermetic, monkeypatch):
    from settings import store
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)
    session = FakeSession()
    monkeypatch.setattr(ex.SessionStore, "load",
                        classmethod(lambda cls, path=None: session))
    name, method, path = DELETE_ITEM
    entry = ex.catalog_descriptor_to_entry(name, method, path)
    rec = _signed_with_the_old_flag(entry, dict(DELETE_PARAMS))
    target = hermetic / "approval.json"
    target.write_text(json.dumps(rec), encoding="utf-8")
    return target, session


def test_the_cli_has_no_unproven_override(delete_approval):
    approval_path, session = delete_approval
    code, out, err = _cli(_delete_argv(approval_path, "--allow-unproven"))
    assert code == 2, out
    assert "unrecognized arguments: --allow-unproven" in err
    assert "DELETE" not in out
    assert session.calls == []


def test_a_pending_delete_refuses_even_with_a_signed_approval(
        delete_approval):
    approval_path, session = delete_approval
    with pytest.raises(ex.CatalogNotProven):
        _cli(_delete_argv(approval_path))
    assert session.calls == []


def test_the_catalog_help_offers_no_override():
    code, out, _err = _cli(["catalog", "--help"])
    assert code == 0
    assert "unproven" not in out.lower()


SHIPPED_TEXT = (
    "SKILL.md", "SCOPE.md", "content/consent.md", "pack/pack.json",
    "failures/catalog.json", "knowledge/api-catalog-guide.md",
    "knowledge/operations-runbook.md", "knowledge/privacy-ferpa.md",
    "audit/DESKTOP_TO_MUSE_MATRIX.md",
)


@pytest.mark.parametrize("rel", SHIPPED_TEXT)
def test_no_shipped_text_offers_the_override(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        text = fh.read()
    for phrase in ("allow-unproven", "allow_unproven", "unproven override",
                   "signed override", "approve an unproven"):
        assert phrase not in text, (rel, phrase)
