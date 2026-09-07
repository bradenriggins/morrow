import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BridgeBinding, BridgeCommand } from "@morrow/bridge-protocol";
import { isJsonObject, sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";

/**
 * Two assistants, two projects, one Morrow.
 *
 * Every case here runs through the real local owner: two separate `morrow-mcp`
 * child processes attach over stdio, each from its own working directory and
 * under its own reported client name, and both are served by one owner process
 * that holds the durable state and the one Bridge connection. Nothing in this
 * file reaches into the runtime object; each proof is an MCP tool call, exactly
 * as an assistant would make it.
 *
 * What this file does not prove: real Chrome, a real Canvas or Moodle site, and
 * two real assistant applications. The Bridge here is a fixture that answers the
 * commands the extension would answer, so those three remain live-unverified.
 */

const ENTRY_PATH = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const EXTENSION_ID = "a".repeat(32);
const CONNECTOR_TOKEN = "multi-client-connector-token-".repeat(3);
const COURSE_ID = "42";
const SLOW_COURSE_ID = "77";
const COURSE_BINDING = `canvas:multi-client:${COURSE_ID}`;
const SLOW_BINDING = `canvas:multi-client:${SLOW_COURSE_ID}`;
const EDIT_SCOPE_DIGEST = "d".repeat(64);
const PRINCIPAL_FINGERPRINT = "c".repeat(64);

/** Answers a Bridge command only after this many milliseconds, while a hold is open. */
let slowCommandMs = 5_000;
/** Epoch milliseconds until which slow-course commands are held. 0 answers at once. */
let holdUntilMs = 0;
/** One page read the fixture holds open, so a cancel can land on a running child. */
let heldChildTarget = "";
let releaseHeldChild: (() => void) | null = null;
/** How the fixture ends the next Canvas write. */
let nextWriteOutcome: "saved" | "unknown_result" | "no_result" = "saved";

interface FixturePage {
  page_id: string;
  url: string;
  title: string;
  body: string;
  published: boolean;
  front_page: boolean;
  editing_roles: string;
  publish_at: null;
}

const pages = new Map<string, FixturePage>();
let commandLog: BridgeCommand[] = [];
let writeCommands = 0;
let nextPageId = 500;

function makePage(pageId: string, url: string, body: string): FixturePage {
  return {
    page_id: pageId,
    url,
    title: `Page ${url}`,
    body,
    published: true,
    front_page: false,
    editing_roles: "teachers",
    publish_at: null,
  };
}

function resetFixturePages(): void {
  pages.clear();
  nextPageId = 500;
  // One page large enough that Morrow stores it as a local artifact instead of
  // returning it inline.
  pages.set("lesson-artifact", makePage("91", "lesson-artifact", `<p>${"Cell structure and function. ".repeat(3_000)}</p>`));
  const numbered = ["lesson-conflict", "lesson-identity-a", "lesson-identity-b", "lesson-unanswered"];
  for (const [index, url] of numbered.entries()) {
    pages.set(url, makePage(String(92 + index), url, "<p>Cells have membranes.</p>"));
  }
}

function pageFor(url: string): FixturePage {
  const held = pages.get(url);
  if (held) return held;
  nextPageId += 1;
  const created = makePage(String(nextPageId), url, `<p>${url} content.</p>`);
  pages.set(url, created);
  return created;
}

function editPermission() {
  return {
    schema: "morrow.bridge.edit-permission.v1" as const,
    revision: 1,
    scopeDigest: EDIT_SCOPE_DIGEST,
    catalogDigest: bridgeCatalogDigestForTests(resolve("../..")),
    sourceBindingId: COURSE_BINDING,
    enabledCategories: ["canvas_page_content"],
    rules: [{
      operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses",
      toolName: "canvas_update_create_page_courses",
      allowedChangedFields: [],
      requiresCanvasContentGuard: true,
      canvasContentGuardKind: "page_text",
    }],
  };
}

function bindings(catalogDigest: string): readonly BridgeBinding[] {
  const permission = editPermission();
  return [
    {
      sourceBindingId: COURSE_BINDING,
      provider: "canvas" as const,
      origin: "https://school.instructure.com",
      courseId: COURSE_ID,
      courseName: "Biology",
      principalFingerprint: PRINCIPAL_FINGERPRINT,
      sessionGeneration: 1,
      catalogDigest,
      editPolicyRevision: permission.revision,
      editOptionsAvailable: true as const,
      editPermission: {
        schema: permission.schema,
        revision: permission.revision,
        scopeDigest: permission.scopeDigest,
        catalogDigest: permission.catalogDigest,
        sourceBindingId: permission.sourceBindingId,
      },
      runtimeVerified: true,
    },
    {
      sourceBindingId: SLOW_BINDING,
      provider: "canvas" as const,
      origin: "https://school.instructure.com",
      courseId: SLOW_COURSE_ID,
      courseName: "Chemistry",
      principalFingerprint: PRINCIPAL_FINGERPRINT,
      sessionGeneration: 1,
      catalogDigest,
      editPolicyRevision: 0,
      editOptionsAvailable: true as const,
      runtimeVerified: true,
    },
  ];
}

/** A Bridge command carries no arguments for some kinds, such as an options read. */
function commandArguments(command: BridgeCommand): JsonObject {
  return isJsonObject(command.arguments) ? command.arguments : {};
}

/** The page a command names, or "" when it names none. */
function commandTarget(command: BridgeCommand): string {
  const value = commandArguments(command).url_or_id;
  return typeof value === "string" ? value : "";
}

function commandDelayMs(command: BridgeCommand): number {
  const args = commandArguments(command);
  const courseId = String(args.course_id ?? args.id ?? "");
  return courseId === SLOW_COURSE_ID && Date.now() < holdUntilMs ? slowCommandMs : 0;
}

function readResult(command: BridgeCommand): JsonObject {
  if (command.toolName === "canvas_list_users_in_course_users") {
    // Every Canvas read establishes its learner privacy boundary from the
    // roster before Morrow returns anything.
    return {
      schema: "morrow.canvas-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data: [{ id: "9001", name: "Jane Doe", email: "jane.doe@example.edu", login_id: "jdoe" }],
    };
  }
  if (command.toolName === "canvas_show_page_courses") {
    const page = pageFor(commandTarget(command));
    return {
      schema: "morrow.canvas-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      pageBodySha256: sha256Text(page.body),
      data: { ...page },
    };
  }
  if (command.toolName === "canvas_show_revision_courses_latest") {
    const page = pageFor(commandTarget(command));
    return {
      schema: "morrow.canvas-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data: { revision_id: "1", latest: true, url: page.url, title: page.title, body: page.body },
    };
  }
  return {
    schema: "morrow.canvas-browser-result.v1",
    ok: true,
    sent: true,
    status: 200,
    truncated: false,
    data: {
      id: String(commandArguments(command).course_id ?? commandArguments(command).id ?? COURSE_ID),
      name: String(commandArguments(command).id ?? "") === SLOW_COURSE_ID ? "Chemistry" : "Biology",
    },
  };
}

/**
 * Opens the fixture Bridge and answers what the extension answers. The Bridge is
 * the shared, single-connection resource in this proof: both assistants use it
 * through the one owner.
 */
async function connectFixtureBridge(port: number): Promise<BridgeTestClient> {
  const catalogDigest = bridgeCatalogDigestForTests(resolve("../.."));
  const bridge = await connectBridgeTestClient({
    port,
    token: CONNECTOR_TOKEN,
    extensionId: EXTENSION_ID,
    catalogDigest,
    bindings: bindings(catalogDigest),
  });
  bridge.onCommand((command) => {
    commandLog.push(command);
    if (command.kind === "edit_policy_options_get") {
      bridge.respond(command, {
        schema: "morrow.bridge.edit-options.v1",
        sourceBindingId: command.sourceBindingId,
        provider: "canvas",
        catalogDigest,
        policyRevision: command.sourceBindingId === COURSE_BINDING ? 1 : 0,
        runtimeVerified: true,
        options: [],
        ...(command.sourceBindingId === COURSE_BINDING ? { editPermission: editPermission() } : {}),
      });
      return;
    }
    if (command.kind === "invoke_write") {
      writeCommands += 1;
      const outcome = nextWriteOutcome;
      nextWriteOutcome = "saved";
      if (outcome === "no_result") {
        // The extension disappears with the command in flight, so no ending ever
        // arrives for this write.
        bridge.socket.close();
        return;
      }
      if (outcome === "unknown_result") {
        bridge.respondProblem(command, {
          schema: "morrow.bridge.problem.v1",
          code: "write_outcome_unknown",
          message: "Canvas did not answer this change, so it may have been saved.",
          recoverable: false,
        });
        return;
      }
      const forwarded = commandArguments(command);
      const guard = isJsonObject(forwarded._morrow) ? forwarded._morrow.canvas_content_guard : undefined;
      if (isJsonObject(guard) && typeof guard.replace_text === "string" && typeof guard.find_text === "string") {
        const page = pageFor(commandTarget(command));
        page.body = page.body.replace(guard.find_text, guard.replace_text);
      }
      bridge.respond(command, {
        schema: "morrow.canvas-browser-result.v1",
        ok: true,
        sent: true,
        status: 200,
        truncated: false,
        data: { ...pageFor(commandTarget(command)) },
        verification: {
          schema: "morrow.browser-verification.v1",
          status: "verified",
          strategy: "page-text",
          readTool: "canvas_show_page_courses",
          evidence: "fresh_readback_matches_requested_postcondition",
        },
      });
      return;
    }
    const response = readResult(command);
    if (heldChildTarget && commandTarget(command) === heldChildTarget) {
      // This child stays in flight until the test lets it finish.
      releaseHeldChild = () => bridge.respond(command, response);
      return;
    }
    const delay = commandDelayMs(command);
    if (delay <= 0) {
      bridge.respond(command, response);
      return;
    }
    const timer = setTimeout(() => bridge.respond(command, response), delay);
    timer.unref?.();
  });
  return bridge;
}

interface ConnectedClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

/** Attaches one stdio proxy from one project directory under one reported name. */
async function connect(configPath: string, cwd: string, clientName: string): Promise<ConnectedClient> {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY_PATH],
    env: { ...getDefaultEnvironment(), MORROW_UPSTREAMS_FILE: configPath },
    stderr: "pipe",
    cwd,
  });
  await client.connect(transport);
  return { client, transport };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, detail: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${detail}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

type ToolResult = { readonly structuredContent?: unknown; readonly content?: unknown; readonly isError?: boolean };

function structured(result: ToolResult): JsonObject {
  return isJsonObject(result.structuredContent) ? result.structuredContent : {};
}

/** Asserts the call succeeded and returns its structured result. */
function ok(result: ToolResult): JsonObject {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return structured(result);
}

function text(result: ToolResult): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content.map((entry) => (isJsonObject(entry) && typeof entry.text === "string" ? entry.text : "")).join("\n");
}

/** Finds one large-result handle anywhere in a result, as an assistant would read it. */
function artifactHandle(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = artifactHandle(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  if (value.schema === "morrow.result-artifact.v1" && typeof value.handle === "string") return value.handle;
  for (const entry of Object.values(value)) {
    const found = artifactHandle(entry);
    if (found) return found;
  }
  return undefined;
}

/** The requesting-assistant identity a saved operation or group carries. */
function requestedBy(value: unknown): JsonObject | undefined {
  if (!isJsonObject(value)) return undefined;
  if (isJsonObject(value.requestedBy)) return value.requestedBy;
  return isJsonObject(value.plan) ? requestedBy(value.plan) : undefined;
}

let directory = "";
let projectA = "";
let projectB = "";
let projectARoot = "";
let projectBRoot = "";
let configPath = "";
let journalPath = "";
let ownerPath = "";
let connectorPort = 0;
let assistantA: ConnectedClient | null = null;
let assistantB: ConnectedClient | null = null;
let bridge: BridgeTestClient | undefined;

async function startOwnerAndClients(): Promise<void> {
  assistantA = await connect(configPath, projectA, "assistant-a");
  await waitFor(() => existsSync(ownerPath), "the local owner descriptor");
  assistantB = await connect(configPath, projectB, "assistant-b");
  bridge = await connectFixtureBridge(connectorPort);
}

async function stopClients(): Promise<void> {
  const clients = [assistantA, assistantB];
  assistantA = null;
  assistantB = null;
  await Promise.all(clients.map((entry) => entry?.client.close().catch(() => undefined)));
  await Promise.all(clients.map((entry) => entry?.transport.close().catch(() => undefined)));
}

function clientA(): Client {
  if (!assistantA) throw new Error("assistant A is not connected");
  return assistantA.client;
}

function clientB(): Client {
  if (!assistantB) throw new Error("assistant B is not connected");
  return assistantB.client;
}

/** Creates one read-only group, and returns both its id and the input its run needs. */
async function createReadBatch(
  client: Client,
  name: string,
  concurrency: number,
  operations: readonly JsonObject[],
): Promise<{ readonly batchId: string; readonly runInput: JsonObject }> {
  // The frozen course set names each selected course once, however many
  // children a course carries.
  const courseIds = [...new Set(operations.map((operation) => String(operation.course_id)))];
  const created = ok(await client.callTool({
    name: "morrow_batch_create",
    arguments: {
      name,
      mode: "read_only",
      concurrency,
      operation_family: "morrow-multi-client-proof",
      operations,
      course_set: {
        source: "explicit",
        course_ids: courseIds,
        complete: true,
        pagination_complete: true,
        snapshot_digest: sha256Json({ schema: "morrow.multi-client.selection.v1", name, courseIds }),
      },
      profile_digest: sha256Json({ schema: "morrow.multi-client.profile.v1", name }),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
  }, { timeout: 60_000 }));
  const batch = created.batch;
  const manifest = created.manifest;
  if (!isJsonObject(batch) || typeof batch.batchId !== "string") throw new Error("group creation returned no id");
  if (!isJsonObject(manifest) || !isJsonObject(manifest.courseSet) || typeof manifest.courseSet.digest !== "string") {
    throw new Error("group creation returned no course-set digest");
  }
  return {
    batchId: batch.batchId,
    runInput: {
      batch_id: batch.batchId,
      max_children: operations.length,
      course_set_digest: manifest.courseSet.digest,
      profile_digest: String(manifest.profileDigest ?? ""),
    },
  };
}

function slowCourseChild(index: number): JsonObject {
  return {
    child_id: `slow-${index}`,
    course_id: SLOW_COURSE_ID,
    tool: "canvas_get_single_course_courses",
    source_binding_id: SLOW_BINDING,
    arguments: { id: SLOW_COURSE_ID },
  };
}

function cancelChild(index: number): JsonObject {
  return {
    child_id: `cancel-${index}`,
    course_id: COURSE_ID,
    tool: "canvas_show_page_courses",
    source_binding_id: COURSE_BINDING,
    arguments: { course_id: COURSE_ID, url_or_id: `cancel-${index}` },
  };
}

async function schedulerHealth(client: Client): Promise<JsonObject> {
  const health = ok(await client.callTool({ name: "morrow_batch_health", arguments: {} }, { timeout: 30_000 }));
  return isJsonObject(health.scheduler) ? health.scheduler : {};
}

async function planPageCorrection(
  client: Client,
  pageUrl: string,
  findText: string,
  replaceText: string,
): Promise<string> {
  const planned = ok(await client.callTool({
    name: "morrow_plan_page_correction",
    arguments: {
      source_binding_id: COURSE_BINDING,
      course_id: COURSE_ID,
      page_url: pageUrl,
      find_text: findText,
      replace_text: replaceText,
    },
  }, { timeout: 60_000 }));
  const operationId = planned.operationId;
  if (typeof operationId !== "string") throw new Error("page change plan returned no operation id");
  return operationId;
}

async function operationRecord(client: Client, operationId: string): Promise<JsonObject> {
  return ok(await client.callTool({
    name: "morrow_operation_get",
    arguments: { operation_id: operationId },
  }, { timeout: 30_000 }));
}

/** Kept across cases so the restart case can prove the same records survive. */
let uncertainOperationId = "";
let cancelledBatchId = "";
let cancelledRunInput: JsonObject = {};
let cancelledBatchCounts: JsonObject = {};

describe("two assistants through one local Morrow owner", () => {
  beforeAll(async () => {
    resetFixturePages();
    directory = await mkdtemp(join(tmpdir(), "morrow-multi-client-"));
    projectA = join(directory, "project-a");
    projectB = join(directory, "project-b");
    await mkdir(projectA);
    await mkdir(projectB);
    projectARoot = await realpath(projectA);
    projectBRoot = await realpath(projectB);
    configPath = join(directory, "morrow.upstreams.json");
    journalPath = join(directory, "gateway.sqlite3");
    ownerPath = `${journalPath}.local-owner.json`;
    connectorPort = await availablePort();
    const root = resolve("../..");
    await writeFile(configPath, `${JSON.stringify({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      toolSurface: "full",
      sourcePolicy: { requireAttestation: false },
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
          MORROW_CANVAS_CONNECTOR_PORT: String(connectorPort),
          MORROW_CANVAS_CONNECTOR_TOKEN: CONNECTOR_TOKEN,
          MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID,
        },
        sourceDisposition: "adapted_owned",
        outputPrivacy: {},
        outputPrivacyDefault: {
          allowedFields: [],
          fieldPolicy: "scrub-sensitive",
          dataClass: "course",
          maxRecords: 10_000,
          maxBytes: 2_000_000,
          freeText: "allow",
          learnerTokens: true,
          artifactInspection: "deny",
          aiClientAdmission: "allow",
        },
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: journalPath },
      privacy: {
        canvasOrigin: "browser-session",
        account: "local",
        principal: "local",
        learnerVaultPath: join(directory, "learner-vault.json"),
      },
      batchScheduler: { maxConcurrentReadWindows: 2 },
      maxCatalogTools: 2_000,
    }, null, 2)}\n`, "utf8");
    await startOwnerAndClients();
  }, 120_000);

  afterAll(async () => {
    await bridge?.close().catch(() => undefined);
    await stopClients();
    try {
      const descriptor = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown };
      if (typeof descriptor.pid === "number") process.kill(descriptor.pid, "SIGKILL");
    } catch { /* the owner already stopped */ }
    await rm(directory, { recursive: true, force: true });
  }, 60_000);

  it("1 · shows both assistants the same course connections and the same saved groups", async () => {
    const [first, second] = await Promise.all([
      clientA().callTool({ name: "morrow_browser_bindings", arguments: {} }, { timeout: 30_000 }),
      clientB().callTool({ name: "morrow_browser_bindings", arguments: {} }, { timeout: 30_000 }),
    ]);
    const firstBindings = ok(first).data;
    const secondBindings = ok(second).data;
    expect(JSON.stringify(secondBindings)).toBe(JSON.stringify(firstBindings));
    expect(JSON.stringify(firstBindings)).toContain(COURSE_BINDING);
    expect(JSON.stringify(firstBindings)).toContain(SLOW_BINDING);

    const fromA = await createReadBatch(clientA(), "Assistant A shared listing", 1, [slowCourseChild(0)]);
    const fromB = await createReadBatch(clientB(), "Assistant B shared listing", 1, [slowCourseChild(1)]);
    const [recentToA, recentToB] = await Promise.all([
      clientA().callTool({ name: "morrow_batches_recent", arguments: { limit: 50 } }, { timeout: 30_000 }),
      clientB().callTool({ name: "morrow_batches_recent", arguments: { limit: 50 } }, { timeout: 30_000 }),
    ]);
    const listedToA = JSON.stringify(ok(recentToA));
    const listedToB = JSON.stringify(ok(recentToB));
    for (const listing of [listedToA, listedToB]) {
      expect(listing).toContain(fromA.batchId);
      expect(listing).toContain(fromB.batchId);
    }
    // Each assistant can open the group the other one saved.
    expect(ok(await clientB().callTool({
      name: "morrow_batch_get",
      arguments: { batch_id: fromA.batchId },
    }, { timeout: 30_000 })).batch).toMatchObject({ batchId: fromA.batchId });
  }, 90_000);

  it("2 · keeps a large saved result with the assistant that asked for it", async () => {
    const large = await clientA().callTool({
      name: "canvas_show_page_courses",
      arguments: { course_id: COURSE_ID, url_or_id: "lesson-artifact", _morrow: { source_binding_id: COURSE_BINDING } },
    }, { timeout: 60_000 });
    const handle = artifactHandle(ok(large));
    expect(handle, JSON.stringify(large).slice(0, 400)).toMatch(/^result:/);

    const refused = await clientB().callTool({
      name: "morrow_result_page",
      arguments: { handle, limit: 1_000 },
    }, { timeout: 30_000 });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      schema: "morrow.problem.v1",
      code: "result_artifact_unavailable",
    });

    // The same handle still works for the assistant that created it, so the
    // refusal above is about who is asking, not a result that went missing.
    const readBack = ok(await clientA().callTool({
      name: "morrow_result_page",
      arguments: { handle, limit: 1_000 },
    }, { timeout: 30_000 }));
    expect(readBack).toMatchObject({ schema: "morrow.result-page.v1", handle, offset: 0 });
    expect(Number(readBack.returned)).toBeGreaterThan(0);
  }, 90_000);

  it("3 · answers a queued run with the group that holds the window instead of waiting forever", async () => {
    // The queue deadline in morrow_batch_run is 60 seconds, so this case really
    // waits that long: it is the only way to prove the refusal arrives.
    slowCommandMs = 5_000;
    const holder = await createReadBatch(
      clientA(),
      "Assistant A holds the read window",
      1,
      Array.from({ length: 40 }, (_value, index) => slowCourseChild(index)),
    );
    const waiting = await createReadBatch(clientB(), "Assistant B waits for a window", 8, [slowCourseChild(100)]);

    holdUntilMs = Date.now() + 70_000;
    const holding = clientA().callTool({
      name: "morrow_batch_run",
      arguments: holder.runInput,
    }, { timeout: 240_000 });
    await waitFor(
      async () => Number((await schedulerHealth(clientB())).activeReadRequests) > 0,
      "assistant A to hold a read window",
    );

    const startedAt = Date.now();
    const queued = await clientB().callTool({
      name: "morrow_batch_run",
      arguments: waiting.runInput,
    }, { timeout: 180_000 });
    const waitedMs = Date.now() - startedAt;

    expect(queued.isError).toBe(true);
    expect(queued.structuredContent).toMatchObject({
      schema: "morrow.problem.v1",
      code: "batch_window_queue_timeout",
      batchId: waiting.batchId,
    });
    const refusal = text(queued);
    expect(refusal).toContain("Morrow did not start this run.");
    expect(refusal).toContain(`Group ${holder.batchId} has been running since`);
    expect(refusal).toContain("assistant-a");
    expect(refusal).toContain("This run sent nothing to the selected learning platform.");
    // It came back at the documented deadline, not on a hang and not at once.
    expect(waitedMs).toBeGreaterThan(50_000);
    expect(waitedMs).toBeLessThan(120_000);

    // The refused run left its own group untouched.
    expect(ok(await clientB().callTool({
      name: "morrow_batch_get",
      arguments: { batch_id: waiting.batchId },
    }, { timeout: 30_000 })).batch).toMatchObject({ state: "planned", succeededChildren: 0 });

    holdUntilMs = 0;
    expect(ok(await holding)).toMatchObject({ batch: { batchId: holder.batchId } });
  }, 300_000);

  it("4 · drops a queued run from the queue when the assistant cancels the request", async () => {
    slowCommandMs = 2_000;
    const holder = await createReadBatch(
      clientA(),
      "Assistant A holds the window briefly",
      1,
      Array.from({ length: 20 }, (_value, index) => slowCourseChild(200 + index)),
    );
    const waiting = await createReadBatch(clientB(), "Assistant B cancels while queued", 8, [slowCourseChild(300)]);

    holdUntilMs = Date.now() + 25_000;
    const holding = clientA().callTool({
      name: "morrow_batch_run",
      arguments: holder.runInput,
    }, { timeout: 240_000 });
    await waitFor(
      async () => Number((await schedulerHealth(clientB())).activeReadRequests) > 0,
      "assistant A to hold a read window",
    );

    const cancellation = new AbortController();
    const queued = clientB().callTool({
      name: "morrow_batch_run",
      arguments: waiting.runInput,
    }, { timeout: 180_000, signal: cancellation.signal });
    const settled = queued.then(() => "returned" as const, () => "cancelled" as const);
    const queueEntry = async (): Promise<JsonObject | undefined> => {
      const health = await schedulerHealth(clientB());
      const queue = Array.isArray(health.waiting) ? health.waiting : [];
      return queue.filter(isJsonObject).find((entry) => entry.batchId === waiting.batchId);
    };
    await waitFor(async () => Boolean(await queueEntry()), "assistant B to enter the window queue");
    // The queue names who is waiting, not only that something is.
    expect(String((await queueEntry())?.holder ?? "")).toContain("assistant-b");

    cancellation.abort();
    expect(await settled).toBe("cancelled");
    await waitFor(async () => !(await queueEntry()), "the cancelled run to leave the window queue");
    expect(Number((await schedulerHealth(clientB())).waitingWindows)).toBe(0);

    // Nothing was started for the cancelled request.
    expect(ok(await clientB().callTool({
      name: "morrow_batch_get",
      arguments: { batch_id: waiting.batchId },
    }, { timeout: 30_000 })).batch).toMatchObject({ state: "planned", succeededChildren: 0 });

    holdUntilMs = 0;
    ok(await holding);
  }, 180_000);

  it("5 · refuses a second change to a held target and names the request that holds it", async () => {
    const before = writeCommands;
    const firstId = await planPageCorrection(
      clientA(),
      "lesson-conflict",
      "Cells have membranes.",
      "Cells have protective membranes.",
    );
    expect(await operationRecord(clientA(), firstId)).toMatchObject({ state: "approved" });

    nextWriteOutcome = "unknown_result";
    const uncertain = await clientA().callTool({
      name: "morrow_operation_dispatch",
      arguments: { operation_id: firstId },
    }, { timeout: 60_000 });
    expect(uncertain.isError).toBe(true);
    expect(uncertain.structuredContent).toMatchObject({ effectState: "applied_or_unknown" });
    expect(writeCommands).toBe(before + 1);
    uncertainOperationId = firstId;

    const secondId = await planPageCorrection(
      clientB(),
      "lesson-conflict",
      "Cells have membranes.",
      "Cells have thin membranes.",
    );
    const blocked = await clientB().callTool({
      name: "morrow_operation_dispatch",
      arguments: { operation_id: secondId },
    }, { timeout: 60_000 });
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent).toMatchObject({
      data: { reason: "provider_effect_target_conflict", blockingOperationId: firstId },
    });
    expect(text(blocked)).toContain(firstId);
    // The refused change sent nothing.
    expect(writeCommands).toBe(before + 1);
    expect(await operationRecord(clientB(), secondId)).toMatchObject({ state: "approved", dispatchAttempt: 0 });
  }, 120_000);

  it("6 · keeps every finished result when an assistant cancels its own group, and repeats no child", async () => {
    // The Bridge holds the second child's read open, so the cancel provably
    // arrives while that child is running rather than between children.
    heldChildTarget = "cancel-1";
    const group = await createReadBatch(
      clientA(),
      "Assistant A cancels its own group",
      1,
      Array.from({ length: 8 }, (_value, index) => cancelChild(index)),
    );
    commandLog = [];
    const running = clientA().callTool({
      name: "morrow_batch_run",
      arguments: group.runInput,
    }, { timeout: 180_000 });
    await waitFor(() => releaseHeldChild !== null, "the second child's read to reach the Bridge");
    ok(await clientA().callTool({ name: "morrow_batch_cancel", arguments: { batch_id: group.batchId } }, { timeout: 30_000 }));
    releaseHeldChild?.();
    releaseHeldChild = null;
    heldChildTarget = "";
    ok(await running);

    const detail = ok(await clientA().callTool({
      name: "morrow_batch_get",
      arguments: { batch_id: group.batchId, limit: 20 },
    }, { timeout: 30_000 }));
    const batch = isJsonObject(detail.batch) ? detail.batch : {};
    const succeeded = Number(batch.succeededChildren ?? 0);
    const cancelled = Number(batch.cancelledChildren ?? 0);
    // A child was in flight, so the group is not quietly "cancelled": it asks
    // for a look at what was already sent. One child had finished and one was
    // running, so six of the eight were still unsent and are the cancelled ones.
    expect(batch.state).toBe("inspection_required");
    expect(succeeded).toBe(2);
    expect(cancelled).toBe(6);
    expect(Number(batch.failedChildren ?? 0)).toBe(0);

    // No child was sent twice: the cancel stopped work that had not started and
    // left the running child alone.
    const perChild = new Map<string, number>();
    for (const command of commandLog) {
      const target = commandTarget(command);
      if (!target.startsWith("cancel-")) continue;
      perChild.set(target, (perChild.get(target) ?? 0) + 1);
    }
    expect([...perChild.values()].every((count) => count === 1)).toBe(true);
    expect(perChild.size).toBe(succeeded);

    // Every child stays visible, and every finished child still holds its own
    // saved result.
    const page = ok(await clientB().callTool({
      name: "morrow_batch_results_page",
      arguments: { batch_id: group.batchId, offset: 0, limit: 20 },
    }, { timeout: 30_000 }));
    const children = Array.isArray(page.children) ? page.children.filter(isJsonObject) : [];
    expect(children).toHaveLength(8);
    const finished = children.filter((child) => child.state === "succeeded");
    expect(finished).toHaveLength(succeeded);
    for (const child of finished) {
      expect(child).toMatchObject({ attemptCount: 1 });
      expect(child.resultDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof child.terminalAt).toBe("string");
    }
    for (const child of children.filter((entry) => entry.state === "cancelled")) {
      expect(child).toMatchObject({ attemptCount: 0, resultDigest: null });
    }

    cancelledBatchId = group.batchId;
    cancelledRunInput = group.runInput;
    cancelledBatchCounts = {
      totalChildren: 8,
      succeededChildren: succeeded,
      cancelledChildren: cancelled,
      failedChildren: Number(batch.failedChildren ?? 0),
      pendingChildren: 0,
      runningChildren: 0,
    };
  }, 180_000);

  it("7 · keeps finished work finished and uncertain work uncertain when the owner restarts", async () => {
    expect(cancelledBatchId, "case 6 must run before the restart case").not.toBe("");
    expect(uncertainOperationId, "case 5 must run before the restart case").not.toBe("");
    const writesBefore = writeCommands;

    await bridge?.close().catch(() => undefined);
    bridge = undefined;
    await stopClients();
    await waitFor(() => !existsSync(ownerPath), "the local owner to stop", 30_000);

    await startOwnerAndClients();
    commandLog = [];

    const restored = ok(await clientB().callTool({
      name: "morrow_batch_get",
      arguments: { batch_id: cancelledBatchId, limit: 20 },
    }, { timeout: 30_000 }));
    // Every child count is exactly what it was before the restart, and the new
    // owner settled the interrupted group by inspecting it rather than by
    // running any of it again.
    expect(restored.batch).toMatchObject(cancelledBatchCounts);
    expect(isJsonObject(restored.batch) ? restored.batch.state : "").toBe("partial");
    const restoredPage = ok(await clientA().callTool({
      name: "morrow_batch_results_page",
      arguments: { batch_id: cancelledBatchId, offset: 0, limit: 20 },
    }, { timeout: 30_000 }));
    const restoredChildren = Array.isArray(restoredPage.children) ? restoredPage.children.filter(isJsonObject) : [];
    const restoredFinished = restoredChildren.filter((child) => child.state === "succeeded");
    expect(restoredFinished).toHaveLength(Number(cancelledBatchCounts.succeededChildren));
    for (const child of restoredFinished) {
      expect(child).toMatchObject({ attemptCount: 1 });
      expect(child.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    }

    // The uncertain change is still uncertain, and still on its single attempt.
    expect(await operationRecord(clientB(), uncertainOperationId)).toMatchObject({
      state: "applied_or_unknown",
      dispatchAttempt: 1,
    });

    // Resuming the cancelled group replays nothing.
    const resumed = ok(await clientA().callTool({
      name: "morrow_batch_resume",
      arguments: cancelledRunInput,
    }, { timeout: 60_000 }));
    expect(resumed).toMatchObject({ processed: 0 });
    expect(commandLog.filter((command) => commandTarget(command).startsWith("cancel-"))).toHaveLength(0);
    expect(writeCommands).toBe(writesBefore);
  }, 180_000);

  it("8 · names the assistant that asked for every saved request and group, without its project path", async () => {
    const projectADigest = createHash("sha256").update(projectARoot).digest("hex");
    const projectBDigest = createHash("sha256").update(projectBRoot).digest("hex");

    const fromA = await planPageCorrection(clientA(), "lesson-identity-a", "Cells have membranes.", "Cells have cell membranes.");
    const fromB = await planPageCorrection(clientB(), "lesson-identity-b", "Cells have membranes.", "Cells have outer membranes.");
    const savedA = await operationRecord(clientA(), fromA);
    const savedB = await operationRecord(clientB(), fromB);
    expect(requestedBy(savedA)).toMatchObject({
      clientName: "assistant-a",
      workspaceName: "project-a",
      workspaceDigest: projectADigest,
    });
    expect(requestedBy(savedB)).toMatchObject({
      clientName: "assistant-b",
      workspaceName: "project-b",
      workspaceDigest: projectBDigest,
    });
    expect(requestedBy(savedA)?.sessionId).not.toBe(requestedBy(savedB)?.sessionId);

    const listed = ok(await clientA().callTool({ name: "morrow_operation_list", arguments: { limit: 50 } }, { timeout: 30_000 }));
    const operations = Array.isArray(listed.operations) ? listed.operations : [];
    const listedA = operations.find((entry) => isJsonObject(entry) && entry.operationId === fromA);
    const listedB = operations.find((entry) => isJsonObject(entry) && entry.operationId === fromB);
    expect(requestedBy(listedA)).toMatchObject({ clientName: "assistant-a", workspaceName: "project-a" });
    expect(requestedBy(listedB)).toMatchObject({ clientName: "assistant-b", workspaceName: "project-b" });

    const groupA = await createReadBatch(clientA(), "Assistant A named group", 1, [slowCourseChild(400)]);
    const groupB = await createReadBatch(clientB(), "Assistant B named group", 1, [slowCourseChild(401)]);
    const savedGroupA = ok(await clientB().callTool({ name: "morrow_batch_get", arguments: { batch_id: groupA.batchId } }, { timeout: 30_000 }));
    const savedGroupB = ok(await clientA().callTool({ name: "morrow_batch_get", arguments: { batch_id: groupB.batchId } }, { timeout: 30_000 }));
    expect(requestedBy(savedGroupA.batch)).toMatchObject({
      clientName: "assistant-a",
      workspaceName: "project-a",
      workspaceDigest: projectADigest,
    });
    expect(requestedBy(savedGroupB.batch)).toMatchObject({
      clientName: "assistant-b",
      workspaceName: "project-b",
      workspaceDigest: projectBDigest,
    });
    const recent = ok(await clientB().callTool({ name: "morrow_batches_recent", arguments: { limit: 50 } }, { timeout: 30_000 }));
    expect(JSON.stringify(recent)).toContain("assistant-a");

    // The name and the project are readable; the path never is.
    for (const value of [savedA, savedB, listed, savedGroupA, savedGroupB, recent]) {
      const serialized = JSON.stringify(value);
      expect(serialized).not.toContain(projectARoot);
      expect(serialized).not.toContain(projectBRoot);
      expect(serialized).not.toContain(projectA);
      expect(serialized).not.toContain(projectB);
    }
  }, 120_000);

  it("9 · settles a write whose answer never arrives as applied_or_unknown and never sends it again", async () => {
    const operationId = await planPageCorrection(
      clientA(),
      "lesson-unanswered",
      "Cells have membranes.",
      "Cells have selective membranes.",
    );
    const before = writeCommands;
    nextWriteOutcome = "no_result";
    const dispatched = await clientA().callTool({
      name: "morrow_operation_dispatch",
      arguments: { operation_id: operationId },
    }, { timeout: 120_000 });
    // The change went out once, and the extension vanished with it. Morrow has
    // no answer to give, so it returns a named problem rather than an outcome.
    expect(writeCommands).toBe(before + 1);
    expect(dispatched.isError).toBe(true);
    expect(structured(dispatched).schema).toBe("morrow.problem.v1");

    // With the Bridge back, the saved record reads as uncertain, on one attempt.
    await bridge?.close().catch(() => undefined);
    bridge = await connectFixtureBridge(connectorPort);
    expect(await operationRecord(clientA(), operationId)).toMatchObject({
      state: "applied_or_unknown",
      dispatchAttempt: 1,
    });

    const reconciled = await clientA().callTool({
      name: "morrow_operation_reconcile",
      arguments: { operation_id: operationId },
    }, { timeout: 60_000 });
    expect(structured(reconciled).effectState ?? "applied_or_unknown").toBe("applied_or_unknown");
    expect(writeCommands).toBe(before + 1);

    // A second dispatch of the same request is refused, from either assistant.
    const again = await clientB().callTool({
      name: "morrow_operation_dispatch",
      arguments: { operation_id: operationId },
    }, { timeout: 60_000 });
    expect(again.isError).toBe(true);
    expect(writeCommands).toBe(before + 1);
    expect(await operationRecord(clientA(), operationId)).toMatchObject({
      state: "applied_or_unknown",
      dispatchAttempt: 1,
    });
  }, 240_000);
});
