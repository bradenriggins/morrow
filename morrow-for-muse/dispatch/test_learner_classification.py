#!/usr/bin/env python3
"""Learner-data classification over the real operation catalog.

Every catalog row whose response carries people (user objects, student
ids, per-student dates, activity, collaborators) must be classified as
learner data, so the executor projects it through the de-identification
boundary (or refuses it where no projection point exists). The rows are
built with the real dispatch.executor.catalog_descriptor_to_entry from
proof-battery/OPERATION_CATALOG.md, the same path a dispatch takes.

Course-content rows stay unclassified: projecting a page or quiz body
would rewrite names in content an educator may save back.

Stdlib only. Scratch lives under .selftest-work/ (never /tmp).
"""

import os
import shutil
import sys

import pytest

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE not in sys.path:
    sys.path.insert(0, _TREE)

from dispatch import admission  # noqa: E402
from dispatch import executor as ex  # noqa: E402

# Reviewed 2026-09-22 against the Canvas REST reference: each of these
# responses carries user objects, student ids, or per-student data.
PEOPLE_BEARING = {
    "C-78": "potential_collaborators: User objects (name, sortable_name)",
    "C-105": "activity_stream: items name the students who posted, "
             "submitted, or messaged",
    "C-106": "activity_stream/summary: same resource as C-105",
    "C-112": "effective_due_dates: keyed by student id",
    "C-274": "module assignment_overrides: students [{id, name}]",
    "C-284": "module assignment_overrides write: students [{id, name}]",
    "C-343": "quiz assignment_overrides: ad hoc override titles carry "
             "student names",
    "C-344": "new quiz assignment_overrides: same shape as C-343",
    "C-34": "assignment overrides: student_ids",
    "C-35": "assignment overrides: student_ids",
    "C-36": "assignment overrides: student_ids",
    "C-39": "assignment overrides: student_ids",
    "C-41": "assignment overrides: student_ids",
    "C-45": "assignment overrides: student_ids",
    "C-46": "assignment overrides: student_ids",
    "C-51": "assignment overrides: student_ids",
    "C-327": "page revisions: edited_by user object for each revision",
    "C-331": "page revision: edited_by user object",
    "C-332": "page revision: edited_by user object",
    "C-231": "assignment date_details: overrides carry student_ids and "
             "students [{id, name}]",
    "C-234": "module date_details: overrides carry student_ids and "
             "students [{id, name}]",
    "C-235": "page date_details: overrides carry student_ids and "
             "students [{id, name}]",
    "C-236": "quiz date_details: overrides carry student_ids and "
             "students [{id, name}]",
    "C-403": "smartsearch: result titles and bodies can name learners",
    "C-322": "outcome alignments for a student (student_id)",
    "C-227": "course groups: group names are free text that often name "
             "the students in them, and include[]=users returns user "
             "objects",
}

# Course content an educator reads and may write back; must stay raw.
CONTENT_ONLY = ["C-330", "C-326", "C-378", "C-377", "C-48", "C-44",
                "C-275", "C-273", "C-114", "C-111", "C-400",
                "C-436", "IB-10", "IB-13"]


def _rows_by_id():
    rows = {}
    for name, desc in ex._load_operation_catalog().items():
        rows[desc["id"]] = (name, desc)
    return rows


def _entry(row_id):
    name, desc = _rows_by_id()[row_id]
    provider = "quiz_api" if row_id.startswith("IB-") else "canvas"
    return ex.catalog_descriptor_to_entry(name, desc["method"],
                                          desc["path"], provider=provider)


@pytest.mark.parametrize("row_id", sorted(PEOPLE_BEARING))
def test_people_bearing_rows_are_learner_data(row_id):
    entry = _entry(row_id)
    assert admission.touches_learner_data(entry), (
        "%s (%s) returns people but is not classified as learner data: "
        "its receipt would reach the agent unprojected"
        % (row_id, PEOPLE_BEARING[row_id]))
    with pytest.raises(admission.LearnerDataGated):
        admission.check_learner_data(entry, admission.load_policy(),
                                     vault_ready=False)


@pytest.mark.parametrize("row_id", CONTENT_ONLY)
def test_content_rows_stay_unprojected(row_id):
    assert not admission.touches_learner_data(_entry(row_id)), row_id


def test_classification_is_structural_not_substring_luck():
    # A learner resource segment is caught wherever it sits, and a
    # lookalike segment is not.
    def entry(path):
        return {"name": "probe", "request": {
            "method": "GET", "url": "{canvas_base}" + path}}
    for path in ("/api/v1/courses/{course_id}/potential_collaborators",
                 "/api/v1/groups/{group_id}/memberships",
                 "/api/v1/courses/{course_id}/discussion_topics/{id}/view",
                 "/api/v1/courses/{course_id}/discussion_topics/{id}/"
                 "entries/{entry_id}/replies",
                 "/api/v1/conversations",
                 "/api/v1/courses/{course_id}/assignments/{id}/"
                 "quiz_submissions",
                 "/api/v1/users/{user_id}/page_views",
                 "/api/v1/courses/{course_id}/activity_stream"):
        assert admission.touches_learner_data(entry(path)), path
    for path in ("/api/v1/courses/{course_id}/pages/{url_or_id}",
                 "/api/banks/{bank_id}/bank_entries",
                 "/api/v1/users/self"):
        assert not admission.touches_learner_data(entry(path)), path


def test_every_live_proven_people_row_is_reviewed():
    # Audit gate: a live-proven row whose path names a people resource
    # must be classified. New rows fail here until reviewed.
    people_words = ("user", "student", "enrollment", "submission",
                    "collaborator", "activity_stream", "override",
                    "membership", "conversation", "participant",
                    "observee", "grade", "analytics", "page_view",
                    "effective_due_dates", "revision", "entries",
                    "replies")
    missed = []
    for row_id, (name, desc) in _rows_by_id().items():
        if desc["status"] != "live-proven":
            continue
        path = desc["path"].lower()
        if "/users/self" in path:
            continue
        if "bank_entries" in path or "quiz_entries" in path:
            continue
        if any(w in path for w in people_words):
            if not admission.touches_learner_data(_entry(row_id)):
                missed.append("%s %s" % (row_id, desc["path"]))
    assert not missed, "unclassified people-bearing rows: %s" % missed


@pytest.fixture
def scratch_vault(monkeypatch):
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        ".selftest-work", "classification-%d" % os.getpid())
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root)
    monkeypatch.setenv("MORROW_HOME", os.path.join(root, "home"))
    monkeypatch.setenv("MORROW_TREE_STATE_DIR", os.path.join(root, "tree"))
    monkeypatch.setenv("MORROW_SOURCE_VAULT_PATH",
                       os.path.join(root, "vault.json"))
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_potential_collaborators_receipt_never_reaches_agent_raw(
        scratch_vault):
    from privacy import executor_wire
    entry = _entry("C-78")
    entry["request"]["url"] = entry["request"]["url"].replace(
        "{course_id}", "89585")
    result = {"receipt": [
        {"id": 5550101, "name": "Jane Doe", "sortable_name": "Doe, Jane",
         "short_name": "Jane Doe"},
        {"id": 5550102, "name": "Omar Haddad",
         "sortable_name": "Haddad, Omar", "short_name": "Omar"},
    ], "truncated": False, "bytes_received": 10}
    try:
        import cryptography  # noqa: F401
        have_crypto = True
    except ImportError:
        have_crypto = False
    if not have_crypto:
        # Without the optional vault dependency the projection refuses
        # loudly; it must never hand back the raw receipt.
        with pytest.raises(Exception):
            executor_wire.project_learner_result(
                entry, result, "https://school.instructure.com")
        return
    out = executor_wire.project_learner_result(
        entry, result, "https://school.instructure.com")
    text = repr(out)
    for raw in ("Jane Doe", "Doe, Jane", "Omar Haddad", "5550101"):
        assert raw not in text, raw


@pytest.mark.parametrize("block", ["discovery", "verify", "before_state",
                                   "undo"])
def test_auxiliary_blocks_are_scanned(block):
    # A roster read hidden in a discovery pre-pass, a verify readback, a
    # freshness reader, or an undo must trip the gate like the request.
    entry = {"name": "probe", "request": {
        "method": "GET",
        "url": "{canvas_base}/api/v1/courses/{course_id}/modules"}}
    assert not admission.touches_learner_data(entry)
    entry[block] = {"method": "GET", "url": "{canvas_base}/api/v1/courses/"
                    "{course_id}/users"}
    assert admission.touches_learner_data(entry), block
    listed = dict(entry)
    listed[block] = [{"method": "GET", "url": "{canvas_base}/api/v1/"
                      "courses/{course_id}/enrollments"}]
    assert admission.touches_learner_data(listed), block


# Documented response keys that name a person but are NOT learner data,
# reviewed 2026-09-22. Anything else a live-proven row documents that
# names a person, a people collection, a person id, or an override set
# must be classified.
PERSON_KEY_EXCEPTIONS = {
    ("C-82", "user_id"): "content export: the educator who started it",
    ("C-85", "user_id"): "content migration: the educator who started it",
    ("C-329", "last_edited_by"): "front page is course content an educator "
                                 "may save back (see CONTENT_ONLY); its "
                                 "last editor is replaced field by field "
                                 "(privacy/executor_wire.py "
                                 "_label_editor_records)",
    ("C-329", "hide_from_students"): "boolean page setting",
    ("C-111", "filter_speed_grader_by_student_group"): "boolean setting",
}


def test_every_live_proven_row_with_person_keys_is_learner_data():
    import re
    from privacy import executor_wire
    catalog = os.path.join(_TREE, "proof-battery", "OPERATION_CATALOG.md")
    missed = []
    scanned = 0
    for line in open(catalog, encoding="utf-8"):
        if not line.startswith("| ") or "live-proven" not in line:
            continue
        match = re.search(r"keys: ([^|]*)", line)
        if not match:
            continue
        row_id = line.split("|")[1].strip()
        keys = [k.strip(" .") for k in match.group(1).split(",")]
        people = [k for k in keys
                  if executor_wire.person_key_kind(k) is not None
                  or re.search(r"(?:^|_)overrides$", k)]
        people = [k for k in people
                  if (row_id, k) not in PERSON_KEY_EXCEPTIONS]
        if not people:
            continue
        scanned += 1
        if not admission.touches_learner_data(_entry(row_id)):
            missed.append((row_id, people))
    assert scanned >= 4
    assert not missed, "unclassified rows with person keys: %s" % missed
