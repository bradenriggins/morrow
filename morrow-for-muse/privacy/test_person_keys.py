#!/usr/bin/env python3
"""Person keys are labeled structurally, wherever they sit.

Failure modes this suite pins down (written before the fix; third-pass
re-audit 2026-09-22, probes reaudit3/priv5.py and priv6.py):
  1. date_details reads (C-231, C-234, C-235, C-236) were not learner
     data, so override student names and ids reached the agent raw.
  2. The roster harvester knew only user/student/author keys: plural
     "students", and id arrays such as "student_ids", "user_ids",
     "participating_user_ids" were never labeled.
  3. An ad hoc override title that names a student stayed raw when the
     record carried only student ids.
  4. Collaborations: user_name was tokenized, but the same learner's
     name inside that record's title and description stayed raw.
  5. A bare id seen before the full record kept the synthesized name,
     so the real name was never learned for free-text redaction.

The harvester tests are stdlib only; the projection tests need the
optional 'cryptography' package and skip without it.
"""

import json
import os
import shutil
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from privacy import executor_wire as wire  # noqa: E402

BASE = "https://school.instructure.com"
PII = ("Zed", "Quill", "55501", "55502", "Ann Lee")


def _ids(entries):
    return sorted(str(e["id"]) for e in entries)


@pytest.mark.parametrize("key", [
    "user", "users", "student", "students", "author", "authors",
    "participant", "participants", "member", "members", "learner",
    "learners", "observer", "observees", "recipients", "submitter",
    "collaborators", "assessor", "people", "person", "context_user",
    "latest_users"])
def test_person_record_keys(key):
    assert wire.person_key_kind(key) == "record", key


@pytest.mark.parametrize("key", [
    "user_id", "user_ids", "student_id", "student_ids", "author_id",
    "participant_ids", "member_ids", "participating_user_ids",
    "context_user_id", "userId", "studentIds", "recipient_ids",
    "observer_id", "assessor_id", "submitter_id"])
def test_person_id_keys(key):
    assert wire.person_key_kind(key) == "ids", key


@pytest.mark.parametrize("key", [
    "id", "name", "title", "course_id", "assignment_id", "group_id",
    "user_name", "members_count", "users_count", "due_at", "section_id",
    "only_visible_to_overrides", "allow_student_discussion_topics",
    "student_count"])
def test_non_person_keys(key):
    assert wire.person_key_kind(key) is None, key


def test_harvest_plural_collections_and_id_arrays():
    receipt = {"id": 4, "overrides": [
        {"id": 8, "title": "1 student", "student_ids": [55501, "55502"],
         "students": [{"id": 55501, "name": "Zed Quill"}]},
        {"id": 9, "user_ids": [55503], "participants": [
            {"id": 55504, "name": "Ann Lee"}],
         "members": [{"id": 55505}]},
        {"id": 10, "participating_user_ids": [55506], "author_id": 55507}]}
    roster = wire._harvest_roster(receipt)
    assert _ids(roster) == ["55501", "55502", "55503", "55504", "55505",
                            "55506", "55507"]
    names = {str(e["id"]): e["name"] for e in roster}
    assert names["55501"] == "Zed Quill"
    assert names["55504"] == "Ann Lee"


def test_harvest_upgrades_a_bare_id_to_the_real_name():
    receipt = {"student_ids": [55501],
               "students": [{"id": 55501, "name": "Zed Quill"}]}
    roster = wire._harvest_roster(receipt)
    assert len(roster) == 1
    assert roster[0]["name"] == "Zed Quill"


def test_harvest_takes_the_person_name_of_a_user_id_record():
    receipt = [{"id": 2, "user_id": 55501, "user_name": "Zed Quill",
                "title": "Notes for Zed Quill"}]
    roster = wire._harvest_roster(receipt)
    assert [(str(e["id"]), e["name"]) for e in roster] == \
        [("55501", "Zed Quill")]


def test_date_details_rows_are_learner_data():
    from dispatch import admission
    from dispatch import executor as ex
    for name, path in (
            ("canvas_get_learning_object_s_date_information_assignments",
             "/api/v1/courses/{course_id}/assignments/{assignment_id}/"
             "date_details"),
            ("canvas_get_learning_object_s_date_information_pages",
             "/api/v1/courses/{course_id}/pages/{url_or_id}/date_details"),
            ("canvas_get_learning_object_s_date_information_modules",
             "/api/v1/courses/{course_id}/modules/{context_module_id}/"
             "date_details"),
            ("canvas_get_learning_object_s_date_information_quizzes",
             "/api/v1/courses/{course_id}/quizzes/{quiz_id}/date_details")):
        entry = ex.catalog_descriptor_to_entry(name, "GET", path)
        assert admission.touches_learner_data(entry), name


# --- projection (needs the optional vault dependency) ---------------------

@pytest.fixture
def vault(monkeypatch):
    pytest.importorskip("cryptography")
    root = os.path.join(HERE, ".selftest-work", "person-keys-%d" % os.getpid())
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root)
    monkeypatch.setenv("MORROW_HOME", root)
    monkeypatch.setenv("MORROW_TREE_STATE_DIR", os.path.join(root, "tree"))
    monkeypatch.setenv(wire.SOURCE_VAULT_ENV_VAR,
                       os.path.join(root, "vault.json"))
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _project(name, path, payload, params):
    from dispatch import executor as ex
    entry = ex.catalog_descriptor_to_entry(name, "GET", path)
    url = ex.render_template(entry["request"]["url"], {"canvas_base": BASE},
                             params)
    view = ex._projection_entry(entry, url, payload)
    assert ex.admission_touches_learner_data(view), name
    out = wire.project_learner_result(
        view, {"receipt": payload, "truncated": False, "bytes_received": 0},
        BASE, error_cls=RuntimeError)
    return json.dumps(out["receipt"])


def _leaks(text):
    return [t for t in PII if t in text]


DATE_DETAILS = ("canvas_get_learning_object_s_date_information_assignments",
                "/api/v1/courses/{course_id}/assignments/{assignment_id}/"
                "date_details")


def test_date_details_names_and_ids_never_reach_agent(vault):
    text = _project(*DATE_DETAILS, {
        "id": 4, "due_at": None, "overrides": [
            {"id": 8, "title": "1 student", "student_ids": [55501],
             "students": [{"id": 55501, "name": "Zed Quill"}]}]},
        {"course_id": 1, "assignment_id": 4})
    assert _leaks(text) == [], text
    assert "Student A1" in text


def test_date_details_ids_only_never_reach_agent(vault):
    text = _project(
        "canvas_get_learning_object_s_date_information_pages",
        "/api/v1/courses/{course_id}/pages/{url_or_id}/date_details",
        {"id": 4, "overrides": [{"id": 8, "title": "1 student",
                                 "student_ids": [55501, 55502]}]},
        {"course_id": 1, "url_or_id": "p"})
    assert _leaks(text) == [], text


def test_module_overrides_students_are_labeled(vault):
    text = _project(
        "canvas_list_module_s_overrides",
        "/api/v1/courses/{course_id}/modules/{context_module_id}/"
        "assignment_overrides",
        [{"id": 8, "title": "1 student",
          "students": [{"id": 55501, "name": "Zed Quill"}]}],
        {"course_id": 1, "context_module_id": 2})
    assert _leaks(text) == [], text


def test_adhoc_override_title_with_unseen_name_is_neutralized(vault):
    text = _project(
        "canvas_retrieve_assignment_overridden_dates_for_new_quizzes",
        "/api/v1/courses/{course_id}/new_quizzes/assignment_overrides",
        {"quiz_assignment_overrides": [{"quiz_id": 3, "due_dates": [
            {"id": 8, "title": "Zed Quill", "student_ids": [55501]}]}]},
        {"course_id": 1})
    assert _leaks(text) == [], text
    assert "1 student" in text


def test_collaboration_free_text_names_the_same_record_learner(vault):
    text = _project(
        "canvas_list_collaborations_courses",
        "/api/v1/courses/{course_id}/collaborations",
        [{"id": 2, "user_id": 55501, "user_name": "Zed Quill",
          "title": "Notes for Zed Quill", "description": "Zed Quill group"}],
        {"course_id": 1})
    assert _leaks(text) == [], text
    assert "Notes for" in text and "group" in text


# --- residual gaps closed (integrator follow-up, 2026-09-22) -------------
#   6. smartsearch results named learners in free text ("Zed Quill's
#      essay feedback") and were not learner data at all.
#   7. outcome_alignments takes a student_id and was not learner data.
#   8. A page read's last_edited_by carried a person's id and name raw.

def test_smartsearch_and_outcome_alignments_are_learner_data():
    from dispatch import admission
    from dispatch import executor as ex
    for name, path in (
            ("canvas_search_course_content",
             "/api/v1/courses/{course_id}/smartsearch"),
            ("canvas_get_outcome_alignments_for_student_or_assignment",
             "/api/v1/courses/{course_id}/outcome_alignments")):
        entry = ex.catalog_descriptor_to_entry(name, "GET", path)
        assert admission.touches_learner_data(entry), name


USERS = ("canvas_list_users_in_course_users",
         "/api/v1/courses/{course_id}/users")
PAGE = ("canvas_show_page_courses",
        "/api/v1/courses/{course_id}/pages/{url_or_id}")
EDITOR = {"id": 55501, "display_name": "Zed Quill",
          "avatar_image_url": "https://x/images/thumbnails/55501/a",
          "html_url": "https://school.instructure.com/courses/1/users/55501"}


def test_smartsearch_labels_vault_known_learners(vault):
    _project(*USERS, [{"id": 55501, "name": "Zed Quill"}], {"course_id": 1})
    text = _project("canvas_search_course_content",
                    "/api/v1/courses/{course_id}/smartsearch",
                    {"results": [{"content_id": 1,
                                  "title": "Zed Quill's essay feedback",
                                  "body": "Notes for Zed Quill"}]},
                    {"course_id": 1})
    assert _leaks(text) == [], text
    assert "essay feedback" in text


def _page(payload):
    from dispatch import executor as ex
    name, path = PAGE
    entry = ex.catalog_descriptor_to_entry(name, "GET", path)
    url = ex.render_template(entry["request"]["url"], {"canvas_base": BASE},
                             {"course_id": 1, "url_or_id": "p"})
    view = ex._projection_entry(entry, url, payload)
    out = wire.project_learner_result(
        view, {"receipt": payload, "truncated": False, "bytes_received": 0},
        BASE, error_cls=RuntimeError)
    return out["receipt"]


def test_page_editor_is_labeled_and_body_untouched_without_the_vault(
        monkeypatch, tmp_path):
    monkeypatch.setenv(wire.SOURCE_VAULT_ENV_VAR, str(tmp_path / "v.json"))
    body = "<p>Welcome, class</p>"
    out = _page({"url": "p", "title": "Home", "body": body,
                 "last_edited_by": dict(EDITOR)})
    assert out["body"] == body and out["title"] == "Home"
    assert _leaks(json.dumps(out)) == [], out


def test_page_editor_known_to_the_vault_gets_their_label(vault):
    _project(*USERS, [{"id": 55501, "name": "Zed Quill"}], {"course_id": 1})
    body = "<p>Welcome, class</p>"
    out = _page({"url": "p", "title": "Home", "body": body,
                 "last_edited_by": dict(EDITOR)})
    assert out["body"] == body
    assert _leaks(json.dumps(out)) == [], out
    assert "Student A1" in json.dumps(out)
