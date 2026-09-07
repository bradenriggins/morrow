import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import { isJsonObject, sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

/**
 * The deadline for one case, and for the fixture the cases share. Every case
 * below drives a real connector process over a real loopback bridge, and the
 * two restart cases start a second one; the slowest measured about four
 * seconds on this machine. Change the deadline here, not per case.
 */
const CASE_TIMEOUT_MS = 30_000;

const EXTENSION_ID = "a".repeat(32);
const TOKEN = "program-scale-connector-token-".repeat(3);
const CANVAS_A_ORIGIN = "https://account-a.instructure.example";
const CANVAS_B_ORIGIN = "https://account-b.instructure.example";
const MOODLE_A_ORIGIN = "https://account-a.moodle.example";
const MOODLE_B_ORIGIN = "https://account-b.moodle.example";
const PRINCIPAL_A = "a".repeat(64);
const PRINCIPAL_B = "b".repeat(64);
const MOODLE_SNAPSHOT = "c".repeat(64);

const canvasCourses = Array.from({ length: 20 }, (_, index) => {
  const courseId = String(101 + index);
  const account = index < 10 ? "a" : "b";
  return {
    provider: "canvas" as const,
    account,
    courseId,
    sourceBindingId: `canvas:${account}:${courseId}`,
    learnerName: `Canvas ${account.toUpperCase()} Learner ${courseId}`,
    learnerEmail: `canvas-${account}-${courseId}@example.edu`,
  };
});

const moodleCourses = Array.from({ length: 20 }, (_, index) => {
  const courseId = String(201 + index);
  const account = index < 10 ? "a" : "b";
  return {
    provider: "moodle" as const,
    account,
    courseId,
    sourceBindingId: `moodle:${account}:${courseId}`,
    learnerName: `Moodle ${account.toUpperCase()} Learner ${courseId}`,
    learnerEmail: `moodle-${account}-${courseId}@example.edu`,
  };
});

const selectedCourses = [...canvasCourses, ...moodleCourses];

type SelectedCourse = typeof selectedCourses[number];
type FixtureState = {
  readonly commands: BridgeCommand[];
  readonly bindingsByCourse: ReadonlyMap<string, SelectedCourse>;
  readonly sourceBindingByCourse: ReadonlyMap<string, string>;
  activeReadCommands: number;
  maximumReadCommands: number;
  writeCommands: number;
  unknownNextWrite: boolean;
};

function root(): string {
  return resolve("../..");
}

function connectorConfig(directory: string, port: number) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "browser-session",
      label: "Shared browser connector fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [resolve(root(), "packages/canvas-connector-mcp/dist/index.js")],
      cwd: root(),
      env: {
        MORROW_CANVAS_CATALOG_PATH: resolve(root(), "artifacts/canvas-api/canvas-api-catalog.json"),
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN,
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID,
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
      learnerVaultPath: join(directory, "learner-vault.json"),
    },
    batchScheduler: { maxConcurrentReadWindows: 2 },
    maxCatalogTools: 2_000,
  });
}

function bindingFor(course: SelectedCourse, catalogDigest: string): JsonObject {
  const origin = course.provider === "canvas"
    ? (course.account === "a" ? CANVAS_A_ORIGIN : CANVAS_B_ORIGIN)
    : (course.account === "a" ? MOODLE_A_ORIGIN : MOODLE_B_ORIGIN);
  return {
    sourceBindingId: course.sourceBindingId,
    provider: course.provider,
    origin,
    ...(course.provider === "moodle" ? { siteUrl: `${origin}/campus/` } : {}),
    courseId: course.courseId,
    courseName: `${course.provider} ${course.account.toUpperCase()} course ${course.courseId}`,
    principalFingerprint: course.account === "a" ? PRINCIPAL_A : PRINCIPAL_B,
    sessionGeneration: 1,
    catalogDigest,
    editPolicyRevision: 0,
    runtimeVerified: true,
  };
}

function courseForCommand(command: BridgeCommand, state: FixtureState): SelectedCourse {
  const courseId = String(command.arguments.course_id || command.arguments.id || "");
  const course = state.bindingsByCourse.get(courseId);
  if (!course) throw new Error(`unexpected course ${courseId} for ${command.toolName}`);
  expect(command.sourceBindingId).toBe(course.sourceBindingId);
  return course;
}

function canvasResult(command: BridgeCommand, course: SelectedCourse): JsonObject {
  if (command.toolName === "canvas_list_users_in_course_users") {
    return {
      schema: "morrow.canvas-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data: [{ id: `learner-${course.sourceBindingId}`, name: course.learnerName, email: course.learnerEmail }],
    };
  }
  if (command.toolName === "canvas_get_single_course_courses") {
    return {
      schema: "morrow.canvas-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data: { id: course.courseId, name: `Canvas course ${course.courseId}` },
    };
  }
  if (command.toolName === "canvas_show_page_courses") {
    const body = `<p>${course.learnerName} (${course.learnerEmail}) can review this page.</p>`;
    return {
      schema: "morrow.canvas-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data: {
        page_id: `page-${course.courseId}`,
        url: String(command.arguments.url_or_id),
        title: `Canvas page ${course.courseId}`,
        body,
      },
      pageBodySha256: sha256Text(body),
    };
  }
  if (command.toolName === "canvas_add_course_to_favorites") {
    return {
      schema: "morrow.canvas-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data: { id: course.courseId, name: `Canvas course ${course.courseId}` },
      verification: {
        schema: "morrow.browser-verification.v1",
        status: "verified",
        strategy: "collection-contains-target",
        readTool: "canvas_list_favorite_courses",
        evidence: "fresh_readback_matches_requested_postcondition",
      },
    };
  }
  throw new Error(`unexpected Canvas command ${command.toolName}`);
}

function moodleResult(command: BridgeCommand, course: SelectedCourse, catalogDigest: string): JsonObject {
  const origin = course.account === "a" ? MOODLE_A_ORIGIN : MOODLE_B_ORIGIN;
  if (command.toolName === "moodle_get_course_participant_roster") {
    return {
      schema: "morrow.moodle-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data: {
        schema: "morrow.moodle-course-roster.v1",
        provider: "moodle",
        sourceBindingId: course.sourceBindingId,
        courseId: course.courseId,
        origin,
        siteUrl: `${origin}/campus/`,
        principalFingerprint: course.account === "a" ? PRINCIPAL_A : PRINCIPAL_B,
        sessionGeneration: 1,
        catalogDigest,
        status: "complete",
        complete: true,
        identities: [{ id: `learner-${course.sourceBindingId}`, name: course.learnerName, email: course.learnerEmail }],
        proof: {
          method: "core_table_get_dynamic_table_content",
          pageSize: 100,
          requestCount: 1,
          pageCount: 1,
          rowCount: 1,
          identityCount: 1,
        },
      },
      targets: [],
      snapshot_digest: MOODLE_SNAPSHOT,
    };
  }
  if (command.toolName === "moodle_get_course") {
    return {
      schema: "morrow.moodle-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data: { course_id: Number(course.courseId), fullname: `Moodle course ${course.courseId}` },
      targets: [],
      snapshot_digest: MOODLE_SNAPSHOT,
    };
  }
  if (command.toolName === "moodle_get_quiz_question") {
    return {
      schema: "morrow.moodle-browser-result.v1",
      ok: true,
      sent: true,
      status: 200,
      truncated: false,
      data: {
        course_id: Number(course.courseId),
        module_id: 8,
        slot_id: 9,
        qtype: "essay",
        name: `Question ${course.courseId}`,
        question_text: `<p>${course.learnerName} (${course.learnerEmail}) submits a reflection.</p>`,
        general_feedback: "Review the course evidence.",
      },
      targets: [],
      snapshot_digest: MOODLE_SNAPSHOT,
    };
  }
  throw new Error(`unexpected Moodle command ${command.toolName}`);
}

async function connectSharedBridge(port: number, state: FixtureState): Promise<BridgeTestClient> {
  const catalogDigest = bridgeCatalogDigestForTests(root());
  await assertPortListening(port);
  const bridge = await connectBridgeTestClient({
    port,
    token: TOKEN,
    extensionId: EXTENSION_ID,
    catalogDigest,
    bindings: selectedCourses.map((course) => bindingFor(course, catalogDigest)),
  });
  bridge.onCommand((command) => {
    state.commands.push(command);
    const course = courseForCommand(command, state);
    if (command.kind === "invoke_write") {
      state.writeCommands += 1;
      if (state.unknownNextWrite) {
        state.unknownNextWrite = false;
        // The extension disappears mid-write, so the ending is uncertain.
        bridge.socket.close();
        return;
      }
    } else {
      state.activeReadCommands += 1;
      state.maximumReadCommands = Math.max(state.maximumReadCommands, state.activeReadCommands);
    }
    const response = course.provider === "canvas"
      ? canvasResult(command, course)
      : moodleResult(command, course, catalogDigest);
    setTimeout(() => {
      try {
        bridge.respond(command, response);
      } finally {
        if (command.kind !== "invoke_write") state.activeReadCommands -= 1;
      }
    }, 8);
  });
  return bridge;
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

function createAuditOperation(course: SelectedCourse) {
  return {
    child_id: `audit:${course.sourceBindingId}`,
    course_id: course.courseId,
    tool: "morrow_audit_course",
    source_binding_id: course.sourceBindingId,
    arguments: course.provider === "canvas"
      ? {
        provider: "canvas",
        source_binding_id: course.sourceBindingId,
        course_id: course.courseId,
        target: { kind: "page", page_url: `scale-${course.courseId}` },
      }
      : {
        provider: "moodle",
        source_binding_id: course.sourceBindingId,
        course_id: Number(course.courseId),
        target: { kind: "quiz_question", module_id: 8, slot_id: 9 },
      },
  };
}

function batchInput(name: string, operations: readonly ReturnType<typeof createAuditOperation>[]) {
  const courseIds = operations.map((operation) => operation.course_id);
  const profileDigest = sha256Json({ schema: "morrow.program-scale.profile.v1", name });
  return {
    name,
    mode: "read_only",
    concurrency: 4,
    operation_family: "program-scale-proof",
    operations,
    course_set: {
      source: "explicit",
      course_ids: courseIds,
      complete: true,
      pagination_complete: true,
      snapshot_digest: sha256Json({ schema: "morrow.program-scale.selection.v1", courseIds }),
    },
    profile_digest: profileDigest,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

function runInput(batchId: string, batch: JsonObject, maxChildren: number) {
  const manifest = batch.manifest;
  if (!isJsonObject(manifest) || !isJsonObject(manifest.courseSet) || typeof manifest.courseSet.digest !== "string") {
    throw new Error("batch manifest did not include its course-set digest");
  }
  const profileDigest = typeof manifest.profileDigest === "string" ? manifest.profileDigest : "";
  return {
    batch_id: batchId,
    max_children: maxChildren,
    course_set_digest: manifest.courseSet.digest,
    profile_digest: profileDigest,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("expected bridge event did not occur");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

describe("program-scale runtime proof", () => {
  /**
   * One connector process, one bridge connection and forty course connections
   * serve every case below, the way one signed-in browser serves one program.
   * The cases run in file order and share that session, so each one inherits
   * what the case before it left: the finished forty-course group, the group a
   * person cancelled, and the write whose ending is uncertain. Two cases close
   * Morrow and open it again on purpose, and the runtime, bridge and assistant
   * they leave behind are the ones the cases after them use.
   */
  describe("forty selected courses in one browser session", () => {
    const state: FixtureState = {
      commands: [],
      bindingsByCourse: new Map(selectedCourses.map((course) => [course.courseId, course])),
      sourceBindingByCourse: new Map(selectedCourses.map((course) => [course.courseId, course.sourceBindingId])),
      activeReadCommands: 0,
      maximumReadCommands: 0,
      writeCommands: 0,
      unknownNextWrite: false,
    };
    let directory = "";
    let statePath = "";
    let keyPath = "";
    let port = 0;
    let runtime: MorrowRuntime;
    let bridge: BridgeTestClient;
    let assistantA: ConnectedAssistant | null = null;
    let assistantB: ConnectedAssistant | null = null;
    let assistantC: ConnectedAssistant | null = null;
    const clientA = (): Client => connectedClient(assistantA, "assistant A");
    const clientB = (): Client => connectedClient(assistantB, "assistant B");
    const clientC = (): Client => connectedClient(assistantC, "assistant C");
    /** The finished forty-course group the reading cases below read back. */
    let auditBatchId = "";
    /** The cancelled group, as the input that resumes it after a restart. */
    let cancellationInput: ReturnType<typeof runInput>;
    /** The write with the uncertain ending, as the input that resumes it. */
    let writeRunInput: ReturnType<typeof runInput>;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "morrow-program-scale-"));
      statePath = join(directory, "morrow.sqlite3");
      keyPath = join(directory, "batch.key");
      port = await reserveLoopbackPort();
      runtime = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      bridge = await connectSharedBridge(port, state);
      assistantA = await openClient(runtime, "program-scale-a");
      assistantB = await openClient(runtime, "program-scale-b");
      assistantC = await openClient(runtime, "program-scale-c");
    }, CASE_TIMEOUT_MS);

    afterAll(async () => {
      await closeAssistant(assistantC);
      await closeAssistant(assistantB);
      await closeAssistant(assistantA);
      await bridge?.close();
      await runtime?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    }, CASE_TIMEOUT_MS);

    it("runs forty exact Canvas and Moodle audits from three assistants at once", async () => {
      const prepared = structured(await clientA().callTool({
        name: "morrow_batch_create",
        arguments: batchInput("Forty selected courses", selectedCourses.map(createAuditOperation)),
      }));
      const batch = prepared.batch;
      if (!isJsonObject(batch) || typeof batch.batchId !== "string") throw new Error("batch creation did not return a batch id");
      auditBatchId = batch.batchId;
      const input = runInput(auditBatchId, prepared, 16);

      const windows = await Promise.all([
        clientA().callTool({ name: "morrow_batch_run", arguments: input }),
        clientB().callTool({ name: "morrow_batch_run", arguments: input }),
        clientC().callTool({ name: "morrow_batch_run", arguments: input }),
      ]);
      const processed = windows.map(structured).reduce((total, value) => total + Number(value.processed || 0), 0);
      expect(processed).toBe(40);
      const completedBatch = runtime.batchGet({ batchId: auditBatchId, limit: 50 });
      expect(completedBatch.batch).toMatchObject({
        state: "completed",
        totalChildren: 40,
        succeededChildren: 40,
        failedChildren: 0,
        unknownChildren: 0,
      });
      expect(state.maximumReadCommands).toBeGreaterThan(1);
      expect(state.maximumReadCommands).toBeLessThanOrEqual(4);
      const readCommands = state.commands.filter((command) => command.kind === "invoke_read");
      expect(readCommands.length).toBeGreaterThanOrEqual(120);
      for (const command of readCommands) {
        const course = courseForCommand(command, state);
        expect(command.sourceBindingId).toBe(state.sourceBindingByCourse.get(course.courseId));
      }
    }, CASE_TIMEOUT_MS);

    it("runs two read groups at once and keeps the reads inside the shared bridge budget", async () => {
      // Two clients run two read groups at once. Both finish, and the reads in flight stay inside
      // the bridge budget the frozen manifests share.
      state.maximumReadCommands = 0;
      const parallelPrepared = await Promise.all([
        clientA().callTool({
          name: "morrow_batch_create",
          arguments: batchInput("Canvas half of the parallel read", canvasCourses.slice(0, 8).map(createAuditOperation)),
        }),
        clientB().callTool({
          name: "morrow_batch_create",
          arguments: batchInput("Moodle half of the parallel read", moodleCourses.slice(0, 8).map(createAuditOperation)),
        }),
      ]);
      const parallelRuns = parallelPrepared.map((created) => {
        const prepared = structured(created);
        const preparedBatch = prepared.batch;
        if (!isJsonObject(preparedBatch) || typeof preparedBatch.batchId !== "string") {
          throw new Error("parallel batch creation did not return a batch id");
        }
        return { batchId: preparedBatch.batchId, input: runInput(preparedBatch.batchId, prepared, 8) };
      });
      const parallelClients = [clientA(), clientB()];
      const parallelResults = await Promise.all(parallelRuns.map((run, index) => parallelClients[index]!.callTool({
        name: "morrow_batch_run",
        arguments: run.input,
      })));
      for (const [index, result] of parallelResults.entries()) {
        expect(structured(result)).toMatchObject({ processed: 8 });
        expect(runtime.batchGet({ batchId: parallelRuns[index]!.batchId, limit: 8 }).batch).toMatchObject({
          state: "completed",
          totalChildren: 8,
          succeededChildren: 8,
          failedChildren: 0,
          unknownChildren: 0,
        });
      }
      // One frozen manifest allows four reads at once, so more than four proves the two groups
      // overlapped, and eight is the whole shared budget.
      expect(state.maximumReadCommands).toBeGreaterThan(4);
      expect(state.maximumReadCommands).toBeLessThanOrEqual(8);
      expect(runtime.batchScheduler.health()).toMatchObject({
        maxConcurrentReadWindows: 2,
        maxConcurrentWriteWindows: 1,
        maxConcurrentReadRequests: 8,
        activeReadWindows: 0,
        activeReadRequests: 0,
      });
    }, CASE_TIMEOUT_MS);

    it("keeps learner names and addresses out of the retained results and out of every assistant's page", async () => {
      const retained = selectedCourses.map((course) => runtime.batches.readResult(auditBatchId, `audit:${course.sourceBindingId}`));
      const retainedText = JSON.stringify(retained);
      for (const course of selectedCourses) {
        expect(retainedText).not.toContain(course.learnerName);
        expect(retainedText).not.toContain(course.learnerEmail);
      }
      expect(retainedText).not.toContain("Canvas A Learner");
      expect(retainedText).not.toContain("Moodle B Learner");

      for (const course of [canvasCourses[0]!, moodleCourses[19]!]) {
        const offset = selectedCourses.findIndex((candidate) => candidate.sourceBindingId === course.sourceBindingId);
        const page = structured(await clientB().callTool({
          name: "morrow_batch_results_page",
          arguments: { batch_id: auditBatchId, offset, limit: 1, result_child_id: `audit:${course.sourceBindingId}` },
        }));
        const egress = JSON.stringify(page);
        for (const secret of selectedCourses.flatMap((selected) => [selected.learnerName, selected.learnerEmail])) {
          expect(egress).not.toContain(secret);
        }
        expect(page.nativeAuditReport).toMatchObject({
          status: "available",
          childId: `audit:${course.sourceBindingId}`,
          report: { provider: course.provider, source_binding_id: course.sourceBindingId },
        });
      }
    }, CASE_TIMEOUT_MS);

    it("refuses an audit whose course connection belongs to another account, and asks the Bridge for nothing", async () => {
      const commandsBeforeMismatch = state.commands.length;
      const mismatched = await clientC().callTool({
        name: "morrow_audit_course",
        arguments: {
          provider: "canvas",
          source_binding_id: canvasCourses[10]!.sourceBindingId,
          course_id: canvasCourses[0]!.courseId,
          target: { kind: "page", page_url: "wrong-account" },
        },
      });
      expect(mismatched.isError).toBe(true);
      expect(state.commands).toHaveLength(commandsBeforeMismatch);
    }, CASE_TIMEOUT_MS);

    it("cancels a running group, keeps the children it already finished, and starts no more", async () => {
      const cancellationPrepared = structured(await clientB().callTool({
        name: "morrow_batch_create",
        arguments: batchInput("Cancelled selected subset", selectedCourses.slice(0, 8).map(createAuditOperation)),
      }));
      const cancellationBatch = cancellationPrepared.batch;
      if (!isJsonObject(cancellationBatch) || typeof cancellationBatch.batchId !== "string") throw new Error("cancellation batch id missing");
      const cancellationBatchId = cancellationBatch.batchId;
      cancellationInput = runInput(cancellationBatchId, cancellationPrepared, 4);
      structured(await clientA().callTool({ name: "morrow_batch_run", arguments: cancellationInput }));
      const cancelled = structured(await clientC().callTool({ name: "morrow_batch_cancel", arguments: { batch_id: cancellationBatchId } }));
      expect(cancelled.batch).toMatchObject({
        state: "partial",
        succeededChildren: 4,
        cancelledChildren: 4,
        pendingChildren: 0,
      });
    }, CASE_TIMEOUT_MS);

    it("keeps the cancelled group settled across a restart and repeats none of it", async () => {
      await closeAssistant(assistantC);
      assistantC = null;
      await closeAssistant(assistantB);
      assistantB = null;
      await closeAssistant(assistantA);
      assistantA = null;
      await bridge.close();
      await runtime.close();

      runtime = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      bridge = await connectSharedBridge(port, state);
      assistantA = await openClient(runtime, "program-scale-after-restart");
      const beforeResumeCommands = state.commands.length;
      const resumed = structured(await clientA().callTool({ name: "morrow_batch_resume", arguments: cancellationInput }));
      expect(resumed).toMatchObject({ processed: 0, batch: { state: "partial", succeededChildren: 4, cancelledChildren: 4 } });
      expect(state.commands).toHaveLength(beforeResumeCommands);
    }, CASE_TIMEOUT_MS);

    it("records a write with an uncertain ending, and refuses the next group aimed at the same course", async () => {
      const writeInput = {
        name: "Applied-or-unknown favorite",
        mode: "stage_writes",
        concurrency: 1,
        operation_family: "program-scale-write-proof",
        operations: [{
          child_id: "write:canvas:101",
          course_id: canvasCourses[0]!.courseId,
          tool: "canvas_add_course_to_favorites",
          source_binding_id: canvasCourses[0]!.sourceBindingId,
          arguments: { id: canvasCourses[0]!.courseId },
        }],
        course_set: {
          source: "explicit",
          course_ids: [canvasCourses[0]!.courseId],
          complete: true,
          pagination_complete: true,
          snapshot_digest: sha256Json({ schema: "morrow.program-scale.write-selection.v1", courseId: canvasCourses[0]!.courseId }),
        },
        profile_digest: sha256Json({ schema: "morrow.program-scale.write-profile.v1" }),
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
      const writePrepared = structured(await clientA().callTool({ name: "morrow_batch_create", arguments: writeInput }));
      const writeBatch = writePrepared.batch;
      if (!isJsonObject(writeBatch) || typeof writeBatch.batchId !== "string") throw new Error("write batch id missing");
      const writeBatchId = writeBatch.batchId;
      const conflicting = structured(await clientA().callTool({
        name: "morrow_batch_create",
        arguments: { ...writeInput, name: "Conflicting favorite target" },
      }));
      const conflictingBatch = conflicting.batch;
      if (!isJsonObject(conflictingBatch) || typeof conflictingBatch.batchId !== "string") throw new Error("conflicting batch id missing");
      const conflictingBatchId = conflictingBatch.batchId;

      runtime.approveBatch(writeBatchId);
      state.unknownNextWrite = true;
      writeRunInput = runInput(writeBatchId, writePrepared, 1);
      structured(await clientA().callTool({ name: "morrow_batch_run", arguments: writeRunInput }));
      expect(state.writeCommands).toBe(1);
      const writeChild = runtime.batchGet({ batchId: writeBatchId, limit: 1 }).children[0]!;
      expect(writeChild).toMatchObject({
        state: "failed",
        attemptCount: 1,
        gatewayOperationState: "applied_or_unknown",
      });

      runtime.approveBatch(conflictingBatchId);
      const conflictRunInput = runInput(conflictingBatchId, conflicting, 1);
      structured(await clientA().callTool({ name: "morrow_batch_run", arguments: conflictRunInput }));
      const conflictDetail = runtime.batchGet({ batchId: conflictingBatchId, limit: 1 });
      expect(conflictDetail).toMatchObject({
        batch: { state: "failed", failedChildren: 1 },
        children: [{ state: "failed", attemptCount: 1, gatewayOperationState: "approved" }],
      });
      const conflictOperationId = String((conflictDetail.children[0] as JsonObject).gatewayOperationId || "");
      expect(runtime.gateway.operationGet(conflictOperationId)).toMatchObject({
        state: "approved", dispatchAttempt: 0, attention: [],
      });
      expect(state.writeCommands).toBe(1);
    }, CASE_TIMEOUT_MS);

    it("keeps the uncertain write settled across a restart and sends it nowhere again", async () => {
      await bridge.closed();
      await closeAssistant(assistantA);
      assistantA = null;
      await runtime.close();

      runtime = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath, batchKeyPath: keyPath });
      bridge = await connectSharedBridge(port, state);
      assistantA = await openClient(runtime, "program-scale-unknown-recovery");
      const beforeUnknownResume = state.writeCommands;
      const unknownResume = structured(await clientA().callTool({ name: "morrow_batch_resume", arguments: writeRunInput }));
      expect(unknownResume).toMatchObject({ processed: 0, batch: { state: "failed", failedChildren: 1 } });
      expect(state.writeCommands).toBe(beforeUnknownResume);
    }, CASE_TIMEOUT_MS);
  });
});
