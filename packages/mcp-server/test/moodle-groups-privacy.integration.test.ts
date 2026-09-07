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
import { GatewayRuntime } from "../src/runtime.js";
import { createMorrowServer } from "../src/server.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";

const ORIGIN = "https://moodle.example.edu";
const SITE_URL = `${ORIGIN}/campus/`;
const SOURCE_BINDING_ID = "moodle:groups";
const PRINCIPAL_FINGERPRINT = "c".repeat(64);
const TOKEN = "moodle-groups-privacy-token-".repeat(3);
const EXTENSION_ID = "a".repeat(32);
let nextGroupResponseUnknown = false;

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

function result(command: BridgeCommand, digest: string): JsonObject {
  if (command.toolName === "moodle_get_course_participant_roster") return {
    schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
    data: { schema: "morrow.moodle-course-roster.v1", provider: "moodle", sourceBindingId: SOURCE_BINDING_ID, courseId: "2", origin: ORIGIN, siteUrl: SITE_URL, principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, status: "complete", complete: true,
      identities: [{ id: "7", name: "Student Name" }, { id: "3", name: "Course Teacher" }], proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 2, identityCount: 2 } },
    snapshot_digest: "d".repeat(64),
  };
  if (command.toolName !== "moodle_get_course_groups") throw new Error(`unexpected source tool ${command.toolName}`);
  const unknown = nextGroupResponseUnknown;
  nextGroupResponseUnknown = false;
  return {
    schema: "morrow.moodle-browser-result.v1", ok: true, sent: false, status: 200, truncated: false,
    data: { course_id: "2", groups: [
      { id: "8", name: "Team Student", visibility: 0, participation: true, membership: [{ user_id: unknown ? "99" : "7", name: unknown ? "Unknown Student" : "Student Name" }] },
      { id: "9", name: "Team Teacher", visibility: 0, participation: true, membership: [{ user_id: "3", name: "Course Teacher" }] },
    ] }, snapshot_digest: "d".repeat(64),
  };
}

describe("Moodle course-group public learner privacy", () => {
  it("routes the public group map through the complete roster and refuses an unknown member", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-morrow-moodle-groups-privacy-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await GatewayRuntime.connect(configuration(root, directory, port));
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Forum course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command, digest));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-forum-privacy", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      expect(runtime.capabilityGet("moodle_get_course_groups")).toMatchObject({ descriptor: { canonicalName: "moodle_get_course_groups", behavior: { readOnly: true } } });
      const read = async () => await client!.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_course_groups", arguments: { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const allowed = await read(); const allowedText = JSON.stringify(allowed);
      expect(allowed.isError, allowedText).not.toBe(true);
      expect(allowedText).not.toContain("Student Name"); expect(allowedText).not.toContain("Course Teacher"); expect(allowedText).not.toContain('"user_id":"7"'); expect(allowedText).not.toContain('"user_id":"3"');
      expect(allowed.structuredContent).toMatchObject({ schema: "morrow.result.v1", tool: "moodle_get_course_groups", data: { result: { data: { groups: [{ membership: [{ learnerToken: expect.any(String) }] }, { membership: [{ learnerToken: expect.any(String) }] }] } } } });
      nextGroupResponseUnknown = true;
      const unknown = await read();
      expect(unknown.isError).toBe(true); expect(unknown.structuredContent).toMatchObject({ schema: "morrow.result.v1", data: { schema: "morrow.problem.v1", code: "learner_roster_identity_unavailable" } }); expect(JSON.stringify(unknown)).not.toContain("Unknown Student");
      const groupDispatches = () => commands.filter((command) => command.toolName === "moodle_get_course_groups");
      const beforeInvalid = groupDispatches().length;
      const invalid = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_course_groups", arguments: { course_id: 2, extra: true, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      expect(invalid.isError).toBe(true); expect(groupDispatches()).toHaveLength(beforeInvalid);
      expect(groupDispatches().map((command) => command.arguments.course_id)).toEqual([2, 2]);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
