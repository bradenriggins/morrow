import { isJsonObject, type JsonObject } from "@morrow/contracts";

/**
 * Projections for the Moodle Choice, Feedback, and Database child-record reads.
 *
 * Each projection rebuilds its result from fixed fields, so a field the browser
 * added cannot reach MCP egress. The response and entry summaries are aggregate
 * counts only: they carry no learner name, no learner ID, and no response value.
 *
 * An anonymous Feedback is refused a per-learner projection here as well as in
 * the page, so a later route cannot turn this read into a de-anonymising one.
 */

export const MOODLE_CHOICE_OPTIONS_OPERATION = "moodle.form.choice.options.read.v1";
export const MOODLE_CHOICE_OPTIONS_TOOL = "moodle_get_choice_options";
export const MOODLE_CHOICE_OPTIONS_SCHEMA = "morrow.moodle-choice-options.v1";

export const MOODLE_CHOICE_RESPONSE_SUMMARY_OPERATION = "moodle.form.choice.response_summary.read.v1";
export const MOODLE_CHOICE_RESPONSE_SUMMARY_TOOL = "moodle_get_choice_response_summary";
export const MOODLE_CHOICE_RESPONSE_SUMMARY_SCHEMA = "morrow.moodle-choice-response-summary.v1";

export const MOODLE_FEEDBACK_ITEMS_OPERATION = "moodle.form.feedback.items.read.v1";
export const MOODLE_FEEDBACK_ITEMS_TOOL = "moodle_get_feedback_items";
export const MOODLE_FEEDBACK_ITEMS_SCHEMA = "morrow.moodle-feedback-items.v1";

export const MOODLE_FEEDBACK_RESPONSE_SUMMARY_OPERATION = "moodle.form.feedback.response_summary.read.v1";
export const MOODLE_FEEDBACK_RESPONSE_SUMMARY_TOOL = "moodle_get_feedback_response_summary";
export const MOODLE_FEEDBACK_RESPONSE_SUMMARY_SCHEMA = "morrow.moodle-feedback-response-summary.v1";

export const MOODLE_DATABASE_FIELDS_OPERATION = "moodle.form.data.fields.read.v1";
export const MOODLE_DATABASE_FIELDS_TOOL = "moodle_get_database_fields";
export const MOODLE_DATABASE_FIELDS_SCHEMA = "morrow.moodle-database-fields.v1";

export const MOODLE_DATABASE_ENTRY_SUMMARY_OPERATION = "moodle.form.data.entry_summary.read.v1";
export const MOODLE_DATABASE_ENTRY_SUMMARY_TOOL = "moodle_get_database_entry_summary";
export const MOODLE_DATABASE_ENTRY_SUMMARY_SCHEMA = "morrow.moodle-database-entry-summary.v1";

const MODULE_BINDING = "course_modedit_form";
const OVERVIEW_METHOD = "core_courseformat_get_overview_information";

const OPTION_LIMIT = 100;
const ITEM_LIMIT = 200;
const FIELD_LIMIT = 100;
const TEXT_LIMIT = 4_000;
const ACTIVITY_LIMIT = 500;
const COUNT_LIMIT = 1_000_000;

/** A key here would name or group learners, which this read never returns. */
const LEARNER_PROJECTION_KEYS = [
  "respondents", "respondent", "responses", "learner", "learners", "user_id", "userid", "users", "students", "entries",
] as const;

export type MoodleActivityContentExpectation = Readonly<{ courseId: number; moduleId: number }>;

export type MoodleChoiceOption = Readonly<{
  option_id: number;
  position: number;
  text: string;
  response_limit: number;
}>;

export type MoodleFeedbackItem = Readonly<{
  item_id: number;
  position: number;
  type: string;
  required: boolean;
  text: string;
  label: string;
  presentation: string;
  depends_on_item_id: number | null;
  depends_on_value: string;
}>;

export type MoodleDatabaseField = Readonly<{
  field_id: number;
  name: string;
  type: string;
}>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function boundedText(value: unknown): string | null {
  return typeof value === "string" && value.length <= TEXT_LIMIT ? value : null;
}

function slug(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,50}$/u.test(value) ? value : null;
}

function header(value: unknown, schema: string, expected: MoodleActivityContentExpectation, error: string): JsonObject {
  if (!isJsonObject(value) || value.schema !== schema || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.module_id) !== expected.moduleId) {
    throw new Error(error);
  }
  return value;
}

function proofOf(
  value: JsonObject,
  method: string,
  capability: string,
  extra: Readonly<Record<string, number | string>>,
  error: string,
): JsonObject {
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (!proof || proof.method !== method || proof.complete !== true
    || proof.exact_module_binding !== MODULE_BINDING || proof.required_capability !== capability) {
    throw new Error(error);
  }
  for (const [key, entry] of Object.entries(extra)) if (proof[key] !== entry) throw new Error(error);
  return {
    method,
    complete: true,
    exact_module_binding: MODULE_BINDING,
    required_capability: capability,
    ...extra,
  };
}

export function projectMoodleChoiceOptions(value: unknown, expected: MoodleActivityContentExpectation): JsonObject {
  const error = "moodle_choice_options_invalid";
  const source = header(value, MOODLE_CHOICE_OPTIONS_SCHEMA, expected, error);
  const choiceId = positiveId(source.choice_id);
  const optionCount = count(source.option_count, OPTION_LIMIT);
  const limitAnswers = source.limit_answers;
  const allowMultiple = source.allow_multiple;
  const hasResponses = source.has_responses;
  if (!choiceId || optionCount === null || !Array.isArray(source.options) || source.options.length !== optionCount
    || typeof limitAnswers !== "boolean" || typeof allowMultiple !== "boolean" || typeof hasResponses !== "boolean") {
    throw new Error(error);
  }
  const seen = new Set<number>();
  const options: MoodleChoiceOption[] = source.options.map((entry, index) => {
    const row = isJsonObject(entry) ? entry : null;
    const optionId = row ? positiveId(row.option_id) : null;
    const text = row ? boundedText(row.text) : null;
    const responseLimit = row ? count(row.response_limit, COUNT_LIMIT) : null;
    if (!row || !optionId || seen.has(optionId) || !text || responseLimit === null || row.position !== index + 1) {
      throw new Error(error);
    }
    seen.add(optionId);
    return { option_id: optionId, position: index + 1, text, response_limit: responseLimit };
  });
  return {
    schema: MOODLE_CHOICE_OPTIONS_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    choice_id: choiceId,
    option_count: optionCount,
    options,
    limit_answers: limitAnswers,
    allow_multiple: allowMultiple,
    has_responses: hasResponses,
    proof: proofOf(source, MODULE_BINDING, "moodle/course:manageactivities", {
      option_limit: OPTION_LIMIT, option_rows: optionCount, text_limit: TEXT_LIMIT,
    }, error),
  };
}

export function projectMoodleChoiceResponseSummary(value: unknown, expected: MoodleActivityContentExpectation): JsonObject {
  const error = "moodle_choice_response_summary_invalid";
  const source = header(value, MOODLE_CHOICE_RESPONSE_SUMMARY_SCHEMA, expected, error);
  const choiceId = positiveId(source.choice_id);
  const responded = count(source.responded_participant_count, COUNT_LIMIT);
  const allowMultiple = source.allow_multiple;
  const activityRows = count(isJsonObject(source.proof) ? source.proof.activity_rows : null, ACTIVITY_LIMIT);
  if (!choiceId || responded === null || typeof allowMultiple !== "boolean" || activityRows === null) throw new Error(error);
  return {
    schema: MOODLE_CHOICE_RESPONSE_SUMMARY_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    choice_id: choiceId,
    responded_participant_count: responded,
    allow_multiple: allowMultiple,
    proof: proofOf(source, `${MODULE_BINDING}+${OVERVIEW_METHOD}`, "mod/choice:readresponses", {
      activity_limit: ACTIVITY_LIMIT, activity_rows: activityRows, overview_item_key: "studentwhoresponded",
    }, error),
  };
}

export function projectMoodleFeedbackItems(value: unknown, expected: MoodleActivityContentExpectation): JsonObject {
  const error = "moodle_feedback_items_invalid";
  const source = header(value, MOODLE_FEEDBACK_ITEMS_SCHEMA, expected, error);
  const feedbackId = positiveId(source.feedback_id);
  const itemCount = count(source.item_count, ITEM_LIMIT);
  const anonymous = source.anonymous;
  if (!feedbackId || itemCount === null || typeof anonymous !== "boolean"
    || !Array.isArray(source.items) || source.items.length !== itemCount) throw new Error(error);
  const seen = new Set<number>();
  const items: MoodleFeedbackItem[] = source.items.map((entry, index) => {
    const row = isJsonObject(entry) ? entry : null;
    const itemId = row ? positiveId(row.item_id) : null;
    const type = row ? slug(row.type) : null;
    const text = row ? boundedText(row.text) : null;
    const label = row ? boundedText(row.label) : null;
    const presentation = row ? boundedText(row.presentation) : null;
    const dependsOnValue = row ? boundedText(row.depends_on_value) : null;
    const dependsOnItemId = row && row.depends_on_item_id === null ? null : positiveId(row?.depends_on_item_id);
    if (!row || !itemId || seen.has(itemId) || !type || text === null || label === null || presentation === null
      || dependsOnValue === null || typeof row.required !== "boolean" || row.position !== index + 1
      || (row.depends_on_item_id !== null && dependsOnItemId === null)) {
      throw new Error(error);
    }
    seen.add(itemId);
    return {
      item_id: itemId,
      position: index + 1,
      type,
      required: row.required,
      text,
      label,
      presentation,
      depends_on_item_id: dependsOnItemId,
      depends_on_value: dependsOnValue,
    };
  });
  return {
    schema: MOODLE_FEEDBACK_ITEMS_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    feedback_id: feedbackId,
    anonymous,
    item_count: itemCount,
    items,
    proof: proofOf(source, `${MODULE_BINDING}+mod_feedback_export_items`, "mod/feedback:edititems", {
      item_limit: ITEM_LIMIT, item_rows: itemCount, text_limit: TEXT_LIMIT,
    }, error),
  };
}

/**
 * Rebuilds the aggregate Feedback response summary. An anonymous Feedback that
 * arrives with any per-learner content, or without its refusal state, is
 * refused by name rather than trimmed, so the attempt stays visible.
 */
export function projectMoodleFeedbackResponseSummary(value: unknown, expected: MoodleActivityContentExpectation): JsonObject {
  const error = "moodle_feedback_response_summary_invalid";
  const refused = "moodle_feedback_response_summary_anonymous_refused";
  const source = header(value, MOODLE_FEEDBACK_RESPONSE_SUMMARY_SCHEMA, expected, error);
  const anonymous = source.anonymous;
  if (typeof anonymous !== "boolean") throw new Error(error);
  const projection = source.per_learner_projection;
  if (anonymous && (projection !== "refused_anonymous" || LEARNER_PROJECTION_KEYS.some((key) => key in source))) {
    throw new Error(refused);
  }
  const feedbackId = positiveId(source.feedback_id);
  const responseCount = count(source.response_count, COUNT_LIMIT);
  const activityRows = count(isJsonObject(source.proof) ? source.proof.activity_rows : null, ACTIVITY_LIMIT);
  if (!feedbackId || responseCount === null || activityRows === null
    || projection !== (anonymous ? "refused_anonymous" : "not_supported")) throw new Error(error);
  return {
    schema: MOODLE_FEEDBACK_RESPONSE_SUMMARY_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    feedback_id: feedbackId,
    anonymous,
    response_count: responseCount,
    per_learner_projection: projection,
    proof: proofOf(source, `${MODULE_BINDING}+${OVERVIEW_METHOD}`, "mod/feedback:viewreports", {
      activity_limit: ACTIVITY_LIMIT, activity_rows: activityRows, overview_item_key: "responses",
    }, error),
  };
}

export function projectMoodleDatabaseFields(value: unknown, expected: MoodleActivityContentExpectation): JsonObject {
  const error = "moodle_database_fields_invalid";
  const source = header(value, MOODLE_DATABASE_FIELDS_SCHEMA, expected, error);
  const databaseId = positiveId(source.database_id);
  const fieldCount = count(source.field_count, FIELD_LIMIT);
  const defaultSort = source.default_sort_field_id;
  if (!databaseId || fieldCount === null || !Array.isArray(source.fields) || source.fields.length !== fieldCount
    || (defaultSort !== null && positiveId(defaultSort) === null)) throw new Error(error);
  const seen = new Set<number>();
  const fields: MoodleDatabaseField[] = source.fields.map((entry) => {
    const row = isJsonObject(entry) ? entry : null;
    const fieldId = row ? positiveId(row.field_id) : null;
    const name = row ? boundedText(row.name) : null;
    const type = row ? slug(row.type) : null;
    if (!row || !fieldId || seen.has(fieldId) || !name || !type) throw new Error(error);
    seen.add(fieldId);
    return { field_id: fieldId, name, type };
  });
  if (defaultSort !== null && !seen.has(Number(defaultSort))) throw new Error(error);
  return {
    schema: MOODLE_DATABASE_FIELDS_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    database_id: databaseId,
    field_count: fieldCount,
    default_sort_field_id: defaultSort === null ? null : Number(defaultSort),
    fields,
    proof: proofOf(source, `${MODULE_BINDING}+mod_data_field_index`, "mod/data:managetemplates", {
      field_limit: FIELD_LIMIT, field_rows: fieldCount, text_limit: TEXT_LIMIT,
    }, error),
  };
}

export function projectMoodleDatabaseEntrySummary(value: unknown, expected: MoodleActivityContentExpectation): JsonObject {
  const error = "moodle_database_entry_summary_invalid";
  const source = header(value, MOODLE_DATABASE_ENTRY_SUMMARY_SCHEMA, expected, error);
  const databaseId = positiveId(source.database_id);
  const entryCount = count(source.entry_count, COUNT_LIMIT);
  const awaiting = count(source.entries_awaiting_approval, entryCount ?? -1);
  const commentCount = count(source.comment_count, COUNT_LIMIT);
  const approvalRequired = source.approval_required;
  const activityRows = count(isJsonObject(source.proof) ? source.proof.activity_rows : null, ACTIVITY_LIMIT);
  if (!databaseId || entryCount === null || awaiting === null || commentCount === null
    || typeof approvalRequired !== "boolean" || activityRows === null) throw new Error(error);
  return {
    schema: MOODLE_DATABASE_ENTRY_SUMMARY_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    database_id: databaseId,
    entry_count: entryCount,
    entries_awaiting_approval: awaiting,
    comment_count: commentCount,
    approval_required: approvalRequired,
    proof: proofOf(source, `${MODULE_BINDING}+${OVERVIEW_METHOD}`, "mod/data:approve", {
      activity_limit: ACTIVITY_LIMIT, activity_rows: activityRows, overview_item_key: "totalentries",
    }, error),
  };
}

export type MoodleActivityContentRead = Readonly<{
  operation: string;
  tool: string;
  schema: string;
  /** True when the result is a learner-derived aggregate and needs its own egress projection. */
  learnerAggregate: boolean;
  summary: string;
  project: (value: unknown, expected: MoodleActivityContentExpectation) => JsonObject;
}>;

const READS: readonly MoodleActivityContentRead[] = [
  {
    operation: MOODLE_CHOICE_OPTIONS_OPERATION,
    tool: MOODLE_CHOICE_OPTIONS_TOOL,
    schema: MOODLE_CHOICE_OPTIONS_SCHEMA,
    learnerAggregate: false,
    summary: "Morrow read the saved option list of one exact Moodle Choice.",
    project: projectMoodleChoiceOptions,
  },
  {
    operation: MOODLE_CHOICE_RESPONSE_SUMMARY_OPERATION,
    tool: MOODLE_CHOICE_RESPONSE_SUMMARY_TOOL,
    schema: MOODLE_CHOICE_RESPONSE_SUMMARY_SCHEMA,
    learnerAggregate: true,
    summary: "Morrow read the aggregate response count of one exact Moodle Choice.",
    project: projectMoodleChoiceResponseSummary,
  },
  {
    operation: MOODLE_FEEDBACK_ITEMS_OPERATION,
    tool: MOODLE_FEEDBACK_ITEMS_TOOL,
    schema: MOODLE_FEEDBACK_ITEMS_SCHEMA,
    learnerAggregate: false,
    summary: "Morrow read the saved question items of one exact Moodle Feedback.",
    project: projectMoodleFeedbackItems,
  },
  {
    operation: MOODLE_FEEDBACK_RESPONSE_SUMMARY_OPERATION,
    tool: MOODLE_FEEDBACK_RESPONSE_SUMMARY_TOOL,
    schema: MOODLE_FEEDBACK_RESPONSE_SUMMARY_SCHEMA,
    learnerAggregate: true,
    summary: "Morrow read the aggregate response count of one exact Moodle Feedback.",
    project: projectMoodleFeedbackResponseSummary,
  },
  {
    operation: MOODLE_DATABASE_FIELDS_OPERATION,
    tool: MOODLE_DATABASE_FIELDS_TOOL,
    schema: MOODLE_DATABASE_FIELDS_SCHEMA,
    learnerAggregate: false,
    summary: "Morrow read the saved field list of one exact Moodle Database.",
    project: projectMoodleDatabaseFields,
  },
  {
    operation: MOODLE_DATABASE_ENTRY_SUMMARY_OPERATION,
    tool: MOODLE_DATABASE_ENTRY_SUMMARY_TOOL,
    schema: MOODLE_DATABASE_ENTRY_SUMMARY_SCHEMA,
    learnerAggregate: true,
    summary: "Morrow read the aggregate entry counts of one exact Moodle Database.",
    project: projectMoodleDatabaseEntrySummary,
  },
];

export function moodleActivityContentReadByTool(toolName: unknown): MoodleActivityContentRead | null {
  return READS.find((entry) => entry.tool === toolName) ?? null;
}

export function projectMoodleActivityContentBrowserResult(
  read: MoodleActivityContentRead,
  browserData: unknown,
  expected: MoodleActivityContentExpectation,
): JsonObject {
  return read.project(browserData, expected);
}
