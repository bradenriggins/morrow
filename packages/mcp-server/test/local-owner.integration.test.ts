import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import {
  clearDeadLocalOwnerMaintenanceLease,
  requestLocalOwnerMaintenance,
} from "../src/local-owner-maintenance.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const entryPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function waitFor(predicate: () => Promise<boolean> | boolean, detail: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${detail}`);
}

async function readLog(path: string): Promise<readonly string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

interface ConnectedClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

async function connect(
  configPath: string,
  cwd?: string,
  clientName = "morrow-local-owner-test",
): Promise<ConnectedClient> {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPath],
    env: { ...getDefaultEnvironment(), MORROW_UPSTREAMS_FILE: configPath },
    stderr: "pipe",
    ...(cwd ? { cwd } : {}),
  });
  await client.connect(transport);
  return { client, transport };
}

interface RequestedByProjection {
  readonly clientName?: unknown;
  readonly clientVersion?: unknown;
  readonly workspaceName?: unknown;
  readonly workspaceDigest?: unknown;
  readonly sessionId?: unknown;
}

function structured(result: unknown): Record<string, unknown> {
  const value = (result as { structuredContent?: unknown }).structuredContent;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** The requesting-assistant identity a saved operation carries, from its frozen plan. */
function requestedByOf(result: unknown): RequestedByProjection | undefined {
  const content = structured(result);
  const direct = content.requestedBy;
  if (direct && typeof direct === "object") return direct as RequestedByProjection;
  const plan = content.plan;
  const fromPlan = plan && typeof plan === "object"
    ? (plan as Record<string, unknown>).requestedBy
    : undefined;
  return fromPlan && typeof fromPlan === "object" ? fromPlan as RequestedByProjection : undefined;
}

/** The requesting-assistant identity a saved batch carries. */
function batchRequestedByOf(result: unknown): RequestedByProjection | undefined {
  const batch = structured(result).batch;
  const value = batch && typeof batch === "object"
    ? (batch as Record<string, unknown>).requestedBy
    : undefined;
  return value && typeof value === "object" ? value as RequestedByProjection : undefined;
}

function batchIdOf(result: unknown): string {
  const batch = structured(result).batch;
  const value = batch && typeof batch === "object"
    ? (batch as Record<string, unknown>).batchId
    : undefined;
  return typeof value === "string" ? value : "";
}

describe("Morrow local owner", () => {
  it("connects when an upstream needs more than ten seconds to start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-local-owner-slow-"));
    const configPath = join(directory, "morrow.upstreams.json");
    const journalPath = join(directory, "gateway.sqlite3");
    const ownerPath = `${journalPath}.local-owner.json`;
    await writeFile(configPath, JSON.stringify({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      toolSurface: "full",
      sourcePolicy: { requireAttestation: false },
      upstreams: [{
        id: "morrow-legacy",
        label: "Delayed startup fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `await new Promise(resolve => setTimeout(resolve, 11_000)); await import(${JSON.stringify(pathToFileURL(fixturePath).href)});`,
        ],
        env: { FAKE_SOURCE: "morrow-legacy" },
        priority: 1,
        required: true,
        enabled: true,
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: journalPath },
      privacy: {
        canvasOrigin: "local",
        account: "local-account",
        principal: "local-principal",
        learnerVaultPath: join(directory, "learner-vault.json"),
      },
      maxCatalogTools: 20,
    }));
    let connection: ConnectedClient | null = null;
    try {
      connection = await connect(configPath);
      expect(existsSync(ownerPath)).toBe(true);
      const result = await connection.client.listTools();
      expect(result.tools.some((tool) => tool.name === "morrow_health")).toBe(true);
    } finally {
      await connection?.client.close();
      await waitFor(() => !existsSync(ownerPath), "the delayed owner's shutdown");
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it("shares one durable runtime across stdio clients and closes when they leave", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-local-owner-"));
    const configPath = join(directory, "morrow.upstreams.json");
    const incompatibleConfigPath = join(directory, "incompatible.upstreams.json");
    const journalPath = join(directory, "gateway.sqlite3");
    const ownerPath = `${journalPath}.local-owner.json`;
    const callLogPath = join(directory, "calls.log");
    const config = {
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      toolSurface: "full",
      sourcePolicy: { requireAttestation: false },
      upstreams: [{
        id: "morrow-legacy",
        label: "Fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [fixturePath],
        env: {
          FAKE_SOURCE: "morrow-legacy",
          FAKE_CALL_LOG: callLogPath,
          FAKE_LARGE_RESULT_CHARS: "70000",
          FAKE_DELAY_MS: "500",
        },
        priority: 1,
        required: true,
        enabled: true,
        outputPrivacy: {
          canvas_page_get: {
            allowedFields: ["source", "course_id", "large"],
            dataClass: "course",
            maxRecords: 10,
            maxBytes: 250_000,
            freeText: "allow",
            learnerTokens: false,
            artifactInspection: "deny",
          },
        },
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: journalPath },
      privacy: {
        canvasOrigin: "local",
        account: "local-account",
        principal: "local-principal",
        learnerVaultPath: join(directory, "learner-vault.json"),
      },
      maxCatalogTools: 20,
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let first: ConnectedClient | null = null;
    let second: ConnectedClient | null = null;
    try {
      [first, second] = await Promise.all([connect(configPath), connect(configPath)]);
      expect(existsSync(ownerPath)).toBe(true);
      const descriptor = JSON.parse(await readFile(ownerPath, "utf8")) as {
        pid?: unknown;
        port?: unknown;
        token?: unknown;
        configDigest?: unknown;
      };
      expect(typeof descriptor.pid).toBe("number");
      expect(typeof descriptor.port).toBe("number");
      expect(descriptor.configDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(first.transport.pid).not.toBeNull();

      const browserRequest = await fetch(`http://127.0.0.1:${descriptor.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${descriptor.token}`,
          "x-morrow-proxy-pid": String(first.transport.pid),
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(browserRequest.status).toBe(403);
      await expect(browserRequest.json()).resolves.toMatchObject({ code: "local_owner_workspace_required" });

      const directWorkspace = await realpath(directory);
      const directWorkspaceHeader = Buffer.from(directWorkspace, "utf8").toString("base64url");
      const initialize = await fetch(`http://127.0.0.1:${descriptor.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${descriptor.token}`,
          "x-morrow-proxy-pid": String(first.transport.pid),
          "x-morrow-workspace": directWorkspaceHeader,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "raw-owner-test", version: "1" } },
        }),
      });
      expect(initialize.status).toBe(200);
      const directSessionId = initialize.headers.get("mcp-session-id");
      expect(directSessionId).toBeTruthy();
      const anotherWorkspace = await mkdtemp(join(tmpdir(), "morrow-other-workspace-"));
      try {
        const switchedWorkspace = await fetch(`http://127.0.0.1:${descriptor.port}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${descriptor.token}`,
            "x-morrow-proxy-pid": String(first.transport.pid),
            "x-morrow-workspace": Buffer.from(await realpath(anotherWorkspace), "utf8").toString("base64url"),
            "mcp-session-id": directSessionId!,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }),
        });
        expect(switchedWorkspace.status).toBe(403);
        await expect(switchedWorkspace.json()).resolves.toMatchObject({ code: "local_owner_session_workspace_required" });
      } finally {
        await rm(anotherWorkspace, { recursive: true, force: true });
      }

      await writeFile(incompatibleConfigPath, `${JSON.stringify({
        ...config,
        privacy: { ...config.privacy, principal: "other-principal" },
      }, null, 2)}\n`, "utf8");
      await expect(connect(incompatibleConfigPath)).rejects.toThrow();

      const [firstHealth, secondHealth] = await Promise.all([
        first.client.callTool({ name: "morrow_health", arguments: {} }),
        second.client.callTool({ name: "morrow_health", arguments: {} }),
      ]);
      const firstCatalog = (firstHealth.structuredContent as { catalogDigest?: unknown }).catalogDigest;
      const secondCatalog = (secondHealth.structuredContent as { catalogDigest?: unknown }).catalogDigest;
      expect(typeof firstCatalog).toBe("string");
      expect(secondCatalog).toBe(firstCatalog);

      const large = await first.client.callTool({
        name: "canvas_page_get",
        arguments: { course_id: "101" },
      });
      const handle = (large.structuredContent as { data?: { handle?: unknown } }).data?.handle;
      expect(typeof handle).toBe("string");
      const page = await second.client.callTool({
        name: "morrow_result_page",
        arguments: { handle, limit: 1_000 },
      });
      expect(page.isError).toBe(true);
      expect(page.structuredContent).toMatchObject({
        schema: "morrow.problem.v1",
        code: "result_artifact_unavailable",
      });

      const slow = first.client.callTool({
        name: "canvas_page_get",
        arguments: { course_id: "102" },
      }).catch(() => undefined);
      await waitFor(async () => (await readLog(callLogPath)).filter((value) => value === "canvas_page_get").length === 2, "second source call");
      const quickHealth = await Promise.race([
        first.client.callTool({ name: "morrow_health", arguments: {} }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("a later request waited behind the slow request")), 300)),
      ]);
      expect(quickHealth.isError).not.toBe(true);
      expect(first.transport.pid).not.toBeNull();
      process.kill(first.transport.pid!, "SIGKILL");
      await slow;
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect((await readLog(callLogPath)).filter((value) => value === "canvas_page_get")).toHaveLength(2);
      expect((await second.client.callTool({ name: "morrow_health", arguments: {} })).isError).not.toBe(true);
      expect(second.transport.pid).not.toBeNull();
      process.kill(second.transport.pid!, "SIGKILL");
    } finally {
      await Promise.all([first?.client.close(), second?.client.close()]);
      await waitFor(() => !existsSync(ownerPath), "local owner cleanup");
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps each shared-owner session inside its admitted project while using one runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-local-owner-workspace-"));
    const projectA = join(directory, "project-a");
    const projectB = join(directory, "project-b");
    const configPath = join(directory, "morrow.upstreams.json");
    const journalPath = join(directory, "gateway.sqlite3");
    const ownerPath = `${journalPath}.local-owner.json`;
    const root = resolve("../..");
    const port = await reserveLoopbackPort();
    const canvasPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
    const browserDigest = bridgeCatalogDigestForTests(root);
    const token = "local-owner-workspace-token-".repeat(3);
    const extensionId = "b".repeat(32);
    const sourceBindingId = "moodle:workspace-test";
    const firstBytes = Buffer.from("workspace-a-private-file");
    const secondBytes = Buffer.from("workspace-b-private-file");
    const firstDigest = createHash("sha256").update(firstBytes).digest("hex");
    const secondDigest = createHash("sha256").update(secondBytes).digest("hex");
    const config = {
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      toolSurface: "full",
      sourcePolicy: { requireAttestation: false },
      upstreams: [{
        id: "browser-session", label: "Morrow browser connector", kind: "mcp-stdio",
        command: process.execPath, args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")], cwd: root,
        env: {
          MORROW_CANVAS_CATALOG_PATH: canvasPath,
          MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
          MORROW_CANVAS_CONNECTOR_PORT: String(port),
          MORROW_CANVAS_CONNECTOR_TOKEN: token,
          MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: extensionId,
        },
        sourceDisposition: "adapted_owned",
        outputPrivacy: {},
        outputPrivacyDefault: {
          allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 10_000,
          maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
        },
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: journalPath },
      privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
      maxCatalogTools: 2_000,
    };
    await mkdir(projectA);
    await mkdir(projectB);
    await writeFile(join(projectA, "guide.txt"), firstBytes);
    await writeFile(join(projectB, "guide.txt"), secondBytes);
    await symlink(join(projectB, "guide.txt"), join(projectA, "linked-project-b.txt"));
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let first: ConnectedClient | null = null;
    let second: ConnectedClient | null = null;
    let bridge: BridgeTestClient | undefined;
    const plannedOperationIds: string[] = [];
    const binding = {
      sourceBindingId, provider: "moodle" as const, origin: "https://moodle.example.edu",
      siteUrl: "https://moodle.example.edu/", courseId: "2", courseName: "Biology",
      principalFingerprint: "c".repeat(64), sessionGeneration: 1, catalogDigest: browserDigest,
      editPolicyRevision: 0, editOptionsAvailable: true, runtimeVerified: true,
    };
    try {
      first = await connect(configPath, projectA, "assistant-a");
      await waitFor(() => existsSync(ownerPath), "local owner descriptor");
      const firstOwner = JSON.parse(await readFile(ownerPath, "utf8")) as { nonce: string; pid: number };
      second = await connect(configPath, projectB, "assistant-b");
      const secondOwner = JSON.parse(await readFile(ownerPath, "utf8")) as { nonce: string; pid: number };
      expect(secondOwner).toEqual(firstOwner);

      await assertPortListening(port);
      bridge = await connectBridgeTestClient({
        port, token, extensionId, catalogDigest: browserDigest, bindings: [binding],
      });
      bridge.onCommand((message) => {
        const sectionId = Number(message.arguments?.section_id);
        bridge?.respond(message, {
          schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200,
          data: { course_id: 2, section_id: sectionId, visible: false }, snapshot_digest: "f".repeat(64),
        });
      });

      const firstPlan = await first.client.callTool({
        name: "morrow_plan_moodle_resource_file",
        arguments: { source_binding_id: sourceBindingId, course_id: 2, section_id: 7, name: "Project A guide", file_path: "guide.txt" },
      });
      const secondPlan = await second.client.callTool({
        name: "morrow_plan_moodle_resource_file",
        arguments: { source_binding_id: sourceBindingId, course_id: 2, section_id: 8, name: "Project B guide", file_path: "guide.txt" },
      });
      expect(firstPlan.isError, JSON.stringify(firstPlan)).not.toBe(true);
      expect(secondPlan.isError, JSON.stringify(secondPlan)).not.toBe(true);
      const firstOperation = (firstPlan.structuredContent as { operationId?: unknown }).operationId;
      const secondOperation = (secondPlan.structuredContent as { operationId?: unknown }).operationId;
      expect(firstOperation).toMatch(/^op:/);
      expect(secondOperation).toMatch(/^op:/);
      expect(secondOperation).not.toBe(firstOperation);
      if (typeof firstOperation !== "string" || typeof secondOperation !== "string") throw new Error("file operation id unavailable");
      plannedOperationIds.push(firstOperation, secondOperation);

      const [firstSaved, secondSaved] = await Promise.all([
        first.client.callTool({ name: "morrow_operation_get", arguments: { operation_id: firstOperation } }),
        second.client.callTool({ name: "morrow_operation_get", arguments: { operation_id: secondOperation } }),
      ]);
      const firstSavedText = JSON.stringify(firstSaved);
      const secondSavedText = JSON.stringify(secondSaved);
      expect(firstSavedText).toContain(firstDigest);
      expect(firstSavedText).not.toContain(secondDigest);
      expect(secondSavedText).toContain(secondDigest);
      expect(secondSavedText).not.toContain(firstDigest);
      for (const value of [JSON.stringify(firstPlan), JSON.stringify(secondPlan), firstSavedText, secondSavedText]) {
        expect(value).not.toContain(projectA);
        expect(value).not.toContain(projectB);
        expect(value).not.toContain(firstBytes.toString());
        expect(value).not.toContain(secondBytes.toString());
      }

      // Every saved request names the assistant that asked for it. The project is
      // named and digested; the absolute path stays inside the owner.
      const projectARoot = await realpath(projectA);
      const projectBRoot = await realpath(projectB);
      const projectADigest = createHash("sha256").update(projectARoot).digest("hex");
      const projectBDigest = createHash("sha256").update(projectBRoot).digest("hex");
      expect(requestedByOf(firstSaved)).toMatchObject({
        clientName: "assistant-a",
        workspaceName: "project-a",
        workspaceDigest: projectADigest,
      });
      expect(requestedByOf(secondSaved)).toMatchObject({
        clientName: "assistant-b",
        workspaceName: "project-b",
        workspaceDigest: projectBDigest,
      });
      expect(requestedByOf(firstSaved)?.sessionId).not.toBe(requestedByOf(secondSaved)?.sessionId);

      const listed = await first.client.callTool({ name: "morrow_operation_list", arguments: { limit: 10 } });
      const listedOperations = (structured(listed).operations as Record<string, unknown>[] | undefined) || [];
      const listedFirst = listedOperations.find((entry) => entry.operationId === firstOperation);
      const listedSecond = listedOperations.find((entry) => entry.operationId === secondOperation);
      expect(requestedByOf({ structuredContent: listedFirst })).toMatchObject({ clientName: "assistant-a", workspaceName: "project-a" });
      expect(requestedByOf({ structuredContent: listedSecond })).toMatchObject({ clientName: "assistant-b", workspaceName: "project-b" });
      expect(JSON.stringify(listed)).not.toContain(await realpath(projectB));

      const batchRequest = (name: string, moduleId: number) => ({
        name,
        mode: "read_only",
        concurrency: 1,
        operation_family: "morrow_audit_course",
        profile_digest: "d".repeat(64),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        operations: [{
          child_id: "course-2",
          course_id: "2",
          tool: "morrow_audit_course",
          source_binding_id: sourceBindingId,
          arguments: {
            provider: "moodle",
            source_binding_id: sourceBindingId,
            course_id: 2,
            target: { kind: "page", module_id: moduleId },
          },
        }],
      });
      const firstBatch = await first.client.callTool({
        name: "morrow_batch_create",
        arguments: batchRequest("Project A audit", 21),
      });
      const secondBatch = await second.client.callTool({
        name: "morrow_batch_create",
        arguments: batchRequest("Project B audit", 22),
      });
      expect(firstBatch.isError, JSON.stringify(firstBatch)).not.toBe(true);
      expect(secondBatch.isError, JSON.stringify(secondBatch)).not.toBe(true);
      const firstBatchId = batchIdOf(firstBatch);
      const secondBatchId = batchIdOf(secondBatch);
      expect(firstBatchId).toMatch(/^bat:/);
      expect(secondBatchId).not.toBe(firstBatchId);
      expect(batchRequestedByOf(firstBatch)).toMatchObject({
        clientName: "assistant-a",
        workspaceName: "project-a",
        workspaceDigest: projectADigest,
      });
      expect(batchRequestedByOf(secondBatch)).toMatchObject({
        clientName: "assistant-b",
        workspaceName: "project-b",
        workspaceDigest: projectBDigest,
      });

      // One owner serves both, so each assistant can read the other's saved group
      // and see who asked for it, but never where that assistant works.
      const crossRead = await first.client.callTool({
        name: "morrow_batch_get",
        arguments: { batch_id: secondBatchId },
      });
      expect(crossRead.isError, JSON.stringify(crossRead)).not.toBe(true);
      expect(batchRequestedByOf(crossRead)).toMatchObject({
        clientName: "assistant-b",
        workspaceName: "project-b",
        workspaceDigest: projectBDigest,
      });
      const recent = await second.client.callTool({
        name: "morrow_batches_recent",
        arguments: { limit: 10 },
      });
      expect(JSON.stringify(recent)).toContain("assistant-a");
      for (const value of [
        JSON.stringify(firstBatch), JSON.stringify(secondBatch),
        JSON.stringify(crossRead), JSON.stringify(recent),
        JSON.stringify(firstSaved), JSON.stringify(secondSaved),
      ]) {
        expect(value).not.toContain(projectARoot);
        expect(value).not.toContain(projectBRoot);
        expect(value).not.toContain(projectA);
        expect(value).not.toContain(projectB);
      }

      const escaped = await first.client.callTool({
        name: "morrow_plan_moodle_resource_file",
        arguments: { source_binding_id: sourceBindingId, course_id: 2, section_id: 9, name: "Escaped guide", file_path: "../project-b/guide.txt" },
      });
      expect(escaped.isError).toBe(true);
      expect(JSON.stringify(escaped)).not.toContain(secondBytes.toString());
      const linked = await first.client.callTool({
        name: "morrow_plan_moodle_resource_file",
        arguments: { source_binding_id: sourceBindingId, course_id: 2, section_id: 10, name: "Linked guide", file_path: "linked-project-b.txt" },
      });
      expect(linked.isError).toBe(true);
      expect(JSON.stringify(linked)).not.toContain(secondBytes.toString());
    } finally {
      await bridge?.close();
      if (first) {
        await Promise.all(plannedOperationIds.map((operationId) => first!.client.callTool({
          name: "morrow_operation_cancel", arguments: { operation_id: operationId },
        }).catch(() => undefined)));
      }
      await Promise.all([first?.client.close(), second?.client.close()]);
      await waitFor(() => !existsSync(ownerPath), "workspace local owner cleanup");
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it("recovers a dead desktop holder through the still-held owner, then closes it before a normal monitor restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-local-owner-recovery-"));
    const configPath = join(directory, "morrow.upstreams.json");
    const journalPath = join(directory, "gateway.sqlite3");
    const ownerPath = `${journalPath}.local-owner.json`;
    const callLogPath = join(directory, "calls.log");
    const workspaceRoot = await realpath(process.cwd());
    const config = {
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      toolSurface: "full",
      sourcePolicy: { requireAttestation: false },
      upstreams: [{
        id: "morrow-legacy",
        label: "Fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [fixturePath],
        env: { FAKE_SOURCE: "morrow-legacy", FAKE_CALL_LOG: callLogPath },
        priority: 1,
        required: true,
        enabled: true,
        outputPrivacy: {
          canvas_page_get: {
            allowedFields: ["source", "course_id"],
            dataClass: "course",
            maxRecords: 10,
            maxBytes: 2_000,
            freeText: "allow",
            learnerTokens: false,
            artifactInspection: "deny",
          },
        },
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: journalPath },
      privacy: {
        canvasOrigin: "local",
        account: "local-account",
        principal: "local-principal",
        learnerVaultPath: join(directory, "learner-vault.json"),
      },
      maxCatalogTools: 20,
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const oldHolder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"] , { stdio: "ignore" });
    let oldMonitor: ConnectedClient | null = null;
    let newMonitor: ConnectedClient | null = null;
    try {
      oldMonitor = await connect(configPath);
      await waitFor(() => existsSync(ownerPath), "initial recovery owner");
      const oldOwner = JSON.parse(await readFile(ownerPath, "utf8")) as { port: number; token: string };
      const retainedSession = await fetch(`http://127.0.0.1:${oldOwner.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${oldOwner.token}`,
          "x-morrow-proxy-pid": String(oldMonitor.transport.pid),
          "x-morrow-workspace": Buffer.from(workspaceRoot, "utf8").toString("base64url"),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "recovery-session", version: "1" } },
        }),
      });
      expect(retainedSession.status).toBe(200);
      expect(retainedSession.headers.get("mcp-session-id")).toBeTruthy();
      const acquired = await requestLocalOwnerMaintenance({
        action: "acquire",
        journalPath,
        holderPid: oldHolder.pid!,
        monitorProxyPid: oldMonitor.transport.pid!,
        workspaceRoot,
      });
      expect(acquired.status).toBe("held");
      process.kill(oldHolder.pid!, "SIGKILL");
      await expect(requestLocalOwnerMaintenance({
        action: "recover",
        journalPath,
        holderPid: process.pid,
        workspaceRoot,
        leaseId: acquired.leaseId,
        leaseToken: acquired.leaseToken,
      })).rejects.toMatchObject({ code: "local_owner_maintenance_work_active" });

      process.kill(oldMonitor.transport.pid!, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const recovered = await requestLocalOwnerMaintenance({
        action: "recover",
        journalPath,
        holderPid: process.pid,
        workspaceRoot,
        leaseId: acquired.leaseId,
        leaseToken: acquired.leaseToken,
      });
      expect(recovered.status).toBe("recovered");
      const closing = await requestLocalOwnerMaintenance({
        action: "commit",
        journalPath,
        holderPid: process.pid,
        workspaceRoot,
        leaseId: recovered.leaseId,
        leaseToken: recovered.leaseToken,
      });
      expect(closing).toMatchObject({ status: "closing", leaseId: recovered.leaseId });
      await waitFor(() => !existsSync(ownerPath), "recovered owner shutdown");
      await waitFor(() => clearDeadLocalOwnerMaintenanceLease(journalPath, { holderPid: process.pid, workspaceRoot }), "recovered owner process exit");

      newMonitor = await connect(configPath);
      expect((await newMonitor.client.callTool({ name: "morrow_health", arguments: {} })).isError).not.toBe(true);
    } finally {
      if (oldHolder.pid) {
        try { process.kill(oldHolder.pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      for (const monitor of [oldMonitor, newMonitor]) {
        if (monitor?.transport.pid) {
          try { process.kill(monitor.transport.pid, "SIGKILL"); } catch { /* already stopped */ }
        }
      }
      await Promise.all([
        oldMonitor?.client.close().catch(() => undefined),
        oldMonitor?.transport.close().catch(() => undefined),
        newMonitor?.client.close().catch(() => undefined),
        newMonitor?.transport.close().catch(() => undefined),
      ]);
      try {
        const descriptor = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown };
        if (typeof descriptor.pid === "number") process.kill(descriptor.pid, "SIGKILL");
      } catch { /* owner already stopped */ }
      await rm(ownerPath, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it("routes only fixed, lease-bound private Bridge controls through the authenticated owner endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-local-owner-bridge-maintenance-"));
    const configPath = join(directory, "morrow.upstreams.json");
    const journalPath = join(directory, "gateway.sqlite3");
    const ownerPath = `${journalPath}.local-owner.json`;
    const root = resolve("../..");
    const port = await reserveLoopbackPort();
    const extensionId = "a".repeat(32);
    const canvasPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
    const browserDigest = bridgeCatalogDigestForTests(root);
    const token = "local-owner-bridge-maintenance-token-".repeat(3);
    const config = {
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      toolSurface: "full",
      sourcePolicy: { requireAttestation: false },
      upstreams: [{
        id: "browser-session", label: "Morrow browser connector", kind: "mcp-stdio",
        command: process.execPath, args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")], cwd: root,
        env: {
          MORROW_CANVAS_CATALOG_PATH: canvasPath,
          MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
          MORROW_CANVAS_CONNECTOR_PORT: String(port),
          MORROW_CANVAS_CONNECTOR_TOKEN: token,
          MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: extensionId,
        },
        sourceDisposition: "adapted_owned",
        outputPrivacy: {},
        outputPrivacyDefault: {
          allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 10_000,
          maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
        },
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: journalPath },
      privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
      maxCatalogTools: 2_000,
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    let monitor: ConnectedClient | null = null;
    let bridge: BridgeTestClient | undefined;
    const bridgeActions: string[] = [];
    try {
      monitor = await connect(configPath);
      await assertPortListening(port);
      bridge = await connectBridgeTestClient({
        port,
        token,
        extensionId,
        catalogDigest: browserDigest,
        bindings: [{
          sourceBindingId: "canvas:bridge-maintenance", provider: "canvas", origin: "https://school.instructure.com",
          courseId: "42", courseName: "Biology", principalFingerprint: "c".repeat(64), sessionGeneration: 1,
          catalogDigest: browserDigest, editPolicyRevision: 0, editOptionsAvailable: true, runtimeVerified: true,
        }],
      });
      bridge.onCommand((command) => {
        if (command.kind !== "bridge_maintenance") return;
        bridgeActions.push(command.maintenance.action);
        const activeFolderProof = {
          schema: "morrow.bridge.active-folder-proof.v1", extensionId, manifestVersion: "1.0.2",
          challengeId: "local-owner-bridge-challenge", nonce: "local-owner-bridge-nonce", challengeSha256: "d".repeat(64),
        };
        const result = command.maintenance.action === "status"
          ? {
            schema: "morrow.bridge.update-status.v1", extensionId, manifestVersion: "1.0.2", installType: "development", quiescent: false,
            activeFolderProof,
          }
          : command.maintenance.action === "quiesce"
            ? {
              schema: "morrow.bridge.update-quiesced.v1", extensionId, manifestVersion: "1.0.2", installType: "development", quiescent: true,
              quiesceEpoch: "local-owner-bridge-epoch", activeFolderProof,
            }
            : command.maintenance.action === "readback"
              ? {
                schema: "morrow.bridge.update-readback.v1", extensionId, manifestVersion: "1.0.2", installType: "development", activeFolderProof,
              }
              : {
                schema: "morrow.bridge.update-resumed.v1", extensionId, manifestVersion: "1.0.2",
                quiesceEpoch: command.maintenance.quiesceEpoch, resumed: true,
              };
        bridge?.respond(command, result);
      });
      const workspaceRoot = await realpath(process.cwd());
      const status = await requestLocalOwnerMaintenance({
        action: "bridge", journalPath, holderPid: process.pid, workspaceRoot, control: { action: "status" },
      });
      expect(status).toMatchObject({
        schema: "morrow.local-owner-maintenance.v1", status: "bridge",
        result: { schema: "morrow.bridge.update-status.v1", extensionId, installType: "development" },
      });
      const held = await requestLocalOwnerMaintenance({
        action: "acquire", journalPath, holderPid: process.pid, monitorProxyPid: monitor.transport.pid!, workspaceRoot,
      });
      expect(held.status).toBe("held");
      if (held.status !== "held") throw new Error("maintenance lease was not held");
      const bridgeLease = { journalPath, holderPid: process.pid, workspaceRoot, leaseId: held.leaseId, leaseToken: held.leaseToken };
      const quiesced = await requestLocalOwnerMaintenance({ action: "bridge", ...bridgeLease, control: { action: "quiesce" } });
      expect(quiesced).toMatchObject({
        status: "bridge", result: { schema: "morrow.bridge.update-quiesced.v1", quiesceEpoch: "local-owner-bridge-epoch" },
      });
      const readback = await requestLocalOwnerMaintenance({ action: "bridge", ...bridgeLease, control: { action: "readback" } });
      expect(readback).toMatchObject({ status: "bridge", result: { schema: "morrow.bridge.update-readback.v1", extensionId } });
      const resumed = await requestLocalOwnerMaintenance({
        action: "bridge", ...bridgeLease,
        control: { action: "resume", quiesceEpoch: "local-owner-bridge-epoch", fileLayerRestored: true },
      });
      expect(resumed).toMatchObject({ status: "bridge", result: { schema: "morrow.bridge.update-resumed.v1", resumed: true } });
      const released = await requestLocalOwnerMaintenance({ action: "release", ...bridgeLease });
      expect(released).toMatchObject({ status: "released", leaseId: held.leaseId });
      expect(bridgeActions).toEqual(["status", "quiesce", "readback", "resume"]);
      expect((await monitor.client.listTools()).tools.map((tool) => tool.name)).not.toContain("morrow_bridge_maintenance");
    } finally {
      await bridge?.close();
      if (monitor?.transport.pid) {
        try { process.kill(monitor.transport.pid, "SIGKILL"); } catch { /* already stopped */ }
      }
      await Promise.all([monitor?.client.close().catch(() => undefined), monitor?.transport.close().catch(() => undefined)]);
      try {
        const descriptor = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown };
        if (typeof descriptor.pid === "number") process.kill(descriptor.pid, "SIGKILL");
      } catch { /* owner already stopped */ }
      await rm(ownerPath, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
