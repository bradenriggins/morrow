#!/usr/bin/env python3
"""Generate the ten guarded image-alt repair planner manifests.

One manifest per desktop planner (page-correction.ts / item-bank-repair.ts).
Planning never performs a Canvas write; each manifest's VALIDATE step runs
catalog/a11y/a11y_repair.validate_repair_plan against fresh audit evidence.

Run: python3 build_repair_manifests.py
Outputs: morrow_plan_*_image_alt_repair.json in this directory.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

COMMON_PARAMS = {
    "source_binding_id": {
        "type": "string", "minLength": 1, "maxLength": 160,
        "description": "Connection binding the educator's session."},
    "course_id": {
        "type": "string", "pattern": "^[1-9][0-9]{0,18}$",
        "description": "Exact Canvas course id."},
    "expected_body_sha256": {
        "type": "string", "pattern": "^[0-9a-f]{64}$",
        "description": "Digest of the exact saved body this repair was planned against."},
    "image_index": {
        "type": "integer", "minimum": 1, "maximum": 2147483648,
        "description": "Position of the image in the saved field, counting every image from 1."},
    "image_src_sha256": {
        "type": "string", "pattern": "^[0-9a-f]{64}$",
        "description": "Digest of the selected image's src attribute from the fresh audit."},
    "alt_text": {
        "type": "string", "maxLength": 500,
        "description": "Alternative text a person can read, or empty when marking decorative."},
    "decorative": {
        "type": "boolean", "default": False,
        "description": "True marks the image decorative with empty alternative text."},
}

ID_PARAMS = {
    "page_url": {"type": "string", "minLength": 1, "maxLength": 500,
                 "description": "Canvas Page URL."},
    "assignment_id": {"type": "string", "pattern": "^[1-9][0-9]{0,18}$",
                      "description": "Canvas Assignment id."},
    "discussion_id": {"type": "string", "pattern": "^[1-9][0-9]{0,18}$",
                      "description": "Canvas Discussion topic id."},
    "quiz_id": {"type": "string", "pattern": "^[1-9][0-9]{0,18}$",
                "description": "Canvas quiz id (Classic Quiz id, or the Canvas assignment id of a New Quiz)."},
    "question_id": {"type": "string", "pattern": "^[1-9][0-9]{0,18}$",
                    "description": "Classic Quiz question id."},
    "item_id": {"type": "string", "pattern": "^[1-9][0-9]{0,18}$",
                "description": "New Quiz item id, or Item Bank question item id."},
    "choice_id": {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$",
                  "description": "New Quiz choice/answer id."},
    "feedback_type": {"type": "string", "enum": ["correct", "incorrect", "neutral"],
                      "description": "Which New Quiz question feedback carries the image."},
    "bank_id": {"type": "string", "pattern": "^[1-9][0-9]{0,18}$",
                "description": "Item Bank id."},
    "bank_entry_id": {"type": "string", "pattern": "^[1-9][0-9]{0,18}$",
                      "description": "Item Bank entry id."},
}

COMMON_REFUSALS = [
    "stale_body: the target changed since the signal; run the audit again",
    "image_position_shifted: the image is no longer at this index",
    "image_source_mismatch: the image at this index is not the signaled image",
    "ambiguous_image: the same image is used more than once",
    "decorative_needs_empty_alt / alt_text_required: alt_text/decorative inconsistency",
    "protected_quiz: New Quiz 506477 is never touched",
]

PLANNERS = [
    {
        "kind": "page",
        "name": "morrow_plan_page_image_alt_repair",
        "title": "Review a Canvas Page image alternative-text repair",
        "description": "Plan one alternative-text repair for a missing-alt image on an existing Canvas Page. Requires fresh audit evidence for the current Page body and image source. Preserves the Page body and settings except for one selected image alt attribute. No Canvas write occurs during planning. Does not support block-editor pages or prove accessibility conformance.",
        "ids": ["page_url"],
        "notes": [
            "Non-block-editor Pages only; block-editor pages are refused.",
            "Changes one escaped alt attribute; keeps the other Page bytes and settings.",
            "The plan and journal use only digests and offsets, not the Page body, image tag, or image URL.",
        ],
    },
    {
        "kind": "assignment",
        "name": "morrow_plan_assignment_image_alt_repair",
        "title": "Review a Canvas Assignment image alternative-text repair",
        "description": "Plan one alternative-text repair for a missing-alt image in an existing Canvas Assignment description. Requires fresh audit evidence for the exact Assignment source. Preserves the saved description and Assignment settings except for one selected image alt attribute. No Canvas write occurs during planning and this does not prove accessibility conformance.",
        "ids": ["assignment_id"],
        "notes": ["Changes one alt attribute in the assignment description; all other fields preserved."],
    },
    {
        "kind": "discussion",
        "name": "morrow_plan_discussion_image_alt_repair",
        "title": "Review a Canvas Discussion image alternative-text repair",
        "description": "Plan one alternative-text repair for a missing-alt image in an existing Canvas Discussion message. Requires fresh audit evidence for the exact Discussion source. Preserves the saved message and Discussion settings except for one selected image alt attribute. No Canvas write occurs during planning and this does not prove accessibility conformance.",
        "ids": ["discussion_id"],
        "notes": ["Changes one alt attribute in the discussion message; replies are never read or touched."],
    },
    {
        "kind": "classic_quiz_description",
        "name": "morrow_plan_classic_quiz_description_image_alt_repair",
        "title": "Review a Canvas Classic Quiz description image alternative-text repair",
        "description": "Plan one alternative-text repair for a missing-alt image in an existing Canvas Classic Quiz description. Requires fresh audit evidence for the exact course and quiz. Preserves the saved Classic Quiz description and settings except for one selected image alt attribute. No Canvas write occurs during planning and this does not support quiz questions, answers, assessment banks, or accessibility conformance.",
        "ids": ["quiz_id"],
        "notes": [
            "The guarded write sends only quiz[description], verifies the full protected Quiz state, and reruns the selected image-alt check.",
        ],
    },
    {
        "kind": "classic_quiz_question",
        "name": "morrow_plan_classic_quiz_question_image_alt_repair",
        "title": "Review a Canvas Classic Quiz question image alternative-text repair",
        "description": "Plan one alternative-text repair for a missing-alt image in an existing Canvas Classic Quiz question, either in the question text or in one of its answers. Canvas rebuilds a Classic Quiz question from the whole request, so the plan reads the question again and resends every field that read returned, changing one selected image alt attribute. Refuses a question in a question group, a question type outside multiple choice, true/false, multiple answers, short answer, and essay, and any read that does not carry a complete question. No Canvas write occurs during planning. This repair is not yet proven against a live Canvas tenant and does not prove accessibility conformance.",
        "ids": ["quiz_id", "question_id"],
        "notes": [
            "Refuses a question with a quiz_group_id.",
            "Refuses question types outside multiple_choice_question, true_false_question, multiple_answers_question, short_answer_question, essay_question.",
            "Refuses any read that omits a field the write must resend or carries state the write cannot resend.",
            "Live-unproven on any connected Canvas tenant: treat a saved result as unconfirmed until the question is read again.",
        ],
    },
    {
        "kind": "new_quiz_item",
        "name": "morrow_plan_new_quiz_item_image_alt_repair",
        "title": "Review a New Quiz item image alternative-text repair",
        "description": "Plan one alternative-text repair for a missing-alt image in a course-scoped New Quiz item body. Requires fresh audit evidence for the exact course, quiz, item, and item body. Preserves the item ID, question type, answer data, scoring, position, and other item settings except for one selected image alt attribute. No Canvas write occurs during planning and this does not support Stimuli, Item Bank entries, answer choices, feedback, or accessibility conformance.",
        "ids": ["quiz_id", "item_id"],
        "notes": ["PATCH contract only, never PUT. Stimulus entries are refused (blocked_current_contract)."],
    },
    {
        "kind": "new_quiz_choice",
        "name": "morrow_plan_new_quiz_choice_image_alt_repair",
        "title": "Review a New Quiz answer-choice image alternative-text repair",
        "description": "Plan one alternative-text repair for a missing-alt image in one direct New Quiz choice or ordering answer. Requires fresh audit evidence for the exact course, quiz, item, choice, and answer HTML. Preserves all other responses, scoring, feedback, item settings, and position. No Canvas write occurs during planning and this does not support Stimuli, Item Bank entries, matching, categorization, or accessibility conformance.",
        "ids": ["quiz_id", "item_id", "choice_id"],
        "notes": ["One choice only; all other responses preserved."],
    },
    {
        "kind": "new_quiz_answer_feedback",
        "name": "morrow_plan_new_quiz_answer_feedback_image_alt_repair",
        "title": "Review a New Quiz answer-feedback image alternative-text repair",
        "description": "Plan one alternative-text repair for a missing-alt image in feedback for one direct New Quiz choice answer. Requires fresh audit evidence for the exact course, quiz, item, choice, and feedback HTML. Preserves all answer choices, scoring, other feedback, item settings, and position. No Canvas write occurs during planning and this does not support Stimuli, Item Bank entries, or accessibility conformance.",
        "ids": ["quiz_id", "item_id", "choice_id"],
        "notes": ["One feedback block only; other feedback preserved."],
    },
    {
        "kind": "new_quiz_feedback",
        "name": "morrow_plan_new_quiz_feedback_image_alt_repair",
        "title": "Review a New Quiz question-feedback image alternative-text repair",
        "description": "Plan one alternative-text repair for a missing-alt image in direct New Quiz correct, incorrect, or general feedback. Requires fresh audit evidence for the exact course, quiz, item, feedback type, and HTML. Preserves answers, scoring, other feedback, item settings, and position. No Canvas write occurs during planning and this does not support Stimuli, Item Bank entries, or accessibility conformance.",
        "ids": ["quiz_id", "item_id", "feedback_type"],
        "notes": ["feedback_type is one of correct, incorrect, neutral."],
    },
    {
        "kind": "item_bank_question",
        "name": "morrow_plan_item_bank_question_image_alt_repair",
        "title": "Review a New Quizzes item bank question image alternative-text repair",
        "description": "Plan one alternative-text repair for one exact image in one New Quizzes Item Bank question. Fresh-reads the course, bank, entry, and complete item; changes one selected missing alternative-text attribute; supplies exact bank and item snapshot digests; uses the admitted complete-item update with one dispatch and exact readback. No Canvas write occurs during planning.",
        "ids": ["bank_id", "bank_entry_id", "item_id"],
        "notes": [
            "Requires exact bank_sha256 and item_sha256 snapshot digests; stale snapshots refuse the plan.",
            "An item bank question image cannot be marked decorative; it needs alternative text a person can read.",
            "morrow_read_item_bank_fan_out output is review context only and never grants authority.",
            "Live-unproven on any connected Canvas tenant: the Item Banks browser frame path stays live-unverified.",
        ],
        "extra_params": {
            "item_sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$",
                            "description": "Digest of the exact item bank question this repair was planned against."},
            "bank_sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$",
                            "description": "Digest of the exact bank snapshot this repair was planned against."},
            "decorative": {"type": "boolean", "const": False,
                           "description": "Item bank question images cannot be marked decorative."},
        },
    },
]


def build_manifest(spec):
    properties = dict(COMMON_PARAMS)
    for pid in spec["ids"]:
        properties[pid] = ID_PARAMS[pid]
    if "extra_params" in spec:
        properties.update(spec["extra_params"])
    required = ["source_binding_id", "course_id"] + spec["ids"] + [
        "expected_body_sha256", "image_index", "image_src_sha256", "alt_text"]

    return {
        "manifest": "morrow.manifest.v0",
        "name": spec["name"],
        "version": "0.1.0",
        "title": spec["title"],
        "description": spec["description"],
        "provider": "canvas",
        "auth": {"slot": "canvas_session", "alternates": ["canvas_pat"]},
        "effects": "plan",
        "evidence_status": "live-unverified",
        "executor_wiring": "pending: entry authored for the dispatch catalog; not yet wired into dispatch/executor.py",
        "honesty": {
            "interpretation": "This planner changes one image alt attribute only. It does not prove accessibility conformance.",
            "no_write_during_planning": True,
        },
        "port_source": "~/workspace/origin-morrow/packages/mcp-server/src/page-correction.ts and item-bank-repair.ts",
        "params": {"type": "object", "properties": properties,
                   "required": required, "additionalProperties": False},
        "multi_step": [
            {"method": "GET", "name": "fresh_read_target",
             "url": "{provider_read_route_for_target}",
             "note": "Fresh-read the exact target (course, quiz/bank, and question/item as the kind requires). "
                     "The read must return the complete saved body; an incomplete read refuses the plan."},
            {"method": "VALIDATE", "name": "validate_repair_plan",
             "url": "local://catalog/a11y/a11y_repair.validate_repair_plan",
             "note": "Validate the plan against the fresh audit evidence. Refusals: "
                     + "; ".join(COMMON_REFUSALS)
                     + ". Planner-specific guards: " + " ".join(spec["notes"])},
            {"method": "APPROVE", "name": "require_authorization",
             "url": "local://dispatch/approval",
             "note": "Requires human approval or a selected valid Edit authority. No Canvas write occurs during planning."},
            {"method": "DISPATCH", "name": "guarded_single_dispatch",
             "url": "{guarded_write_route_for_kind}",
             "note": "One dispatch of the reviewed single-alt update with exact readback of the saved target."},
            {"method": "RE-AUDIT", "name": "re_audit_same_target",
             "url": "local://catalog/a11y/morrow_audit_course_item",
             "note": "Run morrow_audit_course_item again on the same course and target. Report which observed fields, "
                     "digests, and source signals changed. Stop on stale, incomplete, held, or unverified evidence; "
                     "do not retry a write automatically."},
        ],
        "planner_notes": spec["notes"],
        "rate": {"hint": "gentle", "retry_on": [429, 403]},
        "result": {
            "max_bytes": 1048576,
            "receipt": ["course_id", "planner", "target_id", "image_index",
                        "expected_body_sha256", "planned_at", "unread"],
            "redact": [],
            "truncate": "tail",
        },
    }


def main():
    for spec in PLANNERS:
        manifest = build_manifest(spec)
        path = os.path.join(HERE, spec["name"] + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2, sort_keys=True)
            fh.write("\n")
        print("wrote", path)


if __name__ == "__main__":
    main()
