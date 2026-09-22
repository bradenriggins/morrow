#!/usr/bin/env python3
"""Live proof of student resolution (workstream 2).

Read-only. Runs the real learners.resolve_student.resolve_in_course
pipeline against the real tenant (course 89585) through the login
helper's Chromium. Auth stays in the browser/page context; this process
never sees credentials and never performs shell-side HTTPS to Canvas.

What course 89585 actually contains (discovered 2026-09-22 by
live_verify_reads.py and confirmed here): zero real students and one
LMS test account ("LMS Test Student 2") enrolled as a regular, active
StudentEnrollment. It is a fake person but a genuine enrollment record,
so it is a perfect live fixture for the resolution ladder:

  1. exact name "LMS Test Student 2" must resolve live
     (match_kind name_exact) against the real enrollment record;
  2. near-miss "Test Student" must NOT resolve (fuzzy score below the
     0.85 threshold): StudentNotFound, fail-closed, no silent pick;
  3. nonsense query "zzz_no_such_student_zzz" must raise
     StudentNotFound with the one-record pool examined.

Privacy: the evidence records structural facts only (match kinds,
enrollment types/states, exclusion counts). The test account's numeric
user id is redacted even in the evidence file, per the tree's learner
privacy boundary.

Evidence: learners/evidence/live_resolution_<stamp>.json
Stdlib only.
"""

import datetime
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)

# Sanctioned in-tree pattern (failures/live_verify.py): live helper
# state dir before the import so _helper_request picks up the live
# helper's auth token. Transient use only; never printed or written.
os.environ["MORROW_TREE_STATE_DIR"] = os.path.expanduser(
    "~/.morrow/canvas-login-helper")

for _p in (_REPO,):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from learners.resolve_student import (  # noqa: E402
    StudentAmbiguous,
    StudentNotFound,
    StudentResolutionError,
    candidate_roles,
    helper_fetch_factory,
    resolve_in_course,
)

TENANT_BASE = "https://chcp.instructure.com"
COURSE_ID = "89585"
STAMP = "LIVE-RESOLUTION-" + datetime.datetime.now(
    datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
EVIDENCE_DIR = os.path.join(_HERE, "evidence")

REDACTED_ID = "<redacted: test-account id withheld per privacy boundary>"


def _redacted_resolution(resolution):
    cand = resolution.candidate
    enrollments = cand.get("enrollments") or []
    return {
        "resolved": True,
        "match_kind": resolution.match_kind,
        "user_id": REDACTED_ID,
        "roles": candidate_roles(cand),
        "enrollment_types": sorted(
            {e.get("type") for e in enrollments if isinstance(e, dict)}),
        "enrollment_states": sorted(
            {e.get("enrollment_state") for e in enrollments
             if isinstance(e, dict)}),
        "candidates_examined": resolution.evidence.get("candidates_examined"),
        "pool_size": resolution.evidence.get("pool_size"),
        "fetch_pages": resolution.evidence.get("fetch_pages"),
    }


def _not_found(exc):
    return {
        "resolved": False,
        "error_class": type(exc).__name__,
        "message": str(exc),
        "excluded_summary": exc.resolution_evidence.get("excluded_summary"),
        "candidates_examined": exc.resolution_evidence.get(
            "candidates_examined"),
        "pool_size": exc.resolution_evidence.get("pool_size"),
        "fetch_pages": exc.resolution_evidence.get("fetch_pages"),
    }


def main():
    fetch = helper_fetch_factory(TENANT_BASE)
    record = {
        "stamp": STAMP,
        "tenant_base": TENANT_BASE,
        "course_id": COURSE_ID,
        "note": "Read-only live run of resolve_in_course. Course 89585 "
                "holds zero real students and one LMS test account "
                "enrolled as a regular active StudentEnrollment; the "
                "account's numeric id is redacted from this evidence per "
                "the learner privacy boundary.",
        "paths": {},
    }
    failures = []
    try:
        # Path 1: exact name resolves live against the real record.
        try:
            resolution = resolve_in_course(
                fetch, TENANT_BASE, COURSE_ID, "LMS Test Student 2")
            detail = _redacted_resolution(resolution)
            detail["live_proof_ok"] = (
                detail["match_kind"] == "name_exact"
                and detail["enrollment_types"] == ["StudentEnrollment"]
                and detail["enrollment_states"] == ["active"])
            record["paths"]["exact_name_resolves_live"] = detail
            if not detail["live_proof_ok"]:
                failures.append("exact-name live resolution had wrong shape: "
                                "%r" % (detail,))
        except StudentResolutionError as exc:
            record["paths"]["exact_name_resolves_live"] = {
                "resolved": False,
                "error_class": type(exc).__name__,
                "LIVE_PROOF_FAILED": str(exc),
            }
            failures.append("exact name failed to resolve live: %s"
                            % type(exc).__name__)

        # Path 2: near-miss stays unresolved (fail-closed).
        try:
            resolve_in_course(fetch, TENANT_BASE, COURSE_ID, "Test Student")
            record["paths"]["near_miss_stays_unresolved"] = {
                "resolved": True,
                "LIVE_PROOF_FAILED": "near-miss query resolved live",
            }
            failures.append("near-miss 'Test Student' resolved live")
        except StudentNotFound as exc:
            detail = _not_found(exc)
            detail["live_proof_ok"] = detail["candidates_examined"] == 1
            record["paths"]["near_miss_stays_unresolved"] = detail
            if not detail["live_proof_ok"]:
                failures.append("near-miss saw unexpected pool: %r"
                                % (detail,))
        except StudentAmbiguous as exc:
            record["paths"]["near_miss_stays_unresolved"] = {
                "resolved": False,
                "error_class": "StudentAmbiguous",
                "LIVE_PROOF_FAILED": "near-miss was ambiguous live: %s" % exc,
            }
            failures.append("near-miss ambiguous live")

        # Path 3: nonsense query matches nothing live.
        try:
            resolve_in_course(
                fetch, TENANT_BASE, COURSE_ID, "zzz_no_such_student_zzz")
            record["paths"]["nonsense_query_no_match"] = {
                "resolved": True,
                "LIVE_PROOF_FAILED": "expected StudentNotFound",
            }
            failures.append("nonsense query resolved live")
        except StudentNotFound as exc:
            detail = _not_found(exc)
            detail["live_proof_ok"] = (
                detail["candidates_examined"] == 1
                and detail["pool_size"] == 1)
            record["paths"]["nonsense_query_no_match"] = detail
            if not detail["live_proof_ok"]:
                failures.append("nonsense query saw unexpected pool: %r"
                                % (detail,))
        except StudentAmbiguous as exc:
            record["paths"]["nonsense_query_no_match"] = {
                "resolved": False,
                "error_class": "StudentAmbiguous",
                "LIVE_PROOF_FAILED": "nonsense query was ambiguous live",
            }
            failures.append("nonsense query ambiguous live")
    finally:
        fetch.close()

    record["live_proof_ok"] = not failures
    record["failures"] = failures
    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    out_path = os.path.join(EVIDENCE_DIR, "live_resolution_%s.json" % STAMP)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=1)
    print(json.dumps({"evidence": out_path,
                      "live_proof_ok": record["live_proof_ok"],
                      "paths": {k: {kk: vv for kk, vv in v.items()
                                    if kk != "message"}
                                for k, v in record["paths"].items()}},
                     indent=1))
    if failures:
        raise SystemExit("FATAL: live resolution proof failed: %s"
                         % ("; ".join(failures),))


if __name__ == "__main__":
    main()
