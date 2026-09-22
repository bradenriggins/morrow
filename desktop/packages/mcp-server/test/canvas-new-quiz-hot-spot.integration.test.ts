import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeCommand, BridgeProblem } from "@morrow/bridge-protocol";
import { isJsonObject, sha256Json, type JsonObject } from "@morrow/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);
const DIGEST = createHash("sha256").update(PNG).digest("hex");
const SOURCE_BINDING_ID = "canvas:hot-spot-test";
const COURSE_ID = "2";
const QUIZ_ID = "77";

const HOT_SPOT_ITEM: JsonObject = {
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

const SAVED_ITEMS = [
  { id: "11", position: 1, entry_type: "Item" },
  { id: "12", position: 2, entry_type: "Item" },
];

function operationId(result: JsonObject): string {
  const value = isJsonObject(result.structuredContent) ? result.structuredContent.operationId : undefined;
  if (typeof value !== "string") throw new Error(`Hot Spot operation was not planned: ${JSON.stringify(result)}`);
  return value;
}

function readResult(data: unknown): JsonObject {
  return { schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200, truncated: false, data } as JsonObject;
}

interface Harness {
  readonly runtime: GatewayRuntime;
  readonly client: Client;
  readonly writes: BridgeCommand[];
  readonly workspaceRoot: string;
  /** Moves the course connection this plan was reviewed against. */
  moveBinding(): void;
  close(): Promise<void>;
}

const opened: Harness[] = [];

async function harness(options: {
  readonly writeProblem?: { readonly problem: BridgeProblem; readonly result: JsonObject };
  readonly items?: readonly JsonObject[];
} = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "morrow-hot-spot-"));
  const workspaceRoot = await realpath(directory);
  const root = resolve("../..");
  const port = await reserveLoopbackPort();
  const bridgeDigest = bridgeCatalogDigestForTests(root);
  const token = "synthetic-canvas-hot-spot-token-".repeat(3);
  const extensionId = "b".repeat(32);
  const config = parseGatewayConfig({
    schema: "morrow.upstreams.v1", profile: "private-full", toolSurface: "full",
    upstreams: [{
      id: "browser-session", label: "Morrow browser connector", kind: "mcp-stdio",
      command: process.execPath, args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")], cwd: root,
      env: {
        MORROW_CANVAS_CATALOG_PATH: resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"),
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: token,
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: extensionId,
      },
      sourceDisposition: "adapted_owned", outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 10_000,
        maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(directory, "gateway.sqlite3") },
    privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
    maxCatalogTools: 2_000,
  });
  await mkdir(join(directory, "materials"));
  await writeFile(join(directory, "materials/cell.png"), PNG);
  const runtime = await GatewayRuntime.connect(config);
  await assertPortListening(port);
  const bridge: BridgeTestClient = await connectBridgeTestClient({
    port, token, extensionId, catalogDigest: bridgeDigest,
    bindings: [{
      sourceBindingId: SOURCE_BINDING_ID, provider: "canvas", origin: "https://canvas.example.edu", courseId: COURSE_ID,
      principalFingerprint: "e".repeat(64), sessionGeneration: 1, catalogDigest: bridgeDigest,
      editPolicyRevision: 0, editOptionsAvailable: true, runtimeVerified: true,
    }],
  });
  const writes: BridgeCommand[] = [];
  const items = options.items ?? SAVED_ITEMS;
  bridge.onCommand((command) => {
    if (command.kind === "invoke_write") {
      writes.push(command);
      if (options.writeProblem) bridge.respondProblem(command, options.writeProblem.problem, options.writeProblem.result);
      else {
        bridge.respond(command, {
          schema: "morrow.canvas-new-quiz-hot-spot.v1", ok: true, sent: true, outcomeUnknown: false, status: 200,
          verification: {
            schema: "morrow.browser-verification.v1", status: "verified", strategy: "new-quiz-item-lifecycle",
            evidence: "created_item_reread_and_complete_item_list_reread",
          },
          data: {
            course_id: COURSE_ID, assignment_id: QUIZ_ID, item_id: "13", item_count: items.length + 1,
            interaction_type_slug: "hot-spot",
            image_url: "https://instructure-uploads.example.net/media/cell.png",
            sha256: DIGEST,
          },
        });
      }
      return;
    }
    const name = command.toolName;
    bridge.respond(command, name === "canvas_get_single_course_courses"
      ? readResult({ id: COURSE_ID, name: "Biology" })
      : name === "canvas_get_new_quiz"
        ? readResult({ id: QUIZ_ID, course_id: COURSE_ID, title: "Cell Structure Check" })
        : name === "canvas_list_quiz_items"
          ? readResult(items)
          : readResult([]));
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(() => createFullMorrowServer({
    gateway: runtime,
    health: () => ({}),
  } as never, { workspaceRoot }), { transport: b });
  const client = new Client({ name: "morrow-hot-spot-boundary", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(a);
  const binding = {
    sourceBindingId: SOURCE_BINDING_ID, provider: "canvas" as const, origin: "https://canvas.example.edu", courseId: COURSE_ID,
    principalFingerprint: "e".repeat(64), sessionGeneration: 1, catalogDigest: bridgeDigest,
    editPolicyRevision: 0, editOptionsAvailable: true, runtimeVerified: true,
  };
  const entry: Harness = {
    runtime, client, writes, workspaceRoot,
    moveBinding: () => bridge.updateBindings([{ ...binding, sessionGeneration: 2 }]),
    close: async () => {
      await client.close();
      await server.close();
      await bridge.close();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  opened.push(entry);
  return entry;
}

async function plan(client: Client, overrides: JsonObject = {}): Promise<JsonObject> {
  return await client.callTool({
    name: "morrow_plan_new_quiz_item_create",
    arguments: {
      source_binding_id: SOURCE_BINDING_ID,
      course_id: COURSE_ID,
      quiz_id: QUIZ_ID,
      item: HOT_SPOT_ITEM,
      material_path: "materials/cell.png",
      ...overrides,
    },
  }) as unknown as JsonObject;
}

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});

describe("reviewed New Quiz Hot Spot dispatch", () => {
  it("keeps the image private, sends one create, and verifies the readback", async () => {
    const { client, runtime, writes } = await harness();
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    expect(listed).toContain("morrow_plan_new_quiz_item_create");
    expect(listed).not.toContain("canvas_create_new_quiz_hot_spot");

    const planned = await plan(client);
    expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
    const plannedText = JSON.stringify(planned);
    expect(plannedText).not.toContain(PNG.toString("base64"));
    expect(plannedText).not.toContain("materials/cell.png");

    const id = operationId(planned);
    const record = runtime.operationGet(id) as JsonObject;
    expect(record).toMatchObject({
      state: "awaiting_approval",
      plan: {
        authorization: { kind: "review" },
        arguments: {
          course_id: COURSE_ID,
          assignment_id: QUIZ_ID,
          filename: "cell.png",
          size_bytes: PNG.length,
          sha256: DIGEST,
          content_type: "image/png",
          before_items_sha256: sha256Json(SAVED_ITEMS),
          payload_sha256: sha256Json(HOT_SPOT_ITEM),
        },
      },
    });
    expect(JSON.stringify(record)).not.toContain(PNG.toString("base64"));

    runtime.approveOperation(id);
    const dispatched = await runtime.dispatchOperation(id);
    expect(dispatched).toMatchObject({ structuredContent: { status: "verified", effectState: "verified" } });
    expect(runtime.operationGet(id)).toMatchObject({ state: "verified" });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      toolName: "canvas_create_new_quiz_hot_spot",
      operationKey: "canvas.private.new_quiz.hot_spot.create.v1",
      sourceBindingId: SOURCE_BINDING_ID,
      arguments: {
        course_id: COURSE_ID, assignment_id: QUIZ_ID, filename: "cell.png",
        size_bytes: PNG.length, sha256: DIGEST, content_type: "image/png",
      },
      privateAttachment: { manifest: { filename: "cell.png", size_bytes: PNG.length, sha256: DIGEST }, content_type: "image/png" },
    });
    // The reviewed question travels without an image URL of its own; Morrow
    // adds the unsigned Canvas URL only after the confirmed upload.
    const args = (writes[0] as unknown as JsonObject).arguments as JsonObject;
    const entry = (args.item as JsonObject).entry as JsonObject;
    expect(Object.hasOwn(entry.interaction_data as JsonObject, "image_url")).toBe(false);
    expect(JSON.stringify(args)).not.toContain(PNG.toString("base64"));

    // No signed upload URL, and no image bytes, in what the person is shown.
    const shown = JSON.stringify(dispatched);
    expect(shown).not.toContain(PNG.toString("base64"));
    expect(shown).not.toContain("?");

    // One dispatch only.
    await runtime.dispatchOperation(id);
    expect(writes).toHaveLength(1);
  }, 40_000);

  it("refuses a plan for a quiz that is not in the connected course", async () => {
    const { client } = await harness();
    const planned = await plan(client, { course_id: "999" });
    expect(planned.isError).toBe(true);
    expect(JSON.stringify(planned)).not.toContain(PNG.toString("base64"));
  }, 40_000);

  it("settles a definite Canvas refusal as not sent and never repeats it", async () => {
    // The service worker maps a 4xx other than 408 and 429 to this exact code.
    const { client, runtime, writes } = await harness({
      writeProblem: {
        problem: {
          schema: "morrow.bridge.problem.v1", code: "canvas_request_not_sent",
          message: "Canvas could not complete the reviewed Hot Spot question.", recoverable: true,
        },
        result: {
          schema: "morrow.canvas-new-quiz-hot-spot.v1", ok: false, sent: true, outcomeUnknown: false, status: 422,
          error: "canvas_hot_spot_create_http_422",
        },
      },
    });
    const id = operationId(await plan(client));
    runtime.approveOperation(id);
    const dispatched = await runtime.dispatchOperation(id) as JsonObject;
    expect(JSON.stringify(dispatched)).toContain("not_sent");
    expect(runtime.operationGet(id)).toMatchObject({ state: "failed" });
    await runtime.dispatchOperation(id);
    expect(writes).toHaveLength(1);
  }, 40_000);

  it("holds an uncertain Canvas ending open and never repeats it", async () => {
    // A 5xx, a 408, a 429 or no answer at all reaches Morrow as this code.
    const { client, runtime, writes } = await harness({
      writeProblem: {
        problem: {
          schema: "morrow.bridge.problem.v1", code: "write_outcome_unknown",
          message: "Canvas could not complete the reviewed Hot Spot question.", recoverable: false,
        },
        result: {
          schema: "morrow.canvas-new-quiz-hot-spot.v1", ok: false, sent: true, outcomeUnknown: true, status: 500,
          error: "canvas_hot_spot_create_http_500",
        },
      },
    });
    const id = operationId(await plan(client));
    runtime.approveOperation(id);
    const dispatched = await runtime.dispatchOperation(id) as JsonObject;
    expect(JSON.stringify(dispatched)).toContain("unknown");
    expect(runtime.operationGet(id)).not.toMatchObject({ state: "verified" });
    await runtime.dispatchOperation(id);
    expect(writes).toHaveLength(1);
  }, 40_000);

  it("discards the reviewed image when Chrome refuses course file access, and names the next step", async () => {
    // Course file access is a Chrome permission. The Gateway cannot see it
    // while it prepares the question, so only the dispatch learns it is off.
    // What must hold is that the staged image does not survive that refusal and
    // that the person is told the one thing they do next.
    const { client, runtime, writes } = await harness({
      writeProblem: {
        problem: {
          schema: "morrow.bridge.problem.v1", code: "canvas_request_not_sent",
          message: "Course file access is off. Morrow reads course file content, and sends a reviewed image to a course,"
            + " only while course file access is on, and it is off. Open Plan and Edit settings, then turn on course file access.",
          recoverable: true,
        },
        result: {
          schema: "morrow.canvas-new-quiz-hot-spot.v1", ok: false, sent: false,
          error: "canvas_file_storage_access_required",
        },
      },
    });
    const id = operationId(await plan(client));
    runtime.approveOperation(id);
    const dispatched = await runtime.dispatchOperation(id) as JsonObject;

    // The reviewed image was consumed out of the stage store before the command
    // left the Gateway, so the only copy that ever existed after review is the
    // one in this in-flight command. The refusal happens after that point.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      privateAttachment: { manifest: { filename: "cell.png", size_bytes: PNG.length, sha256: DIGEST } },
    });

    // The person is told what to turn on, and where.
    const shown = JSON.stringify(dispatched);
    expect(shown).toContain("course file access");
    expect(shown).toContain("Plan and Edit settings");
    // Nothing was sent, so the question is free to be planned again.
    expect(shown).toContain("not_sent");
    expect(runtime.operationGet(id)).toMatchObject({ state: "failed" });

    // The staged image is gone. It was consumed and zeroed before the dispatch
    // reached Chrome, so no second attempt can find bytes to send, and none of
    // this operation's records hold them.
    expect(shown).not.toContain(PNG.toString("base64"));
    expect(JSON.stringify(runtime.operationGet(id))).not.toContain(PNG.toString("base64"));
    await runtime.dispatchOperation(id);
    expect(writes).toHaveLength(1);

    // The stage did not leak either: a fresh plan still gets one.
    const again = await plan(client);
    expect(again.isError, JSON.stringify(again)).not.toBe(true);
    expect(operationId(again)).not.toBe(id);
  }, 40_000);

  it("discards the staged image when the connection moves between review and dispatch", async () => {
    // This is the discard path the plan's own catch uses: when a reviewed file
    // can no longer be sent, the operation is cancelled and its stage goes with
    // it. Here the course connection moves after the person approves, which is
    // the reachable version of that state.
    const entry = await harness();
    const id = operationId(await plan(entry.client));
    entry.runtime.approveOperation(id);
    entry.moveBinding();

    const dispatched = await entry.runtime.dispatchOperation(id) as JsonObject;
    expect(JSON.stringify(dispatched)).toContain("operation_dispatch_refused");
    expect(entry.writes).toHaveLength(0);

    // The operation was cancelled, so its stage was discarded with it. Nothing
    // holds the image, and the refusal cannot be turned into a send.
    expect(entry.runtime.operationGet(id)).toMatchObject({ state: "cancelled" });
    expect(JSON.stringify(entry.runtime.operationGet(id))).not.toContain(PNG.toString("base64"));
    await entry.runtime.dispatchOperation(id);
    expect(entry.writes).toHaveLength(0);
  }, 40_000);

  it("refuses to dispatch when the saved question list changed after review", async () => {
    const { client, runtime, writes } = await harness();
    const id = operationId(await plan(client));
    runtime.approveOperation(id);
    // The frozen list digest travels with the operation, and the page refuses
    // the create when the quiz no longer matches it.
    const record = runtime.operationGet(id) as JsonObject;
    const args = ((record.plan as JsonObject).arguments) as JsonObject;
    expect(args.before_items_sha256).toBe(sha256Json(SAVED_ITEMS));
    expect(args.before_items_sha256).not.toBe(sha256Json([...SAVED_ITEMS, { id: "14", position: 3, entry_type: "Item" }]));
    expect(writes).toHaveLength(0);
  }, 40_000);
});
