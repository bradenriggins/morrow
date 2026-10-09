import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@morrow/contracts";
import { LoopbackApprovalServer, reviewApprovalProof, type ReviewApprovalPresence } from "../src/approval-server.js";
import { reviewDocumentHeaders } from "./fixtures/review-approval.js";

const operationId = "op:human-presence-1234";
const encodedId = encodeURIComponent(operationId);

function snapshot(state: string): JsonObject {
  return {
    schema: "morrow.operation.v1",
    operationId,
    state,
    verificationStatus: "unconfirmed",
    dispatchAttempt: 0,
    approvalExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    plan: { tool: "moodle_update_page", arguments: { course_id: 2, module_id: 6, content: "Week 2 overview." } },
  };
}

interface Harness {
  readonly server: LoopbackApprovalServer;
  readonly approved: string[];
  readonly remembered: string[];
  readonly presence: ReviewApprovalPresence[];
  announced: number;
}

function harness(): Harness {
  const state: Harness = { server: null as unknown as LoopbackApprovalServer, approved: [], remembered: [], presence: [], announced: 0 };
  const server = new LoopbackApprovalServer({
    operationGet: () => snapshot(state.approved.length ? "approved" : "awaiting_approval"),
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 0, operations: [] }),
    operationReviewContext: async () => ({ targets: [
      { field: "course_id", label: "Course", name: "Biology 101" },
      { field: "module_id", label: "Page", name: "Week 2 overview" },
    ] }),
    approveOperation: (id) => {
      state.approved.push(id);
      return snapshot("approved");
    },
    runApprovedOperation: async () => undefined,
    cancelOperation: () => snapshot("cancelled"),
    setApprovalBaseUrl: () => undefined,
    setApprovalPresence: (presence) => { state.presence.push(presence); },
    announceApprovalPresence: () => { state.announced += 1; },
    rememberOffer: async () => ({ categoryId: "text", label: "Text and titles" }),
    rememberKind: async (id) => {
      state.remembered.push(id);
      return "saved";
    },
  });
  return Object.assign(state, { server });
}

/** What a local program can do after the review page was opened: copy its form and post it back. */
async function forgedApproval(server: LoopbackApprovalServer, baseUrl: string, extra: Record<string, string> = {}): Promise<{ response: Response; nonce: string; cookie: string }> {
  const pageUrl = `${baseUrl}/operations/${encodedId}`;
  const page = await fetch(pageUrl, { headers: reviewDocumentHeaders(server, pageUrl) });
  const body = await page.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(body)?.[1] || "";
  const cookie = page.headers.get("set-cookie")?.split(";", 1)[0] || "";
  expect(nonce).toBeTruthy();
  expect(cookie).toBeTruthy();
  const response = await fetch(`${baseUrl}/operations/${encodedId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      cookie,
      origin: baseUrl,
      referer: `${baseUrl}/operations/${encodedId}`,
    },
    body: new URLSearchParams({ nonce, ...extra }),
    redirect: "manual",
  });
  return { response, nonce, cookie };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("approval needs a person in Chrome, not an HTTP client", () => {
  it("refuses a copied form posted with a forged Origin, Referer, and cookie", async () => {
    const test = harness();
    try {
      const baseUrl = await test.server.start();
      const { response } = await forgedApproval(test.server, baseUrl);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Approve this change in Chrome");
      await settle();
      expect(test.approved).toEqual([]);
    } finally {
      await test.server.close();
    }
  });

  it("refuses the same forgery when it also asks Morrow not to ask again, and grants nothing", async () => {
    const test = harness();
    try {
      const baseUrl = await test.server.start();
      const { response } = await forgedApproval(test.server, baseUrl, { remember: "1" });
      expect(response.status).toBe(403);
      await settle();
      expect(test.approved).toEqual([]);
      expect(test.remembered).toEqual([]);
    } finally {
      await test.server.close();
    }
  });

  it("refuses a guessed or copied presence value", async () => {
    const test = harness();
    try {
      const baseUrl = await test.server.start();
      const guessed = await forgedApproval(test.server, baseUrl, { presence: "A".repeat(43) });
      expect(guessed.response.status).toBe(403);
      // A proof Morrow Bridge made for another review or another nonce is not this one.
      const key = test.presence[0]!.key;
      const otherNonce = await forgedApproval(test.server, baseUrl, { presence: reviewApprovalProof(key, `/operations/${encodedId}/approve`, "another-nonce") });
      expect(otherNonce.response.status).toBe(403);
      const otherReview = await forgedApproval(test.server, baseUrl, { presence: reviewApprovalProof(key, "/operations/op%3Aother/approve", guessed.nonce) });
      expect(otherReview.response.status).toBe(403);
      await settle();
      expect(test.approved).toEqual([]);
    } finally {
      await test.server.close();
    }
  });

  it("keeps the key out of every page, header, and URL an HTTP client can read", async () => {
    const test = harness();
    try {
      const baseUrl = await test.server.start();
      expect(test.presence).toHaveLength(1);
      expect(test.presence[0]!.origin).toBe(baseUrl);
      expect(test.presence[0]!.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const key = test.presence[0]!.key;
      for (const path of [`/operations/${encodedId}`, `/operations/${encodedId}/status`, "/operations", "/review-status.js"]) {
        const response = await fetch(`${baseUrl}${path}`);
        const text = await response.text();
        expect(text).not.toContain(key);
        expect(JSON.stringify([...response.headers])).not.toContain(key);
      }
    } finally {
      await test.server.close();
    }
  });

  it("asks the runtime to hand the key to Morrow Bridge when a person opens a review", async () => {
    const test = harness();
    try {
      const baseUrl = await test.server.start();
      const pageUrl = `${baseUrl}/operations/${encodedId}`;
      await (await fetch(pageUrl, { headers: reviewDocumentHeaders(test.server, pageUrl) })).text();
      expect(test.announced).toBe(1);
    } finally {
      await test.server.close();
    }
  });

  it("hands the key to Morrow Bridge when the review is opened without a proof, and still refuses that open", async () => {
    const test = harness();
    try {
      const baseUrl = await test.server.start();
      const pageUrl = `${baseUrl}/operations/${encodedId}`;
      const response = await fetch(pageUrl, { headers: { accept: "text/html" } });
      const text = await response.text();
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(text).not.toContain(test.presence[0]!.key);
      expect(text).not.toContain("nonce");
      expect(text).not.toContain("Week 2 overview");
      expect(test.announced).toBe(1);
    } finally {
      await test.server.close();
    }
  });

  it("does not list or cancel for a client that sets only Host, and rejects cancel without the Bridge proof", async () => {
    const test = harness();
    const cancelled: string[] = [];
    const server = new LoopbackApprovalServer({
      operationGet: () => snapshot("awaiting_approval"),
      operationList: () => ({ schema: "morrow.operations.list.v1", returned: 1, operations: [snapshot("awaiting_approval")] }),
      operationReviewContext: async () => ({ targets: [{ field: "course_id", label: "Course", name: "Biology 101" }] }),
      approveOperation: () => snapshot("approved"),
      runApprovedOperation: async () => undefined,
      cancelOperation: (id) => { cancelled.push(id); return snapshot("cancelled"); },
      setApprovalBaseUrl: () => undefined,
      setApprovalPresence: (presence) => { test.presence.push(presence); },
    });
    try {
      const baseUrl = await server.start();
      const url = new URL(baseUrl);
      const hostOnly = (method: string, path: string, body?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest({
          hostname: url.hostname,
          port: url.port,
          path,
          method,
          headers: { host: url.host },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
        });
        request.on("error", reject);
        if (body) request.write(body);
        request.end();
      });
      const listed = await hostOnly("GET", "/operations");
      expect(listed.status).toBe(403);
      expect(listed.body).toContain("approval_presence_required");
      expect(listed.body).not.toContain(operationId);
      const review = await hostOnly("GET", `/operations/${encodedId}`);
      expect(review.status).toBe(403);
      expect(review.body).not.toContain("Week 2 overview");
      expect(review.body).not.toContain("nonce");
      const pageUrl = `${baseUrl}/operations/${encodedId}`;
      const spoofed = await fetch(pageUrl, { headers: { accept: "text/html", "user-agent": "Mozilla/5.0", host: new URL(baseUrl).host } });
      const spoofedBody = await spoofed.text();
      expect(spoofed.status).toBe(403);
      expect(spoofed.headers.get("set-cookie")).toBeNull();
      expect(spoofedBody).not.toContain("Week 2 overview");
      expect(spoofedBody).not.toContain("nonce");
      const spoofedList = await fetch(`${baseUrl}/operations`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0", host: new URL(baseUrl).host } });
      expect(spoofedList.status).toBe(403);
      expect(await spoofedList.text()).not.toContain(operationId);
      const page = await fetch(pageUrl, { headers: reviewDocumentHeaders(server, pageUrl) });
      const pageBody = await page.text();
      const nonce = /name="nonce" value="([^"]+)"/.exec(pageBody)?.[1] || "";
      const cookie = page.headers.get("set-cookie")?.split(";", 1)[0] || "";
      const cancelPath = `/operations/${encodedId}/cancel`;
      const unsigned = await fetch(`${baseUrl}${cancelPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html",
          cookie,
          origin: baseUrl,
          referer: `${baseUrl}/operations/${encodedId}`,
        },
        body: new URLSearchParams({ nonce }),
        redirect: "manual",
      });
      expect(unsigned.status).toBe(403);
      expect(await unsigned.text()).toContain("Cancel this request in Chrome");
      expect(cancelled).toEqual([]);
      const hostCancel = await hostOnly("POST", cancelPath, new URLSearchParams({ nonce }).toString());
      expect(hostCancel.status).not.toBe(303);
      expect(cancelled).toEqual([]);
      const signed = await fetch(`${baseUrl}${cancelPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
          origin: baseUrl,
          referer: `${baseUrl}/operations/${encodedId}`,
        },
        body: new URLSearchParams({ nonce, presence: reviewApprovalProof(test.presence[0]!.key, cancelPath, nonce) }),
        redirect: "manual",
      });
      expect(signed.status).toBe(303);
      expect(cancelled).toEqual([operationId]);
    } finally {
      await server.close();
    }
  });

  it("approves once when Morrow Bridge signs this review's nonce after a real click", async () => {
    const test = harness();
    try {
      const baseUrl = await test.server.start();
      const pageUrl = `${baseUrl}/operations/${encodedId}`;
      const page = await fetch(pageUrl, { headers: reviewDocumentHeaders(test.server, pageUrl) });
      const body = await page.text();
      const nonce = /name="nonce" value="([^"]+)"/.exec(body)?.[1] || "";
      const cookie = page.headers.get("set-cookie")?.split(";", 1)[0] || "";
      const approvePath = `/operations/${encodedId}/approve`;
      const presence = reviewApprovalProof(test.presence[0]!.key, approvePath, nonce);
      const response = await fetch(`${baseUrl}${approvePath}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", cookie, origin: baseUrl, referer: `${baseUrl}/operations/${encodedId}` },
        body: new URLSearchParams({ nonce, presence, remember: "1" }),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      await settle();
      expect(test.approved).toEqual([operationId]);
      expect(test.remembered).toEqual([operationId]);
    } finally {
      await test.server.close();
    }
  });

  it("keeps the nonce usable after a refused forgery, so the person can still approve", async () => {
    const test = harness();
    try {
      const baseUrl = await test.server.start();
      const { nonce, cookie } = await forgedApproval(test.server, baseUrl);
      const approvePath = `/operations/${encodedId}/approve`;
      const response = await fetch(`${baseUrl}${approvePath}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: baseUrl, referer: `${baseUrl}/operations/${encodedId}` },
        body: new URLSearchParams({ nonce, presence: reviewApprovalProof(test.presence[0]!.key, approvePath, nonce) }),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(test.approved).toEqual([operationId]);
    } finally {
      await test.server.close();
    }
  });
});
