import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { itemBankEntryMatchesTarget, planItemBankQuestionImageAltRepair, registerItemBankRepairTool } from "../src/item-bank-repair.js";
import type { GatewayRuntime } from "../src/runtime.js";

const bank = { id: "91", title: "Cell bank" };
const question = (body: string): JsonObject => ({
  id: "501", entry_type: "Item",
  entry: { title: "Cell question", item_body: body, interaction_data: { choices: [{ id: "a" }] } },
});
const item = question('<p><img src="/courses/42/files/9"></p>');
// The same question with a second image that also has no alternative text.
// Repairing the first one must not be refused because of the second.
const TWO_UNDESCRIBED = '<p><img src="/courses/42/files/9"></p><p><img src="/courses/42/files/10"></p>';
// Canvas exposes no account-wide list of every quiz that draws from a bank, so
// the record always stays incomplete and the reviewer acknowledges the exact
// observed external courses.
const establishedRecently = () => new Date(Date.now() - 60_000).toISOString();
const observedReach = {
  schema: "morrow.canvas.item-bank.fan-out.v1", bank_id: "91", course_id: "42",
  established_at: establishedRecently(), sources: [], unreachable: ["quiz_uses"], complete: false,
  consumers: [], consumer_count: 0, external_course_ids: [], consumers_sha256: sha256Json([]),
};
// A record whose consumers disclose exactly the given external courses, with
// the digest and list the reader itself would issue.
const reachRecord = (external: string[]) => {
  const consumers = external.map((id) => ({ course_id: id, entity_type: "shared_bank", entity_id: id }));
  const sorted = [...external].sort((a, b) => a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length);
  return { ...observedReach, consumers, consumer_count: consumers.length, consumers_sha256: sha256Json(consumers), external_course_ids: sorted };
};
const input = { source_binding_id: "canvas:instructor", course_id: "42", bank_id: "91", bank_entry_id: "401", item_id: "501",
  item_sha256: sha256Json(item), image_index: 1, image_src_sha256: sha256Text("/courses/42/files/9"), alt_text: "A labeled cell membrane",
  fan_out: observedReach, fan_out_receipt: "a".repeat(64), acknowledged_course_ids: [] };
const readResult = (data: unknown): JsonObject => ({ structuredContent: { schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read", result: { ok: true, sent: true, truncated: false, data } } });

function runtime(captured: JsonObject[], current: JsonObject = item): GatewayRuntime {
  const upstream = (name: string) => ({ upstreamName: name, upstreamId: "canvas-session", publicName: name, annotations: { readOnlyHint: !name.includes("update_item") }, capability: { route: { backend: "canvas-connector" } } });
  const reads = new Map<string, unknown>([
    ["canvas_get_single_course_courses", { id: "42", name: "Biology" }], ["canvas_item_bank_get_bank", bank],
    ["canvas_item_bank_get_entry", { id: "401", bank_id: "91", entry_type: "Item", entry_id: "501" }], ["canvas_item_bank_get_item", current],
  ]);
  return {
    catalog: { tools: [upstream("canvas_item_bank_update_item")] },
    searchCatalog: ({ query }: { query: string }) => ({ tools: [upstream(query)] }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (name: string) => readResult(reads.get(name)),
    resultPage: () => { throw new Error("unused"); },
    planOperationWithCurrentEditPermission: async (name: string, args: JsonObject) => {
      captured.push({ name, args });
      return { content: [{ type: "text", text: "Review" }], structuredContent: { effectState: "awaiting_approval" } };
    },
  } as unknown as GatewayRuntime;
}

describe("Item Bank question image repair", () => {
  it("fresh-reads the exact bank item and plans one snapshot-bound full-item update", async () => {
    const captured: JsonObject[] = [];
    const result = await planItemBankQuestionImageAltRepair(runtime(captured), input);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(captured).toHaveLength(1);
    const args = captured[0]!.args as JsonObject;
    expect(captured[0]!.name).toBe("canvas_item_bank_update_item");
    expect(args).toMatchObject({ course_id: "42", bank_id: "91", item_id: "501", expected_snapshot: { bank_sha256: sha256Json(bank), item_sha256: sha256Json(item) } });
    expect((((args.item as JsonObject).entry as JsonObject).item_body as string)).toContain('alt="A labeled cell membrane"');
    expect(JSON.stringify(item)).not.toContain("alt=");
    expect(result.content?.[0]?.text).toContain("No change has been sent");
    // The observed-reach record and the reviewer's acknowledgement travel with
    // the change: an existing bank is never altered without them.
    expect(args).toMatchObject({ fan_out: observedReach, fan_out_receipt: "a".repeat(64), acknowledged_course_ids: [] });
  });

  it("repairs one reviewed image and leaves another undescribed image alone", async () => {
    const captured: JsonObject[] = [];
    const current = question(TWO_UNDESCRIBED);
    const result = await planItemBankQuestionImageAltRepair(
      runtime(captured, current),
      { ...input, item_sha256: sha256Json(current) },
    );
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(captured).toHaveLength(1);
    const body = ((((captured[0]!.args as JsonObject).item as JsonObject).entry as JsonObject).item_body as string);
    expect(body).toContain('<img src="/courses/42/files/9" alt="A labeled cell membrane">');
    // The second known issue is exactly what Canvas holds. It is a separate
    // repair, not a reason to refuse this one.
    expect(body).toContain('<img src="/courses/42/files/10">');
  });

  it("refuses a repair when the same image appears twice", async () => {
    const captured: JsonObject[] = [];
    const current = question('<img src="/courses/42/files/9"><img src="/courses/42/files/9">');
    const result = await planItemBankQuestionImageAltRepair(
      runtime(captured, current),
      { ...input, item_sha256: sha256Json(current) },
    );
    expect(result.isError).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it("requires the exact bank-entry response id", () => {
    const base = { id: "401", entry_type: "Item", entry_id: "501" };
    expect(itemBankEntryMatchesTarget(base, "401", "91", "501")).toBe(true);
    expect(itemBankEntryMatchesTarget({ ...base, bank_id: "91" }, "401", "91", "501")).toBe(true);
    expect(itemBankEntryMatchesTarget({ ...base, id: "402" }, "401", "91", "501")).toBe(false);
    expect(itemBankEntryMatchesTarget({ ...base, bank_id: "92" }, "401", "91", "501")).toBe(false);
  });

  it("registers the snapshot-bound repair tool", () => {
    const registered: Array<{ name: string; config: JsonObject; handler: (value: typeof input, context: JsonObject) => Promise<CallToolResult> }> = [];
    const server = { registerTool(name: string, config: JsonObject, handler: (value: typeof input, context: JsonObject) => Promise<CallToolResult>) { registered.push({ name, config, handler }); } } as unknown as McpServer;
    registerItemBankRepairTool(server, runtime([]));
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe("morrow_plan_item_bank_question_image_alt_repair");
    expect(registered[0]!.config.description).toContain("binds the reviewed update to the exact bank and item snapshots");
  });
});

describe("Item Bank repair plan-time acknowledgement", () => {
  // The dispatch layer refuses the same mismatch independently, with no plan
  // layer in the path: scripts/test/canvas-item-bank-executor.test.mjs and
  // scripts/test/canvas-item-bank-guard.test.mjs pin the executor's
  // item_bank_fan_out_acknowledgement_mismatch refusal against the frame
  // executor directly. The checks here hold the plan to the same rule before
  // a change is ever presented for approval.

  it("refuses an empty acknowledgement against a record that discloses an external course", async () => {
    const captured: JsonObject[] = [];
    const result = await planItemBankQuestionImageAltRepair(
      runtime(captured),
      { ...input, fan_out: reachRecord(["77"]), acknowledged_course_ids: [] },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "item_bank_fan_out_acknowledgement_mismatch" });
    expect(result.content?.[0]?.text).toContain("did not confirm course 77");
    expect(captured).toHaveLength(0);
  });

  it("refuses an acknowledgement that names a course the record does not disclose", async () => {
    const captured: JsonObject[] = [];
    const result = await planItemBankQuestionImageAltRepair(
      runtime(captured),
      { ...input, fan_out: reachRecord(["77"]), acknowledged_course_ids: ["88"] },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "item_bank_fan_out_acknowledgement_mismatch" });
    expect(result.content?.[0]?.text).toContain("confirmed course 88");
    expect(result.content?.[0]?.text).toContain("does not reach");
    expect(captured).toHaveLength(0);
  });

  it("refuses a superset acknowledgement", async () => {
    const captured: JsonObject[] = [];
    const result = await planItemBankQuestionImageAltRepair(
      runtime(captured),
      { ...input, fan_out: reachRecord(["77"]), acknowledged_course_ids: ["77", "88"] },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "item_bank_fan_out_acknowledgement_mismatch" });
    expect(captured).toHaveLength(0);
  });

  it("plans when the acknowledgement is exactly the disclosed list, in any order", async () => {
    const captured: JsonObject[] = [];
    const result = await planItemBankQuestionImageAltRepair(
      runtime(captured),
      { ...input, fan_out: reachRecord(["77", "88"]), acknowledged_course_ids: ["88", "77"] },
    );
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args).toMatchObject({ acknowledged_course_ids: ["88", "77"] });
  });

  it("refuses a record whose disclosed course list does not match its own consumers", async () => {
    const captured: JsonObject[] = [];
    for (const external_course_ids of [["77", "77"], ["77", "not-a-course"], "77"]) {
      const result = await planItemBankQuestionImageAltRepair(
        runtime(captured),
        { ...input, fan_out: { ...reachRecord([]), external_course_ids }, acknowledged_course_ids: [] },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "item_bank_fan_out_external_course_ids_mismatch" });
      expect(captured).toHaveLength(0);
    }
  });

  it("refuses a record that claims complete reach or has no unread source", async () => {
    const captured: JsonObject[] = [];
    const fullyRead = { ...reachRecord([]), unreachable: [], sources: [
      { name: "bank_entries", exhausted: true }, { name: "shared_banks", exhausted: true }, { name: "quiz_uses", exhausted: true },
    ] };
    for (const reach of [{ ...reachRecord([]), complete: true }, fullyRead]) {
      const result = await planItemBankQuestionImageAltRepair(
        runtime(captured),
        { ...input, fan_out: reach, acknowledged_course_ids: [] },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "item_bank_fan_out_authoritative_reach_claim_refused" });
      expect(captured).toHaveLength(0);
    }
  });

  it("refuses a record older than one hour", async () => {
    const captured: JsonObject[] = [];
    const stale = { ...reachRecord([]), established_at: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString() };
    const result = await planItemBankQuestionImageAltRepair(runtime(captured), { ...input, fan_out: stale, acknowledged_course_ids: [] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "item_bank_fan_out_record_too_old" });
    expect(result.content?.[0]?.text).toContain("more than one hour old");
    expect(captured).toHaveLength(0);
  });

  it("refuses a record that describes a different bank or course", async () => {
    const captured: JsonObject[] = [];
    const wrongBank = await planItemBankQuestionImageAltRepair(runtime(captured), { ...input, fan_out: { ...reachRecord([]), bank_id: "92" }, acknowledged_course_ids: [] });
    expect(wrongBank.isError).toBe(true);
    expect(wrongBank.structuredContent).toMatchObject({ code: "item_bank_fan_out_bank_mismatch" });
    const wrongCourse = await planItemBankQuestionImageAltRepair(runtime(captured), { ...input, fan_out: { ...reachRecord([]), course_id: "43" }, acknowledged_course_ids: [] });
    expect(wrongCourse.isError).toBe(true);
    expect(wrongCourse.structuredContent).toMatchObject({ code: "item_bank_fan_out_course_mismatch" });
    expect(captured).toHaveLength(0);
  });

  it("refuses a record whose consumer digest does not cover its consumers", async () => {
    const captured: JsonObject[] = [];
    const result = await planItemBankQuestionImageAltRepair(
      runtime(captured),
      { ...input, fan_out: { ...reachRecord(["77"]), consumers_sha256: "c".repeat(64) }, acknowledged_course_ids: ["77"] },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "item_bank_fan_out_consumers_digest_mismatch" });
    expect(captured).toHaveLength(0);
  });
});
