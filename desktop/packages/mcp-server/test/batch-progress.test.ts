import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isJsonObject, sha256Json, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-batch-upstream.mjs", import.meta.url));

/** One read-only fixture source, which is all a read group needs. */
function config() {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [
      {
        id: "meridian",
        label: "ExamplePlatform fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [fixturePath],
        env: { FAKE_SOURCE: "meridian" },
        priority: 100,
        required: true,
        enabled: true,
        outputPrivacy: {
          canvas_page_get: {
            allowedFields: ["source", "course_id"],
            dataClass: "course",
            maxRecords: 10,
            maxBytes: 10_000,
            freeText: "deny",
            learnerTokens: false,
            artifactInspection: "deny",
          },
        },
      },
    ],
    filters: { excludePrefixes: ["mindtap_", "connect_"], excludeNames: [] },
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 50,
  });
}

/**
 * Learner text a caller must never see in a progress message. It travels with the frozen child
 * arguments, which is the closest a read group comes to carrying an identity.
 */
const learnerName = "Robin Learner";
const learnerEmail = "robin.learner@example.edu";

function readOperations(courseIds: readonly string[]) {
  return courseIds.map((courseId) => ({
    child_id: `course:${courseId}`,
    course_id: courseId,
    tool: "canvas_page_get",
    arguments: {
      course_id: courseId,
      learner_name: learnerName,
      learner_email: learnerEmail,
    },
  }));
}

function createInput(name: string, courseIds: readonly string[]) {
  return {
    name,
    mode: "read_only",
    concurrency: 2,
    operation_family: "batch-progress-proof",
    operations: readOperations(courseIds),
    profile_digest: sha256Json({ schema: "morrow.batch-progress.profile.v1", name }),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

function structured(result: { readonly structuredContent?: unknown; readonly isError?: boolean }): JsonObject {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  if (!isJsonObject(result.structuredContent)) throw new Error("expected a structured MCP result");
  return result.structuredContent;
}

function runInput(created: JsonObject, maxChildren: number) {
  const batch = created.batch;
  const manifest = created.manifest;
  if (!isJsonObject(batch) || typeof batch.batchId !== "string") throw new Error("batch creation returned no batch id");
  if (!isJsonObject(manifest) || !isJsonObject(manifest.courseSet) || typeof manifest.courseSet.digest !== "string") {
    throw new Error("batch creation returned no course-set digest");
  }
  return {
    batch_id: batch.batchId,
    max_children: maxChildren,
    course_set_digest: manifest.courseSet.digest,
    profile_digest: typeof manifest.profileDigest === "string" ? manifest.profileDigest : "",
  };
}

interface ProgressUpdate {
  readonly progress: number;
  readonly total?: number | undefined;
  readonly message?: string | undefined;
}

describe("batch window progress notifications", () => {
  let runtime: MorrowRuntime;
  let client: Client;
  let server: ReturnType<typeof serveStdio>;
  /** Anything the server sends that no caller asked for. It must stay empty. */
  const unsolicited: string[] = [];

  beforeAll(async () => {
    runtime = await MorrowRuntime.connect(config(), { statePath: ":memory:" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
    client = new Client({ name: "batch-progress-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    client.onerror = (error) => unsolicited.push(error.message);
    client.fallbackNotificationHandler = async (notification) => {
      unsolicited.push(notification.method);
    };
    await client.connect(left);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await runtime?.close();
  });

  it("reports every course a read group finishes to a caller that asked for progress", async () => {
    const courseIds = ["101", "102", "103", "104", "105"];
    const created = structured(await client.callTool({
      name: "morrow_batch_create",
      arguments: createInput("Read five courses", courseIds),
    }));
    const updates: ProgressUpdate[] = [];
    const window = structured(await client.callTool(
      { name: "morrow_batch_run", arguments: runInput(created, 5) },
      { onprogress: (update) => updates.push(update) },
    ));

    expect(window).toMatchObject({ processed: 5, remaining: 0 });
    expect(updates).toHaveLength(5);
    expect(updates.map((update) => update.progress)).toEqual([1, 2, 3, 4, 5]);
    expect(updates.map((update) => update.total)).toEqual([5, 5, 5, 5, 5]);
    const last = updates[updates.length - 1]!;
    expect(last.progress).toBe(last.total);

    const messages = updates.map((update) => update.message ?? "");
    expect(messages.every((message) => message.startsWith("Finished course "))).toBe(true);
    expect(messages.map((message) => message.replace(/^Finished course (\d+)\.$/u, "$1")).sort())
      .toEqual([...courseIds].sort());
    for (const message of messages) {
      expect(message).not.toContain(learnerName);
      expect(message).not.toContain(learnerEmail);
      expect(message).not.toContain("learner");
    }
    expect(unsolicited).toEqual([]);
  }, 30_000);

  it("counts the whole group across windows and reports a resumed run the same way", async () => {
    const courseIds = ["201", "202", "203", "204", "205"];
    const created = structured(await client.callTool({
      name: "morrow_batch_create",
      arguments: createInput("Read five courses in two windows", courseIds),
    }));
    const firstWindow: ProgressUpdate[] = [];
    const first = structured(await client.callTool(
      { name: "morrow_batch_run", arguments: runInput(created, 3) },
      { onprogress: (update) => firstWindow.push(update) },
    ));
    expect(first).toMatchObject({ processed: 3, remaining: 2 });
    expect(firstWindow.map((update) => update.progress)).toEqual([1, 2, 3]);
    expect(firstWindow.map((update) => update.total)).toEqual([5, 5, 5]);

    const secondWindow: ProgressUpdate[] = [];
    const second = structured(await client.callTool(
      { name: "morrow_batch_resume", arguments: runInput(created, 3) },
      { onprogress: (update) => secondWindow.push(update) },
    ));
    expect(second).toMatchObject({ schema: "morrow.batch-resumed.v1", processed: 2, remaining: 0 });
    expect(secondWindow.map((update) => update.progress)).toEqual([4, 5]);
    const last = secondWindow[secondWindow.length - 1]!;
    expect(last.progress).toBe(last.total);
    expect(unsolicited).toEqual([]);
  }, 30_000);

  it("sends nothing extra to a caller that did not ask for progress", async () => {
    const created = structured(await client.callTool({
      name: "morrow_batch_create",
      arguments: createInput("Read two courses without progress", ["301", "302"]),
    }));
    const window = structured(await client.callTool({
      name: "morrow_batch_run",
      arguments: runInput(created, 5),
    }));

    expect(window).toMatchObject({ processed: 2, remaining: 0 });
    // A progress notification for a token this client never issued would arrive here.
    expect(unsolicited).toEqual([]);
  }, 30_000);
});
