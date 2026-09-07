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
const SOURCE_BINDING_ID = "moodle:scorm-reports";
const PRINCIPAL_FINGERPRINT = "f".repeat(64);
const TOKEN = "moodle-scorm-report-token-".repeat(3);
const EXTENSION_ID = "c".repeat(32);
const SUMMARY_METHOD = "core_table_get_dynamic_table_content+mod_scorm_get_scorm_scoes+mod_scorm_get_scorm_attempt_count+mod_scorm_get_scorm_sco_tracks";
const REPORT_METHOD = "mod_scorm_get_scorm_scoes+mod_scorm_get_scorm_attempt_count+mod_scorm_get_scorm_sco_tracks";

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

const summaryData = {
  schema: "morrow.moodle-scorm-attempt-summary.v1", provider: "moodle", course_id: 2, module_id: 8, scorm_id: 71,
  participant_count: 2, attempted_participant_count: 2, total_attempt_count: 3, tracked_sco_count: 2, tracked_record_count: 6,
  sco_status_counts: { passed: 1, completed: 1, failed: 1, incomplete: 1, browsed: 1, notattempted: 1, unknown: 0 },
  score_bucket_counts: { "0-19": 0, "20-39": 1, "40-59": 1, "60-79": 1, "80-100": 1, unscored: 2 },
  proof: {
    method: SUMMARY_METHOD, complete: true, exact_module_binding: "course_modedit_form",
    required_capability: "mod/scorm:viewreport", participant_limit: 10_000, participant_response_rows: 2,
    sco_limit: 200, per_participant_attempt_limit: 50, total_attempt_limit: 5_000,
    track_request_limit: 2_000, track_request_count: 6,
  },
};

function reportData(userId: string) {
  return {
    schema: "morrow.moodle-scorm-learner-report.v1", provider: "moodle", course_id: 2, module_id: 8, scorm_id: 71,
    learner: { user_id: userId }, attempt_count: 1, tracked_sco_count: 2,
    attempts: [{ attempt: 1, records: [{ sco_id: 31, status: "completed", score_percent: 90 }, { sco_id: 33, status: "incomplete", score_percent: null }] }],
    proof: {
      method: REPORT_METHOD, complete: true, exact_module_binding: "course_modedit_form",
      required_capability: "mod/scorm:viewreport", attempt_limit: 50, sco_limit: 200,
      track_request_limit: 500, track_request_count: 2,
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
      identities: [{ id: "7", name: "Student Name" }, { id: "3", name: "Course Teacher" }],
      proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 2, identityCount: 2 },
    },
    snapshot_digest: "d".repeat(64),
  };
  if (command.toolName === "moodle_get_scorm_attempt_summary") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      ...summaryData,
      raw_roster: [{ id: 7, fullname: "Jane Moodle", email: "jane@example.edu" }],
      raw_tracks: [{ element: "cmi.core.student_name", value: "Moodle, Jane" }, { element: "cmi.suspend_data", value: "private suspend data" }],
    },
    snapshot_digest: "e".repeat(64),
  };
  if (command.toolName === "moodle_get_scorm_learner_report") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      ...reportData(String(command.arguments.user_id)),
      raw_tracks: [{ element: "cmi.core.student_name", value: "Moodle, Jane" }, { element: "cmi.suspend_data", value: "private suspend data" }],
    },
    snapshot_digest: "e".repeat(64),
  };
  throw new Error(`unexpected source tool ${command.toolName}`);
}

describe("Moodle SCORM report Full MCP exposure", () => {
  it("exposes both reads, refuses an unknown roster identity, and refuses a module mismatch", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-scorm-reports-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "SCORM course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command, digest));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-scorm-reports", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_capability_read");
      for (const tool of ["moodle_get_scorm_attempt_summary", "moodle_get_scorm_learner_report"]) {
        expect(gateway.capabilityGet(tool)).toMatchObject({ descriptor: { canonicalName: tool, behavior: { readOnly: true } } });
      }

      const aggregate = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_scorm_attempt_summary", arguments: { course_id: 2, module_id: 8, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const aggregateText = JSON.stringify(aggregate);
      expect(aggregate.isError, aggregateText).not.toBe(true);
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "Moodle, Jane", "private suspend data", "cmi.", "user_id"]) {
        expect(aggregateText, `aggregate leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(aggregate.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_scorm_attempt_summary",
        data: {
          participant_count: 2, total_attempt_count: 3, tracked_record_count: 6,
          sco_status_counts: { passed: 1, completed: 1, failed: 1, incomplete: 1, browsed: 1, notattempted: 1, unknown: 0 },
          score_bucket_counts: { "0-19": 0, "20-39": 1, "40-59": 1, "60-79": 1, "80-100": 1, unscored: 2 },
        },
      });

      const report = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_scorm_learner_report", arguments: { course_id: 2, module_id: 8, user_id: 7, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const reportText = JSON.stringify(report);
      expect(report.isError, reportText).not.toBe(true);
      for (const privateValue of ["Student Name", "Jane Moodle", "Moodle, Jane", "jane@example.edu", "private suspend data", "user_id"]) {
        expect(reportText, `learner report leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(report.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_scorm_learner_report",
        data: {
          learner: { learnerToken: expect.stringMatching(/^learner_/) },
          attempt_count: 1, tracked_sco_count: 2,
          attempts: [{ attempt: 1, records: [{ sco_id: 31, status: "completed", score_percent: 90 }, { sco_id: 33, status: "incomplete", score_percent: null }] }],
        },
      });

      const unknown = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_scorm_learner_report", arguments: { course_id: 2, module_id: 8, user_id: 99, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toMatchObject({ schema: "morrow.result.v1", data: { schema: "morrow.problem.v1", code: "learner_roster_identity_unavailable" } });
      expect(JSON.stringify(unknown)).not.toContain("private suspend data");

      const mismatch = await gateway.call("moodle_get_scorm_attempt_summary", { course_id: 2, module_id: 9, _morrow: { source_binding_id: SOURCE_BINDING_ID } });
      const mismatchText = JSON.stringify(mismatch);
      expect(mismatchText).toContain("moodle_scorm_attempt_summary_invalid");
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "private suspend data"]) {
        expect(mismatchText).not.toContain(privateValue);
      }

      // The refused learner report reads the roster twice: once in the dispatch
      // that fails closed, and once more when the MCP egress boundary re-derives
      // the learner scope for the problem result it returns instead.
      expect(commands.map((command) => command.toolName)).toEqual([
        "moodle_get_scorm_attempt_summary",
        "moodle_get_scorm_learner_report",
        "moodle_get_course_participant_roster",
        "moodle_get_scorm_learner_report",
        "moodle_get_course_participant_roster",
        "moodle_get_course_participant_roster",
        "moodle_get_scorm_attempt_summary",
      ]);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
