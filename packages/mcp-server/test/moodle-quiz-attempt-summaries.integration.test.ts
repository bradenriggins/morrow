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
const SOURCE_BINDING_ID = "moodle:quiz-attempt-summary";
const PRINCIPAL_FINGERPRINT = "d".repeat(64);
const TOKEN = "moodle-quiz-attempt-summary-token-".repeat(3);
const EXTENSION_ID = "b".repeat(32);

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

function result(command: BridgeCommand): JsonObject {
  if (command.toolName !== "moodle_get_quiz_attempt_summary") throw new Error(`unexpected source tool ${command.toolName}`);
  return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      schema: "morrow.moodle-quiz-attempt-summary.v1", provider: "moodle", course_id: 2, module_id: 8, quiz_id: 71,
      participant_count: 2, total_attempt_count: 3,
      attempt_state_counts: { notstarted: 0, inprogress: 1, overdue: 0, submitted: 1, finished: 1, abandoned: 0 },
      proof: { method: "core_table_get_dynamic_table_content+mod_quiz_get_user_quiz_attempts", complete: true, exact_module_binding: "course_modedit_form", participant_page_size: 50, participant_response_rows: 2, per_participant_attempt_limit: 50, total_attempt_limit: 500, attempt_response_rows: 3, attempt_request_count: 2 },
      raw_roster: [{ id: 7, fullname: "Jane Moodle", email: "jane@example.edu" }],
      raw_attempts: [{ id: 501, userid: 7, sumgrades: 100, answers: "private answer", feedback: "private feedback" }],
    },
    snapshot_digest: "e".repeat(64),
  };
}

describe("Moodle Quiz attempt-summary Full MCP exposure", () => {
  it("returns a bound aggregate projection without a participant-roster egress", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-quiz-attempt-summary-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Quiz course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-quiz-attempt-summary", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_capability_read");
      expect(gateway.capabilityGet("moodle_get_quiz_attempt_summary")).toMatchObject({ descriptor: { canonicalName: "moodle_get_quiz_attempt_summary", behavior: { readOnly: true } } });
      const allowed = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_quiz_attempt_summary", arguments: { course_id: 2, module_id: 8, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const allowedText = JSON.stringify(allowed);
      expect(allowed.isError, allowedText).not.toBe(true);
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "private answer", "private feedback", '"id":501', '"sumgrades":100']) expect(allowedText).not.toContain(privateValue);
      expect(allowed.structuredContent).toMatchObject({ schema: "morrow.result.v1", tool: "moodle_get_quiz_attempt_summary", data: { participant_count: 2, total_attempt_count: 3, attempt_state_counts: { notstarted: 0, inprogress: 1, overdue: 0, submitted: 1, finished: 1, abandoned: 0 } } });
      const refused = await gateway.call("moodle_get_quiz_attempt_summary", { course_id: 2, module_id: 9, _morrow: { source_binding_id: SOURCE_BINDING_ID } });
      const refusedText = JSON.stringify(refused);
      expect(refusedText).toContain("moodle_quiz_attempt_summary_invalid");
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "private answer", "private feedback", '"id":501']) expect(refusedText).not.toContain(privateValue);
      expect(commands.map((command) => command.toolName)).toEqual(["moodle_get_quiz_attempt_summary", "moodle_get_quiz_attempt_summary"]);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
