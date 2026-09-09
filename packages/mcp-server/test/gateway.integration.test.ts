import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LoopbackBridgeServer, bridgePortInUseMessage } from "@morrow/bridge-loopback";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { GatewayRuntime, mcpRuntimeHealthFromPayload } from "../src/runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

describe("GatewayRuntime stdio federation", () => {
  it("merges, filters, aliases, journals, and forwards through real MCP stdio clients", async () => {
    const config = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      upstreams: [
        {
          id: "meridian",
          label: "ExamplePlatform fixture",
          kind: "mcp-stdio",
          command: process.execPath,
          args: [fixturePath],
          env: { FAKE_SOURCE: "meridian", FAKE_INTERNAL_BRIDGE_MAINTENANCE: "1" },
          priority: 100,
          required: true,
          enabled: true,
          outputPrivacy: {
            canvas_page_get: { allowedFields: ["source", "course_id"], dataClass: "course", maxRecords: 10, maxBytes: 2_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
            meridian_only: { allowedFields: ["source", "tool", "value", "operation_id"], dataClass: "course", maxRecords: 10, maxBytes: 2_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
          },
        },
        {
          id: "example-legacy",
          label: "Morrow legacy fixture",
          kind: "mcp-stdio",
          command: process.execPath,
          args: [fixturePath],
          env: { FAKE_SOURCE: "example-legacy", FAKE_INTERNAL_BRIDGE_MAINTENANCE: "1" },
          priority: 50,
          required: true,
          enabled: true,
          outputPrivacy: {
            canvas_page_get: { allowedFields: ["source", "course_id"], dataClass: "course", maxRecords: 10, maxBytes: 2_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
            morrow_legacy_only: { allowedFields: ["source", "tool", "value", "operation_id"], dataClass: "course", maxRecords: 10, maxBytes: 2_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
          },
        },
      ],
      filters: {
        excludePrefixes: ["mindtap_", "connect_"],
        excludeNames: [],
      },
      operationJournal: { path: ":memory:" },
      maxCatalogTools: 20,
    });

    const runtime = await GatewayRuntime.connect(config, {
      journalPath: ":memory:",
      mcpRuntime: {
        schema: "morrow.mcp-runtime.health.v1",
        packageVersion: "1.0.0-rc.0",
        manifestSha256: "a".repeat(64),
      },
    });
    try {
      const names = runtime.catalog.tools.map((tool) => tool.publicName);
      expect(names).toContain("canvas_page_get");
      expect(names).toContain("morrow_legacy__canvas_page_get");
      expect(names).toContain("meridian_only");
      expect(names).toContain("morrow_legacy_only");
      expect(names.some((name) => name.startsWith("mindtap_"))).toBe(false);
      expect(names.some((name) => name.startsWith("connect_"))).toBe(false);
      expect(names).not.toContain("morrow_browser_edit_policy_set");
      expect(names).not.toContain("morrow_bridge_maintenance");
      expect(names).not.toContain("morrow_private_chat_exchange");
      expect(runtime.catalog.tools.every((tool) => !("meta" in tool))).toBe(true);

      expect(runtime.catalog.collisions).toEqual([{
        requestedName: "canvas_page_get",
        retainedBy: "meridian",
        aliasedSource: "example-legacy",
        aliasedTo: "morrow_legacy__canvas_page_get",
      }]);

      const primary = await runtime.call("canvas_page_get", { course_id: "101" });
      expect(primary.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        phase: "read",
        verification: { status: "not_applicable" },
        data: { source: "meridian", course_id: "101" },
      });
      expect(primary._meta).toEqual({
        "io.morrow/gateway": expect.objectContaining({
          publicToolName: "canvas_page_get",
          upstreamId: "meridian",
          upstreamToolName: "canvas_page_get",
          catalogDigest: runtime.catalog.digest,
          gatewayOperationId: expect.stringMatching(/^gop:/),
          gatewayOperationState: "response_received",
        }),
      });

      const alias = await runtime.call("morrow_legacy__canvas_page_get", { course_id: "202" });
      expect(alias.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        data: { source: "example-legacy", course_id: "202" },
      });

      const firstDedupe = await runtime.call("morrow_legacy_only", {
        value: "write-once",
        _morrow: {
          operation_id: "operation:dedupe-1234",
          readback: {
            tool: "canvas_page_get",
            arguments: { course_id: "101" },
            expected_digest: "a".repeat(64),
          },
        },
      });
      expect(firstDedupe.isError).not.toBe(true);
      expect(firstDedupe.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        phase: "planned",
        effectState: "awaiting_approval",
      });
      const replay = await runtime.call("morrow_legacy_only", {
        value: "write-once",
        _morrow: {
          operation_id: "operation:dedupe-1234",
          readback: {
            tool: "canvas_page_get",
            arguments: { course_id: "101" },
            expected_digest: "a".repeat(64),
          },
        },
      });
      expect(replay.isError).not.toBe(true);
      expect(replay.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        operationId: (firstDedupe.structuredContent as { operationId: string }).operationId,
      });

      const recent = runtime.operationsRecent({ limit: 10 });
      expect(recent.returned).toBe(2);
      const operations = recent.operations as { operationId: string; state: string }[];
      expect(operations.every((operation) => operation.state === "response_received")).toBe(true);
      expect(runtime.operationGet(operations[0]!.operationId)).toMatchObject({
        schema: "morrow.gateway-operation.v1",
        terminal: true,
      });

      const search = runtime.searchCatalog({ query: "canvas", limit: 1 });
      expect(search.returned).toBe(1);
      expect(search.nextOffset).toBe(1);
      expect(search.tools[0]).toMatchObject({
        publicName: "canvas_page_get",
        upstreamId: "meridian",
        inputSchemaSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(search.tools[0]).not.toHaveProperty("inputSchema");

      expect(runtime.health()).toMatchObject({
        ready: true,
        publicToolCount: 4,
        collisionCount: 1,
        excludedToolCount: 10,
        operationJournal: {
          totalOperations: 2,
          unresolvedOperations: 0,
          unknownOperations: 0,
        },
        mcpRuntime: {
          schema: "morrow.mcp-runtime.health.v1",
          packageVersion: "1.0.0-rc.0",
          manifestSha256: "a".repeat(64),
        },
        sources: [
          { id: "meridian", connected: true, toolCount: 7 },
          { id: "example-legacy", connected: true, toolCount: 7 },
        ],
      });
    } finally {
      await runtime.close();
    }
  }, 20_000);
});

describe("packaged MCP runtime identity", () => {
  it("reports the sealed manifest beside the payload it runs from, not what the parent supplies", async () => {
    const root = await mkdtemp(join(tmpdir(), "morrow-mcp-runtime-manifest-"));
    const entrypointDirectory = join(root, "app", "packages", "mcp-server", "dist");
    const manifestPath = join(root, "app", "mcp-runtime-manifest.json");
    const manifest = {
      schema: "morrow.mcp-runtime-manifest.v1",
      package: { name: "@morrow-lms/gateway", version: "1.0.0-rc.0" },
      entrypoint: { path: "packages/mcp-server/dist/index.js", bytes: 341, sha256: "c".repeat(64) },
      dependencies: [],
    };
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    await mkdir(entrypointDirectory, { recursive: true });
    await writeFile(manifestPath, bytes);
    const suppliedVersion = process.env.MORROW_MCP_RUNTIME_PACKAGE_VERSION;
    const suppliedDigest = process.env.MORROW_MCP_RUNTIME_MANIFEST_SHA256;
    process.env.MORROW_MCP_RUNTIME_PACKAGE_VERSION = "9.9.9";
    process.env.MORROW_MCP_RUNTIME_MANIFEST_SHA256 = "a".repeat(64);
    try {
      expect(mcpRuntimeHealthFromPayload(entrypointDirectory)).toEqual({
        schema: "morrow.mcp-runtime.health.v1",
        packageVersion: "1.0.0-rc.0",
        manifestSha256: createHash("sha256").update(bytes).digest("hex"),
      });

      // A source checkout has no sealed manifest and claims no identity.
      expect(mcpRuntimeHealthFromPayload(join(root, "app", "packages", "mcp-server"))).toBeUndefined();

      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, schema: "morrow.other.v1" })}\n`);
      expect(mcpRuntimeHealthFromPayload(entrypointDirectory)).toBeUndefined();

      await writeFile(manifestPath, "{ not json");
      expect(mcpRuntimeHealthFromPayload(entrypointDirectory)).toBeUndefined();
    } finally {
      if (suppliedVersion === undefined) delete process.env.MORROW_MCP_RUNTIME_PACKAGE_VERSION;
      else process.env.MORROW_MCP_RUNTIME_PACKAGE_VERSION = suppliedVersion;
      if (suppliedDigest === undefined) delete process.env.MORROW_MCP_RUNTIME_MANIFEST_SHA256;
      else process.env.MORROW_MCP_RUNTIME_MANIFEST_SHA256 = suppliedDigest;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("second Morrow on a held Bridge port", () => {
  it("starts with its own tools and reports the held port in morrow_health", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-bridge-port-in-use-"));
    const root = resolve("../..");
    const token = "gateway-connector-secret-".repeat(3);
    // Stands in for the Morrow that is already using the Bridge port.
    const firstMorrow = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: "1.0.0-rc.2",
      expectedCatalogDigest: "a".repeat(64),
      port: 0,
    });
    const held = await firstMorrow.start();
    let firstMorrowClosed = false;
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
          MORROW_CANVAS_CONNECTOR_PORT: String(held.port),
          MORROW_CANVAS_CONNECTOR_TOKEN: token,
          MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: "a".repeat(32),
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

    // Before this state existed, the held port ended the whole start-up.
    const morrow = await MorrowRuntime.connect(config, { statePath: join(directory, "gateway.sqlite3") });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createFullMorrowServer(morrow), { transport: serverTransport });
    const client = new Client(
      { name: "morrow-second-instance", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(clientTransport);
      const health = await client.callTool({ name: "morrow_health", arguments: {} });
      expect(health.isError, JSON.stringify(health)).not.toBe(true);
      const detail = `${bridgePortInUseMessage(held.port)} This Morrow started without its Canvas and Moodle browser tools.`;
      expect(health.structuredContent).toMatchObject({
        ready: false,
        readyDetail: detail,
        components: {
          canvasConnector: { processConnected: true, ready: false },
          extensionBridge: {
            connected: false,
            listening: false,
            problem: { code: "bridge_port_in_use", port: held.port, message: bridgePortInUseMessage(held.port) },
          },
        },
      });
      // The person reads this line first, so it names the state.
      expect(health.content).toEqual([{ type: "text", text: detail }]);

      // The rest of Morrow started: its own tools are listed and answer.
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("morrow_health");
      expect(names).toContain("morrow_catalog_search");
      const search = await client.callTool({ name: "morrow_catalog_search", arguments: { query: "page" } });
      expect(search.isError, JSON.stringify(search)).not.toBe(true);

      // The Morrow that holds the port is unchanged.
      expect(firstMorrow.health()).toMatchObject({ listening: true, port: held.port });
      expect(firstMorrow.health().problem).toBeUndefined();

      // Closing the other Morrow is the stated next action, so this Morrow
      // takes the port on its own rather than needing to be started again.
      await firstMorrow.close();
      firstMorrowClosed = true;
      let listening = false;
      const deadline = Date.now() + 20_000;
      while (!listening && Date.now() < deadline) {
        await new Promise((wait) => setTimeout(wait, 250));
        const next = await client.callTool({ name: "morrow_health", arguments: {} });
        const extensionBridge = (next.structuredContent as {
          components?: { extensionBridge?: { listening?: boolean; port?: number; problem?: unknown } };
        }).components?.extensionBridge;
        if (extensionBridge?.listening !== true) continue;
        expect(extensionBridge).toMatchObject({ port: held.port });
        expect(extensionBridge.problem).toBeUndefined();
        listening = true;
      }
      expect(listening).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await morrow.close();
      if (!firstMorrowClosed) await firstMorrow.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
