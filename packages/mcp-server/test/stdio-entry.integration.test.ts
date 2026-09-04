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
        outputPrivacy: {
          canvas_page_get: {
            allowedFields: ["source", "course_id"],
            dataClass: "course",
            maxRecords: 10,
            maxBytes: 2_000,
            freeText: "deny",
            learnerTokens: false,
            artifactInspection: "deny"
          }
        },
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
      expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "morrow_catalog_search",
        "morrow_capability_get",
        "morrow_profile_status",
      ]));
      const profile = await client.callTool({
        name: "morrow_profile_status",
        arguments: {},
      });
      expect(profile.structuredContent).toMatchObject({
        schema: "morrow.profile-status.v1",
        profile: "private-full",
      });
      const capability = await client.callTool({
        name: "morrow_capability_get",
        arguments: { name: "canvas_page_get" },
      });
      expect(capability.structuredContent).toMatchObject({
        schema: "morrow.capability-get.v1",
        descriptor: { canonicalName: "canvas_page_get" },
      });
      expect(listed.tools.some((tool) => tool.name === "morrow_batch_resume")).toBe(true);
      expect(listed.tools.some((tool) => tool.name === "morrow_batch_results_page")).toBe(true);
      const profileDigest = "a".repeat(64);
      const created = await client.callTool({
        name: "morrow_batch_create",
        arguments: {
          name: "One exact course read",
          mode: "read_only",
          concurrency: 2,
          operation_family: "course_read",
          profile_digest: profileDigest,
          expires_at: "2030-01-01T00:00:00.000Z",
          course_set: {
            source: "explicit",
            course_ids: ["1"],
            complete: true,
            pagination_complete: true,
          },
          operations: [{ child_id: "course:1", course_id: "1", tool: "canvas_page_get", arguments: { course_id: "1" } }],
        },
      });
      expect(created.isError).not.toBe(true);
      const createdContent = created.structuredContent as {
        batch: { batchId: string };
        manifest: { courseSet: { digest: string } };
      };
      const page = await client.callTool({
        name: "morrow_batch_results_page",
        arguments: { batch_id: createdContent.batch.batchId, offset: 0, limit: 1 },
      });
      expect(page.isError).not.toBe(true);
      await client.callTool({ name: "morrow_batch_pause", arguments: { batch_id: createdContent.batch.batchId } });
      const resumed = await client.callTool({
        name: "morrow_batch_resume",
        arguments: {
          batch_id: createdContent.batch.batchId,
          max_children: 1,
          course_set_digest: createdContent.manifest.courseSet.digest,
          profile_digest: profileDigest,
        },
      });
      expect(resumed.isError).not.toBe(true);
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
