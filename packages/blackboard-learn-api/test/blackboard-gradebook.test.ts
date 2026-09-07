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
/** A person the course roster does not hold, as a withdrawn account leaves behind. */
const strangerId = "_99_1";
const columnId = "_88_1";
const effectSecret = Buffer.alloc(32, 7).toString("base64url");

const rosterPath = `/learn/api/public/v1/courses/${courseId}/users`;
const columnsPath = `/learn/api/public/v2/courses/${courseId}/gradebook/columns`;
const columnPath = `${columnsPath}/${columnId}`;
const attemptsPath = `${columnPath}/attempts`;
const gradePath = `${columnPath}/users/${studentId}`;
const guestGradePath = `${columnPath}/users/${guestId}`;

/** The one reviewed column change: a new name, new points, and a new due date. */
const columnPatch = { name: "Essay one", score: { possible: 20 }, grading: { due: "2026-10-07T23:59:00Z" } };
/** The same due date as Morrow sends it: one exact instant. */
const sentDue = "2026-10-07T23:59:00.000Z";
/** The one reviewed grade change. */
const gradePatch = { score: 18, text: "18" };

/** The learner identity and work that must never leave this server. */
const studentName = "Jane Doe";
const studentEmail = "jane.doe@example.edu";
const submission = "My essay, by Jane Doe.";
const feedback = "Good work, Jane.";
const notes = "Extension agreed by e-mail.";

function column(): JsonObject {
  return {
    id: columnId,
    externalId: "essay-1",
    contentId: "_33_1",
    externalGrade: true,
    name: "Essay 1",
    description: "The first essay.",
    score: { possible: 10, decimalPlaces: 2 },
    availability: { available: "Yes" },
    grading: { type: "Attempts", due: "2026-09-30T23:59:00.000Z", attemptsAllowed: 2, schemaId: "_1_1", scoringModel: "Last" },
  };
}

function grade(): JsonObject {
  return {
    userId: studentId,
    columnId,
    status: "NeedsGrading",
    score: 8,
    text: "8",
    exempt: false,
    // A tenant may answer this route with the learner's work and the feedback on
    // it. Nothing from either may leave Morrow.
    feedback,
    notes,
    studentSubmission: submission,
  };
}

function attempt(id: string, userId: string, overrides: JsonObject = {}): JsonObject {
  return {
    id,
    userId,
    status: "NeedsGrading",
    score: 8,
    created: "2026-09-20T10:00:00.000Z",
    attemptDate: "2026-09-20T10:00:00.000Z",
    modified: "2026-09-21T08:30:00.000Z",
    exempt: false,
    studentSubmission: submission,
    studentComments: `Sorry this is late — ${studentEmail}`,
    feedback,
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

/** How a site that merges nested objects answers a PATCH of one of them. */
function merged(saved: JsonObject, requested: JsonObject): JsonObject {
  const output: JsonObject = { ...saved };
  for (const [key, value] of Object.entries(requested)) {
    const current = output[key];
    output[key] = isJsonObject(current) && isJsonObject(value) ? { ...current, ...value } : value;
  }
  return output;
}

interface FixtureOptions {
  /** Answer the first attempts page with a link outside this course endpoint. */
  readonly attemptsOffOrigin?: boolean;
  /** Someone else scores this person's work after Morrow froze the plan. */
  readonly scoreBetweenReads?: boolean;
  /** Answer the grade PATCH, and save none of it, as a site that did not apply the change. */
  readonly ignoreGradePatch?: boolean;
  /** Replace the whole `grading` object on a column PATCH instead of merging it. */
  readonly replaceGrading?: boolean;
}

async function harness(options: FixtureOptions = {}) {
  const requests: string[] = [];
  const patches: JsonObject[] = [];
  let savedColumn = column();
  let savedGrade = grade();
  let gradeReads = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://fixture");
    const pathname = url.pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname === "/learn/api/public/v1/oauth2/token") { json(response, { access_token: "temporary-token", expires_in: 3600 }); return; }
    if (pathname === "/learn/api/public/v1/users/me") { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/users/${principalId}`) { json(response, { id: principalId, availability: { available: "Yes" } }); return; }
    if (pathname === `${rosterPath}/${principalId}`) { json(response, { id: "_m10_1", courseId, userId: principalId }); return; }
    if (pathname === rosterPath) {
      json(response, {
        results: [
          {
            id: "_m10_1", courseId, userId: principalId, courseRoleId: "Instructor", availability: { available: "Yes" },
            user: { id: principalId, name: { given: "Ada", family: "Byron" }, contact: { email: "ada.byron@example.edu" }, userName: "ada.byron" },
          },
          {
            id: "_m11_1", courseId, userId: studentId, courseRoleId: "Student", availability: { available: "Yes" },
            user: { id: studentId, name: { given: "Jane", family: "Doe" }, contact: { email: studentEmail }, userName: "jane.doe" },
          },
          {
            id: "_m13_1", courseId, userId: guestId, courseRoleId: "Guest", availability: { available: "Yes" },
            user: { id: guestId, name: { given: "Sam", family: "Rivers" }, contact: { email: "sam.rivers@example.edu" }, userName: "sam.rivers" },
          },
        ],
        paging: {},
      });
      return;
    }
    if (pathname === `/learn/api/public/v3/courses/${courseId}`) {
      json(response, { id: courseId, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false });
      return;
    }
    if (pathname === attemptsPath) {
      // Two pages, so one read has to follow the shared bounded pagination to
      // return the column's attempts at all.
      if (url.searchParams.get("offset") === "1") {
        json(response, { results: [attempt("_502_1", guestId), attempt("_503_1", strangerId)], paging: {} });
        return;
      }
      json(response, {
        results: [attempt("_501_1", studentId)],
        paging: { nextPage: options.attemptsOffOrigin ? "https://elsewhere.invalid/attempts" : `${attemptsPath}?offset=1&limit=100` },
      });
      return;
    }
    if (pathname === `${attemptsPath}/_501_1`) { json(response, attempt("_501_1", studentId)); return; }
    if (pathname === `${attemptsPath}/_503_1`) { json(response, attempt("_503_1", strangerId)); return; }
    if (pathname === gradePath && request.method === "PATCH") {
      void body(request).then((raw) => {
        const requested = JSON.parse(raw) as JsonObject;
        patches.push(requested);
        if (!options.ignoreGradePatch) savedGrade = { ...savedGrade, ...requested, status: "Graded" };
        json(response, savedGrade);
      });
      return;
    }
    if (pathname === gradePath) {
      json(response, savedGrade);
      gradeReads += 1;
      // Someone else scores this person's work after Morrow froze the plan.
      if (options.scoreBetweenReads && gradeReads === 1) savedGrade = { ...savedGrade, score: 5, text: "5" };
      return;
    }
    if (pathname === guestGradePath) {
      json(response, { ...grade(), userId: guestId, score: 3, text: "3" });
      return;
    }
    if (pathname === columnPath && request.method === "PATCH") {
      void body(request).then((raw) => {
        const requested = JSON.parse(raw) as JsonObject;
        patches.push(requested);
        savedColumn = options.replaceGrading ? { ...savedColumn, ...requested } : merged(savedColumn, requested);
        json(response, savedColumn);
      });
      return;
    }
    if (pathname === columnPath) { json(response, savedColumn); return; }
    if (pathname === columnsPath) {
      json(response, { results: [savedColumn, { ...column(), id: "_89_1", name: "Participation", contentId: undefined }], paging: {} });
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
  const client = new Client({ name: "blackboard-gradebook", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
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
    savedGrade: () => ({ ...savedGrade }),
    savedColumn: () => ({ ...savedColumn }),
    call: (name: string, args: JsonObject = {}) => call(name, { ...args, column_id: columnId }),
    callScope: call,
  };
}

type Fixture = Awaited<ReturnType<typeof harness>>;

/** The protected reference the roster read returns for the person in this course role. */
async function referenceFor(fixture: Fixture, courseRoleId: string): Promise<string> {
  const roster = structured(await fixture.callScope("blackboard_course_roster_summary"));
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
    operationId: "op:blackboard-gradebook-test",
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

/** One approved dispatch, as the Gateway sends it. */
function applyArguments(patch: JsonObject, planDigest: string, extra: JsonObject = {}, grant = grantArguments(effectGrant(planDigest))): JsonObject {
  return { ...extra, patch, expected_plan_digest: planDigest, _morrow: { outer_grant: grant } };
}

async function planDigestOf(fixture: Fixture, tool: string, patch: JsonObject, extra: JsonObject = {}): Promise<string> {
  const plan = structured(await fixture.call(tool, { ...extra, patch }));
  if (plan.ok !== true || typeof plan.planDigest !== "string") {
    throw new Error(`the Blackboard plan was refused: ${JSON.stringify(plan)}`);
  }
  return plan.planDigest;
}

/** Nothing a Blackboard gradebook result carries may name a person or their work. */
function expectNoLearnerData(result: unknown, label: string): void {
  const serialized = JSON.stringify(result);
  for (const secret of [studentName, studentEmail, submission, feedback, notes, studentId, guestId]) {
    expect(serialized, `${label} carries ${secret}`).not.toContain(secret);
  }
}

describe("Blackboard gradebook columns and attempts", () => {
  it("lists the gradebook columns of the selected course, and returns no learner and no grade", async () => {
    const fixture = await harness();
    const result = await fixture.callScope("blackboard_list_gradebook_columns");
    const listed = structured(result);
    expect(listed).toMatchObject({
      schema: "morrow.blackboard.gradebook-columns.v1",
      ok: true,
      courseId,
      count: 2,
      status: "api_configured_live_untested",
    });
    expect(rows(listed.columns)[0]).toEqual({
      id: columnId,
      name: "Essay 1",
      description: "The first essay.",
      contentId: "_33_1",
      score: { possible: 10 },
      availability: { available: "Yes" },
      grading: { type: "Attempts", due: "2026-09-30T23:59:00.000Z" },
      externalGrade: true,
    });
    expect(fixture.requests()).toContain(`GET ${columnsPath}`);
    expectNoLearnerData(result, "the column list");
    expect(summary(result)).toBe("Morrow read the gradebook columns of the selected Blackboard course.");
  });

  it("reads one gradebook column", async () => {
    const fixture = await harness();
    const result = structured(await fixture.call("blackboard_read_gradebook_column"));
    expect(result).toMatchObject({
      schema: "morrow.blackboard.gradebook-column.v1",
      ok: true,
      columnId,
      column: { id: columnId, score: { possible: 10 }, grading: { due: "2026-09-30T23:59:00.000Z" } },
    });
    expect(fixture.requests()).toContain(`GET ${columnPath}`);
  });

  it("reads every attempt across the column's pages, names each person by a protected reference, and returns no submitted work", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const result = await fixture.call("blackboard_list_gradebook_attempts");
    const listed = structured(result);
    expect(listed).toMatchObject({
      schema: "morrow.blackboard.gradebook-attempts.v1",
      ok: true,
      columnId,
      // The second page was followed: one attempt on each page belongs to a
      // person this course's roster holds.
      count: 2,
      complete: false,
      status: "api_configured_live_untested",
    });
    expect(rows(listed.attempts)[0]).toEqual({
      id: "_501_1",
      learnerToken: reference,
      status: "NeedsGrading",
      score: 8,
      created: "2026-09-20T10:00:00.000Z",
      attemptDate: "2026-09-20T10:00:00.000Z",
      modified: "2026-09-21T08:30:00.000Z",
      exempt: false,
    });
    // The attempt Morrow could not name by a protected reference is named as
    // unread, not returned and not silently dropped from the count.
    expect(rows(listed.unread)).toEqual([{
      id: "_503_1",
      reason: "learner_unread",
      detail: "Blackboard returned this attempt for a person the selected course's roster does not hold exactly once, so Morrow left it out rather than name them another way.",
    }]);
    expectNoLearnerData(result, "the attempt list");
    expect(summary(result)).toBe("Morrow read part of the attempts in the selected Blackboard gradebook column. The result names every attempt it left out.");
  });

  it("refuses an attempt page from outside this exact course endpoint", async () => {
    const fixture = await harness({ attemptsOffOrigin: true });
    const refused = structured(await fixture.call("blackboard_list_gradebook_attempts"));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_pagination_refused" },
    });
    expect(String(problem(refused).message)).toContain("outside this exact course endpoint");
  });

  it("reads one attempt, and refuses one whose person the course roster does not hold", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const read = structured(await fixture.call("blackboard_read_gradebook_attempt", { attempt_id: "_501_1" }));
    expect(read).toMatchObject({
      schema: "morrow.blackboard.gradebook-attempt.v1",
      ok: true,
      attemptId: "_501_1",
      attempt: { id: "_501_1", learnerToken: reference, status: "NeedsGrading", score: 8 },
    });
    expectNoLearnerData(read, "the attempt read");

    const refused = structured(await fixture.call("blackboard_read_gradebook_attempt", { attempt_id: "_503_1" }));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_membership_mismatch" },
    });
  });

  it("reads one person's grade, and returns no feedback, no notes, and no submitted work", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const result = await fixture.call("blackboard_read_gradebook_grade", { learner_reference: reference });
    expect(structured(result)).toMatchObject({
      schema: "morrow.blackboard.gradebook-grade.v1",
      ok: true,
      columnId,
      grade: { learnerToken: reference, score: 8, text: "8", status: "NeedsGrading", exempt: false },
    });
    expect(fixture.requests()).toContain(`GET ${gradePath}`);
    expectNoLearnerData(result, "the grade read");
    expect(summary(result)).toBe("Morrow read one person's grade in the selected Blackboard gradebook column.");
  });

  it("refuses a Blackboard user id in place of a protected learner reference, and sends nothing", async () => {
    const fixture = await harness();
    const addressed: readonly { name: string; arguments: JsonObject }[] = [
      { name: "blackboard_read_gradebook_grade", arguments: { learner_reference: studentId } },
      { name: "blackboard_plan_gradebook_grade_patch", arguments: { learner_reference: studentId, patch: gradePatch } },
    ];
    for (const { name, arguments: args } of addressed) {
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

  it("plans one column change, freezes the precondition, and sends no PATCH", async () => {
    const fixture = await harness();
    const plan = structured(await fixture.call("blackboard_plan_gradebook_column_patch", { patch: columnPatch }));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.gradebook-column-patch.plan.v1",
      ok: true,
      columnId,
      before: { id: columnId, name: "Essay 1", score: { possible: 10 }, grading: { due: "2026-09-30T23:59:00.000Z" } },
      // The due date is frozen and sent as one exact instant.
      patch: { name: "Essay one", score: { possible: 20 }, grading: { due: sentDue } },
      reviewRequired: true,
      limits: { fields: ["name", "description", "score.possible", "availability.available", "grading.due"], columns: 1 },
      readback: "protected_fields",
      status: "api_configured_live_untested",
    });
    expect(String(plan.planDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(plan.beforeDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.effect_scope).toMatchObject({ provider: "blackboard", sourceBindingId: expect.any(String) });
    expect(fixture.patchRequests()).toEqual([]);
    expect(summary(await fixture.call("blackboard_plan_gradebook_column_patch", { patch: columnPatch })))
      .toBe("Morrow prepared one Blackboard gradebook column change for review. Nothing in the course was changed.");
  });

  it("freezes a due date written with an offset as the same exact instant", async () => {
    const fixture = await harness();
    const offset = { grading: { due: "2026-10-07T19:59:00-04:00" } };
    const plan = structured(await fixture.call("blackboard_plan_gradebook_column_patch", { patch: offset }));
    expect(plan).toMatchObject({ ok: true, patch: { grading: { due: sentDue } } });
  });

  it("sends exactly one PATCH for a reviewed column change, and reads the saved column back", async () => {
    const fixture = await harness();
    const planDigest = await planDigestOf(fixture, "blackboard_plan_gradebook_column_patch", columnPatch);
    const result = structured(await fixture.call("blackboard_apply_reviewed_gradebook_column_patch", applyArguments(columnPatch, planDigest)));
    expect(result).toMatchObject({
      schema: "morrow.blackboard.gradebook-column-patch.readback.v1",
      ok: true,
      resultState: "applied",
      columnId,
      column: { name: "Essay one", score: { possible: 20 }, grading: { type: "Attempts", due: sentDue } },
      readback: "protected_fields",
    });
    expect(fixture.patchRequests()).toEqual([`PATCH ${columnPath}`]);
    expect(fixture.patchBodies()).toEqual([{ name: "Essay one", score: { possible: 20 }, grading: { due: sentDue } }]);
    expect(fixture.savedColumn()).toMatchObject({ name: "Essay one", score: { possible: 20, decimalPlaces: 2 } });

    const verified = structured(await fixture.call("blackboard_verify_gradebook_column_patch", { patch: columnPatch }));
    expect(verified).toMatchObject({
      schema: "morrow.blackboard.gradebook-column-patch.comparator.v1",
      ok: true,
      columnId,
      verified: true,
    });
    expect(verified).not.toHaveProperty("diagnostics");
  });

  it("reports applied_or_unknown when the site clears a grading value the change did not set", async () => {
    const fixture = await harness({ replaceGrading: true });
    const planDigest = await planDigestOf(fixture, "blackboard_plan_gradebook_column_patch", columnPatch);
    const result = structured(await fixture.call("blackboard_apply_reviewed_gradebook_column_patch", applyArguments(columnPatch, planDigest)));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: {
        code: "blackboard_content_mismatch",
        message: "Blackboard did not return every reviewed and protected gradebook column value after the change.",
      },
    });
    expect(fixture.patchRequests()).toEqual([`PATCH ${columnPath}`]);
  });

  it("plans one grade change, freezes the precondition, and sends no PATCH", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const plan = structured(await fixture.call("blackboard_plan_gradebook_grade_patch", { learner_reference: reference, patch: gradePatch }));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.gradebook-grade-patch.plan.v1",
      ok: true,
      columnId,
      before: { learnerToken: reference, score: 8, text: "8", status: "NeedsGrading", exempt: false },
      patch: gradePatch,
      reviewRequired: true,
      limits: { fields: ["score", "text"], grades: 1 },
      readback: "reviewed_fields",
    });
    expect(String(plan.planDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.patchRequests()).toEqual([]);
    expectNoLearnerData(plan, "the grade plan");
  });

  it("sends exactly one PATCH for a reviewed grade change, and reads the saved score back", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const planDigest = await planDigestOf(fixture, "blackboard_plan_gradebook_grade_patch", gradePatch, { learner_reference: reference });
    const result = await fixture.call(
      "blackboard_apply_reviewed_gradebook_grade_patch",
      applyArguments(gradePatch, planDigest, { learner_reference: reference }),
    );
    expect(structured(result)).toMatchObject({
      schema: "morrow.blackboard.gradebook-grade-patch.readback.v1",
      ok: true,
      resultState: "applied",
      columnId,
      // Blackboard set the status itself when it saved the score. Morrow reports
      // that and does not fail on it.
      grade: { learnerToken: reference, score: 18, text: "18", status: "Graded" },
      readback: "reviewed_fields",
    });
    // One approved grade change sends one PATCH request.
    expect(fixture.patchRequests()).toEqual([`PATCH ${gradePath}`]);
    expect(fixture.patchBodies()).toEqual([gradePatch]);
    expect(fixture.savedGrade()).toMatchObject({ score: 18, text: "18" });
    expectNoLearnerData(result, "the grade readback");

    const verified = structured(await fixture.call("blackboard_verify_gradebook_grade_patch", { learner_reference: reference, patch: gradePatch }));
    expect(verified).toMatchObject({
      schema: "morrow.blackboard.gradebook-grade-patch.comparator.v1",
      ok: true,
      learnerToken: reference,
      verified: true,
    });
    expect(verified).not.toHaveProperty("diagnostics");
  });

  it("refuses a score changed between the plan and the dispatch, and sends no PATCH", async () => {
    const fixture = await harness({ scoreBetweenReads: true });
    const reference = await studentReference(fixture);
    const planDigest = await planDigestOf(fixture, "blackboard_plan_gradebook_grade_patch", gradePatch, { learner_reference: reference });
    const refused = structured(await fixture.call(
      "blackboard_apply_reviewed_gradebook_grade_patch",
      applyArguments(gradePatch, planDigest, { learner_reference: reference }),
    ));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: {
        code: "blackboard_content_mismatch",
        message: "The Blackboard grade Morrow read does not match the reviewed plan. It changed after review, or this request names a different person or a different column. The change was not sent.",
      },
    });
    expect(fixture.patchRequests()).toEqual([]);
  });

  it("refuses a dispatch that names another person than the reviewed plan, and sends no PATCH", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const other = await referenceFor(fixture, "Guest");
    const planDigest = await planDigestOf(fixture, "blackboard_plan_gradebook_grade_patch", gradePatch, { learner_reference: reference });
    const refused = structured(await fixture.call(
      "blackboard_apply_reviewed_gradebook_grade_patch",
      applyArguments(gradePatch, planDigest, { learner_reference: other }),
    ));
    expect(refused).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_content_mismatch" } });
    expect(fixture.patchRequests()).toEqual([]);
  });

  it("reports applied_or_unknown when the saved score is not the reviewed one", async () => {
    const fixture = await harness({ ignoreGradePatch: true });
    const reference = await studentReference(fixture);
    const planDigest = await planDigestOf(fixture, "blackboard_plan_gradebook_grade_patch", gradePatch, { learner_reference: reference });
    const result = structured(await fixture.call(
      "blackboard_apply_reviewed_gradebook_grade_patch",
      applyArguments(gradePatch, planDigest, { learner_reference: reference }),
    ));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: {
        code: "blackboard_content_mismatch",
        message: "Blackboard did not return this person, this gradebook column, and every reviewed grade value after the change.",
      },
    });
    expect(fixture.patchRequests()).toEqual([`PATCH ${gradePath}`]);
    expectNoLearnerData(result, "the failed grade readback");

    const verified = structured(await fixture.call("blackboard_verify_gradebook_grade_patch", { learner_reference: reference, patch: gradePatch }));
    expect(verified).toMatchObject({ ok: true, verified: false });
  });

  it("sends nothing for a replayed grade grant", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const planDigest = await planDigestOf(fixture, "blackboard_plan_gradebook_grade_patch", gradePatch, { learner_reference: reference });
    const grant = grantArguments(effectGrant(planDigest));
    expect(structured(await fixture.call(
      "blackboard_apply_reviewed_gradebook_grade_patch",
      applyArguments(gradePatch, planDigest, { learner_reference: reference }, grant),
    )).ok).toBe(true);
    const sent = fixture.patchRequests();

    const replay = structured(await fixture.call(
      "blackboard_apply_reviewed_gradebook_grade_patch",
      applyArguments(gradePatch, planDigest, { learner_reference: reference }, grant),
    ));
    expect(replay).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_patch_review_required", message: "This Blackboard effect grant was already dispatched." },
    });
    expect(fixture.patchRequests()).toEqual(sent);
  });

  it("refuses a change to anything but the reviewed fields, before any request", async () => {
    const fixture = await harness();
    const reference = "learner_2f1a5b3c-9d4e-4f6a-8b7c-1d2e3f4a5b6c";
    const columns: readonly JsonObject[] = [
      {},
      { grading: { type: "Manual" } },
      { grading: { due: "next Friday" } },
      { score: { possible: -1 } },
      { score: { possible: 10, decimalPlaces: 2 } },
      { availability: { available: "Disabled" } },
      { externalGrade: false },
      { name: " Essay one " },
    ];
    for (const patch of columns) {
      const refused = structured(await fixture.call("blackboard_plan_gradebook_column_patch", { patch }));
      expect(refused, JSON.stringify(patch)).toMatchObject({
        ok: false,
        resultState: "not_sent",
        problem: { code: "blackboard_response_invalid" },
      });
    }
    const grades: readonly JsonObject[] = [
      {},
      { score: -1 },
      { score: "18" },
      { exempt: true },
      { feedback: "Well done" },
      { text: "" },
    ];
    for (const patch of grades) {
      const refused = structured(await fixture.call("blackboard_plan_gradebook_grade_patch", { learner_reference: reference, patch }));
      expect(refused, JSON.stringify(patch)).toMatchObject({
        ok: false,
        resultState: "not_sent",
        problem: { code: "blackboard_response_invalid" },
      });
    }
    expect(fixture.requests()).toEqual([]);
  });
});
