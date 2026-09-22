import { BLACKBOARD_ACTIONS } from "./blackboard-actions.js";
import { BLACKBOARD_CONTENT_PATCH_PLAN_NATIVE_TOOL } from "./blackboard-content-patch.js";
import { PUBLIC_MOODLE_ENROLMENT_CANDIDATE_TOOL } from "./moodle-learner-input.js";
import { MOODLE_STAGED_FILE_CAPABILITIES } from "./moodle-resource-file.js";

export type NativeToolSurface = "compact" | "full";
export type NativeToolCollisionPolicy = "reserve" | "exclude";

export type NativeToolDescriptor = Readonly<{
  name: string;
  surfaces: readonly NativeToolSurface[];
  collisionPolicy: NativeToolCollisionPolicy;
}>;

const BOTH = Object.freeze(["compact", "full"] as const);

const compactNames = [
  "morrow_activity",
  "morrow_audit_course",
  "morrow_capability_change",
  "morrow_capability_get",
  "morrow_capability_read",
  "morrow_catalog",
  "morrow_catalog_search",
  "morrow_health",
  "morrow_inventory_courses",
  "morrow_operation_get",
  "morrow_operations_recent",
  "morrow_plan_canvas_file_upload",
  "morrow_private_chat",
  "morrow_profile_status",
  "morrow_program_ledger",
  "morrow_request_edit_access",
  "morrow_result_page",
  "morrow_review_lesson",
  PUBLIC_MOODLE_ENROLMENT_CANDIDATE_TOOL,
  ...Object.values(MOODLE_STAGED_FILE_CAPABILITIES).map((capability) => capability.publicPlanToolName),
] as const;

export const MORROW_BATCH_TOOL_NAMES = Object.freeze([
  "morrow_batch_health",
  "morrow_batch_create",
  "morrow_batch_get",
  "morrow_batch_results_page",
  "morrow_batches_recent",
  "morrow_batch_run",
  "morrow_batch_resume",
  "morrow_batch_reconcile",
  "morrow_batch_recover",
  "morrow_batch_pause",
  "morrow_batch_cancel",
  "morrow_program_inventory_create",
  "morrow_program_inventory_create_audit_batch",
] as const);

const fullNames = [
  ...MORROW_BATCH_TOOL_NAMES,
  "morrow_check_new_quiz",
  "morrow_operation_cancel",
  "morrow_operation_close_unresolved",
  "morrow_operation_dispatch",
  "morrow_operation_list",
  "morrow_operation_reconcile",
  "morrow_operation_undo",
  "morrow_operation_verify",
  "morrow_operation_wait",
  "morrow_recent_changes",
  "morrow_plan_assignment_image_alt_repair",
  "morrow_plan_canvas_conversation",
  "morrow_plan_classic_quiz_description_image_alt_repair",
  "morrow_plan_classic_quiz_question_image_alt_repair",
  "morrow_plan_discussion_image_alt_repair",
  "morrow_plan_item_bank_question_image_alt_repair",
  "morrow_plan_new_quiz_accommodation",
  "morrow_plan_new_quiz_answer_feedback_image_alt_repair",
  "morrow_plan_new_quiz_assignment_group_order",
  "morrow_plan_new_quiz_choice_image_alt_repair",
  "morrow_plan_new_quiz_create",
  "morrow_plan_new_quiz_delete",
  "morrow_plan_new_quiz_feedback_image_alt_repair",
  "morrow_plan_new_quiz_item_create",
  "morrow_plan_new_quiz_item_delete",
  "morrow_plan_new_quiz_item_image_alt_repair",
  "morrow_plan_new_quiz_item_order",
  "morrow_plan_new_quiz_item_replacement",
  "morrow_plan_new_quiz_module_move",
  "morrow_plan_new_quiz_module_placement",
  "morrow_plan_new_quiz_report",
  "morrow_plan_new_quiz_settings",
  "morrow_plan_page_correction",
  "morrow_plan_page_image_alt_repair",
  "morrow_read_item_bank_fan_out",
  BLACKBOARD_CONTENT_PATCH_PLAN_NATIVE_TOOL,
  ...BLACKBOARD_ACTIONS.map((action) => action.publicName),
] as const;

const excludedNames = new Set<string>([...MORROW_BATCH_TOOL_NAMES, "morrow_check_new_quiz"]);

const descriptors: NativeToolDescriptor[] = [
  ...compactNames.map((name) => ({ name, surfaces: BOTH, collisionPolicy: "reserve" as const })),
  ...fullNames.map((name) => ({
    name,
    surfaces: BOTH,
    collisionPolicy: excludedNames.has(name) ? "exclude" as const : "reserve" as const,
  })),
];

const names = new Set<string>();
for (const descriptor of descriptors) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(descriptor.name) || names.has(descriptor.name)) {
    throw new Error(`Native tool manifest contains an invalid or duplicate name: ${descriptor.name}`);
  }
  names.add(descriptor.name);
}

export const NATIVE_TOOL_MANIFEST = Object.freeze(descriptors.map((descriptor) => Object.freeze(descriptor)));
export const MORROW_NATIVE_TOOL_NAMES = Object.freeze(NATIVE_TOOL_MANIFEST.map((descriptor) => descriptor.name).sort());
export const MORROW_NATIVE_EXCLUDED_NAMES = Object.freeze(NATIVE_TOOL_MANIFEST
  .filter((descriptor) => descriptor.collisionPolicy === "exclude")
  .map((descriptor) => descriptor.name)
  .sort());
