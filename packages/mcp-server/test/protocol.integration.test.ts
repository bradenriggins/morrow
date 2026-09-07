import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const entryPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "morrow-protocol-"));
  temporaryDirectories.push(directory);
  return directory;
}

function config(environment: Record<string, string> = {}) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "fixture",
      label: "Fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_SOURCE: "fixture", ...environment },
      priority: 1,
      required: true,
      enabled: true,
      outputPrivacy: {
        canvas_page_get: {
          allowedFields: ["source", "course_id", "large"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 250_000,
          freeText: "allow",
          learnerTokens: false,
          artifactInspection: "deny",
        },
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 20,
  });
}

async function readLog(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch { return ""; }
}

async function waitFor(predicate: () => Promise<boolean>, detail: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${detail}`);
}

async function publicConfig(
  directory: string,
  environment: Record<string, string> = {},
  toolSurface: "compact" | "full" = "full",
): Promise<string> {
  const path = join(directory, "morrow.upstreams.json");
  const sourceId = environment.FAKE_SOURCE === "example-legacy" ? "example-legacy" : "fixture";
  await writeFile(path, JSON.stringify({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface,
    upstreams: [{
      id: sourceId,
      label: "Fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_SOURCE: "fixture", ...environment },
      priority: 1,
      required: true,
      enabled: true,
      outputPrivacy: {
        canvas_page_get: {
          allowedFields: ["source", "course_id", "large"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 250_000,
          freeText: "allow",
          learnerTokens: false,
          artifactInspection: "deny",
        },
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 20,
  }), "utf8");
  return path;
}

async function connectPublic(
  path: string,
  negotiation: "legacy" | "auto" | { pin: string } = "legacy",
): Promise<Client> {
  const client = new Client(
    { name: "morrow-protocol-test", version: "1.0.0" },
    { versionNegotiation: { mode: negotiation } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPath],
    env: { ...getDefaultEnvironment(), MORROW_UPSTREAMS_FILE: path },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

describe("Morrow public stdio protocol", () => {
  it("serves legacy and current SDK eras through the same public entry", async () => {
    const directory = await temporaryDirectory();
    const path = await publicConfig(directory);
    const legacy = await connectPublic(path);
    try {
      expect(legacy.getProtocolEra()).toBe("legacy");
      const legacyTools = (await legacy.listTools()).tools;
      expect(legacyTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "morrow_health",
        "morrow_result_page",
        "morrow_check_new_quiz",
        "canvas_page_get",
      ]));
      const batchRun = legacyTools.find((tool) => tool.name === "morrow_batch_run");
      expect(batchRun).toBeDefined();
      expect((batchRun?.inputSchema.properties as Record<string, unknown>)).not.toHaveProperty("rate_policy");
    } finally {
      await legacy.close();
    }

    const modern = await connectPublic(path, { pin: "2026-07-28" });
    try {
      expect(modern.getProtocolEra()).toBe("modern");
      expect((await modern.listTools()).tools.map((tool) => tool.name)).toContain("canvas_page_get");
    } finally {
      await modern.close();
    }
  }, 20_000);

  it("rejects invalid tool input without a backend call and keeps serving", async () => {
    const directory = await temporaryDirectory();
    const callLog = join(directory, "calls.log");
    const path = await publicConfig(directory, { FAKE_CALL_LOG: callLog });
    const client = await connectPublic(path);
    try {
      const invalid = await client.callTool({
        name: "canvas_page_get",
        arguments: { course_id: 101 },
      });
      expect(invalid.isError).toBe(true);
      expect(await readLog(callLog)).toBe("");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_health");
      const placeholder = await client.callTool({
        name: "morrow_operation_cancel",
        arguments: { operation_id: "operation:placeholder" },
      });
      expect(placeholder.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        phase: "rejected",
        data: { code: "operation_unavailable" },
      });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("discovers, reads, and plans through the compact capability surface", async () => {
    const directory = await temporaryDirectory();
    const callLog = join(directory, "calls.log");
    const path = await publicConfig(
      directory,
      { FAKE_SOURCE: "example-legacy", FAKE_CALL_LOG: callLog },
      "compact",
    );
    const client = await connectPublic(path);
    try {
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "morrow_catalog_search",
        "morrow_capability_get",
        "morrow_capability_read",
        "morrow_capability_change",
      ]));
      expect(names).not.toContain("canvas_page_get");
      expect(tools.find((tool) => tool.name === "morrow_capability_read")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((tool) => tool.name === "morrow_capability_change")?.annotations?.readOnlyHint).toBe(false);

      const catalog = await client.callTool({
        name: "morrow_catalog_search",
        arguments: { query: "canvas_page_get" },
      });
      expect(catalog.structuredContent).toMatchObject({
        schema: "morrow.catalog.search.v1",
        totalMatches: 1,
        tools: [{ publicName: "canvas_page_get" }],
      });
      const capability = await client.callTool({
        name: "morrow_capability_get",
        arguments: { name: "canvas_page_get" },
      });
      expect(capability.structuredContent).toMatchObject({
        schema: "morrow.capability-get.v1",
        descriptor: {
          canonicalName: "canvas_page_get",
          inputSchema: {
            properties: {
              _morrow: {
                properties: {
                  readback: { required: ["tool", "arguments", "expected_digest"] },
                  approval_ttl_ms: { minimum: 60_000 },
                },
              },
            },
          },
        },
      });
      const read = await client.callTool({
        name: "morrow_capability_read",
        arguments: { name: "canvas_page_get", arguments: { course_id: "101" } },
      });
      expect(read.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        data: { source: "example-legacy", course_id: "101" },
      });
      const wrongMode = await client.callTool({
        name: "morrow_capability_read",
        arguments: { name: "morrow_legacy_only", arguments: {} },
      });
      expect(wrongMode.structuredContent).toMatchObject({ code: "capability_mode_mismatch" });
      const planned = await client.callTool({
        name: "morrow_capability_change",
        arguments: {
          name: "morrow_legacy_only",
          arguments: {
            value: "compact-plan",
            _morrow: {
              readback: {
                tool: "canvas_page_get",
                arguments: { course_id: "101" },
                expected_digest: "a".repeat(64),
              },
            },
          },
        },
      });
      expect(planned.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        phase: "planned",
        effectState: "awaiting_approval",
      });
      expect((await readLog(callLog)).trim().split("\n")).toEqual(["canvas_page_get"]);
    } finally {
      await client.close();
    }
  }, 20_000);

  it("rejects invalid compact capability input before the backend", async () => {
    const directory = await temporaryDirectory();
    const callLog = join(directory, "calls.log");
    const path = await publicConfig(directory, { FAKE_CALL_LOG: callLog }, "compact");
    const client = await connectPublic(path);
    try {
      const invalid = await client.callTool({
        name: "morrow_capability_read",
        arguments: { name: "canvas_page_get", arguments: { course_id: 101 } },
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({ code: "capability_input_invalid" });
      expect(await readLog(callLog)).toBe("");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("does not dispatch an already-cancelled request and propagates a later cancellation", async () => {
    const directory = await temporaryDirectory();
    const callLog = join(directory, "calls.log");
    const runtime = await GatewayRuntime.connect(config({ FAKE_CALL_LOG: callLog }), { journalPath: ":memory:" });
    try {
      const signal = new AbortController();
      signal.abort();
      const cancelled = await runtime.call("canvas_page_get", { course_id: "101" }, { signal: signal.signal });
      expect(cancelled.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        phase: "read",
        data: { code: "request_cancelled_before_dispatch" },
      });
      expect(await readLog(callLog)).toBe("");
      expect(runtime.health().operationJournal.totalOperations).toBe(0);
    } finally {
      await runtime.close();
    }

    const path = await publicConfig(directory, { FAKE_CALL_LOG: callLog, FAKE_DELAY_MS: "5000" });
    const client = await connectPublic(path);
    try {
      const controller = new AbortController();
      const pending = client.callTool({
        name: "canvas_page_get",
        arguments: { course_id: "101" },
      }, { signal: controller.signal }).catch(() => undefined);
      await waitFor(async () => (await readLog(callLog)).includes("canvas_page_get"), "source dispatch");
      controller.abort();
      await pending;
      await waitFor(async () => (await readLog(callLog)).includes("aborted"), "upstream cancellation");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_health");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("returns a bounded artifact handle for a large result and pages it", async () => {
    const directory = await temporaryDirectory();
    const path = await publicConfig(directory, { FAKE_LARGE_RESULT_CHARS: "70000" });
    const client = await connectPublic(path);
    try {
      const result = await client.callTool({
        name: "canvas_page_get",
        arguments: { course_id: "101" },
      });
      expect(result.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        data: { schema: "morrow.result-artifact.v1" },
      });
      const handle = (result.structuredContent as { data: { handle: string } }).data.handle;
      const page = await client.callTool({
        name: "morrow_result_page",
        arguments: { handle, limit: 1000 },
      });
      expect(page.structuredContent).toMatchObject({
        schema: "morrow.result-page.v1",
        handle,
        returned: 1000,
        nextOffset: 1000,
      });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("fails a contaminated upstream at readiness and accepts a clean source afterwards", async () => {
    await expect(GatewayRuntime.connect(config({ FAKE_STDOUT_CONTAMINATION: "1" }), {
      journalPath: ":memory:",
    })).rejects.toThrow();
    const runtime = await GatewayRuntime.connect(config(), { journalPath: ":memory:" });
    try {
      expect(runtime.health().ready).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("returns a typed malformed-message error and serves the next request", async () => {
    const directory = await temporaryDirectory();
    const path = await publicConfig(directory);
    const processHandle = spawn(process.execPath, [entryPath], {
      env: { ...process.env, MORROW_UPSTREAMS_FILE: path },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Record<string, unknown>[] = [];
    let buffer = "";
    processHandle.stdout.setEncoding("utf8");
    processHandle.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const message = async (value: Record<string, unknown>) => {
      processHandle.stdin.write(`${JSON.stringify(value)}\n`);
    };
    try {
      processHandle.stdin.write("not json\n");
      await waitFor(async () => messages.some((entry) => (entry.error as { code?: number } | undefined)?.code === -32700), "parse error");
      processHandle.stdin.write("{}\n");
      await waitFor(async () => messages.some((entry) => (entry.error as { code?: number } | undefined)?.code === -32600), "invalid request error");
      await message({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "raw-test", version: "1.0.0" },
        },
      });
      await waitFor(async () => messages.some((entry) => entry.id === 1 && "result" in entry), "initialize response");
      await message({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      await message({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await waitFor(async () => messages.some((entry) => entry.id === 2 && "result" in entry), "tools/list response");
    } finally {
      processHandle.kill("SIGTERM");
    }
  }, 20_000);
});
