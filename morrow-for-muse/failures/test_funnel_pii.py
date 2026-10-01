#!/usr/bin/env python3
"""Agent-visible failure detail names no learner email addresses.

A throw site that interpolates "no user jane@school.edu" must read
"no user [redacted]@school.edu" in engineering_detail: routable for
debugging, naming no one. Secrets keep their own scrubber; this suite
covers the PII layer only.
"""

import os
import sys

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE not in sys.path:
    sys.path.insert(0, _TREE)

from failures.funnel import (  # noqa: E402
    agent_error_payload,
    scrub_pii,
)


def test_scrub_pii_masks_local_part_keeps_domain():
    assert (scrub_pii("no user jane.doe@school.edu found")
            == "no user [redacted]@school.edu found")


def test_scrub_pii_leaves_non_emails_alone():
    assert scrub_pii("course 101 not found") == "course 101 not found"
    assert scrub_pii("") == ""


def test_engineering_detail_masks_interpolated_email():
    payload = agent_error_payload(
        "reading the roster",
        RuntimeError("provider said: no user jane@school.edu"))
    detail = payload["engineering_detail"]
    assert "jane@school.edu" not in detail
    assert "[redacted]@school.edu" in detail
