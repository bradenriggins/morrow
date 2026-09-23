#!/usr/bin/env python3
"""The pages an educator reads use plain words and promise only what works.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-22):
  1. content/consent.md, labeled a plain summary for a non-technical
     educator, used developer terms: the dispatch catalog, live-proven,
     the Chromium lane, catalog rows, standing exclusions, the
     subaccount level, a repository file path, `<tree>/helper/profile/`,
     the journal, and a sealed fingerprint. setup-guide.md said "This is
     the setup-complete gate" and named a file path.
  2. consent.md listed enrollments among the tested tasks (the roster
     read is not live-proven), and consent.md and setup-guide.md
     promised a receipt with "a link to it" and "whether it can be
     undone": results carry no link, and this release cannot undo a
     change automatically.
  3. content/revoke.md told the educator to "Ask Muse to sign you out of
     Canvas on the helper page". No command or SKILL.md step lets the
     assistant sign out. The educator signs out with Canvas's own menu
     on the helper page, and SKILL.md tells the agent to guide that.
  4. consent.md says it is "the whole deal" with no fine print, and
     SKILL.md says installing means consenting to the Muse computer's
     network reading its traffic, but neither consent.md nor
     setup-guide.md told the educator that this network can read the
     Canvas session and the course pages loaded (INSTALL.md and the
     website say so).
  5. consent.md listed three names Morrow does not hide, then said the
     assistant never sees the names of students the educator did not
     name. privacy/FERPA_POLICY.md records more: a first or last name
     used alone and written in small letters, a name of someone who was
     never a student in the course, an ID number written as plain text,
     and other details written beside a name, such as a birth date. The
     0.4.1 release notes repeated the short list (final sweep
     2026-09-23). Every limitation the policy records is either named on
     the consent page or lets no student detail reach the assistant.
"""

import os
import re

import pytest

import test_doc_catalog_counts as counts_doc

TREE = os.path.dirname(os.path.abspath(__file__))
PAGES = ("content/consent.md", "content/setup-guide.md", "content/revoke.md")
JARGON = ("dispatch", "catalog", "live-proven", "Chromium", "lane",
          "standing exclusion", "subaccount", "proof-battery",
          "OPERATION_CATALOG", "<tree>", "helper/profile", "journal",
          "journaled", "sealed", "fingerprint", "gate", "API token",
          "digest", "keyed", "uninstall.sh", "install.sh")
# The only code an educator page shows: the command Muse runs to
# disconnect, and an example Canvas address.
ALLOWED_CODE = ("bin/morrow disconnect --yes", "canvas.school.example.edu")


def _flat(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return " ".join(fh.read().split())


@pytest.mark.parametrize("rel", PAGES)
def test_educator_pages_use_plain_words(rel):
    text = _flat(rel)
    for word in JARGON:
        assert not re.search(r"(?<![\w-])%s(?![\w-])" % re.escape(word),
                             text, re.IGNORECASE), (rel, word)
    code = re.findall(r"`([^`]*)`", text)
    assert all(c in ALLOWED_CODE for c in code), (rel, code)
    assert "\u2014" not in text, rel


def test_consent_states_a_fair_count_and_only_tested_examples():
    text = _flat("content/consent.md")
    match = re.search(r"more than (\d+) Canvas tasks", text)
    assert match, "consent.md no longer says how many tasks are tested"
    stated, live = int(match.group(1)), counts_doc._counts()["live"]
    assert stated < live < stated + 100, (stated, live)
    assert "enrollment" not in text


@pytest.mark.parametrize("rel", ("content/consent.md",
                                 "content/setup-guide.md"))
def test_no_page_promises_a_link_or_an_undo(rel):
    text = _flat(rel)
    assert "a link to it" not in text
    assert "whether it can be undone" not in text


def test_consent_says_what_happens_after_a_change():
    text = _flat("content/consent.md")
    assert "cannot undo a change automatically" in text
    for outcome in ("saved as asked", "could not confirm", "did not work"):
        assert outcome in text, outcome


def test_sign_out_is_done_on_the_helper_page_with_canvas_menu():
    revoke = _flat("content/revoke.md")
    assert "Ask Muse to sign you out" not in revoke
    for rel in ("content/revoke.md", "content/consent.md"):
        text = _flat(rel)
        assert "helper page" in text, rel
        assert "Account, then Logout" in text, rel
    skill = _flat("SKILL.md")
    assert "Account, then Logout" in skill
    assert "no command that signs" in skill


@pytest.mark.parametrize("rel", ("content/consent.md",
                                 "content/setup-guide.md"))
def test_the_educator_hears_who_else_can_read_course_traffic(rel):
    text = _flat(rel)
    assert "can read that traffic" in text, rel
    assert "Canvas sign-in session and the course pages" in text, rel
    assert "Morrow cannot prevent that" in text, rel
    assert "check them before you connect" in text, rel


SUPPORT_EMAIL = "hello@meetmorrow.app"
SUPPORT_PAGE = "meetmorrow.app/support"


@pytest.mark.parametrize("rel", PAGES)
def test_every_educator_page_says_how_to_get_help(rel):
    # No Muse doc named a way to reach Morrow. setup-guide.md ended "that
    # is a bug, and we want to hear about it" with no address, while the
    # website's Support page expects Muse to help the educator email
    # Morrow with the Morrow for Muse version (final sweep 2026-09-23).
    text = _flat(rel)
    assert SUPPORT_EMAIL in text, rel
    assert SUPPORT_PAGE in text, rel
    assert "Do not send student information" in text, rel


def test_skill_tells_the_agent_how_the_educator_gets_help():
    with open(os.path.join(TREE, "SKILL.md"), encoding="utf-8") as fh:
        text = fh.read()
    match = re.search(r"^## Getting help\n(.*?)(?=^## )", text,
                      re.MULTILINE | re.DOTALL)
    assert match, "SKILL.md has no Getting help section"
    section = " ".join(match.group(1).split())
    assert SUPPORT_EMAIL in section and SUPPORT_PAGE in section
    # The version the Support page asks for, and how to read it.
    assert "bin/morrow version" in section
    assert "student" in section and "never" in section.lower()


def _helper_page_text():
    with open(os.path.join(TREE, "helper", "index.html"),
              encoding="utf-8") as fh:
        page = fh.read()
    page = re.sub(r"(?s)<(script|style)\b.*?</\1>", " ", page)
    page = re.sub(r"<[^>]+>", " ", page)
    page = page.replace("&rsquo;", "'").replace("&middot;", " ")
    return " ".join(page.split())


def test_the_sign_in_page_says_the_session_lives_on_the_muse_computer():
    # Failure mode (final sweep 2026-09-23, written before the fix): the
    # helper page said "Morrow keeps your Canvas session on your own
    # machine" and "Your sign-in stays in this browser on your machine".
    # The session lives in the helper's private browser on the Muse
    # computer, as consent.md and the website privacy page say.
    text = _helper_page_text()
    assert "own machine" not in text
    assert "on your machine" not in text
    assert text.count("private browser on your Muse computer") == 2, text


# Each limitation privacy/FERPA_POLICY.md records, by the words its
# bullet starts with, and the words consent.md tells the educator about
# it with. None marks a limitation that lets no student detail reach the
# assistant; the comment above it says why.
POLICY_LIMITS = {
    # how people data is recognized; course content passes the roster
    "Learner-data detection is URL based": None,
    # labels only: matching a label to a student takes the roster
    "Small cohorts": None,
    "Nicknames": "such as a nickname",
    "The course roster bounds what can be labeled":
        "someone who was never a student in that course",
    # hides more than it must, and saves the word back as written
    "A word that matches a student's first or last name": None,
    "A first or last name alone is labeled only when it is capitalized":
        "used alone and written in small letters",
    # hides more: every accent and apostrophe spelling is labeled
    "Matching compares base letters": None,
    "A course's own name": "a course's own name",
    "Bare numeric ids": "an ID number written as plain text",
    "\"canvas id <id>\"": "an ID number written as plain text",
    # refused, never passed on in part
    "Secret-shaped text": None,
    "Opaque blobs": None,
    # how a change puts ids back; nothing reaches the assistant
    "The executor's write-direction resolver": None,
    # an initial is not a name, and the last name beside it is labeled
    "An initial next to a last name": None,
    "Bare dates of birth": "such as a birth date",
    # hides more than it must
    "A file object's `display_name`": None,
    # the educator, not a student
    "The educator's own profile": None,
    # refused
    "Learner-data operations dispatch only where": None,
    "Two students with the same display name": None,
    "Platform TLS inspection": "can read that traffic",
    # the proxy's credential, not a student detail
    "Loopback CONNECT relay": None,
}


def _policy_limits():
    with open(os.path.join(TREE, "privacy", "FERPA_POLICY.md"),
              encoding="utf-8") as fh:
        text = fh.read()
    section = text.split("## Known limitations (honest scope)\n", 1)[1]
    section = section.split("\n## ", 1)[0]
    return [" ".join(item.split())
            for item in re.findall(r"^- (.*(?:\n  .*)*)", section,
                                   re.MULTILINE)]


def test_consent_names_every_limit_the_privacy_policy_records():
    limits = _policy_limits()
    assert len(limits) >= 10, limits
    undecided = [item[:70] for item in limits
                 if not any(item.startswith(key) for key in POLICY_LIMITS)]
    assert undecided == [], "say what consent.md tells the educator " \
        "about: %s" % undecided
    stale = [key for key in POLICY_LIMITS
             if not any(item.startswith(key) for item in limits)]
    assert stale == [], stale
    consent = _flat("content/consent.md")
    missing = sorted({words for words in POLICY_LIMITS.values()
                      if words and words not in consent})
    assert missing == [], missing
    assert "Apart from those limits" in consent


def test_the_0_4_1_notes_name_the_limits_the_consent_page_lists():
    with open(os.path.join(TREE, "CHANGELOG.md"), encoding="utf-8") as fh:
        text = fh.read()
    notes = " ".join(text.split("\n## 0.4.1 (", 1)[1]
                     .split("\n## ", 1)[0].split())
    for words in ("such as a nickname",
                  "used alone and written in small letters",
                  "someone who was never a student in that course",
                  "an ID number written as plain text",
                  "such as a birth date"):
        assert words in notes, words
