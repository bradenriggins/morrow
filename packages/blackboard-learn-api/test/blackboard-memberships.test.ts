import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { signBlackboardEffectGrant, type BlackboardEffectGrant } from "../src/effect-grant.js";
import { BlackboardLearnRuntime } from "../src/runtime.js";
import { createBlackboardLearnMcpServer } from "../src/server.js";
import type { BlackboardTenant } from "../src/types.js";

const courseId = "_22_1";
const principalId = "_11_1";
const studentId = "_44_1";
/** A second enrolled person, so a dispatch can name someone the plan did not. */
const guestId = "_45_1";
const effectSecret = Buffer.alloc(32, 7).toString("base64url");
const rosterPath = `/learn/api/public/v1/courses/${courseId}/users`;
const studentPath = `${rosterPath}/${studentId}`;
const guestPath = `${rosterPath}/${guestId}`;
const accountPath = `/learn/api/public/v1/users/${principalId}`;

/** The one reviewed change: a new course role and a membership made unavailable. */
const patch = { courseRoleId: "Grader", availability: { available: "No" } };

/** The learner name and address that must never leave this server. */
const studentName = "Jane Doe";
const studentEmail = "jane.doe@example.edu";

function membershipRecord(overrides: JsonObject = {}): JsonObject {
  return {
    id: "_m11_1",
    courseId,
    userId: studentId,
    courseRoleId: "Student",
    availability: { available: "Yes" },
    dataSourceId: "_2_1",
    // A tenant may answer this route with the account expanded. Nothing from it
    // may leave Morrow.
    user: { id: studentId, name: { given: "Jane", family: "Doe" }, contact: { email: studentEmail }, userName: "jane.doe" },
    ...overrides,
  };
}

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

function summary(result: unknown): string {
  const content = isJsonObject(result) && Array.isArray(result.content) ? result.content[0] : undefined;
  return isJsonObject(content) && typeof content.text === "string" ? content.text : "";
}

function rows(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value) || value.some((entry) => !isJsonObject(entry))) {
    throw new Error("The Blackboard result did not carry a list of records.");
  }
  return value as readonly JsonObject[];
}

function problem(value: JsonObject): JsonObject {
  return isJsonObject(value.problem) ? value.problem : {};
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

interface FixtureOptions {
  /** Enrol the same person twice, as two membership records of one course. */
  readonly duplicateMembership?: boolean;
  /** Change the course role after the first membership read, as someone else would. */
  readonly roleBetweenReads?: boolean;
  /** Answer the PATCH, and save none of it, as a site that did not apply the change. */
  readonly ignorePatch?: boolean;
}

async function harness(options: FixtureOptions = {}) {
  const requests: string[] = [];
  const patches: JsonObject[] = [];
  let membership = membershipRecord();
  let membershipReads = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "http://fixture").pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname === "/learn/api/public/v1/oauth2/token") { json(response, { access_token: "temporary-token", expires_in: 3600 }); return; }
    if (pathname === "/learn/api/public/v1/users/me") { json(response, { id: principalId }); return; }
    if (pathname === accountPath) {
      json(response, {
        id: principalId,
        availability: { available: "Yes" },
        name: { given: "Ada", family: "Byron" },
        contact: { email: "ada.byron@example.edu" },
        userName: "ada.byron",
      });
      return;
    }
    if (pathname === `${rosterPath}/${principalId}`) { json(response, { id: "_m10_1", courseId, userId: principalId }); return; }
    if (pathname === rosterPath) {
      json(response, {
        results: [
          {
            id: "_m10_1", courseId, userId: principalId, courseRoleId: "Instructor", availability: { available: "Yes" },
            user: { id: principalId, name: { given: "Ada", family: "Byron" }, contact: { email: "ada.byron@example.edu" }, userName: "ada.byron" },
          },
          {
            id: "_m11_1", courseId, userId: studentId, courseRoleId: membership.courseRoleId, availability: membership.availability,
            user: { id: studentId, name: { given: "Jane", family: "Doe" }, contact: { email: studentEmail }, userName: "jane.doe" },
          },
          {
            id: "_m13_1", courseId, userId: guestId, courseRoleId: "Guest", availability: { available: "Yes" },
            user: { id: guestId, name: { given: "Sam", family: "Rivers" }, contact: { email: "sam.rivers@example.edu" }, userName: "sam.rivers" },
          },
          ...(options.duplicateMembership ? [{
            id: "_m12_1", courseId, userId: studentId, courseRoleId: "Grader", availability: { available: "Yes" },
            user: { id: studentId, name: { given: "Jane", family: "Doe" }, contact: { email: studentEmail }, userName: "jane.doe" },
          }] : []),
        ],
        paging: {},
      });
      return;
    }
    if (pathname === `/learn/api/public/v3/courses/${courseId}`) {
      json(response, { id: courseId, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false });
      return;
    }
    if (pathname === studentPath && request.method === "PATCH") {
      void body(request).then((raw) => {
        const requested = JSON.parse(raw) as JsonObject;
        patches.push(requested);
        if (!options.ignorePatch) membership = { ...membership, ...requested };
        json(response, membership);
      });
      return;
    }
    if (pathname === guestPath) {
      json(response, { id: "_m13_1", courseId, userId: guestId, courseRoleId: "Guest", availability: { available: "Yes" } });
      return;
    }
    if (pathname === studentPath) {
      json(response, membership);
      membershipReads += 1;
      // Someone else changes this person's course role after Morrow froze the plan.
      if (options.roleBetweenReads && membershipReads === 1) membership = { ...membership, courseRoleId: "Instructor" };
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
  const client = new Client({ name: "blackboard-memberships", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const running = serveStdio(() => createBlackboardLearnMcpServer(runtime, { includePrivateDispatch: true }), { transport: right });
  await client.connect(left);
  close = async () => {
    await client.close();
    await running.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const scope = { tenant_id: "fixture", source_binding_id: binding, course_id: courseId };
  // A dispatch must carry the exact connection scope frozen by its own source
  // plan. This fixture retains that scope by digest; it never asks the runtime
  // for a newer session while it builds an apply request.
  const reviewedPlans = new Map<string, { readonly effectScope: JsonObject; readonly expectedConnection: JsonObject }>();
  const call = async (name: string, args: JsonObject = {}) => {
    const planDigest = args.expected_plan_digest;
    const reviewed = typeof planDigest === "string" ? reviewedPlans.get(planDigest) : undefined;
    const request = name.startsWith("blackboard_apply_reviewed_") && reviewed && args.expected_connection === undefined
      ? { ...scope, ...args, expected_connection: reviewed.expectedConnection }
      : { ...scope, ...args };
    const result = await client.callTool({ name, arguments: request });
    const content = isJsonObject(result) && isJsonObject(result.structuredContent) ? result.structuredContent : null;
    const effectScope = content && isJsonObject(content.effect_scope) ? content.effect_scope : null;
    if (content && typeof content.planDigest === "string" && effectScope
      && typeof effectScope.principalFingerprint === "string" && /^[0-9a-f]{64}$/.test(effectScope.principalFingerprint)
      && typeof effectScope.sessionGeneration === "number" && Number.isInteger(effectScope.sessionGeneration) && effectScope.sessionGeneration >= 1) {
      const expectedConnection = Object.freeze({
        principal_fingerprint: effectScope.principalFingerprint,
        session_generation: effectScope.sessionGeneration,
      });
      reviewedPlans.set(content.planDigest, Object.freeze({ effectScope: Object.freeze({ ...effectScope }), expectedConnection }));
    }
    return result;
  };
  return {
    requests: () => [...requests],
    patchRequests: () => requests.filter((entry) => entry.startsWith("PATCH ")),
    patchBodies: () => [...patches],
    saved: () => ({ ...membership }),
    call,
  };
}

type Fixture = Awaited<ReturnType<typeof harness>>;

/** The protected reference the roster read returns for the person in this course role. */
async function referenceFor(fixture: Fixture, courseRoleId: string): Promise<string> {
  const roster = structured(await fixture.call("blackboard_course_roster_summary"));
  const person = rows(roster.learners).find((entry) => entry.courseRoleId === courseRoleId);
  if (!person || typeof person.learnerToken !== "string") {
    throw new Error(`the Blackboard roster read returned no ${courseRoleId} reference: ${JSON.stringify(roster)}`);
  }
  return person.learnerToken;
}

function studentReference(fixture: Fixture): Promise<string> {
  return referenceFor(fixture, "Student");
}

let receipts = 0;

function effectGrant(planDigest: string): BlackboardEffectGrant {
  receipts += 1;
  const unsigned = {
    schema: "morrow.blackboard.effect-grant.v1" as const,
    operationId: "op:blackboard-memberships-test",
    planDigest,
    outerPlanDigest: "b".repeat(64),
    approvalGrantDigest: "c".repeat(64),
    effectReceiptId: `effect:00000000-0000-4000-8000-${String(receipts).padStart(12, "0")}`,
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

/** One approved dispatch of the reviewed membership change, as the Gateway sends it. */
function applyArguments(reference: string, planDigest: string, grant = grantArguments(effectGrant(planDigest))): JsonObject {
  return {
    learner_reference: reference,
    patch,
    expected_plan_digest: planDigest,
    _morrow: { outer_grant: grant },
  };
}

async function planDigestOf(fixture: Fixture, reference: string): Promise<string> {
  const plan = structured(await fixture.call("blackboard_plan_membership_patch", { learner_reference: reference, patch }));
  if (plan.ok !== true || typeof plan.planDigest !== "string") {
    throw new Error(`the Blackboard membership plan was refused: ${JSON.stringify(plan)}`);
  }
  return plan.planDigest;
}

describe("Blackboard memberships and users", () => {
  it("refuses a Blackboard user id in place of a protected learner reference, and sends nothing", async () => {
    const fixture = await harness();
    const addressed: readonly JsonObject[] = [
      { name: "blackboard_read_course_membership", arguments: { learner_reference: studentId } },
      { name: "blackboard_plan_membership_patch", arguments: { learner_reference: studentId, patch } },
    ];
    for (const { name, arguments: args } of addressed as readonly { name: string; arguments: JsonObject }[]) {
      const refused = structured(await fixture.call(name, args));
      expect(refused, name).toMatchObject({
        ok: false,
        resultState: "not_sent",
        problem: { code: "blackboard_scope_binding_required" },
      });
      expect(String(problem(refused).message)).toContain("does not accept a Blackboard user id");
    }
    // A request Morrow cannot honour costs the tenant no request at all.
    expect(fixture.requests()).toEqual([]);
  });

  it("refuses a reference this server did not mint for this course, and sends nothing", async () => {
    const fixture = await harness();
    const refused = structured(await fixture.call("blackboard_read_course_membership", {
      learner_reference: "learner_2f1a5b3c-9d4e-4f6a-8b7c-1d2e3f4a5b6c",
    }));
    expect(refused).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_scope_binding_required" } });
    expect(String(problem(refused).message)).toContain("does not hold this protected learner reference");
    expect(fixture.requests()).toEqual([]);
  });

  it("resolves one protected reference to exactly one membership, and returns no learner identity", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const result = await fixture.call("blackboard_read_course_membership", { learner_reference: reference });
    expect(structured(result)).toMatchObject({
      schema: "morrow.blackboard.course-membership.v1",
      ok: true,
      courseId,
      membership: { learnerToken: reference, courseRoleId: "Student", availability: "Yes" },
      status: "api_configured_live_untested",
    });
    // The one membership route was read for the account the reference names.
    expect(fixture.requests()).toContain(`GET ${studentPath}`);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(studentName);
    expect(serialized).not.toContain(studentEmail);
    expect(serialized).not.toContain(studentId);
    expect(summary(result)).toBe("Morrow read one person's membership of the selected Blackboard course.");
  });

  it("refuses when one person holds more than one membership of the course", async () => {
    const fixture = await harness({ duplicateMembership: true });
    const reference = await studentReference(fixture);
    const refused = structured(await fixture.call("blackboard_read_course_membership", { learner_reference: reference }));
    expect(refused).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_membership_mismatch" } });
    expect(String(problem(refused).message)).toContain("more than one membership");
  });

  it("reads the account this connection acts as, with no name and no contact details", async () => {
    const fixture = await harness();
    const result = await fixture.call("blackboard_read_integration_account");
    expect(structured(result)).toMatchObject({
      schema: "morrow.blackboard.integration-account.v1",
      ok: true,
      courseId,
      account: { id: principalId, availability: "Yes" },
      status: "api_configured_live_untested",
    });
    expect(fixture.requests()).toContain(`GET ${accountPath}`);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Ada Byron");
    expect(serialized).not.toContain("ada.byron@example.edu");
  });

  it("plans one membership change, freezes the precondition, and sends no PATCH", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const plan = structured(await fixture.call("blackboard_plan_membership_patch", { learner_reference: reference, patch }));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.membership-patch.plan.v1",
      ok: true,
      courseId,
      before: { learnerToken: reference, courseRoleId: "Student", availability: "Yes" },
      patch,
      reviewRequired: true,
      limits: { fields: ["courseRoleId", "availability.available"], memberships: 1 },
      readback: "protected_fields",
      status: "api_configured_live_untested",
    });
    expect(String(plan.planDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(plan.beforeDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.effect_scope).toMatchObject({ provider: "blackboard", sourceBindingId: expect.any(String) });
    expect(fixture.patchRequests()).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(studentName);
    expect(summary(await fixture.call("blackboard_plan_membership_patch", { learner_reference: reference, patch })))
      .toBe("Morrow prepared one Blackboard course membership change for review. Nothing in the course was changed.");
  });

  it("sends exactly one PATCH after a fresh precondition, and reads the saved role and availability back", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const planDigest = await planDigestOf(fixture, reference);
    const result = await fixture.call("blackboard_apply_reviewed_membership_patch", applyArguments(reference, planDigest));
    expect(structured(result)).toMatchObject({
      schema: "morrow.blackboard.membership-patch.readback.v1",
      ok: true,
      resultState: "applied",
      courseId,
      membership: { learnerToken: reference, courseRoleId: "Grader", availability: "No" },
      readback: "protected_fields",
      status: "api_configured_live_untested",
    });
    expect(fixture.patchRequests()).toEqual([`PATCH ${studentPath}`]);
    expect(fixture.patchBodies()).toEqual([patch]);
    expect(fixture.saved()).toMatchObject({ courseRoleId: "Grader", availability: { available: "No" } });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(studentName);
    expect(serialized).not.toContain(studentId);

    // The comparator re-reads the same membership and compares the saved values.
    const verified = structured(await fixture.call("blackboard_verify_membership_patch", { learner_reference: reference, patch }));
    expect(verified).toMatchObject({
      schema: "morrow.blackboard.membership-patch.comparator.v1",
      ok: true,
      learnerToken: reference,
      verified: true,
    });
    expect(verified).not.toHaveProperty("diagnostics");
  });

  it("refuses a course role changed between the plan and the dispatch, and sends no PATCH", async () => {
    const fixture = await harness({ roleBetweenReads: true });
    const reference = await studentReference(fixture);
    const planDigest = await planDigestOf(fixture, reference);
    const refused = structured(await fixture.call("blackboard_apply_reviewed_membership_patch", applyArguments(reference, planDigest)));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: {
        code: "blackboard_content_mismatch",
        message: "The Blackboard membership Morrow read does not match the reviewed plan. It changed after review, or this request names a different person. The change was not sent.",
      },
    });
    expect(fixture.patchRequests()).toEqual([]);
  });

  it("refuses a dispatch that names another person than the reviewed plan, and sends no PATCH", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const other = await referenceFor(fixture, "Guest");
    const planDigest = await planDigestOf(fixture, reference);
    const refused = structured(await fixture.call("blackboard_apply_reviewed_membership_patch", applyArguments(other, planDigest)));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(String(problem(refused).message)).toContain("names a different person");
    expect(fixture.patchRequests()).toEqual([]);
  });

  it("sends nothing for a replayed grant", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const planDigest = await planDigestOf(fixture, reference);
    const grant = grantArguments(effectGrant(planDigest));
    expect(structured(await fixture.call("blackboard_apply_reviewed_membership_patch", applyArguments(reference, planDigest, grant))).ok).toBe(true);
    const sent = fixture.patchRequests();

    const replay = structured(await fixture.call("blackboard_apply_reviewed_membership_patch", applyArguments(reference, planDigest, grant)));
    expect(replay).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_patch_review_required", message: "This Blackboard effect grant was already dispatched, and Morrow sent that change to Blackboard. It sent nothing now." },
    });
    expect(fixture.patchRequests()).toEqual(sent);
  });

  it("reports applied_or_unknown when the saved membership is not the reviewed one", async () => {
    const fixture = await harness({ ignorePatch: true });
    const reference = await studentReference(fixture);
    const planDigest = await planDigestOf(fixture, reference);
    const result = structured(await fixture.call("blackboard_apply_reviewed_membership_patch", applyArguments(reference, planDigest)));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: {
        code: "blackboard_content_mismatch",
        message: "Blackboard did not return every reviewed and protected membership value after the change.",
      },
    });
    expect(fixture.patchRequests()).toEqual([`PATCH ${studentPath}`]);

    const unresolved = structured(await fixture.call("blackboard_unresolved_effects"));
    expect(unresolved).toMatchObject({
      ok: true,
      count: 1,
      effects: [{
        operationId: "op:blackboard-memberships-test",
        phase: "uncertain",
        tenantId: "fixture",
        courseId,
        targetType: "course-membership",
      }],
    });
    expect(JSON.stringify(unresolved)).not.toContain(studentId);

    const blocked = structured(await fixture.call("blackboard_plan_membership_patch", {
      learner_reference: reference,
      patch,
    }));
    expect(blocked).toMatchObject({
      ok: false,
      problem: { code: "blackboard_effect_unresolved" },
    });

    const verified = structured(await fixture.call("blackboard_verify_membership_patch", { learner_reference: reference, patch }));
    expect(verified).toMatchObject({ ok: true, verified: false });
    expect(structured(await fixture.call("blackboard_unresolved_effects"))).toMatchObject({ ok: true, count: 0, effects: [] });
  });

  it("refuses a change to anything but the course role and availability, before any request", async () => {
    const fixture = await harness();
    const unsupported: readonly JsonObject[] = [
      {},
      { dataSourceId: "_2_1" },
      { availability: { available: "Disabled" } },
      { courseRoleId: "Grader with a space" },
    ];
    for (const candidate of unsupported) {
      const refused = structured(await fixture.call("blackboard_plan_membership_patch", {
        learner_reference: "learner_2f1a5b3c-9d4e-4f6a-8b7c-1d2e3f4a5b6c",
        patch: candidate,
      }));
      expect(refused, JSON.stringify(candidate)).toMatchObject({
        ok: false,
        resultState: "not_sent",
        problem: { code: "blackboard_response_invalid" },
      });
    }
    expect(fixture.requests()).toEqual([]);
  });
});
