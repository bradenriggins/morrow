#!/usr/bin/env python3
"""The --allow-unproven override reaches pending rows only.

Failure mode this suite pins down (written before the fix; third-pass
re-audit 2026-09-22): SKILL.md and SCOPE.md say only live-proven
operations run, with one educator-signed exception for rows not yet
live-proven, and that failed rows are refused with no override. The
catalog provenance gate honored --allow-unproven for ANY known
non-live-proven status, so a signed override dispatched rows the live
battery proved FAILED, or marked unsupported (no working route). The
override must admit only rows whose status is "pending" (never tried
live); failed, unsupported, and excluded rows refuse even with it.

Hermetic: fake session; approvals and the signing key live in pytest's
tmp_path.
"""

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
    BASE, FakeSession, hermetic)


@pytest.fixture(autouse=True)
def hermetic_keys(hermetic, monkeypatch):
    monkeypatch.setattr(admission_mod, "SECRETS_DIR",
                        str(hermetic / "secrets"))
    monkeypatch.setattr(admission_mod, "SIGNING_KEY_PATH",
                        str(hermetic / "secrets" / "approval-signing.key"))
    monkeypatch.delenv("MORROW_APPROVAL_SIGNING_KEY", raising=False)
    yield hermetic


def _rows(status):
    out = []
    for name, desc in ex._load_operation_catalog().items():
        if desc["status"] == status and desc["id"].startswith("C-") \
                and not desc.get("learner_data"):
            out.append((name, desc))
    return out


def _gate(name, desc):
    entry = ex.catalog_descriptor_to_entry(name, desc["method"],
                                           desc["path"])
    params = {"course_id": "7"}
    rec = mint_approval(entry, params, tenant_base=BASE, allow_unproven=True,
                        target_identity={"course_id": "7",
                                         "course_name": "Course"})
    sign_approval(rec, "the educator signs this edge-case override",
                  channel="driver")
    return ex._catalog_provenance_gate(
        entry, name, desc["method"], desc["path"], params, "canvas",
        approval=rec, allow_unproven=True, session=FakeSession(),
        require_educator_channel=False)


@pytest.mark.parametrize("status", ["failed", "unsupported"])
def test_signed_override_never_reaches_failed_or_unsupported_rows(status):
    rows = _rows(status)
    assert rows, status
    for name, desc in rows:
        with pytest.raises((ex.CatalogNotProven,
                            admission_mod.AdmissionRefused)):
            _gate(name, desc)


def test_signed_override_still_reaches_a_pending_row():
    rows = [(n, d) for n, d in _rows("pending")
            if d["method"] == "GET" and not admission_mod.touches_learner_data(
                ex.catalog_descriptor_to_entry(n, d["method"], d["path"]))]
    name, desc = rows[0]
    status, (audit, _record) = _gate(name, desc)
    assert status == "pending"
    assert audit and audit.get("allow_unproven") is True
