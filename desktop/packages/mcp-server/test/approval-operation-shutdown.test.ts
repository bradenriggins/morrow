import { fileURLToPath } from "node:url";
import { sha256Json, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { LoopbackApprovalServer } from "../src/approval-server.js";
import { bridgeSignedPresence } from "./fixtures/review-approval.js";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function snapshot(operationId: string, state: string): JsonObject {
  return {
    schema: "morrow.operation.v1",
    operationId,
    state,
    approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    plan: { tool: "morrow_legacy_only", arguments: { value: operationId } },
  };
}

async function approve(server: LoopbackApprovalServer, baseUrl: string, operationId: string): Promise<void> {
  const reviewUrl = `${baseUrl}/operations/${encodeURIComponent(operationId)}`;
  const review = await fetch(reviewUrl);
  const html = await review.text();
  const nonce = /name="nonce" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  const cookie = review.headers.get("set-cookie")?.split(";", 1)[0];
  expect(nonce).toBeTruthy();
  expect(cookie).toBeTruthy();
  const response = await fetch(`${reviewUrl}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookie!,
      origin: baseUrl,
      referer: reviewUrl,
    },
    body: new URLSearchParams({ nonce: nonce!, presence: bridgeSignedPresence(server, `${reviewUrl}/approve`, nonce!) }),
    redirect: "manual",
  });
  expect(response.status).toBe(303);
}

async function waitUntil(predicate: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function runtimeConfig() {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "morrow-legacy",
      label: "Morrow legacy fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_SOURCE: "morrow-legacy", FAKE_DELAY_MS: "500" },
      priority: 1,
      required: true,
      enabled: true,
      outputPrivacy: {
        canvas_page_get: {
          allowedFields: ["source", "course_id"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 2_000,
          freeText: "deny",
          learnerTokens: false,
          artifactInspection: "deny",
        },
        morrow_legacy_only: {
          allowedFields: ["source", "tool", "value", "operation_id"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 2_000,
          freeText: "deny",
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

function plan(runtime: MorrowRuntime, suffix: string): { readonly id: string; readonly url: string } {
  const result = runtime.gateway.planOperation("morrow_legacy_only", {
    value: suffix,
    course_id: "101",
    _morrow: { operation_id: `operation:approval-shutdown-${suffix}` },
  });
  const structured = result.structuredContent as {
    operationId?: unknown;
    receipts?: { approvalUrl?: unknown };
  };
  if (typeof structured.operationId !== "string" || typeof structured.receipts?.approvalUrl !== "string") {
    throw new Error("approval operation did not expose its review URL");
  }
  return { id: structured.operationId, url: structured.receipts.approvalUrl };
}

describe("single-operation approval shutdown", () => {
  it("aborts and joins the approved operation runner", async () => {
    const operationId = "operation:approval-close-1234";
    const started = deferred();
    let receivedSignal: AbortSignal | undefined;
    const server = new LoopbackApprovalServer({
      operationGet: () => snapshot(operationId, "awaiting_approval"),
      operationList: () => ({ operations: [snapshot(operationId, "awaiting_approval")] }),
      approveOperation: () => snapshot(operationId, "approved"),
      runApprovedOperation: async (_id, signal) => {
        receivedSignal = signal;
        started.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      cancelOperation: () => snapshot(operationId, "cancelled"),
      setApprovalBaseUrl: () => undefined,
    });
    try {
      const baseUrl = await server.start();
      await approve(server, baseUrl, operationId);
      await started.promise;

      await expect(Promise.race([
        server.close(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("approval close did not settle")), 1_000)),
      ])).resolves.toBeUndefined();
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("cancels before send and keeps an abort after send outcome-unknown", async () => {
    let beforeSend: MorrowRuntime | undefined;
    let afterSend: MorrowRuntime | undefined;
    try {
      beforeSend = await MorrowRuntime.connect(runtimeConfig(), { statePath: ":memory:" });
      const before = plan(beforeSend, "before-send-1234");
      const beforeStarted = deferred();
      const originalBeforeDispatch = beforeSend.gateway.dispatchOperation.bind(beforeSend.gateway);
      let beforeSignal: AbortSignal | undefined;
      let beforeSettlement: JsonObject | undefined;
      beforeSend.gateway.dispatchOperation = async (operationId, options = {}) => {
        beforeSignal = options.signal;
        beforeStarted.resolve();
        if (!options.signal) throw new Error("approval dispatch signal is missing");
        await new Promise<void>((resolve) => {
          if (options.signal!.aborted) resolve();
          else options.signal!.addEventListener("abort", () => resolve(), { once: true });
        });
        const result = await originalBeforeDispatch(operationId, options);
        beforeSettlement = beforeSend!.gateway.operationGet(operationId);
        return result;
      };
      await approve(beforeSend.approval, new URL(before.url).origin, before.id);
      await beforeStarted.promise;
      await beforeSend.close();
      beforeSend = undefined;
      expect(beforeSignal?.aborted).toBe(true);
      expect(beforeSettlement).toMatchObject({ state: "cancelled", dispatchAttempt: 0 });

      afterSend = await MorrowRuntime.connect(runtimeConfig(), { statePath: ":memory:" });
      const after = plan(afterSend, "after-send-1234");
      const originalAfterDispatch = afterSend.gateway.dispatchOperation.bind(afterSend.gateway);
      let afterSignal: AbortSignal | undefined;
      let afterSettlement: JsonObject | undefined;
      afterSend.gateway.dispatchOperation = async (operationId, options = {}) => {
        afterSignal = options.signal;
        const result = await originalAfterDispatch(operationId, options);
        afterSettlement = afterSend!.gateway.operationGet(operationId);
        return result;
      };
      await approve(afterSend.approval, new URL(after.url).origin, after.id);
      await waitUntil(() => afterSend!.gateway.operationGet(after.id).state === "dispatching", "provider dispatch");
      await afterSend.close();
      afterSend = undefined;
      expect(afterSignal?.aborted).toBe(true);
      expect(afterSettlement).toMatchObject({
        state: "applied_or_unknown",
        attention: expect.arrayContaining(["provider_effect_may_have_landed"]),
      });
    } finally {
      await afterSend?.close();
      await beforeSend?.close();
    }
  }, 20_000);
});
