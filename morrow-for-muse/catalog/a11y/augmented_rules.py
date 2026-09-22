#!/usr/bin/env python3
"""Morrow-extended augmented accessibility rules for Morrow for Muse.

Layering
--------
Canvas's own checker ships 13 rules; the sibling module
``canvas_parity_rules.py`` ports them verbatim. This module runs AFTER it and
implements ONLY checks that go beyond Canvas's built-in checker. It never
re-implements a Canvas-parity rule. Every finding carries
``source: "morrow-extended"`` and a ``morrow-`` prefixed rule id.

Stdlib only. No network access, no browser contact, no Canvas reads. The
caller supplies already-read HTML; the New Quiz and Item Bank checks work on
the HTML fields the caller extracted from item content (this module never
fetches item JSON itself).

The HTML-level rules are carried over from ``a11y_signals.py`` (the
desktop-derived 18-signal detector) by delegation: this module loads
``a11y_signals.py`` from its own directory and calls its ``scan_html``,
re-labeling the Morrow-only signals with ``morrow-`` rule ids, so the
semantics stay identical to the detector Morrow already ships. The signals
Morrow shares with Canvas's checker (missing alt on page content, heading
jumps, table caption/header/scope) live in the parity module, not here.

Detection/repair linkage
------------------------
The image indexes and ``image_src_sha256`` digests in these findings line up
with the ``image_tags_without_alt`` evidence that
``a11y_repair.validate_repair_plan`` expects, so an alt finding can flow into
a repair plan. Detection is broader than repair on purpose: stimulus passages
are flagged here (Braden's order covers stimuli), but the repair planners
refuse stimulus (``blocked_current_contract``), so a stimulus finding is
detection-only. Detection never consults the protected-quiz rule; that guard
lives in the repair planners.

Context contract
----------------
``check_html(html, context)``. ``context`` is a plain dict:

- New Quiz item content: ``{"target": "new_quiz_item", "quiz_id": "...",
  "item_id": "...", "section": "stem" | "stimulus" | "choice" |
  "answer_feedback" | "general_feedback", "choice_id": "..."}`` (``choice_id``
  only for the choice section). A bare ``quiz_id`` + ``item_id`` pair with no
  target is accepted and means the same thing.
- Item Bank item content: ``{"target": "item_bank_item", "bank_id": "...",
  "item_id": "..."}``. A bare ``bank_id`` + ``item_id`` pair is accepted.
  When both a quiz and a bank are named, the bank wins.
- Quiz instructions: ``{"target": "quiz_instructions", "quiz_id": "...",
  "quiz_type": "new_quiz" | "classic"}``. ``html`` is the instructions or
  description field itself.
- Anything else (including no context): generic HTML content. Only the
  HTML-only augmented rules run.

An explicit ``target`` with missing required ids raises ``ValueError``
(fail closed): silently auditing the wrong surface is worse than refusing.

Honesty standard (non-negotiable, carried over from desktop)
-----------------------------------------------------------
Every finding is a signal that needs human review, never a violation. Every
list stops at ``MAX_FINDINGS_PER_RULE`` and a truncated list is incomplete
evidence for that field, never a pass. No finding and no finding set
establishes accessibility or WCAG conformance.
"""

import importlib.util as _ilu
import os as _os

ENGINE = "morrow-augmented"
SOURCE_TAG = "morrow-extended"
MAX_FINDINGS_PER_RULE = 100  # Mirrors a11y_signals per-signal entry limit.

RULE_IDS = (
    "morrow-nq-item-image-alt",
    "morrow-bank-item-image-alt",
    "morrow-quiz-instructions-empty",
    "morrow-quiz-instructions-image-alt",
    "morrow-media-no-caption-track",
    "morrow-media-autoplay",
    "morrow-iframe-no-title",
    "morrow-aria-hidden-focusable",
    "morrow-link-no-text",
    "morrow-link-bare-url",
    "morrow-link-generic-text",
    "morrow-decorative-image-with-alt",
    "morrow-table-unclosed",
)

# Plain-English "why this goes beyond Canvas" per rule. Each finding's note
# is: "This check goes beyond Canvas's built-in accessibility checker. " +
# this text + " Signal for human review, never a conformance finding."
RULE_NOTES = {
    "morrow-nq-item-image-alt":
        "Canvas's built-in checker scans page, assignment, and discussion "
        "HTML, but it never looks inside New Quiz items. Morrow scans the "
        "item's own content fields (stem, stimulus passage, answer choices, "
        "answer feedback, and general feedback) for images with no alt "
        "attribute, which give a screen reader nothing to announce.",
    "morrow-bank-item-image-alt":
        "Canvas's built-in checker never scans Item Bank content. Morrow "
        "scans bank item HTML for images with no alt attribute. Desktop "
        "Morrow's rule stands: a bank item image always needs real "
        "alternative text, never a decorative marking.",
    "morrow-quiz-instructions-empty":
        "Canvas's checker has no rule about empty quiz instructions. Morrow "
        "flags instructions or description fields that are empty or "
        "whitespace-only, because learners then get no guidance about the "
        "quiz.",
    "morrow-quiz-instructions-image-alt":
        "Canvas's checker never treats quiz instructions as an "
        "accessibility surface. Morrow scans the instructions or "
        "description field for images with no alt attribute, the same as "
        "any other content.",
    "morrow-media-no-caption-track":
        "None of Canvas's 13 built-in rules covers media. Morrow flags "
        "video and audio elements with no captions or subtitles track, "
        "since deaf and hard-of-hearing learners need a text alternative.",
    "morrow-media-autoplay":
        "None of Canvas's 13 built-in rules covers autoplay. Morrow flags "
        "video and audio with the autoplay attribute, which can startle "
        "learners and talk over screen-reader speech.",
    "morrow-iframe-no-title":
        "None of Canvas's 13 built-in rules covers iframes. Morrow flags "
        "iframes with no title attribute, which give assistive technology "
        "no name for the embedded frame.",
    "morrow-aria-hidden-focusable":
        "None of Canvas's 13 built-in rules inspects ARIA states. Morrow "
        "flags focusable elements marked aria-hidden=true, which stay "
        "keyboard-reachable while hidden from assistive technology.",
    "morrow-link-no-text":
        "None of Canvas's 13 built-in rules judges link text. Morrow flags "
        "links with no text and no accessible name, which give "
        "screen-reader users nothing to activate.",
    "morrow-link-bare-url":
        "None of Canvas's 13 built-in rules judges link text. Morrow flags "
        "links whose visible text is a bare URL, which forces screen "
        "readers to announce a raw address instead of a meaningful label.",
    "morrow-link-generic-text":
        "None of Canvas's 13 built-in rules judges link text. Morrow flags "
        "links with generic text such as click here, which says nothing "
        "about the destination out of context.",
    "morrow-decorative-image-with-alt":
        "Canvas's img-alt rule passes any image with a present alt "
        "attribute, including images marked role=presentation. Morrow "
        "flags decorative-marked images that still carry non-empty alt "
        "text, because the marking and the text contradict each other.",
    "morrow-table-unclosed":
        "Canvas's table rules check captions, headers, and scope, but never "
        "whether the table markup was closed. Morrow flags tables left "
        "unclosed in the saved source, which can render unpredictably.",
}

INTERPRETATION = (
    "Morrow-extended augmented layer. Every finding is a signal that needs "
    "human review, never a violation. These checks go beyond what Canvas's "
    "built-in accessibility checker looks at; they do not prove or disprove "
    "WCAG conformance, and no signal set here establishes conformance."
)

# Sections of a New Quiz item that map onto a repair planner kind in
# a11y_repair.py. Stimulus has no planner (blocked_current_contract), so a
# stimulus finding carries no repair_kind and is detection-only.
_NQ_SECTION_REPAIR_KIND = {
    "stem": "new_quiz_item",
    "choice": "new_quiz_choice",
    "answer_feedback": "new_quiz_answer_feedback",
    "general_feedback": "new_quiz_feedback",
}

_TARGETS = ("new_quiz_item", "item_bank_item", "quiz_instructions")


def _load_signals_module():
    """Load a11y_signals.py from this module's own directory.

    File-location loading (not a package import) so the module works whether
    it is run as a script, loaded by importlib from a path, or imported with
    its directory on sys.path.
    """
    here = _os.path.dirname(_os.path.abspath(__file__))
    path = _os.path.join(here, "a11y_signals.py")
    spec = _ilu.spec_from_file_location("morrow_augmented_a11y_signals", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load a11y_signals.py from %r." % (path,))
    module = _ilu.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_signals = _load_signals_module()
_scan_html = _signals.scan_html


# Upstream signal names from a11y_signals.scan_html that feed each augmented
# rule. Used to surface upstream per-signal truncation in this module's
# limits block, so a capped upstream list is never mistaken for complete
# evidence.
_SIGNAL_TO_RULES = {
    "image_tags_without_alt": ("morrow-nq-item-image-alt",
                               "morrow-bank-item-image-alt",
                               "morrow-quiz-instructions-image-alt"),
    "images_marked_decorative_with_alt_text": ("morrow-decorative-image-with-alt",),
    "media_without_caption_track": ("morrow-media-no-caption-track",),
    "autoplay_media": ("morrow-media-autoplay",),
    "iframes_without_title": ("morrow-iframe-no-title",),
    "aria_hidden_on_focusable": ("morrow-aria-hidden-focusable",),
    "links_without_text": ("morrow-link-no-text",),
    "links_with_url_text": ("morrow-link-bare-url",),
    "links_with_generic_text": ("morrow-link-generic-text",),
    "unclosed_tables": ("morrow-table-unclosed",),
}


def _finding(rule_id, locator):
    return {
        "rule_id": rule_id,
        "source": SOURCE_TAG,
        "locator": locator,
        "note": (
            "This check goes beyond Canvas's built-in accessibility "
            "checker. " + RULE_NOTES[rule_id] +
            " Signal for human review, never a conformance finding."
        ),
    }


def _resolve_target(context):
    """Resolve the audit target and the base element locator.

    Returns (target, base_locator). Raises ValueError on an unknown or
    under-specified explicit target (fail closed).
    """
    quiz_id = context.get("quiz_id")
    item_id = context.get("item_id")
    bank_id = context.get("bank_id")
    raw = (context.get("target") or "")
    raw = raw.strip().lower() if isinstance(raw, str) else ""
    if raw and raw not in _TARGETS:
        raise ValueError("Unknown augmented target %r." % (context.get("target"),))
    target = raw
    if not target:
        if bank_id and item_id:
            target = "item_bank_item"
        elif quiz_id and item_id:
            target = "new_quiz_item"
    if target == "new_quiz_item":
        if not (quiz_id and item_id):
            raise ValueError("target 'new_quiz_item' needs quiz_id and item_id.")
    elif target == "item_bank_item":
        if not (bank_id and item_id):
            raise ValueError("target 'item_bank_item' needs bank_id and item_id.")
    elif target == "quiz_instructions":
        if not quiz_id:
            raise ValueError("target 'quiz_instructions' needs quiz_id.")
    base = {"target": target or "html_content"}
    for key in ("quiz_id", "item_id", "bank_id", "quiz_type",
                "section", "choice_id"):
        value = context.get(key)
        if value is not None and value != "":
            base[key] = value
    return target or "html_content", base


def _nq_item_alt_findings(sig, base, section):
    findings = []
    for entry in sig["image_tags_without_alt"]:
        locator = dict(base)
        locator["element"] = "img"
        locator["image_index"] = entry["image_index"]
        locator["image_src_sha256"] = entry["image_src_sha256"]
        repair_kind = _NQ_SECTION_REPAIR_KIND.get((section or "").strip().lower())
        if repair_kind:
            # Hint only: planning still goes through
            # a11y_repair.validate_repair_plan and all of its guards.
            locator["repair_kind"] = repair_kind
        findings.append(_finding("morrow-nq-item-image-alt", locator))
    return findings


def _bank_item_alt_findings(sig, base):
    findings = []
    for entry in sig["image_tags_without_alt"]:
        locator = dict(base)
        locator["element"] = "img"
        locator["image_index"] = entry["image_index"]
        locator["image_src_sha256"] = entry["image_src_sha256"]
        locator["repair_kind"] = "item_bank_question"
        findings.append(_finding("morrow-bank-item-image-alt", locator))
    return findings


def _instructions_findings(html, sig, base, quiz_type):
    findings = []
    if not html.strip():
        locator = dict(base)
        locator["field"] = "instructions"
        findings.append(_finding("morrow-quiz-instructions-empty", locator))
    for entry in sig["image_tags_without_alt"]:
        locator = dict(base)
        locator["element"] = "img"
        locator["image_index"] = entry["image_index"]
        locator["image_src_sha256"] = entry["image_src_sha256"]
        if (quiz_type or "").strip().lower() == "classic":
            # Classic quiz descriptions have a repair planner; New Quiz
            # instructions do not. Hint only; guards still apply.
            locator["repair_kind"] = "classic_quiz_description"
        findings.append(_finding("morrow-quiz-instructions-image-alt", locator))
    return findings


def _html_level_findings(sig, base):
    """The Morrow-only HTML signals, re-labeled with morrow- rule ids."""
    findings = []

    def add(rule_id, **detail):
        locator = dict(base)
        locator.update(detail)
        findings.append(_finding(rule_id, locator))

    for entry in sig["media_without_caption_track"]:
        add("morrow-media-no-caption-track",
            element=entry["tag"], media_index=entry["media_index"])
    for entry in sig["autoplay_media"]:
        add("morrow-media-autoplay",
            element=entry["tag"], media_index=entry["media_index"])
    for index in sig["iframes_without_title"]:
        add("morrow-iframe-no-title", element="iframe", iframe_index=index)
    for entry in sig["aria_hidden_on_focusable"]:
        add("morrow-aria-hidden-focusable",
            element=entry["tag"], focusable_index=entry["focusable_index"])
    for entry in sig["links_without_text"]:
        add("morrow-link-no-text", element="a", link_index=entry["link_index"])
    for entry in sig["links_with_url_text"]:
        add("morrow-link-bare-url", element="a", link_index=entry["link_index"])
    for entry in sig["links_with_generic_text"]:
        add("morrow-link-generic-text", element="a", link_index=entry["link_index"])
    for entry in sig["images_marked_decorative_with_alt_text"]:
        add("morrow-decorative-image-with-alt",
            element="img", image_index=entry["image_index"])
    for index in sig["unclosed_tables"]:
        add("morrow-table-unclosed", element="table", table_index=index)
    return findings


def check_html(html, context=None):
    """Run the Morrow-extended augmented rules over one HTML field.

    ``html`` is an already-read HTML string (page content, a New Quiz item
    content field, a bank item content field, or a quiz instructions field).
    ``context`` follows the contract in the module docstring.

    Returns ``{"findings", "rule_ids", "engine", "source", "limits",
    "interpretation"}``. Findings are signals for human review, never
    violations.
    """
    context = dict(context or {})
    html = html if isinstance(html, str) else ""
    target, base = _resolve_target(context)

    # One saved-source scan; every rule below reads from it. Upstream
    # per-signal truncation (100 entries per signal) is surfaced in the
    # limits block so a capped list is never mistaken for complete evidence.
    scanned = _scan_html(html)
    sig = scanned["observed_source_signals"]

    findings = _html_level_findings(sig, base)
    if target == "new_quiz_item":
        findings.extend(
            _nq_item_alt_findings(sig, base, context.get("section")))
    elif target == "item_bank_item":
        findings.extend(_bank_item_alt_findings(sig, base))
    elif target == "quiz_instructions":
        findings.extend(
            _instructions_findings(html, sig, base, context.get("quiz_type")))

    by_rule = {}
    for finding in findings:
        by_rule.setdefault(finding["rule_id"], []).append(finding)
    capped = []
    truncated = []
    for rule_id in RULE_IDS:
        entries = by_rule.get(rule_id, [])
        capped.extend(entries[:MAX_FINDINGS_PER_RULE])
        if len(entries) > MAX_FINDINGS_PER_RULE:
            truncated.append({"rule_id": rule_id,
                              "returned_count": MAX_FINDINGS_PER_RULE,
                              "total_count": len(entries)})
    upstream_truncated = [
        {"signal": t["signal"],
         "affected_rules": list(_SIGNAL_TO_RULES.get(t["signal"], ())),
         "returned_count": t["returned_count"],
         "total_count": t["total_count"]}
        for t in scanned["source_signal_limits"].get("truncated_signals", [])
    ]
    incomplete = bool(truncated or upstream_truncated)
    return {
        "findings": capped,
        "rule_ids": list(RULE_IDS),
        "engine": ENGINE,
        "source": SOURCE_TAG,
        "limits": {
            "status": "evidence_incomplete" if incomplete else "observed",
            "max_findings_per_rule": MAX_FINDINGS_PER_RULE,
            "truncated_rules": truncated,
            "upstream_truncated_signals": upstream_truncated,
        },
        "interpretation": INTERPRETATION,
    }
