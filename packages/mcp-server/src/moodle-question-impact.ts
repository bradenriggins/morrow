import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_QUESTION_BANK_IMPACT_SCOPE_OPERATION = "moodle.form.question.bank.impact_scope.read.v1";
export const MOODLE_QUESTION_BANK_IMPACT_SCOPE_TOOL = "moodle_get_question_bank_impact_scope";
export const MOODLE_QUESTION_BANK_IMPACT_SCOPE_SCHEMA = "morrow.moodle-question-bank-impact-scope.v1";

const MAX_QUIZZES = 50;
const MAX_SLOTS_PER_QUIZ = 100;
const MAX_FILTERS_PER_SLOT = 20;
const MAX_FILTER_VALUES = 50;
const MAX_REASONS = 200;
const RECOGNISED_FILTER_KEYS = ["category"] as const;
const JOINTYPES = [0, 1, 2] as const;
const JOINTYPE_NAMES = ["none", "any", "all"] as const;
const REASON_CODES = [
  "quiz_list_truncated",
  "slot_list_truncated",
  "slot_reference_unresolved",
  "random_filter_condition_not_exposed",
  "random_filter_condition_malformed",
  "random_context_not_exposed",
  "filter_jointype_none",
  "filter_class_unrecognised",
] as const;
const FILTER_KEY = /^[a-z][a-z0-9_]{0,63}$/u;
const FILTER_VALUE = /^[A-Za-z0-9_,.:@-]{1,64}$/u;

export type MoodleQuestionBankImpactStatus = "complete" | "impact_scope_incomplete";

export type MoodleQuestionBankImpactFilter = Readonly<{
  key: string;
  jointype: number;
  jointype_name: string;
  values: readonly string[];
  recognised: boolean;
  include_subcategories?: boolean;
}>;

export type MoodleQuestionBankImpactSlot = Readonly<{
  slot_id: number;
  position: number;
  reference: "direct" | "random";
  resolved: boolean;
  question_id?: number;
  version?: Readonly<{ mode: "latest" }> | Readonly<{ mode: "pinned"; number: number }>;
  questions_context_id?: number | null;
  filter_source?: "quiz_edit_slot_data";
  filter_jointype?: number;
  filter_jointype_name?: string;
  filters?: readonly MoodleQuestionBankImpactFilter[];
}>;

export type MoodleQuestionBankImpactQuiz = Readonly<{
  module_id: number;
  name?: string;
  slot_count: number;
  slots_readable: boolean;
  slots: readonly MoodleQuestionBankImpactSlot[];
}>;

export type MoodleQuestionBankImpactReason = Readonly<{
  reason: (typeof REASON_CODES)[number];
  module_id?: number;
  slot_id?: number;
  filter_key?: string;
}>;

export type MoodleQuestionBankImpactScope = Readonly<{
  schema: typeof MOODLE_QUESTION_BANK_IMPACT_SCOPE_SCHEMA;
  provider: "moodle";
  course_id: number;
  status: MoodleQuestionBankImpactStatus;
  quiz_count: number;
  slot_count: number;
  direct_reference_count: number;
  random_reference_count: number;
  quizzes: readonly MoodleQuestionBankImpactQuiz[];
  incomplete_reasons: readonly MoodleQuestionBankImpactReason[];
  incomplete_reasons_truncated: boolean;
  proof: Readonly<{
    method: "core_courseformat_get_state";
    slot_source: "mod_quiz_edit_page";
    required_capability: "mod/quiz:manage";
    scope: "approved_course_only";
    cross_course_references: "not_enumerated";
    condition_class_resolution: "not_exposed";
    plugin_components: "not_exposed";
    recognised_filter_keys: readonly string[];
    quiz_limit: typeof MAX_QUIZZES;
    slot_limit_per_quiz: typeof MAX_SLOTS_PER_QUIZ;
    reason_limit: typeof MAX_REASONS;
    question_bank_write_eligibility: "held";
  }>;
}>;

export type MoodleQuestionBankImpactScopeExpectation = Readonly<{ courseId: number }>;

function invalid(): never {
  throw new Error("moodle_question_bank_impact_scope_invalid");
}

function positiveId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
  return Number(value);
}

function count(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) invalid();
  return Number(value);
}

function exactText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}

function filter(value: unknown): MoodleQuestionBankImpactFilter {
  if (!isJsonObject(value)) invalid();
  const key = exactText(value.key, 64);
  const jointype = value.jointype;
  if (!FILTER_KEY.test(key) || !JOINTYPES.includes(jointype as 0 | 1 | 2)) invalid();
  if (value.jointype_name !== JOINTYPE_NAMES[jointype as 0 | 1 | 2]) invalid();
  if (!Array.isArray(value.values) || value.values.length > MAX_FILTER_VALUES) invalid();
  const values = value.values.map((entry) => {
    const text = exactText(entry, 64);
    if (!FILTER_VALUE.test(text)) invalid();
    return text;
  });
  if (value.recognised !== RECOGNISED_FILTER_KEYS.includes(key as "category")) invalid();
  const subcategories = value.include_subcategories;
  if (subcategories !== undefined && (typeof subcategories !== "boolean" || key !== "category")) invalid();
  return {
    key,
    jointype: jointype as number,
    jointype_name: JOINTYPE_NAMES[jointype as 0 | 1 | 2],
    values,
    recognised: value.recognised === true,
    ...(subcategories === undefined ? {} : { include_subcategories: subcategories }),
  };
}

function slot(value: unknown, position: number): MoodleQuestionBankImpactSlot {
  if (!isJsonObject(value)) invalid();
  const slotId = positiveId(value.slot_id);
  if (value.position !== position) invalid();
  if (value.reference !== "direct" && value.reference !== "random") invalid();
  if (typeof value.resolved !== "boolean") invalid();
  const base = { slot_id: slotId, position, resolved: value.resolved } as const;
  if (value.reference === "direct") {
    if (!value.resolved) return { ...base, reference: "direct" };
    const version = isJsonObject(value.version) ? value.version : invalid();
    if (version.mode === "latest") {
      if (Object.keys(version).length !== 1) invalid();
      return { ...base, reference: "direct", question_id: positiveId(value.question_id), version: { mode: "latest" } };
    }
    if (version.mode !== "pinned" || Object.keys(version).length !== 2) invalid();
    return {
      ...base,
      reference: "direct",
      question_id: positiveId(value.question_id),
      version: { mode: "pinned", number: positiveId(version.number) },
    };
  }
  // A random slot carries filter data only when the Quiz edit page exposed the
  // stored condition and it parsed. `resolved` stays false while that condition
  // parsed but its questions context is still missing, so the parsed filters
  // survive into the result and the reason names the exact gap.
  if (value.filter_source === undefined) {
    if (value.resolved !== false) invalid();
    return { ...base, reference: "random" };
  }
  if (value.filter_source !== "quiz_edit_slot_data") invalid();
  const jointype = value.filter_jointype;
  if (!JOINTYPES.includes(jointype as 0 | 1 | 2) || value.filter_jointype_name !== JOINTYPE_NAMES[jointype as 0 | 1 | 2]) invalid();
  if (!Array.isArray(value.filters) || !value.filters.length || value.filters.length > MAX_FILTERS_PER_SLOT) invalid();
  const contextId = value.questions_context_id === null ? null : positiveId(value.questions_context_id);
  if (value.resolved !== (contextId !== null)) invalid();
  return {
    ...base,
    reference: "random",
    questions_context_id: contextId,
    filter_source: "quiz_edit_slot_data",
    filter_jointype: jointype as number,
    filter_jointype_name: JOINTYPE_NAMES[jointype as 0 | 1 | 2],
    filters: value.filters.map(filter),
  };
}

function quiz(value: unknown): MoodleQuestionBankImpactQuiz {
  if (!isJsonObject(value)) invalid();
  const moduleId = positiveId(value.module_id);
  if (typeof value.slots_readable !== "boolean" || !Array.isArray(value.slots)) invalid();
  if (value.slots.length > MAX_SLOTS_PER_QUIZ || count(value.slot_count, MAX_SLOTS_PER_QUIZ) !== value.slots.length) invalid();
  if (!value.slots_readable && value.slots.length) invalid();
  const name = value.name === undefined ? undefined : exactText(value.name, 1_333);
  const slots = value.slots.map((entry, index) => slot(entry, index + 1));
  const slotIds = new Set(slots.map((entry) => entry.slot_id));
  if (slotIds.size !== slots.length) invalid();
  return {
    module_id: moduleId,
    ...(name === undefined ? {} : { name }),
    slot_count: slots.length,
    slots_readable: value.slots_readable,
    slots,
  };
}

function reason(value: unknown): MoodleQuestionBankImpactReason {
  if (!isJsonObject(value)) invalid();
  const code = REASON_CODES.find((entry) => entry === value.reason);
  if (!code) invalid();
  const moduleId = value.module_id === undefined ? undefined : positiveId(value.module_id);
  const slotId = value.slot_id === undefined ? undefined : positiveId(value.slot_id);
  const filterKey = value.filter_key === undefined ? undefined : exactText(value.filter_key, 64);
  if (filterKey !== undefined && !FILTER_KEY.test(filterKey)) invalid();
  if (Object.keys(value).length !== 1 + [moduleId, slotId, filterKey].filter((entry) => entry !== undefined).length) invalid();
  return {
    reason: code,
    ...(moduleId === undefined ? {} : { module_id: moduleId }),
    ...(slotId === undefined ? {} : { slot_id: slotId }),
    ...(filterKey === undefined ? {} : { filter_key: filterKey }),
  };
}

/**
 * Recomputes the incomplete verdict from the enumerated references instead of
 * trusting the status the browser sent. A stored filter that is not recognised,
 * a jointype NONE, an unresolved reference, or a missing random context each
 * force impact_scope_incomplete here, so a browser result cannot report a
 * complete scope that its own slot data contradicts.
 */
function derivedReasonCount(scope: Omit<MoodleQuestionBankImpactScope, "status">): number {
  let required = 0;
  for (const entry of scope.quizzes) {
    if (!entry.slots_readable) required += 1;
    for (const item of entry.slots) {
      if (item.reference === "direct") {
        if (!item.resolved) required += 1;
        continue;
      }
      if (item.filter_source === undefined) {
        required += 1;
        continue;
      }
      if (item.questions_context_id === null) required += 1;
      if (item.filter_jointype === 0) required += 1;
      for (const stored of item.filters ?? []) {
        if (stored.jointype === 0) required += 1;
        if (!stored.recognised) required += 1;
      }
    }
  }
  return required;
}

function scopeBody(value: JsonObject): MoodleQuestionBankImpactScope {
  if (!Array.isArray(value.quizzes) || value.quizzes.length > MAX_QUIZZES) invalid();
  if (!Array.isArray(value.incomplete_reasons) || value.incomplete_reasons.length > MAX_REASONS) invalid();
  if (typeof value.incomplete_reasons_truncated !== "boolean") invalid();
  const proof = isJsonObject(value.proof) ? value.proof : invalid();
  if (proof.method !== "core_courseformat_get_state" || proof.slot_source !== "mod_quiz_edit_page"
    || proof.required_capability !== "mod/quiz:manage" || proof.scope !== "approved_course_only"
    || proof.cross_course_references !== "not_enumerated" || proof.condition_class_resolution !== "not_exposed"
    || proof.plugin_components !== "not_exposed" || proof.quiz_limit !== MAX_QUIZZES
    || proof.slot_limit_per_quiz !== MAX_SLOTS_PER_QUIZ || proof.reason_limit !== MAX_REASONS
    || proof.question_bank_write_eligibility !== "held"
    || !Array.isArray(proof.recognised_filter_keys)
    || proof.recognised_filter_keys.length !== RECOGNISED_FILTER_KEYS.length
    || proof.recognised_filter_keys.some((entry, index) => entry !== RECOGNISED_FILTER_KEYS[index])) invalid();
  const quizzes = value.quizzes.map(quiz);
  if (new Set(quizzes.map((entry) => entry.module_id)).size !== quizzes.length) invalid();
  const reasons = value.incomplete_reasons.map(reason);
  const slots = quizzes.flatMap((entry) => entry.slots);
  const body: Omit<MoodleQuestionBankImpactScope, "status"> = {
    schema: MOODLE_QUESTION_BANK_IMPACT_SCOPE_SCHEMA,
    provider: "moodle",
    course_id: positiveId(value.course_id),
    quiz_count: quizzes.length,
    slot_count: slots.length,
    direct_reference_count: slots.filter((entry) => entry.reference === "direct").length,
    random_reference_count: slots.filter((entry) => entry.reference === "random").length,
    quizzes,
    incomplete_reasons: reasons,
    incomplete_reasons_truncated: value.incomplete_reasons_truncated,
    proof: {
      method: "core_courseformat_get_state",
      slot_source: "mod_quiz_edit_page",
      required_capability: "mod/quiz:manage",
      scope: "approved_course_only",
      cross_course_references: "not_enumerated",
      condition_class_resolution: "not_exposed",
      plugin_components: "not_exposed",
      recognised_filter_keys: [...RECOGNISED_FILTER_KEYS],
      quiz_limit: MAX_QUIZZES,
      slot_limit_per_quiz: MAX_SLOTS_PER_QUIZ,
      reason_limit: MAX_REASONS,
      question_bank_write_eligibility: "held",
    },
  };
  if (count(value.quiz_count, MAX_QUIZZES) !== body.quiz_count
    || count(value.slot_count, MAX_QUIZZES * MAX_SLOTS_PER_QUIZ) !== body.slot_count
    || count(value.direct_reference_count, MAX_QUIZZES * MAX_SLOTS_PER_QUIZ) !== body.direct_reference_count
    || count(value.random_reference_count, MAX_QUIZZES * MAX_SLOTS_PER_QUIZ) !== body.random_reference_count) invalid();
  const required = derivedReasonCount(body);
  if (reasons.length < required && !body.incomplete_reasons_truncated) invalid();
  const incomplete = reasons.length > 0 || body.incomplete_reasons_truncated || required > 0;
  const status: MoodleQuestionBankImpactStatus = incomplete ? "impact_scope_incomplete" : "complete";
  if (value.status !== status) invalid();
  return { ...body, status };
}

/**
 * Re-validates the enumerated Question Bank impact scope for one exact course.
 * The verdict is recomputed here; a browser result that claims a complete scope
 * while carrying an unrecognised filter, a jointype NONE, a truncated list, or
 * an unresolved reference is refused.
 */
export function projectMoodleQuestionBankImpactScope(
  value: unknown,
  expected: MoodleQuestionBankImpactScopeExpectation,
): MoodleQuestionBankImpactScope {
  if (!isJsonObject(value) || value.schema !== MOODLE_QUESTION_BANK_IMPACT_SCOPE_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId) invalid();
  return scopeBody(value);
}

export function projectMoodleQuestionBankImpactScopeBrowserResult(
  browserData: unknown,
  expected: MoodleQuestionBankImpactScopeExpectation,
): JsonObject {
  return projectMoodleQuestionBankImpactScope(browserData, expected) as unknown as JsonObject;
}
