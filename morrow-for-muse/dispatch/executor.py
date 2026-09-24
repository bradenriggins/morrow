#!/usr/bin/env python3
"""
Morrow Direct dispatch executor.

Client logic that makes Morrow Direct manifest entries executable. Implements
the governance port (architecture doc sections 1.2, 2.2, 4):

  manifest digest pinning      - SHA-256 verified against the pack pin before use
  frozen write plans           - writes refuse to run without a frozen plan file
  credential injection         - slot credentials resolved from ~/.morrow/session.json
                                 at egress; cookie/token values never logged
  write halt                   - ~/.morrow/write_halt is a manual lever: when
                                 the file exists, every write is refused
                                 immediately (authority: INSTALL.md/SKILL.md)
  retry discipline             - exponential backoff with full jitter, 4 attempts
                                 max, 30 s timeout; retryable transport errors and
                                 408/429/500/502/503/504; fail fast on other 4xx;
                                 writes are never retried blindly after an
                                 uncertain response
  result bounding              - max_bytes cap, head/tail truncation, receipt
                                 extraction, redaction patterns
  verify block                 - frozen readback after writes, expect assertions
  journal                      - append-only JSONL at
                                 ~/.morrow/trees/<tree-id>/journal/ops.jsonl
                                 (per-tree; the legacy global
                                 ~/.morrow/journal/ops.jsonl is read-only
                                 for idempotency, never merged);
                                 every dispatch claims its op_id under an
                                 exclusive flock BEFORE any network call (a
                                 fsync'd WAL pending record for writes), so a
                                 crash between provider-apply and completion
                                 leaves a record, never silence; duplicate op
                                 ids are refused under the same lock; torn
                                 journal lines fail closed (JournalTorn),
                                 never silently skipped; the live journal
                                 rotates at 10 MB into journal/archive/ with a
                                 sidecar op-id index (ops.idx.json) so
                                 per-dispatch cost stays bounded
  catalog dispatch             - catalog operation descriptors run through the same
                                 pipeline as manifest entries, but only after
                                 the catalog provenance gate: the op must be
                                 marked live-proven in
                                 proof-battery/OPERATION_CATALOG.md; nothing
                                 overrides that
  undo                         - an entry's undo block runs as a new, separately
                                 journaled operation

Two backends (--backend):

  chromium Synchronous executor through the local Chromium's authenticated
           tab (transport/chromium_session.py over transport/
           local_chromium.py via CDP on 127.0.0.1:19223). This is the
           INSTALLED PRODUCT lane for Canvas/Item Banks reads and writes:
           no two-phase dance, no shell-side auth material. It reuses the
           exact governance of the https path (frozen plans, approvals,
           journaling, uncertain-write classification, verify blocks);
           the browser owns the session, so credential injection is skipped.
  https    Raw-HTTPS executor with credential injection from
           ~/.morrow/session.json. This is the RIG/PROOF lane: it exists so
           the proof battery can exercise the API contract directly. The
           installed product does not ship this lane and never holds cookie
           values (see session/capture.py and transport/README.md).

Session contract (~/.morrow/session.json, mode 0600) [RIG LANE ONLY]:

  {
    "canvas": {"base": "https://school.instructure.com",
               "pat": "<PAT, Lane 1>"},
    "quiz_api": {}
  }

Cookie-jar material (canvas.cookies) is no longer read by
any product path: the canvas_session slot was retired
2026-09-20 with the Model B removal. Anything still writing cookie values
into this file is doing so outside the product.

Credential slot resolution (pack credential_slots, kind -> session source):

  canvas_pat     -> canvas.pat            (bearer, secret)
  canvas_session -> RETIRED 2026-09-20     (Model B cookie-jar replay removed;
                                            use the chromium lane)
  local          -> refused here          (VM-local governance procedures; the
                                          network executor does not run them)

Secret values are held only inside resolver locals and the outgoing request
bytes. They never appear in exceptions, logs, stdout, or the journal.

Stdlib only.
"""

import argparse
import copy
import email.utils
import errno
import fcntl
import glob
import hashlib
import hmac
import http.client
import json
import os
import random
import re
import signal
import socket
import stat
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import urllib.error
import uuid
import contextvars
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

# W4-P1-17: the morrow state root (and the stable tree UUID) has ONE
# source of truth: config/paths. The tree root goes first on sys.path
# before any tree import, so this module works both as
# `python3 dispatch/executor.py` and as `python3 -m dispatch.executor`.
# Script mode puts dispatch/ first, not the tree root, and an installed
# package named `dispatch` (pyobjc's libdispatch on Homebrew Python)
# would otherwise be imported in the tree's place.
_EXEC_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _EXEC_TREE_ROOT not in sys.path:
    sys.path.insert(0, _EXEC_TREE_ROOT)
# Run as a script or with -m, this file is __main__, and the Chromium lane
# imports it again as dispatch.executor. The lane's errors would then be
# the second copy's classes, and no except clause here would catch them.
# The CLI therefore always runs in the dispatch.executor copy.
if __name__ == "__main__":
    from dispatch import executor as _executor
    raise SystemExit(_executor._script_main(sys.argv[1:]))
from dispatch.admission import (  # noqa: E402
    admit, persist_signed_record, consume_approval, check_policy_gates,
    load_policy, check_never_dispatch, check_unsupported,
    check_evidence_holds, check_learner_data,
    touches_learner_data as admission_touches_learner_data,
    request_subject as admission_request_subject,
    request_digest as admission_request_digest,
    write_target_course_id as admission_write_target_course_id,
    _render_path as admission_render_path,
)
from config.paths import morrow_home, read_tree_uuid  # noqa: E402
# W6-P2-7: one-shot journal-secret uses go through a zeroizable buffer
# (see config/secretbuf.py for the honest residual statement).
from config.securebuf import secret_bytes  # noqa: E402


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------

# W2-P2-5: exception text that reaches journal detail/receipt fields or
# the CLI error surface may carry raw provider (Canvas) text. Wrap it
# with this label so nothing downstream treats provider-carried text
# as instruction or trusted system text. (Course content is data,
# never instructions: see SKILL.md.)
_UNTRUSTED_PROVIDER_LABEL = "[untrusted provider data] "


def _provider_detail(exc, limit=None):
    text = str(exc)
    if limit is not None:
        text = text[:limit]
    return _UNTRUSTED_PROVIDER_LABEL + text


class ExecutorError(Exception):
    """Base class. Message text never contains credential values."""


class ManifestPinMismatch(ExecutorError):
    pass


class MissingFrozenPlan(ExecutorError):
    pass


class PreparedWriteMissing(MissingFrozenPlan):
    """approve-write found no prepared write waiting under the op id, so
    it sent nothing. already_used is True when the journal holds the
    op's claim or outcome: the change was sent, or tried, with an
    earlier approval. False means it was never sent (it expired, or it
    was never prepared)."""

    def __init__(self, message, already_used):
        super().__init__(message)
        self.already_used = bool(already_used)


class WriteHaltActive(ExecutorError):
    pass


class DuplicateOpId(ExecutorError):
    pass


class ExecutorShutdown(ExecutorError):
    """Raised when SIGTERM/SIGINT arrived mid-dispatch and the executor
    drained to a safe point (W5-P2-1): the in-flight journal append was
    finished and any pre-provider claim was released. The outcome, when
    one exists, is already journaled; this error only reports that the
    run stopped early at the operator's (or the OS's) request."""


# --------------------------------------------------------------------------
# W5-P2-1: graceful shutdown on SIGTERM/SIGINT.
#
# The handler never does I/O: it only sets _shutdown_requested (async-
# signal-safe) and returns, so a signal can never interrupt a journal
# append or a flock hold mid-write. dispatch_entry checks the flag at
# safe checkpoints: before any provider call the live claim is released
# (nothing could have applied, op_id stays reusable) and
# ExecutorShutdown is raised; after the outcome is journaled the flag
# turns the pending raise into ExecutorShutdown instead of letting the
# run continue into further provider phases. A second signal restores
# the default disposition and re-raises, so a wedged run can still be
# killed outright. Handlers are installed by main(); library callers
# that want them call _install_shutdown_handlers() themselves. The
# installer replaces only the default disposition (SIG_DFL, plus
# Python's own default_int_handler for SIGINT, which every
# interpreter installs at startup); a genuinely custom handler is
# never overridden.
# --------------------------------------------------------------------------

_shutdown_requested = False
_shutdown_signal_count = 0


def _handle_shutdown_signal(signum, frame):
    """First SIGTERM/SIGINT: arm graceful drain. Second: die now."""
    global _shutdown_requested, _shutdown_signal_count
    _shutdown_signal_count += 1
    if _shutdown_signal_count > 1:
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)
        return
    _shutdown_requested = True


def _install_shutdown_handlers():
    """Install the W5-P2-1 SIGTERM/SIGINT handlers. Idempotent; only
    replaces the default disposition (SIG_DFL, plus Python's own
    default_int_handler for SIGINT, which every interpreter installs
    at startup), never an already-custom handler; no-op outside the
    main thread (signal.signal would raise)."""
    global _shutdown_signal_count
    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                current = signal.getsignal(sig)
                if current == signal.SIG_DFL or \
                        current is signal.default_int_handler:
                    signal.signal(sig, _handle_shutdown_signal)
            except (OSError, ValueError):
                pass
    except ValueError:
        # Not the main thread: signals cannot be installed here.
        pass


def _raise_if_shutdown_requested(op_id=None, claim_token=None):
    """W5-P2-1 checkpoint: if a shutdown signal arrived, release the
    pre-provider claim when one is given (nothing was sent yet, so the
    op_id stays reusable) and raise ExecutorShutdown. Call only at safe
    points: after journaling is complete, never inside a journal append
    or between approval burn and the provider write."""
    if not _shutdown_requested:
        return
    if op_id is not None and claim_token is not None:
        try:
            release_op_id(op_id, claim_token,
                          "shutdown requested before any provider call; "
                          "claim released, op_id reusable")
        except DuplicateOpId:
            pass
    raise ExecutorShutdown(
        "shutdown requested (SIGTERM/SIGINT); drained to a safe point: "
        "any journaled outcome stands, pre-provider claims released")


class SessionMissing(ExecutorError):
    pass


class SessionHygieneError(ExecutorError):
    pass


class LocalProcedureRefused(ExecutorError):
    pass


class CallerInputError(ExecutorError):
    """A command's own JSON argument (--params, --body,
    --course-resolution) was refused before anything was sent. The text
    is Morrow's own check, never provider data."""


class ConfirmationRequired(ExecutorError):
    """A maintenance command that changes Morrow's own records was run
    without --yes and without a terminal to ask on, so it refused
    before doing anything."""


class VerificationFailed(ExecutorError):
    pass


class LearnerLabelUnresolved(ExecutorError):
    """A write named a student by a label this course never issued, or by
    an echoed name that does not match the educator's record. Nothing
    was sent (round-4 privacy audit H3c)."""


class CourseRosterUnavailable(ExecutorError):
    """The course's student list could not be read before a dispatch
    that reads or changes something in the course, so nothing in the
    course was read or changed: without it, student names in course
    content could not be hidden."""


class InvalidCourseId(ExecutorError):
    """A request names its course by something other than the course's
    Canvas number (a SIS form such as sis_course_id:BIO101). Refused
    before anything is sent; the failure catalog matches this name, as
    it does query/chain.py's refusal of the same kind."""


class RedirectDowngradeRefused(ExecutorError):
    """An https:// -> http:// redirect, or a redirect off the LMS host,
    was refused (W4-P2-7).

    The provider HTTPS lane carries bearer tokens in the Authorization
    header; silently following a downgrade would resend them over
    plaintext. Fail closed instead of trusting the redirect."""


_SESSION_DEAD_NAMES = frozenset({
    "ChromiumSessionDead",   # transport/chromium_session.py (attach/probe time)
    "BrowserSessionDead",    # transport/browser_backend.py
    "SessionDead",           # transport/local_chromium.py
})


def _is_session_dead(exc) -> bool:
    """True when exc is a lane session-death signal (no provider call was
    attempted at attach/probe time). Name-based so the executor does not
    import the lane modules: the lanes raise these only when no provider
    call was attempted, which makes the op_id safely reusable."""
    return type(exc).__name__ in _SESSION_DEAD_NAMES


def _is_stale_command(exc) -> bool:
    """True when exc is a stale-command refusal (W4-P2-1): the lane
    re-authenticated since dispatch, so the command was refused rather
    than run against the new session. The session is NOT dead; it is
    fresh. Name-based like _is_session_dead. A stale command must release
    the claim (nothing was attempted, op_id stays reusable) but must
    NEVER arm the re-auth machinery: no halt, no "re-sign in"
    notification. The educator just signed in."""
    return type(exc).__name__ == "BrowserStaleCommand"


def _uncertain_write_from_session_death(exc) -> bool:
    """True when an UncertainWrite carries session-death evidence.

    W4-P2-2: a SessionDead mid-write raises UncertainWrite on the
    Chromium lane (the effect may have applied), so the journal must
    carry the uncertain record AND the re-auth machinery must run.
    """
    if not isinstance(exc, UncertainWrite):
        return False
    for step in exc.evidence or []:
        if "sessiondead" in str((step or {}).get("detail", "")).lower():
            return True
    return False


def _on_session_death(op_id, entry_name, evidence, write_sent=False):
    """W4-P2-1: run the re-auth state machine when session death is
    detected: impose the write halt, quarantine the op, and write the
    educator notification. Runs after detection and before the original
    exception is re-raised, so the run stops loudly instead of writing
    through a half-dead session. write_sent is True when the write was
    already sent, so Canvas may hold the change.

    Lazy-imports reauth.state_machine: the state machine never imports
    the executor, so there is no import cycle. Best effort by design:
    a failure inside this helper must never mask the original dispatch
    exception, so it is contained.
    """
    try:
        from reauth import state_machine as _rsm
    except ImportError:
        return
    detection = {"provider": "chromium", "signal": "session_dead",
                 "evidence": str(evidence)[:500]}
    try:
        _rsm.on_expiry_detected(detection)
    except Exception as exc:
        print("MORROW WARNING: re-auth halt could not be imposed for op "
              "%s (%s); the original session-death error is still raised "
              "below" % (op_id, type(exc).__name__), file=sys.stderr)
    try:
        _rsm.quarantine_op(op_id, entry_name, str(evidence)[:200],
                           write_sent=write_sent)
    except Exception as exc:
        print("MORROW WARNING: op %s could not be quarantined after "
              "session death (%s); the original error is still raised "
              "below" % (op_id, type(exc).__name__), file=sys.stderr)
    # W4-P2-1: on_expiry_detected wrote the educator notification BEFORE
    # this op was quarantined, so its "N op(s) paused" count is stale.
    # Detection and quarantine still run before the raise; refresh the
    # notification so the count the educator sees includes this op.
    # W6-P1-S2: a failed educator notification used to vanish silently
    # (bare except: pass), so the educator never learned ops were
    # paused. Fail loud on stderr; the notification is also readable
    # via `state_machine.py notify` and the helper /status, so a
    # missing file is detectable, not silent.
    paused = None
    try:
        paused = _rsm.paused_ops()
        _rsm.write_notify_expired(paused)
    except Exception as exc:
        count_txt = str(len(paused)) if paused is not None \
            else "an unknown number of"
        print("MORROW WARNING: the educator notification for %s paused "
              "op(s) FAILED to write (%s); the educator may not know ops "
              "are paused. Read the quarantine directly: "
              "python3 reauth/state_machine.py status"
              % (count_txt, type(exc).__name__), file=sys.stderr)


def _on_stale_verify(op_id, entry_name, evidence):
    """W4-P2-1: a stale command during the verify readback. The write
    itself already returned 2xx and was journaled by the request phase;
    only the verify step is stale (the lane re-authenticated between
    request and verify). Quarantine the op so the verify decision gets
    explicit re-approval before re-running against the fresh session,
    but do NOT impose the write halt and do NOT send the "re-sign in"
    notification: the session is fresh. Best effort; never masks the
    original exception.
    """
    try:
        from reauth import state_machine as _rsm
    except ImportError:
        return
    try:
        _rsm.quarantine_op(op_id, entry_name, str(evidence)[:200])
    except Exception as exc:
        print("MORROW WARNING: op %s could not be quarantined after a "
              "stale verify (%s); the original error is still raised "
              "below" % (op_id, type(exc).__name__), file=sys.stderr)
    # W6-P1-S2: see _on_session_dead: never swallow a failed educator
    # notification silently.
    try:
        _rsm.write_notify_stale(len(_rsm.paused_ops()))
    except Exception as exc:
        print("MORROW WARNING: the educator notification for the stale "
              "verify of op %s FAILED to write (%s); read the quarantine "
              "directly: python3 reauth/state_machine.py status"
              % (op_id, type(exc).__name__), file=sys.stderr)


class UncertainWrite(ExecutorError):
    """A write produced an ambiguous response (timeout or 5xx with a body).
    The provider may or may not have applied the effect. The write is NOT
    retried blindly; the op is journaled as uncertain for reconciliation.

    evidence: list of per-step dicts ({step, method, url, status,
    attempts, detail}) so the journal names which step landed instead of
    a generic receipt. attempts: transport attempts made for the failing
    step. Kept as attributes (not in the message) so str(exc) stays clean.
    """

    def __init__(self, message, evidence=None, attempts=None):
        super().__init__(message)
        self.evidence = list(evidence) if evidence else []
        self.attempts = attempts


class WriteNotAttempted(ExecutorError):
    """A write failed in a way that proves the provider never saw it
    (repeated connection-refused / DNS failures across all attempts).
    Nothing was applied, so the op_id stays reusable after the claim is
    released; the failure is journaled under a fresh event id, never as
    the op's own record."""


class JournalTorn(ExecutorError):
    """A journal line failed to parse as JSON (crash-torn tail). The
    journal is fail-closed: every journal operation raises until an
    operator repairs it (executor.py journal-repair quarantines the torn
    tail). Torn lines are never silently skipped: a skipped line would
    forget an op_id and defeat DuplicateOpId replay protection."""


class JournalIntegrityError(ExecutorError):
    """A journal record or the sidecar index failed its HMAC integrity
    check, or journal/index presence is inconsistent with the sealed
    state (W4-P0-1). The journal is fail-closed: every journal operation
    raises until an operator investigates. Unlike JournalTorn (a crash
    artifact repaired by journal-repair), an integrity failure means the
    journal was modified outside the executor: restore from backup and
    reconcile the affected op against the provider; do NOT run
    journal-seal until the cause is understood, because sealing adopts
    the current bytes as the new trust anchor and would bless tampered
    state."""


class ProviderHttpError(ExecutorError):
    def __init__(self, status, message, body=None):
        super().__init__("provider HTTP %s: %s" % (status, message))
        self.status = status
        # LANE2-2: the response body (text, truncated) so the failure
        # translator can see provider error codes like
        # unprocessable_content. Never logged in full; the funnel
        # truncates and sanitizes before display.
        if isinstance(body, bytes):
            body = body.decode("utf-8", "replace")
        self.body = body[:2000] if isinstance(body, str) else None


class UnsupportedEntry(ExecutorError):
    pass


class CatalogNotProven(ExecutorError):
    """The catalog provenance gate refused a catalog dispatch: the named
    operation is not in proof-battery/OPERATION_CATALOG.md, the supplied
    method/path do not match the catalog row, or the row is not marked
    live-proven. Nothing overrides it. Never-dispatch, unsupported,
    evidence-hold, and learner-data refusals raise their own admission
    errors instead."""


class CatalogNameMismatch(CatalogNotProven):
    """The task name and the request are not one catalog row, but one of
    them is a live-proven row: an unknown name for a live-proven method
    and path, or a name paired with another row's method and path.
    Refused like any CatalogNotProven, before anything is sent;
    catalog_name, catalog_method, and catalog_path name the live-proven
    row the dispatch should use."""

    def __init__(self, message, catalog_name, catalog_method, catalog_path):
        super().__init__(message)
        self.catalog_name = catalog_name
        self.catalog_method = catalog_method
        self.catalog_path = catalog_path


class CatalogEffectMismatch(ExecutorError):
    """The caller-declared effect class contradicts the catalog row's own
    R/W column. The catalog is authoritative: a caller can never declare
    a write as a read (downgrade, which would dodge write approval) nor a
    read as a write (upgrade, which would demand an approval the row does
    not need). The dispatch is refused, loudly, at entry-build time."""


class EffectClassMismatch(ExecutorError):
    """A manifest entry's declared effect class contradicts the effect
    class derived from its own blocks (W4-P0-10). The blocks are
    authoritative: any PUT/POST/PATCH/DELETE request block (single
    request or any multi_step step) or browser-write block means the
    entry is a write, whatever the manifest's "effects" field claims.
    Same semantics as the W3-P0-6 catalog fix: the dispatch is refused,
    loudly, before any admission or write gate runs, so a write can
    never be dispatched as "read" (or "plan") to dodge write approval."""


class UndoTargetMismatch(ExecutorError):
    """An undo's target could not be bound to the op it claims to undo:
    no completed write is journaled under --of-op-id, it was a different
    entry or ran with different params, or the caller's result payload
    disagrees with that op's journaled receipt. The undo target comes
    ONLY from the journal; nothing was sent."""


class TargetIdentityMismatch(ExecutorError):
    """The write target's identity did not verify (W4-P0-11). Raised when
    the frozen plan's readback does not corroborate the plan's course_id,
    when the provider has no such course on this tenant (a typo'd
    course_id fails closed even when it names a different real course),
    or when the provider's course name/term disagrees with the frozen
    plan's declared target identity. Nothing was dispatched."""


class StaleBeforeState(ExecutorError):
    """The frozen plan's before_state_digest does not match a fresh
    provider read of the same state (W4-P1-15): the world moved since
    the plan was frozen. The write is refused; the op_id stays reusable."""


class CourseResolutionRequired(ExecutorError):
    """A mode-gated write that targets a course carried no course
    resolution, or a resolution naming a different course than the
    write targets. The mode gate's ambiguous-course check needs the
    resolution, so its absence fails closed instead of skipping that
    check."""


class TenantBindingMismatch(ExecutorError):
    """The dispatch tenant differs from the helper's configured tenant
    (W4-P1-14 / W4-P2-27): the tenant the browser is actually signed
    into, per the lane state store. Refused loudly, naming both."""


# --------------------------------------------------------------------------
# Paths and constants
# --------------------------------------------------------------------------

MORROW_HOME = morrow_home()
SESSION_PATH = os.path.join(MORROW_HOME, "session.json")
WRITE_HALT_PATH = os.path.join(MORROW_HOME, "write_halt")


def _slug_old(p):
    """Pre-W4-P2-13 slug: unbounded. Only used for the dual-lookup in
    _tree_id() so existing installs keep resolving their state dir;
    never minted for new installs. Same algorithm as
    transport/local_chromium._slug_old and helper/keepalive.sh's
    tree_id_legacy."""
    return re.sub(r"[^A-Za-z0-9]+", "_", p).strip("_").lower() or "tree"


def _slug_new(p):
    """W4-P2-13 bounded slug: <first 48 chars>-<sha256(path)[:16]>.
    Same algorithm as transport/local_chromium._slug_new and
    helper/keepalive.sh's tree_id_bounded(): max 65 chars, always
    NAME_MAX-safe."""
    s = re.sub(r"[^A-Za-z0-9]+", "_", p).strip("_").lower()
    prefix = (s[:48] or "tree")
    digest = hashlib.sha256(os.fsencode(p)).hexdigest()[:16]
    return "%s-%s" % (prefix, digest)


def _tree_id_registry_path():
    """Path of the tree-id registry (W6-P2-6).

    Maps realpath(tree_root) -> minted tree id. Lets _tree_id detect a
    previously-minted id whose .morrow-tree-id file disappeared (deletion
    or partial restore): without this, the loss silently resets the
    idempotency domain to the path slug. The registry is a detection
    aid, not a trust anchor; a missing/corrupt registry degrades to the
    legacy warn-and-slug behavior.
    """
    return os.path.join(MORROW_HOME, "trees", ".tree-id-registry.json")


def _read_tree_id_registry():
    try:
        with open(_tree_id_registry_path(), "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        if isinstance(doc, dict):
            return {str(k): str(v) for k, v in doc.items()}
    except (OSError, ValueError):
        pass
    return {}


def _write_tree_id_registry(registry):
    try:
        os.makedirs(os.path.dirname(_tree_id_registry_path()),
                    exist_ok=True)
        tmp = _tree_id_registry_path() + ".tmp.%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(registry, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, _tree_id_registry_path())
    except OSError as exc:
        sys.stderr.write(
            "morrow: WARNING: could not persist the tree-id registry: %s; "
            "a future .morrow-tree-id deletion would not be detected.\n"
            % exc)


def _tree_id():
    """Stable identity for THIS tree (the tree this file ships in).

    W4-P1-16: prefer the install-time UUID in <tree>/.morrow-tree-id
    (minted by install.sh on install and upgrade, readable before any
    path is derived), so moving or copying the tree keeps the journal
    path and op-id idempotency instead of resetting them.

    W4-P2-13: trees that predate the UUID fall back to the BOUNDED path
    slug with a loud stderr warning (matches nothing orphaned: when the
    legacy unbounded slug's state dir exists and the bounded one does
    not, the legacy slug still resolves via dual-lookup) until the
    installer/upgrade mints one.

    W6-P2-6: fail closed when a previously-minted id disappears. If
    <tree>/.morrow-tree-id is gone but the registry recorded a minted id
    for this tree root, the idempotency domain must NOT silently reset
    to the path slug (that would make every previously used op_id
    re-claimable): raise, and point at restoring the file from backup.
    A changed id for the same root is equally fatal.
    """
    tree_root = os.path.realpath(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    uid = read_tree_uuid(tree_root)
    registry = _read_tree_id_registry()
    if uid:
        prev = registry.get(tree_root)
        if prev is not None and prev != uid:
            raise RuntimeError(
                "morrow: FAIL-CLOSED: the tree id in %s changed from %s "
                "to %s for the same tree root. Refusing to run: the two "
                "ids address different idempotency domains. Restore the "
                "correct .morrow-tree-id from backup."
                % (os.path.join(tree_root, ".morrow-tree-id"), prev, uid))
        if prev != uid:
            registry[tree_root] = uid
            _write_tree_id_registry(registry)
        return uid
    remembered = registry.get(tree_root)
    if remembered:
        raise RuntimeError(
            "morrow: FAIL-CLOSED: %s is missing, but this tree previously "
            "minted id %s (recorded in the tree-id registry). The file "
            "was deleted or a partial restore dropped it. Refusing to "
            "silently reset the idempotency domain to the path slug: "
            "every previously used op_id would become re-claimable. "
            "Restore .morrow-tree-id from backup."
            % (os.path.join(tree_root, ".morrow-tree-id"), remembered))
    new = _slug_new(tree_root)
    old = _slug_old(tree_root)
    if new != old:
        if os.path.isdir(os.path.join(MORROW_HOME, "trees", old)) \
                and not os.path.isdir(os.path.join(MORROW_HOME, "trees", new)):
            sys.stderr.write(
                "morrow: WARNING: using the legacy (pre-W4-P2-13) tree "
                "slug '%s' for the existing state dir; new installs use "
                "the bounded form '%s'.\n" % (old, new))
            return old
    sys.stderr.write(
        "morrow: WARNING: %s has no .morrow-tree-id; using bounded "
        "path-slug tree id '%s'. Moving this tree resets the journal "
        "location and op-id idempotency. Run install.sh (or the next "
        "upgrade) to mint a stable tree id.\n"
        % (os.path.join(tree_root, ".morrow-tree-id"), new))
    return new


def _tree_state_dir():
    """Per-tree runtime state dir. Honors MORROW_TREE_STATE_DIR.

    W6-P2-7: the override is bound to this tree by a marker file
    <dir>/.morrow-tree-binding holding the tree id. A marker for a
    DIFFERENT tree, or existing state with no marker (stale export,
    typo'd path), fails closed instead of silently journaling into the
    wrong tree's state (or a fresh empty dir, which would reset replay
    protection). A fresh/empty dir is bound on first use.
    """
    override = os.environ.get("MORROW_TREE_STATE_DIR")
    if override:
        return _checked_override_state_dir(override)
    return os.path.join(MORROW_HOME, "trees", _tree_id())


def _checked_override_state_dir(override):
    tid = _tree_id()
    marker = os.path.join(override, ".morrow-tree-binding")
    try:
        with open(marker, "r", encoding="utf-8") as fh:
            bound = fh.read().strip()
    except OSError:
        bound = None
    if bound:
        if bound != tid:
            raise RuntimeError(
                "morrow: FAIL-CLOSED: MORROW_TREE_STATE_DIR=%s is bound "
                "to tree id %s, but this tree's id is %s. Refusing to "
                "journal into another tree's state (a stale export or a "
                "typo'd path). Unset the variable or point it at this "
                "tree's state dir." % (override, bound, tid))
        return override
    try:
        entries = os.listdir(override)
    except OSError:
        entries = []
    # A marker-less dir with existing state is not ours to claim: it is
    # either another tree's state or a stale export. Binding it would
    # silently adopt (or reset) its replay protection.
    if entries:
        raise RuntimeError(
            "morrow: FAIL-CLOSED: MORROW_TREE_STATE_DIR=%s holds existing "
            "state but no .morrow-tree-binding marker for this tree "
            "(id %s). Refusing to journal into an unbound dir. If this "
            "dir really is this tree's state, create the marker with: "
            "echo -n '%s' > %s/.morrow-tree-binding"
            % (override, tid, tid, override))
    try:
        os.makedirs(override, exist_ok=True)
        tmp = marker + ".tmp.%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(tid + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, marker)
    except OSError as exc:
        raise RuntimeError(
            "morrow: FAIL-CLOSED: cannot bind MORROW_TREE_STATE_DIR=%s "
            "to tree id %s: %s" % (override, tid, exc))
    return override


TREE_STATE_DIR = _tree_state_dir()
# W2-P1-32: the journal is per-tree/per-profile. Tenant A's op records
# never mix with tenant B's: each tree appends only to its own journal.
JOURNAL_PATH = os.path.join(TREE_STATE_DIR, "journal", "ops.jsonl")
# Legacy global journal (pre-tree-scoping). Read for idempotency, never
# merged automatically; see _journal_read_paths().
LEGACY_JOURNAL_PATH = os.path.join(MORROW_HOME, "journal", "ops.jsonl")


def _journal_read_paths():
    """Journal files consulted for reads (used_op_ids, find_journal_op).

    The tree's own journal first, then the legacy global journal when it
    exists and is a different file. Reads never mix records across
    files: each file is scanned independently and the first match wins,
    so a legacy record can satisfy idempotency without being merged
    into (or contaminating) the tree's journal.
    """
    paths = [JOURNAL_PATH]
    if (os.path.abspath(LEGACY_JOURNAL_PATH) != os.path.abspath(JOURNAL_PATH)
            and os.path.exists(LEGACY_JOURNAL_PATH)):
        paths.append(LEGACY_JOURNAL_PATH)
    return paths

DEFAULT_PACK = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "pack", "pack.json"))
# The lab pin set (stale 0.1.0 entries, kept for proof reproducibility only).
LAB_PACK = os.path.join(
    os.path.expanduser("~"),
    "workspace/connector-verification/morrow-direct-manifests/pack.json",
)

MANIFEST_CONSTANT = "morrow.manifest.v0"
REQUEST_TIMEOUT_S = 30
MAX_ATTEMPTS = 4
RETRYABLE_STATUSES = {408, 429, 500, 502, 503, 504}
DEFAULT_MAX_BYTES = 262144
# Retry-After is honored when present, but a malicious or broken provider
# must not park the educator's dispatch for hours: clamp the sleep.
RETRY_AFTER_CAP_S = 60
# Live journal rotation: keeps per-dispatch journal cost bounded while
# archives stay queryable (W2-P1-8).
JOURNAL_ROTATE_BYTES = 10 * 1024 * 1024
# W5-P1-1: archives are pruned, not kept forever. At most
# JOURNAL_ARCHIVE_MAX_COUNT archives are retained, and none older than
# JOURNAL_ARCHIVE_MAX_AGE_DAYS, so a long-lived tree's disk use stays
# bounded (and the deletion-tripwire rescan in _rebuild_index_locked
# stays O(cap) instead of O(history)). A pruned archive's op_ids move
# into the retired set first, so DuplicateOpId replay protection
# survives pruning: a retired op_id can never be re-claimed.
JOURNAL_ARCHIVE_MAX_COUNT = 10
JOURNAL_ARCHIVE_MAX_AGE_DAYS = 90
# W5-P1-1: the retired op_id set is PERMANENT (no cap). Pruned
# archives' op_ids land here so DuplicateOpId replay protection survives
# pruning forever: a retired op_id can never be re-claimed. Capping it
# would silently re-open ancient op_ids for reuse; the file grows ~37
# bytes per op_id (~13MB/year at 1000 ops/day), an acceptable cost for
# permanent replay protection. (A size warning, not a cap, guards
# against pathological growth.)
RETIRED_OPIDS_WARN_BYTES = 100 * 1024 * 1024
# Pagination: the chromium lane follows Link rel="next" for reads up to
# this many pages before flagging partial results (W2-P1-6).
PAGINATION_MAX_PAGES = 20
REDACTED = "[redacted]"


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------

def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


def digest_of(obj) -> str:
    return "sha256:" + sha256_hex(canonical(obj).encode("utf-8"))


def check_uuid(value: str) -> str:
    parsed = uuid.UUID(str(value))
    return str(parsed)


# --------------------------------------------------------------------------
# W5-P1-1 / W5-P2-3: Unicode identifier handling.
#
# Identifier comparisons (course names, terms, tenants) are normalized with
# NFKC + casefold before comparison (the UTS-39 identifier recipe):
# without this, compatibility-equivalent spellings (ligature vs letters,
# full-width vs ASCII) compare unequal, and nothing flags a visual twin.
# confusable_skeleton() additionally folds the classic cross-script
# lookalikes (Cyrillic/Greek twins of Latin letters) to one Latin
# representative per visual equivalence class, so a homoglyph name is
# detectable: skeleton("B<cy>ilogy 101") == "biology 101" while the raw
# name is not ASCII. assert_no_spoof_identifier() fails closed when a
# word of a human-reviewed name mixes scripts around such characters:
# a write gate must never bless a target whose human-readable name is a
# visual spoof.
# Multilingual names are NOT flagged: the spoof signal is a word that
# mixes Latin, Cyrillic, or Greek letters, which is the shape of the
# homoglyph attack. A Russian or Greek word next to English words (a
# bilingual course name) is not.
# --------------------------------------------------------------------------

def norm_identifier(text) -> str:
    """Canonical form for comparing human-readable identifiers (course
    names, terms): NFKC-normalize, casefold, strip."""
    return unicodedata.normalize("NFKC", str(text if text is not None else "")
                                 ).casefold().strip()


# Cross-script visual twins of Latin letters, mapped to their Latin
# representative. Cyrillic and Greek ranges only; characters without a
# Latin lookalike are absent (they cannot spoof a Latin-script name).
_CONFUSABLE_SKELETON = {
    # Cyrillic small letters
    "а": "a", "с": "c", "е": "e", "һ": "h", "і": "i", "ј": "j",
    "к": "k", "м": "m", "о": "o", "р": "p", "ѕ": "s", "х": "x",
    "у": "y", "ԝ": "w", "ԁ": "d", "ԛ": "q", "ԋ": "h", "ԏ": "t",
    "ӏ": "l", "ӕ": "ae", "ԑ": "e", "ӧ": "o", "ӱ": "y",
    # Cyrillic capital letters
    "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "І": "I",
    "Ј": "J", "К": "K", "М": "M", "О": "O", "Р": "P", "Ѕ": "S",
    "Т": "T", "Х": "X", "Ү": "Y", "Ԝ": "W", "Ԛ": "Q", "Н": "H",
    # Greek small letters
    "α": "a", "ε": "e", "η": "n", "ι": "i", "κ": "k", "μ": "m",
    "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
    "ω": "w", "ς": "s", "ζ": "z", "β": "b", "δ": "d", "λ": "l",
    "γ": "g", "φ": "f",
    # Greek capital letters
    "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I",
    "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T",
    "Υ": "Y", "Χ": "X",
}

# Script detection ranges for the mixed-script spoof signal. Only the
# letter blocks relevant to confusable detection are mapped; anything
# else with category L* counts as its own script ("Other").
_SCRIPT_RANGES = (
    ("Latin", ((0x0041, 0x007A), (0x00C0, 0x00FF), (0x0100, 0x024F),
               (0x1E00, 0x1EFF), (0x2C60, 0x2C7F))),
    ("Cyrillic", ((0x0400, 0x052F),)),
    ("Greek", ((0x0370, 0x03FF), (0x1F00, 0x1FFF))),
)


def _char_script(ch: str) -> str:
    """Best-effort script of one character: Latin/Cyrillic/Greek,
    Common (digits, space, punctuation), or Other (Han, Arabic, ...)."""
    if unicodedata.category(ch)[0] != "L":
        # Digits, marks, punctuation, spaces: script-neutral.
        return "Common"
    o = ord(ch)
    for script, ranges in _SCRIPT_RANGES:
        for lo, hi in ranges:
            if lo <= o <= hi:
                return script
    return "Other"


def confusable_skeleton(text) -> str:
    """UTS-39-style skeleton: fold confusable characters to one
    representative per visual equivalence class, then norm_identifier."""
    normed = unicodedata.normalize(
        "NFKC", str(text if text is not None else ""))
    return "".join(
        _CONFUSABLE_SKELETON.get(ch, ch) for ch in normed
    ).casefold().strip()


_TWIN_SCRIPTS = frozenset({"Latin", "Cyrillic", "Greek"})


def _mixed_word_hits(word):
    """The confusable characters of one word when that word mixes Latin,
    Cyrillic, or Greek letters; [] for a single-script word."""
    scripts = {_char_script(ch) for ch in word} & _TWIN_SCRIPTS
    if len(scripts) < 2:
        return []
    return [(ch, _CONFUSABLE_SKELETON[ch])
            for ch in word if ch in _CONFUSABLE_SKELETON]


def spoof_characters(text):
    """Characters with a cross-script visual twin inside a word that mixes
    scripts (the homoglyph-attack shape, UTS #39 mixed-script words).

    Returns [(char, latin_twin), ...]. Words are runs of letters and
    marks. A word that mixes Latin, Cyrillic, or Greek letters
    ("Вiology" with a Cyrillic В) is a spoof; single-script words are
    not, whatever sits next to them, so a bilingual name ("Русский язык
    (Russian Language I)") or a Greek letter as its own word
    ("Statistics: μ and σ") returns []."""
    normed = unicodedata.normalize(
        "NFKC", str(text if text is not None else ""))
    hits, word = [], []
    for ch in normed + " ":
        if unicodedata.category(ch)[0] in ("L", "M"):
            word.append(ch)
            continue
        if word:
            hits.extend(_mixed_word_hits(word))
            word = []
    return hits


def assert_no_spoof_identifier(text, role: str) -> None:
    """Fail closed on a homoglyph-spoof identifier (W5-P1-1).

    Raises TargetIdentityMismatch naming the offending characters with
    code points, so the refusal is unambiguous even when the glyphs
    render pixel-identical to a human reviewer."""
    hits = spoof_characters(text)
    if hits:
        shown = ", ".join(
            "U+%04X (%r, looks like %r)" % (ord(c), c, twin)
            for c, twin in hits[:8])
        raise TargetIdentityMismatch(
            "refusing: the %s %r contains characters with cross-script "
            "visual twins (%s). A homoglyph twin passes every automated "
            "name check while looking identical to a human reviewer; "
            "verify the numeric course_id out of band before proceeding."
            % (role, text, shown))


# --------------------------------------------------------------------------
# W5-P2-2: structural HTTP header validation.
# --------------------------------------------------------------------------

_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_HEADER_BAD_VALUE_RE = re.compile(r"[\x00-\x1f\x7f]")


def validate_http_header(name, value, *, where: str = "header"):
    """Structural validation of one HTTP header name/value pair.

    Rejects non-token header names and any C0 control, DEL, or CRLF in
    the value (the response-splitting / request-smuggling shape). The
    HTTPS lane's stdlib already refuses these at send time; this makes
    the guarantee structural at build/plan time instead of incidental,
    and covers the browser fetch lane whose enforcement would otherwise
    be whatever the page's JS Fetch implementation does. Raises
    ExecutorError. Returns (name, value) unchanged on success."""
    name = str(name)
    if not _HEADER_NAME_RE.match(name):
        raise ExecutorError(
            "refusing %s: invalid header name %r (not an RFC 7230 token)"
            % (where, name))
    value = str(value)
    if _HEADER_BAD_VALUE_RE.search(value):
        raise ExecutorError(
            "refusing %s %r: control characters (CR/LF/C0/DEL) in the "
            "header value" % (where, name))
    return name, value


# --------------------------------------------------------------------------
# W5-P2-5: static safety screen for agent-authored regexes.
# --------------------------------------------------------------------------

_REDACT_PATTERN_MAX_LEN = 500


def _quantified_alternation_safe(inner: str) -> bool:
    """True when a quantified group's top-level alternation cannot
    backtrack catastrophically: every branch is one distinct literal
    character, e.g. (a|b)+. Anything else with a top-level | under a
    quantifier is refused (conservative): (a|aa)+ is the classic ReDoS
    shape, and redact patterns never need quantified alternation with
    multi-character or overlapping branches."""
    branches, depth, cur = [], 0, []
    i, n = 0, len(inner)
    while i < n:
        ch = inner[i]
        if ch == "\\":
            cur.append(inner[i:i + 2])
            i += 2
            continue
        if ch == "[":
            j = i + 1
            if j < n and inner[j] == "^":
                j += 1
            if j < n and inner[j] == "]":
                j += 1
            while j < n and inner[j] != "]":
                j += 2 if inner[j] == "\\" else 1
            cur.append(inner[i:j + 1])
            i = j + 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif ch == "|" and depth == 0:
            branches.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(ch)
        i += 1
    branches.append("".join(cur))
    if len(branches) < 2:
        return True
    seen = set()
    for b in branches:
        if len(b) != 1 or not b.isalnum() or b in seen:
            return False
        seen.add(b)
    return True


def assert_regex_safe(pattern: str, *, where: str = "redact pattern") -> str:
    """Static safety screen for regexes compiled from agent-authored input
    (manifest `redact` lists, W5-P2-5).

    Rejects the catastrophic-backtracking shapes: a quantifier applied
    to a group that itself contains a quantifier ((a+)+, (\\w+)*,
    (a|b+)+), a quantifier applied to a group whose top-level
    alternation branches overlap ((a|aa)+), and over-long patterns.
    Linear constructs pass: single-atom quantification (a+, [ab]*),
    lazy modifiers, bounded {m,n} repeats, and quantified alternation
    over single distinct characters ((a|b)+). Raises ExecutorError
    naming the pattern. Returns the pattern unchanged on success."""
    p = str(pattern)
    if len(p) > _REDACT_PATTERN_MAX_LEN:
        raise ExecutorError(
            "refusing %s %r: pattern exceeds %d characters"
            % (where, p[:60], _REDACT_PATTERN_MAX_LEN))
    # Mini-parser: one frame per open group; frame["quant"] records
    # whether any quantifier appears inside the group (propagated outward
    # on close, so ((a+))+ is caught too).
    frames = [{"quant": False}]
    last_group = None  # frame of the most recently closed group
    last_atom = None   # "group" | "atom" | "class" | None
    i, n = 0, len(p)
    while i < n:
        ch = p[i]
        if ch == "\\":
            i += 2
            last_atom, last_group = "atom", None
            continue
        if ch == "[":
            i += 1
            if i < n and p[i] == "^":
                i += 1
            if i < n and p[i] == "]":
                i += 1
            while i < n and p[i] != "]":
                if p[i] == "\\":
                    i += 2
                else:
                    i += 1
            i += 1  # consume "]"
            last_atom, last_group = "class", None
            continue
        if ch == "(":
            if p.startswith("(?#", i):
                end = p.find(")", i + 3)
                i = n if end == -1 else end + 1
                continue
            frames.append({"quant": False, "start": None, "inner": None})
            i += 1
            # Consume group prefixes: (?: ?P<name> ?= ?! ?<= ?<!.
            if i < n and p[i] == "?":
                i += 1
                if i < n and p[i] == "P" and i + 1 < n and p[i + 1] == "<":
                    end = p.find(">", i + 2)
                    i = n if end == -1 else end + 1
                elif i + 1 < n and p[i] in ("=", "!") :
                    i += 1
                elif (i + 2 < n and p[i] == "<"
                      and p[i + 1] in ("=", "!")):
                    i += 2
                elif i < n and p[i] == ":":
                    i += 1
            frames[-1]["start"] = i
            last_atom, last_group = None, None
            continue
        if ch == ")":
            if len(frames) > 1:
                closed = frames.pop()
                if closed["quant"]:
                    frames[-1]["quant"] = True
                if closed["start"] is not None:
                    closed["inner"] = p[closed["start"]:i]
                last_atom, last_group = "group", closed
            else:
                last_atom, last_group = None, None
            i += 1
            continue
        if ch in "*+?":
            if ch == "?" and last_atom is None:
                # "?" with no preceding atom is a lazy marker only when it
                # follows a quantifier; anything else is a compile error
                # the re module will report.
                i += 1
                continue
            if last_atom == "group" and last_group is not None \
                    and last_group["quant"]:
                raise ExecutorError(
                    "refusing %s %r: nested quantifier (a quantifier "
                    "applied to a group that itself contains a "
                    "quantifier) risks catastrophic backtracking"
                    % (where, p[:80]))
            if last_atom == "group" and last_group is not None \
                    and last_group.get("inner") is not None \
                    and not _quantified_alternation_safe(
                        last_group["inner"]):
                raise ExecutorError(
                    "refusing %s %r: quantifier applied to a group with "
                    "overlapping alternation branches ((a|aa)+) risks "
                    "catastrophic backtracking"
                    % (where, p[:80]))
            frames[-1]["quant"] = True
            i += 1
            if i < n and p[i] == "?":
                i += 1  # lazy modifier, not a nested quantifier
            last_atom, last_group = None, None
            continue
        if ch == "{":
            m = re.match(r"\{(\d+)(,(\d*)?)?\}", p[i:])
            if m:
                if last_atom == "group" and last_group is not None \
                        and last_group["quant"]:
                    raise ExecutorError(
                        "refusing %s %r: nested quantifier (bounded "
                        "repeat applied to a group that itself contains "
                        "a quantifier) risks catastrophic backtracking"
                        % (where, p[:80]))
                if last_atom == "group" and last_group is not None \
                        and last_group.get("inner") is not None \
                        and not _quantified_alternation_safe(
                            last_group["inner"]):
                    raise ExecutorError(
                        "refusing %s %r: bounded repeat applied to a "
                        "group with overlapping alternation branches "
                        "risks catastrophic backtracking"
                        % (where, p[:80]))
                frames[-1]["quant"] = True
                i += m.end()
                if i < n and p[i] == "?":
                    i += 1
                last_atom, last_group = None, None
                continue
            i += 1
            last_atom = "atom"
            continue
        if ch in "|^$":
            last_atom, last_group = None, None
            i += 1
            continue
        last_atom, last_group = "atom", None
        i += 1
    return p


def _checked_op_id(op_id) -> str:
    """W5-P2-1: op_ids reaching the journal claim API or the
    browser-backend path builders must be UUIDs. Anything else fails
    closed here instead of becoming a path-traversal primitive
    downstream (op_id is interpolated into brief/pending filenames)."""
    try:
        return check_uuid(op_id)
    except ValueError:
        raise ExecutorError(
            "refusing op_id %r: not a valid UUID" % (op_id,))


# --------------------------------------------------------------------------
# Response path navigation: "[0].data", "discussions[0].subject", "token"
# --------------------------------------------------------------------------

_PATH_TOKEN = re.compile(r"\[(\d+)\]|([^.\[\]]+)")


def resolve_path(payload, path: str):
    if not path:
        return payload
    current = payload
    for match in _PATH_TOKEN.finditer(path):
        index, key = match.group(1), match.group(2)
        if index is not None:
            if not isinstance(current, (list, tuple)):
                raise ExecutorError("response_path %r hit non-list" % path)
            current = current[int(index)]
        else:
            if not isinstance(current, dict):
                raise ExecutorError("response_path %r hit non-object" % path)
            if key not in current:
                raise ExecutorError("response_path %r missing key %r" % (path, key))
            current = current[key]
    return current


# --------------------------------------------------------------------------
# Redaction
# --------------------------------------------------------------------------

# Global default redact patterns (desktop defect audit item 15, 2026-09-20):
# secret-ish key names masked in EVERY receipt and every stored provider
# payload, regardless of what an entry's manifest declares. A per-entry
# "redact" list only ADDS on top; it can never remove these. This closes
# the opt-in gap where an entry with no redact patterns journals a full
# provider response body (e.g. Canvas secure_params signed LTI tokens,
# Moodle login tokens, sesskey values) as its receipt. Masking a
# non-secret that happens to contain one of these substrings is the
# accepted tradeoff; the direction is less retention, not more.
DEFAULT_REDACT_PATTERNS = [
    "secure_params", "sesskey", "authenticity_token",
    "access_token", "refresh_token", "id_token", "token",
    "secret", "password", "passwd", "credential",
    "api_key", "apikey", "client_secret", "private_key",
    "cookie", "session", "authorization",
]


def redact_payload(obj, patterns):
    """Mask values of keys matching any pattern (case-insensitive regex),
    and secrets hiding inside ordinary string values (W2-P2-2: a token in
    a URL query string is not saved by key-name matching)."""
    if not patterns:
        return obj
    # W5-P2-5: manifest `redact` lists are agent-authored; screen every
    # pattern for the catastrophic-backtracking shape before compiling.
    compiled = [re.compile(assert_regex_safe(p), re.IGNORECASE)
                for p in patterns]

    def walk(node):
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                if any(c.search(str(k)) for c in compiled):
                    out[k] = REDACTED
                else:
                    out[k] = walk(v)
            return out
        if isinstance(node, list):
            return [walk(v) for v in node]
        if isinstance(node, str):
            return _redact_secret_values(node)
        return node

    return walk(obj)


# W2-P2-2: secret-shaped values inside ordinary strings. Key-name
# redaction misses these (e.g. "https://host/path?token=abc123" stored
# under an innocent key like "url" or "detail"). Only the secret portion
# is masked; the surrounding string survives so the record stays useful.
# Patterns are deliberately narrow (known param names, bearer scheme,
# JSON-ish key: value) to avoid mangling prose that merely mentions the
# word "token".
_SECRET_VALUE_RES = (
    # query-string / form-ish: ?token=abc, &access_token=abc, ;session=abc
    (re.compile(r"([?&;](?:access_token|id_token|refresh_token|token|"
                r"api_key|apikey|client_secret|secret|password|passwd|"
                r"session|auth)\b[^=]*=)([^&#\s'\"]+)", re.IGNORECASE),
     r"\1" + REDACTED),
    # Authorization: Bearer <token>
    (re.compile(r"(\bbearer\s+)[A-Za-z0-9\-._~+/=]+", re.IGNORECASE),
     r"\1" + REDACTED),
    # JSON-ish inside a string: {"canvas_session": "abc"}, 'token'='abc'
    (re.compile(r"([\"'](?:access_token|id_token|refresh_token|token|"
                r"api_key|apikey|client_secret|secret|password|passwd|"
                r"session|canvas_session)[\"']\s*[:=]\s*[\"']?)"
                r"([^\"'\s,};&]+)", re.IGNORECASE),
     r"\1" + REDACTED),
)


def _redact_secret_values(text: str) -> str:
    """Mask secret-shaped substrings inside an ordinary string value."""
    for rx, repl in _SECRET_VALUE_RES:
        text = rx.sub(repl, text)
    return text


def _redacted_url(url: str) -> str:
    """Strip query and fragment from a URL for journal evidence: tokens
    in query strings must never reach the journal, even redacted inline."""
    try:
        parts = urllib.parse.urlsplit(url or "")
        return urllib.parse.urlunsplit(
            (parts.scheme, parts.netloc, parts.path, "", ""))
    except Exception:
        return ""


# --------------------------------------------------------------------------
# Pack loading and digest pin verification
# --------------------------------------------------------------------------

def load_pack(pack_path: str) -> dict:
    with open(pack_path, "r", encoding="utf-8") as fh:
        pack = json.load(fh)
    return pack


def find_pin(pack: dict, entry_name: str):
    for e in pack.get("entries", []):
        if e.get("name") == entry_name:
            return e
    return None


def load_manifest_entry(entry_path: str, pack: dict) -> dict:
    """Load one manifest entry JSON and verify its SHA-256 against the pack pin."""
    with open(entry_path, "rb") as fh:
        raw = fh.read()
    entry = json.loads(raw.decode("utf-8"))
    if entry.get("manifest") != MANIFEST_CONSTANT:
        raise ManifestPinMismatch(
            "entry manifest marker is %r, expected %r; refusing to load"
            % (entry.get("manifest"), MANIFEST_CONSTANT)
        )
    pin = find_pin(pack, entry.get("name"))
    if pin is None:
        raise ManifestPinMismatch(
            "entry name %r is not pinned in the pack; refusing to run" % entry.get("name")
        )
    actual = sha256_hex(raw)
    if actual != pin.get("sha256"):
        raise ManifestPinMismatch(
            "digest mismatch for %r: pack pins %s, file is %s; refusing to run"
            % (entry.get("name"), pin.get("sha256"), actual)
        )
    return entry


# --------------------------------------------------------------------------
# Frozen plan
# --------------------------------------------------------------------------

class FrozenPlan:
    REQUIRED = ("op_id", "entry_name", "params", "before_state_digest", "frozen_readback")
    # Optional. Declares the human-meaningful write target the educator
    # reviewed: {"course_id": ..., "course_name": ..., "term": ...}.
    # W4-P0-11: when present, the dispatch-time target identity precheck
    # verifies the provider's course name/term against it and refuses on
    # mismatch; the approval record also carries it so the educator sees
    # the target they are signing for.
    # Optional (round-4 H1). "request" + "request_digest": the exact
    # request (admission.request_subject) the plan was frozen for. When
    # present, a dispatch whose request or params differ is refused
    # (plan-write always writes them).

    def __init__(self, data: dict, path: str):
        missing = [k for k in self.REQUIRED if k not in data]
        if missing:
            raise MissingFrozenPlan("frozen plan %s missing fields: %s" % (path, missing))
        self.op_id = check_uuid(data["op_id"])
        self.entry_name = data["entry_name"]
        self.params = data["params"]
        self.before_state_digest = data["before_state_digest"]
        self.frozen_readback = data["frozen_readback"]
        target_identity = data.get("target_identity")
        if target_identity is not None:
            if not isinstance(target_identity, dict):
                raise MissingFrozenPlan(
                    "frozen plan %s: target_identity must be an object, got %r"
                    % (path, type(target_identity).__name__))
            for key in ("course_id", "course_name", "term"):
                value = target_identity.get(key)
                if value is not None and not isinstance(value, (str, int, float)):
                    raise MissingFrozenPlan(
                        "frozen plan %s: target_identity.%s must be a scalar, got %r"
                        % (path, key, type(value).__name__))
        self.target_identity = dict(target_identity) if target_identity else {}
        self.request_digest = data.get("request_digest")
        self.learner_tokens = {}
        if self.request_digest is not None:
            request = data.get("request")
            if not isinstance(request, dict) or \
                    admission_request_digest(request) != self.request_digest:
                raise MissingFrozenPlan(
                    "frozen plan %s: request does not match its "
                    "request_digest" % path)
            tokens = request.get("learner_tokens") or {}
            if not isinstance(tokens, dict):
                raise MissingFrozenPlan(
                    "frozen plan %s: learner_tokens must be an object"
                    % path)
            self.learner_tokens = dict(tokens)
        self.path = path
        self.digest = digest_of(data)


def load_frozen_plan(path: str, expected_entry_name: str = None) -> FrozenPlan:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    plan = FrozenPlan(data, path)
    if expected_entry_name and plan.entry_name != expected_entry_name:
        raise MissingFrozenPlan(
            "frozen plan names entry %r, executor was asked for %r"
            % (plan.entry_name, expected_entry_name)
        )
    return plan


# --------------------------------------------------------------------------
# Session store (egress credential injection)
# --------------------------------------------------------------------------

class SessionStore:
    """Holds the raw session contract in memory only. Values are never logged,
    never placed in exception messages, and never written to the journal."""

    def __init__(self, session: dict):
        self._session = session

    @classmethod
    def load(cls, path: str = SESSION_PATH) -> "SessionStore":
        if not os.path.exists(path):
            raise SessionMissing(
                "no session at %s (rig-lane session store; the installed "
                "product uses the chromium lane and needs no session file)" % path
            )
        mode = stat.S_IMODE(os.stat(path).st_mode)
        if mode & 0o077:
            raise SessionHygieneError(
                "session file %s has mode %o; expected 0600. Refusing to use it." % (path, mode)
            )
        try:
            with open(path, "r", encoding="utf-8") as fh:
                session = json.load(fh)
        except (OSError, ValueError) as exc:
            raise SessionMissing("session file unreadable (%s); treating as absent" % exc)
        return cls(session)

    # -- slot material ----------------------------------------------------

    def slot_secret(self, slot: str):
        """Return (is_secret, material) for a credential slot, or raise."""
        s = self._session
        if slot == "canvas_pat":
            pat = ((s.get("canvas") or {}).get("pat"))
            if not pat:
                raise SessionMissing("slot canvas_pat has no material in the session")
            return True, pat
        if slot == "canvas_session":
            raise ExecutorError(
                "slot 'canvas_session' is retired (Model B cookie-jar replay "
                "was removed 2026-09-20; the installed product uses the "
                "chromium lane, which never holds cookie values)")
        if slot == "local":
            raise LocalProcedureRefused("slot 'local' holds no provider credential")
        raise SessionMissing("unknown credential slot %r" % slot)

    def base_for(self, provider: str) -> str:
        base = ((self._session.get(provider) or {}).get("base"))
        if not base:
            raise SessionMissing("session has no base URL for provider %r" % provider)
        return base.rstrip("/")

    def raw_request(self, method: str, url: str, headers: dict, body_bytes,
                    is_write: bool = False, max_bytes: int = None):
        """Egress for one provider call: the shared retry discipline.

        Session objects for other backends (e.g. the Chromium lane) expose
        the same method with their own egress; the dispatch pipeline calls
        only this, never request_with_retry directly.
        """
        return request_with_retry(method, url, headers, body_bytes,
                                  is_write=is_write, max_bytes=max_bytes)


def inject_cookie_header(cookies: dict) -> str:
    return "; ".join("%s=%s" % (k, v) for k, v in cookies.items())


# --------------------------------------------------------------------------
# Journal (append-only JSONL, op-id claims under an exclusive flock)
#
# Write-integrity design (W2-P0-1/2/3/4/18, W2-P1-8, W2-P2-10):
#
# - Every dispatch CLAIMS its op_id under an exclusive flock BEFORE any
#   network call: a fsync'd WAL record (wal="pending" for writes,
#   wal="claimed" for reads). A SIGKILL between provider-apply and the
#   completion record leaves the pending record, never silence; a later
#   dispatch of the same op_id raises DuplicateOpId naming the pending
#   op for reconciliation instead of re-applying it.
# - The check and the append are one locked operation: two processes can
#   never both pass the guard for the same op_id.
# - Torn journal lines fail closed (JournalTorn): they are quarantined,
#   never silently skipped, so a torn tail cannot defeat DuplicateOpId.
# - Appends are a single os.write() with O_APPEND plus fsync: one
#   syscall per record, no interleave under concurrency.
# - The live journal rotates at JOURNAL_ROTATE_BYTES into journal/archive/
#   with a sidecar index (ops.idx.json) mapping every known op_id to its
#   file, so used_op_ids() stays O(index) instead of O(journal).
# - A claim can be RELEASED (release_op_id) when the failure proves the
#   provider never saw the op (prevalidation refusal, 4xx fail-fast,
#   repeated pre-send transport failures, session death before any
#   provider call). The release is itself journaled; the op_id becomes
#   reusable. Anything ambiguous stays claimed: reconcile, don't replay.
#
# Tamper-integrity design (W4-P0-1, W4-P0-2, W4-P2-6):
#
# - Every journal record carries rec_hmac = HMAC-SHA256(tree_secret,
#   canonical_record_bytes), computed over the canonical record with the
#   hmac field itself excluded. The per-tree secret is minted on first
#   journal use and stored 0600 at <journal-dir>/ops.secret. Every read
#   path verifies: a record that fails verification raises
#   JournalIntegrityError (fail closed), never silently skipped or
#   trusted. Forged appends and in-place edits are detected, loudly.
# - The sidecar index is HMAC'd as a whole (index_hmac) and verified
#   before its journal_size/op_ids are trusted: a forged index fails
#   closed instead of being trusted. A missing index alongside an
#   existing journal fails closed too (a crash between the journal
#   append and the index write is indistinguishable from index
#   deletion); journal-seal rebuilds the index once the journal
#   verifies. On rescan after shrinkage, op_ids the sealed index places
#   in the live journal must still be present in the journal or an
#   archive, or the rescan fails closed: cleanly deleted lines are
#   detected, not absorbed.
# - Claim tokens are never stored in the clear: the journal keeps only
#   token_hash = SHA256(token). The claimant holds the raw token in
#   memory (and in its 0600 pending envelope) and presents it;
#   release_op_id/recheck_claim hash the presented value and compare. A
#   journal read alone can therefore neither adopt nor free a foreign
#   claim. Documented non-boundary: a process that can read the
#   claimant's memory (ptrace, same-uid) recovers the raw token;
#   same-uid memory is not a security boundary on this box.
# - The flock is advisory (W4-P2-6): it is a crash/race boundary among
#   cooperating writers, never a security boundary. A local writer that
#   simply never takes the lock is not stopped by it. The tamper
#   boundary is the per-record HMAC plus the sealed sidecar index: an
#   unlocked writer's forged, edited, or deleted records fail closed
#   with JournalIntegrityError on the next read, loudly, instead of
#   being trusted.
# - Upgrade path: journals written before the integrity seal fail closed
#   on first open (never silently trusted). The explicit, documented
#   re-seal step is `python3 dispatch/executor.py journal-seal`, which
#   adopts the current journal bytes as the trust anchor. Sealing cannot
#   detect tampering that predates the seal: reconcile in-flight ops
#   against the provider first.
# --------------------------------------------------------------------------

_JOURNAL_LOCK_NAME = "ops.lock"
_JOURNAL_INDEX_NAME = "ops.idx.json"
_JOURNAL_ARCHIVE_DIR = "archive"
# v2 (2026-09-21, W4-P0-1): the index carries index_hmac, verified by
# _read_index before journal_size/op_ids are trusted. v1 indexes are
# treated as absent; with a journal present that fails closed and points
# at journal-seal (never silently trusted).
_JOURNAL_INDEX_VERSION = 2
_JOURNAL_SECRET_NAME = "ops.secret"
_JOURNAL_HMAC_PREFIX = "hmac-sha256:"


def _journal_lock_path():
    return os.path.join(os.path.dirname(JOURNAL_PATH), _JOURNAL_LOCK_NAME)


def _journal_index_path():
    return os.path.join(os.path.dirname(JOURNAL_PATH), _JOURNAL_INDEX_NAME)


def _journal_archive_dir():
    return os.path.join(os.path.dirname(JOURNAL_PATH), _JOURNAL_ARCHIVE_DIR)


def _journal_secret_path():
    return os.path.join(os.path.dirname(JOURNAL_PATH), _JOURNAL_SECRET_NAME)


def _parse_secret_doc(doc):
    if isinstance(doc, dict):
        secret_hex = doc.get("secret")
        if isinstance(secret_hex, str) and len(secret_hex) >= 32:
            try:
                return bytes.fromhex(secret_hex)
            except ValueError:
                return None
    return None


def _parse_secret_keyring(doc):
    """Parse the journal secret file into a keyring.

    v2 (rotatable): {"version": 2, "active": "<kid>",
                     "keys": {"<kid>": "<64hex>", ...}}.
    v1 (legacy): {"version": 1, "secret": "<hex>"} -> single-key keyring
    with kid "v1". Returns {"active": kid, "keys": {kid: bytes}} or None
    on any malformed document. W6-P1-2: seals verify against EVERY key
    in the ring (so pre-rotation records keep verifying after a
    rotation); new seals always use the ACTIVE key.
    """
    if not isinstance(doc, dict):
        return None
    if doc.get("version") == 2:
        active = doc.get("active")
        keys = doc.get("keys")
        if not isinstance(active, str) or not isinstance(keys, dict):
            return None
        parsed = {}
        for kid, hexval in keys.items():
            if not isinstance(kid, str) or not isinstance(hexval, str):
                return None
            try:
                key = bytes.fromhex(hexval)
            except ValueError:
                return None
            if len(key) != 32:
                return None
            parsed[kid] = key
        if active not in parsed:
            return None
        retired_at = doc.get("retired_at", {})
        if not isinstance(retired_at, dict) or not all(
                isinstance(k, str) and isinstance(v, str)
                for k, v in retired_at.items()):
            return None
        return {"active": active, "keys": parsed, "retired_at": retired_at}
    secret = _parse_secret_doc(doc)
    if secret is None or len(secret) != 32:
        return None
    return {"active": "v1", "keys": {"v1": secret}, "retired_at": {}}


def _read_secret_keyring():
    """The tree's journal HMAC keyring, or None when not yet minted."""
    try:
        with open(_journal_secret_path(), "r", encoding="utf-8") as fh:
            return _parse_secret_keyring(json.load(fh))
    except (OSError, ValueError):
        return None


def _read_secret_or_none():
    """The tree's ACTIVE journal HMAC secret, or None when not yet minted.

    Verification paths should use _read_secret_keyring instead: after a
    rotation (W6-P1-2) older records verify under retired keys.
    """
    ring = _read_secret_keyring()
    if ring is None:
        return None
    return ring["keys"][ring["active"]]


def _have_secret():
    return os.path.exists(_journal_secret_path())


def _writer_tmp_suffix():
    """W5-P2-2: unique-per-writer tmp suffix. The pid alone is not
    enough: threads in one process share a pid, so two threads
    staging the same file would share one tmp path (one thread's
    os.replace can steal the tmp while the other is mid-write).
    Thread ident makes the staging name unique per writer."""
    import threading as _th
    return "%d.%d" % (os.getpid(), _th.get_ident())


def _open_secret_tmp(tmp_path):
    """W6-P2-2: open a staging file for secret bytes, 0600 ATOMICALLY.

    The old pattern (open(tmp, "w") -> write -> os.chmod(tmp, 0o600))
    left the raw key bytes world-readable under a standard 022 umask
    between creation and the chmod: a local process watching the
    directory could scoop the key in that window. os.open with an
    explicit 0o600 mode never creates the file group/other-readable.
    O_EXCL keeps two writers from sharing one staging path; a stale
    tmp from a crashed pid-reuse is unlinked and retried once."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        return os.open(tmp_path, flags, 0o600)
    except FileExistsError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return os.open(tmp_path, flags, 0o600)


def _load_or_mint_secret():
    """Return the tree's journal HMAC secret, minting it on first use.

    The secret is per-tree (it lives next to the tree's journal) and is
    stored 0600. It authenticates every journal record and the sidecar
    index (W4-P0-1). Callers hold the journal lock, so the mint is
    atomic (tmp file + rename + fsync)."""
    secret = _read_secret_or_none()
    if secret is not None:
        return secret
    import secrets as _secrets
    raw = _secrets.token_bytes(32)
    path = _journal_secret_path()
    tmp = path + ".tmp." + _writer_tmp_suffix()
    # W6-P2-2: 0600 at open, never open-then-chmod (the raw key must
    # never be world-readable, even briefly).
    fd = _open_secret_tmp(tmp)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(canonical({"version": 1, "secret": raw.hex()}) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    try:
        dfd = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass
    return raw


def _journal_secret_ctx():
    """W6-P2-7: the ACTIVE journal secret as a zeroizable buffer.

    Use as `with _journal_secret_ctx() as s:` and pass s.view() to
    hmac; the buffer is overwritten on block exit. The journal secret
    is already read fresh from disk per operation; this keeps even
    that transient copy from lingering as an immutable bytes object.
    """
    return secret_bytes(_load_or_mint_secret())


def _seal_record(record, secret):
    """Attach rec_hmac to a record, in place (W4-P0-1).

    The HMAC covers the canonical record bytes with the hmac field
    itself excluded, so verification recomputes over the same bytes."""
    body = {k: v for k, v in record.items() if k != "rec_hmac"}
    mac = hmac.new(secret, canonical(body).encode("utf-8"),
                   hashlib.sha256).hexdigest()
    record["rec_hmac"] = _JOURNAL_HMAC_PREFIX + mac
    return record


def _record_seal_valid(rec, secret):
    """True when the record carries a rec_hmac that verifies."""
    mac = rec.get("rec_hmac")
    if not isinstance(mac, str) or not mac.startswith(_JOURNAL_HMAC_PREFIX):
        return False
    body = {k: v for k, v in rec.items() if k != "rec_hmac"}
    expect = hmac.new(secret, canonical(body).encode("utf-8"),
                      hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac[len(_JOURNAL_HMAC_PREFIX):], expect)


def _record_seal_valid_any(rec, keyring):
    """W6-P1-2: True when rec_hmac verifies under ANY key in the ring.

    Rotation retires keys for sealing but keeps them for verification,
    so records sealed before a rotation keep verifying afterwards.
    """
    if not keyring:
        return False
    return any(_record_seal_valid(rec, key)
               for key in keyring["keys"].values())


def _write_secret_keyring_locked(ring):
    """Atomically persist a keyring doc (0600 at open, W6-P2-2).

    Callers hold the journal lock."""
    path = _journal_secret_path()
    tmp = path + ".tmp." + _writer_tmp_suffix()
    doc = {"version": 2, "active": ring["active"],
           "keys": {kid: key.hex() for kid, key in ring["keys"].items()},
           "retired_at": ring.get("retired_at", {})}
    fd = _open_secret_tmp(tmp)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(canonical(doc) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    try:
        dfd = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def rotate_journal_secret():
    """W6-P1-2: rotate the tree's journal HMAC secret.

    Mints a fresh 256-bit key, makes it the ACTIVE sealing key, and
    keeps the retired keys in the keyring for verification: every
    record sealed before the rotation keeps verifying, so rotation is
    no longer operationally punitive (the old "re-mint breaks every
    seal" trap). New records seal under the new key immediately.
    Returns the new key id. The caller must hold the journal lock OR
    call this from a single operator process (the CLI takes the lock).
    """
    import secrets as _secrets
    ring = _read_secret_keyring()
    if ring is None:
        _load_or_mint_secret()
        ring = _read_secret_keyring()
    kid = "k%d" % (len(ring["keys"]) + 1)
    while kid in ring["keys"]:
        kid = "k" + _secrets.token_hex(4)
    old_active = ring["active"]
    ring["keys"][kid] = _secrets.token_bytes(32)
    ring["active"] = kid
    # W6-P1-2: stamp when the demoted key was retired, so a later
    # retire-secret has a forensic timeline (and the operator can tell
    # how long a possibly-compromised key stayed verify-capable).
    ring.setdefault("retired_at", {})[old_active] = \
        datetime.now(timezone.utc).isoformat()
    _write_secret_keyring_locked(ring)
    return kid


def _verify_record(path, lineno, rec, keyring):
    """Raise JournalIntegrityError when a journal record is unsealed or
    its HMAC does not verify. Fail closed, never silently skip (W4-P0-1).

    keyring is the secret keyring (W6-P1-2): the seal may verify under
    any retired key, not just the active one.
    """
    op_id = rec.get("op_id")
    mac = rec.get("rec_hmac")
    if not isinstance(mac, str) or not mac.startswith(_JOURNAL_HMAC_PREFIX):
        raise JournalIntegrityError(
            "journal %s line %d (op_id %r): record has no integrity seal. "
            "This journal predates the HMAC seal (or the seal was "
            "stripped). Fail closed: reconcile in-flight ops against the "
            "provider, then run `python3 dispatch/executor.py journal-seal` "
            "to adopt the current journal bytes as the trust anchor. "
            "Sealing cannot detect tampering that predates the seal."
            % (path, lineno, op_id))
    if keyring is None:
        raise JournalIntegrityError(
            "journal %s line %d (op_id %r): record carries a seal but the "
            "tree's journal secret is missing, so the seal cannot be "
            "verified. Fail closed: restore the secret from an ENCRYPTED "
            "backup (never store state-tree backups unencrypted: they "
            "carry every HMAC/AES key). If no backup exists, reconcile "
            "in-flight ops against the provider, then run `python3 "
            "dispatch/executor.py journal-recover-secret --yes --reason "
            "'...'`: it re-keys under a new secret and preserves the "
            "op_id replay-protection set (cryptographic provenance of "
            "old records is downgraded to operator attestation). "
            "journal-seal cannot help here: it refuses "
            "sealed-but-unverifiable records."
            % (path, lineno, op_id))
    if not _record_seal_valid_any(rec, keyring):
        raise JournalIntegrityError(
            "journal %s line %d (op_id %r): INTEGRITY CHECK FAILED. The "
            "record was modified outside the executor. Fail closed: do "
            "NOT run journal-seal (it would bless the tampered bytes); "
            "investigate, restore the journal from backup, and reconcile "
            "the affected op against the provider before retrying."
            % (path, lineno, op_id))


def _claim_token_hash(token):
    """One-way hash of a claim token for journal storage (W4-P0-2).

    The journal keeps only the hash; the claimant keeps the raw token in
    memory and presents it to recheck_claim/release_op_id, which hash the
    presented value and compare. A journal read alone can therefore
    neither adopt nor free a foreign claim. W5-P0-1: the pending
    envelope no longer stores the raw token either (only its hash, for
    forensics); the orchestrator threads the token to the verify phase
    through its own memory, and the TTL sweeper frees orphans via
    release_op_id_forced. Documented non-boundary: a process that can
    read the claimant's memory (ptrace, same-uid) recovers the raw
    token; same-uid memory is not a security boundary on this box."""
    return "sha256:" + sha256_hex(str(token).encode("utf-8"))


def _claim_token_matches(stored_hash, claim_token):
    """W6-P2-1: constant-time claim-token comparison.

    The journal stores "sha256:<hex>" of the token; the presented token
    is hashed and compared with hmac.compare_digest so the comparison
    does not short-circuit on the first differing character. Every
    other secret comparison in the tree already uses compare_digest;
    these claim-token sites were the single exception."""
    if not isinstance(stored_hash, str):
        return False
    return hmac.compare_digest(stored_hash, _claim_token_hash(claim_token))


# W6-P2-5: claim-token TTL. A claim token is a bare 122-bit random value
# with no nonce; its only bound was the claim's lifetime, and raw-lane
# crashed claims persisted INDEFINITELY. Claims now expire:
# browser-lane "pending" (write) claims live 7 days (matching the
# browser orphan sweeper's PENDING_TTL_DAYS); raw-lane "claimed" (read)
# claims live 24h. recheck_claim and journal_claimed_outcome fail closed
# on an expired claim; sweep_expired_claims force-releases expired
# claims so nothing persists indefinitely.
CLAIM_TTL_SECONDS = {
    "pending": 7 * 86400,
    "claimed": 24 * 3600,
}


def _parse_claim_ts(ts):
    try:
        dt = datetime.fromisoformat(str(ts))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _claim_expired(rec):
    """True when a pending/claimed journal record is past its TTL.

    Fail closed: a missing or unparseable ts counts as expired (a claim
    that cannot prove its age cannot be honored).
    """
    ttl = CLAIM_TTL_SECONDS.get(rec.get("wal"))
    if ttl is None:
        return False
    dt = _parse_claim_ts(rec.get("ts"))
    if dt is None:
        return True
    return (datetime.now(timezone.utc) - dt).total_seconds() > ttl


def _refuse_expired_claim(op_id, rec):
    raise DuplicateOpId(
        "op id %s claim expired (claimed at %s, TTL %ds for wal=%s); "
        "refusing to honor a stale claim. Reconcile the op against the "
        "provider and re-dispatch with a fresh op_id."
        % (op_id, rec.get("ts"), CLAIM_TTL_SECONDS.get(rec.get("wal"), 0),
           rec.get("wal")))


def sweep_expired_claims():
    """W6-P2-5: force-release every journal claim past its TTL.

    Closes the "raw-lane crashed claims persist indefinitely" gap: an
    expired claim's op_id is freed via release_op_id_forced (journaled
    with forced=true and the reason), so a captured claim token can
    never be honored after its TTL. Terminal ops are untouched; the
    release is a no-op for ops that completed between the scan and the
    release. Returns {"swept": [op_ids], "count": n}.

    W6-P2-5 (archives): rotation renames the whole live journal into
    archive/ regardless of claim state, so an in-flight claim's latest
    record can sit in an archive. The scan therefore covers archives
    (chronological) plus the live journal; the newest record per op_id
    decides. release_op_id_forced already resolves archive-located
    claims via the locations index.
    """
    expired = []
    with _journal_locked():
        latest_by_op = {}
        try:
            archive_names = sorted(os.listdir(_journal_archive_dir()))
        except OSError:
            archive_names = []
        for name in archive_names:
            path = os.path.join(_journal_archive_dir(), name)
            for rec in _scan_journal_file(path):
                if rec.get("wal") == "audit" or not rec.get("op_id"):
                    continue
                latest_by_op[str(rec.get("op_id"))] = rec
        for rec in _scan_journal_file(JOURNAL_PATH):
            if rec.get("wal") == "audit" or not rec.get("op_id"):
                continue
            latest_by_op[str(rec.get("op_id"))] = rec
        for op_id, rec in latest_by_op.items():
            if rec.get("wal") in ("pending", "claimed") \
                    and _claim_expired(rec):
                expired.append(op_id)
    # Two phases: _journal_locked is not reentrant (a second flock on a
    # fresh fd would self-deadlock), and release_op_id_forced takes the
    # lock itself.
    swept = []
    for op_id in expired:
        try:
            result = release_op_id_forced(
                op_id,
                "W6-P2-5: claim TTL expired (wal=%s, claimed at %s); "
                "outcome unknown" % (latest_by_op[op_id].get("wal"),
                                     latest_by_op[op_id].get("ts")))
            if result.get("released"):
                swept.append(op_id)
        except DuplicateOpId:
            pass
    return {"swept": swept, "count": len(swept)}


def ensure_journal_dir():
    # makedirs(mode=) only applies at creation; pre-existing loose paths
    # are tightened rather than trusted. The journal carries approval
    # citations and learner tokens: dir 0700, file 0600.
    for path, mode in ((MORROW_HOME, 0o700),
                       (TREE_STATE_DIR, 0o700),
                       (os.path.dirname(JOURNAL_PATH), 0o700)):
        os.makedirs(path, exist_ok=True)
        os.chmod(path, mode)
    if os.path.exists(JOURNAL_PATH):
        os.chmod(JOURNAL_PATH, 0o600)
    if os.path.exists(_journal_secret_path()):
        os.chmod(_journal_secret_path(), 0o600)
    # W2-P1-32: first-run migration note. When the legacy global journal
    # exists, this tree keeps its own journal; legacy records stay
    # readable for idempotency (see _legacy_op_ids) but are never merged
    # into the tree journal.
    if (os.path.exists(LEGACY_JOURNAL_PATH)
            and os.path.abspath(LEGACY_JOURNAL_PATH)
            != os.path.abspath(JOURNAL_PATH)
            and not os.path.exists(JOURNAL_PATH)):
        print("NOTE: legacy journal %s exists; this tree keeps its own "
              "journal at %s (legacy records remain readable for "
              "idempotency, never merged)" % (LEGACY_JOURNAL_PATH,
                                              JOURNAL_PATH),
              file=sys.stderr)


def _legacy_scan():
    """Read the legacy global journal, isolated per tree (W6-P2-8).

    The legacy file is shared input every tree parses on the claim
    path; a single torn line in it used to raise JournalTorn and brick
    EVERY tree (fail-closed for the tree's own journal became
    fail-closed for everyone else's). The tree's own journal keeps
    fail-closed torn-line behavior; only the shared legacy input is
    isolated: a torn legacy line is quarantined for operator
    inspection, a loud warning names the file, and the legacy journal
    is treated as empty for this read. The legacy file is still never
    written and never merged into any tree journal.
    """
    if (not os.path.exists(LEGACY_JOURNAL_PATH)
            or os.path.abspath(LEGACY_JOURNAL_PATH)
            == os.path.abspath(JOURNAL_PATH)):
        return []
    try:
        return _scan_journal_file(LEGACY_JOURNAL_PATH, verify=False)
    except JournalTorn as exc:
        sys.stderr.write(
            "morrow: WARNING: legacy global journal %s is torn (%s); "
            "quarantining it for operator inspection and treating it "
            "as empty for this read. The tree's own journal is "
            "unaffected. Reconcile legacy op_ids against the provider "
            "before re-dispatching them.\n"
            % (LEGACY_JOURNAL_PATH, exc))
        try:
            qdir = os.path.join(os.path.dirname(LEGACY_JOURNAL_PATH),
                                "quarantine")
            os.makedirs(qdir, exist_ok=True)
            qpath = os.path.join(
                qdir, "legacy-journal.torn.%d" % int(time.time()))
            with open(LEGACY_JOURNAL_PATH, "rb") as src_f, \
                    open(qpath, "wb") as dst_f:
                dst_f.write(src_f.read())
        except OSError as qexc:
            sys.stderr.write(
                "morrow: WARNING: could not quarantine the torn legacy "
                "journal: %s\n" % qexc)
        return []


def _legacy_op_ids():
    """Op IDs from the legacy global journal (pre-tree-scoping).

    Read-only idempotency backstop: an op dispatched before the upgrade
    must not be re-dispatched after it. The legacy file is never written
    and never merged into the tree journal; a torn legacy line is
    isolated per tree (W6-P2-8) instead of bricking every tree.
    """
    net = set()
    for rec in _legacy_scan():
        op_id = rec.get("op_id")
        if not op_id:
            continue
        if rec.get("wal") == "released":
            net.discard(str(op_id))
        else:
            net.add(str(op_id))
    return net


def _legacy_records_for(op_id):
    """All legacy-journal records for one op_id, in file order."""
    want = str(op_id)
    return [r for r in _legacy_scan() if str(r.get("op_id")) == want]


@contextmanager
def _journal_locked():
    """Exclusive flock over every journal mutation and check.

    The lock file lives next to the journal; the lock is held across the
    whole check-and-append so concurrent processes cannot both pass the
    op-id guard (W2-P0-18).

    W4-P2-6: this flock is ADVISORY. It coordinates cooperating writers
    (a crash/race boundary); it is not a security boundary. A local
    writer that simply never takes the lock is not stopped by it. The
    tamper boundary is the per-record HMAC plus the sealed sidecar index
    (W4-P0-1): an unlocked writer's forged, edited, or deleted records
    fail closed with JournalIntegrityError on the next read, loudly,
    instead of being trusted."""
    ensure_journal_dir()
    lock_path = _journal_lock_path()
    fh = open(lock_path, "a", encoding="utf-8")
    try:
        os.chmod(lock_path, 0o600)
    except OSError:
        pass
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        finally:
            fh.close()


def _quarantine_journal(journal_path, raw):
    """Write a content-addressed quarantine copy of a torn journal.

    The quarantine path embeds the sha256 of the journal bytes, so the
    same torn journal state always maps to the same quarantine file:
    repeated scans of an unrepaired tear (and the repair step itself)
    reuse the existing copy instead of piling up duplicates. Returns
    the quarantine path."""
    digest = hashlib.sha256(raw).hexdigest()[:16]
    qpath = "%s.torn.%s" % (journal_path, digest)
    if not os.path.exists(qpath):
        try:
            with open(qpath, "wb") as dst:
                dst.write(raw)
            os.chmod(qpath, 0o600)
        except OSError:
            return "(quarantine write failed)"
    return qpath


def _quarantine_torn(journal_path, lineno, bad_line):
    """Copy a torn journal segment aside for operator inspection.

    Never deletes journal bytes: the operator repairs with
    `executor.py journal-repair`, which truncates only after the torn
    tail is safely quarantined."""
    try:
        with open(journal_path, "rb") as src:
            raw = src.read()
    except OSError:
        raw = b""
    qpath = _quarantine_journal(journal_path, raw)
    raise JournalTorn(
        "journal %s has a torn line %d (not valid JSON); the journal is "
        "fail-closed until repaired. The torn content was quarantined to "
        "%s. Repair with: python3 dispatch/executor.py journal-repair "
        "(after reconciling the affected op against the provider). "
        "Offending bytes: %r"
        % (journal_path, lineno, qpath, bad_line[:120]))


def _scan_journal_file(path, verify=True):
    """Read every record from one journal file, in order.

    Raises JournalTorn on the first unparseable line: torn lines are
    never silently skipped (W2-P0-3). With verify=True (default) every
    record's HMAC is checked and a failure raises JournalIntegrityError
    (W4-P0-1): forged, edited, or unsealed records fail closed. Pass
    verify=False only for the read-only legacy global journal (which
    predates the seal and is consulted for idempotency only, never for
    claim authorization) and for the journal-seal migration step, which
    adopts the current bytes as the trust anchor."""
    records = []
    try:
        fh = open(path, "r", encoding="utf-8")
    except FileNotFoundError:
        return records
    keyring = _read_secret_keyring() if verify else None
    with fh:
        for lineno, line in enumerate(fh, 1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rec = json.loads(stripped)
            except ValueError:
                _quarantine_torn(path, lineno, stripped)
            if verify:
                _verify_record(path, lineno, rec, keyring)
            records.append(rec)
    return records


def _journal_live_size():
    try:
        return os.stat(JOURNAL_PATH).st_size
    except OSError:
        return 0


def _read_index():
    """Load the sidecar op-id index; None when absent or unusable.

    W4-P0-1: the index is HMAC'd as a whole (index_hmac) and the seal is
    verified before journal_size/op_ids are trusted. A forged or
    seal-stripped index raises JournalIntegrityError (fail closed): it
    is never silently trusted, and the journal is never silently
    rebuilt from under it (rebuilding from a tampered journal is exactly
    what the index-forgery attack relies on). Only a missing file, an
    unparseable file, or a pre-integrity version returns None; with a
    journal present, _journal_state_locked then fails closed and points
    at journal-seal."""
    try:
        with open(_journal_index_path(), "r", encoding="utf-8") as fh:
            idx = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(idx, dict) or idx.get("version") != _JOURNAL_INDEX_VERSION:
        return None
    mac = idx.get("index_hmac")
    if not isinstance(mac, str) or not mac.startswith(_JOURNAL_HMAC_PREFIX):
        raise JournalIntegrityError(
            "sidecar index %s has no integrity seal (pre-HMAC install, or "
            "the seal was stripped). Fail closed: reconcile in-flight ops "
            "against the provider, then run `python3 dispatch/executor.py "
            "journal-seal` to adopt the current journal bytes as the trust "
            "anchor." % _journal_index_path())
    keyring = _read_secret_keyring()
    if keyring is None:
        raise JournalIntegrityError(
            "sidecar index %s is sealed but the tree's journal secret is "
            "missing, so the seal cannot be verified. Fail closed: "
            "restore the secret from an ENCRYPTED backup (never store "
            "state-tree backups unencrypted), or reconcile and re-seal."
            % _journal_index_path())
    body = {k: v for k, v in idx.items() if k != "index_hmac"}
    # W6-P1-2: the index may be sealed under a retired key.
    verified = any(
        hmac.compare_digest(
            mac[len(_JOURNAL_HMAC_PREFIX):],
            hmac.new(key, canonical(body).encode("utf-8"),
                     hashlib.sha256).hexdigest())
        for key in keyring["keys"].values())
    if not verified:
        raise JournalIntegrityError(
            "sidecar index %s FAILED integrity verification: the index was "
            "forged or corrupted. Fail closed: journal_size/op_ids from "
            "this index must not be trusted; investigate and restore from "
            "backup." % _journal_index_path())
    if not isinstance(idx.get("op_ids"), list):
        return None
    return idx


def _journal_generation_highwater_path():
    """Path of the journal generation high-water mark (W6-P1-2).

    Lives in the tree state dir but OUTSIDE journal/: the state-backup
    tool deliberately excludes it, so restoring a backup can never roll
    it back. It records the highest sidecar-index generation ever
    written by this tree; an index older than the high-water mark is a
    stale restore, not the current journal.
    """
    return os.path.join(TREE_STATE_DIR, "journal.generation.highwater")


def _read_generation_highwater():
    try:
        with open(_journal_generation_highwater_path(), "r",
                   encoding="utf-8") as fh:
            doc = json.load(fh)
        gen = int(doc.get("generation", 0))
        return max(gen, 0)
    except (OSError, ValueError, TypeError, AttributeError):
        return 0


def _write_generation_highwater(gen):
    """Monotonic: never moves backward. Callers hold the journal lock."""
    if gen <= _read_generation_highwater():
        return
    path = _journal_generation_highwater_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except OSError:
        pass
    tmp = path + ".tmp.%d" % os.getpid()
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"generation": int(gen),
                                 "updated_at": utc_now_iso()}) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        try:
            dfd = os.open(os.path.dirname(path), os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass
    except OSError as exc:
        sys.stderr.write(
            "morrow: WARNING: could not persist the journal generation "
            "high-water mark: %s; stale-restore detection is degraded "
            "until it is writable.\n" % exc)


def _journal_restored_marker_path():
    """The restore marker (W6-P1-2).

    Written by the state-restore tool (and shipped inside backups, so a
    manual cp restore carries it too). While it exists, the journal is
    fail-closed: the operator must run `journal-reconcile` (verify +
    re-anchor the generation) before dispatch resumes.
    """
    return os.path.join(os.path.dirname(JOURNAL_PATH), "restored_from.json")


def _write_index(idx):
    """Atomically replace the sidecar index (tmp file + rename + fsync).

    W4-P0-1: the index carries index_hmac = HMAC-SHA256(tree_secret,
    canonical_index_bytes) computed over the index with the hmac field
    itself excluded; _read_index verifies it before trusting
    journal_size/op_ids.

    W6-P1-2: the index carries a monotonic `generation`, bumped on
    every write to max(old generation, high-water mark) + 1, and the
    high-water mark is advanced with it. A restored backup's index is
    therefore always older than the high-water mark, which
    _journal_state_locked detects (fail closed) instead of silently
    re-admitting a stale journal whose op_ids were already consumed.
    Callers hold the journal lock; the bump is centralized here so
    every index writer (append, rotate, prune, seal, rebuild) advances
    the generation.
    """
    idx = dict(idx)
    idx.pop("index_hmac", None)
    idx.pop("generation", None)
    old_gen = 0
    try:
        old_idx = _read_index()
        if old_idx is not None:
            old_gen = int(old_idx.get("generation") or 0)
    except (JournalIntegrityError, ValueError, TypeError):
        # Adopting (journal-seal) or rebuilding over an unverifiable
        # index: anchor on the high-water mark so the generation never
        # moves backward.
        old_gen = 0
    new_gen = max(old_gen, _read_generation_highwater()) + 1
    idx["generation"] = new_gen
    # W6-P1-5: record whether a retired set exists, sealed inside the
    # index. _retired_op_ids uses this to tell "never had a retired
    # set" apart from "the retired file AND its seal were both deleted
    # outside the executor" (fail closed on the latter).
    try:
        _rst = os.stat(_journal_retired_path())
        idx["retired"] = {"bytes": _rst.st_size,
                          "sealed": os.path.exists(
                              _journal_retired_seal_path())}
    except OSError:
        idx["retired"] = {"bytes": 0, "sealed": False}
    idx["version"] = _JOURNAL_INDEX_VERSION
    # W6-P2-7: use-then-zero; the buffer is overwritten on exit.
    with _journal_secret_ctx() as _s:
        mac = hmac.new(_s.view(),
                       canonical(idx).encode("utf-8"),
                       hashlib.sha256).hexdigest()
    idx["index_hmac"] = _JOURNAL_HMAC_PREFIX + mac
    path = _journal_index_path()
    tmp = path + ".tmp." + _writer_tmp_suffix()
    # W6-P2-2: 0600 at open, never open-then-chmod.
    fd = _open_secret_tmp(tmp)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(canonical(idx))
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    try:
        dfd = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass
    _write_generation_highwater(new_gen)


def _rebuild_index_locked():
    """Full rescan of the live journal; fail loud on torn lines.

    Returns {"op_ids": set(...), "locations": {op_id: "live"|archive}}.
    Archives are immutable once rotated, so only the live journal is
    rescanned for op_ids; archive locations are re-derived from the
    actual archive scans (W6-P2-5), never carried over from the old
    index (a rotation crash used to leave stale "live" pointers at
    records that had already been renamed into an archive).

    W4-P0-1: the old index reached here only after its HMAC verified in
    _read_index, so its op_ids are trusted evidence. When the live
    journal SHRANK since that sealed index was written, every op_id the
    index places in the live journal must still be found in the live
    journal or one of the archives; a missing op_id means records were
    deleted outside the executor, and the rebuild fails closed with
    JournalIntegrityError instead of silently forgetting the op (which
    would defeat DuplicateOpId replay protection). A crash-torn tail
    raises JournalTorn in the scan before this check; legitimate
    rotation renames the journal into archive/ first, so rotated
    records are found by the archive scan."""
    old = _read_index() or {}
    old_locations = old.get("locations") or {}
    archives = list(old.get("archives") or [])
    old_size = old.get("journal_size")
    records = _scan_journal_file(JOURNAL_PATH)
    # Journal order decides: a release frees the op_id even when an
    # earlier claim exists (releases are appended after the claim they
    # free). Records without a wal marker (pre-change journals, catalog
    # refusals) count as used, never as releases.
    #
    # Archived op_ids must survive the rebuild: archives are immutable,
    # so the old index is the only record of them. Seed net from the
    # old op_ids (dropping any whose archive file is gone), then apply
    # the live journal on top. Without this, a rebuild after rotation
    # would silently make archived op_ids reusable (W2-P0-18).
    try:
        existing_archives = set(os.listdir(_journal_archive_dir()))
    except OSError:
        existing_archives = set()
    # W6-P1-4: archive deletion tripwire. The sealed index lists every
    # archive the executor created; an archive that is listed but gone
    # was deleted outside the executor (not by _prune_archives_locked,
    # which drops names from the index BEFORE deleting the files).
    # Silently dropping its op_ids would re-arm already-run ops, so
    # fail closed and point at the backup.
    listed_archives = set(old.get("archives") or [])
    vanished = sorted(listed_archives - existing_archives)
    if vanished:
        raise JournalIntegrityError(
            "archive(s) %s are listed in the sealed sidecar index but "
            "missing from %s: they were deleted outside the executor "
            "(prune drops names from the index before deleting files, "
            "so this is not a prune). Fail closed: %d op_id(s) in those "
            "archives must not become re-claimable. Investigate and "
            "restore from backup; do NOT re-claim op_ids meanwhile."
            % (", ".join(vanished[:5]) + (", ..." if len(vanished) > 5 else ""),
               _journal_archive_dir(), len(vanished)))
    net = {op_id for op_id in (old.get("op_ids") or [])
           if old_locations.get(str(op_id)) in (None, "live")
           or old_locations.get(str(op_id)) in existing_archives}
    live_ids = set()
    for rec in records:
        op_id = rec.get("op_id")
        if not op_id:
            continue
        op_id = str(op_id)
        live_ids.add(op_id)  # every record here lives in the live journal
        if rec.get("wal") == "released":
            net.discard(op_id)
        else:
            net.add(op_id)
    if isinstance(old_size, int) and old_size > _journal_live_size():
        # W4-P0-1 deletion tripwire: the sealed index is trusted evidence
        # that the journal used to be bigger. Every op_id it places in
        # the live journal must still be present in the live journal or
        # one of the archives (the rotation crash window renames the
        # journal into archive/ before rewriting the index, so rotated
        # records are found by the archive scan). A missing op_id means
        # records were deleted outside the executor: fail closed instead
        # of silently forgetting the op.
        found = set(live_ids)
        for name in existing_archives:
            for rec in _scan_journal_file(
                    os.path.join(_journal_archive_dir(), name)):
                if rec.get("op_id"):
                    found.add(str(rec.get("op_id")))
        missing = [op_id for op_id in (old.get("op_ids") or [])
                   if old_locations.get(str(op_id)) in (None, "live")
                   and str(op_id) not in found]
        if missing:
            raise JournalIntegrityError(
                "journal %s shrank from %d to %d bytes and %d op_id(s) the "
                "sealed sidecar index records (%s%s) are absent from the "
                "journal and all archives: records were deleted outside "
                "the executor. Fail closed: investigate and restore from "
                "backup; do NOT re-claim these op_ids."
                % (JOURNAL_PATH, old_size, _journal_live_size(),
                   len(missing), ", ".join(missing[:5]),
                   ", ..." if len(missing) > 5 else ""))
    # W6-P2-5: derive locations from the actual archives, not from
    # the old index. A rotation crash between the journal->archive
    # rename and the index write used to leave the rebuilt index
    # pointing "live" at records that actually live in an archive;
    # repair/explain tooling reading the wrong file is a correctness
    # bug, and a stale "live" pointer masks the rotation. Archives are
    # immutable, so their scans are ground truth (a torn archive raises
    # JournalTorn here: fail closed, operator repairs).
    #
    # Optimization (W5-P2-5): when the live journal GREW (growth drift),
    # archives are untouched and immutable, so their locations are
    # carried over from the old index without rescanning. Only when the
    # live journal SHRANK (possible rotation crash) are archives
    # rescanned to fix stale "live" pointers.
    locations = {}
    live_grew = old_size is not None and _journal_live_size() > old_size
    if live_grew:
        # Growth drift: archives unchanged; reuse old locations.
        for op_id, loc in (old_locations or {}).items():
            if loc in existing_archives:
                locations[str(op_id)] = loc
    else:
        # Shrink or unknown: rescan archives for ground truth.
        for name in sorted(existing_archives):
            for rec in _scan_journal_file(
                    os.path.join(_journal_archive_dir(), name)):
                if rec.get("op_id"):
                    locations[str(rec.get("op_id"))] = name
    for op_id in live_ids:
        locations[op_id] = "live"
    idx = {"journal_size": _journal_live_size(),
           "archives": archives,
           "op_ids": sorted(net),
           "locations": locations}
    _write_index(idx)
    # W5-P1-1: pruned archives' op_ids stay un-reclaimable via the
    # retired set (their records are gone, so the index alone cannot
    # carry them through a from-scratch rebuild).
    return {"op_ids": net | _retired_op_ids(), "locations": locations}


def _journal_state_locked():
    """Validated op-id state under the caller's journal lock.

    Fast path: the sidecar index is trusted when the live journal size
    matches AND the index's HMAC verifies (_read_index raises
    JournalIntegrityError on a forged or seal-stripped index, W4-P0-1).
    Any size drift triggers a full rescan, which raises JournalTorn on
    torn lines and JournalIntegrityError when the sealed index shows
    records were deleted.

    W4-P0-1: a missing index alongside an existing journal fails closed
    (a crash between the journal append and the index write is
    indistinguishable from index deletion); journal-seal rebuilds the
    index once the journal verifies. A missing journal alongside an
    existing secret fails closed the same way (journal deletion).

    W6-P1-2: (a) while journal/restored_from.json exists (written by the
    state-restore tool and shipped inside backups, so even a manual cp
    restore carries it), the journal is fail-closed: the operator must
    run `journal-reconcile` (verify + re-anchor the generation) before
    dispatch resumes. (b) The sealed sidecar index carries a monotonic
    `generation`; the high-water mark in
    <state-dir>/journal.generation.highwater is never rolled back by a
    restore. An index older than the mark is a STALE restore: its op_ids
    were already consumed after the backup was taken, so re-admitting
    them could re-run completed ops."""
    # W6-P1-2: fail closed while a restore marker exists.
    restored_marker = _journal_restored_marker_path()
    if os.path.exists(restored_marker):
        raise JournalIntegrityError(
            "journal state was restored from backup (marker %s). "
            "Fail closed: reconcile in-flight ops against the "
            "provider, then run `python3 dispatch/executor.py "
            "journal-reconcile` to verify and re-anchor the journal."
            % restored_marker)
    if _have_secret() and not os.path.exists(JOURNAL_PATH):
        raise JournalIntegrityError(
            "journal %s is missing but this tree already minted its "
            "journal secret: the journal was deleted. Fail closed: "
            "restore the journal from backup and reconcile in-flight ops "
            "against the provider; the op_ids it recorded must not be "
            "re-claimed blindly." % JOURNAL_PATH)
    idx = _read_index()
    if idx is not None:
        # W6-P1-2: stale-restore detection.
        idx_gen = idx.get("generation")
        try:
            idx_gen = int(idx_gen) if idx_gen is not None else 0
        except (ValueError, TypeError):
            idx_gen = 0
        hw = _read_generation_highwater()
        if idx_gen < hw:
            raise JournalIntegrityError(
                "STALE journal restore detected: the sealed sidecar "
                "index is at generation %d but this tree already wrote "
                "generation %d. The restored journal is older than the "
                "live one; re-admitting it could re-run already-completed "
                "ops. Fail closed: restore the newest backup, then run "
                "`python3 dispatch/executor.py journal-reconcile`."
                % (idx_gen, hw))
    if idx is not None and idx.get("journal_size") == _journal_live_size():
        # W5-P1-1: union the retired op_id set (pruned archives). A
        # retired op_id stays un-reclaimable even though its journal
        # records are gone.
        return {"op_ids": set(idx["op_ids"]) | _retired_op_ids(),
                "locations": dict(idx.get("locations") or {})}
    if idx is None and os.path.exists(JOURNAL_PATH):
        raise JournalIntegrityError(
            "sidecar index %s is missing (or predates the integrity seal) "
            "while journal %s exists: a crash between the journal append "
            "and the index write is indistinguishable from index deletion "
            "(W4-P0-1). Fail closed: reconcile in-flight ops against the "
            "provider, then run `python3 dispatch/executor.py journal-seal` "
            "(it rebuilds the index once the journal verifies); do not "
            "re-claim op_ids meanwhile."
            % (_journal_index_path(), JOURNAL_PATH))
    if idx is None:
        # Nothing journaled yet: no journal, no index, and (checked above)
        # no secret. A rebuild here would mint the secret and index with
        # no journal file, which every later read and claim takes for a
        # deleted journal. The first append creates all three.
        return {"op_ids": _retired_op_ids(), "locations": {}}
    return _rebuild_index_locked()


def _index_note_append_locked(op_id, wal, size_before, size_after):
    """Incrementally update the sidecar index after one append.

    The common path stays O(1): only when the index is missing or does
    not match the pre-append size do we fall back to a full rescan
    (which also re-validates the journal for torn lines)."""
    idx = _read_index()
    if idx is None or idx.get("journal_size") != size_before:
        _rebuild_index_locked()
        return
    op_ids = set(idx.get("op_ids") or [])
    locations = dict(idx.get("locations") or {})
    if wal == "released":
        op_ids.discard(op_id)
    else:
        op_ids.add(op_id)
    locations[op_id] = "live"
    _write_index({"journal_size": size_after,
                  "archives": list(idx.get("archives") or []),
                  "op_ids": sorted(op_ids),
                  "locations": locations})


# Round-4 privacy audit H3c: while a dispatch runs with learner labels
# resolved to real LMS ids, every journal record is relabeled before it
# is sealed, so the journal never holds the raw id a label stood for.
# The value is the dispatch's holder dict; its "map" is {real id: label}.
_ACTIVE_ID_LABELS = contextvars.ContextVar("morrow_active_id_labels",
                                           default=None)


def _relabel_for_journal(record):
    holder = _ACTIVE_ID_LABELS.get()
    mapping = holder.get("map") if isinstance(holder, dict) else None
    if not mapping:
        return record
    from privacy import executor_wire as _wire
    return _wire.relabel_learner_ids(record, mapping)


def _append_record_locked(record):
    """Append one record with O_APPEND plus fsync, under the caller's
    exclusive journal lock.

    W2-P2-10: the flock (held by every caller) is what prevents
    interleave with other journal writers, not the syscall count:
    os.write() may do short writes, so large records are appended in a
    retry loop, all under the same lock. A crash mid-append leaves a
    torn tail, which never parses silently: the next scan raises
    JournalTorn and quarantines it (W2-P0-3). fsync makes the WAL
    pending record durable before dispatch proceeds (W2-P0-2).

    W4-P0-1: before the append, the record is sealed with rec_hmac =
    HMAC-SHA256(tree_secret, canonical_record_bytes), the hmac field
    itself excluded from the HMAC input. The per-tree secret is minted
    on first use at <journal-dir>/ops.secret (0600). The flock above
    stays a crash/race guard among cooperating writers (W4-P2-6: it is
    advisory, never a security boundary); the seal is the tamper
    boundary, verified on every read path, failing closed with
    JournalIntegrityError."""
    record = _relabel_for_journal(record)
    # W6-P2-7: use-then-zero; the buffer is overwritten on exit.
    with _journal_secret_ctx() as _s:
        record = _seal_record(dict(record), _s.view())
    line = (canonical(record) + "\n").encode("utf-8")
    size_before = _journal_live_size()
    fd = os.open(JOURNAL_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        view = memoryview(line)
        while view:
            n = os.write(fd, view)
            view = view[n:]
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.chmod(JOURNAL_PATH, 0o600)
    except OSError:
        pass
    _index_note_append_locked(str(record.get("op_id") or ""),
                              record.get("wal"),
                              size_before, size_before + len(line))
    _maybe_rotate_locked()


def _maybe_rotate_locked():
    """Rotate the live journal into archive/ when it exceeds the cap.

    Archives stay queryable: find_journal_op searches them via the
    index locations map (W2-P1-8).

    W5-P1-1: archives are pruned on every pass (not only when a
    rotation fires), so the age cap is enforced even on quiet trees."""
    _prune_archives_locked()
    if _journal_live_size() <= JOURNAL_ROTATE_BYTES:
        return
    archive_dir = _journal_archive_dir()
    os.makedirs(archive_dir, exist_ok=True)
    try:
        os.chmod(archive_dir, 0o700)
    except OSError:
        pass
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    name = "ops-%s.jsonl" % stamp
    dest = os.path.join(archive_dir, name)
    os.rename(JOURNAL_PATH, dest)
    os.chmod(dest, 0o600)
    fd = os.open(JOURNAL_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.close(fd)
    try:
        dfd = os.open(os.path.dirname(JOURNAL_PATH), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass
    idx = _read_index() or {}
    archives = list(idx.get("archives") or [])
    archives.append(name)
    locations = dict(idx.get("locations") or {})
    for op_id, loc in list(locations.items()):
        if loc == "live":
            locations[op_id] = name
    _write_index({"journal_size": 0, "archives": archives,
                  "op_ids": list(idx.get("op_ids") or []),
                  "locations": locations})


def _journal_retired_path():
    """Path of the retired op_id set (one op_id per line, 0600).

    Pruned archives' op_ids land here so DuplicateOpId replay protection
    survives pruning: a retired op_id can never be re-claimed, even
    though its journal records are gone.
    """
    return os.path.join(os.path.dirname(JOURNAL_PATH), "retired_opids.jsonl")


_retired_cache = None
_retired_cache_key = None


_RETIRED_SEAL_DOMAIN = b"morrow-retired-opids-v1\n"


def _journal_retired_seal_path():
    """Path of the retired set's integrity seal (W6-P1-5)."""
    return os.path.join(os.path.dirname(_journal_retired_path()),
                        "retired_opids.seal")


def _retired_read_unverified():
    """Read retired_opids.jsonl WITHOUT seal verification.

    Recovery ceremonies only (retired-seal adoption, secret-loss
    recovery). Never used on the dispatch path: _retired_op_ids is the
    verified reader.
    """
    try:
        with open(_journal_retired_path(), "r", encoding="utf-8") as f:
            return [line.strip() for line in f if line.strip()]
    except OSError:
        return []


def _write_retired_seal():
    """Write/refresh the retired set's HMAC seal (W6-P1-5).

    seal = HMAC-SHA256(active_journal_secret,
                       "morrow-retired-opids-v1\\n" + file_bytes),
    stored 0600 via tmp+rename+fsync. Callers hold the journal lock.
    """
    path = _journal_retired_path()
    with open(path, "rb") as f:
        data = f.read()
    secret = _read_secret_or_none()
    if secret is None:
        raise JournalIntegrityError(
            "cannot seal the retired op_id set: the tree's journal "
            "secret is missing. Restore the secret from an ENCRYPTED "
            "backup, or run the secret-loss recovery.")
    mac = hmac.new(secret, _RETIRED_SEAL_DOMAIN + data,
                   hashlib.sha256).hexdigest()
    seal_path = _journal_retired_seal_path()
    tmp = seal_path + ".tmp." + _writer_tmp_suffix()
    fd = _open_secret_tmp(tmp)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(_JOURNAL_HMAC_PREFIX + mac + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, seal_path)
    try:
        dfd = os.open(os.path.dirname(seal_path), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def _retired_op_ids():
    """The retired op_id set (W5-P1-1), seal-verified (W6-P1-5).

    Cached in process keyed on (jsonl mtime/size, seal mtime/size).
    Fail-closed, never silent: a missing seal (pre-seal legacy file or
    a stripped seal), a seal that does not verify under any keyring
    key (forged/corrupted), a deleted file with a surviving seal, or a
    deleted file AND seal while the sealed sidecar index records a
    non-empty retired set, all raise JournalIntegrityError. A retired
    op_id that silently dropped out of this set would become
    re-claimable, defeating DuplicateOpId replay protection.
    """
    global _retired_cache, _retired_cache_key
    path = _journal_retired_path()
    seal_path = _journal_retired_seal_path()
    try:
        st = os.stat(path)
    except OSError:
        # The retired file is gone. A surviving seal means it was
        # deleted outside the executor: fail closed, do not silently
        # re-arm its op_ids.
        if os.path.exists(seal_path):
            raise JournalIntegrityError(
                "retired op_id set %s was deleted, but its integrity "
                "seal %s survives: the file was removed outside the "
                "executor. Fail closed: its op_ids must stay "
                "un-reclaimable. Investigate and restore from backup."
                % (path, seal_path))
        # Both file and seal gone: consult the sealed sidecar index,
        # which records whether a retired set existed. (The index is
        # verified by _read_index; a forged index raises there.)
        try:
            idx = _read_index()
        except JournalIntegrityError:
            idx = None
        retired_meta = (idx.get("retired") or {}) if idx else {}
        if retired_meta.get("bytes", 0) > 0:
            raise JournalIntegrityError(
                "retired op_id set %s AND its seal %s are both missing, "
                "but the sealed sidecar index records a non-empty "
                "retired set: it was deleted outside the executor. Fail "
                "closed: its op_ids must stay un-reclaimable. "
                "Investigate and restore from backup." % (path, seal_path))
        return set()
    try:
        seal_st = os.stat(seal_path)
        seal_key = (seal_st.st_mtime_ns, seal_st.st_size)
    except OSError:
        seal_key = None
    key = (st.st_mtime_ns, st.st_size, seal_key)
    if _retired_cache is not None and key == _retired_cache_key:
        return _retired_cache
    with open(path, "rb") as f:
        data = f.read()
    try:
        with open(seal_path, "r", encoding="utf-8") as f:
            seal = f.read().strip()
    except OSError:
        seal = ""
    if not seal.startswith(_JOURNAL_HMAC_PREFIX):
        raise JournalIntegrityError(
            "retired op_id set %s has no integrity seal (pre-seal "
            "legacy file, or the seal was stripped). Fail closed: an "
            "unsealed retired set cannot be trusted for replay "
            "protection. Reconcile, then run `python3 "
            "dispatch/executor.py retired-seal --yes` to adopt and seal "
            "the current file." % path)
    keyring = _read_secret_keyring()
    if keyring is None:
        raise JournalIntegrityError(
            "retired op_id set %s is sealed but the tree's journal "
            "secret is missing, so the seal cannot be verified. Fail "
            "closed: restore the secret from an ENCRYPTED backup, or "
            "run the secret-loss recovery." % path)
    verified = any(
        hmac.compare_digest(
            seal[len(_JOURNAL_HMAC_PREFIX):],
            hmac.new(key_bytes, _RETIRED_SEAL_DOMAIN + data,
                     hashlib.sha256).hexdigest())
        for key_bytes in keyring["keys"].values())
    if not verified:
        raise JournalIntegrityError(
            "retired op_id set %s FAILED integrity verification: the "
            "file was forged or corrupted. Fail closed: its op_ids must "
            "not be trusted. Investigate and restore from backup."
            % path)
    ids = set()
    for line in data.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if line:
            ids.add(line)
    _retired_cache = ids
    _retired_cache_key = key
    return ids


def _retired_append(op_ids):
    """Merge op_ids into the retired set (W5-P1-1).

    Atomic rewrite (tmp + rename), 0600. The set is PERMANENT: no cap,
    no aging out. A retired op_id can never be re-claimed, so pruning
    an archive never weakens DuplicateOpId replay protection.
    Invalidates the in-process cache.
    """
    global _retired_cache, _retired_cache_key
    fresh = [str(o) for o in op_ids if o]
    if not fresh:
        return
    path = _journal_retired_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except OSError:
        pass
    # W6-P1-5: read through the VERIFIED reader. Reading the raw
    # file here would silently bless a forged retired set: the merge
    # below would carry the forged IDs forward and _write_retired_seal
    # would seal them, laundering the forgery into a trusted set.
    try:
        old = sorted(_retired_op_ids())
    except JournalIntegrityError:
        # Fail closed: do not append to an unverifiable set.
        raise
    except OSError:
        old = []
    merged = []
    seen = set()
    for oid in old + fresh:
        if oid not in seen:
            seen.add(oid)
            merged.append(oid)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for oid in merged:
            f.write(oid + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    try:
        dfd = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass
    # W6-P1-5: the rewritten file is sealed immediately; there is never
    # a window where the retired set exists unsealed.
    _write_retired_seal()
    _retired_cache = None
    _retired_cache_key = None
    try:
        if os.path.getsize(path) > RETIRED_OPIDS_WARN_BYTES:
            print("morrow: WARNING: retired op_id set exceeds %d bytes "
                  "(%d ids); replay protection is permanent by design, "
                  "but this growth rate is unusual" % (
                      RETIRED_OPIDS_WARN_BYTES, len(merged)),
                  file=sys.stderr, flush=True)
    except OSError:
        pass


def _prune_archives_locked():
    """Enforce the archive count/age caps (W5-P1-1). Under the journal lock.

    Archives beyond JOURNAL_ARCHIVE_MAX_COUNT (oldest first; rotation
    names are UTC timestamps so lexical order is chronological) or older
    than JOURNAL_ARCHIVE_MAX_AGE_DAYS are pruned. Each pruned archive is
    scanned once for its op_ids (HMAC-verified by _scan_journal_file)
    and those move to the retired set BEFORE the sealed sidecar index is
    updated to drop the pruned names; the files are deleted last. A torn
    or unverifiable archive is KEPT, never pruned blind: pruning must
    not destroy evidence the integrity machinery has not verified. Any
    failure leaves everything in place for the next attempt; pruning
    never breaks the append that triggered it.
    """
    archive_dir = _journal_archive_dir()
    try:
        names = sorted(os.listdir(archive_dir))
    except OSError:
        return
    if not names:
        return
    now = time.time()
    aged_out = set()
    for name in names:
        try:
            mtime = os.stat(os.path.join(archive_dir, name)).st_mtime
        except OSError:
            continue
        if (now - mtime) / 86400.0 > JOURNAL_ARCHIVE_MAX_AGE_DAYS:
            aged_out.add(name)
    survivors = [n for n in names if n not in aged_out]
    over = len(survivors) - JOURNAL_ARCHIVE_MAX_COUNT
    prune = sorted(aged_out) + (survivors[:over] if over > 0 else [])
    if not prune:
        return
    try:
        pruned = []
        for name in prune:
            path = os.path.join(archive_dir, name)
            try:
                op_ids = [str(rec.get("op_id"))
                          for rec in _scan_journal_file(path)
                          if rec.get("op_id")]
            except (JournalTorn, JournalIntegrityError, OSError):
                # Unverifiable: keep it. Pruning must not destroy
                # evidence the integrity machinery has not verified.
                continue
            _retired_append(op_ids)
            pruned.append(name)
        if not pruned:
            return
        pruned_set = set(pruned)
        idx = _read_index() or {}
        archives = [n for n in (idx.get("archives") or [])
                    if n not in pruned_set]
        locations = {op_id: loc
                     for op_id, loc in (idx.get("locations") or {}).items()
                     if loc not in pruned_set}
        _write_index({"journal_size": idx.get("journal_size",
                                              _journal_live_size()),
                      "archives": archives,
                      "op_ids": list(idx.get("op_ids") or []),
                      "locations": locations})
    except (JournalIntegrityError, OSError):
        # Index unreadable/unwritable mid-prune: leave everything in
        # place (nothing deleted yet) and retry on a later append.
        return
    for name in pruned:
        try:
            os.remove(os.path.join(archive_dir, name))
        except OSError:
            pass


def used_op_ids() -> set:
    """Every op_id with a claim/pending/completion record, minus releases.

    Fail-closed: a torn journal line raises JournalTorn instead of being
    silently skipped (W2-P0-3). W2-P1-32: the union of this tree's journal
    and the read-only legacy global journal (never merged, just
    consulted)."""
    with _journal_locked():
        ids = set(_journal_state_locked()["op_ids"])
    return ids | _legacy_op_ids()


def journal_append(record: dict):
    """Append a completion/audit record under the journal lock.

    Callers that need the check-and-append to be atomic (the op-id guard)
    must use claim_op_id, not this."""
    record = dict(record)
    record["ts"] = utc_now_iso()
    if "wal" not in record:
        record["wal"] = "complete"
    with _journal_locked():
        _append_record_locked(record)


_NON_OUTCOME_WAL = ("claimed", "pending", "released", "audit")


def journal_claimed_outcome(op_id: str, record: dict, claim_token=None):
    """W5-P1-4: atomic claim-recheck-and-journal for two-phase completes.

    The browser lane's complete phases used to recheck_claim() and then
    journal_append() as two separate journal-lock holds: two concurrent
    completes could interleave recheck(T1) -> recheck(T2) -> append(T1)
    -> append(T2) and journal two conflicting outcome records for one
    op_id. This merges the check and the append into a single hold:
    the latest non-audit record for op_id must still be a live
    claim/pending record (owned by claim_token when one is given);
    otherwise DuplicateOpId is raised and nothing is journaled. The
    first concurrent complete wins; the loser fails closed.

    claim_token=None skips the ownership check but keeps the
    already-completed/already-released guard: the race is closed either
    way. Callers that hold the token should always pass it."""
    op_id = str(op_id)
    if str(record.get("op_id")) != op_id:
        raise ExecutorError(
            "journal_claimed_outcome op_id mismatch: record is for %r, "
            "not %r" % (record.get("op_id"), op_id))
    record = dict(record)
    record["ts"] = utc_now_iso()
    if "wal" not in record:
        record["wal"] = "complete"
    with _journal_locked():
        state = _journal_state_locked()
        if op_id not in state["op_ids"]:
            raise DuplicateOpId(
                "op id %s has no claim record; refusing to journal an "
                "outcome for an unclaimed op" % op_id)
        # The claim may have rotated into an archive between dispatch
        # and this complete; search the op's locations like
        # release_op_id does.
        locations = state["locations"]
        loc = locations.get(op_id)
        search = []
        if loc == "live" or loc is None:
            search.append(JOURNAL_PATH)
        if loc is not None and loc != "live":
            search.append(os.path.join(_journal_archive_dir(), loc))
        latest = None
        for path in search:
            for rec in _scan_journal_file(path):
                # Audit records are side evidence, not reservation state.
                if str(rec.get("op_id")) == op_id and \
                        rec.get("wal") != "audit":
                    latest = rec
        if latest is None or latest.get("wal") not in ("pending", "claimed"):
            raise DuplicateOpId(
                "op id %s is already completed or released (wal=%s); "
                "refusing to journal a second outcome" %
                (op_id, latest.get("wal") if latest else None))
        if claim_token is not None and \
                not _claim_token_matches(latest.get("claim_token_hash"),
                                         claim_token):
            raise DuplicateOpId(
                "op id %s is claimed by another in-flight op; refusing "
                "to journal under a foreign claim" % op_id)
        # W6-P2-5: fail closed on an expired claim: a stale claimant
        # must not land an outcome after the TTL.
        if _claim_expired(latest):
            _refuse_expired_claim(op_id, latest)
        _append_record_locked(record)


def find_journal_op(op_id: str):
    """Return the latest outcome record for op_id, or None.

    Claim/pending/release/audit records are skipped: they mark
    reservation, its surrender, or side evidence, not an outcome. A
    pre-send refusal releases its claim, so find_journal_op correctly
    reports "no outcome journaled" while the release record stays in
    the raw journal for forensics. Searches the live journal first,
    then archives via the index. Raises JournalTorn on torn lines
    (W2-P0-3)."""
    want = str(op_id)
    with _journal_locked():
        state = _journal_state_locked()
        locations = state["locations"]
        loc = locations.get(want)
        search = []
        if loc == "live" or loc is None:
            search.append(JOURNAL_PATH)
        if loc is not None and loc != "live":
            search.append(os.path.join(_journal_archive_dir(), loc))
        if loc is None:
            # Not in the index (should not happen when the index is
            # valid): fall back to scanning live + archives.
            try:
                names = sorted(os.listdir(_journal_archive_dir()))
            except OSError:
                names = []
            search.extend(os.path.join(_journal_archive_dir(), n)
                          for n in names)
        found = None
        for path in search:
            for rec in _scan_journal_file(path):
                if str(rec.get("op_id")) == want and \
                        rec.get("wal") not in _NON_OUTCOME_WAL:
                    found = rec
        if found is None:
            # W2-P1-32: fall back to the legacy global journal (read-only).
            # A pre-upgrade outcome satisfies idempotency without being
            # merged into the tree journal.
            for rec in _legacy_records_for(want):
                if rec.get("wal") not in _NON_OUTCOME_WAL:
                    found = rec
        return found


# Write claims taken in this process. No change reaches the provider
# before claim_op_id returns, so a CLI failure raised while this count is
# unchanged sent nothing (main marks it nothing_sent for the translator).
_WRITE_CLAIMS = [0]


def claim_op_id(op_id: str, kind: str, entry_name: str, effects: str,
                params_digest: str) -> str:
    """Atomically check-and-claim an op_id under the journal lock.

    Raises DuplicateOpId when the op_id is already claimed or completed
    (the message names a pending op for reconciliation), JournalTorn when
    the journal is torn. On success appends a fsync'd WAL record
    (wal="pending" for writes, "claimed" for reads) and returns the claim
    token, which authorizes release_op_id and the browser lane's resume
    re-check. This is the single atomic check-and-append (W2-P0-18); the
    WAL record before dispatch closes the crash window (W2-P0-2)."""
    # W5-P2-1: fail closed on non-UUID op_ids; the id is interpolated
    # into brief/pending filenames downstream.
    op_id = _checked_op_id(op_id)
    token = uuid.uuid4().hex
    record = {
        "op_id": op_id,
        "kind": kind,
        "entry_name": entry_name,
        "effect": effects,
        "params_digest": params_digest,
        "wal": "pending" if effects == "write" else "claimed",
        # W4-P0-2: the journal keeps only the token hash; the raw token
        # is returned to the claimant (in memory) and never stored.
        "claim_token_hash": _claim_token_hash(token),
        "ts": utc_now_iso(),
    }
    with _journal_locked():
        state = _journal_state_locked()
        if op_id in state["op_ids"]:
            pending = [r for r in _scan_journal_file(JOURNAL_PATH)
                       if str(r.get("op_id")) == op_id
                       and r.get("wal") in ("pending", "claimed")]
            if pending:
                raise DuplicateOpId(
                    "op id %s is already claimed by an in-flight or "
                    "crashed op (wal=%s, entry %r, claimed at %s): "
                    "reconcile it against the provider before retrying; "
                    "it is NOT safe to re-dispatch blindly"
                    % (op_id, pending[-1].get("wal"),
                       pending[-1].get("entry_name"),
                       pending[-1].get("ts")))
            raise DuplicateOpId(
                "op id %s was already journaled; refusing to dispatch again"
                % op_id)
        elif op_id in _legacy_op_ids():
            # W2-P1-32: the op_id lives only in the legacy global journal
            # (pre-tree-scoping). It is never merged into this tree's
            # journal. A completed legacy op refuses the claim (it must
            # not run twice). A legacy claim that never completed is
            # NOT proof the op ran: the pre-tree-scoping journal is
            # unsealed and the claim may be orphaned, so W6-P2-8
            # downgrades the refusal to a reconcile-first error that
            # names the uncertainty instead of asserting a duplicate.
            legacy_pending = [
                r for r in _legacy_records_for(op_id)
                if r.get("wal") in ("pending", "claimed")]
            if legacy_pending:
                raise DuplicateOpId(
                    "op id %s was claimed in the LEGACY global journal "
                    "(wal=%s, entry %r, claimed at %s) with no outcome "
                    "recorded there, so it is UNCLEAR whether the op ran. "
                    "The legacy journal is unsealed pre-tree-scoping "
                    "state: reconcile the op against the provider. If it "
                    "never ran, retry with a fresh op_id; if it did, do "
                    "not re-dispatch."
                    % (op_id, legacy_pending[-1].get("wal"),
                       legacy_pending[-1].get("entry_name"),
                       legacy_pending[-1].get("ts")))
            raise DuplicateOpId(
                "op id %s was already journaled in the legacy global "
                "journal; refusing to dispatch again (use a fresh op_id)"
                % op_id)
        _append_record_locked(record)
    if effects != "read" or kind == "undo":
        _WRITE_CLAIMS[0] += 1
    return token


def recheck_claim(op_id: str, claim_token: str) -> None:
    """Idempotent re-check for a second phase holding the claim token.

    The browser lane's verify phase re-validates the request phase's
    claim without claiming twice. The LATEST record for the op decides:
    a live claim/pending record under the same token passes; a foreign
    claim, a released claim, or a completed op raises DuplicateOpId.
    (W2-P0-18: checking only the first claim record would miss a later
    completion and let a duplicate phase through.)"""
    # W5-P2-1: fail closed on non-UUID op_ids (see claim_op_id).
    op_id = _checked_op_id(op_id)
    with _journal_locked():
        state = _journal_state_locked()
        if op_id not in state["op_ids"]:
            raise DuplicateOpId(
                "op id %s has no claim record; the request phase never "
                "claimed it (or it was released)" % op_id)
        latest = None
        for rec in _scan_journal_file(JOURNAL_PATH):
            # Audit records are side evidence, not reservation state.
            if str(rec.get("op_id")) == op_id and \
                    rec.get("wal") != "audit":
                latest = rec
        if latest is None:
            raise DuplicateOpId(
                "op id %s has no journal record; the request phase never "
                "claimed it" % op_id)
        if latest.get("wal") in ("pending", "claimed"):
            # W4-P0-2: the journal stores only the token hash; hash the
            # presented token and compare. A journal read alone can no
            # longer adopt a foreign claim. W6-P2-1: constant-time
            # compare (see _claim_token_matches).
            if not _claim_token_matches(latest.get("claim_token_hash"),
                                        claim_token):
                raise DuplicateOpId(
                    "op id %s is claimed by another in-flight op; "
                    "refusing to adopt it" % op_id)
            # W6-P2-5: a captured token must not re-pass the recheck
            # after the claim's TTL. The verify phase cannot adopt a
            # stale claim; reconcile and re-dispatch instead.
            if _claim_expired(latest):
                _refuse_expired_claim(op_id, latest)
            return
        raise DuplicateOpId(
            "op id %s is already completed; refusing to run it again"
            % op_id)


def claim_is_live(op_id: str) -> bool:
    """True when op_id currently holds a live journal claim.

    A claim is live when the journal shows it claimed or pending and no
    later release or completion supersedes it. Used by the browser lane's
    verify phase for pending envelopes written before claim tokens
    existed: the claim's liveness is re-validated without a token.
    """
    try:
        op_id = check_uuid(op_id)
    except (ExecutorError, ValueError):
        return False
    with _journal_locked():
        # A claim is live when the latest record for the op (live journal,
        # then archives, like find_journal_op) is a claim/pending record
        # with no superseding release or completion.
        state = _journal_state_locked()
        locations = state["locations"]
        loc = locations.get(op_id)
        search = []
        if loc == "live" or loc is None:
            search.append(JOURNAL_PATH)
        if loc is not None and loc != "live":
            search.append(os.path.join(_journal_archive_dir(), loc))
        latest = None
        for path in search:
            for rec in _scan_journal_file(path):
                # Audit records are side evidence, not reservation state.
                if str(rec.get("op_id")) == op_id and \
                        rec.get("wal") != "audit":
                    latest = rec
        return latest is not None and \
            latest.get("wal") in ("claimed", "pending")


def release_op_id(op_id: str, claim_token: str, reason: str) -> None:
    """Release a claim, making the op_id reusable.

    Only the token holder may release: a process cannot free another
    process's in-flight op. The release is journaled (audit trail). Use
    only when the failure proves the provider never saw the op
    (prevalidation refusal, 4xx fail-fast, repeated pre-send transport
    failures, session death before any provider call)."""
    # W5-P2-1: fail closed on non-UUID op_ids (see claim_op_id).
    op_id = _checked_op_id(op_id)
    with _journal_locked():
        state = _journal_state_locked()
        if op_id not in state["op_ids"]:
            raise DuplicateOpId(
                "op id %s is not claimed; nothing to release" % op_id)
        # The claim may have rotated into an archive between dispatch
        # and this release; search the op's locations like
        # find_journal_op does.
        locations = state["locations"]
        loc = locations.get(op_id)
        search = []
        if loc == "live" or loc is None:
            search.append(JOURNAL_PATH)
        if loc is not None and loc != "live":
            search.append(os.path.join(_journal_archive_dir(), loc))
        owned = any(
            str(r.get("op_id")) == op_id
            and r.get("wal") in ("pending", "claimed")
            # W6-P2-1: constant-time token compare, not ==.
            and _claim_token_matches(r.get("claim_token_hash"), claim_token)
            for path in search
            for r in _scan_journal_file(path))
        if not owned:
            raise DuplicateOpId(
                "op id %s is not claimed by this token; refusing to release "
                "another op's claim" % op_id)
        _append_record_locked({
            "op_id": op_id,
            "kind": "release",
            "wal": "released",
            # W4-P0-2: hash, never the raw token.
            "claim_token_hash": _claim_token_hash(claim_token),
            "release_reason": reason,
            "ts": utc_now_iso(),
        })


def release_op_id_forced(op_id: str, reason: str) -> dict:
    """W5-P0-1 / W5-P1-3: release a journal claim WITHOUT the raw claim
    token. System/operator use only, never a normal dispatch path.

    Two callers: (1) sweep_stale_pending, retiring TTL-expired
    browser-lane orphans whose pending envelope (and therefore the raw
    token) is gone; the envelope no longer stores the raw token at all,
    so the sweep cannot present one. (2) the `claim-release` operator
    CLI, freeing an op_id bricked by a crashed raw-lane dispatch whose
    in-memory token died with the process (W5-P1-3).

    Threat model: release_op_id still requires the token, so a file-read
    attacker (journal, envelope) can neither free nor adopt a live
    claim. This function is reachable only by code execution as the
    educator's uid or by the operator CLI; same-uid code execution is
    outside the claim-token threat model (it can already journal
    anything under the sealed lock). The release is journaled with
    forced=true and the reason, so forensics can tell it apart from a
    token-holder release.

    Returns {"op_id", "released", "detail"}: released is False (not an
    error) when the latest record is already terminal, so the TTL
    sweeper stays idempotent. Raises DuplicateOpId when the op_id was
    never claimed."""
    op_id = str(op_id)
    with _journal_locked():
        state = _journal_state_locked()
        if op_id not in state["op_ids"]:
            raise DuplicateOpId(
                "op id %s is not claimed; nothing to release" % op_id)
        # Search the op's locations like release_op_id: the claim may
        # have rotated into an archive while the op was in flight.
        locations = state["locations"]
        loc = locations.get(op_id)
        search = []
        if loc == "live" or loc is None:
            search.append(JOURNAL_PATH)
        if loc is not None and loc != "live":
            search.append(os.path.join(_journal_archive_dir(), loc))
        latest = None
        for path in search:
            for rec in _scan_journal_file(path):
                # Audit records are side evidence, not reservation state.
                if str(rec.get("op_id")) == op_id and \
                        rec.get("wal") != "audit":
                    latest = rec
        if latest is None or latest.get("wal") not in ("pending", "claimed"):
            return {"op_id": op_id, "released": False,
                    "detail": "latest record is wal=%s; no live claim to "
                              "release" % (latest.get("wal")
                                           if latest else None)}
        _append_record_locked({
            "op_id": op_id,
            "kind": "release",
            "wal": "released",
            "forced": True,
            "release_reason": reason,
            "ts": utc_now_iso(),
        })
        return {"op_id": op_id, "released": True,
                "detail": "live claim released without token: %s" % reason}


def journal_pending_ops():
    """Pending write claims with no completion record: the reconcile list.

    A crashed dispatch leaves exactly this: a wal="pending" record and no
    completion. Returns [{op_id, entry_name, kind, ts, ...}]. Archives
    are included: a pending claim may have rotated out of the live
    journal while the op was in flight. W2-P1-32: legacy-journal
    pendings are included with journal="legacy" provenance (read-only
    visibility for pre-upgrade crashes, never merged).

    W5-P2-5: archives are ingested one file at a time (grouped into
    by_op incrementally) instead of concatenating every archive's full
    record list first: peak memory is one archive, not all of them.
    With W5-P1-1's archive cap the total work per call is bounded too.
    """
    with _journal_locked():
        by_op = {}

        def _ingest(path, journal_label):
            for r in _scan_journal_file(path):
                op_id = r.get("op_id")
                if op_id:
                    by_op.setdefault(
                        str(op_id), []).append(dict(r, journal=journal_label))

        _ingest(JOURNAL_PATH, "tree")
        try:
            archive_names = sorted(os.listdir(_journal_archive_dir()))
        except OSError:
            archive_names = []
        for name in archive_names:
            _ingest(os.path.join(_journal_archive_dir(), name),
                    "archive:" + name)
    if (os.path.exists(LEGACY_JOURNAL_PATH)
            and os.path.abspath(LEGACY_JOURNAL_PATH)
            != os.path.abspath(JOURNAL_PATH)):
        for r in _scan_journal_file(LEGACY_JOURNAL_PATH, verify=False):
            op_id = r.get("op_id")
            if op_id:
                by_op.setdefault(str(op_id), []).append(
                    dict(r, journal="legacy"))
    pending = []
    for op_id, recs in by_op.items():
        wals = [r.get("wal") for r in recs]
        if "pending" in wals and "complete" not in wals \
                and "released" not in wals:
            claim = next(r for r in recs if r.get("wal") == "pending")
            pending.append({"op_id": op_id,
                            "entry_name": claim.get("entry_name"),
                            "kind": claim.get("kind"),
                            "ts": claim.get("ts"),
                            "journal": claim.get("journal", "tree")})
    return pending


def journal_status():
    """Validate the journal and report health (used by the CLI)."""
    with _journal_locked():
        state = _journal_state_locked()
        pending = []
        # W5-P2-5: ingest one file at a time (see journal_pending_ops);
        # peak memory is one archive, not all of them.
        by_op = {}

        def _ingest(path):
            for rec in _scan_journal_file(path):
                if rec.get("op_id"):
                    by_op.setdefault(str(rec["op_id"]), []).append(rec)

        _ingest(JOURNAL_PATH)
        try:
            archive_names = sorted(os.listdir(_journal_archive_dir()))
        except OSError:
            archive_names = []
        for name in archive_names:
            _ingest(os.path.join(_journal_archive_dir(), name))
        for op_id, recs in by_op.items():
            wals = [r.get("wal") for r in recs]
            if "pending" in wals and "complete" not in wals \
                    and "released" not in wals:
                pending.append(op_id)
        idx = _read_index() or {}
        return {"live_bytes": _journal_live_size(),
                "known_op_ids": len(state["op_ids"]),
                "pending_writes": sorted(pending),
                "archives": list(idx.get("archives") or []),
                "torn": False}


def _adopt_journal_locked(reseal_all=False):
    """Adopt the current journal bytes as the integrity trust anchor.

    Shared by journal_seal and journal_repair (both hold the journal
    lock). Every unsealed record in the live journal and the archives is
    sealed in place (rewritten atomically); any plaintext claim_token is
    replaced by its hash (W4-P0-2); the sidecar index is rebuilt sealed
    from scratch, with archive locations re-derived from the sealed
    files (the old index is untrusted at this point: missing, pre-HMAC,
    or forged).

    A record that carries a seal which does NOT verify is tampering,
    not legacy: adoption refuses with JournalIntegrityError instead of
    blessing it. Returns (total_records, sealed_records, tokens_hashed).

    reseal_all (used by reseal_journal, W6-P1-2): additionally re-seal
    every already-sealed record under the ACTIVE key after verifying it
    against the keyring. This is the non-punitive path to dropping a
    retired key: once every record is sealed under the active key,
    retire-secret can remove the old key without turning any read
    fail-closed.
    """
    # W6-P2-7: use-then-zero; the buffer is overwritten when the
    # adoption finishes (or raises).
    with _journal_secret_ctx() as _secret_buf:
        secret = _secret_buf.view()
        keyring = _read_secret_keyring()
        archive_dir = _journal_archive_dir()
        try:
            archive_names = sorted(os.listdir(archive_dir))
        except OSError:
            archive_names = []
        sealed = 0
        hashed = 0
        total = 0

        def _seal_file(path):
            nonlocal sealed, hashed, total
            # verify=False: legacy records are readable here; torn lines
            # still raise JournalTorn (repair the tear first).
            records = _scan_journal_file(path, verify=False)
            changed = False
            lines = []
            for rec in records:
                rec = dict(rec)
                total += 1
                mac = rec.get("rec_hmac")
                if isinstance(mac, str) and mac.startswith(_JOURNAL_HMAC_PREFIX):
                    # W6-P1-2: verify against the whole keyring: records
                    # sealed under a retired (pre-rotation) key are
                    # legitimate, not tampering.
                    if not _record_seal_valid_any(rec, keyring):
                        raise JournalIntegrityError(
                            "journal %s (op_id %r): record carries a seal that "
                            "does NOT verify: the record was tampered with. "
                            "Refusing to adopt it: investigate, restore from "
                            "backup, and reconcile the affected op against the "
                            "provider." % (path, rec.get("op_id")))
                    if reseal_all:
                        # W6-P1-2: the seal verified against the keyring,
                        # so this record is legitimate: re-seal it under
                        # the ACTIVE key. After reseal-journal, no record
                        # depends on a retired key, and retire-secret can
                        # drop the old key without breaking reads.
                        rec.pop("rec_hmac", None)
                        _seal_record(rec, secret)
                        sealed += 1
                        changed = True
                else:
                    if "claim_token" in rec:
                        rec["claim_token_hash"] = _claim_token_hash(
                            rec.pop("claim_token"))
                        hashed += 1
                    rec.pop("claim_token", None)
                    _seal_record(rec, secret)
                    sealed += 1
                    changed = True
                lines.append((canonical(rec) + "\n").encode("utf-8"))
            if changed:
                tmp = path + ".seal." + _writer_tmp_suffix()
                # W6-P2-2: 0600 at open, never open-then-chmod.
                _sfd = _open_secret_tmp(tmp)
                with os.fdopen(_sfd, "wb") as fh:
                    for chunk in lines:
                        fh.write(chunk)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, path)
                try:
                    dfd = os.open(os.path.dirname(path), os.O_RDONLY)
                    try:
                        os.fsync(dfd)
                    finally:
                        os.close(dfd)
                except OSError:
                    pass

        _seal_file(JOURNAL_PATH)
        for name in archive_names:
            _seal_file(os.path.join(archive_dir, name))
        # Rebuild the sealed index from scratch: archives first
        # (chronological), then the live journal, so the newest record for
        # each op_id decides.
        op_ids = set()
        locations = {}
        for name in archive_names:
            for rec in _scan_journal_file(os.path.join(archive_dir, name)):
                op_id = rec.get("op_id")
                if not op_id:
                    continue
                op_id = str(op_id)
                if rec.get("wal") == "released":
                    op_ids.discard(op_id)
                else:
                    op_ids.add(op_id)
                locations[op_id] = name
        for rec in _scan_journal_file(JOURNAL_PATH):
            op_id = rec.get("op_id")
            if not op_id:
                continue
            op_id = str(op_id)
            if rec.get("wal") == "released":
                op_ids.discard(op_id)
            else:
                op_ids.add(op_id)
            locations[op_id] = "live"
        _write_index({"journal_size": _journal_live_size(),
                      "archives": archive_names,
                      "op_ids": sorted(op_ids),
                      "locations": locations})
        # W6-P1-2: adopting the bytes as the trust anchor re-anchors
        # the generation past the high-water mark (via _write_index),
        # so a restore marker (if any) is satisfied by this ceremony:
        # the operator explicitly blessed these bytes with --yes.
        try:
            os.unlink(_journal_restored_marker_path())
        except OSError:
            pass
        return total, sealed, hashed


def _count_records_sealed_under(key_id, ring):
    """How many records (live journal + archives) verify under key_id."""
    key = ring["keys"][key_id]
    paths = []
    if os.path.exists(JOURNAL_PATH):
        paths.append(JOURNAL_PATH)
    try:
        archive_names = sorted(os.listdir(_journal_archive_dir()))
    except OSError:
        archive_names = []
    for name in archive_names:
        paths.append(os.path.join(_journal_archive_dir(), name))
    n = 0
    for path in paths:
        for rec in _scan_journal_file(path, verify=False):
            if _record_seal_valid(rec, key):
                n += 1
    return n


def reseal_journal():
    """W6-P1-2: re-seal every journal record under the ACTIVE secret.

    Every record is verified against the keyring BEFORE its seal is
    replaced: a seal that verifies under no ring key is tampering and
    fails closed, never re-blessed. After this call no record depends
    on a retired key, so `retire-secret <kid>` can drop the old key
    without turning any read fail-closed, and a compromised retired
    key loses its forgery power: the compromise finally has an expiry.

    Incident-response order: rotate-secret -> reseal-journal ->
    retire-secret <old-kid>. The caller must hold the journal lock OR
    call this from a single operator process (the CLI takes the lock).
    Returns {"resealed": n, "records": total, "tokens_hashed": n}.
    """
    with _journal_locked():
        total, sealed, hashed = _adopt_journal_locked(reseal_all=True)
        return {"resealed": sealed, "records": total,
                "tokens_hashed": hashed}


def retire_journal_secret(key_id):
    """W6-P1-2: drop a RETIRED journal HMAC key from the keyring.

    A retired key that stays in the ring keeps full forgery power: any
    record forged under it verifies. Dropping it is what gives a key
    compromise an expiry. Refuses to retire the ACTIVE key, refuses an
    unknown key id, and refuses while any record is still sealed under
    the key (that would turn those reads fail-closed: run
    reseal-journal first). The caller must hold the journal lock OR
    call this from a single operator process (the CLI takes the lock).
    Returns {"retired": key_id}.
    """
    with _journal_locked():
        ring = _read_secret_keyring()
        if ring is None:
            raise JournalIntegrityError(
                "no journal secret keyring exists; nothing to retire")
        if key_id not in ring["keys"]:
            raise JournalIntegrityError(
                "unknown journal secret key id %r" % (key_id,))
        if key_id == ring["active"]:
            raise JournalIntegrityError(
                "cannot retire the ACTIVE journal secret (%r): rotate to a "
                "new key first, then retire the old one" % (key_id,))
        still = _count_records_sealed_under(key_id, ring)
        if still:
            raise JournalIntegrityError(
                "%d journal record(s) are still sealed under retired key "
                "%r; retiring it would turn those reads fail-closed. Run "
                "`python3 dispatch/executor.py reseal-journal` first so "
                "every record is re-sealed under the active key."
                % (still, key_id))
        del ring["keys"][key_id]
        _write_secret_keyring_locked(ring)
        return {"retired": key_id}


def journal_seal():
    """Explicit one-time re-seal of a pre-HMAC journal (W4-P0-1 upgrade path).

    Journals written before the integrity seal fail closed on first
    open; this is the documented explicit step that adopts the current
    journal bytes as the trust anchor. Refuses to run when the journal
    is already sealed and the index verifies: re-blessing a sealed
    journal would silently adopt post-seal tampering, so an integrity
    failure must be investigated first, never re-sealed blindly.

    Sealing CANNOT detect tampering that predates the seal. Reconcile
    in-flight ops against the provider (journal_pending_ops) BEFORE
    sealing. Pre-seal claim tokens appeared in plaintext in the old
    journal: treat them as exposed and reconcile those ops rather than
    trusting their claims.
    """
    with _journal_locked():
        if not os.path.exists(JOURNAL_PATH):
            return {"sealed": False,
                    "detail": "no journal file; nothing to seal"}
        try:
            _scan_journal_file(JOURNAL_PATH)
            try:
                archive_names = sorted(os.listdir(_journal_archive_dir()))
            except OSError:
                archive_names = []
            for name in archive_names:
                _scan_journal_file(os.path.join(_journal_archive_dir(), name))
            if _read_index() is not None:
                return {"sealed": False,
                        "detail": "journal is already sealed and the sidecar "
                                 "index verifies; refusing to re-seal. If "
                                 "you suspect tampering, investigate before "
                                 "re-blessing these bytes."}
        except JournalIntegrityError:
            pass  # adopt the current bytes as the trust anchor below
        # JournalTorn propagates: quarantine/repair the torn tail first.
        total, sealed, hashed = _adopt_journal_locked()
        return {"sealed": True, "records": total,
                "sealed_records": sealed, "tokens_hashed": hashed,
                "detail": "adopted the current journal bytes as the trust "
                          "anchor. This cannot detect tampering that "
                          "predates the seal: in-flight ops must have been "
                          "reconciled against the provider first, and "
                          "pre-seal claim tokens should be treated as "
                          "exposed."}


def journal_reconcile():
    """Post-restore reconcile (W6-P1-2).

    The state-restore tool writes journal/restored_from.json and the
    journal stays fail-closed until this runs. It verifies the live
    journal (torn lines raise JournalTorn), verifies the sealed sidecar
    index, verifies the retired set's seal, then rebuilds the index,
    which re-anchors the generation past the high-water mark, and
    clears the restore marker.

    A STALE restore (index generation behind the high-water mark) is
    REFUSED: restore the newest backup instead. journal-seal --yes is
    the explicit override that blesses the current bytes as the trust
    anchor.
    """
    with _journal_locked():
        marker = _journal_restored_marker_path()
        records = _scan_journal_file(JOURNAL_PATH)
        idx = _read_index()
        if idx is None:
            raise JournalIntegrityError(
                "no trusted sidecar index for journal %s: reconcile "
                "cannot verify the restore. Run `journal-seal` to adopt "
                "the current bytes as the trust anchor instead."
                % JOURNAL_PATH)
        idx_gen = idx.get("generation") or 0
        try:
            idx_gen = int(idx_gen)
        except (ValueError, TypeError):
            idx_gen = 0
        hw = _read_generation_highwater()
        if idx_gen < hw:
            raise JournalIntegrityError(
                "STALE restore: the restored index is at generation %d "
                "but this tree already wrote generation %d. Refusing to "
                "reconcile a stale backup (its op_ids were already "
                "consumed after the backup). Restore the newest backup "
                "and reconcile again; or, if no newer backup exists and "
                "you have reconciled in-flight ops against the provider, "
                "use `journal-seal --yes` to explicitly bless these "
                "bytes as the new trust anchor." % (idx_gen, hw))
        retired = _retired_op_ids()
        state = _rebuild_index_locked()
        new_gen = (_read_index() or {}).get("generation")
        try:
            os.unlink(marker)
        except OSError:
            pass
        return {"reconciled": True, "records": len(records),
                "op_ids": len(state["op_ids"]), "retired": len(retired),
                "generation": new_gen,
                "detail": "journal verified, retired set seal verified, "
                          "generation re-anchored at %s, restore marker "
                          "cleared. Reconcile in-flight ops against the "
                          "provider before dispatching." % new_gen}


def retired_seal():
    """One-time adoption of a pre-seal retired set (W6-P1-5 upgrade path).

    Retired sets written before the integrity seal fail closed on first
    read; this explicit step verifies the operator has reconciled, then
    seals the current retired_opids.jsonl bytes with the active journal
    secret and refreshes the sealed sidecar index's retired metadata.
    Refuses when the file is already sealed and verifying.
    """
    with _journal_locked():
        path = _journal_retired_path()
        if not os.path.exists(path):
            return {"sealed": False,
                    "detail": "no retired set file; nothing to seal"}
        # Already sealed and verifying: refuse to re-bless.
        try:
            ids = _retired_op_ids()
            return {"sealed": False,
                    "detail": "retired set is already sealed and "
                             "verifies (%d ids); refusing to re-seal."
                             % len(ids)}
        except JournalIntegrityError:
            pass  # adopt the current bytes below
        ids = _retired_read_unverified()
        _write_retired_seal()
        idx = _read_index()
        if idx is not None:
            _write_index({k: v for k, v in idx.items()
                          if k not in ("index_hmac",)})
        return {"sealed": True, "ids": len(ids),
                "detail": "adopted the current retired_opids.jsonl bytes "
                          "as the trust anchor and sealed them. This "
                          "cannot detect tampering that predates the "
                          "seal: the retired op_ids must have been "
                          "reconciled before sealing."}


def journal_recover_secret(reason):
    """Secret-loss recovery: re-key under a new secret (W6-P1-3).

    When the journal HMAC secret is lost or corrupted, sealed records
    can never verify again: their cryptographic provenance is
    unrecoverable, and journal-seal REFUSES sealed-but-unverifiable
    records (it must not bless what it cannot verify). Before this
    ceremony the only recovery was deleting the journal, which reset
    ALL op-id replay protection to zero.

    This is the documented re-key ceremony (reconcile-all -> new
    secret -> re-seal). It preserves what CAN be preserved, the op_id
    replay-protection set, under a fresh secret:

      1. Quarantine the corrupt secret file for forensics (if present).
      2. Scan the live journal and archives WITHOUT verification (the
         secret is gone; torn lines still raise JournalTorn: repair
         the tear first).
      3. Mint a new secret.
      4. Strip the old (unverifiable) seals and re-seal every record
         under the new secret.
      5. Journal an audit record documenting the recovery, the reason,
         and the provenance downgrade.
      6. Rebuild the sealed sidecar index from scratch (generation
         re-anchored past the high-water mark) and re-seal the retired
         set, preserving every op_id.
      7. Clear the restore marker.

    The operator MUST reconcile in-flight ops against the provider
    FIRST: without the old secret a planted record is
    indistinguishable from a legitimate one, and re-sealing blesses
    whatever bytes exist. Requires --yes and a --reason (min 20
    chars), journaled in the audit record.
    """
    with _journal_locked():
        secret_path = _journal_secret_path()
        quarantined = None
        if os.path.exists(secret_path):
            quarantined = secret_path + ".corrupt.%d" % int(time.time())
            os.replace(secret_path, quarantined)
        live_records = _scan_journal_file(JOURNAL_PATH, verify=False)
        try:
            archive_names = sorted(os.listdir(_journal_archive_dir()))
        except OSError:
            archive_names = []
        archive_records = {}
        for name in archive_names:
            archive_records[name] = _scan_journal_file(
                os.path.join(_journal_archive_dir(), name), verify=False)
        retired_ids = _retired_read_unverified()
        # Mint the new secret (the old file is quarantined above, so
        # this always mints fresh).
        # W6-P2-7: use-then-zero; the buffer is overwritten on exit.
        with _journal_secret_ctx() as _s:
            _secret_view = _s.view()

            def _resign(path, records):
                lines = []
                for rec in records:
                    rec = dict(rec)
                    rec.pop("rec_hmac", None)
                    _seal_record(rec, _secret_view)
                    lines.append((canonical(rec) + "\n").encode("utf-8"))
                tmp = path + ".resign." + _writer_tmp_suffix()
                sfd = _open_secret_tmp(tmp)
                with os.fdopen(sfd, "wb") as fh:
                    for chunk in lines:
                        fh.write(chunk)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, path)
                try:
                    dfd = os.open(os.path.dirname(path), os.O_RDONLY)
                    try:
                        os.fsync(dfd)
                    finally:
                        os.close(dfd)
                except OSError:
                    pass
                return len(lines)

            total = _resign(JOURNAL_PATH, live_records)
            for name in archive_names:
                total += _resign(os.path.join(_journal_archive_dir(), name),
                                 archive_records[name])
            # Audit record, sealed under the new secret, appended raw
            # (the sidecar index is rebuilt from scratch below).
            import uuid as _uuid
            audit_rec = _seal_record({
                "op_id": str(_uuid.uuid4()),
                "wal": "audit",
                "entry_name": "secret-loss-recovery",
                "ts": utc_now_iso(),
                "reason": reason,
                "quarantined_secret": quarantined,
                "records_resigned": total,
                "detail": "Journal HMAC secret was lost/corrupted and "
                          "could not be restored from backup. All records "
                          "were re-sealed under a new secret WITHOUT "
                          "cryptographic verification of the old seals: "
                          "provenance is downgraded to operator "
                          "attestation (in-flight ops were reconciled "
                          "against the provider before this recovery). "
                          "The op_id replay-protection set is preserved.",
            }, _secret_view)
            line = (canonical(audit_rec) + "\n").encode("utf-8")
            fd = os.open(JOURNAL_PATH,
                         os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                view = memoryview(line)
                while view:
                    n = os.write(fd, view)
                    view = view[n:]
                os.fsync(fd)
            finally:
                os.close(fd)
        # Rebuild the sealed index from the re-sealed bytes (also
        # re-anchors the generation past the high-water mark and
        # refreshes the retired metadata), then re-seal the retired set
        # so its op_ids stay replay-protected under the new secret.
        #
        # W6-P1-3: the old sidecar index is sealed under the LOST
        # secret; _read_index would raise before rebuilding. Quarantine
        # it for forensics and rebuild from the re-sealed journal.
        _idx_path = _journal_index_path()
        if os.path.exists(_idx_path):
            os.replace(_idx_path,
                       _idx_path + ".corrupt.%d" % int(time.time()))
        state = _rebuild_index_locked()
        if os.path.exists(_journal_retired_path()):
            _write_retired_seal()
            _write_index({k: v for k, v in (_read_index() or {}).items()
                          if k != "index_hmac"})
            state = _rebuild_index_locked()
        try:
            os.unlink(_journal_restored_marker_path())
        except OSError:
            pass
        return {"recovered": True,
                "records_resigned": total,
                "retired_preserved": len(retired_ids),
                "op_ids": len(state["op_ids"]),
                "quarantined_secret": quarantined,
                "detail": "re-keyed under a new secret; %d op_ids stay "
                          "replay-protected. Cryptographic provenance of "
                          "pre-recovery records is downgraded to operator "
                          "attestation (see the secret-loss-recovery audit "
                          "record in the journal)." % len(state["op_ids"])}


def journal_repair():
    """Quarantine a torn tail and truncate the live journal to the last
    good line, then re-seal and rebuild the index.

    The torn bytes are preserved in a content-addressed .torn.<sha256>
    quarantine file next to the journal (one per distinct torn state);
    nothing is deleted silently. The operator must
    reconcile the affected op against the provider (journal_pending_ops /
    the quarantine file) before re-dispatching it.

    W4-P0-1: after truncation the journal is re-sealed through the same
    adopt step as journal-seal (_adopt_journal_locked): unsealed records
    are sealed, plaintext claim tokens are hashed, and the sidecar index
    is rebuilt sealed from scratch. A record whose seal fails
    verification is tampering, not a torn tail: repair refuses with
    JournalIntegrityError instead of blessing it."""
    with _journal_locked():
        try:
            _scan_journal_file(JOURNAL_PATH)
            return {"repaired": False, "detail": "journal is valid; nothing to repair"}
        except JournalTorn:
            pass
        # Find the first bad line without raising: rescan manually.
        good_bytes = 0
        bad_lineno = None
        bad_preview = ""
        with open(JOURNAL_PATH, "rb") as fh:
            raw = fh.read()
        offset = 0
        for lineno, line in enumerate(raw.split(b"\n"), 1):
            if not line.strip():
                offset += len(line) + 1
                continue
            try:
                json.loads(line.decode("utf-8"))
            except ValueError:
                bad_lineno = lineno
                bad_preview = line[:120].decode("utf-8", "replace")
                break
            offset += len(line) + 1
            good_bytes = offset
        # Content-addressed: reuses the quarantine copy the JournalTorn
        # scan already made for this exact torn state instead of writing
        # a second one.
        qpath = _quarantine_journal(JOURNAL_PATH, raw)
        with open(JOURNAL_PATH, "r+b") as fh:
            fh.truncate(good_bytes)
            fh.flush()
            os.fsync(fh.fileno())
        total, sealed, hashed = _adopt_journal_locked()
        # W6-P2-E3: the preview is raw torn journal bytes (it can
        # carry provider error bodies and partial records), so it is
        # labeled exactly like other untrusted text: never mistake it
        # for connector-authored output when pasted into chat.
        return {"repaired": True, "quarantine": qpath,
                "torn_lineno": bad_lineno,
                "torn_preview": ("[untrusted journal data follows] "
                                 + bad_preview),
                "records": total, "sealed_records": sealed,
                "tokens_hashed": hashed,
                "detail": "torn tail quarantined; reconcile the affected op "
                          "against the provider before re-dispatching"}


# --------------------------------------------------------------------------
# Reference resolution: params.*, result.*, transient.* and literals
# --------------------------------------------------------------------------

_TEMPLATE_TOKEN = re.compile(r"\{([^{}]+)\}")


def resolve_ref(value, params: dict, result_payload=None, transients: dict = None):
    """Resolve a manifest value reference to a concrete value."""
    transients = transients or {}
    if isinstance(value, str):
        if value.startswith("params."):
            key = value[len("params."):]
            return params.get(key)
        if value.startswith("transient."):
            key = value[len("transient."):]
            if key not in transients:
                raise ExecutorError("transient value %r was never captured" % key)
            return transients[key]
        if value.startswith("result."):
            if result_payload is None:
                raise ExecutorError("reference %r has no result payload yet" % value)
            return resolve_path(result_payload, value[len("result."):])
        return value
    if isinstance(value, dict):
        return {k: resolve_ref(v, params, result_payload, transients) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_ref(v, params, result_payload, transients) for v in value]
    return value


# Path slots that are not numeric ids even though some end in "_id".
_FREE_SEGMENT_SLOTS = frozenset({
    "url_or_id", "tab_id", "anonymous_id", "report_type", "feature",
    "date", "title", "item", "bank", "page_url", "url",
})
# Numeric ids, Canvas SIS ids, and the learner-vault tokens (lrn_...,
# learner_<uuid>) that stand in for learner ids until the lane
# resolves them.
_ID_SEGMENT_RE = re.compile(
    r"^(?:\d+|sis_[a-z_]+:[A-Za-z0-9_.@\-]+|lrn_[A-Za-z0-9_\-]+"
    r"|learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
_FREE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.~:@\-]+$")
_MAX_SEGMENT_LEN = 256


def _checked_path_segment(token: str, value) -> str:
    """Validate and percent-encode one caller-supplied path parameter.

    A path parameter is exactly one URL path segment: "/", "?", "#",
    "\\", "..", whitespace, and control characters could re-route the
    request (another endpoint, an injected query, a dropped suffix), so
    they are refused, never encoded. Id-shaped slots (id, *_id) must be
    numeric, a Canvas SIS id (sis_<kind>:<value>), or a learner token; user_id may also be
    "self"."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ExecutorError(
            "path parameter {%s} must be a string or integer, got %s"
            % (token, type(value).__name__))
    text = str(value)
    if (not text or len(text) > _MAX_SEGMENT_LEN or text in (".", "..")
            or ".." in text or not _FREE_SEGMENT_RE.fullmatch(text)):
        raise ExecutorError(
            "path parameter {%s} is not a single safe URL path segment "
            "(refused: empty, '/', '?', '#', '\\', '..', whitespace, or "
            "control characters); nothing was sent" % token)
    if token not in _FREE_SEGMENT_SLOTS and (
            token == "id" or token.endswith("_id")):
        if not (_ID_SEGMENT_RE.fullmatch(text)
                or (token == "user_id" and text == "self")):
            raise ExecutorError(
                "path parameter {%s} must be a numeric id, a Canvas SIS id "
                "(sis_<kind>:<value>), or a learner token; got a value of "
                "another shape. "
                "Nothing was sent." % token)
    return urllib.parse.quote(text, safe=":@~._-")


def render_template(template: str, config: dict, params: dict,
                    result_payload=None, transients: dict = None) -> str:
    """Fill {slot} tokens. Config values (the tenant base) and captured
    transients are trusted and inserted as-is; caller params are
    validated as one path segment in the path part of the template and
    percent-encoded in the query part."""
    query_start = template.find("?")

    def repl(match):
        token = match.group(1)
        if token in config:
            return str(config[token])
        if transients and token in transients:
            return str(transients[token])
        if token.startswith("result."):
            # Undo and verify blocks address the object the write created.
            resolved = resolve_ref(token, params, result_payload, transients)
            slot = token.rsplit(".", 1)[-1]
        else:
            resolved = resolve_ref("params." + token, params, result_payload,
                                   transients)
            slot = token
        if resolved is None:
            raise ExecutorError("template slot {%s} has no value" % token)
        if 0 <= query_start < match.start():
            if isinstance(resolved, bool) or not isinstance(
                    resolved, (str, int, float)):
                raise ExecutorError(
                    "query parameter {%s} must be a scalar" % token)
            return urllib.parse.quote(str(resolved), safe="")
        return _checked_path_segment(slot, resolved)

    return _TEMPLATE_TOKEN.sub(repl, template)


def transients_supply_base(block: dict, transients) -> bool:
    """True when the block's URL starts with a discovery-captured base
    ({<name>} resolved from transients, e.g. the quiz-api host the
    tenant's own tool list names). Such a request is bound to the
    discovered host, not the tenant origin."""
    match = re.match(r"^\{([^{}]+)\}", str(block.get("url") or ""))
    return bool(match and transients and match.group(1) in transients)


def _same_origin(url: str, base: str) -> bool:
    try:
        a = urllib.parse.urlsplit(url)
        b = urllib.parse.urlsplit(base)
    except ValueError:
        return False
    if a.username or a.password or "@" in (a.netloc or ""):
        return False

    def port(parts):
        return parts.port or {"https": 443, "http": 80}.get(parts.scheme)
    return (a.scheme.lower() == b.scheme.lower()
            and (a.hostname or "").lower() == (b.hostname or "").lower()
            and port(a) == port(b))


# --------------------------------------------------------------------------
# Header construction (egress injection)
# --------------------------------------------------------------------------

def build_headers(entry: dict, headers_spec: dict, session: SessionStore,
                  params: dict, transients: dict, pack: dict,
                  is_write: bool, dry_run: bool = False) -> dict:
    """Resolve header specs. {"credential": slot} injects at egress;
    {"session_value": slot} reads a visible stored value; {"transient": name}
    reads a captured multi-step value. Then the entry's auth slot injects its
    declared header unless the headers already set it.

    W4-P2-26: dry_run=True never resolves actual secret material. Credential
    slots render as "***REDACTED***" without touching the session store, so
    a dry-run cannot leak secrets into its report or memory.
    """
    out = {}
    for name, spec in (headers_spec or {}).items():
        if isinstance(spec, dict) and "credential" in spec:
            if dry_run:
                # W4-P2-26: never resolve secret material during a dry-run.
                out[name] = "***REDACTED***"
                continue
            slot = spec["credential"]
            is_secret, material = _resolve_slot_with_alternates(
                entry, session, slot)
            scheme = spec.get("scheme")
            if isinstance(material, dict):
                out[name] = inject_cookie_header(material)
            else:
                out[name] = ("%s %s" % (scheme, material)) if scheme else material
        elif isinstance(spec, dict) and "session_value" in spec:
            slot = spec["session_value"]
            is_secret, material = session.slot_secret(slot)
            if is_secret:
                raise ExecutorError(
                    "session_value requested for secret slot %r; use credential injection" % slot)
            out[name] = str(material)
        elif isinstance(spec, dict) and "transient" in spec:
            key = spec["transient"]
            if key not in (transients or {}):
                raise ExecutorError("transient %r was never captured" % key)
            value = transients[key]
            out[name] = str(value)
        else:
            out[name] = str(resolve_ref(spec, params, None, transients))

    # Default auth-slot injection from the pack's credential_slots declare block
    auth = entry.get("auth") or {}
    slot = auth.get("slot")
    if slot and slot != "local" and not getattr(session, "browser_owned_auth", False):
        # (browser_owned_auth sessions, e.g. the Chromium lane, skip this
        # whole block: the educator's browser owns the authenticated
        # session, so no credential material is injected at egress.)
        slot_decl = ((pack.get("credential_slots") or {}).get(slot)) or {}
        inject = slot_decl.get("inject") or {}
        header_name = inject.get("header")
        scheme = inject.get("scheme")
        if header_name and header_name not in out:
            if dry_run:
                # W4-P2-26: never resolve secret material during a dry-run.
                out[header_name] = "***REDACTED***"
            else:
                is_secret, material = _resolve_slot_with_alternates(entry, session, slot)
                if isinstance(material, dict):
                    out[header_name] = inject_cookie_header(material)
                else:
                    out[header_name] = ("%s %s" % (scheme, material)) if scheme else material
        # Derived headers for session-cookie auth were a Model B mechanism
        # (X-CSRF-Token read from the stored _csrf_token cookie). Retired
        # 2026-09-20 with the cookie-jar slots: any pack still declaring a
        # derive rule fails closed instead of silently doing nothing.
        for rule in slot_decl.get("derive", []) or []:
            raise ExecutorError(
                "credential derive rules are retired with Model B "
                "(rule: %r); the installed product uses the chromium lane"
                % (rule,))
    # W5-P2-2: structural header validation at build time. Params-derived
    # values reach here raw (resolve_ref); a CRLF/control character must
    # fail here, not depend on the lane's send-time behavior.
    for _hn, _hv in out.items():
        validate_http_header(_hn, _hv, where="build_headers")
    return out


def _resolve_slot_with_alternates(entry: dict, session: SessionStore, slot: str):
    auth = entry.get("auth") or {}
    candidates = [slot] + [a for a in (auth.get("alternates") or []) if a != slot]
    last = None
    for candidate in candidates:
        try:
            return session.slot_secret(candidate)
        except SessionMissing as exc:
            last = exc
            continue
    raise SessionMissing(
        "no credential material for slot %r (tried: %s): %s"
        % (slot, ", ".join(candidates), last)
    )


# --------------------------------------------------------------------------
# HTTP transport with retry discipline
# --------------------------------------------------------------------------

class _NoDowngradeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Redirect policy for the provider HTTPS lane (W4-P2-7).

    The stdlib's HTTPRedirectHandler follows 301/302/303/307/308
    silently, including an https:// -> http:// downgrade, and re-sends
    every request header (Authorization included) to the redirect
    target. This subclass, installed on the executor's opener below:

    - REFUSES an https->http downgrade loudly (fail closed): a
      redirect that would drop the provider bearer token onto
      plaintext raises RedirectDowngradeRefused.
    - REFUSES a redirect to any other host or port: the lane only
      talks to the configured LMS host.
    - STRIPS Authorization and Proxy-Authorization on any scheme
      change, even same-host (stock stdlib keeps the headers).

    Same-scheme, same-host redirects are followed as before.
    """

    _SENSITIVE_HEADERS = ("authorization", "proxy-authorization")

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old = urllib.parse.urlparse(req.full_url)
        # Location may be relative ("/plain"); resolve it against the
        # request URL before judging the scheme, or a relative
        # downgrade target would slip past the check.
        new = urllib.parse.urlparse(
            urllib.parse.urljoin(req.full_url, newurl))
        if (new.hostname or "").lower() != (old.hostname or "").lower() \
                or (new.port or None) != (old.port or None):
            raise RedirectDowngradeRefused(
                "refused redirect off the LMS host: %s -> %s (every "
                "request stays on the configured tenant host)"
                % (_redacted_url(req.full_url), _redacted_url(
                    urllib.parse.urljoin(req.full_url, newurl))))
        if old.scheme == "https" and new.scheme == "http":
            raise RedirectDowngradeRefused(
                "refused https->http redirect downgrade: %s -> %s "
                "(the provider Authorization header would cross "
                "plaintext)" % (req.full_url, newurl))
        redir = super().redirect_request(
            req, fp, code, msg, headers, newurl)
        if redir is not None:
            host_changed = (new.hostname or "").lower() != \
                (old.hostname or "").lower()
            if host_changed or new.scheme != old.scheme:
                for name in list(redir.headers.keys()):
                    if name.lower() in self._SENSITIVE_HEADERS:
                        del redir.headers[name]
        return redir


# Module-level opener: identical to urllib.request.urlopen's default
# opener except the redirect handler above replaces the stock one.
# _do_request goes through this opener so every provider HTTPS call
# inherits the no-downgrade policy; nothing else in the tree is
# affected (no global install_opener).
_SAFE_OPENER = urllib.request.build_opener(_NoDowngradeRedirectHandler())


def _do_request(method: str, url: str, headers: dict, body_bytes, timeout: int,
              max_bytes: int = None):
    """One HTTP round trip with a bounded read (W2-P2-8).

    The body is streamed in chunks and the read stops at max_bytes + 1
    (the +1 tells apply_result_block the payload was truncated): a ~5 MB
    provider response is never fully held and multiplied in memory before
    the bound applies."""
    limit = (DEFAULT_MAX_BYTES if max_bytes is None else max_bytes) + 1

    def _read_bounded(resp):
        chunks = []
        remaining = limit
        while remaining > 0:
            chunk = resp.read(min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    req = urllib.request.Request(url, data=body_bytes, headers=headers or {}, method=method)
    try:
        with _SAFE_OPENER.open(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), _read_bounded(resp)
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), _read_bounded(exc)


def _backoff_sleep(attempt: int):
    cap = min(8.0, 0.5 * (2 ** attempt))
    time.sleep(random.uniform(0, cap))


def _retry_after_delay(resp_headers):
    """Honor Retry-After when present (W2-P2-7).

    Returns the delay in seconds, clamped to [0, RETRY_AFTER_CAP_S], or
    None when the header is absent or unparseable (caller falls back to
    exponential backoff)."""
    raw = None
    for k, v in (resp_headers or {}).items():
        if k.lower() == "retry-after":
            raw = str(v).strip()
            break
    if not raw:
        return None
    if raw.isdigit():
        return max(0.0, min(float(raw), float(RETRY_AFTER_CAP_S)))
    try:
        when = email.utils.parsedate_to_datetime(raw)
        if when is None:
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        delta = (when - datetime.now(timezone.utc)).total_seconds()
        return max(0.0, min(delta, float(RETRY_AFTER_CAP_S)))
    except (ValueError, TypeError, OverflowError):
        return None


def _is_transport_retryable(exc: Exception) -> bool:
    # urllib wraps socket/DNS errors as URLError (not HTTPError), but
    # http.client connection-level failures can propagate raw. Reads may
    # retry all of these: a read has no effect to double-apply. (Writes
    # use _is_write_safe_retry instead.)
    if isinstance(exc, (http.client.RemoteDisconnected,
                        http.client.IncompleteRead,
                        ConnectionError, socket.timeout, TimeoutError)):
        return True
    if "timed out" in str(exc).lower():
        return True
    return isinstance(exc, urllib.error.URLError) and not isinstance(exc, urllib.error.HTTPError)


# errnos that prove the handshake never completed: the provider could
# not have seen the request bytes.
_SAFE_RETRY_ERRNOS = frozenset(
    n for n in (getattr(errno, name, None) for name in
                ("ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH",
                 "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL"))
    if n is not None)


def _is_write_safe_retry(exc: Exception) -> bool:
    """True only when the failure PROVES the provider never saw the bytes.

    W2-P0-1: a connection reset AFTER the server applied the write is
    indistinguishable from one before it, so RemoteDisconnected,
    IncompleteRead, timeouts, and reset/broken-pipe ConnectionErrors are
    NEVER safe to retry for writes: they become UncertainWrite. Only
    DNS failures and refused/unreachable connections (the handshake
    never completed) may retry.
    """
    if isinstance(exc, ConnectionRefusedError):
        return True
    if isinstance(exc, urllib.error.URLError) \
            and not isinstance(exc, urllib.error.HTTPError):
        reason = exc.reason
        if isinstance(reason, ConnectionRefusedError):
            return True
        if isinstance(reason, socket.gaierror):
            return True  # DNS resolution failed: no server was reached
        if isinstance(reason, OSError) and reason.errno in _SAFE_RETRY_ERRNOS:
            return True
    return False


def _pat_401_detail():
    """W4-P2-4: honest cause/remedy for a 401 on the token HTTPS lane.

    The 401 proves only that the provider rejected the personal access
    token; it does not prove whether it was revoked, expired, or never
    valid, so the message stays at what the evidence supports. What it
    does prove is the remedy: re-signing in through the browser lane
    cannot fix a rejected token; the educator must mint a fresh one.
    """
    return (
        "HTTP 401: the provider rejected the personal access token "
        "(revoked, expired, or invalid; the 401 alone does not prove "
        "which). Cause: token authorization failure on the HTTPS lane. "
        "Remedy: mint a fresh token in the provider admin console and "
        "configure it again; re-signing in through the login helper "
        "cannot fix this.")


def request_with_retry(method: str, url: str, headers: dict, body_bytes,
                       is_write: bool, max_bytes: int = None):
    """Run one HTTP request with the retry discipline.

    Reads: retry transport errors and 408/429/500/502/503/504; a 429 with
    a Retry-After header sleeps that long (capped at RETRY_AFTER_CAP_S);
    fail fast on other 4xx and 5xx. Writes: retry ONLY on transport
    failures that prove the request never reached the server (DNS
    failure, connection refused, unreachable host). A reset, incomplete read, or timeout after
    the bytes left is indistinguishable from a reset before the server
    applied the write, so those become UncertainWrite, never a silent
    retry (W2-P0-1). A 429 on a write is likewise uncertain (the provider
    may have applied it before throttling); the Retry-After value is
    reported in the detail for reconciliation. Any 5xx with a response
    is uncertain, never retried.
    """
    attempts = 0
    last_exc = None
    while attempts < MAX_ATTEMPTS:
        attempts += 1
        try:
            status, resp_headers, raw = _do_request(
                method, url, headers, body_bytes, REQUEST_TIMEOUT_S,
                max_bytes=max_bytes)
        except Exception as exc:
            # W4-P2-7: a refused redirect downgrade is a deterministic
            # policy refusal, never a transport ambiguity. It propagates
            # untouched: no retry, and never wrapped as UncertainWrite
            # (the provider provably saw nothing; nothing is uncertain).
            if isinstance(exc, RedirectDowngradeRefused):
                raise
            last_exc = exc
            if is_write:
                # Writes: only failures that prove the provider never saw
                # the request may retry. Everything else is ambiguous.
                if _is_write_safe_retry(exc):
                    if attempts < MAX_ATTEMPTS:
                        _backoff_sleep(attempts - 1)
                        continue
                    raise WriteNotAttempted(
                        "write transport failed on every attempt (%s); the "
                        "provider never saw the request"
                        % type(exc).__name__)
                raise UncertainWrite(
                    "write transport failed (%s); effect state unknown, "
                    "not retried" % type(exc).__name__,
                    attempts=attempts,
                    evidence=[{"method": method,
                               "url": _redacted_url(url),
                               "status": "uncertain",
                               "attempts": attempts,
                               "detail": type(exc).__name__}])
            else:
                # LANE2-D1: retry ONLY transport-retryable failures. The old
                # condition OR-ed `"timed out" not in str(exc).lower()`,
                # which is inverted: every exception whose message lacked
                # "timed out" was retried (programming errors, cert
                # failures, ...). _is_transport_retryable already covers
                # TimeoutError and the "timed out" substring.
                if _is_transport_retryable(exc):
                    if attempts < MAX_ATTEMPTS:
                        _backoff_sleep(attempts - 1)
                        continue
                raise ExecutorError("read transport failed: %s" % exc)
        # Every 5xx is a provider failure: a CDN in front of Canvas
        # answers 520-526 while the origin may still apply a write.
        if status in RETRYABLE_STATUSES or status >= 500:
            if is_write:
                detail = ("write returned HTTP %s; effect state unknown, "
                          "not retried" % status)
                if status == 429:
                    delay = _retry_after_delay(resp_headers)
                    if delay is not None:
                        detail += (" (provider asked to wait %ss before "
                                   "retrying)" % delay)
                raise UncertainWrite(
                    detail, attempts=attempts,
                    evidence=[{"method": method, "url": _redacted_url(url),
                               "status": status, "attempts": attempts}])
            if status not in RETRYABLE_STATUSES:
                raise ProviderHttpError(
                    status, "provider error, not retried", body=raw)
            if attempts < MAX_ATTEMPTS:
                delay = _retry_after_delay(resp_headers) \
                    if status == 429 else None
                if delay is not None:
                    time.sleep(delay)
                else:
                    _backoff_sleep(attempts - 1)
                continue
            raise ProviderHttpError(status, "retryable status persisted after %d attempts" % MAX_ATTEMPTS, body=raw)
        if 400 <= status < 500:
            if status == 401:
                # W4-P2-4: name the token cause and the mint-a-fresh-token
                # remedy instead of a generic "fail fast on 4xx".
                raise ProviderHttpError(status, _pat_401_detail(), body=raw)
            raise ProviderHttpError(status, "fail fast on 4xx", body=raw)
        return status, resp_headers, raw, attempts
    if last_exc:
        raise ExecutorError("transport failed after %d attempts: %s" % (MAX_ATTEMPTS, last_exc))
    raise ExecutorError("unreachable retry state")


# --------------------------------------------------------------------------
# Request block construction
# --------------------------------------------------------------------------

def _content_type(headers: dict) -> str:
    for k, v in (headers or {}).items():
        if k.lower() == "content-type":
            return v.split(";")[0].strip().lower()
    return ""


def _form_scalar(value):
    """One form/query value. Booleans render 'true'/'false': Canvas/Rails
    boolean casting treats the string 'False' as true, so str(True/False)
    would silently flip a boolean field."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def resolved_request_body(block: dict, params: dict, transients: dict,
                          result_payload=None):
    """The request block's body with every reference resolved.

    Shared by build_request and the write-hardening defenses so the
    prevalidation and readback intent see exactly the body that is sent."""
    return resolve_ref(block.get("body"), params, result_payload, transients)


def build_request(entry: dict, block: dict, params: dict, session: SessionStore,
                  pack: dict, config: dict, transients: dict,
                  result_payload=None, dry_run: bool = False) -> tuple:
    """Return (method, url, headers, body_bytes).

    W4-P2-26: dry_run=True never resolves actual secret material into the
    headers (see build_headers); the rendered request carries redaction
    placeholders instead.
    """
    method = block["method"]
    if method == "LOCAL" or str(block.get("url", "")).startswith("local://"):
        raise LocalProcedureRefused(
            "entry %r is a VM-local governance procedure (local://), not a provider call; "
            "the network executor does not run it" % entry.get("name"))
    is_write = (entry.get("effects") == "write")
    url = render_template(block["url"], config, params, result_payload, transients)
    canvas_base = (config or {}).get("canvas_base")
    if canvas_base and not transients_supply_base(block, transients) \
            and not _same_origin(url, canvas_base):
        raise ExecutorError(
            "request for entry %r leaves the configured LMS origin %s; "
            "refusing (every request stays on the tenant host)"
            % (entry.get("name"), canvas_base))

    # New Quiz write contract (P0-2, P0-7): PUT never on New Quiz paths,
    # 506477 refused on every write, quiz-API-route delete only, stimulus
    # refused. Applies to single requests and multi-step steps alike.
    guard_new_quiz_request(entry, method, url, params)

    # path_params are already template-rendered; query and body resolve refs
    query_spec = resolve_ref(block.get("query") or {}, params, result_payload, transients)
    pairs = []
    for key, value in query_spec.items():
        if value is None:
            continue
        if isinstance(value, list):
            for item in value:
                pairs.append((key, _form_scalar(item)))
        else:
            pairs.append((key, _form_scalar(value)))
    if pairs:
        sep = "&" if "?" in url else "?"
        url = url + sep + urllib.parse.urlencode(pairs)

    headers = build_headers(entry, block.get("headers"), session, params,
                            transients, pack, is_write, dry_run=dry_run)

    body = resolved_request_body(block, params, transients, result_payload)
    body_bytes = None
    if body is not None:
        ctype = _content_type(headers)
        if ctype == "application/json":
            body_bytes = json.dumps(body).encode("utf-8")
        elif ctype == "application/x-www-form-urlencoded":
            flat = []
            if isinstance(body, dict):
                for k, v in body.items():
                    if v is None:
                        continue
                    flat.append((k, _form_scalar(v)))
            body_bytes = urllib.parse.urlencode(flat).encode("utf-8")
        else:
            body_bytes = json.dumps(body).encode("utf-8") if not isinstance(body, bytes) else body
    return method, url, headers, body_bytes


# --------------------------------------------------------------------------
# Result block application
# --------------------------------------------------------------------------

def apply_result_block(entry: dict, raw: bytes, resp_headers: dict) -> dict:
    """Apply max_bytes, truncation, JSON parse, response_path, receipt, redact.
    Returns a dict with the bounded payload and metadata. Secrets are not
    expected in provider bodies, but redaction applies regardless."""
    spec = entry.get("result") or {}
    max_bytes = int(spec.get("max_bytes", 262144))
    policy = spec.get("truncate", "tail")
    truncated = False
    bounded = raw
    if len(raw) > max_bytes:
        truncated = True
        bounded = _truncate_json_list_by_items(raw, max_bytes, policy)
        if bounded is None:
            if policy == "head":
                bounded = raw[:max_bytes]
            else:
                bounded = raw[-max_bytes:]
    text = bounded.decode("utf-8", errors="replace")
    ctype = ""
    for k, v in resp_headers.items():
        if k.lower() == "content-type":
            ctype = v
            break
    payload = None
    stripped = text.lstrip()
    if "json" in ctype or stripped.startswith(("{", "[")):
        try:
            payload = json.loads(stripped)
        except ValueError:
            payload = text
    else:
        payload = text
    if isinstance(payload, (dict, list)) and spec.get("response_path"):
        payload = resolve_path(payload, spec["response_path"])
    receipt = extract_receipt(payload, spec.get("receipt") or [])
    # The global defaults always apply; the entry's own list only adds.
    receipt = redact_payload(receipt,
                             (spec.get("redact") or []) + DEFAULT_REDACT_PATTERNS)
    return {
        "payload": payload,
        "receipt": receipt,
        "truncated": truncated,
        "bytes_received": len(raw),
        "bytes_kept": len(bounded),
    }


def _truncate_json_list_by_items(raw: bytes, max_bytes: int, policy: str):
    """Bound a complete JSON array by whole leading items, keeping valid
    JSON; returns the re-encoded bytes, or None when raw is not a
    complete JSON array (byte truncation applies instead).

    A merged paginated collection is complete JSON, so cutting it by
    bytes would break the structure mid-object. The leading items are
    kept whatever the entry's truncate policy says: the result is then
    a prefix of the collection, which is what the partial-collection
    notice describes."""
    try:
        items = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(items, list):
        return None
    kept = []
    size = 2
    for item in items:
        encoded = len(json.dumps(item).encode("utf-8")) + (2 if kept else 0)
        if size + encoded > max_bytes:
            break
        kept.append(item)
        size += encoded
    return json.dumps(kept).encode("utf-8")


def extract_receipt(payload, fields, text_preview_chars=500):
    if not fields:
        if isinstance(payload, dict):
            return dict(payload)
        if isinstance(payload, str):
            return {"_text_preview": payload[:text_preview_chars],
                    "_text_truncated": len(payload) > text_preview_chars}
        return payload
    if isinstance(payload, dict):
        return {f: payload[f] for f in fields if f in payload}
    if isinstance(payload, list):
        return [extract_receipt(item, fields) for item in payload if isinstance(item, dict)]
    return payload


# --------------------------------------------------------------------------
# Discovery and multi_step
# --------------------------------------------------------------------------

def run_discovery(entry: dict, session: SessionStore, pack: dict,
                  config: dict, params: dict, transients: dict,
                  max_bytes: int = None) -> dict:
    discovery = entry.get("discovery")
    if not discovery:
        return transients
    _assert_read_only_block(entry, discovery, "discovery")
    transients = dict(transients)
    method, url, headers, body_bytes = build_request(
        entry, discovery, params, session, pack, config, transients)
    status, resp_headers, raw, attempts = session.raw_request(
        method, url, headers, body_bytes, is_write=False, max_bytes=max_bytes)
    result = apply_result_block(entry, raw, resp_headers)
    pick = discovery.get("pick")
    store_as = discovery.get("store_as")
    value = _apply_pick(entry, pick, result["payload"])
    if store_as:
        transients[store_as] = value
    else:
        transients["discovery"] = value
    return transients


def _apply_first_where_pick(entry: dict, pick: dict, payload):
    """Structured first-match discovery pick.

    pick shape:
      {"response_path": "<path to the list, '' for the whole payload>",
       "first_where_contains": {"field": "<item field>", "substring": "<text>"},
       "project": "<field to take from the matched item, optional>",
       "replace": {"from": "<text>", "to": "<text>"} (optional, applied to the
                   projected string)}
    This is the structured encoding of the old prose rule "first tool whose
    url hostname contains 'quiz-lti', with the quiz-lti label replaced by
    quiz-api". Raises ExecutorError (never UnsupportedEntry) when the list
    has no match, so a failed discovery is a loud, journaled failure.
    """
    base = resolve_path(payload, pick.get("response_path") or "")
    if not isinstance(base, (list, tuple)):
        raise ExecutorError(
            "discovery pick for %r expected a list at response_path %r, got %s"
            % (entry.get("name"), pick.get("response_path"), type(base).__name__))
    fw = pick.get("first_where_contains") or {}
    field, sub = fw.get("field"), fw.get("substring")
    match = None
    for item in base:
        if isinstance(item, dict) and sub in str(item.get(field) or ""):
            match = item
            break
    if match is None:
        raise ExecutorError(
            "discovery pick for %r found no item whose %r contains %r"
            % (entry.get("name"), field, sub))
    value = match
    if pick.get("project"):
        if not isinstance(value, dict) or pick["project"] not in value:
            raise ExecutorError(
                "discovery pick for %r: matched item lacks field %r"
                % (entry.get("name"), pick.get("project")))
        value = value[pick["project"]]
    rep = pick.get("replace")
    if rep:
        value = str(value).replace(rep.get("from", ""), rep.get("to", ""))
    return value


def _apply_pick(entry: dict, pick, payload):
    if isinstance(pick, dict) and pick.get("first_where_contains"):
        return _apply_first_where_pick(entry, pick, payload)
    if isinstance(pick, dict) and pick.get("response_path"):
        return resolve_path(payload, pick["response_path"])
    if isinstance(pick, str) and not pick.strip().lower().startswith("first tool"):
        # A bare response_path string.
        return resolve_path(payload, pick)
    raise UnsupportedEntry(
        "entry %r uses a prose discovery pick that needs a structured rule; "
        "add a response_path pick before dispatch" % entry.get("name"))


def _resolve_step_arg(expr, params):
    """Resolve a tiny step-arg expression: "params.a || params.b" or a literal."""
    if not isinstance(expr, str):
        return expr
    for alt in expr.split("||"):
        alt = alt.strip()
        if alt.startswith("params."):
            val = params.get(alt[len("params."):])
            if val:
                return val
        elif alt:
            return alt
    return None




#
# Desktop-ported contract (INCORPORATION-PLAN.md, 03-newquiz-itembank.md):
#
#   P0-2  New Quiz updates use PATCH, never PUT. Three live PUT attempts
#         against a New Quiz all 404'd; desktop updates with PATCH.
#   P0-4  Settings PATCH sends the complete merged quiz_settings block:
#         fresh read, merge, re-read before the change, refuse stale or
#         unreadable settings, report carried-over keys. A partial settings
#         PATCH can delete the learner result view.
#   P0-7  Interaction IDs are preserved on in-place item edits: only
#         add-only or remove-only id changes are allowed; a rename
#         (add plus remove in one edit) is refused and must be planned as
#         delete plus create. Uncertain writes are never replayed.
#
#   Draws go through the builder page using its quiz.build_token and the
# --------------------------------------------------------------------------
# New Quiz lane (P0-2, P0-4, P0-7)
# --------------------------------------------------------------------------
#
# Desktop-ported contract (INCORPORATION-PLAN.md, 03-newquiz-itembank.md):
#
#   P0-2  New Quiz updates use PATCH, never PUT. Three live PUT attempts
#         against a New Quiz all 404'd; desktop updates with PATCH.
#   P0-4  Settings PATCH sends the complete merged quiz_settings block:
#         fresh read, merge, re-read before the change, refuse stale or
#         unreadable settings, report carried-over keys. A partial settings
#         PATCH can delete the learner result view.
#   P0-7  Interaction IDs are preserved on in-place item edits: only
#         add-only or remove-only id changes are allowed; a rename
#         (add plus remove in one edit) is refused and must be planned as
#         delete plus create. Uncertain writes are never replayed.
#
#   Draws go through the builder page using its quiz.build_token and the
#   builder resource ID (not the builder URL number). Draw updates use
#   PATCH /api/quizzes/{quiz}/quiz_entries/{entry}. Moving a quiz question
#   into a bank uses POST /api/banks/{bank}/bank_entries/move_from_quiz_entry
#   with a same-course guard. The canonical New Quiz delete is the quiz API
#   route; the assignment endpoint orphans the quiz backend object.
#   Stimulus create/update stays refused as targets (Canvas 422s create;
#   unproven contract). New Quiz 506477 is refused on every write path.

NEW_QUIZ_REFUSED_ID = 506477

_NEW_QUIZ_WRITE_METHODS = ("POST", "PATCH", "PUT", "DELETE")

# quiz_settings groups that merge one leaf deeper than the top level.
_NEW_QUIZ_SETTINGS_NESTED = ("filters", "multiple_attempts", "result_view_settings")

# Cleared top-level settings arrive from Canvas saved as 0 (never null).
_CLEARED_ZERO_KEYS = frozenset({"session_time_limit_in_seconds", "max_attempts"})


class NewQuizRefused(ExecutorError):
    """A New Quiz request violated the desktop-ported write contract:
    PUT on a New Quiz path, the refused quiz id, a non-canonical delete
    route, an interaction-id rename, stimulus authoring, a missing
    build token, or an unreadable settings block."""


def _new_quiz_path_kind(url: str):
    """Classify a resolved URL for the New Quiz lane.

    Returns "quiz_v1" for the /quiz/v1 surface (Canvas origin), "draw"
    for the builder quiz_entries surface (quiz-api host), else None.
    """
    try:
        path = (urllib.parse.urlparse(str(url)).path or "").lower()
    except Exception:  # noqa: BLE001 - a garbage url is not a quiz path
        return None
    if "/quiz/v1" in path:
        return "quiz_v1"
    if "/api/quizzes/" in path:
        return "draw"
    return None


def _path_ids(path: str, segment: str):
    """Numeric ids carried in /{segment}/{id} path positions."""
    return re.findall(r"/%s/(\d+)" % segment, path or "", flags=re.IGNORECASE)


def guard_new_quiz_request(entry: dict, method: str, url: str, params: dict) -> None:
    """Enforce the New Quiz write contract at request build time.

    Called by build_request (https lane) and by the browser lane's request
    planners, so every dispatch path gets the same refusal set. Reads pass
    through untouched. Raises NewQuizRefused on any violation.
    """
    method = str(method or "").upper()
    if method not in _NEW_QUIZ_WRITE_METHODS:
        return
    path = urllib.parse.urlparse(str(url)).path or ""
    kind = _new_quiz_path_kind(url)

    # Quiz-ness comes from the entry declaration, not only the URL shape:
    # an assignment-endpoint delete of a quiz does not look like a quiz
    # path, which is exactly why the delete-route check must run on it.
    is_quiz = bool(entry.get("new_quiz"))
    entry_name = str(entry.get("name") or "").lower()
    if "new_quiz" in entry_name:
        is_quiz = True
    ids = set(_path_ids(path, "quizzes")) | set(_path_ids(path, "assignments"))
    if isinstance(params, dict):
        for key in ("quiz_id", "assignment_id", "new_quiz_id",
                    "builder_quiz_id", "id"):
            value = params.get(key)
            if value is not None:
                ids.add(str(value))
        if params.get("is_quiz_lti_assignment"):
            is_quiz = True

    # 7. Hard refusal for the refused quiz id on every New Quiz write path.
    # The quiz and its linked assignment share the id, so the assignment
    # path id counts too: any write naming 506477 is refused outright.
    if str(NEW_QUIZ_REFUSED_ID) in ids:
        raise NewQuizRefused(
            "refusing write to New Quiz %d: this quiz is never touched"
            % NEW_QUIZ_REFUSED_ID)

    # 6. The quiz API route is the only New Quiz delete path. Deleting
    # through the assignment endpoint orphans the quiz backend object.
    # (Checked before the path-kind gate: this URL is not a quiz path.)
    if (method == "DELETE" and "/api/v1/" in path.lower()
            and "/assignments/" in path.lower() and is_quiz):
        raise NewQuizRefused(
            "refusing to delete a New Quiz through the assignment endpoint "
            "(it orphans the quiz backend object); the quiz API route is "
            "the only delete path")

    if kind is None:
        return

    # 1. New Quiz updates use PATCH, never PUT. (PUT on the classic
    # assignment endpoint is legitimate for quiz assignment metadata and
    # is not covered here.)
    if method == "PUT":
        raise NewQuizRefused(
            "PUT is never used on New Quiz paths (%s); use PATCH"
            % (path or url))

    # Stimulus create/update stays refused as targets (Canvas 422s create;
    # the payload contract is unproven).
    if ("stimulus" in entry_name and kind == "quiz_v1"
            and method in ("POST", "PATCH") and "/items" in path.lower()):
        raise NewQuizRefused(
            "stimulus create/update stays refused as targets until a proven "
            "contract lands (Canvas answers 422 on create)")


# -- quiz_settings: complete merged block ---------------------------------

def _cleared_form_value(key: str, group: str):
    """The saved form Canvas uses for a cleared setting: 0, [], or None.

    Canvas saves a cleared null as 0 or []; the write must send the saved
    form so the readback can expect it.
    """
    if group == "filters" and key == "ips":
        return []
    if key in _CLEARED_ZERO_KEYS:
        return 0
    return None


def plan_new_quiz_settings(saved_settings: dict, requested: dict) -> dict:
    """Build the complete merged quiz_settings block for a settings PATCH.

    saved_settings is the fresh read of the complete saved block (the
    caller reads it, and re-reads immediately before the change; digest
    comparison against the frozen plan happens in the caller). requested
    is the reviewed change. A requested value of None clears the setting
    and is sent in the form Canvas saves (0 / [] / null).

    Returns {"block": merged, "preserved": [...], "changed": [...]} where
    preserved names carried-over keys in dotted leaf form and changed names
    keys whose saved value moved. Raises NewQuizRefused when the saved
    block is missing or unreadable: stale settings refuse.
    """
    if not isinstance(saved_settings, dict) or not saved_settings:
        raise NewQuizRefused(
            "refusing settings write: the saved quiz_settings block is "
            "missing or unreadable; re-read before sending")
    if not isinstance(requested, dict):
        raise NewQuizRefused("the requested settings change must be a dict")

    merged = copy.deepcopy(saved_settings)
    for key, value in requested.items():
        if key in _NEW_QUIZ_SETTINGS_NESTED and isinstance(value, dict):
            group = merged.get(key)
            if not isinstance(group, dict):
                group = {}
                merged[key] = group
            for leaf, leaf_value in value.items():
                group[leaf] = (_cleared_form_value(leaf, key)
                               if leaf_value is None else leaf_value)
        else:
            merged[key] = (_cleared_form_value(key, "")
                           if value is None else value)

    def leaves(node, prefix=""):
        flat = {}
        if isinstance(node, dict):
            for key, value in node.items():
                flat.update(leaves(value, prefix + key + "."))
        else:
            flat[prefix[:-1]] = node
        return flat

    saved_flat = leaves(saved_settings)
    merged_flat = leaves(merged)
    preserved = sorted(k for k, v in merged_flat.items()
                       if k in saved_flat and saved_flat[k] == v)
    changed = sorted(k for k, v in merged_flat.items()
                     if saved_flat.get(k, object()) != v)
    return {"block": merged, "preserved": preserved, "changed": changed}


def new_quiz_settings_request(course_id, quiz_id, merged_block: dict) -> dict:
    """The settings write request: PATCH with the complete merged block."""
    if str(quiz_id) == str(NEW_QUIZ_REFUSED_ID):
        raise NewQuizRefused(
            "refusing write to New Quiz %d: this quiz is never touched"
            % NEW_QUIZ_REFUSED_ID)
    return {
        "method": "PATCH",
        "path": "/quiz/v1/courses/%s/quizzes/%s" % (course_id, quiz_id),
        "body": {"quiz": {"quiz_settings": merged_block}},
    }


def new_quiz_settings_match(sent_block: dict, read_block: dict) -> tuple:
    """Compare a readback settings block against what was sent.

    Canvas saves cleared values as 0 or [], so a sent None matches a read
    0 or []. Returns (match, mismatches) with mismatches in dotted form.
    """
    def leaves(node, prefix=""):
        flat = {}
        if isinstance(node, dict):
            for key, value in node.items():
                flat.update(leaves(value, prefix + key + "."))
        else:
            flat[prefix[:-1]] = node
        return flat

    def cleared_equiv(a, b):
        return a in (None, 0, []) and b in (None, 0, [])

    def is_cleared(v):
        return v is None or v == 0 or v == []

    sent = leaves(sent_block or {})
    read = leaves(read_block or {})
    mismatches = []
    for key in sorted(set(sent) | set(read)):
        if key not in sent:
            # Canvas populates empty defaults (e.g. filters.ips: [])
            # that were absent from the sent block. A readback-only
            # key with a cleared-equivalent value is provider
            # normalization, not a write failure; a non-empty
            # readback-only key is still flagged.
            if not is_cleared(read[key]):
                mismatches.append("%s: unexpected in readback" % key)
        elif key not in read:
            mismatches.append("%s: missing from readback" % key)
        elif sent[key] != read[key] and not cleared_equiv(sent[key], read[key]):
            mismatches.append("%s: sent %r, read %r"
                              % (key, sent[key], read[key]))
    return (not mismatches, mismatches)


# -- interaction-id preservation -------------------------------------------

def collect_interaction_ids(interaction_data) -> set:
    """Collect every interaction sub-element id from an item's
    interaction_data (choices, matching questions/answers, blank children).
    The desktop guard merges these sub-elements by id; this set is the id
    set the guard compares."""
    ids = set()

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if (key == "id" and isinstance(value, (str, int))
                        and not isinstance(value, bool)):
                    ids.add(str(value))
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    if isinstance(interaction_data, (dict, list)):
        walk(interaction_data)
    return ids


def check_interaction_ids_preserved(saved_ids, proposed_ids) -> str:
    """Enforce the desktop newQuizIdsPreserved guard semantics.

    In-place item PATCH is safe only when every existing id is
    preserved and only non-structural values change (production
    finding: any regenerated choice, question, or blank id orphans
    the old elements as blank ghost stubs). ANY membership change --
    added ids, removed ids, or a rename (both) -- is refused: that
    change must be planned as a delete plus create. Returns the change
    kind ("unchanged") when the sets match exactly.
    """
    saved, proposed = set(str(i) for i in saved_ids), set(str(i) for i in proposed_ids)
    added = proposed - saved
    removed = saved - proposed
    if added or removed:
        raise NewQuizRefused(
            "interaction-id change refused (added %d, removed %d): in-place "
            "PATCH would orphan ghost stubs; plan as delete plus create"
            % (len(added), len(removed)))
    return "unchanged"


# -- quiz bank draws (builder token) ---------------------------------------

def build_quiz_draw_update(builder_quiz_id, quiz_entry_id, points_possible,
                           sample_num, build_token: str) -> dict:
    """Build the draw PATCH request for a quiz bank draw row.

    The draw update goes through the builder page using its quiz.build_token
    and the builder resource ID (the resource_id claim of the token, scope
    quiz.build; the builder URL number answers 401 "resource id invalid").

    The caller injects the real build token as the Authorization header with
    AuthType: Signature on the tenant quiz-api host. Placeholder credential
    material is never acceptable; a missing token refuses the dispatch.
    """
    if not build_token:
        raise NewQuizRefused(
            "draw dispatch refused: quiz.build_token is not present; "
            "refusing to send a draw change without the builder credential")
    if (isinstance(sample_num, bool) or not isinstance(sample_num, int)
            or sample_num <= 0):
        raise NewQuizRefused(
            "draw update requires a positive whole question count; got %r"
            % (sample_num,))
    if str(builder_quiz_id) == str(NEW_QUIZ_REFUSED_ID):
        raise NewQuizRefused(
            "refusing write to New Quiz %d: this quiz is never touched"
            % NEW_QUIZ_REFUSED_ID)
    return {
        "method": "PATCH",
        "path": "/api/quizzes/%s/quiz_entries/%s"
                % (builder_quiz_id, quiz_entry_id),
        "credential": "quiz.build_token",
        "body": {"quiz_entry": {"points_possible": points_possible,
                                "properties": {"sample_num": sample_num}}},
    }


def assert_draw_row_allowed(row: dict, named_bank_id) -> None:
    """Refuse a draw update unless the row is a bank draw row supplied by
    the named bank. Question rows and rows from another bank are refused."""
    entry_type = str((row or {}).get("entry_type") or "")
    if entry_type not in ("Bank", "BankEntry"):
        raise NewQuizRefused(
            "draw update refused: the row is a %r row, not a bank draw row"
            % entry_type)
    row_bank = (row or {}).get("bank_id")
    if row_bank is None:
        row_bank = ((row or {}).get("entry") or {}).get("bank_id")
    if row_bank is not None and str(row_bank) != str(named_bank_id):
        raise NewQuizRefused(
            "draw update refused: the row comes from bank %s, not the "
            "named bank %s" % (row_bank, named_bank_id))


# -- moving a quiz question into a bank ------------------------------------

def build_move_from_quiz_entry(bank_id, source_quiz_id, entry_row: dict,
                               named_question_id, question_course_id,
                               bank_course_id, body: dict) -> dict:
    """Build the move-from-quiz-entry request with the same-course guard.

    The caller must have read the quiz's complete entry list first; the
    row is sent only when it is a question row whose own question id is
    the one named, because Canvas accepts a question id from another
    course (observed live as a hand-mistake moving a foreign question into
    a sandbox bank). body is the frozen reviewed request body; the exact
    bank-entry body contract rides in the frozen plan, not invented here.
    The caller injects the real banks.build credential material.
    """
    if str(source_quiz_id) == str(NEW_QUIZ_REFUSED_ID):
        raise NewQuizRefused(
            "refusing write to New Quiz %d: this quiz is never touched"
            % NEW_QUIZ_REFUSED_ID)
    entry_type = str((entry_row or {}).get("entry_type") or "")
    if entry_type != "Item":
        raise NewQuizRefused(
            "move refused: the row is a %r row; only question rows (Item) "
            "move into a bank" % entry_type)
    own_id = (entry_row or {}).get("entry_id")
    if own_id is None:
        own_id = ((entry_row or {}).get("entry") or {}).get("id")
    if str(own_id) != str(named_question_id):
        raise NewQuizRefused(
            "move refused: the row's own question id %r is not the named "
            "question %r" % (own_id, named_question_id))
    if str(question_course_id) != str(bank_course_id):
        raise NewQuizRefused(
            "move refused by the same-course guard: the question is from "
            "course %s but the bank is in course %s"
            % (question_course_id, bank_course_id))
    if not isinstance(body, dict):
        raise NewQuizRefused(
            "move requires the frozen reviewed request body; none was supplied")
    return {
        "method": "POST",
        "path": "/api/banks/%s/bank_entries/move_from_quiz_entry" % bank_id,
        "query": {"source_quiz_id": source_quiz_id},
        "credential": "banks.build",
        "body": body,
    }


# -- canonical New Quiz delete ---------------------------------------------

def new_quiz_delete_request(course_id, quiz_id) -> dict:
    """The only New Quiz delete path: the quiz API route, which cleans the
    quiz plus the linked assignment (live-proven)."""
    if str(quiz_id) == str(NEW_QUIZ_REFUSED_ID):
        raise NewQuizRefused(
            "refusing write to New Quiz %d: this quiz is never touched"
            % NEW_QUIZ_REFUSED_ID)
    return {
        "method": "DELETE",
        "path": "/quiz/v1/courses/%s/quizzes/%s" % (course_id, quiz_id),
    }


# -- tag pre-send checks (defect #529) -------------------------------------

def resolve_tag_by_value(account_tag_list, value):
    """Resolve a tag by its value from the account tag list.

    Canvas reports no tag-association ids, so removal names the tag by
    value; the executor resolves the exact tag first. Raises when the
    value is absent or ambiguous.
    """
    matches = [tag for tag in (account_tag_list or [])
               if str((tag or {}).get("value") or (tag or {}).get("name") or "")
               == str(value)]
    if not matches:
        raise NewQuizRefused(
            "tag %r is not on the account tag list; refusing before send"
            % (value,))
    if len(matches) > 1:
        raise NewQuizRefused(
            "tag value %r is ambiguous (%d rows); refusing before send"
            % (value, len(matches)))
    return matches[0]


def assert_question_carries_tag(question_tags, value) -> None:
    """Refuse before send when the question does not carry the tag.

    Proving from the bank search that the question carries the tag happens
    in the caller (the service fills its tag index after the write
    returns, so verification re-reads until the index agrees or a bounded
    budget runs out; never report on a single immediate read).
    """
    carried = set(str((tag or {}).get("value") or (tag or {}).get("name") or "")
                  for tag in (question_tags or []))
    if str(value) not in carried:
        raise NewQuizRefused(
            "refusing tag removal: the question does not carry tag %r"
            % (value,))


def _prevalidate_multi_step_requests(entry: dict, params: dict,
                                     session: SessionStore, pack: dict,
                                     config: dict, transients: dict) -> None:
    """W4 approval ordering: prevalidate every multi-step write request
    BEFORE the approval burns.

    Builds each step's request and runs the D-010 local write
    prevalidation. Steps whose templates reference a prior step's
    not-yet-available result are skipped here; they are validated at
    execution time once that result lands. Any other malformed step
    refuses here, before the approval is consumed, so a bad step can
    never burn an approval for a write that was never sent.
    """
    for step in entry.get("multi_step") or []:
        try:
            method, url, _headers, _body = build_request(
                entry, step, params, session, pack, config, transients)
        except ExecutorError as e:
            if "template slot" in str(e) and "has no value" in str(e):
                continue
            raise
        if entry.get("effects") == "write":
            prevalidate_write_request(
                entry, method, url,
                resolved_request_body(step, params, transients))


def run_multi_step(entry: dict, session: SessionStore, pack: dict,
                   config: dict, params: dict, transients: dict,
                   max_bytes: int = None, attempt_state: dict = None):
    """Run entry['multi_step']; return (final_result_dict, transients).

    Per-step evidence (W2-P1-5): every completed step is recorded; when a
    step raises UncertainWrite the evidence (completed steps plus the
    failing step) rides on the exception so the journal names which step
    landed instead of a generic receipt. attempt_state (a dict, optional)
    gets ["write_attempted"]=True once a write step's provider call is
    actually invoked, so the dispatcher's failure classifier knows a
    write may have reached the provider."""
    transients = dict(transients)
    last_result = None
    completed_steps = []
    step_readbacks = []
    for step in entry.get("multi_step") or []:
        step_name = step.get("name")
        method = url = None
        attempts = 0
        try:
            method, url, headers, body_bytes = build_request(
                entry, step, params, session, pack, config, transients)
            if entry.get("effects") == "write":
                # D-010/D-011 defenses apply to every write step, same as the
                # single-request path: refuse malformed writes before any
                # network call, and refuse a page PUT when the page is missing.
                prevalidate_write_request(
                    entry, method, url,
                    resolved_request_body(step, params, transients))
                page_put_precheck(session, entry, pack, config, params,
                                  transients, method, url,
                                  max_bytes=max_bytes)
            is_write_step = (entry.get("effects") == "write")
            if attempt_state is not None and is_write_step:
                # The write step's provider call is about to be invoked;
                # a failure from here on may mean the provider saw it.
                attempt_state["write_attempted"] = True
            status, resp_headers, raw, attempts = session.raw_request(
                method, url, headers, body_bytes,
                is_write=is_write_step,
                max_bytes=max_bytes)
            result = apply_result_block(entry, raw, resp_headers)
            if entry.get("effects") == "write" and (
                    status in (200, 201) or str(method).upper() == "DELETE"):
                # D-009 defense for multi-step writes: read back the step's
                # written object and compare it against the step's requested
                # intent. A proven mismatch fails the whole entry immediately;
                # an unconfirmed readback keeps it uncertain.
                step_readbacks.append(dict(run_write_readback(
                    entry, session, pack, config, params, transients,
                    method, url,
                    resolved_request_body(step, params, transients),
                    result["payload"], max_bytes=max_bytes),
                    step=step_name))
            elif entry.get("effects") == "write":
                step_readbacks.append({
                    "step": step_name, "status": "unverified",
                    "detail": "HTTP %s answer carries no object to read "
                              "back" % status})
        except UncertainWrite as exc:
            exc.evidence = list(completed_steps) + [{
                "step": step_name, "method": method,
                "url": _redacted_url(url), "status": "uncertain",
                "attempts": attempts or exc.attempts,
                "detail": _provider_detail(exc, 200),
            }] + list(exc.evidence or [])
            if exc.attempts is None:
                exc.attempts = attempts or None
            raise
        completed_steps.append({"step": step_name, "method": method,
                                "url": _redacted_url(url), "status": status,
                                "attempts": attempts})
        result = apply_result_block(entry, raw, resp_headers)
        for name, path in (step.get("capture") or {}).items():
            transients[name] = resolve_path(result["payload"], path)
        last_result = result
        last_result["step_name"] = step.get("name")
        last_result["attempts"] = attempts
    if last_result is not None:
        last_result["step_readbacks"] = step_readbacks
    return last_result, transients


# --------------------------------------------------------------------------
# Verify block (frozen readback)
# --------------------------------------------------------------------------

def run_verify(entry: dict, session: SessionStore, pack: dict, config: dict,
               params: dict, result_payload, transients: dict,
               max_bytes: int = None) -> dict:
    """Run the entry's verify block and assert its expect fields.

    expect maps assertion names to references like 'params.name' (or a
    literal). Each resolves against the verify response payload and the
    original params; all must match."""
    verify = entry.get("verify")
    if not verify:
        return {"status": "none_declared", "detail": "entry declares no verify block"}
    _assert_read_only_block(entry, verify, "verify")
    method, url, headers, body_bytes = build_request(
        entry, verify, params, session, pack, config, transients, result_payload)
    # A verify GET that cannot complete after the write succeeded proves
    # nothing either way: the effect is unconfirmed, like a failed
    # write readback GET, never a failed write.
    try:
        status, resp_headers, raw, attempts = session.raw_request(
            method, url, headers, body_bytes, is_write=False,
            max_bytes=max_bytes)
        result = apply_result_block(entry, raw, resp_headers)
    except ProviderHttpError as exc:
        raise UncertainWrite(
            "declared verify GET %s failed HTTP %s; the write effect is "
            "unconfirmed, not a proven mismatch" % (url, exc.status))
    except UncertainWrite:
        raise
    except ExecutorError as exc:
        if _is_session_dead(exc) or _is_stale_command(exc):
            raise
        raise UncertainWrite(
            "declared verify GET %s failed (%s); the write effect is "
            "unconfirmed, not a proven mismatch" % (url, type(exc).__name__))
    return _assert_verify_expect(entry, verify, result["payload"], params,
                                 result_payload, transients)


def _assert_verify_expect(entry: dict, verify: dict, payload, params: dict,
                          result_payload, transients: dict) -> dict:
    """Assert a verify block's expect fields against a verify response payload.

    Shared by the https backend (run_verify, after fetching) and the browser
    lane (which fetches via the browser task and asserts here).
    """
    response_path = verify.get("response_path")
    failures = []
    unconfirmed = []
    for field, ref in (verify.get("expect") or {}).items():
        # actual always comes from the verify readback payload; expected
        # comes from the reference (params, the write's result, a
        # transient, or a literal). A "result.<path>" ref reads the same
        # path from the readback.
        try:
            if isinstance(ref, str) and ref.startswith("result."):
                actual = resolve_path(payload, ref[len("result."):])
            elif response_path:
                actual = resolve_path(payload, response_path)
            elif isinstance(payload, str):
                actual = payload
            else:
                actual = resolve_path(payload, field)
        except ExecutorError as exc:
            failures.append("%s: %s" % (field, exc))
            continue
        expected = resolve_ref(ref, params, result_payload, transients)
        # The same field verdict as the write readback, on every lane.
        verdict = _write_field_verdict(expected, actual)
        if verdict == "mismatch":
            failures.append("%s: expected %r, read back %r" % (field, expected, actual))
        elif verdict == "uncertain":
            unconfirmed.append("%s: expected %r, read back %r (may be the "
                               "LMS's own normalization)"
                               % (field, expected, actual))
    if failures:
        raise VerificationFailed(
            "verify block assertions failed for %r: %s" % (entry.get("name"), "; ".join(failures)))
    if unconfirmed:
        return {"status": "unverified",
                "detail": "verify block could not confirm: %s"
                          % "; ".join(unconfirmed)}
    return {"status": "pass", "detail": "all %d expect assertions held" % len(verify.get("expect") or {})}


def _project_verification_detail(entry: dict, verification: dict,
                                 raw_payload, tenant_base, entry_name: str,
                                 lane_context=None) -> dict:
    """W3-P2-5: project a verify detail through the learner privacy boundary.

    run_write_readback and _assert_verify_expect format raw provider
    values with %r into verification["detail"]; on a readback mismatch
    those values can be learner names or identifiers. The journal is a
    learner-PII-free surface, so the detail is projected through the same
    privacy boundary as the receipt (privacy/executor_wire), with the
    same gate (touches_learner_data) and a roster harvested from the
    same raw provider payload the receipt projection uses. Entries that do not touch learner data pass through
    untouched. The input verification dict is never mutated; the (possibly
    new) dict is returned. Raises ExecutorError (fail closed) when the
    boundary itself fails.
    """
    detail = verification.get("detail")
    if not isinstance(detail, str) or not detail:
        return verification
    from privacy import executor_wire as _wire
    try:
        projected = _wire.project_learner_result(
            entry,
            {"receipt": {"verification_detail": detail,
                        "provider_payload": raw_payload}},
            tenant_base, lane_context=lane_context, error_cls=ExecutorError)
    except ExecutorError:
        raise
    except Exception as exc:
        raise ExecutorError(
            "learner privacy boundary failed for verification detail of "
            "entry %r: %s" % (entry_name, exc))
    projected_detail = (projected.get("receipt") or {}).get(
        "verification_detail")
    if not isinstance(projected_detail, str):
        return verification
    # W3-P2-5 hardening: the boundary scrubs names, emails, and
    # pattern-shaped ids in prose, but a bare numeric platform id that is
    # not shaped like "user_id=123" survives its deliberately narrow
    # prose id patterns (counts and years must not be mangled). The
    # detail is formatted from the raw payload's own values, so any
    # identifier harvested from that payload must not appear in the
    # journaled detail: replace leftovers with the learner's projected
    # label.
    projected_detail = _scrub_residual_identifiers(
        entry_name, raw_payload, projected.get("receipt") or {},
        projected_detail)
    out = dict(verification)
    out["detail"] = projected_detail
    return out


def _scrub_residual_identifiers(entry_name: str, raw_payload,
                                projected_receipt: dict,
                                detail: str) -> str:
    """Replace raw learner identifiers surviving in a verification detail.

    The boundary projects each learner-shaped record to
    {"learnerToken": "Student A<n>"} while preserving document order, so
    the tokens collected from the projected payload in walk order pair
    one-to-one with the roster harvested from the raw payload. Each raw
    identifier (id, name, email, login/sis ids) still present in the
    detail is replaced with that learner's label. A count mismatch means
    the pairing cannot be trusted: fail closed, because a mislabeled
    scrub is worse than a refusal.
    """
    from privacy import executor_wire as _wire
    raw_roster = _wire._harvest_roster(raw_payload)
    if not raw_roster:
        return detail
    # The boundary emits projected learner records in two shapes: a
    # collapsed {"learnerToken": "Student A<n>"} for a single top-level
    # record, or in-place labels ("id"/"name" replaced with "Student
    # A<n>") when the record sits in a list or envelope. Collect the
    # label from either shape, in document order, and pair it with the
    # raw roster harvested in the same order.
    tokens = []
    _label_re = re.compile(
        r"^(?:Student A[1-9][0-9]*|"
        r"learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
        r"[0-9a-f]{4}-[0-9a-f]{12})$")

    def _collect(node):
        if isinstance(node, dict):
            label = None
            token = node.get("learnerToken")
            if isinstance(token, str) and token:
                label = token
            else:
                for key in ("id", "name"):
                    value = node.get(key)
                    if isinstance(value, str) and _label_re.match(value):
                        label = value
                        break
            if label:
                tokens.append(label)
            for key, value in node.items():
                # A person-id array (student_ids, user_ids) projects to
                # labels in place; the harvester reads it the same way.
                if _wire.person_key_kind(key) == "ids":
                    for item in (value if isinstance(value, list)
                                 else [value]):
                        if isinstance(item, str) and _label_re.match(item):
                            tokens.append(item)
                    continue
                _collect(value)
        elif isinstance(node, list):
            for value in node:
                _collect(value)

    _collect((projected_receipt or {}).get("provider_payload"))
    # The harvester keeps the first sighting of each learner; so does
    # this pairing (one learner, one label).
    seen = set()
    tokens = [t for t in tokens if not (t in seen or seen.add(t))]
    if len(tokens) != len(raw_roster):
        raise ExecutorError(
            "learner privacy boundary returned an unpairable roster for "
            "the verification detail of entry %r; refusing rather than "
            "risking a mislabeled identifier scrub" % (entry_name,))
    scrubbed = detail
    for raw_rec, label in zip(raw_roster, tokens):
        for key in ("id", "name", "email", "login_id", "sis_user_id",
                    "sis_login_id", "sortable_name", "short_name",
                    "display_name"):
            value = raw_rec.get(key)
            if isinstance(value, bool):
                continue
            if not isinstance(value, (str, int)):
                continue
            text = str(value).strip()
            if not text:
                continue
            scrubbed = re.sub(r"\b%s\b" % re.escape(text), label, scrubbed)
    return scrubbed


# --------------------------------------------------------------------------
# Silent-write hardening (D-009, D-010, D-011)
#
# Canvas answers 200 on several writes it silently corrupts: malformed
# nested params are swallowed (D-009: an assignment-group create returned
# a default-ish object), empty discussion bodies create "No Title" objects
# (D-010), and page PUT upserts a new page when the URL does not exist
# (D-011). Status classification cannot catch any of these, so the write
# path carries three defenses:
#
#   prevalidation   required fields must be present and non-empty before
#                   any network call (D-010, plus the obvious equivalents)
#   page pre-check  a page PUT first GETs the page URL and refuses the
#                   update when the page does not exist (D-011)
#   write readback  after a 200/201 create/update, a fresh member GET is
#                   compared field by field against the requested intent;
#                   a proven mismatch is a hard failed write (D-009)
#
# Readback GET failures (429/5xx/transport/4xx) keep the op uncertain,
# never failed: only a successful readback showing mismatched fields is
# a hard failure. These defenses run in the shared dispatch path, so the
# https and chromium backends both get them. The browser lane keeps its
# own two-phase verify (open: adopt the same readback there); multi_step
# entries get prevalidation per write step plus the same per-step write
# readback: each 200/201 write step is read back against its intent, and
# a proven mismatch fails the whole entry.


class WritePrevalidationFailed(ExecutorError):
    """A write was refused before any provider write call: prevalidation
    found a missing or empty required field (D-010), or the page PUT
    pre-check showed the target page does not exist (D-011). Nothing was
    sent, so nothing is journaled and the op_id stays reusable."""


class WriteFieldMismatch(VerificationFailed):
    """Post-write readback proved the provider persisted different fields
    than requested (D-009: HTTP 200 with a wrong object). The op is
    journaled as a failed write with the mismatched fields named; the
    message carries the readback URL (with the created object id) for
    cleanup."""


# (collection path pattern, required field) for write prevalidation.
# D-010 proved the discussion case; the rest are the obvious equivalents
# named by the defect evidence. Open: quiz title, calendar events, and
# other surfaces the defect evidence does not cover.
_WRITE_REQUIRED_FIELDS = (
    (r"/api/v1/courses/\d+/discussion_topics(/[^/]*)?$", "title"),
    (r"/api/v1/courses/\d+/assignments(/[^/]*)?$", "name"),
    (r"/api/v1/courses/\d+/assignment_groups(/[^/]*)?$", "name"),
    (r"/api/v1/courses/\d+/modules(/[^/]*)?$", "name"),
    (r"/api/v1/courses/\d+/pages(/[^/]*)?$", "title"),
)


def _unwrap_canvas_body(body):
    """Unwrap one level of Canvas nested params.

    {"assignment_group": {"name": "x"}} -> {"name": "x"}. A flat body
    ({"title": "x", ...}) passes through unchanged; a non-dict body
    yields {} (nothing to compare or prevalidate)."""
    if isinstance(body, dict) and len(body) == 1:
        inner = next(iter(body.values()))
        if isinstance(inner, dict):
            return inner
    return body if isinstance(body, dict) else {}


def prevalidate_write_request(entry, method, url, resolved_body):
    """Refuse malformed writes before any network call (D-010 defense).

    On a known create/update route, the required field must be present on
    POST and non-empty whenever it is present. Raises
    WritePrevalidationFailed. Reads, unknown routes, and partial updates
    that omit the field pass through untouched."""
    method = str(method or "").upper()
    if method not in ("POST", "PUT", "PATCH"):
        return
    try:
        path = urllib.parse.urlparse(str(url)).path or ""
    except Exception:  # noqa: BLE001 - an unparsable URL matches no pattern
        return
    for pattern, field in _WRITE_REQUIRED_FIELDS:
        if not re.search(pattern, path):
            continue
        fields = _unwrap_canvas_body(resolved_body)
        if method == "POST" and field not in fields:
            raise WritePrevalidationFailed(
                "refusing %s %s: required field %r is missing from the "
                "request body (D-010: Canvas would create a broken object "
                "instead of failing)" % (method, path, field))
        if field in fields:
            value = fields[field]
            if value is None or not str(value).strip():
                raise WritePrevalidationFailed(
                    "refusing %s %s: required field %r is empty "
                    "(D-010: Canvas would create a broken object instead "
                    "of failing)" % (method, path, field))
        return


_PAGE_PUT_RE = re.compile(r"/api/v1/courses/\d+/pages/[^/]+$")


def page_put_precheck(session, entry, pack, config, params, transients,
                      method, url, max_bytes: int = None):
    """D-011 defense: refuse a page PUT when the target page does not exist.

    Canvas silently upserts on page PUT, turning an update aimed at a
    missing page into a surprise create. The pre-check GETs the PUT URL
    first: 404 refuses the update before anything is sent, and any other
    pre-check failure also refuses (fail closed: an upsert must never
    happen against an unconfirmed page)."""
    if str(method or "").upper() != "PUT":
        return
    try:
        path = urllib.parse.urlparse(str(url)).path or ""
    except Exception:  # noqa: BLE001 - an unparsable URL matches no pattern
        return
    if not _PAGE_PUT_RE.search(path):
        return
    target = str(url).split("?")[0].split("#")[0]
    block = {"method": "GET", "url": target, "headers": {}}
    try:
        rmethod, rurl, rheaders, rbody = build_request(
            entry, block, params, session, pack, config, transients or {})
        session.raw_request(rmethod, rurl, rheaders, rbody, is_write=False,
                              max_bytes=max_bytes)
    except ProviderHttpError as exc:
        if exc.status == 404:
            raise WritePrevalidationFailed(
                "refusing PUT %s: the page does not exist (Canvas would "
                "silently create it; D-011)" % path)
        raise WritePrevalidationFailed(
            "refusing PUT %s: the pre-check GET failed HTTP %s, so page "
            "existence is unconfirmed; failing closed (D-011)"
            % (path, exc.status))
    except ExecutorError as exc:
        raise WritePrevalidationFailed(
            "refusing PUT %s: the pre-check GET failed (%s), so page "
            "existence is unconfirmed; failing closed (D-011)"
            % (path, type(exc).__name__))
    # 200: the page exists; the PUT may proceed.


def _dig_path(obj, path: str):
    """Fetch a dotted field path from a parsed JSON object."""
    current = obj
    for part in str(path).split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None
    return current


def _parse_provider_json(raw: bytes, what: str) -> dict:
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise TargetIdentityMismatch(
            "%s did not return JSON (%s); failing closed" % (what, type(exc).__name__))
    if not isinstance(parsed, dict):
        raise TargetIdentityMismatch(
            "%s did not return a JSON object; failing closed" % what)
    return parsed


def verify_write_target_identity(entry, params, plan, session, pack, config,
                                 max_bytes: int = None,
                                 declared: dict | None = None,
                                 approval_target: dict | None = None,
                                 no_approval_target_ok: bool = False) -> dict | None:
    """W4-P0-11(2): course-existence/identity precheck before writes.

    GETs the course the WRITE will actually target (from params/path,
    never from the plan) and verifies it three ways: the course must
    exist on this tenant, the provider's returned id must equal the
    requested id, and the provider's name/term must match the frozen
    plan's declared target_identity. A typo'd course_id that resolves
    to a different real course is caught by the name comparison: the
    educator reviewed "Intended Course", the provider says this id is
    "Some Other Course".

    W4-P0-11(3): the signed approval's target block is cross-checked
    too. Admission already required the block and bound its tenant and
    course_id to the dispatch; here the block's course_name and term
    must agree with the frozen plan's declared target AND the
    provider-verified identity, so a record reviewed for one course
    cannot be paired with a plan (or a provider reality) naming
    another. A missing block fails closed: course-write approvals must
    carry one (admission enforces this; this is defense in depth).

    Runs post-claim, pre-write, as a read (is_write=False), so a
    refusal releases the claim and the op_id stays reusable. Returns
    the provider-verified target identity for the journal, or None for
    non-course writes (no course_id anywhere: nothing to verify).

    declared overrides the plan's target_identity (the undo path passes
    the original op's journaled target); when None, the plan's declared
    target is used. The gate already required a declared course_id and
    course_name for course writes; the equality is re-verified here
    post-claim so a plan swap between gate and precheck cannot slip
    through.

    no_approval_target_ok=True (edit-mode writes authorized by the
    Plan/Edit mode gate, which carry no approval record): the
    approval-target presence check and the approval cross-checks are
    skipped, because there is no approval ceremony to cross-check
    against. The provider-identity verification (the course must exist
    on this tenant and the provider's id must equal the requested id)
    still runs: it is genuine safety, not ceremony. The mode gate's
    ambiguous-course refusal is what protects the "which course"
    question in edit mode.
    """
    write_cid = _write_target_course_id(entry, params)
    if write_cid is None:
        return None
    if str(entry.get("provider") or "").lower() not in ("canvas", ""):
        return None
    if declared is None:
        declared = _declared_target(plan)
    if not isinstance(approval_target, dict) or not approval_target:
        if no_approval_target_ok:
            approval_target = {}
        else:
            raise TargetIdentityMismatch(
                "course %s write has no approval target block to cross-check; "
                "course-write approvals must name the reviewed target. "
                "Refusing." % write_cid)
    target = "{canvas_base}/api/v1/courses/%s" % urllib.parse.quote(write_cid, safe="")
    block = {"method": "GET", "url": target, "headers": {}}
    try:
        rmethod, rurl, rheaders, rbody = build_request(
            entry, block, params, session, pack, config, {})
        _status, _resp_headers, raw, _attempts = session.raw_request(
            rmethod, rurl, rheaders, rbody, is_write=False, max_bytes=max_bytes)
    except ProviderHttpError as exc:
        if exc.status == 404:
            raise TargetIdentityMismatch(
                "course %s does not exist on tenant %s; the write target "
                "is unconfirmed (possible typo'd course_id). Refusing."
                % (write_cid, config.get("canvas_base")))
        raise TargetIdentityMismatch(
            "target identity precheck GET for course %s failed HTTP %s; "
            "the write target is unconfirmed. Refusing closed."
            % (write_cid, exc.status))
    except ExecutorError as exc:
        raise TargetIdentityMismatch(
            "target identity precheck GET for course %s failed (%s); the "
            "write target is unconfirmed. Refusing closed."
            % (write_cid, type(exc).__name__))
    course = _parse_provider_json(raw, "course %s precheck" % write_cid)
    if str(course.get("id")) != write_cid:
        raise TargetIdentityMismatch(
            "provider returned course id %r for requested course %s; "
            "refusing." % (course.get("id"), write_cid))
    provider_name = course.get("name")
    # W5-P1-1: a homoglyph twin passes every name-equality check below
    # (provider, declared, and approval all name the same twin, so the
    # checks only prove the twin is self-consistent). Fail closed on
    # mixed-script confusables before comparing anything.
    if isinstance(provider_name, str):
        assert_no_spoof_identifier(provider_name, "provider course name")
    declared_cid = declared.get("course_id")
    declared_name = declared.get("course_name")
    if declared_cid is not None and str(declared_cid) != write_cid:
        raise TargetIdentityMismatch(
            "write targets course %s but the reviewed target is course %s "
            "(%r): refusing." % (write_cid, declared_cid, declared_name))
    if declared_name is not None:
        assert_no_spoof_identifier(declared_name, "declared course name")
        if not isinstance(provider_name, str) or \
                norm_identifier(provider_name) != \
                norm_identifier(declared_name):
            raise TargetIdentityMismatch(
                "course %s on this tenant is named %r, but the reviewed "
                "target declares %r: this is a different course than the "
                "educator reviewed (possible typo'd course_id). Refusing."
                % (write_cid, provider_name, declared_name))
    term = course.get("term")
    term_name = term.get("name") if isinstance(term, dict) else term
    declared_term = declared.get("term")
    if declared_term is not None and term_name is not None:
        if norm_identifier(term_name) != norm_identifier(declared_term):
            raise TargetIdentityMismatch(
                "course %s is in term %r, but the reviewed target declares "
                "term %r. Refusing." % (write_cid, term_name, declared_term))
    # W4-P0-11(3): the approval's target block must name the same course
    # the plan declared and the provider confirmed. A record reviewed
    # for "Intended Course" cannot authorize a write whose frozen plan
    # (or provider reality) names another course.
    approval_name = approval_target.get("course_name")
    if approval_name is not None:
        # W5-P1-1: the signed approval's name gets the same spoof screen;
        # a twin name reviewed from a search result must not authorize.
        assert_no_spoof_identifier(approval_name, "approval course name")
        if not isinstance(provider_name, str) or \
                norm_identifier(provider_name) != \
                norm_identifier(approval_name):
            raise TargetIdentityMismatch(
                "the signed approval was reviewed for course %r, but the "
                "provider-verified target of course %s is %r: the approval "
                "does not cover this course. Refusing."
                % (approval_name, write_cid, provider_name))
        if declared_name is not None and \
                norm_identifier(declared_name) != \
                norm_identifier(approval_name):
            raise TargetIdentityMismatch(
                "the signed approval was reviewed for course %r, but the "
                "frozen plan declares %r: the approval and the plan "
                "disagree about the target. Refusing."
                % (approval_name, declared_name))
    approval_term = approval_target.get("term")
    if approval_term is not None and term_name is not None:
        if norm_identifier(term_name) != norm_identifier(approval_term):
            raise TargetIdentityMismatch(
                "the signed approval was reviewed for term %r, but course "
                "%s is in term %r. Refusing."
                % (approval_term, write_cid, term_name))
    return {"course_id": write_cid,
            "course_name": provider_name,
            "term": term_name,
            "tenant": config.get("canvas_base")}


def recompute_before_state(entry, params, plan, session, pack, config,
                           transients, max_bytes: int = None) -> dict:
    """W4-P1-15: wire the before_state_digest to a fresh provider read.

    When the entry declares a before_state reader ({"method", "url",
    optional "project": [dotted fields]}), GET it, digest the snapshot
    with the same recipe the freeze step used (digest_of over the
    projected fields, or the whole object), and refuse with
    StaleBeforeState when it disagrees with the plan's
    before_state_digest: the world moved since the plan was frozen.

    Honesty rules (W4-P1-15): a plan digest with no declared reader is
    a misconfiguration and fails closed (a digest that implies a
    freshness guard that cannot run is the theater this finding
    removes: declare a reader or mark the family unsupported). A
    reader marked {"unsupported": True} is reported "unsupported" with
    its reason and the write proceeds (explicit declaration, not silent
    theater; the supported/unsupported families are documented). No
    digest at all is "absent". The journal carries the outcome. Always
    a read (is_write=False), pre-write, so a refusal releases the claim
    and the op_id stays reusable."""
    digest = plan.before_state_digest if plan is not None else None
    if not digest:
        return {"status": "absent", "detail": "no before_state_digest in plan"}
    reader = entry.get("before_state") or {}
    if isinstance(reader, dict) and reader.get("unsupported"):
        return {"status": "unsupported",
                "detail": str(reader.get("reason") or
                              "entry declares before_state as unsupported")}
    if not isinstance(reader, dict) or not reader.get("url"):
        raise ExecutorError(
            "entry %r: the frozen plan carries before_state_digest %s... "
            "but the entry declares no before_state reader, so the "
            "freshness guard cannot run. Refusing rather than pretending "
            "to verify: declare entry['before_state'] with {method, url} "
            "to re-read the frozen state, or mark the family explicitly "
            "{\"unsupported\": true, \"reason\": ...} when it has no "
            "stable re-readable surface." % (entry.get("name"),
                                             str(digest)[:12]))
    _assert_read_only_block(entry, reader, "before_state")
    block = {"method": "GET", "url": reader["url"], "headers": {}}
    try:
        rmethod, rurl, rheaders, rbody = build_request(
            entry, block, params, session, pack, config, transients or {})
        _status, _resp_headers, raw, _attempts = session.raw_request(
            rmethod, rurl, rheaders, rbody, is_write=False, max_bytes=max_bytes)
    except ProviderHttpError as exc:
        raise StaleBeforeState(
            "before-state re-read failed HTTP %s; freshness is "
            "unconfirmed, so the stale plan is refused closed." % exc.status)
    except ExecutorError as exc:
        raise StaleBeforeState(
            "before-state re-read failed (%s); freshness is unconfirmed, "
            "so the stale plan is refused closed." % type(exc).__name__)
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise StaleBeforeState(
            "before-state re-read did not return JSON; freshness is "
            "unconfirmed, so the stale plan is refused closed.")
    project = reader.get("project")
    snapshot = ({field: _dig_path(parsed, field) for field in project}
                if project else parsed)
    fresh = digest_of(snapshot)
    if fresh != digest:
        raise StaleBeforeState(
            "before-state moved since the plan was frozen: plan digest "
            "%s..., fresh read %s.... Refusing the stale plan; re-freeze "
            "against current state." % (str(digest)[:12], fresh[:12]))
    return {"status": "verified",
            "detail": "fresh provider read matches the frozen before-state digest"}


# Member-GET derivation for the write readback (D-009 defense).
#
# COVERAGE (exact allowlist, kept current with the shipped entry surface):
#   - Classic Canvas (/api/v1): assignment_groups, discussion_topics,
#     assignments, modules, quizzes, pages. POST to a collection derives
#     the member URL from the create response's id (or page url);
#     PUT/PATCH to a member route re-reads that route. A course update
#     (PUT /api/v1/courses/{id}) re-reads the course. Batch writes are
#     read back where each change lives: C-36 (PUT
#     /assignments/overrides) with the batch retrieve of the overrides
#     it changed, C-37 (PUT /assignments/bulk_update) with one GET per
#     assignment.
#   - New Quiz (/api/quiz/v1): quizzes collection + quiz member,
#     quizzes/{id}/items collection + item member. Create responses carry
#     the member in the "id" field; PUT/PATCH already name the member.
#
# EXPLICITLY SKIPPED (never silent: run_write_readback journals "skipped"
#   with the skip reason, and the block below is the reference):
#   - Item Bank routes (/api/banks/...): provision-token scoped routes with
#     their own member shapes; no readback derivation is declared for them.
#   - New Quiz accommodations, reports, and media upload routes: bulk or
#     binary surfaces with no stable member GET to compare against intent.
#   - DELETE: deletion is verified by the terminal 404 of the follow-up
#     read, not by a GET of the removed object. A classic quiz delete is
#     verified by the course quiz index (D-002).
#   - Every other route: unknown surface; skipped rather than failed so a
#     new endpoint can never be "proven" by accident.
_WRITE_READBACK_COLLECTIONS = (
    (r"/api/v1/courses/\d+/assignment_groups$", "id"),
    (r"/api/v1/courses/\d+/discussion_topics$", "id"),
    (r"/api/v1/courses/\d+/assignments$", "id"),
    (r"/api/v1/courses/\d+/modules$", "id"),
    (r"/api/v1/courses/\d+/quizzes$", "id"),
    (r"/api/v1/courses/\d+/pages$", "url"),
    (r"/api/quiz/v1/courses/\d+/quizzes$", "id"),
    (r"/api/quiz/v1/courses/\d+/quizzes/\d+/items$", "id"),
)
# Members have numeric ids (pages keep their url slug), so a batch
# route such as /assignments/overrides or /assignments/bulk_update is
# never mistaken for a member.
_WRITE_READBACK_MEMBER_RE = re.compile(
    r"(?:/api/v1/courses/\d+/(?:assignment_groups|discussion_topics|"
    r"assignments|modules|quizzes)/\d+"
    r"|/api/v1/courses/\d+/pages/[^/]+"
    r"|/api/quiz/v1/courses/\d+/quizzes/\d+(?:/items/\d+)?)$")
# A course update (C-128) is read back with the course GET. Updates
# only: a course DELETE may conclude the course, which the course GET
# still serves, so it has no delete readback here.
_COURSE_READBACK_MEMBER_RE = re.compile(r"/api/v1/courses/\d+$")


# W3-P2-22: Item Bank readback derivation. The SDK lane's bank create
# response nests the new id ({"bank": {"id": ...}} for POST /api/banks);
# member PATCH re-reads the bank member URL. Item member routes are
# DELIBERATELY excluded: the provider does not serve direct item GET
# (IB-11, provider-anomalous 404 on existing items), so deriving a
# readback GET for POST /api/banks/{bank}/items or PATCH
# /api/banks/{bank}/items/{item} would turn every successful write into
# a false UncertainWrite. The working item read path is the bank entry
# GET (IB-10); see _readback_skip_reason for the named skip.
_IB_READBACK_BANK_COLLECTION_RE = re.compile(r"/api/banks$")
_IB_READBACK_BANK_MEMBER_RE = re.compile(r"/api/banks/[^/]+$")
# Item shapes: present in the URL space but never read back (see above).
_IB_ITEM_COLLECTION_RE = re.compile(r"/api/banks/[^/]+/items$")
_IB_ITEM_MEMBER_RE = re.compile(r"/api/banks/[^/]+/items/[^/]+$")


def _ib_created_member_id(payload, wrapper):
    """The created id from an Item Bank create response, which nests the
    new object under "bank" or "item" (falling back to a top-level id)."""
    if not isinstance(payload, dict):
        return None
    node = payload.get(wrapper)
    if isinstance(node, dict) and node.get("id") is not None:
        return node.get("id")
    return payload.get("id")


def _readback_target(method, url, result_payload):
    """Derive the member GET URL for a create/update write.

    POST to a known collection appends the created object's id (or page
    url) taken from the create response; PUT/PATCH already name the
    member, so the same URL is re-read. Returns None when no readback
    route is derivable (unknown surface: the readback is skipped, never
    failed)."""
    method = str(method or "").upper()
    if method not in ("POST", "PUT", "PATCH"):
        return None
    target = str(url).split("?")[0].split("#")[0].rstrip("/")
    try:
        path = urllib.parse.urlparse(target).path or ""
    except Exception:  # noqa: BLE001 - an unparsable URL has no readback
        return None
    if method == "POST":
        # Item Bank bank collection first: its create response nests the
        # id under "bank". Item creates deliberately derive nothing:
        # the provider 404s direct item GET (IB-11), so a derived
        # readback would false-positive every item create as uncertain.
        if _IB_READBACK_BANK_COLLECTION_RE.search(path):
            wrapper = "bank"
        else:
            wrapper = None
        if wrapper is not None:
            member_id = _ib_created_member_id(
                result_payload if isinstance(result_payload, dict) else {},
                wrapper)
            if member_id is None or str(member_id).strip() == "":
                return None
            return target + "/" + urllib.parse.quote(str(member_id), safe="")
        for pattern, id_field in _WRITE_READBACK_COLLECTIONS:
            if re.search(pattern, path):
                payload = result_payload if isinstance(result_payload, dict) else {}
                member_id = payload.get(id_field)
                if member_id is None or str(member_id).strip() == "":
                    return None
                return target + "/" + urllib.parse.quote(str(member_id), safe="")
        return None
    if _IB_READBACK_BANK_MEMBER_RE.search(path):
        return target
    if _WRITE_READBACK_MEMBER_RE.search(path):
        return target
    if _COURSE_READBACK_MEMBER_RE.search(path):
        return target
    return None


def _readback_skip_reason(method, url):
    """Route-specific reason a write has no readback target.

    F-11: skipped surfaces are documented by name instead of a generic
    "not derivable" note. Matches the coverage documented in
    _WRITE_READBACK_COLLECTIONS / _WRITE_READBACK_MEMBER_RE.
    """
    method = str(method or "").upper()
    try:
        path = urllib.parse.urlparse(str(url)).path or ""
    except Exception:  # noqa: BLE001 - report the unparsable URL itself
        path = ""
    if method not in ("POST", "PUT", "PATCH"):
        return ("%s has no safe readback on this route: there is no "
                "known member GET that would confirm the object is gone"
                % method)
    if "/accommodations" in path:
        return "New Quiz accommodations routes are not covered by readback derivation"
    if "/reports/" in path:
        return "New Quiz report routes are not covered by readback derivation"
    if path.startswith("/api/banks"):
        if method == "POST" and \
                _IB_READBACK_BANK_COLLECTION_RE.search(path):
            return ("the Item Bank create response carried no bank id, "
                    "so there is no created member to re-read")
        if _IB_ITEM_COLLECTION_RE.search(path) \
                or _IB_ITEM_MEMBER_RE.search(path):
            return ("direct item GET is provider-anomalous (IB-11: the "
                    "provider 404s existing items), so item creates and "
                    "item PATCHes have no readback route; the working "
                    "item read path is the bank entry GET (IB-10)")
        return ("Item Bank route has no member readback derivation "
                "(covered: POST /api/banks and PUT/PATCH on "
                "/api/banks/{bank_id})")
    if "media_upload" in path or re.search(r"/files(/|$)", path):
        return "media upload endpoints have no member readback route"
    if method == "POST":
        for pattern, _id_field in _WRITE_READBACK_COLLECTIONS:
            if re.search(pattern, path):
                return ("the create response carried no member id/url, so "
                        "there is no created member to re-read")
    return "no readback route derivable for %s %s" % (method, url)


def _is_empty_value(value) -> bool:
    return value is None or value == "" or value == [] or value == {}


# Field-semantic comparison for write readback. Canvas echoes stored
# values in its own representation: datetimes in UTC "Z" form, numbers
# as floats, booleans as JSON booleans, HTML after its sanitizer. A
# representation-only difference is a match; a difference that might be
# Canvas's own normalization (HTML sanitizing, surrounding whitespace, a
# naive or date-only time Canvas reads in the educator's zone) is
# "uncertain", never a proven failure.
_BOOL_TRUE_FORMS = frozenset({"true", "t", "1", "on", "yes"})
_BOOL_FALSE_FORMS = frozenset({"false", "f", "0", "off", "no"})
_NUMERIC_TEXT_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
_ISO_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?"
    r"(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?)?$")
_HTML_TAG_RE = re.compile(r"<\s*/?\s*[A-Za-z!][^>]*>")
# Elements Canvas's sanitizer removes together with their content.
_HTML_STRIPPED_ELEMENTS = frozenset({"script", "style", "object", "embed",
                                     "applet", "noscript", "template"})


def _as_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _BOOL_TRUE_FORMS:
            return True
        if text in _BOOL_FALSE_FORMS:
            return False
    return None


def _as_number(value):
    from decimal import Decimal, InvalidOperation
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        text = repr(value) if isinstance(value, float) else str(value)
    elif isinstance(value, str) and _NUMERIC_TEXT_RE.match(value.strip()):
        text = value.strip()
    else:
        return None
    try:
        number = Decimal(text)
    except InvalidOperation:
        return None
    return number if number.is_finite() else None


def _as_datetime(value):
    """(kind, datetime) for an ISO-8601 string: kind is "aware",
    "naive" (no offset), or "date" (no time). None when not a date."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not _ISO_DATETIME_RE.match(text):
        return None
    if len(text) == 10:
        try:
            return "date", datetime.fromisoformat(text)
        except ValueError:
            return None
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text.replace(" ", "T", 1))
    except ValueError:
        return None
    return ("aware" if parsed.tzinfo is not None else "naive"), parsed


def _html_tokens(value, drop_stripped=False):
    """Canonical token list for an HTML fragment: start tags (lowercased,
    attributes sorted) and whitespace-collapsed text. End tags are
    ignored, so an unclosed tag matches its closed echo."""
    import html.parser

    class _Canon(html.parser.HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.tokens = []
            self.skip = 0

        def handle_starttag(self, tag, attrs):
            if drop_stripped and tag in _HTML_STRIPPED_ELEMENTS:
                self.skip += 1
                return
            if not self.skip:
                self.tokens.append(("tag", tag, tuple(sorted(
                    (k, v or "") for k, v in attrs))))

        def handle_startendtag(self, tag, attrs):
            if not self.skip and not (
                    drop_stripped and tag in _HTML_STRIPPED_ELEMENTS):
                self.tokens.append(("tag", tag, tuple(sorted(
                    (k, v or "") for k, v in attrs))))

        def handle_endtag(self, tag):
            if drop_stripped and tag in _HTML_STRIPPED_ELEMENTS \
                    and self.skip:
                self.skip -= 1

        def handle_data(self, data):
            if self.skip:
                return
            if self.tokens and self.tokens[-1][0] == "text":
                self.tokens[-1] = ("text", self.tokens[-1][1] + data)
            else:
                self.tokens.append(("text", data))

    parser = _Canon()
    parser.feed(value)
    parser.close()
    out = []
    for token in parser.tokens:
        if token[0] == "text":
            text = " ".join(token[1].split())
            if text:
                out.append(("text", text))
        else:
            out.append(token)
    return out


def _html_text(tokens):
    return " ".join(t[1] for t in tokens if t[0] == "text")


# Attributes whose value is what the content points at: a changed or
# missing value is a different page, never a sanitizer normalization.
_HTML_TARGET_ATTRS = ("href", "src", "data", "action", "poster", "srcset",
                      "cite", "formaction")
# Tags a body-fragment sanitizer removes: the stripped elements above plus
# document-head elements that never belong in a fragment.
_HTML_SANITIZER_REMOVABLE = _HTML_STRIPPED_ELEMENTS | frozenset({
    "meta", "link", "base"})
# Query parameters Canvas adds to rewritten file links.
_CANVAS_LINK_PARAMS = frozenset({"wrap", "verifier", "download_frd"})


def _html_link_equivalent(want, got):
    """True when two link targets name the same resource after the
    rewriting Canvas does to course links: an absolute same-course URL
    becomes a relative path, and file links gain wrap/verifier params."""
    if want == got:
        return True
    w, g = urllib.parse.urlsplit(want), urllib.parse.urlsplit(got)
    if w.scheme and g.scheme and (w.scheme, w.netloc) != (g.scheme, g.netloc):
        return False
    if w.path.rstrip("/") != g.path.rstrip("/"):
        return False

    def params(parts):
        return sorted((k, v) for k, v in urllib.parse.parse_qsl(parts.query)
                      if k not in _CANVAS_LINK_PARAMS)
    return params(w) == params(g) and w.fragment == g.fragment


def _html_verdict(want, got):
    """match, uncertain (only differences a sanitizer can cause), or
    mismatch. Text must agree (content inside stripped elements aside);
    every requested tag must survive unless a sanitizer removes that
    tag; a surviving tag's link target (href, src, ...) must be the same
    resource; other attribute differences and tags the LMS adds are
    uncertain."""
    want_tokens, got_tokens = _html_tokens(want), _html_tokens(got)
    if want_tokens == got_tokens:
        return "match"
    if _html_text(want_tokens) != _html_text(got_tokens) and \
            _html_text(_html_tokens(want, drop_stripped=True)) \
            != _html_text(got_tokens):
        return "mismatch"
    want_tags = [t for t in _html_tokens(want, drop_stripped=True)
                 if t[0] == "tag"]
    got_tags = [t for t in got_tokens if t[0] == "tag"]
    cursor = 0
    for _kind, name, attrs in want_tags:
        for index in range(cursor, len(got_tags)):
            if got_tags[index][1] == name:
                break
        else:
            if name in _HTML_SANITIZER_REMOVABLE:
                continue
            return "mismatch"
        got_attrs = dict(got_tags[index][2])
        cursor = index + 1
        for key, value in attrs:
            if key in _HTML_TARGET_ATTRS:
                if key not in got_attrs or not _html_link_equivalent(
                        value, got_attrs[key]):
                    return "mismatch"
    return "uncertain"


_MAX_ZONE_SPREAD = timedelta(hours=26)


def _datetime_verdict(want_d, got_d):
    """Verdict for two parsed ISO values (kind, datetime).

    aware vs aware: the same instant is a match, and so is one side
    being the other with its fractional seconds truncated (Canvas stores
    whole seconds). A requested local midnight read back
    as 23:59:59 or 23:59:00 of that day or the day before is uncertain:
    this repo has no evidence for that Canvas adjustment, so it is never
    called verified. Any other difference is proven.

    A naive or date-only value is read in a zone Morrow does not know,
    so it is uncertain only while the difference fits some real zone
    offset (26 hours spans UTC-12 to UTC+14; a date-only value may land
    on the day before or after). Anything further is proven."""
    (wk, wv), (gk, gv) = want_d, got_d
    if wk == "aware" and gk == "aware":
        if wv == gv:
            return "match"
        if wv.replace(microsecond=0) == gv or \
                gv.replace(microsecond=0) == wv:
            return "match"
        local_want = wv
        local_got = gv.astimezone(wv.tzinfo)
        if (local_want.hour, local_want.minute, local_want.second) \
                == (0, 0, 0) and (local_got.hour, local_got.minute) \
                == (23, 59) and local_got.second in (0, 59) and \
                (local_got.date() - local_want.date()).days in (0, -1):
            return "uncertain"
        return "mismatch"

    def naive(kind, value):
        if kind == "aware":
            return value.astimezone(timezone.utc).replace(tzinfo=None)
        return value
    if wk == "date" and gk == "date":
        return "match" if wv == gv else "mismatch"
    if wk == "date" or gk == "date":
        wdate, gdate = naive(wk, wv).date(), naive(gk, gv).date()
        return "uncertain" if abs((wdate - gdate).days) <= 1 else "mismatch"
    diff = abs(naive(wk, wv) - naive(gk, gv))
    if wk == "naive" and gk == "naive":
        return "match" if diff == timedelta(0) else (
            "uncertain" if diff <= _MAX_ZONE_SPREAD else "mismatch")
    return "uncertain" if diff <= _MAX_ZONE_SPREAD else "mismatch"


def _write_field_verdict(want, got):
    """Compare one requested scalar against the readback value by field
    meaning: "match", "mismatch" (a proven difference), or "uncertain"
    (the difference could be the LMS's own normalization).

    Empty equivalents match each other: a cleared field sent as "" (or
    an empty list) may be stored and echoed as null. Booleans compare in
    canonical form (True, 1, "1", "true", "on"), and a value that is not
    a canonical bool on either side is a proven difference; numbers
    compare numerically ("10" vs 10.0); ISO-8601 values compare by
    _datetime_verdict; HTML compares by _html_verdict."""
    if _is_empty_value(want) or _is_empty_value(got):
        return "match" if (_is_empty_value(want)
                           and _is_empty_value(got)) else "mismatch"
    if isinstance(want, (dict, list)) or isinstance(got, (dict, list)):
        return "match" if want == got else "mismatch"
    if isinstance(want, bool) or isinstance(got, bool):
        want_b, got_b = _as_bool(want), _as_bool(got)
        if want_b is None or got_b is None:
            return "mismatch"
        return "match" if want_b == got_b else "mismatch"
    want_n, got_n = _as_number(want), _as_number(got)
    if want_n is not None and got_n is not None:
        return "match" if want_n == got_n else "mismatch"
    want_d, got_d = _as_datetime(want), _as_datetime(got)
    if want_d is not None and got_d is not None:
        if str(want).strip() == str(got).strip():
            return "match"
        return _datetime_verdict(want_d, got_d)
    if isinstance(want, str) and isinstance(got, str):
        if want == got:
            return "match"
        if _HTML_TAG_RE.search(want) or _HTML_TAG_RE.search(got):
            return _html_verdict(want, got)
        if " ".join(want.split()) == " ".join(got.split()):
            return "uncertain"
        return "mismatch"
    return "match" if str(want) == str(got) else "mismatch"


def _write_field_matches(want, got):
    """True when the readback value proves the requested value landed."""
    return _write_field_verdict(want, got) == "match"


def _scalar_list_verdict(want, got):
    remaining = list(got)
    verdict = "match"
    for item in want:
        for index, candidate in enumerate(remaining):
            if _write_field_verdict(item, candidate) == "match":
                del remaining[index]
                break
        else:
            for index, candidate in enumerate(remaining):
                if _write_field_verdict(item, candidate) == "uncertain":
                    del remaining[index]
                    verdict = "uncertain"
                    break
            else:
                return "mismatch"
    return "mismatch" if remaining else verdict


def _compare_intent(want, got, path, compared, unechoed, mismatches,
                    unconfirmed=None):
    """Recursive intent-vs-readback comparison.

    Requested dict keys the provider did not echo go to unechoed (the
    field cannot be confirmed, so the write cannot be called verified);
    compared leaves go to compared; proven differences go to
    mismatches; differences that could be the LMS's own normalization
    go to unconfirmed (unechoed when no unconfirmed list is given).
    Scalar lists compare as multisets (order is not persisted state).
    Lists of objects compare element by element when the lengths agree;
    a length difference is not a proof (the provider may add defaults),
    so the list is recorded as unechoed."""
    if unconfirmed is None:
        unconfirmed = unechoed
    if isinstance(want, dict):
        if _is_empty_value(want) and _is_empty_value(got):
            compared.append(path)
            return
        if not isinstance(got, dict):
            mismatches.append("%s: requested %r, persisted %r"
                              % (path, want, got))
            return
        for key, sub in want.items():
            sub_path = "%s.%s" % (path, key) if path else str(key)
            if key not in got:
                unechoed.append(sub_path)
                continue
            _compare_intent(sub, got[key], sub_path, compared, unechoed,
                            mismatches, unconfirmed)
        return
    if isinstance(want, list):
        if _is_empty_value(want) and _is_empty_value(got):
            compared.append(path)
            return
        if not isinstance(got, list):
            mismatches.append("%s: requested %r, persisted %r"
                              % (path, want, got))
            return
        if all(not isinstance(v, (dict, list)) for v in want + got):
            verdict = _scalar_list_verdict(want, got)
            if verdict == "match":
                compared.append(path)
            elif verdict == "uncertain":
                unconfirmed.append(path)
            else:
                mismatches.append("%s: requested %r, persisted %r"
                                  % (path, want, got))
            return
        if len(want) != len(got):
            unechoed.append(path)
            return
        for index, (w, g) in enumerate(zip(want, got)):
            _compare_intent(w, g, "%s[%d]" % (path, index), compared,
                            unechoed, mismatches, unconfirmed)
        return
    verdict = _write_field_verdict(want, got)
    if verdict == "match":
        compared.append(path)
    elif verdict == "uncertain":
        unconfirmed.append(path)
    else:
        mismatches.append("%s: requested %r, persisted %r"
                          % (path, want, got))


# --------------------------------------------------------------------------
# New Quiz settings readback verification
# --------------------------------------------------------------------------
# New Quiz settings travel as a complete merged block
# ({"quiz": {"quiz_settings": {...}}}); the generic intent extractor drops
# nested dicts, so a settings write would read back "pass" without ever
# comparing the settings. This helper returns the sent settings block for
# a New Quiz quiz-member PATCH, else None, and run_write_readback compares
# it against the readback's quiz_settings with the cleared-equivalence
# rule (cleared leaves may echo as null, "", or the cleared placeholder;
# every other leaf must persist exactly).

_QUIZ_MEMBER_RE = re.compile(r"/quizzes/(\d+)$", re.IGNORECASE)


def _quiz_settings_write_block(method, url, resolved_body):
    """The sent quiz_settings block for a New Quiz settings PATCH, else None."""
    if str(method or "").upper() != "PATCH":
        return None
    if _new_quiz_path_kind(url) != "quiz_v1":
        return None
    try:
        path = (urllib.parse.urlparse(str(url)).path or "").rstrip("/")
    except Exception:  # noqa: BLE001 - unparseable URL is not a settings write
        return None
    if not _QUIZ_MEMBER_RE.search(path):
        return None  # item member or collection: not a quiz settings write
    unwrapped = _unwrap_canvas_body(resolved_body)
    block = (unwrapped or {}).get("quiz_settings")
    return block if isinstance(block, dict) else None


def _delete_readback_target(url):
    """The member GET that confirms a DELETE, or None when the route has
    no known member read (only the covered member routes qualify)."""
    target = str(url).split("?")[0].split("#")[0].rstrip("/")
    try:
        path = urllib.parse.urlparse(target).path or ""
    except Exception:  # noqa: BLE001 - an unparsable URL has no readback
        return None
    if _WRITE_READBACK_MEMBER_RE.search(path):
        return target
    return None


def _readback_get(entry, session, pack, config, params, transients, target,
                  method, max_bytes):
    block = {"method": "GET", "url": target, "headers": {}}
    rmethod, rurl, rheaders, rbody = build_request(
        entry, block, params, session, pack, config, transients or {})
    _status, resp_headers, raw, _attempts = session.raw_request(
        rmethod, rurl, rheaders, rbody, is_write=False, max_bytes=max_bytes)
    return apply_result_block(entry, raw, resp_headers)["payload"]


_CLASSIC_QUIZ_MEMBER_RE = re.compile(r"/api/v1/courses/\d+/quizzes/(\d+)$")


def _url_path(url) -> str:
    try:
        return (urllib.parse.urlparse(str(url)).path or "").rstrip("/")
    except Exception:  # noqa: BLE001 - an unparsable URL has no path
        return ""


# A course index (every classic quiz of a course) can be far larger than
# one operation's receipt bound; only its ids are read.
_INDEX_READ_MAX_BYTES = 8 * 1024 * 1024


def _read_collection_ids(entry, session, pack, config, params, transients,
                         url, method):
    """The ids a paginated collection lists, and whether every page was
    read in full: ({id, ...}, complete). Follows Link rel="next" (and
    the Chromium lane's next page) up to PAGINATION_MAX_PAGES; a page
    cut at the byte bound makes the read incomplete. A failed read
    raises UncertainWrite: the write returned 2xx."""
    ids, pages = set(), 0
    while True:
        pages += 1
        block = {"method": "GET", "url": url, "headers": {}}
        try:
            rmethod, rurl, rheaders, rbody = build_request(
                entry, block, params, session, pack, config,
                transients or {})
            _status, resp_headers, raw, _attempts = session.raw_request(
                rmethod, rurl, rheaders, rbody, is_write=False,
                max_bytes=_INDEX_READ_MAX_BYTES)
        except ProviderHttpError as exc:
            raise UncertainWrite(
                "delete readback GET %s failed HTTP %s; the %s effect is "
                "unconfirmed, not a proven failure" % (url, exc.status, method))
        except ExecutorError as exc:
            raise UncertainWrite(
                "delete readback GET %s failed (%s); the %s effect is "
                "unconfirmed, not a proven failure"
                % (url, type(exc).__name__, method))
        headers = {str(k).lower(): v for k, v in (resp_headers or {}).items()}
        cut = len(raw or b"") > _INDEX_READ_MAX_BYTES \
            or bool(headers.get("x-morrow-truncated"))
        try:
            payload = json.loads((raw or b"").decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            payload = None
        if not isinstance(payload, list):
            if cut:
                return ids, False
            raise UncertainWrite(
                "delete readback GET %s did not return a list; the %s effect "
                "is unconfirmed, not a proven failure" % (url, method))
        for item in payload:
            if isinstance(item, dict) and item.get("id") is not None:
                ids.add(str(item["id"]))
        if cut:
            return ids, False
        pagination = _pagination_state(resp_headers)
        if pagination is None or not pagination.get("partial"):
            return ids, True
        next_page = pagination.get("next_page")
        if not next_page or pages >= PAGINATION_MAX_PAGES:
            return ids, False
        url = urllib.parse.urljoin(url, next_page)


def _verify_classic_quiz_delete(entry, session, pack, config, params,
                                transients, method, url, quiz_id, max_bytes):
    """D-002: after a classic quiz delete Canvas may still serve the quiz
    on a direct member GET; the quiz leaving the course quiz index is
    the delete receipt."""
    member = str(url).split("?")[0].split("#")[0].rstrip("/")
    index = member[:-len("/" + quiz_id)]
    listed, complete = _read_collection_ids(
        entry, session, pack, config, params, transients,
        index + "?per_page=100", method)
    if quiz_id in listed:
        raise WriteFieldMismatch(
            "delete readback mismatch on %s %s: the quiz is still listed in "
            "the course quiz index (readback %s)" % (method, url, index))
    if complete:
        return {"status": "pass",
                "detail": "readback %s no longer lists quiz %s: removal from "
                          "the course quiz index is the delete receipt "
                          "(D-002: a direct GET may still serve a deleted "
                          "classic quiz)" % (index, quiz_id)}
    try:
        parsed = _readback_get(entry, session, pack, config, params,
                               transients, member, method, max_bytes)
    except ProviderHttpError as exc:
        if exc.status in (404, 410):
            return {"status": "pass",
                    "detail": "readback %s returned HTTP %s: the quiz is "
                              "gone" % (member, exc.status)}
        parsed = None
    except ExecutorError:
        parsed = None
    if isinstance(parsed, dict) and (
            str(parsed.get("workflow_state") or "").lower() == "deleted"
            or parsed.get("deleted") is True or parsed.get("deleted_at")):
        return {"status": "pass",
                "detail": "readback %s shows the quiz marked deleted"
                          % member}
    return {"status": "unverified",
            "detail": "the course quiz index %s could not be read in full, "
                      "and the pages read do not list quiz %s; the delete "
                      "is not confirmed" % (index, quiz_id)}


def _verify_delete(entry, session, pack, config, params, transients, method,
                   url, max_bytes):
    classic_quiz = _CLASSIC_QUIZ_MEMBER_RE.search(_url_path(url))
    if classic_quiz:
        return _verify_classic_quiz_delete(
            entry, session, pack, config, params, transients, method, url,
            classic_quiz.group(1), max_bytes)
    target = _delete_readback_target(url)
    if target is None:
        return {"status": "unverified",
                "detail": "readback not run: %s"
                          % _readback_skip_reason(method, url)}
    try:
        parsed = _readback_get(entry, session, pack, config, params,
                               transients, target, method, max_bytes)
    except ProviderHttpError as exc:
        if exc.status in (404, 410):
            return {"status": "pass",
                    "detail": "readback %s returned HTTP %s: the object is "
                              "gone" % (target, exc.status)}
        raise UncertainWrite(
            "delete readback GET %s failed HTTP %s; the %s effect is "
            "unconfirmed, not a proven failure" % (target, exc.status, method))
    except ExecutorError as exc:
        raise UncertainWrite(
            "delete readback GET %s failed (%s); the %s effect is "
            "unconfirmed, not a proven failure"
            % (target, type(exc).__name__, method))
    if isinstance(parsed, dict) and (
            str(parsed.get("workflow_state") or "").lower() == "deleted"
            or parsed.get("deleted") is True or parsed.get("deleted_at")):
        return {"status": "pass",
                "detail": "readback %s shows the object marked deleted"
                          % target}
    if not (isinstance(parsed, dict) and (parsed.get("id") is not None
                                          or parsed.get("url"))):
        return {"status": "unverified",
                "detail": "readback %s answered without a recognizable "
                          "object; the deletion is not confirmed" % target}
    exc = WriteFieldMismatch(
        "delete readback mismatch on %s %s: the object is still present "
        "(readback %s)" % (method, url, target))
    exc.readback_payload = parsed
    raise exc


def _combine_step_readbacks(step_readbacks):
    """One verification for a multi_step write: verified only when every
    write step's readback verified."""
    if not step_readbacks:
        return {"status": "unverified",
                "detail": "multi_step write: no write step was read back"}
    status = ("pass" if all(r.get("status") == "pass" for r in step_readbacks)
              else "unverified")
    return {"status": status,
            "detail": "; ".join("step %s: %s" % (r.get("step"), r.get("detail"))
                                for r in step_readbacks)}


def run_write_readback(entry, session, pack, config, params, transients,
                       method, url, resolved_body, result_payload,
                       max_bytes: int = None):
    """D-009 defense: fresh GET of the written object, compared field by
    field (nested objects and lists included) against the requested
    intent.

    Returns {"status": ..., "detail": ...} with status:
      "pass"        every requested field was read back and matched
                    (for DELETE: the member GET shows the object gone);
      "unverified"  the write returned success but the readback could
                    not confirm it: no readback route, zero comparable
                    fields, or requested fields the provider did not
                    echo. Never reported as a verified success.
    Raises WriteFieldMismatch when the readback proves a mismatch (hard
    failed write, mismatched fields named). Raises UncertainWrite when
    the readback GET itself fails (429/5xx/transport/4xx or a non-object
    response): the effect is unconfirmed, never a hard failure."""
    if not method or not url:
        return {"status": "unverified",
                "detail": "multi_step write: each write step was read back "
                          "as it ran; there is no single request to re-read"}
    if str(method).upper() == "DELETE":
        return _verify_delete(entry, session, pack, config, params,
                              transients, method, url, max_bytes)
    if str(method).upper() == "PUT":
        path = _url_path(url)
        if _OVERRIDE_BATCH_RE.search(path):
            return _readback_override_batch(
                entry, session, pack, config, params, transients, method,
                url, resolved_body, max_bytes)
        if _BULK_DATES_RE.search(path):
            return _readback_bulk_dates(
                entry, session, pack, config, params, transients, method,
                url, resolved_body, max_bytes)
    target = _readback_target(method, url, result_payload)
    if target is None:
        return {"status": "unverified",
                "detail": "readback not run: %s"
                          % _readback_skip_reason(method, url)}
    settings_block = _quiz_settings_write_block(method, url, resolved_body)
    intent = dict(_unwrap_canvas_body(resolved_body))
    if settings_block is not None:
        # Compared below with the New Quiz cleared-equivalence rule.
        intent.pop("quiz_settings", None)
    try:
        parsed = _readback_get(entry, session, pack, config, params,
                               transients, target, method, max_bytes)
    except ProviderHttpError as exc:
        raise UncertainWrite(
            "write readback GET %s failed HTTP %s; the %s effect is "
            "unconfirmed, not a proven mismatch" % (target, exc.status, method))
    except ExecutorError as exc:
        raise UncertainWrite(
            "write readback GET %s failed (%s); the %s effect is "
            "unconfirmed, not a proven mismatch"
            % (target, type(exc).__name__, method))
    if not isinstance(parsed, dict):
        raise UncertainWrite(
            "write readback GET %s did not return a JSON object; the %s "
            "effect is unconfirmed, not a proven mismatch" % (target, method))
    compared, unechoed, mismatches, unconfirmed = [], [], [], []
    _compare_intent(intent, parsed, "", compared, unechoed, mismatches,
                    unconfirmed)
    if settings_block is not None:
        read_block = parsed.get("quiz_settings")
        if isinstance(read_block, dict):
            settings_ok, settings_mismatches = new_quiz_settings_match(
                settings_block, read_block)
            if settings_ok:
                compared.append("quiz_settings")
            else:
                mismatches.append("quiz_settings %s"
                                  % "; ".join(settings_mismatches))
        else:
            unechoed.append("quiz_settings")
    return _readback_verdict(method, url, target, parsed, compared,
                             unechoed, mismatches, unconfirmed)


def _readback_verdict(method, url, target, parsed, compared, unechoed,
                      mismatches, unconfirmed):
    """The readback outcome from a finished comparison: WriteFieldMismatch
    for a proven difference, "unverified" when a requested field was not
    confirmed or nothing was comparable, else "pass"."""
    if mismatches:
        # W3-P2-5: the mismatch detail formats raw readback values with
        # %r, which can be learner names or identifiers. Carry the raw
        # readback payload on the exception so the journal handler can
        # project the detail through the learner boundary before it is
        # journaled.
        exc = WriteFieldMismatch(
            "write readback mismatch on %s %s (readback %s): %s"
            % (method, url, target, "; ".join(mismatches)))
        exc.readback_payload = parsed
        raise exc
    if unechoed or unconfirmed or not compared:
        reasons = []
        if unechoed:
            reasons.append("requested field(s) the provider did not echo: "
                           "%s" % ", ".join(sorted(unechoed)))
        if unconfirmed:
            reasons.append("field(s) stored in a form Canvas may have "
                           "normalized, so they are neither proven nor "
                           "disproven: %s" % ", ".join(sorted(unconfirmed)))
        if not reasons:
            reasons.append("any requested field (nothing comparable)")
        return {"status": "unverified",
                "detail": "readback %s matched %d field(s) (%s) but could "
                          "not confirm %s"
                          % (target, len(compared),
                             ", ".join(sorted(compared)) or "none",
                             "; ".join(reasons))}
    return {"status": "pass",
            "detail": "readback %s matched %d requested field(s): %s"
                      % (target, len(compared), ", ".join(sorted(compared)))}


# Batch writes change many objects in one request. Each change is read
# back where it lives, never by re-reading the batch route.
_OVERRIDE_BATCH_RE = re.compile(r"/api/v1/courses/\d+/assignments/overrides$")
_BULK_DATES_RE = re.compile(r"/api/v1/courses/\d+/assignments/bulk_update$")
_BULK_DATE_FIELDS = ("due_at", "unlock_at", "lock_at")


def _batch_readback_get(entry, session, pack, config, params, transients,
                        target, method, max_bytes):
    """GET one batch readback target; a failed read is UncertainWrite."""
    try:
        return _readback_get(entry, session, pack, config, params,
                             transients, target, method, max_bytes)
    except ProviderHttpError as exc:
        raise UncertainWrite(
            "write readback GET %s failed HTTP %s; the %s effect is "
            "unconfirmed, not a proven mismatch" % (target, exc.status, method))
    except ExecutorError as exc:
        raise UncertainWrite(
            "write readback GET %s failed (%s); the %s effect is "
            "unconfirmed, not a proven mismatch"
            % (target, type(exc).__name__, method))


def _readback_override_batch(entry, session, pack, config, params,
                             transients, method, url, resolved_body,
                             max_bytes):
    """C-36: read back exactly the overrides the batch update changed,
    with the batch retrieve (assignment_overrides[][id] and
    [][assignment_id] for each)."""
    sent = resolved_body.get("assignment_overrides") \
        if isinstance(resolved_body, dict) else None
    if not isinstance(sent, list) or not sent or not all(
            isinstance(o, dict) and o.get("id") is not None
            and o.get("assignment_id") is not None for o in sent):
        return {"status": "unverified",
                "detail": "readback not run: the batch override update "
                          "does not name each override's id and "
                          "assignment_id, so there is nothing to re-read"}
    pairs = []
    for override in sent:
        pairs.append(("assignment_overrides[][id]", str(override["id"])))
        pairs.append(("assignment_overrides[][assignment_id]",
                      str(override["assignment_id"])))
    target = "%s?%s" % (str(url).split("?")[0].split("#")[0].rstrip("/"),
                        urllib.parse.urlencode(pairs))
    parsed = _batch_readback_get(entry, session, pack, config, params,
                                 transients, target, method, max_bytes)
    if not isinstance(parsed, list):
        raise UncertainWrite(
            "write readback GET %s did not return a list; the %s effect is "
            "unconfirmed, not a proven mismatch" % (target, method))
    read = {str(o["id"]): o for o in parsed
            if isinstance(o, dict) and o.get("id") is not None}
    compared, unechoed, mismatches, unconfirmed = [], [], [], []
    for index, override in enumerate(sent):
        where = "assignment_overrides[%d] (override %s)" % (index,
                                                             override["id"])
        got = read.get(str(override["id"]))
        if got is None:
            unechoed.append(where)
            continue
        _compare_intent(override, got, where, compared, unechoed,
                        mismatches, unconfirmed)
    return _readback_verdict(method, url, target, parsed, compared,
                             unechoed, mismatches, unconfirmed)


def _readback_bulk_dates(entry, session, pack, config, params, transients,
                         method, url, resolved_body, max_bytes):
    """C-37: one GET per assignment (with its overrides), comparing the
    dates the update set. Canvas applies the update in the background
    (the PUT answers with a progress record), so a date that does not
    match yet is unconfirmed, never a proven failure."""
    sent = resolved_body
    if not isinstance(sent, list) or not sent or not all(
            isinstance(a, dict) and a.get("id") is not None
            and isinstance(a.get("all_dates"), list) for a in sent):
        return {"status": "unverified",
                "detail": "readback not run: the bulk date update does not "
                          "name each assignment id and its all_dates, so "
                          "there is nothing to re-read"}
    collection = str(url).split("?")[0].split("#")[0].rstrip("/")
    collection = collection[:-len("/bulk_update")]
    query = urllib.parse.urlencode([("include[]", "overrides")])
    compared, unechoed, mismatches, unconfirmed = [], [], [], []
    for assignment in sent:
        target = "%s/%s?%s" % (collection, urllib.parse.quote(
            str(assignment["id"]), safe=""), query)
        read = _batch_readback_get(entry, session, pack, config, params,
                                   transients, target, method, max_bytes)
        if not isinstance(read, dict):
            raise UncertainWrite(
                "write readback GET %s did not return a JSON object; the %s "
                "effect is unconfirmed, not a proven mismatch"
                % (target, method))
        overrides = {str(o.get("id")): o for o in read.get("overrides") or []
                     if isinstance(o, dict)}
        for index, date in enumerate(assignment["all_dates"]):
            where = "assignment %s all_dates[%d]" % (assignment["id"], index)
            if not isinstance(date, dict):
                unechoed.append(where)
                continue
            want = {k: date[k] for k in _BULK_DATE_FIELDS if k in date}
            if date.get("base"):
                got = read
            elif date.get("id") is not None:
                got = overrides.get(str(date["id"]))
            else:
                got = None
            if got is None:
                unechoed.append(where)
                continue
            _compare_intent(want, got, where, compared, unechoed,
                            mismatches, unconfirmed)
    where = "of %d assignment(s)" % len(sent)
    if mismatches:
        return {"status": "unverified",
                "detail": "readback %s found date(s) that do not match yet: "
                          "%s. Canvas applies a bulk date update in the "
                          "background, so this is not proof the change "
                          "failed; it is not confirmed"
                          % (where, "; ".join(mismatches))}
    return _readback_verdict(method, url, where, sent, compared, unechoed,
                             mismatches, unconfirmed)


# --------------------------------------------------------------------------
# Effect-class derivation (W4-P0-10)
# --------------------------------------------------------------------------
# The effect class is DERIVED from the entry's actual operations, never
# trusted from the caller or the manifest's "effects" field. Any
# PUT/POST/PATCH/DELETE request block (the single "request" block or any
# "multi_step" step) or any browser-write block means the entry is a
# write. Same semantics as the W3-P0-6 catalog fix: a declared class
# that disagrees with the derived class is refused loudly
# (EffectClassMismatch), never silently reclassified.

WRITE_METHODS = frozenset({"PUT", "POST", "PATCH", "DELETE"})

_BROWSER_WRITE_ACTIONS = frozenset({
    "write", "fill", "type", "submit", "click", "select", "upload",
})
# Browser actions that are provably read-only. Any browser block whose
# action is not in this set is treated as a write (fail closed): an
# unknown action (e.g. "execute_script") could mutate provider state,
# so derivation must never classify it as "read". W4-P0-10.
_BROWSER_READ_ACTIONS = frozenset({
    "navigate", "goto", "screenshot", "read", "get_text", "get_attribute",
    "wait", "scroll",
})


def _request_block_is_write(block: dict) -> str | None:
    """Return a reason string when this request-style block performs a
    write, else None."""
    method = str(block.get("method") or "").upper()
    if method in WRITE_METHODS:
        return "request block method %s" % method
    return None


def _browser_block_is_write(block: dict) -> str | None:
    """Return a reason string when this block drives a browser write
    action, else None. The managed-browser write lane is closed by
    design, but the derivation must still see such a block if one ever
    appears in a manifest: fail closed, never trust "effects".

    W4-P0-10: unknown browser actions are treated as writes. Only the
    provably read-only actions in _BROWSER_READ_ACTIONS classify as
    "read"; anything else (including a missing action) could mutate
    provider state.
    """
    browser = block.get("browser")
    if isinstance(browser, dict):
        action = str(browser.get("action") or "").lower()
        if action in _BROWSER_WRITE_ACTIONS:
            return "browser block action %r" % browser.get("action")
        if action not in _BROWSER_READ_ACTIONS:
            return ("browser block action %r is not a known read-only "
                    "action; failing closed as a write"
                    % (browser.get("action") or "<missing>"))
    return None


def _entry_request_blocks(entry: dict) -> list:
    """Every block of the entry that can issue a provider request, as
    (where, block) pairs: request, multi_step steps, discovery, verify,
    before_state, undo, and any other top-level block (or list of
    blocks) that carries a method, url, or browser action. Derived
    readbacks are not entry blocks and are not listed."""
    blocks = []
    for key, value in entry.items():
        if isinstance(value, dict):
            candidates = [(key, value)]
        elif isinstance(value, list):
            candidates = [("%s[%d]" % (key, i), v)
                          for i, v in enumerate(value) if isinstance(v, dict)]
        else:
            continue
        for where, block in candidates:
            if key in ("request", "multi_step") or any(
                    k in block for k in ("method", "url", "browser")):
                blocks.append((where, block))
    return blocks


# Blocks that exist only to read (discovery pre-pass, declared verify,
# before-state freshness reader): they are sent with is_write=False,
# so anything but GET would be an unjournaled, unapproved write.
_READ_ONLY_BLOCK_KEYS = ("discovery", "verify", "before_state")


def _assert_read_only_block(entry: dict, block: dict, where: str) -> None:
    method = str(block.get("method") or "GET").upper()
    if method != "GET":
        raise EffectClassMismatch(
            "entry %r: its %s block uses %s; %s blocks are sent as reads "
            "and must be GET. Refusing." % (entry.get("name"), where,
                                            method, where))


def derive_effect_class(entry: dict) -> tuple:
    """Derive ("read"|"write", reason|None) from the entry's blocks.

    Scans every request-issuing block (see _entry_request_blocks).
    "plan" is not derivable from blocks: a plan-class entry performs no
    write, so derivation yields "read" for it and the declared "plan" is
    allowed only when nothing writes (enforcing the documented "plan
    performs no write" contract that W4-P0-10 found unenforced)."""
    for where, block in _entry_request_blocks(entry):
        reason = _request_block_is_write(block) or _browser_block_is_write(block)
        if reason:
            return "write", "%s: %s" % (where, reason)
    return "read", None


def enforce_effect_class(entry: dict) -> tuple:
    """Refuse when the manifest's declared effects disagree with the
    derived effect class (W4-P0-10). Returns (derived, declared).

    Rules: derived "write" requires declared "write" (anything else is
    refused: a write may never ride as "read" or "plan" to dodge write
    approval). Derived "read" allows declared "read" or "plan" (plan is
    verified read-like here: it performs no write). Declared "write"
    with derived "read" is allowed: the write gates apply to an entry
    that performs no write, which is stricter than needed, never
    looser. An unknown declared class is refused outright."""
    declared = entry.get("effects", "read")
    if declared not in ("read", "write", "plan"):
        raise ExecutorError(
            "entry %r declares unknown effect class %r; must be one of "
            "'read', 'write', 'plan'" % (entry.get("name"), declared))
    derived, reason = derive_effect_class(entry)
    if derived == "write" and declared != "write":
        raise EffectClassMismatch(
            "entry %r declares effects=%r but its blocks perform a write "
            "(%s). The effect class is derived from the entry's actual "
            "operations, never trusted from the manifest: a write cannot "
            "be dispatched as %r to dodge write approval. Refusing."
            % (entry.get("name"), declared, reason, declared))
    return derived, declared


def _release_claim_quietly(op_id, claim_token, reason):
    """Release a journal claim, swallowing DuplicateOpId (the claim may
    already be gone); used on pre-dispatch refusals so the op_id stays
    reusable."""
    try:
        release_op_id(op_id, claim_token, reason)
    except DuplicateOpId:
        pass


def _write_target_course_id(entry: dict, params: dict) -> str | None:
    """The course id the write will actually target.

    The /courses/<id> segment of the rendered request path (request
    URL, then each multi_step URL), else params.course_id; see
    admission.write_target_course_id, which admission uses for the same
    write. The frozen plan's declared target is deliberately NOT
    consulted here: the provider precheck must GET the course the write
    will hit, then compare it against the plan's declared target.
    Consulting the plan for the GET target would let a typo'd course id
    slip past.
    """
    return admission_write_target_course_id(entry, params)


def _declared_target(plan) -> dict:
    """The frozen plan's declared human-readable target, or {}."""
    if plan is not None and getattr(plan, "target_identity", None):
        return plan.target_identity
    return {}


def _readback_names_course(readback, course_id: str) -> bool:
    """Exact whole-token course-id match in a frozen readback.

    Substring matching is wrong here: course 12 must not corroborate a
    readback naming course 312. The id must appear as a standalone
    token (not embedded in a longer digit run).
    """
    token = re.compile(r"(?<!\d)%s(?!\d)" % re.escape(str(course_id)))
    if isinstance(readback, dict):
        for key in ("course_id", "course", "id", "name", "title"):
            value = readback.get(key)
            if value is not None and token.search(str(value)):
                return True
        return False
    return bool(token.search(str(readback)))


def _verify_plan_target_corroboration(entry: dict, params: dict, plan) -> dict | None:
    """W4-P0-11(1): actually READ the frozen readback, and require a
    declared human-readable target.

    Fail-closed rules for a write that targets a course:
      1. The frozen plan MUST declare target_identity with course_id
         and course_name: without it the educator never reviewed the
         human-readable target they signed for. Term is compared when
         declared (some courses have none).
      2. The declared course_id must equal the course the write will
         actually target (params/path). A plan/entry mismatch refuses
         here, before any provider call.
      3. The frozen readback must corroborate the declared course id
         with an exact whole-token match (course 12 never matches 312):
         a typo'd course_id that names a different real course is caught
         here when the readback was frozen against the intended course.
    Non-course writes (no course_id anywhere) skip. Returns
    {"course_id": ...} or None.
    """
    write_cid = _write_target_course_id(entry, params)
    if write_cid is None:
        return None
    declared = _declared_target(plan)
    declared_cid = declared.get("course_id")
    declared_name = declared.get("course_name")
    if declared_cid is None or declared_name is None \
            or not str(declared_name).strip():
        raise TargetIdentityMismatch(
            "entry %r targets course %s but the frozen plan declares no "
            "target_identity.course_id/course_name: the educator never "
            "reviewed the human-readable write target. Refusing; re-freeze "
            "the plan with target_identity {course_id, course_name, term} "
            "so the approval names the course being changed."
            % (entry.get("name"), write_cid))
    if str(declared_cid) != write_cid:
        raise TargetIdentityMismatch(
            "frozen plan declares write target course %s (%r) but the "
            "entry's write target is course %s: plan and entry disagree "
            "about which course is being changed. Refusing."
            % (declared_cid, declared_name, write_cid))
    if not _readback_names_course(plan.frozen_readback, str(declared_cid)):
        raise TargetIdentityMismatch(
            "frozen plan's readback does not corroborate course %s for "
            "entry %r: the readback names a different course (or none), "
            "so this write may be aimed at the wrong course. Refusing; "
            "re-freeze the plan against the intended course."
            % (declared_cid, entry.get("name")))
    return {"course_id": write_cid}


def _verify_plan_request(entry: dict, params: dict, plan,
                         learner_tokens=None) -> None:
    """Round-4 H1: a plan frozen for one request never covers another.

    A plan that records its request (plan-write always does) must name
    exactly this dispatch's params and request (method, path, query,
    body). Legacy plans without a request_digest are unaffected.

    Final muse audit M1: a plan that names students by label also
    records each label's vault token (learner_<uuid>, new on every
    issue), inside the digested request. learner_tokens is what the
    labels resolve to now; a label that now names a different issue
    (the course's labels were purged and re-issued between plan and
    approval) is refused, so an approval never follows the label text
    to another student."""
    if plan is None or getattr(plan, "request_digest", None) is None:
        return
    if digest_of(plan.params or {}) != digest_of(params or {}):
        raise MissingFrozenPlan(
            "frozen plan %s was built for different params than this "
            "dispatch; nothing was sent" % plan.path)
    subject = admission_request_subject(entry, params)
    planned = getattr(plan, "learner_tokens", None) or {}
    current = learner_tokens or {}
    if planned or current:
        changed = sorted(label for label in set(planned) | set(current)
                         if planned.get(label) != current.get(label))
        if changed:
            raise LearnerLabelUnresolved(
                "%s no longer names the student the educator approved: "
                "this course's student labels were cleared and issued "
                "again after the approval was prepared. Nothing was sent. "
                "Run `bin/morrow students find` again, then prepare a new "
                "approval with plan-write." % ", ".join(changed))
        subject = dict(subject, learner_tokens=current)
    if admission_request_digest(subject) != plan.request_digest:
        raise MissingFrozenPlan(
            "frozen plan %s was built for a different request (method, "
            "path, query, or body) than this dispatch sends; nothing was "
            "sent" % plan.path)


def _check_expected_digest_guard(entry: dict, params: dict, plan,
                                 release=None) -> None:
    """The concurrency.requires == "expected_digest" guard, honestly
    wired (W4-P1-15).

    The old behavior compared a caller-supplied params.expected_digest
    against the plan digest: the caller attesting to its own freshness,
    which proves nothing. Now: an entry that demands expected_digest
    MUST declare a verifiable before_state reader (entry["before_state"]
    with a method/url); otherwise the demand is refused as
    misconfigured, because the guard it implies cannot be enforced.
    When a verifiable reader exists, the fresh-provider-read comparison
    in dispatch_entry is the real enforcement; this check keeps the
    caller-echo requirement for entries that declare it."""
    concurrency = entry.get("concurrency") or {}
    if concurrency.get("requires") != "expected_digest":
        return
    before_state = entry.get("before_state") or {}
    if before_state.get("unsupported") or not before_state.get("url"):
        raise ExecutorError(
            "entry %r requires expected_digest concurrency but declares "
            "no verifiable before_state reader; the guard it implies "
            "cannot be honestly enforced. Declare entry['before_state'] "
            "with a method/url (or mark it unsupported and drop the "
            "concurrency requirement)." % entry.get("name"))
    expected = (params or {}).get("expected_digest")
    if not expected:
        if release is not None:
            release("expected_digest missing; nothing dispatched")
        raise MissingFrozenPlan("entry requires expected_digest in params")
    if plan and expected != plan.before_state_digest:
        if release is not None:
            release("expected_digest mismatch; nothing dispatched")
        raise MissingFrozenPlan(
            "expected_digest does not match the frozen before-state digest; "
            "state moved since the plan was frozen")


def _check_write_gates(entry: dict, params: dict, plan, op_id, kind="dispatch",
                      resume=False, claim_token=None, dry_run=False,
                      plan_not_required=False, learner_tokens=None) -> tuple:
    """Shared write gating: halt file, frozen plan, duplicate op id, concurrency.

    Returns (op_id, claim_token). The op-id guard is an atomic
    check-and-claim under the journal lock (W2-P0-18): claim_op_id raises
    DuplicateOpId for an already-claimed/completed op and appends a
    fsync'd WAL record otherwise, so the crash window between provider
    dispatch and the completion record leaves a record, not silence
    (W2-P0-2). resume=True with claim_token re-validates an existing
    claim owned by the same token (the browser lane's verify phase)
    instead of claiming twice. Used by dispatch_entry, dispatch_undo,
    and the browser lane (dispatch, complete, and undo phases).

    dry_run=True evaluates every gate but journals nothing: the op_id is
    never claimed and no claim is ever released. Gate failures still
    raise; the caller renders the refusal instead of dispatching.

    plan_not_required=True when the Plan/Edit mode gate already
    authorized this write in edit mode: the frozen plan is the plan-mode
    approval ceremony's artifact, and edit mode skips per-write approval
    by design (the educator's grant IS the authorization). Every other
    gate (halt, quarantine, op-id claim, concurrency) still applies, and
    plan mode still requires the frozen plan.
    """
    # W4-P0-10: the effect class is derived from the entry's blocks
    # before any gate trusts the manifest's "effects" field.
    _derived, declared = enforce_effect_class(entry)
    entry_name = entry.get("name")
    is_write = declared == "write"

    # W4-P2-1: the halt gate routes through the re-auth state
    # machine's check_write_allowed (not a bare file test), so the
    # reason the educator sees names the halt's cause.
    if is_write:
        from reauth import state_machine as _rsm
        _allowed, _reason = _rsm.check_write_allowed()
        if not _allowed:
            halted = WriteHaltActive(
                "write halt is active (%s): %s; every write is refused "
                "while the halt stands" % (WRITE_HALT_PATH, _reason))
            # For the failure translator: a session-expiry halt lifts
            # only after the educator signs in again and resume
            # verifies the account; any other halt is an operator's.
            halted.halt_cause = _rsm.halt_cause() or "manual"
            raise halted
    if is_write and kind != "undo" and not resume and plan is None \
            and not plan_not_required:
        raise MissingFrozenPlan(
            "effects=write requires a frozen plan; none was supplied for %r" % entry_name)
    op_id = check_uuid(op_id or (plan.op_id if plan else uuid.uuid4()))
    if plan and str(plan.op_id) != str(op_id):
        raise MissingFrozenPlan(
            "supplied op_id %s does not match frozen plan op_id %s" % (op_id, plan.op_id))
    # W4-P2-1: quarantine gate. After a session death, an op parked in
    # the re-auth ledger may only be re-dispatched once the educator
    # explicitly approved it (reauth approve --op-id). quarantined and
    # awaiting_approval ops are refused; nothing auto-resumes. The
    # resume=True path (two-phase dispatch: same op, claim-token
    # re-validation, no new claim) is exempt: it is a phase of the
    # original dispatch, not a re-dispatch.
    if not resume:
        from reauth import state_machine as _rsm_q
        _qstatus = _rsm_q.op_quarantine_status(str(op_id))
        if _qstatus in ("quarantined", "awaiting_approval"):
            parked = WriteHaltActive(
                "op %s is quarantined (status %s) after a session "
                "death: re-dispatch needs the educator's explicit "
                "approval (reauth approve --op-id %s) after verified "
                "resume; nothing auto-resumes" % (op_id, _qstatus, op_id))
            parked.halt_cause = "session_expired"
            raise parked
    if resume:
        # Second phase of a two-phase dispatch: the request phase already
        # claimed this op_id. Re-validate ownership via the claim token;
        # never claim twice, never let a foreign claim through.
        if not claim_token:
            raise DuplicateOpId(
                "resume re-check for op %s carries no claim token; refusing "
                "to adopt an unowned claim" % op_id)
        recheck_claim(op_id, claim_token)
        return op_id, claim_token
    if dry_run:
        # Evaluate, never claim: no journal record, nothing to release.
        if plan and plan.entry_name != entry_name:
            raise MissingFrozenPlan(
                "frozen plan names %r, but entry is %r" % (plan.entry_name, entry_name))
        if is_write and plan is not None:
            _verify_plan_request(entry, params, plan, learner_tokens)
            _verify_plan_target_corroboration(entry, params, plan)
        _check_expected_digest_guard(entry, params, plan)
        return op_id, None
    claim_token = claim_op_id(op_id, kind=kind, entry_name=entry_name,
                              effects=entry.get("effects", "read"),
                              params_digest=digest_of(params or {}))
    if plan and plan.entry_name != entry_name:
        # The claim is already journaled; release it so the op_id stays
        # reusable: the plan mismatch means nothing was dispatched.
        try:
            release_op_id(op_id, claim_token,
                          "frozen plan entry mismatch; nothing dispatched")
        except DuplicateOpId:
            pass
        raise MissingFrozenPlan(
            "frozen plan names %r, but entry is %r" % (plan.entry_name, entry_name))
    if is_write and plan is not None:
        # W4-P0-11: the frozen readback is actually READ here: the course
        # it names must corroborate the plan's course_id, or the write is
        # refused and the just-taken claim is released (nothing
        # dispatched, op_id reusable).
        try:
            _verify_plan_request(entry, params, plan, learner_tokens)
            _verify_plan_target_corroboration(entry, params, plan)
        except (TargetIdentityMismatch, MissingFrozenPlan,
                LearnerLabelUnresolved):
            try:
                release_op_id(op_id, claim_token,
                              "target identity corroboration failed; nothing dispatched")
            except DuplicateOpId:
                pass
            raise

    concurrency = entry.get("concurrency") or {}
    _check_expected_digest_guard(entry, params, plan,
                                 release=lambda reason: _release_claim_quietly(
                                     op_id, claim_token, reason))
    return op_id, claim_token


# --------------------------------------------------------------------------
# The dispatch pipeline
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Dry-run rendering (W4-P2-26)
# --------------------------------------------------------------------------

_DRY_RUN_SECRET_HEADER_NAMES = frozenset({
    "authorization", "cookie", "set-cookie", "x-api-key",
})


def _dry_run_secret_headers(entry: dict, pack: dict) -> set:
    """Header names whose values are credential material: redact them in
    dry-run output. Covers explicit {"credential": slot} header specs
    (single request and every multi_step step) and the pack auth-slot
    injection header, plus the defensive built-in secret names."""
    names = set(_DRY_RUN_SECRET_HEADER_NAMES)

    def scan(block):
        for hname, hspec in ((block or {}).get("headers") or {}).items():
            if isinstance(hspec, dict) and "credential" in hspec:
                names.add(str(hname).lower())

    scan(entry.get("request"))
    for step in entry.get("multi_step") or []:
        if isinstance(step, dict):
            scan(step)
    slot = (entry.get("auth") or {}).get("slot")
    if slot:
        inject = ((pack.get("credential_slots") or {}).get(slot) or {}).get("inject") or {}
        if inject.get("header"):
            names.add(str(inject["header"]).lower())
    return names


def _render_request_block(entry, block, params, session, pack, config,
                          label, secret_headers, result_payload=None) -> dict:
    """Render one request block as the dry-run request description."""
    try:
        method, url, headers, body_bytes = build_request(
            entry, block, params, session, pack, config, {},
            result_payload, dry_run=True)
    except ExecutorError as exc:
        return {"label": label, "unrenderable": "%s: %s"
                % (type(exc).__name__, exc)}
    safe_headers = {}
    for hname, hvalue in (headers or {}).items():
        if str(hname).lower() in secret_headers:
            safe_headers[hname] = "***REDACTED***"
        else:
            safe_headers[hname] = hvalue
    body = None
    if body_bytes:
        try:
            body = json.loads(body_bytes.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            body = "<%d bytes of non-JSON body>" % len(body_bytes)
    return {"label": label,
            "method": method,
            "url": _redacted_url(url),
            "headers": safe_headers,
            "body": redact_payload(body, DEFAULT_REDACT_PATTERNS)}


def _render_dry_run(entry, params, session, pack, plan, op_id,
                    approval_audit, tenant_base, derived, declared) -> dict:
    """W4-P2-26: render the exact write request without sending anything.

    Every gate that can be evaluated without provider calls has already
    passed (failures raise before this is called). Provider-dependent
    gates (target-identity GET, before-state re-read, discovery) are
    reported as skipped: dry-run performs zero provider calls of any
    kind, journals nothing, claims no op_id, and never persists or
    consumes the approval. Returns the report dict; the CLI prints it."""
    is_write = declared == "write"
    gates = [
        {"gate": "effect_class_derivation", "result": "pass",
         "detail": "declared %r, derived %r from the entry's blocks"
                   % (declared, derived)},
        {"gate": "admission", "result": "pass",
         "detail": ("write approval verified (digest-bound, educator-signed, "
                     "unexpired, single-use check passed); NOT consumed in "
                     "dry-run" if is_write and approval_audit is not None
                     else "read: no approval required")},
        {"gate": "write_halt", "result": "pass",
         "detail": "no write halt file present"},
    ]
    if is_write:
        if plan is not None:
            gates.append({"gate": "frozen_plan", "result": "pass",
                          "detail": ("plan %s names entry %r and its readback "
                                     "corroborates the target course")
                          % (plan.op_id, plan.entry_name)})
        gates.append({"gate": "op_id_claim", "result": "skipped",
                      "detail": "dry-run: the op_id is never claimed and "
                                "nothing is journaled"})
        gates.append({"gate": "target_identity_provider_check",
                      "result": "skipped",
                      "detail": "dry-run: no provider calls; the course GET "
                                "precheck would run after the claim, before "
                                "any write"})
        gates.append({"gate": "before_state_reread", "result": "skipped",
                      "detail": "dry-run: no provider calls; the fresh-read "
                                "comparison would run after the claim, before "
                                "any write"})
        publish_target = _new_quiz_publish_target(entry)
        if publish_target:
            gates.append({"gate": "new_quiz_publish_check",
                          "result": "skipped",
                          "detail": "dry-run: no provider calls; the %s "
                                    "is read before the change is sent, "
                                    "and publishing a New Quiz is refused"
                                    % publish_target})
    config = {"canvas_base": tenant_base or ""}
    secret_headers = _dry_run_secret_headers(entry, pack)
    requests = []
    if entry.get("discovery"):
        gates.append({"gate": "discovery", "result": "skipped",
                      "detail": "dry-run: discovery GETs are not run; "
                                "transients are empty, so the rendered "
                                "request may be incomplete for entries that "
                                "need discovery values"})
    if entry.get("multi_step"):
        for index, step in enumerate(entry.get("multi_step") or []):
            if isinstance(step, dict):
                requests.append(_render_request_block(
                    entry, step, params, session, pack, config,
                    "multi_step[%d]%s" % (index,
                                          (" (%s)" % step.get("name"))
                                          if step.get("name") else ""),
                    secret_headers))
    elif entry.get("request"):
        requests.append(_render_request_block(
            entry, entry["request"], params, session, pack, config,
            "request", secret_headers))
    return {"dry_run": True,
            "entry_name": entry.get("name"),
            "op_id": op_id,
            "effect": {"declared": declared, "derived": derived},
            # W6-P1-H1: undoability is knowable before anything is sent.
            "undo_available": bool(entry.get("undo")),
            "tenant": tenant_base,
            "gates": gates,
            "requests": requests,
            "provider_calls": 0,
            "journaled": False,
            "approval_consumed": False,
            "note": ("dry-run: nothing was sent to the provider, nothing "
                     "was journaled, no op_id was claimed, and no approval "
                     "was consumed")}


def _burn_write_approval(approval_record, op_id) -> None:
    """Persist the signed write approval under the final op_id, then mark
    it single-use (W4 approval ordering).

    Called only after EVERY pre-write check has passed (D-010/D-011
    prevalidation, the W4-P0-11 target-identity provider precheck, the
    W4-P1-15 before-state re-read), immediately before the write is
    sent. A refusal on any of those checks therefore leaves the
    approval unconsumed and reusable, the op_id claim released, and
    nothing journaled: the educator's authorization is not spent on a
    write that never happened. Persist-before-consume keeps every
    crash state recoverable: persisted-but-unconsumed re-admits cleanly
    on retry, and consumed implies persisted, so the complete phase
    can always re-verify an admitted write."""
    if approval_record is None:
        return
    path = os.path.join(_approvals_dir(), str(op_id) + ".json")
    preexisting = os.path.exists(path)
    persist_signed_record(approval_record, op_id)
    try:
        consume_approval(approval_record)
    except Exception:
        # The write is not sent: drop the copy this burn persisted
        # under the refused op_id. A record that was on disk before
        # (the file ceremony's signed approval) is the educator's
        # and stays.
        if not preexisting:
            try:
                os.unlink(path)
            except OSError:
                pass
        raise


def _learner_vault_ready(session) -> bool:
    """True on a lane that can de-identify learner receipts: the
    Chromium lane (browser_owned_auth: the projection point in
    dispatch_entry) with the encrypted learner vault (the optional
    'cryptography' package). Anything else fails closed."""
    from privacy import core as _privacy_core
    return bool(getattr(session, "browser_owned_auth", False)) and \
        _privacy_core.AESGCM is not None


def _projected_failure(exc, verification):
    """Re-raise a write-verification failure carrying only the projected
    detail (round-4 privacy audit M2: the raw exception text reached the
    agent through the failure funnel's engineering_detail). Same class,
    same scalar attributes; the raw readback payload is dropped."""
    detail = verification.get("detail") if isinstance(verification, dict) \
        else None
    if not isinstance(detail, str):
        return exc
    if detail.startswith(_UNTRUSTED_PROVIDER_LABEL):
        detail = detail[len(_UNTRUSTED_PROVIDER_LABEL):]
    try:
        new = type(exc)(detail)
    except Exception:
        return exc
    for key, value in vars(exc).items():
        if key != "readback_payload":
            setattr(new, key, value)
    return new


def _journalable_result(projection_entry: dict, result: dict, tenant_base,
                        lane_context=None) -> dict:
    """The result with its receipt projected for a failure journal record.

    The verify-failure paths journal before the success-path projection
    runs; journaling the raw receipt there put learner names and ids in
    the journal (round-4 privacy audit). When the boundary itself refuses
    the receipt, the journal keeps a withheld marker instead."""
    from privacy import executor_wire as _wire
    try:
        return _wire.project_learner_result(
            projection_entry, result, tenant_base,
            lane_context=lane_context, error_cls=ExecutorError)
    except Exception:
        out = dict(result)
        out["receipt"] = {"withheld": "the receipt could not be "
                                      "de-identified, so it is not "
                                      "journaled"}
        return out


def _projection_entry(entry: dict, url, raw_payload) -> dict:
    """The entry view the learner privacy boundary decides on.

    Two corrections over the bare manifest entry: the single request
    carries its RENDERED url (so the boundary sees the real course id,
    not a {course_id} template), and an entry the policy does not flag
    as learner data is still projected when the provider payload itself
    carries learner-shaped records (user/student/author objects, or
    records with identity fields). Labeling those identifiers replaces
    the old outcome for such reads, a refusal of the whole read."""
    from privacy import executor_wire as _wire
    view = dict(entry)
    request = entry.get("request")
    if url and isinstance(request, dict):
        view["request"] = dict(request, url=url.split("?", 1)[0])
    if not admission_touches_learner_data(view) and \
            _wire._harvest_roster(raw_payload):
        view["catalog_learner_data"] = True
    return view


def _check_auxiliary_learner_data(entry: dict, vault_ready: bool) -> None:
    """Run the learner-data gate over the entry's auxiliary blocks
    (discovery, verify, before_state, undo, ...). admit() scans only
    the request and multi_step URLs, so a roster read hidden in a
    discovery pre-pass would otherwise reach a lane with no projection
    point."""
    policy = load_policy()
    for where, block in _entry_request_blocks(entry):
        if where == "request" or where.startswith("multi_step"):
            continue
        if not block.get("url"):
            continue
        check_learner_data({"name": "%s#%s" % (entry.get("name"), where),
                            "request": block}, policy, vault_ready)


def _require_course_resolution(entry: dict, params: dict, mode_ctx) -> None:
    """Mode-gated course writes must carry the course resolution for
    the course they target (fail closed when absent or mismatched).
    The legacy signed-approval path (no user_id) binds the course in
    the approval record instead."""
    if not isinstance(mode_ctx, dict) or not mode_ctx.get("user_id"):
        return
    course_id = _write_target_course_id(entry, params)
    if course_id is None:
        return
    resolution = mode_ctx.get("course_resolution")
    if not isinstance(resolution, dict):
        raise CourseResolutionRequired(
            "write to course %s has no course resolution; the dispatcher "
            "must say how the course was resolved (course_id, confidence, "
            "user_confirmed) so an ambiguous course is never written. "
            "Refusing." % course_id)
    if str(resolution.get("course_id")) != str(course_id):
        raise CourseResolutionRequired(
            "write targets course %s, but the course resolution names "
            "course %r. Refusing." % (course_id, resolution.get("course_id")))


def dispatch_entry(entry: dict, params: dict, session: SessionStore, pack: dict,
                   plan: FrozenPlan = None, op_id: str = None,
                   kind: str = "dispatch", approval: dict = None,
                   catalog_status=None,
                   dry_run=False, require_educator_channel: bool = True,
                   mode_ctx: dict = None) -> dict:
    """Execute one manifest entry; see _dispatch_entry_inner.

    Working by name (round-4 privacy audit H3): learner labels in params
    or the request body ("Student A3", or the echoed "Jane Doe (Student
    A3)") are resolved to real LMS ids after the mode gate, for the
    course the write targets only. While the dispatch runs, every
    journal record is relabeled (_ACTIVE_ID_LABELS); the result and any
    raised error are relabeled before the agent sees them, and labels
    the educator introduced by name in this conversation are echoed as
    "<typed name> (label)" (privacy/name_echo).
    """
    from privacy import executor_wire as _wire
    holder = {}
    token = _ACTIVE_ID_LABELS.set(holder)
    rosters = _wire.begin_course_rosters()
    try:
        out = _dispatch_entry_inner(
            entry, params, session, pack, plan=plan, op_id=op_id, kind=kind,
            approval=approval,
            catalog_status=catalog_status, dry_run=dry_run,
            require_educator_channel=require_educator_channel,
            mode_ctx=mode_ctx, _labels=holder)
    except Exception as exc:
        _relabel_exception(exc, holder.get("map"))
        raise
    finally:
        _wire.end_course_rosters(rosters)
        _ACTIVE_ID_LABELS.reset(token)
    if holder.get("map"):
        out = _wire.relabel_learner_ids(out, holder["map"])
    conversation_id = mode_ctx.get("conversation_id") \
        if isinstance(mode_ctx, dict) else None
    course_id = _write_target_course_id(entry, params)
    if conversation_id and course_id:
        try:
            tenant_base = session.base_for(entry.get("provider") or "canvas")
        except Exception:
            tenant_base = None
        if tenant_base:
            out = _wire.apply_name_echo(out, tenant_base, course_id,
                                        conversation_id)
    return out


def _relabel_exception(exc, mapping):
    """Replace resolved real ids with their labels in an escaping error."""
    if not mapping:
        return
    from privacy import executor_wire as _wire

    def fix(value):
        if isinstance(value, bytes):
            try:
                return _wire.relabel_learner_ids(
                    value.decode("utf-8"), mapping).encode("utf-8")
            except UnicodeDecodeError:
                return value
        if isinstance(value, (str, list, dict, tuple)):
            fixed = _wire.relabel_learner_ids(
                list(value) if isinstance(value, tuple) else value, mapping)
            return tuple(fixed) if isinstance(value, tuple) else fixed
        return value
    try:
        exc.args = tuple(fix(a) for a in exc.args)
        for key, value in list(vars(exc).items()):
            setattr(exc, key, fix(value))
    except Exception:
        pass


# Every enrollment state the course roster read asks for; students
# whose enrollment was deleted come from the enrollments read.
_ROSTER_ENROLLMENT_STATES = ("active", "invited", "rejected", "completed",
                             "inactive")
_ROSTER_MAX_READS = 30
_ROSTER_MAX_BYTES = 8 * 1024 * 1024


def _read_all_pages(session, url):
    """Every item of a Canvas list read through the session, following
    the lane's pagination reports. Raises CourseRosterUnavailable on a
    partial or malformed list: a partial roster must never stand in for
    the whole one."""
    items = []
    seen = set()
    base = session.base_for("canvas")
    while url:
        if url in seen or len(seen) >= _ROSTER_MAX_READS:
            raise CourseRosterUnavailable(
                "the course's student list did not end after %d reads"
                % len(seen))
        seen.add(url)
        _status, headers, raw, _attempts = session.raw_request(
            "GET", url, {"Accept": "application/json"}, None,
            is_write=False, max_bytes=_ROSTER_MAX_BYTES)
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        try:
            page = json.loads(text or "[]")
        except ValueError:
            page = None
        if not isinstance(page, list):
            raise CourseRosterUnavailable(
                "the course's student list was not a list")
        items.extend(page)
        state = _pagination_state(headers)
        if state is None or not state.get("partial"):
            break
        url = state.get("next_page")
        if not url:
            raise CourseRosterUnavailable(
                "the course's student list was cut short (%s)"
                % state.get("note"))
        if url.startswith("/"):
            url = base.rstrip("/") + url
    return items


_COURSE_NUMBER_RE = re.compile(r"[1-9][0-9]*")


def _require_numbered_course(entry, params):
    """Refuse a request whose course is not named by its Canvas number.
    The roster read, the course-content projection, the learner-label
    scope, and the course checks all know a course by its number. A SIS
    form (sis_course_id:BIO101) reaches the same course in Canvas but
    none of them, so the students named in its content would reach the
    agent and the journal unlabeled. A leading zero ("0101") reaches
    course 101 but scopes its labels apart from "101"."""
    course_id = _write_target_course_id(entry, params)
    if course_id is not None and not _COURSE_NUMBER_RE.fullmatch(
            str(course_id)):
        raise InvalidCourseId(
            "the course is given as %r, not as its Canvas course number; "
            "find the course by name (canvas_list_courses) and use the "
            "number in its Canvas address. Nothing was sent."
            % str(course_id)[:80])


def _read_course_roster_first(entry, params, session, tenant_base,
                              dry_run, op_id=None):
    """Read the course's whole student roster before a Chromium-lane
    dispatch reads or changes anything in that course. Course content
    (a page body, an assignment description) can name any student, and
    a name can be labeled only when Morrow knows it
    (privacy/course_content.py); a student gets a label in the vault
    when their name appears in what the agent sees, and without the
    vault the names are hidden one way. The roster is held for this
    dispatch only: never journaled, never shown. Fails closed: when the
    roster cannot be read, nothing in the course is read or changed. It
    is the dispatch's first Canvas call, so a sign-in that died here
    arms the re-sign-in flow as an attach-time death does."""
    if dry_run or not getattr(session, "browser_owned_auth", False):
        return
    if entry.get("effects") == "write":
        # A write the halt refuses must reach Canvas not at all; the
        # write gates refuse it right after this.
        from reauth import state_machine as _rsm
        if not _rsm.check_write_allowed()[0]:
            return
    # The course the request path names, or for an Item Bank route the
    # course its launch is bound to (params.course_id).
    course_id = _write_target_course_id(entry, params)
    if course_id is None:
        return
    _require_numbered_course(entry, params)
    from privacy import executor_wire as _wire
    base = session.base_for("canvas").rstrip("/")
    users_url = "%s/api/v1/courses/%s/users?%s" % (
        base, course_id, urllib.parse.urlencode(
            [("enrollment_type[]", "student")]
            + [("enrollment_state[]", s) for s in _ROSTER_ENROLLMENT_STATES]
            + [("include[]", "email"), ("per_page", "100")]))
    deleted_url = "%s/api/v1/courses/%s/enrollments?%s" % (
        base, course_id, urllib.parse.urlencode(
            [("type[]", "StudentEnrollment"), ("state[]", "deleted"),
             ("per_page", "100")]))
    try:
        identities = _wire.roster_identities(
            _read_all_pages(session, users_url),
            _read_all_pages(session, deleted_url))
        _wire.remember_course_roster(tenant_base, course_id, identities)
    except (ProviderHttpError, CourseRosterUnavailable, ValueError,
            TypeError) as exc:
        if isinstance(exc, ProviderHttpError) and exc.status in (401, 403,
                                                                 404):
            # Canvas's answer for the course itself: no such course for
            # this account (the number is wrong), or not allowed to open
            # it. Trying again cannot help, so the educator hears which.
            refused = ProviderHttpError(
                exc.status, "the student list of course %s" % course_id,
                body=exc.body)
            refused.provider = "canvas"
            refused.operation_kind = "read"
            raise refused from None
        detail = exc.status if isinstance(exc, ProviderHttpError) \
            else type(exc).__name__
        raise CourseRosterUnavailable(
            "The student list of course %s could not be read (%s), so "
            "nothing in the course was read or changed: without it, "
            "Morrow cannot hide student names in course content. Nothing "
            "was sent." % (course_id, detail)) from None
    except Exception as exc:
        if _is_session_dead(exc):
            _on_session_death(op_id, entry.get("name"),
                              "session dead while reading the course "
                              "roster: %s" % str(exc)[:200])
        raise


def _resolve_dispatch_labels(entry, params, tenant_base, mode_ctx):
    """(entry, params, {real id: label}, {label: vault token}) with
    learner labels resolved for the course this dispatch targets: to
    real ids in learner-id positions, and to the student's real text in
    free text (privacy/course_content.py). No labels: inputs
    unchanged."""
    from privacy import executor_wire as _wire
    course_id = _write_target_course_id(entry, params)
    conversation_id = mode_ctx.get("conversation_id") \
        if isinstance(mode_ctx, dict) else None
    tokens = {}
    resolved, mapping = _wire.resolve_learner_labels(
        {"entry": entry, "params": params}, tenant_base, course_id,
        conversation_id, error_cls=LearnerLabelUnresolved,
        provider=entry.get("provider"),
        extra_keys=_wire.learner_route_param_keys(entry), tokens_out=tokens)
    if not mapping and not tokens:
        return entry, params, {}, {}
    if not course_id:
        raise LearnerLabelUnresolved(
            "this dispatch names a student by label but targets no course; "
            "labels belong to one course. Nothing was sent.")
    return resolved["entry"], resolved["params"], mapping, tokens


def _dispatch_entry_inner(entry: dict, params: dict, session: SessionStore,
                          pack: dict, plan: FrozenPlan = None,
                          op_id: str = None, kind: str = "dispatch",
                          approval: dict = None,
                          catalog_status=None, dry_run=False,
                          require_educator_channel: bool = True,
                          mode_ctx: dict = None,
                          _labels: dict = None) -> dict:
    """Execute one manifest entry through the full pipeline and journal it.

    catalog_status is the catalog status row of a catalog-dispatched op
    (None for manifest entries). It is journaled with the op.

    dry_run=True (W4-P2-26): evaluate every gate and render the exact
    write request that would be sent, without sending anything and
    without journaling anything: no op_id claim, no approval
    persistence/consumption, no provider calls of any kind, no journal
    record. Gates that need provider reads (target-identity GET,
    before-state re-read) are reported as skipped. Returns the dry-run
    report dict instead of a dispatch result.

    mode_ctx (optional) routes the write-authority step through the
    Plan/Edit mode gate instead of the legacy per-write approval path:
        {"user_id": "<id>", "conversation_id": "<id>",
         "course_resolution": {"course_id": ..., "confidence": 0-1,
                               "user_confirmed": bool, ...},
         "destructive_confirmed": "<verbatim educator yes>"}
    The CLI fills user_id from --user-id, MORROW_USER_ID, or the Canvas
    account pinned at first sign-in, and conversation_id from the
    agent's --conversation-id; without user_id the gate fails closed to
    the legacy plan-mode approval path. See modes/README.md for the
    integrator contract.
    """
    # W4-P0-10: derive the effect class from the entry's blocks before
    # anything trusts the manifest's "effects" field.
    _derived, declared = enforce_effect_class(entry)
    entry_name = entry.get("name")
    effects = declared
    is_write = effects == "write"
    for _key in _READ_ONLY_BLOCK_KEYS:
        _aux = entry.get(_key)
        if isinstance(_aux, dict) and _aux.get("url"):
            _assert_read_only_block(entry, _aux, _key)
    live_proven_gate(entry, journal=not dry_run)
    _require_numbered_course(entry, params)
    if is_write:
        _require_course_resolution(entry, params, mode_ctx)

    # Admission gate: never-dispatch, unsupported, tenant-restricted,
    # learner-data, and per-action write approval. Runs before anything else.
    provider = entry.get("provider")
    try:
        tenant_base = session.base_for(provider or "canvas")
    except Exception:
        tenant_base = None
    if tenant_base and getattr(session, "browser_owned_auth", False):
        # W4-P1-14: admission-level tenant binding. The approval is
        # digest-bound to the session's tenant, which is self-consistent
        # by construction; this check binds the session's tenant to the
        # helper's configured tenant (the tenant the browser is actually
        # signed into) and refuses loudly when they differ, so a
        # globally-wrong tenant cannot sail through.
        _chromium_session_mod().verify_helper_tenant_binding(tenant_base)
    _check_auxiliary_learner_data(entry, _learner_vault_ready(session))
    if is_write and not dry_run:
        # Before the mode gate and the approval: publishing a New Quiz is
        # refused whatever was approved.
        _refuse_new_quiz_publish(entry, params, session, pack)
    approval_audit, approval_record = admit(
        entry, params, tenant_base=tenant_base, approval=approval, op_id=op_id,
        require_educator_channel=require_educator_channel,
        mode_ctx=mode_ctx, journal=not dry_run,
        # The Chromium lane (browser_owned_auth) has the projection point:
        # learner receipts are de-identified through the ported
        # SourceMcpPrivacyBoundary in dispatch_entry's success path
        # (privacy/executor_wire.py). The raw lane has no projection
        # point, and no lane can project without the encrypted vault
        # ('cryptography'), so those keep refusing learner-bearing entries.
        vault_ready=_learner_vault_ready(session))
    # Course content can name any student: read the course roster (and
    # refuse the course when it cannot be read) before anything in the
    # course is read, changed, or restored from labels.
    _read_course_roster_first(entry, params, session, tenant_base, dry_run,
                              op_id)
    # Working by name: resolve learner labels to real ids AFTER the mode
    # gate and BEFORE the write gates claim the op (a refusal here leaves
    # nothing claimed). The gates and every journal record keep the
    # label params; provider calls get the resolved ones.
    wire_entry, wire_params, id_labels, label_tokens = \
        _resolve_dispatch_labels(entry, params, tenant_base, mode_ctx)
    # Learner-data decision 2026-09-20: the raw lane passes no vault_ready,
    # so learner-bearing entries are refused here (LearnerDataGated) rather
    # than projected. Projection runs in dispatch_entry's success path
    # through the shared privacy/executor_wire.project_learner_result
    # (the same implementation the browser lane delegates to); the raw
    # lane returns provider JSON directly and has no projection point.

    # Write gating: halt file, frozen plan, duplicate op id, concurrency.
    # (Shared with the browser lane; see _check_write_gates.) The guard
    # atomically claims the op_id under the journal lock: from here on a
    # crash leaves a WAL pending record, never silence (W2-P0-2), and a
    # concurrent dispatch of the same op_id raises DuplicateOpId (W2-P0-18).
    # dry_run=True evaluates the gates without claiming anything.
    # Plan/Edit modes: when the mode gate authorized this write in edit
    # mode, the frozen plan (the plan-mode approval ceremony's artifact)
    # is not required. The audit's "mode" key is set only by
    # check_mode_authority, so this cannot trigger on the legacy path.
    mode_edit_write = (is_write and isinstance(approval_audit, dict)
                       and approval_audit.get("mode") == "edit")
    op_id, claim_token = _check_write_gates(entry, params, plan, op_id, kind,
                                            dry_run=dry_run,
                                            plan_not_required=mode_edit_write,
                                            learner_tokens=label_tokens)
    journal_params = params
    if id_labels and isinstance(_labels, dict):
        _labels["map"] = id_labels
    if dry_run:
        # The report goes to the agent: the request as the agent wrote
        # it, with labels, never the students' real text or ids.
        report = _render_dry_run(entry, params, session, pack, plan, op_id,
                                 approval_audit, tenant_base, _derived,
                                 declared)
        if wire_entry is not entry or wire_params is not params:
            report["note"] += (
                ". Student labels are shown as written; Morrow puts back "
                "each student's real text only when it sends the change")
        return report
    entry, params = wire_entry, wire_params
    # Post-claim, pre-provider: every step from here to the provider
    # call runs before any provider call, so any failure proves
    # nothing applied. The claim is released (op_id reusable) instead
    # of leaking a pending claim that would block a corrected retry
    # as a duplicate. A crash, KeyboardInterrupt, or SystemExit skips
    # the release on purpose: the WAL pending record stays for
    # reconciliation (W2-P0-2).
    #
    # W4-P0-11 / W4-P1-15 evidence for the journal: bound here so the
    # failure journal paths below can carry them too.
    target_identity_verified = None
    before_state_check = None
    try:
        # W5-P2-1: shutdown requested between claim and any provider
        # call: release the claim (nothing could have applied) and stop
        # before burning approvals or touching the provider.
        _raise_if_shutdown_requested(op_id, claim_token)

        if provider == "morrow" or (entry.get("request") or {}).get("method") == "LOCAL":
            raise LocalProcedureRefused(
                "entry %r is a VM-local governance procedure; the network executor does not run it" % entry_name)

        config = {"canvas_base": session.base_for("canvas")}

        # Item Banks SDK lane: bind the course scope for the LTI launch from
        # params.course_id. Only ChromiumSession implements set_sdk_course;
        # every other session ignores it. A missing course_id fails closed
        # inside the SDK lane at call time.
        _sdk_course_setter = getattr(session, "set_sdk_course", None)
        if callable(_sdk_course_setter):
            _sdk_course_setter(params.get("course_id")
                               if isinstance(params, dict) else None)

        transients = {}
        # Response bound for this entry (W2-P2-8): the transport stops reading
        # at max_bytes + 1 so large provider responses are bounded before
        # being fully held in memory.
        entry_max_bytes = int((entry.get("result") or {}).get("max_bytes",
                                                              DEFAULT_MAX_BYTES))
        if entry.get("discovery"):
            transients = run_discovery(entry, session, pack, config, params, transients,
                                     max_bytes=entry_max_bytes)

        block = entry.get("request")

        method = url = None
    except Exception as exc:
        try:
            release_op_id(op_id, claim_token,
                          "post-claim pre-provider failure: %s"
                          % type(exc).__name__)
        except DuplicateOpId:
            pass
        raise
    method = url = None
    # Tracks whether a write provider call was actually invoked, so the
    # failure classifier below can tell "nothing could have applied"
    # (release the claim, op_id reusable) from "ambiguous" (journal it).
    attempt_state = {"write_attempted": False}
    pagination = None
    try:
        if entry.get("multi_step"):
            if is_write:
                # W4-P0-11(2) + W4-P1-15, post-claim, pre-write: both are
                # reads (is_write=False), so a refusal releases the claim
                # and the op_id stays reusable; nothing could have applied
                # yet. Per-step D-010/D-011 prevalidation runs inside
                # run_multi_step, before each step's network call.
                target_identity_verified = verify_write_target_identity(
                    entry, params, plan, session, pack, config,
                    max_bytes=entry_max_bytes,
                    approval_target=(approval_record or {}).get("target"),
                    # Edit-mode writes carry no approval record: the
                    # provider-identity check still runs, the
                    # approval-ceremony cross-checks are skipped.
                    no_approval_target_ok=mode_edit_write)
                before_state_check = recompute_before_state(
                    entry, params, plan, session, pack, config, transients,
                    max_bytes=entry_max_bytes)
                # W4 approval ordering: prevalidate every step's request
                # (local checks only) before the approval burns, so a
                # malformed step refuses while the approval is still
                # reusable. Steps depending on a prior step's result are
                # validated at execution time.
                _prevalidate_multi_step_requests(
                    entry, params, session, pack, config, transients)
                # W4 approval ordering: every pre-write check passed; burn
                # the approval now, immediately before the write is sent.
                _burn_write_approval(approval_record, op_id)
            result, transients = run_multi_step(
                entry, session, pack, config, params, transients,
                max_bytes=entry_max_bytes, attempt_state=attempt_state)
            attempts = result.get("attempts", 1)
        elif block:
            method, url, headers, body_bytes = build_request(
                entry, block, params, session, pack, config, transients)
            resolved_body = resolved_request_body(block, params, transients)
            if is_write:
                # D-010: refuse malformed writes before any network call.
                prevalidate_write_request(entry, method, url, resolved_body)
                # D-011: refuse a page PUT when the target page is missing.
                page_put_precheck(session, entry, pack, config, params,
                                  transients, method, url,
                                  max_bytes=entry_max_bytes)
                # W4-P0-11(2) + W4-P1-15, post-claim, pre-write: both are
                # reads (is_write=False), so a refusal releases the claim
                # and the op_id stays reusable; nothing could have applied
                # yet. They run after the D-010/D-011 prevalidation so a
                # locally-refused request never spends a provider call.
                target_identity_verified = verify_write_target_identity(
                    entry, params, plan, session, pack, config,
                    max_bytes=entry_max_bytes,
                    approval_target=(approval_record or {}).get("target"),
                    # Edit-mode writes carry no approval record: the
                    # provider-identity check still runs, the
                    # approval-ceremony cross-checks are skipped.
                    no_approval_target_ok=mode_edit_write)
                before_state_check = recompute_before_state(
                    entry, params, plan, session, pack, config, transients,
                    max_bytes=entry_max_bytes)
                # W4 approval ordering: every pre-write check passed; burn
                # the approval now, immediately before the write is sent.
                _burn_write_approval(approval_record, op_id)
                attempt_state["write_attempted"] = True
            status, resp_headers, raw, attempts = session.raw_request(
                method, url, headers, body_bytes, is_write=is_write,
                max_bytes=entry_max_bytes)
            pagination = _pagination_state(resp_headers)
            result = apply_result_block(entry, raw, resp_headers)
        else:
            raise UnsupportedEntry("entry %r has neither request nor multi_step" % entry_name)
    except UncertainWrite as exc:
        # The effect may or may not have applied; never retry blind, but the
        # op MUST be journaled as uncertain so reconciliation can find it.
        # W2-P1-5: the journal carries per-step evidence (which step
        # landed), not a generic receipt.
        steps = list(exc.evidence or [])
        if not steps:
            steps = [{"method": method, "url": _redacted_url(url),
                      "status": "uncertain",
                      "attempts": exc.attempts if exc.attempts is not None
                      else 0}]
        uncertain_result = {"payload": {"uncertain": True},
                            "receipt": {"uncertain": True,
                                        "detail": _provider_detail(exc, 500),
                                        "attempts": exc.attempts,
                                        "steps": steps},
                            "truncated": False, "bytes_received": 0}
        verification = {"status": "uncertain", "detail": _provider_detail(exc)}
        record = _journal_record(entry_name, kind, effects, journal_params, plan,
                                 op_id, None, verification,
                                 uncertain_result, exc.attempts or 0,
                                 uncertain=True,
                                 approval_audit=approval_audit,
                                 catalog_status=catalog_status,
                                 target=target_identity_verified,
                                 before_state=before_state_check,
                                 undo_available=bool(entry.get("undo")))
        journal_append(record)
        # W4-P2-1: a mid-write session death keeps the uncertain journal
        # AND runs the re-auth machinery (halt + quarantine + notify)
        # before raising, so the run stops instead of writing through a
        # half-dead session.
        if _uncertain_write_from_session_death(exc):
            _on_session_death(op_id, entry_name,
                              "SessionDead mid-write; the write may have "
                              "executed before the session died; uncertain "
                              "journal preserved", write_sent=True)
        # W5-P2-1: the uncertain outcome is journaled (drained); a
        # pending shutdown now stops the run instead of continuing.
        _raise_if_shutdown_requested()
        raise
    except WriteFieldMismatch as exc:
        # A multi-step write step proved silent-write corruption on
        # readback. The effect is certain, the fields are wrong; journal
        # the failure with the evidence and re-raise, never report success.
        # W3-P2-5: the mismatch detail formats raw readback values with
        # %r, which can be learner names or identifiers; project it
        # through the learner boundary before it is journaled, same as
        # the declared-verify path below.
        failed_result = {"payload": {"readback_mismatch": True},
                         "receipt": {"detail": _provider_detail(exc, 500)},
                         "truncated": False, "bytes_received": 0}
        verification = {"status": "fail", "detail": _provider_detail(exc)}
        verification = _project_verification_detail(
            _projection_entry(entry, url, getattr(exc, "readback_payload", None)),
            verification, getattr(exc, "readback_payload", None),
            tenant_base, entry_name)
        record = _journal_record(entry_name, kind, effects, journal_params, plan,
                                 op_id, None, verification,
                                 failed_result, 0, uncertain=False,
                                 approval_audit=approval_audit,
                                 catalog_status=catalog_status,
                                 target=target_identity_verified,
                                 before_state=before_state_check,
                                 undo_available=bool(entry.get("undo")))
        journal_append(record)
        # W5-P2-1: the failure outcome is journaled (drained); a pending
        # shutdown now stops the run instead of continuing.
        _raise_if_shutdown_requested()
        raise _projected_failure(exc, verification) from None
    except ExecutorError as exc:
        # Request-phase failure classification (W2-P0-4: an ambiguous write
        # must never escape unjournaled with a reusable op_id).
        if _is_stale_command(exc):
            # W4-P2-1: stale command, not session death. The lane
            # re-authenticated since dispatch, so the command was refused
            # before any provider call; the session is fresh. Release the
            # claim (op_id stays reusable) and re-raise WITHOUT arming the
            # re-auth machinery: no halt, no quarantine, no "re-sign in"
            # notification. The educator just signed in; the remedy is to
            # re-dispatch the op against the fresh session.
            try:
                release_op_id(op_id, claim_token,
                              "request-phase stale command refused before "
                              "any provider call: %s" % type(exc).__name__)
            except DuplicateOpId:
                pass
            # W5-P2-1: claim released; a pending shutdown stops here.
            _raise_if_shutdown_requested()
            raise
        if _is_session_dead(exc) or not is_write or not attempt_state.get(
                "write_attempted") or isinstance(
                exc, (WritePrevalidationFailed, ProviderHttpError,
                      WriteNotAttempted)):
            # Provably nothing applied: the session died before any
            # provider call, the failure is pre-network, it is a read, or
            # it is a fail-fast / pre-send refusal. Release the claim
            # (journaled) so the op_id stays reusable, then re-raise.
            if isinstance(exc, ProviderHttpError):
                # For the failure translator: which provider refused,
                # and whether it refused a write (nothing was saved).
                exc.provider = entry.get("provider") or "canvas"
                exc.operation_kind = "write" if is_write else "read"
            try:
                release_op_id(op_id, claim_token,
                              "request-phase failure before any effect "
                              "could apply: %s" % type(exc).__name__)
            except DuplicateOpId:
                pass
            if _is_session_dead(exc):
                # W4-P2-1: attach/probe-time death. The claim is released
                # (op_id stays reusable, as designed) but the halt is
                # armed and the op metadata quarantined so the run stops
                # and recovery needs explicit re-approval.
                _on_session_death(op_id, entry_name,
                                  "session dead at attach/probe time: %s"
                                  % str(exc)[:200])
            # W5-P2-1: claim released; a pending shutdown stops here.
            _raise_if_shutdown_requested()
            raise
        # A write provider call was invoked and the failure is not
        # fail-fast: ambiguous. Journal an audit record under a FRESH
        # event id (never the op_id, so the id is not consumed by a mere
        # refusal) with the evidence, keep the claim (the op_id stays
        # reserved for reconciliation), and re-raise.
        _journal_write_failure_audit(
            entry_name, kind, effects, journal_params, plan, op_id, exc,
            attempt_state, approval_audit, catalog_status)
        # W5-P2-1: the audit record is journaled (drained); a pending
        # shutdown now stops the run instead of continuing.
        _raise_if_shutdown_requested()
        raise
    except Exception as exc:
        # Not an ExecutorError: an admission refusal while the approval
        # burns (a concurrent dispatch consumed it first, or it could
        # not be persisted), an OSError, a bug. Before a write provider
        # call nothing could have applied: release the claim so the
        # op_id stays reusable. After one, the claim stays pending for
        # reconciliation, like a crash. KeyboardInterrupt and SystemExit
        # are not Exceptions and keep the crash semantics.
        if not is_write or not attempt_state.get("write_attempted"):
            try:
                release_op_id(op_id, claim_token,
                              "request-phase failure before any effect "
                              "could apply: %s" % type(exc).__name__)
            except DuplicateOpId:
                pass
            _raise_if_shutdown_requested()
        raise

    # Verify phase for writes: the D-009 silent-write readback runs first
    # (fresh GET of the written object, compared field by field against the
    # requested intent), then the entry's declared verify block when it has
    # one. A proven readback mismatch is a hard failed write, journaled
    # with the mismatched fields named; a readback GET failure keeps the
    # op uncertain, never failed.
    verification = {"status": "skipped", "detail": "read effect; no verify block run"}
    projection_entry = _projection_entry(entry, url, result.get("payload"))
    if is_write:
        try:
            if entry.get("multi_step"):
                readback = _combine_step_readbacks(
                    result.get("step_readbacks") or [])
            else:
                readback = run_write_readback(
                    entry, session, pack, config, params, transients,
                    method, url, resolved_body, result["payload"],
                    max_bytes=entry_max_bytes)
            verification = readback
            if entry.get("verify"):
                declared = run_verify(entry, session, pack, config, params,
                                      result["payload"], transients,
                                      max_bytes=entry_max_bytes)
                # A declared verify block with at least one expect
                # assertion is itself a provider readback that held.
                declared_proves = bool((entry["verify"] or {}).get("expect")) \
                    and declared.get("status") == "pass"
                verification = {
                    "status": ("pass" if readback.get("status") == "pass"
                               or declared_proves else "unverified"),
                    "detail": "write readback: %s; verify block: %s"
                              % (readback.get("detail"), declared.get("detail")),
                }
        except WriteFieldMismatch as exc:
            # Proven silent-write corruption (D-009): the provider applied
            # an effect, but not the requested one. The effect is certain
            # (uncertain=False), the fields are wrong; journal the failure
            # and never report success.
            verification = {"status": "fail", "detail": _provider_detail(exc)}
            # W3-P2-5: the mismatch detail formats raw readback values with
            # %r; project it through the learner boundary before it is
            # journaled, same as the success path below.
            verification = _project_verification_detail(
                projection_entry, verification, result.get("payload"), tenant_base,
                entry_name)
            after_digest = digest_of(result["receipt"])
            record = _journal_record(entry_name, kind, effects, journal_params, plan,
                                     op_id, after_digest, verification,
                                     _journalable_result(
                                         projection_entry, result,
                                         tenant_base),
                                     attempts, uncertain=False,
                                                                  approval_audit=approval_audit,
                                                                  catalog_status=catalog_status,
                                                                  target=target_identity_verified,
                                                                  before_state=before_state_check,
                                                                  undo_available=bool(entry.get("undo")))
            journal_append(record)
            # W5-P2-1: the failure outcome is journaled (drained); a
            # pending shutdown now stops the run instead of continuing.
            _raise_if_shutdown_requested()
            raise _projected_failure(exc, verification) from None
        except UncertainWrite as exc:
            # The write returned 2xx but its readback GET failed: the
            # effect is unconfirmed, not failed. Journal it as uncertain
            # (reconcile by readback, never blind-retry) and surface an
            # UncertainWrite so the failure catalog classifies it.
            verification = {"status": "uncertain",
                            "detail": _provider_detail(exc)}
            verification = _project_verification_detail(
                projection_entry, verification, result.get("payload"),
                tenant_base, entry_name)
            after_digest = digest_of(result["receipt"])
            record = _journal_record(entry_name, kind, effects, journal_params, plan,
                                     op_id, after_digest, verification,
                                     _journalable_result(
                                         projection_entry, result,
                                         tenant_base),
                                     attempts, uncertain=True,
                                     approval_audit=approval_audit,
                                     catalog_status=catalog_status,
                                     target=target_identity_verified,
                                     before_state=before_state_check,
                                     undo_available=bool(entry.get("undo")))
            journal_append(record)
            if (_is_session_dead(exc)
                    or _uncertain_write_from_session_death(exc)):
                _on_session_death(op_id, entry_name,
                                  "session dead during write readback: %s"
                                  % type(exc).__name__, write_sent=True)
            _raise_if_shutdown_requested()
            raise UncertainWrite(
                "write op %s returned success, but the readback could not "
                "confirm it: %s (journaled as uncertain, not failed)"
                % (op_id, _projected_failure(exc, verification)),
                evidence=exc.evidence, attempts=exc.attempts) from None
        except (VerificationFailed, UncertainWrite, ExecutorError) as exc:
            # Only a proven verify mismatch is a failed write. Anything
            # else here (a dead session, a stale command, another lane
            # error) left the write's effect unconfirmed: uncertain.
            proven = isinstance(exc, VerificationFailed)
            verification = {"status": "fail" if proven else "uncertain",
                            "detail": _provider_detail(exc)}
            # W3-P2-5: the failure detail can carry raw readback values;
            # project it through the learner boundary before journaling.
            verification = _project_verification_detail(
                projection_entry, verification, result.get("payload"), tenant_base,
                entry_name)
            after_digest = digest_of(result["receipt"])
            record = _journal_record(entry_name, kind, effects, journal_params, plan,
                                     op_id, after_digest, verification,
                                     _journalable_result(
                                         projection_entry, result,
                                         tenant_base),
                                     attempts, uncertain=not proven,
                                     approval_audit=approval_audit,
                                     catalog_status=catalog_status,
                                     target=target_identity_verified,
                                     before_state=before_state_check,
                                     undo_available=bool(entry.get("undo")))
            journal_append(record)
            # W4-P2-1: a dead session during the verify readback arms the
            # re-auth machinery (halt + quarantine + notify) before
            # raising, same as the request-phase paths.
            if (_is_session_dead(exc)
                    or _uncertain_write_from_session_death(exc)):
                _on_session_death(op_id, entry_name,
                                  "session dead during verify readback: %s"
                                  % type(exc).__name__, write_sent=True)
            elif _is_stale_command(exc):
                # W4-P2-1: stale verify command, not session death. The
                # write already returned 2xx (request phase journaled);
                # the lane re-authenticated before verify ran. Quarantine
                # the op for explicit re-approval, but no halt and no
                # "re-sign in" notification: the session is fresh.
                _on_stale_verify(op_id, entry_name,
                                 "stale verify command after lane "
                                 "re-authentication: %s" % type(exc).__name__)
            # W5-P2-1: the outcome is journaled (drained); a pending
            # shutdown now stops the run instead of continuing.
            _raise_if_shutdown_requested()
            if proven:
                raise VerificationFailed(
                    "verify block failed for op %s: %s (journaled as failed)"
                    % (op_id, _projected_failure(exc, verification))) \
                    from None
            raise UncertainWrite(
                "write op %s returned success, but the readback could not "
                "confirm it: %s (journaled as uncertain, not failed)"
                % (op_id, _projected_failure(exc, verification)),
                evidence=getattr(exc, "evidence", None),
                attempts=getattr(exc, "attempts", None)) from None

    # Learner-data privacy boundary: project the receipt through the
    # ported SourceMcpPrivacyBoundary before it is journaled or
    # returned, so no raw learner PII is ever agent-visible or
    # journal-visible. The raw lane refuses learner entries earlier
    # (LearnerDataGated); this projection is the browser/Chromium lane's.
    # Shared implementation: privacy/executor_wire.py.
    #
    # W3-P2-5: the success-path verification detail (a write readback
    # mismatch narrative, or a declared-verify detail) formats raw
    # provider values with %r. Project it first, with the same gate and
    # the same raw-payload roster the receipt projection uses, so the
    # journal never carries learner names or identifiers in
    # verification_detail.
    verification = _project_verification_detail(
        projection_entry, verification, result.get("payload"), tenant_base,
        entry_name)
    try:
        from privacy import executor_wire as _wire
        result = _wire.project_learner_result(
            projection_entry, result, tenant_base, error_cls=ExecutorError)
    except ExecutorError:
        raise
    except Exception as exc:
        raise ExecutorError(
            "learner privacy boundary failed for entry %r: %s"
            % (entry_name, exc))

    after_digest = digest_of(result["receipt"])
    record = _journal_record(entry_name, kind, effects, journal_params, plan, op_id,
                             after_digest, verification, result, attempts,
                                                          approval_audit=approval_audit,
                                                          catalog_status=catalog_status,
                                                          pagination=(
                                                              {"note": pagination.get("note"),
                                                               "partial": pagination.get("partial")}
                                                              if pagination else None),
                                                          target=target_identity_verified,
                                                          undo_available=bool(entry.get("undo")),
                                                          before_state=before_state_check)
    journal_append(record)
    # W5-P2-1: the outcome is journaled (drained); a pending shutdown
    # stops the run here instead of reporting success to a dying caller.
    _raise_if_shutdown_requested()
    truncation = None
    if pagination and pagination.get("partial"):
        truncation = {"note": pagination.get("note"),
                      "next_page": pagination.get("next_page")}
    if result.get("truncated"):
        byte_note = ("response exceeded %s bytes; only part of it is "
                     "returned" % entry_max_bytes)
        truncation = truncation or {"note": None, "next_page": None}
        truncation["note"] = "; ".join(
            n for n in (truncation.get("note"), byte_note) if n)
    if is_write:
        outcome = ("verified" if verification.get("status") == "pass"
                   else "unverified")
    else:
        outcome = "read"
    return {
        "op_id": op_id,
        "entry_name": entry_name,
        # Writes: "verified" (the provider readback confirmed the
        # requested state) or "unverified" (the provider answered
        # success but nothing confirmed it). A proven failed or
        # uncertain write raises instead of returning.
        "outcome": outcome,
        "verified": outcome == "verified",
        "verification": dict(verification),
        "receipt": result["receipt"],
        "truncated": truncation is not None,
        "truncation": truncation,
        "bytes_received": result["bytes_received"],
        "attempts": attempts,
        # W6-P1-H1: the receipt half of the undoability promise (the
        # journal record carries the same field).
        "undo_available": bool(entry.get("undo")),
    }


def _pagination_state(resp_headers):
    """Pagination evidence from a provider response, or None.

    The Chromium lane follows Link rel="next" and reports through
    x-morrow-pagination (note), x-morrow-pagination-partial ("true" when
    the collection is incomplete), and x-morrow-next-page (the next
    page's path). A lane that does not follow pagination leaves a raw
    Link rel="next": the collection is then partial by definition."""
    headers = {str(k).lower(): v for k, v in (resp_headers or {}).items()}
    note = headers.get("x-morrow-pagination")
    partial = str(headers.get("x-morrow-pagination-partial") or "").lower() \
        == "true"
    next_page = headers.get("x-morrow-next-page")
    if not note:
        link_next = _link_next_url(headers.get("link"))
        if link_next:
            return {"note": "more pages remain; only the first page was "
                            "read", "partial": True, "next_page": link_next}
        return None
    if not partial and not str(note).startswith("complete"):
        partial = True
    return {"note": note, "partial": partial, "next_page": next_page}


def _link_next_url(link_header):
    for part in str(link_header or "").split(","):
        segments = part.split(";")
        rels = [seg.strip().lower().replace('"', "").replace("'", "")
                for seg in segments[1:]]
        if "rel=next" in rels:
            match = re.match(r"\s*<([^>]+)>", segments[0])
            if match:
                return match.group(1)
    return None


def _journal_record(entry_name, kind, effects, params, plan, op_id,
                    after_digest, verification, result, attempts, uncertain=False,
                    approval_audit=None,
                    catalog_status=None, pagination=None,
                    target=None, before_state=None, undo_available=None):
    """Canonical journal record for dispatch/undo completion.

    wal="complete" marks a full record: it may only follow a prior
    wal="pending" claim for the same op_id (W2-P0-2). verification_detail
    and the receipt are redacted for embedded secrets (W2-P2-2:
    exception strings can carry URLs with tokens). pagination carries
    the truncated-collection notice when provider Link pagination was
    cut off at the page bound (W2-P1-6).
    """
    record = {
        "op_id": op_id,
        "entry_name": entry_name,
        "kind": kind,
        "effect": effects,
        "wal": "complete",
        "params_digest": digest_of(params),
        "plan_digest": plan.digest if plan else None,
        "before_state_digest": plan.before_state_digest if plan else None,
        "after_state_digest": after_digest,
        "verification": verification["status"],
        "verification_detail": redact_payload(
            verification.get("detail"), DEFAULT_REDACT_PATTERNS),
        "receipt": redact_payload(result["receipt"], DEFAULT_REDACT_PATTERNS),
        "truncated": result["truncated"],
        "bytes_received": result["bytes_received"],
        "attempts": attempts,
        "uncertain": uncertain,
        # Approval provenance for every admitted write (None for reads):
        # op_digest, channel, provenance, verbatim authorization citation.
        "approval": approval_audit,
        # F-2 catalog provenance: the catalog status row of the dispatched
        # op (None for manifest entries).
        "catalog_status": catalog_status,
        # W4-P0-11: the provider-verified write target identity
        # (course_id, course_name, term, tenant), None for reads and
        # non-course writes.
        "target": target,
        # W4-P1-15: the before-state freshness outcome (verified /
        # unverifiable / unsupported / absent, with detail). A digest
        # that implies a guard always says here whether the guard ran.
        "before_state": before_state,
        # W6-P1-H1: per-change undoability disclosure (consent.md: this
        # version cannot undo a change automatically). The
        # pre-dispatch half of the promise is the approval display
        # (dispatch/approval_display.py renders the Undo line); this is
        # the receipt half, journaled with every completion.
        "undo_available": undo_available,
    }
    if pagination:
        record["pagination"] = pagination
    return record


def _journal_write_failure_audit(entry_name, kind, effects, params, plan,
                                 op_id, exc, attempt_state,
                                 approval_audit, catalog_status):
    """Journal an ambiguous write failure (W2-P0-4) under a fresh event id.

    A write provider call was invoked and the failure is neither
    fail-fast nor provably pre-send: the effect may have applied. The
    record carries wal="audit" (never "complete"): it is side evidence,
    not the op's outcome, so find_journal_op keeps reporting "no
    outcome journaled" and the op stays visible to pending-ops
    reconciliation. The op_id's WAL claim stays in place, so a retry is
    refused as a duplicate until the operator reconciles the journaled
    evidence against the provider.
    """
    audit_id = "evt-" + uuid.uuid4().hex[:12]
    steps = list(getattr(exc, "evidence", None) or [])
    record = {
        "op_id": op_id,          # the reserved id, still claimed; NOT consumed
        "event_id": audit_id,    # this record's own unique journal id
        "entry_name": entry_name,
        "kind": kind,
        "effect": effects,
        "wal": "audit",
        "params_digest": digest_of(params),
        "plan_digest": plan.digest if plan else None,
        "before_state_digest": plan.before_state_digest if plan else None,
        "after_state_digest": None,
        "verification": "ambiguous",
        "verification_detail": redact_payload(
            "write failure classified ambiguous after a provider call was "
            "invoked (%s); journaled for reconciliation; op_id %s remains "
            "claimed" % (type(exc).__name__, op_id),
            DEFAULT_REDACT_PATTERNS),
        "receipt": redact_payload({
            "uncertain": True,
            "detail": _provider_detail(exc, 500),
            "steps": steps,
        }, DEFAULT_REDACT_PATTERNS),
        "truncated": False,
        "bytes_received": 0,
        "attempts": getattr(exc, "attempts", None) or 0,
        "uncertain": True,
        "approval": approval_audit,
        "catalog_status": catalog_status,
    }
    journal_append(record)


# --------------------------------------------------------------------------
# Generic catalog dispatch (unblocks the generated-catalog operations)
# --------------------------------------------------------------------------

# F-2: the catalog provenance gate. dispatch/executor.py reads the
# authoritative operation catalog directly (no generated side index that
# could go stale) and refuses to synthesize a dispatchable entry for any
# op that is not marked live-proven.
_OPERATION_CATALOG_PATH = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "proof-battery",
    "OPERATION_CATALOG.md"))
_OPERATION_CATALOG_CACHE = None


def _load_operation_catalog():
    """Parse proof-battery/OPERATION_CATALOG.md into {tool_name: descriptor}.

    Standard dispatchable rows are parsed: | C-N | tool | METHOD |
    /path | R/W | mechanism | status | notes |, plus Item Bank rows
    | IB-N | tool | METHOD | /path | R/W | mechanism | status | notes |.
    Sequence rows (NQS-x), summary rows, the Moodle table (different
    shape), and any row missing dispatchable HTTP metadata are ignored;
    a name absent from the result is unknown and the gate refuses it.
    The descriptor retains the row's own R/W column (canonical effect:
    R -> "read", W -> "write") and whether the status column carries the
    [LEARNER-DATA] flag. Parsed once per process.
    """
    global _OPERATION_CATALOG_CACHE
    if _OPERATION_CATALOG_CACHE is not None:
        return _OPERATION_CATALOG_CACHE
    catalog = {}
    try:
        fh = open(_OPERATION_CATALOG_PATH, encoding="utf-8")
    except OSError as exc:
        raise CatalogNotProven(
            "cannot read the authoritative operation catalog at %s (%s); "
            "catalog dispatch is refused while the catalog is unreadable"
            % (_OPERATION_CATALOG_PATH, exc))
    with fh:
        for line in fh:
            fields = [f.strip() for f in line.rstrip("\n").split("|")]
            # W3-P0-6: Canvas rows (C-NNN) and Item Bank rows (IB-NNN)
            # share the same shape. The catalog's own R/W column is the
            # authoritative effect class for the row (R -> read, W ->
            # write); the status column may additionally carry the
            # [LEARNER-DATA] flag. A row without a legible R/W is not
            # dispatchable: it is skipped, so the name is unknown and the
            # provenance gate refuses it.
            if len(fields) < 9 or not re.fullmatch(r"(C|IB)-\d+", fields[1]):
                continue
            tool, method, path = fields[2], fields[3], fields[4]
            if not tool or not method or not path:
                continue
            rw = fields[5].upper()
            if rw not in ("R", "W"):
                continue
            status_field = fields[7]
            status = status_field.split()[0] if status_field else ""
            catalog[tool] = {"id": fields[1], "method": method.upper(),
                             "path": path, "status": status,
                             "effect": "read" if rw == "R" else "write",
                             "effect_rw": rw,
                             "learner_data": "[LEARNER-DATA]"
                             in status_field}
    _OPERATION_CATALOG_CACHE = catalog
    return catalog


def catalog_descriptor_for(name: str):
    """Return the catalog descriptor for a tool name, or None if the name
    is not a dispatchable catalog row."""
    return _load_operation_catalog().get(name)


def _live_row_for(method: str, path_template: str):
    """(tool name, descriptor) of the live-proven row with this method
    and path template (slot names ignored), or None."""
    key = _normalized_catalog_key(method, path_template)
    for row_name, desc in sorted(_load_operation_catalog().items()):
        if desc["status"] == "live-proven" and _normalized_catalog_key(
                desc["method"], desc["path"]) == key:
            return row_name, desc
    return None


def _catalog_name_refusal(name: str, method: str, path_template: str):
    """The refusal for a catalog dispatch whose name and request are not
    one row. When the method and path are a live-proven row, or else the
    name is one, the refusal is CatalogNameMismatch naming that row, so
    the agent runs it again under the right name instead of telling the
    educator the task is untested. Otherwise it is CatalogNotProven."""
    method_u = str(method or "").upper()
    descriptor = catalog_descriptor_for(name)
    if descriptor is None:
        detail = ("operation %r is not a dispatchable row in "
                  "proof-battery/OPERATION_CATALOG.md; only live-proven "
                  "operations run. Refusing." % name)
    else:
        detail = ("operation %r is in the catalog as %s %s, but the "
                  "dispatch asked for %s %s; a proven name cannot be "
                  "paired with arbitrary CLI arguments" % (
                      name, descriptor["method"], descriptor["path"],
                      method_u, path_template))
    row = _live_row_for(method_u, path_template)
    if row is None and descriptor is not None \
            and descriptor["status"] == "live-proven":
        row = (name, descriptor)
    if row is None:
        return CatalogNotProven(detail)
    row_name, row_desc = row
    return CatalogNameMismatch(
        "%s. Nothing was sent. The live-proven row to use is %s: --name "
        "%s --method %s --path '%s'" % (
            detail.rstrip("."), row_desc["id"], row_name,
            row_desc["method"], row_desc["path"]),
        row_name, row_desc["method"], row_desc["path"])


def _journal_catalog_refusal(name, method, path_template, params, status,
                             detail):
    """Journal a catalog-gate refusal under its own event id.

    The refusal gets a fresh UUID, never the caller's op_id, so the
    requested operation id is not accidentally consumed by a refusal.
    Journal failure never masks the refusal itself.
    """
    record = {
        "op_id": str(uuid.uuid4()),
        "kind": "catalog_gate_refusal",
        "entry_name": name,
        "effect": None,
        "method": method,
        "path_template": path_template,
        "params_digest": digest_of(params),
        "catalog_status": status,
        "detail": detail,
    }
    # W6-P2-S1: the refusal itself still raises to the caller, but a
    # lost journal_append used to vanish silently (full disk, torn
    # journal): the one record whose purpose is to prove a dangerous
    # op was refused was the one allowed to disappear quietly. Fail
    # loud on stderr so the missing audit trail is noticed.
    try:
        journal_append(record)
    except Exception as exc:
        print("MORROW WARNING: catalog-gate refusal for %r could not be "
              "journaled (%s); the refusal still stands, but the audit "
              "trail has a gap" % (name, type(exc).__name__),
              file=sys.stderr)


def _catalog_provenance_gate(entry: dict, name: str, method: str,
                             path_template: str, params: dict, session):
    """F-2 catalog provenance gate for catalog dispatch.

    Runs BEFORE any session is loaded or admission runs. Returns the
    catalog status ("live-proven"). Raises on any refusal. Nothing
    overrides a refusal, and no approval changes the answer: admission
    checks the approval later, for writes only.

      - the absolute admission checks (never-dispatch, unsupported,
        evidence-hold, learner-data) raise their own errors;
      - an unknown tool name raises CatalogNotProven;
      - a supplied method/path that does not match the catalog row raises
        CatalogNotProven (a proven name cannot be paired with arbitrary
        CLI arguments);
      - a row that is not marked live-proven (pending, failed,
        unsupported, excluded, or unmarked) raises CatalogNotProven.

    Every refusal is journaled under its own refusal event id.
    """
    policy = load_policy()
    absolute = (
        ("never_dispatch", check_never_dispatch),
        ("unsupported", check_unsupported),
        ("evidence_hold", check_evidence_holds),
        ("learner_data",
         lambda e, p: check_learner_data(
             e, p, vault_ready=_learner_vault_ready(session))),
    )
    for label, check in absolute:
        try:
            check(entry, policy)
        except Exception as exc:  # the checks raise AdmissionRefused
            # subclasses, which are not ExecutorErrors; journal the refusal
            # under its own event id and re-raise unchanged.
            _journal_catalog_refusal(name, method, path_template, params,
                                     label, str(exc))
            raise
    descriptor = catalog_descriptor_for(name)
    if descriptor is None or \
            descriptor["method"] != str(method or "").upper() or \
            descriptor["path"] != path_template:
        refusal = _catalog_name_refusal(name, method, path_template)
        _journal_catalog_refusal(
            name, method, path_template, params,
            "unknown" if descriptor is None else "descriptor_mismatch",
            str(refusal))
        raise refusal
    status = descriptor["status"]
    if status == "live-proven":
        return status
    detail = ("operation %r is marked %r in the catalog; only live-proven "
              "operations run. Refusing." % (name, status or "unmarked"))
    _journal_catalog_refusal(name, method, path_template, params,
                             status or "unmarked", detail)
    raise CatalogNotProven(detail)

_BLOCK_BASE_TOKEN_RE = re.compile(r"^\{[A-Za-z_][A-Za-z0-9_]*\}")
_PATH_SLOT_RE = re.compile(r"\{[^{}]+\}")


def _normalized_catalog_key(method: str, path: str) -> tuple:
    path = _PATH_SLOT_RE.sub("{}", str(path or "")).rstrip("/") or "/"
    return str(method or "GET").upper(), path


def _catalog_rows_by_key() -> dict:
    index = {}
    for descriptor in _load_operation_catalog().values():
        key = _normalized_catalog_key(descriptor["method"],
                                      descriptor["path"])
        index.setdefault(key, []).append(descriptor)
    return index


def _block_catalog_key(block: dict) -> tuple:
    """(METHOD, normalized path template) for one request block. The
    leading {<provider>_base} token and any query/fragment are dropped;
    an absolute literal URL contributes its path."""
    url = str(block.get("url") or "")
    url = url.split("#", 1)[0].split("?", 1)[0]
    stripped = _BLOCK_BASE_TOKEN_RE.sub("", url, count=1)
    if stripped == url and "://" in url:
        stripped = urllib.parse.urlsplit(url).path
    return _normalized_catalog_key(block.get("method") or "GET", stripped)


def live_proven_gate(entry: dict, journal: bool = True) -> None:
    """Refuse unless every request-issuing block of the entry is a
    live-proven row of proof-battery/OPERATION_CATALOG.md.

    Applies to every dispatch path (manifest entries, catalog-synthetic
    entries, undo), not only to dispatch_catalog_op: the catalog is the
    authority on what may run. Blocks are matched by method and path
    template (slot names ignored). There is no exception: unknown and
    non-live-proven operations are never runnable. Readbacks derived by
    the executor itself are not entry blocks and are not gated here.
    Raises CatalogNotProven."""
    index = _catalog_rows_by_key()
    name = entry.get("name")
    for where, block in _entry_request_blocks(entry):
        if isinstance(block.get("browser"), dict) and not block.get("url"):
            continue
        method, path = _block_catalog_key(block)
        rows = index.get((method, path)) or []
        statuses = sorted({row["status"] for row in rows})
        if "live-proven" in statuses:
            continue
        detail = ("entry %r %s block %s %s is %s in "
                  "proof-battery/OPERATION_CATALOG.md; only live-proven "
                  "operations may run. Refusing."
                  % (name, where, method, path,
                     ("marked %s" % "/".join(s or "unmarked" for s in statuses))
                     if rows else "not a dispatchable row"))
        if journal:
            _journal_catalog_refusal(name, method, path, {},
                                     statuses[0] if statuses else "unknown",
                                     detail)
        raise CatalogNotProven(detail)


def catalog_descriptor_to_entry(name: str, method: str, path_template: str,
                                effect_class: str | None = None,
                                provider: str = "canvas",
                                auth_slot: str = None, extra: dict = None) -> dict:
    """Build a synthetic manifest entry from a catalog operation descriptor and
    run it through the same pipeline as a pack entry. The descriptor mirrors
    the generated-catalog operation shape: name, HTTP method, path template
    with {param} slots, and a read/write/plan class. "plan" means the entry
    computes a validated change plan and performs no write; admission still
    gates it, and approval is still required before any later write entry
    executes the plan. W4-P0-10: the "performs no write" half is ENFORCED,
    not just documented: dispatch_entry derives the effect class from the
    entry's blocks and refuses a plan-class (or read-class) entry that
    carries any PUT/POST/PATCH/DELETE or browser-write block
    (EffectClassMismatch), so a write can never ride as "plan" to dodge
    write approval.

    W3-P0-6: the catalog row's own R/W column is the authoritative effect
    class for the entry. When the name resolves to a catalog row, the
    caller-supplied effect_class is OPTIONAL and is only a consistency
    check: omitted (None) means "use the catalog's class"; supplied means
    "refuse loudly if it contradicts the catalog row". The entry's effects
    always come from the catalog, never from the caller, so a write can
    never be dispatched as a read to dodge write approval. A [LEARNER-DATA]
    row also marks the entry so the learner-data gate fires even when the
    URL template carries no policy substring.
    """
    descriptor = catalog_descriptor_for(name)
    catalog_learner_data = False
    if descriptor is not None:
        canonical = descriptor.get("effect")
        catalog_learner_data = bool(descriptor.get("learner_data"))
        if effect_class is not None and effect_class != canonical:
            raise CatalogEffectMismatch(
                "operation %r is catalog row %s with R/W %r (effect class "
                "%r); the caller declared effect class %r, which "
                "contradicts the catalog. The caller can never change a "
                "catalog row's effect class: a write cannot be dispatched "
                "as a read to dodge approval, and a read cannot be "
                "dispatched as a write. Refusing."
                % (name, descriptor.get("id"), descriptor.get("effect_rw"),
                   canonical, effect_class))
        effect_class = canonical
    else:
        if effect_class is None:
            # No effect class can be derived for a name the catalog does
            # not know, and the provenance gate refuses the name anyway.
            raise _catalog_name_refusal(name, method, path_template)
    if effect_class not in ("read", "write", "plan"):
        raise ExecutorError("effect_class must be 'read', 'write', or 'plan', got %r" % effect_class)
    default_slots = {"canvas": "canvas_pat", "quiz_api": "canvas_pat"}
    slot = auth_slot or default_slots.get(provider, "canvas_pat")
    entry = {
        "manifest": MANIFEST_CONSTANT,
        "name": name,
        "title": name,
        "description": "Catalog-dispatched operation %s %s (effect class %s)." % (method, path_template, effect_class),
        "version": "0.1.0",
        "provider": provider,
        "effects": effect_class,
        "params": {"type": "object", "additionalProperties": True},
        "request": {
            "method": method,
            "url": "{%s_base}%s" % (provider, path_template),
            "headers": {},
        },
        "auth": {"slot": slot, "alternates": []},
        "result": {
            "max_bytes": 262144,
            "truncate": "tail",
            "receipt": [],
            "redact": [],
        },
        "rate": {"hint": "gentle", "retry_on": list(RETRYABLE_STATUSES)},
    }
    if catalog_learner_data:
        # W3-P0-5/W3-P0-9: the catalog row is marked [LEARNER-DATA]; the
        # learner-data gate and projection must fire for this entry even
        # when no policy URL substring matches.
        entry["catalog_learner_data"] = True
    if extra:
        for key in ("query", "body", "headers"):
            if key in extra:
                entry["request"][key] = extra[key]
        # verify and undo are entry-level blocks (the browser lane reads
        # entry["verify"] / entry["undo"]); nesting them under request
        # would silently drop them for catalog-synthetic entries.
        # before_state / concurrency are entry-level governance blocks
        # (W4-P1-15): the freshness guard needs them to re-read state.
        for key in ("verify", "undo", "before_state", "concurrency"):
            if key in extra:
                entry[key] = extra[key]
        for key in ("result", "rate", "auth"):
            if key in extra:
                entry[key] = extra[key]
    entry["_catalog_synthetic"] = True
    return entry


def dispatch_catalog_op(name: str, method: str, path_template: str,
                        effect_class: str | None = None, params: dict = None,
                        provider: str = "canvas", auth_slot: str = None,
                        plan: FrozenPlan = None, op_id: str = None,
                        pack: dict = None, extra: dict = None,
                        approval: dict = None, session=None, dry_run=False,
                        require_educator_channel: bool = True,
                        mode_ctx: dict = None) -> dict:
    """Dispatch one generated-catalog operation through the full pipeline.

    mode_ctx is passed through to dispatch_entry: see its docstring. People-bearing rows (learner data) dispatch only on the
    Chromium lane with the encrypted learner vault, where every receipt
    is de-identified; elsewhere they are refused (LearnerDataGated).

    F-2: the catalog provenance gate runs first. The op must be marked
    live-proven in proof-battery/OPERATION_CATALOG.md; every other row,
    unknown names, and descriptor mismatches are refused, and nothing
    overrides that.

    session defaults to the https lane's SessionStore; pass a
    ChromiumSession for the chromium backend.

    dry_run=True (W4-P2-26): render the request without sending anything
    and without journaling anything.
    """
    pack = pack or load_pack(DEFAULT_PACK)
    params = params or {}
    entry = catalog_descriptor_to_entry(name, method, path_template,
                                        effect_class, provider, auth_slot, extra)
    status = _catalog_provenance_gate(
        entry, name, method, path_template, params, session=session)
    if session is None:
        session = SessionStore.load()
    return dispatch_entry(entry, params, session, pack, plan=plan, op_id=op_id,
                          approval=approval,
                          catalog_status=status, dry_run=dry_run,
                          require_educator_channel=require_educator_channel,
                          mode_ctx=mode_ctx)


# --------------------------------------------------------------------------
# Undo: an entry's undo block as a new, separately journaled operation
# --------------------------------------------------------------------------

_RESULT_REF_RE = re.compile(r"\{result\.([^{}]+)\}|\"?result\.([A-Za-z0-9_.\[\]]+)")


def _undo_result_refs(undo) -> list:
    """The result.<path> references an undo block resolves, sorted."""
    refs = set()
    for match in _RESULT_REF_RE.finditer(json.dumps(undo, sort_keys=True)):
        refs.add(match.group(1) or match.group(2))
    return sorted(refs)


def journaled_undo_result(entry: dict, params: dict, of_op_id: str,
                          caller_result=None):
    """The result payload an undo resolves against: ONLY the journaled
    receipt of of_op_id.

    Refuses (UndoTargetMismatch) unless a completed write outcome is
    journaled under of_op_id for this same entry with these same params,
    and unless every result field the undo block references agrees with
    caller_result when the caller passed one. An empty caller_result is
    fine: the journal alone decides the target."""
    original = find_journal_op(str(of_op_id))
    if not isinstance(original, dict) or original.get("wal") != "complete":
        raise UndoTargetMismatch(
            "no completed write is journaled under op id %r, so there is "
            "nothing this undo can be bound to; nothing was sent"
            % str(of_op_id))
    if original.get("kind") == "undo" or original.get("effect") != "write":
        raise UndoTargetMismatch(
            "op %r is not a forward write (kind %r, effect %r); only a "
            "forward write can be undone" % (str(of_op_id),
                                           original.get("kind"),
                                           original.get("effect")))
    if original.get("entry_name") != entry.get("name"):
        raise UndoTargetMismatch(
            "op %r ran entry %r, not %r; an undo must use the undo block of "
            "the entry that made the change" % (
                str(of_op_id), original.get("entry_name"), entry.get("name")))
    if original.get("params_digest") != digest_of(params or {}):
        raise UndoTargetMismatch(
            "the params for this undo differ from the params op %r ran "
            "with; pass the original op's params" % str(of_op_id))
    journaled = original.get("receipt")
    if caller_result:
        for ref in _undo_result_refs(entry.get("undo")):
            try:
                theirs = resolve_path(caller_result, ref)
            except Exception:
                theirs = None
            try:
                ours = resolve_path(journaled, ref)
            except Exception:
                ours = None
            if theirs != ours:
                raise UndoTargetMismatch(
                    "the result payload passed for this undo says "
                    "result.%s is %r, but op %r journaled %r; the undo "
                    "target comes only from the journal" % (
                        ref, theirs, str(of_op_id), ours))
    return journaled


def undo_approval_subject(entry: dict, params: dict, of_op_id: str,
                          result_payload=None) -> tuple:
    """(undo_entry, undo_params): what an undo is approved and admitted as.

    An undo is its own write, so its approval must never be the forward
    write's: the entry is "<name>#undo" with the undo block as its
    request (so destructiveness and learner-data checks see the request
    that is actually sent), and the params bind the original op, the
    exact undo request (method and path, rendered from the original op's
    JOURNALED receipt), and the target fields it resolves. The approval
    display therefore shows the educator exactly what will be undone.
    result_payload, when given, must agree with the journal
    (journaled_undo_result). Mint the educator's undo approval with
    admission.mint_approval(undo_entry, undo_params, tenant_base)."""
    undo = entry.get("undo")
    undo_entry = undo_admission_entry(entry)
    journaled = journaled_undo_result(entry, params, of_op_id,
                                      result_payload)
    undo_params = dict(params or {})
    undo_params["_undo_of"] = str(of_op_id)
    target = {}
    for ref in _undo_result_refs(undo):
        try:
            target[ref] = resolve_path(journaled, ref)
        except Exception:
            target[ref] = None
    undo_params["_undo_target"] = target
    url_template = str(undo.get("url") or "")
    try:
        path = render_template(url_template, {"canvas_base": ""},
                               params or {}, journaled)
    except ExecutorError:
        path = url_template
    undo_params["_undo_request"] = {
        "method": str(undo.get("method") or "").upper(),
        "path": path,
    }
    return undo_entry, undo_params


def undo_admission_entry(entry: dict) -> dict:
    """The entry an undo is admitted as: "<name>#undo" with the undo
    block as its request (see undo_approval_subject)."""
    undo = entry.get("undo")
    if not isinstance(undo, dict):
        raise ExecutorError("entry %r declares no undo block"
                            % entry.get("name"))
    undo_entry = {key: value for key, value in entry.items()
                  if key not in ("undo", "verify", "before_state",
                                 "discovery", "multi_step", "request",
                                 "destructive", "effects")}
    undo_entry["name"] = "%s#undo" % entry.get("name")
    undo_entry["request"] = undo
    undo_entry["effects"] = "write"
    if undo.get("destructive") is True:
        undo_entry["destructive"] = True
    return undo_entry


def dispatch_undo(entry: dict, params: dict, result_payload, of_op_id: str,
                  session: SessionStore, pack: dict, approval: dict = None,
                  dry_run=False,
                  require_educator_channel: bool = True,
                  mode_ctx: dict = None) -> dict:
    """Execute the entry's undo block as a new op that references the original.

    dry_run=True renders the undo request without sending anything and
    without journaling anything (W4-P2-26). mode_ctx is passed through
    to the admission gate: see dispatch_entry's docstring."""
    undo = entry.get("undo")
    if not undo:
        raise ExecutorError(
            "entry %r declares no undo block; the effect is non-undoable and the "
            "governance layer must disclose that to the educator before dispatch" % entry.get("name"))
    # W4-P0-10: the undo block's effect class is derived from the block
    # itself, never trusted from the manifest. An undo reverses a write,
    # so a non-write undo block is refused outright.
    _undo_derived, _ = derive_effect_class({"request": undo})
    if _undo_derived != "write":
        raise EffectClassMismatch(
            "entry %r: undo block derives effect class %r, not 'write'; "
            "an undo must reverse a write. Refusing." % (entry.get("name"),
                                                        _undo_derived))
    # The undo rides on the entry's admission, so the entry itself must
    # derive and declare as a write (a "read" entry carrying a DELETE
    # undo block would otherwise be admitted without write approval).
    enforce_effect_class(entry)
    if entry.get("effects") != "write":
        raise EffectClassMismatch(
            "entry %r declares effects=%r but carries an undo block; an "
            "undo is a write and needs a write-declared entry. Refusing."
            % (entry.get("name"), entry.get("effects")))
    live_proven_gate({"name": "%s#undo" % entry.get("name"),
                      "request": undo}, journal=not dry_run)
    _require_course_resolution(entry, params, mode_ctx)
    # Admission gate: undo is a write; it needs its own educator approval
    # bound to the undo action, plus the never-dispatch / learner-data checks.
    provider = entry.get("provider")
    try:
        tenant_base = session.base_for(provider or "canvas")
    except Exception:
        tenant_base = None
    _check_auxiliary_learner_data(entry, vault_ready=False)
    # The forward entry's own policy gates still apply to its undo.
    check_policy_gates(entry)
    # The undo target comes ONLY from the original op's journaled
    # receipt; a caller payload that disagrees is refused.
    result_payload = journaled_undo_result(entry, params, of_op_id,
                                           result_payload)
    undo_entry, undo_params = undo_approval_subject(entry, params, of_op_id,
                                                    result_payload)
    approval_audit, approval_record = admit(
        undo_entry, undo_params, tenant_base=tenant_base, approval=approval,
        require_educator_channel=require_educator_channel,
        mode_ctx=mode_ctx, journal=not dry_run)
    mode_edit_undo = (isinstance(approval_audit, dict)
                      and approval_audit.get("mode") == "edit")
    # Undo passes no vault_ready: a learner-bearing undo is refused on
    # every lane (undo has no working-by-name or projection path yet).
    # Undo is a write: claim a fresh op_id atomically under the journal
    # lock (W2-P0-18), then run the standard write gates.
    undo_op_id = str(uuid.uuid4())
    undo_op_id, undo_claim = _check_write_gates(entry, params, None, undo_op_id,
                                                kind="undo", dry_run=dry_run)
    if dry_run:
        # W4-P2-26: render, don't send, don't journal, don't consume.
        config = {"canvas_base": tenant_base or ""}
        secret_headers = _dry_run_secret_headers(entry, pack)
        rendered = _render_request_block(
            entry, undo, params, session, pack, config, "undo", secret_headers,
            result_payload)
        return {"dry_run": True,
                "entry_name": entry.get("name"),
                "kind": "undo",
                "undo_of": str(of_op_id),
                "op_id": undo_op_id,
                "effect": {"declared": "write", "derived": "write"},
                "tenant": tenant_base,
                "gates": [
                    {"gate": "effect_class_derivation", "result": "pass",
                     "detail": "undo is a write; write gates applied"},
                    {"gate": "admission", "result": "pass",
                     "detail": "undo approval verified; NOT consumed in dry-run"},
                    {"gate": "write_halt", "result": "pass",
                     "detail": "no write halt file present"},
                    {"gate": "op_id_claim", "result": "skipped",
                     "detail": "dry-run: the op_id is never claimed and nothing is journaled"},
                ],
                "requests": [rendered],
                "provider_calls": 0,
                "journaled": False,
                "approval_consumed": False,
                "note": ("dry-run: nothing was sent to the provider, nothing "
                         "was journaled, no op_id was claimed, and no approval "
                         "was consumed")}
    # W4 approval ordering: the burn happens AFTER the target-identity
    # precheck below (inside the try), so a refused undo leaves its
    # approval reusable. Persist-before-consume keeps every crash state
    # recoverable.

    config = {"canvas_base": session.base_for("canvas")}
    # Item Banks SDK lane: bind the course scope (same as dispatch_entry).
    _sdk_course_setter = getattr(session, "set_sdk_course", None)
    if callable(_sdk_course_setter):
        _sdk_course_setter(params.get("course_id")
                           if isinstance(params, dict) else None)
    entry_max_bytes = int((entry.get("result") or {}).get("max_bytes",
                                                          DEFAULT_MAX_BYTES))
    undo_sent = False
    try:
        # W5-P2-1: shutdown checkpoint before any provider I/O: a pending
        # signal releases the fresh claim (nothing could have applied)
        # and raises ExecutorShutdown.
        _raise_if_shutdown_requested(undo_op_id, undo_claim)
        # W4-P0-11: the undo is a write like any other: verify its target
        # before sending it. The reviewed target is the original op's
        # journaled provider-verified target, so the undo must hit the
        # same course the original write hit; the course's existence is
        # always re-verified. A refusal here is pre-network: the claim is
        # released and the undo op_id stays reusable.
        _undo_original = find_journal_op(str(of_op_id)) or {}
        _undo_declared = (_undo_original.get("target") or {})
        _undo_entry = {"name": "%s#undo" % entry.get("name"),
                       "provider": provider, "request": undo}
        verify_write_target_identity(_undo_entry, params, None, session,
                                     pack, config,
                                     max_bytes=entry_max_bytes,
                                     declared=_undo_declared,
                                     approval_target=(approval_record or {}).get(
                                         "target"),
                                     no_approval_target_ok=mode_edit_undo)
        # W4 approval ordering: the target precheck passed; burn the undo
        # approval now, immediately before the undo write is sent, so a
        # target refusal leaves the approval reusable and the undo op_id
        # unclaimed.
        _burn_write_approval(approval_record, undo_op_id)
        # W5-P2-1: last checkpoint before the provider call: a pending
        # signal releases the claim and stops before any effect.
        _raise_if_shutdown_requested(undo_op_id, undo_claim)
        method, url, headers, body_bytes = build_request(
            entry, undo, params, session, pack, config, {}, result_payload)
        undo_sent = True
        status, resp_headers, raw, attempts = session.raw_request(
            method, url, headers, body_bytes, is_write=True,
            max_bytes=entry_max_bytes)
        result = apply_result_block(entry, raw, resp_headers)
    except UncertainWrite as exc:
        # The undo's effect is uncertain: journal it as such so the
        # journal tells the truth about the write, then re-raise.
        record = {
            "op_id": undo_op_id,
            "entry_name": entry.get("name"),
            "kind": "undo",
            "undo_of": str(of_op_id),
            "effect": "write",
            "wal": "complete",
            "params_digest": digest_of(params),
            "plan_digest": None,
            "before_state_digest": None,
            "after_state_digest": None,
            "verification": "uncertain",
            "verification_detail": redact_payload(
                _provider_detail(exc), DEFAULT_REDACT_PATTERNS),
            "receipt": redact_payload({"uncertain": True,
                                       "detail": _provider_detail(exc, 500)},
                                      DEFAULT_REDACT_PATTERNS),
            "truncated": False,
            "bytes_received": 0,
            "attempts": exc.attempts or 0,
            "uncertain": True,
            "approval": approval_audit,
        }
        journal_append(record)
        # W5-P2-1: the uncertain outcome is journaled; a pending signal
        # now stops the run instead of propagating UncertainWrite.
        _raise_if_shutdown_requested()
        raise
    except ExecutorError:
        # Pre-network or provably pre-send failure: release the claim so
        # the op_id stays reusable, then re-raise. (Ambiguous post-send
        # undo failures surface as UncertainWrite from the transport, so
        # they are journaled above, never silently lost.)
        try:
            release_op_id(undo_op_id, undo_claim,
                          "undo failure before any effect could apply")
        except DuplicateOpId:
            pass
        raise
    except Exception:
        # Not an ExecutorError (an admission refusal while the approval
        # burns, an OSError, a bug): before the undo was sent nothing
        # could have applied, so release the claim; after, it stays
        # pending for reconciliation, like a crash.
        if not undo_sent:
            try:
                release_op_id(undo_op_id, undo_claim,
                              "undo failure before any effect could apply")
            except DuplicateOpId:
                pass
        raise
    record = {
        "op_id": undo_op_id,
        "entry_name": entry.get("name"),
        "kind": "undo",
        "undo_of": str(of_op_id),
        "effect": "write",
        "wal": "complete",
        "params_digest": digest_of(params),
        "plan_digest": None,
        "before_state_digest": None,
        "after_state_digest": digest_of(result["receipt"]),
        "verification": "skipped",
        "verification_detail": "undo journaled separately; verify via the inverse readback if declared",
        "receipt": redact_payload(result["receipt"], DEFAULT_REDACT_PATTERNS),
        "truncated": result["truncated"],
        "bytes_received": result["bytes_received"],
        "attempts": attempts,
        "uncertain": False,
        "approval": approval_audit,
    }
    journal_append(record)
    # W5-P2-1: the undo outcome is journaled; a pending signal stops the
    # run here rather than returning into further phases.
    _raise_if_shutdown_requested()
    return {
        "op_id": undo_op_id,
        "undo_of": str(of_op_id),
        "entry_name": entry.get("name"),
        "receipt": result["receipt"],
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _load_params(text: str) -> dict:
    if not text:
        return {}
    try:
        obj = json.loads(text)
    except ValueError as exc:
        # W6-P2-E2: the raw ValueError text echoes the offending input
        # (params can carry learner tokens); keep it off stderr.
        raise CallerInputError(
            "--params is not valid JSON: %s" % "REDACTED") from exc
    if not isinstance(obj, dict):
        raise CallerInputError("--params must be a JSON object")
    return obj


def _caller_op_id(value, flag: str = "--op-id") -> str:
    """An op id argument, checked before anything is read or sent."""
    try:
        return check_uuid(value)
    except (TypeError, ValueError, AttributeError):
        # The value is not echoed: an agent may paste other text here.
        raise CallerInputError(
            "%s is not an op id: pass the op id exactly as Morrow printed "
            "it (letters, digits, and dashes only), with no brackets, "
            "quotes, or other text. Nothing was sent." % flag) from None


def _load_body(text: str):
    """The request body from --body: a JSON object, or a JSON array of
    objects (the bulk date update, C-37, takes a bare array)."""
    try:
        body = json.loads(text)
    except ValueError as exc:
        # The offending input can carry learner tokens; keep it off
        # stderr (W6-P2-E2).
        raise CallerInputError("--body is not valid JSON") from exc
    if isinstance(body, dict):
        return body
    if isinstance(body, list) and body and all(
            isinstance(item, dict) for item in body):
        return body
    raise CallerInputError(
        "--body must be a JSON object, or a JSON array of objects (the "
        "bulk date update takes an array)")


def _load_approval(path: str | None) -> dict | None:
    """Load an educator-signed approval record from a JSON file.

    W6-P2-E2: the failure message deliberately carries NO OSError text:
    str(exc) embeds the absolute path and the OS username, which used
    to flow into CLI stderr and journaled catalog-gate refusals. The
    underlying error is still available as the exception's __cause__.
    """
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            record = json.load(fh)
    except (OSError, ValueError) as exc:
        raise ExecutorError(
            "approval file is not readable JSON") from exc
    if not isinstance(record, dict):
        raise ExecutorError("approval file must contain a JSON object")
    return record


def _mode_ctx_from_args(args) -> dict | None:
    """Build the Plan/Edit mode_ctx from CLI flags (or None).

    user_id defaults to MORROW_USER_ID, then the Canvas account pinned
    at first sign-in (config/identity.default_user_id); conversation_id
    defaults to MORROW_CONVERSATION_ID. Returns None when no user
    identity is available, in which case the admission gate fails
    closed to the legacy plan-mode approval path.
    """
    from config.identity import default_user_id
    user_id = getattr(args, "user_id", None) or default_user_id()
    if not user_id:
        return None
    ctx = {"user_id": user_id}
    conversation_id = getattr(args, "conversation_id", None) or \
        os.environ.get("MORROW_CONVERSATION_ID")
    if conversation_id:
        ctx["conversation_id"] = conversation_id
    resolution_text = getattr(args, "course_resolution", None)
    if resolution_text:
        try:
            resolution = json.loads(resolution_text)
        except ValueError:
            raise CallerInputError(
                "--course-resolution is not valid JSON: REDACTED")
        if not isinstance(resolution, dict):
            raise CallerInputError(
                "--course-resolution must be a JSON object")
        ctx["course_resolution"] = resolution
    destructive_confirmed = getattr(args, "destructive_confirmed", None)
    if destructive_confirmed:
        ctx["destructive_confirmed"] = destructive_confirmed
    return ctx



# --------------------------------------------------------------------------
# Plan-mode write ceremony from the typed interface (round-4 M4)
#
# plan-write builds everything a Plan-mode write needs from the catalog
# row, the params and body, and one course read: the frozen plan (with
# the course name Canvas reports), the unsigned approval record bound
# to the exact request, and the approval display the educator reviews.
# approve-write signs the educator's verbatim reply and sends the write
# in one call. The agent never assembles frozen-plan fields or a course
# resolution by hand.
# --------------------------------------------------------------------------

PENDING_WRITES_DIRNAME = "pending_writes"
# approve-write sets this on an exception it raises: the change in the
# educator's words, for the failure message (_funnel_operation).
OPERATION_LABEL_ATTR = "morrow_operation_label"


def pending_write_path(op_id: str) -> str:
    """Where plan-write keeps a prepared write until approve-write."""
    return os.path.join(MORROW_HOME, PENDING_WRITES_DIRNAME,
                        check_uuid(str(op_id)) + ".json")


def _write_private_json(path: str, doc: dict) -> None:
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _read_course_identity(entry: dict, params: dict, session, pack: dict,
                          course_id: str) -> dict:
    """The course as Canvas names it: {"course_id", "course_name",
    "term"}. Refuses a missing course, an id mismatch, or a spoofed
    name; the educator must see the real name of the course the write
    targets."""
    config = {"canvas_base": session.base_for("canvas")}
    block = {"method": "GET",
             "url": "{canvas_base}/api/v1/courses/%s"
                    % urllib.parse.quote(str(course_id), safe=""),
             "headers": {}}
    try:
        rmethod, rurl, rheaders, rbody = build_request(
            entry, block, params, session, pack, config, {})
        _status, _hdrs, raw, _attempts = session.raw_request(
            rmethod, rurl, rheaders, rbody, is_write=False)
    except ProviderHttpError as exc:
        raise TargetIdentityMismatch(
            "course %s could not be read (HTTP %s); nothing was prepared. "
            "Check the course id with the educator." % (course_id,
                                                       exc.status))
    course = _parse_provider_json(raw, "course %s read" % course_id)
    if str(course.get("id")) != str(course_id):
        raise TargetIdentityMismatch(
            "Canvas returned course id %r for requested course %s; "
            "nothing was prepared." % (course.get("id"), course_id))
    name = course.get("name")
    if not isinstance(name, str) or not name.strip():
        raise TargetIdentityMismatch(
            "course %s has no name to show the educator; nothing was "
            "prepared." % course_id)
    assert_no_spoof_identifier(name, "course name")
    identity = {"course_id": str(course_id), "course_name": name}
    term = course.get("term")
    term_name = term.get("name") if isinstance(term, dict) else term
    if isinstance(term_name, str) and term_name.strip():
        identity["term"] = term_name
    zone = course.get("time_zone")
    if isinstance(zone, str) and zone.strip():
        identity["time_zone"] = zone.strip()
    return identity


# The objects Canvas serves by GET: the routes the write readback
# re-reads (a course is named by _read_course_identity instead). A
# favorite names a course in a user route; the course is read.
_NAMED_OBJECT_READ_ALIASES = {
    "/api/v1/users/self/favorites/courses/{id}": "/api/v1/courses/{id}",
}


def _named_object_route(entry, params):
    """(read URL template, path slot) for the object a write names: the
    deepest object on its path that Canvas serves by GET (the page a
    revision restores, the module an item goes into, the assignment
    itself). None when the path names no such object."""
    url = str(((entry or {}).get("request") or {}).get("url") or "")
    url = url.split("?", 1)[0]
    base = re.match(r"^\{[a-z_]+_base\}", url)
    if not base:
        return None
    template = "/" + url[base.end():].strip("/")
    alias = _NAMED_OBJECT_READ_ALIASES.get(template)
    if alias is not None:
        return base.group(0) + alias, alias.rsplit("/", 1)[1][1:-1]
    tparts = template.strip("/").split("/")
    rparts = admission_render_path(url, params).strip("/").split("/")
    if len(tparts) != len(rparts):
        return None
    for n in range(len(tparts), 0, -1):
        slot = tparts[n - 1]
        if not (slot.startswith("{") and slot.endswith("}")):
            continue
        rendered = "/" + "/".join(rparts[:n])
        if _WRITE_READBACK_MEMBER_RE.match(rendered) or \
                _IB_READBACK_BANK_MEMBER_RE.match(rendered):
            return (base.group(0) + "/" + "/".join(tparts[:n]),
                    slot[1:-1])
    return None


def _object_title(payload):
    """The name Canvas gives an object: its title or name (a New Quiz
    item keeps its title under "entry", an item bank under "bank")."""
    if not isinstance(payload, dict):
        return None
    for node in (payload, payload.get("entry"), payload.get("bank")):
        if isinstance(node, dict):
            for key in ("title", "name", "display_name"):
                value = node.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return None


def _read_named_object(entry, params, session, pack, tenant_base,
                       project=True, stage="prepared"):
    """The object a write names, read before the educator approves it:
    {"object_slot", "object_name", "object_name_digest"}, or None when
    the path names no object Canvas serves by GET. object_name is
    labeled like course content (project=True), so a student named in a
    title reaches the agent as a label; it is None for an object with
    no name. Refuses (TargetIdentityMismatch) when the object cannot be
    read: the educator never approves a change to an object Morrow
    could not name."""
    from privacy import executor_wire as _wire
    from dispatch.approval_display import _noun
    # The agent can name the object by its labeled address (a page whose
    # address holds a student's name): the read goes to the real one.
    shown_params = params
    params, _ids = _wire.resolve_learner_labels(
        {"params": params}, tenant_base,
        _write_target_course_id(entry, params), None,
        error_cls=LearnerLabelUnresolved, provider=entry.get("provider"),
        extra_keys=_wire.learner_route_param_keys(entry))
    params = params["params"]
    found = _named_object_route(entry, params)
    if found is None:
        return None
    template, slot = found
    read_entry = dict(entry, effects="read",
                      request={"method": "GET", "url": template,
                               "headers": {}})
    config = {"canvas_base": session.base_for("canvas")}
    words = template.split("?", 1)[0].split("/")
    what = "%s %s" % (_noun(words[-2], words[-4] if len(words) > 3
                            else None), shown_params.get(slot))
    rosters = _wire.begin_course_rosters()
    try:
        if project:
            _read_course_roster_first(read_entry, params, session,
                                      tenant_base, dry_run=False)
        rmethod, rurl, rheaders, rbody = build_request(
            read_entry, read_entry["request"], params, session, pack,
            config, {})
        try:
            _status, _hdrs, raw, _attempts = session.raw_request(
                rmethod, rurl, rheaders, rbody, is_write=False)
        except ProviderHttpError as exc:
            missing = exc.status in (404, 410)
            raise TargetIdentityMismatch(
                "the %s %s in Canvas (HTTP %s), so it cannot be named for "
                "the educator. Nothing was %s. Check which one the "
                "educator means." % (what, "was not found" if missing
                                     else "could not be read", exc.status,
                                     stage))
        title = _object_title(_parse_provider_json(raw, "%s read" % what))
        shown = title
        if project and title:
            view = {"name": entry.get("name"),
                    "provider": entry.get("provider") or "canvas",
                    "effects": "read",
                    "request": {"method": "GET",
                                "url": rurl.split("?", 1)[0]}}
            shown = _wire.project_learner_result(
                view, {"receipt": {"name": title}}, tenant_base,
                error_cls=ExecutorError)["receipt"]["name"]
    finally:
        _wire.end_course_rosters(rosters)
    return {"object_slot": slot, "object_name": shown,
            "object_name_digest": hashlib.sha256(
                (title or "").encode("utf-8")).hexdigest()}


# Routes that can publish a New Quiz without naming one: the assignment
# a New Quiz is (C-43) and its module item (C-283). Publishing a New Quiz
# was never tested (SCOPE.md), so Morrow reads the target first (C-44 and
# C-281 are live-proven reads) and refuses a New Quiz. The New Quiz routes
# themselves are refused by admission_policy.json request_fields.
_PUBLISH_TARGETS = {
    ("PUT", "/api/v1/courses/{}/assignments/{}"): "assignment",
    ("PUT", "/api/v1/courses/{}/modules/{}/items/{}"): "module item",
}


def _new_quiz_publish_target(entry):
    """"assignment" or "module item" when the write sets published on a
    route whose target can be a New Quiz, else None."""
    from dispatch.admission import _field_values, _flag_is_false, _route_key
    request = (entry or {}).get("request") or {}
    kind = _PUBLISH_TARGETS.get(_route_key(request.get("method"),
                                           request.get("url")))
    if kind is None:
        return None
    url_query = urllib.parse.urlsplit(str(request.get("url") or "")).query
    for part in (request.get("query"), request.get("body"), url_query):
        if part and any(not _flag_is_false(value)
                        for value in _field_values(part, "published")):
            return kind
    return None


def _is_new_quiz_assignment(doc):
    """True for an assignment that is a New Quiz: Canvas flags it
    is_quiz_lti_assignment, and it launches the quiz-lti tool."""
    if doc.get("is_quiz_lti_assignment") is True:
        return True
    tool = doc.get("external_tool_tag_attributes")
    url = tool.get("url") if isinstance(tool, dict) else None
    return "external_tool" in (doc.get("submission_types") or []) \
        and ".quiz-lti" in str(url or "").lower()


def _read_publish_target(entry, url_template, params, session, pack, what):
    read_entry = dict(entry, effects="read",
                      request={"method": "GET", "url": url_template,
                               "headers": {}})
    config = {"canvas_base": session.base_for("canvas")}
    rmethod, rurl, rheaders, rbody = build_request(
        read_entry, read_entry["request"], params, session, pack, config,
        {})
    try:
        _status, _hdrs, raw, _attempts = session.raw_request(
            rmethod, rurl, rheaders, rbody, is_write=False)
        return _parse_provider_json(raw, "the %s read" % what)
    except (ProviderHttpError, TargetIdentityMismatch) as exc:
        raise WriteNotAttempted(
            "the %s could not be read (%s), so Morrow could not check that "
            "it is not a New Quiz before publishing it. Nothing was sent."
            % (what, "HTTP %s" % exc.status
               if isinstance(exc, ProviderHttpError) else exc))


def _refuse_new_quiz_publish(entry, params, session, pack):
    """Refuse (EvidenceHold) a write that publishes a New Quiz through its
    assignment or module item. Reads the target first; a target Morrow
    cannot read is not published (WriteNotAttempted)."""
    kind = _new_quiz_publish_target(entry)
    if kind is None:
        return
    from reauth import state_machine as _rsm
    if not _rsm.check_write_allowed()[0]:
        # Changes are paused: the write gates refuse it, and nothing is
        # read or sent.
        return
    url = entry["request"]["url"].split("?", 1)[0]
    doc = _read_publish_target(entry, url, params, session, pack, kind)
    if kind == "module item":
        new_quiz = doc.get("quiz_lti") is True
        if "quiz_lti" not in doc and doc.get("type") == "Assignment":
            course_url = url.split("/modules/", 1)[0]
            new_quiz = _is_new_quiz_assignment(_read_publish_target(
                entry, course_url + "/assignments/{content_id}",
                dict(params, content_id=doc.get("content_id")), session,
                pack, "assignment"))
    else:
        new_quiz = _is_new_quiz_assignment(doc)
    if new_quiz:
        from dispatch.admission import EvidenceHold
        raise EvidenceHold(
            "operation %r publishes a New Quiz (the %s is one), which was "
            "never tested; refused on every tenant until a live battery "
            "proves it. Nothing was sent." % (entry.get("name"), kind))


def _educator_time_zone(user_id, course_zone):
    """The zone the approval shows dates in: the educator's timezone
    setting, then the course's time zone in Canvas; None (UTC) when
    neither is set."""
    from config.identity import default_user_id
    uid = user_id or default_user_id()
    if uid:
        try:
            from settings import store as _settings
            name = _settings.get_setting(uid, "timezone")
        except Exception:
            name = None
        if isinstance(name, str) and name.strip():
            return name.strip()
    return course_zone


def prepare_plan_write(name: str, method: str, path_template: str,
                       params: dict, body, session, pack: dict,
                       provider: str = "canvas",
                       ttl_seconds: int = 3600,
                       conversation_id: str | None = None,
                       user_id: str | None = None) -> dict:
    """Prepare one Plan-mode catalog write for the educator's approval.

    Runs the catalog and policy gates, reads the target course and the
    object the write names (_read_named_object), builds the frozen plan
    and the unsigned approval record bound to the exact request, and
    stores them as a pending write. Sends nothing and journals nothing.
    Returns what the agent shows the educator; its dates are in the
    educator's time zone (user_id's timezone setting, then the
    course's).

    Students named by label (or by the echoed "<typed name> (label)"
    form, checked against conversation_id) are stored as bare labels,
    and the plan binds each label to its vault token (final muse audit
    M1/M2): the typed name stays in the encrypted name-echo store, and
    approve-write refuses when a label names a different issue."""
    from dispatch.admission import mint_approval
    from dispatch.approval_display import (render_approval_display,
                                           render_educator_display)
    expire_write_ceremony_files(quiet=True)
    params = dict(params or {})
    extra = {"body": body} if body is not None else None
    entry = catalog_descriptor_to_entry(name, method, path_template, None,
                                        provider, None, extra)
    from privacy import executor_wire as _wire
    bound, learner_tokens = _wire.bind_learner_labels(
        {"params": params, "body": body},
        session.base_for(provider or "canvas"),
        _write_target_course_id(entry, params), conversation_id,
        error_cls=LearnerLabelUnresolved, provider=provider,
        extra_keys=_wire.learner_route_param_keys(entry))
    if learner_tokens:
        if _write_target_course_id(entry, params) is None:
            raise LearnerLabelUnresolved(
                "this write names a student by label but targets no "
                "course; labels belong to one course. Nothing was "
                "prepared.")
        params, body = dict(bound["params"]), bound["body"]
        extra = {"body": body} if body is not None else None
        entry = catalog_descriptor_to_entry(name, method, path_template,
                                            None, provider, None, extra)
    if entry.get("effects") != "write":
        raise CallerInputError(
            "plan-write prepares writes only; %r is a %s operation (run "
            "it with the catalog command, no approval needed). Nothing "
            "was sent." % (name, entry.get("effects")))
    enforce_effect_class(entry)
    _catalog_provenance_gate(entry, name, method, path_template, params,
                             session=session)
    check_policy_gates(entry, bool(getattr(session, "browser_owned_auth",
                                           False)))
    _refuse_new_quiz_publish(entry, params, session, pack)
    tenant_base = session.base_for(provider or "canvas")
    course_id = _write_target_course_id(entry, params)
    target = None
    if course_id is not None:
        target = _read_course_identity(entry, params, session, pack,
                                       course_id)
    time_zone = _educator_time_zone(user_id, (target or {}).get("time_zone"))
    named = _read_named_object(entry, params, session, pack, tenant_base)
    if named is not None:
        target = dict(target or {}, **named)
    op_id = str(uuid.uuid4())
    subject = admission_request_subject(entry, params)
    if learner_tokens:
        subject = dict(subject, learner_tokens=learner_tokens)
    plan = {
        "op_id": op_id,
        "entry_name": name,
        "params": params,
        "before_state_digest": "",
        "frozen_readback": ({"course_id": target["course_id"],
                             "name": target["course_name"]}
                            if target and course_id is not None else {}),
        "request": subject,
        "request_digest": admission_request_digest(subject),
    }
    if target:
        plan["target_identity"] = target
    record = mint_approval(entry, params, tenant_base, ttl_seconds,
                           target_identity=target)
    display = render_educator_display(record, params, entry=entry,
                                      time_zone=time_zone)
    audit_detail = render_approval_display(record, params, entry=entry)
    if learner_tokens and conversation_id and course_id is not None:
        # Shown to the educator (through the agent, in this conversation
        # only): the names the educator typed, next to their labels.
        display = _wire.apply_name_echo(display, tenant_base, course_id,
                                        conversation_id)
    where = None
    if target and target.get("course_name") and course_id is not None:
        where = 'the course "%s"' % target["course_name"]
    elif course_id is not None:
        where = "course %s" % course_id
    _write_private_json(pending_write_path(op_id), {
        "version": 1,
        "op_id": op_id,
        "created_at": utc_now_iso(),
        "descriptor": {"name": name, "method": method,
                       "path": path_template, "provider": provider,
                       "params": params, "body": body},
        "operation_label": _describe_operation(method, path_template,
                                               where),
        "plan": plan,
        "approval": record,
    })
    return {
        "ok": True,
        "status": "awaiting_approval",
        "op_id": op_id,
        "course": ({"id": target["course_id"], "name": target["course_name"],
                    "term": target.get("term")}
                   if target and course_id is not None else None),
        "approval_display": display,
        "audit_detail": audit_detail,
        "expires_at": record.get("expires_at"),
        "message": ("Nothing was sent. Show the educator approval_display "
                    "exactly as written and ask them to approve this write. "
                    "Do not show them audit_detail: it is the technical "
                    "record of the same request, for reviewers. When they "
                    "approve, run approve-write --op-id %s "
                    "--authorization \"<their reply, verbatim>\"." % op_id),
    }


def _recheck_named_object(descriptor, target, session, pack):
    """Before an approved write is sent, read the object it names again:
    it must still be the object the educator was shown by name (the
    prepared plan's target). Refuses (TargetIdentityMismatch) before the
    approval is used."""
    expected = (target or {}).get("object_name_digest") \
        if isinstance(target, dict) else None
    if not expected:
        return
    body = descriptor.get("body")
    provider = descriptor.get("provider") or "canvas"
    entry = catalog_descriptor_to_entry(
        descriptor.get("name"), descriptor.get("method"),
        descriptor.get("path"), None, provider, None,
        {"body": body} if body is not None else None)
    seen = _read_named_object(entry, descriptor.get("params") or {},
                              session, pack, session.base_for(provider),
                              project=False, stage="sent")
    if seen is None or seen["object_name_digest"] != expected:
        raise TargetIdentityMismatch(
            "the object this change names was renamed or replaced in "
            "Canvas after the educator approved it by name. Nothing was "
            "sent. Run plan-write again and show the educator the new "
            "approval.")


def approve_plan_write(op_id: str, authorization: str, session, pack: dict,
                       mode_ctx: dict | None = None,
                       channel: str = "educator-chat") -> dict:
    """Sign the educator's verbatim reply for a prepared write and send
    it, in one call. The write goes through the full pipeline (every
    gate, the approval bound to the exact request, single use). The
    course resolution is the course the educator saw named in the
    approval display; the provider name is re-verified before the
    write. A failure carries the change as the educator approved it
    (OPERATION_LABEL_ATTR)."""
    label = {"text": "the change you approved"}
    try:
        return _approve_plan_write(op_id, authorization, session, pack,
                                   mode_ctx, channel, label)
    except Exception as exc:
        try:
            setattr(exc, OPERATION_LABEL_ATTR, label["text"])
        except Exception:
            pass
        raise


def _approve_plan_write(op_id, authorization, session, pack, mode_ctx,
                        channel, label):
    from dispatch.admission import (approval_used, sign_approval,
                                    _is_destructive)
    op_id = _caller_op_id(op_id)
    expire_write_ceremony_files(quiet=True)
    path = pending_write_path(op_id)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        already_used = find_journal_op(op_id) is not None \
            or claim_is_live(op_id)
        raise PreparedWriteMissing(
            "no prepared write %s is waiting for approval (%s); run "
            "plan-write again" % (
                op_id, "the journal holds its claim or outcome: it was "
                "sent, or tried, with an earlier approval" if already_used
                else "the journal has no record of it: it expired or was "
                "never prepared, and was never sent"),
            already_used)
    descriptor = doc.get("descriptor") or {}
    if isinstance(doc.get("operation_label"), str) \
            and doc["operation_label"]:
        label["text"] = doc["operation_label"]
    elif descriptor.get("method") and descriptor.get("path"):
        label["text"] = _describe_operation(descriptor["method"],
                                            descriptor["path"])
    _recheck_named_object(
        descriptor, (doc.get("plan") or {}).get("target_identity"),
        session, pack)
    plan_path = path[:-len(".json")] + ".plan.json"
    _write_private_json(plan_path, doc.get("plan") or {})
    plan = load_frozen_plan(plan_path, descriptor.get("name"))
    signed = sign_approval(doc.get("approval") or {}, authorization,
                           channel=channel)
    ctx = dict(mode_ctx) if isinstance(mode_ctx, dict) else None
    target = plan.target_identity or {}
    if ctx and ctx.get("user_id") and not ctx.get("course_resolution") \
            and target.get("course_id") is not None:
        ctx["course_resolution"] = {
            "course_id": target.get("course_id"),
            "confidence": 1.0,
            "user_confirmed": True,
            "basis": "the educator approved the write shown to them, "
                     "which named course %r" % target.get("course_name"),
        }
    body = descriptor.get("body")
    # The educator's reply approved this exact deletion as shown, so it
    # is also the explicit yes that confirm_destructive_writes asks for
    # in edit mode.
    if ctx is not None and not ctx.get("destructive_confirmed") \
            and _is_destructive(catalog_descriptor_to_entry(
                descriptor.get("name"), descriptor.get("method"),
                descriptor.get("path"), None,
                descriptor.get("provider") or "canvas", None,
                {"body": body} if body is not None else None)):
        ctx["destructive_confirmed"] = authorization
    try:
        out = dispatch_catalog_op(
            descriptor.get("name"), descriptor.get("method"),
            descriptor.get("path"), None, descriptor.get("params") or {},
            provider=descriptor.get("provider") or "canvas", plan=plan,
            op_id=plan.op_id, pack=pack,
            extra={"body": body} if body is not None else None,
            approval=signed, session=session, mode_ctx=ctx)
    except Exception:
        # A refusal before the approval was used keeps the prepared
        # write, so the educator's reply can be sent again. Once it was
        # used (the write was attempted), a retry is a new plan-write.
        if approval_used(signed):
            try:
                os.unlink(path)
            except OSError:
                pass
        raise
    finally:
        try:
            os.unlink(plan_path)
        except OSError:
            pass
    try:
        os.unlink(path)
    except OSError:
        pass
    return out


# Final muse audit M2: prepared writes the educator never approved, and
# signed approval records of finished writes, do not stay on disk
# forever. A prepared write goes when its approval expires; a signed
# approval record goes a day after its expiry (the browser lane's
# complete phase re-reads it within minutes). consumed.json, the
# single-use replay guard, is never touched here. Every purge removes
# them too (privacy/executor_wire.purge_*).
APPROVAL_RECORD_RETENTION = timedelta(hours=24)


def _approvals_dir():
    from dispatch import admission as _adm
    return _adm.APPROVALS_DIR


def _record_expiry(record, fallback_path):
    expires = None
    if isinstance(record, dict):
        try:
            expires = datetime.fromisoformat(
                str(record.get("expires_at")))
        except ValueError:
            expires = None
    if expires is None or expires.tzinfo is None:
        try:
            mtime = os.path.getmtime(fallback_path)
        except OSError:
            return None
        expires = datetime.fromtimestamp(
            mtime, timezone.utc) + timedelta(days=1)
    return expires


def _ceremony_files():
    """[(kind, path, approval record or None)] for every prepared write
    and every signed approval record on disk."""
    out = []
    pending_dir = os.path.join(MORROW_HOME, PENDING_WRITES_DIRNAME)
    for path in sorted(glob.glob(os.path.join(pending_dir, "*.json"))):
        if path.endswith(".plan.json"):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            doc = {}
        out.append(("pending", path, (doc or {}).get("approval")
                    if isinstance(doc, dict) else None))
    approvals = _approvals_dir()
    for path in sorted(glob.glob(os.path.join(approvals, "*.json"))):
        stem = os.path.basename(path)[:-len(".json")]
        try:
            check_uuid(stem)
        except Exception:
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                record = json.load(fh)
        except (OSError, ValueError):
            record = None
        out.append(("approval", path, record))
    return out


def _remove_ceremony_file(kind, path):
    removed = False
    for target in ((path, path[:-len(".json")] + ".plan.json")
                   if kind == "pending" else (path,)):
        try:
            os.unlink(target)
            removed = removed or target == path
        except OSError:
            pass
    return removed


def expire_write_ceremony_files(now=None, quiet=False) -> dict:
    """Remove expired prepared writes and old signed approval records.

    Runs at every plan-write and approve-write; quiet=True never
    raises. Returns {"pending_writes_removed", "approval_records_removed"}."""
    now = now or datetime.now(timezone.utc)
    report = {"pending_writes_removed": 0, "approval_records_removed": 0}
    try:
        for kind, path, record in _ceremony_files():
            expires = _record_expiry(record, path)
            if expires is None:
                continue
            if kind == "approval":
                expires = expires + APPROVAL_RECORD_RETENTION
            if expires < now and _remove_ceremony_file(kind, path):
                report["pending_writes_removed" if kind == "pending"
                       else "approval_records_removed"] += 1
    except Exception:
        if not quiet:
            raise
    return report


def purge_write_ceremony_files(tenant_base=None, course_id=None) -> dict:
    """Remove prepared writes and signed approval records for one tenant
    (and optionally one course on it), or every one when tenant_base is
    None. Returns the same report shape as expire_write_ceremony_files."""
    def norm(base):
        return str(base or "").strip().rstrip("/").lower()
    report = {"pending_writes_removed": 0, "approval_records_removed": 0}
    for kind, path, record in _ceremony_files():
        if tenant_base is not None:
            target = (record or {}).get("target") \
                if isinstance(record, dict) else None
            target = target if isinstance(target, dict) else {}
            if norm(target.get("tenant")) != norm(tenant_base):
                continue
            if course_id is not None and \
                    str(target.get("course_id")) != str(course_id):
                continue
        if _remove_ceremony_file(kind, path):
            report["pending_writes_removed" if kind == "pending"
                   else "approval_records_removed"] += 1
    return report


def _load_plan(text: str) -> bytes:
    if not text:
        return None
    return text


def _transport_dir():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "..", "transport")


def _chromium_session_mod():
    """Lazy import: chromium_session imports this module, so it must load
    after. Importing (or constructing a session from) this module never
    starts Chromium; the browser starts lazily on the first provider call."""
    tdir = _transport_dir()
    if tdir not in sys.path:
        sys.path.insert(0, tdir)
    import chromium_session
    return chromium_session


def _check_claim_release_reason(reason):
    # W6-P2-D2: "OPERATOR ONLY" is enforced as far as code can: the
    # reason must be a real reconciliation note, not a stub.
    if len((reason or "").strip()) < 20:
        raise ExecutorError(
            "claim-release --reason must be at least 20 characters: "
            "state what you reconciled against the provider "
            "('fixed it' is not a reconciliation)")


def _require_destructive_confirm(command, warning, yes):
    """W6-P1-D1: destructive journal/claim commands need an explicit,
    informed confirmation. --yes skips the interactive prompt (for
    scripts) but still prints the warning; without --yes on a
    non-interactive stdin the command is REFUSED rather than run
    blind."""
    if yes:
        print("WARNING: --yes given; running %s. %s" % (command, warning),
              file=sys.stderr)
        return
    if not sys.stdin.isatty():
        raise ConfirmationRequired(
            "%s is destructive: %s Re-run with --yes to confirm, or run "
            "this command interactively to be prompted." % (command, warning))
    print("WARNING: %s" % warning, file=sys.stderr)
    try:
        answer = input("Type 'yes' to run %s: " % command).strip()
    except EOFError:
        answer = ""
    if answer != "yes":
        raise ExecutorError("%s aborted by operator" % command)


def build_parser():
    """The executor CLI's argument parser (main parses with it)."""
    parser = argparse.ArgumentParser(
        description="Morrow Direct dispatch executor")
    parser.add_argument("--session", default=SESSION_PATH,
                        help="path to session.json (https backend only)")
    parser.add_argument("--canvas-base", default=None,
                        help="Canvas base URL override (chromium backend; "
                             "default precedence: this flag, CANVAS_BASE "
                             "from the environment or this tree's "
                             "helper/env, then the lane state store)")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_backend(p):
        # Accepted after the command too. SUPPRESS leaves the top-level
        # value in place when the flag is not repeated here.
        p.add_argument("--canvas-base", default=argparse.SUPPRESS,
                       help="the same Canvas base URL override as "
                            "--canvas-base before the command")
        p.add_argument("--backend", default="chromium", choices=("https", "chromium"),
                       help="chromium: synchronous executor through the local "
                            "Chromium's authenticated tab via CDP on "
                            "127.0.0.1:19223 (same governance as https; the "
                            "browser owns the session, so no credential "
                            "injection). https: raw-HTTPS executor (PAT lane; "
                            "the cookie-jar replay was retired 2026-09-20).")

    def add_dry_run(p):
        p.add_argument("--dry-run", action="store_true",
                       help="W4-P2-26: evaluate every gate and render the "
                            "exact request the write would send (method, URL, "
                            "redacted headers, body), without sending "
                            "anything and without journaling anything: no "
                            "op_id claim, no approval persistence or "
                            "consumption, zero provider calls. Gates that "
                            "need provider reads are reported as skipped.")

    def add_channel_gate(p):
        # W6-P1-A2: the production dispatch path requires an approval
        # captured from the educator's own reply (channel educator-chat);
        # driver-channel records (proof drivers, scripts) are refused
        # unless this escape hatch is passed explicitly.
        p.add_argument("--allow-driver-channel", action="store_true",
                       help="W6-P1-A2: admit approval records stamped "
                            "channel=driver (proof drivers, scripted tests). "
                            "Without it, only educator-chat approvals are "
                            "admitted on this path.")

    def add_mode_ctx(p):
        # Plan/Edit mode gate (modes workstream). With no user id at all
        # (no flag, no MORROW_USER_ID, no pinned account) the gate fails
        # closed to the legacy plan-mode approval path.
        p.add_argument("--user-id", default=None,
                       help="mode gate: the calling user's id (default: "
                            "env MORROW_USER_ID, then the Canvas account "
                            "pinned at first sign-in)")
        p.add_argument("--conversation-id", default=None,
                       help="mode gate: the Muse conversation id, for "
                            "conversation-scoped grants "
                            "(env MORROW_CONVERSATION_ID is the default)")
        p.add_argument("--course-resolution", default=None,
                       help="mode gate: course-resolution JSON "
                            "{\"course_id\": ..., \"confidence\": 0-1, "
                            "\"user_confirmed\": bool, \"query\": ..., "
                            "\"candidates_public\": [...]}; writes below "
                            "0.9 confidence without confirmation are "
                            "refused, never guessed")
        p.add_argument("--destructive-confirmed", default=None,
                       help="mode gate: the educator's verbatim yes for "
                            "this destructive write (required in edit mode "
                            "while confirm_destructive_writes is on)")

    p_exec = sub.add_parser("execute", help="execute one manifest entry")
    p_exec.add_argument("--entry", required=True, help="path to the manifest entry JSON")
    p_exec.add_argument("--params", default="{}", help="params as a JSON object string")
    p_exec.add_argument("--plan", default=None, help="path to the frozen plan file (required for writes)")
    p_exec.add_argument("--op-id", default=None, help="op id UUID (defaults to the plan's)")
    p_exec.add_argument("--approval", default=None,
                        help="path to an educator-signed v2 approval record JSON (required for writes); "
                        "must be digest-bound to this exact action, unexpired, category-scoped, "
                        "and unused (see dispatch/admission.mint_approval)")
    add_backend(p_exec)
    add_mode_ctx(p_exec)
    add_dry_run(p_exec)
    add_channel_gate(p_exec)

    p_cat = sub.add_parser("catalog", help="dispatch one catalog operation descriptor")
    p_cat.add_argument("--name", required=True)
    p_cat.add_argument("--method", required=True)
    p_cat.add_argument("--path", required=True, help="path template, e.g. /api/v1/courses/{course_id}")
    p_cat.add_argument("--class", dest="effect_class", required=False, default=None, choices=("read", "write", "plan"),
                       help="optional cross-check against the catalog row's own R/W column "
                            "(R -> read, W -> write); a contradicting declaration refuses the dispatch. "
                            "Omit to use the catalog's class; required only for names the catalog "
                            "does not know.")
    p_cat.add_argument("--params", default="{}", help="params as a JSON object string")
    p_cat.add_argument("--body", default=None,
                       help="request body as a JSON object string, or a "
                            "JSON array of objects for the bulk date update "
                            "(the write's intent; the readback compares "
                            "against it). Values may reference params as "
                            "\"params.<name>\"")
    p_cat.add_argument("--provider", default="canvas")
    p_cat.add_argument("--slot", default=None, help="credential slot override (https backend only)")
    p_cat.add_argument("--plan", default=None, help="frozen plan file (required for writes)")
    p_cat.add_argument("--op-id", default=None)
    p_cat.add_argument("--approval", default=None,
                       help="path to an educator-signed v2 approval record JSON (required for writes); "
                        "must be digest-bound to this exact action, unexpired, category-scoped, "
                        "and unused (see dispatch/admission.mint_approval)")
    add_backend(p_cat)
    add_mode_ctx(p_cat)
    add_dry_run(p_cat)
    add_channel_gate(p_cat)

    p_pw = sub.add_parser(
        "plan-write",
        help="Plan mode: prepare one catalog write for the educator's "
             "approval. Reads the course, builds the frozen plan and the "
             "approval bound to the exact request, prints the approval "
             "display to show the educator. Sends nothing.")
    p_pw.add_argument("--name", required=True)
    p_pw.add_argument("--method", required=True)
    p_pw.add_argument("--path", required=True,
                      help="path template, e.g. /api/v1/courses/{course_id}")
    p_pw.add_argument("--params", default="{}",
                      help="params as a JSON object string (include "
                           "course_id for a course write)")
    p_pw.add_argument("--body", default=None,
                      help="request body as a JSON object string, or a "
                           "JSON array of objects for the bulk date update")
    p_pw.add_argument("--provider", default="canvas")
    add_backend(p_pw)
    add_mode_ctx(p_pw)
    p_aw = sub.add_parser(
        "approve-write",
        help="Plan mode: the educator approved a prepared write. Signs "
             "their verbatim reply and sends the write in one call.")
    p_aw.add_argument("--op-id", required=True,
                      help="the op_id plan-write printed")
    p_aw.add_argument("--authorization", required=True,
                      help="the educator's reply approving the write, "
                           "verbatim (any non-empty reply, e.g. \"Yes\")")
    add_backend(p_aw)
    add_mode_ctx(p_aw)

    p_undo = sub.add_parser("undo", help="run an entry's undo block as a new op")
    p_undo.add_argument("--entry", required=True)
    p_undo.add_argument("--of-op-id", required=True, help="original op id being undone")
    p_undo.add_argument("--params", default="{}", help="original params as a JSON object string")
    p_undo.add_argument("--result", default="{}",
                        help="optional: the original result payload as a "
                             "JSON object string. The undo target comes "
                             "ONLY from the journaled receipt of "
                             "--of-op-id; a payload that disagrees with it "
                             "is refused")
    p_undo.add_argument("--approval", default=None,
                        help="path to an educator-signed v2 approval record JSON (undo is a write); "
                             "must be digest-bound to this exact undo, unexpired, category-scoped, "
                             "and unused")
    add_backend(p_undo)
    add_mode_ctx(p_undo)

    p_seal = sub.add_parser("journal-seal",
                   help="one-time re-seal of a pre-HMAC journal: adopt the "
                        "current journal bytes as the integrity trust anchor "
                        "(W4-P0-1 upgrade path). WARNING: sealing cannot "
                        "detect tampering that happened BEFORE the seal; it "
                        "blesses whatever bytes exist right now. Reconcile "
                        "first.")
    p_seal.add_argument("--yes", action="store_true",
                        help="confirm the destructive re-seal without an "
                             "interactive prompt")
    p_repair = sub.add_parser("journal-repair",
                   help="quarantine a torn journal tail, truncate to the last "
                        "good line, and re-seal")
    p_repair.add_argument("--yes", action="store_true",
                        help="confirm the destructive repair without an "
                             "interactive prompt")
    sub.add_parser("journal-pending",
                   help="W5-P1-3: list pending write claims with no "
                        "completion record (the reconcile list; a crashed "
                        "dispatch leaves exactly this)")
    p_recon = sub.add_parser(
        "journal-reconcile",
        help="W6-P1-2: post-restore reconcile. Verifies the journal, the "
             "sealed sidecar index, and the retired set seal, re-anchors "
             "the index generation past the high-water mark, and clears "
             "the restore marker that keeps the journal fail-closed "
             "after a restore. Refuses a STALE restore (restore the "
             "newest backup instead).")
    p_recon.add_argument("--yes", action="store_true",
                         help="confirm the trust re-anchor without an "
                              "interactive prompt")
    p_recsec = sub.add_parser(
        "journal-recover-secret",
        help="W6-P1-3: OPERATOR ONLY. Secret-loss recovery: quarantine "
             "the corrupt secret, mint a new one, and re-seal every "
             "record under it, preserving the op_id replay-protection "
             "set. Cryptographic provenance of old records is "
             "downgraded to operator attestation: reconcile in-flight "
             "ops against the provider FIRST.")
    p_recsec.add_argument("--reason", required=True,
                          help="reconciliation note, journaled in the "
                               "recovery audit record (minimum 20 "
                               "characters: 'fixed it' is not a "
                               "reconciliation).")
    p_recsec.add_argument("--yes", action="store_true",
                          help="confirm the re-key without an interactive "
                               "prompt")
    p_rseal = sub.add_parser(
        "retired-seal",
        help="W6-P1-5: one-time adoption of a pre-seal retired op_id "
             "set. Seals the current retired_opids.jsonl with the "
             "active journal secret. WARNING: sealing cannot detect "
             "tampering that happened BEFORE the seal; reconcile first.")
    p_rseal.add_argument("--yes", action="store_true",
                         help="confirm the adoption without an "
                              "interactive prompt")
    p_rel = sub.add_parser(
        "claim-release",
        help="W5-P1-3: OPERATOR ONLY. Forcibly release a dangling journal "
             "claim without the claim token, freeing the op_id. Use only "
             "after reconciling the op against the provider (a crashed "
             "dispatch whose in-memory token died with the process). The "
             "release is journaled with forced=true and your reason.")
    p_rel.add_argument("--op-id", required=True,
                       help="op id whose live claim to release")
    p_rel.add_argument("--reason", required=True,
                       help="reconciliation note, journaled with the release "
                            "(e.g. 'crashed dispatch; provider confirms no "
                            "effect'). Minimum 20 characters: 'fixed it' is "
                            "not a reconciliation.")
    p_rel.add_argument("--yes", action="store_true",
                       help="confirm the forced release without an "
                            "interactive prompt")
    sub.add_parser(
        "rotate-secret",
        help="W6-P1-2: OPERATOR ONLY. Rotate the tree's journal HMAC "
             "secret: mint a fresh 256-bit key as the active sealing key "
             "and keep retired keys for verification, so pre-rotation "
             "records keep verifying. New seals use the new key "
             "immediately.")
    sub.add_parser(
        "reseal-journal",
        help="W6-P1-2: OPERATOR ONLY. Re-seal every journal record under "
             "the ACTIVE secret (each verified against the keyring "
             "first; tampered records fail closed, never re-blessed). "
             "Run after rotate-secret and before retire-secret.")
    p_retire = sub.add_parser(
        "retire-secret",
        help="W6-P1-2: OPERATOR ONLY. Drop a retired journal HMAC key "
             "from the keyring so it can no longer verify or forge "
             "records. Refuses the active key, unknown ids, and any key "
             "that still seals live records (run reseal-journal first).")
    p_retire.add_argument("key_id",
                          help="retired key id to drop (e.g. v1)")
    sub.add_parser(
        "sweep-expired-claims",
        help="W6-P2-5: release journal claims older than their TTL "
             "(pending/browser writes: 7 days; claimed/reads: 24h) via "
             "the forced-release path. Raw-lane crashed claims no longer "
             "persist indefinitely.")
    add_dry_run(p_undo)
    add_channel_gate(p_undo)
    return parser


def main(argv=None):
    """Run one CLI command. A failure raised before this run claimed a
    write carries nothing_sent=True, so the failure translator never
    tells the educator that a change might have been made."""
    claims_before = _WRITE_CLAIMS[0]
    try:
        return _run_cli(argv)
    except Exception as exc:
        if _WRITE_CLAIMS[0] == claims_before:
            try:
                exc.nothing_sent = True
            except Exception:
                pass
        raise


def _run_cli(argv=None):
    # W5-P2-1: graceful SIGTERM/SIGINT handling for the whole CLI.
    _install_shutdown_handlers()
    args = build_parser().parse_args(argv)
    for flag, attr in (("--op-id", "op_id"), ("--of-op-id", "of_op_id")):
        if getattr(args, attr, None) is not None:
            setattr(args, attr, _caller_op_id(getattr(args, attr), flag))
    # Only the shipped pack runs from the CLI: a caller-chosen pack would
    # let the caller pin any entry it authored, so there is no --pack
    # flag and no environment override.
    pack = load_pack(DEFAULT_PACK)

    def need_chromium_session():
        csm = _chromium_session_mod()
        return csm.ChromiumSession.load(base_url=args.canvas_base)

    def close_chromium_session(session):
        # P2-12: stop an executor-launched Chromium on the success path
        # too (failure paths already stop it in ChromiumSession). Only
        # self-launched browsers are stopped; the attached live-helper
        # browser on 19223 is never touched. Defensive: sessions other
        # than ChromiumSession have no close().
        close = getattr(session, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass

    if args.command == "execute":
        entry = load_manifest_entry(args.entry, pack)
        params = _load_params(args.params)
        plan = load_frozen_plan(args.plan, entry.get("name")) if args.plan else None
        approval = _load_approval(args.approval)
        mode_ctx = _mode_ctx_from_args(args)
        if args.backend == "chromium":
            session = need_chromium_session()
            try:
                out = dispatch_entry(entry, params, session, pack,
                                     plan=plan, op_id=args.op_id,
                                     approval=approval,
                                     dry_run=args.dry_run,
                                     require_educator_channel=not args.allow_driver_channel,
                                     mode_ctx=mode_ctx)
            finally:
                close_chromium_session(session)
        else:
            session = SessionStore.load(args.session)
            out = dispatch_entry(entry, params, session, pack, plan=plan,
                                 op_id=args.op_id, approval=approval,
                                 dry_run=args.dry_run,
                                 require_educator_channel=not args.allow_driver_channel,
                                 mode_ctx=mode_ctx)
        print(canonical(out))
    elif args.command == "catalog":
        params = _load_params(args.params)
        extra = None
        if args.body is not None:
            extra = {"body": _load_body(args.body)}
        plan = load_frozen_plan(args.plan, args.name) if args.plan else None
        approval = _load_approval(args.approval)
        mode_ctx = _mode_ctx_from_args(args)
        if args.backend == "chromium":
            session = need_chromium_session()
            try:
                out = dispatch_catalog_op(args.name, args.method, args.path,
                                          args.effect_class, params,
                                          provider=args.provider, auth_slot=args.slot,
                                          plan=plan, op_id=args.op_id, pack=pack,
                                          extra=extra, approval=approval,
                                          session=session,
                                          dry_run=args.dry_run,
                                          require_educator_channel=not args.allow_driver_channel,
                                          mode_ctx=mode_ctx)
            finally:
                close_chromium_session(session)
        else:
            out = dispatch_catalog_op(args.name, args.method, args.path,
                                      args.effect_class, params,
                                      provider=args.provider, auth_slot=args.slot,
                                      plan=plan, op_id=args.op_id, pack=pack,
                                      extra=extra, approval=approval,
                                      dry_run=args.dry_run,
                                      require_educator_channel=not args.allow_driver_channel,
                                      mode_ctx=mode_ctx)
        print(canonical(out))
    elif args.command in ("plan-write", "approve-write"):
        session = need_chromium_session() if args.backend == "chromium" \
            else SessionStore.load(args.session)
        try:
            if args.command == "plan-write":
                body = None
                if args.body is not None:
                    body = _load_body(args.body)
                mode_ctx = _mode_ctx_from_args(args) or {}
                out = prepare_plan_write(
                    args.name, args.method, args.path,
                    _load_params(args.params), body, session, pack,
                    provider=args.provider,
                    conversation_id=mode_ctx.get("conversation_id"),
                    user_id=mode_ctx.get("user_id"))
            else:
                out = approve_plan_write(args.op_id, args.authorization,
                                         session, pack,
                                         mode_ctx=_mode_ctx_from_args(args))
        finally:
            close_chromium_session(session)
        print(canonical(out))
    elif args.command == "undo":
        entry = load_manifest_entry(args.entry, pack)
        params = _load_params(args.params)
        result_payload = _load_params(args.result)
        approval = _load_approval(args.approval)
        mode_ctx = _mode_ctx_from_args(args)
        if args.backend == "chromium":
            session = need_chromium_session()
            try:
                out = dispatch_undo(entry, params, result_payload, args.of_op_id,
                                    session, pack, approval=approval,
                                    dry_run=args.dry_run,
                                    require_educator_channel=not args.allow_driver_channel,
                                    mode_ctx=mode_ctx)
            finally:
                close_chromium_session(session)
        else:
            session = SessionStore.load(args.session)
            out = dispatch_undo(entry, params, result_payload, args.of_op_id,
                                session, pack, approval=approval,
                                dry_run=args.dry_run,
                                require_educator_channel=not args.allow_driver_channel,
                                mode_ctx=mode_ctx)
        print(canonical(out))
    elif args.command == "journal-seal":
        _require_destructive_confirm(
            "journal-seal",
            "this adopts the CURRENT journal bytes as the integrity trust "
            "anchor; tampering that happened before this moment will be "
            "blessed, not detected.",
            args.yes)
        print(canonical(journal_seal()))
    elif args.command == "journal-repair":
        _require_destructive_confirm(
            "journal-repair",
            "this truncates the journal to the last good line; the torn "
            "tail is quarantined to a .torn file, but the truncation "
            "itself cannot be undone.",
            args.yes)
        print(canonical(journal_repair()))
    elif args.command == "journal-pending":
        print(canonical({"pending": journal_pending_ops()}))
    elif args.command == "journal-reconcile":
        _require_destructive_confirm(
            "journal-reconcile",
            "this re-anchors the journal's trust generation and clears "
            "the restore marker, unblocking dispatch on the restored "
            "state; a stale restore is refused, but a current restore "
            "is blessed only after you reconciled in-flight ops against "
            "the provider.",
            args.yes)
        print(canonical(journal_reconcile()))
    elif args.command == "journal-recover-secret":
        _check_claim_release_reason(args.reason)
        _require_destructive_confirm(
            "journal-recover-secret",
            "this re-keys the journal under a NEW secret and re-seals "
            "every record WITHOUT verifying the old seals (the secret "
            "is lost): provenance is downgraded to your attestation. "
            "Use only after reconciling in-flight ops against the "
            "provider, and only when the secret cannot be restored from "
            "an encrypted backup.",
            args.yes)
        print(canonical(journal_recover_secret(args.reason)))
    elif args.command == "retired-seal":
        _require_destructive_confirm(
            "retired-seal",
            "this adopts the CURRENT retired_opids.jsonl bytes as the "
            "integrity trust anchor; tampering that happened before "
            "this moment will be blessed, not detected. Reconcile "
            "first.",
            args.yes)
        print(canonical(retired_seal()))
    elif args.command == "claim-release":
        # W6-P2-D2: "OPERATOR ONLY" is enforced as far as code can: the
        # reason must be a real reconciliation note, and the release
        # needs the same explicit confirmation as the other destructive
        # commands. There is no separate operator identity on this
        # machine; the journaled forced=true record is the audit trail.
        _check_claim_release_reason(args.reason)
        _require_destructive_confirm(
            "claim-release",
            "this forcibly releases a live journal claim WITHOUT the "
            "claim token. Use only after reconciling the op against the "
            "provider.",
            args.yes)
        print(canonical(release_op_id_forced(check_uuid(args.op_id),
                                             args.reason)))
    elif args.command == "rotate-secret":
        # W6-P1-2: operator-driven rotation of the journal HMAC secret.
        # Takes the journal lock (rotate_journal_secret requires it).
        with _journal_locked():
            kid = rotate_journal_secret()
        print(canonical({"rotated": True, "active_key_id": kid,
                         "detail": "new journal HMAC key %s is active; "
                                   "retired keys kept for verification; run "
                                   "reseal-journal then retire-secret "
                                   "<old-kid> to fully expire the old key"
                                   % kid}))
    elif args.command == "reseal-journal":
        print(canonical(reseal_journal()))
    elif args.command == "retire-secret":
        print(canonical(retire_journal_secret(args.key_id)))
    elif args.command == "sweep-expired-claims":
        print(canonical(sweep_expired_claims()))
    return 0
# --------------------------------------------------------------------------
# Agent-facing error funnel (failures/ translation layer).
#
# Every exception escaping main() is translated through
# failures/funnel.py before it reaches the agent: the agent sees the
# translated four-part message first, and raw exception text only in a
# clearly-labeled, sanitized, truncated engineering_detail field. The
# funnel is the single agent-facing error surface for admission
# refusals, governance refusals, write-outcome errors, journal
# integrity failures, session-death detection, and transport backend
# errors: they all propagate through main(). Exit code stays 2 and the
# "error" key keeps the exception class name; "detail" is gone on
# purpose (raw text is never the primary message again).
# --------------------------------------------------------------------------

def _describe_operation(method, path, where=None):
    from dispatch.approval_display import describe_operation
    return describe_operation(method, path, where)


# Options before the command that take a value (build_parser).
_TOP_LEVEL_VALUE_FLAGS = ("--session", "--canvas-base")


def _funnel_operation(argv, exc=None):
    """What was attempted, in the words the educator reads: "changing a
    page in course 101". approve-write labels its own failures with the
    course name the educator approved (OPERATION_LABEL_ATTR). Otherwise
    the label comes from the method and path template; the only flag
    value read is a numeric course_id. Op ids, command and operation
    names, and file paths never become the label.
    """
    label = getattr(exc, OPERATION_LABEL_ATTR, None)
    if isinstance(label, str) and label:
        return label
    tokens = list(argv or [])

    def _flag(name):
        for i, token in enumerate(tokens):
            if token == name and i + 1 < len(tokens):
                return tokens[i + 1]
            if token.startswith(name + "="):
                return token[len(name) + 1:]
        return None

    subcommand = None
    skip_value = False
    for token in tokens:
        if skip_value:
            skip_value = False
        elif token in _TOP_LEVEL_VALUE_FLAGS:
            skip_value = True
        elif not token.startswith("-"):
            subcommand = token
            break
    if subcommand in ("catalog", "plan-write"):
        method, path = _flag("--method"), _flag("--path")
        if not (method and path):
            return "the Canvas request you asked for"
        try:
            course_id = str(json.loads(_flag("--params") or "{}")
                            .get("course_id", ""))
        except (ValueError, AttributeError):
            course_id = ""
        where = "course %s" % course_id if course_id.isdigit() else None
        return _describe_operation(method, path, where)
    if subcommand == "approve-write":
        return "the change you approved"
    if subcommand == "execute":
        return "the task you asked for"
    if subcommand == "undo":
        return "undoing an earlier change"
    if subcommand:
        return "a Morrow maintenance step"
    return "the step you asked for"


def _agent_error(argv, exc):
    """The agent-facing payload for an exception escaping main()."""
    from failures.funnel import agent_error_payload
    return agent_error_payload(_funnel_operation(argv, exc), exc)


def _script_main(argv):
    """The CLI entry for every documented way to start the executor."""
    try:
        return main(argv)
    except SystemExit:
        raise
    except Exception as exc:
        # Agent-facing error funnel: translate before the agent sees it.
        try:
            payload = _agent_error(argv, exc)
        except Exception:
            # The translation layer itself failed: degrade to the old
            # shape rather than a traceback.
            payload = {"error": type(exc).__name__,
                       "detail": _provider_detail(exc, 500)}
        print(json.dumps(payload), file=sys.stderr)
        return 2
