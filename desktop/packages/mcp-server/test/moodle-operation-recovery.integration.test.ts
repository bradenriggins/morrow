import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";

const ROOT = resolve("../..");
const SOURCE_BINDING_ID = "moodle:recovery-account:g1:c2";
const EXTENSION_ID = "a".repeat(32);
const TOKEN = "gateway-connector-secret-".repeat(3);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  const port = address.port;
  await new Promise<void>((closed) => server.close(() => closed()));
  return port;
}

function connectorConfig(directory: string, port: number) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "canvas-session",
      label: "Morrow browser connector",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [resolve(ROOT, "packages/canvas-connector-mcp/dist/index.js")],
      cwd: ROOT,
      env: {
        MORROW_CANVAS_CATALOG_PATH: resolve(ROOT, "artifacts/canvas-api/canvas-api-catalog.json"),
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN,
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID,
      },
      sourceDisposition: "adapted_owned",
      outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 10_000,
        maxBytes: 2_000_000, freeText: "allow", learnerTokens: true,
        artifactInspection: "deny", aiClientAdmission: "allow",
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(directory, "gateway.sqlite3") },
    privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
    maxCatalogTools: 2_000,
  });
}

describe("Moodle unresolved-operation recovery", () => {
  it("reads the numeric Moodle course through the private connector recovery path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-recovery-"));
    const port = await availablePort();
    const morrow = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath: join(directory, "gateway.sqlite3") });
    let bridge: BridgeTestClient | undefined;
    try {
      bridge = await connectBridgeTestClient({
        port,
        token: TOKEN,
        extensionId: EXTENSION_ID,
        catalogDigest: bridgeCatalogDigestForTests(ROOT),
        bindings: [{
          sourceBindingId: SOURCE_BINDING_ID,
          provider: "moodle",
          origin: "https://sandbox.moodledemo.net",
          siteUrl: "https://sandbox.moodledemo.net/",
          courseId: "2",
          principalFingerprint: "c".repeat(64),
          sessionGeneration: 1,
          catalogDigest: bridgeCatalogDigestForTests(ROOT),
          runtimeVerified: true,
        }],
      });
      bridge.onCommand((command) => {
        expect(command.kind).toBe("invoke_read");
        expect(command.toolName).toBe("moodle_get_contents");
        expect(command.arguments.course_id).toBe(2);
        bridge?.respond(command, {
          schema: "morrow.canvas-browser-result.v1",
          ok: true,
          sent: true,
          status: 200,
          truncated: false,
          data: { activities: [{ id: "10", module: "quiz", name: "MORROWPROOF quiz" }] },
        });
      });
      const runtime = morrow.gateway as unknown as {
        canvasRecoveryRead(read: { readTool: string; arguments: { course_id: number } }, sourceBindingId: string): Promise<unknown>;
      };
      await expect(runtime.canvasRecoveryRead(
        { readTool: "moodle_get_contents", arguments: { course_id: 2 } },
        SOURCE_BINDING_ID,
      )).resolves.toMatchObject({
        ok: true,
        data: { activities: [{ id: "10", module: "quiz", name: "MORROWPROOF quiz" }] },
      });
    } finally {
      await bridge?.close();
      await morrow.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
