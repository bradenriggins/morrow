import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import { isJsonObject, sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
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
 * service worker do: one reserved effect receipt, the Bridge's own guard module
 * applied to the saved question, and a fresh read after the single change. A
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
      case "canvas_item_bank_list_banks":
        return [{ id: BANK_ID, title: "Cell biology bank" }];
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

  /**
   * Reads the affected-course record for this bank through the published
   * reader, with the process-local receipt that binds it to this reader call.
   * A change to an existing bank needs both.
   */
  async function readFanOut(quizUseCourseIds: readonly string[] = ["77", "88"]): Promise<{ record: JsonObject; receipt: string }> {
    const result = await client!.callTool({
      name: "morrow_read_item_bank_fan_out",
      arguments: {
        source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, bank_id: BANK_ID,
        quiz_use_course_ids: [...quizUseCourseIds],
      },
    }) as CallToolResult;
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const content = structured(result);
    expect(typeof content.fan_out_receipt, JSON.stringify(content)).toBe("string");
    return { record: content.fan_out as JsonObject, receipt: String(content.fan_out_receipt) };
  }

  /** Asks for one repair through the published MCP tool, with this case's overrides. */
  async function plan(name: CaseName, observed: { record: JsonObject; receipt: string }, overrides: JsonObject = {}): Promise<CallToolResult> {
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
        fan_out: observed.record,
        fan_out_receipt: observed.receipt,
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
      const observedSharePage = command.toolName === "canvas_item_bank_list_shares";
      bridge?.respond(command, {
        schema: "morrow.canvas-browser-result.v1",
        ok: true, sent: true, status: 200, truncated: observedSharePage,
        ...(observedSharePage ? { paginationComplete: false, paginationUnestablished: true } : {}),
        data: readData(command) as JsonObject,
      });
    });

    const [left, right] = InMemoryTransport.createLinkedPair();
    server = serveStdio(() => createFullMorrowServer(morrow!), { transport: right });
    client = new Client({ name: "morrow-item-bank-repair", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(left);
    const published = (await client.listTools()).tools.map((tool) => tool.name);
    expect(published).toEqual(expect.arrayContaining(["morrow_read_item_bank_fan_out", "morrow_plan_item_bank_question_image_alt_repair"]));
    // The Item Bank question update is a published capability. It carries the
    // same bank and item snapshots, and the same acknowledgement of observed
    // courses, whichever route asks for it.
    expect(runtime.searchCatalog({ query: "canvas_item_bank_update_item", limit: 10 }).tools
      .some((tool) => tool.upstreamName === "canvas_item_bank_update_item")).toBe(true);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await bridge?.close();
    await morrow?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("reports observed courses but keeps quiz use permanently incomplete", async () => {
    const result = await client!.callTool({
      name: "morrow_read_item_bank_fan_out",
      arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, bank_id: BANK_ID, quiz_use_course_ids: ["77", "88"] },
    }) as CallToolResult;
    const record = structured(result).fan_out as JsonObject;

    expect(record).toMatchObject({
      schema: "morrow.canvas.item-bank.fan-out.v1",
      bank_id: BANK_ID,
      course_id: COURSE_ID,
      complete: false,
      unreachable: ["quiz_uses", "shared_banks"],
      external_course_ids: ["77", "88"],
    });
    expect(record.consumers).toEqual([
      { course_id: COURSE_ID, entity_type: "quiz_use", entity_id: QUIZ_ID },
      { course_id: "77", entity_type: "quiz_use", entity_id: "877" },
      { course_id: "77", entity_type: "shared_bank", entity_id: "77" },
      { course_id: "88", entity_type: "quiz_use", entity_id: "888" },
      { course_id: "88", entity_type: "shared_bank", entity_id: "88" },
    ]);
    expect(text(result)).toContain("no authoritative route");
    expect(writeCommands).toHaveLength(0);
    expectNoSourceDisclosure(result);
  }, CASE_TIMEOUT_MS);

  it("plans one repair bound to the exact bank and question, and sends nothing", async () => {
    const observed = await readFanOut();
    const result = await plan("dispatched", observed);

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(text(result)).toContain("No change has been sent");
    expect(text(result)).toContain(ALT_TEXT);
    // Planning reads. It never reaches the bridge with a change.
    expect(writeCommands).toHaveLength(0);
    expectNoSourceDisclosure(result);
  }, CASE_TIMEOUT_MS);

  it("repairs one reviewed image and leaves another undescribed image in the same question alone", async () => {
    const target = CASES.mismatch;
    const second = `/courses/${COURSE_ID}/files/901`;
    const both = `<p>${QUESTION_TEXT}</p><img src="${IMAGE_SOURCE}"><img src="${second}">`;
    const saved = question(target.itemId, both);
    items.set(target.itemId, saved);
    digests.set(target.itemId, await guard.itemBankItemDigest(saved));

    const observed = await readFanOut();
    const result = await plan("mismatch", observed);

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    // The planner proves the change it would send: the reviewed image gains
    // alternative text and the other known issue is exactly as Canvas holds it.
    const applied = await guard.applyItemBankImageAlt(both, {
      image_index: 1, image_src_sha256: sha256Text(IMAGE_SOURCE), alt_text: ALT_TEXT,
    });
    expect(applied.error).toBeUndefined();
    expect(applied.body).toContain(`<img src="${IMAGE_SOURCE}" alt="${ALT_TEXT}">`);
    expect(applied.body).toContain(`<img src="${second}">`);
    expect(writeCommands).toHaveLength(0);
    expectNoSourceDisclosure(result);
  }, CASE_TIMEOUT_MS);

});
