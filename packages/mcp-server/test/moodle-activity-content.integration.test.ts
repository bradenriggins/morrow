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
const SOURCE_BINDING_ID = "moodle:activity-content";
const PRINCIPAL_FINGERPRINT = "d".repeat(64);
const TOKEN = "moodle-activity-content-token-".repeat(3);
const EXTENSION_ID = "b".repeat(32);
const LEARNER_NAME = "Jane Moodle";
const LEARNER_EMAIL = "jane@example.edu";
const PRIVATE_VALUES = [LEARNER_NAME, LEARNER_EMAIL, '"user_id"', '"userid":7', "Rowan Moodle"];

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

function browserResult(data: JsonObject): JsonObject {
  return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data, snapshot_digest: "e".repeat(64),
  };
}

/**
 * The runtime reads the current participant roster before it returns safe
 * course-authored Choice content. The roster cannot authorize historical
 * learner participation routes.
 */
function roster(catalogDigest: string): JsonObject {
  return {
    schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
    data: {
      schema: "morrow.moodle-course-roster.v1", provider: "moodle", sourceBindingId: SOURCE_BINDING_ID,
      courseId: "2", origin: ORIGIN, siteUrl: SITE_URL, principalFingerprint: PRINCIPAL_FINGERPRINT,
      sessionGeneration: 1, catalogDigest, status: "complete", complete: true,
      identities: [{ id: "student-2", name: LEARNER_NAME }],
      proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 1, identityCount: 1 },
    },
    snapshot_digest: "f".repeat(64),
  };
}

/**
 * The browser answers with the aggregate the page builds, plus learner rows the
 * page never produces. Only the course-authored Choice projection may leave the
 * gateway. Database and Feedback participation routes fail before dispatch.
 */
function result(command: BridgeCommand, catalogDigest: string): JsonObject {
  if (command.toolName === "moodle_get_course_participant_roster") return roster(catalogDigest);
  const moduleId = Number((command.arguments as { module_id?: unknown } | undefined)?.module_id);
  if (command.toolName === "moodle_get_choice_options") {
    return browserResult({
      schema: "morrow.moodle-choice-options.v1", provider: "moodle", course_id: 2, module_id: moduleId, choice_id: 21,
      option_count: 2,
      options: [
        { option_id: 41, position: 1, text: "Morning lab", response_limit: 12, chosen_by: [LEARNER_NAME] },
        { option_id: 42, position: 2, text: "Evening lab", response_limit: 0 },
      ],
      limit_answers: true, allow_multiple: false, has_responses: true,
      respondents: [{ userid: 7, fullname: LEARNER_NAME, email: LEARNER_EMAIL }],
      proof: {
        method: "course_modedit_form", complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "moodle/course:manageactivities", option_limit: 100, option_rows: 2, text_limit: 4000,
      },
    });
  }
  if (command.toolName === "moodle_get_database_entry_summary") {
    return browserResult({
      schema: "morrow.moodle-database-entry-summary.v1", provider: "moodle", course_id: 2, module_id: moduleId, database_id: 31,
      entry_count: 7, entries_awaiting_approval: 2, comment_count: 3, approval_required: true,
      raw_entries: [{ id: 91, userid: 7, fullname: LEARNER_NAME, content: "private entry" }],
      proof: {
        method: "course_modedit_form+core_courseformat_get_overview_information", complete: true,
        exact_module_binding: "course_modedit_form", required_capability: "mod/data:approve",
        activity_limit: 500, activity_rows: 2, overview_item_key: "totalentries",
      },
    });
  }
  if (command.toolName === "moodle_get_feedback_response_summary") {
    const anonymous = moduleId === 9;
    return browserResult({
      schema: "morrow.moodle-feedback-response-summary.v1", provider: "moodle", course_id: 2, module_id: moduleId, feedback_id: 22,
      anonymous, response_count: 5,
      per_learner_projection: anonymous ? "refused_anonymous" : "not_supported",
      respondents: [{ userid: 7, fullname: LEARNER_NAME, email: LEARNER_EMAIL, answer: "private answer" }],
      proof: {
        method: "course_modedit_form+core_courseformat_get_overview_information", complete: true,
        exact_module_binding: "course_modedit_form", required_capability: "mod/feedback:viewreports",
        activity_limit: 500, activity_rows: 2, overview_item_key: "responses",
      },
    });
  }
  throw new Error(`unexpected source tool ${command.toolName}`);
}

describe("Moodle Choice, Feedback and Database child-record Full MCP exposure", () => {
  it("returns safe Choice content and fails closed for learner participation history", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-activity-content-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Field methods", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command, digest));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-activity-content", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      expect(gateway.capabilityGet("moodle_get_feedback_response_summary")).toMatchObject({ descriptor: { canonicalName: "moodle_get_feedback_response_summary", behavior: { readOnly: true } } });

      const options = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_choice_options", arguments: { course_id: 2, module_id: 8, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const optionsText = JSON.stringify(options);
      expect(options.isError, optionsText).not.toBe(true);
      // A course-content read keeps the ordinary Moodle egress scope, which
      // reports the capability result inside the capability envelope.
      expect(options.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_choice_options",
        data: {
          schema: "morrow.result.v1", tool: "moodle_get_choice_options",
          data: {
            schema: "morrow.moodle-choice-options.v1", choice_id: 21, option_count: 2, has_responses: true,
            options: [
              { option_id: 41, position: 1, text: "Morning lab", response_limit: 12 },
              { option_id: 42, position: 2, text: "Evening lab", response_limit: 0 },
            ],
          },
        },
      });
      for (const privateValue of [...PRIVATE_VALUES, "chosen_by", "respondents"]) expect(optionsText).not.toContain(privateValue);

      const entries = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_database_entry_summary", arguments: { course_id: 2, module_id: 10, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const entriesText = JSON.stringify(entries);
      expect(entries.isError, entriesText).toBe(true);
      expect(entries.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "privacy_moodle_history_dictionary_unavailable" });
      for (const privateValue of [...PRIVATE_VALUES, "private entry", "raw_entries"]) expect(entriesText).not.toContain(privateValue);

      const named = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_feedback_response_summary", arguments: { course_id: 2, module_id: 11, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const namedText = JSON.stringify(named);
      expect(named.isError, namedText).toBe(true);
      expect(named.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "privacy_moodle_history_dictionary_unavailable" });
      for (const privateValue of [...PRIVATE_VALUES, "private answer", "respondents"]) expect(namedText).not.toContain(privateValue);

      // Named and anonymous Feedback responses have the same history boundary.
      const refused = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_feedback_response_summary", arguments: { course_id: 2, module_id: 9, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const refusedText = JSON.stringify(refused);
      expect(refused.isError, refusedText).toBe(true);
      expect(refused.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "privacy_moodle_history_dictionary_unavailable" });
      expect(refusedText).not.toContain('"anonymous"');
      for (const privateValue of [...PRIVATE_VALUES, "private answer", '"response_count":5', "refused_anonymous"]) {
        expect(refusedText).not.toContain(privateValue);
      }

      expect(commands.map((command) => command.toolName).filter((name) => name !== "moodle_get_course_participant_roster")).toEqual([
        "moodle_get_choice_options",
      ]);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
