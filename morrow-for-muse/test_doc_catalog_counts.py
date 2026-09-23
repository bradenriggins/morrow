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


# Failure mode (final sweep 2026-09-23, written before the fix): three
# knowledge docs SKILL.md tells the agent to read said Item Bank item
# create and update (IB-6, IB-18) were pending ("do not dispatch against
# real items, do not claim them") after the catalog marked them
# live-proven, so the agent refused a task the Muse page offers.
IB_DOCS = ("SKILL.md", "SCOPE.md", "knowledge/operations-runbook.md",
           "knowledge/api-catalog-guide.md",
           "knowledge/new-quizzes-contract.md", "knowledge/item-banks-sdk.md",
           "knowledge/api-patterns-and-errors.md",
           "knowledge/audit-checklist.md")
_NOT_PROVEN = re.compile(
    r"pending|unproven|not proven|never proven|evidence-hold|"
    r"not (?:a )?v1 claims?|do not claim|not implemented", re.I)
_PROVEN = re.compile(r"live-proven", re.I)


def _ib_status():
    out = {}
    with open(CATALOG, encoding="utf-8") as fh:
        for line in fh:
            f = [x.strip() for x in line.rstrip("\n").split("|")]
            if len(f) >= 9 and re.fullmatch(r"IB-\d+", f[1]):
                out[f[1]] = (f[7].split() or [""])[0]
    return out


def _ib_ids(clause):
    ids = []
    for m in re.finditer(r"IB-(\d+)((?:/(?:IB-)?\d+)*)", clause):
        ids.append("IB-" + m.group(1))
        ids += ["IB-" + n for n in re.findall(r"/(?:IB-)?(\d+)", m.group(2))]
    return ids


def test_every_item_bank_status_claim_matches_the_catalog():
    status = _ib_status()
    assert status["IB-6"] == status["IB-18"] == "live-proven"
    wrong = []
    for rel in IB_DOCS:
        text = _read(rel)
        for clause in re.split(r"(?<=[.;])\s+|\s+-\s+(?=\S)|\*\*|\|", text):
            ids = _ib_ids(clause)
            negative = bool(_NOT_PROVEN.search(clause))
            positive = bool(_PROVEN.search(clause))
            if negative and not positive:
                wrong += [(rel, i, "said not proven") for i in ids
                          if status.get(i) == "live-proven"]
            elif positive and not negative:
                wrong += [(rel, i, "said live-proven") for i in ids
                          if status.get(i) != "live-proven"]
    assert wrong == []
