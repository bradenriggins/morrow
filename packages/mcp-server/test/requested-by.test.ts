import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";
import { normalizeRequestedBy, type JsonObject } from "@morrow/contracts";
import { ProviderEffectBroker } from "@morrow/operation-journal";
import { LoopbackApprovalServer } from "../src/approval-server.js";
import { registerBatchTools } from "../src/batch-tools.js";
import { BatchWindowScheduler } from "../src/batch-window-scheduler.js";
import type { MorrowRuntime } from "../src/morrow-runtime.js";

const requestedBy = {
  schema: "morrow.requested-by.v1",
  clientName: "Claude Code",
  clientVersion: "2.1.0",
  proxyPid: 4321,
  workspaceName: "biology-101",
  workspaceDigest: "a".repeat(64),
  sessionId: "session-a",
};

const workspaceRoot = "/Users/instructor/courses/biology-101";

function operationSnapshot(): JsonObject {
  return {
    schema: "morrow.operation.v1",
    operationId: "op:requested-by-1234",
    state: "awaiting_approval",
    verificationStatus: "unconfirmed",
    dispatchAttempt: 0,
    requestDigest: "b".repeat(64),
    planDigest: "c".repeat(64),
    approvalExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    requestedBy,
    plan: {
      tool: "moodle_update_page",
      requestedBy,
      arguments: { course_id: 2, module_id: 6, content: "Publish the Week 2 overview." },
    },
  };
}

describe("requesting assistant identity", () => {
  it("accepts only a complete identity and refuses an absolute workspace path", () => {
    expect(normalizeRequestedBy(requestedBy)).toEqual(requestedBy);
    expect(normalizeRequestedBy({ ...requestedBy, schema: "other" })).toBeUndefined();
    expect(normalizeRequestedBy({ ...requestedBy, workspaceDigest: workspaceRoot })).toBeUndefined();
    expect(normalizeRequestedBy({ ...requestedBy, proxyPid: 0 })).toBeUndefined();
    expect(normalizeRequestedBy({ ...requestedBy, clientName: "" })).toBeUndefined();
    expect(normalizeRequestedBy(undefined)).toBeUndefined();
  });

  it("names the requesting assistant on the approval review page without its project path", async () => {
    const snapshot = operationSnapshot();
    const approval = new LoopbackApprovalServer({
      operationGet: () => snapshot,
      operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [snapshot] }),
      operationReviewContext: async () => ({
        targets: [{ field: "course_id", label: "Course", name: "Biology" }],
      }),
      approveOperation: () => snapshot,
      runApprovedOperation: async () => undefined,
      cancelOperation: () => snapshot,
      setApprovalBaseUrl: () => undefined,
    });
    try {
      const url = await approval.start();
      const page = await (await fetch(`${url}/operations/op%3Arequested-by-1234`)).text();
      expect(page).toContain("Asked for by Claude Code 2.1.0, working in biology-101.");
      expect(page).toContain("This is the name that assistant reported, not proof of identity.");
      expect(page).not.toContain(workspaceRoot);
    } finally {
      await approval.close();
    }
  });

  it("names the requesting assistant on a batch review page", async () => {
    const child = operationSnapshot();
    const batchSnapshot: JsonObject = {
      schema: "morrow.batch-approval.v1",
      batch: {
        schema: "morrow.batch.v1",
        batchId: "bat:requested-by-1234",
        state: "planned",
        requestedBy: { ...requestedBy, clientName: "Codex", clientVersion: "unstated" },
      },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      targetCount: 1,
      children: [{ childId: "child-1", ordinal: 1, courseId: "2", tool: "moodle_update_page", operation: child }],
    };
    const approval = new LoopbackApprovalServer({
      operationGet: () => child,
      operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [child] }),
      approveOperation: () => child,
      runApprovedOperation: async () => undefined,
      cancelOperation: () => child,
      setApprovalBaseUrl: () => undefined,
      batchApprovalGet: () => batchSnapshot,
    });
    try {
      const url = await approval.start();
      const page = await (await fetch(`${url}/batches/bat%3Arequested-by-1234`)).text();
      // An unstated version is left out rather than guessed at.
      expect(page).toContain("Asked for by Codex, working in biology-101.");
      expect(page).not.toContain("Codex unstated");
      expect(page).not.toContain(workspaceRoot);
    } finally {
      await approval.close();
    }
  });

  it("names the assistant that holds a batch window, not only its session", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 1 });
    let started: (() => void) | undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runtime = {
      batchScheduler: scheduler,
      gateway: { requestedBy: { ...requestedBy, clientName: "Gemini CLI" } },
      batchRun: async () => {
        started?.();
        await held;
        return { schema: "morrow.batch-window.v1" };
      },
    } as unknown as MorrowRuntime;
    const client = new Client({ name: "requested-by-window-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => {
      const mcp = new McpServer({ name: "requested-by-window-test", version: "1" });
      registerBatchTools(mcp, runtime);
      return mcp;
    }, { transport: b });
    await client.connect(a);
    try {
      const call = client.callTool({
        name: "morrow_batch_run",
        arguments: {
          batch_id: "bat:window-1234",
          max_children: 1,
          course_set_digest: "e".repeat(64),
          profile_digest: "f".repeat(64),
        },
      });
      await running;
      const holder = scheduler.health().activeBatches[0]?.holder ?? "";
      expect(holder).toContain("Gemini CLI");
      expect(holder).toContain("session");
      release?.();
      expect((await call).isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
      scheduler.close();
    }
  });

  it("records the requester on the plan and leaves the frozen authority untouched", () => {
    const broker = new ProviderEffectBroker({ path: ":memory:" });
    try {
      const base = {
        publicToolName: "canvas_page_update",
        sourceId: "morrow-legacy",
        sourceToolName: "canvas_page_update",
        catalogDigest: "a".repeat(64),
        request: { page_id: "42", title: "Original" },
        forwardedRequest: { page_id: "42", title: "Original" },
        authority: {
          profileDigest: "1".repeat(64),
          actorDigest: "2".repeat(64),
          providerPrincipalDigest: "3".repeat(64),
          connectionGeneration: 1,
          catalogDigest: "a".repeat(64),
          approvalClass: "standard",
          targetSetDigest: "4".repeat(64),
        },
      };
      const anonymous = broker.create(base);
      const named = broker.create({ ...base, requestedBy });

      // The identity travels on the plan only, so the authority a conflict is
      // judged by, and the target it locks, stay exactly as they were.
      expect(named.plan.authority).toEqual(anonymous.plan.authority);
      expect(named.targetIdentityDigest).toBe(anonymous.targetIdentityDigest);
      expect(named.plan.requestedBy).toEqual(requestedBy);
      expect(anonymous.plan).not.toHaveProperty("requestedBy");
      expect(named.planDigest).not.toBe(anonymous.planDigest);
    } finally {
      broker.close();
    }
  });
});
