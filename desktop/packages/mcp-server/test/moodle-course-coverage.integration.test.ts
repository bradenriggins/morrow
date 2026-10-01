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
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";

const ORIGIN = "https://moodle.example.edu";
const SITE_URL = `${ORIGIN}/campus/`;
const SOURCE_BINDING_ID = "moodle:course-coverage";
const PRINCIPAL_FINGERPRINT = "c".repeat(64);
const TOKEN = "moodle-course-coverage-token-".repeat(3);
const EXTENSION_ID = "f".repeat(32);
const DIGEST = "f".repeat(64);

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
    upstreams: [{ ...upstream, env: { ...(upstream.env as Record<string, string>), MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"), MORROW_CANVAS_CONNECTOR_PORT: String(port), MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN, MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID } }],
    operationJournal: { ...generated.operationJournal, path: join(directory, "gateway.sqlite3") },
    privacy: { ...generated.privacy, learnerVaultPath: join(directory, "vault.json") },
  });
}

const PROOF = {
  method: "native_course_page", complete: true, required_capabilities: ["moodle/course:view"],
  page_request_limit: 5, page_request_count: 1,
};

function readResult(data: JsonObject): JsonObject {
  return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, status: 200, provider: "moodle", complete: true,
    data: { ...data, proof: PROOF, raw_rows: [{ id: 1, secret: "must-not-survive" }] },
    snapshot_digest: "e".repeat(64),
  };
}

function writeResult(data: JsonObject, readTool: string): JsonObject {
  return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200, provider: "moodle", complete: true,
    data,
    verification: {
      schema: "morrow.browser-verification.v1", status: "verified", strategy: "updated-resource",
      readTool, evidence: "fresh_readback_matches_requested_postcondition",
    },
    snapshot_digest: "e".repeat(64),
  };
}

function result(command: BridgeCommand, digest: string): JsonObject {
  switch (command.toolName) {
    case "moodle_get_course_participant_roster":
      return {
        schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
        data: {
          schema: "morrow.moodle-course-roster.v1", provider: "moodle", sourceBindingId: SOURCE_BINDING_ID, courseId: "2",
          origin: ORIGIN, siteUrl: SITE_URL, principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1,
          catalogDigest: digest, status: "complete", complete: true,
          identities: [{ id: "7", name: "Student Name" }],
          proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 1, identityCount: 1 },
        },
        snapshot_digest: "d".repeat(64),
      };
    case "moodle_list_assignments":
      return readResult({ schema: "morrow.moodle-assignment-list.v1", provider: "moodle", course_id: 2, assignment_count: 1, assignments: [{ id: "11", name: "Week 1 homework" }] });
    case "moodle_list_quizzes":
      return readResult({ schema: "morrow.moodle-quiz-list.v1", provider: "moodle", course_id: 2, quiz_count: 1, quizzes: [{ id: "12", name: "Week 1 quiz" }] });
    case "moodle_get_course_summary":
      return readResult({ schema: "morrow.moodle-course-summary.v1", provider: "moodle", course_id: 2, summary: "Biology 101", summary_format: "html" });
    case "moodle_get_quiz_creation_form":
      return readResult({ schema: "morrow.moodle-quiz-creation-form.v1", provider: "moodle", course_id: 2, section_id: 3, defaults: { name: "", open_at: null, close_at: null } });
    case "moodle_create_quiz":
      return writeResult({ schema: "morrow.moodle-quiz-write.v1", provider: "moodle", course_id: 2, quiz_id: "44" }, "moodle_get_quiz");
    case "moodle_update_course_summary":
      return writeResult({ schema: "morrow.moodle-course-summary-write.v1", provider: "moodle", course_id: 2 }, "moodle_get_course_summary");
    case "moodle_hide_course":
      return writeResult({ schema: "morrow.moodle-course-visibility-write.v1", provider: "moodle", course_id: 2, visible: false }, "moodle_get_course");
    case "moodle_show_course":
      return writeResult({ schema: "morrow.moodle-course-visibility-write.v1", provider: "moodle", course_id: 2, visible: true }, "moodle_get_course");
    default:
      throw new Error(`unexpected source tool ${command.toolName} kind ${command.kind} :: ${JSON.stringify(command).slice(0, 400)}`);
  }
}

describe("Moodle course reads and writes Full MCP exposure", () => {
  it("reads the four uncovered course tools and writes a quiz, a summary, and visibility, each verified", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-course-coverage-")); const port = await availablePort();
    const digest = bridgeCatalogDigestForTests(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Coverage course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read" && command.kind !== "invoke_write") return;
        commands.push(command);
        bridge?.respond(command, result(command, digest));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-course-coverage", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);

      for (const tool of ["moodle_list_assignments", "moodle_list_quizzes", "moodle_get_course_summary", "moodle_get_quiz_creation_form"]) {
        expect(gateway.capabilityGet(tool)).toMatchObject({ descriptor: { canonicalName: tool, behavior: { readOnly: true } } });
        const read = await client.callTool({ name: "morrow_capability_read", arguments: {
          name: tool, arguments: { course_id: 2, ...(tool === "moodle_get_quiz_creation_form" ? { section_id: 3 } : {}), _morrow: { source_binding_id: SOURCE_BINDING_ID } },
        } });
        expect(read.isError, `${tool}: ${JSON.stringify(read)}`).not.toBe(true);
        expect(read.structuredContent).toMatchObject({ schema: "morrow.result.v1", tool });
        expect(JSON.stringify(read), `${tool} leaked page state`).not.toContain("must-not-survive");
      }
      expect(commands.filter((command) => command.kind === "invoke_read" && command.toolName !== "moodle_get_course_participant_roster")).toHaveLength(4);

      const writes: { tool: string; args: JsonObject; readTool: string }[] = [
        { tool: "moodle_create_quiz", args: { course_id: 2, section_id: 3, name: "Week 1 quiz", instructions: "Answer all questions.", open_at: { year: 2026, month: 9, day: 1, hour: 0, minute: 0 }, close_at: { year: 2026, month: 9, day: 8, hour: 0, minute: 0 }, expected_digest: DIGEST }, readTool: "moodle_get_quiz" },
        { tool: "moodle_update_course_summary", args: { course_id: 2, summary: "Biology 101, revised.", expected_digest: DIGEST }, readTool: "moodle_get_course_summary" },
        { tool: "moodle_hide_course", args: { course_id: 2, expected_digest: DIGEST }, readTool: "moodle_get_course" },
        { tool: "moodle_show_course", args: { course_id: 2, expected_digest: DIGEST }, readTool: "moodle_get_course" },
      ];
      for (const { tool, args } of writes) {
        const before = commands.filter((command) => command.kind === "invoke_write").length;
        const planned = await client.callTool({ name: "morrow_capability_change", arguments: { name: tool, arguments: { ...args, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
        expect(planned.isError, `${tool}: ${JSON.stringify({ args, planned })}`).not.toBe(true);
        const id = (planned.structuredContent as { operationId: string }).operationId;
        expect(id).toMatch(/^op:/);
        gateway.approveOperation(id);
        const dispatched = await client.callTool({ name: "morrow_operation_dispatch", arguments: { operation_id: id } });
        expect(dispatched.isError, `${tool}: ${JSON.stringify(dispatched)}`).not.toBe(true);
        expect(dispatched.structuredContent, tool).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
        expect(commands.filter((command) => command.kind === "invoke_write"), `${tool} dispatched more or less than once`).toHaveLength(before + 1);
      }
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
