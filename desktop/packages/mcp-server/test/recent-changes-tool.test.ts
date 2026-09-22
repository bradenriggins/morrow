import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { registerOperationTools } from "../src/operation-tools.js";
import type { GatewayRuntime } from "../src/runtime.js";

type RecentChangesHandler = () => Promise<CallToolResult>;

/**
 * Captures the tool `registerOperationTools` registers as `morrow_recent_changes`, without
 * standing up a transport or an approval server. `recentChangesUrl` is a capability GatewayRuntime
 * does not itself carry (WI-6.4, the same optional-capability shape as `batchApprovalStatus`
 * above it in `operation-tools.ts`), so what these tests prove is the tool's own handling of that
 * capability being present, absent, or throwing -- not any particular server composition.
 */
function registerRecentChanges(runtime: GatewayRuntime): RecentChangesHandler {
  let handler: RecentChangesHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _definition: unknown, callback: RecentChangesHandler) => {
      if (name === "morrow_recent_changes") handler = callback;
    },
  } as unknown as McpServer;
  registerOperationTools(fakeServer, runtime);
  if (!handler) throw new Error("morrow_recent_changes was not registered");
  return handler;
}

describe("morrow_recent_changes", () => {
  it("returns the review server's link when the runtime can mint one", async () => {
    const url = "http://127.0.0.1:41000/recent?entry=code-1234";
    const runtime = { recentChangesUrl: () => url } as unknown as GatewayRuntime;
    const handler = registerRecentChanges(runtime);
    const result = await handler();
    expect(result.isError).not.toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain(url);
    expect(result.structuredContent).toMatchObject({ url });
  });

  it("fails clearly, without throwing, when the server that registered it has no recent changes page", async () => {
    const runtime = {} as unknown as GatewayRuntime;
    const handler = registerRecentChanges(runtime);
    const result = await handler();
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as JsonObject;
    expect((structured.data as JsonObject)?.code).toBe("operation_unavailable");
  });

  it("fails clearly when minting the entry code itself throws", async () => {
    const runtime = {
      recentChangesUrl: () => { throw new Error("recentEntries capacity reached"); },
    } as unknown as GatewayRuntime;
    const handler = registerRecentChanges(runtime);
    const result = await handler();
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as JsonObject;
    expect((structured.data as JsonObject)?.code).toBe("operation_unavailable");
  });
});

describe("morrow_recent_changes in the full Morrow server", () => {
  it("hands out a link that opens the recent changes page once", async () => {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
    const { fileURLToPath } = await import("node:url");
    const { parseGatewayConfig } = await import("../src/config.js");
    const { MorrowRuntime } = await import("../src/morrow-runtime.js");
    const { createFullMorrowServer } = await import("../src/full-server.js");
    const runtime = await MorrowRuntime.connect(parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      upstreams: [{
        id: "morrow-legacy",
        label: "Morrow legacy fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url))],
        env: { FAKE_SOURCE: "morrow-legacy" },
        priority: 1,
        required: true,
        enabled: true,
      }],
      filters: { excludePrefixes: [], excludeNames: [] },
      operationJournal: { path: ":memory:" },
      maxCatalogTools: 20,
    }), { statePath: ":memory:" });
    const client = new Client({ name: "recent-changes-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => createFullMorrowServer(runtime), { transport: b });
    try {
      await client.connect(a);
      const result = await client.callTool({ name: "morrow_recent_changes", arguments: {} }) as CallToolResult;
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const url = String((result.structuredContent as JsonObject).url);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/recent\?entry=[A-Za-z0-9_-]{43}$/);
      expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
      expect((await fetch(url, { redirect: "manual" })).status).toBe(409);
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  }, 20_000);
});
