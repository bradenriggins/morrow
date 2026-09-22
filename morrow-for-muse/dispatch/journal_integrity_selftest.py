#!/usr/bin/env python3
"""Selftest: journal tamper integrity (W4-P0-1, W4-P0-2, W4-P2-6).

Covers the per-record HMAC seal, the sealed sidecar index, the deletion
tripwires, claim-token hashing, and the journal-seal upgrade path:

  1. claim/journal_append seal records (rec_hmac) and the index
     (index_hmac, v2); the secret file is 0600.
  2. legitimate claim -> recheck -> release -> re-claim still works.
  3. in-place record edit -> JournalIntegrityError on read.
  4. raw appended (unsealed) record -> JournalIntegrityError.
  5. forged sidecar index -> JournalIntegrityError (never trusted).
  6. missing index alongside an existing journal -> JournalIntegrityError.
  7. deleted line with a valid index (shrinkage) -> JournalIntegrityError.
  8. no plaintext claim_token in the journal; release with the scraped
     hash is refused (DuplicateOpId); the raw in-memory token releases.
  9. legacy (pre-HMAC) journal fails closed; journal_seal adopts it
     (hashes plaintext tokens, seals records, rebuilds the index); a
     second seal refuses; the legacy holder's raw token still rechecks.
 10. journal_seal refuses to bless a record whose seal does NOT verify.
 11. whole-journal deletion with a surviving secret -> JournalIntegrityError
     (the deletion tripwire; a deleted journal must never read as empty).
 12. W4-P2-6: the advisory-lock threat model is documented on the lock
     itself (advisory = crash/race boundary among cooperating writers,
     never a security boundary; the tamper boundary is the per-record
     HMAC plus the sealed sidecar index, which tests 3-7 exercise as an
     unlocked writer).
"""
import json
import os
import shutil
import sys
import time
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "dispatch")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


# Test scratch lives under this file's directory (never /tmp).
_SELFTEST_WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              ".selftest-work")
_WORK = os.path.join(_SELFTEST_WORK, "journal-integrity")
if os.path.isdir(_WORK):
    shutil.rmtree(_WORK)
os.makedirs(os.path.join(_WORK, "journal"))

_saved_journal = ex.JOURNAL_PATH


def _use_tree(name):
    """Point the executor at a fresh scratch journal tree (test isolation)."""
    d = os.path.join(_WORK, name)
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(os.path.join(d, "journal"))
    ex.JOURNAL_PATH = os.path.join(d, "journal", "ops.jsonl")
    global _JDIR, _JPATH, _IPATH, _SPATH
    _JDIR = os.path.dirname(ex.JOURNAL_PATH)
    _JPATH = ex.JOURNAL_PATH
    _IPATH = os.path.join(_JDIR, "ops.idx.json")
    _SPATH = os.path.join(_JDIR, "ops.secret")


_use_tree("main")


def _lines():
    with open(_JPATH, "r", encoding="utf-8") as fh:
        return fh.readlines()


def _write_lines(lines):
    with open(_JPATH, "w", encoding="utf-8") as fh:
        fh.writelines(lines)
        fh.flush()
        os.fsync(fh.fileno())


def _raw_append(rec):
    with open(_JPATH, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def _recs():
    return [json.loads(l) for l in _lines() if l.strip()]


try:
    # 1. Sealing on write.
    op1 = str(uuid.uuid4())
    tok1 = ex.claim_op_id(op1, "write", "e1", "write", "d1")
    recs = _recs()
    check("claim record carries rec_hmac",
          len(recs) == 1 and recs[0].get("rec_hmac", "").startswith("hmac-sha256:"),
          repr(recs[0].keys()) if recs else "no records")
    check("claim record has no plaintext claim_token",
          "claim_token" not in recs[0], repr(sorted(recs[0].keys())))
    check("claim record stores claim_token_hash",
          recs[0].get("claim_token_hash", "").startswith("sha256:"))
    check("secret file minted 0600",
          os.path.exists(_SPATH) and (os.stat(_SPATH).st_mode & 0o777) == 0o600)
    idx = json.load(open(_IPATH, encoding="utf-8"))
    check("index is v2 with index_hmac",
          idx.get("version") == 2
          and idx.get("index_hmac", "").startswith("hmac-sha256:"),
          repr({k: idx.get(k) for k in ("version",)}))

    # 2. Legitimate lifecycle still works.
    ex.recheck_claim(op1, tok1)
    check("recheck with the real token passes", True)
    try:
        ex.recheck_claim(op1, "wrong-token")
        check("recheck with a wrong token is refused", False, "no exception")
    except ex.DuplicateOpId:
        check("recheck with a wrong token is refused", True)
    ex.release_op_id(op1, tok1, "selftest release")
    check("release with the real token works", True)
    tok1b = ex.claim_op_id(op1, "write", "e1", "write", "d1")
    check("op_id reusable after release", isinstance(tok1b, str))

    # 3. In-place edit -> JournalIntegrityError.
    lines = _lines()
    edited = []
    for l in lines:
        r = json.loads(l)
        if r.get("op_id") == op1 and r.get("wal") == "pending":
            r["entry_name"] = "forged_entry"
        edited.append(json.dumps(r, sort_keys=True) + "\n")
    _write_lines(edited)
    try:
        ex.used_op_ids()
        check("in-place record edit raises JournalIntegrityError", False,
              "no exception")
    except ex.JournalIntegrityError:
        check("in-place record edit raises JournalIntegrityError", True)
    except Exception as e:  # noqa: BLE001
        check("in-place record edit raises JournalIntegrityError", False,
              "wrong exception: %r" % e)

    # 4. Raw appended (unsealed) record -> JournalIntegrityError.
    _write_lines(lines)  # restore the sealed journal
    _raw_append({"op_id": str(uuid.uuid4()), "wal": "complete",
                 "outcome": "success"})
    try:
        ex.find_journal_op(op1)
        check("unsealed appended record raises JournalIntegrityError", False,
              "no exception")
    except ex.JournalIntegrityError:
        check("unsealed appended record raises JournalIntegrityError", True)
    except Exception as e:  # noqa: BLE001
        check("unsealed appended record raises JournalIntegrityError", False,
              "wrong exception: %r" % e)

    # 5. Forged index -> JournalIntegrityError (never trusted).
    _write_lines(lines)  # restore: sealed journal, sealed index
    with open(_IPATH, "r", encoding="utf-8") as fh:
        fidx = json.load(fh)
    fidx["op_ids"] = []
    fidx["journal_size"] = os.path.getsize(_JPATH)
    with open(_IPATH, "w", encoding="utf-8") as fh:
        json.dump(fidx, fh)
    try:
        ex.used_op_ids()
        check("forged index raises JournalIntegrityError", False,
              "no exception")
    except ex.JournalIntegrityError:
        check("forged index raises JournalIntegrityError", True)
    except Exception as e:  # noqa: BLE001
        check("forged index raises JournalIntegrityError", False,
              "wrong exception: %r" % e)

    # 6. Missing index + existing journal -> JournalIntegrityError.
    os.remove(_IPATH)
    try:
        ex.used_op_ids()
        check("missing index with existing journal raises JournalIntegrityError",
              False, "no exception")
    except ex.JournalIntegrityError:
        check("missing index with existing journal raises JournalIntegrityError",
              True)
    except Exception as e:  # noqa: BLE001
        check("missing index with existing journal raises JournalIntegrityError",
              False, "wrong exception: %r" % e)

    # 7. Deleted line under a valid index (shrinkage) -> JournalIntegrityError.
    # Rebuild a clean sealed state first: journal-seal rebuilds the missing
    # index once the sealed journal verifies.
    reseal = ex.journal_seal()
    check("journal_seal rebuilds a missing index over a sealed journal",
          reseal.get("sealed") is True, repr(reseal))
    op7 = str(uuid.uuid4())
    ex.claim_op_id(op7, "write", "e7", "write", "d7")
    shrunken = [l for l in _lines() if json.loads(l).get("op_id") != op7]
    _write_lines(shrunken)
    try:
        ex.claim_op_id(op7, "write", "e7", "write", "d7")
        check("deleted line under sealed index raises JournalIntegrityError",
              False, "re-claim succeeded")
    except ex.JournalIntegrityError:
        check("deleted line under sealed index raises JournalIntegrityError",
              True)
    except Exception as e:  # noqa: BLE001
        check("deleted line under sealed index raises JournalIntegrityError",
              False, "wrong exception: %r" % e)

    # 8. Token theft from the journal is useless.
    # Test 7 left the "main" tree fail-closed (deleted line), so start a
    # fresh tree for the remaining tests.
    _use_tree("main8")
    op8 = str(uuid.uuid4())
    tok8 = ex.claim_op_id(op8, "write", "e8", "write", "d8")
    scraped = None
    for r in _recs():
        if r.get("op_id") == op8 and r.get("wal") == "pending":
            scraped = r.get("claim_token_hash")
            check("journal carries no plaintext claim_token",
                  "claim_token" not in r, repr(sorted(r.keys())))
    try:
        ex.release_op_id(op8, scraped, "attacker")
        check("release with scraped hash is refused", False, "no exception")
    except ex.DuplicateOpId:
        check("release with scraped hash is refused", True)
    except Exception as e:  # noqa: BLE001
        check("release with scraped hash is refused", False,
              "wrong exception: %r" % e)
    ex.release_op_id(op8, tok8, "holder")
    check("release with the real token works", True)

    # 9. Legacy journal: fail closed, then journal-seal adopts it.
    legacy_dir = os.path.join(_WORK, "legacy")
    os.makedirs(os.path.join(legacy_dir, "journal"))
    ex.JOURNAL_PATH = os.path.join(legacy_dir, "journal", "ops.jsonl")
    lop = str(uuid.uuid4())
    legacy_rec = {"op_id": lop, "kind": "write", "entry_name": "legacy_e",
                  "effect": "write", "params_digest": "d",
                  "wal": "pending", "claim_token": "tok-legacy-plain",
                  "ts": ex.utc_now_iso()}
    with open(ex.JOURNAL_PATH, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(legacy_rec, sort_keys=True) + "\n")
    try:
        ex.used_op_ids()
        check("legacy journal fails closed", False, "no exception")
    except ex.JournalIntegrityError as e:
        check("legacy journal fails closed", "journal-seal" in str(e),
              str(e)[:100])
    except Exception as e:  # noqa: BLE001
        check("legacy journal fails closed", False, "wrong exception: %r" % e)
    seal = ex.journal_seal()
    check("journal_seal adopts the legacy journal",
          seal.get("sealed") is True and seal.get("tokens_hashed") == 1,
          repr(seal))
    sealed_recs = [json.loads(l) for l in open(ex.JOURNAL_PATH, encoding="utf-8")
                   if l.strip()]
    check("sealed journal has no plaintext claim_token",
          all("claim_token" not in r for r in sealed_recs))
    check("sealed records carry rec_hmac",
          all(r.get("rec_hmac", "").startswith("hmac-sha256:")
              for r in sealed_recs))
    check("used_op_ids works after seal", lop in ex.used_op_ids())
    ex.recheck_claim(lop, "tok-legacy-plain")
    check("legacy holder's raw token still rechecks after seal", True)
    seal2 = ex.journal_seal()
    check("second journal_seal refuses (already sealed)",
          seal2.get("sealed") is False, repr(seal2))

    # 10. journal_seal refuses to bless a tampered (bad-seal) record.
    tamper_dir = os.path.join(_WORK, "tampered")
    os.makedirs(os.path.join(tamper_dir, "journal"))
    ex.JOURNAL_PATH = os.path.join(tamper_dir, "journal", "ops.jsonl")
    top = str(uuid.uuid4())
    ex.claim_op_id(top, "write", "et", "write", "dt")
    bad = {"op_id": str(uuid.uuid4()), "wal": "complete", "outcome": "success",
           "rec_hmac": "hmac-sha256:" + "0" * 64}
    with open(ex.JOURNAL_PATH, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(bad, sort_keys=True) + "\n")
    try:
        ex.journal_seal()
        check("journal_seal refuses a bad-seal record", False, "no exception")
    except ex.JournalIntegrityError:
        check("journal_seal refuses a bad-seal record", True)
    except Exception as e:  # noqa: BLE001
        check("journal_seal refuses a bad-seal record", False,
              "wrong exception: %r" % e)

    # 11. Whole-journal deletion with a surviving secret -> JournalIntegrityError.
    # A deleted journal must never read as "no ops yet" (which would make
    # every op_id re-claimable): the secret proves a journal existed.
    _use_tree("deleted-journal")
    dop = str(uuid.uuid4())
    ex.claim_op_id(dop, "write", "edel", "write", "ddel")
    check("secret minted alongside the journal",
          os.path.exists(_SPATH), _SPATH)
    os.remove(_JPATH)
    try:
        ex.used_op_ids()
        check("deleted journal with surviving secret raises "
              "JournalIntegrityError", False, "no exception")
    except ex.JournalIntegrityError as e:
        check("deleted journal with surviving secret raises "
              "JournalIntegrityError", "was deleted" in str(e),
              str(e)[:100])
    except Exception as e:  # noqa: BLE001
        check("deleted journal with surviving secret raises "
              "JournalIntegrityError", False, "wrong exception: %r" % e)
    # The op_id must not be re-claimable after the deletion either.
    try:
        ex.claim_op_id(dop, "write", "edel", "write", "ddel")
        check("deleted journal: op_id not re-claimable", False,
              "re-claim succeeded")
    except ex.JournalIntegrityError:
        check("deleted journal: op_id not re-claimable", True)
    except Exception as e:  # noqa: BLE001
        check("deleted journal: op_id not re-claimable", False,
              "wrong exception: %r" % e)

    # 13. W5-P2-5: size-drift rebuild behavior.
    # Growth drift must rescan ONLY the mutable live journal (archives
    # are immutable and carried from the sealed index), and the
    # repaired index must restore the fast path. Shrinkage still fails
    # closed (covered in test 7; repeated here with an archive present).
    _use_tree("drift")
    d1 = str(uuid.uuid4())
    ex.claim_op_id(d1, "write", "ed1", "write", "dd1")
    # Force a rotation to create one archive.
    saved_rotate = ex.JOURNAL_ROTATE_BYTES
    ex.JOURNAL_ROTATE_BYTES = 1
    try:
        d2 = str(uuid.uuid4())
        ex.claim_op_id(d2, "write", "ed2", "write", "dd2")
    finally:
        ex.JOURNAL_ROTATE_BYTES = saved_rotate
    archive_dir = os.path.join(_JDIR, "archive")
    check("W5-P2-5: rotation created exactly one archive",
          len(os.listdir(archive_dir)) == 1,
          repr(os.listdir(archive_dir)))

    # 13a. Simulate a crash between the journal append and the index
    # write: the sealed record lands, the sidecar keeps the old size.
    real_note = ex._index_note_append_locked
    ex._index_note_append_locked = lambda *a, **k: None  # noqa: E731
    try:
        d3 = str(uuid.uuid4())
        ex.claim_op_id(d3, "write", "ed3", "write", "dd3")
    finally:
        ex._index_note_append_locked = real_note
    idx_before = json.load(open(_IPATH, encoding="utf-8"))
    check("W5-P2-5: index is stale after the simulated crash",
          idx_before.get("journal_size") != os.path.getsize(_JPATH))

    # 13b. Growth-drift rebuild rescans only the live journal.
    # (The legacy global journal is a separate read-only idempotency
    # backstop scanned by used_op_ids itself, not by the rebuild.)
    scanned = []
    real_scan = ex._scan_journal_file

    def _recording_scan(path, verify=True):
        scanned.append(os.path.abspath(path))
        return real_scan(path, verify=verify)

    ex._scan_journal_file = _recording_scan
    try:
        ids = ex.used_op_ids()
    finally:
        ex._scan_journal_file = real_scan
    check("W5-P2-5: growth drift rebuild succeeds",
          {d1, d2, d3} <= ids, "%d ids" % len(ids))
    tree_scans = [p for p in scanned
                  if os.path.abspath(_JDIR) in p]
    check("W5-P2-5: growth drift rescans only the live journal",
          tree_scans == [os.path.abspath(_JPATH)], repr(tree_scans))
    check("W5-P2-5: archived op_ids survive the growth rebuild",
          d1 in ids and d2 in ids)

    # 13c. The repaired index restores the fast path (no rescan).
    idx_after = json.load(open(_IPATH, encoding="utf-8"))
    check("W5-P2-5: repaired index records the live journal size",
          idx_after.get("journal_size") == os.path.getsize(_JPATH))
    check("W5-P2-5: repaired index still lists the archive",
          len(idx_after.get("archives") or []) == 1)
    scanned2 = []
    ex._scan_journal_file = _recording_scan2 = (
        lambda path, verify=True: (scanned2.append(path),
                                   real_scan(path, verify))[1])
    try:
        ids2 = ex.used_op_ids()
    finally:
        ex._scan_journal_file = real_scan
    tree_scans2 = [p for p in scanned2
                   if os.path.abspath(_JDIR) in p]
    check("W5-P2-5: post-repair call takes the fast path (no tree scan)",
          tree_scans2 == [], repr(tree_scans2))
    check("W5-P2-5: fast-path ids match", ids2 == ids)

    # 13d. Shrinkage with an archive present still fails closed.
    # (The repaired index places d3 in the live journal: d1 and d2
    # rotated into the archive. Deleting d3's lines must trip.)
    shrunken = [l for l in _lines()
                if json.loads(l).get("op_id") != d3]
    _write_lines(shrunken)
    try:
        ex.used_op_ids()
        check("W5-P2-5: shrinkage with archive fails closed", False,
              "no exception")
    except ex.JournalIntegrityError:
        check("W5-P2-5: shrinkage with archive fails closed", True)
    except Exception as e:  # noqa: BLE001
        check("W5-P2-5: shrinkage with archive fails closed", False,
              "wrong exception: %r" % e)

    # 12. W4-P2-6: the advisory-lock threat model is documented.
    # The flock is a crash/race boundary among cooperating writers, never
    # a security boundary; the tamper boundary is the per-record HMAC plus
    # the sealed sidecar index. Tests 3-7 above exercise exactly the
    # unlocked-writer case (file manipulation with no lock held) and fail
    # closed; this locks the documented threat model in place.
    _lock_doc = getattr(ex._journal_locked, "__doc__", "") or ""
    check("advisory lock documented as advisory (W4-P2-6)",
          "ADVISORY" in _lock_doc, "docstring names the advisory nature")
    check("lock doc names the crash/race boundary",
          "cooperating writers" in _lock_doc,
          "docstring scopes the lock to cooperating writers")
    check("lock doc names the real tamper boundary",
          "HMAC" in _lock_doc and "not a security boundary" in _lock_doc,
          "docstring points at the HMAC seal, not the lock")

    # 14. W5-P1-1: archive pruning retires op_ids permanently.
    _use_tree("prune")
    # Create archives by forcing rotation.
    saved_rotate2 = ex.JOURNAL_ROTATE_BYTES
    ex.JOURNAL_ROTATE_BYTES = 1
    prune_ids = []
    try:
        for i in range(3):
            oid = str(uuid.uuid4())
            prune_ids.append(oid)
            ex.claim_op_id(oid, "write", "e%d" % i, "write", "d%d" % i)
    finally:
        ex.JOURNAL_ROTATE_BYTES = saved_rotate2
    archive_dir = os.path.join(_JDIR, "archive")
    n_archives = len(os.listdir(archive_dir))
    check("W5-P1-1: rotations created archives",
          n_archives >= 2, "got %d" % n_archives)
    # Force pruning by count: keep only 1.
    saved_max_count = ex.JOURNAL_ARCHIVE_MAX_COUNT
    ex.JOURNAL_ARCHIVE_MAX_COUNT = 1
    try:
        oid = str(uuid.uuid4())
        ex.claim_op_id(oid, "write", "eX", "write", "dX")
    finally:
        ex.JOURNAL_ARCHIVE_MAX_COUNT = saved_max_count
    n_after = len(os.listdir(archive_dir))
    check("W5-P1-1: archive count pruning enforced",
          n_after <= 1, "got %d" % n_after)
    # Pruned op_ids are in the retired set (permanent). The surviving
    # archive's op_id stays live (not retired): with 3 archives and
    # keep=1, exactly 2 are pruned.
    retired = ex._retired_op_ids()
    n_retired = sum(1 for pid in prune_ids if pid in retired)
    check("W5-P1-1: pruned op_ids retired",
          n_retired == 2, "%d/2 retired" % n_retired)
    # A retired op_id can never be re-claimed (duplicate protection
    # survives pruning).
    try:
        ex.claim_op_id(prune_ids[0], "write", "eY", "write", "dY")
        check("W5-P1-1: retired op_id not re-claimable", False,
              "claim succeeded")
    except ex.DuplicateOpId:
        check("W5-P1-1: retired op_id not re-claimable", True)
    except Exception as e:
        check("W5-P1-1: retired op_id not re-claimable", False,
              "wrong exception: %r" % e)
    # The retired set has no cap: it is permanent by design. (Only
    # the pruned op_ids are expected in retired, not the survivor.)
    many = ["retired-%d" % i for i in range(100)]
    ex._retired_append(many)
    retired2 = ex._retired_op_ids()
    check("W5-P1-1: retired set is permanent (no cap)",
          all(pid in retired2 for pid in many)
          and sum(1 for pid in prune_ids if pid in retired2) == 2)

    # 15. W5-P1-1: age-based pruning.
    _use_tree("prune-age")
    ex.JOURNAL_ROTATE_BYTES = 1
    try:
        oid = str(uuid.uuid4())
        ex.claim_op_id(oid, "write", "eA", "write", "dA")
        oid2 = str(uuid.uuid4())
        ex.claim_op_id(oid2, "write", "eB", "write", "dB")
    finally:
        ex.JOURNAL_ROTATE_BYTES = saved_rotate2
    archive_dir = os.path.join(_JDIR, "archive")
    names = os.listdir(archive_dir)
    check("W5-P1-1: age test has an archive", len(names) >= 1)
    saved_max_age = ex.JOURNAL_ARCHIVE_MAX_AGE_DAYS
    ex.JOURNAL_ARCHIVE_MAX_AGE_DAYS = 0
    try:
        old = time.time() - 86400
        for n in names:
            p = os.path.join(archive_dir, n)
            os.utime(p, (old, old))
        oid3 = str(uuid.uuid4())
        ex.claim_op_id(oid3, "write", "eC", "write", "dC")
    finally:
        ex.JOURNAL_ARCHIVE_MAX_AGE_DAYS = saved_max_age
    check("W5-P1-1: aged-out archive pruned",
          len(os.listdir(archive_dir)) == 0,
          repr(os.listdir(archive_dir)))
    check("W5-P1-1: aged-out op_id retired",
          oid in ex._retired_op_ids() or oid2 in ex._retired_op_ids())
finally:
    ex.JOURNAL_PATH = _saved_journal

for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("all journal integrity selftests passed")
