import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { signBlackboardEffectGrant } from "../src/effect-grant.js";
import { BlackboardLearnRuntime } from "../src/runtime.js";
import { createBlackboardLearnMcpServer } from "../src/server.js";
import type { BlackboardPrincipalVerification, BlackboardTenant } from "../src/types.js";

const courseId = "_22_1";
const contentId = "_33_1";
const principalId = "_11_1";
const applicationKey = "app-key";
const firstSecret = "client-secret";
const rotatedSecret = "rotated-client-secret";
const effectSecret = Buffer.alloc(32, 7).toString("base64url");
const contentPath = `/learn/api/public/v1/courses/${courseId}/contents/${contentId}`;
const coursePath = `/learn/api/public/v3/courses/${courseId}`;
const reviewedPatch = { title: "Reviewed title" };
const reviewedAvailability = { available: "No" };

let closeFixture: (() => Promise<void>) | undefined;

afterEach(async () => { await closeFixture?.(); closeFixture = undefined; });

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

function scopeOf(value: JsonObject): JsonObject {
  if (!isJsonObject(value.effect_scope)) throw new Error("The Blackboard plan returned no effect scope.");
  return value.effect_scope;
}

function grantArguments(planDigest: string, receipt: string): JsonObject {
  const unsigned = {
    schema: "morrow.blackboard.effect-grant.v1" as const,
    operationId: "op:blackboard-effect-scope",
    planDigest,
    outerPlanDigest: "a".repeat(64),
    approvalGrantDigest: "b".repeat(64),
    effectReceiptId: receipt,
    dispatchAttempt: 1,
    gatewayProcessId: "gateway:effect-scope",
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

/** The Blackboard connection one plan was reviewed under, as the apply route receives it. */
function reviewedConnection(scope: JsonObject): JsonObject {
  return {
    principal_fingerprint: scope.principalFingerprint,
    session_generation: scope.sessionGeneration,
  };
}

interface Session {
  readonly runtime: BlackboardLearnRuntime;
  readonly effectScope: () => JsonObject;
  readonly read: () => Promise<JsonObject>;
  readonly plan: () => Promise<JsonObject>;
  readonly apply: (input: { planDigest: string; connection: JsonObject; receipt: string }) => Promise<JsonObject>;
  readonly planCourseAvailability: () => Promise<JsonObject>;
  readonly applyCourseAvailability: (input: { planDigest: string; connection: JsonObject; receipt: string }) => Promise<JsonObject>;
  readonly close: () => Promise<void>;
}

/**
 * One local Learn site, one durable session record directory, and as many
 * Morrow runs against them as a test needs. Each `start` is one Morrow start:
 * a fresh runtime, its own MCP server, and the same record file on disk, which
 * is how a credential rotation reaches the product: the secret changes in the
 * setup file and Morrow reads it when it next starts.
 */
async function fixture(options: { readonly principalAnswers?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "morrow-blackboard-effect-scope-"));
  const sessionStatePath = join(directory, "state", "blackboard-sessions.json");
  const control = {
    secret: firstSecret,
    principalAnswers: options.principalAnswers !== false,
  };
  let patchCount = 0;
  let coursePatchCount = 0;
  let course: JsonObject = {
    id: courseId,
    courseId: "BIO-101",
    name: "Biology",
    ultraStatus: "Ultra",
    closedComplete: false,
    availability: { available: "Yes", duration: { type: "Continuous" } },
  };
  let content: JsonObject = {
    id: contentId, courseId, contentHandler: { id: "resource/x-bb-document" },
    title: "Welcome", availability: { available: "Yes" },
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "http://fixture").pathname;
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      const expected = `Basic ${Buffer.from(`${applicationKey}:${control.secret}`, "utf8").toString("base64")}`;
      if (request.headers.authorization !== expected) { json(response, { message: "invalid credentials" }, 401); return; }
      json(response, { access_token: "temporary-token", expires_in: 3600 }); return;
    }
    if (pathname === "/learn/api/public/v1/users/me") {
      if (!control.principalAnswers) { json(response, { message: "refused" }, 404); return; }
      json(response, { id: principalId }); return;
    }
    if (pathname === `/learn/api/public/v1/users/${principalId}`) { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/users/${principalId}`) {
      json(response, { id: "_membership_1", courseId, userId: principalId }); return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/users`) {
      json(response, { results: [{
        id: "_membership_2", courseId, userId: "_44_1", courseRoleId: "Student", availability: { available: "Yes" },
        user: { id: "_44_1", name: { given: "Jane", family: "Doe" }, contact: { email: "jane@example.edu" } },
      }], paging: {} }); return;
    }
    if (pathname === coursePath && request.method === "GET") { json(response, course); return; }
    if (pathname === coursePath && request.method === "PATCH") {
      coursePatchCount += 1;
      let source = "";
      request.on("data", (chunk) => { source += String(chunk); });
      request.on("end", () => {
        const patch = JSON.parse(source) as JsonObject;
        const currentAvailability = isJsonObject(course.availability) ? course.availability : {};
        const patchAvailability = isJsonObject(patch.availability) ? patch.availability : {};
        course = { ...course, ...patch, availability: { ...currentAvailability, ...patchAvailability } };
        json(response, course);
      });
      return;
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
  const scope = { tenant_id: "fixture", source_binding_id: binding, course_id: courseId };
  const started: Session[] = [];
  closeFixture = async () => {
    for (const session of started.reverse()) await session.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  };

  async function start(startOptions: {
    readonly secret?: string;
    readonly principalVerification?: BlackboardPrincipalVerification;
  } = {}): Promise<Session> {
    control.secret = startOptions.secret || control.secret;
    const tenant: BlackboardTenant = {
      id: "fixture", baseUrl, applicationKey, clientSecret: control.secret, principalId,
      ...(startOptions.principalVerification ? { principalVerification: startOptions.principalVerification } : {}),
      courseBindings: [{ sourceBindingId: binding, courseId }],
    };
    const runtime = new BlackboardLearnRuntime([tenant], { effectDispatchSecret: effectSecret, sessionStatePath });
    const [left, right] = InMemoryTransport.createLinkedPair();
    const running = serveStdio(() => createBlackboardLearnMcpServer(runtime, { includePrivateDispatch: true }), { transport: right });
    const client = new Client({ name: "blackboard-effect-scope", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(left);
    const session: Session = {
      runtime,
      effectScope: () => runtime.effectScope({ tenantId: "fixture", sourceBindingId: binding, courseId }),
      read: async () => structured(await client.callTool({ name: "blackboard_read_course", arguments: scope })),
      plan: async () => structured(await client.callTool({
        name: "blackboard_plan_content_patch",
        arguments: { ...scope, content_id: contentId, patch: reviewedPatch },
      })),
      apply: async ({ planDigest, connection, receipt }) => structured(await client.callTool({
        name: "blackboard_apply_reviewed_content_patch",
        arguments: {
          ...scope,
          content_id: contentId,
          patch: reviewedPatch,
          expected_plan_digest: planDigest,
          expected_connection: connection,
          _morrow: { outer_grant: grantArguments(planDigest, receipt) },
        },
      })),
      planCourseAvailability: async () => structured(await client.callTool({
        name: "blackboard_plan_course_availability",
        arguments: { ...scope, ...reviewedAvailability },
      })),
      applyCourseAvailability: async ({ planDigest, connection, receipt }) => structured(await client.callTool({
        name: "blackboard_apply_reviewed_course_availability",
        arguments: {
          ...scope,
          ...reviewedAvailability,
          expected_plan_digest: planDigest,
          expected_connection: connection,
          _morrow: { outer_grant: grantArguments(planDigest, receipt) },
        },
      })),
      close: async () => { await client.close(); await running.close(); },
    };
    started.push(session);
    return session;
  }

  return {
    baseUrl,
    binding,
    sessionStatePath,
    start,
    answerPrincipal: (answers: boolean) => { control.principalAnswers = answers; },
    counts: () => ({ patchCount, coursePatchCount }),
    savedRecord: async () => readFile(sessionStatePath, "utf8"),
  };
}

describe("Blackboard effect binding scope", () => {
  it("binds a change to the account, the credential, and a session generation of one or more", async () => {
    const site = await fixture();
    const first = await site.start();
    const scope = scopeOf(await first.plan());
    expect(scope).toMatchObject({
      provider: "blackboard",
      origin: site.baseUrl,
      sourceBindingId: site.binding,
      sessionGeneration: 1,
    });
    expect(String(scope.principalFingerprint)).toMatch(/^[0-9a-f]{64}$/);
    // The record Morrow keeps of this connection holds digests only.
    const saved = await site.savedRecord();
    for (const secret of [firstSecret, applicationKey, principalId, site.baseUrl]) {
      expect(saved).not.toContain(secret);
    }
  });

  it("refuses a change reviewed before a credential rotation, and sends nothing", async () => {
    const site = await fixture();
    const before = await site.start();
    const reviewed = await before.plan();
    const reviewedScope = scopeOf(reviewed);
    expect(reviewedScope.sessionGeneration).toBe(1);
    await before.close();

    // Morrow starts again with a rotated application secret, the way a person
    // rotating the credential and restarting Morrow reaches this code.
    const after = await site.start({ secret: rotatedSecret });
    const replanned = await after.plan();
    // The content did not change: the reviewed plan digest still stands, so the
    // refusal below is about the connection and nothing else.
    expect(replanned.planDigest).toBe(reviewed.planDigest);
    expect(scopeOf(replanned)).toMatchObject({ sessionGeneration: 2 });
    expect(scopeOf(replanned).principalFingerprint).not.toBe(reviewedScope.principalFingerprint);

    const applied = await after.apply({
      planDigest: String(reviewed.planDigest),
      connection: reviewedConnection(reviewedScope),
      receipt: "effect:00000000-0000-4000-8000-000000000001",
    });
    expect(applied).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_patch_review_required" },
    });
    expect(String((applied.problem as JsonObject).message)).toContain("changed after this change was reviewed");
    expect(site.counts().patchCount).toBe(0);

    // The same change, reviewed under the connection Morrow now holds, is sent.
    const current = await after.apply({
      planDigest: String(replanned.planDigest),
      connection: reviewedConnection(scopeOf(replanned)),
      receipt: "effect:00000000-0000-4000-8000-000000000002",
    });
    expect(current).toMatchObject({ ok: true, resultState: "applied", contentId });
    expect(site.counts().patchCount).toBe(1);
  });

  it("refuses a reviewed course availability change after a credential rotation, before its PATCH", async () => {
    const site = await fixture();
    const before = await site.start();
    const reviewed = await before.planCourseAvailability();
    const reviewedScope = scopeOf(reviewed);
    expect(reviewed).toMatchObject({ ok: true, planDigest: expect.any(String) });
    await before.close();

    const after = await site.start({ secret: rotatedSecret });
    const refused = await after.applyCourseAvailability({
      planDigest: String(reviewed.planDigest),
      connection: reviewedConnection(reviewedScope),
      receipt: "effect:00000000-0000-4000-8000-000000000003",
    });
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_patch_review_required" },
    });
    expect(String((refused.problem as JsonObject).message)).toContain("Private error details were withheld");
    expect(site.counts().coursePatchCount).toBe(0);
  });

  it("raises the generation on every credential change and never lowers it", async () => {
    const site = await fixture();
    const first = await site.start();
    expect(scopeOf(await first.plan()).sessionGeneration).toBe(1);
    await first.close();

    // A restart on the same credential is the same session.
    const restarted = await site.start();
    expect(scopeOf(await restarted.plan()).sessionGeneration).toBe(1);
    await restarted.close();

    const rotated = await site.start({ secret: rotatedSecret });
    expect(scopeOf(await rotated.plan()).sessionGeneration).toBe(2);
    await rotated.close();

    // Returning to the earlier secret is another change, not a return to the
    // earlier session, so an approval frozen at generation 1 stays refused.
    const restored = await site.start({ secret: firstSecret });
    expect(scopeOf(await restored.plan()).sessionGeneration).toBe(3);
  });

  it("counts the account Blackboard reports for the credential, not the configured one", async () => {
    const site = await fixture({ principalAnswers: false });
    const unresolved = await site.start({ principalVerification: "membership-only" });
    expect(await unresolved.read()).toMatchObject({ ok: true, courseId });
    expect(unresolved.effectScope()).toMatchObject({ sessionGeneration: 1 });

    // The site starts answering the account read. The credential and the
    // configuration did not change; the account Morrow proved did.
    site.answerPrincipal(true);
    await unresolved.close();
    const resolved = await site.start();
    expect(await resolved.read()).toMatchObject({ ok: true, courseId });
    expect(resolved.effectScope()).toMatchObject({ sessionGeneration: 2 });
  });

  it("keeps reading, and refuses every change, when its own session record cannot be used", async () => {
    const site = await fixture();
    const first = await site.start();
    expect(scopeOf(await first.plan()).sessionGeneration).toBe(1);
    await first.close();

    for (const damage of [
      async () => writeFile(site.sessionStatePath, "{\"schema\":\"morrow.blackboard-learn.sessions.v1\"", { mode: 0o600 }),
      async () => {
        await writeFile(site.sessionStatePath, JSON.stringify({
          schema: "morrow.blackboard-learn.sessions.v1",
          sessions: [{ identity: "f".repeat(64), generation: 0, revision: "e".repeat(64) }],
        }), { mode: 0o600 });
      },
      async () => chmod(site.sessionStatePath, 0o666),
    ]) {
      await damage();
      const damaged = await site.start();
      // A read sends no change, so it still answers.
      expect(await damaged.read()).toMatchObject({ ok: true, courseId });
      expect(await damaged.plan()).toMatchObject({
        ok: false,
        resultState: "not_sent",
        problem: { code: "blackboard_session_unavailable" },
      });
      expect(site.counts().patchCount).toBe(0);
      await damaged.close();
    }
  });
});
