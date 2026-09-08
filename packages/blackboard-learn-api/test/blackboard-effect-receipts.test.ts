import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { signBlackboardEffectGrant, type BlackboardEffectGrant } from "../src/effect-grant.js";
import { BlackboardEffectReceipts, blackboardEffectStatePath } from "../src/operations/effect-receipts.js";
import { BlackboardLearnRuntime } from "../src/runtime.js";
import { createBlackboardLearnMcpServer } from "../src/server.js";
import type { BlackboardTenant } from "../src/types.js";

const courseId = "_22_1";
const contentId = "_33_1";
const otherContentId = "_34_1";
const principalId = "_11_1";
const applicationKey = "app-key";
const clientSecret = "client-secret";
/** The dispatch secret one Gateway process minted. Another process mints another. */
const gatewaySecret = Buffer.alloc(32, 7).toString("base64url");
const otherGatewaySecret = Buffer.alloc(32, 9).toString("base64url");
const reviewedPatch = { title: "Reviewed title" };

let closeSite: (() => Promise<void>) | undefined;

afterEach(async () => { await closeSite?.(); closeSite = undefined; });

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

function receiptId(index: number): string {
  return `effect:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function unsignedGrant(input: { planDigest: string; receipt: string; operationId: string; processId: string }) {
  return {
    schema: "morrow.blackboard.effect-grant.v1" as const,
    operationId: input.operationId,
    planDigest: input.planDigest,
    outerPlanDigest: "a".repeat(64),
    approvalGrantDigest: "b".repeat(64),
    effectReceiptId: input.receipt,
    dispatchAttempt: 1,
    gatewayProcessId: input.processId,
  };
}

function grantArguments(input: {
  planDigest: string;
  receipt: string;
  operationId: string;
  processId: string;
  secret: string;
}): JsonObject {
  const grant = unsignedGrant(input);
  return {
    schema: grant.schema,
    operation_id: grant.operationId,
    plan_digest: grant.planDigest,
    outer_plan_digest: grant.outerPlanDigest,
    approval_grant_digest: grant.approvalGrantDigest,
    effect_receipt_id: grant.effectReceiptId,
    dispatch_attempt: grant.dispatchAttempt,
    gateway_process_id: grant.gatewayProcessId,
    dispatch_token: signBlackboardEffectGrant(input.secret, grant),
  };
}

interface Session {
  readonly runtime: BlackboardLearnRuntime;
  readonly read: () => Promise<JsonObject>;
  readonly plan: (target?: string) => Promise<JsonObject>;
  readonly apply: (input: {
    planDigest: string;
    receipt: string;
    operationId: string;
    target?: string;
    processId?: string;
    secret?: string;
  }) => Promise<JsonObject>;
  readonly verify: (target?: string) => Promise<JsonObject>;
  readonly unresolved: () => Promise<JsonObject>;
  readonly close: () => Promise<void>;
}

/**
 * One local Learn site, one app-private state directory, and as many Morrow
 * starts against them as a test needs. Each `start` is one restart of this
 * server: a fresh runtime with an empty process memory, reading the same effect
 * record from disk. That is the exact case the durable record exists for, and
 * the only way a test can reach it without a tenant.
 */
async function site() {
  const directory = await mkdtemp(join(tmpdir(), "morrow-blackboard-effects-"));
  const effectStatePath = join(directory, "state", "blackboard-effects.json");
  const sessionStatePath = join(directory, "state", "blackboard-sessions.json");
  const control = { patchStatus: 0 };
  let patchCount = 0;
  const contents: Record<string, JsonObject> = {
    [contentId]: {
      id: contentId, courseId, contentHandler: { id: "resource/x-bb-document" },
      title: "Welcome", availability: { available: "Yes" },
    },
    [otherContentId]: {
      id: otherContentId, courseId, contentHandler: { id: "resource/x-bb-document" },
      title: "Week one", availability: { available: "Yes" },
    },
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
        user: { id: "_44_1", name: { given: "Jane", family: "Doe" }, contact: { email: "jane@example.edu" } },
      }], paging: {} }); return;
    }
    if (pathname === `/learn/api/public/v3/courses/${courseId}`) {
      json(response, { id: courseId, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false });
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}`) { json(response, { id: courseId, name: "Biology" }); return; }
    for (const [id, saved] of Object.entries(contents)) {
      const contentPath = `/learn/api/public/v1/courses/${courseId}/contents/${id}`;
      if (pathname !== contentPath) continue;
      if (request.method === "GET") { json(response, saved); return; }
      if (request.method === "PATCH") {
        patchCount += 1;
        let source = "";
        request.on("data", (chunk) => { source += String(chunk); });
        request.on("end", () => {
          // A site that took the request and then failed. Morrow cannot prove
          // from here whether the change landed.
          if (control.patchStatus) { json(response, { message: "failure" }, control.patchStatus); return; }
          contents[id] = { ...saved, ...(JSON.parse(source) as JsonObject) };
          json(response, contents[id]);
        });
        return;
      }
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
  closeSite = async () => {
    for (const session of started.reverse()) await session.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  };

  async function start(startOptions: { readonly secret?: string } = {}): Promise<Session> {
    const tenant: BlackboardTenant = {
      id: "fixture", baseUrl, applicationKey, clientSecret, principalId,
      courseBindings: [{ sourceBindingId: binding, courseId }],
    };
    const runtime = new BlackboardLearnRuntime([tenant], {
      effectDispatchSecret: startOptions.secret || gatewaySecret,
      sessionStatePath,
      effectStatePath,
    });
    const [left, right] = InMemoryTransport.createLinkedPair();
    const running = serveStdio(() => createBlackboardLearnMcpServer(runtime, { includePrivateDispatch: true }), { transport: right });
    const client = new Client({ name: "blackboard-effect-receipts", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(left);
    const connection = () => {
      const current = runtime.effectScope({ tenantId: "fixture", sourceBindingId: binding, courseId });
      return { principal_fingerprint: current.principalFingerprint, session_generation: current.sessionGeneration };
    };
    const session: Session = {
      runtime,
      read: async () => structured(await client.callTool({ name: "blackboard_read_course", arguments: scope })),
      plan: async (target = contentId) => structured(await client.callTool({
        name: "blackboard_plan_content_patch",
        arguments: { ...scope, content_id: target, patch: reviewedPatch },
      })),
      apply: async (input) => structured(await client.callTool({
        name: "blackboard_apply_reviewed_content_patch",
        arguments: {
          ...scope,
          content_id: input.target || contentId,
          patch: reviewedPatch,
          expected_plan_digest: input.planDigest,
          expected_connection: connection(),
          _morrow: {
            outer_grant: grantArguments({
              planDigest: input.planDigest,
              receipt: input.receipt,
              operationId: input.operationId,
              processId: input.processId || "gateway:first-process",
              secret: input.secret || startOptions.secret || gatewaySecret,
            }),
          },
        },
      })),
      verify: async (target = contentId) => structured(await client.callTool({
        name: "blackboard_verify_content_patch",
        arguments: { ...scope, content_id: target, patch: reviewedPatch },
      })),
      unresolved: async () => structured(await client.callTool({ name: "blackboard_unresolved_effects", arguments: {} })),
      close: async () => { await client.close(); await running.close(); },
    };
    started.push(session);
    return session;
  }

  return {
    baseUrl,
    binding,
    effectStatePath,
    start,
    failNextPatches: (status: number) => { control.patchStatus = status; },
    counts: () => ({ patchCount }),
    savedRecord: async () => readFile(effectStatePath, "utf8"),
  };
}

describe("Blackboard durable effect record", () => {
  it("refuses a receipt this installation already spent, after a restart, and sends no second change", async () => {
    const learn = await site();
    const first = await learn.start();
    const plan = await first.plan();
    const spent = {
      planDigest: String(plan.planDigest),
      receipt: receiptId(1),
      operationId: "op:blackboard-durable-replay",
    };
    expect(await first.apply(spent)).toMatchObject({ ok: true, resultState: "applied", contentId });
    expect(learn.counts().patchCount).toBe(1);

    // Morrow starts again. The process memory that refused the first replay is
    // gone; the record on disk is not.
    await first.close();
    const restarted = await learn.start();
    const replayed = await restarted.apply({ ...spent, planDigest: String((await restarted.plan()).planDigest) });
    expect(replayed).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_patch_review_required" },
    });
    expect(String((replayed.problem as JsonObject).message)).toContain("It sent nothing now.");
    expect(learn.counts().patchCount).toBe(1);
  });

  it("holds the item after a change it could not confirm, across a restart, until an explicit fresh read settles it", async () => {
    const learn = await site();
    const first = await learn.start();
    const plan = await first.plan();
    learn.failNextPatches(500);
    const uncertain = await first.apply({
      planDigest: String(plan.planDigest),
      receipt: receiptId(2),
      operationId: "op:blackboard-uncertain",
    });
    expect(uncertain).toMatchObject({ ok: false, resultState: "applied_or_unknown" });
    expect(learn.counts().patchCount).toBe(1);

    // The item is held from here on, and the refusal happens at review time, so
    // nobody is asked to approve a change Morrow would then refuse to send.
    const blocked = await first.plan();
    expect(blocked).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_effect_unresolved" },
    });
    expect(String((blocked.problem as JsonObject).message)).toContain("op:blackboard-uncertain");

    // Another item in the same course is not held.
    expect(await first.plan(otherContentId)).toMatchObject({ ok: true, contentId: otherContentId });

    // The hold outlives the process that took it.
    await first.close();
    const restarted = await learn.start();
    expect(await restarted.plan()).toMatchObject({ problem: { code: "blackboard_effect_unresolved" } });
    expect(await restarted.unresolved()).toMatchObject({
      ok: true,
      count: 1,
      effects: [{ operationId: "op:blackboard-uncertain", phase: "uncertain", tenantId: "fixture", courseId, contentId }],
    });

    // Only an explicit fresh read lets go of the item, and it sends no change:
    // the site still holds the reviewed title as it was before the failure.
    learn.failNextPatches(0);
    expect(await restarted.verify()).toMatchObject({ ok: true, verified: false, contentId });
    expect(learn.counts().patchCount).toBe(1);
    expect(await restarted.unresolved()).toMatchObject({ ok: true, count: 0, effects: [] });

    // A new reviewed change to that item is accepted again, and it is one more
    // dispatch of a new approval, never a repeat of the earlier one.
    const replanned = await restarted.plan();
    expect(replanned).toMatchObject({ ok: true, contentId });
    expect(await restarted.apply({
      planDigest: String(replanned.planDigest),
      receipt: receiptId(3),
      operationId: "op:blackboard-uncertain-correction",
    })).toMatchObject({ ok: true, resultState: "applied" });
    expect(learn.counts().patchCount).toBe(2);
  });

  it("keeps no dispatch secret, grant token, or learner detail in its record", async () => {
    const learn = await site();
    const session = await learn.start();
    const plan = await session.plan();
    const dispatchToken = String((grantArguments({
      planDigest: String(plan.planDigest),
      receipt: receiptId(4),
      operationId: "op:blackboard-record-contents",
      processId: "gateway:first-process",
      secret: gatewaySecret,
    })).dispatch_token);
    expect(await session.apply({
      planDigest: String(plan.planDigest),
      receipt: receiptId(4),
      operationId: "op:blackboard-record-contents",
    })).toMatchObject({ ok: true, resultState: "applied" });

    const saved = await learn.savedRecord();
    for (const value of [gatewaySecret, dispatchToken, clientSecret, applicationKey, "Jane Doe", "jane@example.edu"]) {
      expect(saved).not.toContain(value);
    }
    expect(JSON.parse(saved)).toMatchObject({
      schema: "morrow.blackboard-learn.effects.v1",
      effects: [{ receiptId: receiptId(4), operationId: "op:blackboard-record-contents", phase: "verified" }],
    });
    expect((await stat(learn.effectStatePath)).mode & 0o077).toBe(0);
    // A settled change is not something a person has to look at.
    expect(await session.unresolved()).toMatchObject({ ok: true, count: 0 });
  });

  it("refuses a grant minted by another Gateway process, so a grant cannot cross a Gateway restart", async () => {
    const learn = await site();
    const session = await learn.start();
    const plan = await session.plan();
    const refused = await session.apply({
      planDigest: String(plan.planDigest),
      receipt: receiptId(5),
      operationId: "op:blackboard-other-process",
      processId: "gateway:earlier-process",
      // The Gateway mints one dispatch secret for each of its own processes
      // (packages/mcp-server/src/runtime.ts). A grant signed under an earlier
      // one is a signature this process cannot accept.
      secret: otherGatewaySecret,
    });
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_patch_review_required" },
    });
    expect(learn.counts().patchCount).toBe(0);
    // A refused signature spends no receipt, so the record stays empty. The same
    // receipt under the same process id, signed with the secret this process
    // holds, is accepted: the signature is the only thing that refused it.
    await expect(readFile(learn.effectStatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await session.apply({
      planDigest: String(plan.planDigest),
      receipt: receiptId(5),
      operationId: "op:blackboard-other-process",
      processId: "gateway:earlier-process",
    })).toMatchObject({ ok: true, resultState: "applied" });
    expect(learn.counts().patchCount).toBe(1);
  });

  it("keeps reading, and refuses every change, when its own effect record cannot be used", async () => {
    const learn = await site();
    const first = await learn.start();
    expect(await first.plan()).toMatchObject({ ok: true, contentId });
    await first.close();

    for (const damage of [
      async () => writeFile(learn.effectStatePath, "{\"schema\":\"morrow.blackboard-learn.effects.v1\"", { mode: 0o600 }),
      async () => writeFile(learn.effectStatePath, JSON.stringify({
        schema: "morrow.blackboard-learn.effects.v1",
        effects: [{ receiptId: "not-a-receipt", gatewayProcessId: "gateway:first-process", operationId: "op:x", phase: "sent", claimedAt: 1, updatedAt: 1 }],
      }), { mode: 0o600 }),
      async () => chmod(learn.effectStatePath, 0o666),
    ]) {
      await damage();
      const damaged = await learn.start();
      // A read sends no change, so it still answers.
      expect(await damaged.read()).toMatchObject({ ok: true, courseId });
      expect(await damaged.plan()).toMatchObject({
        ok: false,
        resultState: "not_sent",
        problem: { code: "blackboard_effect_record_unavailable" },
      });
      // "Morrow could not find out" is not the same answer as "there are none".
      expect(await damaged.unresolved()).toMatchObject({
        ok: false,
        problem: { code: "blackboard_effect_record_unavailable" },
      });
      expect(learn.counts().patchCount).toBe(0);
      await damaged.close();
    }
  });
});

describe("Blackboard effect record retention", () => {
  const target = { tenantId: "fixture", courseId, contentId };
  const otherTarget = { tenantId: "fixture", courseId, contentId: otherContentId };

  function grant(receipt: string, operationId: string): BlackboardEffectGrant {
    const unsigned = unsignedGrant({ planDigest: "c".repeat(64), receipt, operationId, processId: "gateway:retention" });
    return { ...unsigned, dispatchToken: signBlackboardEffectGrant(gatewaySecret, unsigned) };
  }

  it("persists and settles a hashed non-content target without exposing its key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-blackboard-generic-target-"));
    try {
      const path = join(directory, "state", "blackboard-effects.json");
      const target = {
        tenantId: "fixture",
        courseId,
        targetType: "gradebook-grade",
        targetKey: "d".repeat(64),
      } as const;
      const otherTarget = { ...target, targetKey: "e".repeat(64) } as const;
      const record = new BlackboardEffectReceipts(path);
      const dispatch = record.claim(grant(receiptId(10), "op:blackboard-generic-target"), target);
      dispatch.markSent();
      dispatch.markUncertain();

      expect(record.unresolved()).toMatchObject({
        count: 1,
        effects: [{
          operationId: "op:blackboard-generic-target",
          phase: "uncertain",
          tenantId: "fixture",
          courseId,
          targetType: "gradebook-grade",
        }],
      });
      expect(JSON.stringify(record.unresolved())).not.toContain(target.targetKey);
      expect(() => record.assertTargetFree(target)).toThrow(/already sent a change/);
      expect(() => record.assertTargetFree(otherTarget)).not.toThrow();

      const restarted = new BlackboardEffectReceipts(path);
      expect(() => restarted.assertTargetFree(target)).toThrow(/already sent a change/);
      restarted.recordComparison(target, false);
      expect(restarted.unresolved()).toMatchObject({ count: 0, effects: [] });
      expect(() => restarted.assertTargetFree(target)).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drops a settled record after its retention window and keeps an unconfirmed one however old it is", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-blackboard-retention-"));
    try {
      const path = join(directory, "state", "blackboard-effects.json");
      const day = 24 * 60 * 60 * 1_000;
      let clock = Date.UTC(2026, 8, 7);
      const record = new BlackboardEffectReceipts(path, () => clock);

      const settled = record.claim(grant(receiptId(11), "op:blackboard-settled"), target);
      settled.markSent();
      settled.markVerified();
      const holding = record.claim(grant(receiptId(12), "op:blackboard-holding"), otherTarget);
      holding.markSent();

      clock += 31 * day;
      // Any write rewrites the whole record, which is where the window applies.
      record.claim(grant(receiptId(13), "op:blackboard-later"), target).markSent();

      const saved = JSON.parse(await readFile(path, "utf8")) as { effects: { receiptId: string }[] };
      expect(saved.effects.map((effect) => effect.receiptId)).toEqual([receiptId(12), receiptId(13)]);
      expect((record.unresolved().effects as JsonObject[]).map((effect) => effect.operationId))
        .toEqual(["op:blackboard-holding", "op:blackboard-later"]);
      // The dropped record was settled, so its receipt is no longer refused.
      // Nothing can present it again: the Gateway process that signed it minted
      // its own dispatch secret and is long gone.
      expect(() => record.assertUnspent(grant(receiptId(11), "op:blackboard-settled"))).not.toThrow();
      expect(() => record.assertUnspent(grant(receiptId(12), "op:blackboard-holding"))).toThrow(/already dispatched/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the record in the app-private state directory, beside the Blackboard setup file", () => {
    expect(blackboardEffectStatePath({} as NodeJS.ProcessEnv)).toBe(resolve(`${homedir()}/.morrow/blackboard-effects.json`));
    expect(blackboardEffectStatePath({ MORROW_BLACKBOARD_EFFECT_STATE: "/var/morrow/effects.json" } as NodeJS.ProcessEnv))
      .toBe("/var/morrow/effects.json");
  });
});
