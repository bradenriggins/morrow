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
