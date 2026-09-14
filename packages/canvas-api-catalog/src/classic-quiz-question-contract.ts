/**
 * The Canvas Classic QuizQuestion response contract used by both planning and
 * browser execution. Canvas returns saved answer keys such as `text`, `html`,
 * `comments`, `comments_html`, and `weight`; its write route accepts the
 * corresponding `answer_*` request keys. This contract validates the complete
 * response and produces the complete answer request records needed to rebuild
 * a supported question without dropping provider state.
 *
 * Provider source checked 2026-09-13:
 * - lib/api/v1/quiz_question.rb API_ALLOWED_QUESTION_OUTPUT_FIELDS and
 *   API_ALLOWED_QUESTION_DATA_OUTPUT_FIELDS
 * - app/models/quizzes/quiz_question/answer_parsers/multiple_choice.rb
 * - spec/apis/v1/quizzes/quiz_questions_api_spec.rb
 *
 * Keep this file pure and browser-safe. scripts/sync-classic-quiz-question-
 * contract.mjs transpiles it into canvas-content.js so the two boundaries
 * cannot drift.
 */

export const CLASSIC_QUIZ_SUPPORTED_QUESTION_TYPES = Object.freeze([
  "multiple_choice_question",
  "true_false_question",
  "multiple_answers_question",
  "short_answer_question",
  "essay_question",
] as const);

const CLASSIC_QUIZ_ANSWERLESS_QUESTION_TYPES = new Set(["essay_question"]);
const CLASSIC_QUIZ_REQUIRED_TEXT_FIELDS = Object.freeze([
  "question_name",
  "question_text",
  "correct_comments",
  "incorrect_comments",
  "neutral_comments",
] as const);
const CLASSIC_QUIZ_OPTIONAL_TEXT_FIELDS = Object.freeze([
  "correct_comments_html",
  "incorrect_comments_html",
  "neutral_comments_html",
  "text_after_answers",
] as const);
const CLASSIC_QUIZ_NULLABLE_TYPE_FIELDS = Object.freeze([
  "variables",
  "formulas",
  "answer_tolerance",
  "formula_decimal_places",
  "matches",
  "matching_answer_incorrect_matches",
] as const);
const CLASSIC_QUIZ_RESPONSE_FIELDS = new Set([
  "id",
  "quiz_id",
  "quiz_group_id",
  "assessment_question_id",
  "assessment_question_bank_id",
  "created_at",
  "updated_at",
  "regrade_option",
  "question_type",
  "points_possible",
  "position",
  "answers",
  ...CLASSIC_QUIZ_REQUIRED_TEXT_FIELDS,
  ...CLASSIC_QUIZ_OPTIONAL_TEXT_FIELDS,
  ...CLASSIC_QUIZ_NULLABLE_TYPE_FIELDS,
]);
const CLASSIC_QUIZ_RESPONSE_ANSWER_FIELDS = new Set([
  "id",
  "text",
  "html",
  "weight",
  "comments",
  "comments_html",
  "answer_text",
  "answer_html",
  "answer_weight",
  "answer_comments",
  "answer_comment_html",
  "text_after_answers",
]);
const MAX_CLASSIC_QUIZ_ANSWERS = 100;
const CLASSIC_QUIZ_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type ClassicQuizQuestionContractIssue = Readonly<{
  ok: false;
  category: "incomplete" | "group_linked" | "type_unsupported" | "unmodelled_state";
  message: string;
}>;

export type ClassicQuizQuestionRequestAnswer = Readonly<{
  id: string;
  answer_text: string;
  answer_weight: number;
  answer_comments?: string;
  answer_comment_html?: string;
  answer_html?: string;
  text_after_answers?: string;
}>;

export type ClassicQuizQuestionContractResult = ClassicQuizQuestionContractIssue | Readonly<{
  ok: true;
  points: string;
  answers: readonly ClassicQuizQuestionRequestAnswer[];
}>;

type ClassicQuizAlias = Readonly<{
  present: boolean;
  value: unknown;
  issue?: ClassicQuizQuestionContractIssue;
}>;

function classicQuizPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A provider field is untrusted text, so a refusal repeats only a plain identifier. */
function classicQuizReportableField(name: string): string {
  return /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : "an unexpected field";
}

function classicQuizIssue(
  category: ClassicQuizQuestionContractIssue["category"],
  message: string,
): ClassicQuizQuestionContractIssue {
  return { ok: false, category, message };
}

function classicQuizId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) ? value : null;
}

function classicQuizPoints(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) ? value : null;
}

function classicQuizAlias(
  value: Record<string, unknown>,
  providerField: string,
  requestField: string,
): ClassicQuizAlias {
  const providerPresent = Object.hasOwn(value, providerField);
  const requestPresent = Object.hasOwn(value, requestField);
  if (providerPresent && requestPresent && value[providerField] !== value[requestField]) {
    return {
      present: false,
      value: undefined,
      issue: classicQuizIssue(
        "unmodelled_state",
        `Canvas returned conflicting ${providerField} and ${requestField} values on an answer of this question, and this repair cannot choose between them.`,
      ),
    };
  }
  return providerPresent ? { present: true, value: value[providerField] }
    : requestPresent ? { present: true, value: value[requestField] }
    : { present: false, value: undefined };
}

function classicQuizAnswers(
  question: Record<string, unknown>,
): readonly ClassicQuizQuestionRequestAnswer[] | ClassicQuizQuestionContractIssue {
  const rawAnswers = question.answers;
  if (CLASSIC_QUIZ_ANSWERLESS_QUESTION_TYPES.has(String(question.question_type))) {
    if (rawAnswers !== undefined && rawAnswers !== null && (!Array.isArray(rawAnswers) || rawAnswers.length > 0)) {
      return classicQuizIssue("unmodelled_state", "Canvas returned answers for this essay question, and this repair cannot send them back.");
    }
    return [];
  }
  if (!Array.isArray(rawAnswers) || rawAnswers.length < 1 || rawAnswers.length > MAX_CLASSIC_QUIZ_ANSWERS) {
    return classicQuizIssue("incomplete", "Canvas did not return the answers for this question, and Morrow will not rebuild a question without them.");
  }
  const seen = new Set<string>();
  const rebuilt: ClassicQuizQuestionRequestAnswer[] = [];
  for (const rawAnswer of rawAnswers) {
    if (!classicQuizPlainObject(rawAnswer)) {
      return classicQuizIssue("incomplete", "Canvas did not return one of this question's answers as a record, and Morrow will not rebuild a question without it.");
    }
    const unmodelled = Object.keys(rawAnswer).find((field) => !CLASSIC_QUIZ_RESPONSE_ANSWER_FIELDS.has(field));
    if (unmodelled) {
      return classicQuizIssue(
        "unmodelled_state",
        `Canvas returned ${classicQuizReportableField(unmodelled)} on an answer of this question, and this repair cannot send it back.`,
      );
    }
    const id = classicQuizId(rawAnswer.id);
    if (!id || seen.has(id)) {
      return classicQuizIssue("incomplete", "Canvas did not return one exact identifier for every answer of this question, and Morrow will not rebuild a question without them.");
    }
    seen.add(id);
    const text = classicQuizAlias(rawAnswer, "text", "answer_text");
    const weight = classicQuizAlias(rawAnswer, "weight", "answer_weight");
    const comments = classicQuizAlias(rawAnswer, "comments", "answer_comments");
    const commentsHtml = classicQuizAlias(rawAnswer, "comments_html", "answer_comment_html");
    const html = classicQuizAlias(rawAnswer, "html", "answer_html");
    for (const alias of [text, weight, comments, commentsHtml, html]) {
      if (alias.issue) return alias.issue;
    }
    if (typeof text.value !== "string" || typeof weight.value !== "number" || !Number.isInteger(weight.value)
      || weight.value < 0 || weight.value > 100) {
      return classicQuizIssue("incomplete", "Canvas did not return text and weight for every answer of this question.");
    }
    for (const [field, alias] of [["comments", comments], ["comments_html", commentsHtml], ["html", html]] as const) {
      if (alias.present && typeof alias.value !== "string") {
        return classicQuizIssue("incomplete", `Canvas returned ${field} on an answer of this question in a form Morrow cannot send back.`);
      }
    }
    if (Object.hasOwn(rawAnswer, "text_after_answers") && typeof rawAnswer.text_after_answers !== "string") {
      return classicQuizIssue("incomplete", "Canvas returned text_after_answers on an answer of this question in a form Morrow cannot send back.");
    }
    rebuilt.push({
      id,
      answer_text: text.value,
      answer_weight: weight.value,
      ...(comments.present ? { answer_comments: comments.value as string } : {}),
      ...(commentsHtml.present ? { answer_comment_html: commentsHtml.value as string } : {}),
      ...(html.present ? { answer_html: html.value as string } : {}),
      ...(Object.hasOwn(rawAnswer, "text_after_answers") ? { text_after_answers: rawAnswer.text_after_answers as string } : {}),
    });
  }
  return rebuilt;
}

/** Validate one complete fresh QuizQuestion response and build its safe write form. */
export function classicQuizQuestionContract(value: unknown): ClassicQuizQuestionContractResult {
  if (!classicQuizPlainObject(value)) {
    return classicQuizIssue("incomplete", "Canvas did not return this question as a record.");
  }
  if (value.quiz_group_id !== undefined && value.quiz_group_id !== null) {
    return classicQuizIssue("group_linked", "This question belongs to a question group, so Canvas can rebuild it from a question bank and a change here could reach other quizzes. Morrow does not repair it.");
  }
  if (typeof value.question_type !== "string"
    || !CLASSIC_QUIZ_SUPPORTED_QUESTION_TYPES.includes(value.question_type as typeof CLASSIC_QUIZ_SUPPORTED_QUESTION_TYPES[number])) {
    return classicQuizIssue("type_unsupported", "Morrow repairs images only in multiple choice, true or false, multiple answers, short answer, and essay Classic Quiz questions.");
  }
  const unmodelled = Object.keys(value).find((field) => !CLASSIC_QUIZ_RESPONSE_FIELDS.has(field));
  if (unmodelled) {
    return classicQuizIssue("unmodelled_state", `Canvas returned ${classicQuizReportableField(unmodelled)} for this question, and this repair cannot send it back.`);
  }
  for (const field of CLASSIC_QUIZ_REQUIRED_TEXT_FIELDS) {
    if (typeof value[field] !== "string") {
      return classicQuizIssue("incomplete", `Canvas did not return ${field} for this question, and Morrow will not rebuild a question without it.`);
    }
  }
  for (const field of CLASSIC_QUIZ_OPTIONAL_TEXT_FIELDS) {
    if (Object.hasOwn(value, field) && value[field] !== null && typeof value[field] !== "string") {
      return classicQuizIssue("incomplete", `Canvas returned ${field} for this question in a form Morrow cannot preserve.`);
    }
  }
  const points = classicQuizPoints(value.points_possible);
  if (points === null) {
    return classicQuizIssue("incomplete", "Canvas did not return points_possible for this question, and Morrow will not rebuild a question without it.");
  }
  if (!Number.isSafeInteger(value.position) || (value.position as number) < 1) {
    return classicQuizIssue("incomplete", "Canvas did not return position for this question, and Morrow will not rebuild a question without it.");
  }
  for (const field of ["assessment_question_id", "assessment_question_bank_id"]) {
    if (Object.hasOwn(value, field) && value[field] !== null && classicQuizId(value[field]) === null) {
      return classicQuizIssue("incomplete", `Canvas returned ${field} for this question in a form Morrow cannot preserve.`);
    }
  }
  for (const field of ["created_at", "updated_at"]) {
    if (Object.hasOwn(value, field) && (typeof value[field] !== "string" || !CLASSIC_QUIZ_TIMESTAMP.test(value[field] as string)
      || !Number.isFinite(Date.parse(value[field] as string)))) {
      return classicQuizIssue("incomplete", `Canvas returned ${field} for this question in a form Morrow cannot preserve.`);
    }
  }
  if (value.regrade_option !== undefined && value.regrade_option !== null) {
    return classicQuizIssue("unmodelled_state", "Canvas returned a nonempty regrade_option for this question, and this repair cannot preserve its regrade meaning.");
  }
  for (const field of CLASSIC_QUIZ_NULLABLE_TYPE_FIELDS) {
    if (value[field] !== undefined && value[field] !== null) {
      return classicQuizIssue("unmodelled_state", `Canvas returned nonempty ${field} for this question type, and this repair cannot send it back.`);
    }
  }
  const answers = classicQuizAnswers(value);
  return Array.isArray(answers) ? { ok: true, points, answers } : answers as ClassicQuizQuestionContractIssue;
}
