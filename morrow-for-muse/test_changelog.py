#!/usr/bin/env python3
"""The changelog reads correctly on GitHub and in the release zip.

Failure mode pinned down (written before the fix; final sweep
2026-09-23): the heading "### Form-relay lane removed (2026-09-21)" had
the first sentence of its section joined onto it, so GitHub and the
shipped CHANGELOG.md showed a heading that ran into the sentence, with
the rest of the sentence below it. Every dated heading ends at its
date.
"""

import os
import re

TREE = os.path.dirname(os.path.abspath(__file__))


def test_every_dated_heading_ends_at_its_date():
    with open(os.path.join(TREE, "CHANGELOG.md"), encoding="utf-8") as fh:
        headings = [line.rstrip("\n") for line in fh if line.startswith("#")]
    dated = [h for h in headings if re.search(r"\d{4}-\d\d-\d\d", h)]
    assert dated, "no dated heading found"
    assert [h for h in dated if not re.search(r"\d{4}-\d\d-\d\d\)$", h)] \
        == []
