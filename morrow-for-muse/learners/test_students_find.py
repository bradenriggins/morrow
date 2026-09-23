#!/usr/bin/env python3
"""`morrow students find`: the educator names a student, the agent gets a label.

Failure modes this suite pins down (written before the code; privacy
audit round 4, H3a/H3b, 2026-09-22):
  1. No typed tool turned the name the educator typed into a label, so
     the educator could not work by name at all.
  2. An exact or unambiguous name must give ONE label and nothing else
     about the student (no email, login, SIS id, or Canvas id).
  3. An ambiguous name must list EVERY candidate as a label with
     non-identifying disambiguators (section, enrollment state, last
     activity date), never another student's real name.
  4. A fuzzy (typo) match must never be auto-picked, even when only one
     student is close: the educator confirms first.
  5. A confirmation must name one of the offered candidates; any other
     label is refused.
  6. A section name that carries a student's name must not be shown.
  7. No-match output must not echo the educator's query.
  8. A resolved name is recorded as educator-introduced for THIS
     conversation only, so later outputs in this conversation show
     "<name as typed> (Student An)"; other conversations see the label
     only; the record ends with the conversation; the journal never
     holds the name.
  9. bin/morrow routes `students find` to this tool.
 10. The check that no stored file holds the name searched every byte
     for "Jane", including the vault ciphertext, a random run of
     base64url that holds "Jane" by chance with no leak. A stored name
     stands as its own word; the check matches it that way.

Needs the optional 'cryptography' package (labels come from the
encrypted vault); skips without it except the routing test.
"""

import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

BASE = "https://school.instructure.com"
COURSE = "1"
CONV = "conv-find-1"


def _enr(state="active", section=11, last="2026-09-01T10:00:00Z",
         kind="StudentEnrollment"):
    return {"type": kind, "enrollment_state": state,
            "course_section_id": section, "last_activity_at": last}


ROSTER = [
    {"id": 98765, "name": "Jane Doe", "sortable_name": "Doe, Jane",
     "short_name": "Jane Doe", "login_id": "jdoe",
     "email": "jane.doe@school.edu", "sis_user_id": "20231234",
     "enrollments": [_enr(section=11)]},
    {"id": 55123, "name": "Robert Smith", "sortable_name": "Smith, Robert",
     "login_id": "rsmith", "email": "rsmith@school.edu",
     "sis_user_id": "S-4411", "enrollments": [_enr(section=12)]},
    {"id": 70001, "name": "Casey Rivera", "sortable_name": "Rivera, Casey",
     "login_id": "crivera1", "email": "c1@school.edu",
     "enrollments": [_enr(section=11, last="2026-09-10T08:00:00Z")]},
    {"id": 70002, "name": "Casey Rivera", "sortable_name": "Rivera, Casey",
     "login_id": "crivera2", "email": "c2@school.edu",
     "enrollments": [_enr(section=13, state="inactive", last=None)]},
    {"id": 70003, "name": "Mia Chen", "sortable_name": "Chen, Mia",
     "login_id": "mchen", "email": "mia.chen@school.edu",
     "enrollments": [_enr(section=12)]},
]
SECTIONS = [{"id": 11, "name": "Period 2"}, {"id": 12, "name": "Period 4"},
            {"id": 13, "name": "Mia Chen independent study"}]
SECRETS = ("98765", "55123", "70001", "70002", "70003", "jdoe", "rsmith",
           "crivera", "mchen", "@school.edu", "20231234", "S-4411",
           "Robert", "Smith", "Mia", "Chen", "Doe, Jane")


_WORD_RE = re.compile(r"[A-Za-z0-9_-]+")


def found_in(text, needles):
    """The needles that occur in text.

    A needle made only of letters, digits, "_" and "-" counts only as a
    whole word. Ciphertext, HMACs, digests, keys, and op ids are long
    random runs of exactly those characters, so a short name or id can
    sit inside one by chance with no leak. A needle with any other
    character ("jane.doe@", "Doe, Jane") cannot occur inside such a run
    and counts anywhere."""
    words = set(_WORD_RE.findall(text))
    return [n for n in needles
            if (n in words if _WORD_RE.fullmatch(n) else n in text)]


def fake_canvas(roster=ROSTER, sections=SECTIONS):
    calls = []

    def fetch(url):
        calls.append(url)
        if "/sections" in url:
            return 200, {}, json.dumps(sections)
        if "/users" in url:
            return 200, {}, json.dumps(roster)
        return 404, {}, "{}"
    fetch.calls = calls
    return fetch


@pytest.fixture
def home(monkeypatch):
    pytest.importorskip("cryptography")
    root = os.path.join(HERE, ".selftest-work", "find-%d" % os.getpid())
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(os.path.join(root, "journal"))
    from privacy import executor_wire as wire
    from dispatch import executor as ex
    monkeypatch.setenv("MORROW_HOME", root)
    monkeypatch.setenv("MORROW_TREE_STATE_DIR", os.path.join(root, "tree"))
    monkeypatch.setenv(wire.SOURCE_VAULT_ENV_VAR,
                       os.path.join(root, "vault.json"))
    monkeypatch.setattr(ex, "JOURNAL_PATH",
                        os.path.join(root, "journal", "ops.jsonl"))
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _find(query, **kw):
    from learners import find
    kw.setdefault("conversation_id", CONV)
    return find.find_student(kw.pop("fetcher", None) or fake_canvas(),
                             BASE, COURSE, query, **kw)


def _no_secrets(out, allow=()):
    text = json.dumps(out)
    return [s for s in SECRETS if s in text and s not in allow]


def test_exact_name_gives_one_label_and_nothing_else(home):
    out = _find("Jane Doe")
    assert out["status"] == "resolved", out
    assert out["student"].startswith("Student A")
    assert out["shown_as"] == "Jane Doe (%s)" % out["student"]
    assert _no_secrets(out) == [], out


def test_partial_unique_name_resolves(home):
    out = _find("jane")
    assert out["status"] == "resolved", out
    assert out["shown_as"] == "jane (%s)" % out["student"]


def test_ambiguous_name_lists_every_candidate_without_names(home):
    out = _find("Casey Rivera", include_inactive=True)
    assert out["status"] == "confirm", out
    labels = [c["student"] for c in out["candidates"]]
    assert len(labels) == 2 and len(set(labels)) == 2
    for cand in out["candidates"]:
        assert set(cand) >= {"student", "section", "enrollment_state",
                             "last_activity"}
    states = sorted(c["enrollment_state"] for c in out["candidates"])
    assert states == ["active", "inactive"]
    assert any(c["last_activity"] == "2026-09-10" for c in out["candidates"])
    assert _no_secrets(out) == [], out
    # The section named after another student is not shown.
    assert "independent study" not in json.dumps(out)
    assert "Period 2" in json.dumps(out)


def test_fuzzy_single_match_asks_first(home):
    out = _find("Jane Deo")
    assert out["status"] == "confirm", out
    assert len(out["candidates"]) == 1
    assert "shown_as" not in out
    assert _no_secrets(out) == [], out


def test_confirmation_must_name_an_offered_candidate(home):
    first = _find("Casey Rivera", include_inactive=True)
    pick = first["candidates"][0]["student"]
    out = _find("Casey Rivera", include_inactive=True, choose=pick)
    assert out["status"] == "resolved" and out["student"] == pick
    other = _find("Jane Doe", conversation_id=None)["student"]
    refused = _find("Casey Rivera", include_inactive=True, choose=other)
    assert refused["status"] == "refused", refused
    assert refused["ok"] is False


def test_no_match_does_not_echo_the_query(home):
    out = _find("Quentin Zanzibar")
    assert out["status"] == "not_found"
    assert "Quentin" not in json.dumps(out)
    assert "Zanzibar" not in json.dumps(out)


def test_name_echo_is_scoped_to_the_conversation(home):
    from privacy import executor_wire as wire
    from privacy import name_echo
    out = _find("Jane Doe")
    label = out["student"]
    text = {"note": "%s turned it in late" % label}
    shown = wire.apply_name_echo(text, BASE, COURSE, CONV)
    assert shown["note"] == "Jane Doe (%s) turned it in late" % label
    other = wire.apply_name_echo(text, BASE, COURSE, "another-conv")
    assert other == text
    other_course = wire.apply_name_echo(text, BASE, "2", CONV)
    assert other_course == text
    name_echo.end_conversation(CONV)
    assert wire.apply_name_echo(text, BASE, COURSE, CONV) == text


def test_ending_the_conversation_in_settings_ends_the_echo(home):
    from privacy import executor_wire as wire
    from settings import store
    label = _find("Jane Doe")["student"]
    text = {"note": label}
    assert wire.apply_name_echo(text, BASE, COURSE, CONV) != text
    store.end_conversation("find-educator", CONV)
    assert wire.apply_name_echo(text, BASE, COURSE, CONV) == text


def _files_holding(root, needles):
    hits = {}
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(dirpath, name)
            with open(path, "rb") as fh:
                data = fh.read()
            found = found_in(data.decode("utf-8", "replace"), needles)
            if found:
                hits[os.path.relpath(path, root)] = found
    return hits


def test_stored_name_search_ignores_random_runs(home):
    with open(os.path.join(home, "vault.json"), "w") as fh:
        json.dump({"ciphertext": "hCn1HQlmx07kJaneV4X-q7XGMnGXJI0Og"}, fh)
    assert _files_holding(home, ("Jane",)) == {}
    with open(os.path.join(home, "leak.json"), "w") as fh:
        json.dump({"shown": "Jane Doe (Student A2)"}, fh)
    assert _files_holding(home, ("Jane",)) == {"leak.json": ["Jane"]}


def test_echo_store_and_journal_hold_no_plaintext_name(home):
    from dispatch import executor as ex
    _find("Jane Doe")
    assert _files_holding(home, ("Jane",)) == {}
    with open(ex.JOURNAL_PATH, encoding="utf-8") as fh:
        events = [json.loads(line) for line in fh if line.strip()]
    assert any(e.get("event") == "privacy.name_echo_recorded"
               for e in events)


def _lookups():
    from dispatch import executor as ex
    with open(ex.JOURNAL_PATH, encoding="utf-8") as fh:
        return [e for e in (json.loads(line) for line in fh if line.strip())
                if e.get("event") == "privacy.students_find"]


def test_every_lookup_is_journaled_without_the_name(home):
    """Final muse audit M5: a guessed name confirms roster membership,
    so every lookup leaves an audit record: course, conversation,
    outcome, and a keyed digest of the typed name (an auditor holding
    the vault key can check a suspected name; the journal never holds
    the name itself, because it cannot be purged)."""
    _find("Jane Doe")
    _find("jane  doe")
    _find("Quentin Zanzibar")
    _find("Jane Doe", conversation_id=None)
    events = _lookups()
    assert [e["outcome"] for e in events] == [
        "resolved", "resolved", "not_found", "resolved"]
    assert [e["conversation_id"] for e in events] == [CONV, CONV, CONV,
                                                      None]
    assert all(e["course_id"] == COURSE for e in events)
    digests = [e["query_digest"] for e in events]
    assert digests[0] == digests[1] == digests[3] != digests[2]
    text = json.dumps(events)
    for word in ("Jane", "jane", "Doe", "Quentin", "Zanzibar"):
        assert word not in text


def test_no_conversation_means_no_echo(home):
    out = _find("Jane Doe", conversation_id=None)
    assert out["status"] == "resolved"
    assert "shown_as" not in out
    assert "conversation" in out["message"]


def test_cli_prints_the_same_json(home, capsys):
    from learners import find
    rc = find.main(["--course", COURSE, "--canvas-base", BASE,
                    "--conversation-id", CONV, "Jane Doe"],
                   fetcher=fake_canvas())
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["status"] == "resolved"


def test_bin_morrow_routes_students_find(monkeypatch):
    loader = importlib.machinery.SourceFileLoader(
        "morrow_cli_find", os.path.join(TREE, "bin", "morrow"))
    spec = importlib.util.spec_from_loader("morrow_cli_find", loader)
    cli = importlib.util.module_from_spec(spec)
    loader.exec_module(cli)
    seen = {}
    from learners import find
    monkeypatch.setattr(find, "main",
                        lambda argv, fetcher=None: seen.setdefault(
                            "argv", argv) and 0)
    cli.main(["students", "find", "--course", "1", "Jane Doe"])
    assert seen["argv"] == ["--course", "1", "Jane Doe"]
