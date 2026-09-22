#!/usr/bin/env python3
"""Adversarial selftests for the student de-identification layer.

Run: python3 privacy/deidentif_selftest.py
(from ~/workspace/morrow-for-muse-deploy)

These tests ATTACK privacy/pseudonym.py: each one tries to leak a
recognizable student identifier (name, email, login, SIS id, numeric
user id) through Deidentifier.scrub() via nested objects, arrays,
pagination, free text, unicode homoglyphs, base64 blobs, and
CSV-grade grade dumps. ANY surviving recognizable identifier fails
the suite. No live Canvas session is used; all fixtures are synthetic
and live in this file. Test scratch (salt + map) lives under
privacy/.selftest-work/ (or MORROW_SELFTEST_SCRATCH during the audit
wave), never /tmp and never the educator's real
~/.morrow files.
"""
import base64
import json
import os
import stat
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
_TRANSPORT = os.path.join(_REPO, "transport")
for _p in (_REPO, _HERE, _TRANSPORT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from privacy import pseudonym as pn
import browser_backend as bb  # noqa: E402 (imported at module load like
# transport/browser_backend_selftest.py does; only _pii_reveal_audit and
# _project_learner_result are exercised, no browser is touched)

TENANT = "https://school.instructure.com"

# Wave-3 hygiene: MORROW_SELFTEST_SCRATCH redirects test scratch to the
# wave's authorized scratch area (never /tmp); the repo-local default
# keeps the suite hermetic outside the audit.
_SCRATCH_ROOT = os.environ.get("MORROW_SELFTEST_SCRATCH")
SCRATCH = (os.path.join(_SCRATCH_ROOT, "deidentif")
           if _SCRATCH_ROOT else os.path.join(_HERE, ".selftest-work"))
os.makedirs(SCRATCH, exist_ok=True)
os.environ[pn.SALT_ENV_VAR] = os.path.join(SCRATCH, "privacy_salt")
os.environ[pn.MAP_ENV_VAR] = os.path.join(SCRATCH, "privacy_map.jsonl")


# W4-P0-4/5 wiring hermeticity: purge_tenant()/wipe() now purge browser
# transient state through transport.browser_backend's module-level
# defaults (~/.morrow). Redirect the module globals at scratch so this
# suite never touches real transient state.
from transport import browser_backend as _bb
_bb.PENDING_DIR = os.path.join(SCRATCH, "transient-pending")
_bb.BRIEF_DIR = os.path.join(SCRATCH, "transient-briefs")
os.makedirs(_bb.PENDING_DIR, exist_ok=True)
os.makedirs(_bb.BRIEF_DIR, exist_ok=True)


def fresh_deidentifier(tenant=TENANT):
    # A new handle per test keeps identifier sets isolated; the salt
    # file persists so determinism across handles is still exercised.
    return pn.Deidentifier(tenant)


def leaked_identifiers():
    return [
        "Jane Doe",
        "jane.doe@example.edu",
        "jdoe99",
        "SIS-4471",
        "8675309",
        "John Smith",
        "john.smith@example.edu",
        "jsmith2",
        "SIS-9910",
        "1234567",
    ]


def register_pair(d):
    d.register_learner("8675309", {
        "name": "Jane Doe",
        "sortable_name": "Doe, Jane",
        "short_name": "Jane",
        "email": "jane.doe@example.edu",
        "login_id": "jdoe99",
        "sis_user_id": "SIS-4471",
    })
    d.register_learner("1234567", {
        "name": "John Smith",
        "sortable_name": "Smith, John",
        "short_name": "Johnny",
        "email": "john.smith@example.edu",
        "login_id": "jsmith2",
        "sis_user_id": "SIS-9910",
    })


def assert_no_leak(scrubbed, identifiers, where):
    """Fail if any identifier (or its homoglyph-folded form) survives."""
    blob = json.dumps(scrubbed, sort_keys=True, default=str)
    folded_blob = pn.fold(blob)
    for ident in identifiers:
        if not ident:
            continue
        folded = pn.fold(ident)
        if folded and folded in folded_blob:
            raise AssertionError(
                "LEAK in %s: %r (folded %r) survived scrubbing"
                % (where, ident, folded))
        # Raw substring check too, belt and suspenders.
        if ident in blob:
            raise AssertionError(
                "LEAK in %s: raw %r survived scrubbing" % (where, ident))


def pseudo_of(d, identifier, scope="student"):
    return d.register(identifier, scope=scope)


# ---------------------------------------------------------------------------
# Structured shapes
# ---------------------------------------------------------------------------

def test_structured_learner_dict_scrubbed():
    d = fresh_deidentifier()
    register_pair(d)
    payload = {
        "id": 8675309,
        "name": "Jane Doe",
        "sortable_name": "Doe, Jane",
        "email": "jane.doe@example.edu",
        "login_id": "jdoe99",
        "sis_user_id": "SIS-4471",
        "enrollment_state": "active",
    }
    out = d.scrub(payload)
    assert_no_leak(out, leaked_identifiers(), "structured user dict")
    assert out["enrollment_state"] == "active"
    assert out["name"].startswith("stu_")


def test_nested_objects_arrays():
    d = fresh_deidentifier()
    register_pair(d)
    payload = {
        "enrollments": [
            {"id": 11, "type": "StudentEnrollment",
             "user": {"id": 8675309, "name": "Jane Doe",
                      "email": "jane.doe@example.edu"},
             "grades": {"current_score": 95.0}},
            {"id": 12, "type": "StudentEnrollment",
             "student": {"user_id": 1234567, "short_name": "Johnny"}},
        ],
        "course": {"id": 89585, "name": "Biology 101"},
    }
    out = d.scrub(payload)
    assert_no_leak(out, leaked_identifiers(), "nested enrollments")
    assert out["enrollments"][0]["grades"]["current_score"] == 95.0
    assert out["course"]["name"] == "Biology 101"


def test_paginated_users_list():
    d = fresh_deidentifier()
    register_pair(d)
    payload = {
        "users": [
            {"id": 8675309, "name": "Jane Doe",
             "login_id": "jdoe99"},
            {"id": 1234567, "name": "John Smith",
             "sis_user_id": "SIS-9910"},
        ],
        "meta": {"next": "/api/v1/courses/1/users?page=2", "per_page": 50},
    }
    out = d.scrub(payload)
    assert_no_leak(out, leaked_identifiers(), "paginated users")
    assert out["meta"]["per_page"] == 50


def test_submission_body_and_comments():
    d = fresh_deidentifier()
    register_pair(d)
    payload = {
        "id": 4242,
        "user_id": 8675309,
        "body": "Hi, this is Jane Doe (jdoe99) submitting late. "
                "My SIS id is SIS-4471 if the upload looks wrong.",
        "comments": [
            {"author": {"id": 1234567, "name": "John Smith"},
             "comment": "John Smith here: I saw Jane's draft."},
        ],
        "score": 88.5,
    }
    out = d.scrub(payload)
    assert_no_leak(out, leaked_identifiers(), "submission body/comments")
    assert out["score"] == 88.5


# ---------------------------------------------------------------------------
# Adversarial free-text attacks
# ---------------------------------------------------------------------------

def test_email_embedded_in_free_text():
    d = fresh_deidentifier()
    register_pair(d)
    payload = {"note": "Questions? Contact jane.doe@example.edu or "
                       "john.smith@example.edu before Friday."}
    out = d.scrub(payload)
    assert_no_leak(out, leaked_identifiers(), "email in free text")
    assert out["note"].startswith("Questions? Contact stu_")


def test_homoglyph_name_masked():
    # Cyrillic lookalikes: J + CYRILLIC SMALL A + ne, D + CYRILLIC SMALL
    # O + e. Visually "Jane Doe", codepoints differ.
    d = fresh_deidentifier()
    register_pair(d)
    sneaky = "J\u0430ne D\u043e\u0435"
    assert sneaky != "Jane Doe"
    assert pn.fold(sneaky) == pn.fold("Jane Doe"), \
        "fold must catch the cyrillic lookalike"
    payload = {"body": "Submitted by %s, please grade soon." % sneaky}
    out = d.scrub(payload)
    assert_no_leak(out, leaked_identifiers(), "homoglyph name")
    assert_no_leak(out, [sneaky], "homoglyph raw form")


def test_greek_homoglyph_name_masked():
    d = fresh_deidentifier()
    register_pair(d)
    # GREEK SMALL LETTER OMICRON/RHO/EPSILON in "John": J\u03bfhn
    sneaky = "J\u03bfhn Sm\u03b9th"
    payload = {"body": "Peer review by %s." % sneaky}
    out = d.scrub(payload)
    assert_no_leak(out, [sneaky], "greek homoglyph raw form")
    assert_no_leak(out, leaked_identifiers(), "greek homoglyph leak sweep")


def test_base64_blob_masked():
    d = fresh_deidentifier()
    register_pair(d)
    inner = "Student: Jane Doe <jane.doe@example.edu> id 8675309"
    blob = base64.b64encode(inner.encode("utf-8")).decode("ascii")
    assert len(blob) >= 24
    payload = {"attachment": {"data": "prefix " + blob + " suffix"}}
    out = d.scrub(payload)
    assert_no_leak(out, leaked_identifiers(), "base64 blob")
    # The decoded inside must be masked too.
    m = pn._B64_RE.search(out["attachment"]["data"])
    assert m, "expected a base64 segment to remain"
    decoded = base64.b64decode(m.group(0)).decode("utf-8")
    assert_no_leak({"d": decoded}, leaked_identifiers(),
                   "base64 decoded inside")


def test_grade_dump_csv_masked_grades_kept():
    d = fresh_deidentifier()
    register_pair(d)
    csv_text = ("user_id,student_name,score\n"
                "8675309,Jane Doe,95\n"
                "1234567,John Smith,88\n")
    out = d.scrub({"export": csv_text})
    assert_no_leak(out, leaked_identifiers(), "csv grade dump")
    # Grades and structure survive; ids and names do not.
    assert ",95" in out["export"] and ",88" in out["export"]
    assert "user_id,student_name,score" in out["export"]


def test_bare_numeric_id_masked_short_numbers_kept():
    d = fresh_deidentifier()
    register_pair(d)
    payload = {"note": "Roster id 8675309 scored 95 of 100; "
                       "see section 7."}
    out = d.scrub(payload)
    assert_no_leak(out, ["8675309"], "bare numeric id")
    for token in ("95", "100", "7"):
        assert token in out["note"], \
            "short number %r must survive (grades/counts)" % token


def test_sis_and_login_ids_in_prose():
    d = fresh_deidentifier()
    register_pair(d)
    payload = {"note": "jdoe99 / SIS-4471 needs a reset; "
                       "jsmith2 / SIS-9910 is fine."}
    out = d.scrub(payload)
    assert_no_leak(out, leaked_identifiers(), "sis/login ids in prose")


def test_unregistered_email_caught_on_sight():
    d = fresh_deidentifier()
    # Never registered: the regex pass must still catch and pseudonymize.
    payload = {"note": "cc TA quinn.park@example.edu on this."}
    out = d.scrub(payload)
    assert "quinn.park@example.edu" not in json.dumps(out)
    assert out["note"].startswith("cc TA stu_")
    # Deterministic: same email, same pseudonym, no duplicate map rows.
    again = d.scrub({"note": "quinn.park@example.edu"})
    assert again["note"] == out["note"].split(" on this.")[0].replace(
        "cc TA ", "")


def test_non_pii_untouched():
    d = fresh_deidentifier()
    register_pair(d)
    payload = {"course": {"id": 89585, "name": "Biology 101"},
               "assignment": {"id": 42, "name": "Midterm Exam"}}
    out = d.scrub(payload)
    assert out == payload, "non-learner content must pass through unchanged"


def test_pseudonym_carries_no_input():
    d = fresh_deidentifier()
    p = pseudo_of(d, "Jane Doe", scope="name")
    assert p.startswith("stu_")
    for frag in ("jane", "doe", "Jane", "Doe"):
        assert frag not in p, "pseudonym leaks input fragment %r" % frag


# ---------------------------------------------------------------------------
# Determinism, persistence, permissions
# ---------------------------------------------------------------------------

def test_deterministic_across_instances():
    d1 = fresh_deidentifier()
    register_pair(d1)
    p1 = pseudo_of(d1, "Jane Doe", scope="name")
    d2 = fresh_deidentifier()
    register_pair(d2)
    p2 = pseudo_of(d2, "Jane Doe", scope="name")
    assert p1 == p2, "same identifier must map to the same pseudonym"
    # And scrubbing the same payload twice is stable.
    payload = {"note": "Jane Doe <jane.doe@example.edu>"}
    assert d1.scrub(payload) == d2.scrub(payload)


def test_tenant_isolation():
    d1 = pn.Deidentifier("https://x.instructure.com")
    d2 = pn.Deidentifier("https://someothertenant.instructure.com")
    assert (d1.register("Jane Doe", scope="name")
            != d2.register("Jane Doe", scope="name")), \
        "pseudonyms must differ across tenants"


def test_salt_and_map_permissions():
    d = fresh_deidentifier()
    register_pair(d)
    salt = os.environ[pn.SALT_ENV_VAR]
    mapp = os.environ[pn.MAP_ENV_VAR]
    assert os.path.exists(salt) and os.path.exists(mapp)
    for path in (salt, mapp):
        mode = stat.S_IMODE(os.stat(path).st_mode)
        assert mode == 0o600, "%s mode is %o, want 0600" % (path, mode)
    home = os.path.dirname(salt)
    assert stat.S_IMODE(os.stat(home).st_mode) == 0o700


def test_lookup_reversal_educator_only():
    d = fresh_deidentifier()
    p = pseudo_of(d, "SIS-4471", scope="sis_user_id")
    rec = d.lookup(p)
    assert rec is not None and rec["identifier"] == "SIS-4471"
    assert d.lookup("stu_" + "0" * 16) is None


def test_purge_tenant():
    d = fresh_deidentifier()
    p = pseudo_of(d, "Jane Doe", scope="name")
    assert d.lookup(p) is not None
    n = d.purge_tenant(TENANT)
    assert n >= 1
    assert d.lookup(p) is None, "purged pseudonyms must stop resolving"


def test_purge_and_wipe_clear_browser_transient_state():
    # W4-P0-4/W4-P0-5: pending envelopes (raw payloads) and briefs are
    # purged on EVERY purge/wipe path, including orphan briefs.
    # W5-P1-2: in-flight envelopes (younger than the TTL) are never
    # silently destroyed, so the planted envelope is aged past the TTL.
    import time as _t
    from datetime import datetime, timezone
    def plant():
        env = os.path.join(_bb.PENDING_DIR, "op-x.json")
        brf = os.path.join(_bb.BRIEF_DIR, "orphan-x-request.txt")
        _old = _t.time() - 8 * 86400
        _old_iso = datetime.fromtimestamp(
            _old, tz=timezone.utc).isoformat()
        with open(env, "w", encoding="utf-8") as fh:
            fh.write('{"user": {"name": "Zeldana Fakeington"}, '
                     '"op_id": "op-x", "created_at": "%s"}' % _old_iso)
        with open(brf, "w", encoding="utf-8") as fh:
            fh.write("brief: comment on Zeldana Fakeington's submission")
        os.utime(env, (_old, _old))
        return env, brf
    env, brf = plant()
    d = fresh_deidentifier()
    d.purge_tenant(TENANT)
    assert not os.path.exists(env) and not os.path.exists(brf), \
        "purge_tenant must clear envelopes and orphan briefs"
    env, brf = plant()
    d.wipe()
    assert not os.path.exists(env) and not os.path.exists(brf), \
        "wipe must clear envelopes and orphan briefs"


def test_splice_termination_when_key_inside_pseudo():
    # An identifier that is a substring of its own pseudonym's tail must
    # still terminate: inserted pseudonyms are never re-scanned.
    folded, index_map = pn._fold_with_map("x ada y and ada")
    text, _, _ = pn.Deidentifier._splice_all(
        "x ada y and ada", folded, index_map, "ada", "stu_ada1234")
    assert text == "x stu_ada1234 y and stu_ada1234", text


def test_word_boundary_short_name():
    # "Ann" must not eat "annual" or "Annie", but standalone "Ann" goes.
    d = fresh_deidentifier()
    d.register("Ann", scope="short_name")
    out = d.scrub({"note": "Annual review for Ann and Annie."})
    assert "Annual" in out["note"], "Annual must survive"
    assert "Annie" in out["note"], "Annie must survive"
    assert " Ann " not in out["note"], "standalone Ann must be masked"
    assert "stu_" in out["note"]


def test_fold_adversarial_unicode():
    # WORKSTREAM 4: the name-fold tokenizer must never raise and must be
    # deterministic on adversarial unicode: CJK, emoji, combining marks,
    # apostrophes/hyphens, empty strings.
    cases = ["Braden Riggins", "CAF\u00c9", "\u65e5\u672c\u8a9e", "",
             "O'Brien-Smith", "\u00e9\u0301 combining", "\U0001f600",
             "  spaced  ", "x" * 5000]
    for text in cases:
        out = pn.fold(text)
        assert isinstance(out, str), "fold must return str for %r" % text[:20]
        assert pn.fold(text) == out, "fold must be deterministic for %r" % text[:20]
    # Case-insensitive matching is the point of the fold.
    assert pn.fold("Braden Riggins") == pn.fold("braden riggins")


def test_no_tmp_paths_used():
    for var in (pn.SALT_ENV_VAR, pn.MAP_ENV_VAR):
        path = os.environ[var]
        assert not path.startswith("/tmp"), \
            "%s points at /tmp: %s" % (var, path)
        assert path.startswith(SCRATCH), \
            "%s must live under test scratch: %s" % (var, path)
    # The repo-local containment invariant is waived when the wave
    # redirects scratch via MORROW_SELFTEST_SCRATCH: the two assertions
    # above (never /tmp, always under SCRATCH) still hold.
    if not os.environ.get("MORROW_SELFTEST_SCRATCH"):
        assert os.path.abspath(SCRATCH).startswith(os.path.abspath(_HERE))


# ---------------------------------------------------------------------------
# Reveal consent gate (W3-P1-44, fail-closed default)
#
# The bare MORROW_REVEAL_STUDENT_PII_REASON environment variable is
# ignored: an agent that can set its own environment could otherwise
# consent to its own PII reveal. Consent comes only from the educator's
# hand-created consent file <tree-state-dir>/educator_pii_reveal, which
# must be a regular file with mode 0600 carrying a documented
# instructional purpose of at least 12 characters. Malformed consent
# fails closed. The journal attribution is "educator-consent-file".
# ---------------------------------------------------------------------------

def _isolated_tree_state(name="reveal"):
    """Point the tree-state dir at test scratch; never the educator's
    real tree state. Returns the previous MORROW_TREE_STATE_DIR value."""
    d = os.path.join(SCRATCH, "tree_state_%s" % name)
    os.makedirs(d, exist_ok=True)
    old = os.environ.get("MORROW_TREE_STATE_DIR")
    os.environ["MORROW_TREE_STATE_DIR"] = d
    return old


def _restore_tree_state(old):
    if old is None:
        os.environ.pop("MORROW_TREE_STATE_DIR", None)
    else:
        os.environ["MORROW_TREE_STATE_DIR"] = old


def _write_consent(reason_bytes, mode=0o600):
    from privacy import executor_wire as _wire
    path = _wire.consent_path()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, reason_bytes)
    finally:
        os.close(fd)
    os.chmod(path, mode)  # os.open mode applies only on creation
    return path


def test_reveal_unset_means_deidentify():
    # No consent file and no env var: nothing revealed.
    old = _isolated_tree_state("unset")
    try:
        assert bb._pii_reveal_audit() is None
    finally:
        _restore_tree_state(old)


def test_reveal_env_var_ignored():
    # A documented-sounding env var alone must NOT reveal: the agent
    # could set its own environment and consent to its own PII reveal.
    os.environ["MORROW_REVEAL_STUDENT_PII_REASON"] = (
        "grading review with the course TA before posting finals")
    old = _isolated_tree_state("env")
    try:
        assert bb._pii_reveal_audit() is None, \
            "bare env var must be ignored without a consent file"
    finally:
        _restore_tree_state(old)
        os.environ.pop("MORROW_REVEAL_STUDENT_PII_REASON", None)


def test_reveal_stub_reason_refused():
    old = _isolated_tree_state("stub")
    try:
        _write_consent(b"test")
        try:
            bb._pii_reveal_audit()
        except Exception as exc:
            assert "documented instructional purpose" in str(exc), str(exc)
        else:
            raise AssertionError("stub reveal reason must fail closed")
    finally:
        _restore_tree_state(old)


def test_reveal_wrong_mode_refused():
    old = _isolated_tree_state("mode")
    try:
        _write_consent(b"a documented instructional purpose here", mode=0o644)
        try:
            bb._pii_reveal_audit()
        except Exception as exc:
            assert "0600" in str(exc), str(exc)
        else:
            raise AssertionError("world-readable consent must fail closed")
    finally:
        _restore_tree_state(old)


def test_reveal_documented_reason_audited():
    reason = "grading review with the course TA before posting finals"
    old = _isolated_tree_state("audited")
    try:
        _write_consent(reason.encode())
        audit = bb._pii_reveal_audit()
    finally:
        _restore_tree_state(old)
    assert audit["reason"] == reason
    assert audit["revealed_by"] == "educator-consent-file"


def _isolated_source_vault(name="test"):
    """Point the source vault at test scratch (never the educator's real
    ~/.morrow/morrow_source_vault.json). Each name gets a fresh vault so
    Student A<n> labels are deterministic per test."""
    scratch_vault = os.path.join(SCRATCH, "source_vault_%s.json" % name)
    try:
        os.unlink(scratch_vault)
    except FileNotFoundError:
        pass
    old = os.environ.get(bb.SOURCE_VAULT_ENV_VAR)
    os.environ[bb.SOURCE_VAULT_ENV_VAR] = scratch_vault
    return old


def _restore_source_vault(old):
    if old is None:
        os.environ.pop(bb.SOURCE_VAULT_ENV_VAR, None)
    else:
        os.environ[bb.SOURCE_VAULT_ENV_VAR] = old


def _have_crypto():
    try:
        from privacy import core as _pc
        return _pc.AESGCM is not None
    except Exception:
        return False


def test_projection_wire_applies_scrub():
    # End-to-end through the wired choke point: a learner-data entry's
    # receipt is projected through the source privacy boundary into
    # stable Student A<n> labels before it becomes agent-visible.
    # Without the optional 'cryptography' package (degraded mode,
    # documented in INSTALL.md) the file-backed vault cannot seal, so
    # the wire must refuse loudly and name the fix instead of
    # projecting: the educator gets an actionable error, not a mystery.
    from dispatch import admission as adm
    entry = {"name": "t_users", "request": {"url":
             "https://school.instructure.com/api/v1/courses/1/users"}}
    assert adm.touches_learner_data(entry), "fixture must be learner-data"
    old_ts = _isolated_tree_state("wire")  # no consent file may leak in
    old = _isolated_source_vault("wire")
    try:
        result = {"receipt": [
            {"id": 8675309, "name": "Jane Doe",
             "email": "jane.doe@example.edu",
             "bio": "Jane Doe likes biology."},
        ], "truncated": False, "bytes_received": 10}
        if not _have_crypto():
            try:
                bb._project_learner_result(entry, result, TENANT)
            except Exception as exc:
                msg = str(exc)
                assert "cryptography" in msg, msg[:200]
                assert "requirements-optional.txt" in msg, msg[:200]
                return
            raise AssertionError(
                "expected a loud actionable refusal without cryptography")
        out = bb._project_learner_result(entry, result, TENANT)
    finally:
        _restore_source_vault(old)
        _restore_tree_state(old_ts)
    assert_no_leak(out, leaked_identifiers(), "wired projection")
    assert_no_leak(out, ["Jane Doe likes"], "wired free-text")
    rec = out["receipt"][0]
    assert rec["name"] == "Student A1", rec
    assert rec["id"] == "Student A1", rec
    assert "email" not in rec, rec
    assert rec["bio"] == "Student A1 likes biology.", rec


def test_projection_wire_reveal_skips_deidentify():
    # W3-P1-44: only a valid consent file skips deidentification; the
    # bare env var no longer does. Attribution is "educator-consent-file".
    entry = {"name": "t_users", "request": {"url":
             "https://school.instructure.com/api/v1/courses/1/users"}}
    reason = "accommodation review with disability services staff"
    old = _isolated_source_vault("reveal")
    old_ts = _isolated_tree_state("reveal")
    try:
        _write_consent(reason.encode())
        result = {"receipt": [{"id": 1, "name": "Jane Doe"}],
                  "truncated": False, "bytes_received": 1}
        out = bb._project_learner_result(entry, result, TENANT)
    finally:
        _restore_source_vault(old)
        _restore_tree_state(old_ts)
    assert out["receipt"] == [{"id": 1, "name": "Jane Doe"}]
    assert out["pii_reveal"]["reason"] == reason
    assert out["pii_reveal"]["revealed_by"] == "educator-consent-file"


def test_projection_wire_ignores_non_learner_entries():
    entry = {"name": "t_course", "request": {"url":
             "https://school.instructure.com/api/v1/courses/1"}}
    result = {"receipt": {"id": 1, "name": "Biology 101"},
              "truncated": False, "bytes_received": 1}
    out = bb._project_learner_result(entry, result, TENANT)
    assert out is result, "non-learner entries must pass through untouched"


def main():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as exc:
            failed += 1
            print("FAIL %s: %s: %s" % (t.__name__, type(exc).__name__, exc))
        else:
            print("ok %s" % t.__name__)
    print("%d/%d PASS" % (len(tests) - failed, len(tests)))
    # Self-clean: hermetic vault/map/salt/tree-state files are
    # deny-list-matching residue and must not linger in the tree.
    import shutil as _shutil
    for _f in os.listdir(SCRATCH):
        if _f in ("privacy_salt", "privacy_map.jsonl") or (
                _f.startswith("source_vault_")
                and _f.endswith((".json", ".json.key", ".json.lock"))):
            try:
                os.unlink(os.path.join(SCRATCH, _f))
            except FileNotFoundError:
                pass
        elif _f.startswith("tree_state_"):
            _shutil.rmtree(os.path.join(SCRATCH, _f), ignore_errors=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
