import { type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { checkNewQuiz } from "../src/quiz-check.js";
import type { GatewayRuntime } from "../src/runtime.js";

const COURSE = { id: "42", name: "Biology" };
const base = { source_binding_id: "selected-source", course_id: "42", compare_quiz_ids: [] as string[] };

/** One complete documented QuestionItem entry, so the shared payload contract passes it. */
function question(itemBody: string): JsonObject {
  return {
    title: "Explain the membrane", item_body: itemBody, interaction_type_slug: "essay",
    interaction_data: { rce: true, essay: null, word_count: true, file_upload: false, spell_check: true, word_limit_enabled: false },
    scoring_data: { value: "Use evidence." }, scoring_algorithm: "None",
  };
}

function directItem(id: string, position: number, points: number, itemBody: string): JsonObject {
  return { id, position, points_possible: points, entry_type: "Item", entry: question(itemBody) };
}

/** The documented QuizItem for a bank draw: a BankItem entry plus ItemProperties. */
function drawRow(overrides: JsonObject = {}, properties: JsonObject | null = { sample_num: 2 }): JsonObject {
  return {
    id: "1", position: 1, points_possible: 2, entry_type: "Bank",
    ...(properties === null ? {} : { properties }),
    entry: { id: "91", title: "Cell bank", archived: false, entry_count: 3, item_entry_count: 2 },
    ...overrides,
  };
}

/** The documented QuizItem for one bank entry: a BankEntryItem carrying its own record. */
function entryRow(entry: JsonObject, overrides: JsonObject = {}): JsonObject {
  return {
    id: "2", position: 2, points_possible: 3, entry_type: "BankEntry",
    entry: { id: "789", entry_type: "Item", archived: false, bank_id: "91", ...entry },
    ...overrides,
  };
}

type Fixture = Readonly<Record<string, (args: JsonObject) => unknown>>;

function fixture(snapshots: Fixture, unavailable: readonly string[] = []) {
  const calls: { name: string; arguments: JsonObject }[] = [];
  const runtime = {
    resultPage: () => { throw new Error("This fixture returns no paged artifact."); },
    searchCatalog: ({ query }: { query: string }) => ({
      tools: unavailable.some((prefix) => query.startsWith(prefix))
        ? []
        : [{ publicName: query, upstreamName: query, upstreamId: "canvas", annotations: { readOnlyHint: true } }],
    }),
    capabilityGet: () => ({ descriptor: { provider: "canvas", route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (name: string, argumentsValue: JsonObject) => {
      calls.push({ name, arguments: argumentsValue });
      const read = snapshots[name];
      if (!read) throw new Error(`This fixture has no ${name} read.`);
      const data = read(argumentsValue);
      if (data === undefined) throw new Error(`This fixture has no ${name} record for these arguments.`);
      return {
        structuredContent: {
          schema: "morrow.canvas-connector.result.v1", ok: true, provider: "canvas", commandKind: "invoke_read",
          result: { ok: true, sent: true, truncated: false, status: 200, data },
        },
      };
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

/** Bank 91 through the admitted Item Bank reads: two questions and one stimulus. */
function cellBank(items: Readonly<Record<string, JsonObject>> = {
  "501": { id: "501", entry_type: "Item", entry: question("<p>Bank one.</p>") },
  "502": { id: "502", entry_type: "Item", entry: question("<p>Bank two.</p>") },
}): Fixture {
  return {
    canvas_item_bank_get_bank: (args) => args.bank_id === "91" ? { id: "91", title: "Cell bank" } : undefined,
    canvas_item_bank_list_entries: (args) => args.bank_id === "91"
      ? [
        ...Object.keys(items).map((itemId, index) => ({ id: String(700 + index + 1), bank_id: "91", entry_type: "Item", entry_id: itemId })),
        { id: "799", bank_id: "91", entry_type: "Stimulus", entry_id: "599" },
      ]
      : undefined,
    canvas_item_bank_get_item: (args) => args.bank_id === "91" ? items[String(args.item_id)] : undefined,
  };
}

function quizReads(quizId: string, title: string, items: JsonObject[]): Fixture {
  return {
    canvas_get_single_course_courses: (args) => args.id === "42" ? COURSE : undefined,
    canvas_get_new_quiz: (args) => args.assignment_id === quizId ? { id: quizId, course_id: "42", title } : undefined,
    canvas_list_quiz_items: (args) => args.assignment_id === quizId ? items : undefined,
  };
}

function structured(result: Awaited<ReturnType<typeof checkNewQuiz>>): JsonObject {
  return result.structuredContent as JsonObject;
}

function quizOf(report: JsonObject): JsonObject {
  return (report.quizzes as JsonObject[])[0]!;
}

describe("New Quiz check with bank-backed content", () => {
  it("reads the bank a draw takes from and checks the questions it can supply", async () => {
    const { runtime, calls } = fixture({
      ...quizReads("100", "Bank quiz", [drawRow()]),
      ...cellBank(),
    });
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "100", expected_question_count: 2, expected_question_points: 4 }));
    expect(report.status, JSON.stringify(report)).toBe("checks_finished");
    expect(report.findingCount).toBe(0);
    expect(quizOf(report)).toMatchObject({
      id: "100", questionCount: 2, questionPoints: 4, directQuestionCount: 0, directQuestionPoints: 0,
      bankDrawnQuestionCount: 2, bankDrawnQuestionPoints: 4, bankQuestionsChecked: 2,
      questionContractsChecked: 2, totalsComplete: true, contentComplete: true,
    });
    expect((quizOf(report).bankBackedRows as JsonObject[])[0]).toMatchObject({
      quizItemId: "1", entryType: "Bank", bankId: "91", bankName: "Cell bank",
      questionsSupplied: 2, pointsPerQuestion: 2, bankQuestionCount: 2, bankQuestionsChecked: 2, bankFullyChecked: true,
    });
    expect(calls.filter((call) => call.name === "canvas_item_bank_get_item")).toHaveLength(2);
  });

  it("treats a null sample count as the documented draw of every bank question", async () => {
    const { runtime } = fixture({
      ...quizReads("100", "Bank quiz", [drawRow({}, { sample_num: null })]),
      ...cellBank(),
    });
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "100" }));
    expect(report.status, JSON.stringify(report)).toBe("checks_finished");
    expect(quizOf(report)).toMatchObject({ questionCount: 2, questionPoints: 4, totalsComplete: true });
    expect((quizOf(report).bankBackedRows as JsonObject[])[0]).toMatchObject({ questionsSupplied: 2, drawsEveryBankQuestion: true });
  });

  it("checks the question a bank entry row carries and reports it as repeated content", async () => {
    const repeated = "<p>Bank one.</p>";
    const { runtime, calls } = fixture(quizReads("101", "Mixed quiz", [
      directItem("1", 1, 1, repeated),
      entryRow({ entry: question(repeated) }),
    ]));
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "101" }));
    expect(report.status, JSON.stringify(report)).toBe("needs_attention");
    expect(report.repeatedGroupCount).toBe(1);
    expect((report.repeatedContent as JsonObject[][])[0]).toEqual([
      { quizId: "101", quiz: "Mixed quiz", questionId: "1", question: "Explain the membrane" },
      { quizId: "101", quiz: "Mixed quiz", questionId: "2", question: "Explain the membrane", bankId: "91" },
    ]);
    expect(quizOf(report)).toMatchObject({
      questionCount: 2, questionPoints: 4, directQuestionCount: 1, bankDrawnQuestionCount: 1,
      bankQuestionsChecked: 1, questionContractsChecked: 2, totalsComplete: true, contentComplete: true,
    });
    expect(calls.every((call) => !call.name.startsWith("canvas_item_bank_"))).toBe(true);
  });

  it("resolves the private builder row shape as well as the documented one", async () => {
    const { runtime } = fixture(quizReads("101", "Builder quiz", [
      { id: "2", position: 1, points_possible: 3, entry_type: "BankEntry", bank_id: "91", entry_id: "789", entry: question("<p>Builder shape.</p>") },
    ]));
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "101" }));
    expect(report.status, JSON.stringify(report)).toBe("checks_finished");
    expect(quizOf(report)).toMatchObject({ questionCount: 1, questionPoints: 3, bankQuestionsChecked: 1 });
    expect((quizOf(report).bankBackedRows as JsonObject[])[0]).toMatchObject({ bankId: "91", questionChecked: true });
  });

  it("counts a bank entry holding a stimulus as a stimulus and not as a question", async () => {
    const { runtime } = fixture(quizReads("101", "Stimulus quiz", [
      entryRow({ entry_type: "Stimulus", entry: { id: "599", title: "Diagram", body: "<p>Look.</p>", passage: false } }, { points_possible: 0 }),
    ]));
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "101" }));
    expect(report.status, JSON.stringify(report)).toBe("checks_finished");
    expect(quizOf(report)).toMatchObject({ questionCount: 0, questionPoints: 0, relationships: { stimulusCount: 1, bankReferenceCount: 1 } });
    expect((quizOf(report).bankBackedRows as JsonObject[])[0]).toMatchObject({ questionsSupplied: 0, holdsStimulus: true });
  });

  it("keeps exact counts but names the missing Item Bank reads for a draw", async () => {
    const { runtime } = fixture({ ...quizReads("100", "Bank quiz", [drawRow()]), ...cellBank() }, ["canvas_item_bank_"]);
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "100", expected_question_count: 3 }));
    expect(report.status).toBe("incomplete");
    expect(report.incomplete).toContain("This Canvas connection does not provide the Item Bank reads, so the questions a bank draw can supply were not checked.");
    expect(quizOf(report)).toMatchObject({ questionCount: 2, questionPoints: 4, bankQuestionsChecked: 0, totalsComplete: true, contentComplete: false });
    expect((report.findings as JsonObject[]).map((finding) => finding.message)).toContain("Expected 3 questions; found 2.");
  });

  it("reports an unreadable bank without treating it as an empty bank", async () => {
    const { runtime } = fixture({
      ...quizReads("100", "Bank quiz", [drawRow()]),
      canvas_item_bank_get_bank: () => undefined,
    });
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "100" }));
    expect(report.status).toBe("incomplete");
    expect(report.incomplete).toContain("Bank quiz: Morrow could not read Item Bank 91, so the questions it supplies to this quiz were not checked.");
    expect(quizOf(report)).toMatchObject({ bankQuestionsChecked: 0, contentComplete: false });
  });

  it("refuses to guess a draw size Canvas did not report", async () => {
    const { runtime } = fixture({ ...quizReads("100", "Bank quiz", [drawRow({}, null)]), ...cellBank() });
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "100" }));
    expect(report.status).toBe("incomplete");
    expect((report.findings as JsonObject[]).map((finding) => finding.message))
      .toContain("Morrow could not read how many questions this Item Bank draw takes.");
    expect(quizOf(report)).toMatchObject({ bankDrawnQuestionCount: 0, totalsComplete: false });
  });

  it("reports a draw that takes more questions than its bank holds", async () => {
    const { runtime } = fixture({ ...quizReads("100", "Bank quiz", [drawRow({}, { sample_num: 5 })]), ...cellBank() });
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "100" }));
    expect((report.findings as JsonObject[]).map((finding) => finding.message))
      .toContain("This draw takes 5 questions from a bank that holds 2.");
  });

  it("refuses a bank-backed row that names no readable bank", async () => {
    const { runtime } = fixture(quizReads("100", "Bank quiz", [
      { id: "1", position: 1, points_possible: 2, entry_type: "Bank", properties: { sample_num: 2 }, entry: { title: "Unnamed bank" } },
    ]));
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "100" }));
    expect(report.status).toBe("incomplete");
    expect((report.findings as JsonObject[]).map((finding) => finding.message))
      .toContain("This quiz row takes its content from an Item Bank, but it names no bank Morrow can read.");
  });

  it("reports a bank question the saved quiz did not carry", async () => {
    const { runtime } = fixture(quizReads("101", "Mixed quiz", [entryRow({ entry: null })]));
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "101" }));
    expect(report.status).toBe("incomplete");
    expect(report.incomplete).toContain("Mixed quiz: the saved quiz did not carry the Item Bank question at position 2, so that question was not checked.");
    expect(quizOf(report)).toMatchObject({ questionCount: 1, totalsComplete: true, contentComplete: false });
  });

  it("reaches every question in a membership that mixes Item, Stimulus and bank-backed rows", async () => {
    const { runtime, calls } = fixture({
      ...quizReads("104", "Mixed membership", [
        directItem("1", 1, 2, "<p>Directly held.</p>"),
        { id: "2", position: 2, points_possible: 0, entry_type: "Stimulus", entry: { id: "600", title: "Diagram", body: "<p>Look at this.</p>", passage: false } },
        entryRow({ entry: question("<p>Carried by the bank entry row.</p>") }, { id: "3", position: 3, points_possible: 3 }),
        drawRow({ id: "4", position: 4, points_possible: 2 }, { sample_num: 2 }),
        { id: "5", position: 5, points_possible: 0, entry_type: "BankEntry", entry: { id: "790", entry_type: "Stimulus", bank_id: "91", entry: { id: "601", title: "Bank diagram", body: "<p>Bank stimulus.</p>", passage: true } } },
      ]),
      ...cellBank(),
    });
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "104", expected_question_count: 4, expected_question_points: 9 }));
    expect(report.status, JSON.stringify(report)).toBe("checks_finished");
    expect(report.findingCount).toBe(0);
    expect(quizOf(report)).toMatchObject({
      // One directly held question (2 points), one carried by a bank entry row (3 points),
      // and two from the draw at 2 points each. The bank stimulus row supplies no question.
      questionCount: 4, questionPoints: 9,
      directQuestionCount: 1, directQuestionPoints: 2,
      bankDrawnQuestionCount: 3, bankDrawnQuestionPoints: 7,
      // The bank entry's own question, plus both questions the draw can supply.
      bankQuestionsChecked: 3,
      // Every question Morrow reached passed the same shape and scoring contract.
      questionContractsChecked: 4,
      relationships: { stimulusCount: 2, textBlockCount: 0, bankReferenceCount: 3 },
      totalsComplete: true, contentComplete: true,
    });
    // The draw's bank was read; the bank entry row carried its own question, so it needed no read.
    expect(calls.filter((call) => call.name === "canvas_item_bank_get_item").map((call) => call.arguments.item_id)).toEqual(["501", "502"]);
    expect(calls.filter((call) => call.name === "canvas_item_bank_get_entry")).toHaveLength(0);
  });

  it("makes no Item Bank read for a quiz that holds every question itself", async () => {
    const { runtime, calls } = fixture(quizReads("103", "Direct quiz", [
      directItem("1", 1, 2, "<p>One.</p>"), directItem("2", 2, 3, "<p>Two.</p>"),
    ]));
    const report = structured(await checkNewQuiz(runtime, { ...base, quiz_id: "103", expected_question_count: 2, expected_question_points: 5 }));
    expect(report.status, JSON.stringify(report)).toBe("checks_finished");
    expect(quizOf(report)).toMatchObject({ questionCount: 2, questionPoints: 5, bankDrawnQuestionCount: 0, bankQuestionsChecked: 0 });
    expect(calls.every((call) => !call.name.startsWith("canvas_item_bank_"))).toBe(true);
  });
});
