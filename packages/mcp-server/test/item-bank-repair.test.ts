import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { planItemBankQuestionImageAltRepair, registerItemBankRepairTool } from "../src/item-bank-repair.js";
import type { GatewayRuntime } from "../src/runtime.js";

const sourceBindingId = "canvas:instructor";
const courseId = "42";
const bankId = "91";
const bankEntryId = "701";
const itemId = "501";
const imageSrc = "/courses/42/files/12";
const body = `<p>Identify the labelled structure.</p><img src="${imageSrc}">`;

const question: JsonObject = {
  id: itemId,
  entry_type: "Item",
  updated_at: "2026-09-01T10:00:00Z",
  entry: {
    title: "Cell membrane image",
    item_body: body,
    interaction_type_slug: "choice",
    interaction_data: { choices: [{ id: "a", item_body: "Membrane" }, { id: "b", item_body: "Nucleus" }] },
    scoring_algorithm: "Equivalence",
    scoring_data: { value: "a" },
    updated_at: "2026-09-01T10:00:00Z",
  },
};
const bankEntry: JsonObject = { id: bankEntryId, entry_type: "Item", entry_id: itemId };

/**
 * The Morrow Bridge modules the Item Banks frame enforces. The planner mirrors
 * their rules in TypeScript, so these tests run both implementations over the
 * same question and the same record and require the same answer.
 */
type BridgeGuard = {
  ITEM_BANK_GUARD_FIELDS: readonly string[];
  validItemBankGuard(guard: unknown): boolean;
  itemBankItemDigest(item: unknown): Promise<string>;
  itemBankProtectedStateDigest(item: unknown): Promise<string | null>;
  applyItemBankImageAlt(body: string, guard: JsonObject): Promise<{ body?: string; error?: string }>;
};
type BridgeFanOut = {
  establishFanOut(input: {
    bankId: string; courseId: string;
    sources: unknown; consumers: unknown; unreachable: unknown; observedAt: unknown;
  }): Promise<JsonObject | null>;
  validFanOut(record: unknown, options: {
    bankId: string; courseId: string; acknowledgedCourseIds: unknown; now: number;
  }): Promise<string | null>;
};

async function bridgeGuard(): Promise<BridgeGuard> {
  return await import(new URL("../../../connector/extension/src/item-bank-guard.js", import.meta.url).href) as BridgeGuard;
}

async function bridgeFanOut(): Promise<BridgeFanOut> {
  return await import(new URL("../../../connector/extension/src/item-bank-fan-out.js", import.meta.url).href) as BridgeFanOut;
}

const readSources = (exhausted: boolean) => [
  { name: "bank_entries", pages: 1, exhausted: true },
  { name: "shared_banks", pages: 1, exhausted: true },
  { name: "quiz_uses", pages: 1, exhausted },
];
const consumers = [
  { course_id: courseId, entity_type: "quiz_use", entity_id: "301" },
  { course_id: "77", entity_type: "shared_bank", entity_id: "77" },
  { course_id: "88", entity_type: "shared_bank", entity_id: "88" },
];

/** A record built by the Bridge module itself, so no test writes a fan-out record by hand. */
async function fanOutRecord(options: { complete?: boolean; observedAt?: Date } = {}): Promise<JsonObject> {
  const complete = options.complete ?? true;
  const record = await (await bridgeFanOut()).establishFanOut({
    bankId,
    courseId,
    sources: readSources(complete),
    consumers,
    unreachable: complete ? [] : ["quiz_uses"],
    observedAt: options.observedAt ?? new Date(),
  });
  expect(record).not.toBeNull();
  return record!;
}

function readResult(data: unknown): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read",
      result: { ok: true, sent: true, truncated: false, data },
    },
  };
}

const connectorTool = (query: string, upstreamId: string): JsonObject => ({
  publicName: query, upstreamName: query, upstreamId,
  annotations: { readOnlyHint: query !== "canvas_item_bank_update_item" },
  capability: { route: { backend: "canvas-connector" } },
});

function fixture(overrides: { item?: JsonObject; entry?: JsonObject; catalog?: (query: string) => JsonObject[] } = {}) {
  const plans: { tool: string; arguments: Readonly<Record<string, unknown>> }[] = [];
  const reads: string[] = [];
  const currentItem = overrides.item ?? question;
  const currentEntry = overrides.entry ?? bankEntry;
  const catalogTools = (query: string): JsonObject[] => overrides.catalog?.(query) ?? [connectorTool(query, "canvas-session")];
  const runtime = {
    // The guarded question write is a private source tool, so it is not in the
    // searchable catalog and the planner resolves it from the merged one.
    catalog: { tools: catalogTools("canvas_item_bank_update_item") },
    searchCatalog: ({ query }: { query: string }) => ({ tools: catalogTools(query) }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string, args: JsonObject) => {
      expect((args._morrow as JsonObject).source_binding_id).toBe(sourceBindingId);
      reads.push(tool);
      if (tool === "canvas_get_single_course_courses") return readResult({ id: courseId, name: "Biology" });
      if (tool === "canvas_item_bank_get_entry") return readResult(currentEntry);
      if (tool === "canvas_item_bank_get_item") return readResult(currentItem);
      throw new Error(`unexpected tool ${tool}`);
    },
    resultPage: () => { throw new Error("unexpected artifact page"); },
    planOperationWithCurrentEditPermission: async (tool: string, args: Readonly<Record<string, unknown>>) => {
      plans.push({ tool, arguments: args });
      return { content: [], structuredContent: { effectState: "awaiting_approval" } };
    },
  } as unknown as GatewayRuntime;
  return { runtime, plans, reads };
}

async function request(overrides: Partial<JsonObject> = {}): Promise<JsonObject> {
  return {
    source_binding_id: sourceBindingId,
    course_id: courseId,
    bank_id: bankId,
    bank_entry_id: bankEntryId,
    item_id: itemId,
    item_sha256: sha256Json(question),
    image_index: 1,
    image_src_sha256: sha256Text(imageSrc),
    alt_text: "Diagram of a cell membrane",
    fan_out: await fanOutRecord(),
    acknowledged_course_ids: ["77", "88"],
    ...overrides,
  };
}

function planText(result: CallToolResult): string {
  return (result.content as { type: string; text: string }[]).map((entry) => entry.text).join("\n");
}

describe("item bank question image alternative-text planning", () => {
  it("names both external courses before the change and freezes a guard the Item Banks frame accepts", async () => {
    const { runtime, plans, reads } = fixture();
    const input = await request();
    const result = await planItemBankQuestionImageAltRepair(runtime, input as never);

    expect(result.isError).not.toBe(true);
    expect(reads.sort()).toEqual(["canvas_get_single_course_courses", "canvas_item_bank_get_entry", "canvas_item_bank_get_item"]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.tool).toBe("canvas_item_bank_update_item");
    expect(Object.keys(plans[0]!.arguments).sort()).toEqual(["_morrow", "bank_id", "item_id", "morrow_item_bank_guard"]);
    expect(plans[0]!.arguments._morrow).toEqual({ source_binding_id: sourceBindingId });

    const text = planText(result);
    const affected = text.indexOf("course 77, course 88");
    expect(affected).toBeGreaterThan(-1);
    expect(text).toContain("2 other courses");
    // The courses this bank reaches are named before the change is described.
    expect(affected).toBeLessThan(text.indexOf("alternative-text repair for image 1"));
    expect(text).toContain("Diagram of a cell membrane");

    const guard = plans[0]!.arguments.morrow_item_bank_guard as JsonObject;
    const { ITEM_BANK_GUARD_FIELDS, validItemBankGuard, itemBankItemDigest, itemBankProtectedStateDigest, applyItemBankImageAlt } = await bridgeGuard();
    expect(Object.keys(guard).sort()).toEqual([...ITEM_BANK_GUARD_FIELDS].sort());
    expect(validItemBankGuard(guard)).toBe(true);
    expect(guard).toMatchObject({
      kind: "item_bank_entry_image_alt", course_id: courseId, bank_id: bankId, bank_entry_id: bankEntryId,
      item_id: itemId, entry_type: "Item", image_index: 1, image_src_sha256: sha256Text(imageSrc),
      alt_text: "Diagram of a cell membrane", acknowledged_course_ids: ["77", "88"],
    });
    // The digests the frame recomputes before it sends anything.
    expect(guard.item_sha256).toBe(await itemBankItemDigest(question));
    expect(guard.protected_state_sha256).toBe(await itemBankProtectedStateDigest(question));
    const applied = await applyItemBankImageAlt(body, guard);
    expect(applied.error).toBeUndefined();
    expect(applied.body).toContain('alt="Diagram of a cell membrane"');
    expect(await (await bridgeFanOut()).validFanOut(guard.fan_out, {
      bankId, courseId, acknowledgedCourseIds: guard.acknowledged_course_ids, now: Date.now(),
    })).toBeNull();
  });

  it("discloses neither the question source nor the image address", async () => {
    const { runtime, plans } = fixture();
    const result = await planItemBankQuestionImageAltRepair(runtime, await request() as never);
    expect(result.isError).not.toBe(true);
    for (const rendered of [JSON.stringify(plans), JSON.stringify(result)]) {
      expect(rendered).not.toContain(body);
      expect(rendered).not.toContain(imageSrc);
      expect(rendered).not.toContain("Identify the labelled structure");
    }
  });

  it("refuses an ambiguous Canvas connection, and a read that is not on the connection that will send the change", async () => {
    const ambiguous = fixture({
      catalog: (query) => query === "canvas_item_bank_update_item"
        ? [connectorTool(query, "canvas-session"), connectorTool(query, "canvas-second-session")]
        : [connectorTool(query, "canvas-session")],
    });
    const ambiguousResult = await planItemBankQuestionImageAltRepair(ambiguous.runtime, await request() as never);
    expect(ambiguousResult.isError).toBe(true);
    expect(planText(ambiguousResult)).toContain("Canvas connection needed for this item bank question is unavailable");
    // Nothing is read until one connection is named, so an ambiguous
    // connection cannot mix a reading of one Canvas with a change to another.
    expect(ambiguous.reads).toHaveLength(0);
    expect(ambiguous.plans).toHaveLength(0);

    const split = fixture({
      catalog: (query) => [connectorTool(query, query === "canvas_item_bank_get_item" ? "canvas-second-session" : "canvas-session")],
    });
    const splitResult = await planItemBankQuestionImageAltRepair(split.runtime, await request() as never);
    expect(splitResult.isError).toBe(true);
    expect(planText(splitResult)).toContain("No change was planned.");
    expect(split.reads).not.toContain("canvas_item_bank_get_item");
    expect(split.plans).toHaveLength(0);
  });

  it("refuses a stale question digest before it plans anything", async () => {
    const { runtime, plans } = fixture();
    const result = await planItemBankQuestionImageAltRepair(runtime, await request({ item_sha256: "0".repeat(64) }) as never);
    expect(result.isError).toBe(true);
    expect(planText(result)).toContain("changed since this accessibility signal");
    expect(plans).toHaveLength(0);
  });

  it("refuses an incomplete fan-out and says an unread source is not an empty list", async () => {
    const { runtime, plans } = fixture();
    const record = await fanOutRecord({ complete: false });
    expect(record.complete).toBe(false);
    expect(await (await bridgeFanOut()).validFanOut(record, {
      bankId, courseId, acknowledgedCourseIds: ["77", "88"], now: Date.now(),
    })).toBe("incomplete_unread_source_is_not_an_empty_fan_out");

    const result = await planItemBankQuestionImageAltRepair(runtime, await request({ fan_out: record }) as never);
    expect(result.isError).toBe(true);
    expect(planText(result)).toContain("is not an empty list of courses");
    expect(plans).toHaveLength(0);
  });

  it("refuses a missing acknowledgement and an acknowledgement of a course the bank does not reach", async () => {
    const missing = fixture();
    const missingResult = await planItemBankQuestionImageAltRepair(missing.runtime, await request({ acknowledged_course_ids: ["77"] }) as never);
    expect(missingResult.isError).toBe(true);
    expect(planText(missingResult)).toContain("not exactly the courses this item bank reaches");
    expect(missing.plans).toHaveLength(0);

    const extra = fixture();
    const extraResult = await planItemBankQuestionImageAltRepair(extra.runtime, await request({ acknowledged_course_ids: ["77", "88", "99"] }) as never);
    expect(extraResult.isError).toBe(true);
    expect(extra.plans).toHaveLength(0);
  });

  it("refuses a record read more than one hour ago", async () => {
    const { runtime, plans } = fixture();
    const stale = await fanOutRecord({ observedAt: new Date(Date.now() - 61 * 60 * 1_000) });
    const result = await planItemBankQuestionImageAltRepair(runtime, await request({ fan_out: stale }) as never);
    expect(result.isError).toBe(true);
    expect(planText(result)).toContain("more than one hour old");
    expect(plans).toHaveLength(0);
  });

  it("refuses a Stimulus entry and an entry that does not name this question", async () => {
    const stimulus = fixture({ entry: { id: bankEntryId, entry_type: "Stimulus", entry_id: itemId } });
    const stimulusResult = await planItemBankQuestionImageAltRepair(stimulus.runtime, await request() as never);
    expect(stimulusResult.isError).toBe(true);
    expect(planText(stimulusResult)).toContain("not a question");
    expect(stimulus.plans).toHaveLength(0);

    const unresolved = fixture({ entry: { id: bankEntryId, entry_type: "Item", entry_id: "999" } });
    const unresolvedResult = await planItemBankQuestionImageAltRepair(unresolved.runtime, await request() as never);
    expect(unresolvedResult.isError).toBe(true);
    expect(planText(unresolvedResult)).toContain("does not name this question");
    expect(unresolved.plans).toHaveLength(0);
  });

  it("refuses a shifted image, an image that already has alternative text, and a repeated image", async () => {
    const { applyItemBankImageAlt } = await bridgeGuard();
    const guardOf = (index: number): JsonObject => ({ image_index: index, image_src_sha256: sha256Text(imageSrc), alt_text: "Diagram of a cell membrane" });

    const shiftedBody = `<p>Compare these.</p><img src="/courses/42/files/99"><img src="${imageSrc}">`;
    const shiftedItem = { ...question, entry: { ...(question.entry as JsonObject), item_body: shiftedBody } };
    const shifted = fixture({ item: shiftedItem });
    const shiftedResult = await planItemBankQuestionImageAltRepair(shifted.runtime, await request({ item_sha256: sha256Json(shiftedItem) }) as never);
    expect(shiftedResult.isError).toBe(true);
    expect(planText(shiftedResult)).toContain("not the image this signal named");
    expect(shifted.plans).toHaveLength(0);
    expect((await applyItemBankImageAlt(shiftedBody, guardOf(1))).error).toBe("item_bank_image_alt_target_changed");

    const describedBody = `<p>Identify the labelled structure.</p><img src="${imageSrc}" alt="Written by a person">`;
    const describedItem = { ...question, entry: { ...(question.entry as JsonObject), item_body: describedBody } };
    const described = fixture({ item: describedItem });
    const describedResult = await planItemBankQuestionImageAltRepair(described.runtime, await request({ item_sha256: sha256Json(describedItem) }) as never);
    expect(describedResult.isError).toBe(true);
    expect(planText(describedResult)).toContain("already carries an alternative-text attribute");
    expect(described.plans).toHaveLength(0);
    expect((await applyItemBankImageAlt(describedBody, guardOf(1))).error).toBe("item_bank_image_alt_already_present");

    const repeatedBody = `<p>Compare these.</p><img src="${imageSrc}"><img src="${imageSrc}">`;
    const repeatedItem = { ...question, entry: { ...(question.entry as JsonObject), item_body: repeatedBody } };
    const repeated = fixture({ item: repeatedItem });
    const repeatedResult = await planItemBankQuestionImageAltRepair(repeated.runtime, await request({ item_sha256: sha256Json(repeatedItem) }) as never);
    expect(repeatedResult.isError).toBe(true);
    expect(planText(repeatedResult)).toContain("more than once");
    expect(repeated.plans).toHaveLength(0);
    expect((await applyItemBankImageAlt(repeatedBody, guardOf(1))).error).toBe("item_bank_image_alt_ambiguous");
  });

  it("names a bank that reaches no other course, and still requires the empty acknowledgement", async () => {
    const { runtime, plans } = fixture();
    const record = await (await bridgeFanOut()).establishFanOut({
      bankId, courseId, sources: readSources(true),
      consumers: [{ course_id: courseId, entity_type: "quiz_use", entity_id: "301" }],
      unreachable: [], observedAt: new Date(),
    });
    expect(record!.external_course_ids).toEqual([]);
    const result = await planItemBankQuestionImageAltRepair(runtime, await request({ fan_out: record!, acknowledged_course_ids: [] }) as never);
    expect(result.isError).not.toBe(true);
    expect(planText(result)).toContain("reaches no course other than Biology");
    expect(plans).toHaveLength(1);
  });

  it("registers one planning tool that changes nothing while it plans", async () => {
    const registered: { name: string; config: JsonObject; handler: (input: JsonObject, context: JsonObject) => Promise<CallToolResult> }[] = [];
    const server = {
      registerTool: (name: string, config: JsonObject, handler: (input: JsonObject, context: JsonObject) => Promise<CallToolResult>) => {
        registered.push({ name, config, handler });
      },
    } as unknown as McpServer;
    const { runtime, plans } = fixture();
    registerItemBankRepairTool(server, runtime);

    expect(registered.map((tool) => tool.name)).toEqual(["morrow_plan_item_bank_question_image_alt_repair"]);
    expect(registered[0]!.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const result = await registered[0]!.handler(await request(), { mcpReq: {} });
    expect(result.isError).not.toBe(true);
    expect(plans).toHaveLength(1);
  });
});
