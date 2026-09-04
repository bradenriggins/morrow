import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCHEMAS, parseBridgeJson, serializeBridgeMessage, type BridgeCommand } from "@morrow/bridge-protocol";
import { loadCanvasApiCatalog } from "@morrow/canvas-api-catalog";
import { sha256Json } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-batch-upstream.mjs", import.meta.url));

function config() {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [
      {
        id: "meridian",
        label: "ExamplePlatform fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [fixturePath],
        env: { FAKE_SOURCE: "meridian" },
        priority: 100,
        required: true,
        enabled: true,
        outputPrivacy: {
          canvas_page_get: { allowedFields: ["source", "course_id"], dataClass: "course", maxRecords: 10, maxBytes: 10_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
        },
      },
      {
        id: "example-legacy",
        label: "Morrow legacy fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [fixturePath],
        env: { FAKE_SOURCE: "example-legacy" },
        priority: 50,
        required: true,
        enabled: true,
        outputPrivacy: {
          canvas_page_get: { allowedFields: ["source", "course_id"], dataClass: "course", maxRecords: 10, maxBytes: 10_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
          edit_page: { allowedFields: ["schema", "ok", "sourceToolName", "commandKind", "result", "approvalRequired", "taskId", "status", "operationId"], dataClass: "course", maxRecords: 20, maxBytes: 10_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
          morrow_legacy_task_get: { allowedFields: ["schema", "ok", "task", "taskId", "status", "outcome", "terminal", "verificationStatus", "resultCounts", "done", "unconfirmed", "failed", "rollbackFailed", "skipped", "undone", "notStarted", "sourceBindingId"], dataClass: "course", maxRecords: 20, maxBytes: 10_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
        },
      },
    ],
    filters: { excludePrefixes: ["mindtap_", "connect_"], excludeNames: [] },
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 50,
  });
}

function readback(courseId: string) {
  return {
    readback: {
      tool: "canvas_page_get",
      arguments: { course_id: courseId },
      expected_digest: sha256Json({ source: "meridian", course_id: courseId }),
    },
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function connectorConfig(directory: string, port: number) {
  const root = resolve("../..");
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
        MORROW_CANVAS_CATALOG_PATH: resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"),
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
    privacy: {
      canvasOrigin: "browser-session",
      account: "local",
      principal: "local",
      learnerVaultPath: join(directory, "vault.json"),
    },
    maxCatalogTools: 2_000,
  });
}

async function approveBatch(url: string): Promise<string> {
  const view = await fetch(url);
  const body = await view.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(body)?.[1];
  const cookie = view.headers.get("set-cookie")?.split(";", 1)[0];
  expect(nonce).toBeTruthy();
  expect(cookie).toBeTruthy();
  const approval = await fetch(`${url}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookie!,
      origin: new URL(url).origin,
      referer: url,
    },
    body: new URLSearchParams({ nonce: nonce! }),
  });
  expect(approval.status).toBe(200);
  return body;
}

describe("MorrowRuntime durable batches", () => {
  it("runs read-only children in bounded windows and never exposes stored arguments", async () => {
    const runtime = await MorrowRuntime.connect(config(), { statePath: ":memory:" });
    try {
      expect(runtime.gateway.catalog.tools.some((tool) => tool.publicName === "morrow_batch_create")).toBe(false);
      expect(runtime.gateway.catalog.tools.some((tool) => tool.publicName === "morrow_batch_reconcile")).toBe(false);
      const created = runtime.batchCreate({
        name: "Read three courses",
        mode: "read_only",
        concurrency: 2,
        operations: [1, 2, 3].map((course) => ({
          childId: `course:${course}`,
          tool: "canvas_page_get",
          arguments: { course_id: String(course), privateMarker: `not-for-output-${course}` },
        })),
      });
      const batch = created.batch as { batchId: string; state: string };
      expect(batch.state).toBe("planned");
      expect(created.sourceSettlement).toMatchObject({ outcome: "not_applicable", total: 0 });

      const first = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 2 });
      expect((first.batch as { state: string }).state).toBe("running");
      expect(first.processed).toBe(2);
      expect(first.remaining).toBe(1);

      const second = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 2 });
      expect((second.batch as { state: string }).state).toBe("completed");
      expect(second.processed).toBe(1);
      expect(second.remaining).toBe(0);
      expect(second.providerOutcomeFinal).toBe(true);

      const detail = runtime.batchGet({ batchId: batch.batchId, limit: 10 });
      const children = detail.children as Record<string, unknown>[];
      expect(children).toHaveLength(3);
      expect(children.every((child) => !("arguments" in child))).toBe(true);
      expect(detail.sourceSettlements).toEqual([]);
      expect(JSON.stringify(detail)).not.toContain("not-for-output");
      expect(runtime.batchesRecent({ state: "completed" }).returned).toBe(1);
      expect(runtime.batchHealth()).toMatchObject({ activeBatches: 0, inspectionRequiredBatches: 0 });
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("stages multi-course writes, then reconciles approval and verified provider truth separately", async () => {
    const runtime = await MorrowRuntime.connect(config(), { statePath: ":memory:" });
    try {
      const created = runtime.batchCreate({
        name: "Stage two page edits",
        mode: "stage_writes",
        concurrency: 8,
        operations: [41, 42].map((course) => ({
          childId: `course:${course}`,
          tool: "edit_page",
          sourceBindingId: `canvas:${course}`,
          arguments: { course_id: String(course), title: `Course ${course}`, _morrow: readback(String(course)) },
        })),
      });
      const batch = created.batch as { batchId: string; concurrency: number };
      expect(batch.concurrency).toBe(4);
      expect(String(created.note)).toContain("loopback page");
      expect(created.sourceSettlement).toMatchObject({ outcome: "not_started", notStarted: 2 });
      const approvalBody = await approveBatch(String(created.approvalUrl));
      expect(approvalBody).toContain("course:41");
      expect(approvalBody).toContain("course:42");

      const result = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 10 });
      expect((result.batch as { state: string }).state).toBe("paused");
      expect(result.providerOutcomeFinal).toBe(false);
      expect(result.sourceSettlement).toMatchObject({
        outcome: "awaiting_approval",
        awaitingApproval: 2,
      });
      const children = result.children as { state: string; sourceTaskId: string | null; sourceOperationId: string | null }[];
      expect(children.map((child) => child.state)).toEqual(["succeeded", "succeeded"]);
      expect(children.map((child) => child.sourceTaskId)).toEqual(["task-41", "task-42"]);
      expect(children.every((child) => String(child.sourceOperationId).startsWith("operation:"))).toBe(true);

      const firstReconciliation = await runtime.batchReconcile({
        batchId: batch.batchId,
        maxChildren: 10,
      });
      expect(firstReconciliation.processed).toBe(2);
      expect(firstReconciliation.sourceSettlement).toMatchObject({
        outcome: "awaiting_approval",
        awaitingApproval: 2,
      });
      expect(firstReconciliation.providerOutcomeFinal).toBe(false);

      const secondReconciliation = await runtime.batchReconcile({
        batchId: batch.batchId,
        maxChildren: 10,
      });
      expect(secondReconciliation.processed).toBe(2);
      expect(secondReconciliation.sourceSettlement).toMatchObject({
        outcome: "succeeded",
        succeeded: 2,
        terminal: true,
      });
      expect(secondReconciliation.providerOutcomeFinal).toBe(true);
      expect((secondReconciliation.batch as { state: string }).state).toBe("completed");
      expect(runtime.gateway.operationList(10)).toMatchObject({
        returned: 2,
        operations: [
          { state: "verified", verificationStatus: "verified" },
          { state: "verified", verificationStatus: "verified" },
        ],
      });

      const defaultTerminalRecheck = await runtime.batchReconcile({
        batchId: batch.batchId,
        maxChildren: 10,
      });
      expect(defaultTerminalRecheck.processed).toBe(0);
      const explicitTerminalRecheck = await runtime.batchReconcile({
        batchId: batch.batchId,
        maxChildren: 10,
        includeTerminal: true,
      });
      expect(explicitTerminalRecheck.processed).toBe(2);

      const detail = runtime.batchGet({ batchId: batch.batchId, limit: 10 });
      const sourceSettlements = detail.sourceSettlements as Record<string, unknown>[];
      expect(sourceSettlements).toHaveLength(2);
      expect(sourceSettlements.every((row) => row.state === "succeeded")).toBe(true);
      expect(JSON.stringify(detail)).not.toContain("Course 41");

      const stagingOperations = runtime.gateway.operationsRecent({
        source: "example-legacy",
        tool: "edit_page",
        limit: 10,
      });
      expect(stagingOperations.returned).toBe(2);
      expect((stagingOperations.operations as Record<string, unknown>[]).every((operation) => (
        operation.sourceResultState === "awaiting_confirmation"
        && String(operation.sourceTaskId).startsWith("task-")
      ))).toBe(true);
      const inspectionOperations = runtime.gateway.operationsRecent({
        source: "example-legacy",
        tool: "morrow_legacy_task_get",
        limit: 20,
      });
      expect(inspectionOperations.returned).toBe(6);
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("keeps effect-possible and unconfirmed source outcomes visible", async () => {
    const runtime = await MorrowRuntime.connect(config(), { statePath: ":memory:" });
    try {
      const created = runtime.batchCreate({
        name: "Source outcome distinctions",
        mode: "stage_writes",
        concurrency: 3,
        operations: [
          { childId: "effect", outcome: "failed-effect" },
          { childId: "no-effect", outcome: "failed-no-effect" },
          { childId: "unconfirmed", outcome: "unconfirmed" },
        ].map((entry, index) => ({
          childId: entry.childId,
          tool: "edit_page",
          sourceBindingId: `canvas:${index + 1}`,
          arguments: {
            course_id: String(index + 1),
            fixture_outcome: entry.outcome,
            _morrow: readback(String(index + 1)),
          },
        })),
      });
      const batch = created.batch as { batchId: string };
      await approveBatch(String(created.approvalUrl));
      await runtime.batchRun({ batchId: batch.batchId, maxChildren: 10 });
      const reconciled = await runtime.batchReconcile({ batchId: batch.batchId, maxChildren: 10 });
      expect(reconciled.sourceSettlement).toMatchObject({
        outcome: "inspection_required",
        failedEffectPossible: 1,
        failedNoEffect: 1,
        inspectionRequired: 1,
        requiresAttention: true,
      });
      expect(reconciled.providerOutcomeFinal).toBe(false);
      expect(reconciled.problems).toEqual([]);
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("restores staged source-task identity after a process restart without exposing arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-batch-restart-"));
    const statePath = join(directory, "morrow.sqlite3");
    const keyPath = join(directory, "batch.key");
    let batchId = "";

    const first = await MorrowRuntime.connect(config(), { statePath, batchKeyPath: keyPath });
    try {
      const created = first.batchCreate({
        name: "Restart source task",
        mode: "stage_writes",
        concurrency: 1,
        operations: [{
          childId: "course:700",
          tool: "edit_page",
          sourceBindingId: "canvas:700",
          arguments: { course_id: "700", title: "Never returned", _morrow: readback("700") },
        }],
      });
      batchId = (created.batch as { batchId: string }).batchId;
      await approveBatch(String(created.approvalUrl));
      await first.batchRun({ batchId, maxChildren: 1 });
    } finally {
      await first.close();
    }

    const second = await MorrowRuntime.connect(config(), { statePath, batchKeyPath: keyPath });
    try {
      const detail = second.batchGet({ batchId, limit: 10 });
      expect(detail.sourceSettlement).toMatchObject({
        outcome: "inspection_required",
        inspectionRequired: 1,
        requiresAttention: true,
      });
      expect(detail.sourceSettlements).toMatchObject([{
        childId: "course:700",
        sourceBindingId: "canvas:700",
        sourceTaskId: "task-700",
        state: "inspection_required",
      }]);
      expect(JSON.stringify(detail)).not.toContain("Never returned");
    } finally {
      await second.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("recovers a verified direct connector effect after child settlement crashes without redispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-direct-batch-recovery-"));
    const statePath = join(directory, "morrow.sqlite3");
    const keyPath = join(directory, "batch.key");
    const port = await availablePort();
    const catalog = loadCanvasApiCatalog(resolve("../..", "artifacts/canvas-api/canvas-api-catalog.json"));
    const sourceBindingId = "canvas:batch-recovery";
    let first: MorrowRuntime | undefined;
    let second: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    let writeCommands = 0;
    try {
      first = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = new WebSocket(`ws://127.0.0.1:${port}/morrow-bridge/v1`, {
        origin: `chrome-extension://${"a".repeat(32)}`,
      });
      await once(socket, "open");
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.hello,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        token: "gateway-connector-secret-".repeat(3),
        extensionId: "a".repeat(32),
        runtimeRevision: "1.0.0-rc.0",
        catalogDigest: catalog.catalogDigest,
        bindings: [{
          sourceBindingId,
          provider: "canvas",
          origin: "https://school.instructure.com",
          principalFingerprint: "c".repeat(64),
          sessionGeneration: 1,
          runtimeVerified: true,
        }],
        sentAt: Date.now(),
      }));
      await once(socket, "message");
      socket.on("message", (raw) => {
        const value = parseBridgeJson(raw.toString()) as { schema?: string };
        if (value.schema !== BRIDGE_SCHEMAS.command) return;
        const command = value as BridgeCommand;
        expect(command.kind).toBe("invoke_write");
        writeCommands += 1;
        socket?.send(serializeBridgeMessage({
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
            data: { id: "77", name: "Recovered Course" },
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

      const created = first.batchCreate({
        name: "Recover direct connector write",
        mode: "stage_writes",
        concurrency: 1,
        courseSet: { source: "explicit", courseIds: ["77"], complete: true },
        operations: [{
          childId: "course:77",
          courseId: "77",
          tool: "canvas_add_course_to_favorites",
          sourceBindingId,
          arguments: { id: "77" },
        }],
      });
      const batchId = String((created.batch as { batchId: string }).batchId);
      await approveBatch(String(created.approvalUrl));
      const crash = vi.spyOn(first.batches, "settleChild").mockImplementationOnce(() => {
        throw new Error("simulated crash after verified direct effect");
      });
      await expect(first.batchRun({ batchId, maxChildren: 1 })).rejects.toThrow(
        "simulated crash after verified direct effect",
      );
      crash.mockRestore();

      const beforeRestart = first.batches.listChildren(batchId, 0, 10).children[0]!;
      expect(first.gateway.operationGet(String(beforeRestart.gatewayOperationId))).toMatchObject({
        state: "verified",
        verificationStatus: "verified",
      });
      expect(writeCommands).toBe(1);

      await first.close();
      first = undefined;
      socket.close();
      second = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });

      const recovered = second.batchGet({ batchId, limit: 10 });
      expect(recovered.batch).toMatchObject({ state: "completed", succeededChildren: 1, unknownChildren: 0 });
      expect(recovered.children).toMatchObject([
        { childId: "course:77", state: "succeeded", gatewayOperationState: "verified" },
      ]);
      expect(recovered.sourceSettlement).toMatchObject({ outcome: "succeeded", succeeded: 1, terminal: true });
      expect(writeCommands).toBe(1);
    } finally {
      socket?.close();
      await second?.close();
      await first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
