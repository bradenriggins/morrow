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
const testLinkId = "_70_1";
const documentId = "_33_1";
const createdContentId = "_71_1";
const createdColumnId = "_88_1";
const existingColumnId = "_80_1";
const principalId = "_11_1";
const studentId = "_44_1";
const effectSecret = Buffer.alloc(32, 7).toString("base64url");
const rosterPath = `/learn/api/public/v1/courses/${courseId}/users`;
const columnsPath = `/learn/api/public/v2/courses/${courseId}/gradebook/columns`;
const createAssignmentPath = `/learn/api/public/v1/courses/${courseId}/contents/createAssignment`;

/** The one reviewed assignment, as a plan freezes it and a dispatch sends it. */
const assignment = {
  title: "Week 3 lab report",
  instructions: "Submit one lab report as a PDF.",
  points_possible: 40,
  due: "2026-10-01T23:59:00.000Z",
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

async function body(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
}

interface FixtureOptions {
  /** Report the course under this Learn mode instead of Ultra. */
  readonly ultraStatus?: string | null;
  /** Answer the create request without naming the content item it created. */
  readonly createWithoutContentId?: boolean;
  /** Answer the create request without naming the gradebook column it generated. */
  readonly createWithoutColumnId?: boolean;
  /** Name a gradebook column that was already in the course before the change. */
  readonly createNamesExistingColumn?: boolean;
  /** Serve no gradebook column under the id the create request named. */
  readonly columnMissing?: boolean;
  /** Read the created item back with this title instead of the reviewed one. */
  readonly readbackTitle?: string;
  /** Read the created item back without the instructions field. */
  readonly readbackWithoutInstructions?: boolean;
  /** Read the created column back with these points possible. */
  readonly readbackPoints?: number;
  /** Read the created column back as the column that grades this other item. */
  readonly readbackColumnContentId?: string;
}

async function harness(options: FixtureOptions = {}) {
  const requests: string[] = [];
  const createRequests: JsonObject[] = [];
  const columns = new Map<string, JsonObject>([
    [existingColumnId, {
      id: existingColumnId, name: "Week 1 quiz", contentId: testLinkId, externalGrade: true,
      score: { possible: 10 }, availability: { available: "Yes" },
      grading: { type: "Attempts", due: "2026-09-08T23:59:00.000Z" },
    }],
  ]);
  const content = new Map<string, JsonObject>([
    [testLinkId, {
      id: testLinkId, courseId, parentId: "_55_1", title: "Week 1 quiz", position: 1,
      description: "Feedback goes to Jane Doe.",
      contentHandler: { id: "resource/x-bb-asmt-test-link" }, availability: { available: "Yes" },
    }],
    [documentId, {
      id: documentId, courseId, parentId: "_55_1", title: "Week 1", position: 2,
      contentHandler: { id: "resource/x-bb-document" }, availability: { available: "Yes" },
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
      const ultraStatus = options.ultraStatus === undefined ? "Ultra" : options.ultraStatus;
      json(response, {
        id: courseId, courseId: "BIO-101", name: "Biology", closedComplete: false,
        ...(ultraStatus === null ? {} : { ultraStatus }),
      });
      return;
    }
    if (pathname === createAssignmentPath && request.method === "POST") {
      void body(request).then((requested) => {
        createRequests.push(requested);
        const columnId = options.createNamesExistingColumn ? existingColumnId : createdColumnId;
        content.set(createdContentId, {
          id: createdContentId, courseId, parentId: "_55_1", position: 3,
          title: options.readbackTitle ?? String(requested.title),
          ...(options.readbackWithoutInstructions ? {} : { instructions: requested.instructions }),
          contentHandler: { id: "resource/x-bb-asmt-test-link" }, availability: { available: "Yes" },
        });
        if (!options.columnMissing && !options.createNamesExistingColumn) {
          const score = isJsonObject(requested.score) ? requested.score : {};
          const grading = isJsonObject(requested.grading) ? requested.grading : {};
          columns.set(createdColumnId, {
            id: createdColumnId, name: String(requested.title), externalGrade: true,
            ...(options.readbackColumnContentId === "" ? {} : { contentId: options.readbackColumnContentId ?? createdContentId }),
            score: { possible: options.readbackPoints ?? score.possible },
            availability: { available: "Yes" },
            grading: { type: "Attempts", due: grading.due },
          });
        }
        json(response, {
          ...(options.createWithoutContentId ? {} : { contentId: createdContentId }),
          ...(options.createWithoutColumnId ? {} : { gradebookColumnId: columnId }),
        }, 201);
      });
      return;
    }
    if (pathname === columnsPath) { json(response, { results: [...columns.values()], paging: {} }); return; }
    const oneColumn = new RegExp(`^${columnsPath}/([^/]+)$`).exec(pathname);
    if (oneColumn && columns.has(oneColumn[1] || "")) { json(response, columns.get(oneColumn[1] || "")); return; }
    const item = /^\/learn\/api\/public\/v1\/courses\/([^/]+)\/contents\/([^/]+)$/.exec(pathname);
    if (item && item[1] === courseId && content.has(item[2] || "")) { json(response, content.get(item[2] || "")); return; }
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
  const client = new Client({ name: "blackboard-assignments", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
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
    creates: () => requests.filter((entry) => entry === `POST ${createAssignmentPath}`),
    createRequests: () => [...createRequests],
    call,
  };
}

let receipts = 0;

function effectGrant(planDigest: string): BlackboardEffectGrant {
  receipts += 1;
  const unsigned = {
    schema: "morrow.blackboard.effect-grant.v1" as const,
    operationId: "op:blackboard-assignments-test",
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

/** One approved dispatch of the reviewed assignment, as the Gateway sends it. */
function applyArguments(planDigest: string, overrides: JsonObject = {}, grant = effectGrant(planDigest)): JsonObject {
  return {
    ...assignment,
    expected_plan_digest: planDigest,
    _morrow: { outer_grant: grantArguments(grant) },
    ...overrides,
  };
}

async function planDigestOf(fixture: Awaited<ReturnType<typeof harness>>): Promise<string> {
  const plan = structured(await fixture.call("blackboard_plan_ultra_assignment", assignment));
  if (plan.ok !== true || typeof plan.planDigest !== "string") {
    throw new Error(`the assignment plan was refused: ${JSON.stringify(plan)}`);
  }
  return plan.planDigest;
}

describe("Blackboard assignments and assessments", () => {
  it("reads one test link with the gradebook column that grades it, and states the question limit", async () => {
    const fixture = await harness();
    const read = structured(await fixture.call("blackboard_read_course_assessment", { content_id: testLinkId }));
    expect(read).toMatchObject({
      schema: "morrow.blackboard.course-assessment.v1",
      ok: true,
      courseId,
      contentId: testLinkId,
      gradebookColumnState: "one",
      questions: "unavailable",
      status: "api_configured_live_untested",
    });
    expect(read.assessment).toMatchObject({ id: testLinkId, title: "Week 1 quiz", contentHandler: { id: "resource/x-bb-asmt-test-link" } });
    expect(read.gradebookColumn).toMatchObject({ id: existingColumnId, score: { possible: 10 }, grading: { due: "2026-09-08T23:59:00.000Z" } });
    // The limit is a value a person reads, not only prose in a tool description.
    expect(String(read.questionLimit)).toContain("3900.98");
    // Provider text still leaves through the roster redaction.
    expect(JSON.stringify(read)).not.toContain("Jane Doe");
    expect(summary(await fixture.call("blackboard_read_course_assessment", { content_id: testLinkId })))
      .toContain("Morrow cannot read or write the questions inside it.");
  });

  it("refuses an item that is not a Blackboard test or assignment", async () => {
    const fixture = await harness();
    const refused = structured(await fixture.call("blackboard_read_course_assessment", { content_id: documentId }));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_operation_unavailable" },
    });
    expect(String((refused.problem as JsonObject).message)).toContain("resource/x-bb-document");
  });

  it("refuses a request to add a question, naming the 3900.98 removal, and sends no create request", async () => {
    const fixture = await harness();
    const refused = structured(await fixture.call("blackboard_plan_ultra_assignment", {
      ...assignment,
      questions: [{ text: "Which organelle makes ATP?" }],
    }));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_operation_unavailable" },
    });
    const message = String((refused.problem as JsonObject).message);
    expect(message).toContain("3900.98");
    expect(message).toContain("Write the questions in Blackboard.");
    expect(fixture.creates()).toEqual([]);

    // The same refusal holds on the dispatch route, and it does not spend the
    // one-use receipt: the same grant still creates the assignment it was
    // approved for.
    const digest = await planDigestOf(fixture);
    const grant = effectGrant(digest);
    const onDispatch = structured(await fixture.call(
      "blackboard_apply_reviewed_ultra_assignment",
      applyArguments(digest, { questions: [{ text: "Which organelle makes ATP?" }] }, grant),
    ));
    expect(onDispatch).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_operation_unavailable" } });
    expect(fixture.creates()).toEqual([]);
    expect(structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest, {}, grant))).ok).toBe(true);
  });

  it("plans one assignment without creating anything", async () => {
    const fixture = await harness();
    const plan = structured(await fixture.call("blackboard_plan_ultra_assignment", assignment));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.ultra-assignment.plan.v1",
      ok: true,
      courseId,
      reviewRequired: true,
      limits: { assignments: 1, questions: 0, files: 0 },
      readback: "content_and_gradebook_column",
      status: "api_configured_live_untested",
      assignment: {
        title: assignment.title,
        instructions: assignment.instructions,
        pointsPossible: assignment.points_possible,
        due: assignment.due,
      },
    });
    expect(String(plan.questionLimit)).toContain("3900.98");
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.creates()).toEqual([]);
    expect(fixture.requests().some((entry) => entry.startsWith("POST /learn/api/public/v1/courses"))).toBe(false);
  });

  it("refuses a course Blackboard does not report as Ultra, before any create request", async () => {
    const original = await harness({ ultraStatus: "Original" });
    const refused = structured(await original.call("blackboard_plan_ultra_assignment", assignment));
    expect(refused).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_operation_unavailable" } });
    expect(String((refused.problem as JsonObject).message)).toContain("Blackboard reports this course as Original.");
    expect(original.creates()).toEqual([]);
  });

  it("sends one create request per approved plan and reads back both records by the ids Blackboard returned", async () => {
    const fixture = await harness();
    const digest = await planDigestOf(fixture);
    const created = structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest)));
    expect(created).toMatchObject({
      schema: "morrow.blackboard.ultra-assignment.readback.v1",
      ok: true,
      resultState: "applied",
      courseId,
      contentId: createdContentId,
      gradebookColumnId: createdColumnId,
      verification: { title: "matched", instructions: "matched", pointsPossible: "matched", due: "matched", gradedItem: "matched" },
      readback: "content_and_gradebook_column",
      status: "api_configured_live_untested",
    });
    expect(created.assignment).toMatchObject({ id: createdContentId, title: assignment.title });
    expect(created.gradebookColumn).toMatchObject({
      id: createdColumnId, score: { possible: assignment.points_possible }, grading: { due: assignment.due },
    });

    // Exactly one create request, carrying the reviewed values.
    expect(fixture.creates()).toEqual([`POST ${createAssignmentPath}`]);
    expect(fixture.createRequests()).toEqual([{
      title: assignment.title,
      instructions: assignment.instructions,
      score: { possible: assignment.points_possible },
      grading: { due: assignment.due },
    }]);

    // The readback re-read both records by the ids the create response named.
    const after = fixture.requests().slice(fixture.requests().indexOf(`POST ${createAssignmentPath}`) + 1);
    expect(after).toContain(`GET /learn/api/public/v1/courses/${courseId}/contents/${createdContentId}`);
    expect(after).toContain(`GET ${columnsPath}/${createdColumnId}`);
  });

  it("refuses to send a second create request for one approved plan", async () => {
    const fixture = await harness();
    const digest = await planDigestOf(fixture);
    const grant = effectGrant(digest);
    expect(structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest, {}, grant))).ok).toBe(true);
    const replayed = structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest, {}, grant)));
    expect(replayed).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_patch_review_required" } });
    expect(fixture.creates()).toHaveLength(1);
  });

  it("sends nothing for a forged grant, and nothing for a request that is not the reviewed assignment", async () => {
    const fixture = await harness();
    const digest = await planDigestOf(fixture);
    const forged = applyArguments(digest);
    (forged._morrow as JsonObject).outer_grant = { ...(forged._morrow as JsonObject).outer_grant as JsonObject, dispatch_token: "d".repeat(64) };
    expect(structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", forged)))
      .toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_patch_review_required" } });

    const changed = structured(await fixture.call(
      "blackboard_apply_reviewed_ultra_assignment",
      applyArguments(digest, { title: "Week 3 lab report (revised)" }),
    ));
    expect(changed).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_patch_review_required" } });
    expect(fixture.creates()).toEqual([]);
  });

  it("reports applied_or_unknown when Blackboard names no gradebook column for the assignment it created", async () => {
    const fixture = await harness({ createWithoutColumnId: true, columnMissing: true });
    const digest = await planDigestOf(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest)));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(String((result.problem as JsonObject).message)).toContain("gradebookColumnId");
    expect(fixture.creates()).toHaveLength(1);
  });

  it("reports applied_or_unknown when Blackboard names no content item for the assignment it created", async () => {
    const fixture = await harness({ createWithoutContentId: true });
    const digest = await planDigestOf(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest)));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(String((result.problem as JsonObject).message)).toContain("contentId");
    expect(fixture.creates()).toHaveLength(1);
  });

  it("reports applied_or_unknown when the named gradebook column cannot be read back", async () => {
    const fixture = await harness({ columnMissing: true });
    const digest = await planDigestOf(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest)));
    expect(result).toMatchObject({ ok: false, resultState: "applied_or_unknown" });
    expect(fixture.creates()).toHaveLength(1);
  });

  it("reports applied_or_unknown when Blackboard names a column that was already in the course", async () => {
    const fixture = await harness({ createNamesExistingColumn: true });
    const digest = await planDigestOf(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest)));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(String((result.problem as JsonObject).message)).toContain("already in this course");
  });

  it("reports applied_or_unknown when a read-back value is not the reviewed one", async () => {
    const wrongTitle = await harness({ readbackTitle: "Week 3 lab" });
    const titleDigest = await planDigestOf(wrongTitle);
    expect(structured(await wrongTitle.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(titleDigest))))
      .toMatchObject({ ok: false, resultState: "applied_or_unknown", problem: { code: "blackboard_content_mismatch" } });
    await close?.();
    close = undefined;

    const wrongPoints = await harness({ readbackPoints: 50 });
    const pointsDigest = await planDigestOf(wrongPoints);
    const result = structured(await wrongPoints.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(pointsDigest)));
    expect(result).toMatchObject({ ok: false, resultState: "applied_or_unknown", problem: { code: "blackboard_content_mismatch" } });
    expect(String((result.problem as JsonObject).message)).toContain("points possible");
  });

  it("says it did not compare the instructions when Blackboard does not return them", async () => {
    const fixture = await harness({ readbackWithoutInstructions: true });
    const digest = await planDigestOf(fixture);
    const created = structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest)));
    expect(created).toMatchObject({
      ok: true,
      resultState: "applied",
      verification: { title: "matched", instructions: "unreported", pointsPossible: "matched", due: "matched", gradedItem: "matched" },
    });
  });

  it("reports applied_or_unknown when the gradebook column grades a different item", async () => {
    const fixture = await harness({ readbackColumnContentId: testLinkId });
    const digest = await planDigestOf(fixture);
    const result = structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest)));
    expect(result).toMatchObject({ ok: false, resultState: "applied_or_unknown", problem: { code: "blackboard_content_mismatch" } });
    expect(String((result.problem as JsonObject).message)).toContain("grades a different item");
  });

  it("says it did not compare the graded item when Blackboard names none on the column", async () => {
    const fixture = await harness({ readbackColumnContentId: "" });
    const digest = await planDigestOf(fixture);
    expect(structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest))))
      .toMatchObject({ ok: true, resultState: "applied", verification: { gradedItem: "unreported" } });
  });

  it("verifies the reviewed assignment against a fresh gradebook read", async () => {
    const fixture = await harness();
    const before = structured(await fixture.call("blackboard_verify_ultra_assignment", assignment));
    expect(before).toMatchObject({
      schema: "morrow.blackboard.ultra-assignment.comparator.v1",
      ok: true,
      verified: false,
      readback: "content_and_gradebook_column",
    });
    // A comparator returns identifiers the Gateway already holds and one
    // comparison, so it carries no diagnostics for the Gateway to compare against.
    expect(before).not.toHaveProperty("diagnostics");

    const digest = await planDigestOf(fixture);
    expect(structured(await fixture.call("blackboard_apply_reviewed_ultra_assignment", applyArguments(digest))).ok).toBe(true);
    expect(structured(await fixture.call("blackboard_verify_ultra_assignment", assignment))).toMatchObject({ verified: true });
  });
});
