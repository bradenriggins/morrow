import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { buildLocalCanvasConfig } from "../../client-config/src/index.js";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";

const ORIGIN = "https://canvas.example.edu";
const SITE_URL = `${ORIGIN}/courses/2`;
const SOURCE_BINDING_ID = "canvas:course-summaries";
const PRINCIPAL_FINGERPRINT = "c".repeat(64);
const TOKEN = "canvas-course-summary-token-".repeat(4);
const EXTENSION_ID = "a".repeat(32);

/** The learner fields a compromised or stale browser result might attach. */
const PRIVATE_ROWS = [{
  id: 71, user_id: 91, name: "Jane Canvas", email: "jane@example.edu", score: 100,
  comments: "private grading comment", attachment: "private-essay.pdf", validation_token: "private-token",
}];

const ASSIGNMENT_SUMMARY = {
  schema: "morrow.canvas-assignment-submission-summary.v1", provider: "canvas", course_id: 2, assignment_id: 8,
  submission_count: 5, workflow_state_counts: { unsubmitted: 1, submitted: 1, graded: 2, pending_review: 1 },
  late_count: 1, missing_count: 1, excused_count: 1, needs_grading_count: 3,
  proof: {
    method: "GET /api/v1/courses/:course_id/assignments/:assignment_id/submissions",
    complete: true, pagination_complete: true, pages_read: 2, response_row_count: 5,
    needs_grading_count_source: "assignment_record",
  },
  raw_rows: PRIVATE_ROWS,
};

const GRADEBOOK_ASSIGNMENTS = [
  {
    assignment_id: 11, submitted_count: 2, graded_count: 10, ungraded_count: 3, scored_count: 10,
    score_distribution_state: "reported",
    score_distribution: { below_60: 0, "60_to_69": 0, "70_to_79": 0, "80_to_89": 0, "90_and_above": 10 },
  },
  {
    assignment_id: 12, submitted_count: 0, graded_count: 3, ungraded_count: 0, scored_count: 3,
    score_distribution_state: "suppressed_cohort_below_minimum", score_distribution: null,
  },
];

const GRADEBOOK_SUMMARY = {
  schema: "morrow.canvas-course-gradebook-summary.v1", provider: "canvas", course_id: 2,
  assignment_count: 2, submission_count: 25, minimum_cohort: 5, assignments: GRADEBOOK_ASSIGNMENTS,
  proof: {
    method: "GET /api/v1/courses/:course_id/students/submissions",
    complete: true, pagination_complete: true, assignment_pages_read: 1, submission_pages_read: 2,
    response_row_count: 25, ungraded_definition: "submitted_and_pending_review",
    score_scale: "percentage_of_points_possible", minimum_bucket_population: 5,
  },
  raw_rows: PRIVATE_ROWS,
};

const ACTIVITY_SUMMARY = {
  schema: "morrow.canvas-course-activity-summary.v1", provider: "canvas", course_id: 2,
  window_days: 7, window_start: "2026-09-01T00:00:00.000Z",
  kinds: {
    pages: { state: "counted", changed_count: 2, item_count: 3 },
    assignments: { state: "counted", changed_count: 2, item_count: 4 },
    discussions: { state: "counted", changed_count: 1, item_count: 2 },
    quizzes: { state: "timestamp_unavailable", changed_count: null, item_count: 2 },
    modules: { state: "counted", changed_count: 1, item_count: 1 },
  },
  proof: {
    method: "GET /api/v1/courses/:course_id/{pages,assignments,discussion_topics,quizzes,modules}",
    complete: true, pagination_complete: true, pages_read: 5, timestamp_field: "updated_at",
    item_limit_per_kind: 2_000,
  },
  raw_rows: PRIVATE_ROWS,
};

const SUMMARIES: Readonly<Record<string, JsonObject>> = {
  canvas_get_assignment_submission_summary: ASSIGNMENT_SUMMARY,
  canvas_get_course_gradebook_summary: GRADEBOOK_SUMMARY,
  canvas_get_course_activity_summary: ACTIVITY_SUMMARY,
};

const OPERATIONS: Readonly<Record<string, string>> = {
  canvas_get_assignment_submission_summary: "canvas.api.v1.course.assignment.submissions.aggregate.read.v1",
  canvas_get_course_gradebook_summary: "canvas.api.v1.course.gradebook.aggregate.read.v1",
  canvas_get_course_activity_summary: "canvas.api.v1.course.activity.aggregate.read.v1",
};

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function configuration(root: string, directory: string, port: number) {
  const generated = structuredClone(buildLocalCanvasConfig(root, process.execPath)) as { upstreams: Record<string, unknown>[]; operationJournal: Record<string, unknown>; privacy: Record<string, unknown> };
  const upstream = generated.upstreams[0];
  if (!upstream) throw new Error("browser upstream unavailable");
  return parseGatewayConfig({
    ...generated,
    // The full tool surface registers each catalog capability as its own MCP
    // tool, so listTools() shows whether these reads are reachable by name.
    toolSurface: "full",
    upstreams: [{ ...upstream, env: { ...(upstream.env as Record<string, string>), MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"), MORROW_CANVAS_CONNECTOR_PORT: String(port), MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN, MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID } }],
    operationJournal: { ...generated.operationJournal, path: join(directory, "gateway.sqlite3") },
    privacy: { ...generated.privacy, learnerVaultPath: join(directory, "vault.json") },
  });
}

function result(command: BridgeCommand, override?: JsonObject): JsonObject {
  const summary = SUMMARIES[command.toolName];
  if (!summary || command.operationKey !== OPERATIONS[command.toolName]) {
    throw new Error(`unexpected source tool ${command.toolName}`);
  }
  return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "canvas", complete: true,
    data: override ?? summary,
    snapshot_digest: "d".repeat(64),
  };
}

describe("Canvas course-summary Full MCP exposure", () => {
  it("publishes three aggregate-only reads and never a learner row", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-course-summaries-integration-")); const port = await availablePort();
    const digest = bridgeCatalogDigestForTests(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    let override: JsonObject | undefined;
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "canvas", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Private Canvas course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command, override));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-canvas-course-summaries", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      const listed = (await client.listTools()).tools;
      for (const name of Object.keys(SUMMARIES)) {
        expect(listed.map((tool) => tool.name)).toContain(name);
        expect(listed.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
        expect(gateway.capabilityGet(name)).toMatchObject({ descriptor: { canonicalName: name, behavior: { readOnly: true } } });
      }

      const assignment = await client.callTool({ name: "morrow_capability_read", arguments: { name: "canvas_get_assignment_submission_summary", arguments: { course_id: 2, assignment_id: 8, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const assignmentText = JSON.stringify(assignment);
      expect(assignment.isError, assignmentText).not.toBe(true);
      expect(assignment.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "canvas_get_assignment_submission_summary",
        data: {
          schema: "morrow.canvas-assignment-submission-summary.v1", course_id: 2, assignment_id: 8, submission_count: 5,
          workflow_state_counts: { unsubmitted: 1, submitted: 1, graded: 2, pending_review: 1 },
          late_count: 1, missing_count: 1, excused_count: 1, needs_grading_count: 3,
          proof: { needs_grading_count_source: "assignment_record", pages_read: 2 },
        },
      });

      const gradebook = await client.callTool({ name: "morrow_capability_read", arguments: { name: "canvas_get_course_gradebook_summary", arguments: { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const gradebookText = JSON.stringify(gradebook);
      expect(gradebook.isError, gradebookText).not.toBe(true);
      const gradebookData = (gradebook.structuredContent as { data: { assignments: JsonObject[] } }).data;
      expect(gradebookData.assignments).toEqual(GRADEBOOK_ASSIGNMENTS);
      expect(gradebookData.assignments[1]).toMatchObject({ score_distribution_state: "suppressed_cohort_below_minimum", score_distribution: null });

      const activity = await client.callTool({ name: "morrow_capability_read", arguments: { name: "canvas_get_course_activity_summary", arguments: { course_id: 2, days: 7, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const activityText = JSON.stringify(activity);
      expect(activity.isError, activityText).not.toBe(true);
      expect((activity.structuredContent as { data: JsonObject }).data).toMatchObject({
        window_days: 7,
        kinds: { quizzes: { state: "timestamp_unavailable", changed_count: null, item_count: 2 } },
      });

      for (const text of [assignmentText, gradebookText, activityText]) {
        for (const privateValue of ["Jane Canvas", "jane@example.edu", "private grading comment", "private-essay.pdf", "private-token", '"user_id":91', '"id":71', '"score":100', "raw_rows"]) {
          expect(text, `result leaked ${privateValue}`).not.toContain(privateValue);
        }
      }
      expect(commands.map((command) => command.toolName)).toEqual([
        "canvas_get_assignment_submission_summary", "canvas_get_course_gradebook_summary", "canvas_get_course_activity_summary",
      ]);

      // A distribution thinner than the minimum bucket population is refused at
      // this boundary too, so a source that skipped suppression cannot publish
      // a band that identifies one learner's score.
      override = {
        ...GRADEBOOK_SUMMARY,
        assignments: [{
          assignment_id: 11, submitted_count: 2, graded_count: 10, ungraded_count: 3, scored_count: 10,
          score_distribution_state: "reported",
          score_distribution: { below_60: 1, "60_to_69": 0, "70_to_79": 0, "80_to_89": 0, "90_and_above": 9 },
        }],
        assignment_count: 1,
      } as unknown as JsonObject;
      const thin = await gateway.call("canvas_get_course_gradebook_summary", { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } });
      const thinText = JSON.stringify(thin);
      expect(thin.isError).toBe(true);
      expect(thinText).toContain("privacy_output_refused");
      for (const privateValue of ["Jane Canvas", "private grading comment", '"below_60":1', '"90_and_above":9', "score_distribution"]) {
        expect(thinText, `refusal leaked ${privateValue}`).not.toContain(privateValue);
      }

      // A source result for a different assignment is refused rather than relabelled.
      override = undefined;
      const mismatched = await gateway.call("canvas_get_assignment_submission_summary", { course_id: 2, assignment_id: 9, _morrow: { source_binding_id: SOURCE_BINDING_ID } });
      const mismatchedText = JSON.stringify(mismatched);
      expect(mismatched.isError).toBe(true);
      expect(mismatchedText).toContain("privacy_output_refused");
      expect(mismatchedText).not.toContain("submission_count");

      const disallowed = await client.callTool({ name: "morrow_capability_read", arguments: { name: "canvas_get_course_gradebook_summary", arguments: { course_id: 2, _morrow: { source_binding_id: "canvas:wrong-course" } } } });
      expect(disallowed.isError).toBe(true);
      expect(commands).toHaveLength(5);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
