import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MAX_BATCH_RESULT_BYTES } from "@morrow/batch-engine";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import { canonicalJson, sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

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

type AuditBinding = {
  readonly sourceBindingId: string;
  readonly courseId: string;
};

function auditReadResult(command: BridgeCommand) {
  const args = command.arguments as Record<string, unknown>;
  const courseId = String(args.course_id || args.id || "");
  if (command.toolName === "canvas_list_users_in_course_users") {
    return [{
      id: `student-${courseId}`,
      name: courseId === "41" ? "Jane Doe" : courseId === "43" ? "Rowan Clarke" : `Student ${courseId}`,
      email: `student-${courseId}@example.edu`,
    }];
  }
  if (command.toolName === "canvas_get_single_course_courses") {
    return { id: courseId, name: `Course ${courseId}` };
  }
  if (command.toolName === "canvas_show_page_courses") {
    const learner = courseId === "41" ? "Jane Doe" : courseId === "43" ? "Rowan Clarke" : `Student ${courseId}`;
    const body = courseId === "42" ? undefined
      : String(args.url_or_id) === "large-private"
        ? `<h1>Course ${courseId}</h1>${`<p>private-audit-body-${courseId}; feedback for ${learner}</p>`.repeat(2_000)}`
        : `<h1>Course ${courseId}</h1><p>private-audit-body-${courseId}; feedback for ${learner}</p>`;
    return {
      page_id: `page-${courseId}`,
      url: String(args.url_or_id),
      title: `Page ${courseId}`,
      ...(body ? { body, pageBodySha256: sha256Text(body) } : {}),
    };
  }
  if (command.toolName === "canvas_list_pages_courses") {
    const learner = courseId === "41" ? "Jane Doe" : courseId === "43" ? "Rowan Clarke" : `Student ${courseId}`;
    return [{ page_id: `inventory-page-${courseId}`, url: `inventory-${courseId}`, title: `Feedback for ${learner}` }];
  }
  if (command.toolName.startsWith("canvas_") || command.toolName === "canvas_item_bank_list_banks") return [];
  throw new Error(`unexpected audit read ${command.toolName}`);
}

async function connectAuditBridge(
  port: number,
  bindings: readonly AuditBinding[],
  commands: BridgeCommand[],
  options: {
    readonly truncatedTools?: readonly string[];
    readonly dataForCommand?: (command: BridgeCommand) => unknown | undefined;
    readonly responseDelayMs?: number;
    /** Simulates an active Edit permission whose current options must be read. */
    readonly withEditPermission?: boolean;
    /** Simulates an unavailable current Edit-options read after a restart. */
    readonly failEditOptions?: boolean;
    readonly onRosterRead?: () => void;
    readonly onCommandStart?: (command: BridgeCommand) => void;
    readonly onCommandFinish?: (command: BridgeCommand) => void;
    readonly writeResultForCommand?: (command: BridgeCommand) => JsonObject;
    readonly bridgeMaintenanceResult?: (command: BridgeCommand) => JsonObject;
  } = {},
): Promise<WebSocket> {
  const catalogDigest = bridgeCatalogDigestForTests(resolve("../.."));
  const permissionSummary = (sourceBindingId: string) => ({
    schema: "morrow.bridge.edit-permission.v1" as const,
    revision: 1,
    scopeDigest: "d".repeat(64),
    catalogDigest,
    sourceBindingId,
  });
  const permission = (sourceBindingId: string) => ({
    ...permissionSummary(sourceBindingId),
    enabledCategories: [],
    rules: [],
  });
  await assertPortListening(port);
  const bridge = await connectBridgeTestClient({
    port,
    token: "gateway-connector-secret-".repeat(3),
    extensionId: "a".repeat(32),
    catalogDigest,
    bindings: bindings.map((binding) => ({
      ...binding,
      provider: "canvas" as const,
      origin: "https://school.instructure.com",
      principalFingerprint: "c".repeat(64),
      sessionGeneration: 1,
      catalogDigest,
      ...(options.withEditPermission ? {
        editOptionsAvailable: true as const,
        editPolicyRevision: 1,
        editPermission: permissionSummary(binding.sourceBindingId),
      } : {}),
      runtimeVerified: true,
    })),
  });
  bridge.onCommand((command) => {
    if (command.kind === "bridge_maintenance") {
      const result = options.bridgeMaintenanceResult?.(command);
      expect(result, "Bridge maintenance needs one exact private response fixture").toBeTruthy();
      bridge.respond(command, result!);
      return;
    }
    if (command.kind === "edit_policy_options_get") {
      if (options.failEditOptions) {
        bridge.respondProblem(command, {
          schema: "morrow.bridge.problem.v1",
          code: "edit_options_unavailable",
          message: "The selected course Edit options are unavailable or ambiguous.",
          recoverable: true,
        });
        return;
      }
      bridge.respond(command, {
        schema: "morrow.bridge.edit-options.v1",
        sourceBindingId: command.sourceBindingId,
        provider: "canvas",
        catalogDigest,
        policyRevision: 1,
        runtimeVerified: true,
        options: [],
        editPermission: permission(command.sourceBindingId),
      });
      return;
    }
    if (command.kind === "invoke_write") {
      const result = options.writeResultForCommand?.(command);
      expect(result, "Canvas write needs one exact Bridge response fixture").toBeTruthy();
      commands.push(command);
      options.onCommandStart?.(command);
      bridge.respond(command, result!);
      options.onCommandFinish?.(command);
      return;
    }
    expect(command.kind).toBe("invoke_read");
    const data = options.dataForCommand?.(command) ?? auditReadResult(command);
    if (command.toolName === "canvas_list_users_in_course_users") options.onRosterRead?.();
    else commands.push(command);
    const body = typeof (data as { body?: unknown }).body === "string"
      ? (data as { body: string }).body
      : undefined;
    options.onCommandStart?.(command);
    const reply = () => {
      try {
        bridge.respond(command, {
          schema: "morrow.canvas-browser-result.v1",
          ok: true,
          sent: true,
          status: 200,
          truncated: options.truncatedTools?.includes(command.toolName) === true,
          data,
          ...(body ? { pageBodySha256: sha256Text(body) } : {}),
        });
      } finally {
        options.onCommandFinish?.(command);
      }
    };
    if (options.responseDelayMs && options.responseDelayMs > 0) setTimeout(reply, options.responseDelayMs);
    else reply();
  });
  // The tests close and reconnect this bridge, so they hold the socket itself.
  return bridge.socket;
}

describe("MorrowRuntime durable batches", () => {
  it("binds a legacy Canvas page placement only from its verified create artifact and retains no raw page result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-canvas-result-bound-batch-"));
    const statePath = join(directory, "gateway.sqlite3");
    const port = await reserveLoopbackPort();
    const binding = { sourceBindingId: "canvas:compose-42", courseId: "42" };
    const commands: BridgeCommand[] = [];
    let runtime: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    try {
      runtime = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath });
      socket = await connectAuditBridge(port, [binding], commands, {
        withEditPermission: true,
        writeResultForCommand: (command) => {
          if (command.toolName === "canvas_create_page_courses") {
            expect(command.arguments).toMatchObject({ course_id: "42", wiki_page_title: "Private course page" });
            return {
              schema: "morrow.canvas-browser-result.v1",
              ok: true,
              sent: true,
              status: 201,
              data: { url: "private-course-page", title: "Jane Doe private page" },
              verification: { schema: "morrow.browser-verification.v1", status: "verified" },
            };
          }
          expect(command.toolName).toBe("canvas_create_module_item");
          expect(command.arguments).toMatchObject({
            course_id: "42",
            module_id: "9",
            module_item_type: "Page",
            module_item_page_url: "private-course-page",
          });
          return {
            schema: "morrow.canvas-browser-result.v1",
            ok: true,
            sent: true,
            status: 201,
            data: { id: "module-item-8" },
            verification: { schema: "morrow.browser-verification.v1", status: "verified" },
          };
        },
      });
      const created = await runtime.batchCreate({
        name: "Compose one page and module placement",
        mode: "stage_writes",
        concurrency: 1,
        courseSet: { source: "explicit", courseIds: ["42"], complete: true, paginationComplete: true },
        operations: [
          {
            childId: "page-create",
            courseId: "42",
            tool: "canvas_create_page_courses",
            sourceBindingId: binding.sourceBindingId,
            arguments: { course_id: "42", wiki_page_title: "Private course page" },
          },
          {
            childId: "page-place",
            courseId: "42",
            tool: "canvas_create_module_item",
            sourceBindingId: binding.sourceBindingId,
            dependencyChildIds: ["page-create"],
            arguments: { course_id: "42", module_id: "9", module_item_type: "Page" },
            resultBinding: {
              schema: "morrow.canvas-result-binding.v1",
              sourceChildId: "page-create",
              kind: "canvas_page_url_to_module_item_page_url",
            },
          },
        ],
      });
      const batch = created.batch as { batchId: string };
      expect((created.manifest as { approvalCoverageChildCount?: unknown }).approvalCoverageChildCount).toBe(1);
      expect(runtime.batches.get(batch.batchId).children).toMatchObject([
        { childId: "page-create", gatewayOperationState: "awaiting_approval" },
        { childId: "page-place", gatewayOperationId: null, hasBoundRequest: false },
      ]);
      runtime.approveBatch(batch.batchId);

      const first = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 2 });
      expect(first).toMatchObject({ processed: 1, remaining: 1 });
      const bound = runtime.batches.readArguments(batch.batchId, "page-place");
      expect(bound).toMatchObject({ module_item_page_url: "private-course-page" });
      expect(JSON.stringify(runtime.batches.readResult(batch.batchId, "page-create"))).not.toContain("Jane Doe");
      for (const path of [statePath, `${statePath}-wal`].filter(existsSync)) {
        expect(readFileSync(path).includes(Buffer.from("Jane Doe"))).toBe(false);
      }

      const reviewBoundPlacement = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 2 });
      expect(reviewBoundPlacement).toMatchObject({ processed: 0, providerOutcomeFinal: false });
      expect((reviewBoundPlacement.batch as { state: string }).state).toBe("paused");
      runtime.approveBatch(batch.batchId);
      const second = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 2 });
      expect(second).toMatchObject({ processed: 1, remaining: 0, providerOutcomeFinal: true });
      expect((second.batch as { state: string }).state).toBe("completed");
      expect(commands.filter((command) => command.kind === "invoke_write").map((command) => command.toolName))
        .toEqual(["canvas_create_page_courses", "canvas_create_module_item"]);
    } finally {
      socket?.close();
      await runtime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("routes only an exact private Bridge maintenance control and never publishes it through full MCP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-private-bridge-maintenance-"));
    const port = await reserveLoopbackPort();
    let runtime: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    let client: Client | undefined;
    let storeStatus = false;
    try {
      runtime = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath: join(directory, "gateway.sqlite3") });
      socket = await connectAuditBridge(port, [], [], {
        bridgeMaintenanceResult: (command) => {
          expect(command.toolName).toBeUndefined();
          expect(command.operationKey).toBeUndefined();
          expect(command.sourceBindingId).toBeUndefined();
          if (command.maintenance?.action === "readback") {
            return {
              schema: "morrow.bridge.update-readback.v1",
              extensionId: "a".repeat(32),
              manifestVersion: "1.0.3",
              installType: "normal",
              activeFolderProof: {
                schema: "morrow.bridge.active-folder-proof.v1",
                extensionId: "a".repeat(32),
                manifestVersion: "1.0.3",
                challengeId: "bridge-maintenance-test-challenge",
                nonce: "bridge-maintenance-test-nonce",
                challengeSha256: "b".repeat(64),
              },
            };
          }
          expect(command.kind).toBe("bridge_maintenance");
          expect(command.maintenance).toEqual({ action: "status" });
          return storeStatus ? {
            schema: "morrow.bridge.update-status.v1",
            extensionId: "a".repeat(32),
            manifestVersion: "1.0.3",
            installType: "normal",
            quiescent: false,
            activeFolderProof: null,
          } : {
            schema: "morrow.bridge.update-status.v1",
            extensionId: "a".repeat(32),
            manifestVersion: "1.0.2",
            installType: "development",
            quiescent: false,
            activeFolderProof: {
              schema: "morrow.bridge.active-folder-proof.v1",
              extensionId: "a".repeat(32),
              manifestVersion: "1.0.2",
              challengeId: "bridge-maintenance-test-challenge",
              nonce: "bridge-maintenance-test-nonce",
              challengeSha256: "b".repeat(64),
            },
          };
        },
      });

      await expect(runtime.bridgeMaintenance({ action: "status" })).resolves.toMatchObject({
        schema: "morrow.bridge.update-status.v1",
        extensionId: "a".repeat(32),
        installType: "development",
      });
      storeStatus = true;
      await expect(runtime.bridgeMaintenance({ action: "status" })).resolves.toEqual({
        schema: "morrow.bridge.update-status.v1",
        extensionId: "a".repeat(32),
        manifestVersion: "1.0.3",
        installType: "normal",
        quiescent: false,
        activeFolderProof: null,
      });
      await expect(runtime.bridgeMaintenance({ action: "status", path: "/tmp/Bridge" }))
        .rejects.toThrow("private Bridge maintenance control");
      await expect(runtime.bridgeMaintenance({ action: "readback" })).rejects.toThrow("private Bridge readback result");

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createFullMorrowServer(runtime!), { transport: serverTransport });
      client = new Client({ name: "morrow-private-bridge-maintenance", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("morrow_bridge_maintenance");
    } finally {
      await client?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      socket?.close();
      await runtime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  // This integration starts the real connector child process and a WebSocket Bridge.
  // Full workspace concurrency can exceed Vitest's five-second default before its assertions run.
  }, 15_000);

  it("redacts learner identities at reachable MCP boundaries for exact multi-course bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-mcp-privacy-boundary-"));
    const statePath = join(directory, "morrow.sqlite3");
    const keyPath = join(directory, "batch.key");
    const port = await reserveLoopbackPort();
    const bindings = [
      { sourceBindingId: "canvas:audit-41", courseId: "41" },
      { sourceBindingId: "canvas:audit-43", courseId: "43" },
    ];
    let first: MorrowRuntime | undefined;
    let second: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    let client: Client | undefined;
    try {
      first = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectAuditBridge(port, bindings, []);

      const rawReport = {
        schema: "morrow.course-audit.v1",
        provider: "canvas",
        source_binding_id: "canvas:audit-41",
        course_id: "41",
        status: "evidence_ready",
        evidence: {
          html: "<p>Feedback for Jane Doe at jane.doe@example.edu</p>",
          learner: { id: "student-41", name: "Jane Doe", email: "jane.doe@example.edu" },
        },
      };
      const batchCreated = await first.batchCreate({
        name: "Pre-existing encrypted audit report",
        mode: "read_only",
        concurrency: 1,
        courseSet: { source: "explicit", courseIds: ["41"], complete: true, paginationComplete: true },
        operations: [{
          childId: "course:41",
          courseId: "41",
          tool: "morrow_audit_course",
          sourceBindingId: "canvas:audit-41",
          arguments: {
            provider: "canvas",
            source_binding_id: "canvas:audit-41",
            course_id: "41",
            target: { kind: "page", page_url: "page-41" },
          },
        }],
      });
      const batchId = String((batchCreated.batch as { batchId: string }).batchId);
      first.batches.beginRun(batchId, first.gateway.catalog.digest);
      const claimed = first.batches.claimPending(batchId, 1);
      expect(claimed).toHaveLength(1);
      first.batches.settleChild(batchId, claimed[0]!.childId, {
        state: "succeeded",
        resultDigest: sha256Json(rawReport),
        resultPayload: rawReport,
        sourceResultState: "evidence_ready",
      });
      for (const path of [statePath, `${statePath}-wal`].filter(existsSync)) {
        expect(readFileSync(path).includes(Buffer.from("Jane Doe"))).toBe(false);
      }

      await first.close();
      first = undefined;
      socket.close();
      socket = undefined;

      second = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectAuditBridge(port, bindings, []);
      const [a, b] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createFullMorrowServer(second!), { transport: b });
      client = new Client({ name: "mcp-privacy-boundary", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(a);

      const attachmentEgress = await second.gateway.redactMcpEgress({
        structuredContent: {
          status: "ready",
          privateAttachment: { handle: "stage:secret", bytes_base64: Buffer.from("Jane Doe").toString("base64") },
          bytes_base64: Buffer.from("Jane Doe").toString("base64"),
        },
      }, {}, { bound: false });
      const attachmentText = JSON.stringify(attachmentEgress);
      expect(attachmentText).toContain("ready");
      expect(attachmentText).not.toContain("stage:secret");
      expect(attachmentText).not.toContain(Buffer.from("Jane Doe").toString("base64"));

      const inventory = await client.callTool({
        name: "morrow_inventory_courses",
        arguments: {
          provider: "canvas",
          scope: "selected_program",
          courses: bindings.map((binding) => ({
            course_id: binding.courseId,
            expected_name: `Course ${binding.courseId}`,
            source_binding_id: binding.sourceBindingId,
          })),
          max_pages_per_list: 1,
        },
      });
      const inventoryText = JSON.stringify(inventory);
      expect(inventory.isError, inventoryText).not.toBe(true);
      expect(inventoryText).not.toContain("Jane Doe");
      expect(inventoryText).not.toContain("Rowan Clarke");
      expect(inventoryText).toContain("inventory-41");
      expect(inventoryText).toContain("inventory-43");
      expect(inventoryText).toMatch(/learner_[\w-]+/);

      const compact = await client.callTool({
        name: "morrow_capability_read",
        arguments: {
          name: "canvas_show_page_courses",
          arguments: {
            course_id: "41",
            url_or_id: "page-41",
            _morrow: { source_binding_id: "canvas:audit-41" },
          },
        },
      });
      const compactText = JSON.stringify(compact);
      expect(compact.isError, compactText).not.toBe(true);
      expect(compactText).not.toContain("Jane Doe");
      expect(compactText).not.toContain("jane.doe@example.edu");
      expect(compactText).toContain("private-audit-body-41");
      expect(compactText).toMatch(/learner_[\w-]+/);

      const large = await client.callTool({
        name: "morrow_capability_read",
        arguments: {
          name: "canvas_show_page_courses",
          arguments: {
            course_id: "41",
            url_or_id: "large-private",
            _morrow: { source_binding_id: "canvas:audit-41" },
          },
        },
      });
      const largeArtifact = (large.structuredContent as { data?: { schema?: unknown; handle?: unknown } }).data;
      expect(large.isError, JSON.stringify(large)).not.toBe(true);
      expect(largeArtifact).toMatchObject({ schema: "morrow.result-artifact.v1" });
      const largeHandle = largeArtifact?.handle;
      expect(typeof largeHandle).toBe("string");
      const largePage = await client.callTool({
        name: "morrow_result_page",
        arguments: { handle: largeHandle as string, limit: 16_000 },
      });
      const largePageText = JSON.stringify(largePage);
      expect(largePage.isError, largePageText).not.toBe(true);
      expect(largePageText).not.toContain("Jane Doe");
      expect(largePageText).not.toContain("jane.doe@example.edu");
      expect(largePageText).toMatch(/learner_[\w-]+/);

      const planned = await second.gateway.planOperationWithCurrentEditPermission("canvas_update_create_page_courses", {
        course_id: "41",
        url_or_id: "page-41",
        private_note: "Jane Doe needs follow-up",
        _morrow: { source_binding_id: "canvas:audit-41" },
      });
      const operationId = String((planned.structuredContent as { operationId: string }).operationId);
      expect(operationId).toMatch(/^op:/);
      const collectionEgress = await second.gateway.redactMcpEgress({
        structuredContent: { operations: [{ operationId, detail: "Jane Doe" }] },
      }, {}, { bound: false, toolName: "morrow_operations_recent" });
      const collectionText = JSON.stringify(collectionEgress);
      expect(collectionText).not.toContain("Jane Doe");
      expect(collectionText).toMatch(/learner_[\w-]+/);
      for (const request of [
        { name: "morrow_operation_get", arguments: { operation_id: operationId }, expectLearnerToken: true },
        { name: "morrow_operation_list", arguments: { limit: 10 }, expectLearnerToken: true },
        { name: "morrow_operations_recent", arguments: { limit: 10 }, expectLearnerToken: false },
        { name: "morrow_batch_results_page", arguments: { batch_id: batchId, offset: 0, limit: 1, result_child_id: "course:41" }, expectLearnerToken: false },
      ] as const) {
        const result = await client.callTool(request);
        const serialized = JSON.stringify(result);
        expect(result.isError, serialized).not.toBe(true);
        expect(serialized).not.toContain("Jane Doe");
        expect(serialized).not.toContain("jane.doe@example.edu");
        if (request.expectLearnerToken) expect(serialized).toMatch(/learner_[\w-]+/);
      }
    } finally {
      await client?.close();
      await server?.close();
      socket?.close();
      await second?.close();
      await first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it("returns only operation control state when historical Edit-options authority is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-historical-effect-egress-"));
    const statePath = join(directory, "morrow.sqlite3");
    const port = await reserveLoopbackPort();
    const bindings = [{ sourceBindingId: "canvas:historical-41", courseId: "41" }];
    let first: MorrowRuntime | undefined;
    let second: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    let client: Client | undefined;
    try {
      first = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath });
      socket = await connectAuditBridge(port, bindings, [], { withEditPermission: true });
      const planned = await first.gateway.planOperationWithCurrentEditPermission("canvas_update_create_page_courses", {
        course_id: "41",
        url_or_id: "page-41",
        private_note: "Jane Doe needs follow-up",
        _morrow: { source_binding_id: "canvas:historical-41" },
      });
      const operationId = String((planned.structuredContent as { operationId?: unknown }).operationId);
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      expect(operationId).toMatch(/^op:/);

      await first.close();
      first = undefined;
      const firstBridgeClosed = once(socket, "close");
      socket.close();
      await firstBridgeClosed;
      socket = undefined;

      let rosterReads = 0;
      second = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath });
      socket = await connectAuditBridge(port, bindings, [], {
        withEditPermission: true,
        failEditOptions: true,
        onRosterRead: () => { rosterReads += 1; },
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createFullMorrowServer(second!), { transport: b });
      client = new Client({ name: "mcp-historical-effect-egress", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(a);

      const expectedControl = {
        schema: "morrow.operation-control.v1",
        operationId,
        state: "awaiting_approval",
        dispatchAttempt: 0,
        verification: { status: "unconfirmed" },
        contentOmittedReason: "historical_learner_scope_unavailable",
      };
      const get = await client.callTool({ name: "morrow_operation_get", arguments: { operation_id: operationId } });
      expect(get.isError, JSON.stringify(get)).not.toBe(true);
      expect(get.content).toEqual([{ type: "text", text: "Morrow retained only local operation control status because historical learner content is unavailable." }]);
      expect(get.structuredContent).toEqual(expectedControl);
      expect(second.gateway.operationGet(operationId)).toMatchObject({ state: "awaiting_approval", dispatchAttempt: 0 });

      const listed = await client.callTool({ name: "morrow_operation_list", arguments: { limit: 10 } });
      expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
      expect(listed.structuredContent).toEqual({
        schema: "morrow.operations.list.v1",
        returned: 1,
        operations: [expectedControl],
      });

      const recent = await client.callTool({ name: "morrow_operations_recent", arguments: { limit: 10 } });
      expect(recent.isError, JSON.stringify(recent)).not.toBe(true);
      expect(JSON.stringify(recent)).not.toContain("privacy_failure");

      const cancelled = await client.callTool({ name: "morrow_operation_cancel", arguments: { operation_id: operationId } });
      expect(cancelled.isError, JSON.stringify(cancelled)).not.toBe(true);
      expect(cancelled.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        phase: "cancelled",
        effectState: "cancelled",
      });
      expect((cancelled.structuredContent as { data?: unknown }).data).toEqual({ ...expectedControl, state: "cancelled" });
      expect(second.gateway.operationGet(operationId)).toMatchObject({ state: "cancelled", dispatchAttempt: 0 });

      // Control-only recovery never asks the current roster to rebind old scope.
      expect(rosterReads).toBe(0);

      const dispatch = await client.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: operationId } });
      expect(dispatch.isError).toBe(true);
      expect(JSON.stringify(dispatch)).not.toContain("morrow.operation-control.v1");
      expect(second.gateway.operationGet(operationId)).toMatchObject({ state: "cancelled", dispatchAttempt: 0 });
      // Dispatch errors still pass through the normal current-scope egress path.
      expect(rosterReads).toBe(1);

      for (const result of [get, listed, recent, cancelled, dispatch]) {
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("Jane Doe");
        expect(serialized).not.toContain("private_note");
        expect(serialized).not.toContain("canvas:historical-41");
        expect(serialized).not.toContain("school.instructure.com");
      }
      for (const result of [get, listed, cancelled]) {
        expect(JSON.stringify(result)).not.toMatch(/(?:plan|readback|createdAt|updatedAt|catalogDigest|targetIdentity|sourceOperationId)/u);
      }
    } finally {
      await client?.close();
      await server?.close();
      socket?.close();
      await second?.close();
      await first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it("fails closed when a plan-only historical binding is absent after reconnect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-historical-binding-absent-"));
    const statePath = join(directory, "morrow.sqlite3");
    const port = await reserveLoopbackPort();
    const g1Bindings = [{ sourceBindingId: "canvas:historical-g1", courseId: "41" }];
    const g2Bindings = [{ sourceBindingId: "canvas:historical-g2", courseId: "41" }];
    let first: MorrowRuntime | undefined;
    let second: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    let client: Client | undefined;
    try {
      first = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath });
      socket = await connectAuditBridge(port, g1Bindings, []);
      const planned = await first.gateway.planOperationWithCurrentEditPermission("canvas_update_create_page_courses", {
        course_id: "41",
        url_or_id: "page-41",
        private_note: "Jane Doe needs follow-up",
        _morrow: { source_binding_id: "canvas:historical-g1" },
      });
      const operationId = String((planned.structuredContent as { operationId?: unknown }).operationId);
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      expect(operationId).toMatch(/^op:/);

      await first.close();
      first = undefined;
      const firstBridgeClosed = once(socket, "close");
      socket.close();
      await firstBridgeClosed;
      socket = undefined;

      let rosterReads = 0;
      second = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath });
      socket = await connectAuditBridge(port, g2Bindings, [], {
        onRosterRead: () => { rosterReads += 1; },
      });
      const published = await second.gateway.callSourceOwned("morrow_browser_bindings", {});
      const publishedBindings = ((published.structuredContent as { bindings?: unknown }).bindings as JsonObject[]);
      expect(publishedBindings).toHaveLength(1);
      expect(publishedBindings[0]).toMatchObject({ sourceBindingId: "canvas:historical-g2", courseId: "41" });
      expect(JSON.stringify(publishedBindings)).not.toContain("canvas:historical-g1");

      const [a, b] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createFullMorrowServer(second!), { transport: b });
      client = new Client({ name: "mcp-historical-binding-absent", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(a);

      const control = {
        schema: "morrow.operation-control.v1",
        operationId,
        state: "awaiting_approval",
        dispatchAttempt: 0,
        verification: { status: "unconfirmed" },
        contentOmittedReason: "historical_learner_scope_unavailable",
      };
      const get = await client.callTool({ name: "morrow_operation_get", arguments: { operation_id: operationId } });
      expect(get.isError, JSON.stringify(get)).not.toBe(true);
      expect(get.structuredContent).toEqual(control);

      const listed = await client.callTool({ name: "morrow_operation_list", arguments: { limit: 10 } });
      expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
      expect(listed.structuredContent).toEqual({ schema: "morrow.operations.list.v1", returned: 1, operations: [control] });

      const recent = await client.callTool({ name: "morrow_operations_recent", arguments: { limit: 10 } });
      expect(recent.isError, JSON.stringify(recent)).not.toBe(true);

      const cancelled = await client.callTool({ name: "morrow_operation_cancel", arguments: { operation_id: operationId } });
      expect(cancelled.isError, JSON.stringify(cancelled)).not.toBe(true);
      expect((cancelled.structuredContent as { data?: unknown }).data).toEqual({ ...control, state: "cancelled" });
      expect(second.gateway.operationGet(operationId)).toMatchObject({ state: "cancelled", dispatchAttempt: 0 });
      expect(rosterReads).toBe(0);

      for (const result of [get, listed, cancelled]) {
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("Jane Doe");
        expect(serialized).not.toContain("private_note");
        expect(serialized).not.toContain("canvas:historical-g1");
        expect(serialized).not.toContain("canvas:historical-g2");
        expect(serialized).not.toMatch(/(?:plan|readback|createdAt|updatedAt|catalogDigest|targetIdentity|sourceOperationId)/u);
      }
    } finally {
      await client?.close();
      await server?.close();
      socket?.close();
      await second?.close();
      await first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it("runs read-only children in bounded windows and never exposes stored arguments", async () => {
    const runtime = await MorrowRuntime.connect(config(), { statePath: ":memory:" });
    try {
      expect(runtime.gateway.catalog.tools.some((tool) => tool.publicName === "morrow_batch_create")).toBe(false);
      expect(runtime.gateway.catalog.tools.some((tool) => tool.publicName === "morrow_batch_reconcile")).toBe(false);
      const created = await runtime.batchCreate({
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
      const created = await runtime.batchCreate({
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
      const review = runtime.batchApprovalGet(batch.batchId);
      const reviewChildren = review.children as { operation: { approvalExpiresAt: string; state: string } }[];
      const earliestExpiry = Math.min(...reviewChildren.map((child) => Date.parse(child.operation.approvalExpiresAt)));
      expect(Date.parse(String(review.expiresAt))).toBe(earliestExpiry);
      const clock = vi.spyOn(Date, "now").mockReturnValue(earliestExpiry + 1);
      try {
        expect(() => runtime.approveBatch(batch.batchId)).toThrow("batch approval preview expired");
        expect(runtime.batchApprovalGet(batch.batchId).children).toEqual(review.children);
      } finally {
        clock.mockRestore();
      }
      const approvalBody = await (await fetch(String(created.approvalUrl))).text();
      expect(approvalBody).toContain("Course 41");
      expect(approvalBody).toContain("Course 42");
      runtime.approveBatch(batch.batchId);

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
      const created = await runtime.batchCreate({
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
      runtime.approveBatch(batch.batchId);
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
      const created = await first.batchCreate({
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
      first.approveBatch(batchId);
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
    const port = await reserveLoopbackPort();
    const sourceBindingId = "canvas:batch-recovery";
    let first: MorrowRuntime | undefined;
    let second: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    let writeCommands = 0;
    try {
      first = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      await assertPortListening(port);
      const bridge = await connectBridgeTestClient({
        port,
        token: "gateway-connector-secret-".repeat(3),
        extensionId: "a".repeat(32),
        catalogDigest: bridgeCatalogDigestForTests(resolve("../..")),
        bindings: [{
          sourceBindingId,
          provider: "canvas",
          courseId: "77",
          origin: "https://school.instructure.com",
          principalFingerprint: "c".repeat(64),
          sessionGeneration: 1,
          catalogDigest: bridgeCatalogDigestForTests(resolve("../..")),
          runtimeVerified: true,
        }],
      });
      socket = bridge.socket;
      bridge.onCommand((command) => {
        expect(command.kind).toBe("invoke_write");
        writeCommands += 1;
        bridge.respond(command, {
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
        });
      });

      const created = await first.batchCreate({
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
      first.approveBatch(batchId);
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

  it("bounds and deduplicates selected-inventory learner context resolution without widening a course scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-inventory-egress-bound-"));
    const port = await reserveLoopbackPort();
    const bindings = Array.from({ length: 100 }, (_, index) => ({
      sourceBindingId: `canvas:scale-${index + 1}`,
      courseId: String(index + 1_000),
    }));
    let runtime: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    let rosterInFlight = 0;
    let maximumRosterInFlight = 0;
    try {
      runtime = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath: join(directory, "gateway.sqlite3") });
      socket = await connectAuditBridge(port, bindings, [], {
        responseDelayMs: 8,
        onCommandStart: (command) => {
          if (command.toolName !== "canvas_list_users_in_course_users") return;
          rosterInFlight += 1;
          maximumRosterInFlight = Math.max(maximumRosterInFlight, rosterInFlight);
        },
        onCommandFinish: (command) => {
          if (command.toolName === "canvas_list_users_in_course_users") rosterInFlight -= 1;
        },
      });
      const callSourceOwned = vi.spyOn(runtime.gateway, "callSourceOwned");
      const courses = bindings.map((binding) => ({
        course_id: binding.courseId,
        source_binding_id: binding.sourceBindingId,
        evidence: `Feedback for Student ${binding.courseId}`,
        coverage_gaps: [],
        targets: Array.from({ length: 4 }, (_, index) => ({
          batch_eligibility: "eligible",
          target: {
            kind: "page",
            page_url: `page-${binding.courseId}-${index}`,
            title: `Feedback for Student ${binding.courseId}`,
          },
        })),
      }));
      const auditChildren = courses.flatMap((course) => course.targets.map((target, index) => ({
        childId: `audit:${course.course_id}:${index}`,
        courseId: course.course_id,
        sourceBindingId: course.source_binding_id,
        tool: "morrow_audit_course",
        arguments: {
          provider: "canvas",
          course_id: course.course_id,
          source_binding_id: course.source_binding_id,
          target: target.target,
        },
      })));
      const request = { provider: "canvas", scope: "selected_program", courses };
      const redacted = await runtime.gateway.redactMcpEgress({
        structuredContent: {
          schema: "morrow.course-inventory.v1",
          provider: "canvas",
          scope: "selected_program",
          courses,
          audit_children: auditChildren,
          coverage: { complete: true },
        },
      }, request, { bound: false, toolName: "morrow_inventory_courses" });
      const text = JSON.stringify(redacted);
      expect(redacted.isError, text).not.toBe(true);
      expect(text).not.toContain("Student 1000");
      expect(maximumRosterInFlight).toBeGreaterThan(1);
      expect(maximumRosterInFlight).toBeLessThanOrEqual(4);
      expect(callSourceOwned.mock.calls.filter(([tool]) => tool === "morrow_browser_bindings")).toHaveLength(1);
      expect(callSourceOwned.mock.calls.filter(([tool]) => tool === "canvas_list_users_in_course_users")).toHaveLength(100);

      const refused = await runtime.gateway.redactMcpEgress({
        structuredContent: {
          schema: "morrow.course-inventory.v1",
          provider: "canvas",
          scope: "selected_program",
          courses,
          audit_children: [...auditChildren, {
            childId: "audit:wrong-scope",
            courseId: "999999",
            sourceBindingId: "canvas:not-selected",
            tool: "morrow_audit_course",
            arguments: {
              provider: "canvas",
              course_id: "999999",
              source_binding_id: "canvas:not-selected",
              target: { kind: "page", page_url: "private", title: "Jane Doe" },
            },
          }],
          coverage: { complete: true },
        },
      }, request, { bound: false, toolName: "morrow_inventory_courses" });
      expect(refused).toMatchObject({
        isError: true,
        structuredContent: { code: "learner_roster_binding_unavailable" },
      });
      expect(JSON.stringify(refused)).not.toContain("Jane Doe");
    } finally {
      socket?.close();
      await runtime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("persists per-course inventory progress and creates one idempotent audit batch from eligible partial coverage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-program-inventory-"));
    const statePath = join(directory, "morrow.sqlite3");
    const keyPath = join(directory, "batch.key");
    const port = await reserveLoopbackPort();
    const bindings = [{ sourceBindingId: "canvas:program-41", courseId: "41" }];
    const commands: BridgeCommand[] = [];
    let first: MorrowRuntime | undefined;
    let second: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    try {
      first = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectAuditBridge(port, bindings, commands, {
        truncatedTools: ["canvas_list_files_courses"],
      });
      const created = await first.programInventoryCreate({
        name: "Selected program",
        concurrency: 1,
        inventory: {
          provider: "canvas",
          scope: "selected_program",
          courses: [{ course_id: "41", expected_name: "Course 41", source_binding_id: "canvas:program-41" }],
          max_pages_per_list: 1,
        },
      });
      const inventoryBatchId = String((created.inventoryBatch as { batchId: string }).batchId);
      await first.batchRun({ batchId: inventoryBatchId, maxChildren: 1 });
      const retained = first.batches.readResult(inventoryBatchId, "inventory:41");
      const retainedText = JSON.stringify(retained);
      expect(retained).toMatchObject({
        schema: "morrow.course-inventory.v1",
        courses: [{ course_id: "41", source_binding_id: "canvas:program-41" }],
        audit_children: expect.any(Array),
      });
      expect(retainedText).not.toContain("Jane Doe");
      expect(retainedText).not.toContain("jane.doe@example.edu");
      const defaultPage = first.batchResultsPage({ batchId: inventoryBatchId, limit: 1 });
      expect(JSON.stringify(defaultPage)).not.toContain("Jane Doe");
      expect(defaultPage.children).toMatchObject([
        { childId: "inventory:41", state: "succeeded", sourceResultState: "inventory_incomplete", hasStoredResult: true },
      ]);
      const selected = await first.batchResultsPageEgress({
        batchId: inventoryBatchId,
        limit: 1,
        resultChildId: "inventory:41",
      });
      const selectedText = JSON.stringify(selected);
      expect(selectedText).not.toContain("Jane Doe");
      expect(selected).toMatchObject({
        nativeInventoryReport: {
          status: "available",
          childId: "inventory:41",
          report: { coverage: { complete: false }, audit_children: expect.any(Array) },
        },
      });
      const report = (selected.nativeInventoryReport as { report: { audit_children: { childId: string }[] } }).report;
      const pageTarget = report.audit_children.find((target) => target.childId.startsWith("audit:"));
      expect(pageTarget).toBeTruthy();
      for (const path of [statePath, `${statePath}-wal`].filter(existsSync)) {
        expect(readFileSync(path).includes(Buffer.from("Jane Doe"))).toBe(false);
      }

      await first.close();
      first = undefined;
      socket.close();
      socket = undefined;
      second = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectAuditBridge(port, bindings, commands);
      const audit = await second.programInventoryCreateAuditBatch({
        inventoryBatchId,
        name: "Audit eligible saved targets",
        concurrency: 1,
        targetIds: [pageTarget!.childId],
      });
      const auditBatchId = String((audit.auditBatch as { batchId: string }).batchId);
      const repeat = await second.programInventoryCreateAuditBatch({
        inventoryBatchId,
        name: "Ignored on idempotent repeat",
        concurrency: 1,
        targetIds: [pageTarget!.childId],
      });
      expect(repeat).toMatchObject({ auditBatch: { batchId: auditBatchId }, idempotent: true });
      await second.batchRun({ batchId: auditBatchId, maxChildren: 1 });
      expect(second.batchGet({ batchId: auditBatchId, limit: 10 }).batch).toMatchObject({ state: "completed", succeededChildren: 1 });
      const auditResult = await second.batchResultsPageEgress({
        batchId: auditBatchId,
        limit: 1,
        resultChildId: pageTarget!.childId,
      });
      expect(JSON.stringify(auditResult)).not.toContain("Jane Doe");
      expect(auditResult).toMatchObject({ nativeAuditReport: { status: "available", childId: pageTarget!.childId } });
    } finally {
      socket?.close();
      await second?.close();
      await first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it("removes an audit target whose exact identifier would change during learner redaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-inventory-identifier-privacy-"));
    const statePath = join(directory, "morrow.sqlite3");
    const keyPath = join(directory, "batch.key");
    const port = await reserveLoopbackPort();
    let runtime: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    try {
      runtime = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectAuditBridge(port, [{ sourceBindingId: "canvas:identifier-41", courseId: "41" }], [], {
        dataForCommand: (command) => command.toolName === "canvas_list_pages_courses"
          ? [{ page_id: "101", url: "Jane%20Doe", title: "Identifier collision" }]
          : undefined,
      });
      const created = await runtime.programInventoryCreate({
        name: "Identifier privacy boundary",
        concurrency: 1,
        inventory: {
          provider: "canvas",
          scope: "selected_program",
          courses: [{ course_id: "41", expected_name: "Course 41", source_binding_id: "canvas:identifier-41" }],
          max_pages_per_list: 1,
        },
      });
      const inventoryBatchId = String((created.inventoryBatch as { batchId: string }).batchId);
      const completed = await runtime.batchRun({ batchId: inventoryBatchId, maxChildren: 1 });
      expect(completed.batch).toMatchObject({ state: "completed", succeededChildren: 1 });
      const stored = runtime.batches.readResult(inventoryBatchId, "inventory:41")!;
      const storedText = JSON.stringify(stored);
      expect(storedText).not.toContain("Jane Doe");
      expect(storedText).not.toContain("Jane%20Doe");
      expect(storedText).not.toMatch(/learner_[\w-]+/);
      expect(stored).toMatchObject({
        audit_children: [{ arguments: { target: { kind: "syllabus" } } }],
        coverage: { complete: false, status: "inventory_incomplete", audit_child_count: 1 },
      });
      const course = (stored.courses as JsonObject[])[0]!;
      expect(course.targets).toEqual([expect.objectContaining({ target: { kind: "syllabus" } })]);
      expect(course.coverage_gaps).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "target_identifier_redacted", list: "privacy", blocking: true }),
      ]));
      await expect(runtime.programInventoryCreateAuditBatch({
        inventoryBatchId,
        name: "No tokenized identifier audit",
        concurrency: 1,
        targetIds: ["Jane%20Doe"],
      })).rejects.toThrow();
    } finally {
      socket?.close();
      await runtime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("bounds an oversized selected-course inventory before encrypted settlement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-inventory-result-limit-"));
    const statePath = join(directory, "morrow.sqlite3");
    const keyPath = join(directory, "batch.key");
    const port = await reserveLoopbackPort();
    const pages = Array.from({ length: 2_500 }, (_, index) => ({
      page_id: String(index + 10_000),
      url: `large-page-${index + 1}`,
      title: `Feedback for ${"Jane Doe ".repeat(35)}`.trim(),
    }));
    let runtime: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    try {
      runtime = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectAuditBridge(port, [{ sourceBindingId: "canvas:large-41", courseId: "41" }], [], {
        dataForCommand: (command) => command.toolName === "canvas_list_pages_courses" ? pages : undefined,
      });
      const inventoryInput = {
        provider: "canvas" as const,
        scope: "selected_program" as const,
        courses: [{ course_id: "41", expected_name: "Course 41", source_binding_id: "canvas:large-41" }],
        max_pages_per_list: 1,
      };
      const created = await runtime.programInventoryCreate({
        name: "Large selected course",
        concurrency: 1,
        inventory: inventoryInput,
      });
      const inventoryBatchId = String((created.inventoryBatch as { batchId: string }).batchId);
      const completed = await runtime.batchRun({ batchId: inventoryBatchId, maxChildren: 1 });
      expect(completed.batch).toMatchObject({ state: "completed", succeededChildren: 1, runningChildren: 0 });
      const stored = runtime.batches.readResult(inventoryBatchId, "inventory:41");
      expect(stored).toBeTruthy();
      expect(Buffer.byteLength(canonicalJson(stored), "utf8")).toBeLessThanOrEqual(MAX_BATCH_RESULT_BYTES);
      const storedText = JSON.stringify(stored);
      expect(storedText).not.toContain("Jane Doe");
      expect(stored).toMatchObject({ coverage: { complete: false, status: "inventory_incomplete" } });
      const storedCourse = (stored!.courses as JsonObject[])[0]!;
      expect((storedCourse.targets as JsonObject[]).length).toBeGreaterThan(0);
      expect((storedCourse.targets as JsonObject[]).length).toBeLessThan(pages.length);
      expect(storedCourse.coverage_gaps).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "durable_result_target_cap_reached", list: "durable_result", blocking: true }),
      ]));
      expect(stored.audit_children).toHaveLength((storedCourse.targets as JsonObject[]).length);
    } finally {
      socket?.close();
      await runtime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it("persists one native Canvas audit report across restart without exposing it in default batch results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-native-audit-batch-"));
    const statePath = join(directory, "morrow.sqlite3");
    const keyPath = join(directory, "batch.key");
    const port = await reserveLoopbackPort();
    const courseIds = Array.from({ length: 24 }, (_, index) => String(index + 41));
    const bindings = courseIds.map((courseId) => ({
      sourceBindingId: `canvas:audit-${courseId}`,
      courseId,
    }));
    const commands: BridgeCommand[] = [];
    let first: MorrowRuntime | undefined;
    let second: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    let batchId = "";
    try {
      first = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectAuditBridge(port, bindings, commands);
      const created = await first.batchCreate({
        name: "Native Canvas audit",
        mode: "read_only",
        concurrency: 8,
        courseSet: { source: "explicit", courseIds, complete: true, paginationComplete: true },
        operations: bindings.map((binding) => ({
          childId: `course:${binding.courseId}`,
          courseId: binding.courseId,
          tool: "morrow_audit_course",
          sourceBindingId: binding.sourceBindingId,
          arguments: {
            provider: "canvas",
            source_binding_id: binding.sourceBindingId,
            course_id: binding.courseId,
            target: { kind: "page", page_url: `page-${binding.courseId}` },
          },
        })),
      });
      batchId = String((created.batch as { batchId: string }).batchId);
      const firstRun = await first.batchRun({ batchId, maxChildren: 1 });
      expect(firstRun).toMatchObject({ processed: 1, remaining: courseIds.length - 1 });
      expect(commands).toHaveLength(2);
      expect(JSON.stringify(first.batchResultsPage({ batchId, limit: 1 }))).not.toContain("private-audit-body-41");
      for (const path of [statePath, `${statePath}-wal`].filter(existsSync)) {
        expect(readFileSync(path).includes(Buffer.from("private-audit-body-41"))).toBe(false);
      }
      await first.close();
      first = undefined;
      socket.close();
      socket = undefined;

      second = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectAuditBridge(port, bindings, commands);
      const secondRun = await second.batchResume({ batchId, maxChildren: courseIds.length - 1 });
      expect(secondRun.batch).toMatchObject({ state: "completed", succeededChildren: courseIds.length });
      expect(commands).toHaveLength(courseIds.length * 2);
      for (const command of commands) {
        const argumentsValue = command.arguments as Record<string, unknown>;
        const courseId = String(argumentsValue.course_id || argumentsValue.id || "");
        expect(courseIds).toContain(courseId);
        expect(command.sourceBindingId).toBe(`canvas:audit-${courseId}`);
      }
      for (const courseId of courseIds) {
        expect(commands.filter((command) => {
          const argumentsValue = command.arguments as Record<string, unknown>;
          return String(argumentsValue.course_id || argumentsValue.id || "") === courseId;
        })).toHaveLength(2);
      }
      const defaultPage = second.batchResultsPage({ batchId, offset: 0, limit: 1 });
      expect(JSON.stringify(defaultPage)).not.toContain("private-audit-body-41");
      expect(defaultPage.children).toMatchObject([
        { childId: "course:41", state: "succeeded", sourceResultState: "evidence_ready", hasStoredResult: true },
      ]);
      const incompletePage = second.batchResultsPage({ batchId, offset: 1, limit: 1, resultChildId: "course:42" });
      expect(incompletePage).toMatchObject({
        children: [{ childId: "course:42", state: "succeeded", sourceResultState: "evidence_incomplete", hasStoredResult: true }],
        nativeAuditReport: { status: "available", childId: "course:42", report: { status: "evidence_incomplete" } },
      });
      const firstCourseReport = second.batchResultsPage({
        batchId,
        offset: 0,
        limit: 1,
        resultChildId: "course:41",
      });
      const secondCourseReport = second.batchResultsPage({
        batchId,
        offset: 2,
        limit: 1,
        resultChildId: "course:43",
      });
      const firstSerialized = JSON.stringify(firstCourseReport.nativeAuditReport);
      const secondSerialized = JSON.stringify(secondCourseReport.nativeAuditReport);
      const firstToken = /learner_[\w-]+/.exec(firstSerialized)?.[0];
      const secondToken = /learner_[\w-]+/.exec(secondSerialized)?.[0];
      expect(firstSerialized).not.toContain("Jane Doe");
      expect(secondSerialized).not.toContain("Rowan Clarke");
      expect(firstToken).toBeTruthy();
      expect(secondToken).toBeTruthy();
      expect(firstToken).not.toBe(secondToken);
      const laterCourseId = courseIds.at(-1)!;
      const selectedPage = second.batchResultsPage({
        batchId,
        offset: courseIds.length - 1,
        limit: 1,
        resultChildId: `course:${laterCourseId}`,
      });
      expect(selectedPage.nativeAuditReport).toMatchObject({
        status: "available",
        childId: `course:${laterCourseId}`,
        report: { provider: "canvas", source_binding_id: `canvas:audit-${laterCourseId}`, status: "evidence_ready" },
      });
      expect(JSON.stringify(selectedPage.nativeAuditReport)).toContain(`private-audit-body-${laterCourseId}`);
    } finally {
      socket?.close();
      await second?.close();
      await first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it("retains a cancelled native audit batch as partial across restart without scheduling cancelled children", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-native-audit-cancel-"));
    const statePath = join(directory, "morrow.sqlite3");
    const keyPath = join(directory, "batch.key");
    const port = await reserveLoopbackPort();
    const bindings = ["51", "52", "53"].map((courseId) => ({
      sourceBindingId: `canvas:audit-${courseId}`,
      courseId,
    }));
    const commands: BridgeCommand[] = [];
    let first: MorrowRuntime | undefined;
    let second: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    try {
      first = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectAuditBridge(port, bindings, commands);
      const created = await first.batchCreate({
        name: "Cancelled native Canvas audit",
        mode: "read_only",
        concurrency: 1,
        courseSet: { source: "explicit", courseIds: bindings.map(({ courseId }) => courseId), complete: true, paginationComplete: true },
        operations: bindings.map((binding) => ({
          childId: `course:${binding.courseId}`,
          courseId: binding.courseId,
          tool: "morrow_audit_course",
          sourceBindingId: binding.sourceBindingId,
          arguments: {
            provider: "canvas",
            source_binding_id: binding.sourceBindingId,
            course_id: binding.courseId,
            target: { kind: "page", page_url: `page-${binding.courseId}` },
          },
        })),
      });
      const batchId = String((created.batch as { batchId: string }).batchId);
      await first.batchRun({ batchId, maxChildren: 1 });
      expect(commands).toHaveLength(2);
      expect(first.batchCancel(batchId).batch).toMatchObject({
        state: "partial",
        succeededChildren: 1,
        cancelledChildren: 2,
        pendingChildren: 0,
      });
      await first.close();
      first = undefined;
      socket.close();
      socket = undefined;

      second = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      const resumed = await second.batchResume({ batchId, maxChildren: 3 });
      expect(resumed).toMatchObject({ processed: 0, batch: { state: "partial", succeededChildren: 1, cancelledChildren: 2 } });
      expect(commands).toHaveLength(2);
      expect(second.batchResultsPage({ batchId, offset: 0, limit: 3 }).children).toMatchObject([
        { childId: "course:51", state: "succeeded", hasStoredResult: true },
        { childId: "course:52", state: "cancelled", hasStoredResult: false },
        { childId: "course:53", state: "cancelled", hasStoredResult: false },
      ]);
    } finally {
      socket?.close();
      await second?.close();
      await first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails a native audit when a frozen binding belongs to another course", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-native-audit-binding-"));
    const port = await reserveLoopbackPort();
    const commands: BridgeCommand[] = [];
    let runtime: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    try {
      runtime = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath: join(directory, "gateway.sqlite3") });
      socket = await connectAuditBridge(port, [{ sourceBindingId: "canvas:audit-41", courseId: "41" }], commands);
      const created = await runtime.batchCreate({
        name: "Wrong audit binding",
        mode: "read_only",
        concurrency: 1,
        operations: [{
          childId: "course:42",
          courseId: "42",
          tool: "morrow_audit_course",
          sourceBindingId: "canvas:audit-41",
          arguments: {
            provider: "canvas",
            source_binding_id: "canvas:audit-41",
            course_id: "42",
            target: { kind: "page", page_url: "page-42" },
          },
        }],
      });
      const batchId = String((created.batch as { batchId: string }).batchId);
      const run = await runtime.batchRun({ batchId, maxChildren: 1 });
      expect(run.batch).toMatchObject({ state: "failed", failedChildren: 1 });
      expect(commands).toEqual([]);
      expect(runtime.batchResultsPage({ batchId, limit: 1 })).toMatchObject({
        children: [{
          childId: "course:42",
          state: "failed",
          sourceResultState: "course_audit_unavailable",
          hasStoredResult: false,
        }],
      });
    } finally {
      socket?.close();
      await runtime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

async function connectMoodleInventoryBridge(
  port: number,
  sourceBindingId: string,
  courseId: number,
  commands: BridgeCommand[],
): Promise<WebSocket> {
  const origin = "https://moodle.inventory.example";
  const siteUrl = `${origin}/campus/`;
  const catalogDigest = bridgeCatalogDigestForTests(resolve("../.."));
  const principalFingerprint = "m".replace("m", "c").repeat(64);
  await assertPortListening(port);
  const bridge = await connectBridgeTestClient({
    port,
    token: "gateway-connector-secret-".repeat(3),
    extensionId: "a".repeat(32),
    catalogDigest,
    bindings: [{
      sourceBindingId,
      provider: "moodle" as const,
      origin,
      siteUrl,
      courseId: String(courseId),
      courseName: "Moodle Biology",
      principalFingerprint,
      sessionGeneration: 1,
      catalogDigest,
      editPolicyRevision: 0,
      runtimeVerified: true,
    }],
  });
  bridge.onCommand((command) => {
    expect(command.kind).toBe("invoke_read");
    expect(command.sourceBindingId).toBe(sourceBindingId);
    expect(String(command.arguments.course_id)).toBe(String(courseId));
    commands.push(command);
    const snapshotDigest = "d".repeat(64);
    const data = command.toolName === "moodle_get_course_participant_roster"
      ? {
        schema: "morrow.moodle-course-roster.v1",
        provider: "moodle",
        sourceBindingId,
        courseId: String(courseId),
        origin,
        siteUrl,
        principalFingerprint,
        sessionGeneration: 1,
        catalogDigest,
        status: "complete",
        complete: true,
        identities: [{ id: "student-81", name: "Jane Moodle", email: "jane.moodle@example.edu" }],
        proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 1, identityCount: 1 },
      }
      : command.toolName === "moodle_get_course"
        ? { course_id: courseId, fullname: "Moodle Biology" }
        : command.toolName === "moodle_get_contents"
          ? {
            course: { id: courseId, fullname: "Moodle Biology" },
            sections: [],
            activities: [
              { id: 81, module: "page", name: "Feedback from Jane Moodle" },
              { id: 82, module: "assign", name: "Reflection" },
              { id: 83, module: "quiz", name: "Knowledge check" },
              { id: 84, module: "resource", name: "Reference PDF" },
              { id: 85, module: "workshop", name: "Peer workshop" },
            ],
          }
          : command.toolName === "moodle_get_page"
            ? { course_id: courseId, module_id: 81, name: "Feedback from Jane Moodle", content: "<p>Jane Moodle: jane.moodle@example.edu</p>" }
            : command.toolName === "moodle_get_assignment"
              ? { course_id: courseId, module_id: 82, name: "Reflection", instructions: "<p>Reflect</p>" }
              : command.toolName === "moodle_get_quiz"
                ? { course_id: courseId, module_id: 83, name: "Knowledge check", instructions: "<p>Quiz</p>" }
                : command.toolName === "moodle_list_quiz_questions"
                  ? {
                    course_id: courseId,
                    module_id: 83,
                    truncated: false,
                    questions: [
                      { slot_id: 91, qtype: "essay", inspectable: true, name: "Jane Moodle reflection" },
                      { slot_id: 92, qtype: "truefalse", inspectable: true, name: "Unsupported question" },
                      { slot_id: 93, qtype: "essay", inspectable: false, reason: "random_slot" },
                    ],
                  }
                  : command.toolName === "moodle_get_resource_files"
                    ? {
                      course_id: courseId,
                      module_id: 84,
                      name: "Reference PDF",
                      files: [{ filename: "reference.pdf", relative_path: "reference.pdf", size_bytes: 120_345, media_type_label: "PDF document", main_file: true }],
                      provenance: { source: "native_resource_settings_form", private_draft_copy_prepared: true, form_submitted: false, root_folder_only: true },
                    }
                    : command.toolName === "moodle_get_quiz_question"
                      ? Number(command.arguments.slot_id) === 91
                        ? { course_id: courseId, module_id: 83, slot_id: 91, qtype: "essay", name: "Jane Moodle reflection", question_text: "<p>Jane Moodle reflects.</p>", general_feedback: "Review." }
                        : { course_id: courseId, module_id: 83, slot_id: 92, qtype: "truefalse", name: "True or false", question_text: "<p>Cells have membranes.</p>", general_feedback: "Review." }
                      : null;
    if (!data) throw new Error(`unexpected Moodle inventory command ${command.toolName}`);
    bridge.respond(command, {
      schema: "morrow.moodle-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data,
      targets: [],
      snapshot_digest: snapshotDigest,
    });
  });
  // The tests close and reconnect this bridge, so they hold the socket itself.
  return bridge.socket;
}

describe("Moodle durable selected-program inventory", () => {
  it("persists only redacted exact Moodle inventory data, retains explicit gaps, and converts readable targets after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-moodle-program-inventory-"));
    const statePath = join(directory, "morrow.sqlite3");
    const keyPath = join(directory, "batch.key");
    const port = await reserveLoopbackPort();
    const sourceBindingId = "moodle:program:71";
    const commands: BridgeCommand[] = [];
    let first: MorrowRuntime | undefined;
    let second: MorrowRuntime | undefined;
    let socket: WebSocket | undefined;
    try {
      first = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectMoodleInventoryBridge(port, sourceBindingId, 71, commands);
      const created = await first.programInventoryCreate({
        name: "Moodle selected program",
        concurrency: 1,
        inventory: {
          provider: "moodle",
          scope: "selected_program",
          courses: [{ course_id: 71, expected_name: "Moodle Biology", source_binding_id: sourceBindingId }],
        },
      });
      const inventoryBatchId = String((created.inventoryBatch as { batchId: string }).batchId);
      await first.batchRun({ batchId: inventoryBatchId, maxChildren: 1 });
      const retained = first.batches.readResult(inventoryBatchId, "inventory:moodle:71");
      const retainedText = JSON.stringify(retained);
      expect(retained).toMatchObject({
        schema: "morrow.course-inventory.v1",
        provider: "moodle",
        courses: [{ course_id: "71", source_binding_id: sourceBindingId, status: "inventory_incomplete" }],
      });
      expect(retainedText).not.toContain("Jane Moodle");
      expect(retainedText).not.toContain("jane.moodle@example.edu");
      const retainedCourse = ((retained as JsonObject).courses as JsonObject[])[0]!;
      expect(retainedCourse.coverage_gaps).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "file_bytes_not_readable", blocking: true }),
        expect.objectContaining({ code: "activity_type_unsupported", blocking: true }),
        expect.objectContaining({ code: "quiz_question_unreadable", blocking: true }),
      ]));
      expect((retained as JsonObject).audit_children).toHaveLength(5);
      const page = await first.batchResultsPageEgress({ batchId: inventoryBatchId, limit: 1, resultChildId: "inventory:moodle:71" });
      expect(JSON.stringify(page)).not.toContain("Jane Moodle");
      expect(JSON.stringify(page)).not.toContain("jane.moodle@example.edu");
      expect(commands.map((command) => command.toolName)).toEqual(expect.arrayContaining([
        "moodle_get_contents", "moodle_get_page", "moodle_get_assignment", "moodle_get_quiz", "moodle_list_quiz_questions", "moodle_get_quiz_question", "moodle_get_resource_files",
      ]));
      for (const path of [statePath, `${statePath}-wal`].filter(existsSync)) {
        expect(readFileSync(path).includes(Buffer.from("Jane Moodle"))).toBe(false);
      }

      await first.close();
      first = undefined;
      socket.close();
      socket = undefined;
      second = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      socket = await connectMoodleInventoryBridge(port, sourceBindingId, 71, commands);
      const audit = await second.programInventoryCreateAuditBatch({
        inventoryBatchId,
        name: "Moodle readable targets",
        concurrency: 2,
      });
      const auditBatchId = String((audit.auditBatch as { batchId: string }).batchId);
      expect(second.batchGet({ batchId: auditBatchId, limit: 10 }).children).toHaveLength(5);
      const repeat = await second.programInventoryCreateAuditBatch({
        inventoryBatchId,
        name: "Moodle readable targets repeated",
        concurrency: 2,
      });
      expect(repeat).toMatchObject({ auditBatch: { batchId: auditBatchId }, idempotent: true });
    } finally {
      socket?.close();
      await second?.close();
      await first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
