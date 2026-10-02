import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LoopbackBridgeServer } from "@morrow/bridge-loopback";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime, bridgeMismatchDetail } from "../src/morrow-runtime.js";
import { bridgeMismatchGuidance } from "../src/server.js";

const expectedRevision = "1.0.0-rc.2";
const expectedDigest = "a".repeat(64);
const extensionId = "a".repeat(32);

function mismatchBridge(reason: string, received: Record<string, unknown>) {
  return {
    schema: "morrow.bridge.health.v1",
    listening: true,
    connected: false,
    lastMismatch: {
      schema: "morrow.bridge.version-mismatch.v1",
      reason,
      receivedRuntimeRevision: null,
      receivedCatalogDigest: null,
      receivedExtensionVersion: null,
      receivedProtocolVersion: null,
      expectedRuntimeRevision: expectedRevision,
      expectedCatalogDigest: expectedDigest,
      expectedExtensionVersion: "9.9.9",
      expectedProtocolVersion: 1,
      at: Date.now(),
      ...received,
    },
  };
}

describe("bridge mismatch health detail", () => {
  it("names the expected and received revision and digest", () => {
    const detail = bridgeMismatchDetail(mismatchBridge("bridge_version_mismatch", {
      receivedRuntimeRevision: "9.9.9",
      receivedCatalogDigest: "b".repeat(64),
    }));
    expect(detail).toContain("9.9.9");
    expect(detail).toContain(expectedRevision);
    expect(detail).toContain("b".repeat(12));
    expect(detail).toContain("a".repeat(12));
    expect(detail).toContain("Update Morrow Bridge and reload the extension");
  });

  it("names the expected and received Bridge build when one is configured", () => {
    const detail = bridgeMismatchDetail(mismatchBridge("bridge_version_mismatch", {
      receivedRuntimeRevision: expectedRevision,
      receivedCatalogDigest: expectedDigest,
      receivedExtensionVersion: "9.9.8",
    }));
    expect(detail).toContain("9.9.8");
    expect(detail).toContain("9.9.9");
  });

  it("names the expected and received protocol on a protocol mismatch", () => {
    const detail = bridgeMismatchDetail(mismatchBridge("bridge_protocol_mismatch", {
      receivedProtocolVersion: 2,
    }));
    expect(detail).toContain("protocol 2");
    expect(detail).toContain("expects protocol 1");
    expect(detail).toContain("Update Morrow and Morrow Bridge to the same release");
  });

  it("reports nothing without a mismatch record", () => {
    expect(bridgeMismatchDetail(null)).toBeNull();
    expect(bridgeMismatchDetail({ schema: "morrow.bridge.health.v1", listening: true, connected: false })).toBeNull();
  });
});

describe("bridge mismatch tool guidance", () => {
  it("guides an update when the bridge reports a mismatch, without a runtime reason", () => {
    const guidance = bridgeMismatchGuidance({
      ready: false,
      components: { extensionBridge: mismatchBridge("bridge_version_mismatch", { receivedRuntimeRevision: "9.9.9" }) },
    });
    expect(guidance).toContain("Update Morrow Bridge and reload the extension");
  });

  it("reports nothing without structured mismatch evidence", () => {
    expect(bridgeMismatchGuidance({ ready: false })).toBeNull();
    expect(bridgeMismatchGuidance({
      ready: false,
      components: { extensionBridge: { connected: false } },
    })).toBeNull();
  });
});

describe("stale Bridge build health", () => {
  it("names the skewed build in morrow_health with update guidance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-bridge-mismatch-"));
    const root = resolve("../..");
    const token = "gateway-connector-secret-".repeat(3);
    const probe = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: expectedRevision,
      expectedCatalogDigest: expectedDigest,
      port: 0,
    });
    const { port } = await probe.start();
    await probe.close();
    const config = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      upstreams: [{
        id: "canvas-session",
        label: "Morrow Bridge",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")],
        cwd: root,
        env: {
          MORROW_CANVAS_CATALOG_PATH: resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"),
          MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
          MORROW_CANVAS_CONNECTOR_PORT: String(port),
          MORROW_CANVAS_CONNECTOR_TOKEN: token,
          MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: extensionId,
        },
        sourceDisposition: "adapted_owned",
        required: true,
        outputPrivacy: {},
        outputPrivacyDefault: {
          allowedFields: [],
          fieldPolicy: "scrub-sensitive",
          dataClass: "course",
          maxRecords: 10_000,
          maxBytes: 2_000_000,
          freeText: "allow",
          learnerTokens: true,
          artifactInspection: "deny",
          aiClientAdmission: "allow",
        },
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: join(directory, "gateway.sqlite3") },
      privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
      maxCatalogTools: 2_000,
    });

    const morrow = await MorrowRuntime.connect(config, { statePath: join(directory, "morrow.sqlite3") });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createFullMorrowServer(morrow), { transport: serverTransport });
    const client = new Client(
      { name: "morrow-mismatch-health", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const socket = new WebSocket(`ws://127.0.0.1:${port}/morrow-bridge/v1`, {
      origin: `chrome-extension://${extensionId}`,
    });
    try {
      await client.connect(clientTransport);
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.send(JSON.stringify({
        schema: "morrow.bridge.authenticate.v1",
        protocolVersion: 1,
        clientNonce: randomBytes(32).toString("hex"),
        extensionId,
        runtimeRevision: "9.9.9",
        catalogDigest: "b".repeat(64),
        sentAt: Date.now(),
      }));
      const [code, reason] = await closed as [number, Buffer];
      expect(code).toBe(4403);
      expect(reason.toString()).toBe("bridge_version_mismatch");

      const health = await client.callTool({ name: "morrow_health", arguments: {} });
      expect(health.isError, JSON.stringify(health)).not.toBe(true);
      expect(health.structuredContent).toMatchObject({
        ready: false,
        components: {
          extensionBridge: {
            connected: false,
            lastMismatch: {
              reason: "bridge_version_mismatch",
              receivedRuntimeRevision: "9.9.9",
              expectedRuntimeRevision: expectedRevision,
            },
          },
        },
      });
      const text = (health.content as [{ type: string; text: string }])[0]?.text ?? "";
      expect(text).toContain("9.9.9");
      expect(text).toContain(expectedRevision);
      expect(text).toContain("Update Morrow Bridge and reload the extension");

      const connectorHealth = await client.callTool({
        name: "morrow_capability_read",
        arguments: { name: "morrow_canvas_connector_health", arguments: {} },
      });
      expect(connectorHealth.isError, JSON.stringify(connectorHealth)).not.toBe(true);
      expect(connectorHealth.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        data: {
          schema: "morrow.canvas-connector.health.v1",
          bridge: {
            connected: false,
            expectedRuntimeRevision: expectedRevision,
            expectedExtensionVersion: null,
            lastMismatch: {
              reason: "bridge_version_mismatch",
              receivedRuntimeRevision: "9.9.9",
              expectedRuntimeRevision: expectedRevision,
            },
          },
        },
      });
    } finally {
      socket.close();
      await client.close();
      await server.close();
      await morrow.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
