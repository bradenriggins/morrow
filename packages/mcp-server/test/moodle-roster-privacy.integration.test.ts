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
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";
import { createMorrowServer } from "../src/server.js";
import { buildLocalCanvasConfig } from "../../client-config/src/index.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";

const SOURCE_BINDINGS = new Map([
  ["2", "moodle:complete"],
  ["3", "moodle:partial"],
  ["4", "moodle:mismatch"],
]);
const ORIGIN = "https://moodle.example.edu";
const SITE_URL = `${ORIGIN}/campus/`;
const PRINCIPAL_FINGERPRINT = "c".repeat(64);
const SNAPSHOT_DIGEST = "d".repeat(64);
const TOKEN = "moodle-roster-gateway-token-".repeat(3);
const EXTENSION_ID = "a".repeat(32);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function bridgeCatalogDigest(root: string): string {
  const canvas = loadCanvasApiCatalog(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"));
  const canvasBrowser = createHash("sha256")
    .update(readFileSync(resolve(root, "connector/extension/generated/canvas-browser-catalog.json")))
    .digest("hex");
  const moodle = createHash("sha256")
    .update(readFileSync(resolve(root, "connector/extension/generated/moodle-browser-catalog.json")))
    .digest("hex");
  return createHash("sha256").update(`${canvas.catalogDigest}\n${canvasBrowser}\n${moodle}`).digest("hex");
}

function connectorConfig(root: string, directory: string, port: number) {
  const generated = structuredClone(buildLocalCanvasConfig(root, process.execPath)) as {
    upstreams: Record<string, unknown>[];
    operationJournal: Record<string, unknown>;
    privacy: Record<string, unknown>;
  };
  const upstream = generated.upstreams[0];
  if (!upstream) throw new Error("generated browser upstream unavailable");
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

function roster(command: BridgeCommand, catalogDigest: string): JsonObject {
  const courseId = String(command.arguments.course_id);
  const sourceBindingId = SOURCE_BINDINGS.get(courseId);
  if (!sourceBindingId) throw new Error("unexpected roster course");
  const partial = courseId === "3";
  const mismatch = courseId === "4";
  return {
    schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200,
    truncated: partial,
    data: {
      schema: "morrow.moodle-course-roster.v1", provider: "moodle",
      sourceBindingId,
      courseId, origin: ORIGIN, siteUrl: mismatch ? `${ORIGIN}/other-root/` : SITE_URL,
      principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest,
      status: partial ? "partial" : "complete", complete: !partial,
      identities: partial ? [] : [{ id: `student-${courseId}`, name: "Jane Moodle" }],
      proof: { method: "core_table_get_dynamic_table_content", pageSize: 100, requestCount: 1, pageCount: 1, rowCount: partial ? 0 : 1, identityCount: partial ? 0 : 1 },
    },
    snapshot_digest: SNAPSHOT_DIGEST,
  };
}

function browserResult(command: BridgeCommand, catalogDigest: string): JsonObject {
  const courseId = String(command.arguments.course_id);
  if (command.toolName === "moodle_get_course_participant_roster") return roster(command, catalogDigest);
  const data = command.toolName === "moodle_get_course"
    ? { course_id: Number(courseId), fullname: "Genetics" }
    : command.toolName === "moodle_get_quiz_question"
      ? {
        course_id: Number(courseId), module_id: 8, slot_id: 9, qtype: "essay", name: "Reflection",
        question_text: "<p>Jane Moodle must explain meiosis.</p>", general_feedback: "Review the chromosome diagram.",
      }
      : null;
  if (!data) throw new Error(`unexpected browser command ${command.toolName}`);
  return {
    schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200,
    truncated: false, data, targets: [], snapshot_digest: SNAPSHOT_DIGEST,
  };
}

describe("Moodle source-bound roster egress", () => {
  it("redacts a complete roster and refuses partial or mismatched roster reports through the MCP boundary", async () => {
    const root = resolve("../..");
    const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-roster-egress-"));
    const port = await availablePort();
    const catalogDigest = bridgeCatalogDigest(root);
    const config = connectorConfig(root, directory, port);
    expect(config.upstreams[0]?.outputPrivacyDefault?.dataClass).toBe("learner");
    const runtime = await GatewayRuntime.connect(config);
    let bridge: BridgeTestClient | undefined;
    let client: Client | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({
        port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest,
        bindings: [...SOURCE_BINDINGS].map(([courseId, sourceBindingId]) => ({
          sourceBindingId, provider: "moodle" as const, origin: ORIGIN, siteUrl: SITE_URL,
          courseId, courseName: `Course ${courseId}`, principalFingerprint: PRINCIPAL_FINGERPRINT,
          sessionGeneration: 1, catalogDigest, editPolicyRevision: 0, runtimeVerified: true,
        })),
      });
      bridge.onCommand((message) => {
        if (message.kind !== "invoke_read") return;
        commands.push(message);
        const courseId = String(message.arguments.course_id);
        expect(message.sourceBindingId).toBe(SOURCE_BINDINGS.get(courseId));
        bridge?.respond(message, browserResult(message, catalogDigest));
      });

      const [left, right] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-roster-egress", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(left);
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("moodle_get_course_participant_roster");

      const connections = await client.callTool({
        name: "morrow_capability_read",
        arguments: { name: "morrow_browser_bindings", arguments: {} },
      });
      const connectionsText = JSON.stringify(connections);
      expect(connections.isError, connectionsText).not.toBe(true);
      expect(connections.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        data: {
          schema: "morrow.browser-bindings.v1", ok: true, count: 3,
          bindings: [
            { sourceBindingId: "moodle:complete", provider: "moodle", courseId: "2", courseName: "Course 2", principalFingerprint: PRINCIPAL_FINGERPRINT },
            { sourceBindingId: "moodle:mismatch", provider: "moodle", courseId: "4", principalFingerprint: PRINCIPAL_FINGERPRINT },
            { sourceBindingId: "moodle:partial", provider: "moodle", courseId: "3", principalFingerprint: PRINCIPAL_FINGERPRINT },
          ],
        },
      });
      expect(connectionsText).not.toContain("Jane Moodle");
      expect(connectionsText).not.toContain("principalId");
      expect(connectionsText).not.toContain("Course 3");
      expect(connectionsText).not.toContain("Course 4");

      const bindingMapping = runtime.catalog.tools.find((tool) => tool.upstreamName === "morrow_browser_bindings");
      if (!bindingMapping) throw new Error("browser bindings mapping unavailable");
      const bindingEgress = runtime as unknown as {
        publicBrowserBindings: (mapping: typeof bindingMapping, raw: JsonObject) => Promise<JsonObject>;
      };
      const empty = await bindingEgress.publicBrowserBindings(bindingMapping, {
        structuredContent: { schema: "morrow.browser-bindings.v1", ok: true, count: 0, bindings: [] },
      });
      expect(empty.structuredContent).toMatchObject({ schema: "morrow.browser-bindings.v1", ok: true, count: 0, bindings: [] });
      const baseBinding = {
        sourceBindingId: "moodle:duplicate", provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL,
        courseId: "2", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1,
        catalogDigest, editPolicyRevision: 0, runtimeVerified: true,
      };
      await expect(bindingEgress.publicBrowserBindings(bindingMapping, {
        structuredContent: { schema: "morrow.browser-bindings.v1", ok: true, count: 2, bindings: [baseBinding] },
      })).rejects.toThrow("privacy_browser_bindings_invalid");
      await expect(bindingEgress.publicBrowserBindings(bindingMapping, {
        structuredContent: {
          schema: "morrow.browser-bindings.v1", ok: true, count: 2,
          bindings: [baseBinding, { ...baseBinding, courseId: "3" }],
        },
      })).rejects.toThrow("privacy_browser_bindings_invalid");

      runtime.setApprovalBaseUrl("http://127.0.0.1:4317");
      const planned = await client.callTool({
        name: "morrow_capability_change",
        arguments: {
          name: "moodle_update_page",
          arguments: {
            course_id: 2,
            module_id: 8,
            name: "Review privacy boundary",
            expected_digest: SNAPSHOT_DIGEST,
            _morrow: { source_binding_id: "moodle:complete" },
          },
        },
      });
      const approvalUrl = (planned.structuredContent as { receipts?: { approvalUrl?: unknown } })?.receipts?.approvalUrl;
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      expect(approvalUrl).toEqual(expect.stringMatching(/^http:\/\/127\.0\.0\.1:4317\/operations\/op%3A/));
      expect(String(approvalUrl)).toContain("%3A");

      const audit = async (courseId: number) => await client!.callTool({
        name: "morrow_audit_course",
        arguments: { provider: "moodle", source_binding_id: SOURCE_BINDINGS.get(String(courseId)), course_id: courseId, target: { kind: "quiz_question", module_id: 8, slot_id: 9 } },
      });
      const complete = await audit(2);
      const completeText = JSON.stringify(complete);
      expect(complete.isError, completeText).not.toBe(true);
      expect(complete.structuredContent).toMatchObject({ schema: "morrow.course-audit.v1", provider: "moodle", course: { id: 2 } });
      expect(completeText).not.toContain("Jane Moodle");

      const partial = await audit(3);
      expect(partial.isError).toBe(true);
      expect(partial.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "learner_roster_result_incomplete" });
      expect(JSON.stringify(partial)).not.toContain("Jane Moodle");

      const mismatch = await audit(4);
      expect(mismatch.isError).toBe(true);
      expect(mismatch.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "learner_roster_result_mismatch" });
      expect(JSON.stringify(mismatch)).not.toContain("Jane Moodle");
      expect(commands.filter((command) => command.toolName === "moodle_get_course_participant_roster").map((command) => String(command.arguments.course_id))).toEqual(["2", "4", "3", "2", "2", "3", "4"]);
    } finally {
      await client?.close();
      await server?.close();
      await bridge?.close();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
