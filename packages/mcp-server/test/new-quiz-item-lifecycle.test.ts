import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Json, type JsonObject } from "@morrow/contracts";
import { newQuizItemLifecycleWriteSchema } from "../../canvas-connector-mcp/src/server.js";
import {
  planNewQuizItemCreate,
  planNewQuizItemDelete,
  planNewQuizItemReplacement,
  prepareNewQuizHotSpotCreate,
  registerNewQuizItemLifecycleTools,
} from "../src/new-quiz-item-lifecycle.js";
import type { GatewayRuntime } from "../src/runtime.js";

const sourceBindingId = "canvas:instructor";
const writeTools = new Set(["canvas_create_quiz_item", "canvas_delete_quiz_item", "canvas_update_quiz_item"]);
const choiceA = "11111111-1111-4111-8111-111111111111";
const choiceB = "22222222-2222-4222-8222-222222222222";
const choiceC = "33333333-3333-4333-8333-333333333333";
const choiceD = "44444444-4444-4444-8444-444444444444";
const catalog = JSON.parse(readFileSync(new URL("../../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const createOperation = catalog.operations.find((entry: { toolName: string }) => entry.toolName === "canvas_create_quiz_item");

const questionOne: JsonObject = {
  id: "11",
  status: "mutable",
  position: 1,
  entry_type: "Item",
  points_possible: 2,
  entry: { title: "Mitochondria", item_body: "<p>What does the mitochondrion do?</p>" },
};

const questionTwo: JsonObject = {
  id: "12",
  status: "mutable",
  position: 2,
  entry_type: "Item",
  points_possible: 5,
  entry: {
    title: "Cell membrane",
    item_body: "<p>Which layer controls what enters the cell?</p>",
    interaction_type_slug: "choice",
    interaction_data: { choices: [{ id: choiceA, position: 1, item_body: "Membrane" }, { id: choiceB, position: 2, item_body: "Nucleus" }] },
    scoring_algorithm: "Equivalence",
    scoring_data: { value: choiceA },
    feedback: { correct: "Correct.", incorrect: "Look at the outer layer." },
  },
};

const newQuestion: JsonObject = {
  entry_type: "Item",
  points_possible: 3,
  entry: {
    title: "Ribosomes",
    item_body: "<p>Where are proteins assembled?</p>",
    interaction_type_slug: "choice",
    interaction_data: { choices: [{ id: choiceA, position: 1, item_body: "Ribosome" }, { id: choiceB, position: 2, item_body: "Vacuole" }] },
    scoring_algorithm: "Equivalence",
    scoring_data: { value: choiceA },
  },
};

function readResult(data: unknown): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      commandKind: "invoke_read",
      result: { ok: true, sent: true, truncated: false, data },
    },
  };
}

function fixture(overrides: { items?: unknown; item?: JsonObject; quiz?: JsonObject } = {}) {
  const calls: { tool: string; args: JsonObject }[] = [];
  const items = overrides.items ?? [questionOne, questionTwo];
  const quiz = overrides.quiz ?? { id: "77", course_id: "42", title: "Cell Structure Check" };
  const item = overrides.item ?? questionTwo;
  const runtime = {
    searchCatalog: ({ query }: { query: string }) => ({
      tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: !writeTools.has(query) } }],
    }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string, args: JsonObject) => {
      calls.push({ tool, args });
      expect((args._morrow as JsonObject).source_binding_id).toBe(sourceBindingId);
      if (tool === "canvas_get_single_course_courses") return readResult({ id: "42", name: "Biology" });
      if (tool === "canvas_get_new_quiz") return readResult(quiz);
      if (tool === "canvas_list_quiz_items") return readResult(items);
      if (tool === "canvas_get_quiz_item") return readResult(item);
      throw new Error(`unexpected tool ${tool}`);
    },
    resultPage: () => { throw new Error("unexpected artifact page"); },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

function plan(result: { structuredContent?: unknown }): JsonObject {
  return result.structuredContent as JsonObject;
}

function operations(result: { structuredContent?: unknown }): JsonObject[] {
  return plan(result).operations as JsonObject[];
}

/** Nothing these planners do may reach a Canvas write route. */
function expectNoWriteSent(calls: readonly { tool: string }[]): void {
  expect(calls.filter((call) => writeTools.has(call.tool))).toEqual([]);
}

describe("New Quiz question create planning", () => {
  it("refuses an item id the quiz still holds", async () => {
    const { runtime, calls } = fixture();
    const result = await planNewQuizItemCreate(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item: newQuestion,
      requested_item_id: "12",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("already holds question id 12");
    expect(plan(result).operations).toBeUndefined();
    expectNoWriteSent(calls);
  });

  it("plans one create for an id the quiz does not hold", async () => {
    const { runtime, calls } = fixture();
    const result = await planNewQuizItemCreate(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item: newQuestion,
      requested_item_id: "99",
    });
    expect(result.isError).not.toBe(true);
    const providerValidation = await fromJsonSchema(newQuizItemLifecycleWriteSchema(createOperation.inputSchema))["~standard"]
      .validate(operations(result)[0]!.arguments);
    expect(providerValidation.issues).toBeUndefined();
    expect(plan(result)).toMatchObject({
      action: "create",
      status: "planned",
      requested_item_id: "99",
      requested_item_id_state: "not_held_by_this_quiz",
      created_item_id: null,
      operation_count: 1,
    });
    expect(operations(result)).toHaveLength(1);
    expect(operations(result)[0]).toMatchObject({
      step: 1,
      tool: "canvas_create_quiz_item",
      arguments: {
        course_id: "42",
        assignment_id: "77",
        item_entry_type: "Item",
        item_points_possible: 3,
        item_entry_item_body: "<p>Where are proteins assembled?</p>",
        item_entry_interaction_type_slug: "choice",
        item_entry_scoring_algorithm: "Equivalence",
        item_entry_title: "Ribosomes",
        _morrow: { source_binding_id: sourceBindingId },
      },
      readback: { tool: "canvas_get_quiz_item", item_id: null, expect_item: "present", membership_authority: "canvas_list_quiz_items" },
    });
    // The current list is the only id evidence Canvas offers, and the plan says so.
    expect((plan(result).warnings as string[]).join(" ")).toContain("does not list the ids of questions somebody deleted earlier");
    expect((plan(result).limits as string[]).join(" ")).toContain("live-unverified");
    expectNoWriteSent(calls);
  });

  it("refuses a field the Canvas create route cannot carry", async () => {
    const { runtime, calls } = fixture();
    const dropped = await planNewQuizItemCreate(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item: { ...newQuestion, workflow_state: "active" },
    });
    expect(dropped.isError).toBe(true);
    expect(JSON.stringify(dropped)).toContain("workflow_state");

    const assignedId = await planNewQuizItemCreate(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item: { ...newQuestion, id: "99" },
    });
    expect(assignedId.isError).toBe(true);
    expect(JSON.stringify(assignedId)).toContain("Canvas assigns these question fields");
    expect(JSON.stringify(assignedId)).toContain("id");

    const entryId = await planNewQuizItemCreate(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item: { ...newQuestion, entry: { ...(newQuestion.entry as JsonObject), id: "99" } },
    });
    expect(entryId.isError).toBe(true);
    expect(JSON.stringify(entryId)).toContain("Canvas assigns these question fields");
    expect(JSON.stringify(entryId)).toContain("entry.id");

    for (const [field, value] of [
      ["status", "mutable"],
      ["entry_editable", true],
      ["immutable", false],
      ["created_at", "2026-09-08T12:00:00Z"],
      ["updated_at", "2026-09-08T12:00:00Z"],
      ["stimulus_quiz_entry_id", "31"],
    ] as const) {
      const assigned = await planNewQuizItemCreate(runtime, {
        source_binding_id: sourceBindingId,
        course_id: "42",
        quiz_id: "77",
        item: { ...newQuestion, [field]: value },
      });
      expect(assigned.isError).toBe(true);
      expect(JSON.stringify(assigned)).toContain(field);
    }
    expectNoWriteSent(calls);
  });

  it("refuses unsupported entry types and non-positive points", async () => {
    const { runtime, calls } = fixture();
    for (const entryType of ["Stimulus", "StimulusItem", "BankItem", "BankEntry", "item"]) {
      const result = await planNewQuizItemCreate(runtime, {
        source_binding_id: sourceBindingId,
        course_id: "42",
        quiz_id: "77",
        item: { ...newQuestion, entry_type: entryType },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('entry_type \\"Item\\"');
    }
    for (const points of [0, -1]) {
      const result = await planNewQuizItemCreate(runtime, {
        source_binding_id: sourceBindingId,
        course_id: "42",
        quiz_id: "77",
        item: { ...newQuestion, points_possible: points },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("greater than 0");
    }
    expectNoWriteSent(calls);
  });
});

describe("New Quiz question replacement planning", () => {
  it("refuses caller-supplied provider fields instead of silently dropping them", async () => {
    for (const requested of [
      { status: "mutable" },
      { entry_editable: true },
      { entry: { id: "91" } },
    ]) {
      const attempt = fixture();
      const result = await planNewQuizItemReplacement(attempt.runtime, {
        source_binding_id: sourceBindingId,
        course_id: "42",
        quiz_id: "77",
        item_id: "12",
        item: requested,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Canvas assigns these replacement fields");
      expectNoWriteSent(attempt.calls);
    }
  });

  it("keeps every field left out of the request", async () => {
    const { runtime, calls } = fixture();
    const result = await planNewQuizItemReplacement(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item_id: "12",
      item: { entry: { item_body: "<p>Which layer controls what enters and leaves the cell?</p>" } },
    });
    expect(result.isError).not.toBe(true);
    const create = operations(result)[1] as JsonObject;
    expect(create.arguments).toMatchObject({
      item_entry_type: "Item",
      item_points_possible: 5,
      item_position: 2,
      item_entry_item_body: "<p>Which layer controls what enters and leaves the cell?</p>",
      item_entry_title: "Cell membrane",
      item_entry_interaction_type_slug: "choice",
      item_entry_interaction_data: { choices: [{ id: choiceA, position: 1, item_body: "Membrane" }, { id: choiceB, position: 2, item_body: "Nucleus" }] },
      item_entry_scoring_algorithm: "Equivalence",
      item_entry_scoring_data: { value: choiceA },
      item_entry_feedback_correct: "Correct.",
      item_entry_feedback_incorrect: "Look at the outer layer.",
    });
    expect(plan(result).preserved_from_existing_item).toEqual([
      "entry.feedback.correct",
      "entry.feedback.incorrect",
      "entry.interaction_data",
      "entry.interaction_type_slug",
      "entry.scoring_algorithm",
      "entry.scoring_data",
      "entry.title",
      "entry_type",
      "points_possible",
      "position",
    ]);
    expect(plan(result).not_carried_to_replacement).toEqual([]);
    expectNoWriteSent(calls);
  });

  it("does not try to send documented provider-assigned response fields", async () => {
    const attempt = fixture({ item: { ...questionTwo, status: "mutable", created_at: "2026-09-08T12:00:00Z" } });
    const result = await planNewQuizItemReplacement(attempt.runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item_id: "12",
      item: { entry: { item_body: "<p>Replacement body</p>" } },
    });
    expect(result.isError).not.toBe(true);
    expect(plan(result).not_carried_to_replacement).toEqual([]);
    const create = operations(result)[1] as JsonObject;
    expect(create.arguments).not.toHaveProperty("status");
    expect(create.arguments).not.toHaveProperty("created_at");
    expectNoWriteSent(attempt.calls);
  });

  /**
   * The complete QuizItem and QuestionItem Canvas documents, with every provider-assigned field it
   * returns on a saved question. Source:
   * https://developerdocs.instructure.com/services/canvas/resources/new_quiz_items
   */
  const savedInDocumentedShape: JsonObject = {
    id: "12", position: 2, points_possible: 5, entry_type: "Item", entry_editable: true,
    stimulus_quiz_entry_id: null, status: "mutable", properties: null,
    entry: {
      id: "500", title: "Cell membrane", item_body: "<p>Which layer controls what enters the cell?</p>",
      calculator_type: "none", feedback: null, interaction_type_slug: "choice",
      interaction_data: { choices: [{ id: choiceA, position: 1, item_body: "Membrane" }, { id: choiceB, position: 2, item_body: "Nucleus" }] },
      properties: null, scoring_data: { value: choiceA }, answer_feedback: {}, scoring_algorithm: "Equivalence",
      created_at: "2013-01-15T15:00:00Z", updated_at: "2013-01-15T15:04:00Z",
    },
  };

  it("replaces a question that carries every provider-assigned field Canvas returns", async () => {
    const { runtime, calls } = fixture({ item: savedInDocumentedShape, items: [questionOne, savedInDocumentedShape] });
    const result = await planNewQuizItemReplacement(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
      item: { entry: { item_body: "<p>Replacement body</p>" } },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(plan(result).not_carried_to_replacement).toEqual([]);
    const create = operations(result)[1] as JsonObject;
    for (const argument of ["status", "entry_editable", "created_at", "updated_at", "properties",
      "item_status", "item_entry_editable", "item_created_at", "item_updated_at", "item_properties"]) {
      expect(create.arguments, argument).not.toHaveProperty(argument);
    }
    // A null optional field and an empty answer_feedback carry nothing, so neither is sent.
    expect(create.arguments).not.toHaveProperty("item_entry_properties");
    expect(create.arguments).not.toHaveProperty("item_entry_answer_feedback");
    expect(create.arguments).toMatchObject({ item_entry_item_body: "<p>Replacement body</p>", item_entry_scoring_algorithm: "Equivalence" });
    expectNoWriteSent(calls);
  });

  it("still refuses a caller that supplies a provider-assigned field or a null container", async () => {
    const cases: readonly [JsonObject, string][] = [
      [{ properties: null, entry: { item_body: "<p>New</p>" } }, "Canvas assigns these replacement fields"],
      [{ entry: { item_body: "<p>New</p>", created_at: "2026-09-08T12:00:00Z" } }, "Canvas assigns these replacement fields"],
      [{ entry: { item_body: "<p>New</p>", updated_at: "2026-09-08T12:00:00Z" } }, "Canvas assigns these replacement fields"],
      [{ entry: { item_body: "<p>New</p>", feedback: null } }, "Canvas cannot carry these replacement fields"],
    ];
    for (const [item, message] of cases) {
      const { runtime, calls } = fixture({ item: savedInDocumentedShape, items: [questionOne, savedInDocumentedShape] });
      const result = await planNewQuizItemReplacement(runtime, {
        source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12", item,
      });
      expect(result.isError, JSON.stringify(item)).toBe(true);
      expect(JSON.stringify(result), JSON.stringify(item)).toContain(message);
      expectNoWriteSent(calls);
    }
  });

  it("refuses loudly when Canvas returns a required question field as null", async () => {
    const broken = { ...savedInDocumentedShape, entry: { ...(savedInDocumentedShape.entry as JsonObject), item_body: null } };
    const { runtime, calls } = fixture({ item: broken, items: [questionOne, broken] });
    const result = await planNewQuizItemReplacement(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
      item: { entry: { title: "New title" } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("non-empty entry.item_body");
    expectNoWriteSent(calls);
  });

  it("refuses replacement when provider state or relationships make it unsafe", async () => {
    const cases: readonly [JsonObject, string][] = [
      [{ ...questionTwo, status: "published" }, "unsupported provider status"],
      [{ ...questionTwo, status: "immutable" }, "is not editable"],
      [{ ...questionTwo, stimulus_quiz_entry_id: "31" }, "belongs to stimulus 31"],
      [{ ...questionTwo, entry_editable: false }, "is not editable"],
      [{ ...questionTwo, immutable: true }, "is not editable"],
    ];
    for (const [item, reason] of cases) {
      const attempt = fixture({ item });
      const result = await planNewQuizItemReplacement(attempt.runtime, {
        source_binding_id: sourceBindingId,
        course_id: "42",
        quiz_id: "77",
        item_id: "12",
        item: { entry: { item_body: "<p>Replacement body</p>" } },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(reason);
      expect(plan(result).operations).toBeUndefined();
      expectNoWriteSent(attempt.calls);
    }
  });

  it("plans a delete and an add, states the non-atomic window, and never plans an in-place change", async () => {
    const { runtime, calls } = fixture();
    const result = await planNewQuizItemReplacement(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item_id: "12",
      item: { entry: { interaction_data: { choices: [{ id: choiceC, position: 1, item_body: "Cell membrane" }, { id: choiceD, position: 2, item_body: "Nucleus" }] }, scoring_data: { value: choiceC } } },
    });
    expect(result.isError).not.toBe(true);
    expect(plan(result)).toMatchObject({
      action: "replacement",
      status: "planned",
      item_id: "12",
      replacement_item_id: null,
      replacement_item_id_source: "assigned_by_canvas_at_create",
      atomic: false,
      in_place_update_planned: false,
      operation_count: 2,
    });
    expect(operations(result).map((operation) => [operation.step, operation.tool])).toEqual([
      [1, "canvas_delete_quiz_item"],
      [2, "canvas_create_quiz_item"],
    ]);
    expect(operations(result)[0]).toMatchObject({
      arguments: { course_id: "42", assignment_id: "77", item_id: "12" },
      readback: { tool: "canvas_get_quiz_item", item_id: "12", expect_item: "absent", membership_authority: "canvas_list_quiz_items" },
    });
    const warnings = (plan(result).warnings as string[]).join(" ");
    expect(warnings).toContain("not atomic");
    expect(warnings).toContain("the quiz holds one fewer question");
    expect(warnings).toContain("canvas_list_quiz_items is the authority");
    expect(warnings).toContain("new question with a new id");
    expect(warnings).toContain("The add asks Canvas for position 2");
    expect(JSON.stringify(result)).not.toContain("canvas_update_quiz_item");
    expect(String((result.content[0] as { text: string }).text)).toContain("not atomic");
    expectNoWriteSent(calls);
  });

  it("hashes Canvas's renumbered post-delete membership when replacing the first, middle, or final item", async () => {
    const items = ["11", "12", "13", "14"].map((id, index) => ({
      ...questionTwo,
      id,
      position: index + 1,
      entry: { ...(questionTwo.entry as JsonObject), title: `Question ${id}` },
    }));
    for (const itemId of ["11", "12", "14"]) {
      const selected = items.find((item) => item.id === itemId)!;
      const attempt = fixture({ items, item: selected });
      const result = await planNewQuizItemReplacement(attempt.runtime, {
        source_binding_id: sourceBindingId,
        course_id: "42",
        quiz_id: "77",
        item_id: itemId,
        item: { entry: { item_body: `<p>Replacement for ${itemId}</p>` } },
      });
      expect(result.isError, itemId).not.toBe(true);
      const create = operations(result)[1] as JsonObject;
      const guard = create.arguments.morrow_new_quiz_item_lifecycle_guard as JsonObject;
      const removedPosition = selected.position as number;
      const postDeleteMembership = items
        .filter((item) => item.id !== itemId)
        .map((item) => ({
          id: item.id,
          position: (item.position as number) > removedPosition ? (item.position as number) - 1 : item.position,
          entry_type: item.entry_type,
        }));
      expect(guard.before_items_sha256, itemId).toBe(sha256Json(postDeleteMembership));
      const filteredWithoutRenumbering = items.filter((item) => item.id !== itemId).map((item) => ({
        id: item.id,
        position: item.position,
        entry_type: item.entry_type,
      }));
      if (removedPosition < items.length) {
        expect(guard.before_items_sha256, itemId).not.toBe(sha256Json(filteredWithoutRenumbering));
      } else {
        expect(guard.before_items_sha256, itemId).toBe(sha256Json(filteredWithoutRenumbering));
      }
      expect(create.arguments.item_position, itemId).toBe(removedPosition);
      expectNoWriteSent(attempt.calls);
    }
  });

  it("refuses a replacement that changes nothing, an absent question, and a question that is not an item", async () => {
    const unchanged = fixture();
    const sameItem = await planNewQuizItemReplacement(unchanged.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
      item: { entry: { title: "Cell membrane" } },
    });
    expect(sameItem.isError).toBe(true);
    expect(JSON.stringify(sameItem)).toContain("same as the current question");

    const absent = fixture();
    const missing = await planNewQuizItemReplacement(absent.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "13",
      item: { entry: { item_body: "<p>New stem</p>" } },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toContain("does not hold question 13");

    const stimulus = fixture({ items: [questionOne, { ...questionTwo, entry_type: "Stimulus" }] });
    const notAnItem = await planNewQuizItemReplacement(stimulus.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
      item: { entry: { item_body: "<p>New stem</p>" } },
    });
    expect(notAnItem.isError).toBe(true);
    expect(JSON.stringify(notAnItem)).toContain("Morrow replaces question items only");

    for (const attempt of [unchanged, absent, stimulus]) expectNoWriteSent(attempt.calls);
  });
});

describe("New Quiz question delete planning", () => {
  it("plans nothing for a question the quiz no longer holds", async () => {
    const { runtime, calls } = fixture();
    const result = await planNewQuizItemDelete(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "13",
    });
    expect(result.isError).not.toBe(true);
    expect(plan(result)).toMatchObject({
      action: "delete",
      status: "already_absent",
      item_id: "13",
      verification_state: "verified_absent",
      operation_count: 0,
    });
    expect(plan(result).operations).toEqual([]);
    expect(String((result.content[0] as { text: string }).text)).toContain("does not hold question 13");
    expect(calls.map((call) => call.tool)).not.toContain("canvas_get_quiz_item");
    expectNoWriteSent(calls);
  });

  it("plans one delete for a question the quiz holds", async () => {
    const { runtime, calls } = fixture();
    const result = await planNewQuizItemDelete(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
    });
    expect(result.isError).not.toBe(true);
    expect(plan(result)).toMatchObject({
      action: "delete",
      status: "planned",
      item_id: "12",
      item_position: 2,
      verification_state: "verified_present",
      operation_count: 1,
    });
    expect(operations(result)).toHaveLength(1);
    expect(operations(result)[0]).toMatchObject({
      step: 1,
      tool: "canvas_delete_quiz_item",
      arguments: { course_id: "42", assignment_id: "77", item_id: "12", _morrow: { source_binding_id: sourceBindingId } },
      readback: { tool: "canvas_get_quiz_item", item_id: "12", expect_item: "absent" },
    });
    expect(String((result.content[0] as { text: string }).text)).toContain('delete question 2, "Cell membrane" (item id 12)');
    expect((plan(result).warnings as string[]).join(" ")).toContain("No Canvas route restores a deleted New Quiz question");
    expectNoWriteSent(calls);
  });

  it("refuses a Stimulus removal", async () => {
    const { runtime, calls } = fixture({ items: [questionOne, { ...questionTwo, entry_type: "Stimulus" }] });
    const result = await planNewQuizItemDelete(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("no evidence of what deleting that entry type does to its dependencies");
    expectNoWriteSent(calls);
  });

  it("refuses removal when provider status is unknown or immutable", async () => {
    for (const item of [
      { ...questionTwo, status: "published" },
      { ...questionTwo, status: "immutable" },
      { ...questionTwo, entry_editable: false },
      { ...questionTwo, immutable: true },
    ]) {
      const attempt = fixture({ item });
      const result = await planNewQuizItemDelete(attempt.runtime, {
        source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
      });
      expect(result.isError).toBe(true);
      expect(plan(result).operations).toBeUndefined();
      expectNoWriteSent(attempt.calls);
    }
  });
});

describe("New Quiz question list checks", () => {
  it("refuses a list with a repeated position", async () => {
    const { runtime, calls } = fixture({ items: [questionOne, { ...questionTwo, position: 1 }] });
    const result = await planNewQuizItemDelete(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("listed two questions at position 1");
    expectNoWriteSent(calls);
  });

  it("refuses a list with a repeated id, a missing position, or a missing id", async () => {
    const repeatedId = fixture({ items: [questionOne, { ...questionTwo, id: "11" }] });
    const repeated = await planNewQuizItemCreate(repeatedId.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item: newQuestion,
    });
    expect(repeated.isError).toBe(true);
    expect(JSON.stringify(repeated)).toContain("listed question id 11 more than once");

    const noPosition = fixture({ items: [questionOne, { ...questionTwo, position: 0 }] });
    const unnumbered = await planNewQuizItemCreate(noPosition.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item: newQuestion,
    });
    expect(unnumbered.isError).toBe(true);
    expect(JSON.stringify(unnumbered)).toContain("no whole question number");

    const noId = fixture({ items: [questionOne, { ...questionTwo, id: "" }] });
    const unnamed = await planNewQuizItemCreate(noId.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item: newQuestion,
    });
    expect(unnamed.isError).toBe(true);
    expect(JSON.stringify(unnamed)).toContain("no exact id");

    for (const attempt of [repeatedId, noPosition, noId]) expectNoWriteSent(attempt.calls);
  });
});

describe("New Quiz Hot Spot routing", () => {
  const hotSpot: JsonObject = {
    entry_type: "Item",
    points_possible: 3,
    entry: {
      title: "Label the mitochondrion",
      item_body: "<p>Select the mitochondrion.</p>",
      interaction_type_slug: "hot-spot",
      interaction_data: {},
      scoring_algorithm: "HotSpot",
      scoring_data: { value: { type: "oval", coordinates: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }] } },
    },
  };

  function hotSpotFixture() {
    const { runtime, calls } = fixture();
    const routed: JsonObject[] = [];
    (runtime as unknown as { planCanvasNewQuizHotSpotCreate: unknown }).planCanvasNewQuizHotSpotCreate = async (input: JsonObject) => {
      routed.push(input);
      return { structuredContent: { operationId: "op:hot-spot" } };
    };
    return { runtime, calls, routed };
  }

  it("sends every Hot Spot create to the reviewed image planner, never to the plain create", async () => {
    const { runtime, calls, routed } = hotSpotFixture();
    const result = await planNewQuizItemCreate(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item: hotSpot,
      material_path: "materials/cell.png",
    });
    expect(result.isError).not.toBe(true);
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ material_path: "materials/cell.png" });
    expectNoWriteSent(calls);
  });

  it("routes a Hot Spot with no image to the same planner, which refuses it", async () => {
    const { runtime, routed } = hotSpotFixture();
    await planNewQuizItemCreate(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item: hotSpot,
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]).not.toHaveProperty("material_path");
    await expect(prepareNewQuizHotSpotCreate(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item: hotSpot,
    }, AbortSignal.timeout(5_000))).rejects.toThrow("material_path");
  });

  it("refuses a reviewed image for a question that is not a Hot Spot", async () => {
    const { runtime } = hotSpotFixture();
    await expect(prepareNewQuizHotSpotCreate(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77",
      item: newQuestion, material_path: "materials/cell.png",
    }, AbortSignal.timeout(5_000))).rejects.toThrow("Hot Spot");
  });

  it("refuses a Hot Spot that carries its own image URL", async () => {
    const { runtime } = hotSpotFixture();
    const carried = { ...hotSpot, entry: { ...(hotSpot.entry as JsonObject), interaction_data: { image_url: "https://elsewhere.example/x.png" } } };
    await expect(prepareNewQuizHotSpotCreate(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77",
      item: carried, material_path: "materials/cell.png",
    }, AbortSignal.timeout(5_000))).rejects.toThrow("image_url");
  });

  it("freezes the complete saved question list the reviewed create is bound to", async () => {
    const { runtime } = hotSpotFixture();
    const prepared = await prepareNewQuizHotSpotCreate(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77",
      item: hotSpot, material_path: "materials/cell.png",
    }, AbortSignal.timeout(5_000));
    expect(prepared.beforeItemsSha256).toBe(sha256Json([
      { id: "11", position: 1, entry_type: "Item" },
      { id: "12", position: 2, entry_type: "Item" },
    ]));
    expect(Object.hasOwn(((prepared.item.entry as JsonObject).interaction_data as JsonObject), "image_url")).toBe(false);
  });
});

describe("New Quiz question lifecycle tool surface", () => {
  it("registers the three planners that answer over MCP", async () => {
    const { runtime, calls } = fixture();
    const client = new Client({ name: "new-quiz-item-lifecycle-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => {
      const mcp = new McpServer({ name: "new-quiz-item-lifecycle-test", version: "1" });
      registerNewQuizItemLifecycleTools(mcp, runtime);
      return mcp;
    }, { transport: b });
    await client.connect(a);
    try {
      const listed = (await client.listTools()).tools;
      for (const name of ["morrow_plan_new_quiz_item_replacement", "morrow_plan_new_quiz_item_delete"]) {
        expect(listed.find((tool) => tool.name === name), name).toMatchObject({
          annotations: { readOnlyHint: true, destructiveHint: false },
        });
      }
      // The create planner stages a reviewed Hot Spot image and reserves one
      // approval-bound operation, so it is not a read-only planner.
      expect(listed.find((tool) => tool.name === "morrow_plan_new_quiz_item_create")).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: false },
      });
      expect(listed.find((tool) => tool.name === "morrow_plan_new_quiz_item_replacement")?.description).toContain("not atomic");
      const result = await client.callTool({
        name: "morrow_plan_new_quiz_item_delete",
        arguments: { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12" },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        schema: "morrow.new-quiz-item-lifecycle.plan.v1",
        action: "delete",
        status: "planned",
        operation_count: 1,
      });
    } finally {
      await client.close();
      await server.close();
    }
    expectNoWriteSent(calls);
  });
});
