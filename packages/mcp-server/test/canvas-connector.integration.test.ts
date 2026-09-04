import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCHEMAS, parseBridgeJson, serializeBridgeMessage, type BridgeCommand } from "@morrow/bridge-protocol";
import { loadCanvasApiCatalog } from "@morrow/canvas-api-catalog";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { GatewayRuntime } from "../src/runtime.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function operationId(result: JsonObject): string {
  const value = isJsonObject(result.structuredContent) ? result.structuredContent.operationId : undefined;
  if (typeof value !== "string") throw new Error("operation id missing");
  return value;
}

function connectorConfig(directory: string, port: number) {
  const root = resolve("../..");
  const catalogPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
  return parseGatewayConfig({
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
        MORROW_CANVAS_CATALOG_PATH: catalogPath,
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: "gateway-connector-secret-".repeat(3),
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: "a".repeat(32),
      },
      sourceDisposition: "adapted_owned",
      outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [],
        fieldPolicy: "scrub-sensitive",
        dataClass: "learner",
        maxRecords: 10_000,
        maxBytes: 2_000_000,
        freeText: "allow",
        learnerTokens: true,
        artifactInspection: "deny",
        aiClientAdmission: "allow",
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(directory, "gateway.sqlite3") },
    privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
    maxCatalogTools: 2_000,
  });
}

async function approveBatch(url: string): Promise<void> {
  const page = await fetch(url);
  const body = await page.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(body)?.[1];
  const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
  expect(nonce).toBeTruthy();
  expect(cookie).toBeTruthy();
  const response = await fetch(`${url}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookie!,
      origin: new URL(url).origin,
      referer: url,
    },
    body: new URLSearchParams({ nonce: nonce! }),
  });
  expect(response.status).toBe(200);
}

describe("Canvas connector gateway path", () => {
  it("plans, approves, grants, dispatches, and verifies one browser-session write", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-connector-gateway-"));
    const port = await availablePort();
    const root = resolve("../..");
    const catalogPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
    const connectorCatalog = loadCanvasApiCatalog(catalogPath);
    const config = connectorConfig(directory, port);
    const runtime = await GatewayRuntime.connect(config, { journalPath: join(directory, "gateway.sqlite3") });
    const extensionId = "a".repeat(32);
    const sourceBindingId = "canvas:test-account";
    const socket = new WebSocket(`ws://127.0.0.1:${port}/morrow-bridge/v1`, { origin: `chrome-extension://${extensionId}` });
    try {
      await once(socket, "open");
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.hello,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        token: "gateway-connector-secret-".repeat(3),
        extensionId,
        runtimeRevision: "1.0.0-rc.0",
        catalogDigest: connectorCatalog.catalogDigest,
        bindings: [{ sourceBindingId, provider: "canvas", origin: "https://school.instructure.com", principalFingerprint: "c".repeat(64), sessionGeneration: 1, runtimeVerified: true }],
        sentAt: Date.now(),
      }));
      const [readyRaw] = await once(socket, "message");
      const ready = parseBridgeJson(readyRaw.toString()) as { generation: number };
      let writeCommands = 0;
      socket.on("message", (raw) => {
        const value = parseBridgeJson(raw.toString()) as { schema?: string };
        if (value.schema !== BRIDGE_SCHEMAS.command) return;
        const command = value as BridgeCommand;
        if (command.kind === "invoke_write") {
          writeCommands += 1;
          expect(command.outerGrant).toMatchObject({ dispatchAttempt: 1 });
        }
        socket.send(serializeBridgeMessage({
          schema: BRIDGE_SCHEMAS.result,
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          requestId: command.requestId,
          operationId: command.operationId,
          generation: command.generation,
          ok: true,
          result: {
            schema: "morrow.canvas-browser-result.v1",
            ok: true,
            sent: true,
            status: 200,
            data: { id: "42", name: "Biology" },
            ...(command.kind === "invoke_write" ? {
              verification: {
                schema: "morrow.browser-verification.v1",
                status: "verified",
                strategy: "collection-contains-target",
                readTool: "canvas_list_favorite_courses",
                evidence: "fresh_readback_matches_requested_postcondition",
              },
            } : {}),
          },
          completedAt: Date.now(),
        }));
      });

      const planned = await runtime.call("canvas_add_course_to_favorites", {
        id: "42",
        _morrow: {
          operation_id: "operation:canvas-connector-gateway-test",
          source_binding_id: sourceBindingId,
        },
      });
      const id = operationId(planned);
      expect(planned.structuredContent).toMatchObject({ status: "awaiting_approval" });
      runtime.approveOperation(id);
      const dispatched = await runtime.dispatchOperation(id);
      expect(dispatched.structuredContent).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(writeCommands).toBe(1);

      const unbound = await runtime.call("canvas_add_course_to_favorites", {
        id: "43",
        _morrow: { operation_id: "operation:unbound-connector-test" },
      });
      expect(unbound).toMatchObject({ isError: true, structuredContent: { data: { code: "operation_plan_invalid" } } });

      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.bindings,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: ready.generation,
        bindings: [],
        sentAt: Date.now(),
      }));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      const stalePlan = await runtime.call("canvas_add_course_to_favorites", {
        id: "44",
        _morrow: {
          operation_id: "operation:stale-binding-connector-test",
          source_binding_id: sourceBindingId,
        },
      });
      const staleId = operationId(stalePlan);
      runtime.approveOperation(staleId);
      const staleDispatch = await runtime.dispatchOperation(staleId);
      expect(staleDispatch.structuredContent).toMatchObject({ effectState: "failed" });
      expect(writeCommands).toBe(1);
    } finally {
      socket.close();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs a governed cross-course connector batch with one write per child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-connector-batch-"));
    const port = await availablePort();
    const connectorCatalog = loadCanvasApiCatalog(resolve("../..", "artifacts/canvas-api/canvas-api-catalog.json"));
    const runtime = await MorrowRuntime.connect(connectorConfig(directory, port), {
      statePath: join(directory, "morrow.sqlite3"),
      batchKeyPath: join(directory, "batch.key"),
    });
    const extensionId = "a".repeat(32);
    const sourceBindingId = "canvas:test-account:g1";
    const socket = new WebSocket(`ws://127.0.0.1:${port}/morrow-bridge/v1`, { origin: `chrome-extension://${extensionId}` });
    try {
      expect(await runtime.health()).toMatchObject({
        ready: false,
        components: {
          canvasConnector: { processConnected: true, ready: false },
          extensionBridge: { connected: false, listening: true },
        },
      });
      await once(socket, "open");
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.hello,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        token: "gateway-connector-secret-".repeat(3),
        extensionId,
        runtimeRevision: "1.0.0-rc.0",
        catalogDigest: connectorCatalog.catalogDigest,
        bindings: [{ sourceBindingId, provider: "canvas", origin: "https://school.instructure.com", principalFingerprint: "c".repeat(64), sessionGeneration: 1, runtimeVerified: true }],
        sentAt: Date.now(),
      }));
      await once(socket, "message");
      expect(await runtime.health()).toMatchObject({
        ready: true,
        components: {
          canvasConnector: { processConnected: true, ready: true },
          extensionBridge: { connected: true, bindingCount: 1 },
        },
      });
      const receipts = new Set<string>();
      let writeCommands = 0;
      socket.on("message", (raw) => {
        const value = parseBridgeJson(raw.toString()) as { schema?: string };
        if (value.schema !== BRIDGE_SCHEMAS.command) return;
        const command = value as BridgeCommand;
        expect(command.kind).toBe("invoke_write");
        writeCommands += 1;
        receipts.add(String(command.outerGrant?.effectReceiptId));
        const id = String(command.arguments?.id);
        socket.send(serializeBridgeMessage({
          schema: BRIDGE_SCHEMAS.result,
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          requestId: command.requestId,
          operationId: command.operationId,
          generation: command.generation,
          ok: true,
          result: {
            schema: "morrow.canvas-browser-result.v1",
            ok: true,
            sent: true,
            status: 200,
            data: { id, name: `Course ${id}` },
            verification: {
              schema: "morrow.browser-verification.v1",
              status: "verified",
              strategy: "collection-contains-target",
              readTool: "canvas_list_favorite_courses",
              evidence: "fresh_readback_matches_requested_postcondition",
            },
          },
          completedAt: Date.now(),
        }));
      });

      const created = runtime.batchCreate({
        name: "Favorite two courses",
        mode: "stage_writes",
        concurrency: 2,
        courseSet: { source: "explicit", courseIds: ["41", "42"], complete: true },
        operations: ["41", "42"].map((courseId) => ({
          childId: `course:${courseId}`,
          courseId,
          tool: "canvas_add_course_to_favorites",
          sourceBindingId,
          arguments: { id: courseId },
        })),
      });
      const batchId = String((created.batch as JsonObject).batchId);
      await approveBatch(String(created.approvalUrl));
      const result = await runtime.batchRun({ batchId, maxChildren: 2 });
      expect(result.batch).toMatchObject({ state: "completed" });
      expect(result.sourceSettlement).toMatchObject({ outcome: "succeeded", succeeded: 2, terminal: true });
      expect(result.providerOutcomeFinal).toBe(true);
      expect(writeCommands).toBe(2);
      expect(receipts.size).toBe(2);
      const detail = runtime.batchResultsPage({ batchId, limit: 10 });
      expect(detail.children).toMatchObject([
        { childId: "course:41", state: "succeeded", gatewayOperationState: "verified" },
        { childId: "course:42", state: "succeeded", gatewayOperationState: "verified" },
      ]);
      const reconciled = await runtime.batchReconcile({ batchId, maxChildren: 10 });
      expect(reconciled.processed).toBe(0);
      expect(reconciled.sourceSettlement).toMatchObject({ outcome: "succeeded", succeeded: 2 });
    } finally {
      socket.close();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
