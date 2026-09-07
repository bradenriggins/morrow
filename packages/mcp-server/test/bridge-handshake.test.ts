import { describe, expect, it } from "vitest";
import { LoopbackBridgeServer } from "@morrow/bridge-loopback";
import { BRIDGE_SCHEMAS, type BridgeBinding } from "@morrow/bridge-protocol";
import {
  BRIDGE_TEST_RUNTIME_REVISION,
  BRIDGE_TEST_WAIT_MS,
  BridgeClosedError,
  BridgeTimeoutError,
  connectBridgeTestClient,
} from "./fixtures/bridge-client.js";

const TOKEN = "bridge-handshake-test-token-".repeat(2);
const WRONG_TOKEN = "bridge-handshake-wrong-token-".repeat(2);
const EXTENSION_ID = "a".repeat(32);
const OTHER_EXTENSION_ID = "b".repeat(32);
const UNKNOWN_EXTENSION_ID = "c".repeat(32);
const CATALOG_DIGEST = "1".repeat(64);
const WRONG_CATALOG_DIGEST = "0".repeat(64);

const BINDINGS: readonly BridgeBinding[] = [{
  sourceBindingId: "canvas:bridge-handshake",
  provider: "canvas",
  origin: "https://school.instructure.com",
  courseId: "42",
  principalFingerprint: "c".repeat(64),
  sessionGeneration: 1,
  catalogDigest: CATALOG_DIGEST,
  runtimeVerified: true,
}];

async function withBridge(run: (port: number, bridge: LoopbackBridgeServer) => Promise<void>): Promise<void> {
  const bridge = new LoopbackBridgeServer({
    token: TOKEN,
    expectedRuntimeRevision: BRIDGE_TEST_RUNTIME_REVISION,
    expectedCatalogDigest: CATALOG_DIGEST,
    // Both ids pass the upgrade allowlist, so a refusal below is the hello
    // identity check and not the transport.
    allowedExtensionIds: [EXTENSION_ID, OTHER_EXTENSION_ID],
    heartbeatMs: 60_000,
  });
  const { port } = await bridge.start();
  try {
    await run(port, bridge);
  } finally {
    await bridge.close();
  }
}

// The bridge refuses a mismatched hello by closing the socket
// (packages/bridge-loopback/src/index.ts:500-508). A test that waits on
// once(socket, "message") never sees that close, so each refusal below asserts
// the exact close code inside the deadline.
describe("Bridge handshake", () => {
  it("accepts a matching hello and carries one command to a result", async () => {
    await withBridge(async (port, bridge) => {
      const client = await connectBridgeTestClient({
        port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: CATALOG_DIGEST, bindings: BINDINGS,
      });
      try {
        expect(client.ready).toMatchObject({
          schema: BRIDGE_SCHEMAS.ready,
          acceptedExtensionId: EXTENSION_ID,
          catalogDigest: CATALOG_DIGEST,
        });
        const invoked = bridge.invoke({
          kind: "invoke_read",
          toolName: "canvas_get_single_course_courses",
          operationKey: "GET /v1/courses/{id}#get_single_course_courses",
          sourceBindingId: "canvas:bridge-handshake",
          arguments: { id: "42" },
        });
        const command = await client.waitForCommand((candidate) => candidate.kind === "invoke_read");
        expect(command.toolName).toBe("canvas_get_single_course_courses");
        client.respond(command, {
          schema: "morrow.canvas-browser-result.v1",
          ok: true,
          sent: true,
          status: 200,
          data: { id: "42", name: "Biology" },
        });
        expect(await invoked).toMatchObject({ ok: true, generation: client.generation });
      } finally {
        await client.close();
      }
    });
  }, 15_000);

  it("refuses a wrong catalog digest with close code 4403 inside the deadline", async () => {
    await withBridge(async (port) => {
      const startedAt = Date.now();
      const refused = connectBridgeTestClient({
        port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: WRONG_CATALOG_DIGEST, bindings: BINDINGS,
      });
      await expect(refused).rejects.toThrow(BridgeClosedError);
      await expect(refused).rejects.toMatchObject({ code: 4403, reason: "bridge_identity_refused" });
      await expect(refused).rejects.toThrow(/4403 bridge_identity_refused/);
      expect(Date.now() - startedAt).toBeLessThan(BRIDGE_TEST_WAIT_MS);
    });
  }, 15_000);

  it("refuses a wrong token with close code 4403", async () => {
    await withBridge(async (port) => {
      const refused = connectBridgeTestClient({
        port, token: WRONG_TOKEN, extensionId: EXTENSION_ID, catalogDigest: CATALOG_DIGEST, bindings: BINDINGS,
      });
      await expect(refused).rejects.toMatchObject({ code: 4403, reason: "bridge_identity_refused" });
    });
  }, 15_000);

  it("refuses a wrong runtime revision with close code 4403", async () => {
    await withBridge(async (port) => {
      const refused = connectBridgeTestClient({
        port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: CATALOG_DIGEST, bindings: BINDINGS,
        runtimeRevision: "1.0.0-rc.1",
      });
      await expect(refused).rejects.toMatchObject({ code: 4403, reason: "bridge_identity_refused" });
    });
  }, 15_000);

  it("refuses an extension id that does not match the connection origin with close code 4403", async () => {
    await withBridge(async (port) => {
      const refused = connectBridgeTestClient({
        port, token: TOKEN, extensionId: OTHER_EXTENSION_ID, catalogDigest: CATALOG_DIGEST, bindings: BINDINGS,
        origin: `chrome-extension://${EXTENSION_ID}`,
      });
      await expect(refused).rejects.toMatchObject({ code: 4403, reason: "bridge_identity_refused" });
    });
  }, 15_000);

  it("fails fast when an unknown extension is dropped at the upgrade", async () => {
    await withBridge(async (port) => {
      const startedAt = Date.now();
      // An id outside the allowlist never reaches the hello: the upgrade is
      // destroyed, so there is no close code to report.
      await expect(connectBridgeTestClient({
        port, token: TOKEN, extensionId: UNKNOWN_EXTENSION_ID, catalogDigest: CATALOG_DIGEST, bindings: BINDINGS,
      })).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(BRIDGE_TEST_WAIT_MS);
    });
  }, 15_000);

  it("gives every wait a deadline instead of waiting for a command that never comes", async () => {
    await withBridge(async (port) => {
      const client = await connectBridgeTestClient({
        port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: CATALOG_DIGEST, bindings: BINDINGS,
      });
      try {
        await expect(client.waitForCommand(() => true, 250)).rejects.toThrow(BridgeTimeoutError);
      } finally {
        await client.close();
      }
    });
  }, 15_000);

  it("rejects a waiting command with the close code when the bridge disconnects", async () => {
    await withBridge(async (port, bridge) => {
      const client = await connectBridgeTestClient({
        port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: CATALOG_DIGEST, bindings: BINDINGS,
      });
      const waiting = expect(client.waitForCommand(() => true)).rejects.toMatchObject({
        code: 1001,
        reason: "server_shutdown",
      });
      await bridge.close();
      await waiting;
    });
  }, 15_000);
});
