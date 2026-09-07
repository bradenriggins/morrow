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
const SOURCE_BINDING_ID = "moodle:course-reports";
const PRINCIPAL_FINGERPRINT = "a".repeat(64);
const TOKEN = "moodle-course-report-token-".repeat(3);
const EXTENSION_ID = "d".repeat(32);

// Values a Moodle report page carries that must never reach an assistant.
const PRIVATE_IP = "203.0.113.44";
const PRIVATE_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const PRIVATE_NAME = "Jane Learner";
const PRIVATE_EMAIL = "jane.learner@example.edu";
const PRIVATE_DESCRIPTION = "The user with id '9' viewed the course with id '2'.";

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

const activityReport = {
  schema: "morrow.moodle-course-activity-report.v1", provider: "moodle", course_id: 2,
  activity_count: 2, total_view_count: 12, unreadable_count: 0,
  activities: [
    { module_id: 77, modname: "quiz", view_count: 12 },
    { module_id: 78, modname: "assign", view_count: null },
  ],
  proof: {
    method: "report_outline_index", complete: true, required_capability: "report/outline:view",
    activity_limit: 500, response_byte_limit: 2 * 1024 * 1024, request_count: 1,
  },
};

const completionReport = {
  schema: "morrow.moodle-course-completion-report.v1", provider: "moodle", course_id: 2,
  participant_count: 3, activity_count: 1,
  activities: [{ module_id: 77, modname: "quiz", complete_count: 2, incomplete_count: 1, unreadable_count: 0 }],
  proof: {
    method: "report_progress_index", complete: true, required_capability: "report/progress:view",
    participant_limit: 5_000, activity_limit: 500, page_size: 2, page_request_limit: 200, page_request_count: 2,
  },
};

const logSummary = {
  schema: "morrow.moodle-course-log-summary.v1", provider: "moodle", course_id: 2,
  entry_count: 4, course_context_count: 1, other_context_count: 1,
  origin_counts: { web: 2, ws: 1, cli: 0, restore: 1, other: 0 },
  activity_counts: [{ module_id: 77, modname: "quiz", count: 2 }],
  proof: {
    method: "report_log_index", complete: true, required_capability: "report/log:view",
    entry_limit: 5_000, page_size: 3, page_request_limit: 50, page_request_count: 2,
    omitted_columns: ["time", "user", "related_user", "component", "event_name", "description", "ip_address", "user_agent"],
  },
};

const datesReport = {
  schema: "morrow.moodle-course-dates-report.v1", provider: "moodle", course_id: 2,
  first_month: "2026-09", last_month: "2026-10", months: 2,
  dated_entry_count: 3, course_event_count: 1, unattributed_activity_event_count: 0, skipped_event_count: 1,
  month_counts: [{ month: "2026-09", count: 2 }, { month: "2026-10", count: 1 }],
  activity_counts: [{ module_id: 77, modname: "quiz", count: 1 }, { module_id: 78, modname: "assign", count: 1 }],
  proof: {
    method: "core_calendar_get_calendar_monthly_view", complete: true, required_capability: null,
    access_rule: "course_calendar_visibility", event_limit: 2_000, month_limit: 12, request_count: 2,
  },
};

function participationReport(moduleId: number, participants: readonly JsonObject[]) {
  return {
    schema: "morrow.moodle-course-participation-report.v1", provider: "moodle", course_id: 2,
    module_id: moduleId, role_id: 5, action: "view", since_days: 30, time_from: 1_785_000_000,
    participant_count: participants.length,
    performed_count: participants.filter((entry) => Number(entry.action_count) > 0).length,
    not_performed_count: participants.filter((entry) => Number(entry.action_count) === 0).length,
    total_action_count: participants.reduce((sum, entry) => sum + Number(entry.action_count), 0),
    includes_participants: participants.length > 0,
    participants,
    proof: {
      method: "report_participation_index", complete: true, required_capability: "report/participation:view",
      participant_limit: 5_000, page_size: 2, page_request_limit: 100, page_request_count: 1,
    },
  };
}

/** A browser result that also carries the raw page values Morrow must not pass on. */
function browserResult(data: JsonObject): JsonObject {
  return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      ...data,
      raw_rows: [{ user_id: 9, fullname: PRIVATE_NAME, email: PRIVATE_EMAIL, ip: PRIVATE_IP, useragent: PRIVATE_AGENT, description: PRIVATE_DESCRIPTION }],
    },
    snapshot_digest: "e".repeat(64),
  };
}

let activityCourseId = 2;

function result(command: BridgeCommand, digest: string): JsonObject {
  if (command.toolName === "moodle_get_course_participant_roster") return {
    schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
    data: {
      schema: "morrow.moodle-course-roster.v1", provider: "moodle", sourceBindingId: SOURCE_BINDING_ID, courseId: "2",
      origin: ORIGIN, siteUrl: SITE_URL, principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1,
      catalogDigest: digest, status: "complete", complete: true,
      identities: [{ id: "9", name: PRIVATE_NAME }, { id: "10", name: "Sam Learner" }, { id: "3", name: "Course Teacher" }],
      proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 3, identityCount: 3 },
    },
    snapshot_digest: "d".repeat(64),
  };
  if (command.toolName === "moodle_get_course_activity_report") return browserResult({ ...activityReport, course_id: activityCourseId } as unknown as JsonObject);
  if (command.toolName === "moodle_get_course_completion_report") return browserResult(completionReport as unknown as JsonObject);
  if (command.toolName === "moodle_get_course_log_summary") return browserResult(logSummary as unknown as JsonObject);
  if (command.toolName === "moodle_get_course_dates_report") return browserResult(datesReport as unknown as JsonObject);
  if (command.toolName === "moodle_get_course_participation_report") {
    const moduleId = Number(command.arguments.module_id);
    if (command.arguments.include_participants !== true) return browserResult(participationReport(moduleId, []) as unknown as JsonObject);
    // Module 78 lists a person the complete course roster does not hold.
    const participants = moduleId === 78
      ? [{ user_id: "99", action_count: 4 }]
      : [{ user_id: "9", action_count: 3 }, { user_id: "10", action_count: 0 }];
    return browserResult(participationReport(moduleId, participants) as unknown as JsonObject);
  }
  throw new Error(`unexpected source tool ${command.toolName}`);
}

describe("Moodle course-report Full MCP exposure", () => {
  it("returns aggregates by default, tokenizes the named participation report, and lets no identity, IP address or user agent out", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-reports-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Reports course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command, digest));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-reports", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      for (const tool of [
        "moodle_get_course_activity_report",
        "moodle_get_course_participation_report",
        "moodle_get_course_completion_report",
        "moodle_get_course_log_summary",
        "moodle_get_course_dates_report",
      ]) {
        expect(gateway.capabilityGet(tool)).toMatchObject({ descriptor: { canonicalName: tool, behavior: { readOnly: true } } });
      }
      const read = (name: string, args: JsonObject) => client!.callTool({
        name: "morrow_capability_read",
        arguments: { name, arguments: { ...args, _morrow: { source_binding_id: SOURCE_BINDING_ID } } },
      });
      const leaked = ["raw_rows", PRIVATE_IP, PRIVATE_AGENT, PRIVATE_NAME, PRIVATE_EMAIL, PRIVATE_DESCRIPTION, "useragent", "\"ip\""];

      const activity = await read("moodle_get_course_activity_report", { course_id: 2 });
      const activityText = JSON.stringify(activity);
      expect(activity.isError, activityText).not.toBe(true);
      for (const value of leaked) expect(activityText, `the activity report leaked ${value}`).not.toContain(value);
      expect(activity.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_course_activity_report",
        data: { total_view_count: 12, activities: [{ module_id: 77, view_count: 12 }, { module_id: 78, view_count: null }] },
      });

      const completion = await read("moodle_get_course_completion_report", { course_id: 2 });
      const completionText = JSON.stringify(completion);
      expect(completion.isError, completionText).not.toBe(true);
      for (const value of leaked) expect(completionText, `the completion report leaked ${value}`).not.toContain(value);
      expect(completion.structuredContent).toMatchObject({
        data: { participant_count: 3, activities: [{ module_id: 77, complete_count: 2, incomplete_count: 1 }] },
      });

      const log = await read("moodle_get_course_log_summary", { course_id: 2 });
      const logText = JSON.stringify(log);
      expect(log.isError, logText).not.toBe(true);
      for (const value of leaked) expect(logText, `the log summary leaked ${value}`).not.toContain(value);
      expect(log.structuredContent).toMatchObject({
        data: {
          entry_count: 4,
          origin_counts: { web: 2, ws: 1 },
          proof: { omitted_columns: ["time", "user", "related_user", "component", "event_name", "description", "ip_address", "user_agent"] },
        },
      });

      const dates = await read("moodle_get_course_dates_report", { course_id: 2, year: 2026, month: 9, months: 2 });
      const datesText = JSON.stringify(dates);
      expect(dates.isError, datesText).not.toBe(true);
      for (const value of leaked) expect(datesText, `the dates report leaked ${value}`).not.toContain(value);
      expect(dates.structuredContent).toMatchObject({
        data: {
          dated_entry_count: 3, course_event_count: 1, skipped_event_count: 1,
          month_counts: [{ month: "2026-09", count: 2 }, { month: "2026-10", count: 1 }],
          activity_counts: [{ module_id: 77, count: 1 }, { module_id: 78, count: 1 }],
        },
      });

      // The default participation report names nobody, and reads no roster.
      const beforeAggregate = commands.length;
      const aggregate = await read("moodle_get_course_participation_report", { course_id: 2, module_id: 77, action: "view", since_days: 30 });
      const aggregateText = JSON.stringify(aggregate);
      expect(aggregate.isError, aggregateText).not.toBe(true);
      for (const value of [...leaked, "learnerToken", "user_id"]) {
        expect(aggregateText, `the aggregate participation report leaked ${value}`).not.toContain(value);
      }
      expect(aggregate.structuredContent).toMatchObject({ data: { includes_participants: false, participants: [] } });
      expect(commands.slice(beforeAggregate).map((command) => command.toolName)).toEqual(["moodle_get_course_participation_report"]);

      // Asking for the people it counted is its own request, and every identity
      // comes back as a vault token the roster resolved.
      const named = await read("moodle_get_course_participation_report", { course_id: 2, module_id: 77, action: "view", since_days: 30, include_participants: true });
      const namedText = JSON.stringify(named);
      expect(named.isError, namedText).not.toBe(true);
      for (const value of leaked) expect(namedText, `the named participation report leaked ${value}`).not.toContain(value);
      expect(namedText).not.toContain("\"user_id\"");
      expect(named.structuredContent).toMatchObject({
        data: {
          includes_participants: true,
          participants: [
            { learnerToken: expect.stringMatching(/^learner_/), action_count: 3 },
            { learnerToken: expect.stringMatching(/^learner_/), action_count: 0 },
          ],
        },
      });

      // One person the complete roster cannot place in this course fails the
      // whole report closed. No count for anybody is returned.
      const unknown = await read("moodle_get_course_participation_report", { course_id: 2, module_id: 78, action: "view", since_days: 30, include_participants: true });
      const unknownText = JSON.stringify(unknown);
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toMatchObject({ schema: "morrow.result.v1", data: { schema: "morrow.problem.v1", code: "learner_roster_identity_unavailable" } });
      for (const value of [...leaked, "action_count", "\"99\""]) {
        expect(unknownText, `the refusal leaked ${value}`).not.toContain(value);
      }

      // A browser result that names another course is refused before it is
      // projected, and the refusal carries none of the page's raw values.
      activityCourseId = 5;
      const mismatch = await gateway.call("moodle_get_course_activity_report", { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } });
      const mismatchText = JSON.stringify(mismatch);
      expect(mismatchText).toContain("moodle_course_activity_report_invalid");
      for (const value of leaked) expect(mismatchText, `the refusal leaked ${value}`).not.toContain(value);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
