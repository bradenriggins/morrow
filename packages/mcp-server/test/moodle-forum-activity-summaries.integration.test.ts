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
const SOURCE_BINDING_ID = "moodle:forum-activity-summary";
const PRINCIPAL_FINGERPRINT = "d".repeat(64);
const TOKEN = "moodle-forum-activity-summary-token-".repeat(3);
const EXTENSION_ID = "b".repeat(32);

const PROOF = {
  method: "mod_forum_get_forum_discussions", complete: true, exact_module_binding: "course_modedit_form",
  required_capability: "mod/forum:viewdiscussion", scope: "current_principal_permitted_discussions",
  group_scope: "native_default_permitted_groups", sort_order: "created_asc", page_size: 50,
  page_request_limit: 11, page_request_count: 2, discussion_limit: 500, reply_limit: 5_000_000,
};

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
    // The full tool surface registers each catalog capability as its own MCP tool,
    // so listTools() shows whether this operation is reachable by name.
    toolSurface: "full",
    upstreams: [{ ...upstream, env: { ...(upstream.env as Record<string, string>), MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"), MORROW_CANVAS_CONNECTOR_PORT: String(port), MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN, MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID } }],
    operationJournal: { ...generated.operationJournal, path: join(directory, "gateway.sqlite3") },
    privacy: { ...generated.privacy, learnerVaultPath: join(directory, "vault.json") },
  });
}

function result(command: BridgeCommand, digest: string): JsonObject {
  if (command.toolName === "moodle_get_course_participant_roster") return {
    schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
    data: {
      schema: "morrow.moodle-course-roster.v1", provider: "moodle", sourceBindingId: SOURCE_BINDING_ID, courseId: "2",
      origin: ORIGIN, siteUrl: SITE_URL, principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1,
      catalogDigest: digest, status: "complete", complete: true,
      identities: [{ id: "7", name: "Jane Moodle", email: "jane@example.edu" }],
      proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 1, identityCount: 1 },
    },
    snapshot_digest: "a".repeat(64),
  };
  if (command.toolName !== "moodle_get_forum_activity_summary") throw new Error(`unexpected source tool ${command.toolName}`);
  return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: {
      schema: "morrow.moodle-forum-activity-summary.v1", provider: "moodle", course_id: 2, module_id: 8, forum_id: 71,
      discussion_count: 51, reply_count: 52,
      proof: PROOF,
      raw_discussions: [{ discussion: 1_000, id: 2_000, userid: 7, userfullname: "Jane Moodle", useremail: "jane@example.edu", subject: "private subject", message: "private body", groupid: 9, numunread: 1 }],
      attachments: [{ filename: "private-file.pdf" }],
    },
    snapshot_digest: "e".repeat(64),
  };
}

describe("Moodle Forum activity-summary Full MCP exposure", () => {
  it("fails closed because the current roster is not a complete Forum-history dictionary", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-forum-activity-summary-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Forum course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command, digest));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-forum-activity-summary", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      const listed = (await client.listTools()).tools;
      expect(listed.map((tool) => tool.name)).toContain("moodle_get_forum_activity_summary");
      expect(listed.find((tool) => tool.name === "moodle_get_forum_activity_summary")?.annotations?.readOnlyHint).toBe(true);
      expect(gateway.capabilityGet("moodle_get_forum_activity_summary")).toMatchObject({ descriptor: { canonicalName: "moodle_get_forum_activity_summary", behavior: { readOnly: true } } });

      const denied = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_forum_activity_summary", arguments: { course_id: 2, module_id: 8, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const deniedText = JSON.stringify(denied);
      expect(denied.isError, deniedText).toBe(true);
      expect(denied.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "privacy_moodle_history_dictionary_unavailable" });
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "Student A", "private subject", "private body", "private-file.pdf", '"course_id"', '"module_id"', '"forum_id"', '"id":2000', '"groupid"', '"numunread"']) {
        expect(deniedText, `result leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(commands.map((command) => command.toolName)).toEqual(["moodle_get_course_participant_roster"]);

      const refused = await gateway.call("moodle_get_forum_activity_summary", { course_id: 2, module_id: 9, _morrow: { source_binding_id: SOURCE_BINDING_ID } });
      const refusedText = JSON.stringify(refused);
      expect(refused).toMatchObject({ isError: true, structuredContent: { schema: "morrow.problem.v1", code: "privacy_moodle_history_dictionary_unavailable" } });
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "Student A", "private subject", "private body", "private-file.pdf", '"discussion_count"', '"reply_count"']) {
        expect(refusedText, `refusal leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(commands.map((command) => command.toolName)).toEqual(["moodle_get_course_participant_roster"]);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
