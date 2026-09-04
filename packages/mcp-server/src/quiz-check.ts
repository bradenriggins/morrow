import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import type { GatewayRuntime } from "./runtime.js";
import { canvasReadResult } from "./canvas-read.js";

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
type Question = { quizId: string; quiz: string; questionId: string; question: string; body: string };

const limits = [
  "This checks saved New Quiz structure. It does not change Canvas.",
  "Repeated content means identical question content apart from extra whitespace. It does not detect questions that test the same idea in different words.",
  "Answer checks cover multiple-choice, multiple-answer, and true/false questions. They check that choices and a matching correct answer are saved. They do not judge whether an answer is right or check partial-credit rules.",
  "This does not check learning objectives, accessibility, bank contents, or what a student can open. Changes made during or after this check may not appear here.",
];

function sameId(value: unknown, expected: string): boolean {
  return value === expected || (typeof value === "number" && Number.isSafeInteger(value) && String(value) === expected);
}

function name(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : fallback;
}

export async function checkNewQuiz(runtime: CheckRuntime, value: CheckInput, callerSignal?: AbortSignal): Promise<CallToolResult> {
  const input = inputSchema.parse(value);
  const findings: Finding[] = [];
  const incomplete: string[] = [];
  const quizzes: JsonObject[] = [];
  const questions: Question[] = [];
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  let course = "Selected course";
  let source: string | undefined;

  async function read(toolName: string, args: JsonObject): Promise<unknown> {
    const matches = runtime.searchCatalog({ query: toolName, limit: 100 }).tools.filter((tool) => {
      const descriptor = runtime.capabilityGet(tool.publicName).descriptor;
      return tool.upstreamName === toolName && tool.annotations?.readOnlyHint === true
        && (!source || tool.upstreamId === source) && isJsonObject(descriptor)
        && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new Error("The Canvas read tool is unavailable or ambiguous.");
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
      for (const item of items) {
        if (!isJsonObject(item) || !["string", "number"].includes(typeof item.id)
          || (typeof item.id === "number" && !Number.isSafeInteger(item.id)) || !/^[1-9][0-9]{0,18}$/.test(String(item.id)) || ids.has(String(item.id))) {
          complete = false;
          continue;
        }
        ids.add(String(item.id));
        if (item.entry_type === "Stimulus") continue;
        if (item.entry_type !== "Item" || !isJsonObject(item.entry)) {
          complete = false;
          continue;
        }
        count += 1;
        const entry = item.entry;
        const question = name(entry.title, `Question ${typeof item.position === "number" ? item.position : count}`);
        const questionId = String(item.id);
        const issue = (message: string) => findings.push({ quizId, quiz, questionId, question, message });
        if (typeof item.points_possible !== "number" || !Number.isFinite(item.points_possible) || item.points_possible < 0) {
          complete = false;
          issue("Question points could not be read.");
        } else points += item.points_possible;
        if (typeof entry.item_body !== "string" || !entry.item_body.trim()) issue("Question content is missing.");
        else questions.push({ quizId, quiz, questionId, question, body: sha256Text(entry.item_body.replace(/\s+/g, " ").trim()) });
        if (entry.interaction_type_slug === "true-false") {
          answerChecks += 1;
          const data = isJsonObject(entry.interaction_data) ? entry.interaction_data : {};
          if (typeof data.true_choice !== "string" || !data.true_choice.trim()
            || typeof data.false_choice !== "string" || !data.false_choice.trim()) issue("True/false answer choices are missing.");
          if (!isJsonObject(entry.scoring_data) || typeof entry.scoring_data.value !== "boolean") issue("The saved true/false answer is missing.");
        } else if (["choice", "multi-answer"].includes(String(entry.interaction_type_slug))) {
          answerChecks += 1;
          const choices = isJsonObject(entry.interaction_data) ? entry.interaction_data.choices : null;
          const validChoices = Array.isArray(choices) ? choices.filter(isJsonObject) : [];
          const choiceIds = validChoices.map((choice) => choice.id);
          if (validChoices.length < 2 || validChoices.length !== (Array.isArray(choices) ? choices.length : 0)
            || choiceIds.some((id) => typeof id !== "string" || !id)
            || new Set(choiceIds).size !== choiceIds.length
            || validChoices.some((choice) => !name(choice.item_body ?? choice.itemBody, ""))) {
            issue("Answer choices are missing, empty, or repeated.");
          }
          const answer = isJsonObject(entry.scoring_data) ? entry.scoring_data.value : null;
          const answers = entry.interaction_type_slug === "multi-answer" ? answer : [answer];
          if (!Array.isArray(answers) || answers.length === 0 || new Set(answers).size !== answers.length
            || answers.some((id) => typeof id !== "string" || !choiceIds.includes(id))) {
            issue("The saved correct answer does not match the answer choices.");
          }
        }
      }
      const total = Number(points.toFixed(6));
      quizzes.push({ id: quizId, name: quiz, directQuestionCount: count, directQuestionPoints: total, totalsComplete: complete, answerSettingsChecked: answerChecks, otherQuestionTypes: count - answerChecks });
      if (!complete) incomplete.push(`${quiz}: some questions, points, or bank draws could not be checked. Totals and repeated-content checks may be incomplete.`);
      if (quizId === input.quiz_id && complete) {
        if (input.expected_question_count !== undefined && count !== input.expected_question_count) {
          findings.push({ quizId, quiz, message: `Expected ${input.expected_question_count} questions; found ${count}.` });
        }
        if (input.expected_question_points !== undefined && Math.abs(total - input.expected_question_points) > 0.000001) {
          findings.push({ quizId, quiz, message: `Expected ${input.expected_question_points} question points; found ${total}.` });
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
    repeatedContent: repeated.slice(0, 50).map((group) => group.slice(0, 20).map(({ quizId, quiz, questionId, question }) => ({ quizId, quiz, questionId, question }))),
    repeatedGroupCount: repeated.length, incomplete, limits,
    detailsLimited: findings.length > 100 || repeated.length > 50 || repeated.some((group) => group.length > 20),
  };
  const lines = [summary, `Course: ${course}`, ...quizzes.map((quiz) => `${quiz.name}: ${quiz.directQuestionCount} directly listed questions; ${quiz.directQuestionPoints} question points${quiz.totalsComplete ? "." : " (incomplete)."}`),
    ...findings.slice(0, 30).map((finding) => `${finding.quiz}${finding.question ? ` — ${finding.question}` : ""}: ${finding.message}`),
    ...repeated.slice(0, 10).map((group) => `Repeated content: ${group.slice(0, 10).map((question) => `${question.quiz} — ${question.question}`).join("; ")}.`),
    ...incomplete, ...limits];
  return { content: [{ type: "text", text: lines.join("\n\n") }], structuredContent: report };
}

export function registerQuizCheckTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_check_new_quiz", {
    title: "Check a New Quiz",
    description: "Check saved New Quiz question counts, question points, choice-based answer settings, and repeated question content. Optionally compare three quizzes in the same course. Does not change Canvas, inspect bank contents, judge teaching quality, or prove student access. Reports incomplete reads explicitly.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input, context) => await checkNewQuiz(runtime, input, context.mcpReq.signal));
}
