import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { BlackboardLearnRuntime } from "../src/runtime.js";
import { createBlackboardLearnMcpServer } from "../src/server.js";
import { BlackboardApiError, type BlackboardTenant } from "../src/types.js";
import { signBlackboardEffectGrant, type BlackboardEffectGrant } from "../src/effect-grant.js";

const courseId = "_22_1";
const contentId = "_33_1";
const parentId = "_55_1";
const principalId = "_11_1";
const effectSecret = Buffer.alloc(32, 7).toString("base64url");
const COURSE_FIELDS = "id,courseId,name,ultraStatus,closedComplete";
let server: ReturnType<typeof createServer> | undefined;

afterEach(async () => { await new Promise<void>((resolve) => server?.close(() => resolve()) || resolve()); server = undefined; });

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function fixture(options: {
  readonly mutateBeforePatch?: boolean;
  /** Change one frozen field the patch does not touch, just before dispatch. */
  readonly mutateProtectedSiblingBeforePatch?: boolean;
  readonly unsafeContentNextPage?: boolean;
  readonly unauthorizedFirstContentsRead?: boolean;
  readonly patchStatus?: number;
  readonly contentHandler?: JsonObject;
  readonly closedComplete?: boolean;
  readonly ultraStatus?: string | null;
  /** Answer the PATCH by replacing the whole availability object. */
  readonly replaceAvailabilityOnPatch?: boolean;
} = {}) {
  let patchCount = 0;
  let tokenCount = 0;
  let contentReadCount = 0;
  let contentsRequests = 0;
  const courseFields: string[] = [];
  let content: JsonObject = {
    id: contentId,
    parentId,
    courseId,
    contentHandler: options.contentHandler || { id: "resource/x-bb-document" },
    title: "Welcome Jane Doe",
    description: "Jane Doe uses jane@example.edu",
    body: "Hello Jane Doe",
    position: 3,
    availability: { available: "Yes", allowGuests: false, adaptiveRelease: { start: "2026-09-01T00:00:00.000Z" } },
  };
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://fixture");
    const pathname = url.pathname;
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      tokenCount += 1;
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from("app-key:client-secret").toString("base64")}`);
      json(response, { access_token: "temporary-token", expires_in: 3600 }); return;
    }
    expect(request.headers.authorization).toBe("Bearer temporary-token");
    if (pathname === "/learn/api/public/v1/users/me") { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/users/${principalId}`) { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/users/${principalId}`) { json(response, { id: "_membership_1", courseId, userId: principalId }); return; }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/users`) {
      json(response, { results: [{
        id: "_membership_2", courseId, userId: "_44_1", courseRoleId: "Student", availability: { available: "Yes" },
        user: { id: "_44_1", name: { given: "Jane", family: "Doe" }, contact: { email: "jane@example.edu" }, userName: "jane.doe" },
      }], paging: {} }); return;
    }
    if (pathname === `/learn/api/public/v3/courses/${courseId}`) {
      courseFields.push(url.searchParams.get("fields") || "");
      const ultraStatus = options.ultraStatus === undefined ? "Ultra" : options.ultraStatus;
      json(response, {
        id: courseId,
        courseId: "BIO-101",
        name: "Biology",
        closedComplete: options.closedComplete === true,
        ...(ultraStatus === null ? {} : { ultraStatus }),
      }); return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}`) { json(response, { id: courseId, name: "Biology" }); return; }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/contents`) {
      contentsRequests += 1;
      if (options.unauthorizedFirstContentsRead && contentsRequests === 1) { json(response, { message: "expired" }, 401); return; }
      json(response, { results: [content], paging: options.unsafeContentNextPage ? { nextPage: "https://outside.example/learn/api/public/v1/courses/_22_1/contents" } : {} }); return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/contents/${contentId}` && request.method === "GET") {
      contentReadCount += 1;
      if (options.mutateBeforePatch && contentReadCount === 2) content = { ...content, title: "Changed by instructor" };
      if (options.mutateProtectedSiblingBeforePatch && contentReadCount === 2) {
        content = { ...content, availability: { ...(content.availability as JsonObject), adaptiveRelease: { start: "2026-10-01T00:00:00.000Z" } } };
      }
      json(response, content); return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/contents/${contentId}` && request.method === "PATCH") {
      patchCount += 1;
      let source = "";
      request.on("data", (chunk) => { source += String(chunk); });
      request.on("end", () => {
        if (options.patchStatus) {
          response.writeHead(options.patchStatus, {
            "content-type": "application/json",
            ...(options.patchStatus === 429 ? { "retry-after": "30", "x-rate-limit-remaining": "0" } : {}),
          });
          response.end(JSON.stringify({ message: "failure" }));
          return;
        }
        const requested = JSON.parse(source) as JsonObject;
        const previousAvailability = content.availability as JsonObject;
        content = { ...content, ...requested };
        if (options.replaceAvailabilityOnPatch) {
          // A tenant that replaces the whole availability object instead of merging it.
          content = { ...content, availability: { available: (content.availability as JsonObject).available } };
        } else if (isJsonObject(requested.availability)) {
          // A tenant that merges the requested availability field into the stored object.
          content = { ...content, availability: { ...previousAvailability, ...requested.availability } };
        }
        json(response, content);
      });
      return;
    }
    json(response, { message: "not found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test fixture address missing");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const binding = deriveBlackboardSourceBindingId(baseUrl, principalId, courseId);
  const tenant: BlackboardTenant = {
    id: "fixture", baseUrl, applicationKey: "app-key", clientSecret: "client-secret", principalId,
    courseBindings: [{ sourceBindingId: binding, courseId }],
  };
  return {
    runtime: new BlackboardLearnRuntime([tenant], { effectDispatchSecret: effectSecret }),
    binding,
    counts: () => ({ patchCount, tokenCount, courseFields: [...courseFields] }),
  };
}

/** The Blackboard connection one run acts as, as the dispatch route requires it. */
function reviewedConnection(runtime: BlackboardLearnRuntime, binding: string): JsonObject {
  const current = runtime.effectScope({ tenantId: "fixture", sourceBindingId: binding, courseId });
  return { principal_fingerprint: current.principalFingerprint, session_generation: current.sessionGeneration };
}

function effectGrant(planDigest: string, receipt = "effect:00000000-0000-4000-8000-000000000001"): BlackboardEffectGrant {
  const unsigned = {
    schema: "morrow.blackboard.effect-grant.v1" as const,
    operationId: "op:blackboard-effect-1",
    planDigest,
    outerPlanDigest: "a".repeat(64),
    approvalGrantDigest: "b".repeat(64),
    effectReceiptId: receipt,
    dispatchAttempt: 1,
    gatewayProcessId: "gateway:test",
  };
  return { ...unsigned, dispatchToken: signBlackboardEffectGrant(effectSecret, unsigned) };
}

function grantArguments(grant: BlackboardEffectGrant): JsonObject {
  return {
    schema: grant.schema,
    operation_id: grant.operationId,
    plan_digest: grant.planDigest,
    outer_plan_digest: grant.outerPlanDigest,
    approval_grant_digest: grant.approvalGrantDigest,
    effect_receipt_id: grant.effectReceiptId,
    dispatch_attempt: grant.dispatchAttempt,
    gateway_process_id: grant.gatewayProcessId,
    dispatch_token: grant.dispatchToken,
  };
}

describe("Blackboard Learn REST vertical slice", () => {
  it("binds each read to the configured principal/course and redacts roster-derived learner identities before MCP egress", async () => {
    const { runtime, binding, counts } = await fixture();
    const result = await runtime.listContents({ tenantId: "fixture", sourceBindingId: binding, courseId });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("jane@example.edu");
    expect(result).toMatchObject({ status: "api_configured_live_untested", contents: [{ id: contentId }] });
    expect(counts().tokenCount).toBe(1);
    await expect(runtime.listContents({ tenantId: "fixture", sourceBindingId: "blackboard:wrong", courseId }))
      .rejects.toMatchObject({ code: "blackboard_scope_binding_mismatch" });
  });

  it("refuses a tenant object that supplies a non-derived source binding", async () => {
    const { binding } = await fixture();
    expect(() => new BlackboardLearnRuntime([{
      id: "wrong-binding", baseUrl: "http://127.0.0.1", applicationKey: "key", clientSecret: "secret", principalId,
      courseBindings: [{ sourceBindingId: binding, courseId }],
    }])).toThrow("source binding id does not match");
  });

  it("refuses an oversized description and the intentionally unsupported PartiallyVisible availability before any PATCH", async () => {
    const { runtime, binding, counts } = await fixture();
    await expect(runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch: { description: "x".repeat(751) } }))
      .rejects.toMatchObject({ code: "blackboard_response_invalid" });
    await expect(runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch: { availability: { available: "PartiallyVisible" } } }))
      .rejects.toMatchObject({ code: "blackboard_response_invalid" });
    expect(counts().patchCount).toBe(0);
  });

  it("refuses a document-body change and names the missing native contract before any request", async () => {
    const { runtime, binding, counts } = await fixture();
    await expect(runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch: { body: "<p>New body</p>" } }))
      .rejects.toMatchObject({ code: "blackboard_operation_unavailable", dispatchState: "not_sent", message: /Ultra BbML/ });
    expect(counts()).toMatchObject({ patchCount: 0, tokenCount: 0 });
  });

  it("refuses a folder, the Ultra document wrapper, and a file target with distinct reasons and no PATCH", async () => {
    const folder = await fixture({ contentHandler: { id: "resource/x-bb-folder" } });
    await expect(folder.runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: folder.binding, courseId, contentId, patch: { title: "Reviewed title" } }))
      .rejects.toMatchObject({ code: "blackboard_operation_unavailable", dispatchState: "not_sent", message: /not a folder/ });
    expect(folder.counts().patchCount).toBe(0);
    await new Promise<void>((resolve) => server?.close(() => resolve()) || resolve()); server = undefined;

    const wrapper = await fixture({ contentHandler: { id: "resource/x-bb-folder", isBbPage: true } });
    await expect(wrapper.runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: wrapper.binding, courseId, contentId, patch: { title: "Reviewed title" } }))
      .rejects.toMatchObject({ code: "blackboard_operation_unavailable", dispatchState: "not_sent", message: /Ultra document wrapper/ });
    expect(wrapper.counts().patchCount).toBe(0);
    await new Promise<void>((resolve) => server?.close(() => resolve()) || resolve()); server = undefined;

    const file = await fixture({ contentHandler: { id: "resource/x-bb-file" } });
    await expect(file.runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: file.binding, courseId, contentId, patch: { title: "Reviewed title" } }))
      .rejects.toMatchObject({ code: "blackboard_operation_unavailable", dispatchState: "not_sent", message: /resource\/x-bb-file/ });
    expect(file.counts().patchCount).toBe(0);
  });

  it("refuses a closed and complete course, and a course that does not report its Learn mode, before any PATCH", async () => {
    const closed = await fixture({ closedComplete: true });
    await expect(closed.runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: closed.binding, courseId, contentId, patch: { title: "Reviewed title" } }))
      .rejects.toMatchObject({ code: "blackboard_course_unavailable", dispatchState: "not_sent", message: /closed and complete/ });
    expect(closed.counts().patchCount).toBe(0);
    await new Promise<void>((resolve) => server?.close(() => resolve()) || resolve()); server = undefined;

    const unknownMode = await fixture({ ultraStatus: null });
    await expect(unknownMode.runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: unknownMode.binding, courseId, contentId, patch: { title: "Reviewed title" } }))
      .rejects.toMatchObject({ code: "blackboard_operation_unavailable", dispatchState: "not_sent", message: /Original or Ultra/ });
    expect(unknownMode.counts().patchCount).toBe(0);
  });

  it("permits one 401 credential refresh for a read but refuses an off-scope pagination link", async () => {
    const first = await fixture({ unauthorizedFirstContentsRead: true });
    await expect(first.runtime.listContents({ tenantId: "fixture", sourceBindingId: first.binding, courseId })).resolves.toMatchObject({ ok: true });
    expect(first.counts().tokenCount).toBe(2);
    await new Promise<void>((resolve) => server?.close(() => resolve()) || resolve()); server = undefined;
    const second = await fixture({ unsafeContentNextPage: true });
    await expect(second.runtime.listContents({ tenantId: "fixture", sourceBindingId: second.binding, courseId }))
      .rejects.toMatchObject({ code: "blackboard_pagination_refused" });
  });

  it("sends one reserved PATCH only after a fresh exact precondition and confirms it with a fresh GET", async () => {
    const { runtime, binding, counts } = await fixture();
    const plan = await runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch: { title: "Reviewed title" } });
    await expect(runtime.applyReservedContentPatch(plan, {} as BlackboardEffectGrant)).rejects.toMatchObject({ code: "blackboard_patch_review_required" });
    const result = await runtime.applyReservedContentPatch(plan, effectGrant(plan.planDigest));
    expect(result).toMatchObject({ ok: true, content: { title: "Reviewed title" } });
    expect(counts().patchCount).toBe(1);
    expect(counts().courseFields).toEqual([COURSE_FIELDS, COURSE_FIELDS]);
  });

  it("refuses a changed item before dispatch and does not retry a Blackboard PATCH", async () => {
    const { runtime, binding, counts } = await fixture({ mutateBeforePatch: true });
    const plan = await runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch: { title: "Reviewed title" } });
    await expect(runtime.applyReservedContentPatch(plan, effectGrant(plan.planDigest, "effect:00000000-0000-4000-8000-000000000002")))
      .rejects.toMatchObject({ code: "blackboard_content_mismatch" });
    expect(counts().patchCount).toBe(0);
  });

  it("confirms an availability change only when the frozen availability sub-fields come back with it", async () => {
    const { runtime, binding, counts } = await fixture();
    const patch = { availability: { available: "No" } };
    const plan = await runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch });
    const result = await runtime.applyReservedContentPatch(plan, effectGrant(plan.planDigest, "effect:00000000-0000-4000-8000-000000000008"));
    expect(result).toMatchObject({ ok: true, content: { availability: { available: "No" } } });
    expect(counts().patchCount).toBe(1);
  });

  it("refuses a protected field the patch does not touch when it changed between review and dispatch", async () => {
    const { runtime, binding, counts } = await fixture({ mutateProtectedSiblingBeforePatch: true });
    const plan = await runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch: { title: "Reviewed title" } });
    await expect(runtime.applyReservedContentPatch(plan, effectGrant(plan.planDigest, "effect:00000000-0000-4000-8000-000000000007")))
      .rejects.toMatchObject({ code: "blackboard_content_mismatch", dispatchState: "not_sent" });
    expect(counts().patchCount).toBe(0);
  });

  it("reports a patch that returns the requested title but drops the frozen adaptive release as applied or unknown", async () => {
    const { runtime, binding, counts } = await fixture({ replaceAvailabilityOnPatch: true });
    const patch = { title: "Reviewed title" };
    const plan = await runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch });
    const client = new Client({ name: "blackboard-readback-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [left, right] = InMemoryTransport.createLinkedPair();
    const running = serveStdio(() => createBlackboardLearnMcpServer(runtime, { includePrivateDispatch: true }), { transport: right });
    await client.connect(left);
    const result = await client.callTool({
      name: "blackboard_apply_reviewed_content_patch",
      arguments: {
        tenant_id: "fixture",
        source_binding_id: binding,
        course_id: courseId,
        content_id: contentId,
        patch,
        expected_plan_digest: plan.planDigest,
        expected_connection: reviewedConnection(runtime, binding),
        _morrow: { outer_grant: grantArguments(effectGrant(plan.planDigest, "effect:00000000-0000-4000-8000-000000000006")) },
      },
    });
    expect(isJsonObject(result.structuredContent) ? result.structuredContent : {}).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(counts().patchCount).toBe(1);
    await client.close();
    await running.close();
  });

  it("does not retry an uncertain Blackboard PATCH response", async () => {
    const { runtime, binding, counts } = await fixture({ patchStatus: 502 });
    const plan = await runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch: { title: "Reviewed title" } });
    await expect(runtime.applyReservedContentPatch(plan, effectGrant(plan.planDigest, "effect:00000000-0000-4000-8000-000000000003")))
      .rejects.toMatchObject({ code: "blackboard_request_failed", status: 502 });
    expect(counts().patchCount).toBe(1);
  });

  it("returns the tenant's bounded rate-limit diagnostics through MCP", async () => {
    const { runtime, binding, counts } = await fixture({ patchStatus: 429 });
    const patch = { title: "Reviewed title" };
    const plan = await runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch });
    const client = new Client({ name: "blackboard-rate-limit-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [left, right] = InMemoryTransport.createLinkedPair();
    const running = serveStdio(() => createBlackboardLearnMcpServer(runtime, { includePrivateDispatch: true }), { transport: right });
    await client.connect(left);
    const result = await client.callTool({
      name: "blackboard_apply_reviewed_content_patch",
      arguments: {
        tenant_id: "fixture",
        source_binding_id: binding,
        course_id: courseId,
        content_id: contentId,
        patch,
        expected_plan_digest: plan.planDigest,
        expected_connection: reviewedConnection(runtime, binding),
        _morrow: { outer_grant: grantArguments(effectGrant(plan.planDigest, "effect:00000000-0000-4000-8000-000000000009")) },
      },
    });
    expect(isJsonObject(result.structuredContent) ? result.structuredContent : {}).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: {
        code: "blackboard_request_rate_limited",
        status: 429,
        diagnostics: { "retry-after": "30", "x-rate-limit-remaining": "0" },
      },
    });
    expect(counts().patchCount).toBe(1);
    await client.close();
    await running.close();
  });

  it("refuses a forged or replayed effect grant without a second PATCH", async () => {
    const { runtime, binding, counts } = await fixture();
    const plan = await runtime.planContentPatch({ tenantId: "fixture", sourceBindingId: binding, courseId, contentId, patch: { title: "Reviewed title" } });
    const signed = effectGrant(plan.planDigest, "effect:00000000-0000-4000-8000-000000000004");
    await expect(runtime.applyReservedContentPatch(plan, { ...signed, dispatchToken: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "blackboard_patch_review_required" });
    const wrongPlan = effectGrant("c".repeat(64), "effect:00000000-0000-4000-8000-000000000005");
    await expect(runtime.applyReservedContentPatch(plan, wrongPlan))
      .rejects.toMatchObject({ code: "blackboard_patch_review_required" });
    expect(counts().patchCount).toBe(0);
    await runtime.applyReservedContentPatch(plan, signed);
    await expect(runtime.applyReservedContentPatch(plan, signed)).rejects.toMatchObject({ code: "blackboard_patch_review_required" });
    expect(counts().patchCount).toBe(1);
  });

  it("does not expose a direct Blackboard PATCH tool through public MCP", async () => {
    const { runtime } = await fixture();
    const client = new Client({ name: "blackboard-public-tool-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [left, right] = InMemoryTransport.createLinkedPair();
    const running = serveStdio(() => createBlackboardLearnMcpServer(runtime), { transport: right });
    await client.connect(left);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).not.toContain("blackboard_apply_reviewed_content_patch");
    expect(tools.tools.find((tool) => tool.name === "blackboard_plan_content_patch")?.annotations?.readOnlyHint).toBe(true);
    await client.close();
    await running.close();
  });
});
