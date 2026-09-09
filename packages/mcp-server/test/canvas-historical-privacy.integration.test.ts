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
  ["2", "canvas:complete"],
  ["3", "canvas:partial"],
  ["4", "canvas:mismatch"],
]);
const ORIGIN = "https://canvas.example.edu";
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

describe("Canvas historical learner dictionary", () => {
  it("redacts former learners and refuses a partial history before content dispatch", async () => {
    const root = resolve("../..");
    const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-history-"));
    const port = await availablePort();
    const catalogDigest = bridgeCatalogDigest(root);
    const runtime = await GatewayRuntime.connect(connectorConfig(root, directory, port));
    let bridge: BridgeTestClient | undefined;
    const contentCourses: string[] = [];
    try {
      bridge = await connectBridgeTestClient({
        port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest,
        bindings: [...SOURCE_BINDINGS].map(([courseId, sourceBindingId]) => ({
          sourceBindingId, provider: "canvas" as const, origin: ORIGIN, siteUrl: SITE_URL,
          courseId, principalFingerprint: PRINCIPAL_FINGERPRINT,
          sessionGeneration: 1, catalogDigest, editPolicyRevision: 0, runtimeVerified: true,
        })),
        deletedEnrollmentHistory: (command) => ({
          schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200,
          truncated: command.arguments.course_id === "3",
          data: [{ course_id: Number(command.arguments.course_id), user_id: 72, type: "StudentEnrollment", enrollment_state: "deleted", user: { id: 72, name: "Michaela Adams", short_name: "Michaela", login_id: "madams" } }],
        }),
      });
      bridge.onCommand((command) => {
        const course = String(command.arguments.course_id);
        const rosterRead = command.toolName === "canvas_list_users_in_course_users";
        if (!rosterRead) contentCourses.push(course);
        bridge?.respond(command, {
          schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
          data: rosterRead ? [{ id: 71, name: "Rowan Clarke" }] : { body: "Michaela discussed this with Rowan Clarke. Login madams." },
        });
      });
      const allowed = await runtime.call("canvas_show_page_courses", { url_or_id: "introduction", course_id: "2", _morrow: { source_binding_id: SOURCE_BINDINGS.get("2") } });
      expect(allowed.isError, JSON.stringify(allowed)).not.toBe(true);
      expect(JSON.stringify(allowed)).toContain("Student A");
      expect(JSON.stringify(allowed)).not.toContain("Michaela");
      expect(contentCourses).toEqual(["2"]);
      // Native result egress also uses the dictionary that includes former learners.
      const egress = await runtime.redactMcpEgress({ content: [{ type: "text", text: "Michaela discussed this with Rowan Clarke. Login madams." }] }, { course_id: "2", _morrow: { source_binding_id: SOURCE_BINDINGS.get("2") } });
      const text = JSON.stringify(egress);
      expect(egress.isError, text).not.toBe(true);
      expect(text).toContain("Student A");
      for (const identity of ["Michaela", "Rowan Clarke", "madams"]) expect(text).not.toContain(identity);
      const before = contentCourses.length;
      const denied = await runtime.call("canvas_show_page_courses", { url_or_id: "introduction", course_id: "3", _morrow: { source_binding_id: SOURCE_BINDINGS.get("3") } });
      expect(denied).toMatchObject({ isError: true, structuredContent: { code: "learner_roster_result_incomplete" } });
      expect(contentCourses).toHaveLength(before);
    } finally { await bridge?.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
