import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import { loadCanvasApiCatalog } from "@morrow/canvas-api-catalog";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { buildLocalCanvasConfig } from "../../client-config/src/index.js";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";

const ORIGIN = "https://moodle.example.edu";
const SITE_URL = `${ORIGIN}/campus/`;
const SOURCE_BINDING_ID = "moodle:quiz-attempt-detail";
const PRINCIPAL_FINGERPRINT = "b".repeat(64);
const TOKEN = "moodle-quiz-attempt-detail-token-".repeat(3);
const EXTENSION_ID = "d".repeat(32);
const AVOIDED_ROUTES = "/mod/quiz/attempt.php+/mod/quiz/review.php+/mod/quiz/reviewquestion.php";
const PRIVATE_RESPONSE = "the mitochondria is the powerhouse";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function browserCatalogDigest(root: string): string {
  const canvas = loadCanvasApiCatalog(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"));
  const canvasBrowser = createHash("sha256").update(readFileSync(resolve(root, "connector/extension/generated/canvas-browser-catalog.json"))).digest("hex");
  const moodle = createHash("sha256").update(readFileSync(resolve(root, "connector/extension/generated/moodle-browser-catalog.json"))).digest("hex");
  return createHash("sha256").update(`${canvas.catalogDigest}\n${canvasBrowser}\n${moodle}`).digest("hex");
}

function configuration(root: string, directory: string, port: number) {
  const generated = structuredClone(buildLocalCanvasConfig(root, process.execPath)) as { upstreams: Record<string, unknown>[]; operationJournal: Record<string, unknown>; privacy: Record<string, unknown> };
  const upstream = generated.upstreams[0];
  if (!upstream) throw new Error("browser upstream unavailable");
  return parseGatewayConfig({
    ...generated,
    upstreams: [{ ...upstream, env: { ...(upstream.env as Record<string, string>), MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"), MORROW_CANVAS_CONNECTOR_PORT: String(port), MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN, MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID } }],
    operationJournal: { ...generated.operationJournal, path: join(directory, "gateway.sqlite3") },
    privacy: { ...generated.privacy, learnerVaultPath: join(directory, "vault.json") },
  });
}

function attemptData(attemptId: number, userId: string) {
  return {
    schema: "morrow.moodle-quiz-attempt.v1", provider: "moodle", course_id: 2, module_id: 8, attempt_id: attemptId,
    state: "finished",
    started_display: "Monday, 1 September 2026, 10:04 AM",
    completed_display: "Monday, 1 September 2026, 10:31 AM",
    duration_display: "27 mins",
    slot_count: 2,
    slots: [
      { slot: 1, state: "correct", mark: 1, regraded: false },
      { slot: 2, state: "requiresgrading", mark: null, regraded: false },
    ],
    learner: { user_id: userId },
    proof: {
      method: "quiz_report_overview_page", route: "/mod/quiz/report.php?mode=overview", complete: true,
      exact_module_binding: "quiz_report_page", required_capability: "mod/quiz:viewreports",
      avoided_routes: AVOIDED_ROUTES, records_learner_state: false, records_report_viewed_event: true,
      sesskey_sent: false, page_size: 100, page_count: 1, row_count: 2, slot_limit: 100,
    },
  };
}

const queueData = {
  schema: "morrow.moodle-quiz-manual-grading-queue.v1", provider: "moodle", course_id: 2, module_id: 8,
  question_count: 2, needs_grading_count: 3, manually_graded_count: 3, response_count: 7,
  questions: [
    { slot: 2, question_id: 55, needs_grading: 3, manually_graded: 1, total: 5 },
    { slot: 4, question_id: 57, needs_grading: 0, manually_graded: 2, total: 2 },
  ],
  proof: {
    method: "quiz_report_grading_index", route: "/mod/quiz/report.php?mode=grading", complete: true,
    exact_module_binding: "quiz_report_page", required_capability: "mod/quiz:grade",
    avoided_routes: AVOIDED_ROUTES, records_learner_state: false, records_report_viewed_event: true,
    sesskey_sent: false, includes_automatically_graded: false, question_limit: 200, listed_question_rows: 2,
  },
};

const regradeData = {
  schema: "morrow.moodle-quiz-regrade-report.v1", provider: "moodle", course_id: 2, module_id: 8,
  regraded_attempt_count: 2, commit_pending: true,
  proof: {
    method: "quiz_report_overview_regraded_filter", route: "/mod/quiz/report.php?mode=overview&onlyregraded=1",
    complete: true, exact_module_binding: "quiz_report_page", required_capability: "mod/quiz:viewreports",
    regrade_capability_marker: "onlyregraded_filter", avoided_routes: AVOIDED_ROUTES,
    records_learner_state: false, records_report_viewed_event: true, sesskey_sent: false,
    regrade_parameter_sent: false, page_size: 100, page_count: 1, attempt_limit: 1000,
  },
};

function result(command: BridgeCommand, digest: string): JsonObject {
  if (command.toolName === "moodle_get_course_participant_roster") return {
    schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
    data: {
      schema: "morrow.moodle-course-roster.v1", provider: "moodle", sourceBindingId: SOURCE_BINDING_ID, courseId: "2",
      origin: ORIGIN, siteUrl: SITE_URL, principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1,
      catalogDigest: digest, status: "complete", complete: true,
      identities: [{ id: "7", name: "Jane Moodle" }, { id: "3", name: "Course Teacher" }],
      proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 2, identityCount: 2 },
    },
    snapshot_digest: "a".repeat(64),
  };
  const browser = (data: JsonObject): JsonObject => ({
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data, snapshot_digest: "e".repeat(64),
  });
  if (command.toolName === "moodle_get_quiz_attempt") {
    const attemptId = Number(command.arguments.attempt_id);
    return browser({
      ...attemptData(attemptId, attemptId === 41 ? "7" : "99"),
      // A real report row carries the learner name and the response the report
      // links to; neither may cross the MCP boundary.
      raw_row: { fullname: "Jane Moodle", email: "jane@example.edu", response: PRIVATE_RESPONSE },
    } as unknown as JsonObject);
  }
  if (command.toolName === "moodle_get_quiz_manual_grading_queue") {
    return browser({ ...queueData, raw_rows: [{ user_id: 7, fullname: "Jane Moodle", response: PRIVATE_RESPONSE }] } as unknown as JsonObject);
  }
  if (command.toolName === "moodle_get_quiz_regrade_report") {
    return browser({ ...regradeData, raw_attempts: [{ id: 51, fullname: "Jane Moodle" }] } as unknown as JsonObject);
  }
  throw new Error(`unexpected source tool ${command.toolName}`);
}

describe("Moodle Quiz attempt, manual grading and regrade Full MCP exposure", () => {
  it("tokenizes the one named learner, refuses an unknown identity, and keeps both aggregates learner-free", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-quiz-attempt-detail-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Quiz course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command, digest));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-quiz-attempt-detail", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_capability_read");
      for (const tool of ["moodle_get_quiz_attempt", "moodle_get_quiz_manual_grading_queue", "moodle_get_quiz_regrade_report"]) {
        expect(gateway.capabilityGet(tool)).toMatchObject({ descriptor: { canonicalName: tool, behavior: { readOnly: true } } });
      }
      const rosterReads = () => commands.filter((command) => command.toolName === "moodle_get_course_participant_roster").length;

      const record = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_quiz_attempt", arguments: { course_id: 2, module_id: 8, attempt_id: 41, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const recordText = JSON.stringify(record);
      expect(record.isError, recordText).not.toBe(true);
      for (const privateValue of ["Jane Moodle", "jane@example.edu", PRIVATE_RESPONSE, "user_id"]) {
        expect(recordText, `the attempt record leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(record.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_quiz_attempt",
        data: {
          learner: { learnerToken: expect.stringMatching(/^learner_/) },
          attempt_id: 41, state: "finished", slot_count: 2,
          slots: [
            { slot: 1, state: "correct", mark: 1, regraded: false },
            { slot: 2, state: "requiresgrading", mark: null, regraded: false },
          ],
          proof: { route: "/mod/quiz/report.php?mode=overview", avoided_routes: AVOIDED_ROUTES, records_learner_state: false },
        },
      });
      // The one named learner is projected through the complete course roster.
      expect(rosterReads()).toBeGreaterThan(0);

      const unknown = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_quiz_attempt", arguments: { course_id: 2, module_id: 8, attempt_id: 99, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toMatchObject({ schema: "morrow.result.v1", data: { schema: "morrow.problem.v1", code: "learner_roster_identity_unavailable" } });
      const unknownText = JSON.stringify(unknown);
      for (const privateValue of ["Jane Moodle", PRIVATE_RESPONSE, "\"99\""]) {
        expect(unknownText, `the refusal leaked ${privateValue}`).not.toContain(privateValue);
      }

      const beforeQueue = rosterReads();
      const queue = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_quiz_manual_grading_queue", arguments: { course_id: 2, module_id: 8, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const queueText = JSON.stringify(queue);
      expect(queue.isError, queueText).not.toBe(true);
      for (const privateValue of ["Jane Moodle", PRIVATE_RESPONSE, "user_id", "learnerToken"]) {
        expect(queueText, `the grading queue leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(queue.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_quiz_manual_grading_queue",
        data: {
          question_count: 2, needs_grading_count: 3, manually_graded_count: 3, response_count: 7,
          questions: [
            { slot: 2, question_id: 55, needs_grading: 3, manually_graded: 1, total: 5 },
            { slot: 4, question_id: 57, needs_grading: 0, manually_graded: 2, total: 2 },
          ],
          proof: { required_capability: "mod/quiz:grade", includes_automatically_graded: false },
        },
      });
      // An aggregate read names nobody, so it needs no roster.
      expect(rosterReads()).toBe(beforeQueue);

      const regrade = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_quiz_regrade_report", arguments: { course_id: 2, module_id: 8, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const regradeText = JSON.stringify(regrade);
      expect(regrade.isError, regradeText).not.toBe(true);
      for (const privateValue of ["Jane Moodle", "user_id", "learnerToken"]) {
        expect(regradeText, `the regrade report leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(regrade.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_quiz_regrade_report",
        data: {
          regraded_attempt_count: 2, commit_pending: true,
          proof: { regrade_capability_marker: "onlyregraded_filter", sesskey_sent: false, regrade_parameter_sent: false },
        },
      });
      expect(rosterReads()).toBe(beforeQueue);

      const mismatch = await gateway.call("moodle_get_quiz_attempt", { course_id: 2, module_id: 9, attempt_id: 41, _morrow: { source_binding_id: SOURCE_BINDING_ID } });
      const mismatchText = JSON.stringify(mismatch);
      expect(mismatchText).toContain("moodle_quiz_attempt_invalid");
      for (const privateValue of ["Jane Moodle", PRIVATE_RESPONSE]) {
        expect(mismatchText).not.toContain(privateValue);
      }

      expect([...new Set(commands.map((command) => command.toolName))].sort()).toEqual([
        "moodle_get_course_participant_roster",
        "moodle_get_quiz_attempt",
        "moodle_get_quiz_manual_grading_queue",
        "moodle_get_quiz_regrade_report",
      ]);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
