import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";
import { createMorrowServer } from "../src/server.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

function operationId(result: JsonObject): string {
  const value = isJsonObject(result.structuredContent) ? result.structuredContent.operationId : undefined;
  if (typeof value !== "string") throw new Error("Canvas file operation was not planned");
  return value;
}

describe("reviewed Canvas file dispatch", () => {
  it("keeps material bytes out of the plan and transfers them once through the exact private route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-canvas-file-dispatch-"));
    const workspaceRoot = await realpath(directory);
    const root = resolve("../..");
    const port = await reserveLoopbackPort();
    const canvasPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
    const bridgeDigest = bridgeCatalogDigestForTests(root);
    const token = "synthetic-canvas-file-token-".repeat(3);
    const extensionId = "a".repeat(32);
    const sourceBindingId = "canvas:file-transfer-test";
    const config = parseGatewayConfig({
      schema: "morrow.upstreams.v1", profile: "private-full", toolSurface: "full",
      upstreams: [{
        id: "browser-session", label: "Morrow browser connector", kind: "mcp-stdio",
        command: process.execPath, args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")], cwd: root,
        env: {
          MORROW_CANVAS_CATALOG_PATH: canvasPath,
          MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
          MORROW_CANVAS_CONNECTOR_PORT: String(port),
          MORROW_CANVAS_CONNECTOR_TOKEN: token,
          MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: extensionId,
        },
        sourceDisposition: "adapted_owned", outputPrivacy: {},
        outputPrivacyDefault: {
          allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 10_000,
          maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
        },
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: join(directory, "gateway.sqlite3") },
      privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
      maxCatalogTools: 2_000,
    });
    const bytes = Buffer.from("selected canonical Canvas material");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const input = { source_binding_id: sourceBindingId, course_id: 2, folder_id: 71, material_path: "materials/guide.txt" };
    const runtime = await GatewayRuntime.connect(config);
    let bridge: BridgeTestClient | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    let client: Client | undefined;
    const writes: BridgeCommand[] = [];
    try {
      await mkdir(join(directory, "materials"));
      await writeFile(join(directory, input.material_path), bytes);
      await assertPortListening(port);
      bridge = await connectBridgeTestClient({
        port, token, extensionId, catalogDigest: bridgeDigest,
        bindings: [{
          sourceBindingId, provider: "canvas", origin: "https://canvas.example.edu", courseId: "2",
          principalFingerprint: "d".repeat(64), sessionGeneration: 1, catalogDigest: bridgeDigest,
          editPolicyRevision: 0, editOptionsAvailable: true, runtimeVerified: true,
        }],
      });
      bridge.onCommand((command) => {
        if (command.kind === "invoke_write") writes.push(command);
        bridge?.respond(command, command.toolName === "canvas_list_users_in_course_users"
          ? {
              schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200,
              truncated: false, data: [],
            }
          : command.kind === "invoke_write"
          ? {
              schema: "morrow.canvas-course-file-transfer.v1", ok: true, sent: true, outcomeUnknown: false, status: 201,
              verification: { schema: "morrow.browser-verification.v1", status: "verified", strategy: "saved_file_bytes" },
              data: { course_id: 2, folder_id: 71, file: { id: "501" }, sha256: digest },
            }
          : { ok: true });
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createMorrowServer(runtime, undefined, { workspaceRoot }), { transport: b });
      client = new Client({ name: "morrow-canvas-file-boundary", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(a);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("morrow_plan_canvas_file_upload");
      expect(names).not.toContain("canvas_transfer_course_file");
      const planned = await client.callTool({ name: "morrow_plan_canvas_file_upload", arguments: input });
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      const plannedText = JSON.stringify(planned);
      expect(plannedText).not.toContain(bytes.toString());
      expect(plannedText).not.toContain(bytes.toString("base64"));
      expect(plannedText).not.toContain(input.material_path);
      const id = operationId(planned as unknown as JsonObject);
      expect(runtime.operationGet(id)).toMatchObject({
        state: "awaiting_approval",
        plan: { authorization: { kind: "review" }, arguments: {
          course_id: 2, folder_id: 71, filename: "guide.txt", size_bytes: bytes.length, sha256: digest, content_type: "text/plain",
        } },
      });
      expect(JSON.stringify(runtime.operationGet(id))).not.toContain(bytes.toString("base64"));
      runtime.approveOperation(id);
      expect(await runtime.dispatchOperation(id)).toMatchObject({
        structuredContent: { status: "verified", effectState: "verified" },
      });
      expect(runtime.operationGet(id)).toMatchObject({ state: "verified" });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        toolName: "canvas_transfer_course_file",
        operationKey: "canvas.private.course_file.transfer.v1",
        sourceBindingId,
        arguments: { course_id: 2, folder_id: 71, filename: "guide.txt", size_bytes: bytes.length, sha256: digest, content_type: "text/plain" },
        privateAttachment: { manifest: { filename: "guide.txt", size_bytes: bytes.length, sha256: digest }, content_type: "text/plain" },
      });
      expect(JSON.stringify(writes[0]?.arguments)).not.toContain(bytes.toString("base64"));
      await runtime.dispatchOperation(id);
      expect(writes).toHaveLength(1);
    } finally {
      await client?.close();
      await server?.close();
      await bridge?.close();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
