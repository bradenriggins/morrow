import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it, vi } from "vitest";
import { LoopbackApprovalServer, reviewApprovalProof, type ReviewApprovalPresence } from "../src/approval-server.js";
import { EditAccessReviews } from "../src/edit-access-review.js";
import { registerOperationTools } from "../src/operation-tools.js";
import { EditCategoryUnavailableError, type BrowserEditAccessPrepared, type BrowserEditAccessResult, type GatewayRuntime } from "../src/runtime.js";
import { createMorrowServer } from "../src/server.js";

const input = {
  mode: "edit" as const,
  selections: [
    { source_binding_id: "canvas-bio", enabled_categories: ["assignment_due_at"] },
    { source_binding_id: "moodle-chem", enabled_categories: ["moodle_page_content"] },
  ],
};

const prepared: BrowserEditAccessPrepared = {
  mode: "edit",
  selections: [
    {
      sourceBindingId: "canvas-bio", provider: "canvas", courseId: "42", courseName: "Biology", site: "https://canvas.example.edu",
      principalFingerprint: "a".repeat(64), sessionGeneration: 4, catalogDigest: "b".repeat(64), expectedPolicyRevision: 2,
      enabledCategories: [{ id: "assignment_due_at", label: "Assignment due dates", description: "Change one assignment due date.", destructive: false, unchecked: false }],
    },
    {
      sourceBindingId: "moodle-chem", provider: "moodle", courseId: "51", courseName: "Chemistry", site: "https://moodle.example.edu",
      principalFingerprint: "c".repeat(64), sessionGeneration: 9, catalogDigest: "d".repeat(64), expectedPolicyRevision: 7,
      enabledCategories: [{ id: "moodle_page_content", label: "Page content", description: "Change a Moodle Page.", destructive: false, unchecked: false }],
    },
  ],
};

const planPrepared: BrowserEditAccessPrepared = {
  mode: "plan",
  selections: prepared.selections.map((selection) => ({ ...selection, enabledCategories: [] })),
};

function grantedResult(scope: BrowserEditAccessPrepared, expiresAt: number | undefined = undefined): BrowserEditAccessResult {
  return {
    mode: "edit",
    outcome: "received",
    command: { schema: "morrow.browser-edit-policy-set.v1", ok: true },
    bindings: scope.selections.map((selection) => ({
      sourceBindingId: selection.sourceBindingId,
      provider: selection.provider,
      courseId: selection.courseId,
      ...(selection.provider === "canvas" ? { origin: selection.site } : { siteUrl: selection.site }),
      principalFingerprint: selection.principalFingerprint,
      sessionGeneration: selection.sessionGeneration,
      catalogDigest: selection.catalogDigest,
      runtimeVerified: true,
      editPolicyRevision: selection.expectedPolicyRevision + 1,
      editPermission: {
        sourceBindingId: selection.sourceBindingId,
        revision: selection.expectedPolicyRevision + 1,
        catalogDigest: selection.catalogDigest,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        enabledCategories: selection.enabledCategories.map((category) => category.id),
      },
    })),
  };
}

function operationStub(): JsonObject {
  return { schema: "morrow.operation.v1", operationId: "unused", state: "cancelled" };
}

/**
 * The owner side of an Edit request: the MCP tools, the review server, and one review store,
 * wired the way MorrowRuntime wires them. Only the Bridge's save is a stand-in.
 */
async function owner(expiresAt: number | undefined = undefined) {
  const prepare = vi.fn().mockResolvedValue(prepared);
  const apply = vi.fn().mockImplementation(async (scope: BrowserEditAccessPrepared) => grantedResult(scope, expiresAt));
  const reviews = new EditAccessReviews((scope, options) => apply(scope, options));
  let baseUrl: string | null = null;
  const presence: ReviewApprovalPresence[] = [];
  const approval = new LoopbackApprovalServer({
    operationGet: operationStub,
    operationList: () => ({ schema: "morrow.operations.list.v1", returned: 0, operations: [] }),
    approveOperation: operationStub,
    runApprovedOperation: async () => undefined,
    cancelOperation: operationStub,
    setApprovalBaseUrl: (url) => { baseUrl = url; },
    setApprovalPresence: (value) => { presence.push(value); },
    editAccessGet: (id) => reviews.page(id),
    approveEditAccess: (id) => reviews.approve(id),
    runApprovedEditAccess: (id) => reviews.run(id),
    cancelEditAccess: (id) => reviews.cancel(id),
  });
  await approval.start();
  const runtime = {
    catalog: { tools: [], digest: "e".repeat(64) },
    config: { toolSurface: "compact", upstreams: [] },
    prepareBrowserEditAccess: prepare,
    applyBrowserEditAccess: apply,
    createEditAccessReview: (scope: BrowserEditAccessPrepared) => reviews.create(scope, baseUrl),
    editAccessReviewResult: (id: string) => reviews.result(id),
  } as unknown as GatewayRuntime;
  // A client that would answer any form on its own, as an assistant driving it could.
  const client = new Client(
    { name: "edit-access-test", version: "1" },
    { capabilities: { elicitation: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(() => {
    const created = createMorrowServer(runtime);
    registerOperationTools(created, runtime);
    return created;
  }, { transport: b });
  await client.connect(a);
  return {
    client,
    prepare,
    apply,
    baseUrl: () => baseUrl!,
    key: () => presence[0]!.key,
    async close() {
      await client.close();
      await server.close();
      await approval.close();
    },
  };
}

type Owner = Awaited<ReturnType<typeof owner>>;

async function requestEdit(test: Owner, argumentsValue: JsonObject = input): Promise<JsonObject> {
  const answer = await test.client.callTool({ name: "morrow_request_edit_access", arguments: argumentsValue });
  expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
  expect(answer).not.toHaveProperty("inputRequests");
  return answer.structuredContent as JsonObject;
}

async function waitFor(test: Owner, editAccessId: string, maxWaitSeconds = 5): Promise<JsonObject> {
  const answer = await test.client.callTool({ name: "morrow_operation_wait", arguments: { edit_access_id: editAccessId, max_wait_seconds: maxWaitSeconds } });
  expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
  return answer.structuredContent as JsonObject;
}

/** What a person's browser does: open the review, then post its form. `presence` is the Bridge's part. */
async function reviewForm(test: Owner, path: string): Promise<{ body: string; nonce: string; cookie: string }> {
  const page = await fetch(`${test.baseUrl()}${path}`);
  const body = await page.text();
  return {
    body,
    nonce: /name="nonce" value="([^"]+)"/.exec(body)?.[1] || "",
    cookie: page.headers.get("set-cookie")?.split(";", 1)[0] || "",
  };
}

async function post(test: Owner, path: string, action: "approve" | "cancel", fields: Record<string, string>, cookie: string): Promise<Response> {
  return fetch(`${test.baseUrl()}${path}/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      cookie,
      origin: test.baseUrl(),
      referer: `${test.baseUrl()}${path}`,
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

async function turnOnEdit(test: Owner, requested: JsonObject): Promise<JsonObject> {
  const path = new URL(String(requested.approvalUrl)).pathname;
  const { nonce, cookie } = await reviewForm(test, path);
  const response = await post(test, path, "approve", { nonce, presence: reviewApprovalProof(test.key(), `${path}/approve`, nonce) }, cookie);
  expect(response.status).toBe(303);
  return waitFor(test, String(requested.editAccessId));
}

describe("Edit asked for in a conversation", () => {
  it("opens a review page and turns nothing on, even for a client that answers every form itself", async () => {
    const test = await owner();
    try {
      const requested = await requestEdit(test);
      expect(requested).toMatchObject({ schema: "morrow.edit-access.v1", ok: false, mode: "edit", state: "awaiting_approval", outcome: "not_sent" });
      expect(String(requested.approvalUrl)).toBe(`${test.baseUrl()}/edit-access/${requested.editAccessId}`);
      expect(requested.editAccessId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(test.prepare).toHaveBeenCalledWith("edit", [
        { sourceBindingId: "canvas-bio", enabledCategories: ["assignment_due_at"] },
        { sourceBindingId: "moodle-chem", enabledCategories: ["moodle_page_content"] },
      ]);
      expect(test.apply).not.toHaveBeenCalled();
      const waited = await waitFor(test, String(requested.editAccessId), 1);
      expect(waited).toMatchObject({ state: "awaiting_approval", ok: false, waited: { timedOut: true } });
      expect(test.apply).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("refuses a program that posts the review form without Morrow Bridge's signature", async () => {
    const test = await owner();
    try {
      const requested = await requestEdit(test);
      const path = new URL(String(requested.approvalUrl)).pathname;
      const { nonce, cookie } = await reviewForm(test, path);
      for (const presence of [undefined, "A".repeat(43), reviewApprovalProof(test.key(), `${path}/approve`, "another-nonce")]) {
        const response = await post(test, path, "approve", { nonce, ...(presence ? { presence } : {}) }, cookie);
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("in Chrome");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(test.apply).not.toHaveBeenCalled();
      expect(await waitFor(test, String(requested.editAccessId), 1)).toMatchObject({ state: "awaiting_approval" });
      // The refusals left the page usable, so the person can still turn Edit on in Chrome.
      expect(await turnOnEdit(test, requested)).toMatchObject({ ok: true, state: "enabled" });
    } finally {
      await test.close();
    }
  });

  it("turns on exactly the reviewed scope after a signed click, once, and the wait confirms it", async () => {
    const test = await owner();
    try {
      const requested = await requestEdit(test);
      const confirmed = await turnOnEdit(test, requested);
      expect(test.apply).toHaveBeenCalledTimes(1);
      // The reviewed kinds join what each course already has; nothing the person turned on ends.
      expect(test.apply).toHaveBeenCalledWith(prepared, { merge: true });
      expect(confirmed).toMatchObject({ schema: "morrow.edit-access.v1", ok: true, mode: "edit", state: "enabled", outcome: "received" });
      expect(confirmed.selections).toEqual([
        expect.objectContaining({ sourceBindingId: "canvas-bio", actualMode: "edit", confirmed: true }),
        expect.objectContaining({ sourceBindingId: "moodle-chem", actualMode: "edit", confirmed: true }),
      ]);
      expect(confirmed).not.toHaveProperty("approvalUrl");
      const path = new URL(String(requested.approvalUrl)).pathname;
      const after = await reviewForm(test, path);
      expect(after.nonce).toBe("");
      expect(after.body).toContain("Edit is on for these courses.");
    } finally {
      await test.close();
    }
  });

  it("keeps the Edit choices a course already has, and lists the whole saved grant after Turn on Edit", async () => {
    const test = await owner();
    try {
      const requested = await requestEdit(test);
      const { body } = await reviewForm(test, new URL(String(requested.approvalUrl)).pathname);
      expect(body).toContain("Changes Morrow already makes without asking in these courses stay on.");
      // Biology already had a removal and a routine kind, turned on in Plan and Edit settings.
      test.apply.mockImplementationOnce(async (scope: BrowserEditAccessPrepared) => {
        const granted = grantedResult(scope);
        return {
          ...granted,
          bindings: granted.bindings.map((binding) => binding.sourceBindingId !== "canvas-bio" ? binding : {
            ...binding,
            editCategories: [
              { id: "action:canvas:canvas_remove_report", label: "Remove a generated report", availability: "edit", destructive: true },
              { id: "assignment_due_at", label: "Assignment due dates", availability: "edit" },
              { id: "canvas_create_ai_conversation", label: "Start an AI conversation", availability: "edit", verification: "unchecked" },
            ],
            editPermission: {
              ...(binding.editPermission as JsonObject),
              enabledCategories: ["action:canvas:canvas_remove_report", "assignment_due_at", "canvas_create_ai_conversation"],
            },
          }),
        } satisfies BrowserEditAccessResult;
      });
      const confirmed = await turnOnEdit(test, requested);
      expect(confirmed).toMatchObject({ ok: true, state: "enabled", outcome: "received" });
      expect(confirmed.selections).toEqual([
        expect.objectContaining({ sourceBindingId: "canvas-bio", actualMode: "edit", confirmed: true }),
        expect.objectContaining({ sourceBindingId: "moodle-chem", actualMode: "edit", confirmed: true }),
      ]);
      const after = await reviewForm(test, new URL(String(requested.approvalUrl)).pathname);
      const biology = after.body.slice(after.body.indexOf("Biology"), after.body.indexOf("Chemistry"));
      expect(biology).toContain("Changes Morrow now makes without asking");
      expect(biology).toContain("<li>Remove a generated report</li>");
      expect(biology).toContain("<li>Assignment due dates</li>");
      expect(biology).toContain("<li>Start an AI conversation</li>");
      expect(after.body.slice(after.body.indexOf("Chemistry"))).toContain("<li>Page content</li>");
    } finally {
      await test.close();
    }
  });

  it("does not confirm Edit when the saved grant is missing a reviewed kind", async () => {
    const test = await owner();
    try {
      const requested = await requestEdit(test);
      test.apply.mockImplementationOnce(async (scope: BrowserEditAccessPrepared) => {
        const granted = grantedResult(scope);
        return {
          ...granted,
          bindings: granted.bindings.map((binding) => binding.sourceBindingId !== "canvas-bio" ? binding : {
            ...binding,
            editPermission: { ...(binding.editPermission as JsonObject), enabledCategories: ["canvas_create_ai_conversation"] },
          }),
        } satisfies BrowserEditAccessResult;
      });
      expect(await turnOnEdit(test, requested)).toMatchObject({ ok: false, state: "unconfirmed" });
    } finally {
      await test.close();
    }
  });

  it("says when a course's Edit access from an earlier Morrow ends, and that the new kinds end with it", async () => {
    const endsAt = Date.now() + 3 * 60 * 60_000;
    const test = await owner(endsAt);
    try {
      test.prepare.mockResolvedValueOnce({
        mode: "edit",
        selections: [{ ...prepared.selections[0]!, grantEndsAt: endsAt }, prepared.selections[1]!],
      } satisfies BrowserEditAccessPrepared);
      const requested = await requestEdit(test);
      const when = new Date(endsAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const { body } = await reviewForm(test, new URL(String(requested.approvalUrl)).pathname);
      const biology = body.slice(body.indexOf("Biology"), body.indexOf("Chemistry"));
      expect(biology).toContain(`This course has Edit access from an earlier version of Morrow that ends ${when}. These changes end with it, and the course returns to Plan.`);
      expect(body.slice(body.indexOf("Chemistry"))).not.toContain("earlier version of Morrow");
      expect(body).not.toContain("Edit stays on for these courses until you return them to Plan in Morrow Bridge.");
      expect(body).toContain("Edit stays on until you return a course to Plan in Morrow Bridge, except for a course this page says ends sooner.");
      expect(await turnOnEdit(test, requested)).toMatchObject({ ok: true, state: "enabled" });
      const after = await reviewForm(test, new URL(String(requested.approvalUrl)).pathname);
      expect(after.body).toContain(`This course has Edit access from an earlier version of Morrow that ends ${when}. These changes end with it, and the course returns to Plan.`);
      expect(after.body).not.toContain("It stays on until you return them to Plan in Morrow Bridge.");
    } finally {
      await test.close();
    }
  });

  it("keeps Plan when the person selects Keep Plan", async () => {
    const test = await owner();
    try {
      const requested = await requestEdit(test);
      const path = new URL(String(requested.approvalUrl)).pathname;
      const { nonce, cookie } = await reviewForm(test, path);
      expect((await post(test, path, "cancel", { nonce }, cookie)).status).toBe(303);
      expect(await waitFor(test, String(requested.editAccessId))).toMatchObject({ ok: false, state: "declined", outcome: "not_sent" });
      expect(test.apply).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("reports a course connection that changed before the save, and turns nothing on", async () => {
    const test = await owner();
    try {
      const requested = await requestEdit(test);
      test.apply.mockRejectedValueOnce(new Error("The selected browser course connection changed before confirmation."));
      expect(await turnOnEdit(test, requested)).toMatchObject({ ok: false, state: "not_sent" });
    } finally {
      await test.close();
    }
  });

  it("names each course and action on the page, and says Edit stays on until Plan", async () => {
    const test = await owner();
    try {
      test.prepare.mockResolvedValueOnce({
        mode: "edit",
        selections: [{
          ...prepared.selections[1]!,
          enabledCategories: [
            { id: "moodle_page_content", label: "Page content", description: "Change a Moodle Page.", destructive: false, unchecked: false },
            { id: "action:moodle:moodle_update_book_chapter", label: "Update a Book chapter", description: "Change a chapter.", destructive: false, unchecked: true },
          ],
        }],
      } satisfies BrowserEditAccessPrepared);
      const requested = await requestEdit(test, { mode: "edit", selections: [{ source_binding_id: "moodle-chem", enabled_categories: ["action:moodle:moodle_update_book_chapter", "moodle_page_content"] }] });
      const { body } = await reviewForm(test, new URL(String(requested.approvalUrl)).pathname);
      expect(body).toContain("<h1>Turn on Edit?</h1>");
      expect(body).toContain("Chemistry");
      expect(body).toContain("https://moodle.example.edu");
      expect(body).toContain("<li>Page content</li>");
      expect(body).toContain("<li>Update a Book chapter</li>");
      expect(body).toContain("Morrow cannot check the saved result for 1 selected action: Update a Book chapter. Morrow reports those results as unconfirmed.");
      expect(body).toContain("Edit stays on for these courses until you return them to Plan in Morrow Bridge.");
      expect(body).toContain(">Turn on Edit</button>");
      expect(body).toContain(">Keep Plan</button>");
      expect(body).not.toContain(test.key());
    } finally {
      await test.close();
    }
  });

  it("never offers an action that removes content", async () => {
    const test = await owner();
    try {
      test.prepare.mockRejectedValueOnce(new EditCategoryUnavailableError(
        "action:canvas:canvas_delete_assignment",
        "Actions that remove content are turned on only in Morrow Bridge Plan and Edit settings.",
      ));
      const refused = await test.client.callTool({
        name: "morrow_request_edit_access",
        arguments: { mode: "edit", selections: [{ source_binding_id: "canvas-bio", enabled_categories: ["action:canvas:canvas_delete_assignment"] }] },
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ code: "edit_access_category_unavailable", category: "action:canvas:canvas_delete_assignment" });
      expect(JSON.stringify(refused.content)).toContain("Actions that remove content are turned on only in Morrow Bridge Plan and Edit settings.");
      // The review store refuses one too, whatever prepared it.
      const reviews = new EditAccessReviews(async () => { throw new Error("never saved"); });
      expect(() => reviews.create({
        mode: "edit",
        selections: [{ ...prepared.selections[0]!, enabledCategories: [{ id: "action:canvas:canvas_delete_assignment", label: "Delete an assignment", description: "Removes it.", destructive: true, unchecked: false }] }],
      }, test.baseUrl())).toThrow(/removes content/);
      expect(test.apply).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("sets Plan at once, with no review", async () => {
    const test = await owner();
    try {
      test.prepare.mockResolvedValueOnce(planPrepared);
      test.apply.mockResolvedValueOnce({
        mode: "plan",
        outcome: "received",
        command: { schema: "morrow.browser-edit-policy-set.v1", ok: true },
        bindings: planPrepared.selections.map((selection) => ({
          sourceBindingId: selection.sourceBindingId,
          provider: selection.provider,
          courseId: selection.courseId,
          ...(selection.provider === "canvas" ? { origin: selection.site } : { siteUrl: selection.site }),
          principalFingerprint: selection.principalFingerprint,
          sessionGeneration: selection.sessionGeneration,
          catalogDigest: selection.catalogDigest,
          runtimeVerified: true,
          editPolicyRevision: selection.expectedPolicyRevision + 1,
        })),
      } satisfies BrowserEditAccessResult);
      const revoked = await test.client.callTool({
        name: "morrow_request_edit_access",
        arguments: { mode: "plan", selections: input.selections.map((selection) => ({ source_binding_id: selection.source_binding_id })) },
      });
      expect(revoked.isError, JSON.stringify(revoked.content)).not.toBe(true);
      expect(revoked).not.toHaveProperty("inputRequests");
      expect(test.apply).toHaveBeenLastCalledWith(planPrepared);
      expect(revoked.structuredContent).toMatchObject({ schema: "morrow.edit-access.v1", ok: true, mode: "plan", outcome: "received" });
    } finally {
      await test.close();
    }
  });
});

describe("untimed Edit grants", () => {
  it("confirms a grant the Bridge saved with no end time", async () => {
    const test = await owner();
    try {
      expect(await turnOnEdit(test, await requestEdit(test))).toMatchObject({ ok: true, mode: "edit" });
    } finally {
      await test.close();
    }
  });

  it("still confirms a legacy grant with a future end time, and refuses one that already ended", async () => {
    const future = await owner(Date.now() + 60_000);
    try {
      expect(await turnOnEdit(future, await requestEdit(future))).toMatchObject({ ok: true });
    } finally {
      await future.close();
    }
    const lapsed = await owner(Date.now() - 1_000);
    try {
      expect(await turnOnEdit(lapsed, await requestEdit(lapsed))).toMatchObject({ ok: false, state: "unconfirmed" });
    } finally {
      await lapsed.close();
    }
  });
});
