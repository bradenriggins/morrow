#!/usr/bin/env python3
"""QOL-1 tests: human-readable audit format for catalog/a11y/runner.py.

Safety contract under test:
- the default output format is unchanged (JSON, machine-readable);
- --format human is an opt-in presentation layer only: it reads the
  report dict, never touches the provider, never alters the report;
- human output contains no em dashes (user-facing text rule).
"""

import io
import json
import os
import sys
from contextlib import redirect_stdout

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A11Y = os.path.join(TREE, "catalog", "a11y")
for _p in (TREE, A11Y):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from catalog.a11y import runner as R  # noqa: E402


HTML = ("<html><body><h1></h1>"
        "<img src='x.png'>"
        "<a href='http://example.com'>click here</a>"
        "<table><tr><td>x</td></tr></table>"
        "</body></html>")


def _report():
    scan = R._run_detectors(HTML)
    return {
        "mode": "audit",
        "audit": "morrow_audit_course_item",
        "evidence": {
            "target_kind": "canvas_page",
            "course_id": "89585",
            "target_id": "abc",
            "catalog_op": "canvas_show_page_courses",
            "html_field": "body",
            "body_sha256": "ab" * 32,
            "html_chars": len(HTML),
            "read_at": "2026-09-22T00:00:00+00:00",
        },
        "signals": scan,
        "remediation_candidate": R._remediation_candidate(scan),
        "honesty": "Signal lists are signals needing human review.",
        "completed_at": "2026-09-22T00:00:01+00:00",
    }


def test_human_renders_all_sections():
    text = R.render_human(_report())
    for section in ("Accessibility audit: canvas_page in course 89585",
                    "SOURCE SIGNALS", "CANVAS PARITY RULES",
                    "MORROW AUGMENTED RULES", "REMEDIATION", "Note:"):
        assert section in text, section
    assert "img-alt" in text


def test_human_has_no_em_dashes():
    assert "\u2014" not in R.render_human(_report())


def test_human_defensive_on_empty_report():
    text = R.render_human({})
    assert "Accessibility audit" in text


def test_human_defensive_on_unavailable_engines():
    report = _report()
    report["signals"]["canvas_parity_rules"] = {"status": "unavailable"}
    report["signals"]["augmented_rules"] = {"status": "unavailable"}
    text = R.render_human(report)
    assert "unavailable" in text


def test_default_format_is_json(monkeypatch, capsys):
    monkeypatch.setattr(R, "run_audit", lambda *a, **k: _report())
    rc = R.main(["audit", "--target-kind", "canvas_page",
                 "--course-id", "89585"])
    assert rc == 0
    out = capsys.readouterr().out
    parsed = json.loads(out)  # must be valid JSON by default
    assert parsed["mode"] == "audit"


def test_human_format_flag(monkeypatch, capsys):
    monkeypatch.setattr(R, "run_audit", lambda *a, **k: _report())
    rc = R.main(["audit", "--target-kind", "canvas_page",
                 "--course-id", "89585", "--format", "human"])
    assert rc == 0
    out = capsys.readouterr().out
    assert out.startswith("Accessibility audit:")
    with pytest.raises(json.JSONDecodeError):
        json.loads(out)


def test_bad_format_rejected(capsys):
    with pytest.raises(SystemExit) as exc:
        R.main(["audit", "--target-kind", "canvas_page",
                "--course-id", "89585", "--format", "xml"])
    assert exc.value.code == 2
