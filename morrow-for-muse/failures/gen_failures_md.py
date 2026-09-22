#!/usr/bin/env python3
"""One-shot generator for ~/workspace/morrow-for-muse-deploy/FAILURES.md.

Reads failures/catalog.json and renders one section per cataloged
failure mode, plus the fallback contract and the how-to-add-a-mode
guide. Re-run after catalog changes. No em dashes in output.
"""

import json
import os

TREE = os.path.expanduser("~/workspace/morrow-for-muse-deploy")
CATALOG = os.path.join(TREE, "failures", "catalog.json")
OUT = os.path.join(TREE, "FAILURES.md")


def _render_value(value):
    if isinstance(value, str):
        return '"%s"' % value
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    return json.dumps(value)


def _render_predicate(key, spec):
    if isinstance(spec, dict):
        if len(spec) != 1:
            return "%s has a compound predicate" % key
        op, operand = next(iter(spec.items()))
        if op == "eq":
            return "%s is %s" % (key, _render_value(operand))
        if op == "neq":
            return "%s is not %s" % (key, _render_value(operand))
        if op == "contains":
            return '%s contains "%s"' % (key, operand)
        if op == "not_contains":
            return '%s does not contain "%s"' % (key, operand)
        if op == "startswith":
            return '%s starts with "%s"' % (key, operand)
        if op == "lte":
            return "%s <= %s" % (key, _render_value(operand))
        if op == "gte":
            return "%s >= %s" % (key, _render_value(operand))
        if op == "in":
            return "%s is one of [%s]" % (
                key, ", ".join(_render_value(v) for v in operand))
        if op == "not_in":
            return "%s is none of [%s]" % (
                key, ", ".join(_render_value(v) for v in operand))
        if op == "exists":
            return ("%s is present" if operand else "%s is absent") % key
        if op == "truthy":
            return "%s is truthy" % key
        if op == "falsy":
            return "%s is falsy" % key
        return "%s %s %s" % (key, op, _render_value(operand))
    return "%s is %s" % (key, _render_value(spec))


def _render_signature(signature):
    top = []
    for key, spec in signature.items():
        if key == "__any_of":
            continue
        top.append(_render_predicate(key, spec))
    branches = signature.get("__any_of") or []
    if branches:
        rendered = []
        for branch in branches:
            rendered.append("(%s)" % " AND ".join(
                _render_predicate(k, v) for k, v in branch.items()))
        top.append("at least one of: %s" % " OR ".join(rendered))
    return " AND ".join(top) if top else "(matches anything)"


def _para(text):
    return (text or "").strip()


def main():
    with open(CATALOG, encoding="utf-8") as fh:
        catalog = json.load(fh)
    entries = catalog["entries"]
    assert "\u2014" not in json.dumps(catalog), "catalog has an em dash"

    lines = []
    a = lines.append
    a("# Morrow failure-mode catalog: what each failure means and what to do")
    a("")
    a("This document is generated from `failures/catalog.json` (%d modes)."
      % len(entries))
    a("It is the human-readable companion to the error translation layer:")
    a("every agent-facing error in the Morrow connector is translated")
    a("through `failures/translator.py` into one of these modes before the")
    a("agent ever sees it. The agent never sees raw exception text as the")
    a("primary message; raw text survives only inside the clearly-labeled,")
    a("sanitized, truncated `engineering_detail` field.")
    a("")
    a("## How to read an entry")
    a("")
    a("- **Signature**: the observable evidence that identifies the mode.")
    a("  When every clause holds, the translator classifies the failure as")
    a("  this mode. The most specific matching mode wins.")
    a("- **What it is NOT**: the common misdiagnosis, ruled out so nobody")
    a("  chases the wrong fix.")
    a("- **Auto-remediation**: what the agent does on its own, no educator")
    a("  approval needed.")
    a("- **Escalate when**: the conditions under which the agent must bring")
    a("  the educator (or engineering) in.")
    a("")
    a("## The four-part message contract")
    a("")
    a("Every translated error the agent sees carries four parts, in order:")
    a("")
    a("1. **What was attempted**: the operation, in plain words.")
    a("2. **What the evidence showed**: the observations that identify the")
    a("   mode (status codes, session health, rate-limit state, and so on).")
    a("3. **What it means**: the root cause, plus what it is not.")
    a("4. **What happens next**: the auto-remediation and the concrete")
    a("   next step.")
    a("")
    a("Plus machine fields: `mode_id`, `correlation_id`, `auto_action`,")
    a("`escalate`, and the labeled `engineering_detail`.")
    a("")
    a("## The modes")
    a("")

    for entry in entries:
        a("### %s" % entry["id"])
        a("")
        a("**%s**" % entry["title"])
        a("")
        a("- Surface: %s" % entry["surface"])
        a("- Severity hint: %s" % entry["severity_hint"])
        a("- Signature (observable evidence): %s"
          % _render_signature(entry.get("signature", {})))
        a("- What it is: %s" % _para(entry.get("root_cause")))
        a("- What it is NOT: %s" % _para(entry.get("is_not")))
        a("- Auto-remediation: %s" % _para(entry.get("auto_action")))
        a("- Escalate when: %s" % _para(entry.get("escalate_when")))
        a("")

    a("## The unknown fallback: the contract when nothing matches")
    a("")
    a("Mode id `unknown` is never matched by a signature. When no catalog")
    a("signature fits the evidence, the translator falls through to it.")
    a("The contract is strict: no shrug is ever rendered. The agent gets a")
    a("structured message with the same four parts, a fresh correlation")
    a("id, and `escalate: true`, always. The auto-remediation is: capture")
    a("the full evidence bundle to the journal and the engineering log,")
    a("park the op, and never blind-retry. If the op was write-class and")
    a("might have applied, reconcile with a readback before any")
    a("re-dispatch. The agent surfaces the evidence summary and the")
    a("concrete next step to the educator and routes the full bundle to")
    a("engineering. Unknown is a classification outcome, not an excuse to")
    a("guess: the message states exactly what was checked and what is")
    a("still unknown.")
    a("")
    a("## How to add a new failure mode")
    a("")
    a("1. **Write the evidence first.** A mode earns a catalog entry only")
    a("   when its signature is observable and reproducible: status codes,")
    a("   body markers, session health, rate-limit state, route kind, or")
    a("   exception class names. A hunch is not a signature.")
    a("2. **Add the entry to `failures/catalog.json`.** Required fields:")
    a("   `id` (stable, kebab-case), `title`, `surface`, `severity_hint`")
    a("   (low, medium, high, critical), `signature` (evidence predicates;")
    a("   each value is a literal for equality or an object with one")
    a("   predicate op: eq, neq, contains, not_contains, startswith, lte,")
    a("   gte, in, not_in, exists, truthy, falsy; the reserved key")
    a("   `__any_of` holds alternative predicate groups where at least one")
    a("   must match), `root_cause`, `agent_message` (the four parts in")
    a("   order, using the documented placeholders), `auto_action`,")
    a("   `escalate_when`. Optional: `is_not` (write it whenever a")
    a("   look-alike misdiagnosis exists), `signature_notes`. Never set")
    a("   `fallback: true` on a real mode; only the `unknown` entry has it.")
    a("3. **Check the overlap.** The most specific matching signature wins,")
    a("   with ties broken by catalog order. If the new mode overlaps an")
    a("   existing one, make the signatures disjoint or order the more")
    a("   specific entry so it wins. Run the translator against the old")
    a("   mode's evidence to prove the new entry does not steal it.")
    a("4. **Validate.** `failures/catalog.py` validates every entry")
    a("   (required fields, predicate ops, no em dashes, no shrug")
    a("   language). The catalog must load with zero validation errors.")
    a("5. **Add a selftest case.** Cover the new signature in")
    a("   `failures/selftest_smoke.py` (mode id, the tiebreakers it must")
    a("   win or lose) and, if it touches the agent surface, in")
    a("   `failures/selftest_wiring.py` (four anchors, correlation id,")
    a("   escalate flag).")
    a("6. **Regenerate this document.** Re-run this generator")
    a("   (`failures/gen_failures_md.py`) so FAILURES.md stays in sync")
    a("   with the catalog.")
    a("")

    text = "\n".join(lines)
    assert "\u2014" not in text, "generated doc has an em dash"
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("wrote %s (%d modes)" % (OUT, len(entries)))


if __name__ == "__main__":
    main()
