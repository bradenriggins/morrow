import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";
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
