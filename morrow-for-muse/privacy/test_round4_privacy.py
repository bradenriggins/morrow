#!/usr/bin/env python3
"""Round-4 privacy audit probes, as tests.

Failure modes this suite pins down (written before the fix; privacy
audit round 4, 2026-09-22, probes audit-privacy/probe_urls.py,
probe_consent.py, probe_gate.py, probe_rev.py, probe_stability.py,
probe_nocrypto.py, and the funnel output capture):

  H1. A raw Canvas user id survived inside a URL next to the label:
      the id rule knew only /users|learners|students/<id>, so
      enrollments[].grades.html_url (/grades/<id>) and a submission's
      preview_url/html_url (/submissions/<id>?preview=1) leaked it. Any
      URL path segment or query value equal to a rostered learner id
      must become the label, whatever the route is called.
  H2. The agent could turn de-identification off by itself: any 0600
      file at <tree-state-dir>/educator_pii_reveal with a 12+ character
      reason revealed every name, unscoped and permanently. Reveal now
      needs an educator-sealed record, scoped to one course, with a
      short expiry; the file is not a consent channel any more.
  L1. Labels followed first-read order, so a roster read in
      alphabetical order leaked each student's alphabetical rank.
      New labels are assigned in keyed-hash order inside the course;
      a learner who already has a label keeps it.
  L2. Page revisions failed closed when a teacher's edited_by record
      carried an html_url, and assignments?include[]=submission failed
      closed: both must project.
  L3. Student-resolution errors echoed the educator's query into the
      agent-visible evidence.
  D1. Catalog people-bearing operations were refused even with the
      vault ready (vault_ready hard-coded False). With the Chromium
      lane and the 'cryptography' package they open; without either,
      they stay refused.

Projection tests need the optional 'cryptography' package and skip
without it; the refusal tests run in both venvs.
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
from privacy import core  # noqa: E402

BASE = "https://school.instructure.com"
JANE = {"id": 98765, "name": "Jane Doe", "sortable_name": "Doe, Jane",
        "short_name": "Janie", "login_id": "jdoe",
        "email": "jane.doe@school.edu", "sis_user_id": "20231234"}
BOB = {"id": 55123, "name": "Robert Smith", "sortable_name": "Smith, Robert",
       "login_id": "rsmith", "email": "rsmith@school.edu",
       "sis_user_id": "S-4411"}
PII = ("Jane", "Doe", "Janie", "jdoe", "jane.doe@", "98765", "20231234",
       "Robert", "Smith", "rsmith", "55123", "S-4411", "Teach Er")
USERS = ("canvas_list_users_in_course_users",
         "/api/v1/courses/{course_id}/users")
SUBS = ("canvas_list_assignment_submissions_courses",
        "/api/v1/courses/{course_id}/assignments/{assignment_id}/submissions")


def _leaks(value):
    text = json.dumps(value)
    return [p for p in PII if p in text]


@pytest.fixture
def vault(monkeypatch):
    pytest.importorskip("cryptography")
    root = os.path.join(HERE, ".selftest-work", "round4-%d" % os.getpid())
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


def _project(name, path, params, payload, method="GET", lane_context=None):
    from dispatch import executor as ex
    entry = ex.catalog_descriptor_to_entry(name, method, path)
    url = ex.render_template(entry["request"]["url"], {"canvas_base": BASE},
                             params)
    view = ex._projection_entry(entry, url, payload)
    out, reveal = wire.project_learner_result(
        view, {"receipt": payload, "truncated": False, "bytes_received": 0},
        BASE, lane_context=lane_context, error_cls=RuntimeError)
    return out["receipt"], reveal


# ---------------------------------------------------------------- H1 --

def test_submission_urls_carry_the_label_not_the_raw_id(vault):
    sub = [{"id": 11, "user_id": 98765, "assignment_id": 3, "score": 40,
            "preview_url": BASE + "/courses/1/assignments/3/submissions/"
                                  "98765?preview=1&version=2",
            "html_url": BASE + "/courses/1/assignments/3/submissions/98765"}]
    out, _ = _project(*SUBS, {"course_id": 1, "assignment_id": 3}, sub)
    assert _leaks(out) == [], out
    assert "Student%20A1" in out[0]["html_url"], out
    assert out[0]["html_url"].startswith(BASE + "/courses/1/assignments/3/")


def test_enrollment_grades_url_carries_the_label(vault):
    roster = [dict(JANE, enrollments=[{
        "id": 1, "user_id": 98765, "type": "StudentEnrollment",
        "grades": {"html_url": BASE + "/courses/1/grades/98765",
                   "current_score": 41.0}}]), dict(BOB)]
    out, _ = _project(*USERS, {"course_id": 1}, roster)
    assert _leaks(out) == [], out
    grades = out[0]["enrollments"][0]["grades"]["html_url"]
    assert grades.startswith(BASE + "/courses/1/grades/Student%20A"), grades


def test_query_value_and_unusual_route_carry_the_label(vault):
    payload = [{"id": 11, "user_id": 98765,
                "url": BASE + "/courses/1/gradebook/speed_grader"
                              "?assignment_id=3&student_id=98765",
                "other": BASE + "/api/v1/courses/1/anything/98765/x"}]
    out, _ = _project(*SUBS, {"course_id": 1, "assignment_id": 3}, payload)
    assert _leaks(out) == [], out
    assert "assignment_id=3" in out[0]["url"]
    assert "/courses/1/" in out[0]["other"]


# ---------------------------------------------------------------- H2 --

def _write_consent_file():
    path = os.path.join(wire._tree_state_dir(), "educator_pii_reveal")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
    os.write(fd, b"agent wrote this reason text")
    os.close(fd)
    os.chmod(path, 0o600)
    return path


def test_an_agent_written_consent_file_reveals_nothing(vault):
    _write_consent_file()
    out, reveal = _project(*USERS, {"course_id": 1}, [dict(JANE)])
    assert reveal is None
    assert _leaks(out) == [], out
    assert not hasattr(wire, "consent_path")


@pytest.fixture
def signing(vault, monkeypatch):
    from dispatch import admission
    monkeypatch.setattr(admission, "SECRETS_DIR",
                        os.path.join(vault, "secrets"))
    monkeypatch.setattr(admission, "SIGNING_KEY_PATH",
                        os.path.join(vault, "secrets", "signing.key"))
    monkeypatch.delenv("MORROW_APPROVAL_SIGNING_KEY", raising=False)
    return admission


REVEAL_WORDS = ("please show me the real names for course 1 while I "
                "review grades with my TA")


def test_sealed_educator_reveal_is_course_scoped(signing):
    rec = signing.mint_pii_reveal(BASE, "1", REVEAL_WORDS,
                                  channel="educator-chat")
    out, reveal = _project(*USERS, {"course_id": 1}, [dict(JANE)],
                           lane_context={"pii_reveal": rec})
    assert reveal and reveal["revealed_by"] == "educator-sealed-record"
    assert reveal["course_id"] == "1"
    assert "Jane Doe" in json.dumps(out)
    # The same record does not reveal a different course.
    out2, reveal2 = _project(*USERS, {"course_id": 2}, [dict(JANE)],
                             lane_context={"pii_reveal": rec})
    assert reveal2 is None and _leaks(out2) == []


def test_reveal_refuses_driver_channel_expired_and_tampered(signing):
    import datetime
    with pytest.raises(ValueError):
        signing.mint_pii_reveal(BASE, "1", "   ", "educator-chat")
    with pytest.raises(ValueError):
        signing.mint_pii_reveal(BASE, "1", REVEAL_WORDS, "educator-chat",
                                minutes=24 * 60)
    driver = signing.mint_pii_reveal(BASE, "1", REVEAL_WORDS, "driver")
    with pytest.raises(RuntimeError):
        _project(*USERS, {"course_id": 1}, [dict(JANE)],
                 lane_context={"pii_reveal": driver})
    rec = signing.mint_pii_reveal(BASE, "1", REVEAL_WORDS, "educator-chat")
    tampered = dict(rec, course_id="2")
    with pytest.raises(RuntimeError):
        _project(*USERS, {"course_id": 2}, [dict(JANE)],
                 lane_context={"pii_reveal": tampered})
    expired = dict(rec)
    past = (datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(minutes=1)).isoformat()
    expired["expires_at"] = past
    expired = signing._seal_record(
        {k: v for k, v in expired.items() if k != "seal"})
    with pytest.raises(RuntimeError):
        _project(*USERS, {"course_id": 1}, [dict(JANE)],
                 lane_context={"pii_reveal": expired})


def test_reveal_mint_is_journaled_without_names(signing, monkeypatch):
    seen = []
    monkeypatch.setattr(signing, "_journal_reveal", seen.append)
    signing.mint_pii_reveal(BASE, "1", REVEAL_WORDS, "educator-chat")
    assert seen and seen[0]["event"] == "privacy.pii_reveal_issued"
    assert seen[0]["course_id"] == "1"


# ---------------------------------------------------------------- L1 --

def test_labels_do_not_follow_alphabetical_order(vault):
    names = ["Aaron Adams", "Bea Brown", "Cal Clark", "Dee Dunn",
             "Eli Evans", "Fay Ford", "Gus Gray", "Hal Hill", "Ivy Ives",
             "Jo James", "Kai King", "Lu Long"]
    roster = [{"id": 1000 + i, "name": n, "login_id": "u%d" % i}
              for i, n in enumerate(names)]
    out, _ = _project(*USERS, {"course_id": 1}, roster)
    numbers = [int(r["id"][len("Student A"):]) for r in out]
    assert sorted(numbers) == list(range(1, 13))
    assert numbers != sorted(numbers), numbers


def test_existing_labels_stay_stable_when_new_learners_arrive(vault):
    first, _ = _project(*USERS, {"course_id": 1},
                        [{"id": 1001, "name": "Jane Doe", "login_id": "j"}])
    assert first[0]["id"] == "Student A1"
    roster = [{"id": 1000 + i, "name": "Person %s" % chr(65 + i),
               "login_id": "p%d" % i} for i in range(8)]
    out, _ = _project(*USERS, {"course_id": 1}, roster)
    by_id = {1000 + i: r["id"] for i, r in enumerate(out)}
    assert by_id[1001] == "Student A1"


# ---------------------------------------------------------------- L2 --

REVS = ("canvas_list_revisions_courses",
        "/api/v1/courses/{course_id}/pages/{url_or_id}/revisions")


def test_revision_teacher_editor_with_html_url_projects(vault):
    payload = [{"revision_id": 3, "latest": True, "edited_by": {
        "id": 5, "anonymous_id": "5", "display_name": "Teach Er",
        "avatar_image_url": "https://x/images/thumbnails/5/q",
        "html_url": BASE + "/courses/1/users/5", "pronouns": None}}]
    out, _ = _project(*REVS, {"course_id": 1, "url_or_id": "p"}, payload)
    assert _leaks(out) == [], out
    assert out[0]["revision_id"] == 3


def test_assignments_with_submission_project(vault):
    payload = [{"id": 3, "name": "Essay",
                "submission": {"id": 11, "user_id": 98765, "score": 3}}]
    out, _ = _project("canvas_list_assignments_assignments",
                      "/api/v1/courses/{course_id}/assignments",
                      {"course_id": 1}, payload)
    assert _leaks(out) == [], out
    assert out[0]["name"] == "Essay"
    assert out[0]["submission"]["score"] == 3


# ---------------------------------------------------------------- L3 --

def test_student_resolution_errors_do_not_echo_the_query():
    from learners.resolve_student import (StudentAmbiguous, StudentNotFound,
                                          build_candidate, match_query)
    from failures.funnel import agent_error_payload
    cands = [build_candidate({"id": i, "name": "Casey Rivera",
                              "enrollments": [{
                                  "type": "StudentEnrollment",
                                  "enrollment_state": "active",
                                  "course_section_id": 10 + i}]})
             for i in (1, 2)]
    for query, cls in (("Casey Rivera", StudentAmbiguous),
                       ("Quentin Nobody", StudentNotFound)):
        with pytest.raises(cls) as info:
            match_query(cands, query)
        payload = agent_error_payload("find a student", info.value)
        text = json.dumps(payload)
        assert query not in text, text
        assert "query" not in info.value.resolution_evidence


def test_fuzzy_match_is_never_auto_picked():
    from learners.resolve_student import (StudentAmbiguous, build_candidate,
                                          match_query)
    cands = [build_candidate({"id": 1, "name": "John Smith", "enrollments": [
        {"type": "StudentEnrollment", "enrollment_state": "active"}]})]
    with pytest.raises(StudentAmbiguous) as info:
        match_query(cands, "Jonh Smith")
    assert info.value.resolution_evidence["match_kind"] == "name_fuzzy"


# ---------------------------------------------------------------- D1 --

class _Browser:
    browser_owned_auth = True


class _Raw:
    browser_owned_auth = False


PEOPLE_OPS = [
    ("canvas_list_users_in_course_users", "GET",
     "/api/v1/courses/{course_id}/users"),
    ("canvas_create_assignment_override", "POST",
     "/api/v1/courses/{course_id}/assignments/{assignment_id}/overrides"),
    ("canvas_list_assignments_for_user", "GET",
     "/api/v1/users/{user_id}/courses/{course_id}/assignments"),
    ("canvas_list_revisions_courses", "GET",
     "/api/v1/courses/{course_id}/pages/{url_or_id}/revisions"),
]


@pytest.mark.parametrize("name,method,path", PEOPLE_OPS)
def test_people_ops_open_on_the_projecting_lane(name, method, path):
    pytest.importorskip("cryptography")
    from dispatch import executor as ex
    entry = ex.catalog_descriptor_to_entry(name, method, path)
    status, _ = ex._catalog_provenance_gate(
        entry, name, method, path, {}, "canvas", approval=None,
        allow_unproven=False, session=_Browser())
    assert status == "live-proven"


@pytest.mark.parametrize("name,method,path", PEOPLE_OPS)
def test_people_ops_stay_refused_without_a_projection_point(
        name, method, path, monkeypatch):
    from dispatch import executor as ex
    from dispatch.admission import LearnerDataGated
    entry = ex.catalog_descriptor_to_entry(name, method, path)
    with pytest.raises(LearnerDataGated):
        ex._catalog_provenance_gate(
            entry, name, method, path, {}, "canvas", approval=None,
            allow_unproven=False, session=_Raw())
    monkeypatch.setattr(core, "AESGCM", None)
    with pytest.raises(LearnerDataGated) as info:
        ex._catalog_provenance_gate(
            entry, name, method, path, {}, "canvas", approval=None,
            allow_unproven=False, session=_Browser())
    assert "has not landed" not in str(info.value)
    assert "cryptography" in str(info.value)


def test_pending_people_ops_stay_refused_on_the_projecting_lane():
    pytest.importorskip("cryptography")
    from dispatch import executor as ex
    from dispatch.admission import LearnerDataGated
    name, method, path = (
        "canvas_get_course_level_student_summary_data", "GET",
        "/api/v1/courses/{course_id}/analytics/student_summaries")
    entry = ex.catalog_descriptor_to_entry(name, method, path)
    from dispatch.admission import WriteApprovalMissing
    with pytest.raises((LearnerDataGated, ex.CatalogNotProven,
                        WriteApprovalMissing)):
        ex._catalog_provenance_gate(
            entry, name, method, path, {}, "canvas", approval=None,
            allow_unproven=True, session=_Browser())
