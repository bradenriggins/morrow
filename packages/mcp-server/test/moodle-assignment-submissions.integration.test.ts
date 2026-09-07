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
const SOURCE_BINDING_ID = "moodle:assignment-summary";
const PRINCIPAL_FINGERPRINT = "c".repeat(64);
const TOKEN = "moodle-assignment-summary-token-".repeat(3);
const EXTENSION_ID = "a".repeat(32);

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
  if (command.toolName !== "moodle_get_assignment_submission_summary") throw new Error(`unexpected source tool ${command.toolName}`);
  return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      schema: "morrow.moodle-assignment-submission-summary.v1", provider: "moodle", course_id: 2, module_id: 8, assignment_id: 70,
      participant_count: 4, submitted_count: 1, requires_grading_count: 2, granted_extension_count: 1,
      submission_status_counts: { new: 1, reopened: 1, draft: 1, submitted: 1 },
      proof: { method: "mod_assign_list_participants", complete: true, exact_module_binding: "course_modedit_form", requested_limit: 0, response_row_count: 4 },
      raw_rows: [{ id: 7, fullname: "Jane Moodle", grade: 100, commenttext: "private feedback" }],
    },
    snapshot_digest: "d".repeat(64),
  };
}

describe("Moodle Assignment submission-summary Full MCP exposure", () => {
  it("returns a bound aggregate projection without a participant-roster read", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-assignment-summary-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Assignment course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-assignment-summary", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_capability_read");
      expect(gateway.capabilityGet("moodle_get_assignment_submission_summary")).toMatchObject({ descriptor: { canonicalName: "moodle_get_assignment_submission_summary", behavior: { readOnly: true } } });
      const allowed = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_assignment_submission_summary", arguments: { course_id: 2, module_id: 8, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const allowedText = JSON.stringify(allowed);
      expect(allowed.isError, allowedText).not.toBe(true);
      expect(allowedText).not.toContain("Jane Moodle"); expect(allowedText).not.toContain("private feedback"); expect(allowedText).not.toContain('"id":7');
      expect(allowed.structuredContent).toMatchObject({ schema: "morrow.result.v1", tool: "moodle_get_assignment_submission_summary", data: { participant_count: 4, submitted_count: 1, requires_grading_count: 2, granted_extension_count: 1 } });
      expect(commands.map((command) => command.toolName)).toEqual(["moodle_get_assignment_submission_summary"]);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
