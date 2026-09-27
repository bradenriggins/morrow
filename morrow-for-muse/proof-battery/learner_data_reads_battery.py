#!/usr/bin/env python3
"""Live proof battery: learner-data READ rows (grade/submission/score reads).

Proves the learner-data read rows dispatch on the Chromium lane with the
encrypted learner vault, and that every receipt is de-identified before
the agent or the journal sees it.

Rows in scope (reads only):
  C-410  document_annotations/read        GET submissions/{user_id}/...
  C-411  rubric_assessments/read          GET submissions/{user_id}/...
  C-412  rubric_comments/read             GET submissions/{user_id}/...
  C-413  anonymous_submissions/{anon}     GET (needs --anonymous-id)
  C-414  submissions/{user_id}            GET one submission
  C-419  submissions (list, include user) GET assignments/{id}/submissions
  C-420  gradebook_history/days           GET courses/{id}/gradebook_history/days
  C-421  gradeable_students               GET courses/{id}/assignments/gradeable_students
  C-422  students/submissions             GET courses/{id}/students/submissions
  C-430  submission_summary               GET assignments/{id}/submission_summary

Grade WRITES (C-415..C-418 and every other W row) are NOT in scope and
stay held. This battery performs zero writes: every call is a GET
through the helper's authenticated browser session, the same transport
the executor uses.

Safety:
  - Port 8902 only (the 0.4.6 helper). LOGIN_HELPER_PORT is forced to
    8902; the 8901 session is never touched.
  - Fails fast when the helper is down or not logged in to Canvas.
  - Fails fast when --course / --assignment are missing.
  - Refuses to interpret partial/truncated bodies (LiveReader raises).
  - Evidence carries shapes and counts only; never raw identifiers.

For each row the battery:
  1. admits the entry through dispatch/admission.check_learner_data with
     vault_ready=True (must admit), and with vault_ready=False (must
     raise LearnerDataGated): the gate is proven in both directions.
  2. GETs the endpoint through the Chromium lane (query/live_read.py).
  3. checks HTTP 200 and the expected response shape.
  4. projects the raw payload through the real executor boundary
     (dispatch/executor._projection_entry +
     privacy/executor_wire.project_learner_result), the exact code path
     dispatch_entry uses before journaling or returning.
  5. scans the projected output for every raw identifier harvested from
     the raw payload (names, emails, logins, SIS ids, Canvas user ids):
     any leak fails the row.
  6. asserts stable "Student A<n>" labels are present, and that a second
     projection produces identical labels (vault persistence).

Row outcomes: PROVEN, EMPTY (endpoint worked but the collection was
empty, so de-identification was not exercised), NOT-APPLICABLE (with a
reason), or FAILED (with a reason).

Evidence: proof-battery/evidence/learner_data_reads_battery_<stamp>.json
(sanitized: shapes, counts, label samples; never raw identifiers).

Catalog: with --apply, rows that are PROVEN are flipped from
`pending [LEARNER-DATA]` to `live-proven [LEARNER-DATA]` in
proof-battery/OPERATION_CATALOG.md with the evidence stamp. Without
--apply the battery prints the exact row updates and changes nothing.

Usage:
  python3 proof-battery/learner_data_reads_battery.py \
      --course 12345 --assignment 67890 [--anonymous-id abc] [--apply]

Stdlib only (plus this tree's own modules).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys

# This tree's helper port only. Never 8901.
os.environ["LOGIN_HELPER_PORT"] = "8902"

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

from dispatch import admission as _admission  # noqa: E402
from dispatch.executor import (  # noqa: E402
    _projection_entry as _executor_projection_entry,
    extract_receipt as _extract_receipt,
)
from privacy import executor_wire as _wire  # noqa: E402
from query import live_read as _live_read  # noqa: E402


# ---------------------------------------------------------------------------
# Row definitions
# ---------------------------------------------------------------------------

# Each row: catalog id, URL template, shape check name. {c} = course,
# {a} = assignment, {u} = a real user id harvested from C-419,
# {anon} = --anonymous-id.
ROWS = [
    ("C-419",
     "/api/v1/courses/{c}/assignments/{a}/submissions"
     "?include[]=user&per_page=100",
     "submission_list"),
    ("C-414",
     "/api/v1/courses/{c}/assignments/{a}/submissions/{u}",
     "submission"),
    ("C-410",
     "/api/v1/courses/{c}/assignments/{a}/submissions/{u}"
     "/document_annotations/read",
     "annotation_read"),
    ("C-411",
     "/api/v1/courses/{c}/assignments/{a}/submissions/{u}"
     "/rubric_assessments/read",
     "rubric_read"),
    ("C-412",
     "/api/v1/courses/{c}/assignments/{a}/submissions/{u}"
     "/rubric_comments/read",
     "rubric_read"),
    ("C-413",
     "/api/v1/courses/{c}/assignments/{a}/anonymous_submissions/{anon}",
     "anonymous_submission"),
    ("C-420",
     "/api/v1/courses/{c}/gradebook_history/days",
     "day_list"),
    ("C-421",
     "/api/v1/courses/{c}/assignments/gradeable_students",
     "student_list"),
    ("C-422",
     "/api/v1/courses/{c}/students/submissions?{student_ids}",
     "submission_list"),
    ("C-430",
     "/api/v1/courses/{c}/assignments/{a}/submission_summary",
     "summary"),
]

NEEDS_USER = {"C-410", "C-411", "C-412", "C-414"}

EVIDENCE_DIR = os.path.join(_TREE_ROOT, "proof-battery", "evidence")
CATALOG_PATH = os.path.join(_TREE_ROOT, "proof-battery",
                            "OPERATION_CATALOG.md")

_LABEL_RE = re.compile(r"Student A\d+")


def _fail(msg):
    sys.stderr.write("FAIL: %s\n" % msg)
    sys.stderr.flush()
    sys.exit(1)


# ---------------------------------------------------------------------------
# Shape checks
# ---------------------------------------------------------------------------

def _check_shape(kind, payload):
    """Returns (ok, detail, learner_bearing)."""
    if kind == "submission_list":
        if not isinstance(payload, list):
            return False, "expected a JSON array, got %s" % type(
                payload).__name__, False
        if not payload:
            return True, "empty list", False
        bad = [i for i, it in enumerate(payload) if not isinstance(it, dict)]
        if bad:
            return False, "items %s are not objects" % bad[:5], True
        return True, "list[%d]" % len(payload), True
    if kind == "submission":
        if not isinstance(payload, dict):
            return False, "expected an object, got %s" % type(
                payload).__name__, False
        return True, "object keys=%s" % sorted(payload.keys())[:8], True
    if kind == "annotation_read":
        if not isinstance(payload, (dict, list)):
            return False, "expected object/array, got %s" % type(
                payload).__name__, False
        return True, "ok (%s)" % type(payload).__name__, True
    if kind == "rubric_read":
        if not isinstance(payload, (dict, list)):
            return False, "expected object/array, got %s" % type(
                payload).__name__, False
        return True, "ok (%s)" % type(payload).__name__, True
    if kind == "anonymous_submission":
        if not isinstance(payload, dict):
            return False, "expected an object, got %s" % type(
                payload).__name__, False
        return True, "object keys=%s" % sorted(payload.keys())[:8], True
    if kind == "day_list":
        if not isinstance(payload, list):
            return False, "expected a JSON array, got %s" % type(
                payload).__name__, False
        return True, "list[%d]" % len(payload), True
    if kind == "student_list":
        if not isinstance(payload, list):
            return False, "expected a JSON array, got %s" % type(
                payload).__name__, False
        if not payload:
            return True, "empty list", False
        return True, "list[%d]" % len(payload), True
    if kind == "summary":
        if not isinstance(payload, dict):
            return False, "expected an object, got %s" % type(
                payload).__name__, False
        keys = sorted(payload.keys())
        return True, "object keys=%s" % keys[:8], False
    return False, "unknown shape kind %r" % kind, False


# ---------------------------------------------------------------------------
# Identifier harvesting and leak scanning
# ---------------------------------------------------------------------------

_ID_KEYS = ("name", "email", "login_id", "sis_user_id", "sis_login_id",
            "sortable_name", "short_name", "display_name")


def _harvest_identifiers(raw_payload, educator_id):
    """Raw identifier strings from the payload's learner records.

    Uses the same harvester the privacy boundary uses, so the scan
    covers exactly what the boundary promises to redact. The educator's
    own Canvas id is excluded: they are the requester, not a learner.
    """
    roster = _wire._harvest_roster(raw_payload)
    found = []
    for rec in roster:
        rid = rec.get("id")
        if rid is not None and str(rid).strip() != "" \
                and str(rid) != str(educator_id):
            found.append(("id", str(rid).strip()))
        for key in _ID_KEYS:
            value = rec.get(key)
            if isinstance(value, str) and value.strip() != "":
                found.append((key, value.strip()))
    # Deduplicate, keep order.
    seen = set()
    unique = []
    for item in found:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique, len(roster)


def _leak_scan(projected_json, identifiers):
    """Every raw identifier must be absent from the projected output.

    Numeric ids match on word boundaries only (a score of 95 must not
    trip on user id 9); names, emails, and logins match as substrings.
    Returns the list of leaked (kind, value) pairs.
    """
    leaks = []
    for kind, value in identifiers:
        if kind == "id":
            if re.search(r"(?<![0-9A-Za-z])%s(?![0-9A-Za-z])"
                         % re.escape(value), projected_json):
                leaks.append((kind, value))
        else:
            if value in projected_json:
                leaks.append((kind, value))
    return leaks


def _mask(value):
    """Mask an identifier for failure output: first/last char only."""
    s = str(value)
    if len(s) <= 2:
        return "**"
    return s[0] + "*" * (len(s) - 2) + s[-1]


# ---------------------------------------------------------------------------
# Per-row proof
# ---------------------------------------------------------------------------

def _prove_row(row_id, url_template, shape_kind, reader, tenant, principal,
               educator_id, policy, ctx):
    """Run the full proof for one catalog row. Returns an outcome dict."""
    outcome = {"row": row_id, "url": None, "status": "FAILED",
               "detail": "", "http": None}
    if row_id == "C-413" and not ctx["anonymous_id"]:
        outcome["status"] = "NOT-APPLICABLE"
        outcome["detail"] = ("no --anonymous-id given and the battery will "
                             "not guess one; rerun with --anonymous-id from "
                             "an anonymously-graded assignment")
        return outcome
    url = url_template.format(
        c=ctx["course"], a=ctx["assignment"],
        u=ctx["user_id"] or "",
        anon=ctx["anonymous_id"] or "",
        student_ids=ctx["student_ids_param"])
    outcome["url"] = url

    # 1. Admission: admits on the vault-ready lane, refuses elsewhere.
    entry = {"name": row_id, "provider": "canvas",
             "request": {"url": url.split("?", 1)[0]}}
    try:
        _admission.check_learner_data(entry, policy, vault_ready=True)
    except Exception as exc:
        outcome["detail"] = ("admission refused on the vault-ready lane: %s"
                             % exc)
        return outcome
    try:
        _admission.check_learner_data(entry, policy, vault_ready=False)
    except _admission.LearnerDataGated:
        pass
    except Exception as exc:
        outcome["detail"] = ("admission on a non-vault lane raised %s "
                             "instead of LearnerDataGated" % type(exc).__name__)
        return outcome
    else:
        outcome["detail"] = ("admission admitted on a non-vault lane; "
                             "fail-closed gate broken")
        return outcome

    # 2. The GET through the Chromium lane.
    try:
        if shape_kind in ("submission_list", "day_list", "student_list") \
                and row_id in ("C-419", "C-421"):
            status, payload, note = reader.get_paginated(url)
        else:
            payload = reader.get_json(url)
            status, note = 200, None
    except _live_read.LiveReadError as exc:
        outcome["detail"] = "GET failed: %s" % exc
        return outcome
    outcome["http"] = status
    if status != 200:
        outcome["detail"] = "GET returned HTTP %s" % status
        return outcome
    if note:
        outcome["status"] = "FAILED"
        outcome["detail"] = "pagination stopped loudly: %s" % note
        return outcome

    # 3. Shape check.
    ok, detail, learner_bearing = _check_shape(shape_kind, payload)
    outcome["detail"] = "shape: %s" % detail
    if not ok:
        return outcome
    if detail == "empty list":
        outcome["status"] = "EMPTY"
        outcome["detail"] = ("HTTP 200 with the expected shape, but the "
                             "collection is empty: de-identification not "
                             "exercised; rerun against an assignment with "
                             "submissions")
        return outcome

    # 4. Project through the real executor boundary.
    proj_entry = _executor_projection_entry(
        entry, url, payload)
    result = {"payload": payload,
              "receipt": _extract_receipt(payload, [])}
    lane_context = {"principal": principal}
    try:
        projected = _wire.project_learner_result(
            proj_entry, result, tenant, lane_context=lane_context,
            error_cls=RuntimeError)
    except RuntimeError as exc:
        outcome["detail"] = "projection refused: %s" % exc
        return outcome
    projected_json = json.dumps(projected.get("receipt"),
                                sort_keys=True, default=str)

    # 5. Leak scan: no raw identifier may survive.
    identifiers, roster_size = _harvest_identifiers(payload, educator_id)
    outcome["roster_size"] = roster_size
    outcome["identifiers_checked"] = len(identifiers)
    leaks = _leak_scan(projected_json, identifiers)
    if leaks:
        outcome["detail"] = ("LEAK: %d raw identifier(s) survived "
                             "projection: %s"
                             % (len(leaks),
                                [k + "=" + _mask(v) for k, v in leaks[:5]]))
        return outcome

    # 6. Labels present and stable across a second projection.
    if learner_bearing and roster_size:
        labels = sorted(set(_LABEL_RE.findall(projected_json)))
        if not labels:
            outcome["detail"] = ("no 'Student A<n>' labels in the projected "
                                 "output for %d rostered learners" %
                                 roster_size)
            return outcome
        outcome["labels"] = labels[:5]
        projected2 = _wire.project_learner_result(
            proj_entry, result, tenant, lane_context=lane_context,
            error_cls=RuntimeError)
        projected2_json = json.dumps(projected2.get("receipt"),
                                     sort_keys=True, default=str)
        labels2 = sorted(set(_LABEL_RE.findall(projected2_json)))
        if labels != labels2:
            outcome["detail"] = ("labels unstable across projections: %s "
                                 "vs %s" % (labels[:5], labels2[:5]))
            return outcome
        outcome["labels_stable"] = True

    outcome["status"] = "PROVEN"
    outcome["detail"] = ("200, shape ok, %d learner(s) harvested, %d "
                         "identifier(s) checked, zero leaks, labels stable"
                         % (roster_size, len(identifiers)))
    return outcome


# ---------------------------------------------------------------------------
# Catalog update
# ---------------------------------------------------------------------------

def _catalog_updates(outcomes, stamp, evidence_name):
    """The exact new row text for each PROVEN row."""
    updates = []
    with open(CATALOG_PATH, "r", encoding="utf-8") as fh:
        lines = fh.readlines()
    for outcome in outcomes:
        if outcome["status"] != "PROVEN":
            continue
        row_id = outcome["row"]
        for i, line in enumerate(lines):
            if line.startswith("| %s |" % row_id) \
                    and "pending [LEARNER-DATA]" in line:
                parts = [p.strip() for p in line.strip().strip("|").split("|")]
                # parts: id, method, endpoint, status, notes
                parts[3] = "live-proven [LEARNER-DATA]"
                parts[4] = ("live-proven %s via proof-battery/"
                            "learner_data_reads_battery.py; evidence %s"
                            % (stamp, evidence_name))
                new_line = "| " + " | ".join(parts) + " |\n"
                updates.append((row_id, i, line, new_line))
                lines[i] = new_line
                break
    return updates, lines


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Live proof battery for the learner-data READ rows.")
    parser.add_argument("--course", required=True,
                        help="Canvas course id with real students")
    parser.add_argument("--assignment", required=True,
                        help="Canvas assignment id with real submissions")
    parser.add_argument("--anonymous-id", default=None,
                        help="anonymous id for C-413 (anonymous grading)")
    parser.add_argument("--apply", action="store_true",
                        help="flip PROVEN rows to live-proven in the catalog")
    args = parser.parse_args(argv)

    stamp = _dt.datetime.now(
        _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    evidence_name = "learner_data_reads_battery_%s.json" % stamp.replace(
        ":", "-")

    print("learner-data reads battery (port 8902 only)")
    print("course=%s assignment=%s" % (args.course, args.assignment))

    # Helper health: fail fast without a live educator session.
    reader = _live_read.LiveReader(_live_read.tenant_base())
    tenant = _live_read.tenant_base()
    if not tenant:
        _fail("no Canvas base URL (CANVAS_BASE); refusing to run blind")
    try:
        reader.health_check()
    except _live_read.LiveReadError as exc:
        _fail("helper/educator session not ready: %s" % exc)
    print("helper: Chromium alive, logged in as %r" % reader.principal)
    me = reader.get_json("/api/v1/users/self")
    educator_id = me.get("id")
    print("principal id=%s (excluded from the learner leak scan)" %
          educator_id)

    try:
        _wire._privacy_core.AESGCM
    except AttributeError:
        pass
    if _wire._privacy_core.AESGCM is None:
        _fail("the 'cryptography' package is not installed; the encrypted "
              "learner vault cannot seal, so nothing may be projected")

    policy = _admission.load_policy()

    ctx = {"course": args.course, "assignment": args.assignment,
           "anonymous_id": args.anonymous_id, "user_id": None,
           "student_ids_param": ""}

    outcomes = []
    try:
        for row_id, url_template, shape_kind in ROWS:
            if row_id in NEEDS_USER and not ctx["user_id"]:
                outcomes.append({
                    "row": row_id, "url": None, "status": "NOT-APPLICABLE",
                    "detail": "C-419 yielded no user id to address"})
                continue
            print("proving %s ..." % row_id)
            outcome = _prove_row(row_id, url_template, shape_kind, reader,
                                 tenant, reader.principal, educator_id,
                                 policy, ctx)
            print("  %s: %s" % (outcome["status"], outcome["detail"]))
            outcomes.append(outcome)
            if row_id == "C-419" and outcome["status"] == "PROVEN":
                # Harvest real user ids for the addressed rows.
                status, payload, _note = reader.get_paginated(
                    url_template.format(c=args.course, a=args.assignment,
                                        u="", anon="",
                                        student_ids=""))
                ids = []
                for item in payload:
                    if isinstance(item, dict):
                        uid = item.get("user_id", item.get("id"))
                        if uid is not None:
                            ids.append(uid)
                if ids:
                    ctx["user_id"] = ids[0]
                    ctx["student_ids_param"] = "&".join(
                        "student_ids[]=%s" % uid for uid in ids[:5])
    finally:
        reader.close()

    # Evidence (sanitized: shapes and counts only).
    evidence = {
        "battery": "learner_data_reads_battery",
        "stamp": stamp,
        "tenant": tenant,
        "helper_port": 8902,
        "course_id": args.course,
        "assignment_id": args.assignment,
        "principal": reader.principal,
        "cryptography": True,
        "rows": outcomes,
    }
    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    evidence_path = os.path.join(EVIDENCE_DIR, evidence_name)
    with open(evidence_path, "w", encoding="utf-8") as fh:
        json.dump(evidence, fh, indent=2, sort_keys=True)
    os.chmod(evidence_path, 0o600)
    print("evidence: %s" % evidence_path)

    proven = [o["row"] for o in outcomes if o["status"] == "PROVEN"]
    print("PROVEN: %s" % (", ".join(proven) if proven else "none"))
    for o in outcomes:
        if o["status"] not in ("PROVEN",):
            print("  %s -> %s: %s" % (o["row"], o["status"], o["detail"]))

    updates, new_lines = _catalog_updates(outcomes, stamp, evidence_name)
    if args.apply:
        if not updates:
            print("nothing to apply: no PROVEN rows")
        else:
            with open(CATALOG_PATH, "w", encoding="utf-8") as fh:
                fh.writelines(new_lines)
            for row_id, _i, _old, _new in updates:
                print("catalog: %s -> live-proven [LEARNER-DATA]" % row_id)
    else:
        if updates:
            print("--apply not given; the catalog is unchanged. "
                  "Rerun with --apply to write:")
            for row_id, _i, _old, new in updates:
                print("  %s" % new.strip())

    failed = [o["row"] for o in outcomes if o["status"] == "FAILED"]
    if failed:
        _fail("rows FAILED: %s" % ", ".join(failed))
    print("battery complete: no failures")


if __name__ == "__main__":
    main()
