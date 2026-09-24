import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import type { JsonObject } from "@morrow/contracts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it, vi } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime, PrivateChatBridgeProblemError, PrivateChatWaitEndedError } from "../src/runtime.js";
import { createMorrowServer } from "../src/server.js";
import { buildLocalCanvasConfig } from "../../client-config/src/index.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";

const SOURCE_BINDING_ID = "canvas:course-2";
const ORIGIN = "https://canvas.example.edu";
const TOKEN = "private-chat-label-gateway-token-".repeat(2);
const EXTENSION_ID = "b".repeat(32);
const ROSTER = [
  { id: 98765, name: "Jane Doe", sortable_name: "Doe, Jane", login_id: "jdoe" },
  { id: 55123, name: "Robert Smith", sortable_name: "Smith, Robert", login_id: "rsmith" },
];

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

describe("Private Chat course labels", () => {
  it("gives a student the same label in Private Chat as in every tool result", async () => {
    const root = resolve("../..");
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-chat-labels-"));
    const port = await availablePort();
    const catalogDigest = bridgeCatalogDigestForTests(root);
    const runtime = await GatewayRuntime.connect(connectorConfig(root, directory, port));
    let bridge: BridgeTestClient | undefined;
    const exchanges: JsonObject[] = [];
    try {
      bridge = await connectBridgeTestClient({
        port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest,
        bindings: [{
          sourceBindingId: SOURCE_BINDING_ID, provider: "canvas" as const, origin: ORIGIN, siteUrl: `${ORIGIN}/`,
          courseId: "2", principalFingerprint: "c".repeat(64),
          sessionGeneration: 1, catalogDigest, editPolicyRevision: 0, runtimeVerified: true,
        }],
      });
      bridge.onCommand((command: BridgeCommand) => {
        if (command.kind === "private_chat_exchange") {
          const input = command.arguments as JsonObject;
          exchanges.push(structuredClone(input));
          // The Bridge names only the platform id of the student in the message.
          if (input.action === "listen") {
            bridge?.respond(command, {
              schema: "morrow.private-chat.exchange.v1", status: "labels_required", sessionId: input.sessionId as string,
              sourceBindingId: SOURCE_BINDING_ID, courseId: "2", learnerIds: ["55123"],
            });
          } else {
            const labels = input.labelsById as Record<string, string>;
            bridge?.respond(command, {
              schema: "morrow.private-chat.exchange.v1", status: "message", sessionId: input.sessionId as string,
              sourceBindingId: SOURCE_BINDING_ID, courseId: "2", protectedText: `Review ${labels["55123"]}'s essay.`,
            });
          }
          return;
        }
        const rosterRead = command.toolName === "canvas_list_users_in_course_users";
        bridge?.respond(command, {
          schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
          data: rosterRead ? ROSTER : { body: "Robert Smith and Jane Doe presented. Grades: /courses/2/grades/55123" },
        });
      });

      const message = await runtime.privateChatExchange({
        schema: "morrow.private-chat.exchange.v1", action: "listen", sessionId: "session-12345678", assistantName: "Desktop assistant",
      });
      expect(message).toEqual({
        schema: "morrow.private-chat.exchange.v1", status: "message", sessionId: "session-12345678",
        sourceBindingId: SOURCE_BINDING_ID, courseId: "2", protectedText: "Review Student A2's essay.",
      });
      expect(exchanges.map((exchange) => exchange.action)).toEqual(["listen", "labels"]);
      expect(exchanges[1]!.labelsById).toEqual({ 55123: "Student A2" });

      const read = await runtime.call("canvas_show_page_courses", { url_or_id: "introduction", course_id: "2", _morrow: { source_binding_id: SOURCE_BINDING_ID } });
      const text = JSON.stringify(read);
      expect(read.isError, text).not.toBe(true);
      expect(text).toContain("Student A2 and Student A1 presented");
      expect(text).toContain("/courses/2/grades/Student A2");
      for (const identity of ["Robert", "Smith", "Jane", "55123", "98765"]) expect(text).not.toContain(identity);
    } finally { await bridge?.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});

const BINDING = {
  sourceBindingId: SOURCE_BINDING_ID, provider: "canvas" as const, origin: ORIGIN, siteUrl: `${ORIGIN}/`,
  courseId: "2", principalFingerprint: "c".repeat(64),
  sessionGeneration: 1, editPolicyRevision: 0, runtimeVerified: true,
};

// The Bridge waits up to 9 minutes for the educator's next message. The gateway's own call to the
// connector must outlast that wait, not end at the MCP SDK's 60-second request default.
describe("Private Chat waits for the educator", () => {
  it("keeps waiting when the educator's message arrives after the MCP default request timeout", async () => {
    const root = resolve("../..");
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-chat-wait-"));
    const port = await availablePort();
    const catalogDigest = bridgeCatalogDigestForTests(root);
    const runtime = await GatewayRuntime.connect(connectorConfig(root, directory, port));
    let bridge: BridgeTestClient | undefined;
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest, bindings: [{ ...BINDING, catalogDigest }] });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const listening = runtime.privateChatExchange({
        schema: "morrow.private-chat.exchange.v1", action: "listen", sessionId: "session-12345678", assistantName: "Desktop assistant",
      });
      const settled = listening.then(() => "resolved", () => "rejected");
      const command = await bridge.waitForCommand((candidate) => candidate.kind === "private_chat_exchange");
      await vi.advanceTimersByTimeAsync(61_000);
      vi.useRealTimers();
      bridge.respond(command, {
        schema: "morrow.private-chat.exchange.v1", status: "message", sessionId: "session-12345678",
        sourceBindingId: SOURCE_BINDING_ID, courseId: "2", protectedText: "Hello.",
      });
      expect(await settled).toBe("resolved");
      expect(await listening).toMatchObject({ status: "message", protectedText: "Hello." });
    } finally { vi.useRealTimers(); await bridge?.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("names the end of the Bridge's wait instead of an invalid relay result", async () => {
    const root = resolve("../..");
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-chat-expired-"));
    const port = await availablePort();
    const catalogDigest = bridgeCatalogDigestForTests(root);
    const runtime = await GatewayRuntime.connect(connectorConfig(root, directory, port));
    let bridge: BridgeTestClient | undefined;
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest, bindings: [{ ...BINDING, catalogDigest }] });
      bridge.onCommand((command: BridgeCommand) => {
        if (command.kind !== "private_chat_exchange") return;
        bridge?.respondProblem(command, { schema: "morrow.bridge.problem.v1", code: "private_chat_wait_expired", message: "Private Chat stopped waiting before a message was sent.", recoverable: true });
      });
      await expect(runtime.privateChatExchange({
        schema: "morrow.private-chat.exchange.v1", action: "listen", sessionId: "session-12345678", assistantName: "Desktop assistant",
      })).rejects.toBeInstanceOf(PrivateChatWaitEndedError);
    } finally { await bridge?.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});

describe("Private Chat at its message limit", () => {
  it("sends the last reply through the connector to the Bridge without listening for another message", async () => {
    const root = resolve("../..");
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-chat-limit-"));
    const port = await availablePort();
    const catalogDigest = bridgeCatalogDigestForTests(root);
    const runtime = await GatewayRuntime.connect(connectorConfig(root, directory, port));
    let bridge: BridgeTestClient | undefined;
    const exchanges: JsonObject[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest, bindings: [{ ...BINDING, catalogDigest }] });
      bridge.onCommand((command: BridgeCommand) => {
        if (command.kind !== "private_chat_exchange") return;
        exchanges.push(structuredClone(command.arguments as JsonObject));
        bridge?.respond(command, { schema: "morrow.private-chat.exchange.v1", status: "closed" });
      });
      await expect(runtime.privateChatExchange({
        schema: "morrow.private-chat.exchange.v1", action: "reply_at_limit", sessionId: "session-12345678", assistantName: "Desktop assistant",
        assistantReply: "Student A1 has until Friday.", sourceBindingId: SOURCE_BINDING_ID, courseId: "2",
      })).resolves.toEqual({ schema: "morrow.private-chat.exchange.v1", status: "closed" });
      expect(exchanges).toEqual([{
        schema: "morrow.private-chat.exchange.v1", action: "reply_at_limit", sessionId: "session-12345678", assistantName: "Desktop assistant",
        assistantReply: "Student A1 has until Friday.", sourceBindingId: SOURCE_BINDING_ID, courseId: "2",
      }]);
    } finally { await bridge?.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});

// The Bridge's own reason reaches the tool, so the educator is told what to fix instead of a
// validation failure that never happened.
describe("Private Chat when Morrow Bridge cannot relay it", () => {
  it("names Morrow Bridge as not connected when Chrome has no Bridge connected", async () => {
    const root = resolve("../..");
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-chat-no-bridge-"));
    const port = await availablePort();
    const runtime = await GatewayRuntime.connect(connectorConfig(root, directory, port));
    const client = new Client({ name: "VS Code", version: "1" }, { capabilities: { sampling: {} }, versionNegotiation: { mode: "legacy" } });
    let sampled = 0;
    client.setRequestHandler("sampling/createMessage", async () => {
      sampled += 1;
      return { model: "local-test", role: "assistant", content: { type: "text", text: "ok" } };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
    try {
      const refused = runtime.privateChatExchange({
        schema: "morrow.private-chat.exchange.v1", action: "listen", sessionId: "session-12345678", assistantName: "Desktop assistant",
      });
      await expect(refused).rejects.toBeInstanceOf(PrivateChatBridgeProblemError);
      await expect(refused).rejects.toMatchObject({ code: "bridge_unavailable" });

      await client.connect(a);
      const result = await client.callTool({ name: "morrow_private_chat", arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toBe(
        "Private Chat unavailable. Morrow Bridge is not connected to Morrow. Open Chrome and open the Morrow Bridge popup, which shows the step that connects it. Then ask the assistant to start Private Chat again.",
      );
      expect(result.structuredContent).toEqual({ schema: "morrow.problem.v1", code: "private_chat_unavailable", sourceCode: "bridge_unavailable" });
      expect(sampled).toBe(0);
    } finally { await client.close(); await server.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("carries the Bridge's reason when another Private Chat is already open", async () => {
    const root = resolve("../..");
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-chat-busy-"));
    const port = await availablePort();
    const catalogDigest = bridgeCatalogDigestForTests(root);
    const runtime = await GatewayRuntime.connect(connectorConfig(root, directory, port));
    let bridge: BridgeTestClient | undefined;
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest, bindings: [{ ...BINDING, catalogDigest }] });
      bridge.onCommand((command: BridgeCommand) => {
        if (command.kind !== "private_chat_exchange") return;
        bridge?.respondProblem(command, { schema: "morrow.bridge.problem.v1", code: "private_chat_busy", message: "Another Private Chat is already open.", recoverable: true });
      });
      const refused = runtime.privateChatExchange({
        schema: "morrow.private-chat.exchange.v1", action: "listen", sessionId: "session-12345678", assistantName: "Desktop assistant",
      });
      await expect(refused).rejects.toBeInstanceOf(PrivateChatBridgeProblemError);
      await expect(refused).rejects.toMatchObject({ code: "private_chat_busy" });
    } finally { await bridge?.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
