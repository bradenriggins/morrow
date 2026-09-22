#!/usr/bin/env python3
"""Guarded image-alt repair plan validation for Morrow for Muse.

Port of the desktop planner contracts:
- ``morrow_plan_page_image_alt_repair`` (Canvas Page, non-block-editor)
- ``morrow_plan_assignment_image_alt_repair``
- ``morrow_plan_discussion_image_alt_repair``
- ``morrow_plan_classic_quiz_description_image_alt_repair``
- ``morrow_plan_classic_quiz_question_image_alt_repair``
- ``morrow_plan_new_quiz_item_image_alt_repair``
- ``morrow_plan_new_quiz_choice_image_alt_repair``
- ``morrow_plan_new_quiz_answer_feedback_image_alt_repair``
- ``morrow_plan_new_quiz_feedback_image_alt_repair``
- ``morrow_plan_item_bank_question_image_alt_repair``

(source: ``packages/mcp-server/src/page-correction.ts``,
``packages/mcp-server/src/item-bank-repair.ts``)

Planning never performs a Canvas write. ``validate_repair_plan`` checks a
proposed plan against fresh audit evidence and raises ``RepairPlanRefused``
with a stable code when any guard fails. The caller must supply the fresh
read (body, digest, and the missing-alt evidence from ``a11y_signals``);
this module never fetches anything.
"""

import re

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COURSE_ID_RE = re.compile(r"^[1-9][0-9]{0,18}$")
ITEM_ID_RE = re.compile(r"^[1-9][0-9]{0,18}$")

# New Quiz assignment IDs that must never be touched by any repair plan.
PROTECTED_NEW_QUIZ_IDS = frozenset({"506477"})

# Classic Quiz question types the question repair supports. Canvas rebuilds a
# question from the whole request through AssessmentQuestion.parse_question,
# so any other type is refused rather than risk a lossy rebuild.
CLASSIC_QUIZ_QUESTION_TYPE_ALLOWLIST = frozenset({
    "multiple_choice_question",
    "true_false_question",
    "multiple_answers_question",
    "short_answer_question",
    "essay_question",
})

MAX_ALT_TEXT_CHARS = 500
MAX_IMAGE_INDEX = 2 * 1024 * 1024

# Planner kinds and the extra guard each one carries.
PLANNER_KINDS = (
    "page",                    # Canvas Page, non-block-editor only
    "assignment",              # Canvas Assignment description
    "discussion",              # Canvas Discussion message
    "classic_quiz_description",
    "classic_quiz_question",
    "new_quiz_item",
    "new_quiz_choice",
    "new_quiz_answer_feedback",
    "new_quiz_feedback",
    "item_bank_question",
)

# Item Bank question images cannot be marked decorative (desktop rule).
_NO_DECORATIVE_KINDS = frozenset({"item_bank_question"})


class RepairPlanRefused(Exception):
    """A repair plan was refused. ``code`` is stable for journaling."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _require(condition, code, message):
    if not condition:
        raise RepairPlanRefused(code, message)


def _valid_digest(value):
    return isinstance(value, str) and bool(SHA256_RE.match(value))


def validate_repair_plan(kind, params, evidence):
    """Validate one image-alt repair plan against fresh audit evidence.

    ``kind`` is one of ``PLANNER_KINDS``. ``params`` carries the caller's
    plan inputs (ids, digests, image index, alt text). ``evidence`` carries
    the fresh read: ``body_sha256``, ``missing_alt`` (the
    ``image_tags_without_alt`` list from :func:`a11y_signals.scan_html`),
    and kind-specific facts (``question_type``, ``quiz_group_id``,
    ``item_sha256``, ``bank_sha256``).

    Returns a dict describing the validated plan (digests and offsets only,
    never the body or image URL). Raises ``RepairPlanRefused`` on any guard
    failure.
    """
    _require(kind in PLANNER_KINDS, "unknown_planner_kind",
             "Unknown repair planner kind %r." % (kind,))
    params = params or {}
    evidence = evidence or {}

    course_id = str(params.get("course_id", ""))
    _require(bool(COURSE_ID_RE.match(course_id)), "bad_course_id",
             "The course id is not an exact Canvas course id.")

    quiz_id = params.get("quiz_id")
    if quiz_id is not None and str(quiz_id) in PROTECTED_NEW_QUIZ_IDS:
        raise RepairPlanRefused(
            "protected_quiz",
            "New Quiz %s is protected and is never touched by repair plans." % quiz_id)

    expected = params.get("expected_body_sha256")
    fresh = evidence.get("body_sha256")
    _require(_valid_digest(expected) and _valid_digest(fresh), "bad_digest",
             "Both the expected and the fresh body digest must be sha256 hex.")
    _require(expected == fresh, "stale_body",
             "The target changed since this accessibility signal. Run the audit again.")

    missing = evidence.get("missing_alt") or []
    image_index = params.get("image_index")
    _require(isinstance(image_index, int) and 1 <= image_index <= MAX_IMAGE_INDEX,
             "bad_image_index", "The image index must be a positive whole number.")
    _require(image_index <= len(missing), "image_position_shifted",
             "The selected image is no longer at this position. Run the audit again.")
    selected = missing[image_index - 1]
    _require(selected.get("image_index") == image_index, "image_position_shifted",
             "The selected image is no longer at this position. Run the audit again.")

    want_src = params.get("image_src_sha256")
    _require(_valid_digest(want_src), "bad_image_src_digest",
             "The image source digest must be sha256 hex.")
    _require(selected.get("image_src_sha256") == want_src, "image_source_mismatch",
             "The image at this position is not the image this signal named. "
             "Run the audit again.")

    # One image only: the same source used more than once is ambiguous.
    same_source = [m for m in missing
                   if m.get("image_src_sha256") == want_src]
    _require(len(same_source) == 1, "ambiguous_image",
             "This target uses the same image more than once, so one image "
             "cannot be named exactly.")

    decorative = bool(params.get("decorative"))
    alt_text = params.get("alt_text", "")
    _require(isinstance(alt_text, str) and len(alt_text) <= MAX_ALT_TEXT_CHARS,
             "bad_alt_text", "Alternative text must be at most 500 characters.")
    if kind in _NO_DECORATIVE_KINDS:
        _require(not decorative, "decorative_not_allowed",
                 "An item bank question image cannot be marked decorative here; "
                 "it needs alternative text a person can read.")
    if decorative:
        _require(alt_text == "", "decorative_needs_empty_alt",
                 "Decorative images use empty alternative text.")
    else:
        _require(alt_text.strip() != "", "alt_text_required",
                 "Non-decorative images need alternative text a person can read.")

    if kind == "classic_quiz_question":
        qtype = evidence.get("question_type")
        _require(qtype in CLASSIC_QUIZ_QUESTION_TYPE_ALLOWLIST,
                 "unsupported_question_type",
                 "Classic Quiz question repair supports only multiple choice, "
                 "true/false, multiple answers, short answer, and essay "
                 "questions; got %r." % (qtype,))
        _require(not evidence.get("quiz_group_id"), "question_group_refused",
                 "Questions in a question group are refused: Canvas rebuilds "
                 "the question from the whole request and a group rebuild is "
                 "not proven safe.")
        _require(bool(evidence.get("question_read_complete")), "incomplete_question_read",
                 "The question read omitted a field the write must resend. "
                 "Canvas rebuilds the question from the whole request.")

    if kind == "item_bank_question":
        _require(_valid_digest(params.get("item_sha256")), "bad_item_digest",
                 "The exact item snapshot digest is required.")
        _require(params.get("item_sha256") == evidence.get("item_sha256"),
                 "stale_item_snapshot",
                 "The item bank question changed since this signal. Run the audit again.")
        _require(_valid_digest(params.get("bank_sha256")), "bad_bank_digest",
                 "The exact bank snapshot digest is required.")
        _require(params.get("bank_sha256") == evidence.get("bank_sha256"),
                 "stale_bank_snapshot",
                 "The item bank changed since this signal. Run the audit again.")

    if kind in ("new_quiz_item", "new_quiz_choice",
                "new_quiz_answer_feedback", "new_quiz_feedback"):
        _require(evidence.get("entry_type", "Item") == "Item",
                 "unsupported_entry_type",
                 "Stimulus and other unsupported entry types return "
                 "blocked_current_contract: no proven partial mutation contract.")

    plan = {
        "planner": "morrow_plan_%s_image_alt_repair" % kind,
        "course_id": course_id,
        "expected_body_sha256": expected,
        "image_index": image_index,
        "image_src_sha256": want_src,
        "decorative": decorative,
        "write_contract": "one_dispatch_exact_readback",
        "post_write": "re_audit_same_target",
    }
    for key in ("page_url", "assignment_id", "discussion_id", "quiz_id",
                "question_id", "item_id", "bank_id", "bank_entry_id",
                "choice_id", "feedback_type"):
        if params.get(key) is not None:
            plan[key] = params[key]
    return plan
