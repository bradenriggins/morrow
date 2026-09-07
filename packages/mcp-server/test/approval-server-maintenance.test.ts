import { request, type ClientRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { LoopbackApprovalServer } from "../src/approval-server.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for approval state");
}

function streamPost(url: URL, headers: Record<string, string>): { request: ClientRequest; response: Promise<{ status: number; body: string }> } {
  let resolveResponse!: (value: { status: number; body: string }) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const client = request(url, { method: "POST", headers }, (incoming) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => resolveResponse({ status: incoming.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
  });
  client.once("error", rejectResponse);
  return { request: client, response };
}

describe("approval maintenance admission", () => {
  it("counts an in-flight approval POST and refuses a later approval after admission closes", async () => {
    const run = deferred();
    let approvals = 0;
    const snapshot = { operationId: "op:maintenance-approval", state: "awaiting_approval", approvalExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    const approval = new LoopbackApprovalServer({
      operationGet: () => snapshot,
      operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [snapshot] }),
      approveOperation: () => {
        approvals += 1;
        return { ...snapshot, state: "approved" };
      },
      runApprovedOperation: async () => run.promise,
      cancelOperation: () => ({ ...snapshot, state: "cancelled" }),
      setApprovalBaseUrl: () => undefined,
    });
    let first: ReturnType<typeof streamPost> | null = null;
    let rejected: ReturnType<typeof streamPost> | null = null;
    try {
      const baseUrl = await approval.start();
      const review = await fetch(`${baseUrl}/operations/${encodeURIComponent(snapshot.operationId)}`);
      const html = await review.text();
      const nonce = /name="nonce" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
      const cookie = review.headers.get("set-cookie")?.split(";")[0];
      expect(nonce).toBeTruthy();
      expect(cookie).toBeTruthy();
      const target = new URL(`/operations/${encodeURIComponent(snapshot.operationId)}/approve`, baseUrl);
      const headers = {
        "content-type": "application/x-www-form-urlencoded",
        origin: baseUrl,
        referer: `${baseUrl}/operations/${encodeURIComponent(snapshot.operationId)}`,
        cookie: cookie!,
      };
      first = streamPost(target, headers);
      first.request.flushHeaders();
      first.request.write("nonce=");
      await waitFor(() => (approval as unknown as { approvalPosts: number }).approvalPosts === 1);

      approval.setMaintenanceAdmission(false);
      expect(approval.maintenanceQuiescent()).toBe(false);
      rejected = streamPost(target, headers);
      rejected.request.end(`nonce=${encodeURIComponent(nonce!)}`);
      await expect(rejected.response).resolves.toMatchObject({ status: 409, body: expect.stringContaining("approval_maintenance_held") });

      first.request.end(encodeURIComponent(nonce!));
      await expect(first.response).resolves.toMatchObject({ status: 303 });
      expect(approvals).toBe(1);
      await waitFor(() => !approval.maintenanceQuiescent());
      run.resolve();
      await waitFor(() => approval.maintenanceQuiescent());
    } finally {
      run.resolve();
      first?.request.destroy();
      rejected?.request.destroy();
      await approval.close();
    }
  });
});
