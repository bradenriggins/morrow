import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { isJsonObject, sha256Json, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { GatewayRuntime } from "../src/runtime.js";
import { createMorrowServer } from "../src/server.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

/** Long enough that a second assistant can read the activity while it is held. */
const READ_DELAY_MS = 400;
const WRITE_DELAY_MS = 1_500;

function pagePrivacy(maxBytes: number) {
  return {
    allowedFields: ["source", "course_id", "large"],
    dataClass: "course",
    maxRecords: 10,
    maxBytes,
    freeText: "allow",
    learnerTokens: false,
    artifactInspection: "deny",
  };
}

function sharedRuntimeConfig() {
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
        env: {
          FAKE_SOURCE: "meridian",
          FAKE_DELAY_MS: String(READ_DELAY_MS),
          FAKE_LARGE_RESULT_CHARS: "70000",
        },
        priority: 100,
        required: true,
        enabled: true,
        outputPrivacy: { canvas_page_get: pagePrivacy(2_000_000) },
      },
      {
        id: "morrow-legacy",
        label: "Morrow legacy fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [fixturePath],
        env: { FAKE_SOURCE: "morrow-legacy", FAKE_DELAY_MS: String(WRITE_DELAY_MS) },
        priority: 50,
        required: true,
        enabled: true,
        outputPrivacy: {
          canvas_page_get: pagePrivacy(2_000_000),
          morrow_legacy_only: {
            allowedFields: ["source", "tool", "value", "operation_id"],
            dataClass: "course",
            maxRecords: 10,
            maxBytes: 2_000,
            freeText: "deny",
            learnerTokens: false,
            artifactInspection: "deny",
          },
        },
      },
    ],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 20,
  });
}

function publicSurfaceConfig() {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "meridian",
      label: "ExamplePlatform fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_SOURCE: "meridian" },
      priority: 100,
      required: true,
      enabled: true,
      outputPrivacy: { canvas_page_get: pagePrivacy(10_000) },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 20,
  });
}

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>((done) => listener.close(() => done()));
  return address.port;
}

function connectorConfig(directory: string, port: number, token: string, extensionId: string) {
  const root = resolve("../..");
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "full",
    upstreams: [{
      id: "browser-session",
      label: "Morrow browser connector",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")],
      cwd: root,
      env: {
        MORROW_CANVAS_CATALOG_PATH: resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"),
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: token,
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: extensionId,
      },
      sourceDisposition: "adapted_owned",
      outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 10_000,
        maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny",
        aiClientAdmission: "allow",
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(directory, "gateway.sqlite3") },
    privacy: {
      canvasOrigin: "browser-session", account: "local", principal: "local",
      learnerVaultPath: join(directory, "vault.json"),
    },
    maxCatalogTools: 2_000,
  });
}

interface ConnectedAssistant {
  readonly client: Client;
  readonly server: McpServer;
}

async function openAssistant(
  runtime: MorrowRuntime,
  input: {
    readonly clientName: string;
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly proxyPid: number;
  },
): Promise<ConnectedAssistant> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // One server, one admitted project and one session for each assistant, as the
  // local owner gives them.
  serverTransport.sessionId = input.sessionId;
  const server = createFullMorrowServer(runtime, {
    workspaceRoot: input.workspaceRoot,
    proxyPid: input.proxyPid,
  });
  await server.connect(serverTransport);
  const client = new Client({ name: input.clientName, version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

async function closeAssistant(assistant: ConnectedAssistant | undefined): Promise<void> {
  await assistant?.client.close();
  await assistant?.server.close();
}

function structured(result: { readonly structuredContent?: unknown; readonly isError?: boolean }): JsonObject {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  if (!isJsonObject(result.structuredContent)) throw new Error("expected a structured MCP result");
  return result.structuredContent;
}

function section(report: JsonObject, name: string): JsonObject {
  const value = report[name];
  if (!isJsonObject(value)) throw new Error(`activity report has no ${name} section`);
  return value;
}

function rows(value: unknown): readonly JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

async function activityFrom(client: Client): Promise<JsonObject> {
  return structured(await client.callTool({ name: "morrow_activity", arguments: {} }));
}

async function waitForActivity(
  client: Client,
  predicate: (report: JsonObject) => boolean,
  detail: string,
): Promise<JsonObject> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const report = await activityFrom(client);
    if (predicate(report)) return report;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readBatchInput(name: string, courseIds: readonly string[]) {
  return {
    name,
    mode: "read_only",
    concurrency: 1,
    operation_family: "activity-proof",
    operations: courseIds.map((courseId) => ({
      child_id: `course:${courseId}`,
      course_id: courseId,
      tool: "canvas_page_get",
      arguments: { course_id: courseId },
    })),
    course_set: {
      source: "explicit",
      course_ids: [...courseIds],
      complete: true,
      pagination_complete: true,
      snapshot_digest: sha256Json({ schema: "morrow.activity.selection.v1", courseIds }),
    },
    profile_digest: sha256Json({ schema: "morrow.activity.profile.v1", name }),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

function runInput(batchId: string, created: JsonObject, maxChildren: number) {
  const manifest = created.manifest;
  if (!isJsonObject(manifest) || !isJsonObject(manifest.courseSet) || typeof manifest.courseSet.digest !== "string"
    || typeof manifest.profileDigest !== "string") {
    throw new Error("the frozen batch manifest did not name its course set and profile");
  }
  return {
    batch_id: batchId,
    max_children: maxChildren,
    course_set_digest: manifest.courseSet.digest,
    profile_digest: manifest.profileDigest,
  };
}

describe("morrow_activity", () => {
  it("tells a second assistant who is connected, what runs, which targets are locked, and what needs a person", async () => {
    const projectA = "/morrow-activity-test/project-a";
    const projectB = "/morrow-activity-test/project-b";
    let runtime: MorrowRuntime | undefined;
    let first: ConnectedAssistant | undefined;
    let second: ConnectedAssistant | undefined;
    try {
      runtime = await MorrowRuntime.connect(sharedRuntimeConfig());
      first = await openAssistant(runtime, {
        clientName: "assistant-a", sessionId: "session-a", workspaceRoot: projectA, proxyPid: 41_001,
      });
      second = await openAssistant(runtime, {
        clientName: "assistant-b", sessionId: "session-b", workspaceRoot: projectB, proxyPid: 41_002,
      });

      // 1. Both assistants are visible to each other, by the name each reported,
      //    and neither project path leaves the owner.
      const idle = await activityFrom(second.client);
      expect(idle.schema).toBe("morrow.activity.v1");
      const assistants = section(idle, "assistants");
      expect(assistants).toMatchObject({ connected: 2, namesAreSelfReported: true });
      expect(rows(assistants.sessions).map((entry) => isJsonObject(entry.requestedBy) ? entry.requestedBy.clientName : null).sort())
        .toEqual(["assistant-a", "assistant-b"]);
      expect(rows(assistants.sessions).map((entry) => entry.sessionId).sort()).toEqual(["session-a", "session-b"]);
      expect(JSON.stringify(idle)).not.toContain(projectA);
      expect(JSON.stringify(idle)).not.toContain(projectB);
      expect(section(idle, "groups")).toMatchObject({ known: true, running: [], queued: [] });
      expect(section(idle, "lockedTargets")).toMatchObject({ count: 0, coverageComplete: true });
      expect(section(idle, "needsPerson")).toMatchObject({ count: 0 });
      // No browser connector is configured here, so the Bridge state is known
      // and reports exactly that.
      expect(section(idle, "bridge")).toMatchObject({
        known: true, connected: false, reason: "not_configured", catalogDigestMatches: null, anchorSites: [],
      });

      // 2. A group assistant A started, seen by assistant B with its progress.
      const created = structured(await first.client.callTool({
        name: "morrow_batch_create",
        arguments: readBatchInput("Read four courses", ["101", "102", "103", "104"]),
      }));
      const batch = created.batch;
      if (!isJsonObject(batch) || typeof batch.batchId !== "string") throw new Error("no batch id");
      const batchId = batch.batchId;
      expect(structured(await first.client.callTool({
        name: "morrow_batch_run",
        arguments: runInput(batchId, created, 1),
      })).processed).toBe(1);

      const partial = await activityFrom(second.client);
      const paused = rows(section(partial, "groups").running);
      expect(paused).toHaveLength(1);
      expect(paused[0]).toMatchObject({
        batchId,
        name: "Read four courses",
        mode: "read_only",
        state: "running",
        windowHeld: false,
        holder: null,
        children: { total: 4, done: 1, uncertain: 0, pending: 3 },
      });
      expect(paused[0]!.requestedBy).toMatchObject({ clientName: "assistant-a", workspaceName: "project-a" });

      // 3. While assistant A holds the batch window, assistant B is told which
      //    session holds it instead of guessing.
      const running = first.client.callTool({
        name: "morrow_batch_run",
        arguments: runInput(batchId, created, 3),
      });
      const held = await waitForActivity(
        second.client,
        (report) => rows(section(report, "groups").running).some((entry) => entry.windowHeld === true),
        "assistant A to hold the batch window",
      );
      const holder = rows(section(held, "groups").running)[0]!;
      expect(holder.batchId).toBe(batchId);
      expect(String(holder.holder)).toContain("assistant-a");
      expect(String(holder.holder)).toContain("session-a");
      const heldSessions = rows(section(held, "assistants").sessions);
      expect(heldSessions.filter((entry) => entry.holdsBatchWindow === true)).toHaveLength(1);
      expect(heldSessions.find((entry) => entry.holdsBatchWindow === true)?.sessionId).toBe("session-a");
      expect(heldSessions.find((entry) => entry.sessionId === "session-b")?.holdsBatchWindow).toBe(false);
      expect(structured(await running).processed).toBe(3);

      // 4. A change assistant A sends locks its course item while it is in
      //    flight. Morrow is still working, so no person is needed yet.
      const planned = structured(await first.client.callTool({
        name: "morrow_capability_change",
        arguments: {
          name: "morrow_legacy_only",
          arguments: {
            value: "activity-write",
            course_id: "77",
            page_id: "page-77",
            _morrow: {
              readback: {
                tool: "canvas_page_get",
                arguments: { course_id: "77" },
                // A comparator the fresh read cannot match, so the record stays
                // unresolved and a person has to check the item.
                expected_digest: "a".repeat(64),
              },
            },
          },
        },
      }));
      const operationId = String(planned.operationId);
      expect(operationId).toMatch(/^op:/);
      runtime.gateway.approveOperation(operationId);
      const dispatch = first.client.callTool({
        name: "morrow_operation_dispatch",
        arguments: { operation_id: operationId },
      });
      const sending = await waitForActivity(
        second.client,
        (report) => rows(section(report, "lockedTargets").targets).some((entry) => entry.state === "dispatching"),
        "assistant A's change to hold its course item",
      );
      expect(rows(section(sending, "lockedTargets").targets)[0]).toMatchObject({
        operationId,
        tool: "morrow_legacy_only",
        courseId: "77",
        state: "dispatching",
      });
      expect(section(sending, "needsPerson")).toMatchObject({ count: 0 });
      await dispatch;

      // 5. The change settles unresolved, so it keeps the lock and now needs a
      //    person. Assistant B is told both, and who asked for it.
      const unresolved = await activityFrom(second.client);
      expect(section(unresolved, "lockedTargets")).toMatchObject({ count: 1 });
      expect(rows(section(unresolved, "needsPerson").operations)).toHaveLength(1);
      const needsPerson = rows(section(unresolved, "needsPerson").operations)[0]!;
      expect(needsPerson).toMatchObject({
        operationId,
        tool: "morrow_legacy_only",
        courseId: "77",
        state: "awaiting_verification",
        attention: ["readback_did_not_match_frozen_comparator"],
      });
      expect(needsPerson.requestedBy).toMatchObject({ clientName: "assistant-a", workspaceName: "project-a" });
      expect(typeof needsPerson.targetDigest).toBe("string");
      expect(JSON.stringify(unresolved)).not.toContain(projectA);

      // 6. Assistant B sees all of assistant A's activity, and none of its
      //    saved result artifacts.
      const large = structured(await first.client.callTool({
        name: "morrow_capability_read",
        arguments: { name: "canvas_page_get", arguments: { course_id: "101" } },
      }));
      const artifact = isJsonObject(large.data) ? large.data : {};
      expect(artifact.schema).toBe("morrow.result-artifact.v1");
      const handle = String(artifact.handle);
      expect(handle).toMatch(/^result:/);
      const mine = await first.client.callTool({ name: "morrow_result_page", arguments: { handle, limit: 16 } });
      expect(mine.isError).not.toBe(true);
      const stolen = await second.client.callTool({ name: "morrow_result_page", arguments: { handle, limit: 16 } });
      expect(stolen.isError).toBe(true);
      expect(stolen.structuredContent).toMatchObject({ code: "result_artifact_unavailable" });

      // 7. Closing one assistant leaves the other, and the saved work stays.
      await closeAssistant(first);
      first = undefined;
      const alone = await waitForActivity(
        second.client,
        (report) => section(report, "assistants").connected === 1,
        "assistant A to leave",
      );
      expect(rows(section(alone, "assistants").sessions)[0]).toMatchObject({ sessionId: "session-b" });
      expect(section(alone, "lockedTargets")).toMatchObject({ count: 1 });
      expect(rows(section(alone, "groups").running)).toHaveLength(0);
    } finally {
      await closeAssistant(first);
      await closeAssistant(second);
      await runtime?.close();
    }
  }, 120_000);

  it("names the Bridge state and every connected site an assistant would have to share", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-activity-bridge-"));
    const port = await availablePort();
    const token = "synthetic-activity-bridge-token-".repeat(3);
    const extensionId = "a".repeat(32);
    const catalogDigest = bridgeCatalogDigestForTests(resolve("../.."));
    let runtime: MorrowRuntime | undefined;
    let bridge: BridgeTestClient | undefined;
    let assistant: ConnectedAssistant | undefined;
    try {
      runtime = await MorrowRuntime.connect(connectorConfig(directory, port, token, extensionId));
      bridge = await connectBridgeTestClient({
        port,
        token,
        extensionId,
        catalogDigest,
        bindings: [
          {
            sourceBindingId: "canvas:activity-2", provider: "canvas", origin: "https://canvas.example.edu",
            siteUrl: "https://canvas.example.edu/", courseId: "2", principalFingerprint: "d".repeat(64),
            sessionGeneration: 1, catalogDigest, editPolicyRevision: 0, runtimeVerified: true,
          },
          {
            sourceBindingId: "canvas:activity-3", provider: "canvas", origin: "https://canvas.example.edu",
            siteUrl: "https://canvas.example.edu/", courseId: "3", principalFingerprint: "d".repeat(64),
            sessionGeneration: 1, catalogDigest, editPolicyRevision: 0, runtimeVerified: true,
          },
          {
            sourceBindingId: "moodle:activity-9", provider: "moodle", origin: "https://moodle.example.edu",
            siteUrl: "https://moodle.example.edu/", courseId: "9", principalFingerprint: "e".repeat(64),
            sessionGeneration: 1, catalogDigest, editPolicyRevision: 0, runtimeVerified: false,
          },
        ],
      });
      const browserCommands: string[] = [];
      bridge.onCommand((command) => browserCommands.push(command.kind));
      assistant = await openAssistant(runtime, {
        clientName: "assistant-bridge", sessionId: "session-bridge",
        workspaceRoot: "/morrow-activity-test/project-bridge", proxyPid: 41_003,
      });

      const report = await activityFrom(assistant.client);
      const bridgeState = section(report, "bridge");
      expect(bridgeState).toMatchObject({
        known: true,
        connected: true,
        extensionId,
        catalogDigest,
        // The Bridge refuses any extension whose catalog digest differs, so a
        // connected extension has already matched this Morrow's catalog.
        catalogDigestMatches: true,
        anchorSitesKnown: true,
      });
      expect(Number(bridgeState.generation)).toBeGreaterThanOrEqual(1);
      const sites = rows(bridgeState.anchorSites);
      expect(sites).toHaveLength(2);
      expect(sites.find((site) => site.provider === "canvas")).toMatchObject({
        origin: "https://canvas.example.edu",
        courseConnections: 2,
        verifiedCourseConnections: 2,
        verified: true,
      });
      // A site whose connection is not verified in the browser is named, and is
      // not reported as verified.
      expect(sites.find((site) => site.provider === "moodle")).toMatchObject({
        origin: "https://moodle.example.edu",
        courseConnections: 1,
        verifiedCourseConnections: 0,
        verified: false,
      });
      // Reading the Bridge state sends no browser command, so nothing reaches a
      // learning platform.
      expect(browserCommands).toEqual([]);
    } finally {
      await closeAssistant(assistant);
      await bridge?.close().catch(() => undefined);
      await runtime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("answers on the public tool surface and says plainly what that profile does not have", async () => {
    let runtime: GatewayRuntime | undefined;
    let client: Client | undefined;
    let server: McpServer | undefined;
    try {
      runtime = await GatewayRuntime.connect(publicSurfaceConfig(), { journalPath: ":memory:" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      serverTransport.sessionId = "session-public";
      server = createMorrowServer(runtime);
      await server.connect(serverTransport);
      client = new Client({ name: "assistant-public", version: "1.0.0" });
      await client.connect(clientTransport);

      const listed = (await client.listTools()).tools;
      expect(listed.map((tool) => tool.name)).toContain("morrow_activity");
      expect(listed.find((tool) => tool.name === "morrow_activity")?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });

      const report = await activityFrom(client);
      expect(report).toMatchObject({
        schema: "morrow.activity.v1",
        // This surface has no group tools and no Bridge component, and says so
        // rather than reporting an idle scheduler or a disconnected Bridge.
        groups: { known: false, reason: "group_tools_unavailable_in_this_profile" },
        bridge: { known: false, reason: "bridge_status_unavailable" },
        lockedTargets: { count: 0 },
        needsPerson: { count: 0 },
      });
      const sessions = rows(section(report, "assistants").sessions);
      expect(section(report, "assistants").connected).toBe(1);
      // This connection was admitted with no project, so Morrow has no reported
      // identity for it and says so rather than inventing one.
      expect(sessions[0]).toMatchObject({
        sessionId: "session-public",
        requestedBy: null,
        holdsBatchWindow: false,
        waitingForBatchWindow: false,
      });
    } finally {
      await client?.close();
      await server?.close();
      await runtime?.close();
    }
  }, 60_000);
});
