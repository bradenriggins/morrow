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
 11. A course given as anything but its Canvas number (the SIS form
     "sis_course_id:BIO101", a path like "1/../2") got labels in a
     scope of its own. The same label, used in the course by number,
     named a different student. Such a course is refused before any
     read, as the executor and the query refuse it.
 12. Errors skipped the failure funnel: they carried Python class names
     and no reference, and a stopped helper told the agent to sign the
     educator in again. Every error now carries a mode and a reference
     and names the real remedy: helper-down, the roster read failed,
     or the learner vault is missing.

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


# ------------------------------------------- course numbers and errors --

def _journal_lookups_or_none():
    from dispatch import executor as ex
    if not os.path.exists(ex.JOURNAL_PATH):
        return []
    return _lookups()


@pytest.mark.parametrize("course", ["sis_course_id:BIO101", "1/../2",
                                    "101?per_page=1", "0101", "", "abc"])
def test_course_must_be_given_by_its_canvas_number(home, course):
    from learners import find
    fetch = fake_canvas()
    out = find.find_student(fetch, BASE, course, "Jane Doe",
                            conversation_id=CONV)
    assert out["ok"] is False and out["status"] == "refused", out
    assert out["mode_id"] == "query-course-id-invalid", out
    assert out["correlation_id"]
    assert "canvas_list_courses" in out["next_step"], out
    assert "student" not in out
    # Nothing was read, so no label was issued in any scope.
    assert fetch.calls == []
    assert _journal_lookups_or_none() == []


def test_cli_refuses_a_sis_course_before_the_helper(home, capsys,
                                                    monkeypatch):
    from learners import find
    from learners import resolve_student as rs

    def _no_helper(*_a, **_k):
        raise AssertionError("the helper was reached for a bad course")
    monkeypatch.setattr(rs, "helper_fetch_factory", _no_helper)
    rc = find.main(["--course", "sis_course_id:BIO101", "--canvas-base",
                    BASE, "Jane Doe"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 1 and out["status"] == "refused", out


_CLASS_NAME_RE = re.compile(r"\b[A-Za-z]*(?:Error|Exception|Unavailable)\b")


def _funneled(out, mode_id):
    assert out["ok"] is False and out["status"] == "error", out
    assert out["mode_id"] == mode_id, out
    assert re.fullmatch(r"[0-9a-f]{12}", out["correlation_id"]), out
    assert out["correlation_id"] in out["message"], out
    assert _CLASS_NAME_RE.findall(out["message"]) == [], out["message"]
    assert "error" not in out
    return out


@pytest.fixture
def helper_env(tmp_path, monkeypatch):
    """helper/env and the tree state dir for the real helper client."""
    def write(port):
        env_file = tmp_path / "helper-env"
        env_file.write_text("CANVAS_BASE=%s\nLOGIN_HELPER_PORT=%d\n"
                            % (BASE, port))
        env_file.chmod(0o600)
        state = tmp_path / "tree-state"
        state.mkdir(exist_ok=True)
        (state / "helper_token").write_text("ab" * 32 + "\n")
        for name in ("CANVAS_BASE", "LOGIN_HELPER_PORT",
                     "LOGIN_HELPER_TLS_CERT", "LOGIN_HELPER_TLS_KEY"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("MORROW_HELPER_ENV_FILE", str(env_file))
        monkeypatch.setenv("MORROW_TREE_STATE_DIR", str(state))
    return write


def test_helper_down_says_helper_down_not_sign_in(home, helper_env,
                                                  capsys):
    """The scenario: the helper process is down while the Canvas sign-in
    is fine. A bound socket that never listens refuses the connection,
    as a stopped helper does."""
    import socket
    from learners import find
    closed = socket.socket()
    closed.bind(("127.0.0.1", 0))
    try:
        helper_env(closed.getsockname()[1])
        rc = find.main(["--course", "89585", "--conversation-id", "c1",
                        "Jane Doe"])
    finally:
        closed.close()
    out = _funneled(json.loads(capsys.readouterr().out), "helper-down")
    assert rc == 1
    assert "Sign the educator in" not in out["message"]
    assert "not affected" in out["message"]
    assert "keepalive" in out["next_step"]


def test_signed_out_helper_asks_for_a_sign_in(home, helper_env, capsys):
    import http.server
    import threading
    from learners import find

    class _Helper(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            raw = json.dumps({"logged_in": False,
                              "chromium_alive": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Helper)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        helper_env(srv.server_address[1])
        rc = find.main(["--course", "89585", "Jane Doe"])
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()
    _funneled(json.loads(capsys.readouterr().out), "canvas-session-dead")
    assert rc == 1


def test_roster_read_failure_is_a_live_read_failure(home):
    def fetch(url):
        return 500, {}, "<html>Internal error</html>"
    out = _funneled(_find("Jane Doe", fetcher=fetch),
                    "query-live-read-failed")
    assert "not an empty class" in out["message"]


def test_missing_vault_is_learner_data_gated(home, monkeypatch):
    from privacy import core
    monkeypatch.setattr(core, "AESGCM", None)
    out = _funneled(_find("Jane Doe"), "learner-data-gated")
    assert "requirements-optional.txt" in out["message"]
    assert _no_secrets(out) == [], out


def test_unrecorded_lookup_is_funneled(home, monkeypatch):
    from learners import find

    def _fail(*_a, **_k):
        raise OSError("journal disk full")
    monkeypatch.setattr(find, "_journal_lookup", _fail)
    out = _find("Jane Doe")
    assert out["ok"] is False and out["status"] == "error", out
    assert out["correlation_id"] and "student" not in out
    assert _CLASS_NAME_RE.findall(out["message"]) == [], out["message"]
