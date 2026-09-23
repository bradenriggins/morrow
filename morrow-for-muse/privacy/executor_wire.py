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
import sys
import urllib.parse

# W4-P1-17: config.paths is the single source of truth for the morrow
# state root. executor_wire can be imported before dispatch.executor
# inserts the tree root, so insert it here (no-op when already present).
_EW_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _EW_TREE_ROOT not in sys.path:
    sys.path.insert(0, _EW_TREE_ROOT)

from dispatch import admission as _admission

from privacy import boundary as _boundary
from privacy import core as _privacy_core

# De-identification has no off switch: no record, flag, file, or
# environment variable shows real names to the agent (final sweep
# 2026-09-22 removed the educator reveal record, which did).
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
# Structural person-key rule: a key naming a person or a people
# collection ("students", "participants", "context_user") marks its value
# as person records; a key naming a person's id or ids ("student_ids",
# "participating_user_ids", "author_id") marks its scalars as person ids.
_PERSON_NOUNS = ("user", "student", "author", "participant", "member",
                 "learner", "observer", "observee", "recipient", "submitter",
                 "collaborator", "assessor", "attendee", "enrollee",
                 "person")
_PERSON_NOUN_RE = "(?:%s)" % "|".join(_PERSON_NOUNS)
_PERSON_RECORD_KEY_RE = re.compile(
    r"^(?:[a-z0-9]+_)?(?:%s)s?$|^people$" % _PERSON_NOUN_RE)
_PERSON_ID_KEY_RE = re.compile(
    r"^(?:[a-z0-9]+_)*%s_?ids?$" % _PERSON_NOUN_RE)
# Leading words that make a person-noun key a setting, not a person.
_PERSON_KEY_SETTING_PREFIX = re.compile(
    r"^(?:allow|hide|show|filter|can|is|has|max|min|num|only|visible)_")
_ROSTER_PERSON_NAME_KEYS = ("user_name", "student_name", "author_name",
                            "display_name")
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


def person_key_kind(key):
    """"record" for a key naming a person or people collection, "ids" for
    a key naming a person's id or ids, else None."""
    k = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", str(key or "")).lower()
    if _PERSON_KEY_SETTING_PREFIX.match(k) or k.startswith("sis_"):
        return None
    if _PERSON_ID_KEY_RE.match(k):
        return "ids"
    if _PERSON_RECORD_KEY_RE.match(k):
        return "record"
    return None


_ADHOC_TITLE_RE = re.compile(r"^\s*\d+\s+students?\s*$", re.IGNORECASE)


def _neutralize_adhoc_override_titles(node):
    """Copy of node where an ad hoc override's title is its student count.

    An override that lists student ids is an ad hoc (per-student)
    override, and its title is free text that commonly names the
    students. Its students may not appear anywhere else in the receipt,
    so the name cannot be learned and redacted: the title is replaced by
    the neutral count Canvas itself uses ("1 student", "3 students").
    """
    if isinstance(node, list):
        return [_neutralize_adhoc_override_titles(v) for v in node]
    if not isinstance(node, dict):
        return node
    out = {k: _neutralize_adhoc_override_titles(v) for k, v in node.items()}
    ids = out.get("student_ids")
    title = out.get("title")
    if isinstance(ids, list) and isinstance(title, str) \
            and not _ADHOC_TITLE_RE.match(title):
        out["title"] = "%d student%s" % (len(ids), "" if len(ids) == 1
                                          else "s")
    return out


# Fields on course content (a page's last_edited_by, a record's
# created_by) that hold the person who edited it. The content itself is
# not learner data (it is course material an educator may save back),
# so only these person fields are replaced.
_EDITOR_KEY_RE = re.compile(
    r"^(?:last_)?(?:edited|created|updated|modified|deleted)_by$|"
    r"^(?:last_)?(?:editor|modifier)$")
UNLABELED_PERSON = "a Canvas user Morrow has not labeled"


def _editor_slots(node, out):
    """(container, key) for every person record under an editor key."""
    if isinstance(node, dict):
        for key, value in node.items():
            if _EDITOR_KEY_RE.match(str(key).lower()) and \
                    isinstance(value, dict) and value:
                out.append((node, key))
            else:
                _editor_slots(value, out)
    elif isinstance(node, list):
        for value in node:
            _editor_slots(value, out)
    return out


def _vault_labels_for(entry, tenant_base, lane_context):
    """{learner id: label} for learners the vault already labeled in this
    entry's course scope, or {} when there is no vault to ask."""
    if _privacy_core.AESGCM is None:
        return {}
    course_id = _entry_course_id(entry)
    path = _source_vault_path()
    if not course_id or not os.path.exists(path):
        return {}
    try:
        origin = _exact_origin(tenant_base, ValueError)
    except ValueError:
        return {}
    scope = learner_scope(origin, course_id, entry.get("provider"),
                          (lane_context or {}).get("principal"))
    try:
        vault = _privacy_core.LearnerVault(path)
        known = vault.identities_for_scope(scope)
        labels = vault.tokenize_many(scope, known) if known else []
    except Exception:
        return {}
    return {str(identity["id"]): label
            for identity, label in zip(known, labels)}


def learner_scope(tenant_base, course_id, provider=None, principal=None):
    """The exact vault scope the boundary labels one course's learners
    under. Every labeler and resolver must use this one shape, or a
    label issued by one path would not resolve on another."""
    origin = _exact_origin(tenant_base, ValueError)
    provider = provider or "canvas"
    return {"canvasOrigin": origin,
            "account": "%s:%s:%s" % (provider, provider, origin),
            "course": str(course_id),
            "principal": principal or "local-educator",
            "profile": "source:%s" % provider}


def _label_editor_records(entry, result, tenant_base, lane_context,
                          error_cls):
    """Replace person records under editor keys.

    A learner the vault already labeled in this course becomes
    {"learnerToken": <their label>}; anyone else becomes
    {"person": UNLABELED_PERSON}. Nothing else in the receipt changes.
    Runs on non-learner reads, and on learner reads before the boundary
    (round-4 audit L2: a teacher editor carrying an html_url made a
    whole page-revision read fail closed)."""
    receipt = result.get("receipt") if isinstance(result, dict) else None
    if not _editor_slots(receipt, []):
        return result
    import copy
    receipt = copy.deepcopy(receipt)
    labels = _vault_labels_for(entry, tenant_base, lane_context)
    for container, key in _editor_slots(receipt, []):
        label = labels.get(str(container[key].get("id")))
        container[key] = {"learnerToken": label} if label else \
            {"person": UNLABELED_PERSON}
    out = dict(result)
    out["receipt"] = receipt
    return out


def _harvest_roster(receipt, items_are_people=False):
    """Recursively harvest learner records from a receipt.

    A dict counts as a learner record when it carries a user_id, or when
    it sits under a person key (person_key_kind "record": students,
    participants, members, ...) or carries one of the identity fields and
    has an id. Every scalar under a person-id key (student_ids, user_ids,
    author_id, ...) is a learner id too. Records with an id but no name
    get a synthesized "Learner <id>" name: the id itself is still PII and
    must tokenize, and the synthesized name can never leak real PII. A
    later record with a real name for the same id replaces the
    synthesized one, so free-text mentions of that name are redacted.
    """
    found = []
    by_id = {}
    synthesized = set()

    def add(lid, raw_id, name, node=None):
        if lid in by_id:
            entry = by_id[lid]
            if name and lid in synthesized:
                entry["name"] = name
                synthesized.discard(lid)
            else:
                return
        else:
            entry = {"id": raw_id, "name": name or "Learner %s" % lid}
            if not name:
                synthesized.add(lid)
            by_id[lid] = entry
            found.append(entry)
        for key in _ROSTER_PASSTHROUGH_KEYS:
            value = (node or {}).get(key)
            if isinstance(value, str) and value.strip() != "" \
                    and key not in entry:
                entry[key] = value

    def add_ids(value):
        values = value if isinstance(value, list) else [value]
        for item in values:
            if isinstance(item, bool) or not isinstance(item, (int, str)):
                continue
            if str(item).strip() == "":
                continue
            add(str(item), item, None)

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
            if lid is not None:
                name = None
                # A record keyed by user_id names its person in user_name
                # and the like; its own "name" may be the object's name.
                keys = (_ROSTER_PERSON_NAME_KEYS + _ROSTER_NAME_KEYS) \
                    if "user_id" in node else _ROSTER_NAME_KEYS
                for key in keys:
                    value = node.get(key)
                    if isinstance(value, str) and value.strip() != "":
                        name = value
                        break
                add(lid, node.get("user_id", node.get("id")), name, node)
            for key, value in node.items():
                kind = person_key_kind(key)
                if kind == "ids":
                    add_ids(value)
                    continue
                visit(value, kind == "record")
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

    There is no reveal: every learner read is projected, for the agent
    and for the journal alike. Returns the projected result.
    """
    lane_context = lane_context or {}
    course_id = _entry_course_id(entry)
    if not _admission.touches_learner_data(entry):
        return _label_editor_records(entry, result, tenant_base,
                                     lane_context, error_cls)
    provider = entry.get("provider") or "canvas"
    if not course_id:
        raise error_cls(
            "entry %r touches learner data but carries no course id in its "
            "URLs; no exact-scope privacy binding can be built, refusing "
            "rather than surfacing raw learner PII" % entry.get("name"))
    origin = _exact_origin(tenant_base, error_cls)
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

    result = _label_editor_records(entry, result, tenant_base, lane_context,
                                   error_cls)
    receipt = _neutralize_adhoc_override_titles(result.get("receipt"))
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
    return out


# ---------------------------------------------------------------------------
# Working by name (round-4 privacy audit H3). The educator types a name;
# `morrow students find` resolves it to a course label and records the
# name as educator-introduced for that conversation (privacy/name_echo).
# Outputs echo that name next to the label in that conversation only;
# writes carry labels, and the executor turns them into real ids at the
# LMS boundary (resolve_learner_labels), then back into labels in
# everything the agent or the journal sees (relabel_learner_ids).
# ---------------------------------------------------------------------------

_LABEL_TEXT_RE = re.compile(r"(?<![A-Za-z0-9(])(Student A[1-9][0-9]*)(?![0-9])")
_LABEL_VALUE_RE = re.compile(r"^Student A[1-9][0-9]*$")
_ECHO_VALUE_RE = re.compile(r"^(.+?) \((Student A[1-9][0-9]*)\)$")


def _walk_strings(value, fn, key=""):
    if isinstance(value, str):
        return fn(value, key)
    if isinstance(value, list):
        return [_walk_strings(v, fn, key) for v in value]
    if isinstance(value, dict):
        return {k: _walk_strings(v, fn, k) for k, v in value.items()}
    return value


def issue_labels(tenant_base, course_id, identities, provider=None):
    """Course labels for roster identities, straight from the vault.

    identities: [{"id", "name", "email", "loginId", "sisUserId"}]. Every
    identity is sealed into the vault under learner_scope, so later
    reads project the same student (and any of these identifiers in free
    text) to the same label. Returns the labels in input order. Raises
    when the vault cannot be used (no 'cryptography'): no label, no
    answer. Unlike a projected read this never renders text, so two
    students who share a display name still get their own labels."""
    if _privacy_core.AESGCM is None:
        raise RuntimeError(
            "course labels need the encrypted learner vault, which needs "
            "the 'cryptography' package (requirements-optional.txt)")
    scope = learner_scope(tenant_base, course_id, provider)
    vault = _privacy_core.LearnerVault(_source_vault_path())
    try:
        return vault.tokenize_many(scope, identities)
    finally:
        vault.close()


def apply_name_echo(value, tenant_base, course_id, conversation_id):
    """Show each educator-introduced label as "<typed name> (label)".

    Only labels the educator introduced by name in THIS conversation
    and course (privacy/name_echo) change; every other label stays a
    bare label. Returns a new value; the input is not mutated."""
    if not conversation_id or not course_id:
        return value
    from privacy import name_echo as _echo
    known = _echo.introductions(tenant_base, course_id, conversation_id)
    if not known:
        return value

    def echo(text, _key):
        return _LABEL_TEXT_RE.sub(
            lambda m: "%s (%s)" % (known[m.group(1)], m.group(1))
            if m.group(1) in known else m.group(1), text)
    return _walk_strings(value, echo)


def _same_typed_name(left, right):
    return " ".join(str(left).split()).casefold() == \
        " ".join(str(right).split()).casefold()


# Learner-id positions (final muse audit L3). A label is a learner
# reference only where a learner id belongs: a value under a person-id
# key ("student_ids", "user_id", "assignment_override[student_ids][]"),
# the "id" of a person record ("user": {"id": ...}), or a path parameter
# that follows a person route word ("/users/{id}"). Free text whose
# whole value happens to be a label (a page titled "Student A1") is
# text, and relabeling never touches an object's own id or an
# html_url segment that is not a person route.
_KEY_SEGMENT_RE = re.compile(r"[A-Za-z0-9_]+")
_PERSON_ROUTE_WORD = r"(?:%ss?|people)" % _PERSON_NOUN_RE
_PERSON_ROUTE_SLOT_RE = re.compile(
    r"/%s/\{([A-Za-z0-9_]+)\}" % _PERSON_ROUTE_WORD, re.IGNORECASE)


def _key_segment(key):
    parts = _KEY_SEGMENT_RE.findall(str(key or ""))
    return parts[-1] if parts else ""


def is_learner_id_key(key, parent_key=None):
    """True when a value under key (inside parent_key) is a learner id."""
    segment = _key_segment(key)
    if person_key_kind(segment) == "ids":
        return True
    return segment == "id" and parent_key is not None and \
        person_key_kind(_key_segment(parent_key)) == "record"


def learner_route_param_keys(entry):
    """Path parameter names that sit after a person route word in any of
    the entry's request URLs ("/users/{id}" gives "id")."""
    keys = set()

    def scan(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "url" and isinstance(v, str):
                    keys.update(_PERSON_ROUTE_SLOT_RE.findall(v))
                else:
                    scan(v)
        elif isinstance(node, list):
            for v in node:
                scan(v)
    scan(entry or {})
    return frozenset(keys)


def _map_learner_positions(value, fn, extra_keys=frozenset(), key="",
                           parent=None, in_position=False):
    """Apply fn(text) to every string in a learner-id position."""
    if isinstance(value, str):
        return fn(value) if in_position else value
    if isinstance(value, list):
        return [_map_learner_positions(v, fn, extra_keys, key, parent,
                                       in_position) for v in value]
    if isinstance(value, dict):
        return {k: _map_learner_positions(
            v, fn, extra_keys, k, key,
            is_learner_id_key(k, key) or k in extra_keys)
            for k, v in value.items()}
    return value


def _lookup_learner_refs(value, tenant_base, course_id, conversation_id,
                         error_cls, provider, extra_keys):
    """{reference text: (label, identity, token)} for every label or
    echoed label in a learner-id position of value."""
    refs = []

    def collect(text):
        if _LABEL_VALUE_RE.match(text) or _ECHO_VALUE_RE.match(text):
            refs.append(text)
        return text
    _map_learner_positions(value, collect, extra_keys)
    if not refs:
        return {}
    if _privacy_core.AESGCM is None:
        raise error_cls(
            "this write names a student by label, and turning a label "
            "into the student's LMS id needs the encrypted learner vault "
            "(the optional 'cryptography' package). Nothing was sent.")
    try:
        scope = learner_scope(tenant_base, course_id, provider)
    except ValueError:
        raise error_cls("this write names a student by label, but the "
                        "tenant base is not an exact origin. Nothing was "
                        "sent.")
    path = _source_vault_path()
    if not os.path.exists(path):
        raise error_cls(
            "no student labels have been issued on this machine yet; run "
            "`morrow students find` for course %s first. Nothing was sent."
            % course_id)
    from privacy import name_echo as _echo
    introduced = None
    vault = _privacy_core.LearnerVault(path)
    found = {}
    try:
        for text in refs:
            if text in found:
                continue
            echo = _ECHO_VALUE_RE.match(text)
            label = echo.group(2) if echo else text
            if echo:
                if introduced is None:
                    introduced = _echo.introductions(
                        tenant_base, course_id, conversation_id)
                if not _same_typed_name(introduced.get(label, "\x00"),
                                        echo.group(1)):
                    raise error_cls(
                        "%s is not the student the educator named in this "
                        "conversation for course %s; run `morrow students "
                        "find` again for this course. Nothing was sent."
                        % (label, course_id))
            try:
                identity, token = vault.resolve_with_token(scope, label)
            except _privacy_core.PrivacyError:
                raise error_cls(
                    "%s was never issued in course %s (labels belong to one "
                    "course); run `morrow students find` for this course "
                    "and use the label it returns. Nothing was sent."
                    % (label, course_id))
            found[text] = (label, identity, token)
    finally:
        vault.close()
    return found


def resolve_learner_labels(value, tenant_base, course_id, conversation_id,
                           error_cls=Exception, provider=None,
                           extra_keys=frozenset(), tokens_out=None):
    """Replace learner labels with real LMS ids for ONE course's write.

    A string in a learner-id position (is_learner_id_key, or a key in
    extra_keys such as a person route's path parameter) that is exactly
    a label ("Student A3") or the echoed form ("Jane Doe (Student A3)")
    is a learner reference; it becomes the learner's real id (an int
    when numeric). The label must have been issued in THIS course's
    vault scope, so a label from another course is refused; an echoed
    name must match what the educator typed in this conversation, so a
    stale or cross-course echo is refused. Free text is never rewritten.
    Returns (resolved_value, {str(real_id): label}) so the caller can
    relabel everything the agent or the journal sees afterwards. When
    tokens_out is a dict it receives {label: vault token}.
    """
    found = _lookup_learner_refs(value, tenant_base, course_id,
                                 conversation_id, error_cls, provider,
                                 extra_keys)
    if not found:
        return value, {}
    mapping = {}
    by_text = {}
    for text, (label, identity, token) in found.items():
        raw = identity["id"]
        by_text[text] = int(raw) if raw.isdigit() else raw
        mapping[str(raw)] = label
        if tokens_out is not None:
            tokens_out[label] = token
    return _map_learner_positions(
        value, lambda text: by_text.get(text, text), extra_keys), mapping


def bind_learner_labels(value, tenant_base, course_id, conversation_id,
                        error_cls=Exception, provider=None,
                        extra_keys=frozenset()):
    """What a Plan-mode write stores for the educator's approval.

    Every learner reference in a learner-id position is checked exactly
    as resolve_learner_labels checks it, then stored as the bare label
    (the typed name of an echoed label stays in the encrypted name-echo
    store only). Returns (value_with_bare_labels, {label: vault token});
    the tokens bind the approval to the students, not to the label
    text, and never reveal a real id."""
    found = _lookup_learner_refs(value, tenant_base, course_id,
                                 conversation_id, error_cls, provider,
                                 extra_keys)
    if not found:
        return value, {}
    bare = {text: label for text, (label, _i, _t) in found.items()}
    tokens = {label: token for label, _i, token in found.values()}
    return _map_learner_positions(
        value, lambda text: bare.get(text, text), extra_keys), tokens


# Bookkeeping fields that are never learner references (op ids, claim
# tokens, digests, seals, timestamps): relabeling must never touch them.
_RELABEL_SKIP_KEYS = frozenset({
    "op_id", "of_op_id", "event_id", "claim_token", "claim_token_hash",
    "correlation_id", "rec_hmac", "sig", "ts", "reveal_id", "grant_id"})


def relabel_learner_ids(value, mapping):
    """Put labels back wherever a resolved real id stands for a learner.

    mapping is resolve_learner_labels' {str(real_id): label}. A value in
    a learner-id position (is_learner_id_key) equal to a resolved id
    becomes the label. In other text, an occurrence is relabeled only
    right after a person word ("user 98765", "/users/98765",
    "student_ids": [98765]); inside a URL the label is percent-encoded
    so the URL stays intact. An object's own id or an html_url segment
    that happens to equal a student's id is left alone."""
    if not mapping:
        return value
    ids = sorted(mapping, key=len, reverse=True)
    pattern = re.compile(
        r"(?<![0-9A-Za-z])(%s(?:_ids?)?(?:\[\])?[\"']?"
        r"(?:\s*(?:[:=/#]|%%2[Ff])\s*\[?\s*|\s+))(%s)(?![0-9A-Za-z])"
        % (_PERSON_ROUTE_WORD, "|".join(re.escape(i) for i in ids)),
        re.IGNORECASE)

    def text_fn(text):
        spans = [(m.start(), m.end()) for m in
                 _privacy_core._URL_TOKEN_RE.finditer(text)]

        def sub(match):
            label = mapping[match.group(2)]
            inside = any(a <= match.start(2) < b for a, b in spans)
            return match.group(1) + (urllib.parse.quote(label, safe="")
                                     if inside else label)
        return pattern.sub(sub, text)

    def walk(node, key="", parent=None):
        if key in _RELABEL_SKIP_KEYS or str(key).endswith("_digest"):
            return node
        position = is_learner_id_key(key, parent)
        if isinstance(node, str):
            if position and node in mapping:
                return mapping[node]
            return text_fn(node)
        if isinstance(node, bool):
            return node
        if isinstance(node, int) and position and str(node) in mapping:
            return mapping[str(node)]
        if isinstance(node, list):
            return [walk(v, key, parent) for v in node]
        if isinstance(node, dict):
            return {k: walk(v, k, key) for k, v in node.items()}
        return node
    return walk(value)


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


def _purge_write_ceremony_files(tenant_base=None, course_id=None):
    """Final muse audit M2: prepared writes (pending_writes/) and signed
    approval records (approvals/<op>.json) name students by label and
    carry the educator's words, so every purge removes them too."""
    from dispatch import executor as _ex
    return _ex.purge_write_ceremony_files(tenant_base, course_id)


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
    from privacy import name_echo as _echo
    _echo.purge(origin)
    pending, briefs, inflight_skipped = _purge_transient_state()
    report = {"tenant": origin, "vault_records_purged": records,
              "pending_envelopes_removed": pending,
              "briefs_removed": briefs,
              "inflight_envelopes_skipped": inflight_skipped}
    report.update(_purge_write_ceremony_files(origin))
    return report


def purge_course(tenant_base, course_id, error_cls=Exception):
    """Drop every shipped-vault record for one course on one tenant,
    then purge all browser transient state (same un-scopable rationale
    as purge_tenant). Returns the same report shape."""
    origin = _exact_origin(tenant_base, error_cls)
    vault = _privacy_core.LearnerVault(_source_vault_path())
    records = vault.purge_course(origin, course_id)
    from privacy import name_echo as _echo
    _echo.purge(origin, course_id)
    pending, briefs, inflight_skipped = _purge_transient_state()
    report = {"tenant": origin, "course_id": str(course_id),
              "vault_records_purged": records,
              "pending_envelopes_removed": pending,
              "briefs_removed": briefs,
              "inflight_envelopes_skipped": inflight_skipped}
    report.update(_purge_write_ceremony_files(origin, course_id))
    return report


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
    from privacy import name_echo as _echo
    report["name_echo_removed"] = _echo.remove_all()
    vault_path = _source_vault_path()
    for label, path in (("vault_removed", vault_path),
                        ("vault_key_removed", vault_path + ".key")):
        try:
            os.remove(path)
            report[label] = True
        except OSError:
            pass
    report.update(_purge_write_ceremony_files())
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
