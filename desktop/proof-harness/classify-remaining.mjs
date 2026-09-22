// The controls this run did not exercise, each with the exact thing it would need. A control
// recorded here is unproven and says why, which is a verdict; it is never a silent skip.
import { loadLedger, recordRow } from "./ledger.mjs";

const REASONS = {
  morrow_plan_canvas_conversation: ["OUTBOUND", "Sending a message leaves Canvas for whoever it names. The sandbox rule forbids it, so this control is never run here."],
  morrow_private_chat: ["OUTBOUND", "The private chat surface carries a message to a person, which the sandbox rule forbids."],
  morrow_plan_canvas_file_upload: ["NEEDS-FIXTURE", "Needs a reviewed local file staged for transfer, which this run does not build."],
  morrow_plan_assignment_image_alt_repair: ["NEEDS-FIXTURE", "Needs an assignment whose description carries an image with no description."],
  morrow_plan_discussion_image_alt_repair: ["NEEDS-FIXTURE", "Needs a discussion whose message carries an image with no description."],
  morrow_plan_classic_quiz_description_image_alt_repair: ["NEEDS-FIXTURE", "Needs a classic quiz whose description carries an image with no description."],
  morrow_plan_classic_quiz_question_image_alt_repair: ["NEEDS-FIXTURE", "Needs a classic quiz question carrying an image with no description."],
  morrow_plan_item_bank_question_image_alt_repair: ["NEEDS-FIXTURE", "Needs an item bank question carrying an image with no description."],
  morrow_plan_new_quiz_item_image_alt_repair: ["NEEDS-FIXTURE", "Needs a New Quiz question whose body carries an image with no description."],
  morrow_plan_new_quiz_choice_image_alt_repair: ["NEEDS-FIXTURE", "Needs a New Quiz question whose answer choice carries an image with no description."],
  morrow_plan_new_quiz_feedback_image_alt_repair: ["NEEDS-FIXTURE", "Needs a New Quiz question whose feedback carries an image with no description."],
  morrow_plan_new_quiz_answer_feedback_image_alt_repair: ["NEEDS-FIXTURE", "Needs a New Quiz question whose per-answer feedback carries an image with no description."],
  morrow_plan_new_quiz_item_replacement: ["NEEDS-FIXTURE", "Needs a saved New Quiz question to replace with one of a different type."],
  morrow_plan_new_quiz_accommodation: ["NEEDS-LEARNER-ATTEMPT", "An accommodation names a learner, and Morrow resolves that learner from a roster token the sandbox does not establish for this run."],
  morrow_program_inventory_create: ["NEEDS-FIXTURE", "Needs a program record naming several courses, which this run does not build."],
  morrow_program_inventory_create_audit_batch: ["NEEDS-FIXTURE", "Needs a program inventory to build the audit batch from."],
  morrow_program_ledger: ["NEEDS-FIXTURE", "Takes an inventory record this run does not build."],
  morrow_review_lesson: ["NEEDS-FIXTURE", "Needs a lesson draft to review, which this run does not build."],
  morrow_plan_new_quiz_module_move: ["NEEDS-FIXTURE", "Needs the module item id of a quiz already placed in a module, which this run did not keep."],
};

const ledger = loadLedger();
let written = 0;
for (const [id, [classification, reason]] of Object.entries(REASONS)) {
  const held = ledger.rows[id];
  if (held?.verdict === "PASS") continue;
  recordRow(ledger, id, { phase: 1, kind: "tool", verdict: "BLOCKED", classification, reason });
  written += 1;
}
console.log(JSON.stringify({ written }));
