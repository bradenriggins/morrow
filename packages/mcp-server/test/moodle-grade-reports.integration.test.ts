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
const SOURCE_BINDING_ID = "moodle:grade-reports";
const PRINCIPAL_FINGERPRINT = "a".repeat(64);
const TOKEN = "moodle-grade-report-token-".repeat(3);
const EXTENSION_ID = "d".repeat(32);
const METHOD = "grade_report_grader_index";
const CAPABILITIES = ["gradereport/grader:view", "moodle/grade:viewall"];

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
  schema: "morrow.moodle-grade-report-summary.v1", provider: "moodle", course_id: 2,
  participant_count: 3, grade_item_count: 2,
  items: [
    { item_id: 200, kind: "item", graded_count: 3, ungraded_count: 0, unreadable_count: 0, percent_source: "percentage_display", statistics: { mean: "60-79", median: "60-79", minimum: "40-59", maximum: "80-100" }, statistics_unavailable: null },
    { item_id: 300, kind: "course_total", graded_count: 1, ungraded_count: 2, unreadable_count: 0, percent_source: "range_row", statistics: { mean: "60-79", median: "60-79", minimum: "60-79", maximum: "60-79" }, statistics_unavailable: null },
  ],
  proof: {
    method: METHOD, complete: true, required_capabilities: CAPABILITIES, participant_limit: 10_000,
    participant_response_rows: 3, grade_item_limit: 500, page_size: 3, page_request_limit: 500, page_request_count: 1,
  },
};

function reportData(userId: string) {
  return {
    schema: "morrow.moodle-learner-grade-report.v1", provider: "moodle", course_id: 2,
    learner: { user_id: userId }, grade_item_count: 2,
    items: [
      { item_id: 200, kind: "item", state: "graded", percent: 80, percent_source: "percentage_display" },
      { item_id: 300, kind: "course_total", state: "graded", percent: 70, percent_source: "range_row" },
    ],
    proof: {
      method: METHOD, complete: true, required_capabilities: CAPABILITIES, participant_limit: 10_000,
      grade_item_limit: 500, page_request_limit: 500, page_request_count: 1,
    },
  };
}

function result(command: BridgeCommand, digest: string, summaryCourseId: number): JsonObject {
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
  if (command.toolName === "moodle_get_grade_report_summary") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      ...summaryData,
      course_id: summaryCourseId,
      raw_rows: [{ user_id: 7, fullname: "Jane Moodle", email: "jane@example.edu", grades: ["80.00", "105.00"] }],
    },
    snapshot_digest: "e".repeat(64),
  };
  if (command.toolName === "moodle_get_learner_grade_report") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      ...reportData(String(command.arguments.user_id)),
      raw_cells: [{ item_id: 200, value: "80.00", feedback: "private feedback" }],
    },
    snapshot_digest: "e".repeat(64),
  };
  throw new Error(`unexpected source tool ${command.toolName}`);
}

describe("Moodle grade-report Full MCP exposure", () => {
  it("exposes an identity-free summary, tokenizes the learner report, and refuses an unknown identity", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-grade-reports-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    let summaryCourseId = 2;
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Gradebook course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command, digest, summaryCourseId));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-grade-reports", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_capability_read");
      for (const tool of ["moodle_get_grade_report_summary", "moodle_get_learner_grade_report"]) {
        expect(gateway.capabilityGet(tool)).toMatchObject({ descriptor: { canonicalName: tool, behavior: { readOnly: true } } });
      }

      const aggregate = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_grade_report_summary", arguments: { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const aggregateText = JSON.stringify(aggregate);
      expect(aggregate.isError, aggregateText).not.toBe(true);
      // The aggregate carries no identity and no grade value: only counts and bands.
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "Student Name", "80.00", "105.00", "raw_rows", "user_id", "learnerToken"]) {
        expect(aggregateText, `the summary leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(aggregate.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_grade_report_summary",
        data: {
          participant_count: 3, grade_item_count: 2,
          items: [
            { item_id: 200, graded_count: 3, ungraded_count: 0, statistics: { mean: "60-79", minimum: "40-59", maximum: "80-100" } },
            { item_id: 300, graded_count: 1, ungraded_count: 2, statistics: { mean: "60-79" } },
          ],
          proof: { required_capabilities: CAPABILITIES },
        },
      });

      const report = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_learner_grade_report", arguments: { course_id: 2, user_id: 7, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const reportText = JSON.stringify(report);
      expect(report.isError, reportText).not.toBe(true);
      for (const privateValue of ["Student Name", "Jane Moodle", "jane@example.edu", "private feedback", "raw_cells", "80.00", "user_id"]) {
        expect(reportText, `the learner report leaked ${privateValue}`).not.toContain(privateValue);
      }
      // Grade values reach an assistant only here, under this tool's own name,
      // and only for an identity the roster placed in this exact course.
      expect(report.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_learner_grade_report",
        data: {
          learner: { learnerToken: expect.stringMatching(/^learner_/) },
          grade_item_count: 2,
          items: [
            { item_id: 200, kind: "item", state: "graded", percent: 80, percent_source: "percentage_display" },
            { item_id: 300, kind: "course_total", state: "graded", percent: 70, percent_source: "range_row" },
          ],
        },
      });

      const unknown = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_learner_grade_report", arguments: { course_id: 2, user_id: 99, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const unknownText = JSON.stringify(unknown);
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toMatchObject({ schema: "morrow.result.v1", data: { schema: "morrow.problem.v1", code: "learner_roster_identity_unavailable" } });
      for (const privateValue of ["private feedback", "80.00", "percent"]) {
        expect(unknownText, `the refusal leaked ${privateValue}`).not.toContain(privateValue);
      }

      summaryCourseId = 5;
      const mismatch = await gateway.call("moodle_get_grade_report_summary", { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } });
      const mismatchText = JSON.stringify(mismatch);
      expect(mismatchText).toContain("moodle_grade_report_summary_invalid");
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "80.00", "105.00"]) {
        expect(mismatchText).not.toContain(privateValue);
      }

      // The refused learner report reads the roster twice: once in the dispatch
      // that fails closed, and once more when the MCP egress boundary re-derives
      // the learner scope for the problem result it returns instead.
      expect(commands.map((command) => command.toolName)).toEqual([
        "moodle_get_grade_report_summary",
        "moodle_get_learner_grade_report",
        "moodle_get_course_participant_roster",
        "moodle_get_learner_grade_report",
        "moodle_get_course_participant_roster",
        "moodle_get_course_participant_roster",
        "moodle_get_grade_report_summary",
      ]);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
