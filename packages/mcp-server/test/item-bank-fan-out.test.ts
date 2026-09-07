import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { readItemBankFanOut, registerItemBankFanOutTool } from "../src/item-bank-fan-out.js";
import type { GatewayRuntime } from "../src/runtime.js";

const sourceBindingId = "canvas:instructor";
const courseId = "42";
const bankId = "91";
const now = () => Date.now();

/**
 * The Morrow Bridge module the in-frame guard validates a fan-out record with.
 * The tool builds its record in TypeScript, so these tests run both
 * implementations over the same input and require identical results.
 */
type BridgeFanOut = {
  establishFanOut(input: {
    bankId: string; courseId: string;
    sources: unknown; consumers: unknown; unreachable: unknown; observedAt: unknown;
  }): Promise<JsonObject | null>;
  fanOutDigest(consumers: unknown): Promise<string | null>;
  validFanOut(record: unknown, options: {
    bankId: string; courseId: string; acknowledgedCourseIds: unknown; now: number;
  }): Promise<string | null>;
};

async function bridgeFanOut(): Promise<BridgeFanOut> {
  return await import(new URL("../../../connector/extension/src/item-bank-fan-out.js", import.meta.url).href) as BridgeFanOut;
}

function readResult(data: unknown, extra: JsonObject = {}): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read",
      result: { ok: true, sent: true, truncated: false, data, ...extra },
    },
  };
}

/** A list the connector could not walk to its end. `canvasReadResult` refuses it. */
function budgetExceededResult(data: unknown, pageCount: number): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read",
      result: { ok: true, sent: true, truncated: true, data, pageCount },
    },
  };
}

function unavailableResult(message: string): JsonObject {
  return {
    isError: true,
    content: [{ type: "text", text: "Morrow read Canvas data." }],
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1", ok: false, provider: "canvas", resultState: "not_sent",
      problem: { schema: "morrow.bridge.problem.v1", code: "canvas_request_not_sent", message, recoverable: true },
    },
  };
}

const bankDrawItem = { id: "5", entry_type: "BankEntry", entry: { bank_id: bankId } };
const ownItem = { id: "6", entry_type: "Item", entry: { item_body: "<p>Which organelle?</p>" } };

type Overrides = {
  course?: JsonObject;
  entries?: JsonObject;
  shares?: JsonObject;
  quizzes?: JsonObject;
  items?: Record<string, JsonObject>;
};

function fixture(overrides: Overrides = {}) {
  const calls: { tool: string; arguments: JsonObject }[] = [];
  const runtime = {
    searchCatalog: ({ query }: { query: string }) => ({
      tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: true } }],
    }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    resultPage: () => { throw new Error("unexpected artifact page"); },
    callSourceOwned: async (tool: string, args: JsonObject) => {
      expect((args._morrow as JsonObject).source_binding_id).toBe(sourceBindingId);
      calls.push({ tool, arguments: args });
      if (tool === "canvas_get_single_course_courses") return overrides.course ?? readResult({ id: courseId, name: "Biology" });
      if (tool === "canvas_item_bank_list_entries") return overrides.entries ?? readResult([{ id: "20", entry_type: "BankEntry" }], { pageCount: 1 });
      if (tool === "canvas_item_bank_list_shares") return overrides.shares ?? readResult([]);
      if (tool === "canvas_list_new_quizzes") return overrides.quizzes ?? readResult([{ id: "70", title: "Cell check" }]);
      if (tool === "canvas_list_quiz_items") return overrides.items?.[String(args.assignment_id)] ?? readResult([ownItem]);
      throw new Error(`unexpected tool ${tool}`);
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

async function readFanOut(runtime: GatewayRuntime, quizUseCourseIds: string[] = []): Promise<{ result: CallToolResult; report: JsonObject; record: JsonObject; text: string }> {
  const result = await readItemBankFanOut(runtime, {
    source_binding_id: sourceBindingId, course_id: courseId, bank_id: bankId, quiz_use_course_ids: quizUseCourseIds,
  });
  const report = result.structuredContent as JsonObject;
  return { result, report, record: report.fan_out as JsonObject, text: String(result.content?.[0]?.text ?? "") };
}

const sharedInto = (ids: string[]): JsonObject => readResult(ids.map((id) => ({ id: `s${id}`, entity_type: "course", entity_id: id, bank_id: bankId, permission: "read" })));

describe("item bank fan-out reader", () => {
  it("reads every source and names the course the bank reaches", async () => {
    const { runtime, calls } = fixture({
      shares: sharedInto(["77"]),
      items: { "70": readResult([bankDrawItem, ownItem]) },
    });
    const { result, report, record, text } = await readFanOut(runtime, ["77"]);

    expect(result.isError).not.toBe(true);
    expect(report.status).toBe("complete");
    expect(record).toMatchObject({
      schema: "morrow.canvas.item-bank.fan-out.v1", bank_id: bankId, course_id: courseId,
      complete: true, unreachable: [], consumer_count: 2, external_course_ids: ["77"],
    });
    expect(record.consumers).toEqual([
      { course_id: "42", entity_type: "quiz_use", entity_id: "70" },
      { course_id: "77", entity_type: "shared_bank", entity_id: "77" },
    ]);
    expect(record.sources).toEqual([
      { name: "bank_entries", pages: 1, exhausted: true },
      { name: "shared_banks", pages: 1, exhausted: true },
      { name: "quiz_uses", pages: 2, exhausted: true },
    ]);
    expect(report.unread).toEqual([]);
    expect(text).toContain("course 77");

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: record.external_course_ids, now: now() })).toBeNull();
    expect(calls.map((call) => call.tool)).toEqual([
      "canvas_get_single_course_courses", "canvas_item_bank_list_entries", "canvas_item_bank_list_shares",
      "canvas_list_new_quizzes", "canvas_list_quiz_items",
    ]);
    expect(calls[1]?.arguments).toMatchObject({ bank_id: bankId, morrow_max_pages: 25 });
    expect(calls[2]?.arguments).toMatchObject({ bank_id: bankId, per_page: 100 });
  });

  it("records an unreadable share list as unread, never as an empty fan-out", async () => {
    const { runtime } = fixture({ shares: unavailableResult("The Item Banks frame is not available.") });
    const { report, record, text } = await readFanOut(runtime);

    expect(report.status).toBe("incomplete");
    expect(record.complete).toBe(false);
    expect(record.unreachable).toEqual(["quiz_uses", "shared_banks"]);
    expect(record.external_course_ids).toEqual([]);
    expect(report.unread).toEqual([
      { source: "shared_banks", reasons: [expect.stringContaining("Canvas did not return a complete readable result.")] },
      { source: "quiz_uses", reasons: [expect.stringContaining("could not read every course this bank reaches")] },
    ]);
    expect(text).toContain("found no other course, which is not the same as showing that none exists");

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: [], now: now() }))
      .toBe("incomplete_unread_source_is_not_an_empty_fan_out");
  });

  it("records a bank-entry walk that reached its page budget as unread", async () => {
    const { runtime } = fixture({ entries: budgetExceededResult([{ id: "20", entry_type: "BankEntry" }], 25) });
    const { report, record } = await readFanOut(runtime);

    expect(record.unreachable).toEqual(["bank_entries"]);
    expect(record.complete).toBe(false);
    expect(record.sources).toContainEqual({ name: "bank_entries", pages: 0, exhausted: false });
    expect(report.unread).toEqual([{ source: "bank_entries", reasons: [expect.stringContaining("at most 25 pages of bank entries")] }]);
    expect((report.observed as JsonObject).bank_entry_count).toBe(0);

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: [], now: now() }))
      .toBe("incomplete_unread_source_is_not_an_empty_fan_out");
  });

  it("leaves quiz uses unread when the other courses were not enumerated", async () => {
    const { runtime } = fixture({ shares: sharedInto(["77", "88"]) });
    const { report, record, text } = await readFanOut(runtime);

    expect(record.unreachable).toEqual(["quiz_uses"]);
    expect(record.complete).toBe(false);
    expect(record.external_course_ids).toEqual(["77", "88"]);
    expect(report.unread).toEqual([{ source: "quiz_uses", reasons: [expect.stringContaining("course 77, course 88")] }]);
    expect((report.observed as JsonObject).quiz_use_courses_declared_by_caller).toEqual([]);
    expect(text).toContain("course 77, course 88");

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: ["77", "88"], now: now() }))
      .toBe("incomplete_unread_source_is_not_an_empty_fan_out");
  });

  it("completes the set when every other course the bank reaches was enumerated", async () => {
    const { runtime } = fixture({ shares: sharedInto(["77", "88"]) });
    const { report, record, text } = await readFanOut(runtime, ["88", "77"]);

    expect(report.status).toBe("complete");
    expect(record.complete).toBe(true);
    expect(record.external_course_ids).toEqual(["77", "88"]);
    expect((report.observed as JsonObject)).toMatchObject({
      quiz_use_courses_read_by_morrow: ["42"], quiz_use_courses_declared_by_caller: ["77", "88"], quizzes_read: 1,
    });
    expect(text).toContain("2 other courses: course 77, course 88");
    expect(text).toContain("Morrow did not read those courses and records the declaration as yours");

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: ["77", "88"], now: now() })).toBeNull();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: ["77"], now: now() })).toBe("acknowledgement_mismatch");
  });

  it("records a bank shared into two other courses as two consumers", async () => {
    const { runtime } = fixture({ shares: sharedInto(["88", "77"]) });
    const { record } = await readFanOut(runtime, ["77", "88"]);

    expect(record.consumers).toEqual([
      { course_id: "77", entity_type: "shared_bank", entity_id: "77" },
      { course_id: "88", entity_type: "shared_bank", entity_id: "88" },
    ]);
    expect(record.consumer_count).toBe(2);
  });

  it("records a bank shared nowhere as complete with no other course", async () => {
    const { runtime } = fixture({ items: { "70": readResult([bankDrawItem]) } });
    const { report, record, text } = await readFanOut(runtime);

    expect(report.status).toBe("complete");
    expect(record.external_course_ids).toEqual([]);
    expect(record.consumers).toEqual([{ course_id: "42", entity_type: "quiz_use", entity_id: "70" }]);
    expect(text).toContain("No course other than the selected one draws from it.");

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: [], now: now() })).toBeNull();
  });

  it("records a share that names an account as unread, because no route lists its courses", async () => {
    const { runtime } = fixture({ shares: readResult([{ id: "s1", entity_type: "account", entity_id: "3" }]) });
    const { report, record } = await readFanOut(runtime);

    expect(record.unreachable).toEqual(["quiz_uses", "shared_banks"]);
    expect(record.consumers).toEqual([]);
    expect(report.unread).toContainEqual({ source: "shared_banks", reasons: ["One share names an entity of type account, not a course. No Item Bank route lists the courses inside it."] });
  });

  it("records a quiz item that draws from an unnamed bank as unread", async () => {
    const { runtime } = fixture({ items: { "70": readResult([{ id: "5", entry_type: "BankEntry", entry: {} }]) } });
    const { record, report } = await readFanOut(runtime);

    expect(record.unreachable).toEqual(["quiz_uses"]);
    expect(record.consumers).toEqual([]);
    expect(report.unread).toEqual([{ source: "quiz_uses", reasons: [expect.stringContaining("draws from an item bank that its item does not name")] }]);
  });

  it("counts one quiz that draws from the bank twice as one consumer", async () => {
    const { runtime } = fixture({ items: { "70": readResult([bankDrawItem, { id: "7", entry_type: "BankEntry", entry: { bank_id: bankId } }]) } });
    const { record } = await readFanOut(runtime);

    expect(record.consumers).toEqual([{ course_id: "42", entity_type: "quiz_use", entity_id: "70" }]);
    expect(record.complete).toBe(true);
  });

  it("ignores a quiz that draws from another bank", async () => {
    const { runtime } = fixture({ items: { "70": readResult([{ id: "5", entry_type: "BankEntry", entry: { bank_id: "999" } }]) } });
    const { record } = await readFanOut(runtime);

    expect(record.consumers).toEqual([]);
    expect(record.complete).toBe(true);
  });

  it("builds no record when the selected course cannot be confirmed", async () => {
    const { runtime, calls } = fixture({ course: readResult({ id: "43", name: "Chemistry" }) });
    const { result, report } = await readFanOut(runtime);

    expect(result.isError).toBe(true);
    expect(report).toEqual({ schema: "morrow.problem.v1", code: "item_bank_fan_out_not_established" });
    expect(calls.map((call) => call.tool)).toEqual(["canvas_get_single_course_courses"]);
  });

  it("builds the same record and digest as the Morrow Bridge module", async () => {
    const { runtime } = fixture({ shares: sharedInto(["88", "77"]), items: { "70": readResult([bankDrawItem]) } });
    const complete = (await readFanOut(runtime, ["77", "88"])).record;
    const incomplete = (await readFanOut(fixture({ shares: sharedInto(["77"]) }).runtime)).record;
    const { establishFanOut, fanOutDigest } = await bridgeFanOut();

    for (const record of [complete, incomplete]) {
      // The bridge module is given the consumers in reverse order, so a matching
      // record also proves both implementations sort and digest them the same way.
      const bridgeRecord = await establishFanOut({
        bankId, courseId,
        sources: record.sources,
        consumers: [...record.consumers as JsonObject[]].reverse(),
        unreachable: record.unreachable,
        observedAt: record.established_at,
      });
      expect(bridgeRecord).toEqual(record);
      expect(await fanOutDigest(record.consumers)).toBe(record.consumers_sha256);
    }
  });

  it("registers one read-only tool that returns the record", async () => {
    const registered: { name: string; config: JsonObject; handler: (input: JsonObject, context: JsonObject) => Promise<CallToolResult> }[] = [];
    const server = {
      registerTool: (name: string, config: JsonObject, handler: (input: JsonObject, context: JsonObject) => Promise<CallToolResult>) => {
        registered.push({ name, config, handler });
      },
    } as unknown as McpServer;
    const { runtime } = fixture();
    registerItemBankFanOutTool(server, runtime);

    expect(registered.map((tool) => tool.name)).toEqual(["morrow_read_item_bank_fan_out"]);
    expect(registered[0]!.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const result = await registered[0]!.handler(
      { source_binding_id: sourceBindingId, course_id: courseId, bank_id: bankId },
      { mcpReq: {} },
    );
    expect((result.structuredContent as JsonObject).schema).toBe("morrow.item-bank-fan-out.v1");
  });
});
