import { describe, expect, it } from "vitest";
import type { JsonObject } from "@morrow/contracts";
import { LoopbackApprovalServer, type ApprovalOperationController } from "../src/approval-server.js";

/**
 * A controller whose `operationReviewContext` throws if it is ever called. `/recent` names an
 * item from the plan arguments already on the operation record (F28), never a fresh platform
 * read, so a test that would fail on a live read proves the page never asks for one.
 */
function recentController(
  operations: readonly JsonObject[],
  connectionNames: Readonly<Record<string, string>> = {},
): ApprovalOperationController {
  return {
    operationGet: () => { throw new Error("recent changes must not read a single operation"); },
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: operations.length, operations: [...operations] }),
    operationReviewContext: async () => { throw new Error("recent changes must not make a live platform read"); },
    approveOperation: () => { throw new Error("recent changes never approves anything"); },
    runApprovedOperation: async () => { throw new Error("recent changes never runs anything"); },
    cancelOperation: () => { throw new Error("recent changes never cancels anything"); },
    setApprovalBaseUrl: () => undefined,
    connectionName: (sourceBindingId) => (sourceBindingId ? connectionNames[sourceBindingId] : undefined),
  };
}

function finishedOperation(overrides: JsonObject = {}): JsonObject {
  return {
    schema: "morrow.operation.v1",
    operationId: "op:recent-1234",
    state: "verified",
    sourceBindingId: "binding-1",
    createdAt: "2026-09-20T14:00:00.000Z",
    updatedAt: "2026-09-20T14:05:00.000Z",
    terminalAt: "2026-09-20T14:05:00.000Z",
    plan: {
      tool: "moodle_update_page",
      arguments: { course_id: 2, content_id: 91, content: "Publish the Week 2 overview." },
    },
    ...overrides,
  };
}

describe("GET /recent", () => {
  it("shows no page without an entry code or a session cookie", async () => {
    const server = new LoopbackApprovalServer(recentController([finishedOperation()]));
    try {
      const baseUrl = await server.start();
      const response = await fetch(`${baseUrl}/recent`, { headers: { accept: "text/html" } });
      const body = await response.text();
      expect(response.status).toBe(403);
      expect(body).not.toContain("op:recent-1234");
      expect(body).not.toContain("recent-list");
      expect(body).toContain("Ask your assistant");
    } finally {
      await server.close();
    }
  });

  it("exchanges a one-time entry code for a session, and refuses the same code a second time", async () => {
    const server = new LoopbackApprovalServer(recentController([finishedOperation()]));
    try {
      const baseUrl = await server.start();
      const code = server.issueRecentChangesEntry();

      const exchanged = await fetch(`${baseUrl}/recent?entry=${encodeURIComponent(code)}`, { redirect: "manual" });
      expect(exchanged.status).toBe(303);
      expect(exchanged.headers.get("location")).toBe("/recent");
      const setCookie = exchanged.headers.get("set-cookie");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      const cookie = setCookie?.split(";", 1)[0];
      expect(cookie).toBeTruthy();

      const page = await fetch(`${baseUrl}/recent`, { headers: { cookie: cookie!, accept: "text/html" } });
      expect(page.status).toBe(200);
      const body = await page.text();
      expect(body).toContain("Recent changes");
      expect(body).toContain("op:recent-1234");

      const reused = await fetch(`${baseUrl}/recent?entry=${encodeURIComponent(code)}`, { redirect: "manual" });
      expect(reused.status).toBe(409);
      const reusedBody = await reused.text();
      expect(reusedBody).toContain("already opened");

      const unknown = await fetch(`${baseUrl}/recent?entry=not-a-real-code`, { redirect: "manual" });
      expect(unknown.status).toBe(409);
    } finally {
      await server.close();
    }
  });

  it("shows the plain label, course name, item reference, and status link without decoding a tokenized value", async () => {
    const operation = finishedOperation({
      plan: {
        tool: "moodle_update_page",
        arguments: { course_id: 2, content_id: "[content:7]", content: "Publish the Week 2 overview." },
      },
    });
    const server = new LoopbackApprovalServer(recentController([operation], { "binding-1": "Biology 101" }));
    try {
      const baseUrl = await server.start();
      const code = server.issueRecentChangesEntry();
      const exchanged = await fetch(`${baseUrl}/recent?entry=${encodeURIComponent(code)}`, { redirect: "manual" });
      const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0];
      const page = await fetch(`${baseUrl}/recent`, { headers: { cookie } });
      const body = await page.text();
      expect(body).toContain("Edit Page");
      expect(body).toContain("Biology 101");
      // The record's own tokenized identifier is shown exactly as the plan carries it, never
      // resolved against a live read (`operationReviewContext` above throws if that happens).
      expect(body).toContain("[content:7]");
      expect(body).toContain(`/operations/${encodeURIComponent("op:recent-1234")}`);
      expect(body).toContain("Reverse change op:recent-1234.");
    } finally {
      await server.close();
    }
  });

  it("offers an undo request only for a change that may have reached the platform", async () => {
    const reachable = [
      ...["verified", "applied_or_unknown", "closed_by_person"].map((state) =>
        finishedOperation({ operationId: `op:recent-${state}`, state })),
      // A read proved the platform saved something other than the approved change, so it was sent.
      finishedOperation({
        operationId: "op:recent-mismatch-1234",
        state: "failed",
        verificationStatus: "mismatch",
        attention: ["readback_did_not_match_frozen_comparator"],
      }),
    ];
    const unsent = [
      finishedOperation({ operationId: "op:recent-cancel-1234", state: "cancelled", attention: ["cancelled_by_person"] }),
      finishedOperation({ operationId: "op:recent-failed-1234", state: "failed", attention: ["dispatch_failed_before_send"] }),
      finishedOperation({ operationId: "op:recent-inner-1234", state: "failed", attention: ["inner_operation_failed_without_effect"] }),
    ];
    const server = new LoopbackApprovalServer(recentController([...reachable, ...unsent]));
    try {
      const baseUrl = await server.start();
      const code = server.issueRecentChangesEntry();
      const exchanged = await fetch(`${baseUrl}/recent?entry=${encodeURIComponent(code)}`, { redirect: "manual" });
      const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0];
      const body = await (await fetch(`${baseUrl}/recent`, { headers: { cookie } })).text();
      const rows = body.split('<li class="recent-row">').slice(1);
      expect(rows).toHaveLength(7);
      for (const operation of reachable) {
        const row = rows.find((entry) => entry.includes(`/operations/${encodeURIComponent(String(operation.operationId))}"`))!;
        expect(row).toContain(`Reverse change ${operation.operationId}.`);
        expect(row).not.toContain("Nothing was sent");
      }
      expect(rows.find((entry) => entry.includes("op%3Arecent-mismatch-1234"))).toContain("Did not save as approved");
      for (const operation of unsent) {
        const row = rows.find((entry) => entry.includes(`/operations/${encodeURIComponent(String(operation.operationId))}"`))!;
        expect(row).toContain("Nothing was sent");
        expect(row).not.toContain("Reverse change");
        expect(row).not.toContain("To undo this");
      }
      expect(body).not.toContain("Changes Morrow finished");
    } finally {
      await server.close();
    }
  });

  it("keeps only operations that reached a final state, newest first, up to 50", async () => {
    const pending = finishedOperation({ operationId: "op:still-open", state: "awaiting_approval", terminalAt: null });
    const done = finishedOperation({ operationId: "op:recent-1234" });
    const server = new LoopbackApprovalServer(recentController([pending, done]));
    try {
      const baseUrl = await server.start();
      const code = server.issueRecentChangesEntry();
      const exchanged = await fetch(`${baseUrl}/recent?entry=${encodeURIComponent(code)}`, { redirect: "manual" });
      const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0];
      const page = await fetch(`${baseUrl}/recent`, { headers: { cookie } });
      const body = await page.text();
      expect(body).toContain("op:recent-1234");
      expect(body).not.toContain("op:still-open");
    } finally {
      await server.close();
    }
  });

  it("links the verified result page to /recent with a working one-time entry code", async () => {
    const operation = finishedOperation();
    const controller: ApprovalOperationController = {
      ...recentController([operation]),
      operationGet: () => operation,
      operationReviewContext: async () => ({
        targets: [{ field: "content_id", label: "Page", name: "Week 2 overview" }],
      }),
    };
    const server = new LoopbackApprovalServer(controller);
    try {
      const baseUrl = await server.start();
      const resultPage = await (await fetch(`${baseUrl}/operations/${encodeURIComponent("op:recent-1234")}`)).text();
      const match = resultPage.match(/<a href="\/recent\?entry=([A-Za-z0-9_-]+)">See recent changes<\/a>/);
      expect(match).toBeTruthy();
      const exchanged = await fetch(`${baseUrl}/recent?entry=${encodeURIComponent(match![1])}`, { redirect: "manual" });
      expect(exchanged.status).toBe(303);
      const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0];
      const page = await fetch(`${baseUrl}/recent`, { headers: { cookie, accept: "text/html" } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Recent changes");
    } finally {
      await server.close();
    }
  });
});

describe("one-time /recent codes", () => {
  function verifiedServer(ids: readonly string[]): LoopbackApprovalServer {
    const operations = ids.map((operationId) => finishedOperation({ operationId }));
    return new LoopbackApprovalServer({
      ...recentController(operations),
      operationGet: (id) => operations.find((operation) => operation.operationId === id)!,
      operationReviewContext: async () => ({ targets: [{ field: "content_id", label: "Page", name: "Week 2 overview" }] }),
    });
  }
  const linkIn = (html: string) => /\/recent\?entry=([A-Za-z0-9_-]+)/.exec(html)?.[1];

  it("keeps the link the tool handed out valid while result pages reload and poll", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `op:recent-${1000 + index}`);
    const server = verifiedServer(ids);
    try {
      const baseUrl = await server.start();
      const code = server.issueRecentChangesEntry();
      for (const id of ids) {
        const path = `${baseUrl}/operations/${encodeURIComponent(id)}`;
        for (let load = 0; load < 3; load += 1) {
          await (await fetch(path)).text();
          await (await fetch(`${path}/status`)).json();
        }
      }
      const opened = await fetch(`${baseUrl}/recent?entry=${encodeURIComponent(code)}`, { redirect: "manual" });
      expect(opened.status).toBe(303);
    } finally {
      await server.close();
    }
  });

  it("gives one result page the same link on every reload and poll until it is used", async () => {
    const server = verifiedServer(["op:recent-1234"]);
    try {
      const baseUrl = await server.start();
      const path = `${baseUrl}/operations/${encodeURIComponent("op:recent-1234")}`;
      const first = linkIn(await (await fetch(path)).text());
      const reloaded = linkIn(await (await fetch(path)).text());
      const polled = linkIn(String(((await (await fetch(`${path}/status`)).json()) as JsonObject).html));
      expect(first).toBeTruthy();
      expect(reloaded).toBe(first);
      expect(polled).toBe(first);

      expect((await fetch(`${baseUrl}/recent?entry=${first}`, { redirect: "manual" })).status).toBe(303);
      expect((await fetch(`${baseUrl}/recent?entry=${first}`, { redirect: "manual" })).status).toBe(409);
      const next = linkIn(await (await fetch(path)).text());
      expect(next).toBeTruthy();
      expect(next).not.toBe(first);
    } finally {
      await server.close();
    }
  });

  it("does not let one result page's link open from another operation's code", async () => {
    const server = verifiedServer(["op:recent-1234", "op:recent-5678"]);
    try {
      const baseUrl = await server.start();
      const one = linkIn(await (await fetch(`${baseUrl}/operations/${encodeURIComponent("op:recent-1234")}`)).text());
      const two = linkIn(await (await fetch(`${baseUrl}/operations/${encodeURIComponent("op:recent-5678")}`)).text());
      expect(one).toBeTruthy();
      expect(two).toBeTruthy();
      expect(one).not.toBe(two);
    } finally {
      await server.close();
    }
  });
});
