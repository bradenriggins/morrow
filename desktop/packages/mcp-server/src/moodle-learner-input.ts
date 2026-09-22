import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_ROSTER_LEARNER_INPUT_TOOLS = new Set([
  "moodle_create_assignment_override",
  "moodle_update_assignment_override",
  "moodle_create_quiz_override",
  "moodle_update_quiz_override",
  "moodle_get_participant_enrolment",
  "moodle_get_assignment_submission",
  "moodle_get_assignment_feedback",
  "moodle_get_scorm_learner_report",
  "moodle_get_learner_grade_report",
  "moodle_suspend_participant",
  "moodle_unenrol_participant",
  "moodle_assign_role",
  "moodle_remove_role",
  "moodle_add_group_member",
  "moodle_remove_group_member",
] as const);

export const MOODLE_ENROL_CANDIDATE_INPUT_TOOL = "moodle_enrol_participant";
export const PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL = "morrow_private_moodle_find_enrolment_candidate";
export const PRIVATE_MOODLE_ENROLMENT_CANDIDATE_OPERATION = "moodle.private.enrolment_candidate.find.v1";
export const PUBLIC_MOODLE_ENROLMENT_CANDIDATE_TOOL = "morrow_find_moodle_enrolment_candidate";
export const MOODLE_LEARNER_TOKEN_PATTERN = "^Student A[1-9][0-9]*$";

const MOODLE_USER_OVERRIDE_INPUT_TOOLS = new Set([
  "moodle_create_assignment_override",
  "moodle_update_assignment_override",
  "moodle_create_quiz_override",
  "moodle_update_quiz_override",
] as const);

function renameRequiredField(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => renameRequiredField(entry, from, to));
  if (!isJsonObject(value)) return value;
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = key === "required" && Array.isArray(child)
      ? child.map((entry) => entry === from ? to : entry)
      : renameRequiredField(child, from, to);
  }
  return output;
}

/**
 * The checked-in browser catalog is the private source contract. Its Moodle
 * executors still take a numeric user_id. The public MCP clone names only the
 * scoped readable label that the Gateway resolves immediately before dispatch.
 */
export function publicMoodleLearnerInputSchema(toolName: string, schema: JsonObject): JsonObject {
  const rostered = MOODLE_ROSTER_LEARNER_INPUT_TOOLS.has(toolName as never);
  const candidate = toolName === MOODLE_ENROL_CANDIDATE_INPUT_TOOL;
  if (!rostered && !candidate) return structuredClone(schema);
  const field = candidate ? "candidate_token" : "learner_token";
  const renamed = renameRequiredField(structuredClone(schema), "user_id", field) as JsonObject;
  const properties = isJsonObject(renamed.properties) ? { ...renamed.properties } : {};
  if (!Object.hasOwn(properties, "user_id")) {
    throw new TypeError(`${toolName} has no private Moodle user_id contract`);
  }
  delete properties.user_id;
  properties[field] = {
    type: "string",
    pattern: MOODLE_LEARNER_TOKEN_PATTERN,
    description: candidate
      ? "The readable candidate label (for example, Student A1) returned by morrow_find_moodle_enrolment_candidate for this exact course connection."
      : "The readable learner label (for example, Student A1) returned by a Morrow participant read for this exact course connection.",
  };
  return { ...renamed, properties };
}

export function isMoodleLearnerToken(value: unknown): value is string {
  return typeof value === "string" && /^Student A[1-9][0-9]*$/.test(value);
}

/**
 * Runtime and batch callers do not all pass through the MCP JSON-schema
 * validator. Hold the same public boundary here, before a source read or an
 * effect plan can receive a private Moodle user id.
 */
export function assertPublicMoodleLearnerInput(
  toolName: string,
  request: Readonly<Record<string, unknown>>,
): void {
  const rostered = MOODLE_ROSTER_LEARNER_INPUT_TOOLS.has(toolName as never);
  const candidate = toolName === MOODLE_ENROL_CANDIDATE_INPUT_TOOL;
  if (!rostered && !candidate) return;
  if (Object.hasOwn(request, "user_id") || Object.hasOwn(request, "learner_id")) {
    throw new TypeError("Moodle learner input requires a readable learner label");
  }
  if (candidate) {
    if (!isMoodleLearnerToken(request.candidate_token) || Object.hasOwn(request, "learner_token")) {
      throw new TypeError("Moodle enrolment input requires one candidate label");
    }
    return;
  }
  if (MOODLE_USER_OVERRIDE_INPUT_TOOLS.has(toolName as never) && Object.hasOwn(request, "group_id")) {
    if (Object.hasOwn(request, "learner_token")) {
      throw new TypeError("A Moodle override must name one learner or one group");
    }
    return;
  }
  if (!isMoodleLearnerToken(request.learner_token)) {
    throw new TypeError("Moodle learner input requires one learner label");
  }
}
