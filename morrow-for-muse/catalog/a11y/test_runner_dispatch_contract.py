#!/usr/bin/env python3
"""The a11y runner reads through the executor's real result shape.

dispatch_catalog_op returns the provider object under "receipt"; the
runner must read it from there and must ask for the educator-channel
admission explicitly (never inherit a weaker default).
"""

import os
import sys

TREE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
for _p in (TREE, os.path.join(TREE, "catalog", "a11y")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from catalog.a11y import runner as R  # noqa: E402
from dispatch import executor as ex  # noqa: E402

HTML = "<html><body><h1>T</h1><img src='x.png'></body></html>"


class _Session:
    def close(self):
        pass


def test_runner_reads_receipt_and_requires_educator_channel(monkeypatch):
    calls = []

    def fake_dispatch(name, method, path, effect_class=None, params=None,
                      **kw):
        calls.append(kw)
        return {"op_id": "x", "entry_name": name, "outcome": "read",
                "verified": False, "verification": {"status": "skipped"},
                "receipt": {"title": "Fake", "body": HTML},
                "truncated": False, "truncation": None,
                "bytes_received": len(HTML), "attempts": 1}

    monkeypatch.setattr(ex, "dispatch_catalog_op", fake_dispatch)
    report = R.run_audit("canvas_page", "89585", {"page_url": "fake-page"},
                         session=_Session())
    assert report["evidence"]["html_chars"] == len(HTML)
    assert calls and calls[0].get("require_educator_channel") is True
