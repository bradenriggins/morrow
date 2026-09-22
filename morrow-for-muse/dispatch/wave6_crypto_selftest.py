#!/usr/bin/env python3
"""Wave 6 crypto/auth regression selftest.

Covers the Wave 6 crypto findings that live in dispatch/executor.py and
config/secretbuf.py (the helper, admission, egress, and vault findings
are covered in their own suites):

  W6-P2-1: claim-token comparison is constant-time (hmac.compare_digest
    at all three sites, via _claim_token_matches).
  W6-P2-5: claim tokens expire (browser-lane and raw-lane TTLs); the
    sweeper releases expired claims.
  W6-P1-2: the journal HMAC secret rotates (keyring with active/retired
    keys, retired_at timestamps, reseal verifies under the keyring).
  W6-P2-7: SecretBytes buffers are zeroed after close (defense in depth
    against memory disclosure).

Runs on synthetic fixtures in a scratch tree. No real credentials.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import hmac as _hmac_module
import os
import sys
import time
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "dispatch"),
           os.path.join(REPO, "config")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

WORK = os.path.join(REPO, "dispatch", ".selftest-work", "wave6-crypto")
if os.environ.get("MORROW_SELFTEST_SCRATCH"):
    WORK = os.path.join(os.environ["MORROW_SELFTEST_SCRATCH"],
                        "wave6-crypto")
os.environ["MORROW_HOME"] = WORK

from dispatch import executor as ex  # noqa: E402
from config.securebuf import SecretBytes, secret_bytes  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


def _use_tree(name):
    d = os.path.join(WORK, name)
    os.makedirs(os.path.join(d, "journal"), exist_ok=True)
    ex.JOURNAL_PATH = os.path.join(d, "journal", "ops.jsonl")
    return d


# All W6 crypto tests share one tree: the journal secret is bound to the
# tree, and switching trees mid-run trips the missing-journal fail-closed.
_use_tree("main")


# ----------------------------------------------------------------------
# W6-P2-1: constant-time claim-token comparison.
# ----------------------------------------------------------------------
# 1a. _claim_token_matches must delegate to hmac.compare_digest (not
#     a short-circuiting ==). Prove it by observing the call.
_calls = []
_real_cd = _hmac_module.compare_digest


def _recording_cd(a, b):
    _calls.append((a, b))
    return _real_cd(a, b)


_hmac_module.compare_digest = _recording_cd
try:
    tok = uuid.uuid4().hex
    stored = ex._claim_token_hash(tok)
    assert ex._claim_token_matches(stored, tok) is True
    assert ex._claim_token_matches(stored, "wrong-token") is False
finally:
    _hmac_module.compare_digest = _real_cd

check("W6-P2-1: _claim_token_matches calls hmac.compare_digest",
      len(_calls) == 2, "calls=%d" % len(_calls))
check("W6-P2-1: correct token matches", True)
check("W6-P2-1: wrong token does not match", True)

# 1b. Non-string stored hashes fail closed (no exception, no match).
check("W6-P2-1: non-string stored hash fails closed",
      ex._claim_token_matches(None, tok) is False
      and ex._claim_token_matches(12345, tok) is False)

# 1c. All three claim-token sites route through _claim_token_matches.
#     (Source-level guard: a future edit must not reintroduce a bare
#     != on the token hash.)
_src = open(os.path.join(REPO, "dispatch", "executor.py"),
            encoding="utf-8").read()
_bare = [ln for ln in _src.splitlines()
         if "claim_token_hash" in ln and "!=" in ln
         and "_claim_token_matches" not in ln
         and "is not" not in ln]
check("W6-P2-1: no bare != on claim_token_hash remains",
      not _bare, "; ".join(_bare[:3]))


# ----------------------------------------------------------------------
# W6-P2-5: claim tokens expire.
# ----------------------------------------------------------------------
# 5a. A fresh claim is not expired; the TTLs are 7d (browser-lane
#     "pending") and 24h (raw-lane "claimed").
op1 = str(uuid.uuid4())
tok1 = ex.claim_op_id(op1, "dispatch", "test.op", "write", "d")
pending = ex.journal_pending_ops()
rec1 = [p for p in pending if p["op_id"] == op1]
check("W6-P2-5: fresh claim appears in pending ops", len(rec1) == 1)
check("W6-P2-5: fresh claim is not expired",
      bool(rec1) and ex._claim_expired(rec1[0]) is False)
check("W6-P2-5: browser-lane TTL is 7 days",
      ex.CLAIM_TTL_SECONDS.get("pending") == 7 * 86400)
check("W6-P2-5: raw-lane TTL is 24 hours",
      ex.CLAIM_TTL_SECONDS.get("claimed") == 24 * 3600)

# 5b. A claim older than its TTL counts as expired (fail closed on
#     unparseable ts, too).
from datetime import datetime, timezone, timedelta  # noqa: E402
_old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
check("W6-P2-5: 8-day-old pending claim is expired",
      ex._claim_expired({"wal": "pending", "ts": _old}) is True)
check("W6-P2-5: unparseable ts fails closed as expired",
      ex._claim_expired({"wal": "pending", "ts": "not-a-time"}) is True)
check("W6-P2-5: missing ts fails closed as expired",
      ex._claim_expired({"wal": "pending"}) is True)


# ----------------------------------------------------------------------
# W6-P1-2: journal HMAC secret rotation.
# ----------------------------------------------------------------------
# 2a. Rotation mints a new active key; the old key is retired (not
#     deleted) with a retired_at timestamp.
ring_before = ex._read_secret_keyring()
kid_before = ring_before["active"] if ring_before else None
kid_after = ex.rotate_journal_secret()
ring = ex._read_secret_keyring()
check("W6-P1-2: rotation changes the active key id",
      kid_after != kid_before, "%s -> %s" % (kid_before, kid_after))
check("W6-P1-2: retired key is retained with retired_at",
      kid_before in ring["keys"]
      and kid_before in ring.get("retired_at", {}),
      repr(ring.get("retired_at")))

# 2b. Records sealed before rotation still verify (keyring, not just
#     the active key).
op3 = str(uuid.uuid4())
ex.claim_op_id(op3, "dispatch", "test.op", "write", "d")
ex.rotate_journal_secret()
try:
    ex._scan_journal_file(ex.JOURNAL_PATH, verify=True)
    _verify_ok = True
    _verify_err = ""
except Exception as exc:  # noqa: BLE001
    _verify_ok = False
    _verify_err = str(exc)[:120]
check("W6-P2-5/W6-P1-2: pre-rotation records verify after rotation",
      _verify_ok, _verify_err)


# ----------------------------------------------------------------------
# W6-P2-2: secret files are created 0600 atomically (no transient
# 0644 window from open-then-chmod).
# ----------------------------------------------------------------------
import stat as _stat  # noqa: E402

# 2c. browser_backend._write_secret_file creates 0600 at open.
_bb_path = os.path.join(WORK, "w6p22-secret.txt")
_bb_mod = __import__("transport.browser_backend", fromlist=["_write_secret_file"])
# Import via path (transport is not a package import here).
import importlib.util as _ilu2  # noqa: E402
_spec2 = _ilu2.spec_from_file_location(
    "bb_w6p22", os.path.join(REPO, "transport", "browser_backend.py"))
# Already imported as transport.browser_backend above? Use sys.modules.
import sys as _sys2  # noqa: E402
_bb = _sys2.modules.get("transport.browser_backend")
if _bb is None:
    _sys2.path.insert(0, os.path.join(REPO, "transport"))
    import browser_backend as _bb  # noqa: E402
_bb._write_secret_file(_bb_path, "secret-bytes")
_mode = _stat.S_IMODE(os.stat(_bb_path).st_mode)
check("W6-P2-2: _write_secret_file creates 0600",
      _mode == 0o600, oct(_mode))
os.remove(_bb_path)

# 2d. The staging uses O_CREAT|O_EXCL with explicit 0600 (source-level
#     guard: a future edit must not reintroduce open-then-chmod).
_bb_src = open(os.path.join(REPO, "transport", "browser_backend.py"),
               encoding="utf-8").read()
check("W6-P2-2: staging uses os.open with 0o600",
      "os.open(tmp_path, flags, 0o600)" in _bb_src)
check("W6-P2-2: no open-then-chmod in _write_secret_file",
      "os.chmod" not in _bb_src.split("def _write_secret_file")[1].split(
          "\ndef ")[0])

# 2e. Executor and admission use the same atomic pattern (source-level
#     guard against open-then-chmod regressions).
_ex_src = open(os.path.join(REPO, "dispatch", "executor.py"),
               encoding="utf-8").read()
check("W6-P2-2: executor _open_secret_tmp uses os.open 0600",
      "def _open_secret_tmp" in _ex_src
      and "os.open" in _ex_src.split("def _open_secret_tmp")[1].split(
          "\ndef ")[0]
      and "0o600" in _ex_src.split("def _open_secret_tmp")[1].split(
          "\ndef ")[0])
_ad_src = open(os.path.join(REPO, "dispatch", "admission.py"),
               encoding="utf-8").read()
# Admission must use _open_secret_tmp (atomic 0600) for secret files;
# no open-then-chmod on file content (directory chmods are fine).
_ad_file_chmods = [
    ln for ln in _ad_src.splitlines()
    if "os.chmod" in ln and "DIR" not in ln]
check("W6-P2-2: admission has no open-then-chmod on files",
      not _ad_file_chmods, "; ".join(_ad_file_chmods[:2]))
check("W6-P2-2: admission uses _open_secret_tmp",
      "_open_secret_tmp" in _ad_src)


# ----------------------------------------------------------------------
# W6-P2-7: SecretBytes zeroing.
# ----------------------------------------------------------------------

# 7a. Zeroing a buffer wipes its bytes.
sb = secret_bytes(b"sensitive-data-123")
_buf_view = sb.view()
assert _buf_view[:] == b"sensitive-data-123"
sb.zero()
check("W6-P2-7: zeroed SecretBytes reads back as zeroes",
      all(b == 0 for b in _buf_view),
      repr(bytes(_buf_view)[:8]))

# 7b. Context-manager exit zeroes.
with secret_bytes(b"ctx-secret") as ctx:
    _ctx_view = ctx.view()
    assert _ctx_view[:] == b"ctx-secret"
check("W6-P2-7: context exit zeroes the buffer",
      all(b == 0 for b in _ctx_view))

# 7c. Double zero is safe (idempotent).
sb2 = secret_bytes(b"abc")
sb2.zero()
try:
    sb2.zero()
    _dbl_ok = True
except Exception:  # noqa: BLE001
    _dbl_ok = False
check("W6-P2-7: double zero is safe", _dbl_ok)

# 7d. zeroed reports the state.
sb3 = secret_bytes(b"xyz")
check("W6-P2-7: zeroed is False before zero",
      sb3.zeroed is False)
sb3.zero()
check("W6-P2-7: zeroed is True after zero",
      sb3.zeroed is True)


print()
for n in PASS:
    print("PASS " + n)
for n in FAIL:
    print("FAIL " + n)
print()
if FAIL:
    print("FAILED: %d (%s)" % (len(FAIL), "; ".join(FAIL[:5])))
    sys.exit(1)
print("wave6 crypto selftest: all %d passed" % len(PASS))
