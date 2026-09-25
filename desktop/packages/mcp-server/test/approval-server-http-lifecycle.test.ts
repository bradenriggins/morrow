import { request, type ClientRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { LoopbackApprovalServer } from "../src/approval-server.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

async function waitUntil(predicate: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function partialPost(url: URL, headers: Record<string, string>): ClientRequest {
  const client = request(url, { method: "POST", headers });
  client.on("error", () => undefined);
  client.flushHeaders();
  client.write("nonce=");
  return client;
}

describe("approval HTTP shutdown", () => {
  it("aborts complete and partial requests, refuses late admission, and closes within its bound", async () => {
    const operationId = "operation:http-close-1234";
    const reviewStarted = deferred();
    const releaseReview = deferred();
    let holdReview = false;
    const snapshot = {
      operationId,
      state: "awaiting_approval",
      approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const approval = new LoopbackApprovalServer({
      operationGet: () => snapshot,
      operationList: () => ({ operations: [snapshot] }),
      operationReviewContext: async () => {
        if (holdReview) {
          reviewStarted.resolve();
          await releaseReview.promise;
        }
        return { targets: [] };
      },
      approveOperation: () => ({ ...snapshot, state: "approved" }),
      runApprovedOperation: async () => undefined,
      cancelOperation: () => ({ ...snapshot, state: "cancelled" }),
      setApprovalBaseUrl: () => undefined,
    });
    let partial: ClientRequest | null = null;
    try {
      const baseUrl = await approval.start();
      const reviewUrl = `${baseUrl}/operations/${encodeURIComponent(operationId)}`;
      const review = await fetch(reviewUrl);
      const html = await review.text();
      const cookie = review.headers.get("set-cookie")?.split(";", 1)[0];
      expect(cookie).toBeTruthy();

      holdReview = true;
      const pendingReview = fetch(reviewUrl);
      await reviewStarted.promise;
      const loading = await pendingReview;
      expect(loading.status).toBe(200);
      const reader = loading.body!.getReader();
      const firstChunk = await reader.read();
      expect(new TextDecoder().decode(firstChunk.value)).toContain("Preparing your review");
      const pendingBody = reader.read().then(
        () => "completed",
        () => "aborted",
      );

      partial = partialPost(new URL(`${reviewUrl}/approve`), {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "128",
        origin: baseUrl,
        referer: reviewUrl,
        cookie: cookie!,
      });
      await waitUntil(
        () => (approval as unknown as { approvalPosts: number }).approvalPosts === 1,
        "the partial approval body",
      );

      const startedAt = Date.now();
      await expect(Promise.race([
        approval.close(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("approval close exceeded its bound")), 1_000)),
      ])).resolves.toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await expect(pendingBody).resolves.toBe("aborted");
      await expect(fetch(`${baseUrl}/operations`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    } finally {
      releaseReview.resolve();
      partial?.destroy();
      await approval.close();
    }
  });
});
