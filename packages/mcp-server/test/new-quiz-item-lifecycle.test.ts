import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@morrow/contracts";
import {
  planNewQuizItemCreate,
  planNewQuizItemDelete,
  planNewQuizItemReplacement,
  registerNewQuizItemLifecycleTools,
} from "../src/new-quiz-item-lifecycle.js";
import type { GatewayRuntime } from "../src/runtime.js";

const sourceBindingId = "canvas:instructor";
const writeTools = new Set(["canvas_create_quiz_item", "canvas_delete_quiz_item", "canvas_update_quiz_item"]);

const questionOne: JsonObject = {
  id: "11",
  position: 1,
  entry_type: "Item",
  points_possible: 2,
  entry: { title: "Mitochondria", item_body: "<p>What does the mitochondrion do?</p>" },
};

const questionTwo: JsonObject = {
  id: "12",
  position: 2,
  entry_type: "Item",
  points_possible: 5,
  // `status` is a field the Canvas create route has no parameter for. A
  // delete-then-add cannot carry it, and the plan has to say so.
  status: "published",
  entry: {
    title: "Cell membrane",
    item_body: "<p>Which layer controls what enters the cell?</p>",
    interaction_type_slug: "choice",
    interaction_data: { choices: [{ id: "a", item_body: "Membrane" }, { id: "b", item_body: "Nucleus" }] },
    scoring_algorithm: "Equivalence",
    scoring_data: { value: "a" },
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
    interaction_data: { choices: [{ id: "a", item_body: "Ribosome" }, { id: "b", item_body: "Vacuole" }] },
    scoring_algorithm: "Equivalence",
    scoring_data: { value: "a" },
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
    expect(JSON.stringify(assignedId)).toContain("Canvas assigns the ids of a created question");

    const entryId = await planNewQuizItemCreate(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item: { ...newQuestion, entry: { ...(newQuestion.entry as JsonObject), id: "99" } },
    });
    expect(entryId.isError).toBe(true);
    expect(JSON.stringify(entryId)).toContain("Canvas assigns the ids of a created question");
    expectNoWriteSent(calls);
  });
});

describe("New Quiz question replacement planning", () => {
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
      item_position: "2",
      item_entry_item_body: "<p>Which layer controls what enters and leaves the cell?</p>",
      item_entry_title: "Cell membrane",
      item_entry_interaction_type_slug: "choice",
      item_entry_interaction_data: { choices: [{ id: "a", item_body: "Membrane" }, { id: "b", item_body: "Nucleus" }] },
      item_entry_scoring_algorithm: "Equivalence",
      item_entry_scoring_data: { value: "a" },
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
    // A field the create route cannot carry is named, never silently dropped.
    expect(plan(result).not_carried_to_replacement).toEqual(["status"]);
    expect((plan(result).warnings as string[]).join(" ")).toContain("the replacement will not have them: status");
    expectNoWriteSent(calls);
  });

  it("plans a delete and an add, states the non-atomic window, and never plans an in-place change", async () => {
    const { runtime, calls } = fixture();
    const result = await planNewQuizItemReplacement(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item_id: "12",
      item: { entry: { interaction_data: { choices: [{ id: "c", item_body: "Cell membrane" }, { id: "d", item_body: "Nucleus" }] }, scoring_data: { value: "c" } } },
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
    expect(JSON.stringify(result)).toContain("no evidence of what happens to the questions bound to a Stimulus");
    expectNoWriteSent(calls);
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

describe("New Quiz question lifecycle tool surface", () => {
  it("registers three read-only planners that answer over MCP", async () => {
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
      for (const name of ["morrow_plan_new_quiz_item_create", "morrow_plan_new_quiz_item_replacement", "morrow_plan_new_quiz_item_delete"]) {
        expect(listed.find((tool) => tool.name === name), name).toMatchObject({
          annotations: { readOnlyHint: true, destructiveHint: false },
        });
      }
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
