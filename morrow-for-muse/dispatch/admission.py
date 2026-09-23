"""Enforced operation admission gate for Morrow for Muse.

The admission gate runs BEFORE any operation is dispatched, on every lane:
plain HTTPS dispatch, browser-lane dispatch and complete, catalog dispatch,
and undo. It turns the launch blockers into enforced refusals:

  1. never_dispatch  - Standing exclusions plus the catalog's excluded
     set. Never dispatchable, for any caller, even with educator approval.
  2. unsupported     - Catalog-unsupported operations (no working provider
     route). Refused rather than dispatched to fail.
  3. evidence_holds  - Operations that are not yet live-proven through Morrow
     for Muse. Refused on EVERY tenant until a disposable live battery
     proves the complete path; when one is proven it is admitted on ALL
     tenants. There are no tenant allowlists anywhere: no tenant is ever
     gated, restricted, or treated differently from any other.
  4. learner_data    - Operations touching learner PII are refused until the
     learner vault/tokenization boundary lands.
  5. write approval  - effects=write requires an educator-signed approval
     record bound to the specific action. Per-action approval is enforced
     here, not policy text.

Admission policy lives in dispatch/admission_policy.json (machine-readable,
generated from proof-battery/OPERATION_CATALOG.md plus the standing
proof-directive exclusions). The gate matches entry names against the tool-name lists and scans
every request URL the entry would hit against the URL-substring lists,
and every request's query and body for the never-dispatch request flags
(is_announcement: Morrow for Muse never posts an announcement).

Approval records (v2): JSON, either supplied as a dict or read from
~/.morrow/approvals/<op_id>.json. Fields:
    {"version": 2, "by": "educator", "at": "<ISO-8601 issued>",
     "expires_at": "<ISO-8601>", "op": "<entry name>",
     "op_digest": "<sha256 of canonical (op, params, tenant, category,
                    request_digest)>",
     "category": "<operation family, e.g. canvas.assignment>",
     "params_digest": "<sha256 of canonical params>",
     "request": {"method", "url", "path", "query", "body"[, "multi_step"]},
     "request_digest": "<sha256 of the canonical request above>",
     "authorization": "<verbatim educator authorization basis>",
     "channel": "<'educator-chat' | 'driver'>",
     "sig": "<HMAC-SHA256 tamper seal over the other fields>"}
No field of an approval lets a catalog operation that is not marked
live-proven in proof-battery/OPERATION_CATALOG.md run: the executor's
catalog provenance gate refuses it before any approval is read.
The gate recomputes the op digest from the actual dispatch (entry name,
canonical params, tenant base, and the exact request: method, path,
query, and body) and refuses on any mismatch, so one approval
authorizes exactly one request on one tenant. Approvals expire
(time-boxed, max 24h TTL) and are single-use: each minted record
carries a random approval_id under the seal, and its use key (the
op_digest bound to that approval_id) is recorded under
~/.morrow/approvals/consumed.json and refused on replay. A new approval
of the same change (a new plan-write and a new educator reply) has a new
approval_id and is admitted.
Only "educator" is accepted as the approver; the agent cannot
self-approve. v1 records (no digest binding, no expiry, no category) are
retired and refused outright.
"""

from __future__ import annotations

import datetime
import fcntl
import hashlib
import hmac as _hmac
import json
import os
import re
import secrets
import stat
import sys
import unicodedata
import urllib.parse

# W4-P1-17: the morrow state root has ONE source of truth
# (config/paths.morrow_home, honoring MORROW_HOME). Every hardcoded
# ~/.morrow reference in this package resolves through it, so a
# MORROW_HOME override moves the journal, approvals, and signing key
# together instead of stranding the approvals under ~/.morrow.
_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)
from config.paths import morrow_home  # noqa: E402
# W6-P2-7: the signing key is used through a zeroizable buffer, never
# held as long-lived bytes (see config/secretbuf.py).
from config.securebuf import secret_bytes  # noqa: E402

POLICY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "admission_policy.json")
APPROVALS_DIR = os.path.join(morrow_home(), "approvals")
CONSUMED_PATH = os.path.join(APPROVALS_DIR, "consumed.json")
# W6-P2-4: machine-held HMAC key that tamper-seals signed approval
# records. It used to live at <APPROVALS_DIR>/.signing.key, NEXT TO the
# records it seals: anyone able to modify an approval file could read
# the sibling key and re-seal a forgery, which gutted the
# tamper-evidence goal (a forged record was indistinguishable from a
# legitimate one). The key now lives in a SEPARATE secrets directory
# (<morrow_home>/secrets/approval-signing.key, 0700), so a
# write-scoped-to-approvals attacker, or a backup scoped to the
# approvals dir, no longer gets the key together with the records.
# MORROW_APPROVAL_SIGNING_KEY overrides the path entirely (point it at
# a volume excluded from backups to shrink the backup-recovery attack
# in W6-P1-2). The seal binds a record against post-signing
# modification (e.g. editing the file to extend expiry); it does NOT
# authenticate the educator. See the sign_approval docstring for the
# honest trust statement.
SECRETS_DIR = os.path.join(morrow_home(), "secrets")
SIGNING_KEY_PATH = os.environ.get("MORROW_APPROVAL_SIGNING_KEY") or \
    os.path.join(SECRETS_DIR, "approval-signing.key")
_LEGACY_SIGNING_KEY_PATH = os.path.join(APPROVALS_DIR, ".signing.key")

# Approval record version enforced by the gate. v1 (no digest binding,
# no expiry, no category) is retired: check_write_approval refuses it.
APPROVAL_VERSION = 2
# Approvals are time-boxed: an approval may live at most one day.
MAX_APPROVAL_TTL_SECONDS = 24 * 3600
# W5-P1-3: consumed digests are replay-protection, not history. They are
# pruned on every write: a digest consumed longer than this ago can
# never authorize a replay (any approval carrying it is refused as
# expired first: MAX_APPROVAL_TTL_SECONDS plus the issue-skew margin,
# rounded up). The entry cap is a backstop for pathological bursts.
CONSUMED_RETENTION_S = 25 * 3600
CONSUMED_MAX_ENTRIES = 200_000
# In-process cache for _load_consumed (W5-P1-3): (mtime_ns, size) key.
_consumed_cache = None
_consumed_cache_key = None
# The authorization basis is the educator's verbatim reply. Any
# non-empty reply is enough ("Yes" is an approval): what binds it to one
# action is the digest, not the reply's length.
APPROVAL_AUTH_MIN_LEN = 1
# Clock skew tolerated when checking issued-at against now.
_APPROVAL_SKEW_SECONDS = 5 * 60

# Segments dropped when deriving an entry's category from its name:
# action verbs plus articles/prepositions. What remains names the
# operation family (canvas_create_assignment -> canvas.assignment).
_CATEGORY_DROP = {
    "create", "read", "get", "list", "update", "patch", "delete", "remove",
    "attach", "detach", "share", "unshare", "reply", "lock", "unlock",
    "pin", "unpin", "subscribe", "unsubscribe", "publish", "unpublish",
    "archive", "restore", "copy", "move", "new", "to", "of", "a", "an",
    "the", "or", "for", "in", "on", "with", "by",
}

_policy_cache = None


class AdmissionRefused(Exception):
    """Base class: the admission gate refused to dispatch this operation."""


class NeverDispatch(AdmissionRefused):
    """The operation is on the never-dispatch list (standing exclusion / catalog excluded)."""


class UnsupportedOperation(AdmissionRefused):
    """The operation is catalog-unsupported: no working provider route exists."""


class EvidenceHold(AdmissionRefused):
    """The operation is not yet live-proven through Morrow for Muse; refused
    on every tenant until a disposable live battery proves the complete
    path. When proven, it is admitted on ALL tenants. There are no tenant
    allowlists: no tenant is ever gated, restricted, or treated differently
    from any other."""


class LearnerDataGated(AdmissionRefused):
    """The operation touches learner PII and this lane cannot de-identify
    it (no projection point, or no encrypted learner vault)."""


class WriteApprovalMissing(AdmissionRefused):
    """A write was dispatched without an educator-signed approval record."""


class ApprovalMismatch(AdmissionRefused):
    """The approval record does not match this action (wrong op, digest, or approver)."""


def load_policy() -> dict:
    """Load the admission policy JSON (cached)."""
    global _policy_cache
    if _policy_cache is None:
        with open(POLICY_PATH, "r", encoding="utf-8") as f:
            _policy_cache = json.load(f)
    return _policy_cache


def canonical_params_digest(params: dict) -> str:
    """SHA-256 over the canonical (sorted-keys, compact) JSON of params."""
    canonical = json.dumps(params or {}, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=True, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# Learner tokens are lrn_ + 20 hex chars (privacy/learner_vault.py). The
# agent reasons on tokens; there is deliberately NO display renderer that
# turns tokens back into display names. A previous build had one
# (render_approval_display, the only production caller of the vault's
# name-lookup method); it was removed in the wave-3 hardening because no
# connector UX ever called it and a de-tokenizing display path must not
# exist without an explicit educator consent ceremony. Educator consent
# for a write is recorded by sign_approval (agent-relayed educator
# citation, HMAC tamper seal), and the gate binds the signed
# resolved_identities schedule to the op's tokens via
# _check_identity_schedule. No product code may resolve learner names
# for display: a selftest asserts zero non-test call sites of the vault's
# name-lookup method.

_TOKEN_RE = re.compile(r"^lrn_[0-9a-f]{20}$")


def _walk_tokens(obj, found):
    """Collect token-shaped strings in canonical (sorted-key) order."""
    if isinstance(obj, dict):
        for key in sorted(obj.keys(), key=str):
            _walk_tokens(obj[key], found)
    elif isinstance(obj, (list, tuple)):
        for item in obj:
            _walk_tokens(item, found)
    elif isinstance(obj, str) and _TOKEN_RE.match(obj):
        if obj not in found:
            found.append(obj)


def param_tokens(params: dict) -> list:
    """Ordered unique learner tokens in params (canonical walk order)."""
    found = []
    _walk_tokens(params or {}, found)
    return found


def extract_urls(entry: dict) -> list:
    """Collect every request URL template an entry would hit.

    W3-P1-45: query templates ride with the URL they qualify. A learner
    signal carried only in the query (e.g. include[]=enrollments on a
    modules list) must not bypass the learner-data gate, so each
    template is returned with its canonical query text appended.

    Every request-issuing block counts, not only request and
    multi_step: discovery pre-passes, verify readbacks, before_state
    freshness readers, undo, and any other top-level block (or list of
    blocks) carrying a url. A roster read hidden in an auxiliary block
    must meet the same never-dispatch and learner-data gates.
    """
    urls = []
    for key, value in (entry or {}).items():
        if isinstance(value, dict):
            blocks = [value]
        elif isinstance(value, list):
            blocks = [v for v in value if isinstance(v, dict)]
        else:
            continue
        for block in blocks:
            if block.get("url"):
                urls.append(_url_with_query(block))
    return urls


def _url_with_query(block: dict) -> str:
    """A URL template with its query template appended in canonical form."""
    url = str(block.get("url"))
    query = block.get("query")
    if isinstance(query, dict) and query:
        pairs = []
        for key in sorted(query.keys(), key=str):
            pairs.append("%s=%s" % (key, query[key]))
        sep = "&" if "?" in url else "?"
        return url + sep + "&".join(pairs)
    if query:
        sep = "&" if "?" in url else "?"
        return url + sep + str(query)
    return url


def _url_hits_any(url: str, substrings: list) -> str | None:
    lowered = url.lower()
    for sub in substrings:
        if sub.lower() in lowered:
            return sub
    return None


# W3-P1-45: bare learner tokens scanned in query/body signal texts (and in
# the query-augmented URL templates). URL-shaped policy substrings cannot
# see include[]=enrollments because no "/" precedes the value; these
# tokens close that hole. The plural resource nouns are the Canvas
# collection names; the singular _id forms catch identifier parameters
# (student_ids, user_id) that carry learner references in bodies.
_QUERY_BODY_LEARNER_TOKENS = ("enrollments", "students", "users",
                              "student_id", "user_id")


# A JSON object key naming a learner record or learner identifier
# ("user", "student", "enrollment", with optional _id/_ids suffix). The
# substring tokens above catch learner tokens in VALUES (include[]=...);
# this catches them as KEYS, so a body like {"user": {...}} is gated
# without gating prose that merely mentions the word "user".
_LEARNER_KEY_RE = re.compile(
    r'"(?:user|users|student|students|enrollment|enrollments)'
    r'(?:_ids?)?"\s*:')


def _canonical_signal(obj) -> str:
    """Canonical text form of a query/body block for substring scanning."""
    if obj is None:
        return ""
    if isinstance(obj, str):
        return obj
    try:
        return json.dumps(obj, sort_keys=True, default=str,
                          ensure_ascii=True)
    except (TypeError, ValueError):
        return str(obj)


def _payload_signal_texts(entry: dict) -> list:
    """Canonical JSON of the request and multi-step query/body blocks.

    W3-P1-45: query/body content is merged into synthetic catalog entries
    (executor catalog_descriptor_to_entry) but was never scanned by the
    learner-data gate. These texts close that hole.
    """
    texts = []
    try:
        blocks = [entry.get("request") or {}]
    except AttributeError:
        blocks = [{}]
    try:
        for step in entry.get("multi_step") or []:
            if isinstance(step, dict):
                blocks.append(step)
    except AttributeError:
        pass
    for block in blocks:
        if not isinstance(block, dict):
            continue
        for key in ("query", "body"):
            texts.append(_canonical_signal(block.get(key)))
    return [t for t in texts if t]


def _url_segment_hit(url: str, segments: list, suffixes: list) -> str | None:
    """Learner resource named by a literal path segment of url, or None.

    Placeholders ("{course_id}", "{canvas_base}") and the query string
    are ignored; the match is on whole segments, so "bank_entries" is
    not "entries" and "/users/self" is handled by the caller's
    exception list, not here.
    """
    path = (url or "").split("?", 1)[0].split("#", 1)[0]
    wanted = {s.lower() for s in segments}
    tails = tuple(s.lower() for s in suffixes)
    for seg in path.lower().split("/"):
        if not seg or "{" in seg or "}" in seg:
            continue
        if seg in wanted or (tails and seg.endswith(tails)):
            return "segment %r" % seg
    return None


def _learner_signal_hit(entry: dict, policy: dict) -> str | None:
    """First learner-data signal hit for the entry, or None.

    Scans, in order: the catalog row's own [LEARNER-DATA] flag
    (W3-P0-5/W3-P0-9: authoritative per-row classification, fires even
    when no URL substring matches); the URL templates with their query
    templates appended (whole path segments naming a people resource
    first, then the substring net); and the canonical request/multi-step query/body
    texts (W3-P1-45). The /users/self educator exception still exempts
    the educator's own record from URL-derived signals.
    """
    # The catalog flag is authoritative for the row: a flagged row touches
    # learner data no matter what its URL template looks like.
    if entry.get("catalog_learner_data"):
        return "catalog [LEARNER-DATA]"
    ld = policy.get("learner_data", {})
    exceptions = ld.get("url_exceptions", [])
    substrings = ld.get("url_substrings", [])
    segments = ld.get("url_segments", [])
    suffixes = ld.get("url_segment_suffixes", [])

    def scan(text, is_url=False):
        lowered = (text or "").lower()
        if any(exc.lower() in lowered for exc in exceptions):
            return None
        if is_url:
            hit = _url_segment_hit(text, segments, suffixes)
            if hit:
                return hit
        hit = _url_hits_any(text, substrings)
        if hit:
            return hit
        for token in _QUERY_BODY_LEARNER_TOKENS:
            if token in lowered:
                return "learner token %r" % token
        if _LEARNER_KEY_RE.search(text or ""):
            return "learner key"
        return None

    for url in extract_urls(entry):
        hit = scan(url, is_url=True)
        if hit:
            return hit
    for text in _payload_signal_texts(entry):
        hit = scan(text)
        if hit:
            return hit
    return None


_FALSE_FLAG_TEXT = frozenset({"", "0", "false", "f", "no", "n", "off"})
_FORM_KEY_PART_RE = re.compile(r"[A-Za-z0-9_]+")


def _flag_is_false(value) -> bool:
    """True only for a value Canvas reads as false. Anything else, a
    params reference included, may turn the flag on."""
    if value is None or isinstance(value, bool):
        return not value
    if isinstance(value, (int, float)):
        return value == 0
    if isinstance(value, str):
        return value.strip().lower() in _FALSE_FLAG_TEXT
    return False


def _flag_set_in(value, flags) -> str | None:
    """The first flag in flags that a query or body sets to anything but
    false, or None.

    Flags are matched as keys, including form keys such as
    "discussion_topic[is_announcement]", never inside text values, so a
    page body that mentions a flag is not a request to set it. A string
    query or body is read as JSON or as form-encoded pairs.
    """
    if isinstance(value, str):
        text = value.strip()
        if text[:1] in ("{", "["):
            try:
                return _flag_set_in(json.loads(text), flags)
            except ValueError:
                pass
        pairs = urllib.parse.parse_qsl(text.lstrip("?"),
                                       keep_blank_values=True)
        return _flag_set_in([{k: v} for k, v in pairs], flags)
    if isinstance(value, list):
        for item in value:
            hit = _flag_set_in(item, flags)
            if hit:
                return hit
        return None
    if isinstance(value, dict):
        for key, child in value.items():
            parts = _FORM_KEY_PART_RE.findall(str(key))
            flag = next((p for p in parts if p in flags), None)
            if flag and not _flag_is_false(child):
                return flag
            if isinstance(child, (dict, list)):
                hit = _flag_set_in(child, flags)
                if hit:
                    return hit
    return None


def _request_flag_hit(entry: dict, flags) -> str | None:
    """The first never-dispatch request flag any request block of the
    entry sets: in its query, its body, or its URL's own query string."""
    if not flags:
        return None
    for value in (entry or {}).values():
        blocks = [value] if isinstance(value, dict) else \
            [v for v in value if isinstance(v, dict)] \
            if isinstance(value, list) else []
        for block in blocks:
            if not block.get("url"):
                continue
            url_query = urllib.parse.urlsplit(str(block["url"])).query
            for part in (block.get("query"), block.get("body"), url_query):
                hit = _flag_set_in(part, flags) if part else None
                if hit:
                    return hit
    return None


_READ_METHODS = ("GET", "HEAD")


def _url_blocks(entry: dict):
    """(block, url with query) for every request-issuing block, the same
    blocks extract_urls scans."""
    for value in (entry or {}).values():
        if isinstance(value, dict):
            blocks = [value]
        elif isinstance(value, list):
            blocks = [v for v in value if isinstance(v, dict)]
        else:
            continue
        for block in blocks:
            if block.get("url"):
                yield block, _url_with_query(block)


def _block_reads_only(block: dict) -> bool:
    return str(block.get("method") or "GET").upper() in _READ_METHODS \
        and not isinstance(block.get("browser"), dict)


def _entry_reads_only(entry: dict) -> bool:
    """True only when the entry is a read and every block it sends is a
    GET or HEAD request."""
    return entry.get("effects") == "read" and all(
        _block_reads_only(block) for block, _url in _url_blocks(entry))


def _never_dispatch_refusal(message, entry):
    refusal = NeverDispatch(message)
    # For the failure translator: a refused read is told as a read.
    refusal.operation_kind = "read" if _entry_reads_only(entry) else "write"
    return refusal


def check_never_dispatch(entry: dict, policy: dict) -> None:
    """Refuse standing-excluded and catalog-excluded operations. No override.

    url_substrings refuse every request to a matching URL.
    write_url_substrings refuse only changes: any request that is not a
    GET or HEAD, and every request of an entry that is not a read."""
    name = entry.get("name") or ""
    nd = policy.get("never_dispatch", {})
    if name in nd.get("tool_names", []):
        raise _never_dispatch_refusal(
            "operation %r is on the never-dispatch list (catalog excluded / "
            "standing exclusion); it cannot be dispatched by any caller. "
            "Nothing was sent." % name, entry)
    changes = entry.get("effects") != "read"
    for block, url in _url_blocks(entry):
        hit = _url_hits_any(url, nd.get("url_substrings", []))
        if not hit and (changes or not _block_reads_only(block)):
            hit = _url_hits_any(url, nd.get("write_url_substrings", []))
        if hit:
            raise _never_dispatch_refusal(
                "operation %r targets a never-dispatch URL pattern %r "
                "(standing exclusion: messages to people, support tickets, "
                "subaccount-affecting operations). Nothing was sent."
                % (name, hit), entry)
    flags = nd.get("request_flags") or {}
    flag = _request_flag_hit(entry, flags)
    if flag:
        raise _never_dispatch_refusal(
            "operation %r sets %s, which %s. Nothing was sent."
            % (name, flag, flags[flag]), entry)


def check_unsupported(entry: dict, policy: dict) -> None:
    """Refuse catalog-unsupported operations."""
    name = entry.get("name") or ""
    if name in policy.get("unsupported", {}).get("tool_names", []):
        raise UnsupportedOperation(
            "operation %r is catalog-unsupported: no working provider route "
            "exists; refusing to dispatch" % name)


def check_evidence_holds(entry: dict, policy: dict) -> None:
    """Refuse operations that are not yet live-proven through Morrow for Muse.

    Tenant-independent: the refusal applies identically on every tenant.
    When a disposable live battery proves the complete path for a held
    operation, it is removed from the hold list and admitted on all tenants.
    """
    name = entry.get("name") or ""
    holds = policy.get("evidence_holds", {}) or {}
    reasons = holds.get("reasons", {}) or {}
    if name in holds.get("tool_names", []):
        reason = reasons.get(name, "not yet live-proven through Morrow for Muse")
        raise EvidenceHold(
            "operation %r is on evidence hold: %s; refused on every tenant "
            "until a live battery proves the complete path" % (name, reason))


def check_learner_data(entry: dict, policy: dict, vault_ready: bool) -> None:
    """Refuse learner-PII operations on a lane that cannot de-identify.

    vault_ready is True only on a lane with a projection point (the
    Chromium lane) AND the encrypted learner vault (the optional
    'cryptography' package): there every receipt is projected to labels
    before it is agent-visible, so the op is admitted. Anywhere else
    the op is refused. Signals (W3-P0-5/W3-P0-9/W3-P1-45): the catalog
    row's own [LEARNER-DATA] flag, query templates, and request /
    multi-step query/body content alongside the URL substrings.
    """
    if vault_ready:
        return
    hit = _learner_signal_hit(entry, policy)
    if hit:
        raise LearnerDataGated(
            "operation %r touches learner data (signal %r). Student data "
            "runs only on the Chromium lane with the encrypted learner "
            "vault (the optional 'cryptography' package, pinned in "
            "requirements-optional.txt), where every receipt is "
            "de-identified before anyone sees it. This dispatch has no "
            "de-identification point, so it is refused."
            % (entry.get("name"), hit))


def touches_learner_data(entry: dict, policy: dict | None = None) -> bool:
    """True when the entry touches learner data.

    Used by the completion path to decide whether the result must be
    projected through the learner vault before it becomes agent-visible.
    Same signals as check_learner_data (W3-P0-5/W3-P0-9/W3-P1-45): the
    catalog row's [LEARNER-DATA] flag, URL templates with query templates,
    and request/multi-step query/body content.
    """
    policy = policy if policy is not None else load_policy()
    return _learner_signal_hit(entry, policy) is not None


def _ensure_approvals_dir() -> None:
    """Create the approvals dir 0700; tighten a pre-existing loose dir.

    Fails closed: if the directory cannot be brought to 0700, nothing
    that depends on approval replay protection may proceed.
    """
    os.makedirs(APPROVALS_DIR, mode=0o700, exist_ok=True)
    try:
        mode = stat.S_IMODE(os.stat(APPROVALS_DIR).st_mode)
        if mode != 0o700:
            os.chmod(APPROVALS_DIR, 0o700)
            mode = stat.S_IMODE(os.stat(APPROVALS_DIR).st_mode)
        if mode != 0o700:
            raise ApprovalMismatch(
                "approvals dir %s has mode %o; cannot tighten to 0700, "
                "refusing rather than risk replay-protection tampering"
                % (APPROVALS_DIR, mode))
    except OSError as exc:
        raise ApprovalMismatch(
            "cannot verify approvals dir permissions (%s); refusing"
            % exc)


def _ensure_secrets_dir() -> None:
    """Create/tighten the secrets dir (0700), separate from approvals."""
    os.makedirs(SECRETS_DIR, exist_ok=True)
    try:
        if stat.S_IMODE(os.stat(SECRETS_DIR).st_mode) != 0o700:
            os.chmod(SECRETS_DIR, 0o700)
    except OSError:
        pass


def _migrate_legacy_signing_key() -> None:
    """W6-P2-4: move a pre-upgrade key out of the approvals dir.

    The legacy key lived next to the records it seals. On first load,
    move it to the new secrets dir (atomic rename on the same volume)
    so existing seals keep verifying under the new layout. Skipped when
    the key path is overridden via MORROW_APPROVAL_SIGNING_KEY.
    """
    if os.path.abspath(SIGNING_KEY_PATH) == \
            os.path.abspath(_LEGACY_SIGNING_KEY_PATH):
        return
    if os.path.exists(SIGNING_KEY_PATH):
        return
    if not os.path.exists(_LEGACY_SIGNING_KEY_PATH):
        return
    _ensure_secrets_dir()
    try:
        os.replace(_LEGACY_SIGNING_KEY_PATH, SIGNING_KEY_PATH)
    except OSError:
        pass


def _parse_signing_keyring(raw: bytes):
    """Parse the signing-key file into {"active", "keys"}.

    v2 (rotatable): {"version": 2, "active": "<kid>",
                     "keys": {"<kid>": "<hex>"}}.
    Legacy: raw key bytes -> single-key ring with kid "v1".
    Returns None when the file exists but is malformed (fail closed:
    callers refuse rather than mint over it blindly).
    """
    stripped = raw.strip()
    if stripped.startswith(b"{"):
        try:
            doc = json.loads(stripped.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        if not isinstance(doc, dict) or doc.get("version") != 2:
            return None
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
    if len(raw) < 32:
        return None
    return {"active": "v1", "keys": {"v1": raw}, "retired_at": {}}


def _read_signing_keyring():
    """The approval tamper-seal keyring, or None when not yet minted."""
    _migrate_legacy_signing_key()
    try:
        with open(SIGNING_KEY_PATH, "rb") as f:
            raw = f.read()
    except OSError:
        return None
    return _parse_signing_keyring(raw)


def _write_signing_keyring(ring) -> None:
    """Atomically persist a v2 signing-keyring doc (0600 at open)."""
    _ensure_secrets_dir()
    doc = {"version": 2, "active": ring["active"],
           "keys": {kid: key.hex() for kid, key in ring["keys"].items()},
           "retired_at": ring.get("retired_at", {})}
    tmp = SIGNING_KEY_PATH + ".tmp"
    fd = _open_secret_tmp(tmp)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(doc, sort_keys=True))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, SIGNING_KEY_PATH)


def _signing_key() -> bytes:
    """Load or create the machine-held approval tamper-seal key (0600).

    Returns the ACTIVE key; verification tries every key in the ring
    (see _verify_seal), so rotation never invalidates old seals.
    """
    ring = _read_signing_keyring()
    if ring is not None:
        return ring["keys"][ring["active"]]
    if os.path.exists(SIGNING_KEY_PATH):
        raise ApprovalMismatch(
            "approval signing key file is malformed; refusing to mint "
            "over it blindly (that would invalidate every existing "
            "seal)")
    _ensure_secrets_dir()
    key = secrets.token_bytes(32)
    _write_signing_keyring({"active": "v1", "keys": {"v1": key}})
    return key


def rotate_signing_key() -> str:
    """W6-P1-2: rotate the approval tamper-seal key.

    Mints a fresh 256-bit key, makes it the ACTIVE sealing key, and
    keeps retired keys in the keyring for verification: records sealed
    before the rotation keep verifying, so rotation is no longer
    operationally punitive. New seals use the new key immediately.
    Returns the new key id.
    """
    ring = _read_signing_keyring()
    if ring is None:
        if os.path.exists(SIGNING_KEY_PATH):
            raise ApprovalMismatch(
                "approval signing key file is malformed; refusing to "
                "rotate blindly")
        _signing_key()
        ring = _read_signing_keyring()
    kid = "k%d" % (len(ring["keys"]) + 1)
    while kid in ring["keys"]:
        kid = "k" + secrets.token_hex(4)
    old_active = ring["active"]
    ring["keys"][kid] = secrets.token_bytes(32)
    ring["active"] = kid
    # W6-P1-2: stamp when the demoted key was retired, so a later
    # retire-signing-key can enforce the 25h minimum (approval records
    # live up to 24h + 5min issue skew; the consumed set retains 25h).
    ring.setdefault("retired_at", {})[old_active] = \
        datetime.datetime.now(datetime.timezone.utc).isoformat()
    _write_signing_keyring(ring)
    return kid


def retire_signing_key(key_id: str) -> str:
    """W6-P1-2: drop a RETIRED approval tamper-seal key from the keyring.

    A retired key that stays in the ring keeps full forgery power: any
    approval record forged under it verifies. Dropping it is what gives
    a key compromise an expiry. Refuses to retire the ACTIVE key and
    refuses unknown key ids. Also refuses a key retired less than 25
    hours ago: approval records carry a TTL of up to 24h (+5min issue
    skew) and the consumed-record set retains 25h, so dropping the key
    earlier would turn legitimate in-flight verifications fail-closed.
    Wait out the 25h, then retire. Returns the retired key id.
    """
    ring = _read_signing_keyring()
    if ring is None:
        raise ApprovalMismatch(
            "no approval signing keyring exists; nothing to retire")
    if key_id not in ring["keys"]:
        raise ApprovalMismatch(
            "unknown approval signing key id %r" % (key_id,))
    if key_id == ring["active"]:
        raise ApprovalMismatch(
            "cannot retire the ACTIVE approval signing key (%r): rotate to "
            "a new key first, then retire the old one" % (key_id,))
    stamp = ring.get("retired_at", {}).get(key_id)
    if stamp is not None:
        try:
            retired_dt = datetime.datetime.fromisoformat(stamp)
            if retired_dt.tzinfo is None:
                retired_dt = retired_dt.replace(
                    tzinfo=datetime.timezone.utc)
            age = (datetime.datetime.now(datetime.timezone.utc)
                   - retired_dt).total_seconds()
        except ValueError:
            age = 0
        if age < 25 * 3600:
            raise ApprovalMismatch(
                "approval signing key %r was retired only %.1f hours ago; "
                "records sealed under it can still be presented for up to "
                "25h. Wait out the 25h, then retire." % (key_id, age / 3600))
    del ring["keys"][key_id]
    _write_signing_keyring(ring)
    return key_id


def _open_secret_tmp(tmp_path: str) -> int:
    """W6-P2-2: open a staging file for secret bytes, 0600 ATOMICALLY.

    Mirrors dispatch/executor._open_secret_tmp: os.open with an explicit
    0o600 mode never creates the file group/other-readable, closing the
    transient-0644 window of the old open-then-chmod pattern. O_EXCL
    keeps concurrent writers off one staging path; a stale tmp from a
    crashed pid-reuse is unlinked and retried once."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        return os.open(tmp_path, flags, 0o600)
    except FileExistsError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return os.open(tmp_path, flags, 0o600)


def _canonical_record_bytes(record: dict) -> bytes:
    """Canonical bytes of an approval record, excluding its own seal."""
    payload = {k: v for k, v in record.items() if k != "sig"}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, default=str).encode("utf-8")


def _seal_record(record: dict) -> dict:
    """Attach the HMAC tamper seal. Only sign_approval calls this."""
    # W6-P2-7: use-then-zero; the key buffer is overwritten on exit.
    with secret_bytes(_signing_key()) as key:
        record["sig"] = _hmac.new(
            key.view(), _canonical_record_bytes(record),
            hashlib.sha256).hexdigest()
    return record


def _verify_seal(record: dict) -> None:
    """Refuse a record whose tamper seal is missing or does not verify.

    Records minted before sealing existed carry no "sig" and are refused:
    a seal is mandatory, not best-effort.
    """
    sig = record.get("sig")
    if not isinstance(sig, str):
        raise ApprovalMismatch(
            "approval record carries no tamper seal; records must pass "
            "through sign_approval on this machine")
    ring = _read_signing_keyring()
    if ring is None:
        raise ApprovalMismatch(
            "approval signing key is missing; cannot verify the tamper "
            "seal")
    # W6-P1-2: the seal may verify under a retired (pre-rotation) key.
    # W6-P2-7: each candidate key is used-then-zeroed.
    body = _canonical_record_bytes(record)
    verified = False
    for key in ring["keys"].values():
        with secret_bytes(key) as key_buf:
            if _hmac.compare_digest(
                    sig,
                    _hmac.new(key_buf.view(), body,
                              hashlib.sha256).hexdigest()):
                verified = True
                break
    if not verified:
        raise ApprovalMismatch(
            "approval record tamper seal does not verify; the record was "
            "modified after signing")


def load_approval(op_id: str | None, approval: dict | None):
    """Resolve the approval record plus its provenance.

    Returns (record, provenance) where provenance is "file" (read from
    the approvals dir: the file ceremony) or "in_process" (an explicit
    dict handed to dispatch: lower-trust, no file ceremony). Returns
    (None, None) when no record exists. The provenance is journaled with
    every admitted write so a reviewer can tell the two apart.
    """
    if approval is not None:
        return approval, "in_process"
    if op_id:
        path = os.path.join(APPROVALS_DIR, op_id + ".json")
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f), "file"
    return None, None


def entry_category(entry: dict) -> str:
    """The operation family an approval is scoped to.

    An explicit entry["category"] wins. Otherwise it is derived
    deterministically: "<provider>.<family>", where family is the entry
    name's segments minus the provider prefix and minus action-verb /
    article / preposition segments. Examples:
      canvas_create_assignment      -> canvas.assignment
      canvas_item_bank_create_item  -> canvas.item_bank_item
      moodle_reply_to_forum_post    -> moodle.forum_post
      proof_create_assignment       -> canvas.proof_assignment
    The derivation is documented and stable; the gate requires the
    approval's category to match it exactly, so an approval minted for
    one family can never authorize another.
    """
    explicit = entry.get("category")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    provider = str(entry.get("provider") or "").strip().lower()
    name = str(entry.get("name") or "")
    segments = [s for s in re.split(r"[._]", name.lower()) if s]
    if provider and segments and segments[0] == provider:
        segments = segments[1:]
    family = [s for s in segments if s not in _CATEGORY_DROP]
    if not family:
        family = [s for s in re.split(r"[._]", name.lower()) if s] or ["unknown"]
    fam = "_".join(family)
    return ("%s.%s" % (provider, fam)) if provider else fam


_BASE_SLOT_RE = re.compile(r"^\{[a-z_]+_base\}")
_SLOT_RE = re.compile(r"\{([A-Za-z0-9_]+)\}")


def _resolve_param_refs(value, params: dict):
    """value with every "params.<name>" string replaced by the param's
    value (the same references the executor resolves at send time).
    Transient and result references stay as written: they are filled
    from provider data at send time, which the educator cannot see
    before approving, and the digest binds the reference itself."""
    if isinstance(value, str):
        if value.startswith("params.") and isinstance(params, dict):
            key = value[len("params."):]
            if key in params:
                return params[key]
        return value
    if isinstance(value, dict):
        return {k: _resolve_param_refs(v, params) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_param_refs(v, params) for v in value]
    return value


def _render_path(url_template: str, params: dict) -> str:
    """The request path the educator sees: the tenant base dropped and
    every {param} slot filled from params (unfilled slots stay)."""
    path = _BASE_SLOT_RE.sub("", str(url_template or ""))

    def fill(match):
        key = match.group(1)
        if isinstance(params, dict) and params.get(key) is not None:
            return str(params[key])
        return match.group(0)
    return _SLOT_RE.sub(fill, path)


# The course segment of a rendered Canvas or New Quizzes path. A slot
# left unfilled ({id}) is not a course.
_COURSE_SEGMENT_RE = re.compile(
    r"/api/(?:quiz/)?v1/courses/([^/?#{}]+)(?=[/?#]|$)")


def write_target_course_id(entry: dict, params: dict) -> str | None:
    """The course a request targets.

    The course is the /courses/<id> segment of the rendered request
    path (the request URL, then each multi_step URL), whatever the slot
    is called: PUT /api/v1/courses/{id} targets course {id} just as
    /api/v1/courses/{course_id}/pages/... targets {course_id}.
    params.course_id is the fallback for routes whose path names no
    course (Item Bank and other non-course URLs). The course-resolution
    guard, the provider identity GET, the approval target, and the mode
    journal all read the course from here."""
    urls = []
    request = entry.get("request") if isinstance(entry, dict) else None
    if isinstance(request, dict) and request.get("url"):
        urls.append(str(request["url"]))
    steps = entry.get("multi_step") if isinstance(entry, dict) else None
    for step in steps or []:
        if isinstance(step, dict) and step.get("url"):
            urls.append(str(step["url"]))
    for url in urls:
        match = _COURSE_SEGMENT_RE.search(_render_path(url, params))
        if match:
            return match.group(1)
    if isinstance(params, dict) and params.get("course_id") is not None:
        return str(params["course_id"])
    return None


def request_subject(entry: dict, params: dict) -> dict:
    """The exact request an approval covers: method, URL template, the
    rendered path, query, and body (param references resolved), plus
    the multi-step blocks when the entry has them.

    Round-4 audit H1: the approval used to bind the op name, params,
    tenant, and category only, so a changed body rode on an approval
    for another body. This subject is bound into the op digest, stamped
    into the record for the approval display, and recomputed at
    dispatch and at the complete phase.
    """
    req = entry.get("request") or {}
    subject = {
        "method": str(req.get("method") or "").upper(),
        "url": str(req.get("url") or ""),
        "path": _render_path(req.get("url"), params),
        "query": _resolve_param_refs(req.get("query"), params),
        "body": _resolve_param_refs(req.get("body"), params),
    }
    if entry.get("multi_step"):
        subject["multi_step"] = _resolve_param_refs(entry.get("multi_step"),
                                                    params)
    return subject


def request_digest(subject: dict) -> str:
    """SHA-256 over the canonical JSON of a request_subject()."""
    canonical = json.dumps(subject or {}, sort_keys=True,
                           separators=(",", ":"), ensure_ascii=True,
                           default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def op_digest_of(entry_name: str, params: dict, tenant_base: str | None,
                 category: str | None = None,
                 request: dict | None = None) -> str:
    """SHA-256 binding one approval to one request on one tenant.

    Covers the entry name, the canonical params, the tenant base, the
    operation family, and (when given) the request_subject(): method,
    path, query, and body. The digest cannot be replayed for different
    params, a different tenant, a different category, or a different
    request body.
    """
    doc = {"op": entry_name, "params": params or {},
           "tenant": tenant_base or "", "category": category or ""}
    if request is not None:
        doc["request_digest"] = request_digest(request)
    canonical = json.dumps(
        doc, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
        default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def mint_approval(entry: dict, params: dict, tenant_base: str | None = None,
                  ttl_seconds: int = 3600,
                  target_identity: dict | None = None) -> dict:
    """Build an UNSIGNED v2 approval record (by=None).

    The agent fills in everything except the signature: op, digests,
    category, issued/expiry times. The educator signs it via
    sign_approval() with the verbatim authorization basis. This function
    never sets by itself: an unsigned record is refused by the gate.

    target_identity (W4-P0-11) is the human-meaningful write target the
    educator reviewed: {"course_id": ..., "course_name": ..., "term":
    ...}. It is stamped into the record (and covered by the tamper
    seal) alongside the tenant, so the reviewing educator sees the
    target they are signing for. course_id falls back to the course
    the request path targets (write_target_course_id) when the caller
    does not name it explicitly.
    """
    if ttl_seconds <= 0 or ttl_seconds > MAX_APPROVAL_TTL_SECONDS:
        raise ValueError("ttl_seconds must be within (0, %d]"
                         % MAX_APPROVAL_TTL_SECONDS)
    now = datetime.datetime.now(datetime.timezone.utc)
    category = entry_category(entry)
    subject = request_subject(entry, params)
    record = {
        "version": APPROVAL_VERSION,
        "by": None,
        "at": now.isoformat(),
        "expires_at": (now + datetime.timedelta(seconds=ttl_seconds)).isoformat(),
        "op": entry.get("name"),
        "op_digest": op_digest_of(entry.get("name"), params, tenant_base,
                                  category, request=subject),
        # Single use is per approval, not per change: the educator may
        # approve the same change again (rename, revert, rename). The
        # seal covers the id, so one signed record is still single-use.
        "approval_id": secrets.token_hex(16),
        "category": category,
        "params_digest": canonical_params_digest(params),
        # Round-4 H1: the exact request this approval covers, for the
        # approval display; bound by request_digest and the op digest.
        "request": subject,
        "request_digest": request_digest(subject),
        "authorization": None,
        "note": ("Set by=\"educator\" via sign_approval() only on the "
                 "educator's explicit authorization of this exact action."),
    }
    # W4-P0-11: human-readable write target for the reviewing educator.
    # Covered by the tamper seal like every other field.
    declared_target = dict(target_identity) if isinstance(target_identity, dict) else {}
    if declared_target.get("course_id") is None:
        write_cid = write_target_course_id(entry, params)
        if write_cid is not None:
            declared_target["course_id"] = write_cid
    target_block = {}
    if tenant_base:
        target_block["tenant"] = tenant_base
    for key in ("course_id", "course_name", "term", "object_slot",
                "object_name"):
        if declared_target.get(key) is not None:
            target_block[key] = declared_target[key]
    if target_block:
        record["target"] = target_block
    return record


def sign_approval(record: dict, authorization: str,
                  channel: str,
                  resolved_identities: list | None = None,
                  identity_authorization: str | None = None) -> dict:
    """Educator signature on a minted approval record.

    Sets by="educator", records the VERBATIM basis of the educator's
    explicit authorization (their message, or the directive they issued),
    stamps the ceremony channel, and tamper-seals the record with the
    machine-held HMAC key.

    W6-P2-F1: channel has NO default. Every caller must state it
    explicitly: "educator-chat" when the authorization was captured from
    the educator's own reply in the connector chat after they cited the
    identities themselves, or "driver" for every other path (proof
    drivers, scripts, tests). A forgotten channel used to silently land
    on "driver", degrading the forensic signal in exactly the direction
    that makes a fabricated educator approval indistinguishable from a
    lazy one. The channel is journaled with the write so a reviewer can
    tell the two apart, and check_write_approval can refuse
    driver-channel records outright (require_educator_channel).

    resolved_identities is the agent-relayed educator citation of the
    identities the op touches ([{token, displayed_as}]): the educator
    names the identities, the agent relays that citation, and the seal
    covers it. There is no de-tokenizing renderer. When present it is stamped into the record and the seal covers it;
    resolution_authority is set to "approval:<op_digest>", authorizing
    identity resolution for that op digest only. It is not a standing
    permission: a new op mints a new ceremony. When params carry no
    learner tokens, pass None and no resolution is authorized.

    W6-P2-A3: the identity schedule is NO LONGER covered by the action
    authorization alone. When resolved_identities is non-empty, a
    SEPARATE identity_authorization (the educator's own words naming
    the identities, any non-empty reply) is required and is sealed and journaled
    alongside the action authorization. Bundling the write action and
    the identity list into one rubber-stamp invited skipping the
    identity half (the FERPA-consequential half); two citations force
    two questions.

    Before asking for either authorization, show the educator the full
    payload with dispatch.approval_display.render_educator_display
    (W6-P1-A1): in plain words, the course, the change, every value
    that will be sent, and the undo-availability disclosure (W6-P1-H1).
    render_approval_display is the audit detail of the same request.

    Honest trust statement: this function runs in the agent's process,
    so it cannot cryptographically prove the authorization string came
    from the educator. What it does guarantee: (a) the citation is
    non-empty and journaled verbatim for audit; (b) the seal binds
    every field (op, digests, tenant, category, expiry, authorization,
    identity authorization, channel, identity schedule) against
    post-signing modification; (c) a record that never passed through
    this function carries no valid seal and is refused by the gate.
    Claiming channel="educator-chat" for a fabricated authorization is
    a detectable lie in audit, not a prevented one; true prevention
    needs the connector UX to hold the signing step outside the agent's
    reach, and the gate's require_educator_channel option refuses
    driver-channel records at dispatch time.
    """
    if not isinstance(authorization, str) or len(authorization.strip()) < APPROVAL_AUTH_MIN_LEN:
        raise ValueError(
            "sign_approval requires the educator's verbatim reply "
            "approving the action (any non-empty reply, e.g. \"Yes\"); "
            "inferred or standing-note approvals are not accepted")
    if channel not in ("educator-chat", "driver"):
        raise ValueError(
            "sign_approval channel must be 'educator-chat' or 'driver', "
            "got %r" % (channel,))
    schedule = None
    if resolved_identities is not None:
        if not isinstance(resolved_identities, list):
            raise ValueError("resolved_identities must be a list of "
                             "{token, displayed_as} dicts or None")
        schedule = []
        for item in resolved_identities:
            if (not isinstance(item, dict)
                    or not isinstance(item.get("token"), str)
                    or not _TOKEN_RE.match(item["token"])
                    or not isinstance(item.get("displayed_as"), str)
                    or not item["displayed_as"].strip()):
                raise ValueError(
                    "resolved_identities items must be {token, displayed_as} "
                    "with a token-shaped token and a non-empty display name")
            schedule.append({"token": item["token"],
                             "displayed_as": item["displayed_as"].strip()})
    record["by"] = "educator"
    record["authorization"] = authorization.strip()
    # W6-P2-A3: a non-empty identity schedule needs its own separate
    # educator citation; the action authorization does not cover it.
    if schedule:
        if (not isinstance(identity_authorization, str)
                or len(identity_authorization.strip()) < APPROVAL_AUTH_MIN_LEN):
            raise ValueError(
                "sign_approval: a resolved_identities schedule requires a "
                "separate identity_authorization (the educator's own "
                "non-empty reply naming the identities); the action "
                "authorization does not cover the identity schedule")
        record["identity_authorization"] = identity_authorization.strip()
    else:
        record["identity_authorization"] = None
    record["channel"] = channel
    record["resolved_identities"] = schedule
    record["resolution_authority"] = (
        "approval:%s" % record["op_digest"] if schedule else None)
    return _seal_record(record)


def _parse_time(value, field: str) -> datetime.datetime:
    try:
        dt = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        raise ApprovalMismatch("approval %s is not a valid ISO-8601 time: %r"
                               % (field, value))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def _consumed_seal_path():
    # The seal lives next to the consumed set it protects. Computed
    # from the CURRENT CONSUMED_PATH (not frozen at import) so test
    # harnesses that redirect CONSUMED_PATH get a redirected seal too,
    # instead of reading/writing the product's real seal.
    return CONSUMED_PATH + ".seal"
_CONSUMED_SEAL_DOMAIN = b"morrow-consumed-v1\n"
_CONSUMED_SEAL_PREFIX = "morrow-consumed-hmac$"


def _write_consumed_seal() -> None:
    """Write/refresh the consumed set's HMAC seal (W6-P1-6).

    seal = "morrow-consumed-hmac$" + HMAC-SHA256(approval_signing_key,
           "morrow-consumed-v1\\n" + file_bytes),
    stored 0600 via tmp+rename+fsync. Callers hold the consumed lock.
    Verification tries every keyring key (W6-P1-2 rotation).
    """
    with open(CONSUMED_PATH, "rb") as f:
        data = f.read()
    with secret_bytes(_signing_key()) as _kb:
        mac = _hmac.new(_kb.view(), _CONSUMED_SEAL_DOMAIN + data,
                        hashlib.sha256).hexdigest()
    seal_path = _consumed_seal_path()
    os.makedirs(os.path.dirname(seal_path), exist_ok=True)
    tmp = seal_path + ".tmp"
    fd = _open_secret_tmp(tmp)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(_CONSUMED_SEAL_PREFIX + mac + "\n")
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


def _load_consumed() -> dict:
    # W5-P1-3: the membership checks in check_write_approval and
    # reverify_approval each parsed the whole file (several parses per
    # admit). Cache in process keyed on
    # (mtime_ns, size); the file changes only under _record_consumed's
    # flock, so the common path is one stat() per admit instead of a
    # full parse. CONSUMED_PATH is read at call time (not bound as a
    # default arg) so test overrides of the module attribute keep
    # working.
    #
    # W6-P1-6: the consumed set is replay protection: a dropped digest
    # re-arms a single-use approval. consumed.json carries an HMAC
    # seal (consumed.seal, keyed by the approval signing keyring) and
    # this reader is fail-closed: a missing seal (pre-seal legacy
    # file, or a stripped seal), a seal that does not verify under any
    # keyring key, or a deleted file with a surviving seal all raise
    # ApprovalMismatch instead of silently trusting (or silently
    # emptying) the set.
    global _consumed_cache, _consumed_cache_key
    try:
        st = os.stat(CONSUMED_PATH)
    except OSError:
        # Missing file: a surviving seal means deletion outside the
        # gate. Both missing is first run.
        if os.path.exists(_consumed_seal_path()):
            raise ApprovalMismatch(
                "consumed approval set %s was deleted, but its seal %s "
                "survives: the file was removed outside the admission "
                "gate. Fail closed: consumed digests must stay "
                "un-reusable. Investigate and restore from backup."
                % (CONSUMED_PATH, _consumed_seal_path()))
        _consumed_cache = {}
        _consumed_cache_key = None
        return {}
    try:
        seal_st = os.stat(_consumed_seal_path())
        seal_key = (seal_st.st_mtime_ns, seal_st.st_size)
    except OSError:
        seal_key = None
    key = (st.st_mtime_ns, st.st_size, seal_key)
    if key == _consumed_cache_key and _consumed_cache is not None:
        return dict(_consumed_cache)
    with open(CONSUMED_PATH, "rb") as f:
        raw = f.read()
    try:
        with open(_consumed_seal_path(), "r", encoding="utf-8") as f:
            seal = f.read().strip()
    except OSError:
        seal = ""
    if not seal.startswith(_CONSUMED_SEAL_PREFIX):
        raise ApprovalMismatch(
            "consumed approval set %s has no integrity seal (pre-seal "
            "legacy file, or the seal was stripped). Fail closed: an "
            "unsealed consumed set cannot be trusted for replay "
            "protection. Reconcile, then run the consumed-seal adoption."
            % CONSUMED_PATH)
    ring = _read_signing_keyring()
    if ring is None:
        raise ApprovalMismatch(
            "consumed approval set %s is sealed but the approval "
            "signing key is missing, so the seal cannot be verified. "
            "Fail closed: restore from backup." % CONSUMED_PATH)
    verified = False
    for key_bytes in ring["keys"].values():
        with secret_bytes(key_bytes) as key_buf:
            if _hmac.compare_digest(
                    seal[len(_CONSUMED_SEAL_PREFIX):],
                    _hmac.new(key_buf.view(),
                              _CONSUMED_SEAL_DOMAIN + raw,
                              hashlib.sha256).hexdigest()):
                verified = True
                break
    if not verified:
        raise ApprovalMismatch(
            "consumed approval set %s FAILED integrity verification: "
            "the file was forged or corrupted. Fail closed: its digests "
            "must not be trusted. Investigate and restore from backup."
            % CONSUMED_PATH)
    try:
        data = json.loads(raw.decode("utf-8"))
        data = data if isinstance(data, dict) else {}
    except ValueError:
        data = {}
    _consumed_cache = dict(data)
    _consumed_cache_key = key
    return data


def _invalidate_consumed_cache() -> None:
    global _consumed_cache, _consumed_cache_key
    _consumed_cache = None
    _consumed_cache_key = None


def _consumed_cutoff() -> datetime.datetime:
    return (datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(seconds=CONSUMED_RETENTION_S))


def _prune_consumed_dict(consumed: dict):
    """Drop expired digests from a consumed map (W5-P1-3).

    Approvals live at most MAX_APPROVAL_TTL_SECONDS (24h); a digest
    consumed longer than CONSUMED_RETENTION_S ago can never authorize a
    replay, because any record carrying it is refused as expired first.
    Unparseable timestamps are KEPT (fail-safe: never drop replay
    protection we cannot date). Returns (pruned_dict, n_dropped).
    """
    cutoff = _consumed_cutoff()
    kept = {}
    dropped = 0
    for digest, ts in consumed.items():
        try:
            when = datetime.datetime.fromisoformat(
                str(ts).replace("Z", "+00:00"))
            if when.tzinfo is None:
                when = when.replace(tzinfo=datetime.timezone.utc)
        except (ValueError, TypeError):
            kept[digest] = ts
            continue
        if when >= cutoff:
            kept[digest] = ts
        else:
            dropped += 1
    if len(kept) > CONSUMED_MAX_ENTRIES:
        # Backstop: keep the newest. Timestamps sort lexicographically
        # for the ISO-8601 shape _record_consumed writes.
        items = sorted(kept.items(), key=lambda kv: str(kv[1]))
        dropped += len(items) - CONSUMED_MAX_ENTRIES
        kept = dict(items[-CONSUMED_MAX_ENTRIES:])
    return kept, dropped


def _use_key(record: dict) -> str:
    """The consumed-set key of one signed approval: its op_digest bound
    to its own approval_id. A record minted before approval ids existed
    is keyed by its op_digest alone."""
    digest = record.get("op_digest")
    approval_id = record.get("approval_id")
    if not approval_id:
        return digest
    return hashlib.sha256(("morrow-approval-use-v1\n%s\n%s"
                           % (digest, approval_id)).encode("utf-8")
                          ).hexdigest()


def approval_used(record: dict | None) -> bool:
    """True when this signed approval record was already consumed."""
    if not isinstance(record, dict) or not record.get("op_digest"):
        return False
    return _use_key(record) in _load_consumed()


def _record_consumed(use_key: str) -> None:
    """Mark an approval's use key consumed (single-use). Fails closed.

    The read-modify-write runs under an exclusive inter-process lock
    (fcntl.flock on a lock file beside the consumed set), so two
    concurrent dispatches racing on the same approval cannot both
    consume it. The loser is refused here, before any network I/O: its
    persisted-but-unconsumed record can never complete, and the
    educator's approval is spent exactly once. A digest that is already
    consumed is a replay and is refused even by the winner's retry.
    """
    os.makedirs(APPROVALS_DIR, exist_ok=True)
    lock_fd = os.open(CONSUMED_PATH + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            consumed = _load_consumed()
            if use_key in consumed:
                raise ApprovalMismatch(
                    "approval for this op was already consumed; refusing "
                    "replay")
            # W5-P1-3: prune expired digests on every write so the file
            # (parsed ~3x and fully rewritten per dispatch) stays
            # bounded instead of growing forever.
            consumed, _dropped = _prune_consumed_dict(consumed)
            consumed[use_key] = datetime.datetime.now(
                datetime.timezone.utc).isoformat()
            tmp = CONSUMED_PATH + ".tmp"
            try:
                # W6-P2-2: 0600 at open, never open-then-chmod.
                _cfd = _open_secret_tmp(tmp)
                with os.fdopen(_cfd, "w", encoding="utf-8") as f:
                    json.dump(consumed, f, indent=2, sort_keys=True)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, CONSUMED_PATH)
                # W6-P1-6: seal the rewritten file immediately; the
                # consumed set is never left unsealed on disk.
                _write_consumed_seal()
            except OSError as exc:
                raise ApprovalMismatch(
                    "cannot record approval consumption (%s); refusing rather "
                    "than risk a replay" % exc)
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
    finally:
        os.close(lock_fd)
    _invalidate_consumed_cache()


def prune_consumed() -> int:
    """Drop expired consumed digests outside the dispatch path (W5-P1-3).

    Runs under the same exclusive lock as _record_consumed. Returns the
    number of digests removed. Never raises: a prune failure leaves the
    file untouched.
    """
    try:
        os.makedirs(APPROVALS_DIR, exist_ok=True)
        lock_fd = os.open(CONSUMED_PATH + ".lock",
                          os.O_CREAT | os.O_RDWR, 0o600)
    except OSError:
        return 0
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            consumed = _load_consumed()
            pruned, dropped = _prune_consumed_dict(consumed)
            if dropped:
                tmp = CONSUMED_PATH + ".tmp"
                # W6-P2-2: 0600 at open, never open-then-chmod.
                _fd = _open_secret_tmp(tmp)
                with os.fdopen(_fd, "w", encoding="utf-8") as f:
                    json.dump(pruned, f, indent=2, sort_keys=True)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, CONSUMED_PATH)
                # W6-P1-6: keep the seal in step with the file.
                _write_consumed_seal()
            return dropped
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
    except OSError:
        return 0
    finally:
        try:
            os.close(lock_fd)
        except OSError:
            pass
        _invalidate_consumed_cache()


def _check_identity_schedule(record: dict, params: dict) -> None:
    """Enforce that the identity schedule matches the op's learner tokens.

    When the signed record carries resolved_identities (the educator
    cited the identities the op touches), the scheduled tokens must be
    exactly the tokens in the canonical params, in canonical walk order:
    the educator approved precisely the identities the op touches, no
    more, no fewer.
    A record without resolved_identities (plain action approval, or a
    driver-channel proof) carries no identity claim and is not checked.
    """
    schedule = record.get("resolved_identities")
    if schedule is None:
        return
    if not isinstance(schedule, list):
        raise ApprovalMismatch(
            "approval resolved_identities is malformed; refusing")
    scheduled = []
    for item in schedule:
        if (not isinstance(item, dict)
                or not isinstance(item.get("token"), str)
                or not _TOKEN_RE.match(item["token"])):
            raise ApprovalMismatch(
                "approval resolved_identities is malformed; refusing")
        scheduled.append(item["token"])
    expected = param_tokens(params)
    if scheduled != expected:
        raise ApprovalMismatch(
            "approval identity schedule does not match this dispatch's "
            "learner tokens; what the educator saw is not what is being "
            "dispatched")


def _entry_is_write(entry: dict) -> bool:
    """LANE2-4: normalize the effects declaration for the write gate.

    The string "write" and any list/tuple/set containing "write" count
    as a write. A bare ``!= "write"`` comparison treated ["write"] as a
    read and silently bypassed write approval; the list shape is a
    natural caller mistake and must fail closed, not open.
    """
    eff = entry.get("effects", "read")
    if isinstance(eff, str):
        return eff == "write"
    if isinstance(eff, (list, tuple, set, frozenset)):
        return "write" in eff
    return False


def check_write_approval(entry: dict, params: dict, approval: dict | None,
                         op_id: str | None, tenant_base: str | None = None,
                         require_educator_channel: bool = True):
    """Enforce digest-bound, time-boxed, category-scoped educator approval.

    A write is admitted only when the approval record:
      - is a v2 record (v1 records are retired and refused),
      - is educator-signed (by == "educator") with a cited verbatim
        authorization basis (no inferred approvals),
      - carries a valid tamper seal from sign_approval on this machine,
      - names this entry (op) and its operation family (category),
      - carries the op digest recomputed from THIS dispatch's entry name,
        canonical params, and tenant base,
      - is currently valid (issued not in the future, not expired, TTL
        within the maximum),
      - has not been consumed before (single-use; consumed by the
        dispatcher via consume_approval() after every gate passes).
    Anything else raises WriteApprovalMissing or ApprovalMismatch.

    W4-P0-11: the record's "target" block (tenant, course_id,
    course_name, term when known) is for the reviewing educator's eyes;
    it is sealed like every other field, and the gate carries it into
    the journal audit block. Target-identity VERIFICATION (readback
    corroboration plus the provider course GET) runs in the executor's
    write gates, not here.

    Returns (audit_block, signed_record) for the journal and for
    persist_signed_record(); (None, None) for reads.

    This function CHECKS ONLY and never mutates: it verifies the record
    and confirms the digest is not already consumed, but it does not
    consume it. The dispatcher must, after every gate has passed, call
    persist_signed_record(record, op_id) and then consume_approval(record)
    in that order. Persist-before-consume makes every crash state
    recoverable: persisted-but-unconsumed re-admits cleanly on retry,
    and consumed implies persisted, so the complete phase can always
    re-verify an admitted write.
    """
    if not _entry_is_write(entry):
        return None, None
    record, provenance = load_approval(op_id, approval)
    if record is None:
        raise WriteApprovalMissing(
            "effects=write for %r requires an educator-signed v2 approval "
            "record; none was supplied (pass approval=<record> or place it "
            "at %s)" % (entry.get("name"),
                        os.path.join(APPROVALS_DIR, "<op_id>.json")))
    if not isinstance(record, dict) or record.get("version") != APPROVAL_VERSION:
        raise ApprovalMismatch(
            "approval for %r is not a v%d record; v1 approvals (no digest "
            "binding, no expiry, no category) are retired and refused"
            % (entry.get("name"), APPROVAL_VERSION))
    audit = _verify_record_binding(entry, params, record, tenant_base,
                                   provenance,
                                   require_educator_channel=require_educator_channel)
    if _use_key(record) in _load_consumed():
        raise ApprovalMismatch(
            "approval for %r was already consumed; approvals are single-use"
            % entry.get("name"))
    return audit, record


def _normalize_target_tenant(base: str) -> str:
    # W5-P2-3: NFKC + casefold, not just lower(): compatibility-equivalent
    # spellings (full-width host, ligatures) must compare equal, and
    # casefold is the correct Unicode case-insensitive comparison.
    return unicodedata.normalize(
        "NFKC", str(base or "").strip().rstrip("/")).casefold()


def _verify_record_target(record: dict, params: dict,
                          tenant_base: str | None, entry: dict) -> None:
    """Cross-check the approval's human-readable target block against
    this dispatch (W4-P0-11). Raises ApprovalMismatch when the record's
    tenant or course_id disagrees with the dispatch's.

    W4-P0-11 hardening: a course-scoped write (its path targets a
    course, see write_target_course_id) MUST carry a target block
    naming the reviewed tenant, course_id, and course_name; a record
    without one is refused, not admitted on trust. Non-course writes may omit the block, but when present it is
    still cross-checked. The course_name/term comparison against the
    frozen plan and the provider-verified identity happens in the
    executor's verify_write_target_identity, which has both; admission
    binds the block to the dispatch's tenant and course here."""
    target = record.get("target")
    params_cid = write_target_course_id(entry, params)
    if not isinstance(target, dict) or not target:
        if params_cid is not None:
            raise ApprovalMismatch(
                "approval for %r carries no target block, but this is a "
                "course-scoped write (course_id %r): course-write "
                "approvals must name the reviewed tenant, course_id, and "
                "course_name, or they cannot be admitted"
                % (entry.get("name"), params_cid))
        return
    record_tenant = target.get("tenant")
    if record_tenant and tenant_base and \
            _normalize_target_tenant(record_tenant) != \
            _normalize_target_tenant(tenant_base):
        raise ApprovalMismatch(
            "approval for %r was reviewed for tenant %r but this dispatch "
            "targets tenant %r; an approval cannot be retargeted"
            % (entry.get("name"), record_tenant, tenant_base))
    record_cid = target.get("course_id")
    if record_cid is not None and params_cid is not None \
            and str(record_cid) != str(params_cid):
        raise ApprovalMismatch(
            "approval for %r was reviewed for course %r but this dispatch "
            "targets course %r; an approval cannot be retargeted"
            % (entry.get("name"), record_cid, params_cid))


def _verify_record_binding(entry: dict, params: dict, record: dict,
                           tenant_base: str | None, provenance,
                           require_educator_channel: bool = True) -> dict:
    """Shared binding verification for signed v2 approval records.

    Runs every check except presence, version, and single-use consumption:
    the tamper seal, educator identity, the verbatim authorization basis,
    the op name, the operation-family category, time validity
    (not-future, not-expired, TTL within the maximum), the op_digest and
    params_digest binding to THIS dispatch, and the identity schedule
    gate. Returns the journal audit block. Raises ApprovalMismatch on any
    failure.

    W6-P1-A2: require_educator_channel makes the channel stamp an
    ENFORCED gate, not audit-only decoration. When True, a
    driver-channel record (proof drivers, scripts, anything but the
    educator's own chat reply) is refused at dispatch: a fabricated
    "educator-chat" authorization is still only detectable in audit,
    but a lazily-or-maliciously driver-channeled record can no longer
    slip through the production path.

    Consumption is deliberately left to the caller: check_write_approval
    enforces single-use for writes, and the dispatcher burns the record
    exactly once by its persist/consume ordering.
    """
    _verify_seal(record)
    if record.get("by") != "educator":
        raise ApprovalMismatch(
            "approval for %r names approver %r; only the educator can approve "
            "a write (the agent cannot self-approve)" % (entry.get("name"), record.get("by")))
    # W6-P1-A2: the channel stamp is enforced, not decorative, when the
    # caller requires it.
    if require_educator_channel and record.get("channel") != "educator-chat":
        raise ApprovalMismatch(
            "approval for %r is channel %r, not 'educator-chat'; this "
            "dispatch path requires an approval captured from the "
            "educator's own reply (pass require_educator_channel=False "
            "only for proof drivers and tests)"
            % (entry.get("name"), record.get("channel")))
    auth_basis = record.get("authorization")
    if not isinstance(auth_basis, str) or len(auth_basis.strip()) < APPROVAL_AUTH_MIN_LEN:
        raise ApprovalMismatch(
            "approval for %r cites no explicit educator authorization; "
            "inferred or driver-interpreted approvals are not accepted"
            % entry.get("name"))
    if record.get("op") != entry.get("name"):
        raise ApprovalMismatch(
            "approval names operation %r but this dispatch is %r"
            % (record.get("op"), entry.get("name")))
    expected_category = entry_category(entry)
    if record.get("category") != expected_category:
        raise ApprovalMismatch(
            "approval category %r does not match this dispatch's category "
            "%r; an approval is bound to one operation family"
            % (record.get("category"), expected_category))
    now = datetime.datetime.now(datetime.timezone.utc)
    # W6-P2-2: refuse admission while the clock is untrustworthy.
    _check_clock_rollback(now)
    issued = _parse_time(record.get("at"), "at")
    expires = _parse_time(record.get("expires_at"), "expires_at")
    if issued > now + datetime.timedelta(seconds=_APPROVAL_SKEW_SECONDS):
        raise ApprovalMismatch("approval for %r is dated in the future"
                               % entry.get("name"))
    if expires <= now:
        raise ApprovalMismatch("approval for %r expired at %s"
                               % (entry.get("name"), record.get("expires_at")))
    if (expires - issued).total_seconds() > MAX_APPROVAL_TTL_SECONDS:
        raise ApprovalMismatch(
            "approval for %r exceeds the maximum %dh TTL"
            % (entry.get("name"), MAX_APPROVAL_TTL_SECONDS // 3600))
    subject = request_subject(entry, params)
    if record.get("request_digest") != request_digest(subject):
        raise ApprovalMismatch(
            "approval for %r was given for a different request (method, "
            "path, query, or body) than this dispatch sends; the educator "
            "approved exactly what they were shown, so a changed request "
            "needs a new approval" % entry.get("name"))
    expected_digest = op_digest_of(entry.get("name"), params, tenant_base,
                                   expected_category, request=subject)
    if record.get("op_digest") != expected_digest:
        raise ApprovalMismatch(
            "approval op_digest does not match this dispatch (entry, params, "
            "tenant, request); an approval is bound to one specific action "
            "and cannot be reused or retargeted")
    if record.get("params_digest") != canonical_params_digest(params):
        raise ApprovalMismatch(
            "approval params_digest does not match this dispatch's params")
    # W4-P0-11: the human-readable target block is cross-checked against
    # this dispatch, in addition to the cryptographic op_digest binding
    # above: a record the educator reviewed for one course/tenant cannot
    # authorize a dispatch aimed at another.
    _verify_record_target(record, params, tenant_base, entry)
    _check_identity_schedule(record, params)
    audit = {
        "op_digest": expected_digest,
        "params_digest": record.get("params_digest"),
        "by": record.get("by"),
        "channel": record.get("channel", "driver"),
        "provenance": provenance,
        "authorization": record.get("authorization"),
        # W6-P2-A3: the identity schedule's own educator citation, when
        # one was required (non-empty schedule); None otherwise.
        "identity_authorization": record.get("identity_authorization"),
        "issued_at": record.get("at"),
        "expires_at": record.get("expires_at"),
        "category": record.get("category"),
        # W4-P0-11: the human-readable write target the educator
        # reviewed (tenant, course_id, course_name, term when known).
        "target": record.get("target"),
    }
    return audit


def consume_approval(record: dict | None) -> None:
    """Mark one signed approval consumed (single-use, by its use key).

    Call AFTER persist_signed_record(record, op_id) and only after every
    dispatch gate has passed (write halt, frozen plan, duplicate op id,
    concurrency). A gate failure before this point leaves the approval
    unburned, so the educator is never asked to re-authorize because an
    unrelated gate refused the dispatch.

    Ordering guarantee: persist-then-consume. A crash between persist
    and consume leaves a persisted-but-unconsumed record, and the retry
    re-admits cleanly. A crash after consume leaves persisted+consumed,
    and the complete phase re-verifies it. No crash state burns an
    approval without a completable op, and no crash state lets an
    unadmitted write complete. Fails closed on seal or write errors.
    No-op for None (reads return no record).
    """
    if not isinstance(record, dict):
        return
    _verify_seal(record)
    digest = record.get("op_digest")
    if not isinstance(digest, str) or not digest:
        raise ApprovalMismatch(
            "cannot consume an approval record with no op_digest")
    _record_consumed(_use_key(record))


def persist_signed_record(record: dict, op_id: str | None) -> None:
    """Persist the signed approval record (0600) under the final op_id.

    Called by dispatchers after _check_write_gates finalizes the op_id,
    so the complete phase can reload and re-verify the approval. Fails
    closed: if the record cannot be persisted, the admission is refused
    rather than admitted without re-verifiable proof.
    """
    if not op_id or not isinstance(record, dict):
        return
    _ensure_approvals_dir()
    path = os.path.join(APPROVALS_DIR, op_id + ".json")
    tmp = path + ".tmp"
    try:
        # W6-P2-2: 0600 at open, never open-then-chmod.
        _pfd = _open_secret_tmp(tmp)
        with os.fdopen(_pfd, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except OSError as exc:
        raise ApprovalMismatch(
            "cannot persist signed approval record (%s); refusing rather "
            "than admit without re-verifiable proof" % exc)


def approval_audit_for(op_id: str | None):
    """Rebuild the journal audit block from the persisted approval record.

    Used by the complete phase (which runs without the in-process record)
    to re-verify the approval and to journal its provenance. Returns None
    when no record was persisted (reads, or ops admitted before this
    sealing existed).
    """
    record, provenance = load_approval(op_id, None)
    if record is None:
        return None
    try:
        _verify_seal(record)
    except ApprovalMismatch:
        return None
    return {
        "op_digest": record.get("op_digest"),
        "params_digest": record.get("params_digest"),
        "by": record.get("by"),
        "channel": record.get("channel", "driver"),
        "provenance": provenance,
        "authorization": record.get("authorization"),
        "identity_authorization": record.get("identity_authorization"),
        "issued_at": record.get("at"),
        "expires_at": record.get("expires_at"),
        "category": record.get("category"),
    }


def _time_highwater_path():
    # Computed from the CURRENT approvals dir (not frozen at import)
    # so test harnesses that redirect APPROVALS_DIR get a redirected
    # high-water file too.
    return os.path.join(APPROVALS_DIR, "time.highwater")
_CLOCK_ROLLBACK_TOLERANCE_S = 60


def _read_time_highwater():
    """The latest approval-gate time observed (W6-P2-2), or None."""
    try:
        with open(_time_highwater_path(), "r", encoding="utf-8") as f:
            doc = json.load(f)
        return datetime.datetime.fromisoformat(
            str(doc.get("at")).replace("Z", "+00:00"))
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def _write_time_highwater(now: datetime.datetime) -> None:
    """Monotonic: never moves backward (W6-P2-2)."""
    prev = _read_time_highwater()
    if prev is not None and now <= prev:
        return
    try:
        os.makedirs(os.path.dirname(_time_highwater_path()), exist_ok=True)
        tmp = _time_highwater_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps({"at": now.isoformat()}) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, _time_highwater_path())
    except OSError as exc:
        sys.stderr.write(
            "morrow: WARNING: could not persist the approval time "
            "high-water mark: %s; clock-rollback detection is degraded.\n"
            % exc)


def _check_clock_rollback(now: datetime.datetime) -> None:
    """Fail closed on clock rollback (W6-P2-2).

    An unused approval's expiry is only meaningful if the clock is
    trustworthy: rolling the system clock back past an approval's
    issued_at would resurrect its validity window. The high-water
    mark records the latest time the gate has seen; a now more than
    60s behind it (past NTP wobble) refuses admission until the clock
    is corrected. Called with the same `now` the expiry check uses.
    """
    hw = _read_time_highwater()
    if (hw is not None
            and now < hw - datetime.timedelta(
                seconds=_CLOCK_ROLLBACK_TOLERANCE_S)):
        raise ApprovalMismatch(
            "system clock appears to have rolled back (now %s, latest "
            "observed %s): refusing to admit approvals while the clock "
            "is untrustworthy; correct the clock and retry"
            % (now.isoformat(), hw.isoformat()))
    _write_time_highwater(now)


def reverify_approval(entry: dict, params: dict, tenant_base: str | None,
                      op_id: str | None):
    """Re-verify the write approval at the complete phase.

    Reloads the persisted record by op_id, verifies its tamper seal,
    recomputes the op digest from THIS complete's entry/params/tenant,
    and requires the digest in the consumed set (proof the dispatch
    phase admitted it). Returns the journal audit block, or None for
    reads. Refuses (ApprovalMismatch) when a write has no persisted
    record or any check fails: an op that was never admitted cannot
    complete.
    """
    if not _entry_is_write(entry):
        return None
    record, provenance = load_approval(op_id, None)
    if record is None:
        raise ApprovalMismatch(
            "no persisted approval record for op %s; the write was never "
            "admitted and cannot complete" % (op_id,))
    _verify_seal(record)
    # W6-P2-1: the complete phase re-checks expiry. An approval that
    # was valid at dispatch can expire before the op finishes; without
    # this, a slow or stalled op completes on a dead approval.
    # W6-P2-2: same clock-rollback guard as the dispatch gate.
    now = datetime.datetime.now(datetime.timezone.utc)
    _check_clock_rollback(now)
    expires = _parse_time(record.get("expires_at"), "expires_at")
    if expires <= now:
        raise ApprovalMismatch(
            "approval for op %s expired at %s before the complete "
            "phase; refusing to complete on an expired approval"
            % (op_id, record.get("expires_at")))
    expected_category = entry_category(entry)
    subject = request_subject(entry, params)
    if record.get("request_digest") != request_digest(subject):
        raise ApprovalMismatch(
            "persisted approval for op %s was given for a different "
            "request (method, path, query, or body) than this complete; "
            "completing something other than what was approved is "
            "refused" % (op_id,))
    expected_digest = op_digest_of(entry.get("name"), params, tenant_base,
                                   expected_category, request=subject)
    if record.get("op_digest") != expected_digest:
        raise ApprovalMismatch(
            "persisted approval op_digest does not match this complete "
            "(entry, params, tenant, request); completing something other "
            "than what was approved is refused")
    if _use_key(record) not in _load_consumed():
        raise ApprovalMismatch(
            "approval for op %s was never consumed at dispatch; refusing "
            "to complete an unadmitted write" % (op_id,))
    return {
        "op_digest": expected_digest,
        "params_digest": record.get("params_digest"),
        "by": record.get("by"),
        "channel": record.get("channel", "driver"),
        "provenance": provenance,
        "authorization": record.get("authorization"),
        "identity_authorization": record.get("identity_authorization"),
        "issued_at": record.get("at"),
        "expires_at": record.get("expires_at"),
        "category": record.get("category"),
    }


def _is_destructive(entry: dict) -> bool:
    """True when the entry destroys data: HTTP DELETE, or an entry
    explicitly marked destructive. Destructive writes are the one
    category where the educator's confirm_destructive_writes setting
    can still surface a confirmation inside edit mode."""
    if entry.get("destructive") is True:
        return True
    request = entry.get("request") or {}
    return str(request.get("method", "")).upper() == "DELETE"


def _destructive_confirmation_required(user_id) -> bool:
    """The educator's confirm_destructive_writes setting. Fail closed
    (True) when the settings package is unavailable or the read
    fails: a destructive write must never slip through on a settings
    error."""
    try:
        from settings.store import get_setting
        return bool(get_setting(user_id, "confirm_destructive_writes"))
    except Exception:
        return True


def check_mode_authority(entry: dict, params: dict,
                         approval: dict | None, mode_ctx,
                         tenant_base: str | None = None,
                         op_id: str | None = None,
                         require_educator_channel: bool = True,
                         journal: bool = True):
    """Mode-aware write authority gate (modes workstream).

    mode_ctx carries the calling user and, when the dispatcher has one,
    the course resolution:
        {"user_id": "<id>",
         "conversation_id": "<id>",           # optional; scopes grants
         "course_resolution": {"course_id": ..., "confidence": 0.0-1.0,
                               "user_confirmed": bool, "query": ...,
                               "candidates_public": ...},
         "destructive_confirmed": "<verbatim educator yes>"}  # optional

    Reads are untouched (returns (None, None), same as
    check_write_approval). For writes:
      - effective mode "edit" (a live educator grant, or the
        educator's standing default_mode): the write is admitted
        WITHOUT a per-write approval record (that is the point of edit
        mode). The grant usage is journaled with the educator identity
        bound. Returns (mode_audit_block, None): there is no signed
        record to persist, so the dispatcher's persist_signed_record /
        consume_approval calls are no-ops, exactly like reads.
      - destructive writes (HTTP DELETE, or entries marked
        destructive) in edit mode: admitted only with a recorded
        educator confirmation for that action
        (mode_ctx["destructive_confirmed"]) while the educator's
        confirm_destructive_writes setting is on (off by default).
        Otherwise DestructiveConfirmationRequired.
      - effective mode "plan": delegates to check_write_approval, so
        the existing frozen-plan + educator-signed v2 approval path is
        unchanged.
      - a grant that ended (revoked, or a legacy timed grant from an
        older install) is plan mode: the approval path above applies.
      - course resolution below confidence 0.9 without user
        confirmation: AmbiguousCourseWriteRefused (never write on a
        guessed course).
      - no user_id in mode_ctx: fails closed to the plan-mode approval
        path (a mode cannot be resolved without a user identity).

    Every other gate (never-dispatch, unsupported, evidence-holds,
    learner-data) runs in admit() before this hook, in both modes.

    journal=False (a dry run) evaluates the same decision but journals
    nothing: no mode.write_admitted, no mode.write_refused.
    """
    from modes import state as mode_state
    from modes import errors as mode_errors

    def refused(*args, **kwargs):
        if journal:
            mode_state.journal_write_refused(*args, **kwargs)
    if not _entry_is_write(entry):
        return None, None
    ctx = mode_ctx if isinstance(mode_ctx, dict) else {}
    user_id = ctx.get("user_id")
    entry_name = entry.get("name")
    course_id = write_target_course_id(entry, params)
    resolution = ctx.get("course_resolution")
    conversation_id = ctx.get("conversation_id")
    if not user_id:
        # No user identity: a mode cannot be resolved, so fail closed
        # to the plan-mode approval path (behavior unchanged).
        return check_write_approval(entry, params, approval, op_id,
                                    tenant_base=tenant_base,
                                    require_educator_channel=require_educator_channel)
    try:
        decision, code, auth = mode_state.authorize_write(
            user_id, course_id=course_id, resolution=resolution,
            conversation_id=conversation_id, observe=journal)
    except mode_errors.ModeError as exc:
        refused(
            user_id, entry_name, course_id, op_id,
            "mode_error:%s" % type(exc).__name__, str(exc))
        raise
    if decision == "defer":
        # Plan mode: the existing frozen-plan + educator-signed v2
        # approval path, unchanged. When it finds no approval, the
        # educator gets the mode-aware plan_mode_write_without_approval
        # message (not the legacy write-approval-missing one), because
        # the mode gate was consulted and the user is in plan mode.
        try:
            return check_write_approval(
                entry, params, approval, op_id,
                tenant_base=tenant_base,
                require_educator_channel=require_educator_channel)
        except WriteApprovalMissing as exc:
            refused(
                user_id, entry_name, course_id, op_id,
                "plan_mode_write_without_approval", str(exc))
            raise mode_errors.PlanModeWriteWithoutApproval(
                "plan mode: no educator-approved validated plan on file "
                "for this write",
                course_id=course_id) from exc
    if decision == "refuse":
        auth = auth or {}
        refused(
            user_id, entry_name, course_id, op_id, code,
            "mode authority refused this write", auth=auth,
            resolution=resolution)
        if code == "ambiguous_course":
            res = resolution if isinstance(resolution, dict) else {}
            raise mode_errors.AmbiguousCourseWriteRefused(
                "course target is ambiguous; confirm the course with "
                "the user before writing",
                query=res.get("query"),
                candidates_public=res.get("candidates_public"),
                course_id=course_id)
        raise mode_errors.ModeError(
            "mode authority refused this write (%s)" % (code,))
    # "allow": edit mode admits the write without a per-write approval
    # record. Every other gate already ran in admit() before this hook.
    # Destructive writes still need the educator's explicit yes while
    # their confirm_destructive_writes setting is on.
    if _is_destructive(entry) and \
            _destructive_confirmation_required(user_id) and \
            not ctx.get("destructive_confirmed"):
        refused(
            user_id, entry_name, course_id, op_id,
            "destructive_confirmation_required",
            "destructive write needs the educator's explicit confirmation",
            auth=auth, resolution=resolution)
        raise mode_errors.DestructiveConfirmationRequired(
            "this write destroys data (%s); the educator's "
            "confirm_destructive_writes setting is on, so say what will "
            "be destroyed and get an explicit yes before retrying with "
            "destructive_confirmed" % (entry_name,),
            entry_name=entry_name, course_id=course_id)
    if ctx.get("destructive_confirmed"):
        auth = dict(auth or {})
        auth["destructive_confirmed"] = ctx.get("destructive_confirmed")
    if journal:
        mode_state.journal_write_admitted(auth, entry_name, course_id, op_id,
                                          user_id, resolution=resolution)
    educator = auth.get("educator_identity") or {}
    audit = {
        "mode": "edit",
        "scope_type": auth.get("scope_type"),
        "grant_id": auth.get("grant_id"),
        "grant_revision": auth.get("grant_revision"),
        "by": educator.get("by", "educator"),
        "authorization": educator.get("authorization"),
        "course_id": course_id,
    }
    return audit, None


def check_policy_gates(entry: dict, vault_ready: bool = False) -> None:
    """The policy gates admit() runs first: never-dispatch, unsupported,
    evidence-holds, learner-data. Raises an AdmissionRefused subclass."""
    policy = load_policy()
    check_never_dispatch(entry, policy)
    check_unsupported(entry, policy)
    check_evidence_holds(entry, policy)
    check_learner_data(entry, policy, vault_ready)


def admit(entry: dict, params: dict, tenant_base: str | None = None,
          approval: dict | None = None, op_id: str | None = None,
          vault_ready: bool = False,
          require_educator_channel: bool = True,
          mode_ctx: dict | None = None, journal: bool = True):
    """Run the full admission gate for one entry.

    Returns (approval_audit, signed_record): the journal audit block for
    admitted writes (None for reads) plus the signed record the
    dispatcher must persist via persist_signed_record() once the final
    op_id is known, and then mark single-use via consume_approval()
    after every remaining gate has passed. Raises an AdmissionRefused
    subclass on the first failing check, in order: never-dispatch,
    unsupported, evidence-holds, learner-data, write approval.
    Reads need no approval; writes always do.

    mode_ctx (optional) routes the write-authority step through the
    modes workstream's check_mode_authority instead of
    check_write_approval: {"user_id": <id>, "course_resolution": {...}}.
    In edit mode a live educator grant (or the educator's standing
    default) admits the write without a per-write approval record;
    in plan mode the behavior is identical to check_write_approval.
    When mode_ctx is None the gate behaves exactly as before.

    W6-P1-A2: the gate is secure by default. require_educator_channel
    defaults to True and refuses driver-channel records at dispatch
    (proof drivers, scripts, anything but the educator's own chat
    reply). Pass require_educator_channel=False explicitly ONLY for
    proof drivers and tests; production dispatch paths must never do
    this.

    journal=False (a dry run) journals nothing from the mode gate.
    """
    check_policy_gates(entry, vault_ready)
    if mode_ctx is not None:
        return check_mode_authority(entry, params, approval, mode_ctx,
                                    tenant_base=tenant_base, op_id=op_id,
                                    require_educator_channel=require_educator_channel,
                                    journal=journal)
    return check_write_approval(entry, params, approval, op_id,
                                tenant_base=tenant_base,
                                require_educator_channel=require_educator_channel)


def write_approval_template(entry_name: str, params: dict) -> dict:
    """Retired. v1 approval templates are no longer accepted by the gate.

    Use mint_approval(entry, params, tenant_base) + sign_approval(record,
    authorization) to build a v2 record. Kept as a loud failure so old
    callers break visibly instead of minting unusable records.
    """
    raise RuntimeError(
        "write_approval_template is retired; use admission.mint_approval + "
        "admission.sign_approval to build a v2 approval record")


# W6-P2-H3: this module is a library; probing it for a CLI used to exit
# 0 in total silence, indistinguishable from success. Now it prints
# usage (exit 0 for --help/-h, exit 2 otherwise) instead of pretending
# something happened.
_ADMISSION_USAGE = """\
dispatch/admission.py: approval ceremony library.

CLI: rotate-signing-key (W6-P1-2, OPERATOR ONLY): rotate the approval
tamper-seal key, keeping retired keys for verification.
CLI: retire-signing-key <key-id> (W6-P1-2, OPERATOR ONLY): drop a retired
key from the keyring once it is older than 25h, so a compromised retired
key finally loses its forgery power.
CLI: consumed-seal --yes (W6-P1-6, OPERATOR ONLY): one-time adoption of a
pre-seal consumed set; seals the current consumed.json with the active
signing key. Sealing cannot detect pre-seal tampering: reconcile first.

Build an educator-signed v2 approval record in Python:

    from dispatch import admission

    record = admission.mint_approval(entry, params, tenant_base,
                                     ttl_seconds=3600,
                                     target_identity={"course_id": ...,
                                                      "course_name": ...})
    # Show the educator the FULL payload first (W6-P1-A1), in plain
    # words (render_approval_display is the audit detail):
    from dispatch import approval_display
    print(approval_display.render_educator_display(record, params,
                                                   entry=entry))
    # ... educator replies with explicit authorization ...
    signed = admission.sign_approval(
        record, authorization, channel="educator-chat",
        resolved_identities=[{"token": ..., "displayed_as": ...}],
        identity_authorization="...")

Then dispatch with approval=signed. check_write_approval /
admit / reverify_approval enforce the v2 contract at dispatch and
complete time. See dispatch/approval-ceremony.md.
"""


def consumed_seal() -> dict:
    """One-time adoption of a pre-seal consumed set (W6-P1-6 upgrade path).

    Consumed sets written before the integrity seal fail closed on
    first read; this explicit step seals the current consumed.json
    bytes with the active approval signing key. Refuses when the file
    is already sealed and verifying. Callers hold no lock; the seal
    write is atomic and the reader re-verifies.
    """
    if not os.path.exists(CONSUMED_PATH):
        return {"sealed": False,
                "detail": "no consumed set file; nothing to seal"}
    try:
        data = _load_consumed()
        return {"sealed": False,
                "detail": "consumed set is already sealed and verifies "
                         "(%d digests); refusing to re-seal." % len(data)}
    except ApprovalMismatch:
        pass  # adopt the current bytes below
    lock_fd = os.open(CONSUMED_PATH + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            with open(CONSUMED_PATH, "rb") as f:
                raw = f.read()
            try:
                data = json.loads(raw.decode("utf-8"))
                n = len(data) if isinstance(data, dict) else 0
            except ValueError:
                n = 0
            _write_consumed_seal()
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
    finally:
        os.close(lock_fd)
    _invalidate_consumed_cache()
    return {"sealed": True, "digests": n,
            "detail": "adopted the current consumed.json bytes as the "
                      "trust anchor and sealed them. This cannot detect "
                      "tampering that predates the seal."}


def _admission_main(argv):
    if not argv or argv[0] in ("--help", "-h"):
        print(_ADMISSION_USAGE)
        return 0
    if argv[0] == "rotate-signing-key":
        # W6-P1-2: OPERATOR ONLY. Rotate the approval tamper-seal key:
        # mint a fresh 256-bit key as the active sealing key and keep
        # retired keys for verification, so pre-rotation records keep
        # verifying. New seals use the new key immediately.
        kid = rotate_signing_key()
        print(json.dumps({"rotated": True, "active_key_id": kid,
                          "detail": "new approval tamper-seal key %s is "
                                    "active; retired keys kept for "
                                    "verification; after 25h, run "
                                    "retire-signing-key <old-kid> to fully "
                                    "expire the old key" % kid}))
        return 0
    if argv[0] == "retire-signing-key":
        # W6-P1-2: OPERATOR ONLY. Drop a retired approval tamper-seal
        # key from the keyring. Refuses the active key, unknown ids,
        # and keys retired less than 25h ago.
        if len(argv) != 2:
            print("usage: dispatch/admission.py retire-signing-key <key-id>")
            return 2
        kid = retire_signing_key(argv[1])
        print(json.dumps({"retired": True, "key_id": kid,
                          "detail": "approval tamper-seal key %s dropped; "
                                    "records forged under it no longer "
                                    "verify" % kid}))
        return 0
    if argv[0] == "consumed-seal":
        # W6-P1-6: OPERATOR ONLY. One-time adoption of a pre-seal
        # consumed set.
        if argv[1:] != ["--yes"]:
            print("consumed-seal adopts the CURRENT consumed.json bytes "
                  "as the integrity trust anchor; tampering that happened "
                  "before this moment will be blessed, not detected. "
                  "Reconcile first, then re-run with --yes.")
            return 2
        print(json.dumps(consumed_seal()))
        return 0
    print(_ADMISSION_USAGE)
    print("error: unknown argument %r; commands: rotate-signing-key, "
          "retire-signing-key, consumed-seal" % (argv[0],))
    return 2


if __name__ == "__main__":
    import sys as _sys
    _sys.exit(_admission_main(_sys.argv[1:]))
