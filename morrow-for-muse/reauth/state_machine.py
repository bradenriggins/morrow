#!/usr/bin/env python3
"""Re-auth state machine for the Lane 2 (session, no-PAT) Canvas connector.

States: healthy -> expired -> reauth_pending -> healthy.

Expiry detection uses the two signals live-observed on the tenant on
2026-09-20:
  - JSON API: 401 with body {"status":"unauthenticated", ...}
  - Browser-format flows: 302 to /login

On detection the machine:
  1. Writes the write-halt lock (<morrow-home>/write_halt). The dispatch
     executor MUST call check_write_allowed() before dispatching any write.
  2. Quarantines in-flight ops to <morrow-home>/quarantine.jsonl
     (append-only; entries are NEVER retried blind against a dead session).
  3. Writes a plain-language notification to <morrow-home>/notify.txt.
  4. Production recovery (the rig-only guided re-sign-in below is NOT
     wired into production): the executor refuses every write while the
     halt is present; the educator re-signs in through the login helper
     (the helper's own Chromium tab, no credentials touch the agent);
     quarantined ops move to awaiting_approval ONLY after the session is
     verified live AND the principal is pinned to the stored one; each
     op then needs the educator's explicit per-op approval
     (approve_op / the `approve` CLI) before it may be re-dispatched;
     ops never approved stay quarantined forever and are never retried
     blind. Rule: resume, re-approve, or discard, per op, by the
     educator's explicit word; nothing auto-resumes.
  5. Guided re-sign-in (RIG/DRILL ONLY) = re-run capture.py: the
     educator signs in through the login helper page; the agent never
     sees a password. capture.py reaches the helper's browser through
     its token-authenticated /cdp/* proxy (W4-P0-3: no TCP CDP).
     Production never runs capture.py.
  6. Verified resume = GET /api/v1/users/self principal from the fresh
     capture must match the stored principal (principal pinning). On mismatch
     the halt is refused-lifted and the situation escalates, never resumes.
  7. Only then lifts the halt, and only after fresh per-action approval
     semantics are re-armed (quarantined ops replay only with explicit
     per-action approval; nothing auto-retries).

Usage:
  state_machine.py detect --status 401 --body '{"status":"unauthenticated"}'
  state_machine.py detect --status 302 --location 'https://school.example.edu/login'
  state_machine.py check                      # dispatch executor pre-check
  state_machine.py quarantine --op-id X --action create_page [--summary ...]
  state_machine.py reauth                     # guided re-sign-in + verified resume
  state_machine.py pin --first-signin         # pin the signed-in account
                                               # at first sign-in (keepalive
                                               # runs this; refused during a
                                               # re-auth halt)
  state_machine.py pin --confirm-account "..." # educator-confirmed pin for
                                               # an install with no pin
  state_machine.py resume [--principal-id <id>]  # production recovery after
                                               # manual re-sign-in via the
                                               # login helper; reads the live
                                               # account, requires it to match
                                               # the pinned one, re-arms
                                               # per-op approval, lifts the
                                               # halt
  state_machine.py approve --op-id X --authorization "..."  # educator per-op
                                               # re-approval; the educator's
                                               # verbatim words are REQUIRED
                                               # (W6-P2-A5: the agent cannot
                                               # self-approve)
  state_machine.py notify                    # read (+clear) the pending
                                             # educator notification
                                             # (W6-P1-S2)
  state_machine.py status                    # halt + quarantine view (+ the
                                             # session-expiry horizon warning,
                                             # W4-P2-3)
  state_machine.py selftest                   # full drill on a SIMULATED 401;
                                              # the real session is never expired

W4-P2-1: the machine is no longer drill-only. Production session-death
detection (transport/chromium_session.py, first lc.SessionDead on a
session object) calls impose_halt() + quarantine_session() +
write_notify_expired() exactly once per death, so a dead session halts
writes, parks itself in the quarantine ledger, and notifies, instead of
just raising a loud exception.

W4-P2-5: session.json.prev exists ONLY between a re-auth start and its
successful completion. _complete_reauth() deletes it on verified resume;
age_out_stale_prev() deletes a .prev older than 7 days (a leftover from
an incomplete earlier cycle), and impose_halt() sweeps it on every fresh
death.

All file writes are metadata only. No cookie or token values are ever
written to the halt file, quarantine ledger, or notify text.
"""
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
import errno
import fcntl
import heapq
from contextlib import contextmanager

# W4-P1-17: single source of truth for the morrow state root.
_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)
from config.paths import morrow_home  # noqa: E402

STORE_DIR = morrow_home()
STATE_PATH = os.path.join(STORE_DIR, "reauth_state.json")
HALT_PATH = os.path.join(STORE_DIR, "write_halt")
QUAR_PATH = os.path.join(STORE_DIR, "quarantine.jsonl")
NOTIFY_PATH = os.path.join(STORE_DIR, "notify.txt")
APPROVAL_PATH = os.path.join(STORE_DIR, "approval_required")
SESSION_PATH = os.path.join(STORE_DIR, "session.json")
SESSION_PREV = os.path.join(STORE_DIR, "session.json.prev")
CAPTURE_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "..", "session", "capture.py")

HEALTHY, EXPIRED, REAUTH_PENDING = "healthy", "expired", "reauth_pending"

# W5-P1-2: the quarantine ledger is append-mostly, but unbounded growth
# turns every status/approve/resume CLI call into an O(ledger) memory
# hit. When the live ledger exceeds QUAR_COMPACT_BYTES it is compacted:
# every non-terminal entry (quarantined / awaiting_approval: still
# actionable) is kept, and only the newest QUAR_KEEP_TERMINAL terminal
# entries (approved ops, session_death records) are retained. Terminal
# entries are forensic history; dropping the oldest is a documented
# retention policy, not data loss of anything actionable.
QUAR_COMPACT_BYTES = 2 * 1024 * 1024
QUAR_KEEP_TERMINAL = 2000

# W5-P1-4: flap dedup for session_death records. Each `execute --backend
# chromium` CLI run builds a FRESH ChromiumSession, so the per-object
# _death_notified flag cannot dedup across runs; a flapping helper (or
# a retrying driver against a dead session) would otherwise append one
# session_death record per attempt. While the write halt from the
# incident is still active, a repeat death with the same cause inside
# this window is the same incident: the append is skipped. Once the
# halt is lifted (recovery happened), the next death always records.
SESSION_DEATH_DEDUP_S = 24 * 3600
LAST_DEATH_PATH = os.path.join(STORE_DIR, "last_session_death.json")

# W5-P2-1: monotonic birth stamp for session.json.prev, so a wall-clock
# jump cannot make age_out_stale_prev() delete a fresh pinning snapshot
# mid-re-auth-cycle.
SESSION_PREV_MONO = SESSION_PREV + ".mono"


class QuarantineLedgerError(OSError):
    """The quarantine ledger could not be written (e.g. disk full).

    Subclasses OSError so existing handlers keep working; carriers set
    errno to the underlying cause. Raised instead of a bare OSError so
    the operator sees which store failed and why."""


QUAR_LOCK_PATH = QUAR_PATH + ".lock"


@contextmanager
def _ledger_locked():
    """Exclusive cross-process lock for ledger mutation (W5-P1-2).

    Serializes append, compaction, and the two status mutators so a
    concurrent CLI run cannot append between a compaction's scan and
    its atomic replace (which would silently drop the appended entry),
    and two mutators cannot interleave partial rewrites. Readers take
    no lock: the append path is O_APPEND-atomic per entry and the
    mutators publish via atomic rename, so readers always see whole
    lines or a whole file. Best-effort: if the lock cannot be taken
    the mutation still proceeds (a stuck lock must never wedge the
    educator's recovery commands).
    """
    try:
        os.makedirs(STORE_DIR, mode=0o700, exist_ok=True)
        fd = os.open(QUAR_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o600)
    except OSError:
        yield
        return
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
        except OSError:
            yield
            return
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)


# W6-P0-1: the quarantine ledger is the trust anchor for the
# executor's re-dispatch gate (executor._check_write_gates refuses
# quarantined/awaiting_approval ops; only "approved" passes). An
# unsealed ledger lets anyone with file-append access forge an
# "approved" line and bypass the educator-approval gate, so every
# ledger entry now carries ledger_hmac =
# HMAC-SHA256(quarantine_secret, canonical_entry_bytes), the hmac
# field itself excluded. The secret lives at
# <morrow-home>/quarantine.secret (0600), minted once like the
# journal's ops.secret.
_QUAR_SECRET_NAME = "quarantine.secret"
_QUAR_HMAC_PREFIX = "hmac-sha256:"


def _quarantine_secret_path():
    return os.path.join(STORE_DIR, _QUAR_SECRET_NAME)


def _load_or_mint_quarantine_secret():
    """The quarantine ledger's HMAC secret, minted once at 0600.

    A corrupt-but-present secret file is renamed aside (forensics) and
    replaced: previously sealed "approved" entries then fail
    verification and fall back to their older blocking status
    (fail-closed: the educator re-approves; nothing is silently
    admitted).
    """
    path = _quarantine_secret_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        secret_hex = doc.get("secret") if isinstance(doc, dict) else None
        if isinstance(secret_hex, str):
            return bytes.fromhex(secret_hex)
    except (OSError, ValueError):
        pass
    except Exception:
        pass
    if os.path.exists(path):
        # Present but unparseable: quarantine it, do not trust it.
        try:
            os.replace(path, "%s.corrupt.%d" % (path, _now()))
        except OSError:
            pass
        print("morrow: WARNING: quarantine ledger secret %s was corrupt; "
              "it was quarantined and a fresh secret minted. Previously "
              "approved quarantined ops need re-approval." % path,
              file=sys.stderr)
    import secrets as _secrets
    raw = _secrets.token_bytes(32)
    os.makedirs(STORE_DIR, mode=0o700, exist_ok=True)
    tmp = "%s.new.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"version": 1, "secret": raw.hex()}) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    try:
        dfd = os.open(STORE_DIR, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass
    return raw


def _canonical_ledger_bytes(entry):
    body = {k: v for k, v in entry.items() if k != "ledger_hmac"}
    return json.dumps(body, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, default=str).encode("utf-8")


def _seal_ledger_entry(entry, secret):
    """Attach ledger_hmac to a ledger entry, in place (W6-P0-1)."""
    mac = hmac.new(secret, _canonical_ledger_bytes(entry),
                   hashlib.sha256).hexdigest()
    entry["ledger_hmac"] = _QUAR_HMAC_PREFIX + mac
    return entry


def _ledger_entry_seal_valid(entry, secret):
    """True when the entry carries a ledger_hmac that verifies."""
    mac = entry.get("ledger_hmac")
    if not isinstance(mac, str) or not mac.startswith(_QUAR_HMAC_PREFIX):
        return False
    expect = hmac.new(secret, _canonical_ledger_bytes(entry),
                      hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac[len(_QUAR_HMAC_PREFIX):], expect)


def _seal_ledger_entry_for_rewrite(entry, secret):
    """Seal policy for ledger rewrites (W6-P0-1).

    Rewriting re-seals every entry it touches, EXCEPT an "approved"
    entry that does not already carry a valid seal: sealing that would
    bless a forged approval line into a gate-passing one. Blocking
    statuses (quarantined/awaiting_approval/session records) are always
    safe to seal; an already-valid seal is always safe to refresh after
    the rewrite modified the entry.
    """
    if (entry.get("status") == "approved"
            and not _ledger_entry_seal_valid(entry, secret)):
        return entry
    return _seal_ledger_entry(entry, secret)


# ------------------------------------------------------------- state helpers

def _now():
    return int(time.time())


def _write_json(path, obj, mode=0o600):
    os.makedirs(STORE_DIR, mode=0o700, exist_ok=True)
    # W5-P2-2: pid-unique tmp name; two concurrent writers of the
    # same state file must not share one staging path.
    # W6 (related): fsync the file and the directory, like the journal
    # append path: a crash between json.dump and os.replace must not
    # leave a torn state file behind.
    tmp = "%s.new.%d" % (path, os.getpid())
    with open(tmp, "w") as f:
        json.dump(obj, f)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)
    try:
        dfd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def get_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f).get("state", HEALTHY)
    except (FileNotFoundError, ValueError):
        return HEALTHY


def set_state(state, detection=None):
    _write_json(STATE_PATH, {"state": state, "updated_at": _now(),
                             "detection": detection})


# ----------------------------------------------------------------- detection

def classify_response(status, body="", location="", url=""):
    """Return 'expired' when the response carries a live-observed expiry signal.

    Both signals were confirmed live on the tenant 2026-09-20:
      401 {"status":"unauthenticated",...} on JSON API endpoints, and
      302 to /login on browser-format flows.
    Anything else returns 'unknown' (not healthy-by-proof, just not-expiry).
    """
    body_s = (body or "")[:400]
    try:
        parsed = json.loads(body_s) if body_s.strip().startswith("{") else {}
    except ValueError:
        parsed = {}
    if status == 401 and parsed.get("status") == "unauthenticated":
        return "expired", {"signal": "401_unauthenticated",
                           "status": status, "body_head": body_s[:120]}
    loc = (location or "").lower()
    if status in (301, 302, 303, 307, 308) and "/login" in loc:
        return "expired", {"signal": "302_to_login",
                           "status": status, "location": location}
    return "unknown", {"status": status, "body_head": body_s[:120]}


# ------------------------------------------------------- halt and quarantine

def check_write_allowed():
    """Pre-dispatch check the executor must call. Returns (allowed, reason)."""
    if os.path.exists(HALT_PATH):
        try:
            with open(HALT_PATH) as f:
                info = json.load(f)
            reason = (f"write halt active since {info.get('halted_at')}: "
                      f"{info.get('reason')}")
        except (ValueError, OSError):
            reason = "write halt file present (unreadable)"
        return False, reason
    return True, "no write halt"


def is_write_halted():
    """True when the write halt file is present."""
    return os.path.exists(HALT_PATH)


# The causes the re-auth machinery records in the halt file. Each is
# lifted by a verified resume once the pinned account is signed in.
HALT_CAUSES = ("session_expired", "account_mismatch")

# Halt files written before the cause field existed (0.4.0) name their
# cause only in the reason text.
_LEGACY_ACCOUNT_MISMATCH_REASON = (
    "a different Canvas account is signed in to the helper")


def halt_cause():
    """Why writes are paused, from the cause the halt file records:
    "session_expired" (the Canvas session died), "account_mismatch" (a
    different Canvas account signed in to the helper), "manual" for a
    halt file placed any other way (or unreadable), None when writes
    are not paused."""
    if not os.path.exists(HALT_PATH):
        return None
    try:
        with open(HALT_PATH) as f:
            info = json.load(f) or {}
        cause = info.get("cause")
        reason = str(info.get("reason") or "")
    except (ValueError, OSError, AttributeError):
        return "manual"
    if cause is not None:
        return cause if cause in HALT_CAUSES else "manual"
    if reason == "session_expiry" or reason.startswith(
            "chromium session death"):
        return "session_expired"
    if reason == _LEGACY_ACCOUNT_MISMATCH_REASON:
        return "account_mismatch"
    return "manual"


def impose_halt(detection, reason="session_expiry", cause="session_expired"):
    if cause not in HALT_CAUSES:
        raise ValueError("unknown halt cause %r" % (cause,))
    # W4-P2-5: a fresh death ages out any superseded session.json.prev
    # left behind by an earlier incomplete re-auth cycle before the new
    # halt is recorded. Fresh .prev files (younger than the threshold)
    # are never touched: a re-auth already in progress keeps its
    # pinning snapshot.
    age_out_stale_prev()
    _write_json(HALT_PATH, {"halted_at": _now(),
                            "reason": reason,
                            "cause": cause,
                            "detection": detection})
    set_state(EXPIRED, detection)


def lift_halt():
    try:
        os.remove(HALT_PATH)
    except FileNotFoundError:
        pass
    # W5-P1-4: the flap-dedup marker belongs to the incident the halt
    # was imposed for. Lifting the halt means the incident is resolved
    # (re-auth completed with a verified principal), so a later death
    # is a new incident and must be recorded: "once the halt lifts,
    # the next death always records." Without this, a second incident
    # with the same cause inside the 24h window would be silently
    # deduped against the resolved incident's marker.
    try:
        os.remove(LAST_DEATH_PATH)
    except FileNotFoundError:
        pass
    set_state(HEALTHY)


def _is_terminal_ledger_entry(entry):
    """True for ledger entries that can never move again.

    session_death records (status session_quarantined) are history by
    design; op entries that reached "approved" were explicitly approved
    and re-dispatched or abandoned by the educator. Everything else
    (quarantined, awaiting_approval) is still actionable and is never
    compacted away."""
    if entry.get("kind") == "session_death":
        return True
    return entry.get("status") == "approved"


def _compact_ledger():
    """Compact the live quarantine ledger file (W5-P1-2).

    Keeps every non-terminal entry plus the newest QUAR_KEEP_TERMINAL
    terminal entries, in original file order. Bounded memory: two
    streaming passes. Pass 1 records terminal entries' (quarantined_at,
    offset) in a size-K min-heap (O(K) memory); pass 2 copies live
    entries and the selected terminal offsets to a tmp file. Atomic
    (tmp + rename), mode 0600. Raises on torn lines: a ledger that
    does not parse is never silently rewritten (the caller treats that
    as "do not compact").
    Returns the number of entries dropped.
    """
    # Pass 1: stream; live entries pass through, terminal entries go
    # through a size-K min-heap keyed (quarantined_at, offset) so only
    # the newest K survive. (offset breaks timestamp ties: the later
    # line wins.)
    terminal_heap = []
    total = 0
    with open(QUAR_PATH, "rb") as f:
        while True:
            offset = f.tell()
            line = f.readline()
            if not line:
                break
            if not line.strip():
                continue
            total += 1
            entry = json.loads(line.decode("utf-8"))
            if _is_terminal_ledger_entry(entry):
                heapq.heappush(
                    terminal_heap,
                    (int(entry.get("quarantined_at") or 0), offset))
                if len(terminal_heap) > QUAR_KEEP_TERMINAL:
                    heapq.heappop(terminal_heap)
    keep_offsets = {offset for _, offset in terminal_heap}
    # Pass 2: stream again, copying kept lines in original order.
    kept = 0
    tmp = QUAR_PATH + ".compact"
    with open(QUAR_PATH, "rb") as src, open(tmp, "wb") as dst:
        while True:
            offset = src.tell()
            line = src.readline()
            if not line:
                break
            if not line.strip():
                continue
            entry = json.loads(line.decode("utf-8"))
            if not _is_terminal_ledger_entry(entry) \
                    or offset in keep_offsets:
                dst.write(line)
                kept += 1
        dst.flush()
        os.fsync(dst.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, QUAR_PATH)
    return total - kept


def _maybe_compact_ledger():
    """Compact the ledger when it exceeds QUAR_COMPACT_BYTES (W5-P1-2).

    Best effort: compaction must never break the quarantine append that
    triggered it, so failures are logged to stderr and swallowed. The
    entry just appended is fsync'd before compaction runs, so a failed
    compaction loses nothing.
    """
    with _ledger_locked():
        _maybe_compact_ledger_locked()


def _maybe_compact_ledger_locked():
    """_maybe_compact_ledger with the ledger lock already held."""
    try:
        if os.path.getsize(QUAR_PATH) <= QUAR_COMPACT_BYTES:
            return
    except OSError:
        return
    try:
        dropped = _compact_ledger()
    except Exception as exc:
        print("warning: quarantine ledger compaction failed (%s); "
              "ledger left uncompacted" % exc, file=sys.stderr)
        return
    if dropped:
        print("quarantine ledger compacted: dropped %d terminal "
              "entries" % dropped, file=sys.stderr)


def _ledger_append(entry):
    """Append one entry to the quarantine ledger (W5-P1-2).

    Single os.write loop under O_APPEND plus fsync, so the entry lands
    whole or not at all. ENOSPC raises QuarantineLedgerError with a
    plain-language message (the op journal got ENOSPC handling in
    waves 1-4; the quarantine ledger did not). Other OSErrors
    propagate as before.

    W6-P0-1: the entry is HMAC-sealed before append (see
    _seal_ledger_entry): the executor's quarantine gate only honors an
    "approved" status from a sealed entry, so a forged appended line
    can never bypass the educator-approval gate. Seals in place and
    returns the sealed entry.
    """
    os.makedirs(STORE_DIR, mode=0o700, exist_ok=True)
    _seal_ledger_entry(entry, _load_or_mint_quarantine_secret())
    line = (json.dumps(entry) + "\n").encode("utf-8")
    with _ledger_locked():
        try:
            fd = os.open(QUAR_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND,
                         0o600)
            try:
                view = memoryview(line)
                while view:
                    n = os.write(fd, view)
                    view = view[n:]
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError as exc:
            if exc.errno == errno.ENOSPC:
                raise QuarantineLedgerError(
                    errno.ENOSPC,
                    "quarantine ledger %s unwritable: disk full; the entry "
                    "was NOT recorded" % QUAR_PATH)
            raise
        try:
            os.chmod(QUAR_PATH, 0o600)
        except OSError:
            pass
        # Inside the lock: no concurrent append can land between this
        # append and the compaction's scan, so the atomic replace
        # cannot silently drop another process's entry.
        _maybe_compact_ledger_locked()


def quarantine_op(op_id, action, summary="", detection=None,
                  write_sent=False):
    """Append an in-flight op to the quarantine ledger. Never auto-retries.

    write_sent is True when the change was already on its way to Canvas
    as the session ended: Canvas may hold it, and its op id is used up,
    so it is checked in the course and prepared again, never resent."""
    entry = {"kind": "op", "op_id": op_id, "action": action,
             "summary": summary[:200], "status": "quarantined",
             "quarantined_at": _now(), "reason": "session_expiry",
             "write_sent": bool(write_sent),
             "detection": detection or {}}
    _ledger_append(entry)
    return entry


def quarantine_session(cause, detection=None):
    """W4-P2-1: quarantine the dead session itself in the ledger.

    Called exactly once per detected session death (the session object
    is sticky-dead, so repeat detections never reach here). The entry
    carries kind "session_death" and status "session_quarantined", so
    the op lifecycle (mark_ops_awaiting_approval / approve_op) never
    moves it: it is a record of the death, not a parked op. Metadata
    only: cause label, timestamp, detection evidence. No credential
    material is ever written.

    W5-P1-4: flap dedup. The "exactly once" above holds only within one
    process lifetime, but each `execute --backend chromium` CLI run
    builds a fresh ChromiumSession, so a flapping helper (or a retrying
    driver against a dead session) would append one session_death
    record per attempt, growing the ledger without bound. While the
    write halt from the incident is still active, a repeat death with
    the same cause inside SESSION_DEATH_DEDUP_S is the same incident:
    the append is skipped and the recorded entry is returned with
    deduped=True. Once the halt lifts, the next death always records.
    """
    now = _now()
    if is_write_halted():
        try:
            with open(LAST_DEATH_PATH) as f:
                last = json.load(f)
            if (isinstance(last, dict)
                    and last.get("cause") == cause
                    and now - int(last.get("quarantined_at") or 0)
                    < SESSION_DEATH_DEDUP_S):
                entry = dict(last.get("entry") or {})
                entry["deduped"] = True
                return entry
        except (OSError, ValueError):
            pass
    entry = {"kind": "session_death", "op_id": None,
             "action": "session_death", "summary": "",
             "status": "session_quarantined",
             "quarantined_at": now, "reason": "session death detected",
             "cause": cause, "detection": detection or {}}
    _ledger_append(entry)
    _write_json(LAST_DEATH_PATH,
                {"cause": cause, "quarantined_at": now, "entry": entry})
    return entry


def session_deaths():
    """Newest-first session_death records, or [] when none.

    W5-P1-2: streams the ledger (O(1) memory for the scan); only
    matching session_death records are collected, and those are
    terminal entries bounded by the compaction cap.
    """
    deaths = []
    try:
        with open(QUAR_PATH) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                op = json.loads(line)  # torn line: fail loud
                if op.get("kind") == "session_death":
                    deaths.append(op)
    except FileNotFoundError:
        pass
    deaths.reverse()
    return deaths


def age_out_stale_prev(max_age_days=7):
    """W4-P2-5: delete a superseded session.json.prev older than
    max_age_days.

    The .prev exists ONLY between a re-auth start and its successful
    completion; anything older is a leftover from an incomplete earlier
    cycle and must not persist. Returns True when a file was deleted,
    False when there was nothing stale to delete. Never raises.

    W5-P2-1: wall-clock age is corruptible by clock jumps: a forward
    jump would make a seconds-old .prev look ancient and delete the
    pinning snapshot mid-re-auth-cycle (impose_halt sweeps on every
    fresh death). reauth() therefore records the .prev's birth on the
    monotonic (steady) clock in session.json.prev.mono; when that stamp
    says the .prev is fresh, it is kept regardless of what the wall
    clock claims. A backward jump can only make a stale .prev look
    fresh (kept, harmless: reauth() overwrites it on the next cycle).
    """
    try:
        mtime = os.stat(SESSION_PREV).st_mtime
    except FileNotFoundError:
        return False
    except OSError:
        return False
    try:
        with open(SESSION_PREV_MONO) as f:
            born_mono = float((json.load(f) or {}).get("mono", 0))
        # W5-P2-1: the monotonic clock resets on reboot. A negative
        # delta means the stamp was written before a reboot and is
        # meaningless now: ignore it and fall back to wall-clock age
        # (fail-safe: an actually-fresh .prev is re-pinned by reauth()
        # on the next cycle; an actually-stale one is deleted).
        now_mono = time.monotonic()
        if (born_mono > 0 and now_mono >= born_mono
                and (now_mono - born_mono
                     < max_age_days * 86400.0)):
            return False
    except (OSError, ValueError):
        pass
    age_days = (time.time() - mtime) / 86400.0
    if age_days > max_age_days:
        try:
            os.remove(SESSION_PREV)
        except FileNotFoundError:
            return False
        except OSError:
            return False
        # W5-P2-1: the monotonic birth stamp goes with the .prev it
        # describes; leaving it behind would protect a future .prev
        # that never had one.
        try:
            os.remove(SESSION_PREV_MONO)
        except OSError:
            pass
        return True
    return False


def quarantined_ops():
    ops = []
    try:
        with open(QUAR_PATH) as f:
            for line in f:
                line = line.strip()
                if line:
                    ops.append(json.loads(line))
    except FileNotFoundError:
        pass
    return ops


def paused_ops():
    """The changes still waiting on the educator: one entry per op id,
    its newest, when that status is quarantined or awaiting_approval.
    The session_death records of past incidents are history, not
    paused changes."""
    newest = {}
    for entry in quarantined_ops():
        if (entry.get("kind") or "op") == "op":
            newest[str(entry.get("op_id"))] = entry
    return [entry for entry in newest.values()
            if entry.get("status") in ("quarantined", "awaiting_approval")]


def mark_ops_awaiting_approval():
    """After verified resume, quarantined ops move to awaiting_approval.

    Replay requires fresh per-action approval from the educator; the dispatch
    executor must gate on status == 'approved'.

    W5-P1-2: streams the rewrite line by line (O(1) memory) through a
    tmp file + atomic rename, under the ledger lock, instead of loading
    the whole ledger and truncating it in place.
    """
    moved = 0
    with _ledger_locked():
        tmp = QUAR_PATH + ".mutate"
        try:
            # W6-P0-1: every rewritten entry is re-sealed with the
            # current secret, so the ledger never carries an unsealed
            # entry written by this code (legacy pre-seal entries keep
            # their shape until rewritten).
            secret = _load_or_mint_quarantine_secret()
            with open(QUAR_PATH) as src, open(tmp, "w") as dst:
                for line in src:
                    if line.strip():
                        op = json.loads(line)  # torn line: fail loud
                        if op.get("status") == "quarantined":
                            op["status"] = "awaiting_approval"
                            op["approved"] = False
                            moved += 1
                        _seal_ledger_entry_for_rewrite(op, secret)
                        dst.write(json.dumps(op) + "\n")
                    else:
                        dst.write(line)
                dst.flush()
                os.fsync(dst.fileno())
        except FileNotFoundError:
            return 0
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        os.chmod(tmp, 0o600)
        os.replace(tmp, QUAR_PATH)
    return moved


def op_quarantine_status(op_id):
    """Newest quarantine status for op_id, or None when never quarantined.

    W5-P1-2: streams the ledger line by line (O(1) memory) instead of
    loading it whole. This is the executor's quarantine gate on every
    write dispatch, so it must stay cheap. Torn lines are skipped here
    (they cannot be attributed to an op_id); quarantined_ops() still
    fails loud on them.

    W6-P0-1: an "approved" status is honored ONLY from an entry whose
    ledger_hmac verifies. A forged appended line (or a tampered entry)
    carries no valid seal and is skipped, so the newest trustworthy
    status (quarantined/awaiting_approval) still blocks the gate.
    Blocking statuses from pre-seal (legacy) entries are still honored
    fail-safe, but a legacy "approved" line is never trusted: ops
    approved before the seal existed need one fresh approve_op.

    W6-P0-1 (secret loss): when the ledger holds entries for this op
    but none yields a trustworthy status (e.g. the only entry is an
    "approved" whose seal no longer verifies after the quarantine
    secret was lost or corrupted), the op is NOT "never quarantined":
    return "quarantined" fail-closed so the executor's gate blocks
    re-dispatch until the educator re-approves. Returning None here
    would let the gate treat a secret-loss victim as a fresh op.
    """
    status = None
    seen = False
    secret = None
    try:
        with open(QUAR_PATH) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    op = json.loads(line)
                except ValueError:
                    continue
                if str(op.get("op_id")) != str(op_id):
                    continue
                seen = True
                entry_status = op.get("status")
                if entry_status == "approved":
                    # The admitting status requires authenticity.
                    if secret is None:
                        try:
                            secret = _load_or_mint_quarantine_secret()
                        except OSError:
                            continue
                    if not _ledger_entry_seal_valid(op, secret):
                        continue
                status = entry_status
    except FileNotFoundError:
        pass
    if status is None and seen:
        return "quarantined"
    return status


# W6-P2-A5: the re-approval citation bar, matching the admission
# ceremony's APPROVAL_AUTH_MIN_LEN (the state machine must not import
# the dispatcher; the value is mirrored, not shared). Any non-empty
# verbatim reply counts: "yes" is an approval.
_REAPPROVAL_AUTH_MIN_LEN = 1


def approve_op(op_id, authorization=None):
    """The educator's explicit per-op approval to re-dispatch a quarantined op.

    Only an op in status 'awaiting_approval' (verified resume already
    happened) can be approved. Returns True on approval, False when the
    op is not awaiting approval. The dispatch executor refuses any op_id
    whose newest quarantine status is not 'approved'.

    W6-P2-A5: `authorization` is REQUIRED: the educator's verbatim
    words approving THIS op's re-dispatch (any non-empty reply), sealed into
    the ledger entry. The old signature let the agent "approve" a
    quarantined op with no educator input at all; the whole
    "explicit approval" loop was agent-self-certified. A short or
    missing citation raises ValueError before anything is approved.

    W5-P1-2: streams the rewrite line by line (O(1) memory) through a
    tmp file + atomic rename, under the ledger lock, instead of loading
    the whole ledger and truncating it in place.
    """
    if (not isinstance(authorization, str)
            or len(authorization.strip()) < _REAPPROVAL_AUTH_MIN_LEN):
        raise ValueError(
            "approve_op requires the educator's verbatim reply approving "
            "the re-dispatch of this op (any non-empty reply); the agent "
            "cannot self-approve a quarantined op")
    changed = False
    with _ledger_locked():
        tmp = QUAR_PATH + ".mutate"
        try:
            # W6-P0-1: rewritten entries are re-sealed (see
            # mark_ops_awaiting_approval); only a sealed "approved"
            # entry passes the executor's quarantine gate.
            secret = _load_or_mint_quarantine_secret()
            with open(QUAR_PATH) as src, open(tmp, "w") as dst:
                for line in src:
                    if line.strip():
                        op = json.loads(line)  # torn line: fail loud
                        granted = False
                        if (str(op.get("op_id")) == str(op_id)
                                and op.get("status")
                                == "awaiting_approval"):
                            op["status"] = "approved"
                            op["approved"] = True
                            op["approved_at"] = _now()
                            # W6-P2-A5: the educator's verbatim citation
                            # is sealed into the ledger entry with the
                            # approval, so audit can check the words.
                            op["approval_authorization"] = authorization.strip()
                            changed = True
                            granted = True
                        if granted:
                            # This rewrite just granted the approval:
                            # seal it. Anything else goes through the
                            # bless-aware policy (a pre-existing
                            # unsealed "approved" line is never sealed).
                            _seal_ledger_entry(op, secret)
                        else:
                            _seal_ledger_entry_for_rewrite(op, secret)
                        dst.write(json.dumps(op) + "\n")
                    else:
                        dst.write(line)
                dst.flush()
                os.fsync(dst.fileno())
        except FileNotFoundError:
            return False
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        os.chmod(tmp, 0o600)
        os.replace(tmp, QUAR_PATH)
    return changed


class PrincipalPinError(Exception):
    """The pinned Canvas principal cannot be trusted or changed.

    Raised when the pin store is unreadable, loosely permissioned, or
    corrupt, when a different account tries to replace the pin, and
    when a pin would be taken during a re-auth halt without the
    educator's own confirmation. Always fails closed.
    """


PIN_AUDIT_PATH_NAME = "principal_pin.json"
PIN_CONFIRM_MIN_LEN = 1


def _lane_state_module():
    from transport import state as _lane_state
    return _lane_state


def pinned_principal():
    """The pinned principal {"id", "name", "base"}, or None when none.

    Production pin store: the browser lane state (browser_lane.json,
    metadata only, 0600), written on the educator's first sign-in.
    Rig/drill fallback: session.json. A store that exists but cannot be
    read, is loosely permissioned, or is corrupt raises
    PrincipalPinError: it is never read as "no pin".
    """
    lane = _lane_state_module()
    try:
        rec = lane.load()
    except (OSError, ValueError) as exc:
        raise PrincipalPinError(
            "the pinned-account record %s cannot be trusted (%s)"
            % (lane.STATE_PATH, exc))
    canvas = (rec or {}).get("canvas") if isinstance(rec, dict) else None
    principal = (canvas or {}).get("principal") if isinstance(
        canvas, dict) else None
    if rec is not None and (not isinstance(principal, dict)
                            or principal.get("id") in (None, "")):
        raise PrincipalPinError(
            "the pinned-account record %s has no principal id"
            % lane.STATE_PATH)
    if isinstance(principal, dict):
        return {"id": principal.get("id"), "name": principal.get("name"),
                "base": (canvas or {}).get("base")}
    try:
        with open(SESSION_PATH) as f:
            sess = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise PrincipalPinError(
            "the session record %s cannot be trusted (%s)"
            % (SESSION_PATH, exc))
    principal = ((sess or {}).get("canvas") or {}).get("principal") \
        if isinstance(sess, dict) else None
    if not isinstance(principal, dict) or principal.get("id") in (None, ""):
        return None
    return {"id": principal.get("id"), "name": principal.get("name"),
            "base": (sess.get("canvas") or {}).get("base")}


def pin_principal(base, principal_id, principal_name, first_signin=False,
                  confirmation=None):
    """Pin the signed-in Canvas principal. Returns the pinned record.

    - Same id already pinned: refreshes the display name, nothing else.
    - A different id already pinned: refused. Switching accounts is a
      disconnect followed by a fresh first sign-in, never a silent swap.
    - No pin and no write halt (first_signin=True): the first sign-in
      is the educator's own onboarding, so it is pinned.
    - No pin during a write halt: pinning whoever signed back in would
      defeat the check, so it needs the educator's verbatim confirming
      words (confirmation, any non-empty reply).
    """
    if principal_id in (None, ""):
        raise PrincipalPinError("no principal id to pin")
    current = pinned_principal()
    lane = _lane_state_module()
    if current is not None:
        if str(current["id"]) != str(principal_id):
            raise PrincipalPinError(
                "this connector is pinned to Canvas account id %s; the "
                "signed-in account is id %s. Refusing to replace the pin. "
                "To connect a different account, disconnect first "
                "(bin/morrow disconnect), then sign in again."
                % (current["id"], principal_id))
        name = str(principal_name or current.get("name") or "").strip()
        lane.save(current.get("base") or base, current["id"], name)
        return pinned_principal()
    confirmed = (isinstance(confirmation, str)
                 and len(confirmation.strip()) >= PIN_CONFIRM_MIN_LEN)
    if is_write_halted() and not confirmed:
        raise PrincipalPinError(
            "no Canvas account is pinned and paused work is waiting on a "
            "re-sign-in, so the signed-in account cannot be pinned "
            "automatically. The educator must confirm it is their own "
            "account: state_machine.py pin --confirm-account \"<their "
            "own words>\"")
    if not first_signin and not confirmed:
        raise PrincipalPinError(
            "pinning needs either the first sign-in (--first-signin) or "
            "the educator's confirming words (--confirm-account, any "
            "non-empty reply)")
    if not base:
        raise PrincipalPinError("no Canvas base URL to pin against")
    lane.save(base, principal_id, str(principal_name or "").strip())
    _write_json(os.path.join(STORE_DIR, PIN_AUDIT_PATH_NAME), {
        "pinned_at": _now(),
        "principal_id": str(principal_id),
        "base": base.rstrip("/"),
        "how": "educator-confirmed" if confirmed else "first-signin",
        "educator_confirmation": confirmation.strip() if confirmed else None,
    })
    return pinned_principal()


def read_live_principal(base=None):
    """(id, name, base) of the account signed in to the login helper.

    Requires the helper /status to report a live signed-in session, then
    reads GET /api/v1/users/self through the Chromium lane (the
    educator's own record; a read, no approval). Raises
    PrincipalPinError when the session is not live or the read fails.
    """
    from transport import local_chromium as lc
    try:
        st = lc.helper_status(timeout=10)
    except Exception as exc:
        raise PrincipalPinError(
            "the login helper is not reachable (%s); start it with "
            "helper/keepalive.sh and sign in first" % type(exc).__name__)
    if not (st or {}).get("logged_in"):
        raise PrincipalPinError(
            "the login helper reports no signed-in Canvas session; sign "
            "in through the helper page first")
    from config import tree_config
    base = (base or tree_config.canvas_base()).rstrip("/")
    if not base:
        raise PrincipalPinError(
            "no Canvas base URL: CANVAS_BASE is not set in this tree's "
            "helper/env (%s) or the environment; set it there, or pass "
            "--base" % tree_config.env_file_path())
    from dispatch import executor as ex
    from transport import chromium_session as cs
    sess = cs.ChromiumSession(base)
    entry = ex.catalog_descriptor_to_entry(
        "users_self", "GET", "/api/v1/users/self", provider="canvas")
    method, url, headers, body = ex.build_request(
        entry, entry["request"], {}, sess, ex.load_pack(ex.DEFAULT_PACK),
        {"canvas_base": base}, {})
    try:
        status, _rh, raw, _attempts = sess.raw_request(
            method, url, headers, body, is_write=False)
        me = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise PrincipalPinError(
            "could not read the signed-in account (GET /api/v1/users/self: "
            "%s)" % type(exc).__name__)
    if status != 200 or not isinstance(me, dict) or me.get("id") is None:
        raise PrincipalPinError(
            "GET /api/v1/users/self did not return the signed-in account "
            "(HTTP %s)" % status)
    return me.get("id"), me.get("name") or "", base


_NO_PIN_RECOVERY = (
    "REFUSED: no Canvas account is pinned for this connector, so there is "
    "no way to prove the account that signed back in is the educator's. "
    "The write halt stays and paused work stays paused. Recovery: the "
    "educator confirms, in their own words, that the signed-in account "
    "is theirs; then run state_machine.py pin --confirm-account "
    "\"<their words>\" and run resume again.")


def verified_resume_after_manual_signin(principal_id, principal_name="",
                                        base=""):
    """Production recovery after the educator re-signs in manually.

    The production flow never re-runs capture.py (rig-only). Instead:
    the educator signs in again through the login helper's own browser
    tab; the live principal is read and must match the PINNED principal
    (pinned at first sign-in, see pin_principal). Only then are
    quarantined ops re-armed as awaiting_approval (each still needs the
    educator's explicit per-op approval via approve_op before
    re-dispatch) and the halt lifted. Returns the number of ops moved
    to awaiting_approval, or -1 on refusal (halt stays): a principal
    mismatch (escalation written), no pinned principal, or a pin store
    that cannot be trusted.
    """
    try:
        stored = pinned_principal()
    except PrincipalPinError as exc:
        write_notify_escalation("pinned-account record unusable: %s" % exc)
        print("REFUSED: %s; halt stays, escalated" % exc)
        return -1
    if stored is None:
        print(_NO_PIN_RECOVERY)
        return -1
    stored_id = stored["id"]
    if str(principal_id) != str(stored_id):
        write_notify_escalation(
            "principal mismatch on manual re-sign-in: expected id %s, "
            "saw id %s" % (stored_id, principal_id))
        print("REFUSED: principal mismatch after manual re-sign-in; "
              "halt stays, escalated")
        return -1
    # W6-P2-A4: the id matched, so this is the same account; refresh the
    # stored display name from the fresh verification so the helper UI
    # ("signed in as ...") does not lag a Canvas display-name change.
    if principal_name and str(principal_name).strip():
        try:
            pin_principal(stored.get("base") or base, stored_id,
                          principal_name)
        except PrincipalPinError:
            pass
        if os.path.exists(SESSION_PATH):
            try:
                with open(SESSION_PATH) as f:
                    sess = json.load(f)
                sess.setdefault("canvas", {}).setdefault(
                    "principal", {})["name"] = str(principal_name).strip()
                _write_json(SESSION_PATH, sess)
            except (OSError, ValueError):
                pass
    moved = mark_ops_awaiting_approval()
    _write_json(APPROVAL_PATH,
                {"re_armed_at": _now(),
                 "policy": "fresh per-action approval required before any "
                           "quarantined op replays; nothing auto-retries",
                 "quarantined_ops": len(quarantined_ops()),
                 "recovery": "manual_signin"})
    lift_halt()
    # W4-P2-5: production recovery never creates a .prev, but an earlier
    # incomplete rig/drill cycle may have left one behind; a completed
    # recovery is the right moment to sweep it.
    age_out_stale_prev()
    write_notify_resumed(paused_ops())
    print("verified resume (manual sign-in): principal id=%s matches the "
          "pinned account, halt lifted, %d op(s) awaiting fresh per-op "
          "approval" % (principal_id, moved))
    return moved


# ------------------------------------------------- pre-expiry awareness

# W4-P2-3: warn while the horizon is still in the future, not after the
# first failed op. The helper's /status reports
# session_expiry_horizon_days (cookie METADATA only: whole days until
# the earliest persistent tenant cookie expires, null when unknown).
# "Near expiry" here is within ~24h (days <= 1); keepalive.sh already
# logs its own louder warning at 7 days on every healthy tick, and the
# helper's session_expiry_warning flag mirrors that threshold.


def expiry_horizon_warning():
    """W4-P2-3: (days, near, message) for the session-expiry horizon.

    Reads the helper's /status (open endpoint, metadata only). near is
    True when the horizon is within ~24h. days is None when the horizon
    is unknown (helper down, legacy server, malformed body). Never
    raises: an unreachable helper is "unknown", not an error.
    """
    try:
        from transport import local_chromium as lc
        st = lc.helper_status(timeout=5)
    except Exception:
        return None, False, ("session expiry horizon unknown "
                             "(helper /status unreachable)")
    try:
        days = (st or {}).get("session_expiry_horizon_days")
    except Exception:
        days = None
    if not isinstance(days, int) or isinstance(days, bool) or days < 0:
        return None, False, ("session expiry horizon unknown "
                             "(helper reported no usable horizon)")
    if days <= 1:
        return days, True, (
            "WARNING: the Canvas session's earliest cookie expires within "
            "~24h (horizon %d day(s) per helper /status); re-sign in "
            "through the login helper soon, or the next write run will "
            "halt mid-operation" % days)
    return days, False, "session expiry horizon: %d day(s)" % days


# ------------------------------------------------------------------ notify

def _session_summary():
    try:
        pin = pinned_principal()
    except PrincipalPinError:
        pin = None
    if not pin:
        return "?", "?", "?"
    return (pin.get("base") or "?", pin.get("name") or "?",
            pin.get("id") if pin.get("id") is not None else "?")


def _split_paused(paused):
    """(changes that may already be in Canvas, changes never sent)."""
    sent = sum(1 for op in paused if op.get("write_sent"))
    return sent, len(paused) - sent


def _changes(n):
    return "1 change" if n == 1 else "%d changes" % n


def _may_be_in_canvas_text(n, resumed):
    one = n == 1
    text = "%s may already be in Canvas. " % _changes(n)
    if resumed:
        text += "Morrow checks the course to see if %s there" % (
            "it is" if one else "they are")
    else:
        text += ("The connection ended while Morrow was sending %s, so "
                 "Morrow cannot tell if Canvas saved %s. Morrow will not "
                 "send %s again on its own. Morrow checks the course first"
                 % (("it",) * 3 if one else ("them",) * 3))
    return text + (", and asks for your OK before it prepares %s again.\n"
                   % ("the change" if one else "any of them"))


def write_notify_expired(paused):
    """paused: the changes still waiting on the educator (paused_ops())."""
    base, name, pid = _session_summary()
    sent, unsent = _split_paused(paused)
    lines = ""
    if sent:
        lines += _may_be_in_canvas_text(sent, resumed=False)
    if unsent == 1:
        lines += ("1 change was stopped before Morrow sent it, so it did "
                  "not change anything in Canvas. It waits for your OK "
                  "before Morrow sends it.\n")
    elif unsent:
        lines += ("%d changes were stopped before Morrow sent them, so "
                  "they did not change anything in Canvas. Each one waits "
                  "for your OK before Morrow sends it.\n" % unsent)
    if not paused:
        lines = "No change was in progress, so nothing was paused.\n"
    text = (
        "Morrow: your Canvas connection expired.\n\n"
        f"The session for {name} (id {pid}) on {base} is no longer valid.\n"
        + lines
        + "\nNext step: sign in to Canvas again on the helper page.\n"
    )
    os.makedirs(STORE_DIR, mode=0o700, exist_ok=True)
    with open(NOTIFY_PATH, "w") as f:
        f.write(text)
    os.chmod(NOTIFY_PATH, 0o600)


def write_notify_resumed(paused):
    """paused: the changes still waiting on the educator (paused_ops())."""
    if not paused:
        # Nothing waits on the educator, so the helper page has nothing
        # left to tell them.
        try:
            os.remove(NOTIFY_PATH)
        except FileNotFoundError:
            pass
        return
    base, name, pid = _session_summary()
    sent, unsent = _split_paused(paused)
    lines = ""
    if sent:
        lines += _may_be_in_canvas_text(sent, resumed=True)
    if unsent == 1:
        lines += ("1 change that was not sent is waiting for your OK. "
                  "Nothing is sent without it.\n")
    elif unsent:
        lines += ("%d changes that were not sent are waiting for your OK. "
                  "Nothing is sent without your OK on each one.\n" % unsent)
    text = (
        "Morrow: your Canvas connection is back.\n\n"
        f"The session for {name} (id {pid}) on {base} was verified as the "
        "same account.\n"
        + lines
    )
    with open(NOTIFY_PATH, "w") as f:
        f.write(text)
    os.chmod(NOTIFY_PATH, 0o600)


def write_notify_stale(n_quarantined):
    """W4-P2-1: the session was re-established after a command was
    prepared, so the stale command was refused rather than run against
    the new session. The session is NOT dead and no re-sign-in is needed;
    the educator only needs to approve re-running the pending step
    against the fresh session."""
    base, name, pid = _session_summary()
    text = (
        "Morrow: your Canvas connection was refreshed.\n\n"
        f"The session for {name} (id {pid}) on {base} was re-established "
        "after an operation's command was prepared, so the stale command "
        "was refused rather than run against the new session. Nothing was "
        "retried and nothing was lost.\n\n"
        f"{n_quarantined} operation(s) are waiting for your approval "
        "before the pending step re-runs against the fresh session. "
        "Nothing will run without your OK on each one.\n"
    )
    os.makedirs(STORE_DIR, mode=0o700, exist_ok=True)
    with open(NOTIFY_PATH, "w") as f:
        f.write(text)
    os.chmod(NOTIFY_PATH, 0o600)


def write_notify_escalation(detail):
    base, name, pid = _session_summary()
    text = (
        "Morrow: re-sign-in needs your attention.\n\n"
        "After the new sign-in, the Canvas account did not match the one "
        f"Morrow was connected to ({name}, id {pid} on {base}). For safety, "
        "paused work stays paused and nothing resumed.\n\n"
        f"Detail: {detail}\n\n"
        "Please check which account you signed in with, or contact support.\n"
    )
    with open(NOTIFY_PATH, "w") as f:
        f.write(text)
    os.chmod(NOTIFY_PATH, 0o600)


# ------------------------------------------------------------- re-auth flow

def on_expiry_detected(detection, simulated=False):
    """Full expiry handling: halt, quarantine placeholder, notify."""
    impose_halt(detection)
    write_notify_expired(paused_ops())
    tag = " (SIMULATED)" if simulated else ""
    print(f"expiry detected{tag}: state={EXPIRED}, write halt imposed, "
          f"notify.txt written, {len(paused_ops())} op(s) quarantined")


def reauth():
    """Guided re-sign-in: re-run capture.py, pin the principal, resume.

    Principal pinning: the fresh capture's principal id must equal the
    stored one. On mismatch the halt is NOT lifted and the situation
    escalates. When the stored record has no principal (older captures),
    the fresh capture's live-verified principal is pinned first-seen.
    The agent never sees credentials; sign-in stays manual.
    """
    state = get_state()
    if state not in (EXPIRED, REAUTH_PENDING):
        print(f"no re-auth needed: state={state}")
        return True
    set_state(REAUTH_PENDING)

    # Snapshot the current (dead) session record for pinning.
    try:
        shutil.copy2(SESSION_PATH, SESSION_PREV)
        with open(SESSION_PREV) as f:
            stored = json.load(f)
    except (FileNotFoundError, ValueError) as e:
        write_notify_escalation(f"stored session record unreadable: {e}")
        print("escalation: stored session record unreadable")
        return False
    old_principal = (stored.get("canvas") or {}).get("principal") or {}
    if old_principal.get("id") is None:
        # The stored record never captured a principal (pre-principal
        # capture, e.g. the live store). _complete_reauth pins the fresh
        # capture's live-verified principal as the first-seen pin.
        print("no stored principal: first-seen pinning will record the "
              "fresh capture's principal")
    # W5-P2-1: birth-stamp the pinning snapshot on the monotonic
    # clock so a wall-clock jump cannot make age_out_stale_prev()
    # delete it mid-cycle.
    _write_json(SESSION_PREV_MONO, {"mono": time.monotonic()})

    print("guided re-sign-in: re-running capture.py "
          "(educator signs in through the login helper page)")
    try:
        proc = subprocess.run([sys.executable, CAPTURE_PY],
                              capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        # W5-P2-6: a hung capture.py takes the designed escalation path
        # (plain-language notify, state stays reauth_pending), not a
        # traceback out of reauth(). subprocess.run kills the child
        # before raising TimeoutExpired.
        write_notify_escalation(
            "capture.py hung past the 120s timeout and was killed; "
            "state stays reauth_pending")
        print("escalation: capture.py timed out after 120s (killed), "
              "state stays reauth_pending")
        return False
    if proc.returncode != 0:
        write_notify_escalation(
            f"capture.py failed (exit {proc.returncode}); "
            f"{(proc.stderr or proc.stdout)[-300:]}")
        print("escalation: capture failed, state stays reauth_pending")
        return False

    with open(SESSION_PATH) as f:
        new_principal = json.load(f)["canvas"]["principal"]
    return _complete_reauth(old_principal, new_principal)


def _complete_reauth(old_principal, new_principal):
    """W4-P2-5: the testable completion step of re-auth.

    Principal pinning: the fresh principal id must equal the stored
    one. On mismatch the halt is NOT lifted, the situation escalates,
    and session.json.prev is RETAINED (recovery did not complete). On
    match: re-arm per-op approval, lift the halt, and ONLY THEN delete
    session.json.prev (it has served its pinning purpose).
    First-seen pinning: when the stored record has no principal (older
    captures), the fresh capture's live-verified principal is recorded
    as the pin instead of failing; there is nothing to be swapped
    against.
    Returns True on verified resume, False on mismatch.
    """
    old_id = old_principal.get("id")
    new_id = new_principal.get("id")
    if old_id is None and new_id is not None:
        # First-seen pinning (see reauth()): the stored record never
        # captured a principal. The fresh principal was verified live by
        # capture.py's in-tab probe; record it as the pin and proceed.
        print(f"first-seen principal pin: id={new_id} "
              f"name={new_principal.get('name')!r}")
    elif new_id != old_id:
        write_notify_escalation(
            f"principal mismatch: expected id {old_id}, got id {new_id}")
        print("REFUSED: principal mismatch, halt stays, escalated")
        return False

    # Verified resume: lift the halt, re-arm per-action approval.
    moved = mark_ops_awaiting_approval()
    _write_json(APPROVAL_PATH,
                {"re_armed_at": _now(),
                 "policy": "fresh per-action approval required before any "
                           "quarantined op replays; nothing auto-retries",
                 "quarantined_ops": len(quarantined_ops())})
    # W4-P2-5: the superseded session record has served its
    # principal-pinning purpose; wipe it now that the fresh session is
    # verified. Retention rule: session.json.prev exists ONLY between a
    # re-auth start and its successful completion, then it is deleted.
    try:
        os.remove(SESSION_PREV)
    except FileNotFoundError:
        pass
    # W5-P2-1: the monotonic birth stamp goes with it.
    try:
        os.remove(SESSION_PREV_MONO)
    except OSError:
        pass
    lift_halt()
    write_notify_resumed(paused_ops())
    print(f"verified resume: principal id={new_principal.get('id')} pinned, "
          f"halt lifted, {moved} op(s) awaiting fresh per-action approval")
    return True


# -------------------------------------------------------------------- CLI

def _arg(flag, default=""):
    for i, a in enumerate(sys.argv):
        if a == flag and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def cmd_detect():
    status = int(_arg("--status", "0"))
    body = _arg("--body", "")
    location = _arg("--location", "")
    url = _arg("--url", "")
    simulated = "--simulated" in sys.argv
    verdict, detection = classify_response(status, body, location, url)
    print(f"classify: status={status} -> {verdict} {detection}")
    if verdict == "expired":
        on_expiry_detected(detection, simulated=simulated)
    else:
        print("no expiry signal; state unchanged")


def cmd_check():
    allowed, reason = check_write_allowed()
    print(f"writes_allowed={allowed} reason={reason} state={get_state()}")
    return allowed


def cmd_quarantine():
    # W5-P0-1: the default op_id MUST be unique. The old default
    # (op-<epoch-seconds>) collided for any two quarantines in the same
    # wall-clock second, and approve_op flips EVERY ledger entry with a
    # matching op_id: approving one op silently approved dozens of
    # distinct ops. uuid4 makes collision infeasible.
    op_id = _arg("--op-id", "op-" + uuid.uuid4().hex)
    action = _arg("--action", "unknown")
    summary = _arg("--summary", "")
    allowed, reason = check_write_allowed()
    entry = quarantine_op(op_id, action, summary)
    print(f"quarantined op_id={op_id} action={action} "
          f"(writes_allowed={allowed}; {reason})")


def _write_was_sent(op_id):
    """True when op_id's newest ledger entry says its write was sent."""
    sent = False
    for entry in quarantined_ops():
        if (entry.get("kind") or "op") == "op" \
                and str(entry.get("op_id")) == str(op_id):
            sent = bool(entry.get("write_sent"))
    return sent


def approval_refusal_evidence(op_id, status):
    """The failure translator's evidence for an approve refused because
    the op is not awaiting approval. Approving never sends a change."""
    return {"error": "ApprovalRefused",
            "quarantine_status": status or "none",
            "nothing_sent": True,
            "detail": "op_id=%s is not awaiting_approval (status=%s)"
                      % (op_id, status)}


def cmd_approve():
    op_id = _arg("--op-id", None)
    authorization = _arg("--authorization", None)
    if not op_id or not (authorization or "").strip():
        print('usage: state_machine.py approve --op-id <op_id> '
              '--authorization "the educator\'s verbatim approval words"')
        print("W6-P2-A5: the educator must actually say the words; the "
              "agent cannot approve on their behalf.")
        return False
    try:
        ok = approve_op(op_id, authorization)
    except ValueError as exc:
        # Agent-facing error funnel: the agent sees the translated
        # four-part message, never the raw refusal text.
        exc.nothing_sent = True
        try:
            from failures.funnel import agent_error_text
            print(agent_error_text("approving a paused change", exc))
        except Exception:
            print(f"refused: {exc}")
        return False
    if ok:
        if _write_was_sent(op_id):
            print(f"approved op_id={op_id}. This change may already be in "
                  "Canvas and its op id is used up, so it is never sent "
                  "again. Read the item back with a live-proven read and "
                  "tell the educator what Canvas has. Prepare the change "
                  "again (plan-write, or catalog in Edit mode) only when "
                  "that read shows it is not there and the educator says "
                  "so.")
        else:
            print(f"approved op_id={op_id} for re-dispatch")
        return True
    status = op_quarantine_status(op_id)
    try:
        from failures.funnel import agent_error_text
        print(agent_error_text("approving a paused change",
                               approval_refusal_evidence(op_id, status)))
    except Exception:
        print(f"refused: op_id={op_id} is not awaiting_approval "
              f"(status={status})")
    return False


def cmd_notify():
    """W6-P1-S2: the educator-notification reader.

    write_notify_* writes the "your connection expired, N ops paused"
    notice to NOTIFY_PATH, but nothing in the product ever read it
    back: the educator could sit for a semester never knowing ops were
    waiting. This command prints the pending notice (if any) so the
    agent surfaces it to the educator in chat, then clears it. Exit 0
    prints a notice (or "none pending"); the notice text goes to
    stdout for relaying.
    """
    try:
        with open(NOTIFY_PATH, encoding="utf-8") as fh:
            text = fh.read().strip()
    except FileNotFoundError:
        text = ""
    except OSError as exc:
        try:
            from failures.funnel import agent_error_text
            print(agent_error_text("reading the notice about paused changes", exc))
        except Exception:
            print(f"could not read the educator notification: {exc}")
        return False
    if not text:
        print("no educator notification pending")
        return True
    print(text)
    print()
    print("-- end of pending educator notification "
          "(cleared after display) --")
    try:
        os.remove(NOTIFY_PATH)
    except OSError:
        pass
    return True


def cmd_resume():
    """W4-P2-1: the concrete production recovery caller.

    Run AFTER the educator re-signs in through the login helper's own
    browser tab:
      state_machine.py resume [--principal-id <id>] [--base B]
    It reads the live principal itself (helper /status must show a live
    session, then GET /api/v1/users/self). A --principal-id that
    disagrees with the live account is refused. The live account must
    match the pinned one; on match, quarantined ops are re-armed as
    awaiting_approval and the halt lifts. On mismatch, or with no
    pinned account, the halt stays.
    """
    claimed = _arg("--principal-id", None)
    try:
        live_id, live_name, live_base = read_live_principal(
            _arg("--base", "") or None)
    except PrincipalPinError as exc:
        print("REFUSED: %s; halt stays" % exc)
        return False
    if claimed is not None and str(claimed) != str(live_id):
        print("REFUSED: --principal-id %s is not the signed-in account "
              "(live id %s); halt stays" % (claimed, live_id))
        return False
    moved = verified_resume_after_manual_signin(
        live_id, principal_name=live_name, base=live_base)
    return moved >= 0


def cmd_pin():
    """Pin the signed-in Canvas account (first sign-in, or recovery).

      state_machine.py pin --first-signin      # keepalive / FIRST_RUN step 4
      state_machine.py pin --confirm-account "<educator's own words>"

    --first-signin is quiet and succeeds when the same account is
    already pinned. It refuses during a re-auth halt (it would pin
    whoever signed back in). --confirm-account records the educator's
    verbatim confirmation that the signed-in account is theirs.
    """
    first = "--first-signin" in sys.argv
    confirmation = _arg("--confirm-account", None)
    try:
        live_id, live_name, live_base = read_live_principal(
            _arg("--base", "") or None)
        rec = pin_principal(live_base, live_id, live_name,
                            first_signin=first, confirmation=confirmation)
    except PrincipalPinError as exc:
        print("NOT PINNED: %s" % exc)
        return False
    print("pinned Canvas account: %s (id %s) on %s"
          % (rec.get("name") or "?", rec.get("id"), rec.get("base")))
    return True


def cmd_status():
    op_id = _arg("--op-id", None)
    if op_id:
        print(f"op_id={op_id} status={op_quarantine_status(op_id)}")
    else:
        for op in quarantined_ops():
            kind = op.get("kind") or "op"
            print(f"kind={kind} op_id={op.get('op_id')} "
                  f"status={op.get('status')} action={op.get('action')}"
                  + (f" cause={op.get('cause')}" if kind == "session_death"
                     else "")
                  + (" write_sent=True" if op.get("write_sent") else ""))
    print(f"write_halt={is_write_halted()} state={get_state()}")
    # W4-P2-3: surface the pre-expiry horizon on every status view so
    # the educator sees the warning before the session dies.
    _days, _near, _msg = expiry_horizon_warning()
    print(f"expiry_horizon: {_msg}")
    return True


def cmd_selftest():
    """Full drill on a SIMULATED 401. The real session is never expired.

    Snapshots pre-existing state files, runs detect -> halt -> quarantine ->
    notify -> reauth (real capture.py against the live session, principal
    pinned), then restores everything to the pre-test state.
    """
    paths = [STATE_PATH, HALT_PATH, QUAR_PATH, NOTIFY_PATH, APPROVAL_PATH,
             SESSION_PREV, SESSION_PATH]
    backups = {}
    for p in paths:
        if os.path.exists(p):
            bak = p + ".selftest-bak"
            shutil.copy2(p, bak)
            backups[p] = bak
    results = []

    def check(name, cond, detail=""):
        results.append((name, bool(cond), detail))
        print(f"{'PASS' if cond else 'FAIL'} {name} {detail}")

    try:
        # 1. detection of the live-observed 401 shape
        verdict, detection = classify_response(
            401, '{"status":"unauthenticated","errors":[{"message":"user authorization required"}]}')
        check("detect_401_unauthenticated", verdict == "expired", str(detection))

        # 2. halt + notify
        on_expiry_detected(detection, simulated=True)
        allowed, reason = check_write_allowed()
        check("halt_imposed", not allowed, reason)
        check("state_expired", get_state() == EXPIRED, get_state())
        check("notify_written", os.path.exists(NOTIFY_PATH)
              and "expired" in open(NOTIFY_PATH).read().lower())

        # 3. quarantine two in-flight ops (metadata only, never retried blind).
        # The ledger may already hold entries from earlier drills: assert
        # the two new op_ids are present and quarantined (subset check),
        # never an exact total.
        quarantine_op("selftest-op-1", "create_page", "test course page draft")
        quarantine_op("selftest-op-2", "create_assignment", "test assignment draft")
        ops = quarantined_ops()
        by_id = {o.get("op_id"): o for o in ops}
        check("quarantine_ledger",
              all(by_id.get(oid, {}).get("status") == "quarantined"
                  for oid in ("selftest-op-1", "selftest-op-2")),
              f"{len(ops)} entries total")

        # 4. reauth against the live session (capture re-runs; nothing logs out)
        ok = reauth()
        check("reauth_flow", ok)
        allowed, _ = check_write_allowed()
        check("halt_lifted", allowed and get_state() == HEALTHY,
              f"state={get_state()}")
        ops = quarantined_ops()
        by_id = {o.get("op_id"): o for o in ops}
        check("approval_rearmed",
              all(by_id.get(oid, {}).get("status") == "awaiting_approval"
                  for oid in ("selftest-op-1", "selftest-op-2"))
              and os.path.exists(APPROVAL_PATH),
              f"{len(ops)} ops total in ledger")

        # 5. 302-to-login signal also classified
        verdict2, det2 = classify_response(
            302, "", "https://school.example.edu/login")
        check("detect_302_to_login", verdict2 == "expired", str(det2))

        # 6. non-expiry responses do NOT trip the machine
        verdict3, _ = classify_response(403, '{"status":"forbidden"}')
        verdict4, _ = classify_response(200, '{"id":28206}')
        check("no_false_positive_403_200",
              verdict3 == "unknown" and verdict4 == "unknown")
    finally:
        for p, bak in backups.items():
            shutil.copy2(bak, p)
            os.remove(bak)
        for p in paths:
            if p not in backups and os.path.exists(p):
                os.remove(p)

    failed = [n for n, ok_, _ in results if not ok_]
    print(f"selftest: {len(results) - len(failed)}/{len(results)} passed"
          + (f"; FAILED: {failed}" if failed else "; state restored"))
    return not failed


def main():
    if len(sys.argv) < 2:
        print(__doc__.split("Usage:")[1].split('"""')[0] if '"""' in __doc__ else "see module docstring")
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "detect":
        cmd_detect()
    elif cmd == "check":
        sys.exit(0 if cmd_check() else 1)
    elif cmd == "quarantine":
        cmd_quarantine()
    elif cmd == "reauth":
        sys.exit(0 if reauth() else 1)
    elif cmd == "approve":
        sys.exit(0 if cmd_approve() else 1)
    elif cmd == "notify":
        sys.exit(0 if cmd_notify() else 1)
    elif cmd == "resume":
        sys.exit(0 if cmd_resume() else 1)
    elif cmd == "pin":
        sys.exit(0 if cmd_pin() else 1)
    elif cmd == "status":
        sys.exit(0 if cmd_status() else 1)
    elif cmd == "selftest":
        sys.exit(0 if cmd_selftest() else 1)
    else:
        print(f"unknown command: {cmd}")
        sys.exit(2)


if __name__ == "__main__":
    main()
