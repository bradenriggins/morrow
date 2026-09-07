import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";
import { BatchWindowScheduler } from "../src/batch-window-scheduler.js";
import { registerBatchTools } from "../src/batch-tools.js";
import type { MorrowRuntime } from "../src/morrow-runtime.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("expected batch action did not occur");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const digests = {
  course: "a".repeat(64),
  profile: "b".repeat(64),
};

describe("batch MCP controls", () => {
  it("freezes the only supported Canvas create-result bindings and refuses extra binding fields", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 1 });
    let captured: unknown;
    const runtime = {
      batchScheduler: scheduler,
      batchCreate: async (input: unknown) => {
        captured = input;
        return { schema: "morrow.batch-created.v1" };
      },
    } as unknown as MorrowRuntime;
    const client = new Client({ name: "batch-result-binding-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => {
      const mcp = new McpServer({ name: "batch-result-binding-test", version: "1" });
      registerBatchTools(mcp, runtime);
      return mcp;
    }, { transport: b });
    const request = {
      name: "Place a created page",
      mode: "stage_writes",
      concurrency: 1,
      operation_family: "canvas_course_compose",
      profile_digest: digests.profile,
      expires_at: "2030-01-01T00:00:00.000Z",
      operations: [
        {
          child_id: "page-create",
          course_id: "42",
          tool: "canvas_create_page_courses",
          source_binding_id: "canvas:school:42",
          arguments: { course_id: "42", wiki_page_title: "Cell notes" },
        },
        {
          child_id: "page-place",
          course_id: "42",
          tool: "canvas_create_module_item",
          source_binding_id: "canvas:school:42",
          depends_on: ["page-create"],
          arguments: { course_id: "42", module_id: "9", module_item_type: "Page" },
          result_binding: {
            schema: "morrow.canvas-result-binding.v1",
            source_child_id: "page-create",
            kind: "canvas_page_url_to_module_item_page_url",
          },
        },
      ],
    };
    await client.connect(a);
    try {
      const advertised = (await client.listTools()).tools.find((tool) => tool.name === "morrow_batch_create");
      expect(advertised?.description).toContain("canvas_page_url_to_module_item_page_url binds a canvas_create_page_courses result to a Page canvas_create_module_item");
      expect(advertised?.description).toContain("canvas_assignment_id_to_module_item_content_id binds a canvas_create_assignment result to an Assignment canvas_create_module_item");
      expect(advertised?.description).toContain("must explicitly depend on its source");
      const accepted = await client.callTool({ name: "morrow_batch_create", arguments: request });
      expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
      expect(captured).toMatchObject({
        operations: [
          { childId: "page-create" },
          {
            childId: "page-place",
            resultBinding: {
              schema: "morrow.canvas-result-binding.v1",
              sourceChildId: "page-create",
              kind: "canvas_page_url_to_module_item_page_url",
            },
          },
        ],
      });
      const refused = await client.callTool({
        name: "morrow_batch_create",
        arguments: {
          ...request,
          operations: [{
            ...request.operations[1],
            result_binding: { ...request.operations[1].result_binding, target_value: "caller-controlled" },
          }],
        },
      });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      scheduler.close();
    }
  });

  it("forwards client cancellation and applies pause or cancel while a same-batch window is running", async () => {
    const runStarted = deferred();
    const runGate = deferred();
    const resumeStarted = deferred();
    const resumeGate = deferred();
    let runSignal: AbortSignal | undefined;
    let resumeSignal: AbortSignal | undefined;
    let pauses = 0;
    let cancels = 0;
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 1 });
    const runtime = {
      batchScheduler: scheduler,
      batchRun: async (input: { readonly signal?: AbortSignal }) => {
        runSignal = input.signal;
        runStarted.resolve();
        await runGate.promise;
        return { schema: "morrow.batch-window.v1" };
      },
      batchResume: async (input: { readonly signal?: AbortSignal }) => {
        resumeSignal = input.signal;
        resumeStarted.resolve();
        await resumeGate.promise;
        return { schema: "morrow.batch-resumed.v1" };
      },
      batchPause: () => {
        pauses += 1;
        return { schema: "morrow.batch-paused.v1" };
      },
      batchCancel: () => {
        cancels += 1;
        return { schema: "morrow.batch-cancelled.v1" };
      },
    } as unknown as MorrowRuntime;
    const client = new Client({ name: "batch-tools-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => {
      const mcp = new McpServer({ name: "batch-tools-test", version: "1" });
      registerBatchTools(mcp, runtime);
      return mcp;
    }, { transport: b });
    const input = {
      batch_id: "bat:control-1234",
      max_children: 1,
      course_set_digest: digests.course,
      profile_digest: digests.profile,
    };
    await client.connect(a);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "morrow_program_inventory_create",
        "morrow_program_inventory_create_audit_batch",
      ]));
      const running = client.callTool({ name: "morrow_batch_run", arguments: input });
      await runStarted.promise;
      expect(runSignal).toBeInstanceOf(AbortSignal);
      const paused = client.callTool({ name: "morrow_batch_pause", arguments: { batch_id: input.batch_id } });
      await waitUntil(() => pauses === 1);
      runGate.resolve();
      expect((await paused).isError).not.toBe(true);
      expect((await running).isError).not.toBe(true);

      const resuming = client.callTool({ name: "morrow_batch_resume", arguments: input });
      await resumeStarted.promise;
      expect(resumeSignal).toBeInstanceOf(AbortSignal);
      const cancelled = client.callTool({ name: "morrow_batch_cancel", arguments: { batch_id: input.batch_id } });
      await waitUntil(() => cancels === 1);
      resumeGate.resolve();
      expect((await cancelled).isError).not.toBe(true);
      expect((await resuming).isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
      scheduler.close();
    }
  });

  it("answers a refused batch window with a plain result that names the holding group", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 1 });
    const holdingGate = deferred();
    let runs = 0;
    const runtime = {
      batchScheduler: scheduler,
      batchRun: async () => {
        runs += 1;
        return { schema: "morrow.batch-window.v1" };
      },
    } as unknown as MorrowRuntime;
    const client = new Client({ name: "batch-window-queue-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => {
      const mcp = new McpServer({ name: "batch-window-queue-test", version: "1" });
      registerBatchTools(mcp, runtime);
      return mcp;
    }, { transport: b });
    await client.connect(a);
    try {
      const holding = scheduler.run("bat:holding-1234", () => holdingGate.promise, { holder: "claude-session-1" });
      await waitUntil(() => scheduler.health().activeWindows === 1);
      const queued = Array.from({ length: scheduler.maxQueuedWindows }, (_value, index) => scheduler.run(
        `bat:waiting-${index}`,
        async () => index,
        { queueTimeoutMs: 0 },
      ));
      await waitUntil(() => scheduler.health().waitingWindows === scheduler.maxQueuedWindows);

      const refused = await client.callTool({
        name: "morrow_batch_run",
        arguments: {
          batch_id: "bat:refused-1234",
          max_children: 1,
          course_set_digest: digests.course,
          profile_digest: digests.profile,
        },
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        schema: "morrow.problem.v1",
        code: "batch_window_queue_full",
        batchId: "bat:refused-1234",
        queueDepth: 32,
        maxQueuedWindows: 32,
      });
      const text = (refused.content as readonly { readonly type: string; readonly text?: string }[])[0]?.text ?? "";
      expect(text).toContain("Morrow did not start this run.");
      expect(text).toContain("Group bat:holding-1234 has been running since");
      expect(text).toContain("claude-session-1");
      expect(text).toContain("This run sent nothing to the selected learning platform.");
      expect(runs).toBe(0);

      holdingGate.resolve();
      await holding;
      await Promise.all(queued);
    } finally {
      await client.close();
      await server.close();
      scheduler.close();
    }
  });
});
