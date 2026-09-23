import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeBinding, BridgeCommand } from "@morrow/bridge-protocol";
import type { JsonObject } from "@morrow/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";
import { createMorrowServer } from "../src/server.js";
import { buildLocalCanvasConfig } from "../../client-config/src/index.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";

// A course read that Morrow could not make tells the assistant the real reason and the step that
// fixes it. Closing Chrome, or a course tab that closed, is not a learner-privacy fault and is not
// unsafe output.

const SOURCE_BINDING_ID = "canvas:course-2";
const ORIGIN = "https://canvas.example.edu";
const TOKEN = "course-read-reasons-gateway-token-".repeat(2);
const EXTENSION_ID = "b".repeat(32);

const BRIDGE_NOT_CONNECTED = "Morrow Bridge is not connected to Morrow, so Morrow could not reach the course. Open Chrome and open the Morrow Bridge popup, which shows the step that connects it. Then ask again.";
const COURSE_NOT_CONNECTED = "This course is not connected in Morrow Bridge, so Morrow could not reach it. Open the course in Chrome and sign in, then select Connect this course in the Morrow Bridge popup. Then ask again.";
const PORT_IN_USE = "Another Morrow is already connected to Morrow Bridge, so this Morrow could not reach the course. Close the other Morrow, or use one Morrow for all your assistants.";
const COURSE_CONNECTION_UNUSABLE = "Morrow sent nothing, because the signed-in Canvas or Moodle tab for this course is closed, signed out, or showing another page. Open the course in Canvas or Moodle and sign in, then ask again. If the course is closed, select Open Canvas or Open Moodle in the Morrow Bridge popup.";

const READS = [
  { name: "canvas_show_page_courses", arguments: { course_id: "2", url_or_id: "week-1" } },
  { name: "canvas_get_single_course_courses", arguments: { id: "2" } },
] as const;

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
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

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { text: string }[])[0]!.text;
}

/** The problem a read answered with, whether bare or inside Morrow's result envelope. */
function problem(result: Awaited<ReturnType<Client["callTool"]>>): JsonObject {
  const structured = result.structuredContent as JsonObject;
  return structured.schema === "morrow.problem.v1" ? structured : structured.data as JsonObject;
}

describe("a course read Morrow could not make", () => {
  const root = resolve("../..");
  let directory: string;
  let port: number;
  let catalogDigest: string;
  let runtime: GatewayRuntime;
  let client: Client;
  let server: Awaited<ReturnType<typeof serveStdio>>;
  let bridge: BridgeTestClient | undefined;

  const binding = (): BridgeBinding => ({
    sourceBindingId: SOURCE_BINDING_ID, provider: "canvas", origin: ORIGIN, siteUrl: `${ORIGIN}/`,
    courseId: "2", principalFingerprint: "c".repeat(64), sessionGeneration: 1, catalogDigest,
    editPolicyRevision: 0, runtimeVerified: true,
  });
  const read = (entry: typeof READS[number]) => client.callTool({
    name: "morrow_capability_read",
    arguments: { name: entry.name, arguments: { ...entry.arguments, _morrow: { source_binding_id: SOURCE_BINDING_ID } } },
  });

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "morrow-course-read-reasons-"));
    port = await availablePort();
    catalogDigest = bridgeCatalogDigestForTests(root);
    runtime = await GatewayRuntime.connect(connectorConfig(root, directory, port));
    client = new Client({ name: "Claude Code", version: "1" }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    await client.connect(a);
  }, 60_000);

  afterAll(async () => {
    await bridge?.close();
    await client?.close();
    await server?.close();
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("says Morrow Bridge is not connected when Chrome is closed", async () => {
    for (const entry of READS) {
      const result = await read(entry);
      expect(result.isError, entry.name).toBe(true);
      expect(text(result), entry.name).toBe(BRIDGE_NOT_CONNECTED);
      expect(problem(result), entry.name).toMatchObject({ code: "privacy_browser_bridge_not_connected" });
    }
  }, 60_000);

  it("says another Morrow holds Morrow Bridge when this Morrow could not take its port", async () => {
    const holder = createServer();
    const heldPort = await new Promise<number>((done) => holder.listen(0, "127.0.0.1", () => done((holder.address() as { port: number }).port)));
    const heldDirectory = mkdtempSync(join(tmpdir(), "morrow-course-read-port-held-"));
    let second: GatewayRuntime | undefined;
    let secondClient: Client | undefined;
    let secondServer: Awaited<ReturnType<typeof serveStdio>> | undefined;
    try {
      second = await GatewayRuntime.connect(connectorConfig(root, heldDirectory, heldPort));
      secondClient = new Client({ name: "Claude Code", version: "1" }, { capabilities: {} });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const secondRuntime = second;
      secondServer = serveStdio(() => createMorrowServer(secondRuntime), { transport: b });
      await secondClient.connect(a);
      const result = await secondClient.callTool({
        name: "morrow_capability_read",
        arguments: { name: READS[0].name, arguments: { ...READS[0].arguments, _morrow: { source_binding_id: SOURCE_BINDING_ID } } },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(PORT_IN_USE);
      expect(problem(result)).toMatchObject({ code: "privacy_browser_bridge_port_in_use" });
    } finally {
      await secondClient?.close();
      await secondServer?.close();
      await second?.close();
      await new Promise<void>((done) => holder.close(() => done()));
      rmSync(heldDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("says to connect the course when Morrow Bridge has no connection for it", async () => {
    bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest, bindings: [] });
    try {
      for (const entry of READS) {
        const result = await read(entry);
        expect(result.isError, entry.name).toBe(true);
        expect(text(result), entry.name).toBe(COURSE_NOT_CONNECTED);
        expect(problem(result), entry.name).toMatchObject({ code: "privacy_browser_binding_missing" });
      }
    } finally { await bridge.close(); bridge = undefined; }
  }, 60_000);

  it("names the course connection step, and keeps it recoverable, when Morrow Bridge refuses a read before sending it", async () => {
    bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest, bindings: [binding()] });
    const refused: string[] = [];
    bridge.onCommand((command: BridgeCommand) => {
      if (command.kind === "ui_state") return bridge?.respond(command, {});
      if (READS.some((entry) => entry.name === command.toolName)) {
        refused.push(command.toolName as string);
        return bridge?.respondProblem(command, {
          schema: "morrow.bridge.problem.v1", code: "canvas_binding_required",
          message: "Morrow sent nothing: the Canvas site tab for Biology is not open and signed in.", recoverable: true,
        });
      }
      return bridge?.respond(command, { schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200, truncated: false, data: [] });
    });
    try {
      for (const entry of READS) {
        const result = await read(entry);
        expect(result.isError, entry.name).toBe(true);
        expect(text(result), entry.name).toBe(COURSE_CONNECTION_UNUSABLE);
        expect(problem(result), entry.name).toMatchObject({
          code: "upstream_error_sanitized", recoverable: true, resultState: "not_sent", sourceCode: "canvas_binding_required",
        });
        expect(JSON.stringify(result), entry.name).not.toContain("Biology");
      }
      expect(refused).toEqual(READS.map((entry) => entry.name));
    } finally { await bridge.close(); bridge = undefined; }
  }, 60_000);
});
