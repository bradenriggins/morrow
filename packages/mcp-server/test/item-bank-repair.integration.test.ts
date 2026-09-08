import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import type { GatewayRuntime } from "../src/runtime.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

/**
 * The Item Bank lane driven end to end: the real MCP tool surface, the real
 * gateway runtime, the real Canvas connector process, and a real loopback
 * bridge. `test/item-bank-repair.test.ts` proves the planner's rules against a
 * stubbed runtime, and `scripts/test/canvas-item-bank-guard.test.mjs` proves the
 * in-frame guard. Only this path can count how many changes reach the bridge,
 * which is the property that matters for a bank other courses draw from: a
 * question sent twice is a question changed twice, in every one of them.
 *
 * Every ending has its own question, so no case inherits another's target lock:
 * a stale question, a record that was not complete, a record edited after it was
 * read, a course the person did not confirm, one change and no second, a check
 * that did not match, two uncertain endings that are never repeated, and a
 * receipt the frame had already reserved. `writeCommands` is asserted in every
 * one, and no case reports a verified result without a matching fresh read.
 *
 * The bridge here is a stub. It answers the way the Item Banks frame and the
 * service worker do — one reserved effect receipt, the Bridge's own guard module
 * applied to the saved question, a fresh read after the single change — but a
 * real extension host, a real Item Banks frame and a real bank are out of reach
 * on this machine, so nothing in this file is live proof that Canvas behaves
 * this way.
 */
const CASE_TIMEOUT_MS = 30_000;
const SETUP_TIMEOUT_MS = 60_000;

const ORIGIN = "https://canvas.example.edu";
const SOURCE_BINDING_ID = "canvas:item-bank-repair";
const TOKEN = "morrow-item-bank-repair-token-".repeat(3);
const EXTENSION_ID = "a".repeat(32);
const COURSE_ID = "42";
const COURSE_NAME = "Biology";
const BANK_ID = "91";
const QUIZ_ID = "301";
const ALT_TEXT = "Diagram of a cell membrane";
const IMAGE_SOURCE = `/courses/${COURSE_ID}/files/900`;
const QUESTION_TEXT = "Identify the labelled structure.";
const IMAGE_TAG = `<img src="${IMAGE_SOURCE}">`;
const BODY = `<p>${QUESTION_TEXT}</p>${IMAGE_TAG}`;

/** One question per ending, so a locked target in one case cannot answer another. */
const CASES = {
  stale: { itemId: "501", entryId: "701" },
  incomplete: { itemId: "502", entryId: "702" },
  edited: { itemId: "503", entryId: "703" },
  unconfirmed: { itemId: "504", entryId: "704" },
  dispatched: { itemId: "505", entryId: "705" },
  mismatch: { itemId: "506", entryId: "706" },
  unanswered: { itemId: "507", entryId: "707" },
  unread: { itemId: "508", entryId: "708" },
  replayed: { itemId: "509", entryId: "709" },
} as const;

type CaseName = keyof typeof CASES;

/** How the stub Item Banks frame ends the one change it is sent. */
type WriteEnding = "verified" | "mismatch" | "unanswered" | "unread" | "replayed";

function question(itemId: string, body: string): JsonObject {
  return {
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
}

/**
 * The digest the Item Banks frame recomputes before it sends anything, from
 * `connector/extension/src/item-bank-guard.js`. That module is plain JavaScript
 * with no declaration file, so the planner mirrors its rules in TypeScript and
 * this file reads the digests from the module itself rather than restating them.
 */
type BridgeGuardModule = {
  itemBankItemDigest(item: unknown): Promise<string>;
  applyItemBankImageAlt(body: string, guard: unknown): Promise<{ body?: string; error?: string }>;
};

function structured(result: unknown): JsonObject {
  const value = isJsonObject(result) ? result.structuredContent : undefined;
  return isJsonObject(value) ? value : {};
}

function text(result: unknown): string {
  const content = isJsonObject(result) && Array.isArray(result.content) ? result.content : [];
  return content.map((entry) => isJsonObject(entry) && typeof entry.text === "string" ? entry.text : "").join("\n");
}

describe("guarded Item Bank question repair through the MCP runtime", () => {
  let directory = "";
  let morrow: MorrowRuntime | undefined;
  let runtime: GatewayRuntime;
  let bridge: BridgeTestClient | undefined;
  let server: ReturnType<typeof serveStdio> | undefined;
  let client: Client | undefined;
  let guard: BridgeGuardModule;

  /** The saved bank, read fresh by every plan and by every check after a change. */
  const items = new Map<string, JsonObject>();
  const digests = new Map<string, string>();
  /** Every change that reached the bridge, in order. No case may add two. */
  const writeCommands: BridgeCommand[] = [];
  /** The service worker reserves one effect receipt per change; a used one is refused. */
  const usedReceipts = new Set<string>();
  const endings = new Map<string, WriteEnding>();

  function itemIdOf(command: BridgeCommand): string {
    return String((command.arguments ?? {}).item_id ?? "");
  }

  function readData(command: BridgeCommand): unknown {
    const args = command.arguments ?? {};
    switch (command.toolName) {
      case "canvas_get_single_course_courses":
        return { id: String(args.id), name: COURSE_NAME };
      // The learner privacy boundary this course is read behind. No question in
      // this bank names a learner, and this fixture course enrols none.
      case "canvas_list_users_in_course_users":
        return [];
      case "canvas_item_bank_get_bank":
        return { id: BANK_ID, title: "Cell biology bank" };
      case "canvas_item_bank_list_entries":
        return [...Object.values(CASES)].map((entry) => ({ id: entry.entryId, entry_type: "Item", entry_id: entry.itemId }));
      case "canvas_item_bank_list_shares":
        return [
          { id: "1", entity_type: "course", entity_id: "77" },
          { id: "2", entity_type: "course", entity_id: "88" },
        ];
      case "canvas_list_new_quizzes":
        return [{ id: args.course_id === COURSE_ID ? QUIZ_ID : `8${args.course_id}`, course_id: args.course_id, title: "Cell transport quiz" }];
      case "canvas_get_new_quiz":
        return { id: args.assignment_id, course_id: args.course_id, title: "Cell transport quiz" };
      case "canvas_list_quiz_items":
        return [{ id: "9001", course_id: args.course_id, quiz_id: args.assignment_id, entry_type: "BankEntry", bank_id: BANK_ID }];
      case "canvas_item_bank_get_entry": {
        const found = [...Object.values(CASES)].find((entry) => entry.entryId === args.bank_entry_id);
        return found ? { id: found.entryId, entry_type: "Item", entry_id: found.itemId } : null;
      }
      case "canvas_item_bank_get_item":
        return items.get(String(args.item_id)) ?? null;
      default:
        throw new Error(`unexpected read ${command.toolName}`);
    }
  }

  /**
   * The stub Item Banks frame. It refuses a reused effect receipt the way
   * `reserveReceiptNow` in `connector/extension/src/service-worker.js` does,
   * changes only the selected image alternative text through the Bridge's own
   * guard module, then reads the question again and reports what it read.
   */
  async function answerWrite(command: BridgeCommand): Promise<void> {
    writeCommands.push(command);
    const receipt = String(command.outerGrant?.effectReceiptId ?? "");
    if (!receipt || usedReceipts.has(receipt)) {
      bridge?.respondProblem(command, {
        schema: "morrow.bridge.problem.v1",
        code: "effect_receipt_refused",
        message: "The provider effect receipt is missing or was already used.",
        recoverable: false,
      });
      return;
    }
    usedReceipts.add(receipt);
    const itemId = itemIdOf(command);
    const ending = endings.get(itemId) ?? "verified";
    if (ending === "replayed") {
      // The service worker already reserved this receipt, so this change is a
      // repeat of one it has seen. It sends nothing and says so.
      bridge?.respondProblem(command, {
        schema: "morrow.bridge.problem.v1",
        code: "effect_receipt_refused",
        message: "The provider effect receipt is missing or was already used.",
        recoverable: false,
      });
      return;
    }
    if (ending === "unanswered") {
      bridge?.respondProblem(command, {
        schema: "morrow.bridge.problem.v1",
        code: "write_outcome_unknown",
        message: "Canvas did not answer this change, so it may have been saved.",
        recoverable: false,
      });
      return;
    }
    const saved = items.get(itemId)!;
    const applied = await guard.applyItemBankImageAlt(String((saved.entry as JsonObject).item_body), command.arguments?.morrow_item_bank_guard);
    expect(applied.error, `the stub frame refused the guard for item ${itemId}`).toBeUndefined();
    const stored = ending === "mismatch"
      // Canvas saved something else. The frame reads that, and says so.
      ? question(itemId, `<p>${QUESTION_TEXT}</p><img src="${IMAGE_SOURCE}" alt="Something else entirely">`)
      : question(itemId, applied.body!);
    items.set(itemId, stored);
    if (ending === "unread") {
      // The one change was sent and the frame could not read the question
      // again: a collapsed Item Banks frame ends here, and it is not a failure.
      bridge?.respondProblem(command, {
        schema: "morrow.bridge.problem.v1",
        code: "write_outcome_unknown",
        message: "Morrow sent this change and could not read the question again to check it.",
        recoverable: false,
      });
      return;
    }
    bridge?.respond(command, {
      schema: "morrow.canvas-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data: { id: itemId },
      verification: {
        schema: "morrow.browser-verification.v1",
        status: ending === "mismatch" ? "mismatch" : "verified",
        strategy: "updated-resource",
        readTool: "canvas_item_bank_get_item",
        evidence: ending === "mismatch"
          ? "fresh_readback_differs_from_requested_postcondition"
          : "fresh_readback_matches_requested_postcondition",
      },
    });
  }

  /** Reads the affected-course record for this bank through the published reader. */
  async function readFanOut(quizUseCourseIds: readonly string[] = ["77", "88"]): Promise<JsonObject> {
    const result = await client!.callTool({
      name: "morrow_read_item_bank_fan_out",
      arguments: {
        source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, bank_id: BANK_ID,
        quiz_use_course_ids: [...quizUseCourseIds],
      },
    }) as CallToolResult;
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return structured(result).fan_out as JsonObject;
  }

  /** Asks for one repair through the published MCP tool, with this case's overrides. */
  async function plan(name: CaseName, fanOut: JsonObject, overrides: JsonObject = {}): Promise<CallToolResult> {
    const target = CASES[name];
    return await client!.callTool({
      name: "morrow_plan_item_bank_question_image_alt_repair",
      arguments: {
        source_binding_id: SOURCE_BINDING_ID,
        course_id: COURSE_ID,
        bank_id: BANK_ID,
        bank_entry_id: target.entryId,
        item_id: target.itemId,
        item_sha256: digests.get(target.itemId),
        image_index: 1,
        image_src_sha256: sha256Text(IMAGE_SOURCE),
        alt_text: ALT_TEXT,
        fan_out: fanOut,
        acknowledged_course_ids: ["77", "88"],
        ...overrides,
      },
    }) as CallToolResult;
  }

  function operationId(result: CallToolResult): string {
    const value = structured(result).operationId;
    expect(typeof value, JSON.stringify(result)).toBe("string");
    return String(value);
  }

  /**
   * Nothing Morrow returns carries the question source, the image address, the
   * guard, or the Item Banks credential the frame holds. The credential name is
   * checked by hand because it never appears in any fixture here: if it ever
   * reaches a result, it came from the frame.
   */
  function expectNoSourceDisclosure(...results: unknown[]): void {
    const rendered = JSON.stringify(results);
    expect(rendered).not.toContain(QUESTION_TEXT);
    expect(rendered).not.toContain(IMAGE_SOURCE);
    expect(rendered).not.toContain("banks.build");
    expect(rendered).not.toContain("morrow_item_bank_guard");
    expect(rendered).not.toContain("protected_state_sha256");
    expect(rendered).not.toContain("<img");
  }

  beforeAll(async () => {
    const root = resolve("../..");
    guard = await import(
      new URL("../../../connector/extension/src/item-bank-guard.js", import.meta.url).href
    ) as BridgeGuardModule;
    for (const target of Object.values(CASES)) {
      const saved = question(target.itemId, BODY);
      items.set(target.itemId, saved);
      digests.set(target.itemId, await guard.itemBankItemDigest(saved));
    }
    directory = mkdtempSync(join(tmpdir(), "morrow-item-bank-repair-"));
    const port = await reserveLoopbackPort();
    const catalogDigest = bridgeCatalogDigestForTests(root);

    morrow = await MorrowRuntime.connect(parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      upstreams: [{
        id: "canvas-session",
        label: "Morrow Canvas Connector",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")],
        cwd: root,
        env: {
          MORROW_CANVAS_CATALOG_PATH: resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"),
          MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
          MORROW_CANVAS_CONNECTOR_PORT: String(port),
          MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN,
          MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID,
        },
        sourceDisposition: "adapted_owned",
        outputPrivacy: {},
        outputPrivacyDefault: {
          allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 10_000,
          maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
        },
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: join(directory, "gateway.sqlite3") },
      privacy: {
        canvasOrigin: "browser-session", account: "local", principal: "local",
        learnerVaultPath: join(directory, "vault.json"),
      },
      maxCatalogTools: 2_000,
    }), { statePath: join(directory, "batch.sqlite3") });
    runtime = morrow.gateway;
    await assertPortListening(port);

    bridge = await connectBridgeTestClient({
      port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest,
      bindings: [COURSE_ID, "77", "88"].map((id) => ({
        sourceBindingId: id === COURSE_ID ? SOURCE_BINDING_ID : `canvas:course-${id}`,
        provider: "canvas", origin: ORIGIN, courseId: id,
        courseName: COURSE_NAME, principalFingerprint: "c".repeat(64), sessionGeneration: 1,
        catalogDigest, editPolicyRevision: 0, editOptionsAvailable: true, runtimeVerified: true,
      })),
    });
    bridge.onCommand((command) => {
      if (command.kind === "invoke_write") {
        void answerWrite(command);
        return;
      }
      if (command.kind !== "invoke_read") return;
      bridge?.respond(command, {
        schema: "morrow.canvas-browser-result.v1",
        ok: true, sent: true, status: 200, truncated: false,
        data: readData(command) as JsonObject,
      });
    });

    const [left, right] = InMemoryTransport.createLinkedPair();
    server = serveStdio(() => createFullMorrowServer(morrow!), { transport: right });
    client = new Client({ name: "morrow-item-bank-repair", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(left);
    const published = (await client.listTools()).tools.map((tool) => tool.name);
    expect(published).toEqual(expect.arrayContaining(["morrow_read_item_bank_fan_out", "morrow_plan_item_bank_question_image_alt_repair"]));
    // The guarded question write is Morrow's own route into the Item Banks
    // frame, not a capability an assistant may reach for on its own.
    expect(published).not.toContain("canvas_item_bank_update_item");
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await bridge?.close();
    await morrow?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("reads which courses one item bank reaches, and says so only when every source was read", async () => {
    const complete = await client!.callTool({
      name: "morrow_read_item_bank_fan_out",
      arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, bank_id: BANK_ID, quiz_use_course_ids: ["77", "88"] },
    }) as CallToolResult;
    const record = structured(complete).fan_out as JsonObject;
    expect(record).toMatchObject({
      schema: "morrow.canvas.item-bank.fan-out.v1",
      bank_id: BANK_ID, course_id: COURSE_ID, complete: true, unreachable: [], external_course_ids: ["77", "88"],
    });
    // Each course has its own bound quiz read, and every drawing quiz is a consumer.
    expect(record.consumers).toEqual([
      { course_id: COURSE_ID, entity_type: "quiz_use", entity_id: QUIZ_ID },
      { course_id: "77", entity_type: "quiz_use", entity_id: "877" },
      { course_id: "77", entity_type: "shared_bank", entity_id: "77" },
      { course_id: "88", entity_type: "quiz_use", entity_id: "888" },
      { course_id: "88", entity_type: "shared_bank", entity_id: "88" },
    ]);
    expect(text(complete)).toContain("course 77, course 88");
    expect(writeCommands).toHaveLength(0);
    expectNoSourceDisclosure(complete);
  }, CASE_TIMEOUT_MS);

  it("1. refuses a question that changed since the signal, and sends nothing", async () => {
    const result = await plan("stale", await readFanOut(), { item_sha256: "0".repeat(64) });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("This item bank question changed since this accessibility signal.");
    expect(text(result)).toContain("Run the audit again before planning a repair.");
    // Nothing here is offered as a change Morrow can retry as it stands.
    expect(structured(result).recoverable).not.toBe(true);
    expect(writeCommands).toHaveLength(0);
    expectNoSourceDisclosure(result);
  }, CASE_TIMEOUT_MS);

  it("2. refuses an incomplete affected-course record, and names the source it could not read", async () => {
    const partial = await client!.callTool({
      name: "morrow_read_item_bank_fan_out",
      arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, bank_id: BANK_ID, quiz_use_course_ids: [] },
    }) as CallToolResult;
    const record = structured(partial).fan_out as JsonObject;
    expect(record).toMatchObject({ complete: false, unreachable: ["quiz_uses"] });
    expect(text(partial)).toContain("This record is not complete");
    expect(text(partial)).toContain("An unread source is not an empty result.");
    // The unread source is named where the person can act on it: quiz use in
    // the courses this bank is shared into cannot be read from this course.
    expect(text(partial)).toContain("quiz use");

    const result = await plan("incomplete", record);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Morrow could not read every course this item bank reaches.");
    expect(text(result)).toContain("A source it could not read is not an empty list of courses");
    expect(structured(result).recoverable).not.toBe(true);
    expect(writeCommands).toHaveLength(0);
    expectNoSourceDisclosure(partial, result);
  }, CASE_TIMEOUT_MS);

  it("3. refuses a record edited after it was read, and sends nothing", async () => {
    const record = await readFanOut();
    const consumers = record.consumers as JsonObject[];
    const edited = {
      ...record,
      // One course dropped from the list after the digest over it was taken.
      consumers: consumers.filter((consumer) => consumer.course_id !== "88"),
      external_course_ids: ["77"],
      consumer_count: consumers.length - 1,
    };
    const result = await plan("edited", edited, { acknowledged_course_ids: ["77"] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("does not match this bank, this course, and its own record");
    expect(text(result)).toContain("morrow_read_item_bank_fan_out");
    expect(structured(result).recoverable).not.toBe(true);
    expect(writeCommands).toHaveLength(0);
    expectNoSourceDisclosure(result);
  }, CASE_TIMEOUT_MS);

  it("4. refuses when a course the bank reaches was not confirmed, and names that course", async () => {
    const result = await plan("unconfirmed", await readFanOut(), { acknowledged_course_ids: ["77"] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("The confirmed courses are not exactly the courses this item bank reaches.");
    // The person is told which course is missing, not only that one is.
    expect(text(result)).toContain("course 88");
    expect(structured(result).recoverable).not.toBe(true);
    expect(writeCommands).toHaveLength(0);
    expectNoSourceDisclosure(result);
  }, CASE_TIMEOUT_MS);

  it("5. sends exactly one change, checks it, and will not send it again", async () => {
    const target = CASES.dispatched;
    const planned = await plan("dispatched", await readFanOut());
    expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
    const id = operationId(planned);
    // The courses this bank reaches are named before the change is described.
    expect(text(planned).indexOf("course 77, course 88")).toBeLessThan(text(planned).indexOf("alternative-text repair for image 1"));
    expect(writeCommands).toHaveLength(0);

    runtime.approveOperation(id);
    const dispatched = await runtime.dispatchOperation(id);
    expect(dispatched.isError, JSON.stringify(dispatched)).not.toBe(true);
    expect(structured(dispatched)).toMatchObject({
      effectState: "verified", status: "verified", phase: "verified_readback",
      verification: { status: "verified" }, attention: [], limitations: [],
    });
    expect(runtime.effects.get(id)).toMatchObject({ state: "verified", verificationStatus: "verified", dispatchAttempt: 1 });

    // One change reached the bridge, carrying the bank, the question and the
    // guard, and nothing else. The question body is not in it: the Item Banks
    // frame builds it from its own fresh read.
    expect(writeCommands).toHaveLength(1);
    const sent = writeCommands[0]!;
    expect(sent.toolName).toBe("canvas_item_bank_update_item");
    expect(Object.keys(sent.arguments ?? {}).sort()).toEqual(["bank_id", "item_id", "morrow_item_bank_guard"]);
    expect(sent.arguments).toMatchObject({ bank_id: BANK_ID, item_id: target.itemId });
    expect((sent.arguments!.morrow_item_bank_guard as JsonObject)).toMatchObject({
      kind: "item_bank_entry_image_alt", course_id: COURSE_ID, entry_type: "Item",
      item_sha256: digests.get(target.itemId), alt_text: ALT_TEXT, acknowledged_course_ids: ["77", "88"],
    });
    expect(usedReceipts.size).toBe(1);

    // The change landed: the saved question now carries the alternative text,
    // and the question text, answers and scoring are untouched.
    const saved = items.get(target.itemId)!;
    expect((saved.entry as JsonObject).item_body).toBe(`<p>${QUESTION_TEXT}</p><img src="${IMAGE_SOURCE}" alt="${ALT_TEXT}">`);
    expect((saved.entry as JsonObject).scoring_data).toEqual({ value: "a" });

    // The same settled change asked for again sends nothing. The effect receipt
    // the service worker reserves is never offered twice, because the runtime
    // does not reach the bridge a second time for a change it already settled.
    const again = await runtime.dispatchOperation(id);
    expect(again.isError).toBe(true);
    expect(writeCommands).toHaveLength(1);
    expect(runtime.effects.get(id)).toMatchObject({ state: "verified", dispatchAttempt: 1 });
    expectNoSourceDisclosure(planned, dispatched, again);
  }, CASE_TIMEOUT_MS);

  it("6. reports a check that did not match as unverified, and does not claim the change was applied", async () => {
    const target = CASES.mismatch;
    endings.set(target.itemId, "mismatch");
    const planned = await plan("mismatch", await readFanOut());
    expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
    const id = operationId(planned);
    runtime.approveOperation(id);
    const dispatched = await runtime.dispatchOperation(id);

    // The change was sent and the fresh read does not hold it. Morrow reports
    // that, and never as an applied change: nothing here says verified.
    expect(structured(dispatched)).toMatchObject({
      status: "unconfirmed", phase: "readback_unconfirmed", effectState: "awaiting_verification",
      verification: { status: "unconfirmed" },
      attention: ["readback_did_not_match_frozen_comparator"],
      data: { result: { verification: { status: "mismatch" } } },
    });
    expect(runtime.effects.get(id)).toMatchObject({ verificationStatus: "unconfirmed", dispatchAttempt: 1 });
    expect(runtime.effects.get(id).state).not.toBe("verified");
    expect(structured(dispatched).recoverable).not.toBe(true);
    expect(text(dispatched)).toContain("Morrow could not confirm this change.");
    expect(text(dispatched)).toContain("Do not repeat this change.");
    expect(writeCommands).toHaveLength(2);
    expectNoSourceDisclosure(planned, dispatched);
  }, CASE_TIMEOUT_MS);

  it("7. keeps an unanswered change and an unread check uncertain, and never sends either again", async () => {
    for (const [name, itemId] of [["unanswered", CASES.unanswered.itemId], ["unread", CASES.unread.itemId]] as const) {
      endings.set(itemId, name);
      const before = writeCommands.length;
      const planned = await plan(name, await readFanOut());
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      const id = operationId(planned);
      runtime.approveOperation(id);
      const dispatched = await runtime.dispatchOperation(id);

      // The change may or may not have been saved. Morrow says so, keeps the
      // record open, and does not offer to send it again.
      expect(structured(dispatched), `${name}: ${JSON.stringify(dispatched)}`).toMatchObject({
        status: "indeterminate", phase: "dispatch_failed", effectState: "applied_or_unknown",
        verification: { status: "unconfirmed" },
        limitations: ["Morrow will not replay this operation because the provider effect may have occurred."],
        data: { ok: false, problem: { code: "write_outcome_unknown", recoverable: false } },
      });
      expect(structured(dispatched).attention, name).toContain("provider_effect_may_have_landed");
      expect(runtime.effects.get(id), name).toMatchObject({ state: "applied_or_unknown", dispatchAttempt: 1 });
      // The person is told to check the bank before they change anything else.
      expect(text(dispatched), name).toContain("Morrow cannot confirm the result.");
      expect(text(dispatched), name).toContain("check the existing request");
      expect(text(dispatched), name).toContain("Do not repeat this change.");
      expect(writeCommands.length, name).toBe(before + 1);

      // Asked for again, the uncertain record sends nothing.
      const again = await runtime.dispatchOperation(id);
      expect(again.isError, name).toBe(true);
      expect(writeCommands.length, name).toBe(before + 1);
      expect(runtime.effects.get(id), name).toMatchObject({ state: "applied_or_unknown", dispatchAttempt: 1 });
      expectNoSourceDisclosure(planned, dispatched, again);
    }
    // Four changes so far: one settled, one unmatched, two uncertain.
    expect(writeCommands).toHaveLength(4);
    expect(usedReceipts.size).toBe(4);
    expect(new Set(writeCommands.map((command) => itemIdOf(command))).size).toBe(4);
  }, CASE_TIMEOUT_MS);

  it("surfaces a refused effect receipt as a change that was not sent, and does not send it again", async () => {
    const target = CASES.replayed;
    endings.set(target.itemId, "replayed");
    const planned = await plan("replayed", await readFanOut());
    expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
    const id = operationId(planned);
    runtime.approveOperation(id);
    const dispatched = await runtime.dispatchOperation(id);

    // The Item Banks frame reserves one effect receipt per change
    // (`reserveReceiptNow` in connector/extension/src/service-worker.js). A
    // receipt it has already seen means this change was sent once before, so
    // the frame sends nothing and Morrow reports it as not sent, not as done.
    expect(structured(dispatched)).toMatchObject({
      status: "indeterminate", phase: "dispatch_failed", effectState: "applied_or_unknown",
      limitations: ["Morrow will not replay this operation because the provider effect may have occurred."],
      data: { ok: false, problem: { code: "effect_receipt_refused", recoverable: false } },
    });
    // A reserved receipt means an earlier attempt already reached Canvas, so
    // this ending stays uncertain rather than failed. Morrow tells the person
    // to check the bank, and never offers to send it again.
    expect(structured(dispatched).attention).toContain("provider_effect_may_have_landed");
    expect(structured(dispatched).verification).toMatchObject({ status: "unconfirmed" });
    expect(text(dispatched)).toContain("check the existing request");
    expect(text(dispatched)).toContain("Do not repeat this change.");
    expect(runtime.effects.get(id)).toMatchObject({ state: "applied_or_unknown", dispatchAttempt: 1 });
    expect(writeCommands).toHaveLength(5);

    const again = await runtime.dispatchOperation(id);
    expect(again.isError).toBe(true);
    expect(writeCommands).toHaveLength(5);
    expect(new Set(writeCommands.map((command) => itemIdOf(command))).size).toBe(5);
    expectNoSourceDisclosure(planned, dispatched, again);
  }, CASE_TIMEOUT_MS);
});
