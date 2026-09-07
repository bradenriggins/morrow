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
import type { BlackboardPrincipalVerification, BlackboardTenant } from "../src/types.js";

const courseId = "_22_1";
const contentId = "_33_1";
const principalId = "_11_1";
const otherPrincipalId = "_99_1";
const effectSecret = Buffer.alloc(32, 5).toString("base64url");
const contentPath = `/learn/api/public/v1/courses/${courseId}/contents/${contentId}`;

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
    operationId: "op:blackboard-principal",
    planDigest,
    outerPlanDigest: "a".repeat(64),
    approvalGrantDigest: "b".repeat(64),
    effectReceiptId: receipt,
    dispatchAttempt: 1,
    gatewayProcessId: "gateway:principal",
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

/** What one Learn site answers at GET /learn/api/public/v1/users/me. */
type PrincipalAnswer =
  | { readonly kind: "account"; readonly id: unknown }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "text" };

/**
 * One local Blackboard fixture plus the source's own MCP server, because the
 * refusal a person reads and its execution-state marker are both shaped there.
 */
async function harness(options: {
  readonly principal?: PrincipalAnswer;
  readonly principalVerification?: BlackboardPrincipalVerification;
  /** Seconds the fixture's OAuth token lasts, which is what the principal cache is held against. */
  readonly tokenLifetime?: number;
} = {}) {
  const answers = { principal: options.principal || { kind: "account", id: principalId } as PrincipalAnswer };
  let patchCount = 0;
  let principalReadCount = 0;
  let courseRequestCount = 0;
  let content: JsonObject = {
    id: contentId, courseId, contentHandler: { id: "resource/x-bb-document" },
    title: "Welcome", availability: { available: "Yes" },
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "http://fixture").pathname;
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      json(response, { access_token: "temporary-token", expires_in: options.tokenLifetime || 3600 }); return;
    }
    if (pathname === "/learn/api/public/v1/users/me") {
      principalReadCount += 1;
      const answer = answers.principal;
      if (answer.kind === "status") { json(response, { message: "refused" }, answer.status); return; }
      if (answer.kind === "text") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify("not an account"));
        return;
      }
      json(response, { id: answer.id }); return;
    }
    courseRequestCount += 1;
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
    if (pathname === `/learn/api/public/v1/courses/${courseId}`) { json(response, { id: courseId, name: "Biology" }); return; }
    if (pathname === contentPath && request.method === "GET") { json(response, content); return; }
    if (pathname === contentPath && request.method === "PATCH") {
      patchCount += 1;
      let source = "";
      request.on("data", (chunk) => { source += String(chunk); });
      request.on("end", () => { content = { ...content, ...(JSON.parse(source) as JsonObject) }; json(response, content); });
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
    ...(options.principalVerification ? { principalVerification: options.principalVerification } : {}),
    courseBindings: [{ sourceBindingId: binding, courseId }],
  };
  const runtime = new BlackboardLearnRuntime([tenant], { effectDispatchSecret: effectSecret });
  const client = new Client({ name: "blackboard-principal", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
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
    runtime,
    scope,
    answerPrincipalWith: (answer: PrincipalAnswer) => { answers.principal = answer; },
    counts: () => ({ patchCount, principalReadCount, courseRequestCount }),
    read: async () => structured(await client.callTool({ name: "blackboard_read_course", arguments: scope })),
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

describe("Blackboard integration principal", () => {
  it("reads the account the token acts as, once per token, and then proceeds", async () => {
    const fixture = await harness();
    expect(await fixture.read()).toMatchObject({ ok: true, courseId, course: { id: courseId } });
    expect(await fixture.read()).toMatchObject({ ok: true });
    // The account read is held against the exact token record, so one live token
    // resolves the principal once.
    expect(fixture.counts().principalReadCount).toBe(1);
  });

  it("refuses every read and write when the site names another account", async () => {
    const fixture = await harness({ principal: { kind: "account", id: otherPrincipalId } });
    expect(await fixture.read()).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_account_mismatch" },
    });
    expect(await fixture.plan({ title: "Reviewed title" })).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_account_mismatch" },
    });
    // Nothing about the course was read, and nothing was changed.
    expect(fixture.counts()).toMatchObject({ courseRequestCount: 0, patchCount: 0 });
  });

  it("reports a rejected credential as unauthorized, not as an unverified account", async () => {
    const fixture = await harness({ principal: { kind: "status", status: 401 } });
    expect(await fixture.read()).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_request_unauthorized", status: 401 },
    });
    expect(fixture.counts()).toMatchObject({ courseRequestCount: 0, patchCount: 0 });
  });

  it("refuses reads by default when the site does not answer the account read", async () => {
    for (const answer of [
      { kind: "status", status: 403 } as const,
      { kind: "status", status: 404 } as const,
      { kind: "text" } as const,
      { kind: "account", id: 11 } as const,
    ]) {
      const fixture = await harness({ principal: answer });
      expect(await fixture.read()).toMatchObject({
        ok: false,
        resultState: "not_sent",
        problem: { code: "blackboard_principal_unverified" },
      });
      expect(fixture.counts()).toMatchObject({ courseRequestCount: 0, patchCount: 0 });
      await close?.(); close = undefined;
    }
  });

  it("reads but never writes on a membership-only tenant that cannot answer the account read", async () => {
    const fixture = await harness({ principal: { kind: "status", status: 404 }, principalVerification: "membership-only" });
    expect(await fixture.read()).toMatchObject({ ok: true, courseId, course: { id: courseId } });
    expect(await fixture.plan({ title: "Reviewed title" })).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_principal_unverified" },
    });
    expect(fixture.counts().patchCount).toBe(0);
  });

  it("sends no PATCH when the account stops resolving between review and dispatch", async () => {
    const fixture = await harness({ tokenLifetime: 1 });
    const patch = { title: "Reviewed title" };
    const plan = await fixture.plan(patch);
    expect(plan).toMatchObject({ ok: true, reviewRequired: true });
    // A short-lived token forces a fresh token record, which invalidates the
    // cached account, so the dispatch re-reads the account the way a live
    // Blackboard token expiry would.
    fixture.answerPrincipalWith({ kind: "status", status: 403 });
    const applied = await fixture.apply(patch, String(plan.planDigest), "effect:00000000-0000-4000-8000-000000000001");
    expect(applied).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_principal_unverified" },
    });
    expect(fixture.counts().patchCount).toBe(0);
  });

  it("reports the effective verification mode in health", async () => {
    const strict = await harness();
    expect(structured(await strict.client.callTool({ name: "morrow_blackboard_health", arguments: {} })))
      .toMatchObject({ tenants: [{ id: "fixture", principalVerification: "self" }] });
    await close?.(); close = undefined;
    const relaxed = await harness({ principalVerification: "membership-only" });
    expect(relaxed.runtime.health()).toMatchObject({ tenants: [{ id: "fixture", principalVerification: "membership-only" }] });
  });
});
