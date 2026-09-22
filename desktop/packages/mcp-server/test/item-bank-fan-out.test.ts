import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { readItemBankFanOut, registerItemBankFanOutTool, validItemBankFanOutReceipt } from "../src/item-bank-fan-out.js";
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

function observedShareResult(data: unknown): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read",
      result: {
        ok: true, sent: true, truncated: true, paginationComplete: false,
        paginationUnestablished: true, data,
      },
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
  courses?: Record<string, JsonObject>;
  bindings?: JsonObject[];
  bank?: JsonObject;
  banks?: JsonObject;
  courseQuizzes?: Record<string, JsonObject>;
  onRead?: (tool: string, args: JsonObject, calls: { tool: string; arguments: JsonObject }[]) => JsonObject | undefined;
  entries?: JsonObject;
  shares?: JsonObject;
  quizzes?: JsonObject;
  items?: Record<string, JsonObject>;
};

function courseBinding(id: string): JsonObject {
  return {
    sourceBindingId: id === courseId ? sourceBindingId : `canvas:course-${id}`, provider: "canvas",
    origin: "https://school.instructure.com", courseId: id, principalFingerprint: "a".repeat(64),
    sessionGeneration: 1, catalogDigest: "b".repeat(64), runtimeVerified: true,
  };
}

function fixture(overrides: Overrides = {}) {
  const calls: { tool: string; arguments: JsonObject }[] = [];
  const runtime = {
    searchCatalog: ({ query }: { query: string }) => ({
      tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: true } }],
    }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    resultPage: () => { throw new Error("unexpected artifact page"); },
    callSourceOwned: async (tool: string, args: JsonObject) => {
      calls.push({ tool, arguments: args });
      const custom = overrides.onRead?.(tool, args, calls);
      if (custom) return custom;
      if (tool === "morrow_browser_bindings") {
        const bindings = overrides.bindings ?? [courseBinding(courseId), courseBinding("77"), courseBinding("88")];
        return { structuredContent: { schema: "morrow.browser-bindings.v1", ok: true, count: bindings.length, bindings } };
      }
      const requestedCourseId = String(args.course_id ?? (tool === "canvas_get_single_course_courses" ? args.id : courseId));
      expect((args._morrow as JsonObject).source_binding_id).toBe(courseBinding(requestedCourseId).sourceBindingId);
      if (tool === "canvas_get_single_course_courses") return overrides.courses?.[String(args.id)]
        ?? (args.id === courseId ? overrides.course : undefined) ?? readResult({ id: String(args.id), name: "Biology" });
      if (tool === "canvas_item_bank_list_banks") return overrides.banks ?? readResult([{ id: bankId, title: "Biology bank" }]);
      if (tool === "canvas_item_bank_get_bank") return overrides.bank ?? readResult({ id: bankId, title: "Biology bank" });
      if (tool === "canvas_get_new_quiz") return readResult({ id: String(args.assignment_id), course_id: String(args.course_id) });
      if (tool === "canvas_item_bank_list_entries") return overrides.entries ?? readResult([{ id: "20", entry_type: "BankEntry" }], { pageCount: 1 });
      if (tool === "canvas_item_bank_list_shares") return overrides.shares ?? observedShareResult([]);
      if (tool === "canvas_list_new_quizzes") return overrides.courseQuizzes?.[String(args.course_id)]
        ?? (args.course_id === courseId ? overrides.quizzes ?? readResult([{ id: "70", title: "Cell check" }]) : readResult([]));
      if (tool === "canvas_list_quiz_items") return overrides.items?.[`${args.course_id}:${args.assignment_id}`] ?? overrides.items?.[String(args.assignment_id)] ?? readResult([ownItem]);
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

const sharedInto = (ids: string[]): JsonObject => observedShareResult(ids.map((id) => ({ id: `s${id}`, entity_type: "course", entity_id: id, bank_id: bankId, permission: "read" })));

describe("item bank fan-out reader", () => {
  it("reads the requested sources but keeps quiz use permanently incomplete", async () => {
    const { runtime, calls } = fixture({
      shares: sharedInto(["77"]),
      items: { "70": readResult([bankDrawItem, ownItem]) },
    });
    const { result, report, record, text } = await readFanOut(runtime, ["77"]);

    expect(result.isError).not.toBe(true);
    expect(report.status).toBe("incomplete");
    expect(record).toMatchObject({
      schema: "morrow.canvas.item-bank.fan-out.v1", bank_id: bankId, course_id: courseId,
      complete: false, unreachable: ["quiz_uses", "shared_banks"], consumer_count: 2, external_course_ids: ["77"],
    });
    expect(record.consumers).toEqual([
      { course_id: "42", entity_type: "quiz_use", entity_id: "70" },
      { course_id: "77", entity_type: "shared_bank", entity_id: "77" },
    ]);
    expect(record.sources).toEqual([
      { name: "bank_entries", pages: 2, exhausted: true },
      { name: "shared_banks", pages: 2, exhausted: false },
      { name: "quiz_uses", pages: 5, exhausted: false },
    ]);
    expect(report.unread).toContainEqual({ source: "quiz_uses", reasons: expect.arrayContaining([expect.stringContaining("no authoritative route")]) });
    expect(text).toContain("course 77");

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: record.external_course_ids, now: now() })).toBeNull();
    expect(calls.filter((call) => call.tool === "canvas_list_new_quizzes").map((call) => call.arguments.course_id))
      .toEqual(["42", "42", "77", "77"]);
    expect(calls.find((call) => call.tool === "canvas_item_bank_list_entries")?.arguments)
      .toMatchObject({ course_id: courseId, bank_id: bankId, morrow_max_pages: 25 });
    expect(calls.find((call) => call.tool === "canvas_item_bank_list_shares")?.arguments)
      .toEqual({ course_id: courseId, bank_id: bankId, _morrow: { source_binding_id: sourceBindingId } });
    expect(report.unread).toContainEqual({ source: "shared_banks", reasons: [expect.stringContaining("pagination is not established")] });

  });

  it("records an unreadable share list as unread, never as an empty fan-out", async () => {
    const { runtime } = fixture({ shares: unavailableResult("The Item Banks frame is not available.") });
    const { report, record, text } = await readFanOut(runtime);

    expect(report.status).toBe("incomplete");
    expect(record.complete).toBe(false);
    expect(record.unreachable).toEqual(["quiz_uses", "shared_banks"]);
    expect(record.external_course_ids).toEqual([]);
    expect(report.unread).toContainEqual({ source: "shared_banks", reasons: [expect.stringContaining("one-page Item Bank share observation")] });
    expect(report.unread).toContainEqual({ source: "quiz_uses", reasons: expect.arrayContaining([
      expect.stringContaining("could not read every course this bank reaches"),
      expect.stringContaining("no authoritative route"),
    ]) });
    expect(text).toContain("found no other course, which is not the same as showing that none exists");

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: [], now: now() }))
      .toBeNull();
  });

  it("records a bank-entry walk that reached its page budget as unread", async () => {
    const { runtime } = fixture({ entries: budgetExceededResult([{ id: "20", entry_type: "BankEntry" }], 25) });
    const { report, record } = await readFanOut(runtime);

    expect(record.unreachable).toEqual(["bank_entries", "quiz_uses", "shared_banks"]);
    expect(record.complete).toBe(false);
    expect(record.sources).toContainEqual({ name: "bank_entries", pages: 0, exhausted: false });
    expect(report.unread).toContainEqual({ source: "bank_entries", reasons: [expect.stringContaining("at most 25 pages of bank entries")] });
    expect(report.unread).toContainEqual({ source: "quiz_uses", reasons: expect.arrayContaining([expect.stringContaining("no authoritative route")]) });
    expect((report.observed as JsonObject).bank_entry_count).toBe(0);

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: [], now: now() }))
      .toBeNull();
  });

  it("leaves quiz uses unread when the other courses were not enumerated", async () => {
    const { runtime } = fixture({ shares: sharedInto(["77", "88"]) });
    const { report, record, text } = await readFanOut(runtime);

    expect(record.unreachable).toEqual(["quiz_uses", "shared_banks"]);
    expect(record.complete).toBe(false);
    expect(record.external_course_ids).toEqual(["77", "88"]);
    expect(report.unread).toContainEqual({ source: "quiz_uses", reasons: expect.arrayContaining([
      expect.stringContaining("could not read every course this bank reaches"),
      expect.stringContaining("no authoritative route"),
    ]) });
    expect((report.observed as JsonObject).quiz_use_courses_requested).toEqual([]);
    expect(text).toContain("course 77, course 88");

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: ["77", "88"], now: now() }))
      .toBeNull();
  });

  it("never completes the set when every caller-selected course was enumerated", async () => {
    const { runtime } = fixture({ shares: sharedInto(["77", "88"]) });
    const { report, record, text } = await readFanOut(runtime, ["88", "77"]);

    expect(report.status).toBe("incomplete");
    expect(record.complete).toBe(false);
    expect(record.external_course_ids).toEqual(["77", "88"]);
    expect((report.observed as JsonObject)).toMatchObject({
      quiz_use_courses_read_by_morrow: ["42", "77", "88"], quiz_use_courses_requested: ["77", "88"], quizzes_read: 1,
    });
    expect(text).toContain("courses Morrow did find are course 77, course 88");
    expect(text).toContain("Morrow completed quiz reads for course 42, course 77, course 88");

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: ["77", "88"], now: now() })).toBeNull();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: ["77"], now: now() })).toBe("acknowledgement_mismatch");
  });

  it("reads external quiz items under their own course binding and includes their bank use", async () => {
    const { runtime, calls } = fixture({
      shares: sharedInto(["77"]),
      courseQuizzes: { "77": readResult([{ id: "80", course_id: "77" }]) },
      items: { "77:80": readResult([bankDrawItem]) },
    });
    const { record, report } = await readFanOut(runtime, ["77"]);

    expect(record.complete).toBe(false);
    expect(record.consumers).toEqual([
      { course_id: "77", entity_type: "quiz_use", entity_id: "80" },
      { course_id: "77", entity_type: "shared_bank", entity_id: "77" },
    ]);
    expect(calls.filter((call) => call.tool === "canvas_list_quiz_items")).toContainEqual({
      tool: "canvas_list_quiz_items",
      arguments: { course_id: "77", assignment_id: "80", morrow_max_pages: 25, _morrow: { source_binding_id: "canvas:course-77" } },
    });
    expect(report.observed).toMatchObject({ quiz_use_courses_read_by_morrow: ["42", "77"], quizzes_read: 2 });
  });

  it.each([
    ["missing", []],
    ["unverified", [{ ...courseBinding("77"), runtimeVerified: false }]],
    ["another site", [{ ...courseBinding("77"), origin: "https://other.instructure.com" }]],
    ["another account", [{ ...courseBinding("77"), principalFingerprint: "c".repeat(64) }]],
    ["ambiguous", [courseBinding("77"), { ...courseBinding("77"), sourceBindingId: "canvas:other-77" }]],
  ])("refuses a declared course whose binding is %s without reading through another binding", async (_name, external) => {
    const { runtime, calls } = fixture({ shares: sharedInto(["77"]), bindings: [courseBinding(courseId), ...external] });
    const { record } = await readFanOut(runtime, ["77"]);

    expect(record.complete).toBe(false);
    expect(record.unreachable).toEqual(["quiz_uses", "shared_banks"]);
    expect(calls.some((call) => call.arguments.course_id === "77" || call.arguments.id === "77")).toBe(false);
  });

  it.each([
    ["permission denied", unavailableResult("The teacher cannot read these items.")],
    ["truncated", budgetExceededResult([bankDrawItem], 25)],
    ["wrong quiz", readResult([{ ...bankDrawItem, quiz_id: "999" }])],
    ["conflicting bank", readResult([{ ...bankDrawItem, bank_id: "999" }])],
  ])("keeps external quiz use unread when its item read is %s", async (_name, items) => {
    const { runtime } = fixture({
      shares: sharedInto(["77"]), courseQuizzes: { "77": readResult([{ id: "80" }]) },
      items: { "77:80": items },
    });
    const { record, report } = await readFanOut(runtime, ["77"]);

    expect(record.complete).toBe(false);
    expect(record.unreachable).toEqual(["quiz_uses", "shared_banks"]);
    expect(report.observed).toMatchObject({ quiz_use_courses_read_by_morrow: ["42"] });
    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: ["77"], now: now() }))
      .toBeNull();
  });

  it.each(["course", "quiz", "bank", "shares", "binding"])("refuses a %s context that changes during enumeration", async (kind) => {
    const { runtime } = fixture({
      shares: sharedInto(["77"]), courseQuizzes: { "77": readResult([{ id: "80" }]) },
      onRead: (tool, args, calls) => {
        const matching = calls.filter((call) => call.tool === tool && call.arguments.id === args.id && call.arguments.assignment_id === args.assignment_id);
        if (kind === "course" && tool === "canvas_get_single_course_courses" && args.id === "77" && matching.length === 2) return readResult({ id: "88", name: "Moved" });
        if (kind === "quiz" && tool === "canvas_get_new_quiz" && args.assignment_id === "80" && matching.length === 2) return readResult({ id: "81" });
        if (kind === "bank" && tool === "canvas_item_bank_get_bank" && matching.length === 2) return readResult({ id: "92" });
        if (kind === "shares" && tool === "canvas_item_bank_list_shares" && matching.length === 2) return sharedInto(["77", "88"]);
        if (kind === "binding" && tool === "morrow_browser_bindings" && matching.length === 2) {
          const bindings = [courseBinding(courseId), { ...courseBinding("77"), sessionGeneration: 2 }];
          return { structuredContent: { schema: "morrow.browser-bindings.v1", ok: true, count: 2, bindings } };
        }
        return undefined;
      },
    });
    const { record } = await readFanOut(runtime, ["77"]);
    expect(record.complete).toBe(false);
    expect(record.unreachable).toContain("quiz_uses");
  });

  it("shares one quiz-item read budget across courses and refuses the unread remainder", async () => {
    const quizzes = readResult(Array.from({ length: 101 }, (_, index) => ({ id: String(index + 1) })));
    const { runtime, calls } = fixture({ shares: sharedInto(["77"]), quizzes, courseQuizzes: { "77": quizzes } });
    const { record, report } = await readFanOut(runtime, ["77"]);

    expect(record.complete).toBe(false);
    expect(calls.filter((call) => call.tool === "canvas_list_quiz_items")).toHaveLength(200);
    expect(report.observed).toMatchObject({ quiz_use_courses_read_by_morrow: ["42"], quizzes_read: 200 });
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

  /*
   * Canvas pins no one key casing for a share row, so every reader of one
   * accepts either. This is the gateway reader; the connector reads the same
   * rows in connector/extension/src/item-bank-executor.js and
   * packages/mcp-server/src/course-inventory.ts. A reader stricter than its
   * twins drops a course the bank really reaches out of the disclosure, which
   * is the one thing this record exists to name.
   */
  it.each([
    ["snake_case", (id: string): JsonObject => ({ id: `s${id}`, entity_type: "course", entity_id: id, bank_id: bankId, permission: "read" })],
    ["camelCase", (id: string): JsonObject => ({ id: `s${id}`, entityType: "course", entityId: id, bank_id: bankId, permission: "read" })],
    ["a mixed casing", (id: string): JsonObject => ({ id: `s${id}`, entity_type: "course", entityId: id, bank_id: bankId, permission: "read" })],
  ])("reads a share row answered in %s as the same consumer", async (_label, shareRow) => {
    const { runtime } = fixture({ shares: observedShareResult([shareRow("88"), shareRow("77")]) });
    const { record } = await readFanOut(runtime, ["77", "88"]);

    expect(record.consumers).toEqual([
      { course_id: "77", entity_type: "shared_bank", entity_id: "77" },
      { course_id: "88", entity_type: "shared_bank", entity_id: "88" },
    ]);
    expect(record.external_course_ids).toEqual(["77", "88"]);
    expect(record.consumer_count).toBe(2);
  });

  it("does not present a private share context identifier as a Canvas course id", async () => {
    const contextUuid = "4cc89358-1adc-4ea9-b005-4eea86087fa8";
    const { runtime } = fixture({
      shares: observedShareResult([{ id: "s1", entity_type: "course", entity_id: contextUuid, bank_id: bankId, permission: "read" }]),
    });
    const { report, record } = await readFanOut(runtime);

    expect(record.external_course_ids).toEqual([]);
    expect(record.consumers).toEqual([]);
    expect(report.observed).toMatchObject({ share_row_count: 1 });
    expect(report.unread).toContainEqual({ source: "shared_banks", reasons: expect.arrayContaining([
      expect.stringContaining("no proved mapping"),
    ]) });
  });

  it("keeps an owner bank with no share rows incomplete because it can be used in an unselected course", async () => {
    const { runtime } = fixture({ items: { "70": readResult([bankDrawItem]) } });
    const { report, record, text } = await readFanOut(runtime);

    expect(report.status).toBe("incomplete");
    expect(record.external_course_ids).toEqual([]);
    expect(record.consumers).toEqual([{ course_id: "42", entity_type: "quiz_use", entity_id: "70" }]);
    expect(text).toContain("found no other course, which is not the same as showing that none exists");
    expect(text).toContain("owned by the current user can be used in an unselected course without a share row");

    const { validFanOut } = await bridgeFanOut();
    expect(await validFanOut(record, { bankId, courseId, acknowledgedCourseIds: [], now: now() })).toBeNull();
  });

  it("records a share that names an account as unread, because no route lists its courses", async () => {
    const { runtime } = fixture({ shares: observedShareResult([{ id: "s1", entity_type: "account", entity_id: "3" }]) });
    const { report, record } = await readFanOut(runtime);

    expect(record.unreachable).toEqual(["quiz_uses", "shared_banks"]);
    expect(record.consumers).toEqual([]);
    expect(report.unread).toContainEqual({ source: "shared_banks", reasons: expect.arrayContaining(["One share names an entity of type account, not a course. No Item Bank route lists the courses inside it."]) });
  });

  it("records a quiz item that draws from an unnamed bank as unread", async () => {
    const { runtime } = fixture({ items: { "70": readResult([{ id: "5", entry_type: "BankEntry", entry: {} }]) } });
    const { record, report } = await readFanOut(runtime);

    expect(record.unreachable).toEqual(["quiz_uses", "shared_banks"]);
    expect(record.consumers).toEqual([]);
    expect(report.unread).toContainEqual({ source: "quiz_uses", reasons: expect.arrayContaining([
      expect.stringContaining("draws from an item bank that its item does not name"),
      expect.stringContaining("no authoritative route"),
    ]) });
  });

  it("counts one quiz that draws from the bank twice as one consumer", async () => {
    const { runtime } = fixture({ items: { "70": readResult([bankDrawItem, { id: "7", entry_type: "BankEntry", entry: { bank_id: bankId } }]) } });
    const { record } = await readFanOut(runtime);

    expect(record.consumers).toEqual([{ course_id: "42", entity_type: "quiz_use", entity_id: "70" }]);
    expect(record.complete).toBe(false);
  });

  it("ignores a quiz that draws from another bank", async () => {
    const { runtime } = fixture({ items: { "70": readResult([{ id: "5", entry_type: "BankEntry", entry: { bank_id: "999" } }]) } });
    const { record } = await readFanOut(runtime);

    expect(record.consumers).toEqual([]);
    expect(record.complete).toBe(false);
  });

  it("builds no record when the selected course cannot be confirmed", async () => {
    const { runtime, calls } = fixture({ course: readResult({ id: "43", name: "Chemistry" }) });
    const { result, report } = await readFanOut(runtime);

    expect(result.isError).toBe(true);
    expect(report).toEqual({ schema: "morrow.problem.v1", code: "item_bank_fan_out_not_established" });
    expect(calls.map((call) => call.tool)).toEqual(["canvas_get_single_course_courses"]);
  });

  it("builds no record when the bank is not associated with the selected course", async () => {
    const { runtime, calls } = fixture({ banks: readResult([{ id: "92", title: "Another course bank" }]) });
    const { result, report } = await readFanOut(runtime);

    expect(result.isError).toBe(true);
    expect(report).toEqual({ schema: "morrow.problem.v1", code: "item_bank_fan_out_not_established" });
    expect(calls.find((call) => call.tool === "canvas_item_bank_list_banks")?.arguments)
      .toMatchObject({ course_id: courseId, morrow_max_pages: 25 });
    expect(calls.some((call) => call.tool === "canvas_item_bank_get_bank")).toBe(false);
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

  it("issues a process-local receipt bound to the exact record and source binding", async () => {
    const { runtime } = fixture({ shares: sharedInto(["77"]) });
    const { report, record } = await readFanOut(runtime, ["77"]);
    const receipt = report.fan_out_receipt;

    expect(validItemBankFanOutReceipt(record, receipt, sourceBindingId)).toBe(true);
    expect(validItemBankFanOutReceipt({ ...record, bank_id: "92" }, receipt, sourceBindingId)).toBe(false);
    expect(validItemBankFanOutReceipt(record, receipt, "canvas:other")).toBe(false);
    expect(validItemBankFanOutReceipt(record, "a".repeat(64), sourceBindingId)).toBe(false);
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
