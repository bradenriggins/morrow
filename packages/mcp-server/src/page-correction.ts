import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { Parser } from "htmlparser2";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import type { GatewayRuntime } from "./runtime.js";

const textInputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  page_url: z.string().min(1).max(1000).describe("The page identifier from Canvas, not a full web address."),
  find_text: z.string().min(1).max(10000).describe("One exact, unique visible phrase within a single text section. Do not include HTML."),
  replace_text: z.string().max(10000).describe("Plain replacement text. Use an empty string to remove the selected phrase."),
});

const imageAltInputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  page_url: z.string().min(1).max(1000).describe("The page identifier from Canvas, not a full web address."),
  expected_body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  image_index: z.number().int().min(1).max(2 * 1024 * 1024),
  image_src_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alt_text: z.string().max(500),
  decorative: z.boolean(),
}).superRefine((value, context) => {
  if (value.decorative ? value.alt_text !== "" : value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Decorative images use empty alternative text. Other images need alternative text." });
  }
});

const assignmentImageAltInputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  assignment_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  expected_body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  image_index: z.number().int().min(1).max(2 * 1024 * 1024),
  image_src_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alt_text: z.string().max(500),
  decorative: z.boolean(),
}).superRefine((value, context) => {
  if (value.decorative ? value.alt_text !== "" : value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Decorative images use empty alternative text. Other images need alternative text." });
  }
});

const discussionImageAltInputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  topic_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  expected_body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  image_index: z.number().int().min(1).max(2 * 1024 * 1024),
  image_src_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alt_text: z.string().max(500),
  decorative: z.boolean(),
}).superRefine((value, context) => {
  if (value.decorative ? value.alt_text !== "" : value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Decorative images use empty alternative text. Other images need alternative text." });
  }
});

const classicQuizDescriptionImageAltInputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  quiz_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  expected_body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  image_index: z.number().int().min(1).max(2 * 1024 * 1024),
  image_src_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alt_text: z.string().max(500),
  decorative: z.boolean(),
}).superRefine((value, context) => {
  if (value.decorative ? value.alt_text !== "" : value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Decorative images use empty alternative text. Other images need alternative text." });
  }
});

const classicQuizQuestionImageAltInputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  quiz_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  question_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  answer_id: z.string().regex(/^[1-9][0-9]{0,18}$/).optional().describe("Set only when the image is inside one answer of this question."),
  answer_field: z.enum(["answer_text", "answer_html"]).optional().describe("The answer field that holds the image. Required with answer_id."),
  expected_body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  image_index: z.number().int().min(1).max(2 * 1024 * 1024),
  image_src_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alt_text: z.string().max(500),
  decorative: z.boolean(),
}).superRefine((value, context) => {
  if (value.decorative ? value.alt_text !== "" : value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Decorative images use empty alternative text. Other images need alternative text." });
  }
  if ((value.answer_id === undefined) !== (value.answer_field === undefined)) {
    context.addIssue({ code: "custom", message: "An answer repair needs both answer_id and answer_field. Leave both out to repair the question text." });
  }
});

const newQuizItemImageAltInputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  quiz_id: z.string().regex(/^[1-9][0-9]{0,18}$/).describe("The Canvas assignment ID of the New Quiz."),
  item_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  expected_body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  image_index: z.number().int().min(1).max(2 * 1024 * 1024),
  image_src_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alt_text: z.string().max(500),
  decorative: z.boolean(),
}).superRefine((value, context) => {
  if (value.decorative ? value.alt_text !== "" : value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Decorative images use empty alternative text. Other images need alternative text." });
  }
});

const newQuizChoiceImageAltInputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  quiz_id: z.string().regex(/^[1-9][0-9]{0,18}$/).describe("The Canvas assignment ID of the New Quiz."),
  item_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  choice_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  expected_body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  image_index: z.number().int().min(1).max(2 * 1024 * 1024),
  image_src_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alt_text: z.string().max(500),
  decorative: z.boolean(),
}).superRefine((value, context) => {
  if (value.decorative ? value.alt_text !== "" : value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Decorative images use empty alternative text. Other images need alternative text." });
  }
});

const newQuizAnswerFeedbackImageAltInputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  quiz_id: z.string().regex(/^[1-9][0-9]{0,18}$/).describe("The Canvas assignment ID of the New Quiz."),
  item_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  choice_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  expected_body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  image_index: z.number().int().min(1).max(2 * 1024 * 1024),
  image_src_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alt_text: z.string().max(500),
  decorative: z.boolean(),
}).superRefine((value, context) => {
  if (value.decorative ? value.alt_text !== "" : value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Decorative images use empty alternative text. Other images need alternative text." });
  }
});

const newQuizFeedbackImageAltInputSchema = z.object({
  source_binding_id: z.string().min(1).max(160),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  quiz_id: z.string().regex(/^[1-9][0-9]{0,18}$/).describe("The Canvas assignment ID of the New Quiz."),
  item_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  feedback_type: z.enum(["correct", "incorrect", "neutral"]),
  expected_body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  image_index: z.number().int().min(1).max(2 * 1024 * 1024),
  image_src_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alt_text: z.string().max(500),
  decorative: z.boolean(),
}).superRefine((value, context) => {
  if (value.decorative ? value.alt_text !== "" : value.alt_text.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Decorative images use empty alternative text. Other images need alternative text." });
  }
});

class PageCorrectionError extends Error {}

export type CanvasContentMissingAltEvidence = Readonly<{
  imageIndex: number;
  imageStart: number;
  imageEnd: number;
  imageTagSha256: string;
  imageSrcSha256: string;
}>;

export function canvasContentMissingAltEvidence(body: string): readonly CanvasContentMissingAltEvidence[] {
  const evidence: CanvasContentMissingAltEvidence[] = [];
  let imageIndex = 0;
  let templateDepth = 0;
  let foreignDepth = 0;
  let parser: Parser;
  parser = new Parser({
    onopentag(name, attributes, isImplied) {
      const ignored = templateDepth > 0 || foreignDepth > 0;
      if (!isImplied && name === "img" && !ignored) {
        imageIndex += 1;
        const sourceStart = parser.startIndex;
        const sourceEnd = parser.endIndex;
        const source = sourceStart >= 0 && sourceEnd >= sourceStart && sourceEnd < body.length
          ? body.slice(sourceStart, sourceEnd + 1)
          : "";
        const src = attributes.src;
        if (source.startsWith("<") && source.endsWith(">") && !Object.hasOwn(attributes, "alt") && typeof src === "string" && src.length > 0) {
          evidence.push({
            imageIndex,
            imageStart: sourceStart,
            imageEnd: sourceEnd,
            imageTagSha256: sha256Text(source),
            imageSrcSha256: sha256Text(src),
          });
        }
      }
      if (name === "template") templateDepth += 1;
      if (name === "svg" || name === "math") foreignDepth += 1;
    },
    onclosetag(name) {
      if (name === "template" && templateDepth > 0) templateDepth -= 1;
      if ((name === "svg" || name === "math") && foreignDepth > 0) foreignDepth -= 1;
    },
  }, { decodeEntities: true });
  parser.end(body);
  return evidence;
}

/** @deprecated Use canvasContentMissingAltEvidence for any Canvas HTML field. */
export const pageMissingAltEvidence = canvasContentMissingAltEvidence;

function exactId(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new PageCorrectionError("The page identifier is not exact.");
  const id = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new PageCorrectionError("The page identifier is unavailable.");
  return id;
}

function checkAnchor(body: string, find: string): void {
  const anchor = find.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const start = body.indexOf(anchor);
  if (start < 0 || body.indexOf(anchor, start + 1) !== -1) throw new PageCorrectionError("Choose a phrase that appears exactly once on this page.");
  const end = start + anchor.length;
  for (const entity of body.matchAll(/&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);?/g)) {
    const entityStart = entity.index;
    const entityEnd = entityStart + entity[0].length;
    if ((entityStart < start && start < entityEnd) || (entityStart < end && end < entityEnd)) {
      throw new PageCorrectionError("Choose visible page text, not an HTML character reference.");
    }
  }
  let blocked = false;
  for (const match of body.matchAll(/<!--[\s\S]*?-->|<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    if (match.index >= end) break;
    if (match.index + match[0].length > start) throw new PageCorrectionError("Choose visible page text, not an image setting or HTML.");
    if (/^<(script|style|iframe|object|embed|textarea|title)\b/i.test(match[0])) blocked = true;
    if (/^<\/(script|style|iframe|object|embed|textarea|title)\s*>/i.test(match[0])) blocked = false;
  }
  if (blocked) throw new PageCorrectionError("Text inside embedded content cannot be changed by this workflow.");
}

type PageInput = {
  readonly source_binding_id: string;
  readonly course_id: string;
  readonly page_url: string;
};

type CurrentPage = {
  readonly writeTool: string;
  readonly course: JsonObject;
  readonly page: JsonObject;
  readonly revision: JsonObject;
  readonly bodySha256: string;
  readonly fields: JsonObject;
};

async function currentPage(
  runtime: GatewayRuntime,
  input: PageInput,
  signal: AbortSignal,
): Promise<CurrentPage> {
  let source: string | undefined;
  const tool = (name: string, readOnly: boolean) => {
    const matches = runtime.searchCatalog({ query: name, limit: 100 }).tools.filter((candidate) => {
      const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
      return candidate.upstreamName === name && candidate.annotations?.readOnlyHint === readOnly
        && (!source || candidate.upstreamId === source) && isJsonObject(descriptor)
        && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new PageCorrectionError("The Canvas connection needed for this page is unavailable.");
    source = matches[0]!.upstreamId;
    return matches[0]!.publicName;
  };
  const writeTool = tool("canvas_update_create_page_courses", false);
  const read = async (name: string, args: JsonObject) => {
    try {
      return canvasReadResult(runtime, await runtime.callSourceOwned(tool(name, true), {
        ...args, _morrow: { source_binding_id: input.source_binding_id },
      }, { signal }));
    } catch {
      throw new PageCorrectionError("Morrow could not read the current Canvas Page evidence.");
    }
  };
  const args = { course_id: input.course_id, url_or_id: input.page_url };
  const [courseResult, pageResult, revisionResult] = await Promise.all([
    read("canvas_get_single_course_courses", { id: input.course_id }),
    read("canvas_show_page_courses", args),
    read("canvas_show_revision_courses_latest", args),
  ]);
  const course = courseResult.data;
  const page = pageResult.data;
  const revision = revisionResult.data;
  if (!isJsonObject(course) || exactId(course.id) !== input.course_id || typeof course.name !== "string"
    || !isJsonObject(page) || !isJsonObject(revision) || typeof page.body !== "string"
    || pageResult.pageBodySha256 !== sha256Text(page.body)) {
    throw new PageCorrectionError("Morrow could not read the complete, unchanged source page. Refresh the Canvas connection before trying again.");
  }
  if (page.editor === "block_editor" || page.block_editor_attributes != null) {
    throw new PageCorrectionError("This workflow cannot safely change a Canvas block-editor page.");
  }
  const fields: JsonObject = {};
  for (const field of ["url", "title", "published", "front_page", "editing_roles"]) {
    const expectedType = ["published", "front_page"].includes(field) ? "boolean" : "string";
    if (typeof page[field] !== expectedType) throw new PageCorrectionError("Canvas did not return all the page settings needed for this check.");
    fields[field] = page[field];
  }
  if (typeof page.publish_at !== "string" && page.publish_at !== null) {
    throw new PageCorrectionError("Canvas did not return all the page settings needed for this check.");
  }
  fields.publish_at = page.publish_at;
  if (revision.latest !== true || revision.body !== page.body || revision.url !== page.url || revision.title !== page.title) {
    throw new PageCorrectionError("The page changed during this check. Read the current page and create a new review.");
  }
  return { writeTool, course, page, revision, bodySha256: pageResult.pageBodySha256, fields };
}

type CanvasContentItemInput = {
  readonly source_binding_id: string;
  readonly course_id: string;
};

type CanvasContentItemTarget = {
  readonly readTool: string;
  readonly writeTool: string;
  readonly readArguments: (input: CanvasContentItemInput) => JsonObject;
  readonly writeArguments: (input: CanvasContentItemInput, guard: JsonObject) => JsonObject;
  readonly bodyField: "description" | "message";
  readonly itemId: (input: CanvasContentItemInput) => string;
  readonly itemLabel: "Assignment" | "Discussion" | "Classic Quiz";
  readonly requireCourseId?: boolean;
};

type CurrentCanvasContentItem = {
  readonly writeTool: string;
  readonly course: JsonObject;
  readonly item: JsonObject;
  readonly body: string;
  readonly bodySha256: string;
  readonly protectedStateSha256: string;
};

function protectedContentState(item: JsonObject, bodyField: "description" | "message"): string {
  const state = { ...item };
  delete state[bodyField];
  delete state.updated_at;
  return sha256Json(state);
}

async function currentCanvasContentItem(
  runtime: GatewayRuntime,
  input: CanvasContentItemInput,
  target: CanvasContentItemTarget,
  signal: AbortSignal,
): Promise<CurrentCanvasContentItem> {
  let source: string | undefined;
  const tool = (name: string, readOnly: boolean) => {
    const matches = runtime.searchCatalog({ query: name, limit: 100 }).tools.filter((candidate) => {
      const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
      return candidate.upstreamName === name && candidate.annotations?.readOnlyHint === readOnly
        && (!source || candidate.upstreamId === source) && isJsonObject(descriptor)
        && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new PageCorrectionError(`The Canvas connection needed for this ${target.itemLabel} is unavailable.`);
    source = matches[0]!.upstreamId;
    return matches[0]!.publicName;
  };
  const read = async (name: string, args: JsonObject) => {
    try {
      return canvasReadResult(runtime, await runtime.callSourceOwned(tool(name, true), {
        ...args, _morrow: { source_binding_id: input.source_binding_id },
      }, { signal }));
    } catch {
      throw new PageCorrectionError(`Morrow could not read the current Canvas ${target.itemLabel} evidence.`);
    }
  };
  const writeTool = tool(target.writeTool, false);
  const [courseResult, itemResult] = await Promise.all([
    read("canvas_get_single_course_courses", { id: input.course_id }),
    read(target.readTool, target.readArguments(input)),
  ]);
  const course = courseResult.data;
  const item = itemResult.data;
  const body = isJsonObject(item) ? item[target.bodyField] : undefined;
  if (!isJsonObject(course) || exactId(course.id) !== input.course_id || typeof course.name !== "string"
    || !isJsonObject(item) || exactId(item.id) !== target.itemId(input) || typeof body !== "string"
    || (target.requireCourseId === true && exactId(item.course_id) !== input.course_id)) {
    throw new PageCorrectionError(`Morrow could not read the complete current Canvas ${target.itemLabel} source.`);
  }
  return {
    writeTool,
    course,
    item,
    body,
    bodySha256: sha256Text(body),
    protectedStateSha256: protectedContentState(item, target.bodyField),
  };
}

type CurrentNewQuizItem = {
  readonly writeTool: string;
  readonly course: JsonObject;
  readonly quiz: JsonObject;
  readonly item: JsonObject;
  readonly body: string;
  readonly bodySha256: string;
  readonly protectedStateSha256: string;
};

type NewQuizItemIdentity = Readonly<{
  source_binding_id: string;
  course_id: string;
  quiz_id: string;
  item_id: string;
}>;

type NewQuizNestedImageAltInput = z.infer<typeof newQuizChoiceImageAltInputSchema>
  | z.infer<typeof newQuizAnswerFeedbackImageAltInputSchema>
  | z.infer<typeof newQuizFeedbackImageAltInputSchema>;

function itemEntry(item: JsonObject): JsonObject {
  if (item.entry_type !== "Item" || !isJsonObject(item.entry)) {
    throw new PageCorrectionError("Canvas did not return a direct New Quiz question item.");
  }
  return item.entry;
}

function cloneNewQuizItem(item: JsonObject): JsonObject {
  return structuredClone(item);
}

function protectedNewQuizItemState(item: JsonObject, remove: (entry: JsonObject) => void = (entry) => { delete entry.item_body; }): string {
  const state = cloneNewQuizItem(item);
  const entry = itemEntry(state);
  delete state.updated_at;
  delete entry.updated_at;
  remove(entry);
  return sha256Json(state);
}

function choiceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new PageCorrectionError("Canvas did not return an exact New Quiz answer identifier.");
  }
  return value;
}

function directNewQuizChoices(entry: JsonObject, expectedChoiceId: string): readonly JsonObject[] {
  if (!["choice", "multi-answer", "ordering"].includes(String(entry.interaction_type_slug))
    || !isJsonObject(entry.interaction_data) || !Array.isArray(entry.interaction_data.choices)) {
    throw new PageCorrectionError("This New Quiz item does not expose a supported direct answer-choice source.");
  }
  const choices = entry.interaction_data.choices;
  if (!choices.length || choices.some((choice) => !isJsonObject(choice) || choiceId(choice.id) === "" || typeof choice.item_body !== "string")) {
    throw new PageCorrectionError("Canvas did not return the complete New Quiz answer-choice state needed for this repair.");
  }
  const ids = choices.map((choice) => choiceId((choice as JsonObject).id));
  if (new Set(ids).size !== ids.length || !ids.includes(expectedChoiceId)) {
    throw new PageCorrectionError("The selected New Quiz answer choice is unavailable or ambiguous.");
  }
  return choices as JsonObject[];
}

function newQuizChoiceBody(item: JsonObject, choice: string): { readonly body: string; readonly protectedStateSha256: string } {
  const entry = itemEntry(item);
  const selected = directNewQuizChoices(entry, choice).find((candidate) => candidate.id === choice);
  if (!selected || typeof selected.item_body !== "string") throw new PageCorrectionError("The selected New Quiz answer choice is unavailable.");
  return {
    body: selected.item_body,
    protectedStateSha256: protectedNewQuizItemState(item, (protectedEntry) => {
      const interaction = protectedEntry.interaction_data;
      const choices = isJsonObject(interaction) ? interaction.choices : undefined;
      if (!Array.isArray(choices)) throw new PageCorrectionError("Canvas did not return the complete New Quiz answer-choice state needed for this repair.");
      const index = choices.findIndex((candidate) => isJsonObject(candidate) && candidate.id === choice);
      if (index < 0 || !isJsonObject(choices[index])) throw new PageCorrectionError("The selected New Quiz answer choice is unavailable.");
      const protectedChoices = [...choices];
      protectedChoices[index] = { ...protectedChoices[index] as JsonObject };
      delete (protectedChoices[index] as JsonObject).item_body;
      (interaction as JsonObject).choices = protectedChoices;
    }),
  };
}

function newQuizAnswerFeedbackBody(item: JsonObject, choice: string): { readonly body: string; readonly protectedStateSha256: string } {
  const entry = itemEntry(item);
  if (entry.interaction_type_slug !== "choice") {
    throw new PageCorrectionError("Canvas supports answer feedback only for direct New Quiz choice questions.");
  }
  directNewQuizChoices(entry, choice);
  if (!isJsonObject(entry.answer_feedback) || Object.entries(entry.answer_feedback).some(([id, value]) => choiceId(id) === "" || typeof value !== "string")
    || typeof entry.answer_feedback[choice] !== "string") {
    throw new PageCorrectionError("Canvas did not return the complete New Quiz answer-feedback state needed for this repair.");
  }
  return {
    body: entry.answer_feedback[choice] as string,
    protectedStateSha256: protectedNewQuizItemState(item, (protectedEntry) => {
      if (!isJsonObject(protectedEntry.answer_feedback)) throw new PageCorrectionError("Canvas did not return the complete New Quiz answer-feedback state needed for this repair.");
      protectedEntry.answer_feedback = { ...protectedEntry.answer_feedback };
      delete (protectedEntry.answer_feedback as JsonObject)[choice];
    }),
  };
}

function newQuizFeedbackBody(item: JsonObject, feedbackType: "correct" | "incorrect" | "neutral"): { readonly body: string; readonly protectedStateSha256: string } {
  const entry = itemEntry(item);
  if (!isJsonObject(entry.feedback) || typeof entry.feedback[feedbackType] !== "string") {
    throw new PageCorrectionError("Canvas did not return the selected New Quiz feedback source.");
  }
  return {
    body: entry.feedback[feedbackType] as string,
    protectedStateSha256: protectedNewQuizItemState(item, (protectedEntry) => {
      if (!isJsonObject(protectedEntry.feedback)) throw new PageCorrectionError("Canvas did not return the selected New Quiz feedback source.");
      protectedEntry.feedback = { ...protectedEntry.feedback };
      delete (protectedEntry.feedback as JsonObject)[feedbackType];
    }),
  };
}

async function currentNewQuizItem(
  runtime: GatewayRuntime,
  input: NewQuizItemIdentity,
  signal: AbortSignal,
): Promise<CurrentNewQuizItem> {
  let source: string | undefined;
  const tool = (name: string, readOnly: boolean) => {
    const matches = runtime.searchCatalog({ query: name, limit: 100 }).tools.filter((candidate) => {
      const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
      return candidate.upstreamName === name && candidate.annotations?.readOnlyHint === readOnly
        && (!source || candidate.upstreamId === source) && isJsonObject(descriptor)
        && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new PageCorrectionError("The Canvas connection needed for this New Quiz item is unavailable.");
    source = matches[0]!.upstreamId;
    return matches[0]!.publicName;
  };
  const read = async (name: string, args: JsonObject) => {
    try {
      return canvasReadResult(runtime, await runtime.callSourceOwned(tool(name, true), {
        ...args, _morrow: { source_binding_id: input.source_binding_id },
      }, { signal }));
    } catch {
      throw new PageCorrectionError("Morrow could not read the current Canvas New Quiz item evidence.");
    }
  };
  const writeTool = tool("canvas_update_quiz_item", false);
  const quizArgs = { course_id: input.course_id, assignment_id: input.quiz_id };
  const [courseResult, quizResult, itemResult] = await Promise.all([
    read("canvas_get_single_course_courses", { id: input.course_id }),
    read("canvas_get_new_quiz", quizArgs),
    read("canvas_get_quiz_item", { ...quizArgs, item_id: input.item_id }),
  ]);
  const course = courseResult.data;
  const quiz = quizResult.data;
  const item = itemResult.data;
  const entry = isJsonObject(item) ? item.entry : undefined;
  const body = isJsonObject(entry) ? entry.item_body : undefined;
  if (!isJsonObject(course) || exactId(course.id) !== input.course_id || typeof course.name !== "string"
    || !isJsonObject(quiz) || exactId(quiz.id) !== input.quiz_id
    || (quiz.course_id !== undefined && exactId(quiz.course_id) !== input.course_id)
    || !isJsonObject(item) || exactId(item.id) !== input.item_id || item.entry_type !== "Item"
    || !isJsonObject(entry) || typeof body !== "string") {
    throw new PageCorrectionError("Morrow could not read the complete current Canvas New Quiz item source.");
  }
  return {
    writeTool,
    course,
    quiz,
    item,
    body,
    bodySha256: sha256Text(body),
    protectedStateSha256: protectedNewQuizItemState(item),
  };
}

type CurrentClassicQuizQuestion = {
  readonly writeTool: string;
  readonly course: JsonObject;
  readonly question: JsonObject;
};

async function currentClassicQuizQuestion(
  runtime: GatewayRuntime,
  input: Readonly<{ source_binding_id: string; course_id: string; quiz_id: string; question_id: string }>,
  signal: AbortSignal,
): Promise<CurrentClassicQuizQuestion> {
  let source: string | undefined;
  const tool = (name: string, readOnly: boolean) => {
    const matches = runtime.searchCatalog({ query: name, limit: 100 }).tools.filter((candidate) => {
      const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
      return candidate.upstreamName === name && candidate.annotations?.readOnlyHint === readOnly
        && (!source || candidate.upstreamId === source) && isJsonObject(descriptor)
        && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new PageCorrectionError("The Canvas connection needed for this Classic Quiz question is unavailable.");
    source = matches[0]!.upstreamId;
    return matches[0]!.publicName;
  };
  const read = async (name: string, args: JsonObject) => {
    try {
      return canvasReadResult(runtime, await runtime.callSourceOwned(tool(name, true), {
        ...args, _morrow: { source_binding_id: input.source_binding_id },
      }, { signal }));
    } catch {
      throw new PageCorrectionError("Morrow could not read the current Canvas Classic Quiz question evidence.");
    }
  };
  const writeTool = tool("canvas_update_existing_quiz_question", false);
  const [courseResult, questionResult] = await Promise.all([
    read("canvas_get_single_course_courses", { id: input.course_id }),
    read("canvas_get_single_quiz_question", { course_id: input.course_id, quiz_id: input.quiz_id, id: input.question_id }),
  ]);
  const course = courseResult.data;
  const question = questionResult.data;
  if (!isJsonObject(course) || exactId(course.id) !== input.course_id || typeof course.name !== "string"
    || !isJsonObject(question) || exactId(question.id) !== input.question_id || exactId(question.quiz_id) !== input.quiz_id) {
    throw new PageCorrectionError("Morrow could not read the complete current Canvas Classic Quiz question source.");
  }
  return { writeTool, course, question };
}

function noPlan(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `No change was planned. ${error instanceof PageCorrectionError ? error.message : "Morrow could not finish the Canvas content check. Check the Canvas connection and try again."}` }],
    structuredContent: { schema: "morrow.problem.v1", code: "page_correction_not_planned" },
  };
}

export async function planPageCorrection(runtime: GatewayRuntime, value: z.infer<typeof textInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  const input = textInputSchema.parse(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    if (input.find_text === input.replace_text) throw new PageCorrectionError("The replacement is the same as the current text.");
    const current = await currentPage(runtime, input, signal);
    const body = String(current.page.body);
    checkAnchor(body, input.find_text);
    signal.throwIfAborted();
    const guard = {
      kind: "page_text",
      course_id: input.course_id,
      page_id: exactId(current.page.page_id),
      revision_id: exactId(current.revision.revision_id),
      body_sha256: current.bodySha256,
      fields: current.fields,
      find_text: input.find_text,
      replace_text: input.replace_text,
    };
    const planned = await runtime.planOperationWithCurrentEditPermission(current.writeTool, {
      course_id: input.course_id,
      url_or_id: current.page.url,
      _morrow: { source_binding_id: input.source_binding_id, canvas_content_guard: guard },
    });
    if (planned.isError === true) return planned as unknown as CallToolResult;
    const editAuthorized = isJsonObject(planned.structuredContent) && planned.structuredContent.effectState === "approved";
    return {
      ...planned,
      content: [{ type: "text", text: `${editAuthorized ? "Morrow prepared" : "Review"} this text change in ${String(current.page.title)} (${String(current.course.name)}).\n\nCurrent text: ${input.find_text}\nReplacement: ${input.replace_text || "Remove this text"}\n\nNo change has been sent. ${editAuthorized ? "Your current extension Edit permission covers this phrase only." : "The review covers this phrase only."} The bridge will keep the other page content and settings, check the page again before sending, and check the saved page and revision history afterward. Canvas does not lock the page during these checks. If another edit is detected, Morrow will stop or report that it could not confirm the result.` }],
    } as CallToolResult;
  } catch (error) {
    return noPlan(error);
  }
}

export async function planPageImageAltRepair(runtime: GatewayRuntime, value: z.infer<typeof imageAltInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  const input = imageAltInputSchema.parse(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const current = await currentPage(runtime, input, signal);
    if (input.expected_body_sha256 !== current.bodySha256) {
      throw new PageCorrectionError("The Page body changed since this accessibility signal. Run the audit again before planning a repair.");
    }
    const evidence = pageMissingAltEvidence(String(current.page.body)).find((candidate) => (
      candidate.imageIndex === input.image_index && candidate.imageSrcSha256 === input.image_src_sha256
    ));
    if (!evidence) {
      throw new PageCorrectionError("The selected missing-alt image is no longer present at this Page position. Run the audit again before planning a repair.");
    }
    signal.throwIfAborted();
    const guard = {
      kind: "page_image_alt",
      course_id: input.course_id,
      page_id: exactId(current.page.page_id),
      revision_id: exactId(current.revision.revision_id),
      body_sha256: current.bodySha256,
      fields: current.fields,
      image_index: evidence.imageIndex,
      image_start: evidence.imageStart,
      image_end: evidence.imageEnd,
      image_tag_sha256: evidence.imageTagSha256,
      image_src_sha256: evidence.imageSrcSha256,
      alt_text: input.alt_text,
      decorative: input.decorative,
    };
    const planned = await runtime.planOperationWithCurrentEditPermission(current.writeTool, {
      course_id: input.course_id,
      url_or_id: current.page.url,
      _morrow: { source_binding_id: input.source_binding_id, canvas_content_guard: guard },
    });
    if (planned.isError === true) return planned as unknown as CallToolResult;
    const editAuthorized = isJsonObject(planned.structuredContent) && planned.structuredContent.effectState === "approved";
    return {
      ...planned,
      content: [{ type: "text", text: `${editAuthorized ? "Morrow prepared" : "Review"} an alternative-text repair for image ${input.image_index} in ${String(current.page.title)} (${String(current.course.name)}).\n\nAlternative text: ${input.decorative ? "Decorative image (empty alternative text)" : input.alt_text}\n\nNo change has been sent. ${editAuthorized ? "Your current extension Edit permission covers this image repair only." : "The review covers this image repair only."} The bridge will read the Page again before sending, change only the selected image alternative-text attribute, preserve the other Page content and settings, and then check the saved Page and revision history. Canvas does not lock the Page during these checks.` }],
    } as CallToolResult;
  } catch (error) {
    return noPlan(error);
  }
}

type CanvasContentImageAltInput = z.infer<typeof assignmentImageAltInputSchema>
  | z.infer<typeof discussionImageAltInputSchema>
  | z.infer<typeof classicQuizDescriptionImageAltInputSchema>;

type CanvasContentImageAltTarget = CanvasContentItemTarget & {
  readonly kind: "assignment_image_alt" | "discussion_image_alt" | "classic_quiz_description_image_alt";
  readonly guardItemId: "assignment_id" | "topic_id" | "quiz_id";
};

const assignmentImageAltTarget: CanvasContentImageAltTarget = {
  kind: "assignment_image_alt",
  guardItemId: "assignment_id",
  itemLabel: "Assignment",
  readTool: "canvas_get_single_assignment",
  writeTool: "canvas_edit_assignment",
  readArguments: (input) => ({ course_id: input.course_id, id: exactId((input as z.infer<typeof assignmentImageAltInputSchema>).assignment_id) }),
  writeArguments: (input, guard) => ({
    course_id: input.course_id,
    id: exactId((input as z.infer<typeof assignmentImageAltInputSchema>).assignment_id),
    _morrow: { source_binding_id: input.source_binding_id, canvas_content_guard: guard },
  }),
  bodyField: "description",
  itemId: (input) => exactId((input as z.infer<typeof assignmentImageAltInputSchema>).assignment_id),
};

const discussionImageAltTarget: CanvasContentImageAltTarget = {
  kind: "discussion_image_alt",
  guardItemId: "topic_id",
  itemLabel: "Discussion",
  readTool: "canvas_get_single_topic_courses",
  writeTool: "canvas_update_topic_courses",
  readArguments: (input) => ({ course_id: input.course_id, topic_id: exactId((input as z.infer<typeof discussionImageAltInputSchema>).topic_id) }),
  writeArguments: (input, guard) => ({
    course_id: input.course_id,
    topic_id: exactId((input as z.infer<typeof discussionImageAltInputSchema>).topic_id),
    _morrow: { source_binding_id: input.source_binding_id, canvas_content_guard: guard },
  }),
  bodyField: "message",
  itemId: (input) => exactId((input as z.infer<typeof discussionImageAltInputSchema>).topic_id),
};

const classicQuizDescriptionImageAltTarget: CanvasContentImageAltTarget = {
  kind: "classic_quiz_description_image_alt",
  guardItemId: "quiz_id",
  itemLabel: "Classic Quiz",
  readTool: "canvas_get_single_quiz",
  writeTool: "canvas_edit_quiz",
  readArguments: (input) => ({ course_id: input.course_id, id: exactId((input as z.infer<typeof classicQuizDescriptionImageAltInputSchema>).quiz_id) }),
  writeArguments: (input, guard) => ({
    course_id: input.course_id,
    id: exactId((input as z.infer<typeof classicQuizDescriptionImageAltInputSchema>).quiz_id),
    _morrow: { source_binding_id: input.source_binding_id, canvas_content_guard: guard },
  }),
  bodyField: "description",
  itemId: (input) => exactId((input as z.infer<typeof classicQuizDescriptionImageAltInputSchema>).quiz_id),
  requireCourseId: true,
};

async function planCanvasContentImageAltRepair(
  runtime: GatewayRuntime,
  input: CanvasContentImageAltInput,
  target: CanvasContentImageAltTarget,
  callerSignal?: AbortSignal,
): Promise<CallToolResult> {
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const current = await currentCanvasContentItem(runtime, input, target, signal);
    if (input.expected_body_sha256 !== current.bodySha256) {
      throw new PageCorrectionError(`The ${target.itemLabel} source changed since this accessibility signal. Run the audit again before planning a repair.`);
    }
    const evidence = canvasContentMissingAltEvidence(current.body).find((candidate) => (
      candidate.imageIndex === input.image_index && candidate.imageSrcSha256 === input.image_src_sha256
    ));
    if (!evidence) {
      throw new PageCorrectionError(`The selected missing-alt image is no longer present in this ${target.itemLabel}. Run the audit again before planning a repair.`);
    }
    const guard = {
      kind: target.kind,
      course_id: input.course_id,
      [target.guardItemId]: target.itemId(input),
      body_sha256: current.bodySha256,
      protected_state_sha256: current.protectedStateSha256,
      image_index: evidence.imageIndex,
      image_start: evidence.imageStart,
      image_end: evidence.imageEnd,
      image_tag_sha256: evidence.imageTagSha256,
      image_src_sha256: evidence.imageSrcSha256,
      alt_text: input.alt_text,
      decorative: input.decorative,
    } as JsonObject;
    signal.throwIfAborted();
    const planned = await runtime.planOperationWithCurrentEditPermission(target.writeTool, target.writeArguments(input, guard));
    if (planned.isError === true) return planned as unknown as CallToolResult;
    const editAuthorized = isJsonObject(planned.structuredContent) && planned.structuredContent.effectState === "approved";
    const itemTitle = typeof current.item.name === "string" ? current.item.name
      : typeof current.item.title === "string" ? current.item.title : target.itemLabel;
    return {
      ...planned,
      content: [{ type: "text", text: `${editAuthorized ? "Morrow prepared" : "Review"} an alternative-text repair for image ${input.image_index} in ${itemTitle} (${String(current.course.name)}).\n\nAlternative text: ${input.decorative ? "Decorative image (empty alternative text)" : input.alt_text}\n\nNo change has been sent. ${editAuthorized ? "Your current extension Edit permission covers this image repair only." : "The review covers this image repair only."} The bridge will read the current Canvas ${target.itemLabel} again before sending, change only the selected image alternative-text attribute, preserve the other saved content and settings, and then compare the saved Canvas record afterward. Canvas does not lock the ${target.itemLabel} during these checks.` }],
    } as CallToolResult;
  } catch (error) {
    return noPlan(error);
  }
}

export async function planAssignmentImageAltRepair(runtime: GatewayRuntime, value: z.infer<typeof assignmentImageAltInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  return await planCanvasContentImageAltRepair(runtime, assignmentImageAltInputSchema.parse(value), assignmentImageAltTarget, callerSignal);
}

export async function planDiscussionImageAltRepair(runtime: GatewayRuntime, value: z.infer<typeof discussionImageAltInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  return await planCanvasContentImageAltRepair(runtime, discussionImageAltInputSchema.parse(value), discussionImageAltTarget, callerSignal);
}

export async function planClassicQuizDescriptionImageAltRepair(runtime: GatewayRuntime, value: z.infer<typeof classicQuizDescriptionImageAltInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  return await planCanvasContentImageAltRepair(runtime, classicQuizDescriptionImageAltInputSchema.parse(value), classicQuizDescriptionImageAltTarget, callerSignal);
}

// Canvas rebuilds a Classic Quiz question from the whole request through
// AssessmentQuestion.parse_question, so a field left out of the request is
// rebuilt from a default rather than preserved. This planner therefore refuses
// the same cases the connector refuses at write time: a question in a question
// group, a question type whose payload cannot be rebuilt, an incomplete read,
// and a read that carries state the write cannot resend. The contract lives in
// connector/extension/src/canvas-content.js; this copy exists so a person is
// told before an approval is requested, not after. The round trip itself is
// live-unverified against a connected Canvas tenant.
const CLASSIC_QUIZ_QUESTION_TYPES = ["multiple_choice_question", "true_false_question", "multiple_answers_question", "short_answer_question", "essay_question"];
const CLASSIC_QUIZ_ANSWERLESS_QUESTION_TYPES = ["essay_question"];
const CLASSIC_QUIZ_QUESTION_TEXT_FIELDS = ["question_name", "question_text", "correct_comments", "incorrect_comments", "neutral_comments"];
const CLASSIC_QUIZ_QUESTION_DERIVED_FIELDS = ["id", "quiz_id", "quiz_group_id", "assessment_question_id", "correct_comments_html", "incorrect_comments_html", "neutral_comments_html"];
const CLASSIC_QUIZ_QUESTION_SENT_FIELDS = ["question_type", "points_possible", "position", "text_after_answers", "answers"];
const CLASSIC_QUIZ_ANSWER_FIELDS = ["id", "answer_text", "answer_weight", "answer_comments", "answer_html", "text_after_answers"];
const CLASSIC_QUIZ_ANSWER_DERIVED_FIELDS = ["answer_comment_html"];

/** A field name Canvas returned is untrusted text, so a refusal repeats it only when it is a plain identifier. */
function reportableFieldName(name: string): string {
  return /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : "an unexpected field";
}

function checkClassicQuizQuestion(question: JsonObject): void {
  if (question.quiz_group_id !== undefined && question.quiz_group_id !== null) {
    throw new PageCorrectionError("This question belongs to a question group, so Canvas can rebuild it from a question bank and a change here could reach other quizzes. Morrow does not repair it.");
  }
  if (typeof question.question_type !== "string" || !CLASSIC_QUIZ_QUESTION_TYPES.includes(question.question_type)) {
    throw new PageCorrectionError("Morrow repairs images only in multiple choice, true or false, multiple answers, short answer, and essay Classic Quiz questions.");
  }
  const unmodelled = Object.keys(question).find((field) => !CLASSIC_QUIZ_QUESTION_TEXT_FIELDS.includes(field)
    && !CLASSIC_QUIZ_QUESTION_DERIVED_FIELDS.includes(field) && !CLASSIC_QUIZ_QUESTION_SENT_FIELDS.includes(field));
  if (unmodelled) {
    throw new PageCorrectionError(`Canvas returned ${reportableFieldName(unmodelled)} for this question, and this repair cannot send it back.`);
  }
  for (const field of CLASSIC_QUIZ_QUESTION_TEXT_FIELDS) {
    if (typeof question[field] !== "string") {
      throw new PageCorrectionError(`Canvas did not return ${field} for this question, and Morrow will not rebuild a question without it.`);
    }
  }
  if (typeof question.points_possible !== "number" && typeof question.points_possible !== "string") {
    throw new PageCorrectionError("Canvas did not return points_possible for this question, and Morrow will not rebuild a question without it.");
  }
  if (typeof question.position !== "number" || !Number.isSafeInteger(question.position) || question.position < 1) {
    throw new PageCorrectionError("Canvas did not return position for this question, and Morrow will not rebuild a question without it.");
  }
  if (Object.hasOwn(question, "text_after_answers") && typeof question.text_after_answers !== "string") {
    throw new PageCorrectionError("Canvas returned text_after_answers for this question in a form Morrow cannot send back.");
  }
  const answerless = CLASSIC_QUIZ_ANSWERLESS_QUESTION_TYPES.includes(String(question.question_type));
  const answers = question.answers;
  if (answerless) {
    if (answers !== undefined && (!Array.isArray(answers) || answers.length > 0)) {
      throw new PageCorrectionError("Canvas returned answers for this essay question, and this repair cannot send them back.");
    }
    return;
  }
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 100) {
    throw new PageCorrectionError("Canvas did not return the answers for this question, and Morrow will not rebuild a question without them.");
  }
  const ids = new Set<string>();
  for (const answer of answers) {
    if (!isJsonObject(answer)) throw new PageCorrectionError("Canvas did not return one of this question's answers as a record.");
    const unmodelledAnswer = Object.keys(answer).find((field) => !CLASSIC_QUIZ_ANSWER_FIELDS.includes(field) && !CLASSIC_QUIZ_ANSWER_DERIVED_FIELDS.includes(field));
    if (unmodelledAnswer) {
      throw new PageCorrectionError(`Canvas returned ${reportableFieldName(unmodelledAnswer)} on an answer of this question, and this repair cannot send it back.`);
    }
    const id = exactId(answer.id);
    if (ids.has(id)) throw new PageCorrectionError("Canvas returned two answers with the same identifier for this question.");
    ids.add(id);
    if (typeof answer.answer_text !== "string" || typeof answer.answer_weight !== "number"
      || !Number.isInteger(answer.answer_weight) || answer.answer_weight < 0 || answer.answer_weight > 100) {
      throw new PageCorrectionError("Canvas did not return answer_text and answer_weight for every answer of this question.");
    }
    for (const field of ["answer_comments", "answer_html", "text_after_answers"]) {
      if (Object.hasOwn(answer, field) && typeof answer[field] !== "string") {
        throw new PageCorrectionError(`Canvas returned ${field} on an answer of this question in a form Morrow cannot send back.`);
      }
    }
  }
}

type ClassicQuizQuestionImageAltInput = z.infer<typeof classicQuizQuestionImageAltInputSchema>;

function classicQuizQuestionSource(question: JsonObject, input: ClassicQuizQuestionImageAltInput): { readonly body: string; readonly protectedStateSha256: string } {
  checkClassicQuizQuestion(question);
  const state = structuredClone(question);
  delete state.updated_at;
  if (input.answer_id === undefined || input.answer_field === undefined) {
    const body = question.question_text;
    if (typeof body !== "string") throw new PageCorrectionError("Canvas did not return the question text for this question.");
    delete state.question_text;
    return { body, protectedStateSha256: sha256Json(state) };
  }
  const answers = Array.isArray(question.answers) ? question.answers : [];
  const selected = answers.filter((answer) => isJsonObject(answer) && exactId(answer.id) === input.answer_id);
  if (selected.length !== 1) throw new PageCorrectionError("The selected answer is not one exact answer of this question.");
  const body = (selected[0] as JsonObject)[input.answer_field];
  if (typeof body !== "string") throw new PageCorrectionError("Canvas did not return the selected answer field of this question.");
  const stateAnswers = Array.isArray(state.answers) ? state.answers : [];
  const stateSelected = stateAnswers.filter((answer) => isJsonObject(answer) && exactId(answer.id) === input.answer_id);
  delete (stateSelected[0] as JsonObject)[input.answer_field];
  return { body, protectedStateSha256: sha256Json(state) };
}

export async function planClassicQuizQuestionImageAltRepair(
  runtime: GatewayRuntime,
  value: z.infer<typeof classicQuizQuestionImageAltInputSchema>,
  callerSignal?: AbortSignal,
): Promise<CallToolResult> {
  const input = classicQuizQuestionImageAltInputSchema.parse(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const current = await currentClassicQuizQuestion(runtime, input, signal);
    const source = classicQuizQuestionSource(current.question, input);
    if (input.expected_body_sha256 !== sha256Text(source.body)) {
      throw new PageCorrectionError("The selected Classic Quiz question source changed since this accessibility signal. Run the audit again before planning a repair.");
    }
    const evidence = canvasContentMissingAltEvidence(source.body).find((candidate) => (
      candidate.imageIndex === input.image_index && candidate.imageSrcSha256 === input.image_src_sha256
    ));
    if (!evidence) {
      throw new PageCorrectionError("The selected missing-alt image is no longer present in this Classic Quiz question. Run the audit again before planning a repair.");
    }
    const guard = {
      kind: "classic_quiz_question_image_alt",
      course_id: input.course_id,
      quiz_id: input.quiz_id,
      question_id: input.question_id,
      ...(input.answer_id !== undefined && input.answer_field !== undefined ? { answer_id: input.answer_id, answer_field: input.answer_field } : {}),
      body_sha256: sha256Text(source.body),
      protected_state_sha256: source.protectedStateSha256,
      image_index: evidence.imageIndex,
      image_start: evidence.imageStart,
      image_end: evidence.imageEnd,
      image_tag_sha256: evidence.imageTagSha256,
      image_src_sha256: evidence.imageSrcSha256,
      alt_text: input.alt_text,
      decorative: input.decorative,
    } as JsonObject;
    signal.throwIfAborted();
    const planned = await runtime.planOperationWithCurrentEditPermission(current.writeTool, {
      course_id: input.course_id,
      quiz_id: input.quiz_id,
      id: input.question_id,
      _morrow: { source_binding_id: input.source_binding_id, canvas_content_guard: guard },
    });
    if (planned.isError === true) return planned as unknown as CallToolResult;
    const editAuthorized = isJsonObject(planned.structuredContent) && planned.structuredContent.effectState === "approved";
    const questionTitle = typeof current.question.question_name === "string" ? current.question.question_name : "Classic Quiz question";
    const place = input.answer_id === undefined ? "the question text" : "one answer";
    return {
      ...planned,
      content: [{ type: "text", text: `${editAuthorized ? "Morrow prepared" : "Review"} an alternative-text repair for image ${input.image_index} in ${place} of ${questionTitle} (${String(current.course.name)}).

Alternative text: ${input.decorative ? "Decorative image (empty alternative text)" : input.alt_text}

No change has been sent. ${editAuthorized ? "Your current extension Edit permission covers this image repair only." : "The review covers this image repair only."} Canvas rebuilds a Classic Quiz question from the whole request, so the bridge will read this question again before sending, resend every field that read returned, change only the selected image alternative-text attribute, and then compare the saved question afterward. It refuses a question in a question group, an unsupported question type, and a read that does not carry a complete question. Canvas does not lock the question during these checks, and this repair is not yet proven against a live Canvas tenant.` }],
    } as CallToolResult;
  } catch (error) {
    return noPlan(error);
  }
}

export async function planNewQuizItemImageAltRepair(runtime: GatewayRuntime, value: z.infer<typeof newQuizItemImageAltInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  const input = newQuizItemImageAltInputSchema.parse(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const current = await currentNewQuizItem(runtime, input, signal);
    if (input.expected_body_sha256 !== current.bodySha256) {
      throw new PageCorrectionError("The New Quiz item body changed since this accessibility signal. Run the audit again before planning a repair.");
    }
    const evidence = canvasContentMissingAltEvidence(current.body).find((candidate) => (
      candidate.imageIndex === input.image_index && candidate.imageSrcSha256 === input.image_src_sha256
    ));
    if (!evidence) {
      throw new PageCorrectionError("The selected missing-alt image is no longer present in this New Quiz item. Run the audit again before planning a repair.");
    }
    const guard = {
      kind: "new_quiz_item_image_alt",
      course_id: input.course_id,
      assignment_id: input.quiz_id,
      item_id: input.item_id,
      body_sha256: current.bodySha256,
      protected_state_sha256: current.protectedStateSha256,
      image_index: evidence.imageIndex,
      image_start: evidence.imageStart,
      image_end: evidence.imageEnd,
      image_tag_sha256: evidence.imageTagSha256,
      image_src_sha256: evidence.imageSrcSha256,
      alt_text: input.alt_text,
      decorative: input.decorative,
    } as JsonObject;
    signal.throwIfAborted();
    const planned = await runtime.planOperationWithCurrentEditPermission(current.writeTool, {
      course_id: input.course_id,
      assignment_id: input.quiz_id,
      item_id: input.item_id,
      _morrow: { source_binding_id: input.source_binding_id, canvas_content_guard: guard },
    });
    if (planned.isError === true) return planned as unknown as CallToolResult;
    const editAuthorized = isJsonObject(planned.structuredContent) && planned.structuredContent.effectState === "approved";
    const entry = isJsonObject(current.item.entry) ? current.item.entry : undefined;
    const itemTitle = typeof entry?.title === "string" ? entry.title : "New Quiz item";
    return {
      ...planned,
      content: [{ type: "text", text: `${editAuthorized ? "Morrow prepared" : "Review"} an alternative-text repair for image ${input.image_index} in ${itemTitle} (${String(current.quiz.title ?? "New Quiz")}, ${String(current.course.name)}).\n\nAlternative text: ${input.decorative ? "Decorative image (empty alternative text)" : input.alt_text}\n\nNo change has been sent. ${editAuthorized ? "Your current extension Edit permission covers this image repair only." : "The review covers this image repair only."} The bridge will read the current New Quiz item again before sending, change only the selected image alternative-text attribute in the item body, preserve the item ID, answers, scoring, position, and other settings, and then compare the saved item afterward. Canvas does not lock the item during these checks.` }],
    } as CallToolResult;
  } catch (error) {
    return noPlan(error);
  }
}

type NewQuizNestedImageAltTarget = Readonly<{
  kind: "new_quiz_choice_image_alt" | "new_quiz_answer_feedback_image_alt" | "new_quiz_feedback_image_alt";
  label: string;
  targetBody: (item: JsonObject, input: NewQuizNestedImageAltInput) => { readonly body: string; readonly protectedStateSha256: string };
  guardSelector: (input: NewQuizNestedImageAltInput) => JsonObject;
}>;

const newQuizChoiceImageAltTarget: NewQuizNestedImageAltTarget = {
  kind: "new_quiz_choice_image_alt",
  label: "answer choice",
  targetBody: (item, input) => newQuizChoiceBody(item, (input as z.infer<typeof newQuizChoiceImageAltInputSchema>).choice_id),
  guardSelector: (input) => ({ choice_id: (input as z.infer<typeof newQuizChoiceImageAltInputSchema>).choice_id }),
};

const newQuizAnswerFeedbackImageAltTarget: NewQuizNestedImageAltTarget = {
  kind: "new_quiz_answer_feedback_image_alt",
  label: "answer feedback",
  targetBody: (item, input) => newQuizAnswerFeedbackBody(item, (input as z.infer<typeof newQuizAnswerFeedbackImageAltInputSchema>).choice_id),
  guardSelector: (input) => ({ choice_id: (input as z.infer<typeof newQuizAnswerFeedbackImageAltInputSchema>).choice_id }),
};

const newQuizFeedbackImageAltTarget: NewQuizNestedImageAltTarget = {
  kind: "new_quiz_feedback_image_alt",
  label: "question feedback",
  targetBody: (item, input) => newQuizFeedbackBody(item, (input as z.infer<typeof newQuizFeedbackImageAltInputSchema>).feedback_type),
  guardSelector: (input) => ({ feedback_type: (input as z.infer<typeof newQuizFeedbackImageAltInputSchema>).feedback_type }),
};

async function planNewQuizNestedImageAltRepair(
  runtime: GatewayRuntime,
  input: NewQuizNestedImageAltInput,
  target: NewQuizNestedImageAltTarget,
  callerSignal?: AbortSignal,
): Promise<CallToolResult> {
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const current = await currentNewQuizItem(runtime, input, signal);
    const source = target.targetBody(current.item, input);
    if (input.expected_body_sha256 !== sha256Text(source.body)) {
      throw new PageCorrectionError(`The selected New Quiz ${target.label} changed since this accessibility signal. Run the audit again before planning a repair.`);
    }
    const evidence = canvasContentMissingAltEvidence(source.body).find((candidate) => (
      candidate.imageIndex === input.image_index && candidate.imageSrcSha256 === input.image_src_sha256
    ));
    if (!evidence) {
      throw new PageCorrectionError(`The selected missing-alt image is no longer present in this New Quiz ${target.label}. Run the audit again before planning a repair.`);
    }
    const guard = {
      kind: target.kind,
      course_id: input.course_id,
      assignment_id: input.quiz_id,
      item_id: input.item_id,
      ...target.guardSelector(input),
      body_sha256: sha256Text(source.body),
      protected_state_sha256: source.protectedStateSha256,
      image_index: evidence.imageIndex,
      image_start: evidence.imageStart,
      image_end: evidence.imageEnd,
      image_tag_sha256: evidence.imageTagSha256,
      image_src_sha256: evidence.imageSrcSha256,
      alt_text: input.alt_text,
      decorative: input.decorative,
    } as JsonObject;
    signal.throwIfAborted();
    const planned = await runtime.planOperationWithCurrentEditPermission(current.writeTool, {
      course_id: input.course_id,
      assignment_id: input.quiz_id,
      item_id: input.item_id,
      _morrow: { source_binding_id: input.source_binding_id, canvas_content_guard: guard },
    });
    if (planned.isError === true) return planned as unknown as CallToolResult;
    const editAuthorized = isJsonObject(planned.structuredContent) && planned.structuredContent.effectState === "approved";
    const entry = itemEntry(current.item);
    const itemTitle = typeof entry.title === "string" ? entry.title : "New Quiz item";
    return {
      ...planned,
      content: [{ type: "text", text: `${editAuthorized ? "Morrow prepared" : "Review"} an alternative-text repair for image ${input.image_index} in the ${target.label} of ${itemTitle} (${String(current.quiz.title ?? "New Quiz")}, ${String(current.course.name)}).\n\nAlternative text: ${input.decorative ? "Decorative image (empty alternative text)" : input.alt_text}\n\nNo change has been sent. ${editAuthorized ? "Your current extension Edit permission covers this image repair only." : "The review covers this image repair only."} The bridge will read the current New Quiz item again before sending, change only the selected image alternative-text attribute, preserve the item ID, all other response data, scoring, feedback, position, and settings, and then compare the saved item afterward. Canvas does not lock the item during these checks.` }],
    } as CallToolResult;
  } catch (error) {
    return noPlan(error);
  }
}

export async function planNewQuizChoiceImageAltRepair(runtime: GatewayRuntime, value: z.infer<typeof newQuizChoiceImageAltInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  return await planNewQuizNestedImageAltRepair(runtime, newQuizChoiceImageAltInputSchema.parse(value), newQuizChoiceImageAltTarget, callerSignal);
}

export async function planNewQuizAnswerFeedbackImageAltRepair(runtime: GatewayRuntime, value: z.infer<typeof newQuizAnswerFeedbackImageAltInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  return await planNewQuizNestedImageAltRepair(runtime, newQuizAnswerFeedbackImageAltInputSchema.parse(value), newQuizAnswerFeedbackImageAltTarget, callerSignal);
}

export async function planNewQuizFeedbackImageAltRepair(runtime: GatewayRuntime, value: z.infer<typeof newQuizFeedbackImageAltInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  return await planNewQuizNestedImageAltRepair(runtime, newQuizFeedbackImageAltInputSchema.parse(value), newQuizFeedbackImageAltTarget, callerSignal);
}

export function registerPageCorrectionTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_plan_page_correction", {
    title: "Review a page text change",
    description: "Plan one exact visible-text replacement on an existing Canvas page. Preserves the other HTML and page settings. Reads and binds the current page and revision, then uses the separate Morrow approval flow. The Chrome bridge checks for stale content before sending and verifies the full page and one new revision afterward. No Canvas write occurs during planning. Does not support block-editor pages or provide an atomic Canvas edit lock.",
    inputSchema: textInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planPageCorrection(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_page_image_alt_repair", {
    title: "Review a Canvas Page image alternative-text repair",
    description: "Plan one alternative-text repair for a missing-alt image on an existing Canvas Page. Requires fresh audit evidence for the current Page body and image source. Preserves the Page body and settings except for one selected image alt attribute. No Canvas write occurs during planning. Does not support block-editor pages or prove accessibility conformance.",
    inputSchema: imageAltInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planPageImageAltRepair(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_assignment_image_alt_repair", {
    title: "Review a Canvas Assignment image alternative-text repair",
    description: "Plan one alternative-text repair for a missing-alt image in an existing Canvas Assignment description. Requires fresh audit evidence for the exact Assignment source. Preserves the saved description and Assignment settings except for one selected image alt attribute. No Canvas write occurs during planning and this does not prove accessibility conformance.",
    inputSchema: assignmentImageAltInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planAssignmentImageAltRepair(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_discussion_image_alt_repair", {
    title: "Review a Canvas Discussion image alternative-text repair",
    description: "Plan one alternative-text repair for a missing-alt image in an existing Canvas Discussion message. Requires fresh audit evidence for the exact Discussion source. Preserves the saved message and Discussion settings except for one selected image alt attribute. No Canvas write occurs during planning and this does not prove accessibility conformance.",
    inputSchema: discussionImageAltInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planDiscussionImageAltRepair(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_classic_quiz_description_image_alt_repair", {
    title: "Review a Canvas Classic Quiz description image alternative-text repair",
    description: "Plan one alternative-text repair for a missing-alt image in an existing Canvas Classic Quiz description. Requires fresh audit evidence for the exact course and quiz. Preserves the saved Classic Quiz description and settings except for one selected image alt attribute. No Canvas write occurs during planning and this does not support quiz questions, answers, assessment banks, or accessibility conformance.",
    inputSchema: classicQuizDescriptionImageAltInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planClassicQuizDescriptionImageAltRepair(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_classic_quiz_question_image_alt_repair", {
    title: "Review a Canvas Classic Quiz question image alternative-text repair",
    description: "Plan one alternative-text repair for a missing-alt image in an existing Canvas Classic Quiz question, either in the question text or in one of its answers. Requires fresh audit evidence for the exact course, quiz, question, and source field. Canvas rebuilds a Classic Quiz question from the whole request, so the bridge reads the question again and resends every field that read returned, changing one selected image alt attribute. Refuses a question in a question group, a question type outside multiple choice, true or false, multiple answers, short answer, and essay, and any read that does not carry a complete question. No Canvas write occurs during planning. This repair is not yet proven against a live Canvas tenant and does not prove accessibility conformance.",
    inputSchema: classicQuizQuestionImageAltInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planClassicQuizQuestionImageAltRepair(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_item_image_alt_repair", {
    title: "Review a New Quiz item image alternative-text repair",
    description: "Plan one alternative-text repair for a missing-alt image in a course-scoped New Quiz item body. Requires fresh audit evidence for the exact course, quiz, item, and item body. Preserves the item ID, question type, answer data, scoring, position, and other item settings except for one selected image alt attribute. No Canvas write occurs during planning and this does not support Stimuli, Item Bank entries, answer choices, feedback, or accessibility conformance.",
    inputSchema: newQuizItemImageAltInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planNewQuizItemImageAltRepair(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_choice_image_alt_repair", {
    title: "Review a New Quiz answer-choice image alternative-text repair",
    description: "Plan one alternative-text repair for a missing-alt image in one direct New Quiz choice or ordering answer. Requires fresh audit evidence for the exact course, quiz, item, choice, and answer HTML. Preserves all other responses, scoring, feedback, item settings, and position. No Canvas write occurs during planning and this does not support Stimuli, Item Bank entries, matching, categorization, or accessibility conformance.",
    inputSchema: newQuizChoiceImageAltInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planNewQuizChoiceImageAltRepair(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_answer_feedback_image_alt_repair", {
    title: "Review a New Quiz answer-feedback image alternative-text repair",
    description: "Plan one alternative-text repair for a missing-alt image in feedback for one direct New Quiz choice answer. Requires fresh audit evidence for the exact course, quiz, item, choice, and feedback HTML. Preserves all answer choices, scoring, other feedback, item settings, and position. No Canvas write occurs during planning and this does not support Stimuli, Item Bank entries, or accessibility conformance.",
    inputSchema: newQuizAnswerFeedbackImageAltInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planNewQuizAnswerFeedbackImageAltRepair(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_feedback_image_alt_repair", {
    title: "Review a New Quiz question-feedback image alternative-text repair",
    description: "Plan one alternative-text repair for a missing-alt image in direct New Quiz correct, incorrect, or general feedback. Requires fresh audit evidence for the exact course, quiz, item, feedback type, and HTML. Preserves answers, scoring, other feedback, item settings, and position. No Canvas write occurs during planning and this does not support Stimuli, Item Bank entries, or accessibility conformance.",
    inputSchema: newQuizFeedbackImageAltInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input, context) => planNewQuizFeedbackImageAltRepair(runtime, input, context.mcpReq.signal));
}
