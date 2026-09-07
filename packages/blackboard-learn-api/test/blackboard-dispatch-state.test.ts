import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { BlackboardLearnRuntime } from "../src/runtime.js";
import { createBlackboardLearnMcpServer } from "../src/server.js";
import { signBlackboardEffectGrant } from "../src/effect-grant.js";
import type { BlackboardTenant } from "../src/types.js";

const courseId = "_22_1";
const contentId = "_33_1";
const principalId = "_11_1";
const effectSecret = Buffer.alloc(32, 9).toString("base64url");
const patchPath = `/learn/api/public/v1/courses/${courseId}/contents/${contentId}`;

let close: (() => Promise<void>) | undefined;

afterEach(async () => { await close?.(); close = undefined; });

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function structured(result: unknown): JsonObject {
  if (!isJsonObject(result) || !isJsonObject(result.structuredContent)) {
    throw new Error("The Blackboard tool returned no structured result.");
  }
  return result.structuredContent;
}

function grantArguments(planDigest: string, receipt: string): JsonObject {
  const unsigned = {
    schema: "morrow.blackboard.effect-grant.v1" as const,
    operationId: "op:blackboard-dispatch-state",
    planDigest,
    outerPlanDigest: "a".repeat(64),
    approvalGrantDigest: "b".repeat(64),
    effectReceiptId: receipt,
    dispatchAttempt: 1,
    gatewayProcessId: "gateway:dispatch-state",
  };
  return {
    schema: unsigned.schema,
    operation_id: unsigned.operationId,
    plan_digest: unsigned.planDigest,
    outer_plan_digest: unsigned.outerPlanDigest,
    approval_grant_digest: unsigned.approvalGrantDigest,
    effect_receipt_id: unsigned.effectReceiptId,
    dispatch_attempt: unsigned.dispatchAttempt,
    gateway_process_id: unsigned.gatewayProcessId,
    dispatch_token: signBlackboardEffectGrant(effectSecret, unsigned),
  };
}

/**
 * One local Blackboard fixture plus the source's own MCP server, because the
 * execution-state marker is written where the server shapes a tool result.
 */
async function harness(options: {
  /** Change the stored title just before the numbered content read answers. */
  readonly mutateOnContentRead?: number;
  /** Answer the PATCH with HTTP 200 without storing the change. */
  readonly storePatch?: boolean;
  /** Drop the connection after the PATCH request arrives. */
  readonly dropConnectionOnPatch?: boolean;
} = {}) {
  let patchCount = 0;
  let contentReadCount = 0;
  let content: JsonObject = {
    id: contentId,
    courseId,
    contentHandler: { id: "resource/x-bb-document" },
    title: "Welcome Jane Doe",
    description: "Jane Doe uses jane@example.edu",
    availability: { available: "Yes" },
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "http://fixture").pathname;
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      json(response, { access_token: "temporary-token", expires_in: 3600 }); return;
    }
    if (pathname === "/learn/api/public/v1/users/me") { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/users/${principalId}`) { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/users/${principalId}`) {
      json(response, { id: "_membership_1", courseId, userId: principalId }); return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/users`) {
      json(response, { results: [{
        id: "_membership_2", courseId, userId: "_44_1", courseRoleId: "Student", availability: { available: "Yes" },
        user: { id: "_44_1", name: { given: "Jane", family: "Doe" }, contact: { email: "jane@example.edu" }, userName: "jane.doe" },
      }], paging: {} }); return;
    }
    if (pathname === `/learn/api/public/v3/courses/${courseId}`) {
      json(response, { id: courseId, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false }); return;
    }
    if (pathname === patchPath && request.method === "GET") {
      contentReadCount += 1;
      if (options.mutateOnContentRead === contentReadCount) content = { ...content, title: "Changed by the instructor" };
      json(response, content); return;
    }
    if (pathname === patchPath && request.method === "PATCH") {
      patchCount += 1;
      let source = "";
      request.on("data", (chunk) => { source += String(chunk); });
      request.on("end", () => {
        if (options.dropConnectionOnPatch) { request.socket.destroy(); return; }
        if (options.storePatch !== false) content = { ...content, ...(JSON.parse(source) as JsonObject) };
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
  const runtime = new BlackboardLearnRuntime([tenant], { effectDispatchSecret: effectSecret });
  const client = new Client({ name: "blackboard-dispatch-state", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const running = serveStdio(() => createBlackboardLearnMcpServer(runtime, { includePrivateDispatch: true }), { transport: right });
  await client.connect(left);
  close = async () => {
    await client.close();
    await running.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const scope = { tenant_id: "fixture", source_binding_id: binding, course_id: courseId };
  /** The Blackboard connection this run acts as, as the dispatch route requires it. */
  const reviewedConnection = () => {
    const current = runtime.effectScope({ tenantId: "fixture", sourceBindingId: binding, courseId });
    return { principal_fingerprint: current.principalFingerprint, session_generation: current.sessionGeneration };
  };
  return {
    client,
    scope,
    binding,
    counts: () => ({ patchCount }),
    plan: async (patch: JsonObject) => structured(await client.callTool({
      name: "blackboard_plan_content_patch",
      arguments: { ...scope, content_id: contentId, patch },
    })),
    apply: async (patch: JsonObject, planDigest: string, receipt: string) => structured(await client.callTool({
      name: "blackboard_apply_reviewed_content_patch",
      arguments: {
        ...scope,
        content_id: contentId,
        patch,
        expected_plan_digest: planDigest,
        expected_connection: reviewedConnection(),
        _morrow: { outer_grant: grantArguments(planDigest, receipt) },
      },
    })),
  };
}

describe("Blackboard result execution state", () => {
  it("marks a refusal raised before any Blackboard request as not sent", async () => {
    const fixture = await harness();
    const mismatched = structured(await fixture.client.callTool({
      name: "blackboard_read_course",
      arguments: { ...fixture.scope, source_binding_id: "blackboard:another-course" },
    }));
    expect(mismatched).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_scope_binding_mismatch" },
    });
    const invalid = await fixture.plan({ description: "x".repeat(751) });
    expect(invalid).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_response_invalid" },
    });
    expect(fixture.counts().patchCount).toBe(0);
  });

  it("marks a content change found before the PATCH as not sent", async () => {
    const fixture = await harness({ mutateOnContentRead: 3 });
    const patch = { title: "Reviewed title" };
    const plan = await fixture.plan(patch);
    expect(plan).toMatchObject({ ok: true, reviewRequired: true });
    const applied = await fixture.apply(patch, String(plan.planDigest), "effect:00000000-0000-4000-8000-000000000001");
    expect(applied).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(fixture.counts().patchCount).toBe(0);
  });

  it("marks a readback that does not match after a sent PATCH as applied or unknown", async () => {
    const fixture = await harness({ storePatch: false });
    const patch = { title: "Reviewed title" };
    const plan = await fixture.plan(patch);
    const applied = await fixture.apply(patch, String(plan.planDigest), "effect:00000000-0000-4000-8000-000000000002");
    expect(applied).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(fixture.counts().patchCount).toBe(1);
  });

  it("marks a connection failure raised after the PATCH began as applied or unknown", async () => {
    const fixture = await harness({ dropConnectionOnPatch: true });
    const patch = { title: "Reviewed title" };
    const plan = await fixture.plan(patch);
    const applied = await fixture.apply(patch, String(plan.planDigest), "effect:00000000-0000-4000-8000-000000000003");
    expect(applied).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_request_failed" },
    });
    expect(fixture.counts().patchCount).toBe(1);
  });

  it("marks a confirmed patch as applied and keeps the untested-evidence label", async () => {
    const fixture = await harness();
    const patch = { title: "Reviewed title" };
    const plan = await fixture.plan(patch);
    const applied = await fixture.apply(patch, String(plan.planDigest), "effect:00000000-0000-4000-8000-000000000004");
    expect(applied).toMatchObject({
      ok: true,
      resultState: "applied",
      status: "api_configured_live_untested",
      content: { title: "Reviewed title" },
    });
    expect(fixture.counts().patchCount).toBe(1);
  });
});
