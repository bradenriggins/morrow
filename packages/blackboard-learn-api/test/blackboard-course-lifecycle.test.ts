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
const destinationCourseId = "BIO-101-COPY";
const copiedCourseId = "_23_1";
const principalId = "_11_1";
const studentId = "_44_1";
const contentId = "_55_1";
const folderId = "_56_1";
const effectSecret = Buffer.alloc(32, 7).toString("base64url");

const rosterPath = `/learn/api/public/v1/courses/${courseId}/users`;
const coursePath = `/learn/api/public/v3/courses/${courseId}`;
const courseCopyPath = `/learn/api/public/v2/courses/${courseId}/copy`;
const courseCopyTaskPath = `/learn/api/public/v1/courses/${courseId}/tasks/_99_1`;
const copiedCoursePath = `/learn/api/public/v1/courses/${copiedCourseId}`;
const copiedCourseExternalPath = `/learn/api/public/v3/courses/externalId%3A${destinationCourseId}`;
const contentPath = `/learn/api/public/v1/courses/${courseId}/contents/${contentId}`;
const folderPath = `/learn/api/public/v1/courses/${courseId}/contents/${folderId}`;

/** The learner name and address that must never leave this server. */
const studentEmail = "jane.doe@example.edu";

/** The window one reviewed course change opens the course in. */
const termStart = "2026-09-01T00:00:00.000Z";
const termEnd = "2026-12-18T23:59:00.000Z";

/** The window one reviewed dated-visibility change gives the item. */
const releaseStart = "2026-10-05T08:00:00.000Z";
const releaseEnd = "2026-10-12T23:59:00.000Z";

let close: (() => Promise<void>) | undefined;

afterEach(async () => { await close?.(); close = undefined; });

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function location(response: ServerResponse, value: string, status: number): void {
  response.writeHead(status, { location: value });
  response.end();
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

function problem(value: JsonObject): JsonObject {
  return isJsonObject(value.problem) ? value.problem : {};
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

interface FixtureOptions {
  /** Rename the course after the plan froze it, as someone else in Blackboard would. */
  readonly courseBetweenReads?: boolean;
  /** Retitle the content item after the plan froze it. */
  readonly contentBetweenReads?: boolean;
  /** Answer the PATCH, and save none of it, as a site that did not apply the change. */
  readonly ignorePatch?: boolean;
  /** Clear the course window while applying the change, as a site that replaces the nested object. */
  readonly clearCourseWindow?: boolean;
  /** Clear the item's end date while applying the change. */
  readonly clearItemEnd?: boolean;
  /** Start the content item with no dated-visibility window at all. */
  readonly noItemWindow?: boolean;
  /**
   * Answer a cleared date as `null` instead of dropping it, as a site that keeps
   * the field and empties it. Both answers mean the item holds no date.
   */
  readonly keepsClearedDatesAsNull?: boolean;
  /** Leave the documented copy task running after the copy request. */
  readonly copyPending?: boolean;
  /** Answer the first task read as running, then complete it on the next read. */
  readonly copyPendingOnce?: boolean;
  /** Complete the task but return a target that does not match the source. */
  readonly copyMismatch?: boolean;
}

async function harness(options: FixtureOptions = {}) {
  const requests: string[] = [];
  const coursePatches: JsonObject[] = [];
  const contentPatches: JsonObject[] = [];
  const courseCopies: JsonObject[] = [];
  let courseReads = 0;
  let contentReads = 0;
  let copyTaskReads = 0;

  let course: JsonObject = {
    id: courseId,
    courseId: "BIO-101",
    name: "Biology",
    ultraStatus: "Ultra",
    closedComplete: false,
    availability: {
      available: "Yes",
      duration: { type: "Continuous" },
    },
  };

  let content: JsonObject = {
    id: contentId,
    parentId: "_54_1",
    courseId,
    title: "Week 3 reading",
    description: "The reading for week 3.",
    position: 2,
    contentHandler: { id: "resource/x-bb-document" },
    availability: {
      available: "Yes",
      allowGuests: false,
      ...(options.noItemWindow ? {} : { adaptiveRelease: { start: "2026-09-28T08:00:00.000Z", end: "2026-10-01T23:59:00.000Z" } }),
    },
  };
  let copiedCourse: JsonObject | undefined;

  const folder: JsonObject = {
    id: folderId,
    parentId: null,
    courseId,
    title: "Week 3",
    position: 1,
    contentHandler: { id: "resource/x-bb-folder", isBbPage: false },
    availability: { available: "Yes" },
  };

  /** One PATCH applied the way a merging Learn site would apply it. */
  const merge = (record: JsonObject, patch: JsonObject): JsonObject => {
    const output = { ...record, ...patch };
    const currentAvailability = isJsonObject(record.availability) ? record.availability : {};
    const patchedAvailability = isJsonObject(patch.availability) ? patch.availability : {};
    const availability: JsonObject = { ...currentAvailability, ...patchedAvailability };
    for (const nested of ["duration", "adaptiveRelease"]) {
      const before = isJsonObject(currentAvailability[nested]) ? currentAvailability[nested] : {};
      const after = patchedAvailability[nested];
      if (!isJsonObject(after)) continue;
      const merged: JsonObject = { ...before };
      for (const [key, value] of Object.entries(after)) {
        if (value !== null) merged[key] = value;
        else if (options.keepsClearedDatesAsNull) merged[key] = null;
        else delete merged[key];
      }
      availability[nested] = merged;
    }
    output.availability = availability;
    return output;
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "http://fixture").pathname;
    const method = request.method || "GET";
    requests.push(`${method} ${pathname}`);
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
        ],
        paging: {},
      });
      return;
    }

    if (pathname === coursePath && method === "PATCH") {
      void body(request).then((raw) => {
        const requested = JSON.parse(raw) as JsonObject;
        coursePatches.push(requested);
        if (!options.ignorePatch) course = merge(course, requested);
        if (options.clearCourseWindow) {
          const availability = isJsonObject(course.availability) ? course.availability : {};
          course = { ...course, availability: { ...availability, duration: { type: "Continuous" } } };
        }
        json(response, course);
      });
      return;
    }
    if (pathname === courseCopyPath && method === "POST") {
      void body(request).then((raw) => {
        const requested = JSON.parse(raw) as JsonObject;
        courseCopies.push(requested);
        copiedCourse = {
          ...course,
          id: copiedCourseId,
          courseId: destinationCourseId,
          ...(options.copyMismatch ? { name: "Different course" } : {}),
        };
        location(response, courseCopyTaskPath, 202);
      });
      return;
    }
    if (pathname === courseCopyTaskPath) {
      copyTaskReads += 1;
      if (options.copyPending || (options.copyPendingOnce && copyTaskReads === 1)) json(response, { status: "Running" });
      else location(response, copiedCoursePath, 303);
      return;
    }
    if ((pathname === copiedCoursePath || pathname === copiedCourseExternalPath) && copiedCourse) {
      json(response, copiedCourse);
      return;
    }
    if (pathname === coursePath) {
      json(response, course);
      courseReads += 1;
      // Someone else renames the course after Morrow froze the plan. The plan
      // reads this route twice: the course-accepts-a-change read, and the freeze.
      if (options.courseBetweenReads && courseReads === 2) course = { ...course, name: "Renamed in Blackboard" };
      return;
    }

    if (pathname === contentPath && method === "PATCH") {
      void body(request).then((raw) => {
        const requested = JSON.parse(raw) as JsonObject;
        contentPatches.push(requested);
        if (!options.ignorePatch) content = merge(content, requested);
        if (options.clearItemEnd) {
          const availability = isJsonObject(content.availability) ? content.availability : {};
          const release = isJsonObject(availability.adaptiveRelease) ? { ...availability.adaptiveRelease } : {};
          delete release.end;
          content = { ...content, availability: { ...availability, adaptiveRelease: release } };
        }
        json(response, content);
      });
      return;
    }
    if (pathname === contentPath) {
      json(response, content);
      contentReads += 1;
      if (options.contentBetweenReads && contentReads === 1) content = { ...content, title: "Retitled in Blackboard" };
      return;
    }
    if (pathname === folderPath) { json(response, folder); return; }

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
  const client = new Client({ name: "blackboard-course-lifecycle", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
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
    /** Every request that could change the course. The token request is not one. */
    writeRequests: () => requests.filter((entry) => (
      /^(?:POST|PATCH|PUT|DELETE) /.test(entry) && !entry.endsWith("/oauth2/token")
    )),
    coursePatchBodies: () => [...coursePatches],
    contentPatchBodies: () => [...contentPatches],
    courseCopyBodies: () => [...courseCopies],
    savedCourse: () => ({ ...course }),
    savedContent: () => ({ ...content }),
    call,
  };
}

type Fixture = Awaited<ReturnType<typeof harness>>;

let receipts = 0;

function effectGrant(planDigest: string): BlackboardEffectGrant {
  receipts += 1;
  const unsigned = {
    schema: "morrow.blackboard.effect-grant.v1" as const,
    operationId: "op:blackboard-course-lifecycle-test",
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

/** The plan digest of one reviewed change, or the refusal that stopped it. */
async function planDigestOf(fixture: Fixture, name: string, args: JsonObject): Promise<string> {
  const plan = structured(await fixture.call(name, args));
  if (plan.ok !== true || typeof plan.planDigest !== "string") {
    throw new Error(`the Blackboard plan ${name} was refused: ${JSON.stringify(plan)}`);
  }
  return plan.planDigest;
}

function applyArguments(args: JsonObject, planDigest: string, grant = grantArguments(effectGrant(planDigest))): JsonObject {
  return { ...args, expected_plan_digest: planDigest, _morrow: { outer_grant: grant } };
}

describe("Blackboard course availability, dates and course copy", () => {
  it("plans one course availability change, states who loses access, and sends nothing", async () => {
    const fixture = await harness();
    const plan = structured(await fixture.call("blackboard_plan_course_availability", { available: "No" }));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.course-availability-patch.plan.v1",
      ok: true,
      courseId,
      reviewRequired: true,
      readback: "protected_fields",
      status: "api_configured_live_untested",
    });
    expect(plan.before).toMatchObject({
      id: courseId, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false,
      availability: { available: "Yes", duration: { type: "Continuous" } },
    });
    expect(plan.change).toEqual({ available: "No", durationType: null, durationStart: null, durationEnd: null });
    expect(plan.request).toEqual({ availability: { available: "No" } });
    expect(plan.access).toEqual({
      available: { before: "Yes", after: "No" },
      learners: 1,
      peopleEnrolled: 2,
      detail: "Learners lose access to this course: 1 of the 2 people enrolled in this course have the Student course role.",
    });
    expect(plan.notCompared).toEqual([]);
    expect(summary(await fixture.call("blackboard_plan_course_availability", { available: "No" })))
      .toBe("Morrow prepared one Blackboard course availability change for review. Nothing in the course was changed.");
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("sends exactly one PATCH for an approved availability change and reads the course back", async () => {
    const fixture = await harness();
    const args = { available: "No" };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_availability", args);
    const applied = structured(await fixture.call(
      "blackboard_apply_reviewed_course_availability",
      applyArguments(args, planDigest),
    ));
    expect(applied).toMatchObject({
      schema: "morrow.blackboard.course-availability-patch.readback.v1",
      ok: true,
      resultState: "applied",
      courseId,
      notCompared: [],
    });
    expect(applied.course).toMatchObject({ availability: { available: "No", duration: { type: "Continuous" } } });
    expect(fixture.writeRequests()).toEqual([`PATCH ${coursePath}`]);
    expect(fixture.coursePatchBodies()).toEqual([{ availability: { available: "No" } }]);
  });

  it("sends exactly one PATCH for an approved course window and names the dates it did not compare", async () => {
    const fixture = await harness();
    const args = { duration_type: "DateRange", duration_start: termStart, duration_end: termEnd };
    const plan = structured(await fixture.call("blackboard_plan_course_availability", args));
    expect(plan.access).toMatchObject({
      available: { before: "Yes", after: "Yes" },
      detail: "This change does not change whether the course is available; 1 of the 2 people enrolled in this course have the Student course role. It sets the course open between 2026-09-01T00:00:00.000Z and 2026-12-18T23:59:00.000Z.",
    });
    expect(plan.notCompared).toEqual(["availability.duration.daysOfUse"]);
    const applied = structured(await fixture.call(
      "blackboard_apply_reviewed_course_availability",
      applyArguments(args, String(plan.planDigest)),
    ));
    expect(applied).toMatchObject({ ok: true, resultState: "applied", notCompared: ["availability.duration.daysOfUse"] });
    expect(applied.course).toMatchObject({
      availability: { available: "Yes", duration: { type: "DateRange", start: termStart, end: termEnd } },
    });
    expect(fixture.writeRequests()).toEqual([`PATCH ${coursePath}`]);
    expect(fixture.coursePatchBodies()).toEqual([
      { availability: { duration: { type: "DateRange", start: termStart, end: termEnd } } },
    ]);
  });

  it("refuses before sending when an unrelated course field changed between plan and dispatch", async () => {
    const fixture = await harness({ courseBetweenReads: true });
    const args = { available: "No" };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_availability", args);
    const refused = structured(await fixture.call(
      "blackboard_apply_reviewed_course_availability",
      applyArguments(args, planDigest),
    ));
    expect(refused).toMatchObject({ ok: false, resultState: "not_sent" });
    expect(problem(refused)).toMatchObject({ code: "blackboard_content_mismatch" });
    expect(String(problem(refused).message)).toContain("Nothing was sent.");
    expect(fixture.writeRequests()).toEqual([]);
    expect(fixture.savedCourse()).toMatchObject({ availability: { available: "Yes" } });
  });

  it("reports applied_or_unknown when the site clears the course window while it applies the change", async () => {
    const fixture = await harness({ clearCourseWindow: true });
    const args = { duration_type: "DateRange", duration_start: termStart, duration_end: termEnd };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_availability", args);
    const failed = structured(await fixture.call(
      "blackboard_apply_reviewed_course_availability",
      applyArguments(args, planDigest),
    ));
    expect(failed).toMatchObject({ ok: false, resultState: "applied_or_unknown" });
    expect(problem(failed)).toMatchObject({
      code: "blackboard_content_mismatch",
      message: "Blackboard did not return every reviewed and protected course value after the change.",
    });
    expect(fixture.writeRequests()).toEqual([`PATCH ${coursePath}`]);
  });

  it("reports applied_or_unknown when the site saves none of the reviewed availability change", async () => {
    const fixture = await harness({ ignorePatch: true });
    const args = { available: "No" };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_availability", args);
    const failed = structured(await fixture.call(
      "blackboard_apply_reviewed_course_availability",
      applyArguments(args, planDigest),
    ));
    expect(failed).toMatchObject({ ok: false, resultState: "applied_or_unknown" });
    expect(fixture.writeRequests()).toEqual([`PATCH ${coursePath}`]);
  });

  it("sends nothing when the same course grant is dispatched twice", async () => {
    const fixture = await harness();
    const args = { available: "No" };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_availability", args);
    const grant = grantArguments(effectGrant(planDigest));
    const applied = structured(await fixture.call("blackboard_apply_reviewed_course_availability", applyArguments(args, planDigest, grant)));
    expect(applied.ok).toBe(true);
    const replay = structured(await fixture.call("blackboard_apply_reviewed_course_availability", applyArguments(args, planDigest, grant)));
    expect(replay).toMatchObject({ ok: false, resultState: "not_sent" });
    expect(problem(replay)).toMatchObject({ code: "blackboard_patch_review_required" });
    expect(fixture.writeRequests()).toEqual([`PATCH ${coursePath}`]);
  });

  it("verifies a saved course availability change and refuses to call an unsaved one verified", async () => {
    const fixture = await harness();
    const args = { available: "No" };
    const before = structured(await fixture.call("blackboard_verify_course_availability", args));
    expect(before).toMatchObject({
      schema: "morrow.blackboard.course-availability-patch.comparator.v1",
      ok: true,
      verified: false,
      readback: "protected_fields",
    });
    expect(before.diagnostics).toBeUndefined();
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_availability", args);
    await fixture.call("blackboard_apply_reviewed_course_availability", applyArguments(args, planDigest));
    expect(structured(await fixture.call("blackboard_verify_course_availability", args))).toMatchObject({ verified: true });
  });

  it("refuses a course change that sets nothing, an unordered window, and a date that is not an instant", async () => {
    const fixture = await harness();
    for (const args of [
      {},
      { duration_type: "DateRange", duration_start: termEnd, duration_end: termStart },
      { duration_type: "DateRange", duration_start: "week 1" },
      { duration_type: "Continuous", duration_start: termStart },
      { duration_type: "DateRange" },
      { duration_start: termStart },
    ]) {
      const refused = structured(await fixture.call("blackboard_plan_course_availability", args));
      expect(refused).toMatchObject({ ok: false, resultState: "not_sent" });
      expect(problem(refused)).toMatchObject({ code: "blackboard_response_invalid" });
    }
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("plans one dated-visibility change as the whole window the item ends up with", async () => {
    const fixture = await harness();
    const plan = structured(await fixture.call("blackboard_plan_content_dated_visibility", {
      content_id: contentId, start: releaseStart, end: releaseEnd,
    }));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.content-dates.plan.v1",
      ok: true,
      courseId,
      contentId,
      reviewRequired: true,
      dates: { start: releaseStart, end: releaseEnd },
      request: { availability: { adaptiveRelease: { start: releaseStart, end: releaseEnd } } },
    });
    expect(plan.before).toMatchObject({
      id: contentId,
      title: "Week 3 reading",
      datedVisibility: { start: "2026-09-28T08:00:00.000Z", end: "2026-10-01T23:59:00.000Z" },
    });
    expect(plan.access).toEqual({
      window: { start: releaseStart, end: releaseEnd },
      learners: 1,
      peopleEnrolled: 2,
      detail: `Learners see this item between ${releaseStart} and ${releaseEnd}. 1 of the 2 people enrolled in this course have the Student course role.`,
    });
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("sends exactly one PATCH for an approved dated-visibility change and reads both dates back", async () => {
    const fixture = await harness();
    const args = { content_id: contentId, start: releaseStart, end: releaseEnd };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_content_dated_visibility", args);
    const applied = structured(await fixture.call(
      "blackboard_apply_reviewed_content_dated_visibility",
      applyArguments(args, planDigest),
    ));
    expect(applied).toMatchObject({
      schema: "morrow.blackboard.content-dates.readback.v1",
      ok: true,
      resultState: "applied",
      contentId,
    });
    expect(applied.content).toMatchObject({ datedVisibility: { start: releaseStart, end: releaseEnd } });
    expect(fixture.writeRequests()).toEqual([`PATCH ${contentPath}`]);
    expect(fixture.contentPatchBodies()).toEqual([
      { availability: { adaptiveRelease: { start: releaseStart, end: releaseEnd } } },
    ]);
    expect(summary(await fixture.call("blackboard_verify_content_dated_visibility", args)))
      .toBe("Morrow re-read when learners see the selected Blackboard content item.");
  });

  it("keeps the date a change leaves out, and clears one a change sets to null", async () => {
    const fixture = await harness();
    const kept = structured(await fixture.call("blackboard_plan_content_dated_visibility", {
      content_id: contentId, start: "2026-09-29T08:00:00.000Z",
    }));
    expect(kept).toMatchObject({
      dates: { start: "2026-09-29T08:00:00.000Z", end: "2026-10-01T23:59:00.000Z" },
      request: { availability: { adaptiveRelease: { start: "2026-09-29T08:00:00.000Z", end: "2026-10-01T23:59:00.000Z" } } },
    });

    // The window is checked against the date the item keeps, not only against
    // the dates one request carries, so a start after the item's own end is
    // refused instead of hiding the item from every learner.
    const inverted = structured(await fixture.call("blackboard_plan_content_dated_visibility", {
      content_id: contentId, start: releaseStart,
    }));
    expect(problem(inverted)).toMatchObject({
      code: "blackboard_response_invalid",
      message: "The Blackboard dated visibility ends before it starts.",
    });

    const clear = { content_id: contentId, end: null };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_content_dated_visibility", clear);
    const applied = structured(await fixture.call(
      "blackboard_apply_reviewed_content_dated_visibility",
      applyArguments(clear, planDigest),
    ));
    expect(applied).toMatchObject({ ok: true, resultState: "applied" });
    expect(applied.content).toMatchObject({ datedVisibility: { start: "2026-09-28T08:00:00.000Z", end: null } });
    expect(fixture.contentPatchBodies()).toEqual([
      { availability: { adaptiveRelease: { start: "2026-09-28T08:00:00.000Z", end: null } } },
    ]);
    expect(fixture.writeRequests()).toEqual([`PATCH ${contentPath}`]);
  });

  it("calls a cleared date cleared whether the site drops it or answers it as null", async () => {
    const fixture = await harness({ keepsClearedDatesAsNull: true });
    const clear = { content_id: contentId, end: null };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_content_dated_visibility", clear);
    const applied = structured(await fixture.call(
      "blackboard_apply_reviewed_content_dated_visibility",
      applyArguments(clear, planDigest),
    ));
    // The site kept `end` and emptied it. That is the reviewed window, so this
    // is applied, not a change Morrow could not confirm.
    expect(applied).toMatchObject({ ok: true, resultState: "applied" });
    expect(applied.content).toMatchObject({ datedVisibility: { start: "2026-09-28T08:00:00.000Z", end: null } });
    expect(isJsonObject(fixture.savedContent().availability)
      && isJsonObject((fixture.savedContent().availability as JsonObject).adaptiveRelease)
      ? ((fixture.savedContent().availability as JsonObject).adaptiveRelease as JsonObject).end
      : "missing").toBeNull();
    expect(fixture.writeRequests()).toEqual([`PATCH ${contentPath}`]);

    // A second change to the same item sends no null for the date it now holds
    // as null: there is nothing left to clear.
    const second = { content_id: contentId, start: "2026-09-30T08:00:00.000Z" };
    const secondDigest = await planDigestOf(fixture, "blackboard_plan_content_dated_visibility", second);
    await fixture.call("blackboard_apply_reviewed_content_dated_visibility", applyArguments(second, secondDigest));
    expect(fixture.contentPatchBodies()[1]).toEqual({
      availability: { adaptiveRelease: { start: "2026-09-30T08:00:00.000Z" } },
    });
  });

  it("sends no null for a date the item does not hold", async () => {
    const fixture = await harness({ noItemWindow: true });
    const args = { content_id: contentId, start: releaseStart };
    const plan = structured(await fixture.call("blackboard_plan_content_dated_visibility", args));
    expect(plan).toMatchObject({
      dates: { start: releaseStart, end: null },
      request: { availability: { adaptiveRelease: { start: releaseStart } } },
      access: { detail: `Learners see this item from ${releaseStart}, with no end date. 1 of the 2 people enrolled in this course have the Student course role.` },
    });
    const applied = structured(await fixture.call(
      "blackboard_apply_reviewed_content_dated_visibility",
      applyArguments(args, String(plan.planDigest)),
    ));
    expect(applied).toMatchObject({ ok: true, resultState: "applied" });
    expect(fixture.contentPatchBodies()).toEqual([{ availability: { adaptiveRelease: { start: releaseStart } } }]);
  });

  it("refuses before sending when the content item changed between plan and dispatch", async () => {
    const fixture = await harness({ contentBetweenReads: true });
    const args = { content_id: contentId, start: releaseStart, end: releaseEnd };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_content_dated_visibility", args);
    const refused = structured(await fixture.call(
      "blackboard_apply_reviewed_content_dated_visibility",
      applyArguments(args, planDigest),
    ));
    expect(refused).toMatchObject({ ok: false, resultState: "not_sent" });
    expect(problem(refused)).toMatchObject({ code: "blackboard_content_mismatch" });
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("reports applied_or_unknown when the site drops the end date while it sets the start date", async () => {
    const fixture = await harness({ clearItemEnd: true });
    const args = { content_id: contentId, start: releaseStart, end: releaseEnd };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_content_dated_visibility", args);
    const failed = structured(await fixture.call(
      "blackboard_apply_reviewed_content_dated_visibility",
      applyArguments(args, planDigest),
    ));
    expect(failed).toMatchObject({ ok: false, resultState: "applied_or_unknown" });
    expect(problem(failed)).toMatchObject({
      code: "blackboard_content_mismatch",
      message: "Blackboard did not return every reviewed and protected content value after the change.",
    });
    expect(fixture.writeRequests()).toEqual([`PATCH ${contentPath}`]);
  });

  it("sets no date on a folder, and refuses a change that sets neither date", async () => {
    const fixture = await harness();
    const folderRefusal = structured(await fixture.call("blackboard_plan_content_dated_visibility", {
      content_id: folderId, start: releaseStart,
    }));
    expect(folderRefusal).toMatchObject({ ok: false, resultState: "not_sent" });
    expect(problem(folderRefusal)).toMatchObject({ code: "blackboard_operation_unavailable" });
    expect(String(problem(folderRefusal).message)).toContain("Morrow sets dates on one document, not on a folder.");

    const empty = structured(await fixture.call("blackboard_plan_content_dated_visibility", { content_id: contentId }));
    expect(problem(empty)).toMatchObject({ code: "blackboard_response_invalid" });
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("verifies a saved dated-visibility change against the item's own window", async () => {
    const fixture = await harness();
    const args = { content_id: contentId, start: releaseStart, end: releaseEnd };
    expect(structured(await fixture.call("blackboard_verify_content_dated_visibility", args))).toMatchObject({
      schema: "morrow.blackboard.content-dates.comparator.v1",
      ok: true,
      verified: false,
    });
    const planDigest = await planDigestOf(fixture, "blackboard_plan_content_dated_visibility", args);
    await fixture.call("blackboard_apply_reviewed_content_dated_visibility", applyArguments(args, planDigest));
    expect(structured(await fixture.call("blackboard_verify_content_dated_visibility", args))).toMatchObject({ verified: true });
  });

  it("copies one reviewed source course through its task and re-reads the copied course", async () => {
    const fixture = await harness();
    const args = { destination_course_id: destinationCourseId };
    const plan = structured(await fixture.call("blackboard_plan_course_copy", args));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.course-copy.plan.v1",
      ok: true,
      destinationCourseId,
      request: { targetCourse: { courseId: destinationCourseId } },
      reviewRequired: true,
    });
    expect(fixture.writeRequests()).toEqual([]);
    const applied = structured(await fixture.call(
      "blackboard_apply_reviewed_course_copy",
      applyArguments(args, String(plan.planDigest)),
    ));
    expect(applied).toMatchObject({
      schema: "morrow.blackboard.course-copy.readback.v1",
      ok: true,
      resultState: "applied",
      destinationCourseId,
      copiedCourse: { id: copiedCourseId, courseId: destinationCourseId, name: "Biology" },
    });
    expect(fixture.courseCopyBodies()).toEqual([{ targetCourse: { courseId: destinationCourseId } }]);
    expect(fixture.writeRequests()).toEqual([`POST ${courseCopyPath}`]);
    expect(structured(await fixture.call("blackboard_verify_course_copy", args))).toMatchObject({
      schema: "morrow.blackboard.course-copy.comparator.v1",
      ok: true,
      destinationCourseId,
      verified: true,
    });
  });

  it("does not repeat a course copy while Blackboard still reports its task running", async () => {
    const fixture = await harness({ copyPending: true });
    const args = { destination_course_id: destinationCourseId };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_copy", args);
    const pending = structured(await fixture.call(
      "blackboard_apply_reviewed_course_copy",
      applyArguments(args, planDigest),
    ));
    expect(pending).toMatchObject({
      schema: "morrow.blackboard.course-copy.pending.v1",
      ok: true,
      resultState: "awaiting_provider",
      taskId: expect.stringMatching(/^bbcopy:[A-Za-z0-9_-]+$/),
    });
    expect(fixture.writeRequests()).toEqual([`POST ${courseCopyPath}`]);
  });

  it("retains the exact task and verifies it after a pending course copy completes", async () => {
    const fixture = await harness({ copyPendingOnce: true });
    const args = { destination_course_id: destinationCourseId };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_copy", args);
    const pending = structured(await fixture.call(
      "blackboard_apply_reviewed_course_copy",
      applyArguments(args, planDigest),
    ));
    const verified = structured(await fixture.call("blackboard_verify_course_copy", {
      ...args,
      task_reference: pending.taskId,
    }));
    expect(verified).toMatchObject({
      schema: "morrow.blackboard.course-copy.comparator.v1",
      ok: true,
      destinationCourseId,
      verified: true,
    });
    expect(fixture.writeRequests()).toEqual([`POST ${courseCopyPath}`]);
  });

  it("keeps an unconfirmed course copy when its completed task returns a different course", async () => {
    const fixture = await harness({ copyMismatch: true });
    const args = { destination_course_id: destinationCourseId };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_copy", args);
    const failed = structured(await fixture.call(
      "blackboard_apply_reviewed_course_copy",
      applyArguments(args, planDigest),
    ));
    expect(failed).toMatchObject({ ok: false, resultState: "applied_or_unknown" });
    expect(problem(failed)).toMatchObject({ code: "blackboard_content_mismatch" });
    expect(fixture.writeRequests()).toEqual([`POST ${courseCopyPath}`]);
  });

  it("calls a course copy unverified, not failed, while the destination course does not exist", async () => {
    const fixture = await harness();
    const args = { destination_course_id: destinationCourseId };
    // The Gateway freezes this comparator while it plans the copy, before any
    // course exists at the reviewed Course ID, so Blackboard's 404 is an answer.
    const before = structured(await fixture.call("blackboard_verify_course_copy", args));
    expect(before).toMatchObject({
      schema: "morrow.blackboard.course-copy.comparator.v1",
      ok: true,
      destinationCourseId,
      verified: false,
    });
    expect(fixture.requests()).toContain(`GET ${copiedCourseExternalPath}`);
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("returns no learner name or address in any course lifecycle result", async () => {
    const fixture = await harness();
    const results = [
      structured(await fixture.call("blackboard_plan_course_availability", { available: "No" })),
      structured(await fixture.call("blackboard_plan_content_dated_visibility", { content_id: contentId, start: releaseStart })),
    ];
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain("Jane");
      expect(text).not.toContain(studentEmail);
    }
  });
});
