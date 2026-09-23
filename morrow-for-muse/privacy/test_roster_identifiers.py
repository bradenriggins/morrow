#!/usr/bin/env python3
"""Roster reads project every student identifier; none refuse or leak.

Failure modes this suite pins down (written before the fix; re-audit
2026-09-22, probes reaudit/priv_probe2.py + priv_probe3.py):
  1. A non-null sis_user_id on a live-proven roster read (C-120
     /courses/{id}/users) made the privacy boundary refuse the whole
     read: the SIS id was taken as the learner's primary id, which the
     roster (keyed by Canvas id) did not know.
  2. A minimal user record ({"id", "name"}) on a user-collection route
     passed through raw: the roster harvest did not recognize it as a
     person, so neither the name nor the Canvas id was labeled.
  3. Free-text learner names in bulk_user_tags tags and in course group
     names reached the assistant raw. Names the learner vault already
     knows for the course must be labeled wherever they appear.

Needs the optional 'cryptography' package (the encrypted learner
vault); skipped without it. Scratch lives under .selftest-work/ (never
/tmp).
"""

import json
import os
import shutil
import sys

import pytest

pytest.importorskip("cryptography")

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from dispatch import executor as ex  # noqa: E402
from privacy import executor_wire as wire  # noqa: E402

BASE = "https://school.instructure.com"
USERS = ("canvas_list_users_in_course_users",
         "/api/v1/courses/{course_id}/users")
TAGS = ("canvas_bulk_fetch_user_tags_for_multiple_users_in_course",
        "/api/v1/courses/{course_id}/bulk_user_tags")
GROUPS = ("canvas_list_groups_available_in_context_courses",
          "/api/v1/courses/{course_id}/groups")
PII = ("Jane", "Doe", "Janie", "jdoe", "jane.doe@", "98765", "20231234",
       "jdoe-sis", "INT-77")


@pytest.fixture(autouse=True)
def vault(monkeypatch):
    root = os.path.join(HERE, ".selftest-work", "roster-ids-%d" % os.getpid())
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


def _project(op, payload):
    name, path = op
    entry = ex.catalog_descriptor_to_entry(name, "GET", path)
    url = ex.render_template(entry["request"]["url"], {"canvas_base": BASE},
                             {"course_id": 1})
    view = ex._projection_entry(entry, url, payload)
    assert ex.admission_touches_learner_data(view), name
    out = wire.project_learner_result(
        view, {"receipt": payload, "truncated": False, "bytes_received": 0},
        BASE, error_cls=RuntimeError)
    return json.dumps(out["receipt"])


def _leaks(text):
    return [t for t in PII if t in text]


JANE = {"id": 98765, "name": "Jane Doe", "sortable_name": "Doe, Jane",
        "short_name": "Janie"}


@pytest.mark.parametrize("extra", [
    {"sis_user_id": "20231234"}, {"sis_user_id": "jdoe-sis"},
    {"sis_user_id": None},
    {"sis_user_id": "20231234", "login_id": "jdoe",
     "email": "jane.doe@school.edu", "integration_id": "INT-77"},
])
def test_roster_read_with_sis_id_projects_instead_of_refusing(extra):
    user = dict(JANE, **extra)
    text = _project(USERS, [user])
    assert _leaks(text) == [], text
    assert "Student A1" in text


def test_minimal_user_record_on_a_user_route_is_labeled():
    text = _project(USERS, [{"id": 98765, "name": "Jane Doe"}])
    assert _leaks(text) == [], text
    assert "Student A1" in text


def test_vault_known_name_in_tags_is_labeled():
    _project(USERS, [dict(JANE)])
    text = _project(TAGS, {"users": [{"user_id": 98765,
                                      "tags": ["Jane Doe accommodations"]}]})
    assert _leaks(text) == [], text
    assert "accommodations" in text


def test_vault_known_name_in_group_name_is_labeled():
    _project(USERS, [dict(JANE)])
    text = _project(GROUPS, [{"id": 3, "name": "Jane Doe project group",
                              "members_count": 1}])
    assert _leaks(text) == [], text
    assert "project group" in text
