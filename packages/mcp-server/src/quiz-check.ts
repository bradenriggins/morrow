import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import type { GatewayRuntime } from "./runtime.js";
import { canvasReadResult } from "./canvas-read.js";
import { completeQuizItemPayloadReason, quizItemPayloadMessage } from "./quiz-item-payload.js";

const canvasId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const inputSchema = z.object({
  source_binding_id: z.string().min(1).max(200),
  course_id: canvasId,
  quiz_id: canvasId.describe("The Canvas assignment ID of the New Quiz to check."),
  compare_quiz_ids: z.array(canvasId).max(3).default([]).describe("Up to three other New Quizzes in this course to check for repeated question content."),
  expected_question_count: z.number().int().min(0).max(10_000).optional(),
  expected_question_points: z.number().finite().min(0).optional().describe("Expected sum of question points, not the assignment's gradebook points."),
});

type CheckInput = z.infer<typeof inputSchema>;
type CheckRuntime = Pick<GatewayRuntime, "searchCatalog" | "capabilityGet" | "callSourceOwned" | "resultPage">;
type Finding = { quizId: string; quiz: string; questionId?: string; question?: string; message: string };
type Question = { quizId: string; quiz: string; questionId: string; question: string; body: string; bankId?: string };
/** One quiz row that takes its content from an Item Bank instead of holding it. */
type BankRow = {
  itemId: string;
  position: number | null;
  entryType: string;
  /** `draw` takes items from a whole bank. `single` names one bank entry. */
  kind: "draw" | "single";
  bankId: string;
  bankName: string;
  /** The bank's own item count, when the quiz row reported it. */
  bankItemCount: number | null;
  /** The bank entry a `single` row names. */
  entryId: string;
  /** A number, `"all"` for a draw of every bank item, or null when Canvas did not report it. */
  sampleCount: number | "all" | null;
  points: number | null;
  /** The question this row supplies, once Morrow has read it. */
  questionChecked: boolean;
  /** True when the bank entry this row names holds a stimulus, which is not a question. */
  stimulus: boolean;
};

const ID = /^[1-9][0-9]{0,18}$/;
/** Bounds on the bank reads one review may make. Exceeding one is an incomplete result, never a silent stop. */
const MAX_BANKS = 20;
const MAX_BANK_ENTRIES = 2_000;
const MAX_BANK_ITEM_READS = 300;

const limits = [
  "This checks saved New Quiz structure. It does not change Canvas.",
  "Repeated content means identical question content apart from extra whitespace. It does not detect questions that test the same idea in different words.",
  "Shape and scoring-reference checks cover all 12 question types supported by the New Quiz Items create contract. They do not judge whether an answer is factually or pedagogically correct.",
  "A bank entry row carries its question in the saved quiz, so Morrow checks it with the other questions. A bank draw carries only the bank, its size, and how many questions it takes, so Morrow reads that bank to check the questions it can supply. Canvas decides which of them each learner receives at attempt time and publishes no list of the selected ones.",
  "The count and points for a bank draw are the number of questions it takes multiplied by its points per question.",
  "The New Quiz Items API allows only entry_type \"Item\" on create and update, and states that stimulus items and bank items \"can only be retrieved with the API. They must be created and updated via the UI.\" Morrow reads them and never plans one as a create or update target.",
  "This does not check learning objectives, accessibility, or what a student can open. Changes made during or after this check may not appear here.",
];

class ToolUnavailable extends Error {}

function sameId(value: unknown, expected: string): boolean {
  return value === expected || (typeof value === "number" && Number.isSafeInteger(value) && String(value) === expected);
}

function exactId(value: unknown): string {
  return typeof value === "string" && ID.test(value) ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0 && ID.test(String(value)) ? String(value) : "";
}

function name(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : fallback;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function wholeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value
    : typeof value === "string" && /^[1-9][0-9]{0,6}$/.test(value) ? Number(value) : null;
}

/** `BankEntry`, `bank_entry` and `Bank Entry` are the same provider value written three ways. */
function normalizedEntryType(value: unknown): string {
  return String(value ?? "").replaceAll(/[_ -]/g, "").toLowerCase();
}

/**
 * The bank a quiz row takes its content from, read from the row itself.
 *
 * The documented QuizItem carries the bank in its own `entry`. A `Bank` row's
 * entry is a BankItem: the bank's id, title, `entry_count` and
 * `item_entry_count`, with `properties.sample_num` holding how many questions
 * the draw takes, or null when the draw takes every item in the bank. A
 * `BankEntry` row's entry is a BankEntryItem: the bank entry's own id, its
 * `bank_id`, whether it holds an `Item` or a `Stimulus`, and that record itself
 * under a second `entry`. Morrow also reads the private builder's `entry_id`
 * and `bank_id` spelling, so a row from either shape resolves.
 *
 * Sources: https://developerdocs.instructure.com/services/canvas/resources/new_quiz_items
 * ("the number of items to randomly select from the bank. null if all items
 * should be included") and
 * docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md.
 */
function bankBackedRow(item: JsonObject): BankRow | null {
  const entryType = normalizedEntryType(item.entry_type);
  const kind = ["bank", "itembank"].includes(entryType) ? "draw"
    : entryType === "bankentry" ? "single" : null;
  if (!kind) return null;
  const entry = isJsonObject(item.entry) ? item.entry : undefined;
  const properties = isJsonObject(item.properties) ? item.properties
    : isJsonObject(entry?.properties) ? entry.properties : undefined;
  const bankId = kind === "draw"
    ? exactId(entry?.id) || exactId(item.entry_id) || exactId(item.bank_id)
    : exactId(entry?.bank_id) || exactId(item.bank_id);
  const sampleCount = kind === "single" ? 1
    : properties && Object.hasOwn(properties, "sample_num")
      ? properties.sample_num === null ? "all" : wholeCount(properties.sample_num)
      : null;
  return {
    itemId: String(item.id),
    position: typeof item.position === "number" && Number.isSafeInteger(item.position) ? item.position : null,
    entryType: String(item.entry_type ?? "unread").slice(0, 60),
    kind,
    bankId,
    bankName: kind === "draw" ? name(entry?.title, "") : "",
    bankItemCount: kind === "draw" ? wholeCount(entry?.item_entry_count) ?? wholeCount(entry?.entry_count) : null,
    entryId: kind === "single" ? exactId(entry?.id) || exactId(item.entry_id) : "",
    sampleCount,
    points: positiveNumber(item.points_possible),
    questionChecked: false,
    stimulus: kind === "single" && normalizedEntryType(entry?.entry_type) === "stimulus",
  };
}

/**
 * The question a bank entry row already carries, taken from the BankEntryItem's
 * own `entry`. The private builder shape carries the same question one level
 * higher, so both are read.
 */
function savedBankQuestion(item: JsonObject): JsonObject | null {
  const entry = isJsonObject(item.entry) ? item.entry : null;
  const question = entry && isJsonObject(entry.entry) ? entry.entry : entry;
  if (!question || typeof question.item_body !== "string" || !question.item_body.trim()
    || typeof question.interaction_type_slug !== "string") return null;
  return { entry_type: "Item", ...(typeof item.points_possible === "number" ? { points_possible: item.points_possible } : {}), entry: question };
}

/**
 * Section 3.3 of docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md:
 * an entry row may name its question in `entry_id`, or embed it under `item`,
 * `entry`, `current_version` or `data`, or name it nowhere at all.
 */
function bankEntryItemId(entry: JsonObject): string {
  if (normalizedEntryType(entry.entry_type) !== "item") return "";
  const direct = exactId(entry.entry_id);
  if (direct) return direct;
  for (const key of ["item", "entry", "current_version", "data"]) {
    const value = entry[key];
    if (!isJsonObject(value)) continue;
    const own = exactId(value.id);
    if (own) return own;
    for (const nested of ["item", "data"]) {
      const inner = value[nested];
      if (isJsonObject(inner)) {
        const innerId = exactId(inner.id);
        if (innerId) return innerId;
      }
    }
  }
  return "";
}

export async function checkNewQuiz(runtime: CheckRuntime, value: CheckInput, callerSignal?: AbortSignal): Promise<CallToolResult> {
  const input = inputSchema.parse(value);
  const findings: Finding[] = [];
  const incomplete: string[] = [];
  const quizzes: JsonObject[] = [];
  const questions: Question[] = [];
  const timeout = AbortSignal.timeout(180_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  let course = "Selected course";
  let source: string | undefined;
  let bankReadsUnavailable = false;
  let bankItemReads = 0;

  async function read(toolName: string, args: JsonObject): Promise<unknown> {
    const matches = runtime.searchCatalog({ query: toolName, limit: 100 }).tools.filter((tool) => {
      const descriptor = runtime.capabilityGet(tool.publicName).descriptor;
      return tool.upstreamName === toolName && tool.annotations?.readOnlyHint === true
        && (!source || tool.upstreamId === source) && isJsonObject(descriptor)
        && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new ToolUnavailable("The Canvas read tool is unavailable or ambiguous.");
    source = matches[0]!.upstreamId;
    return canvasReadResult(runtime, await runtime.callSourceOwned(matches[0]!.publicName, {
      ...args, _morrow: { source_binding_id: input.source_binding_id },
    }, { signal })).data;
  }

  try {
    const result = await read("canvas_get_single_course_courses", { id: input.course_id });
    if (!isJsonObject(result) || !sameId(result.id, input.course_id)) throw new Error("Course did not match.");
    course = name(result.name, course);
  } catch {
    incomplete.push("Morrow could not confirm the selected course. No quiz checks were completed.");
  }

  if (incomplete.length === 0) for (const quizId of new Set([input.quiz_id, ...input.compare_quiz_ids])) {
    let quiz = quizId === input.quiz_id ? "Selected quiz" : "Comparison quiz";
    try {
      const args = { course_id: input.course_id, assignment_id: quizId };
      const [detail, items] = await Promise.all([
        read("canvas_get_new_quiz", args), read("canvas_list_quiz_items", args),
      ]);
      if (!isJsonObject(detail) || !sameId(detail.id, quizId)
        || (detail.course_id !== undefined && !sameId(detail.course_id, input.course_id))
        || !Array.isArray(items) || items.length > 10_000) throw new Error("Quiz did not match or items were incomplete.");
      quiz = name(detail.title, quiz);
      let count = 0;
      let points = 0;
      let complete = true;
      let answerChecks = 0;
      const ids = new Set<string>();
      const itemById = new Map<string, JsonObject>();
      const questionTypes = new Map<string, number>();
      let stimulusCount = 0;
      let textBlockCount = 0;
      let linkedQuestionCount = 0;
      let bankReferenceCount = 0;
      const bankRows: BankRow[] = [];
      const bankReports: JsonObject[] = [];
      let bankQuestionsRead = 0;

      /**
       * The one question contract every checked question passes through, whether the quiz
       * holds it directly or an Item Bank supplies it. `bankId` is set only for a bank
       * question, so repeated content can name where each copy lives.
       */
      const checkQuestion = (record: JsonObject, questionId: string, fallback: string, bankId?: string): void => {
        const entry = isJsonObject(record.entry) ? record.entry : {};
        const question = name(entry.title, fallback);
        const issue = (message: string) => findings.push({ quizId, quiz, questionId, question, message });
        if (typeof entry.item_body !== "string" || !entry.item_body.trim()) issue("Question content is missing.");
        else questions.push({ quizId, quiz, questionId, question, body: sha256Text(entry.item_body.replace(/\s+/g, " ").trim()), ...(bankId ? { bankId } : {}) });
        const slug = typeof entry.interaction_type_slug === "string" ? entry.interaction_type_slug : "unread";
        questionTypes.set(slug, (questionTypes.get(slug) ?? 0) + 1);
        answerChecks += 1;
        // An Item Bank question is the same QuestionItem shape without the quiz row's own
        // `entry_type`, so the one contract reads both.
        const payloadReason = completeQuizItemPayloadReason({ ...record, entry_type: "Item" });
        if (payloadReason) issue(quizItemPayloadMessage(payloadReason));
      };

      for (const item of items) {
        if (isJsonObject(item) && ["string", "number"].includes(typeof item.id)) itemById.set(String(item.id), item);
      }
      for (const item of items) {
        if (!isJsonObject(item) || !["string", "number"].includes(typeof item.id)
          || (typeof item.id === "number" && !Number.isSafeInteger(item.id)) || !ID.test(String(item.id)) || ids.has(String(item.id))) {
          complete = false;
          continue;
        }
        ids.add(String(item.id));
        if (item.entry_type === "Stimulus") {
          stimulusCount += 1;
          if (isJsonObject(item.entry) && item.entry.passage === true) textBlockCount += 1;
          if (!isJsonObject(item.entry) || typeof item.entry.body !== "string") {
            complete = false;
            findings.push({ quizId, quiz, questionId: String(item.id), question: name(isJsonObject(item.entry) ? item.entry.title : undefined, `Stimulus ${item.position ?? item.id}`), message: "The stimulus body could not be read." });
          }
          continue;
        }
        const bankRow = bankBackedRow(item);
        if (bankRow) {
          bankReferenceCount += 1;
          if (bankRow.stimulus) {
            stimulusCount += 1;
            bankRow.sampleCount = 0;
          } else if (bankRow.kind === "single") {
            const saved = savedBankQuestion(item);
            if (saved) {
              bankRow.questionChecked = true;
              bankQuestionsRead += 1;
              checkQuestion(saved, bankRow.itemId, `Bank question ${bankRow.position ?? bankRow.itemId}`, bankRow.bankId || undefined);
            }
          }
          bankRows.push(bankRow);
          continue;
        }
        if (item.entry_type !== "Item" || !isJsonObject(item.entry)) {
          complete = false;
          continue;
        }
        count += 1;
        const questionId = String(item.id);
        if (typeof item.points_possible !== "number" || !Number.isFinite(item.points_possible) || item.points_possible <= 0) {
          complete = false;
          findings.push({ quizId, quiz, questionId, question: name(item.entry.title, `Question ${typeof item.position === "number" ? item.position : count}`), message: "Question points could not be read." });
        } else points += item.points_possible;
        checkQuestion(item, questionId, `Question ${typeof item.position === "number" ? item.position : count}`);
        const stimulusId = item.stimulus_quiz_entry_id;
        if (stimulusId !== undefined && stimulusId !== null) {
          linkedQuestionCount += 1;
          const stimulus = itemById.get(String(stimulusId));
          if (!stimulus || stimulus.entry_type !== "Stimulus") {
            complete = false;
            findings.push({ quizId, quiz, questionId, question: name(item.entry.title, `Question ${item.position ?? count}`), message: "The question references a stimulus that is absent from this saved quiz item list." });
          }
        }
      }

      // A bank draw carries only its bank, so the questions it can supply are read from that
      // bank. A bank Morrow cannot read is named, never counted as empty.
      let drawnCount = 0;
      let drawnPoints = 0;
      let bankQuestionsUnchecked = 0;
      const drawBankIds = [...new Set(bankRows.filter((row) => row.kind === "draw").map((row) => row.bankId).filter(Boolean))];
      const bankTitles = new Map<string, string>(bankRows.filter((row) => row.bankName).map((row) => [row.bankId, row.bankName]));
      const bankPools = new Map<string, { entries: number; read: number; complete: boolean }>();
      const bankLabel = (row: BankRow) => `${bankTitles.get(row.bankId) || `Item Bank ${row.bankId}`}${row.kind === "draw" ? " draw" : " entry"}`;
      if (drawBankIds.length > MAX_BANKS) {
        bankQuestionsUnchecked += drawBankIds.length;
        incomplete.push(`${quiz}: this quiz draws from ${drawBankIds.length} Item Banks, more than the ${MAX_BANKS} one check reads. Its bank questions were not checked.`);
      } else for (const bankId of drawBankIds) {
        if (bankReadsUnavailable) { bankQuestionsUnchecked += 1; continue; }
        try {
          const bank = await read("canvas_item_bank_get_bank", { course_id: input.course_id, bank_id: bankId });
          if (!isJsonObject(bank) || !sameId(bank.id, bankId)) throw new Error("Bank did not match.");
          bankTitles.set(bankId, name(bank.title, bankTitles.get(bankId) || `Item Bank ${bankId}`));
          const entries = await read("canvas_item_bank_list_entries", { course_id: input.course_id, bank_id: bankId });
          if (!Array.isArray(entries) || entries.length > MAX_BANK_ENTRIES) throw new Error("Bank entries were incomplete.");
          const pool = { entries: 0, read: 0, complete: true };
          bankPools.set(bankId, pool);
          for (const entry of entries) {
            if (!isJsonObject(entry)) { pool.complete = false; continue; }
            if (normalizedEntryType(entry.entry_type) === "stimulus") continue;
            pool.entries += 1;
            const itemId = bankEntryItemId(entry);
            if (!itemId || bankItemReads >= MAX_BANK_ITEM_READS) { pool.complete = false; continue; }
            bankItemReads += 1;
            const bankItem = await read("canvas_item_bank_get_item", { course_id: input.course_id, bank_id: bankId, item_id: itemId });
            if (!isJsonObject(bankItem) || !sameId(bankItem.id, itemId)) { pool.complete = false; continue; }
            pool.read += 1;
            bankQuestionsRead += 1;
            checkQuestion(bankItem, `${bankId}:${itemId}`, `Bank question ${itemId}`, bankId);
          }
          if (!pool.complete) {
            bankQuestionsUnchecked += 1;
            incomplete.push(`${quiz}: Morrow read ${pool.read} of the questions in Item Bank ${bankId} and could not read the rest.`);
          }
        } catch (error) {
          bankQuestionsUnchecked += 1;
          if (error instanceof ToolUnavailable) {
            bankReadsUnavailable = true;
            incomplete.push("This Canvas connection does not provide the Item Bank reads, so the questions a bank draw can supply were not checked.");
          } else {
            incomplete.push(`${quiz}: Morrow could not read Item Bank ${bankId}, so the questions it supplies to this quiz were not checked.`);
          }
        }
      }

      for (const row of bankRows) {
        if (!row.bankId) {
          complete = false;
          findings.push({ quizId, quiz, questionId: row.itemId, question: `${row.entryType} ${row.position ?? row.itemId}`, message: "This quiz row takes its content from an Item Bank, but it names no bank Morrow can read." });
          continue;
        }
        const pool = bankPools.get(row.bankId);
        // `sample_num: null` is the documented all-items draw, so its size is the bank's size.
        const drawn = row.sampleCount === "all"
          ? row.bankItemCount ?? (pool?.complete ? pool.entries : null)
          : row.sampleCount;
        if (row.kind === "single" && !row.questionChecked && !row.stimulus) {
          bankQuestionsUnchecked += 1;
          incomplete.push(`${quiz}: the saved quiz did not carry the Item Bank question at position ${row.position ?? row.itemId}, so that question was not checked.`);
        }
        if (drawn === null) {
          complete = false;
          findings.push({ quizId, quiz, questionId: row.itemId, question: bankLabel(row), message: "Morrow could not read how many questions this Item Bank draw takes." });
        } else drawnCount += drawn;
        if (row.points === null && drawn !== 0) {
          complete = false;
          findings.push({ quizId, quiz, questionId: row.itemId, question: bankLabel(row), message: "Morrow could not read the points each question this Item Bank supplies is worth." });
        } else if (drawn !== null && row.points !== null) drawnPoints += drawn * row.points;
        const bankSize = row.bankItemCount ?? (pool?.complete ? pool.entries : null);
        if (row.kind === "draw" && typeof drawn === "number" && bankSize !== null && drawn > bankSize) {
          findings.push({ quizId, quiz, questionId: row.itemId, question: bankLabel(row), message: `This draw takes ${drawn} questions from a bank that holds ${bankSize}.` });
        }
        bankReports.push({
          quizItemId: row.itemId, entryType: row.entryType, position: row.position, bankId: row.bankId,
          bankName: bankTitles.get(row.bankId) ?? null, questionsSupplied: drawn, pointsPerQuestion: row.points,
          ...(row.sampleCount === "all" ? { drawsEveryBankQuestion: true } : {}),
          ...(row.kind === "draw"
            ? { bankQuestionCount: bankSize, bankQuestionsChecked: pool?.read ?? 0, bankFullyChecked: Boolean(pool?.complete) }
            : { questionChecked: row.questionChecked, holdsStimulus: row.stimulus }),
        });
      }
      const totalsComplete = complete;
      if (bankQuestionsUnchecked > 0) complete = false;

      const directPoints = Number(points.toFixed(6));
      const totalCount = count + drawnCount;
      const totalPoints = Number((points + drawnPoints).toFixed(6));
      quizzes.push({
        id: quizId, name: quiz, questionCount: totalCount, questionPoints: totalPoints,
        directQuestionCount: count, directQuestionPoints: directPoints,
        bankDrawnQuestionCount: drawnCount, bankDrawnQuestionPoints: Number(drawnPoints.toFixed(6)),
        bankQuestionsChecked: bankQuestionsRead, totalsComplete, contentComplete: complete,
        questionContractsChecked: answerChecks,
        questionTypes: Object.fromEntries([...questionTypes.entries()].sort(([left], [right]) => left.localeCompare(right))),
        relationships: { stimulusCount, textBlockCount, linkedQuestionCount, bankReferenceCount },
        ...(bankReports.length ? { bankBackedRows: bankReports.slice(0, 100) } : {}),
      });
      if (!totalsComplete) incomplete.push(`${quiz}: some questions or points could not be read. Totals and repeated-content checks are incomplete.`);
      if (quizId === input.quiz_id && totalsComplete) {
        if (input.expected_question_count !== undefined && totalCount !== input.expected_question_count) {
          findings.push({ quizId, quiz, message: `Expected ${input.expected_question_count} questions; found ${totalCount}.` });
        }
        if (input.expected_question_points !== undefined && Math.abs(totalPoints - input.expected_question_points) > 0.000001) {
          findings.push({ quizId, quiz, message: `Expected ${input.expected_question_points} question points; found ${totalPoints}.` });
        }
      }
    } catch {
      incomplete.push(`${quiz}: Canvas did not provide all the details needed to finish this check. Morrow made no changes.`);
    }
  }

  const grouped = new Map<string, Question[]>();
  for (const question of questions) {
    const group = grouped.get(question.body) || [];
    group.push(question);
    grouped.set(question.body, group);
  }
  const repeated = [...grouped.values()].filter((group) => group.length > 1 && group.some((question) => question.quizId === input.quiz_id));
  const status = incomplete.length ? "incomplete" : findings.length || repeated.length ? "needs_attention" : "checks_finished";
  const summary = status === "incomplete" ? "Some quiz checks could not finish. Do not treat this as a complete check."
    : status === "needs_attention" ? `Quiz checks finished. Found ${findings.length} issues and ${repeated.length} groups of repeated question content.`
      : "Quiz checks finished. No issues were found by these checks. This is not a full review of the quiz.";
  const report = {
    schema: "morrow.new-quiz-check.v1", status, summary, checkedAt: new Date().toISOString(),
    course: { id: input.course_id, name: course }, quizzes,
    findings: findings.slice(0, 100), findingCount: findings.length,
    repeatedContent: repeated.slice(0, 50).map((group) => group.slice(0, 20).map(({ quizId, quiz, questionId, question, bankId }) => ({ quizId, quiz, questionId, question, ...(bankId ? { bankId } : {}) }))),
    repeatedGroupCount: repeated.length, incomplete, limits,
    detailsLimited: findings.length > 100 || repeated.length > 50 || repeated.some((group) => group.length > 20),
  };
  const lines = [summary, `Course: ${course}`, ...quizzes.map((quiz) => `${quiz.name}: ${quiz.questionCount} questions; ${quiz.questionPoints} question points${quiz.totalsComplete ? "." : " (incomplete)."}${Number(quiz.bankDrawnQuestionCount) > 0 ? ` ${quiz.bankDrawnQuestionCount} of those come from an Item Bank; Morrow checked ${quiz.bankQuestionsChecked} bank questions.` : ""}`),
    ...findings.slice(0, 30).map((finding) => `${finding.quiz}${finding.question ? `: ${finding.question}` : ""}: ${finding.message}`),
    ...repeated.slice(0, 10).map((group) => `Repeated content: ${group.slice(0, 10).map((question) => `${question.quiz}: ${question.question}`).join("; ")}.`),
    ...incomplete, ...limits];
  return { content: [{ type: "text", text: lines.join("\n\n") }], structuredContent: report };
}

export function registerQuizCheckTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_check_new_quiz", {
    title: "Check a New Quiz",
    description: "Check saved New Quiz question counts, points, all 12 documented QuestionItem shapes and scoring references, item relationships, and repeated question content, including the questions the quiz takes from an Item Bank draw or bank entry. Optionally compare three quizzes in the same course. Does not change Canvas, judge teaching quality, or prove student access. Reports incomplete reads explicitly.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input, context) => await checkNewQuiz(runtime, input, context.mcpReq.signal));
}
