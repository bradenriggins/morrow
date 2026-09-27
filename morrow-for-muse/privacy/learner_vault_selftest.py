#!/usr/bin/env python3
"""Selftests for the learner vault / tokenization boundary.

Run: python3 privacy/learner_vault_selftest.py
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import json
import os
import stat
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
for _p in (_REPO, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from privacy import learner_vault as lv
from dispatch import admission as adm


# Hygiene: never /tmp (absolute). Vault test scratch lives under
# privacy/.selftest-work/ so it survives on the persistent workspace
# volume; the wave's authorized scratch area can take over via
# MORROW_SELFTEST_SCRATCH.
_VAULT_SCRATCH_ROOT = os.path.join(
    os.environ.get("MORROW_SELFTEST_SCRATCH") or
    os.path.join(_HERE, ".selftest-work"), "learner-vault")
os.makedirs(_VAULT_SCRATCH_ROOT, exist_ok=True)
_vault_scratch_n = [0]


# W4-P0-4/5 wiring hermeticity: purge_tenant()/wipe() now purge browser
# transient state through transport.browser_backend's module-level
# defaults (~/.morrow). Redirect the module globals at scratch so this
# suite never touches real transient state.
from transport import browser_backend as _bb
_bb.PENDING_DIR = os.path.join(_VAULT_SCRATCH_ROOT, "transient-pending")
_bb.BRIEF_DIR = os.path.join(_VAULT_SCRATCH_ROOT, "transient-briefs")
os.makedirs(_bb.PENDING_DIR, exist_ok=True)
os.makedirs(_bb.BRIEF_DIR, exist_ok=True)


def _mk_vault_scratch(prefix):
    # Replaces tempfile.mkdtemp (which defaults to /tmp): hermetic,
    # repo-local (or wave-redirected) per-test scratch. The pid keeps
    # names unique across runs, like mkdtemp's random suffix did.
    _vault_scratch_n[0] += 1
    path = os.path.join(_VAULT_SCRATCH_ROOT,
                        "%s%d-%d" % (prefix, os.getpid(),
                                     _vault_scratch_n[0]))
    os.makedirs(path, exist_ok=True)
    return path


def _fresh_vault():
    tmp = _mk_vault_scratch("vault-test-")
    return lv.LearnerVault(vault_dir=os.path.join(tmp, "vault"))


def test_token_deterministic():
    v1, v2 = _fresh_vault(), None
    # Second handle on the same dir must derive identical tokens.
    v2 = lv.LearnerVault(vault_dir=v1.dir)
    t1 = v1.token_for("https://school.example.edu", "12345")
    t2 = v2.token_for("https://school.example.edu", "12345")
    assert t1 == t2, "token not stable across vault handles"
    assert t1.startswith("lrn_") and len(t1) == len("lrn_") + 20


def test_token_tenant_isolated():
    v = _fresh_vault()
    a = v.token_for("https://a.example", "12345")
    b = v.token_for("https://b.example", "12345")
    assert a != b, "tokens must differ across tenants"


def test_token_carries_no_pii():
    v = _fresh_vault()
    t = v.token_for("https://school.example.edu", "12345")
    for frag in ("12345", "chcp", "lrn_12345"):
        assert frag not in t or frag == "lrn_12345"[:0], \
            "token leaks input material: %r in %r" % (frag, t)
    assert "12345" not in t and "chcp" not in t


def test_register_lookup_roundtrip():
    v = _fresh_vault()
    t = v.register("https://school.example.edu", "777",
                   {"name": "Test Student", "email": "t@example.com",
                    "sis_user_id": "S-1", "role": "oops-not-pii-field"})
    rec = v.lookup(t)
    assert rec is not None
    assert rec["pii"]["name"] == "Test Student"
    assert rec["pii"]["email"] == "t@example.com"
    assert rec["pii"]["sis_user_id"] == "S-1"
    # Non-PII keys are never stored in the identity map.
    assert "role" not in rec["pii"]
    assert v.lookup("lrn_nonexistent") is None


def test_register_merges_fields():
    v = _fresh_vault()
    t1 = v.register("https://t.example", "9", {"name": "N"})
    t2 = v.register("https://t.example", "9", {"email": "n@e.com"})
    assert t1 == t2, "same learner must keep one token"
    rec = v.lookup(t1)
    assert rec["pii"]["name"] == "N" and rec["pii"]["email"] == "n@e.com"


def test_projection_strips_pii_keeps_grades():
    v = _fresh_vault()
    payload = {
        "id": 89585,
        "enrollments": [
            {"id": 111, "user_id": 12345, "type": "StudentEnrollment",
             "role": "Student", "enrollment_state": "active",
             "course_id": 89585, "section_id": 42,
             "grades": {"current_score": 88.5, "final_grade": "B+"},
             "user": {"id": 12345, "name": "Ada Learner",
                      "sortable_name": "Learner, Ada",
                      "email": "ada@example.com", "login_id": "ada01",
                      "sis_user_id": "SIS-9", "avatar_url": "http://x/y.png",
                      "pronouns": "she/her"}},
            {"id": 112, "user_id": 67890, "type": "StudentEnrollment",
             "role": "Student", "enrollment_state": "invited",
             "grades": {"current_score": None},
             "user": {"id": 67890, "name": "Bob Learner",
                      "email": "bob@example.com"}},
        ],
    }
    out = lv.project_payload(payload, v, "https://school.example.edu")
    text = json.dumps(out)
    for leak in ("Ada Learner", "Learner, Ada", "ada@example.com", "ada01",
                 "SIS-9", "http://x/y.png", "she/her",
                 "Bob Learner", "bob@example.com", "12345", "67890"):
        assert leak not in text, "PII/learner id leaked: %r" % leak
    e0, e1 = out["enrollments"]
    assert e0["learner_token"].startswith("lrn_")
    assert e1["learner_token"].startswith("lrn_")
    assert e0["learner_token"] != e1["learner_token"]
    # Non-PII correlation fields survive.
    assert e0["role"] == "Student"
    assert e0["enrollment_state"] == "active"
    assert e0["grades"]["current_score"] == 88.5
    assert e0["course_id"] == 89585 and e0["section_id"] == 42
    assert e0["id"] == 111  # the enrollment's own id is not the learner
    # Input not mutated.
    assert payload["enrollments"][0]["user"]["name"] == "Ada Learner"


def test_projection_token_stable():
    v = _fresh_vault()
    rec = {"user_id": 555, "name": "Zed", "email": "z@e.com", "role": "Student"}
    t1 = lv.project_payload([rec], v, "https://t.example")[0]["learner_token"]
    t2 = lv.project_payload([rec], v, "https://t.example")[0]["learner_token"]
    assert t1 == t2, "same learner must project to the same token"


def test_projection_idempotent():
    v = _fresh_vault()
    rec = {"user_id": 555, "name": "Zed", "email": "z@e.com"}
    once = lv.project_payload([rec], v, "https://t.example")
    twice = lv.project_payload(once, v, "https://t.example")
    assert once == twice, "projecting a projected payload must be a no-op"


def test_non_learner_payload_untouched():
    v = _fresh_vault()
    payload = {"id": 4045370, "name": "Morrow Product Proof (temp)",
               "course_id": 89585, "published": False,
               "workflow_state": "unpublished"}
    out = lv.project_payload(payload, v, "https://t.example")
    assert out == payload, "non-learner payload must pass through unchanged"
    assert "learner_token" not in json.dumps(out)


def test_normalize_roster():
    recs = [
        {"id": 111, "user_id": 1, "type": "StudentEnrollment",
         "role": "Student", "enrollment_state": "active",
         "grades": {"current_score": 90},
         "user": {"id": 1, "name": "Ann", "email": "ann@e.com"}},
        {"id": 2, "name": "Ben", "email": "ben@e.com", "login_id": "ben2"},
        {"id": 4045370, "name": "Some Assignment"},  # not a learner
    ]
    obs = lv.normalize_roster(recs, "https://t.example")
    keys = {o["learner_key"] for o in obs}
    assert "1" in keys and "2" in keys, keys
    ann = [o for o in obs if o["learner_key"] == "1"][0]
    assert ann["pii"]["name"] == "Ann"
    assert ann["context"]["role"] == "Student"
    assert ann["context"]["grades"]["current_score"] == 90


def test_secret_file_permissions():
    v = _fresh_vault()
    v.register("https://t.example", "1", {"name": "X"})
    for name in (lv.SECRET_FILE, lv.MAP_FILE):
        path = os.path.join(v.dir, name)
        mode = stat.S_IMODE(os.stat(path).st_mode)
        assert mode == 0o600, "%s has mode %o, want 600" % (name, mode)
    dmode = stat.S_IMODE(os.stat(v.dir).st_mode)
    assert dmode == 0o700, "vault dir has mode %o, want 700" % dmode


def test_admission_allows_learner_ops_when_vault_ready():
    entry = {"name": "x",
             "request": {"url": "{canvas_base}/api/v1/courses/1/enrollments"}}
    policy = adm.load_policy()
    try:
        adm.check_learner_data(entry, policy, vault_ready=False)
    except adm.LearnerDataGated:
        pass
    else:
        raise AssertionError("expected LearnerDataGated with vault not ready")
    adm.check_learner_data(entry, policy, vault_ready=True)  # must not raise
    assert adm.touches_learner_data(entry) is True
    assert adm.touches_learner_data(
        {"name": "y", "request": {"url": "{canvas_base}/api/v1/courses/1"}}) is False
    assert adm.touches_learner_data(
        {"name": "z", "request": {"url": "{canvas_base}/api/v1/users/self"}}) is False


def test_purge_tenant_drops_only_that_tenant():
    v = _fresh_vault()
    ta = v.register("https://a.example", "1", {"name": "Amy A"})
    tb = v.register("https://b.example", "2", {"name": "Bo B"})
    n = v.purge_tenant("https://a.example")
    assert n == 1, "expected 1 purged, got %d" % n
    assert v.lookup(ta) is None, "purged tenant token still resolves"
    rec = v.lookup(tb)
    assert rec is not None and rec["pii"]["name"] == "Bo B", \
        "other tenant must be untouched"
    # Purge persists: a new handle on the same dir sees the same state.
    v2 = lv.LearnerVault(vault_dir=v.dir)
    assert v2.lookup(ta) is None and v2.lookup(tb) is not None
    assert v2.purge_tenant("https://a.example") == 0, "re-purge must be 0"


def test_purge_tenant_clears_browser_transient_state():
    # W4-P0-4/W4-P0-5: pending envelopes (raw payloads) and briefs are
    # purged on EVERY purge/wipe path, including orphan briefs.
    # W5-P1-2: in-flight envelopes (younger than the TTL) are never
    # silently destroyed, so the planted envelope is aged past the TTL.
    import time as _t
    import datetime as _dt
    def plant():
        env = os.path.join(_bb.PENDING_DIR, "op-x.json")
        brf = os.path.join(_bb.BRIEF_DIR, "orphan-x-request.txt")
        # W6-P2-4: staleness uses the envelope's internal created_at,
        # never the file mtime, so the planted envelope carries a
        # realistic created_at aged past the TTL.
        _old_iso = (_dt.datetime.now(_dt.timezone.utc)
                    - _dt.timedelta(days=8)).isoformat()
        with open(env, "w", encoding="utf-8") as fh:
            fh.write('{"op_id": "op-x", "created_at": "%s", '
                     '"brief_dir": "%s"}' % (_old_iso, _bb.BRIEF_DIR))
        with open(brf, "w", encoding="utf-8") as fh:
            fh.write("brief: comment on Zeldana Fakeington's submission")
        return env, brf
    env, brf = plant()
    v = _fresh_vault()
    v.purge_tenant("https://a.example")
    assert not os.path.exists(env) and not os.path.exists(brf), \
        "purge_tenant must clear envelopes and orphan briefs"
    env, brf = plant()
    v.wipe()
    assert not os.path.exists(env) and not os.path.exists(brf), \
        "wipe must clear envelopes and orphan briefs"


def test_wipe_removes_map_secret_and_dir():
    v = _fresh_vault()
    t = v.register("https://school.example.edu", "9", {"name": "Gone"})
    assert v.lookup(t) is not None
    v.wipe()
    assert not os.path.exists(v.dir), "vault dir must be gone after wipe"
    assert v.lookup(t) is None
    # A fresh vault gets a fresh secret: the old token can never resolve.
    v2 = lv.LearnerVault(vault_dir=v.dir)
    assert v2.lookup(t) is None
    assert v2.token_for("https://school.example.edu", "9") != t, \
        "fresh secret must not reproduce pre-wipe tokens"


def test_vault_available_tightens_loose_dir():
    tmp = _mk_vault_scratch("vault-loose-")
    loose = os.path.join(tmp, "vault")
    os.makedirs(loose, mode=0o755)
    os.chmod(loose, 0o755)
    old = lv.VAULT_DIR
    lv.VAULT_DIR = loose
    try:
        assert lv.vault_available(), "vault should be available"
        assert stat.S_IMODE(os.stat(loose).st_mode) == 0o700, \
            "pre-existing loose vault dir must be tightened to 0700"
    finally:
        lv.VAULT_DIR = old


# ------------------------------------------------- W6-P1-7 secret loss

def test_w6p17_secret_loss_fails_closed():
    v = _fresh_vault()
    tok = v.register("t1", "100", {"name": "No Mint"})
    assert v.lookup(tok) is not None
    # Lose the secret with the map still present: must NOT silently
    # re-mint (that would sever every token<->identity link).
    os.remove(os.path.join(v.dir, "secret.key"))
    try:
        lv.LearnerVault(vault_dir=v.dir)
    except lv.VaultUnavailable:
        pass
    else:
        raise AssertionError("secret loss with map present must fail "
                             "closed, not re-mint")
    # Fresh dir still mints (normal first-run path).
    v2 = _fresh_vault()
    assert v2.token_for("t1", "100").startswith("lrn_")


def test_w6p17_malformed_secret_fails_closed():
    v = _fresh_vault()
    v.register("t1", "101", {"name": "Bad Secret"})
    with open(os.path.join(v.dir, "secret.key"), "w") as fh:
        fh.write("truncated")
    try:
        lv.LearnerVault(vault_dir=v.dir)
    except lv.VaultUnavailable:
        pass
    else:
        raise AssertionError("malformed secret.key must fail closed")


# ------------------------------------------------- W6-P1-8 map seal

def test_w6p18_map_sealed_and_verified():
    v = _fresh_vault()
    tok = v.register("t1", "200", {"name": "Sealed Sam"})
    seal = os.path.join(v.dir, "map.jsonl.seal")
    assert os.path.exists(seal), "map seal sidecar must exist"
    assert open(seal).read().startswith("hmac-sha256:")
    # Reopen verifies the seal; tampering is detected.
    v2 = lv.LearnerVault(vault_dir=v.dir)
    assert v2.lookup(tok) is not None
    with open(os.path.join(v.dir, "map.jsonl"), "a") as fh:
        fh.write('{"token": "lrn_forged", "tenant": "t1"}\n')
    v3 = lv.LearnerVault(vault_dir=v.dir)
    # .prev recovery restores the last-known-good map (the forged
    # record is gone; the genuine one survives).
    assert v3.lookup(tok) is not None, "genuine record must survive"
    assert v3.lookup("lrn_forged") is None, "forged record must not load"


def test_w6p18_torn_map_no_recovery_fails_closed():
    v = _fresh_vault()
    v.register("t1", "201", {"name": "Torn Tia"})
    # Destroy the map, its seal, and every recovery copy: fail closed.
    for name in ("map.jsonl.seal", "map.jsonl.prev",
                 "map.jsonl.prev.seal"):
        try:
            os.remove(os.path.join(v.dir, name))
        except OSError:
            pass
    with open(os.path.join(v.dir, "map.jsonl"), "w") as fh:
        fh.write('{"token": "lrn_x",\n')  # torn line
    try:
        lv.LearnerVault(vault_dir=v.dir)
    except lv.VaultUnavailable:
        pass
    else:
        raise AssertionError("torn map with no recovery must fail closed")


def test_w6p18_torn_map_recovers_from_prev():
    # W6-P1-8: a torn (unparseable) active map must fall through to
    # the verified .prev last-known-good copy, not raise a parse error
    # that strands the vault. The .prev must be sealed and valid.
    v = _fresh_vault()
    tok = v.register("t1", "202", {"name": "Resilient Rita"})
    assert v.lookup(tok) is not None
    # Tear the active map (unparseable JSON); the .prev stays sealed
    # and valid from the earlier persist.
    with open(os.path.join(v.dir, "map.jsonl"), "w") as fh:
        fh.write('{"token": "lrn_x",\n')  # torn line
    v2 = lv.LearnerVault(vault_dir=v.dir)
    assert v2.lookup(tok) is not None, \
        "torn active map must recover from verified .prev"
    assert v2.lookup(tok)["pii"]["name"] == "Resilient Rita"


def test_w6p18_legacy_map_needs_adopt_ceremony():
    # Simulate a pre-seal map: valid JSON lines, no seal, no .prev.
    tmp = _mk_vault_scratch("vault-legacy-")
    vdir = os.path.join(tmp, "vault")
    v = lv.LearnerVault(vault_dir=vdir)
    tok = v.register("t1", "300", {"name": "Legacy Leo"})
    for name in ("map.jsonl.seal", "map.jsonl.prev",
                 "map.jsonl.prev.seal"):
        try:
            os.remove(os.path.join(vdir, name))
        except OSError:
            pass
    try:
        lv.LearnerVault(vault_dir=vdir)
    except lv.VaultUnavailable as exc:
        assert "adopt-legacy" in str(exc), \
            "legacy failure must name the adopt ceremony"
    else:
        raise AssertionError("unsealed legacy map must fail closed")
    # The adopt-legacy ceremony seals it; afterwards it opens normally.
    import subprocess
    env = dict(os.environ)
    # adopt-legacy uses the module VAULT_DIR; point it at our scratch.
    code = ("import sys; sys.path.insert(0, %r);"
            "from privacy import learner_vault as lv;"
            "lv.VAULT_DIR = %r;"
            "sys.argv=['x','adopt-legacy'];"
            "sys.exit(lv._cli(['adopt-legacy']))" % (_REPO, vdir))
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True,
                          text=True, env=env)
    assert proc.returncode == 0, proc.stderr[-500:]
    v2 = lv.LearnerVault(vault_dir=vdir)
    assert v2.lookup(tok)["pii"]["name"] == "Legacy Leo"


def test_w6p18_rotation_seals_under_new_secret():
    v = _fresh_vault()
    old_tok = v.register("t1", "400", {"name": "Rotate Rita"})
    result = v.rotate_secret()
    assert result["rotated"] and result["records_rekeyed"] == 1
    # The re-keyed map verifies under the NEW secret on reopen.
    v2 = lv.LearnerVault(vault_dir=v.dir)
    new_tok = v2.token_for("t1", "400")
    assert new_tok != old_tok, "rotation must start a new token epoch"
    assert v2.lookup(new_tok)["pii"]["name"] == "Rotate Rita"
    assert v2.lookup(old_tok) is None


def test_w6p12_vault_key_rotation_retires_old():
    # W6-P1-2: the vault AES key rotates; the old key is retired (not
    # usable for new seals) and the vault stays readable.
    v = _fresh_vault()
    v.register("t1", "400", {"name": "Rekey Ron"})
    _old_secret_view = v._secret.view()
    _old_bytes = bytes(_old_secret_view)
    result = v.rotate_secret()
    assert result["rotated"] is True
    assert bytes(v._secret.view()) != _old_bytes, \
        "rotation must mint a fresh key"
    # The old buffer was zeroed on retirement.
    assert all(b == 0 for b in _old_secret_view), \
        "retired key buffer must be zeroed"
    # Vault still works under the new key.
    v2 = lv.LearnerVault(vault_dir=v.dir)
    assert v2.lookup(v2.token_for("t1", "400"))["pii"]["name"] == \
        "Rekey Ron"


def test_w6p27_vault_secret_zeroed_after_wipe():
    # W6-P2-7: wipe() zeroes the in-memory secret.
    v = _fresh_vault()
    v.register("t1", "400", {"name": "Wipe Wendy"})
    _view = v._secret.view()
    assert any(b != 0 for b in _view)
    v.wipe()
    assert all(b == 0 for b in _view), \
        "wipe must zero the in-memory secret"


def test_w6p27_vault_secret_zeroed_after_rotation():
    # W6-P2-7: the pre-rotation secret buffer is zeroed, not just
    # dropped (defense against memory disclosure).
    v = _fresh_vault()
    v.register("t1", "400", {"name": "Zero Zara"})
    _old_view = v._secret.view()
    _old_copy = bytes(_old_view)
    assert any(b != 0 for b in _old_copy)
    v.rotate_secret()
    assert all(b == 0 for b in _old_view), \
        "old secret buffer must be zeroed after rotation"


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
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
