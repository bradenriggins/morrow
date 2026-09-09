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
const SOURCE_BINDING_ID = "moodle:assign-learner";
const PRINCIPAL_FINGERPRINT = "b".repeat(64);
const TOKEN = "moodle-assign-learner-token-".repeat(3);
const EXTENSION_ID = "d".repeat(32);
const STATUS_METHOD = "mod_assign_get_submission_status";
const LEARNER_NAME = "Student Name";
const PRIVATE_ESSAY = "Student Name wrote this essay about mitosis.";
const PRIVATE_COMMENT = "Good work Student Name, see the marked copy.";

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

function submissionData(userId: string) {
  return {
    schema: "morrow.moodle-assignment-submission.v1", provider: "moodle", course_id: 2, module_id: 8, assignment_id: 71,
    learner: { user_id: userId },
    attempt: { attempt_number: 1, status: "submitted", time_created: 1_700_000_000, time_modified: 1_700_000_600, time_started: 1_699_999_000 },
    grading_status: "readyforrelease", locked: false, graded: true, blind_marking: false, extension_due_date: null,
    submission_types: [
      { type: "file", has_content: true, file_count: 1 },
      { type: "onlinetext", has_content: true, file_count: 0 },
    ],
    // The file name is learner-authored, so it can carry the learner's own name.
    files: [{
      plugin_type: "file", area: "submission_files", file_name: `${LEARNER_NAME} essay.pdf`, file_path: "/",
      file_size: 18_321, mime_type: "application/pdf", time_modified: 1_700_000_600,
    }],
    proof: {
      method: STATUS_METHOD, complete: true, exact_module_binding: "course_modedit_form",
      required_capability: "mod/assign:viewgrades", submission_type_limit: 20, file_limit: 200,
      file_count: 1, includes_file_bytes: false,
    },
  };
}

function feedbackData(userId: string) {
  return {
    schema: "morrow.moodle-assignment-feedback.v1", provider: "moodle", course_id: 2, module_id: 8, assignment_id: 71,
    learner: { user_id: userId },
    grading_status: "readyforrelease", marking_workflow_state: "readyforrelease", graded: true,
    grade_value: 85, grade_attempt_number: 1, graded_date: 1_700_001_200,
    feedback_types: [
      { type: "comments", comment_present: true, file_count: 0 },
      { type: "file", comment_present: false, file_count: 1 },
    ],
    files: [{
      plugin_type: "file", area: "feedback_files", file_name: `marked-${LEARNER_NAME}.pdf`, file_path: "/",
      file_size: 4_096, mime_type: "application/pdf", time_modified: 1_700_001_200,
    }],
    proof: {
      method: STATUS_METHOD, complete: true, exact_module_binding: "course_modedit_form",
      required_capability: "mod/assign:grade", feedback_type_limit: 20, file_limit: 200,
      file_count: 1, includes_feedback_text: false, includes_file_bytes: false,
    },
  };
}

function result(command: BridgeCommand, digest: string): JsonObject {
  if (command.toolName === "moodle_get_course_participant_roster") return {
    schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
    data: {
      schema: "morrow.moodle-course-roster.v1", provider: "moodle", sourceBindingId: SOURCE_BINDING_ID, courseId: "2",
      origin: ORIGIN, siteUrl: SITE_URL, principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1,
      catalogDigest: digest, status: "complete", complete: true,
      identities: [{ id: "7", name: LEARNER_NAME }, { id: "3", name: "Course Teacher" }],
      proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 2, identityCount: 2 },
    },
    snapshot_digest: "d".repeat(64),
  };
  if (command.toolName === "moodle_get_course_participants") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      schema: "morrow.moodle-course-participants.v1", provider: "moodle", course_id: 2,
      participant_count: 1,
      participants: [{ user_id: "7", roles: ["Student"], enrolment_methods: ["Manual enrolments"] }],
      proof: {
        method: "core_table_get_dynamic_table_content", complete: true,
        required_capabilities: ["moodle/course:viewparticipants", "moodle/course:enrolreview"],
        participant_limit: 500, page_size: 100, page_request_limit: 5, page_request_count: 1, total_rows: 1,
      },
    },
    snapshot_digest: "c".repeat(64),
  };
  const userId = String(command.arguments.user_id);
  // The fixture adds the source fields a real Moodle response carries and the
  // projection must drop: submission text, feedback text, grader identity, file
  // URLs, and file bytes.
  if (command.toolName === "moodle_get_assignment_submission") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      ...submissionData(userId),
      submission_text: `<p>${PRIVATE_ESSAY}</p>`,
      raw_files: [{ fileurl: `${ORIGIN}/pluginfile.php/99/assignsubmission_file/submission_files/501/essay.pdf`, contents_base64: "JVBERi0xLjcKJUZJWFRVUkU=" }],
    },
    snapshot_digest: "e".repeat(64),
  };
  if (command.toolName === "moodle_get_assignment_feedback") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      ...feedbackData(userId),
      feedback_comment: `<p>${PRIVATE_COMMENT}</p>`,
      grader: 3,
      raw_files: [{ fileurl: `${ORIGIN}/pluginfile.php/99/assignfeedback_file/feedback_files/9/marked.pdf`, contents_base64: "JVBERi0xLjcKJUZFRURCQUNL" }],
    },
    snapshot_digest: "e".repeat(64),
  };
  throw new Error(`unexpected source tool ${command.toolName}`);
}

describe("Moodle Assignment learner read Full MCP exposure", () => {
  it("keeps readable current participant labels and refuses retained learner history before source reads", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-assign-learner-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Assignment course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command, digest));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-assign-learner", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_capability_read");
      for (const tool of ["moodle_get_assignment_submission", "moodle_get_assignment_feedback"]) {
        expect(gateway.capabilityGet(tool)).toMatchObject({ descriptor: { canonicalName: tool, behavior: { readOnly: true } } });
      }
      const participants = await client.callTool({ name: "morrow_capability_read", arguments: {
        name: "moodle_get_course_participants", arguments: { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } },
      } });
      expect(participants.isError, JSON.stringify(participants)).not.toBe(true);
      const learnerToken = (participants.structuredContent as { data: { participants: { learnerToken: string }[] } }).data.participants[0]!.learnerToken;
      expect(learnerToken).toMatch(/^Student A[1-9][0-9]*$/);
      const repeated = await client.callTool({ name: "morrow_capability_read", arguments: {
        name: "moodle_get_course_participants", arguments: { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } },
      } });
      expect(repeated.structuredContent).toMatchObject({ data: { participants: [{ learnerToken }] } });
      const beforeHistory = commands.length;
      for (const tool of ["moodle_get_assignment_submission", "moodle_get_assignment_feedback"]) {
        const args = { course_id: 2, module_id: 8, learner_token: learnerToken };
        const denied = await client.callTool({ name: "morrow_capability_read", arguments: {
          name: tool, arguments: { ...args, _morrow: { source_binding_id: SOURCE_BINDING_ID } },
        } });
        expect(denied.isError, JSON.stringify(denied)).toBe(true);
        expect(denied.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "privacy_moodle_history_dictionary_unavailable" });
        for (const identity of ["Jane Moodle", "jane@example.edu", "learnerToken", "user_id"]) expect(JSON.stringify(denied)).not.toContain(identity);
      }
      expect(commands.slice(beforeHistory).every((command) => command.toolName === "moodle_get_course_participant_roster")).toBe(true);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
