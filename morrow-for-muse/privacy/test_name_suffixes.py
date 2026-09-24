#!/usr/bin/env python3
"""A name suffix (Jr., Sr., II, III, IV) is never taken for a surname.

Failure modes this suite pins down (written before the fix; known-open
item known-4, final sweep 2026-09-23):
  1. privacy/course_content._name_parts took the last word of the roster
     name as the surname. For "Martin Luther King Jr." the "last name"
     was "Jr.", so a page that said "King" alone reached the model with
     the student's real surname, while every capitalized "Jr." in the
     course (a "Jr. varsity" note) was labeled as the student.
  2. The same held for "Henry Ford III" (surname "III", and "Ford" left
     as written) and for a roster name with the suffix after a comma
     ("Martin Luther King, Jr.", "King, Jr., Martin").
  3. privacy/core, the learner-data projection, had the same rule in
     _surname_of_name, and read the given name of "King, Jr., Martin" as
     "Jr.", so "Martin" alone was never hidden there either.
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from privacy import core  # noqa: E402
from privacy import course_content as cc  # noqa: E402

NAMES = [
    ("Martin Luther King Jr.", "Martin", "King"),
    ("Martin Luther King Jr", "Martin", "King"),
    ("Martin Luther King, Jr.", "Martin", "King"),
    ("King, Martin Luther, Jr.", "Martin", "King"),
    ("King Jr., Martin", "Martin", "King"),
    ("King, Jr., Martin", "Martin", "King"),
    ("Henry Ford III", "Henry", "Ford"),
    ("Henry Ford II", "Henry", "Ford"),
    ("Louis Dupont IV", "Louis", "Dupont"),
    ("Robert Smith Sr.", "Robert", "Smith"),
    # Not suffixes: an ordinary surname, and a surname that only starts
    # like a suffix.
    ("Anna Vi", "Anna", "Vi"),
    ("Jane Junior", "Jane", "Junior"),
    ("Jane Doe", "Jane", "Doe"),
]


@pytest.mark.parametrize("name,given,surname", NAMES)
def test_course_content_name_parts_skip_the_suffix(name, given, surname):
    assert cc._name_parts(name) == (given, surname)


@pytest.mark.parametrize("name,given,surname", NAMES)
def test_learner_data_aliases_skip_the_suffix(name, given, surname):
    normalized = core._normalize_alias(name)
    assert core._surname_of_name(normalized) == surname.lower()
    aliases = core._learner_name_aliases({"id": "1", "name": name})
    assert given.lower() in aliases
    assert surname.lower() in aliases
    for suffix in ("jr", "jr.", "jr.,", "sr.", "ii", "iii", "iv"):
        assert suffix not in aliases
    # The name without its suffix names the student too.
    assert " ".join(core._without_name_suffixes(
        core._normalize_alias(name)).split()) in aliases


KING = {"id": "81001", "name": "Martin Luther King Jr.", "loginId": "mlk"}
FORD = {"id": "81002", "name": "Henry Ford III", "loginId": "hford"}
LABELS = {"81001": "Student A1", "81002": "Student A2"}
PAGE = ("<p>King led the debate, and Ford took notes. Martin Luther King "
        "spoke first. Jr. varsity tryouts are Friday; see Unit III.</p>")


def _prepared():
    return cc.prepare([(i, LABELS[i["id"]]) for i in (KING, FORD)])


def test_a_surname_alone_is_labeled_and_the_suffix_is_left_alone():
    out = cc.project_text(PAGE, _prepared())
    for secret in ("King", "Ford", "Martin", "Luther"):
        assert secret not in out, (secret, out)
    assert "Student A1 (last name) led the debate" in out
    assert "Student A2 (last name) took notes" in out
    assert "Jr. varsity tryouts" in out
    assert "Unit III" in out


def test_projection_then_restoration_is_exact():
    table = {LABELS[i["id"]]: i for i in (KING, FORD)}
    projected = cc.project_text(PAGE, _prepared())
    assert cc.restore_text(projected, table.get) == PAGE


def test_without_labels_the_surname_is_hidden_and_the_suffix_is_not():
    out = cc.project_text(PAGE, cc.prepare_hidden([KING, FORD]))
    for secret in ("King", "Ford", "Martin", "Luther"):
        assert secret not in out, (secret, out)
    assert "Jr. varsity tryouts" in out
