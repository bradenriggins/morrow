import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { planNewQuizItemCreate } from "../src/new-quiz-item-lifecycle.js";
import { QUIZ_ITEM_PAYLOAD_REASONS, quizItemPayloadMessage, quizItemPayloadReason } from "../src/quiz-item-payload.js";
import type { GatewayRuntime } from "../src/runtime.js";

/**
 * The Morrow Bridge module that holds the same rules. The New Quiz question
 * planners check a payload in TypeScript because the extension module has no
 * declaration file, so these tests run both implementations over the one shared
 * case list and require the same verdict from each.
 */
type BridgePayload = { validateQuizItemPayload(item: unknown): string | null };
type PayloadCase = { readonly name: string; readonly item: unknown; readonly reason: string | null };
type PayloadCases = {
  readonly CASES: readonly PayloadCase[];
  readonly PASS_THROUGH_SLUGS: readonly string[];
  readonly UNCHECKABLE_ENTRY: JsonObject;
  readonly IMAGE: string;
  item(entry: JsonObject): JsonObject;
};

async function bridgePayload(): Promise<BridgePayload> {
  return await import(new URL("../../../connector/extension/src/quiz-item-payload.js", import.meta.url).href) as BridgePayload;
}

async function payloadCases(): Promise<PayloadCases> {
  return await import(new URL("../../../scripts/test/lib/quiz-item-payload-cases.mjs", import.meta.url).href) as PayloadCases;
}

describe("New Quiz question payload rules", () => {
  it("reaches the same verdict as the Morrow Bridge module for every case", async () => {
    const bridge = await bridgePayload();
    const { CASES } = await payloadCases();
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    for (const { name, item, reason } of CASES) {
      expect(quizItemPayloadReason(item), name).toBe(reason);
      expect(quizItemPayloadReason(item), name).toBe(bridge.validateQuizItemPayload(item));
    }
  });

  it("reads a question written flat exactly as one wrapped in its item record", async () => {
    const { CASES } = await payloadCases();
    for (const { name, item, reason } of CASES) {
      const entry = (item as JsonObject | null)?.entry;
      if (!entry || typeof entry !== "object") continue;
      expect(quizItemPayloadReason(entry), name).toBe(reason);
    }
  });

  it("sends every interaction type it cannot read, and checks the media of all of them", async () => {
    const cases = await payloadCases();
    // The same payload, refused as a choice question, is accepted under every
    // one of the eight types an earlier hard allowlist refused before Canvas
    // ever saw them.
    expect(quizItemPayloadReason(cases.item({ interaction_type_slug: "choice", ...cases.UNCHECKABLE_ENTRY }))).toBe("choice_too_few");
    for (const slug of cases.PASS_THROUGH_SLUGS) {
      const passed = cases.item({ interaction_type_slug: slug, ...cases.UNCHECKABLE_ENTRY });
      expect(quizItemPayloadReason(passed), slug).toBeNull();
      const described = cases.item({ interaction_type_slug: slug, ...cases.UNCHECKABLE_ENTRY, item_body: `<p>Sort these.</p>${cases.IMAGE}` });
      const undescribed = cases.item({ interaction_type_slug: slug, ...cases.UNCHECKABLE_ENTRY, item_body: '<p>Sort these.</p><img src="/courses/42/files/9">' });
      expect(quizItemPayloadReason(described), slug).toBeNull();
      expect(quizItemPayloadReason(undescribed), slug).toBe("media_image_alt_missing");
    }
  });

  it("has one plain sentence for every reason it can return", async () => {
    const { CASES } = await payloadCases();
    const returned = new Set(CASES.map((entry) => entry.reason).filter((reason): reason is string => reason !== null));
    expect(returned.size).toBeGreaterThanOrEqual(20);
    for (const reason of returned) {
      expect(QUIZ_ITEM_PAYLOAD_REASONS, reason).toContain(reason);
    }
    for (const reason of QUIZ_ITEM_PAYLOAD_REASONS) {
      const message = quizItemPayloadMessage(reason);
      expect(message, reason).not.toContain(reason);
      expect(message.endsWith("."), reason).toBe(true);
      expect(message.length, reason).toBeGreaterThan(30);
    }
    // A reason with no sentence names itself rather than reading as nothing.
    expect(quizItemPayloadMessage("not_a_reason")).toBe("Morrow refused this question payload: not_a_reason.");
  });
});

const sourceBindingId = "canvas:instructor";
const writeTools = new Set(["canvas_create_quiz_item", "canvas_delete_quiz_item", "canvas_update_quiz_item"]);

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

function fixture() {
  const calls: { tool: string }[] = [];
  const runtime = {
    searchCatalog: ({ query }: { query: string }) => ({
      tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: !writeTools.has(query) } }],
    }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string) => {
      calls.push({ tool });
      if (tool === "canvas_get_single_course_courses") return readResult({ id: "42", name: "Biology" });
      if (tool === "canvas_get_new_quiz") return readResult({ id: "77", course_id: "42", title: "Cell Structure Check" });
      if (tool === "canvas_list_quiz_items") return readResult([]);
      throw new Error(`unexpected tool ${tool}`);
    },
    resultPage: () => { throw new Error("unexpected artifact page"); },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

function question(entry: JsonObject): JsonObject {
  return { entry_type: "Item", points_possible: 1, entry: { title: "Organelles", scoring_algorithm: "Equivalence", ...entry } };
}

const readableQuestion: JsonObject = question({
  item_body: '<p>Which organelle makes most of a cell\'s ATP?</p><img src="/courses/42/files/9" alt="A cell diagram">',
  interaction_type_slug: "choice",
  interaction_data: { choices: [{ id: "c1", item_body: "Mitochondrion" }, { id: "c2", item_body: "Ribosome" }] },
  scoring_data: { value: "c1" },
});

describe("New Quiz question create planning checks the payload", () => {
  it("plans a question whose images name their alternative text", async () => {
    const { runtime } = fixture();
    const result = await planNewQuizItemCreate(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item: readableQuestion });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as JsonObject).status).toBe("planned");
  });

  it("refuses an image with no alternative text and reads no Canvas route", async () => {
    const { runtime, calls } = fixture();
    const item = question({
      item_body: '<p>Which organelle makes most of a cell\'s ATP?</p><img src="/courses/42/files/9">',
      interaction_type_slug: "choice",
      interaction_data: { choices: [{ id: "c1", item_body: "Mitochondrion" }, { id: "c2", item_body: "Ribosome" }] },
      scoring_data: { value: "c1" },
    });
    const result = await planNewQuizItemCreate(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("no alt attribute") as unknown as string });
    // The payload is checked before anything is read, so a question a person has
    // to fix costs no Canvas request.
    expect(calls).toEqual([]);
  });

  it("refuses an answer key that names a choice the question does not have", async () => {
    const { runtime, calls } = fixture();
    const item = question({
      item_body: "<p>Which organelle makes most of a cell's ATP?</p>",
      interaction_type_slug: "choice",
      interaction_data: { choices: [{ id: "c1", item_body: "Mitochondrion" }, { id: "c2", item_body: "Ribosome" }] },
      scoring_data: { value: "c9" },
    });
    const result = await planNewQuizItemCreate(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("names a choice this question does not have") as unknown as string });
    expect(calls).toEqual([]);
  });

  it("plans a question of an interaction type it cannot read", async () => {
    const { runtime } = fixture();
    const item = question({
      item_body: "<p>Sort these organelles by size.</p>",
      interaction_type_slug: "ordering",
      interaction_data: { choices: [{ id: "c1", item_body: "Mitochondrion" }] },
      scoring_data: { value: ["c1"] },
    });
    const result = await planNewQuizItemCreate(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as JsonObject).status).toBe("planned");
  });
});
