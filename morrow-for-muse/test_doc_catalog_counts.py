#!/usr/bin/env python3
"""Every count of catalog rows in the docs matches the catalog itself.

Failure mode pinned down (final muse audit 2026-09-22, L4): the
catalog had 209 live-proven rows (195 Canvas + 14 Item Bank), while
SKILL.md and consent.md said 210, and the operations runbook and the
catalog guide said 456 rows with 194 + 13 live-proven. The counts are
computed here from proof-battery/OPERATION_CATALOG.md and checked in
every doc that states them.
"""

import collections
import os
import re

TREE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.path.join(TREE, "proof-battery", "OPERATION_CATALOG.md")
DOCS = ("SKILL.md", "content/consent.md", "knowledge/operations-runbook.md",
        "knowledge/api-catalog-guide.md", "INSTALL.md", "FIRST_RUN.md",
        "SCOPE.md", "DEPLOY.md", "INTEGRATION_NOTES.md")


def _rows():
    rows = []
    with open(CATALOG, encoding="utf-8") as fh:
        for line in fh:
            f = [x.strip() for x in line.rstrip("\n").split("|")]
            if len(f) >= 9 and re.fullmatch(r"(C|IB)-\d+", f[1]):
                rows.append({"kind": f[1].split("-")[0],
                             "rw": f[5].upper(),
                             "status": (f[7].split() or [""])[0]})
    return rows


def _counts():
    rows = _rows()
    status = {k: collections.Counter(r["status"] for r in rows
                                     if r["kind"] == k) for k in ("C", "IB")}
    live = [r for r in rows if r["status"] == "live-proven"]
    return {
        "total": len(rows),
        "canvas": sum(1 for r in rows if r["kind"] == "C"),
        "item_bank": sum(1 for r in rows if r["kind"] == "IB"),
        "status": status,
        "live": len(live),
        "live_reads": sum(1 for r in live if r["rw"] == "R"),
        "live_writes": sum(1 for r in live if r["rw"] == "W"),
        "live_canvas_reads": sum(1 for r in live
                                 if r["rw"] == "R" and r["kind"] == "C"),
        "live_ib_reads": sum(1 for r in live
                             if r["rw"] == "R" and r["kind"] == "IB"),
    }


def _read(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return " ".join(fh.read().split())


def test_the_executor_parses_the_same_rows():
    from dispatch import executor as ex
    parsed = ex._load_operation_catalog()
    counts = _counts()
    assert len(parsed) == counts["total"]
    assert sum(1 for r in parsed.values()
               if r["status"] == "live-proven") == counts["live"]


def test_live_proven_totals_in_every_doc():
    counts = _counts()
    seen = 0
    for rel in DOCS:
        text = _read(rel)
        for match in re.finditer(
                r"(?<![-\w])(\d{3}) (?:rows )?(?:are |marked )live-proven", text):
            seen += 1
            assert int(match.group(1)) == counts["live"], (rel, match.group(0))
        for match in re.finditer(
                r"(?<![-\w])(\d{3}) (?:rows|Canvas operations)\b", text):
            seen += 1
            assert int(match.group(1)) == counts["total"], (rel, match.group(0))
        for match in re.finditer(
                r"(?:rows total|Canvas operations) \((\d{3}) "
                r"(?:Canvas C- rows|course-level)", text):
            assert int(match.group(1)) == counts["canvas"], (rel, match.group(0))
    assert seen >= 4, "the docs no longer state the counts this test checks"


def test_status_breakdowns_in_the_knowledge_docs():
    counts = _counts()
    c, ib = counts["status"]["C"], counts["status"]["IB"]
    for rel in ("knowledge/operations-runbook.md",
                "knowledge/api-catalog-guide.md"):
        text = _read(rel)
        m = re.search(r"Canvas rows\)?: live-proven (\d+), pending (\d+), "
                      r"failed (\d+), unsupported (\d+), excluded (\d+), "
                      r"evidence-hold (\d+)", text)
        assert m, rel
        assert [int(x) for x in m.groups()] == [
            c["live-proven"], c["pending"], c["failed"], c["unsupported"],
            c["excluded"], c["evidence-hold"]], (rel, m.group(0))
        m = re.search(r"Item Bank rows: live-proven (\d+), pending (\d+), "
                      r"failed (\d+), evidence-hold (\d+)", text)
        assert m, rel
        assert [int(x) for x in m.groups()] == [
            ib["live-proven"], ib["pending"], ib["failed"],
            ib["evidence-hold"]], (rel, m.group(0))
        m = re.search(r"(\d+) Canvas rows \(C-1 through C-(\d+)\)", text)
        assert m and int(m.group(1)) == counts["canvas"] \
            and int(m.group(2)) == counts["canvas"], rel
    text = _read("knowledge/api-catalog-guide.md")
    m = re.search(r"(\d+) are reads and (\d+) are writes \((\d+) of the "
                  r"reads are Canvas rows, (\d+) are Item Bank", text)
    assert m
    assert [int(x) for x in m.groups()] == [
        counts["live_reads"], counts["live_writes"],
        counts["live_canvas_reads"], counts["live_ib_reads"]], m.group(0)


def test_live_proven_read_counts_in_every_doc():
    # SCOPE.md and the operations runbook said "113 verified GETs (108
    # Canvas plus 5 Item Bank)" after the catalog gained the educator's
    # own reads (C-436 users/self, C-437 list courses) (final sweep
    # 2026-09-23).
    counts = _counts()
    seen = 0
    for rel in DOCS:
        text = _read(rel)
        for match in re.finditer(
                r"(?<![-\w])(\d{3}) (?:verified GETs|live-proven reads)"
                r"(?: \([^)]*\))?:? \(?(\d{3}) Canvas(?: reads)? plus "
                r"(\d+) Item Bank", text):
            seen += 1
            assert [int(x) for x in match.groups()] == [
                counts["live_reads"], counts["live_canvas_reads"],
                counts["live_ib_reads"]], (rel, match.group(0))
        for match in re.finditer(r"(?<![-\w])(\d{3}) (?:verified GETs|"
                                 r"live-proven reads)", text):
            assert int(match.group(1)) == counts["live_reads"], (
                rel, match.group(0))
    assert seen >= 2, "the docs no longer state the read counts"


def _scope_section(heading):
    with open(os.path.join(TREE, "SCOPE.md"), encoding="utf-8") as fh:
        text = fh.read()
    start = text.index(heading)
    end = text.find("\n#", start + len(heading))
    return " ".join(text[start:end if end != -1 else None].split())


def test_scope_ships_the_educators_own_live_proven_reads():
    # SCOPE.md, "the exact, complete statement of what v1 ships", listed
    # course and user reads as having no catalog rows, while C-437 (list
    # your courses: the educator's first request) and C-436 (your own
    # profile) are live-proven, so the agent hedged on "Show me my
    # courses" (final sweep 2026-09-23).
    live = set()
    with open(CATALOG, encoding="utf-8") as fh:
        for line in fh:
            f = [x.strip() for x in line.split("|")]
            if len(f) >= 9 and f[1] in ("C-436", "C-437") \
                    and f[7].startswith("live-proven"):
                live.add(f[1])
    assert live == {"C-436", "C-437"}
    ships = _scope_section("## Ships in v1")
    assert "C-436" in ships and "C-437" in ships
    pending = _scope_section("### In scope but pending live proof")
    assert "courses" not in pending and "users/self" not in pending
