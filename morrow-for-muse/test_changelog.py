#!/usr/bin/env python3
"""The changelog reads correctly on GitHub and in the release zip.

Failure mode pinned down (written before the fix; final sweep
2026-09-23): the heading "### Form-relay lane removed (2026-09-21)" had
the first sentence of its section joined onto it, so GitHub and the
shipped CHANGELOG.md showed a heading that ran into the sentence, with
the rest of the sentence below it. Every dated heading ends at its
date.

Muse UX audit round 2 (2026-09-23): the 0.4.1 notes, which become the
release notes, said "The shipped `transport/local_chromium_selftest.py`
runs in the release", but the 0.4.1 carve leaves that file out
(scripts/carve.py DEV_ONLY). The current release's notes never say a
file the carve leaves out ships or runs in the release.
"""

import os
import re
import sys

TREE = os.path.dirname(os.path.abspath(__file__))


def test_every_dated_heading_ends_at_its_date():
    with open(os.path.join(TREE, "CHANGELOG.md"), encoding="utf-8") as fh:
        headings = [line.rstrip("\n") for line in fh if line.startswith("#")]
    dated = [h for h in headings if re.search(r"\d{4}-\d\d-\d\d", h)]
    assert dated, "no dated heading found"
    assert [h for h in dated if not re.search(r"\d{4}-\d\d-\d\d\)$", h)] \
        == []


_NOT_SHIPPED = re.compile(r"(?i)\bno longer (?:ships|in the release)\b|"
                          r"\bdoes not ship\b|\bnot (?:part of|in) the "
                          r"release\b")


def _ship_claim(path, bullet):
    """True when the bullet says the file itself ships or runs in the
    release ("the shipped `x`", "`x` ships.", "`x` runs in the
    release"), not that it ships something else."""
    quoted = re.escape("`%s`" % path)
    return bool(re.search(
        r"(?i)\bshipped %s|%s (?:ships|is shipped|is in the release)"
        r"(?=[.,:;]| in\b|$)|%s[^.;]*\bruns in the release\b"
        % (quoted, quoted, quoted), bullet))


def _current_release_bullets():
    with open(os.path.join(TREE, "CHANGELOG.md"), encoding="utf-8") as fh:
        text = fh.read()
    start = text.index("\n## ") + 1
    section = text[start:text.index("\n## ", start)]
    bullets = re.split(r"\n(?=- )", section)
    return [" ".join(b.split()) for b in bullets if b.startswith("- ")]


def test_the_release_notes_never_ship_a_file_the_carve_leaves_out():
    sys.path.insert(0, os.path.join(TREE, "scripts"))
    import carve
    shipped = set(carve.shipped_files())
    wrong = []
    for bullet in _current_release_bullets():
        if _NOT_SHIPPED.search(bullet):
            continue
        for path in re.findall(r"`([\w./-]+\.(?:py|sh|json|md|txt))`",
                               bullet):
            if os.path.isfile(os.path.join(TREE, path)) \
                    and path not in shipped and _ship_claim(path, bullet):
                wrong.append(bullet)
    assert wrong == []
