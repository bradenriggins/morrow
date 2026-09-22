#!/usr/bin/env python3
"""Selftest: educator approval display (W6-P1-A1 and related).

The approval UI must show the FULL payload. An earlier revision
truncated the displayed params at 8,000 characters; that cap is gone.
A truncated approval display is a consent defect: the educator must
see exactly what will be sent, all of it.

Covers:
  - W6-P1-A1: a payload whose pretty JSON exceeds the old 8,000-char
    cap renders in full: no truncation marker, and a unique tail
    string from the end of the payload is present in the output.
  - The params digest still covers the full canonical params.
  - Undo availability renders from the catalog entry.
  - The identity schedule renders educator-cited display labels.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from dispatch import approval_display

PASS = []
FAIL = []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("PASS %s" % name)
    else:
        FAIL.append(name)
        print("FAIL %s%s" % (name, (" (%s)" % detail) if detail else ""))


def _record():
    return {
        "op": "create_page",
        "category": "content",
        "channel": "educator-chat",
        "target": {"tenant": "canvas.example", "course_id": 42,
                   "course_name": "Biology 101", "term": "Fall 2026"},
        "at": "2026-09-22T10:00:00Z",
        "expires_at": "2026-09-22T11:00:00Z",
        "resolved_identities": [
            {"token": "Student A1", "displayed_as": "Student A1"},
        ],
    }


def t_full_payload_no_truncation():
    # Build params whose pretty-printed JSON is well past the old
    # 8,000-char cap, with a unique marker at the very end.
    tail_marker = "TAIL-MARKER-9f8e7d6c5b4a"
    params = {
        "title": "Week 12 Lab",
        "body": "x" * 20000,
        "tail": tail_marker,
    }
    out = approval_display.render_approval_display(_record(), params,
                                                   entry={"undo": True})
    check("w6p1a1: no truncation marker",
          "truncated for display" not in out, out[-200:])
    check("w6p1a1: unique tail marker present",
          tail_marker in out)
    check("w6p1a1: bulk body present in full",
          "x" * 20000 in out)
    check("w6p1a1: full payload header present",
          "FULL OPERATION PAYLOAD (exactly what will be sent):" in out)


def t_digest_covers_full_params():
    params = {"b": 2, "a": 1}
    d = approval_display.approval_display_dict(_record(), params)
    import hashlib
    import json
    canonical = json.dumps(params, sort_keys=True, separators=(",", ":"))
    expect = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    check("digest: sha256 of full canonical params",
          d["params_digest"] == expect, d["params_digest"])


def t_undo_and_identity_render():
    out = approval_display.render_approval_display(
        _record(), {"a": 1}, entry={"undo": True})
    check("undo: available line renders",
          "Undo      : AVAILABLE" in out)
    out2 = approval_display.render_approval_display(
        _record(), {"a": 1}, entry={})
    check("undo: not-available line renders",
          "Undo      : NOT AVAILABLE" in out2)
    check("identity: educator-cited label renders",
          "Student A1" in out)


if __name__ == "__main__":
    t_full_payload_no_truncation()
    t_digest_covers_full_params()
    t_undo_and_identity_render()
    print("approval_display_selftest: %d passed, %d failed"
          % (len(PASS), len(FAIL)))
    sys.exit(1 if FAIL else 0)
