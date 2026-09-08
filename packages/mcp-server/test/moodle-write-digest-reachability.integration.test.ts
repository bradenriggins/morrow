import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadCanvasApiCatalog } from "@morrow/canvas-api-catalog";
import { describe, expect, it } from "vitest";
import { buildLocalCanvasConfig } from "../../client-config/src/index.js";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";
import { createMorrowServer } from "../src/server.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";

const ORIGIN = "https://moodle.example.edu";
const SITE_URL = `${ORIGIN}/campus/`;
const SOURCE_BINDING_ID = "moodle:digest-reachability";
const PRINCIPAL_FINGERPRINT = "c".repeat(64);
const EXPECTED_DIGEST = "d".repeat(64);
const TOKEN = "moodle-write-digest-token-".repeat(3);
const EXTENSION_ID = "a".repeat(32);

const writeCases: ReadonlyArray<Readonly<{ name: string; arguments: Record<string, unknown> }>> = [
  { name: "moodle_update_choice_option", arguments: { course_id: 2, module_id: 8, option_id: 11, position: 1, text: "Reviewed option" } },
  { name: "moodle_create_feedback_item", arguments: { course_id: 2, module_id: 8, type: "textfield", text: "Reviewed question", label: "Question", required: true, position: 1, expected_item_count: 0 } },
  { name: "moodle_update_feedback_item", arguments: { course_id: 2, module_id: 8, item_id: 11, position: 1, text: "Reviewed question" } },
  { name: "moodle_create_database_field", arguments: { course_id: 2, module_id: 8, type: "text", name: "Reviewed field", description: "", required: true, expected_field_count: 0 } },
  { name: "moodle_update_database_field", arguments: { course_id: 2, module_id: 8, field_id: 11, position: 1, name: "Reviewed field" } },
  { name: "moodle_create_group", arguments: { course_id: 2, name: "Reviewed group" } },
  { name: "moodle_update_group", arguments: { course_id: 2, group_id: 5, expected_group_name: "Section A", name: "Reviewed group" } },
  { name: "moodle_delete_group", arguments: { course_id: 2, group_id: 5, expected_group_name: "Section A", expected_member_count: 0 } },
  { name: "moodle_add_group_member", arguments: { course_id: 2, group_id: 5, expected_group_name: "Section A", learner_token: "learner_add" } },
  { name: "moodle_remove_group_member", arguments: { course_id: 2, group_id: 5, expected_group_name: "Section A", learner_token: "learner_remove" } },
  { name: "moodle_start_course_import", arguments: { course_id: 2, source_course_id: 7, acknowledge_course_change: true } },
  { name: "moodle_copy_course", arguments: { course_id: 2, new_full_name: "Reviewed copy", new_short_name: "REVIEWED-COPY", acknowledge_new_course: true } },
];

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
  const generated = structuredClone(buildLocalCanvasConfig(root, process.execPath)) as {
    upstreams: Record<string, unknown>[];
    operationJournal: Record<string, unknown>;
    privacy: Record<string, unknown>;
  };
  const upstream = generated.upstreams[0];
  if (!upstream) throw new Error("browser upstream unavailable");
  return parseGatewayConfig({
    ...generated,
    upstreams: [{
      ...upstream,
      env: {
        ...(upstream.env as Record<string, string>),
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN,
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID,
      },
    }],
    operationJournal: { ...generated.operationJournal, path: join(directory, "gateway.sqlite3") },
    privacy: { ...generated.privacy, learnerVaultPath: join(directory, "vault.json") },
  });
}

describe("Moodle write digest reachability", () => {
  it("plans all twelve repaired writes and rejects a missing or malformed digest before operation creation", async () => {
    const root = resolve("../..");
    const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-write-digest-"));
    const port = await availablePort();
    const catalogDigest = browserCatalogDigest(root);
    const runtime = await GatewayRuntime.connect(configuration(root, directory, port));
    let bridge: BridgeTestClient | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    let client: Client | undefined;
    const bridgeCommands: Array<{ kind: string; toolName: string }> = [];
    try {
      bridge = await connectBridgeTestClient({
        port,
        token: TOKEN,
        extensionId: EXTENSION_ID,
        catalogDigest,
        bindings: [{
          sourceBindingId: SOURCE_BINDING_ID,
          provider: "moodle",
          origin: ORIGIN,
          siteUrl: SITE_URL,
          courseId: "2",
          courseName: "Digest course",
          principalFingerprint: PRINCIPAL_FINGERPRINT,
          sessionGeneration: 1,
          catalogDigest,
          editPolicyRevision: 0,
          runtimeVerified: true,
        }],
      });
      bridge.onCommand((command) => {
        bridgeCommands.push({ kind: command.kind, toolName: command.toolName });
        if (command.kind !== "invoke_read" || command.toolName !== "moodle_get_course_participant_roster") return;
        bridge?.respond(command, {
          schema: "morrow.moodle-browser-result.v1",
          ok: true,
          sent: true,
          status: 200,
          truncated: false,
          data: {
            schema: "morrow.moodle-course-roster.v1",
            provider: "moodle",
            sourceBindingId: SOURCE_BINDING_ID,
            courseId: "2",
            origin: ORIGIN,
            siteUrl: SITE_URL,
            principalFingerprint: PRINCIPAL_FINGERPRINT,
            sessionGeneration: 1,
            catalogDigest,
            status: "complete",
            complete: true,
            identities: [{ id: "7", name: "Student Name" }],
            proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 1, identityCount: 1 },
          },
          snapshot_digest: "e".repeat(64),
        });
      });
      const [left, right] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createMorrowServer(runtime), { transport: right });
      client = new Client(
        { name: "morrow-moodle-write-digest", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(left);

      expect(writeCases).toHaveLength(12);
      const effectCount = () => Number(runtime.operationList(200).returned);
      const operationCountBefore = effectCount();
      const plannedOperationIds = new Set<string>();
      for (const testCase of writeCases) {
        const planned = await client.callTool({
          name: "morrow_capability_change",
          arguments: {
            name: testCase.name,
            arguments: {
              ...testCase.arguments,
              expected_digest: EXPECTED_DIGEST,
              _morrow: { source_binding_id: SOURCE_BINDING_ID },
            },
          },
        });
        expect(planned.isError, `${testCase.name}: ${JSON.stringify(planned)}`).not.toBe(true);
        expect(planned.structuredContent, testCase.name).toMatchObject({
          schema: "morrow.result.v1",
          phase: "planned",
          effectState: "awaiting_approval",
        });
        const operationId = (planned.structuredContent as { operationId?: unknown } | undefined)?.operationId;
        expect(operationId, testCase.name).toEqual(expect.stringMatching(/^op:/));
        plannedOperationIds.add(String(operationId));
      }
      expect(plannedOperationIds.size).toBe(writeCases.length);
      expect(effectCount()).toBe(operationCountBefore + writeCases.length);
      expect(bridgeCommands.filter((command) => command.kind === "invoke_write")).toEqual([]);

      const operationCountAfterPlans = effectCount();
      for (const testCase of writeCases) {
        for (const expectedDigest of [undefined, "D".repeat(64)]) {
          const argumentsValue: Record<string, unknown> = {
            ...testCase.arguments,
            _morrow: { source_binding_id: SOURCE_BINDING_ID },
          };
          if (expectedDigest !== undefined) argumentsValue.expected_digest = expectedDigest;
          const invalid = await client.callTool({
            name: "morrow_capability_change",
            arguments: { name: testCase.name, arguments: argumentsValue },
          });
          expect(invalid.isError, `${testCase.name}: ${JSON.stringify(invalid)}`).toBe(true);
          expect(invalid.structuredContent, testCase.name).toMatchObject({
            schema: "morrow.problem.v1",
            code: "capability_input_invalid",
          });
        }
      }
      expect(effectCount()).toBe(operationCountAfterPlans);
    } finally {
      await client?.close();
      await server?.close();
      await bridge?.close();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
