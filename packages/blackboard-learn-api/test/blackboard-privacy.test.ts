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
const instructorId = "_44_1";
const studentId = "_45_1";
const rosterPath = `/learn/api/public/v1/courses/${courseId}/users`;
const contentPath = `/learn/api/public/v1/courses/${courseId}/contents/${contentId}`;
const effectSecret = Buffer.alloc(32, 3).toString("base64url");

/** One mixed roster: the instructor who owns the course and one enrolled learner. */
const instructorMembership: JsonObject = {
  id: "_membership_2", courseId, userId: instructorId, courseRoleId: "Instructor", availability: { available: "Yes" },
  user: { id: instructorId, name: { given: "Ada", family: "Byron" }, contact: { email: "ada.byron@example.edu" }, userName: "ada.byron" },
};
const studentMembership: JsonObject = {
  id: "_membership_3", courseId, userId: studentId, courseRoleId: "Student", availability: { available: "Yes" },
  user: { id: studentId, name: { given: "Jane", family: "Doe" }, contact: { email: "jane.doe@example.edu" }, userName: "jane.doe" },
};

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

function problemMessage(result: JsonObject): string {
  return isJsonObject(result.problem) && typeof result.problem.message === "string" ? result.problem.message : "";
}

function grantArguments(planDigest: string, receipt: string): JsonObject {
  const unsigned = {
    schema: "morrow.blackboard.effect-grant.v1" as const,
    operationId: "op:blackboard-privacy",
    planDigest,
    outerPlanDigest: "a".repeat(64),
    approvalGrantDigest: "b".repeat(64),
    effectReceiptId: receipt,
    dispatchAttempt: 1,
    gatewayProcessId: "gateway:privacy",
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

async function harness(options: {
  readonly memberships?: readonly JsonObject[];
  /** Answer every roster page with another page, the way a roster larger than the ceiling reads. */
  readonly rosterPageCeiling?: boolean;
  readonly course?: JsonObject;
  readonly content?: JsonObject;
} = {}) {
  let patchCount = 0;
  let rosterRequests = 0;
  let courseReadCount = 0;
  const course: JsonObject = options.course || {
    id: courseId,
    courseId: "BIO-101",
    name: "Biology with Ada Byron",
    description: "Jane Doe and Ada Byron keep the syllabus. Reach Jane Doe at jane.doe@example.edu.",
  };
  let content: JsonObject = options.content || {
    id: contentId, courseId, contentHandler: { id: "resource/x-bb-document" },
    title: "Welcome from Ada Byron",
    description: "Jane Doe posts her questions here.",
    body: "Ada Byron and Jane Doe both replied.",
    availability: { available: "Yes" },
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://fixture");
    const pathname = url.pathname;
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      json(response, { access_token: "temporary-token", expires_in: 3600 }); return;
    }
    if (pathname === "/learn/api/public/v1/users/me") { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/users/${principalId}`) { json(response, { id: principalId }); return; }
    if (pathname === `${rosterPath}/${principalId}`) {
      json(response, { id: "_membership_1", courseId, userId: principalId }); return;
    }
    if (pathname === rosterPath) {
      rosterRequests += 1;
      if (options.rosterPageCeiling) {
        const offset = Number(url.searchParams.get("offset") || 0);
        const userId = `_${100 + offset}_1`;
        json(response, {
          results: [{
            id: `_membership_page_${offset}`, courseId, userId, courseRoleId: "Student", availability: { available: "Yes" },
            user: { id: userId, name: { given: "Page", family: `Learner${offset}` } },
          }],
          paging: { nextPage: `${rosterPath}?limit=100&expand=user&offset=${offset + 1}` },
        });
        return;
      }
      json(response, { results: options.memberships || [instructorMembership, studentMembership], paging: {} }); return;
    }
    if (pathname === `/learn/api/public/v3/courses/${courseId}`) {
      if (url.searchParams.get("fields")?.includes("description")) {
        courseReadCount += 1;
        json(response, course); return;
      }
      json(response, { id: courseId, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false }); return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/contents`) {
      json(response, { results: [content], paging: {} }); return;
    }
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
    courseBindings: [{ sourceBindingId: binding, courseId }],
  };
  const runtime = new BlackboardLearnRuntime([tenant], { effectDispatchSecret: effectSecret });
  const client = new Client({ name: "blackboard-privacy", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
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
    counts: () => ({ patchCount, rosterRequests, courseReadCount }),
    read: async () => structured(await client.callTool({ name: "blackboard_read_course", arguments: scope })),
    listContents: async () => structured(await client.callTool({ name: "blackboard_list_course_contents", arguments: scope })),
    roster: async () => structured(await client.callTool({ name: "blackboard_course_roster_summary", arguments: scope })),
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

describe("Blackboard privacy boundary", () => {
  it("refuses a course read when the roster stops at the page ceiling, and changes nothing on the write path", async () => {
    const fixture = await harness({ rosterPageCeiling: true });
    const read = await fixture.read();
    expect(read).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_response_incomplete" },
    });
    expect(problemMessage(read)).toContain("did not build a complete learner roster");
    expect(problemMessage(read)).toContain("exceeded the safe limit");
    // The refusal replaces the result: no course text and no withheld marker.
    expect(read.course).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain("Withheld");
    expect(fixture.counts()).toMatchObject({ courseReadCount: 0, rosterRequests: 20 });

    const plan = await fixture.plan({ title: "Reviewed title" });
    expect(plan).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_response_incomplete" } });
    expect(problemMessage(plan)).toContain("changed nothing in it");
    expect(fixture.counts().patchCount).toBe(0);
  });

  it("refuses a course read when a membership has no expanded user, and names that condition", async () => {
    const missing = await harness({
      memberships: [instructorMembership, { id: "_membership_4", courseId, userId: studentId, courseRoleId: "Student" }],
    });
    const read = await missing.read();
    expect(read).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_response_incomplete" },
    });
    expect(problemMessage(read)).toContain("Of 2 course memberships Blackboard returned, 1 came back with no expanded user record");
    expect(problemMessage(read)).toContain("disabled or deleted account");
    // The instructor on the same roster is not named by the refusal.
    expect(JSON.stringify(read)).not.toContain("Ada");
    expect(missing.counts().courseReadCount).toBe(0);
    await close?.(); close = undefined;

    const mismatched = await harness({
      memberships: [{ ...studentMembership, user: { ...(studentMembership.user as JsonObject), id: instructorId } }],
    });
    const mismatch = await mismatched.read();
    expect(mismatch).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_response_incomplete" } });
    expect(problemMessage(mismatch)).toContain("came back with an expanded user record for a different account");
    expect(mismatched.counts().courseReadCount).toBe(0);
  });

  it("refuses the whole result when redaction fails instead of withholding one field", async () => {
    const fixture = await harness({
      course: {
        id: courseId,
        courseId: "BIO-101",
        name: "Biology",
        description: "Ask the registrar at registrar@example.edu before the term starts.",
      },
    });
    const read = await fixture.read();
    expect(read).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_response_incomplete" },
    });
    expect(problemMessage(read)).toContain("could not remove every learner identity from the Blackboard course description");
    expect(problemMessage(read)).toContain("privacy_sensitive_text_refused");
    const serialized = JSON.stringify(read);
    expect(serialized).not.toContain("registrar@example.edu");
    expect(serialized).not.toContain("descriptionWithheld");
    expect(fixture.counts().courseReadCount).toBe(1);
  });

  it("tokenizes a mixed instructor and student roster with no name or e-mail address in the result", async () => {
    const fixture = await harness();
    const read = await fixture.read();
    const contents = await fixture.listContents();
    const roster = await fixture.roster();
    for (const result of [read, contents, roster]) {
      const serialized = JSON.stringify(result);
      expect(result).toMatchObject({ ok: true, status: "api_configured_live_untested" });
      for (const identity of ["Ada", "Byron", "Jane", "Doe", "@example.edu", "ada.byron", "jane.doe"]) {
        expect(serialized).not.toContain(identity);
      }
    }
    expect(JSON.stringify(read)).toContain("learner_");
    expect(JSON.stringify(contents)).toContain("learner_");
    expect(read).toMatchObject({ course: { id: courseId, courseId: "BIO-101" } });
    const learners = Array.isArray(roster.learners) ? roster.learners : [];
    expect(roster.count).toBe(2);
    expect(learners.map((learner) => (isJsonObject(learner) ? learner.courseRoleId : undefined))).toEqual(["Instructor", "Student"]);
    const tokens = learners.map((learner) => (isJsonObject(learner) && typeof learner.learnerToken === "string" ? learner.learnerToken : ""));
    expect(tokens.every((token) => /^learner_[0-9a-f-]{36}$/.test(token))).toBe(true);
    expect(new Set(tokens).size).toBe(2);
  });

  it("reports a readback it cannot redact as applied or unknown, never as not sent", async () => {
    const fixture = await harness();
    // Reviewed course text that names an address no one on this roster holds.
    const patch = { description: "Ask the registrar at registrar@example.edu." };
    const plan = await fixture.plan(patch);
    expect(plan).toMatchObject({ ok: true, reviewRequired: true });
    const applied = await fixture.apply(patch, String(plan.planDigest), "effect:00000000-0000-4000-8000-000000000011");
    expect(applied).toMatchObject({
      ok: false,
      // The PATCH left Morrow, so this refusal states what reached Blackboard.
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_response_incomplete" },
    });
    expect(problemMessage(applied)).toContain("could not remove every learner identity from the Blackboard content description");
    expect(JSON.stringify(applied)).not.toContain("registrar@example.edu");
    expect(fixture.counts().patchCount).toBe(1);
  });

  it("leaves a field Blackboard did not return absent and marks only a non-text value withheld", async () => {
    const absent = await harness({ course: { id: courseId, courseId: "BIO-101", name: "Biology", description: null } });
    const withoutDescription = await absent.read();
    expect(withoutDescription).toMatchObject({ ok: true, course: { id: courseId, name: "Biology" } });
    expect(isJsonObject(withoutDescription.course) ? withoutDescription.course : {}).not.toHaveProperty("description");
    expect(JSON.stringify(withoutDescription)).not.toContain("descriptionWithheld");
    await close?.(); close = undefined;

    const structuredValue = await harness({
      course: { id: courseId, courseId: "BIO-101", name: "Biology", description: { text: "Structured description" } },
    });
    const withheld = await structuredValue.read();
    expect(withheld).toMatchObject({ ok: true, course: { id: courseId, name: "Biology", descriptionWithheld: true } });
    expect(isJsonObject(withheld.course) ? withheld.course : {}).not.toHaveProperty("description");
  });
});
