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
  C-420  gradeable_students               GET assignments/{id}/gradeable_students
  C-421  gradeable_students               GET courses/{id}/assignments/gradeable_students
  C-422  students/submissions             GET courses/{id}/students/submissions
  C-430  submission_summary               GET assignments/{id}/submission_summary

Grade WRITES (C-415..C-418 and every other W row) are NOT in scope and
stay held. This battery performs zero writes: every call is a GET
through the helper's authenticated browser session, the same transport
the executor uses.

Safety:
  - Uses this tree's configured helper route. Importing the driver changes no route.
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
import tempfile
from collections import Counter
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlsplit

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
     "/api/v1/courses/{c}/assignments/{a}/gradeable_students",
     "student_list"),
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
        return True, "object with %d properties" % len(payload), True
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
        return True, "object with %d properties" % len(payload), True
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
        if not all(isinstance(item, dict) for item in payload):
            return False, "student list contains a non-object", True
        return True, "list[%d]" % len(payload), True
    if kind == "summary":
        if not isinstance(payload, dict):
            return False, "expected an object, got %s" % type(
                payload).__name__, False
        return True, "summary with %d properties" % len(payload), False
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
    identity = _catalog_identity(row_id)
    expected_path = url_template.split("?", 1)[0]
    for short, canonical in [("c", "course_id"), ("a", "assignment_id"),
                             ("u", "user_id"), ("anon", "anonymous_id")]:
        expected_path = expected_path.replace("{" + short + "}", "{" + canonical + "}")
    if identity["method"] != "GET" or identity["effect"] != "R" or identity["path_template"] != expected_path:
        outcome["detail"] = "battery endpoint does not match the authoritative catalog"
        return outcome
    outcome.update(identity)
    outcome["url"] = identity["path_template"]
    if row_id == "C-413" and not ctx["anonymous_id"]:
        outcome["status"] = "NOT-APPLICABLE"
        outcome["detail"] = ("no --anonymous-id given and the battery will "
                             "not guess one; rerun with --anonymous-id from "
                             "an anonymously-graded assignment")
        return outcome
    url = url_template.format(
        c=quote(str(ctx["course"]), safe=""), a=quote(str(ctx["assignment"]), safe=""),
        u=quote(str(ctx["user_id"] or ""), safe=""),
        anon=quote(str(ctx["anonymous_id"] or ""), safe=""),
        student_ids=ctx["student_ids_param"])
    outcome["query_keys"] = dict(Counter(key for key, _ in parse_qsl(urlsplit(url).query, keep_blank_values=True)))

    # 1. Admission: admits on the vault-ready lane, refuses elsewhere.
    entry = {"name": row_id, "provider": "canvas",
             "request": {"url": url.split("?", 1)[0]}}
    try:
        _admission.check_learner_data(entry, policy, vault_ready=True)
    except Exception:
        outcome["detail"] = "admission refused on the vault-ready lane"
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
        if row_id in ("C-419", "C-420", "C-421", "C-422"):
            status, payload, note = reader.get_paginated(url)
        else:
            payload = reader.get_json(url)
            status, note = 200, None
    except Exception:
        outcome["detail"] = "GET failed; no complete result was available"
        return outcome
    outcome["http"] = status
    if status != 200:
        outcome["detail"] = "GET returned HTTP %s" % status
        return outcome
    if note:
        outcome["status"] = "FAILED"
        outcome["detail"] = "pagination did not complete"
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
    except Exception:
        outcome["detail"] = "privacy projection refused the result"
        return outcome
    projected_json = json.dumps(projected.get("receipt"),
                                sort_keys=True, default=str)

    # 5. Leak scan: no raw identifier may survive.
    identifiers, roster_size = _harvest_identifiers(payload, educator_id)
    outcome["roster_size"] = roster_size
    outcome["identifiers_checked"] = len(identifiers)
    leaks = _leak_scan(projected_json, identifiers)
    if leaks:
        outcome["detail"] = "privacy projection retained %d raw identifiers" % len(leaks)
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
        try:
            projected2 = _wire.project_learner_result(
                proj_entry, result, tenant, lane_context=lane_context,
                error_cls=RuntimeError)
        except Exception:
            outcome["detail"] = "second privacy projection refused the result"
            return outcome
        projected2_json = json.dumps(projected2.get("receipt"),
                                     sort_keys=True, default=str)
        labels2 = sorted(set(_LABEL_RE.findall(projected2_json)))
        if labels != labels2:
            outcome["detail"] = ("labels unstable across projections: %s "
                                 "vs %s" % (labels[:5], labels2[:5]))
            return outcome
        outcome["labels_stable"] = True

    if row_id == "C-419":
        ids = []
        for item in payload:
            uid = item.get("user_id") if isinstance(item, dict) else None
            if isinstance(uid, (str, int)) and not isinstance(uid, bool):
                uid = str(uid)
                if re.fullmatch(r"[1-9][0-9]{0,18}", uid) and uid != str(educator_id) and uid not in ids:
                    ids.append(uid)
        if ids:
            ctx["user_id"] = ids[0]
            ctx["student_ids_param"] = "&".join("student_ids[]=%s" % uid for uid in ids[:5])

    outcome["status"] = "PROVEN"
    outcome["detail"] = ("200, shape ok, %d learner(s) harvested, %d "
                         "identifier(s) checked, zero leaks, labels stable"
                         % (roster_size, len(identifiers)))
    return outcome


# ---------------------------------------------------------------------------
# Catalog update
# ---------------------------------------------------------------------------

def _catalog_identity(row_id):
    if row_id not in {row[0] for row in ROWS}:
        raise ValueError("row is outside the learner-read battery")
    lines = Path(CATALOG_PATH).read_text(encoding="utf-8").splitlines()
    matches = [line for line in lines if line.startswith("| %s |" % row_id)]
    if len(matches) != 1:
        raise ValueError("catalog row is missing or duplicated")
    fields = [part.strip() for part in matches[0].strip().strip("|").split("|")]
    if len(fields) != 8 or fields[2] != "GET" or fields[4] != "R" or "[LEARNER-DATA]" not in fields[6]:
        raise ValueError("catalog row is not a learner-data read")
    return dict(zip(["row", "tool", "method", "path_template", "effect", "mechanism"], fields[:6]))


def _catalog_updates(outcomes, stamp, evidence_name):
    """The exact new row text for each PROVEN row."""
    updates = []
    with open(CATALOG_PATH, "r", encoding="utf-8") as fh:
        lines = fh.readlines()
    for outcome in outcomes:
        if outcome["status"] != "PROVEN":
            continue
        row_id = outcome["row"]
        identity = _catalog_identity(row_id)
        if any(outcome.get(key) != value for key, value in identity.items()):
            raise ValueError("proof does not match the authoritative operation")
        for i, line in enumerate(lines):
            if line.startswith("| %s |" % row_id) \
                    and "pending [LEARNER-DATA]" in line:
                parts = [p.strip() for p in line.strip().strip("|").split("|")]
                parts[6] = "live-proven [LEARNER-DATA]"
                parts[7] = ("live-proven %s via proof-battery/"
                            "learner_data_reads_battery.py; evidence %s"
                            % (stamp, evidence_name))
                new_line = "| " + " | ".join(parts) + " |\n"
                updates.append((row_id, i, line, new_line))
                lines[i] = new_line
                break
    return updates, lines


def _validate_catalog_candidate(lines, updates):
    from dispatch import executor
    descriptor_path, cache = executor._OPERATION_CATALOG_PATH, executor._OPERATION_CATALOG_CACHE
    descriptor, candidate = tempfile.mkstemp(prefix=".learner-catalog-", dir=os.path.dirname(CATALOG_PATH))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.writelines(lines)
        executor._OPERATION_CATALOG_PATH = candidate
        executor._OPERATION_CATALOG_CACHE = None
        parsed = executor._load_operation_catalog()
        for row_id, _, _, _ in updates:
            identity = _catalog_identity(row_id)
            actual = parsed.get(identity["tool"])
            if not actual or actual["id"] != row_id or actual["method"] != "GET" \
                    or actual["path"] != identity["path_template"] or actual["effect"] != "read" \
                    or actual["status"] != "live-proven" or not actual["learner_data"]:
                raise ValueError("candidate failed the executor catalog parser")
    finally:
        executor._OPERATION_CATALOG_PATH, executor._OPERATION_CATALOG_CACHE = descriptor_path, cache
        os.unlink(candidate)


def _write_evidence(evidence, evidence_name):
    os.makedirs(EVIDENCE_DIR, mode=0o700, exist_ok=True)
    path = os.path.join(EVIDENCE_DIR, evidence_name)
    descriptor, temporary = tempfile.mkstemp(prefix=".learner-evidence-", dir=EVIDENCE_DIR)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(evidence, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def _installed_tree():
    return any(os.path.isfile(os.path.join(_TREE_ROOT, name)) for name in
               ("release-manifest.json", "pack/carve-manifest.json"))


def _publish_results(outcomes, stamp, evidence, apply=False):
    if apply and _installed_tree():
        raise ValueError("catalog promotion is available only in the source checkout")
    evidence_name = "learner_data_reads_battery_%s.json" % stamp.replace(":", "-")
    original = Path(CATALOG_PATH).read_bytes()
    updates, lines = _catalog_updates(outcomes, stamp, evidence_name)
    _validate_catalog_candidate(lines, updates)
    evidence_path = _write_evidence(evidence, evidence_name)
    if apply and updates:
        descriptor, temporary = tempfile.mkstemp(prefix=".learner-catalog-", dir=os.path.dirname(CATALOG_PATH))
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.writelines(lines)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, os.stat(CATALOG_PATH).st_mode & 0o777)
            if Path(CATALOG_PATH).read_bytes() != original:
                raise ValueError("catalog changed during proof publication")
            os.replace(temporary, CATALOG_PATH)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return evidence_path, updates


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
    if args.apply and _installed_tree():
        _fail("catalog promotion is available only in the source checkout")
    if not re.fullmatch(r"[1-9][0-9]{0,18}", args.course) or not re.fullmatch(r"[1-9][0-9]{0,18}", args.assignment):
        _fail("course and assignment must be positive Canvas IDs")

    stamp = _dt.datetime.now(
        _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    evidence_name = "learner_data_reads_battery_%s.json" % stamp.replace(
        ":", "-")

    print("learner-data reads battery (configured tree helper)")
    print("course=%s assignment=%s" % (args.course, args.assignment))

    # Helper health: fail fast without a live educator session.
    reader = _live_read.LiveReader(_live_read.tenant_base())
    tenant = _live_read.tenant_base()
    if not tenant:
        _fail("no Canvas base URL (CANVAS_BASE); refusing to run blind")
    try:
        reader.health_check()
    except _live_read.LiveReadError:
        _fail("helper/educator session is not ready")
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
    finally:
        reader.close()

    # Evidence (sanitized: shapes and counts only).
    evidence = {
        "battery": "learner_data_reads_battery",
        "stamp": stamp,
        "tenant": tenant,
        "helper_route": "configured tree helper",
        "course_id": args.course,
        "assignment_id": args.assignment,
        "principal": reader.principal,
        "cryptography": True,
        "rows": outcomes,
    }
    evidence_path, updates = _publish_results(outcomes, stamp, evidence, apply=args.apply)
    print("evidence: %s" % evidence_path)

    proven = [o["row"] for o in outcomes if o["status"] == "PROVEN"]
    print("PROVEN: %s" % (", ".join(proven) if proven else "none"))
    for o in outcomes:
        if o["status"] not in ("PROVEN",):
            print("  %s -> %s: %s" % (o["row"], o["status"], o["detail"]))

    if args.apply:
        if not updates:
            print("nothing to apply: no PROVEN rows")
        else:
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
