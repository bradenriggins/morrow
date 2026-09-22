#!/usr/bin/env python3
"""Failure-mode catalog for the Morrow error translation layer.

Loads a JSON catalog (default: the sibling catalog.json, seeded with the
known failure modes). A sibling inventory lane produces the final catalog
at ~/workspace/audits/error-translation-2026-09-22/catalog.json; that file
can be dropped in by passing its path to load_catalog().

Catalog entry schema (every field required except where noted):

  id              stable failure-mode identifier, e.g. "canvas-422-csrf-missing"
  title           short human title
  surface         where the error surfaces in the Morrow tree
  severity_hint   one of "low", "medium", "high", "critical"
  signature       dict of evidence predicates. Each value is either a
                  literal (equality) or {"<op>": operand} where op is one of:
                  eq, neq, contains, not_contains, startswith, lte, gte,
                  in, not_in, exists, truthy, falsy.
                  The reserved key "__any_of" holds a list of alternative
                  predicate dicts; the entry matches when all top-level
                  predicates match AND at least one __any_of branch
                  matches (when __any_of is present).
  root_cause      what the mode actually is (evidence-grounded)
  is_not          what the mode is NOT (optional; used to rule out the
                  look-alike the educator would otherwise assume)
  agent_message   template in four parts, in order: what was attempted /
                  what the evidence showed / what it means / what happens
                  next. Placeholders are filled from evidence + context
                  by translator.py. Missing placeholders render as
                  "(unknown)", never as a crash.
  auto_action     what Morrow does (or did) automatically
  escalate_when   when the agent must escalate to the educator/engineering
  fallback        true only on the "unknown" entry: never matched by
                  signature, used when nothing else matches.

Stdlib only.
"""

from __future__ import annotations

import json
import os

REQUIRED_FIELDS = (
    "id", "title", "surface", "severity_hint", "signature",
    "root_cause", "agent_message", "auto_action", "escalate_when",
)
SEVERITY_HINTS = {"low", "medium", "high", "critical"}
PREDICATE_OPS = {
    "eq", "neq", "contains", "not_contains", "startswith",
    "lte", "gte", "in", "not_in", "exists", "truthy", "falsy",
}
# No em dashes, and no shrug language, may appear in catalog text.
_BANNED_PHRASES = (
    "\u2014",  # em dash (standing rule)
    "i don't know what happened",
    "sorry, i don't know",
    "oh well",
    "no idea what",
)
FALLBACK_ID = "unknown"

_DEFAULT_CATALOG_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "catalog.json")


def _check_predicate_spec(spec, where):
    """Validate one signature predicate value; return an error string or None."""
    if isinstance(spec, dict):
        if not spec:
            return "%s: empty predicate dict" % where
        if len(spec) != 1:
            # LANE2-A: _predicate_matches rejects any multi-operator
            # dict at match time, so validation must reject it at
            # authoring time. Otherwise a catalog could validate while
            # containing a predicate that can never match.
            return ("%s: predicate dict must have exactly one operator "
                    "(matching rejects multi-operator dicts)" % where)
        for op, operand in spec.items():
            if op not in PREDICATE_OPS:
                return "%s: unknown predicate op %r" % (where, op)
        return None
    # Literal: equality. Must be JSON scalar (or null) so matching is total.
    if spec is not None and not isinstance(spec, (bool, int, float, str)):
        return "%s: literal predicate must be a JSON scalar" % where
    return None


def validate_entry(entry) -> list:
    """Validate one catalog entry. Returns a list of problem strings."""
    problems = []
    if not isinstance(entry, dict):
        return ["entry is not an object"]
    entry_id = entry.get("id", "<no id>")
    for field in REQUIRED_FIELDS:
        if field not in entry:
            problems.append("%s: missing required field %r" % (entry_id, field))
    if entry.get("severity_hint") not in SEVERITY_HINTS:
        problems.append("%s: severity_hint must be one of %s"
                        % (entry_id, sorted(SEVERITY_HINTS)))
    signature = entry.get("signature", {})
    if not isinstance(signature, dict):
        problems.append("%s: signature must be an object" % entry_id)
    else:
        for key, spec in signature.items():
            if key == "__any_of":
                if not isinstance(spec, list) or not spec:
                    problems.append("%s: __any_of must be a non-empty list"
                                    % entry_id)
                    continue
                for i, branch in enumerate(spec):
                    if not isinstance(branch, dict) or not branch:
                        problems.append(
                            "%s: __any_of branch %d must be a non-empty object"
                            % (entry_id, i))
                        continue
                    for bkey, bspec in branch.items():
                        err = _check_predicate_spec(
                            bspec, "%s.__any_of[%d].%s" % (entry_id, i, bkey))
                        if err:
                            problems.append(err)
            else:
                err = _check_predicate_spec(spec, "%s.signature.%s" % (entry_id, key))
                if err:
                    problems.append(err)
    # Text checks: no em dashes, no shrug language (case-insensitive).
    for field in ("title", "root_cause", "is_not", "agent_message",
                  "auto_action", "escalate_when"):
        text = entry.get(field)
        if not isinstance(text, str):
            continue
        lowered = text.lower()
        for banned in _BANNED_PHRASES:
            if banned in lowered:
                problems.append("%s: field %r contains banned phrase %r"
                                % (entry_id, field, banned))
    # The four-part message contract: the template must cover all four
    # parts in order (checked on the rendered static text anchors).
    message = entry.get("agent_message")
    if isinstance(message, str) and entry_id != FALLBACK_ID:
        # The fallback entry has its own message contract (checked/extraction
        # anchors) and is exempt from the four-part ordering check.
        anchors = ("what was attempted", "what the evidence showed",
                   "what this means", "what happens next")
        lowered = message.lower()
        positions = [lowered.find(a) for a in anchors]
        if any(p < 0 for p in positions):
            problems.append("%s: agent_message must cover the four parts "
                            "(attempted / evidence / meaning / next)" % entry_id)
        elif positions != sorted(positions):
            problems.append("%s: agent_message four parts are out of order"
                            % entry_id)
    return problems


class Catalog:
    """A validated, order-preserving failure-mode catalog."""

    def __init__(self, entries):
        self.entries = list(entries)
        self.by_id = {e["id"]: e for e in self.entries}

    def get(self, entry_id):
        return self.by_id.get(entry_id)

    def matchable(self):
        """Entries eligible for signature matching (excludes the fallback)."""
        return [e for e in self.entries if not e.get("fallback")]

    def fallback(self):
        entry = self.by_id.get(FALLBACK_ID)
        if entry is None:
            raise KeyError("catalog has no %r fallback entry" % FALLBACK_ID)
        return entry


def load_catalog(path=None) -> Catalog:
    """Load and validate a failure-mode catalog JSON file.

    path defaults to the seeded sibling catalog.json. Raises ValueError
    listing every validation problem, so a dropped-in final catalog
    fails loudly at load time instead of silently mis-translating.
    """
    catalog_path = path or _DEFAULT_CATALOG_PATH
    with open(catalog_path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    entries = doc.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError("catalog %s: 'entries' must be a non-empty list"
                         % catalog_path)
    problems = []
    seen = set()
    for entry in entries:
        problems.extend(validate_entry(entry))
        entry_id = entry.get("id") if isinstance(entry, dict) else None
        if entry_id in seen:
            problems.append("duplicate entry id %r" % entry_id)
        seen.add(entry_id)
    fallback_ids = [e.get("id") for e in entries
                    if isinstance(e, dict) and e.get("fallback")]
    if FALLBACK_ID not in fallback_ids:
        problems.append("catalog must contain the %r fallback entry" % FALLBACK_ID)
    if problems:
        raise ValueError("catalog %s failed validation:\n- %s"
                         % (catalog_path, "\n- ".join(problems)))
    return Catalog(entries)
