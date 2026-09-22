"""Shared learner-data projection for executor read paths.

The ported SourceMcpPrivacyBoundary (privacy/boundary.py) projects
provider receipts through receipt-derived rosters into stable
"Student A<n>" labels. This module is the single implementation of
that projection for every executor read path:

- dispatch/executor.py dispatch_entry (the live Chromium lane) calls
  project_learner_result() before journaling and returning.
- transport/browser_backend.py _project_learner_result delegates here,
  so the proof-battery lane and the live lane share one implementation.

error_cls is injected (the module must not import dispatch.executor;
executor.py imports this module). lane_context may carry principal,
session_generation, and lane_state (a mapping with per-provider
session_generation).
"""

import hashlib
import os
import re
import stat
import sys
import urllib.parse
from datetime import datetime, timezone

# W4-P1-17: config.paths is the single source of truth for the morrow
# state root. executor_wire can be imported before dispatch.executor
# inserts the tree root, so insert it here (no-op when already present).
_EW_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _EW_TREE_ROOT not in sys.path:
    sys.path.insert(0, _EW_TREE_ROOT)

from dispatch import admission as _admission

from privacy import boundary as _boundary
from privacy import core as _privacy_core

# W3-P1-44: reveal consent provenance. A bare environment variable is NOT
# consent: the educator's reveal decision is honored only when they have
# created the consent file <tree-state-dir>/educator_pii_reveal by hand.
# The file existing is the consent act; its content is the documented
# instructional purpose. MORROW_REVEAL_STUDENT_PII_REASON is ignored: an
# agent that can set its own environment could otherwise consent to its
# own PII reveal.
CONSENT_BASENAME = "educator_pii_reveal"
CONSENT_REASON_MIN_LEN = 12
SOURCE_VAULT_ENV_VAR = "MORROW_SOURCE_VAULT_PATH"
SOURCE_VAULT_BASENAME = "morrow_source_vault.json"
_COURSE_ID_RE = re.compile(r"/courses/(\d+)", re.IGNORECASE)

# Fields that, together with an "id", mark a bare dict as a learner
# record. Plain "name" is deliberately excluded: assignments, courses,
# sections, and groups all have names; only user objects carry these
# (mirrors the legacy learner_vault.IDENTITY_FIELDS discriminator).
_ROSTER_IDENTITY_FIELDS = frozenset({
    "email", "login_id", "sis_user_id", "sis_login_id",
    "sortable_name", "short_name",
})
_ROSTER_USER_KEYS = frozenset({"user", "student", "author"})
_ROSTER_NAME_KEYS = ("name", "fullname", "display_name", "sortable_name",
                     "short_name")
_ROSTER_PASSTHROUGH_KEYS = ("email", "login_id", "sis_user_id", "sis_login_id",
                            "sortable_name", "short_name", "display_name",
                            "pronouns")
# Routes whose top-level items ARE people (the user-collection reads and
# a single user under them), so even a bare {"id", "name"} is a person.
_USER_COLLECTION_RE = re.compile(
    r"/(?:users|students|search_users|recent_students|gradeable_students|"
    r"potential_collaborators)(?:/\d+)?/?$", re.IGNORECASE)


def _source_vault_path():
    """Educator-local source vault file. Labels persist here (0600), so
    Student A<n> labels stay stable across processes for a course scope.
    Tests point MORROW_SOURCE_VAULT_PATH at scratch."""
    # W4-P1-17: single source of truth for the morrow state root.
    from config.paths import morrow_home  # noqa: E402
    override = os.environ.get(SOURCE_VAULT_ENV_VAR)
    if override:
        return override
    return os.path.join(morrow_home(), SOURCE_VAULT_BASENAME)


def _entry_course_id(entry):
    try:
        urls = _admission.extract_urls(entry)
    except Exception:
        urls = []
    for url in urls:
        match = _COURSE_ID_RE.search(url or "")
        if match:
            return match.group(1)
    return None


def _exact_origin(tenant_base, error_cls):
    parts = urllib.parse.urlsplit(tenant_base or "")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise error_cls(
            "learner-data read refused: the tenant base %r is not an exact "
            "http(s) origin, so no privacy binding can be built"
            % (tenant_base,))
    host = parts.hostname
    port = parts.port
    if port and port not in (80, 443):
        host = "%s:%d" % (host, port)
    return "%s://%s" % (parts.scheme, host)


def _is_user_collection(entry):
    try:
        urls = _admission.extract_urls(entry)
    except Exception:
        urls = []
    for url in urls:
        path = urllib.parse.urlsplit(str(url or "")).path
        if "/users/self" in path:
            continue
        if _USER_COLLECTION_RE.search(path):
            return True
    return False


def _harvest_roster(receipt, items_are_people=False):
    """Recursively harvest learner records from a receipt.

    A dict counts as a learner record when it carries a user_id, or when
    it sits under a user-ish key (user/student/author) or carries one of
    the identity fields and has an id. Records with an id but no name get
    a synthesized "Learner <id>" name: the id itself is still PII and
    must tokenize, and the synthesized name can never leak real PII.
    """
    found = []
    seen = set()

    def learner_id_of(node, in_user_key):
        uid = node.get("user_id")
        if isinstance(uid, (int, str)) and str(uid).strip() != "":
            return str(uid)
        if in_user_key or any(k in node for k in _ROSTER_IDENTITY_FIELDS):
            oid = node.get("id")
            if isinstance(oid, (int, str)) and str(oid).strip() != "":
                return str(oid)
        return None

    def visit(node, in_user_key=False):
        if isinstance(node, dict):
            lid = learner_id_of(node, in_user_key)
            if lid is not None and lid not in seen:
                entry = {"id": node.get("user_id", node.get("id"))}
                name = None
                for key in _ROSTER_NAME_KEYS:
                    value = node.get(key)
                    if isinstance(value, str) and value.strip() != "":
                        name = value
                        break
                entry["name"] = name if name else "Learner %s" % lid
                for key in _ROSTER_PASSTHROUGH_KEYS:
                    value = node.get(key)
                    if isinstance(value, str) and value.strip() != "" \
                            and key not in entry:
                        entry[key] = value
                seen.add(lid)
                found.append(entry)
            for key, value in node.items():
                visit(value, str(key).lower() in _ROSTER_USER_KEYS)
        elif isinstance(node, list):
            for value in node:
                visit(value, in_user_key)

    visit(receipt, items_are_people)
    return found


def _lane_generation(lane_state, provider="canvas"):
    lane = (lane_state or {}).get(provider) or {}
    try:
        return int(lane.get("session_generation", 0) or 0)
    except (TypeError, ValueError):
        return 0


def pii_reveal_audit(error_cls):
    """The explicit educator override for learner-data de-identification.

    W3-P1-44: the environment is not a consent channel. Reveal is
    honored only when the educator has created the consent file
    <tree-state-dir>/educator_pii_reveal: a regular file, mode 0600,
    carrying a documented instructional purpose of at least 12
    characters. The tree state dir honors MORROW_TREE_STATE_DIR, else
    ~/.morrow/trees/<this-tree-slug> (same slug algorithm as
    dispatch/executor; this module must not import dispatch.executor, so
    the resolution is duplicated here).

    Returns None when de-identification applies (no consent file), or an
    audit dict {"revealed_by": "educator-consent-file", "reason": ...,
    "at": ...} when the consent file validates. A malformed consent
    file (not a regular file, wrong mode, stub reason) fails closed: the
    op is refused rather than run half-consented.
    """
    path = os.path.join(_tree_state_dir(), CONSENT_BASENAME)
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode):
        raise error_cls(
            "PII reveal refused: %s exists but is not a regular file; "
            "remove it, or replace it with a regular 0600 file carrying "
            "a documented instructional purpose, to change reveal "
            "behavior" % path)
    mode = stat.S_IMODE(st.st_mode)
    if mode != 0o600:
        raise error_cls(
            "PII reveal refused: %s has mode %o, expected 0600; the "
            "consent file must be readable only by the educator "
            "(chmod 600 %s)" % (path, mode, path))
    try:
        with open(path, "r", encoding="utf-8") as f:
            reason = f.read().strip()
    except OSError as exc:
        raise error_cls(
            "PII reveal refused: cannot read the consent file %s (%s)"
            % (path, exc))
    if len(reason) < CONSENT_REASON_MIN_LEN:
        raise error_cls(
            "PII reveal refused: %s documents a reason of %d characters; "
            "revealing student PII needs a documented instructional "
            "purpose of at least %d characters"
            % (path, len(reason), CONSENT_REASON_MIN_LEN))
    return {"revealed_by": "educator-consent-file",
            "reason": reason,
            "at": datetime.now(timezone.utc).isoformat()}


def _tree_state_dir():
    """Per-tree runtime state dir, mirroring dispatch/executor.

    Duplicated here because this module must not import
    dispatch.executor (executor imports this module). MORROW_TREE_STATE_DIR
    wins; otherwise <morrow-home>/trees/<tree-id>, where the tree id is
    the install-time stable UUID (W4-P1-16) with legacy path-slug fallback.
    Resolved at call time so tests can point it at scratch.
    """
    from config.paths import morrow_home, read_tree_uuid  # noqa: E402
    override = os.environ.get("MORROW_TREE_STATE_DIR")
    if override:
        return override
    home = morrow_home()
    tree_root = os.path.realpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    return os.path.join(home, "trees", read_tree_uuid(tree_root) or
                        _legacy_tree_slug(tree_root))


def _legacy_tree_slug(tree_root):
    """Path-slug fallback for pre-UUID trees (W4-P1-16)."""
    slug = re.sub(r"[^A-Za-z0-9]+", "_", tree_root).strip("_").lower()
    return slug or "tree"


def consent_path():
    """Canonical path of the educator PII-reveal consent file."""
    return os.path.join(_tree_state_dir(), CONSENT_BASENAME)


def project_learner_result(entry, result, tenant_base, lane_context=None,
                           error_cls=Exception):
    """Project one applied result's receipt through the source privacy
    boundary when the entry touches learner data. Returns a new result
    dict (input is not mutated).

    The boundary (privacy/boundary.py, a faithful port of
    SourceMcpPrivacyBoundary) runs its full flow: the binding is
    validated, the complete receipt-derived roster is registered before
    redaction, the binding is checked again after the provider result is
    in hand, legacy donor tokens are refused, and the receipt is
    redacted through the exact-scope roster into stable "Student A<n>"
    labels.

    Fail-closed: a learner-data entry with no course id in its URLs, no
    exact tenant origin, or a roster the boundary rejects (ambiguous
    identities) refuses the op rather than surfacing raw learner PII.

    Explicit educator override (W3-P1-44): the educator's hand-created
    consent file <tree-state-dir>/educator_pii_reveal (regular file, mode
    0600, documented instructional purpose of at least 12 characters)
    skips projection; the consent is journaled as revealed_by
    "educator-consent-file" with the documented reason. A bare
    MORROW_REVEAL_STUDENT_PII_REASON environment variable is ignored: an
    agent that can set its own environment could otherwise consent to its
    own PII reveal. A malformed consent file fails closed. Returns
    (projected_result, reveal_audit_or_None).
    """
    if not _admission.touches_learner_data(entry):
        return result, None
    reveal = pii_reveal_audit(error_cls)
    if reveal is not None:
        revealed = dict(result)
        revealed["pii_reveal"] = reveal
        return revealed, reveal
    provider = entry.get("provider") or "canvas"
    course_id = _entry_course_id(entry)
    if not course_id:
        raise error_cls(
            "entry %r touches learner data but carries no course id in its "
            "URLs; no exact-scope privacy binding can be built, refusing "
            "rather than surfacing raw learner PII" % entry.get("name"))
    origin = _exact_origin(tenant_base, error_cls)
    lane_context = lane_context or {}
    principal = lane_context.get("principal") or "local-educator"
    lane_state = lane_context.get("lane_state")
    binding_id = "exec-%s-%s" % (provider, course_id)
    catalog_digest = hashlib.sha256(_privacy_core.canonical_json({
        "entry": entry.get("name"),
        "provider": provider,
        "course_id": course_id,
        "origin": origin,
    }).encode("utf-8")).hexdigest()

    def current_generation():
        if lane_state is not None:
            try:
                return int(_lane_generation(lane_state, provider))
            except Exception:
                pass
        try:
            return int(lane_context.get("session_generation", 0) or 0)
        except (TypeError, ValueError):
            return 0

    def build_binding():
        return {
            "sourceBindingId": binding_id,
            "provider": provider,
            "courseId": course_id,
            "origin": origin,
            "runtimeVerified": True,
            "principalFingerprint": principal,
            "sessionGeneration": current_generation(),
            "catalogDigest": catalog_digest,
        }

    receipt = result.get("receipt")
    # On a user-collection route the items are people, so even a bare
    # {"id", "name"} joins the roster and is labeled.
    roster_entries = _harvest_roster(receipt, _is_user_collection(entry))
    vault_path = _source_vault_path()
    if _privacy_core.AESGCM is None:
        # Fail closed AND actionable, before the boundary's invoke()
        # swallows the cause into its generic refusal: without the
        # 'cryptography' package the file-backed vault cannot seal or
        # open, so projection is impossible. Name the missing package
        # and the exact fix; the educator must never get a mystery
        # "boundary could not be verified" here. (2026-09-22 first-run
        # audit: the wire previously failed the install's selftest on
        # machines without the optional dependency, and the live lane
        # surfaced the same mystery on learner-data reads.)
        raise error_cls(
            "learner-data projection for entry %r needs the encrypted "
            "learner vault, which needs the 'cryptography' package "
            "(pinned cryptography==50.0.1 in requirements-optional.txt), "
            "and it is not installed. Install it with "
            "'pip install -r requirements-optional.txt', then retry. "
            "Nothing was read and nothing was surfaced."
            % entry.get("name"))
    boundary = _boundary.SourceMcpPrivacyBoundary({
        "bindings": lambda: [build_binding()],
        "load_roster": lambda _b: _boundary.source_privacy_roster(
            roster_entries),
        "source": provider,
        "learner_vault_path": vault_path,
    })
    # invoke() projects tool results as JSON objects, so the receipt
    # rides inside a wrapper and is unwrapped after projection.
    projected = boundary.invoke(
        "exec_read",
        {"source_binding_id": binding_id, "course_id": course_id},
        None,
        lambda _resolved: {"receipt": receipt},
    )
    if isinstance(projected, dict) and projected.get("isError"):
        detail = ""
        try:
            detail = projected["content"][0]["text"]
        except (KeyError, IndexError, TypeError):
            pass
        raise error_cls(
            "learner privacy boundary refused the receipt for entry %r: %s"
            % (entry.get("name"), detail))
    out = dict(result)
    try:
        out["receipt"] = projected["receipt"]
    except (KeyError, TypeError):
        raise error_cls(
            "learner privacy boundary returned an unexpected shape for "
            "entry %r; refusing rather than surfacing raw learner PII"
            % entry.get("name"))
    return out, None


# ---------------------------------------------------------------------------
# W4-P2-10 / W4-P0-4 / W4-P0-5: retention commands for the SHIPPED lane.
#
# The legacy purge/wipe CLIs (privacy/pseudonym.py, privacy/learner_vault.py)
# cover only their own legacy stores and are not shipped. These functions
# are the shipped lane's deletion path: the wired source vault
# (~/.morrow/morrow_source_vault.json, or MORROW_SOURCE_VAULT_PATH) plus
# the browser transient state (pending envelopes with RAW provider
# payloads, brief files) that W4-P0-4/W4-P0-5 found surviving every
# documented deletion.
# ---------------------------------------------------------------------------

def _purge_transient_state():
    """Lazy import: transport.browser_backend imports privacy.learner_vault
    at module top, so importing it here at module top would cycle."""
    from transport import browser_backend as _bb
    return _bb.purge_transient_state()


def purge_tenant(tenant_base, error_cls=Exception):
    """W4-P2-10: drop every shipped-vault record for one tenant (matched
    on the scope's exact canvasOrigin), then purge ALL browser transient
    state (pending envelopes + briefs, W4-P0-4/W4-P0-5: they hold raw
    payloads and cannot be scoped to a tenant).

    The vault map is rewritten atomically (flock + tmp/rename/fsync);
    other tenants' records and the vault key are untouched. Issued
    labels for the purged tenant stop resolving.

    A per-tenant purge of the Chromium profile stores is genuinely not
    feasible: History/Cache/DOM storage mix tenants with no reliable
    per-tenant attribution. The profile is addressed only by
    purge_all() (selective store wipe) or uninstall (whole profile).

    Returns {"tenant", "vault_records_purged", "pending_envelopes_removed",
    "briefs_removed"}.
    """
    origin = _exact_origin(tenant_base, error_cls)
    vault = _privacy_core.LearnerVault(_source_vault_path())
    records = vault.purge_tenant(origin)
    pending, briefs, inflight_skipped = _purge_transient_state()
    return {"tenant": origin, "vault_records_purged": records,
            "pending_envelopes_removed": pending,
            "briefs_removed": briefs,
            "inflight_envelopes_skipped": inflight_skipped}


def purge_course(tenant_base, course_id, error_cls=Exception):
    """Drop every shipped-vault record for one course on one tenant,
    then purge all browser transient state (same un-scopable rationale
    as purge_tenant). Returns the same report shape."""
    origin = _exact_origin(tenant_base, error_cls)
    vault = _privacy_core.LearnerVault(_source_vault_path())
    records = vault.purge_course(origin, course_id)
    pending, briefs, inflight_skipped = _purge_transient_state()
    return {"tenant": origin, "course_id": str(course_id),
            "vault_records_purged": records,
            "pending_envelopes_removed": pending,
            "briefs_removed": briefs,
            "inflight_envelopes_skipped": inflight_skipped}


def purge_all(full_profile=False, error_cls=Exception):
    """Full shipped-lane purge without uninstalling: delete the wired
    source vault file and its .key (issued labels can never resolve
    again), purge ALL browser transient state (W4-P0-4/W4-P0-5), and
    wipe the Chromium profile's learner-data-carrying stores
    (W4-P0-6; selective by default, keeping session cookies so the
    educator stays signed in; full_profile=True wipes the whole
    profile).

    May raise transport.browser_backend.BrowserProfileInUse when a
    Chromium process is running against the profile: stop the helper
    (or the browser) first, then re-run. Returns a report dict.
    """
    from transport import browser_backend as _bb
    report = {"vault_removed": False, "vault_key_removed": False}
    vault_path = _source_vault_path()
    for label, path in (("vault_removed", vault_path),
                        ("vault_key_removed", vault_path + ".key")):
        try:
            os.remove(path)
            report[label] = True
        except OSError:
            pass
    pending, briefs, inflight_skipped = _bb.purge_transient_state()
    report["pending_envelopes_removed"] = pending
    report["briefs_removed"] = briefs
    report["inflight_envelopes_skipped"] = inflight_skipped
    report["profile"] = _bb.purge_browser_profile(full=full_profile)
    return report


# ---------------------------------------------------------------------------
# CLI: retention commands for the SHIPPED lane. W4-P2-10: the shipped lane
# needs a real purge CLI with per-tenant and per-course scoping, not just
# python one-liners.
#
#   python3 -m privacy.executor_wire purge --tenant <base>
#   python3 -m privacy.executor_wire purge-course --tenant <base> --course-id <id>
#   python3 -m privacy.executor_wire purge-all [--full]
#
# Every path also purges ALL browser transient state
# (~/.morrow/browser-pending/ envelopes with raw provider payloads and
# ~/.morrow/browser-briefs/; W4-P0-4/W4-P0-5), which cannot be scoped to a
# tenant or course, so they go on every invocation. purge-all also wipes
# the Chromium profile's learner-data-carrying stores (W4-P0-6; selective
# by default, session cookies kept; --full wipes the whole profile).
# ---------------------------------------------------------------------------

def _cli(argv) -> int:
    import argparse
    import json
    p = argparse.ArgumentParser(
        description="Shipped-lane retention commands. See "
                    "privacy/FERPA_POLICY.md for the residue inventory.")
    sub = p.add_subparsers(dest="command", required=True)
    pt = sub.add_parser("purge",
                        help="drop every shipped-vault record for one tenant")
    pt.add_argument("--tenant", required=True,
                    help="tenant base, e.g. https://school.instructure.com")
    pc = sub.add_parser("purge-course",
                        help="drop every shipped-vault record for one course "
                             "on one tenant")
    pc.add_argument("--tenant", required=True,
                    help="tenant base, e.g. https://school.instructure.com")
    pc.add_argument("--course-id", required=True,
                    help="Canvas course id, e.g. 89585")
    pa = sub.add_parser("purge-all",
                        help="full shipped-lane purge: vault file + .key, all "
                             "browser transient state, and the Chromium "
                             "profile's learner-data-carrying stores")
    pa.add_argument("--full", action="store_true",
                    help="also wipe the WHOLE Chromium profile (default: "
                         "selective store wipe, session cookies kept so the "
                         "educator stays signed in)")
    args = p.parse_args(argv)

    if args.command == "purge":
        report = purge_tenant(args.tenant)
        print(json.dumps({"command": "purge", **report}))
        return 0
    if args.command == "purge-course":
        report = purge_course(args.tenant, args.course_id)
        print(json.dumps({"command": "purge-course", **report}))
        return 0
    try:
        report = purge_all(full_profile=args.full)
    except Exception as exc:
        # W4-P0-6: BrowserProfileInUse must be loud, never silent: the
        # educator has to stop the helper (or the browser) and re-run.
        print(json.dumps({"command": "purge-all", "error": str(exc)}))
        return 1
    print(json.dumps({"command": "purge-all", **report}))
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
