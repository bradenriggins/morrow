#!/usr/bin/env python3
"""Course content reaches the model with course labels, and goes back exact.

Failure modes this suite pins down (written before the code; final sweep
2026-09-23, finding muse/privacy/course-content-names-reach-model):
  1. A page body that names a rostered student ("Great work, Jane Doe
     (jane.doe@school.edu, login jdoe). Doe, Jane will lead Friday.")
     reached the model as written: only [LEARNER-DATA] rows were
     projected. Every form the roster knows must become the student's
     label: the full name, the first and last name alone, the name last
     name first, the email, the login, the SIS id, other roster
     spellings, and a user id after a person word ("/users/98765").
  2. Course content is what an educator edits and saves back. A label
     that stood for "Jane" must go back as "Jane", an email as the
     email, and a word that only looks like a name ("Brown v. Board"
     with a student named Kevin Brown) exactly as written. Projection
     then restoration gives back the original text, character for
     character, including inside links.
  3. Text that already reads like a label ("Student A1" typed by a
     teacher) must go back unchanged, never as a student's name.
  4. Restoration refuses a label the course never issued, and a form
     the roster cannot fill (no email on record), instead of guessing.
  5. Two students who share a first name are both named, never one
     chosen for the other.
  6. Without the encrypted vault there are no labels, so every form is
     hidden one way ("[hidden: student name]"), and text that still
     carries a hidden form is recognized so it is never saved back.
  7. (muse engine audit, 2026-09-23) A name with accents did not match
     the same name without them, in either direction ("José Álvarez" in a
     page, "Jose Alvarez" on the roster), and a typographic apostrophe
     did not match a straight one ("Liam O’Brien"). The model read
     the full name. Every spelling that differs only by accents,
     apostrophes, or a letter such as ł or ß is labeled, and so is a
     German name written with ae, oe, or ue for ä, ö, or ü ("Mueller"
     for "Müller"); a roster spelling goes back exactly as the roster
     spells it.
  8. (muse engine audit, 2026-09-23) A name written as one joined token
     was not labeled: a Canvas page address ("jane-doe-iep-
     accommodations", in url and html_url), and file names such as
     "Jane_Doe_essay.pdf", "JaneDoe.pdf", or "doe_jane.docx". Each part
     alone is lowercase or glued to the other, and "_" counted as part
     of a word. Every joined form of a roster name (first and last
     name, last and first, joined by "-", "_", "." or nothing, in any
     case, with or without accents and apostrophes) is labeled as
     "(joined name N)" and goes back exactly as written, so a link or
     page address still works.
  9. A link to a student's grades, to an assignment submission, or to a
     profile ("/courses/1/grades/98765", "/assignments/5/submissions/
     98765", "/about/98765") kept the student's Canvas id, although the
     consent page says ID numbers inside links are hidden: only a person
     word ("user", "/users/") marked a number as a student's id (final
     sweep 2026-09-23).
"""

import os
import sys
import urllib.parse

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from privacy import course_content as cc  # noqa: E402

JANE = {"id": "98765", "name": "Jane Doe", "email": "jane.doe@school.edu",
        "loginId": "jdoe", "sisUserId": "20231234",
        "aliases": ["Doe, Jane", "Janie"]}
KEVIN = {"id": "55123", "name": "Kevin Brown", "email": "kb@school.edu",
         "loginId": "kbrown"}
ALICE = {"id": "70003", "name": "Alice B. Thornton", "loginId": "athorn"}
JANE_ROE = {"id": "70004", "name": "Jane Roe", "loginId": "jroe"}
LABELS = {"98765": "Student A1", "55123": "Student A2", "70003": "Student A3",
          "70004": "Student A4"}
ROSTER = [JANE, KEVIN, ALICE]


def _prepared(roster=ROSTER):
    return cc.prepare([(i, LABELS[i["id"]]) for i in roster])


def _by_label(roster=ROSTER):
    table = {LABELS[i["id"]]: i for i in roster}
    return table.get


PAGE = ("<p>Great work this week, Jane Doe (jane.doe@school.edu, login "
        "jdoe, SIS 20231234). Doe, Jane will lead Friday; Janie agreed. "
        "Ask Jane or Ms. Doe. Kevin Brown reads Brown v. Board next. "
        "Alice Thornton and Alice B. Thornton are one student. "
        "<a href=\"mailto:jane.doe@school.edu\">email</a> "
        "<a href=\"https://s.example/courses/1/users/98765\">profile</a> "
        "Student A7 is an example name in the rubric.</p>")


# -- 1 ------------------------------------------------------------------------

def test_every_roster_form_becomes_the_label():
    out = cc.project_text(PAGE, _prepared())
    for secret in ("Jane", "Doe", "jane.doe", "jdoe", "20231234", "Janie",
                   "Kevin", "Brown", "Alice", "Thornton", "98765"):
        assert secret not in out, (secret, out)
    assert "Student A1 (email)" in out
    assert "Student A1 (login)" in out
    assert "Student A1 (SIS id)" in out
    assert "Student A1 (name, last name first)" in out
    assert "Student A1 (first name)" in out
    assert "Student A1 (last name)" in out
    assert "Student A2 reads Student A2 (last name) v. Board" in out
    assert "Student A3 (other name" in out
    assert "Great work this week, Student A1 (" in out


def test_a_user_id_after_a_person_word_is_labeled():
    out = cc.project_text("See user 98765 and /users/98765/profile.",
                          _prepared())
    assert "98765" not in out
    assert "user Student A1 (user id)" in out


def test_an_object_id_that_equals_a_student_id_is_left_alone():
    text = "Open /courses/1/assignments/98765 for the rubric (id 98765)."
    assert cc.project_text(text, _prepared()) == text


@pytest.mark.parametrize("link", [
    "https://s.example/courses/1/grades/98765",
    "https://s.example/courses/1/grades/98765#tab-assignments",
    "/courses/1/assignments/5/submissions/98765",
    "https://s.example/api/v1/courses/1/assignments/5/submissions/98765",
    "https://s.example/about/98765",
])
def test_a_link_to_a_students_grades_submission_or_profile_is_labeled(link):
    text = "<a href=\"%s\">open</a> %s" % (link, link)
    out = cc.project_text(text, _prepared())
    assert "98765" not in out, out
    assert cc.restore_text(out, _by_label()) == text


def test_other_ids_in_those_links_are_left_alone():
    # The assignment and the course keep their ids, and a classic quiz
    # submission's id is not a student's id even when the numbers match.
    text = ("/courses/1/assignments/98765/submissions/12 and "
            "/courses/98765/grades/12 and /courses/1/quizzes/5/"
            "submissions/98765")
    assert cc.project_text(text, _prepared()) == text


# -- 2 ------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    PAGE,
    "Jane Austen wrote Emma. Brown v. Board of Education, 1954.",
    "Mark your calendar. Will you come?",
    "jane.doe@school.edu;kb@school.edu",
    "Grades for JANE DOE and jane doe are ready.",
    "<a href=\"https://s.example/search?q=Jane%20Doe&u=98765\">x</a>",
    "Name: Jane&nbsp;Doe",
    "",
    "No students here.",
])
def test_projection_then_restoration_is_exact(text):
    projected = cc.project_text(text, _prepared())
    restored = cc.restore_text(projected, _by_label())
    expected = text.replace("Jane&nbsp;Doe", "Jane Doe") \
        .replace("JANE DOE", "Jane Doe").replace("jane doe", "Jane Doe")
    assert restored == expected, (projected, restored)


def test_a_label_the_model_writes_goes_back_as_the_full_name():
    restored = cc.restore_text(
        "Congratulations, Student A1! Student A2 (first name) helped.",
        _by_label())
    assert restored == "Congratulations, Jane Doe! Kevin helped."


def test_a_possessive_and_punctuation_around_a_label_survive():
    assert cc.restore_text("Student A1's essay (Student A2).",
                           _by_label()) == "Jane Doe's essay (Kevin Brown)."


# -- 3 ------------------------------------------------------------------------

def test_text_that_reads_like_a_label_goes_back_unchanged():
    text = "Student A1 reviews Student A12's draft."
    projected = cc.project_text(text, _prepared())
    assert projected == ("Student A1 (as written) reviews Student A12 (as "
                         "written)'s draft.")
    assert cc.restore_text(projected, _by_label()) == text
    assert cc.labels_in_text(projected) == set()


# -- 4 ------------------------------------------------------------------------

def test_an_unknown_label_is_refused():
    with pytest.raises(cc.RestoreError) as info:
        cc.restore_text("Thanks, Student A9!", _by_label())
    assert "Student A9" in str(info.value)


def test_a_form_the_roster_cannot_fill_is_refused():
    with pytest.raises(cc.RestoreError):
        cc.restore_text("Write to Student A3 (email).", _by_label())


def test_labels_in_text_names_each_student_referenced():
    text = cc.project_text(PAGE, _prepared())
    assert cc.labels_in_text(text) == {"Student A1", "Student A2",
                                       "Student A3"}


# -- 5 ------------------------------------------------------------------------

def test_a_shared_first_name_names_both_students():
    roster = [JANE, JANE_ROE]
    out = cc.project_text("Jane will present.", _prepared(roster))
    assert out == "Student A1 or Student A4 (first name) will present."
    assert cc.restore_text(out, _by_label(roster)) == "Jane will present."
    assert cc.labels_in_text(out) == {"Student A1", "Student A4"}


def test_values_are_walked_and_keys_are_kept():
    value = {"title": "Jane Doe's project", "id": 98765,
             "items": [{"body": "by jdoe"}], "Jane Doe": "key stays"}
    out = cc.project_value(value, _prepared())
    assert out == {"title": "Student A1's project", "id": 98765,
                   "items": [{"body": "by Student A1 (login)"}],
                   "Jane Doe": "key stays"}
    assert cc.restore_value(out, _by_label()) == value


# -- 6 ------------------------------------------------------------------------

def test_without_labels_every_form_is_hidden_one_way():
    out = cc.project_text(PAGE, cc.prepare_hidden(ROSTER))
    for secret in ("Jane", "Doe", "jane.doe", "jdoe", "20231234", "Janie",
                   "Kevin", "Brown", "Alice", "Thornton", "98765"):
        assert secret not in out, (secret, out)
    for form in ("name", "first name", "last name", "email", "login",
                 "SIS id", "user id"):
        assert "[hidden: student %s]" % form in urllib.parse.unquote(out), \
            (form, out)
    assert "/users/%5Bhidden%3A%20student%20user%20id%5D" in out
    assert "Student A7 is an example" in out
    assert cc.has_hidden(out)
    assert not cc.has_hidden("No students here.")
    assert cc.has_hidden({"body": [cc.project_text("Jane Doe",
                                                   cc.prepare_hidden(ROSTER))]})
    assert cc.has_hidden("https://s.example/?q=%5Bhidden%3A%20student%20name%5D")


# -- 7 ------------------------------------------------------------------------

JOSE = {"id": "80001", "name": "Jose Alvarez"}
JOSE_ACCENTED = {"id": "80002", "name": "José Álvarez",
                 "aliases": ["Jose Alvarez"]}
ZOE = {"id": "80003", "name": "Zoë Müller"}
LIAM = {"id": "80004", "name": "Liam O'Brien"}
LIAM_CURLY = {"id": "80005", "name": "Liam O\u2019Brien"}
LUKASZ = {"id": "80006", "name": "Łukasz Strauß"}
GUDRUN = {"id": "80007", "name": "Guðrún Þórsdóttir"}
MARIJA = {"id": "80008", "name": "Marija Ħili"}
MORE_LABELS = {"80001": "Student A5", "80002": "Student A6",
               "80003": "Student A7", "80004": "Student A8",
               "80005": "Student A9", "80006": "Student A10",
               "80007": "Student A11", "80008": "Student A12"}


def _one(identity):
    return cc.prepare([(identity, MORE_LABELS[identity["id"]])])


def _restore_one(identity):
    return {MORE_LABELS[identity["id"]]: identity}.get


@pytest.mark.parametrize("identity, text, secrets", [
    (JOSE, "Great job, José Álvarez! Álvarez leads.",
     ("José", "Álvarez", "Jose", "Alvarez")),
    (JOSE_ACCENTED, "Jose Alvarez and JOSÉ ÁLVAREZ presented.",
     ("José", "JOSÉ", "Jose", "Alvarez", "ÁLVAREZ")),
    (ZOE, "Zoe Muller asked; Muller agreed.", ("Zoe", "Muller")),
    (ZOE, "Zoe Mueller asked; Mueller agreed.", ("Zoe", "Mueller")),
    (LIAM, "Liam O\u2019Brien and O\u2018Brien wrote.", ("Liam", "Brien")),
    (LIAM_CURLY, "Liam O'Brien wrote; O'Brien agreed.", ("Liam", "Brien")),
    (LUKASZ, "Lukasz Strauss and Strauss.", ("Lukasz", "Strauss")),
    (LUKASZ, "Lukasz STRAUẞ wrote.", ("Lukasz", "STRAU")),
    (GUDRUN, "Gudrun Thorsdottir asked; Gudrun replied.",
     ("Gudrun", "Thorsdottir")),
    (MARIJA, "Marija Hili asked; Hili agreed.", ("Marija", "Hili")),
])
def test_accents_and_apostrophes_do_not_hide_a_name(identity, text,
                                                    secrets):
    out = cc.project_text(text, _one(identity))
    for secret in secrets:
        assert secret not in out, (secret, out)
    assert MORE_LABELS[identity["id"]] in out
    restored = cc.restore_text(out, _restore_one(identity))
    assert cc.project_text(restored, _one(identity)) == out


def test_a_roster_spelling_goes_back_exactly():
    text = "Jose Alvarez and José Álvarez are one student."
    out = cc.project_text(text, _one(JOSE_ACCENTED))
    assert cc.restore_text(out, _restore_one(JOSE_ACCENTED)) == text


# -- 8 ------------------------------------------------------------------------

ALICE_JOINED = ("alice-b-thornton-notes", "alice-thornton-plan",
                "Alice_Thornton.docx")


@pytest.mark.parametrize("identity, text, secrets", [
    (JANE, "Jane_Doe_essay.pdf", ("Jane", "Doe")),
    (JANE, "jane-doe-iep-accommodations", ("jane", "doe")),
    (JANE, "JaneDoe.pdf", ("Jane", "Doe")),
    (JANE, "janedoe.pdf", ("jane", "doe")),
    (JANE, "doe_jane.docx", ("doe", "jane")),
    (JANE, "JANE_DOE_FINAL.pdf", ("JANE", "DOE")),
    (JANE, "notes.jane.doe.txt", ("jane", "doe")),
    (JANE, "Doe-Jane report", ("Doe", "Jane")),
    (JANE, "https://school.instructure.com/courses/1/pages/"
           "jane-doe-iep-accommodations", ("jane", "doe")),
    (ALICE, " ".join(ALICE_JOINED), ("alice", "Alice", "thornton",
                                     "Thornton")),
    (JOSE_ACCENTED, "jose-alvarez-notes José_Álvarez.pdf",
     ("jose", "José", "alvarez", "Álvarez")),
    (LIAM, "liam-obrien-reading-log liam-o-brien Liam_O'Brien.pdf",
     ("liam", "Liam", "brien", "Brien")),
])
def test_a_joined_name_is_labeled_and_goes_back_exactly(identity, text,
                                                        secrets):
    labels = dict(LABELS, **MORE_LABELS)
    prepared = cc.prepare([(identity, labels[identity["id"]])])
    out = cc.project_text(text, prepared)
    for secret in secrets:
        assert secret not in out, (secret, out)
    assert "%s (joined name" % labels[identity["id"]] in \
        urllib.parse.unquote(out), out
    restored = cc.restore_text(out, {labels[identity["id"]]: identity}.get)
    assert restored == text, (out, restored)


def test_a_joined_name_in_a_link_keeps_the_link_one_token():
    url = ("https://school.instructure.com/courses/1/pages/"
           "jane-doe-iep-accommodations")
    out = cc.project_text("See %s today." % url, _prepared())
    link = out.split(" ")[1]
    assert link.startswith("https://") and "jane" not in link, out
    assert "%28joined%20name" in link, out


def test_a_joined_name_does_not_match_inside_a_longer_word():
    text = "xjanedoe janedoes jane-doe2"
    assert cc.project_text(text, _prepared()) == text


def test_a_lowercase_first_name_alone_is_still_an_ordinary_word():
    text = "jane's reading log and the doe in the woods"
    assert cc.project_text(text, _prepared()) == text
