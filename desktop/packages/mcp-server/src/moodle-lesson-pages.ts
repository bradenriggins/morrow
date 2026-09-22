import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_LESSON_PAGE_LIST_OPERATION = "moodle.form.lesson.pages.read.v1";
export const MOODLE_LESSON_PAGE_LIST_TOOL = "moodle_list_lesson_pages";
export const MOODLE_LESSON_PAGE_LIST_SCHEMA = "morrow.moodle-lesson-page-list.v1";

export const MOODLE_LESSON_PAGE_OPERATION = "moodle.form.lesson.page.read.v1";
export const MOODLE_LESSON_PAGE_TOOL = "moodle_get_lesson_page";
export const MOODLE_LESSON_PAGE_SCHEMA = "morrow.moodle-lesson-page.v1";

const MAX_PAGES = 100;
const MAX_ANSWERS = 40;
const MAX_TITLE = 255;
const MAX_RICH_TEXT = 40_000;

/** mod/lesson/pagetypes/*.php, Moodle v5.2.2. */
const PAGE_TYPES: Readonly<Record<number, string>> = {
  1: "shortanswer",
  2: "truefalse",
  3: "multichoice",
  5: "matching",
  8: "numerical",
  10: "essay",
  20: "branchtable",
  21: "endofbranch",
  30: "cluster",
  31: "endofcluster",
};

const PAGE_KINDS: Readonly<Record<string, "question" | "content" | "structure">> = {
  shortanswer: "question",
  truefalse: "question",
  multichoice: "question",
  matching: "question",
  numerical: "question",
  essay: "question",
  branchtable: "content",
  endofbranch: "structure",
  cluster: "structure",
  endofcluster: "structure",
};

/** mod/lesson/locallib.php, Moodle v5.2.2. A positive jumpto value is a page ID. */
const JUMP_NAMES = [
  "this_page",
  "next_page",
  "end_of_lesson",
  "previous_page",
  "unseen_branch_page",
  "random_page",
  "random_branch",
  "cluster_jump",
] as const;

const SCORE = /^-?(?:0|[1-9][0-9]{0,6})$/u;
const FORMAT = /^[0-9]{1,3}$/u;

/**
 * The same refusal the Moodle Quiz question reader applies to rich text it
 * returns, repeated here so a browser result that carries a draft-file
 * reference or embedded media cannot reach a caller.
 * connector/extension/src/moodle-executor.js hasEmbeddedFile.
 */
const EMBEDDED_FILE = /(?:draftfile\.php\/|@@PLUGINFILE@@|<\s*(?:img|audio|video|source|track|object|embed|iframe)\b|\b(?:src|poster)\s*=\s*["']?\s*(?:data:|blob:))/iu;

export type MoodleLessonJump =
  | Readonly<{ index: number; target: "page"; page_id: number }>
  | Readonly<{ index: number; target: (typeof JUMP_NAMES)[number] }>;

export type MoodleLessonPageSummary = Readonly<{
  page_id: number;
  position: number;
  title: string;
  page_type: string;
  page_type_id: number;
  page_kind: "question" | "content" | "structure";
  jumps: readonly MoodleLessonJump[];
  branch_target_page_ids: readonly number[];
}>;

export type MoodleLessonPageList = Readonly<{
  schema: typeof MOODLE_LESSON_PAGE_LIST_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  lesson_id: number;
  page_count: number;
  pages: readonly MoodleLessonPageSummary[];
  proof: Readonly<{
    list_source: "mod_lesson_edit_page";
    page_source: "mod_lesson_editpage_form";
    exact_module_binding: "course_modedit_form";
    required_capability: "mod/lesson:manage";
    page_form_capability: "mod/lesson:edit";
    jump_source: "editpage_form_stored_answers";
    learner_progress: "not_recorded";
    page_content: "not_returned";
    view_route: "never_opened";
    page_limit: typeof MAX_PAGES;
    answer_limit: typeof MAX_ANSWERS;
    page_request_count: number;
  }>;
}>;

export type MoodleLessonAnswer = Readonly<{
  index: number;
  answer_text: string | null;
  answer_format: string | null;
  response_text: string | null;
  response_format: string | null;
  score: string | null;
  jump: Omit<MoodleLessonJump, "index">;
}>;

export type MoodleLessonPage = Readonly<{
  schema: typeof MOODLE_LESSON_PAGE_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  lesson_id: number;
  page_id: number;
  position: number;
  page_count: number;
  title: string;
  page_type: string;
  page_type_id: number;
  page_kind: "question" | "content" | "structure";
  contents_text: string;
  contents_format: string;
  answer_count: number;
  answers: readonly MoodleLessonAnswer[];
  proof: Readonly<{
    list_source: "mod_lesson_edit_page";
    page_source: "mod_lesson_editpage_form";
    exact_module_binding: "course_modedit_form";
    required_capability: "mod/lesson:manage";
    page_form_capability: "mod/lesson:edit";
    jump_source: "editpage_form_stored_answers";
    learner_progress: "not_recorded";
    file_bearing_text: "refused";
    view_route: "never_opened";
    page_limit: typeof MAX_PAGES;
    answer_limit: typeof MAX_ANSWERS;
  }>;
}>;

export type MoodleLessonPageListExpectation = Readonly<{ courseId: number; moduleId: number }>;
export type MoodleLessonPageExpectation = Readonly<{ courseId: number; moduleId: number; pageId: number }>;

function invalid(error: string): never {
  throw new Error(error);
}

function positiveId(value: unknown, error: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(error);
  return Number(value);
}

function exactText(value: unknown, maximum: number, error: string): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) invalid(error);
  return value;
}

function richText(value: unknown, error: string): string {
  if (typeof value !== "string" || value.length > MAX_RICH_TEXT || value.includes("\u0000")) invalid(error);
  if (EMBEDDED_FILE.test(value)) invalid(error);
  return value;
}

function pageType(value: JsonObject, error: string): { id: number; name: string; kind: "question" | "content" | "structure" } {
  const typeId = positiveId(value.page_type_id, error);
  const name = PAGE_TYPES[typeId];
  if (!name || value.page_type !== name) invalid(error);
  const kind = PAGE_KINDS[name]!;
  if (value.page_kind !== kind) invalid(error);
  return { id: typeId, name, kind };
}

function jump(value: unknown, error: string): { target: string; page_id?: number } {
  if (!isJsonObject(value)) invalid(error);
  if (value.target === "page") {
    if (Object.keys(value).filter((key) => key !== "index").length !== 2) invalid(error);
    return { target: "page", page_id: positiveId(value.page_id, error) };
  }
  const named = JUMP_NAMES.find((entry) => entry === value.target);
  if (!named || Object.keys(value).filter((key) => key !== "index").length !== 1) invalid(error);
  return { target: named };
}

function pageSummary(value: unknown, position: number, error: string): MoodleLessonPageSummary {
  if (!isJsonObject(value)) invalid(error);
  if (value.position !== position) invalid(error);
  const type = pageType(value, error);
  if (!Array.isArray(value.jumps) || !value.jumps.length || value.jumps.length > MAX_ANSWERS) invalid(error);
  if (!Array.isArray(value.branch_target_page_ids)) invalid(error);
  const jumps: MoodleLessonJump[] = value.jumps.map((entry, index) => {
    if (!isJsonObject(entry) || !Number.isSafeInteger(entry.index) || Number(entry.index) < 0) invalid(error);
    const resolved = jump(entry, error);
    return (resolved.page_id === undefined
      ? { index: Number(entry.index), target: resolved.target as (typeof JUMP_NAMES)[number] }
      : { index: Number(entry.index), target: "page", page_id: resolved.page_id }) as MoodleLessonJump;
  });
  if (jumps.some((entry, index) => index > 0 && entry.index <= jumps[index - 1]!.index)) invalid(error);
  const targets = [...new Set(jumps.filter((entry) => entry.target === "page").map((entry) => (entry as { page_id: number }).page_id))]
    .sort((left, right) => left - right);
  if (value.branch_target_page_ids.length !== targets.length
    || value.branch_target_page_ids.some((entry, index) => entry !== targets[index])) invalid(error);
  return {
    page_id: positiveId(value.page_id, error),
    position,
    title: exactText(value.title, MAX_TITLE, error),
    page_type: type.name,
    page_type_id: type.id,
    page_kind: type.kind,
    jumps,
    branch_target_page_ids: targets,
  };
}

/**
 * Re-validates the complete Lesson page graph for one exact module. Every page
 * position, every jump and every branch target is recomputed here, so a browser
 * result cannot report a graph its own pages contradict, and every jump that
 * names a page must name a page of the same Lesson.
 */
export function projectMoodleLessonPageList(
  value: unknown,
  expected: MoodleLessonPageListExpectation,
): MoodleLessonPageList {
  const error = "moodle_lesson_pages_invalid";
  if (!isJsonObject(value) || value.schema !== MOODLE_LESSON_PAGE_LIST_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id, error) !== expected.courseId
    || positiveId(value.module_id, error) !== expected.moduleId) invalid(error);
  const lessonId = positiveId(value.lesson_id, error);
  if (!Array.isArray(value.pages) || value.pages.length > MAX_PAGES) invalid(error);
  const proof = isJsonObject(value.proof) ? value.proof : invalid(error);
  if (proof.list_source !== "mod_lesson_edit_page" || proof.page_source !== "mod_lesson_editpage_form"
    || proof.exact_module_binding !== "course_modedit_form" || proof.required_capability !== "mod/lesson:manage"
    || proof.page_form_capability !== "mod/lesson:edit" || proof.jump_source !== "editpage_form_stored_answers"
    || proof.learner_progress !== "not_recorded" || proof.page_content !== "not_returned"
    || proof.view_route !== "never_opened" || proof.page_limit !== MAX_PAGES || proof.answer_limit !== MAX_ANSWERS
    || proof.page_request_count !== value.pages.length) invalid(error);
  const pages = value.pages.map((entry, index) => pageSummary(entry, index + 1, error));
  const known = new Set(pages.map((entry) => entry.page_id));
  if (known.size !== pages.length) invalid(error);
  for (const page of pages) {
    if (page.branch_target_page_ids.some((target) => !known.has(target))) invalid(error);
  }
  if (value.page_count !== pages.length) invalid(error);
  return {
    schema: MOODLE_LESSON_PAGE_LIST_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    lesson_id: lessonId,
    page_count: pages.length,
    pages,
    proof: {
      list_source: "mod_lesson_edit_page",
      page_source: "mod_lesson_editpage_form",
      exact_module_binding: "course_modedit_form",
      required_capability: "mod/lesson:manage",
      page_form_capability: "mod/lesson:edit",
      jump_source: "editpage_form_stored_answers",
      learner_progress: "not_recorded",
      page_content: "not_returned",
      view_route: "never_opened",
      page_limit: MAX_PAGES,
      answer_limit: MAX_ANSWERS,
      page_request_count: pages.length,
    },
  };
}

function answer(value: unknown, error: string): MoodleLessonAnswer {
  if (!isJsonObject(value) || !Number.isSafeInteger(value.index) || Number(value.index) < 0
    || Number(value.index) >= MAX_ANSWERS) invalid(error);
  const answerText = value.answer_text === null ? null : richText(value.answer_text, error);
  const answerFormat = value.answer_format === null ? null : exactText(value.answer_format, 8, error);
  if (answerFormat !== null && (!FORMAT.test(answerFormat) || answerText === null)) invalid(error);
  const responseText = value.response_text === null ? null : richText(value.response_text, error);
  const responseFormat = value.response_format === null ? null : exactText(value.response_format, 8, error);
  if ((responseText === null) !== (responseFormat === null)) invalid(error);
  if (responseFormat !== null && !FORMAT.test(responseFormat)) invalid(error);
  const score = value.score === null ? null : exactText(value.score, 16, error);
  if (score !== null && !SCORE.test(score)) invalid(error);
  const resolved = jump(value.jump, error);
  return {
    index: Number(value.index),
    answer_text: answerText,
    answer_format: answerFormat,
    response_text: responseText,
    response_format: responseFormat,
    score,
    jump: (resolved.page_id === undefined
      ? { target: resolved.target as (typeof JUMP_NAMES)[number] }
      : { target: "page", page_id: resolved.page_id }) as Omit<MoodleLessonJump, "index">,
  };
}

/**
 * Re-validates one exact Lesson page. Rich text is checked again here against
 * the draft-file and embedded-media test the browser reader applies, so a page
 * that carries a file reference is refused at the runtime boundary as well.
 *
 * A single page read carries no page list, so this projection can prove that
 * every jump names a page, but not that the named page belongs to the same
 * Lesson. The browser reader proves that against the stored page order before
 * it returns.
 */
export function projectMoodleLessonPage(
  value: unknown,
  expected: MoodleLessonPageExpectation,
): MoodleLessonPage {
  const error = "moodle_lesson_page_invalid";
  if (!isJsonObject(value) || value.schema !== MOODLE_LESSON_PAGE_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id, error) !== expected.courseId
    || positiveId(value.module_id, error) !== expected.moduleId
    || positiveId(value.page_id, error) !== expected.pageId) invalid(error);
  const lessonId = positiveId(value.lesson_id, error);
  const pageCount = positiveId(value.page_count, error);
  const position = positiveId(value.position, error);
  if (pageCount > MAX_PAGES || position > pageCount) invalid(error);
  const type = pageType(value, error);
  const proof = isJsonObject(value.proof) ? value.proof : invalid(error);
  if (proof.list_source !== "mod_lesson_edit_page" || proof.page_source !== "mod_lesson_editpage_form"
    || proof.exact_module_binding !== "course_modedit_form" || proof.required_capability !== "mod/lesson:manage"
    || proof.page_form_capability !== "mod/lesson:edit" || proof.jump_source !== "editpage_form_stored_answers"
    || proof.learner_progress !== "not_recorded" || proof.file_bearing_text !== "refused"
    || proof.view_route !== "never_opened" || proof.page_limit !== MAX_PAGES
    || proof.answer_limit !== MAX_ANSWERS) invalid(error);
  if (!Array.isArray(value.answers) || !value.answers.length || value.answers.length > MAX_ANSWERS) invalid(error);
  const answers = value.answers.map((entry) => answer(entry, error));
  if (answers.some((entry, index) => index > 0 && entry.index <= answers[index - 1]!.index)) invalid(error);
  if (value.answer_count !== answers.length) invalid(error);
  const contentsFormat = exactText(value.contents_format, 8, error);
  if (!FORMAT.test(contentsFormat)) invalid(error);
  return {
    schema: MOODLE_LESSON_PAGE_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    lesson_id: lessonId,
    page_id: expected.pageId,
    position,
    page_count: pageCount,
    title: exactText(value.title, MAX_TITLE, error),
    page_type: type.name,
    page_type_id: type.id,
    page_kind: type.kind,
    contents_text: richText(value.contents_text, error),
    contents_format: contentsFormat,
    answer_count: answers.length,
    answers,
    proof: {
      list_source: "mod_lesson_edit_page",
      page_source: "mod_lesson_editpage_form",
      exact_module_binding: "course_modedit_form",
      required_capability: "mod/lesson:manage",
      page_form_capability: "mod/lesson:edit",
      jump_source: "editpage_form_stored_answers",
      learner_progress: "not_recorded",
      file_bearing_text: "refused",
      view_route: "never_opened",
      page_limit: MAX_PAGES,
      answer_limit: MAX_ANSWERS,
    },
  };
}

export function projectMoodleLessonPageListBrowserResult(
  browserData: unknown,
  expected: MoodleLessonPageListExpectation,
): JsonObject {
  return projectMoodleLessonPageList(browserData, expected) as unknown as JsonObject;
}

export function projectMoodleLessonPageBrowserResult(
  browserData: unknown,
  expected: MoodleLessonPageExpectation,
): JsonObject {
  return projectMoodleLessonPage(browserData, expected) as unknown as JsonObject;
}
