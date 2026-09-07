import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DurableBatchStore, loadOrCreateBatchEncryptionKey } from "@morrow/batch-engine";
import { isJsonObject, sha256Json, sha256Text, type CatalogTool, type JsonObject } from "@morrow/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../../blackboard-learn-api/src/binding.js";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { stableEffectTargetIdentity, type EffectBindingScope } from "../src/runtime.js";

/**
 * The deadline for one case, and for the fixture the cases share. Every case
 * below drives the real Blackboard Learn REST source process against a local
 * HTTPS Blackboard fixture, and one case stops Morrow and starts it again.
 * Change the deadline here, not per case.
 */
const CASE_TIMEOUT_MS = 60_000;

const TENANT_ID = "fixture";
const PRINCIPAL_ID = "_11_1";
const CREDENTIAL_REVISION = "8c751fc3-ecf9-4558-b86b-d97a34e93295";
const TEST_CERTIFICATE = fileURLToPath(new URL("./fixtures/blackboard-test-cert.pem", import.meta.url));
const TEST_KEY = fileURLToPath(new URL("./fixtures/blackboard-test-key.pem", import.meta.url));
/** Whole milliseconds one content read is held open, so overlapping reads are observable. */
const CONTENT_READ_DELAY_MS = 10;

interface FixtureCourse {
  readonly courseId: string;
  readonly courseName: string;
  /** The item each course-scale read reads. */
  readonly contentId: string;
  /** A second item in the same course, so one held item does not hold its siblings. */
  readonly siblingContentId: string;
  readonly learnerId: string;
  readonly learnerName: string;
  readonly learnerEmail: string;
}

/** Twelve selected courses on one configured tenant, as one program. */
const courses: readonly FixtureCourse[] = Array.from({ length: 12 }, (_, index) => {
  const number = 101 + index;
  return {
    courseId: `_${number}_1`,
    courseName: `Blackboard course ${number}`,
    contentId: `_${200 + index}_1`,
    siblingContentId: `_${300 + index}_1`,
    learnerId: `_${400 + index}_1`,
    learnerName: `Blackboard Learner ${number}`,
    learnerEmail: `learner-${number}@example.edu`,
  };
});

const courseById = new Map(courses.map((course) => [course.courseId, course]));

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function contentKey(courseId: string, contentId: string): string {
  return `${courseId}/${contentId}`;
}

interface BlackboardFixture {
  readonly directory: string;
  readonly baseUrl: string;
  readonly configPath: string;
  readonly binding: (courseId: string) => string;
  /** The fixture answers a PATCH without storing it when this is false. */
  storePatch: boolean;
  /** The next read of this exact item is received and never answered. */
  holdNextRead: (courseId: string, contentId: string) => void;
  readonly heldReadCount: () => number;
  readonly releaseHeldReads: () => void;
  readonly requestCount: () => number;
  readonly contentReads: (courseId: string, contentId: string) => number;
  readonly patches: () => readonly string[];
  readonly maxConcurrentContentReads: () => number;
  readonly close: () => Promise<void>;
}

async function createFixture(): Promise<BlackboardFixture> {
  const directory = await mkdtemp(join(tmpdir(), "morrow-blackboard-batch-scale-"));
  const certificate = await readFile(TEST_CERTIFICATE);
  const key = await readFile(TEST_KEY);
  const contents = new Map<string, JsonObject>();
  for (const course of courses) {
    for (const contentId of [course.contentId, course.siblingContentId]) {
      contents.set(contentKey(course.courseId, contentId), {
        id: contentId,
        courseId: course.courseId,
        contentHandler: { id: "resource/x-bb-document" },
        title: `Week one for ${course.learnerName}`,
        description: `${course.learnerName} can reach ${course.learnerEmail} for help.`,
        availability: { available: "Yes" },
      });
    }
  }
  const state = {
    storePatch: true,
    requests: 0,
    activeContentReads: 0,
    maxConcurrentContentReads: 0,
  };
  const contentReads = new Map<string, number>();
  const patches: string[] = [];
  const holds = new Set<string>();
  const held: ServerResponse[] = [];

  const server = createServer({ key, cert: certificate }, async (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "https://fixture.invalid").pathname;
    state.requests += 1;
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      json(response, { access_token: "temporary-token", expires_in: 3600 });
      return;
    }
    if (pathname === "/learn/api/public/v1/users/me" || pathname === `/learn/api/public/v1/users/${PRINCIPAL_ID}`) {
      json(response, { id: PRINCIPAL_ID });
      return;
    }
    const membership = /^\/learn\/api\/public\/v1\/courses\/([^/]+)\/users\/([^/]+)$/.exec(pathname);
    if (membership && membership[2] === PRINCIPAL_ID && courseById.has(membership[1]!)) {
      json(response, { id: `_membership_${membership[1]}`, courseId: membership[1], userId: PRINCIPAL_ID });
      return;
    }
    const roster = /^\/learn\/api\/public\/v1\/courses\/([^/]+)\/users$/.exec(pathname);
    if (roster && courseById.has(roster[1]!)) {
      const course = courseById.get(roster[1]!)!;
      json(response, {
        results: [{
          id: `_roster_${course.courseId}`,
          courseId: course.courseId,
          userId: course.learnerId,
          courseRoleId: "Student",
          availability: { available: "Yes" },
          user: {
            id: course.learnerId,
            name: { given: course.learnerName.split(" ").slice(0, -1).join(" "), family: course.learnerName.split(" ").at(-1) },
            contact: { email: course.learnerEmail },
          },
        }],
        paging: {},
      });
      return;
    }
    const courseRead = /^\/learn\/api\/public\/v[13]\/courses\/([^/]+)$/.exec(pathname);
    if (courseRead && courseById.has(courseRead[1]!)) {
      const course = courseById.get(courseRead[1]!)!;
      json(response, {
        id: course.courseId,
        courseId: `BB-${course.courseId}`,
        name: course.courseName,
        ultraStatus: "Ultra",
        closedComplete: false,
      });
      return;
    }
    const item = /^\/learn\/api\/public\/v1\/courses\/([^/]+)\/contents\/([^/]+)$/.exec(pathname);
    const stored = item ? contents.get(contentKey(item[1]!, item[2]!)) : undefined;
    if (item && stored && request.method === "GET") {
      const target = contentKey(item[1]!, item[2]!);
      contentReads.set(target, (contentReads.get(target) || 0) + 1);
      if (holds.delete(target)) {
        // Blackboard received this read and Morrow never receives its answer.
        held.push(response);
        return;
      }
      state.activeContentReads += 1;
      state.maxConcurrentContentReads = Math.max(state.maxConcurrentContentReads, state.activeContentReads);
      setTimeout(() => {
        state.activeContentReads -= 1;
        json(response, contents.get(target) || stored);
      }, CONTENT_READ_DELAY_MS);
      return;
    }
    if (item && stored && request.method === "PATCH") {
      const target = contentKey(item[1]!, item[2]!);
      patches.push(target);
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const patched = { ...stored, ...(JSON.parse(body) as JsonObject) };
      if (state.storePatch) contents.set(target, patched);
      json(response, patched);
      return;
    }
    json(response, { message: "not found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Blackboard fixture has no TCP address");
  const baseUrl = `https://127.0.0.1:${address.port}`;
  const home = join(directory, "home");
  const credentialDirectory = join(home, ".morrow", "credentials", "blackboard");
  const configPath = join(directory, "blackboard-learn.json");
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(credentialDirectory, "fixture.secret"), JSON.stringify({
    schema: "morrow.blackboard-learn.credential.v1",
    credentialRevision: CREDENTIAL_REVISION,
    applicationSecret: "client-secret",
  }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({
    schema: "morrow.blackboard-learn.config.v1",
    tenants: [{
      id: TENANT_ID,
      baseUrl,
      applicationKey: "app-key",
      credentialRef: "file",
      credentialRevision: CREDENTIAL_REVISION,
      principalId: PRINCIPAL_ID,
      courseBindings: courses.map((course) => ({ courseId: course.courseId })),
    }],
  }), { mode: 0o600 });
  return {
    directory,
    baseUrl,
    configPath,
    binding: (courseId: string) => deriveBlackboardSourceBindingId(baseUrl, PRINCIPAL_ID, courseId),
    get storePatch() { return state.storePatch; },
    set storePatch(value: boolean) { state.storePatch = value; },
    holdNextRead: (courseId: string, contentId: string) => { holds.add(contentKey(courseId, contentId)); },
    heldReadCount: () => held.length,
    releaseHeldReads: () => {
      while (held.length > 0) {
        const response = held.pop();
        try { response?.destroy(); } catch { /* the connection is already gone */ }
      }
    },
    requestCount: () => state.requests,
    contentReads: (courseId: string, contentId: string) => contentReads.get(contentKey(courseId, contentId)) || 0,
    patches: () => [...patches],
    maxConcurrentContentReads: () => state.maxConcurrentContentReads,
    close: async () => {
      for (const response of held) {
        try { response.destroy(); } catch { /* the connection is already gone */ }
      }
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function configuration(root: string, fixture: BlackboardFixture, statePath: string) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "full",
    sourcePolicy: { requireAttestation: false },
    upstreams: [{
      id: "blackboard-rest",
      label: "Blackboard Learn REST fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [join(root, "packages/blackboard-learn-api/dist/index.js")],
      cwd: root,
      env: {
        HOME: join(fixture.directory, "home"),
        MORROW_BLACKBOARD_CONFIG: fixture.configPath,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      sourceDisposition: "direct_owned",
      priority: 100,
      required: true,
      enabled: true,
      outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "learner", maxRecords: 10_000,
        maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: statePath },
    batchScheduler: { maxConcurrentReadWindows: 2 },
  });
}

interface ConnectedAssistant {
  readonly client: Client;
  readonly server: ReturnType<typeof serveStdio>;
}

async function openClient(runtime: MorrowRuntime, name: string): Promise<ConnectedAssistant> {
  const [left, right] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
  const client = new Client({ name, version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(left);
  return { client, server };
}

async function closeAssistant(assistant: ConnectedAssistant | null): Promise<void> {
  await assistant?.client.close();
  await assistant?.server.close();
}

/** The assistant a case sends through, or a named failure instead of a null read. */
function connectedClient(assistant: ConnectedAssistant | null, name: string): Client {
  if (!assistant) throw new Error(`${name} is not connected`);
  return assistant.client;
}

function structured(result: { readonly structuredContent?: unknown; readonly isError?: boolean }): JsonObject {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  if (!isJsonObject(result.structuredContent)) throw new Error("expected structured MCP result");
  return result.structuredContent;
}

function problem(result: { readonly structuredContent?: unknown; readonly isError?: boolean }): JsonObject {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  if (!isJsonObject(result.structuredContent)) throw new Error("expected structured MCP problem");
  const data = result.structuredContent.data;
  return isJsonObject(data) ? data : result.structuredContent;
}

function batchIdOf(created: JsonObject): string {
  const batch = created.batch;
  if (!isJsonObject(batch) || typeof batch.batchId !== "string") throw new Error("batch creation did not return a batch id");
  return batch.batchId;
}

function runInput(batchId: string, created: JsonObject, maxChildren: number) {
  const manifest = created.manifest;
  if (!isJsonObject(manifest) || !isJsonObject(manifest.courseSet) || typeof manifest.courseSet.digest !== "string") {
    throw new Error("batch manifest did not include its course-set digest");
  }
  return {
    batch_id: batchId,
    max_children: maxChildren,
    course_set_digest: manifest.courseSet.digest,
    profile_digest: typeof manifest.profileDigest === "string" ? manifest.profileDigest : "",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("expected Blackboard fixture event did not occur");
    await new Promise((done) => setTimeout(done, 5));
  }
}

function blackboardMapping(name: string, sourceExport: string): CatalogTool {
  return {
    publicName: name,
    upstreamId: "blackboard-rest",
    upstreamLabel: "Blackboard Learn REST",
    upstreamName: name,
    inputSchema: {},
    capability: {
      provider: "blackboard",
      route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
      sourceImplementations: [{ toolName: name, sourceExport }],
    },
  } as unknown as CatalogTool;
}

describe("Blackboard multi-course and concurrent-assistant runtime proof", () => {
  /**
   * One configured Blackboard tenant, twelve selected course connections, one
   * Blackboard Learn REST source process and two connected assistants serve
   * every case below. The cases run in file order and share that installation,
   * so each one inherits what the case before it left: the finished twelve
   * course reads, the change whose ending Morrow could not confirm, the group a
   * person cancelled, and the group Morrow was stopped in the middle of. One
   * case stops Morrow and starts it again on purpose, and the runtime and
   * assistant it leaves behind are the ones the cases after it use.
   *
   * Blackboard REST configuration is present here and no live Blackboard tenant
   * is involved: this fixture proves the contract only.
   */
  let fixture: BlackboardFixture;
  let directory = "";
  let statePath = "";
  let keyPath = "";
  let runtime: MorrowRuntime;
  let assistantA: ConnectedAssistant | null = null;
  let assistantB: ConnectedAssistant | null = null;
  const clientA = (): Client => connectedClient(assistantA, "assistant A");
  const clientB = (): Client => connectedClient(assistantB, "assistant B");
  const scopeFor = (course: FixtureCourse) => ({
    tenant_id: TENANT_ID,
    source_binding_id: fixture.binding(course.courseId),
    course_id: course.courseId,
  });
  const readOperation = (course: FixtureCourse, contentId: string) => ({
    child_id: `read:${course.courseId}:${contentId}`,
    course_id: course.courseId,
    tool: "blackboard_read_course_content",
    arguments: { ...scopeFor(course), content_id: contentId },
  });
  const batchInput = (
    name: string,
    operations: readonly ReturnType<typeof readOperation>[],
    concurrency: number,
  ) => {
    const courseIds = operations.map((operation) => operation.course_id);
    return {
      name,
      mode: "read_only",
      concurrency,
      operation_family: "blackboard-scale-proof",
      operations,
      course_set: {
        source: "explicit",
        course_ids: courseIds,
        complete: true,
        pagination_complete: true,
        snapshot_digest: sha256Json({ schema: "morrow.blackboard-scale.selection.v1", name, courseIds }),
      },
      profile_digest: sha256Json({ schema: "morrow.blackboard-scale.profile.v1", name }),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  };
  /** The change Morrow sent to course one and could not confirm. */
  let unconfirmedOperationId = "";
  /** The group Morrow was stopped in the middle of, as the input that resumes it. */
  let interruptedBatchId = "";
  let interruptedRunInput: ReturnType<typeof runInput>;

  beforeAll(async () => {
    fixture = await createFixture();
    directory = fixture.directory;
    statePath = join(directory, "morrow.sqlite3");
    keyPath = join(directory, "batch.key");
    runtime = await MorrowRuntime.connect(
      configuration(resolve("../.."), fixture, statePath),
      { statePath, batchKeyPath: keyPath },
    );
    assistantA = await openClient(runtime, "blackboard-scale-a");
    assistantB = await openClient(runtime, "blackboard-scale-b");
  }, CASE_TIMEOUT_MS);

  afterAll(async () => {
    await closeAssistant(assistantB);
    await closeAssistant(assistantA);
    await runtime?.close();
    await fixture?.close();
  }, CASE_TIMEOUT_MS);

  it("reads twelve Blackboard courses as durable children from two assistants at once", async () => {
    const created = structured(await clientA().callTool({
      name: "morrow_batch_create",
      arguments: batchInput("Twelve selected Blackboard courses", courses.map((course) => readOperation(course, course.contentId)), 4),
    }));
    const batchId = batchIdOf(created);
    // Each assistant asks for half of the twelve courses, so both of them work
    // in the same frozen group and neither one runs it alone.
    const input = runInput(batchId, created, 6);

    const windows = (await Promise.all([
      clientA().callTool({ name: "morrow_batch_run", arguments: input }),
      clientB().callTool({ name: "morrow_batch_run", arguments: input }),
    ])).map(structured);
    expect(windows.map((window) => Number(window.processed || 0))).toEqual([6, 6]);
    expect(runtime.batchGet({ batchId, limit: 12 }).batch).toMatchObject({
      state: "completed",
      totalChildren: 12,
      succeededChildren: 12,
      failedChildren: 0,
      unknownChildren: 0,
      cancelledChildren: 0,
    });

    // One frozen manifest allows four reads at once, and more than one proves
    // the twelve courses did not run one after another.
    expect(fixture.maxConcurrentContentReads()).toBeGreaterThan(1);
    expect(fixture.maxConcurrentContentReads()).toBeLessThanOrEqual(4);
    expect(runtime.batchScheduler.health()).toMatchObject({
      maxConcurrentReadWindows: 2,
      maxConcurrentWriteWindows: 1,
      activeReadWindows: 0,
      activeReadRequests: 0,
    });

    // Every child keeps its own course, its own item, and the course connection
    // that belongs to that course, and Blackboard was asked for each item once.
    const detail = runtime.batchGet({ batchId, limit: 12 });
    const children = Array.isArray(detail.children) ? detail.children : [];
    const courseOfChild = new Map(runtime.batches.getManifest(batchId).children.map((child) => [child.childId, child.courseId]));
    expect(children).toHaveLength(12);
    for (const course of courses) {
      const childId = `read:${course.courseId}:${course.contentId}`;
      const child = children.find((entry) => isJsonObject(entry) && entry.childId === childId);
      expect(child, `child ${childId} is missing`).toBeTruthy();
      expect(child).toMatchObject({ state: "succeeded", attemptCount: 1 });
      expect(courseOfChild.get(childId)).toBe(course.courseId);
      expect(runtime.batches.readArguments(batchId, childId)).toEqual({
        tenant_id: TENANT_ID,
        source_binding_id: fixture.binding(course.courseId),
        course_id: course.courseId,
        content_id: course.contentId,
      });
      expect(fixture.contentReads(course.courseId, course.contentId)).toBe(1);
      expect(fixture.contentReads(course.courseId, course.siblingContentId)).toBe(0);
    }

    // No learner name or address reaches the saved group or an assistant's page.
    const page = structured(await clientB().callTool({
      name: "morrow_batch_results_page",
      arguments: { batch_id: batchId, offset: 0, limit: 12 },
    }));
    const egress = `${JSON.stringify(detail)}${JSON.stringify(page)}`;
    for (const course of courses) {
      expect(egress).not.toContain(course.learnerName);
      expect(egress).not.toContain(course.learnerEmail);
    }
  }, CASE_TIMEOUT_MS);

  it("refuses a read whose course connection belongs to another course, and asks Blackboard for nothing", async () => {
    const requestsBefore = fixture.requestCount();
    const crossed = {
      tenant_id: TENANT_ID,
      source_binding_id: fixture.binding(courses[1]!.courseId),
      course_id: courses[0]!.courseId,
      content_id: courses[0]!.contentId,
    };
    const mismatched = await clientB().callTool({ name: "blackboard_read_course_content", arguments: crossed });
    expect(problem(mismatched)).toMatchObject({ code: "upstream_error_sanitized", recoverable: false });
    // The source names the refusal on Morrow's own side of that boundary.
    const source = await runtime.gateway.callSourceOwned("blackboard_read_course_content", crossed);
    expect(source.isError).toBe(true);
    expect(source.structuredContent).toMatchObject({ ok: false, problem: { code: "blackboard_scope_binding_mismatch" } });
    expect(fixture.requestCount()).toBe(requestsBefore);
  }, CASE_TIMEOUT_MS);

  it("holds one Blackboard item after a change whose ending Morrow could not confirm, across two assistants", async () => {
    const course = courses[0]!;
    const patchInput = { ...scopeFor(course), content_id: course.contentId, patch: { title: "Reviewed week one" } };
    const first = structured(await clientA().callTool({ name: "morrow_plan_blackboard_content_patch", arguments: patchInput }));
    const second = structured(await clientB().callTool({ name: "morrow_plan_blackboard_content_patch", arguments: patchInput }));
    unconfirmedOperationId = String(first.operationId || "");
    const secondOperationId = String(second.operationId || "");
    expect(unconfirmedOperationId).toMatch(/^op:/);
    expect(secondOperationId).toMatch(/^op:/);
    expect(secondOperationId).not.toBe(unconfirmedOperationId);
    // Two assistants froze two changes for the same item, and neither has been sent.
    expect(fixture.patches()).toHaveLength(0);

    // A person approves both through the loopback review.
    runtime.gateway.approveOperation(unconfirmedOperationId);
    runtime.gateway.approveOperation(secondOperationId);

    // Blackboard answers the first change and does not keep it, so the fresh
    // read after it does not show the reviewed value: Morrow cannot say whether
    // the change landed.
    fixture.storePatch = false;
    const uncertain = await clientA().callTool({
      name: "morrow_operation_dispatch",
      arguments: { operation_id: unconfirmedOperationId },
    });
    expect(uncertain.isError).toBe(true);
    const uncertainRecord = runtime.gateway.operationGet(unconfirmedOperationId);
    expect(uncertainRecord).toMatchObject({ state: "applied_or_unknown" });
    expect(Array.isArray(uncertainRecord.attention) ? uncertainRecord.attention[0] : null)
      .toBe("provider_effect_may_have_landed");
    expect(fixture.patches()).toEqual([contentKey(course.courseId, course.contentId)]);

    // The second assistant's approved change is refused at the item, before
    // anything is sent, and the refusal names the request to check.
    const refused = await clientB().callTool({
      name: "morrow_operation_dispatch",
      arguments: { operation_id: secondOperationId },
    });
    expect(problem(refused)).toMatchObject({
      code: "operation_dispatch_refused",
      reason: "provider_effect_target_conflict",
      blockingOperationId: unconfirmedOperationId,
      recoverable: true,
    });
    expect(fixture.patches()).toHaveLength(1);

    // Morrow names the exact item a person has to open in Blackboard.
    expect(structured(await clientB().callTool({ name: "blackboard_unresolved_effects", arguments: {} }))).toMatchObject({
      data: {
        schema: "morrow.blackboard.unresolved-effects.v1",
        ok: true,
        count: 1,
        effects: [{ tenantId: TENANT_ID, courseId: course.courseId, contentId: course.contentId, phase: "uncertain" }],
      },
    });

    // A new change for the held item is refused before review, and sends nothing.
    const replanned = await clientA().callTool({ name: "morrow_plan_blackboard_content_patch", arguments: patchInput });
    expect(replanned.isError).toBe(true);
    expect(fixture.patches()).toHaveLength(1);
  }, CASE_TIMEOUT_MS);

  it("leaves the other items in that course free while one item is held", async () => {
    const course = courses[0]!;
    const siblingInput = { ...scopeFor(course), content_id: course.siblingContentId, patch: { title: "Reviewed week two" } };
    const planned = structured(await clientB().callTool({ name: "morrow_plan_blackboard_content_patch", arguments: siblingInput }));
    const siblingOperationId = String(planned.operationId || "");
    expect(siblingOperationId).toMatch(/^op:/);
    fixture.storePatch = true;
    runtime.gateway.approveOperation(siblingOperationId);
    const dispatched = structured(await clientB().callTool({
      name: "morrow_operation_dispatch",
      arguments: { operation_id: siblingOperationId },
    }));
    expect(dispatched).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
    expect(fixture.patches()).toEqual([
      contentKey(course.courseId, course.contentId),
      contentKey(course.courseId, course.siblingContentId),
    ]);
  }, CASE_TIMEOUT_MS);

  it("keeps a Blackboard change out of a group of requests, so no group can report one as done", async () => {
    const course = courses[1]!;
    // A Blackboard change is one reviewed operation, and this build stages only
    // browser-bridge changes in a group. Both routes an assistant could name are
    // refused here, so a group never reports a Blackboard change as done and an
    // unconfirmed one is never a child of a group summary.
    const changeGroup = (name: string, tool: string) => ({
      name,
      mode: "stage_writes",
      concurrency: 1,
      operation_family: "blackboard-scale-proof",
      operations: [{
        child_id: `change:${course.courseId}`,
        course_id: course.courseId,
        tool,
        arguments: { ...scopeFor(course), content_id: course.contentId, patch: { title: "Grouped change" } },
      }],
      course_set: {
        source: "explicit",
        course_ids: [course.courseId],
        complete: true,
        pagination_complete: true,
        snapshot_digest: sha256Json({ schema: "morrow.blackboard-scale.change-selection.v1", courseId: course.courseId }),
      },
      profile_digest: sha256Json({ schema: "morrow.blackboard-scale.profile.v1", name }),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    const reviewedRoute = await clientA().callTool({
      name: "morrow_batch_create",
      arguments: changeGroup("Blackboard change through the reviewed route", "morrow_plan_blackboard_content_patch"),
    });
    expect(problem(reviewedRoute)).toMatchObject({
      code: "batch_operation_failed",
      detailDigest: sha256Text("Error:Unknown Morrow tool morrow_plan_blackboard_content_patch."),
    });

    const dispatchRoute = await clientA().callTool({
      name: "morrow_batch_create",
      arguments: changeGroup("Blackboard change through the dispatch route", "blackboard_apply_reviewed_content_patch"),
    });
    expect(problem(dispatchRoute)).toMatchObject({
      code: "batch_operation_failed",
      detailDigest: sha256Text(
        "Error:stage_writes batch accepts browser-bridge write tools; blackboard_apply_reviewed_content_patch is not eligible",
      ),
    });
    expect(fixture.patches()).toHaveLength(2);
  }, CASE_TIMEOUT_MS);

  it("cancels a running group, keeps the courses it already read, and reads no more", async () => {
    const selected = courses.slice(0, 8);
    const created = structured(await clientB().callTool({
      name: "morrow_batch_create",
      arguments: batchInput("Cancelled Blackboard subset", selected.map((course) => readOperation(course, course.siblingContentId)), 4),
    }));
    const batchId = batchIdOf(created);
    structured(await clientA().callTool({ name: "morrow_batch_run", arguments: runInput(batchId, created, 4) }));
    const cancelled = structured(await clientB().callTool({ name: "morrow_batch_cancel", arguments: { batch_id: batchId } }));
    expect(cancelled.batch).toMatchObject({
      state: "partial",
      totalChildren: 8,
      succeededChildren: 4,
      cancelledChildren: 4,
      pendingChildren: 0,
    });

    const detail = runtime.batchGet({ batchId, limit: 8 });
    const children = Array.isArray(detail.children) ? detail.children : [];
    const courseOfChild = new Map(runtime.batches.getManifest(batchId).children.map((child) => [child.childId, child.courseId]));
    const cancelledCourses = children
      .filter((child): child is JsonObject => isJsonObject(child) && child.state === "cancelled")
      .map((child) => courseOfChild.get(String(child.childId)) || "");
    expect(cancelledCourses).toHaveLength(4);
    for (const courseId of cancelledCourses) {
      const course = courseById.get(courseId);
      expect(course, `cancelled child names no selected course (${courseId})`).toBeTruthy();
      expect(fixture.contentReads(courseId, course!.siblingContentId)).toBe(0);
    }
    const requestsAfterCancel = fixture.requestCount();
    const resumed = structured(await clientA().callTool({ name: "morrow_batch_resume", arguments: runInput(batchId, created, 8) }));
    expect(resumed).toMatchObject({ processed: 0, batch: { state: "partial", succeededChildren: 4, cancelledChildren: 4 } });
    expect(fixture.requestCount()).toBe(requestsAfterCancel);
  }, CASE_TIMEOUT_MS);

  it("reports the request it could not confirm when Morrow stops in the middle of a group", async () => {
    const interrupted = courses[10]!;
    const remaining = courses[11]!;
    const created = structured(await clientA().callTool({
      name: "morrow_batch_create",
      arguments: batchInput(
        "Blackboard group Morrow was stopped in",
        [readOperation(interrupted, interrupted.siblingContentId), readOperation(remaining, remaining.siblingContentId)],
        1,
      ),
    }));
    interruptedBatchId = batchIdOf(created);
    interruptedRunInput = runInput(interruptedBatchId, created, 2);
    fixture.holdNextRead(interrupted.courseId, interrupted.siblingContentId);
    const running = clientA()
      .callTool({ name: "morrow_batch_run", arguments: interruptedRunInput })
      .catch(() => undefined);
    await waitFor(() => fixture.heldReadCount() === 1);

    // Morrow stops with that one request in flight.
    await runtime.close();
    await Promise.race([running, new Promise((done) => setTimeout(done, 5_000))]);
    await closeAssistant(assistantB);
    assistantB = null;
    await closeAssistant(assistantA);
    assistantA = null;

    // What Morrow records when it opens that group again: the request it could
    // not confirm, and a group it does not report as successful.
    const store = new DurableBatchStore({ path: statePath, encryptionKey: loadOrCreateBatchEncryptionKey(keyPath) });
    try {
      expect(store.getBatch(interruptedBatchId)).toMatchObject({
        state: "inspection_required",
        totalChildren: 2,
        succeededChildren: 0,
        unknownChildren: 1,
        pendingChildren: 1,
      });
      expect(store.listChildren(interruptedBatchId, 0, 2).children.map((child) => ({
        childId: child.childId,
        state: child.state,
        gatewayOperationState: child.gatewayOperationState,
        attemptCount: child.attemptCount,
      }))).toEqual([
        {
          childId: `read:${interrupted.courseId}:${interrupted.siblingContentId}`,
          state: "unknown",
          gatewayOperationState: "process_restart",
          attemptCount: 1,
        },
        {
          childId: `read:${remaining.courseId}:${remaining.siblingContentId}`,
          state: "pending",
          gatewayOperationState: null,
          attemptCount: 0,
        },
      ]);
    } finally {
      store.close();
    }
  }, CASE_TIMEOUT_MS);

  it("starts again, queues the unconfirmed read once more because a read changes nothing, and repeats no change", async () => {
    const interrupted = courses[10]!;
    const remaining = courses[11]!;
    const readsBefore = fixture.contentReads(interrupted.courseId, interrupted.siblingContentId);
    expect(readsBefore).toBe(1);

    runtime = await MorrowRuntime.connect(
      configuration(resolve("../.."), fixture, statePath),
      { statePath, batchKeyPath: keyPath },
    );
    assistantA = await openClient(runtime, "blackboard-scale-after-restart");

    // A read changes nothing in a course, so Morrow queues the one it could not
    // confirm instead of leaving it for a person. It has not been sent again.
    expect(runtime.batchGet({ batchId: interruptedBatchId, limit: 2 })).toMatchObject({
      batch: { state: "paused", succeededChildren: 0, unknownChildren: 0, pendingChildren: 2 },
      children: [{ state: "pending", attemptCount: 1 }, { state: "pending", attemptCount: 0 }],
    });
    expect(fixture.contentReads(interrupted.courseId, interrupted.siblingContentId)).toBe(readsBefore);

    // The change Morrow could not confirm survived the restart, still holds its
    // item, and was never sent again.
    expect(runtime.gateway.operationGet(unconfirmedOperationId)).toMatchObject({ state: "applied_or_unknown" });
    const replanned = await clientA().callTool({
      name: "morrow_plan_blackboard_content_patch",
      arguments: { ...scopeFor(courses[0]!), content_id: courses[0]!.contentId, patch: { title: "Reviewed week one" } },
    });
    expect(replanned.isError).toBe(true);
    expect(fixture.patches()).toHaveLength(2);

    fixture.releaseHeldReads();
    const resumed = structured(await clientA().callTool({ name: "morrow_batch_resume", arguments: interruptedRunInput }));
    expect(resumed).toMatchObject({ processed: 2, batch: { state: "completed", succeededChildren: 2, unknownChildren: 0 } });
    expect(fixture.contentReads(interrupted.courseId, interrupted.siblingContentId)).toBe(readsBefore + 1);
    expect(fixture.contentReads(remaining.courseId, remaining.siblingContentId)).toBe(1);
  }, CASE_TIMEOUT_MS);

  it("locks one Blackboard item by tenant, course, and item, whichever connection sent the change", () => {
    const apply = blackboardMapping(
      "blackboard_apply_reviewed_content_patch",
      "PATCH /learn/api/public/v1/courses/{course_id}/contents/{content_id}",
    );
    const connection = (index: number): EffectBindingScope => ({
      provider: "blackboard",
      origin: "https://learn.example.edu",
      sourceBindingId: `blackboard:${String(index).repeat(64)}`,
      principalFingerprint: String(index).repeat(64),
      sessionGeneration: index,
    });
    const target = (request: JsonObject, scope: EffectBindingScope): string => (
      stableEffectTargetIdentity(apply, request, undefined, scope, sha256Json({ scope }))
    );
    const request = { tenant_id: TENANT_ID, course_id: "_22_1", content_id: "_33_1", patch: { title: "one" } };

    // One item, one lock: a second course connection, a repointed integration
    // account and a rotated credential all reach the same Blackboard item.
    expect(target(request, connection(1))).toBe(target({ ...request, patch: { title: "two" } }, connection(2)));
    // Its siblings, its other courses and another tenant stay free.
    expect(target(request, connection(1))).not.toBe(target({ ...request, content_id: "_34_1" }, connection(1)));
    expect(target(request, connection(1))).not.toBe(target({ ...request, course_id: "_23_1" }, connection(1)));
    expect(target(request, connection(1))).not.toBe(target({ ...request, tenant_id: "second-campus" }, connection(1)));
    // A change Morrow cannot bind to one configured tenant is not planned.
    expect(() => target({ course_id: "_22_1", content_id: "_33_1" }, connection(1)))
      .toThrow("Morrow needs an exact tenant identity before it can plan a provider effect.");
  });
});
