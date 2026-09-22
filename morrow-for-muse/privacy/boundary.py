#!/usr/bin/env python3
"""Faithful Python port of the Morrow source privacy boundary.

Source (read-only):
``~/workspace/origin-morrow/packages/gateway-core/src/source-mcp-privacy.ts``.
This module ports it:

- ``SourceMcpPrivacyBoundary``: wraps a source read/write call. Reads are
  redacted through the exact-scope roster + vault before they surface;
  writes have learner labels/tokens resolved back to real identities before
  provider dispatch. Anything unverifiable returns the
  ``privacy_source_boundary_refused`` failure object; upstream exceptions
  are never copied into the result. The raw lane opens only through the
  internal process capability carried in MCP metadata, never through tool
  arguments.
- ``source_privacy_roster``: strict roster validation/normalization.
- ``canvas_privacy_roster``: the historical identity dictionary (current
  users + deleted enrollments, conflict-checked).
- ``moodle_source_history_available``: which Moodle reads may rely on the
  current roster vs. held former-user content.
- ``source_privacy_input_schema``: extends learner identifier positions in
  a JSON schema with the ``Student A<n>`` label pattern.
- ``source_learner_identifier_fields``: provider routes whose generic field
  name carries a learner identity.

Wiring note: the desktop connector wires this as
``privacy.invoke(toolName, args, meta, handler)`` around every source MCP
tool call (see ``canvas-connector-mcp/src/server.ts``). In this tree the
analogous chokepoint is the browser-lane completion path
(``transport/browser_backend._project_learner_result``), which builds one
verified binding per course scope and runs the receipt through
``invoke``. See ``privacy/README.md``.
"""

import hashlib
import hmac
import json
import re
import urllib.parse

from privacy.core import (
    PrivacyError,
    LearnerRoster,
    LearnerVault,
    canonical_json,
    is_json_object,
    normalize_learner_identity,
    redact_learner_egress,
    resolve_learner_tokens,
)

INTERNAL_SOURCE_CAPABILITY_META = "io.morrow/internal-source-capability"

_CAPABILITY_RE = re.compile(r"^[a-f0-9]{64}$")
_SAFE_INT_MAX = 2 ** 53 - 1


def _is_safe_integer(value):
    return isinstance(value, int) and not isinstance(value, bool) \
        and abs(value) <= _SAFE_INT_MAX


# ---------------------------------------------------------------------------
# sourceLearnerIdentifierFields
# ---------------------------------------------------------------------------

def source_learner_identifier_fields(tool_name):
    """Provider routes whose generic field name carries a learner identity."""
    return ["id"] if tool_name == "canvas_get_single_user" else []


# ---------------------------------------------------------------------------
# sourcePrivacyRoster
# ---------------------------------------------------------------------------

_ALIAS_FIELDS = [
    "sortable_name", "short_name", "display_name", "full_name", "fullname",
    "username", "integration_id", "sis_login_id", "idnumber", "first_name",
    "last_name", "firstname", "lastname", "uuid",
]


def source_privacy_roster(value):
    if not isinstance(value, list) or len(value) > 50_000:
        raise PrivacyError("privacy_roster_invalid")
    seen = set()
    output = []
    for entry in value:
        if not is_json_object(entry) \
                or not isinstance(entry.get("id"), (str, int)) \
                or isinstance(entry.get("id"), bool) \
                or not str(entry["id"]).strip():
            raise PrivacyError("privacy_roster_invalid")
        ident = str(entry["id"])
        if ident in seen:
            raise PrivacyError("privacy_roster_duplicate")
        seen.add(ident)

        def text(key):
            candidate = entry.get(key)
            if candidate is None or candidate == "":
                return None
            if not isinstance(candidate, str) or not candidate.strip() \
                    or len(candidate) > 500:
                raise PrivacyError("privacy_roster_invalid")
            return candidate.strip()

        aliases = entry.get("aliases")
        if aliases is not None and (
                not isinstance(aliases, list) or any(
                    not isinstance(alias, str) or not alias.strip()
                    or len(alias) > 500 for alias in aliases)):
            raise PrivacyError("privacy_roster_invalid")
        name = text("name") or text("fullname")
        if not name:
            raise PrivacyError("privacy_roster_name_required")
        collected = []
        for key in _ALIAS_FIELDS:
            alias_text = text(key)
            if alias_text:
                collected.append(alias_text)
        if isinstance(aliases, list):
            collected.extend(aliases)
        output.append(normalize_learner_identity({
            "id": ident,
            "name": name,
            "email": text("email"),
            "loginId": text("login_id") or text("loginId"),
            "sisUserId": text("sis_user_id") or text("sisUserId"),
            "aliases": collected,
        }))
    return output


# ---------------------------------------------------------------------------
# canvasPrivacyRoster: course enrollment history includes students absent
# from the current Users roster.
# ---------------------------------------------------------------------------

_COURSE_ID_RE = re.compile(r"^[1-9][0-9]*$")


def canvas_privacy_roster(current_users, deleted_enrollments, course_id):
    if not _COURSE_ID_RE.match(str(course_id)) \
            or not isinstance(deleted_enrollments, list) \
            or len(deleted_enrollments) > 50_000:
        raise PrivacyError("privacy_roster_history_invalid")
    identities = {identity["id"]: identity
                  for identity in source_privacy_roster(current_users)}
    for enrollment in deleted_enrollments:
        user = enrollment.get("user") if is_json_object(enrollment) else None
        if not is_json_object(enrollment) \
                or str(enrollment.get("course_id")) != str(course_id) \
                or enrollment.get("type") != "StudentEnrollment" \
                or enrollment.get("enrollment_state") != "deleted" \
                or not is_json_object(user) \
                or not _COURSE_ID_RE.match(str(enrollment.get("user_id"))) \
                or str(user.get("id")) != str(enrollment.get("user_id")):
            raise PrivacyError("privacy_roster_history_mismatch")
        merged_user = dict(user)
        sis = enrollment.get("sis_user_id")
        if sis is not None and sis != "":
            if merged_user.get("sis_user_id") not in (None, "") \
                    and merged_user.get("sis_user_id") != sis:
                raise PrivacyError("privacy_roster_history_conflict")
            merged_user["sis_user_id"] = sis
        identity = source_privacy_roster([merged_user])[0]
        current = identities.get(identity["id"])
        if current is None:
            identities[identity["id"]] = identity
            continue
        for field in ("name", "email", "loginId", "sisUserId"):
            if current.get(field) and identity.get(field) \
                    and current[field] != identity[field]:
                raise PrivacyError("privacy_roster_history_conflict")
        merged_aliases = []
        for alias in (current.get("aliases") or []) \
                + (identity.get("aliases") or []):
            if alias not in merged_aliases:
                merged_aliases.append(alias)
        identities[identity["id"]] = normalize_learner_identity({
            "id": identity["id"],
            "name": current.get("name") or identity.get("name"),
            "email": current.get("email") or identity.get("email"),
            "loginId": current.get("loginId") or identity.get("loginId"),
            "sisUserId": current.get("sisUserId") or identity.get("sisUserId"),
            "aliases": merged_aliases,
        })
    return list(identities.values())


# ---------------------------------------------------------------------------
# moodleSourceHistoryAvailable: Moodle retains visible contributions after
# unenrolment; its Participants table is not a history dictionary.
# ---------------------------------------------------------------------------

_MOODLE_CURRENT_ROSTER_READS = frozenset([
    "moodle_get_course_participant_roster", "moodle_get_course_participants",
    "moodle_get_enrolment_methods", "moodle_get_participant_enrolment",
    "moodle_get_course_groups", "moodle_get_course_groupings",
    "moodle_get_course_dates_report",
])
_MOODLE_LEARNER_AUTHORED_READS = frozenset([
    "moodle_list_glossary_entries", "moodle_get_glossary_entry",
    "moodle_list_wiki_pages", "moodle_get_wiki_page",
])
_MOODLE_HELD_RE = re.compile(
    r"^moodle_.*(?:submission|assignment_feedback|quiz_attempt|"
    r"manual_grading_queue|regrade_report|forum_posts|forum_post_target|"
    r"forum_activity_summary|scorm_learner_report|scorm_attempt_summary|"
    r"learner_grade_report|grade_report_summary|response_summary|"
    r"entry_summary|course_activity_report|course_participation_report|"
    r"course_completion_report|course_log_summary|message|conversation|"
    r"history)")


def moodle_source_history_available(tool_name, data_class=None):
    if tool_name in _MOODLE_CURRENT_ROSTER_READS:
        return True
    return data_class != "learner" \
        and tool_name not in _MOODLE_LEARNER_AUTHORED_READS \
        and not _MOODLE_HELD_RE.match(tool_name)


# ---------------------------------------------------------------------------
# sourcePrivacyInputSchema: extend only learner identifier positions; course
# and object identifiers retain their contract.

# ---------------------------------------------------------------------------
# SourceMcpPrivacyBoundary
# ---------------------------------------------------------------------------

def _failure():
    return {
        "isError": True,
        "content": [{
            "type": "text",
            "text": "Morrow refused this source request because its course "
                    "privacy boundary could not be verified.",
        }],
        "structuredContent": {
            "schema": "morrow.problem.v1",
            "ok": False,
            "code": "privacy_source_boundary_refused",
            "recoverable": False,
        },
    }


def _binding_identity(binding):
    return json.dumps([
        binding.get("sourceBindingId"), binding.get("provider"),
        binding.get("courseId"), binding.get("origin"),
        binding.get("siteUrl"), binding.get("principalFingerprint"),
        binding.get("accountFingerprint"), binding.get("sessionGeneration"),
        binding.get("catalogDigest"), binding.get("runtimeVerified"),
    ], ensure_ascii=False, separators=(",", ":"), sort_keys=False)


_PRIVATE_TOOL_RE = re.compile(
    r"^(?:morrow_private_|canvas_send_private_|canvas_transfer_course_file|"
    r"canvas_create_new_quiz_hot_spot|morrow_bridge_maintenance|"
    r"morrow_browser_edit_policy_set)")
_LEGACY_DONOR_TOKEN_RE = re.compile(r"\bStudent_[A-Za-z0-9_-]+\b")
_BINDINGS_TOOLS = frozenset([
    "morrow_canvas_bindings", "morrow_browser_bindings",
    "morrow_legacy_bindings",
])


class SourceMcpPrivacyBoundary:
    """Faithful port of ``SourceMcpPrivacyBoundary``.

    ``options`` keys (mirroring ``SourceMcpPrivacyOptions``):

    - ``source``: source name used in scope derivation (e.g. ``canvas``).
    - ``internal_source_capability``: optional 64-hex process capability
      that opens the raw lane. It is compared with ``hmac.compare_digest``;
      it is never read from tool arguments.
    - ``learner_vault_path``: optional vault directory.
    - ``bindings``: callable returning the current list of
      ``SourcePrivacyBinding`` dicts.
    - ``accepts_course_request``: optional callable
      ``(tool_name, args, binding) -> bool``.
    - ``load_roster``: callable ``(binding) -> list`` returning the
      complete roster for the binding. It is called before provider
      dispatch; an incomplete roster fails the call.

    ``invoke(tool_name, args, meta, handler)`` wraps one source call.
    ``handler`` is a sync callable taking the resolved args dict. Reads
    are redacted through the exact-scope roster + vault; writes have
    learner labels/tokens resolved to real identities first. Anything
    unverifiable returns the ``privacy_source_boundary_refused``
    failure object, and upstream exceptions are never copied into the
    result.
    """

    def __init__(self, options):
        capability = options.get("internal_source_capability")
        if capability is not None \
                and not _CAPABILITY_RE.match(capability):
            raise PrivacyError("privacy_source_capability_invalid")
        self._source = options["source"]
        self._capability = capability
        self._vault = LearnerVault(
            options.get("learner_vault_path", ":memory:"))
        self._bindings = options["bindings"]
        self._accepts_course_request = options.get("accepts_course_request")
        self._load_roster = options["load_roster"]

    # -- capability ------------------------------------------------------
    def _authenticated(self, meta):
        supplied = meta.get(INTERNAL_SOURCE_CAPABILITY_META) \
            if is_json_object(meta) else None
        return bool(self._capability and isinstance(supplied, str)
                    and _CAPABILITY_RE.match(supplied)
                    and hmac.compare_digest(self._capability, supplied))

    # -- binding ---------------------------------------------------------
    def _context(self, binding):
        if not binding.get("runtimeVerified") or not binding.get("courseId") \
                or not binding.get("origin") \
                or not binding.get("principalFingerprint") \
                or not _is_safe_integer(
                    binding.get("sessionGeneration")) \
                or not binding.get("catalogDigest"):
            raise PrivacyError("privacy_binding_invalid")
        parsed = urllib.parse.urlparse(binding["origin"])
        port = parsed.port
        if (parsed.scheme == "https" and port == 443) \
                or (parsed.scheme == "http" and port == 80):
            port = None
        origin = "%s://%s%s" % (
            parsed.scheme, parsed.hostname.lower() if parsed.hostname else "",
            (":%d" % port) if port else "")
        if origin != binding["origin"] \
                or parsed.scheme not in ("http", "https"):
            raise PrivacyError("privacy_binding_invalid")
        provider = binding.get("provider")
        learner_scope = {
            "canvasOrigin": origin,
            "account": binding.get("accountFingerprint")
            or "%s:%s:%s" % (self._source, provider, origin),
            "course": binding["courseId"],
            "principal": binding["principalFingerprint"],
            "profile": "source:%s" % self._source,
        }
        roster = LearnerRoster()
        roster.register(learner_scope, self._load_roster(binding))
        self._assert_current(binding)
        return {"learnerRoster": roster, "learnerVault": self._vault,
                "learnerScope": learner_scope}

    def _assert_current(self, binding):
        current = [candidate for candidate in self._bindings()
                   if candidate.get("sourceBindingId")
                   == binding.get("sourceBindingId")]
        if len(current) != 1 \
                or _binding_identity(current[0]) != _binding_identity(binding):
            raise PrivacyError("privacy_binding_changed")

    # -- invocation ------------------------------------------------------
    def invoke(self, tool_name, args, meta, handler):
        try:
            if self._authenticated(meta):
                # The raw lane is a process capability, never a tool
                # argument or catalog option.
                result = handler(dict(args))
                return result if is_json_object(result) else _failure()
            if is_json_object(meta) \
                    and INTERNAL_SOURCE_CAPABILITY_META in meta:
                return _failure()
            if tool_name.endswith("_health"):
                return {
                    "content": [{
                        "type": "text",
                        "text": "Morrow source is available. Course reads "
                                "require a verified course connection and "
                                "complete roster.",
                    }],
                    "structuredContent": {
                        "ok": True,
                        "schema": "morrow.source-public-health.v1",
                    },
                }
            if tool_name in _BINDINGS_TOOLS:
                bindings = []
                for binding in self._bindings():
                    context = self._context(binding)
                    projected = redact_learner_egress({
                        "sourceBindingId": binding.get("sourceBindingId"),
                        "provider": binding.get("provider"),
                        "courseId": binding.get("courseId"),
                        "origin": binding.get("origin"),
                        "runtimeVerified": True,
                    }, context)
                    if not is_json_object(projected):
                        raise PrivacyError("privacy_binding_invalid")
                    bindings.append(projected)
                return {
                    "content": [{
                        "type": "text",
                        "text": "Morrow checked the course connections.",
                    }],
                    "structuredContent": {
                        "ok": True, "bindings": bindings,
                        "count": len(bindings),
                    },
                }
            # These controls take raw private payloads or manage more than
            # one course.
            if _PRIVATE_TOOL_RE.match(tool_name):
                return _failure()
            controls = args.get("_morrow") \
                if is_json_object(args.get("_morrow")) else {}
            binding_id = controls.get("source_binding_id")
            if binding_id is None:
                binding_id = args.get("source_binding_id")
            matches = [candidate for candidate in self._bindings()
                       if candidate.get("sourceBindingId") == binding_id]
            if len(matches) != 1:
                return _failure()
            binding = dict(matches[0])
            requested_course = args.get("course_id")
            if requested_course is None:
                requested_course = args.get("courseId")
            if requested_course is not None \
                    and str(requested_course) != binding.get("courseId"):
                return _failure()
            if self._accepts_course_request is not None \
                    and not self._accepts_course_request(
                        tool_name, args, binding):
                return _failure()
            context = self._context(binding)
            resolved = resolve_learner_tokens(
                args, self._vault, context["learnerScope"],
                context["learnerRoster"],
                source_learner_identifier_fields(tool_name))
            result = handler(resolved)
            self._assert_current(binding)
            # Legacy donor tokens have no identity proof in this source vault.
            if _LEGACY_DONOR_TOKEN_RE.search(json.dumps(result)):
                return _failure()
            projected = redact_learner_egress(result, context)
            if is_json_object(projected) \
                    and "[learner]" not in json.dumps(projected):
                return projected
            return _failure()
        except Exception:
            # Never copy an upstream exception into an MCP error, including
            # raw-lane errors.
            return _failure()

# ---------------------------------------------------------------------------
# sourcePrivacyInputSchema: extend only learner identifier positions; course
# and object identifiers retain their contract.
# ---------------------------------------------------------------------------

_SCHEMA_FIELD_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,79}$")
_SCHEMA_LEARNER_KEY_RE = re.compile(
    r"^(?:user|student|learner|recipient|author|participant)(?:s|_?ids?)?$",
    re.IGNORECASE)


def source_privacy_input_schema(schema,
                                additional_learner_identifier_fields=()):
    learner_identifier_fields = set(additional_learner_identifier_fields)
    if any(not _SCHEMA_FIELD_RE.match(field)
           for field in learner_identifier_fields):
        raise TypeError("privacy learner identifier field is invalid")

    def walk(value, key=""):
        if isinstance(value, list):
            return [walk(entry, key) for entry in value]
        if not is_json_object(value):
            return value
        output = {}
        for field, child in value.items():
            if field == "properties" and is_json_object(child):
                output[field] = {name: walk(definition, name)
                                 for name, definition in child.items()}
            else:
                output[field] = walk(child, key)
        if (_SCHEMA_LEARNER_KEY_RE.match(key)
                or key in learner_identifier_fields) \
                and value.get("type") != "array" \
                and value.get("type") in ("number", "integer", "string"):
            return {
                "anyOf": [output,
                          {"type": "string",
                           "pattern": "^Student A[1-9][0-9]*$"}],
                "description":
                    "Use the course learner pseudonym returned by Morrow.",
            }
        return output

    return walk(schema)
