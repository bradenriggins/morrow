import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

describe("Morrow stdio entry", () => {
  it("keeps the runtime open after initialization and serves a forwarded call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-stdio-entry-"));
    const configPath = join(directory, "upstreams.json");
    const fixturePath = resolve("test/fixtures/fake-upstream.mjs");
    const entryPath = resolve("dist/index.js");
    await writeFile(configPath, `${JSON.stringify({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      sourcePolicy: { requireAttestation: false },
      upstreams: [{
        id: "fixture",
        label: "Fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [fixturePath],
        priority: 1,
        required: true,
        enabled: true,
        env: {},
      }],
      filters: { excludePrefixes: ["mindtap_", "connect_"], excludeNames: [] },
      operationJournal: { path: ":memory:" },
      batchScheduler: { maxConcurrentWindows: 1 },
      maxCatalogTools: 1000,
    }, null, 2)}\n`, "utf8");

    const client = new Client({ name: "morrow-stdio-entry-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPath],
      env: {
        ...process.env,
        MORROW_UPSTREAMS_FILE: configPath,
      },
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === "canvas_page_get")).toBe(true);
      const result = await client.callTool({
        name: "canvas_page_get",
        arguments: { course_id: "1" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ source: "fake", course_id: "1" });
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
