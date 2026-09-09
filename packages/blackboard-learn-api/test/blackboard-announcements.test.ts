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
const existingId = "_90_1";
const createdId = "_91_1";
const effectSecret = Buffer.alloc(32, 5).toString("base64url");
const rosterPath = `/learn/api/public/v1/courses/${courseId}/users`;
const announcementsPath = `/learn/api/public/v1/courses/${courseId}/announcements`;
const siteAnnouncementsPath = "/learn/api/public/v1/announcements";
const learnerToken = /Student A[1-9][0-9]*/;

/** The one reviewed announcement, as a plan freezes it and a dispatch sends it. */
const announcement = {
  title: "Lab 3 moves to Friday",
  body: "Lab 3 now runs on Friday at 09:00 in room B.",
  duration_type: "DateRange",
  duration_start: "2026-10-01T08:00:00.000Z",
  duration_end: "2026-10-08T08:00:00.000Z",
  show_at_top_of_course: true,
};

/** The request body one approved dispatch sends for that announcement. */
const announcementRequest = {
  title: announcement.title,
  body: announcement.body,
  availability: { duration: { type: "DateRange", start: announcement.duration_start, end: announcement.duration_end } },
  showAtTopOfCourse: true,
};

/** One roster: the account this credential acts as, and one enrolled learner. */
const roster: readonly JsonObject[] = [
  {
    id: "_m10_1", courseId, userId: principalId, courseRoleId: "Instructor", availability: { available: "Yes" },
    user: { id: principalId, name: { given: "Ada", family: "Byron" }, contact: { email: "ada.byron@example.edu" }, userName: "ada.byron" },
  },
  {
    id: "_m11_1", courseId, userId: studentId, courseRoleId: "Student", availability: { available: "Yes" },
    user: { id: studentId, name: { given: "Jane", family: "Doe" }, contact: { email: "jane.doe@example.edu" }, userName: "jane.doe" },
  },
];

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

function problem(result: JsonObject): JsonObject {
  return isJsonObject(result.problem) ? result.problem : {};
}

async function body(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
}

interface FixtureOptions {
  /** Answer every course-announcement path with 404, as a site that does not serve them. */
  readonly routeUnavailable?: boolean;
  /** Serve the collection, but no announcement under the requested id. */
  readonly announcementMissing?: boolean;
  /** Answer the create request without naming the announcement it created. */
  readonly createWithoutId?: boolean;
  /** Name an announcement that was already in the course before the change. */
  readonly createNamesExisting?: boolean;
  /** Save the announcement with this title instead of the reviewed one. */
  readonly readbackTitle?: string;
  /** Save the announcement without a body, as a site that does not return one. */
  readonly readbackWithoutBody?: boolean;
  /** Save the announcement without the top-of-course flag. */
  readonly readbackWithoutShowAtTop?: boolean;
  /** Save the announcement with this visibility-window type instead. */
  readonly readbackDurationType?: string;
  /** Save the announcement with this end date instead of the reviewed one. */
  readonly readbackEnd?: string;
}

/** One announcement record as this Learn fixture stores it. */
function record(id: string, requested: JsonObject, options: FixtureOptions): JsonObject {
  const availability = isJsonObject(requested.availability) ? requested.availability : {};
  const duration = isJsonObject(availability.duration) ? availability.duration : {};
  return {
    id,
    title: options.readbackTitle ?? requested.title,
    ...(options.readbackWithoutBody ? {} : { body: requested.body }),
    availability: {
      duration: {
        type: options.readbackDurationType ?? duration.type,
        ...(duration.start === undefined ? {} : { start: duration.start }),
        ...(duration.end === undefined ? {} : { end: options.readbackEnd ?? duration.end }),
      },
    },
    ...(options.readbackWithoutShowAtTop ? {} : { showAtTopOfCourse: requested.showAtTopOfCourse }),
    created: "2026-09-05T08:00:00.000Z",
  };
}

async function harness(options: FixtureOptions = {}) {
  const requests: string[] = [];
  const sent: JsonObject[] = [];
  const announcements = new Map<string, JsonObject>([
    [existingId, {
      id: existingId,
      title: "Welcome to the course",
      // A learner named in an announcement written in Blackboard. Every read of
      // this record has to replace the name with a protected reference.
      body: "Jane Doe is the lab assistant this term. Write to jane.doe@example.edu.",
      availability: { duration: { type: "Continuous" } },
      showAtTopOfCourse: false,
      created: "2026-09-01T08:00:00.000Z",
    }],
  ]);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://fixture");
    const pathname = url.pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname === "/learn/api/public/v1/oauth2/token") { json(response, { access_token: "temporary-token", expires_in: 3600 }); return; }
    if (pathname === "/learn/api/public/v1/users/me") { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/users/${principalId}`) { json(response, { id: principalId }); return; }
    if (pathname === `${rosterPath}/${principalId}`) { json(response, { id: "_m10_1", courseId, userId: principalId }); return; }
    if (pathname === rosterPath) { json(response, { results: roster, paging: {} }); return; }
    if (pathname === `/learn/api/public/v3/courses/${courseId}`) {
      json(response, { id: courseId, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false });
      return;
    }
    if (options.routeUnavailable && pathname.startsWith(announcementsPath)) { json(response, { message: "not found" }, 404); return; }
    if (pathname === announcementsPath && request.method === "POST") {
      void body(request).then((requested) => {
        sent.push(requested);
        const id = options.createNamesExisting ? existingId : createdId;
        if (!options.createNamesExisting) announcements.set(createdId, record(createdId, requested, options));
        json(response, { ...(options.createWithoutId ? {} : { id }) }, 201);
      });
      return;
    }
    if (pathname === announcementsPath) { json(response, { results: [...announcements.values()], paging: {} }); return; }
    const one = new RegExp(`^${announcementsPath}/([^/]+)$`).exec(pathname);
    const held = one ? announcements.get(one[1] || "") : undefined;
    if (one && request.method === "PATCH" && held) {
      void body(request).then((requested) => {
        sent.push(requested);
        announcements.set(held.id as string, record(held.id as string, requested, options));
        json(response, announcements.get(held.id as string));
      });
      return;
    }
    if (one && held && !options.announcementMissing) { json(response, held); return; }
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
  const client = new Client({ name: "blackboard-announcements", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
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
    posts: () => requests.filter((entry) => entry === `POST ${announcementsPath}`),
    patches: () => requests.filter((entry) => entry === `PATCH ${announcementsPath}/${existingId}`),
    sent: () => [...sent],
    /** Change the announcement in the course, as a person editing it in Blackboard would. */
    edit: (values: JsonObject) => {
      announcements.set(existingId, { ...announcements.get(existingId) as JsonObject, ...values });
    },
    call,
  };
}

let receipts = 0;

function effectGrant(planDigest: string): BlackboardEffectGrant {
  receipts += 1;
  const unsigned = {
    schema: "morrow.blackboard.effect-grant.v1" as const,
    operationId: "op:blackboard-announcements-test",
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

/** One approved dispatch of the reviewed announcement, as the Gateway sends it. */
function applyArguments(planDigest: string, overrides: JsonObject = {}, grant = effectGrant(planDigest)): JsonObject {
  return {
    ...announcement,
    expected_plan_digest: planDigest,
    _morrow: { outer_grant: grantArguments(grant) },
    ...overrides,
  };
}

type Fixture = Awaited<ReturnType<typeof harness>>;

async function planDigestOf(fixture: Fixture, tool: string, args: JsonObject): Promise<string> {
  const plan = structured(await fixture.call(tool, args));
  if (plan.ok !== true || typeof plan.planDigest !== "string") {
    throw new Error(`the announcement plan was refused: ${JSON.stringify(plan)}`);
  }
  return plan.planDigest;
}

const createPlan = (fixture: Fixture) => planDigestOf(fixture, "blackboard_plan_course_announcement", announcement);
const patchPlan = (fixture: Fixture) => planDigestOf(fixture, "blackboard_plan_course_announcement_patch", { ...announcement, announcement_id: existingId });

describe("Blackboard course announcements", () => {
  it("lists the announcements of the selected course and replaces a named learner with a protected reference", async () => {
    const fixture = await harness();
    const listed = structured(await fixture.call("blackboard_list_course_announcements"));
    expect(listed).toMatchObject({
      schema: "morrow.blackboard.course-announcements.v1",
      ok: true,
      courseId,
      count: 1,
      status: "api_configured_live_untested",
    });
    const announcements = listed.announcements as readonly JsonObject[];
    expect(announcements[0]).toMatchObject({
      id: existingId,
      title: "Welcome to the course",
      availability: { duration: { type: "Continuous" } },
      showAtTopOfCourse: false,
      created: "2026-09-01T08:00:00.000Z",
    });
    // The learner's name and e-mail address leave as one protected reference.
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("jane.doe@example.edu");
    expect(String(announcements[0]?.body)).toMatch(learnerToken);
    // The limit a person has to know is a value in the result, not only prose.
    expect(String(listed.recallLimit)).toContain("Morrow cannot recall a sent announcement.");
    expect(summary(await fixture.call("blackboard_list_course_announcements")))
      .toBe("Morrow read the announcements of the selected Blackboard course.");
  });

  it("reads one announcement by its id, through the same privacy boundary", async () => {
    const fixture = await harness();
    const read = structured(await fixture.call("blackboard_read_course_announcement", { announcement_id: existingId }));
    expect(read).toMatchObject({
      schema: "morrow.blackboard.course-announcement.v1",
      ok: true,
      courseId,
      announcementId: existingId,
    });
    expect(JSON.stringify(read)).not.toContain("Jane Doe");
    expect(String((read.announcement as JsonObject).body)).toMatch(learnerToken);
  });

  it("reports a site that does not serve course announcements as unavailable, and asks for no other path", async () => {
    const fixture = await harness({ routeUnavailable: true });
    for (const [tool, args] of [
      ["blackboard_list_course_announcements", {}],
      ["blackboard_read_course_announcement", { announcement_id: existingId }],
      ["blackboard_plan_course_announcement", announcement],
      ["blackboard_plan_course_announcement_patch", { ...announcement, announcement_id: existingId }],
    ] as const) {
      const refused = structured(await fixture.call(tool, args as JsonObject));
      expect(refused).toMatchObject({
        ok: false,
        resultState: "not_sent",
        problem: { code: "blackboard_operation_unavailable" },
      });
      const message = String(problem(refused).message);
      expect(message).toContain("/learn/api/public/v1/courses/{course_id}/announcements");
      expect(message).toContain("does not fall back");
    }
    // No guessed path: the site-wide announcement collection is never asked for,
    // and nothing was posted.
    expect(fixture.requests().some((entry) => entry.endsWith(` ${siteAnnouncementsPath}`))).toBe(false);
    expect(fixture.posts()).toEqual([]);
  });

  it("tells an announcement this course does not hold apart from a route the site does not serve", async () => {
    const fixture = await harness({ announcementMissing: true });
    const refused = structured(await fixture.call("blackboard_read_course_announcement", { announcement_id: existingId }));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(String(problem(refused).message)).toContain("no announcement with this id");
  });

  it("plans one announcement, carrying the exact text a dispatch sends, and posts nothing", async () => {
    const fixture = await harness();
    const plan = structured(await fixture.call("blackboard_plan_course_announcement", announcement));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.course-announcement.plan.v1",
      ok: true,
      courseId,
      reviewRequired: true,
      limits: { announcements: 1, files: 0, learnersNamed: 0 },
      readback: "reviewed_fields",
      status: "api_configured_live_untested",
      announcement: {
        title: announcement.title,
        body: announcement.body,
        durationType: "DateRange",
        durationStart: announcement.duration_start,
        durationEnd: announcement.duration_end,
        showAtTopOfCourse: true,
      },
    });
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(String(plan.recallLimit)).toContain("Morrow cannot recall a sent announcement.");
    expect(fixture.posts()).toEqual([]);
  });

  it("refuses a visibility window it did not review, before any request", async () => {
    const fixture = await harness();
    const noEnd = structured(await fixture.call("blackboard_plan_course_announcement", { ...announcement, duration_end: undefined }));
    expect(noEnd).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_response_invalid" } });
    expect(String(problem(noEnd).message)).toContain("Private error details were withheld");

    const backwards = structured(await fixture.call("blackboard_plan_course_announcement", {
      ...announcement, duration_start: announcement.duration_end, duration_end: announcement.duration_start,
    }));
    expect(String(problem(backwards).message)).toContain("Private error details were withheld");

    const datedContinuous = structured(await fixture.call("blackboard_plan_course_announcement", {
      ...announcement, duration_type: "Continuous",
    }));
    expect(datedContinuous).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_response_invalid" } });
    expect(String(problem(datedContinuous).message)).toContain("Private error details were withheld");
    expect(fixture.posts()).toEqual([]);
  });

  it("refuses an announcement that names a person enrolled in the course, and posts nothing", async () => {
    const fixture = await harness();
    const named = { ...announcement, body: "Jane Doe will run the Friday lab." };
    const refused = structured(await fixture.call("blackboard_plan_course_announcement", named));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_operation_unavailable" },
    });
    const message = String(problem(refused).message);
    expect(message).toContain("names a person enrolled in the selected Blackboard course");
    expect(message).not.toContain("Jane Doe");
    expect(fixture.posts()).toEqual([]);

    // The same refusal holds on the dispatch route, and nothing is posted. The
    // one-use receipt is spent before the first Blackboard request, so this
    // dispatch cannot be repeated; a new approval can still post the reviewed
    // announcement.
    const digest = await createPlan(fixture);
    const onDispatch = structured(await fixture.call(
      "blackboard_apply_reviewed_course_announcement",
      applyArguments(digest, { body: named.body }),
    ));
    expect(onDispatch).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_operation_unavailable" } });
    expect(fixture.posts()).toEqual([]);
    expect(structured(await fixture.call("blackboard_apply_reviewed_course_announcement", applyArguments(digest))).ok).toBe(true);
    expect(fixture.posts()).toHaveLength(1);
  });

  it("sends one create request per approved plan and reads the announcement back by the id Blackboard returned", async () => {
    const fixture = await harness();
    const digest = await createPlan(fixture);
    const posted = structured(await fixture.call("blackboard_apply_reviewed_course_announcement", applyArguments(digest)));
    expect(posted).toMatchObject({
      schema: "morrow.blackboard.course-announcement.readback.v1",
      ok: true,
      resultState: "applied",
      courseId,
      announcementId: createdId,
      verification: {
        title: "matched",
        body: "matched",
        durationType: "matched",
        durationStart: "matched",
        durationEnd: "matched",
        showAtTopOfCourse: "matched",
      },
      readback: "reviewed_fields",
      status: "api_configured_live_untested",
    });
    expect(posted.announcement).toMatchObject({
      id: createdId,
      title: announcement.title,
      body: announcement.body,
      availability: { duration: { type: "DateRange", start: announcement.duration_start, end: announcement.duration_end } },
      showAtTopOfCourse: true,
    });

    // Exactly one create request, carrying the reviewed values and the whole
    // visibility window.
    expect(fixture.posts()).toEqual([`POST ${announcementsPath}`]);
    expect(fixture.sent()).toEqual([announcementRequest]);

    // The readback re-read the record by the id the create response named.
    const after = fixture.requests().slice(fixture.requests().indexOf(`POST ${announcementsPath}`) + 1);
    expect(after).toContain(`GET ${announcementsPath}/${createdId}`);
    expect(summary(await fixture.call("blackboard_read_course_announcement", { announcement_id: createdId })))
      .toBe("Morrow read one announcement of the selected Blackboard course.");
  });

  it("refuses to send a second create request for one approved plan", async () => {
    const fixture = await harness();
    const digest = await createPlan(fixture);
    const grant = effectGrant(digest);
    expect(structured(await fixture.call("blackboard_apply_reviewed_course_announcement", applyArguments(digest, {}, grant))).ok).toBe(true);
    const replayed = structured(await fixture.call("blackboard_apply_reviewed_course_announcement", applyArguments(digest, {}, grant)));
    expect(replayed).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_patch_review_required" } });
    expect(fixture.posts()).toHaveLength(1);
  });

  it("sends nothing for a forged grant, and nothing for a request that is not the reviewed announcement", async () => {
    const fixture = await harness();
    const digest = await createPlan(fixture);
    const forged = applyArguments(digest);
    (forged._morrow as JsonObject).outer_grant = { ...(forged._morrow as JsonObject).outer_grant as JsonObject, dispatch_token: "d".repeat(64) };
    expect(structured(await fixture.call("blackboard_apply_reviewed_course_announcement", forged)))
      .toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_patch_review_required" } });

    const changed = structured(await fixture.call(
      "blackboard_apply_reviewed_course_announcement",
      applyArguments(digest, { title: "Lab 3 moves to Thursday" }),
    ));
    expect(changed).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_patch_review_required" } });
    expect(fixture.posts()).toEqual([]);
  });

  it("reports applied_or_unknown when Blackboard does not name the announcement it created", async () => {
    const fixture = await harness({ createWithoutId: true });
    const digest = await createPlan(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_course_announcement", applyArguments(digest)));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(String(problem(result).message)).toContain("(id)");
    expect(fixture.posts()).toHaveLength(1);
  });

  it("reports applied_or_unknown when Blackboard names an announcement the course already held", async () => {
    const fixture = await harness({ createNamesExisting: true });
    const digest = await createPlan(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_course_announcement", applyArguments(digest)));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(String(problem(result).message)).toContain("already in this course");
  });

  it("reports applied_or_unknown when a read-back value is not the reviewed one", async () => {
    const wrongTitle = await harness({ readbackTitle: "Lab 3" });
    expect(structured(await wrongTitle.call("blackboard_apply_reviewed_course_announcement", applyArguments(await createPlan(wrongTitle)))))
      .toMatchObject({ ok: false, resultState: "applied_or_unknown", problem: { code: "blackboard_content_mismatch" } });
    await close?.();
    close = undefined;

    const wrongEnd = await harness({ readbackEnd: "2026-12-01T08:00:00.000Z" });
    const ended = structured(await wrongEnd.call("blackboard_apply_reviewed_course_announcement", applyArguments(await createPlan(wrongEnd))));
    expect(ended).toMatchObject({ ok: false, resultState: "applied_or_unknown", problem: { code: "blackboard_content_mismatch" } });
    expect(String(problem(ended).message)).toContain("end date");
    await close?.();
    close = undefined;

    const wrongWindow = await harness({ readbackDurationType: "Continuous" });
    const window = structured(await wrongWindow.call("blackboard_apply_reviewed_course_announcement", applyArguments(await createPlan(wrongWindow))));
    expect(window).toMatchObject({ ok: false, resultState: "applied_or_unknown", problem: { code: "blackboard_content_mismatch" } });
    expect(String(problem(window).message)).toContain("when learners see it");
  });

  it("says which frozen fields it did not compare when the site does not return them", async () => {
    const fixture = await harness({ readbackWithoutBody: true, readbackWithoutShowAtTop: true });
    const posted = structured(await fixture.call("blackboard_apply_reviewed_course_announcement", applyArguments(await createPlan(fixture))));
    expect(posted).toMatchObject({
      ok: true,
      resultState: "applied",
      verification: {
        title: "matched",
        body: "unreported",
        durationType: "matched",
        durationStart: "matched",
        durationEnd: "matched",
        showAtTopOfCourse: "unreported",
      },
    });
  });

  it("verifies one posted announcement against a fresh read of the course announcements", async () => {
    const fixture = await harness();
    const before = structured(await fixture.call("blackboard_verify_course_announcement", announcement));
    expect(before).toMatchObject({
      schema: "morrow.blackboard.course-announcement.comparator.v1",
      ok: true,
      verified: false,
      readback: "reviewed_fields",
    });
    // A comparator returns identifiers the Gateway already holds and one
    // comparison, so it carries no diagnostics for the Gateway to compare against.
    expect(before).not.toHaveProperty("diagnostics");

    expect(structured(await fixture.call("blackboard_apply_reviewed_course_announcement", applyArguments(await createPlan(fixture)))).ok).toBe(true);
    expect(structured(await fixture.call("blackboard_verify_course_announcement", announcement))).toMatchObject({ verified: true });
  });

  it("plans one announcement change against the announcement as it is now", async () => {
    const fixture = await harness();
    const plan = structured(await fixture.call("blackboard_plan_course_announcement_patch", { ...announcement, announcement_id: existingId }));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.course-announcement-patch.plan.v1",
      ok: true,
      courseId,
      announcementId: existingId,
      reviewRequired: true,
      readback: "reviewed_fields",
      announcement: { title: announcement.title, showAtTopOfCourse: true },
    });
    expect(plan.beforeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    // The announcement as it is now is shown through the privacy boundary.
    expect(JSON.stringify(plan)).not.toContain("Jane Doe");
    expect(String((plan.before as JsonObject).body)).toMatch(learnerToken);
    expect(fixture.patches()).toEqual([]);
  });

  it("sends one change request per approved plan and reads the announcement back", async () => {
    const fixture = await harness();
    const digest = await patchPlan(fixture);
    const changed = structured(await fixture.call("blackboard_apply_reviewed_course_announcement_patch", applyArguments(digest, { announcement_id: existingId })));
    expect(changed).toMatchObject({
      schema: "morrow.blackboard.course-announcement-patch.readback.v1",
      ok: true,
      resultState: "applied",
      announcementId: existingId,
      verification: {
        title: "matched",
        body: "matched",
        durationType: "matched",
        durationStart: "matched",
        durationEnd: "matched",
        showAtTopOfCourse: "matched",
      },
    });
    expect(fixture.patches()).toEqual([`PATCH ${announcementsPath}/${existingId}`]);
    expect(fixture.sent()).toEqual([announcementRequest]);
    expect(summary(await fixture.call("blackboard_verify_course_announcement_patch", { ...announcement, announcement_id: existingId })))
      .toBe("Morrow re-read the selected Blackboard course announcement.");
    expect(structured(await fixture.call("blackboard_verify_course_announcement_patch", { ...announcement, announcement_id: existingId })))
      .toMatchObject({ verified: true, announcementId: existingId });
  });

  it("sends nothing when the announcement changed after it was reviewed", async () => {
    const fixture = await harness();
    const digest = await patchPlan(fixture);
    fixture.edit({ title: "Welcome to the course (updated)" });
    const refused = structured(await fixture.call("blackboard_apply_reviewed_course_announcement_patch", applyArguments(digest, { announcement_id: existingId })));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(String(problem(refused).message)).toContain("The change was not sent.");
    expect(fixture.patches()).toEqual([]);
  });

  it("refuses to send a second change request for one approved plan", async () => {
    const fixture = await harness();
    const digest = await patchPlan(fixture);
    const grant = effectGrant(digest);
    const args = applyArguments(digest, { announcement_id: existingId }, grant);
    expect(structured(await fixture.call("blackboard_apply_reviewed_course_announcement_patch", args)).ok).toBe(true);
    expect(structured(await fixture.call("blackboard_apply_reviewed_course_announcement_patch", args)))
      .toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_patch_review_required" } });
    expect(fixture.patches()).toHaveLength(1);
  });

  it("registers the dispatch and comparator routes only for the Gateway process", async () => {
    const runtime = new BlackboardLearnRuntime([]);
    const client = new Client({ name: "blackboard-announcements-surface", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const [left, right] = InMemoryTransport.createLinkedPair();
    const running = serveStdio(() => createBlackboardLearnMcpServer(runtime), { transport: right });
    await client.connect(left);
    const names = (await client.listTools()).tools.map((tool) => tool.name).filter((name) => name.includes("announcement"));
    await client.close();
    await running.close();
    // The two reads and the two plans are registered. Nothing that sends a
    // change, and nothing the Gateway compares against, is.
    expect(names).toEqual([
      "blackboard_list_course_announcements",
      "blackboard_read_course_announcement",
      "blackboard_plan_course_announcement",
      "blackboard_plan_course_announcement_patch",
    ]);
  });
});
