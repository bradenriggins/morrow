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
const groupId = "_66_1";
const groupSetId = "_67_1";
/** The id Blackboard gives the group a reviewed create makes. */
const createdGroupId = "_69_1";
const effectSecret = Buffer.alloc(32, 9).toString("base64url");

const rosterPath = `/learn/api/public/v1/courses/${courseId}/users`;
const groupsV2Path = `/learn/api/public/v2/courses/${courseId}/groups`;
const groupsV1Path = `/learn/api/public/v1/courses/${courseId}/groups`;
const groupSetsV2Path = `${groupsV2Path}/sets`;
const groupSetsV1Path = `${groupsV1Path}/sets`;
const groupV2Path = `${groupsV2Path}/${groupId}`;
const groupV1Path = `${groupsV1Path}/${groupId}`;
const membersV2Path = `${groupsV2Path}/${groupId}/users`;
const membersV1Path = `${groupsV1Path}/${groupId}/users`;
const membersPath = membersV2Path;
const studentMembershipPath = `${membersPath}/${studentId}`;
const guestMembershipPath = `${membersPath}/${guestId}`;

/** The learner name and address that must never leave this server. */
const studentName = "Jane Doe";
const studentEmail = "jane.doe@example.edu";

/** The one reviewed group change: a new name and a group made unavailable. */
const patch = { name: "Lab team A", availability: { available: "No" } };

/** The one reviewed new group. */
const newGroup = { name: "Lab team 2", description: "The second lab team.", available: "Yes" };

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
  /** Answer every `v2` group route with 404, as a Learn site that serves only `v1`. */
  readonly legacyGroups?: boolean;
  /** Answer every group route with 404, as a site that serves no group routes. */
  readonly noGroupRoutes?: boolean;
  /** Rename the group after the first group read, as someone else would. */
  readonly groupBetweenReads?: boolean;
  /** Put another person into the group after the first membership read. */
  readonly membershipBetweenReads?: boolean;
  /** Answer the PATCH, and save none of it, as a site that did not apply the change. */
  readonly ignorePatch?: boolean;
  /** Answer the membership change, and save none of it. */
  readonly ignoreMembership?: boolean;
  /** Return the same person twice in the group, as two membership records. */
  readonly duplicateGroupMembership?: boolean;
}

async function harness(options: FixtureOptions = {}) {
  const requests: string[] = [];
  const patches: JsonObject[] = [];
  const creates: JsonObject[] = [];
  let group: JsonObject = {
    id: groupId, name: "Lab team 1", description: "The first lab team.",
    availability: { available: "Yes" }, groupSetId,
  };
  let members: readonly string[] = [studentId];
  let created: JsonObject | undefined;
  let groupReads = 0;
  let memberReads = 0;

  const groupSet: JsonObject = {
    id: groupSetId, name: "Lab teams", description: "Every lab team.", availability: { available: "Yes" },
  };

  const memberRecords = (): readonly JsonObject[] => [
    ...members.map((userId, index) => ({ id: `_gm${index + 1}_1`, groupId, userId })),
    ...(options.duplicateGroupMembership ? [{ id: "_gm90_1", groupId, userId: studentId }] : []),
  ];

  const groupList = (): readonly JsonObject[] => (created ? [group, created] : [group]);

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

    const missing = (): void => { json(response, { message: "not found" }, 404); };
    if (options.noGroupRoutes && pathname.includes("/groups")) { missing(); return; }
    const servedVersion = options.legacyGroups ? "v1" : "v2";
    const groupsHere = servedVersion === "v1" ? groupsV1Path : groupsV2Path;
    const setsHere = servedVersion === "v1" ? groupSetsV1Path : groupSetsV2Path;
    const groupHere = `${groupsHere}/${groupId}`;
    const createdHere = `${groupsHere}/${createdGroupId}`;

    if (pathname === setsHere) { json(response, { results: [groupSet], paging: {} }); return; }
    if (pathname === groupsHere && method === "POST") {
      void body(request).then((raw) => {
        const requested = JSON.parse(raw) as JsonObject;
        creates.push(requested);
        created = { id: createdGroupId, ...requested };
        json(response, created, 201);
      });
      return;
    }
    if (pathname === groupsHere) { json(response, { results: groupList(), paging: {} }); return; }
    if (pathname === groupHere && method === "PATCH") {
      void body(request).then((raw) => {
        const requested = JSON.parse(raw) as JsonObject;
        patches.push(requested);
        if (!options.ignorePatch) group = { ...group, ...requested };
        json(response, group);
      });
      return;
    }
    if (pathname === groupHere) {
      json(response, group);
      groupReads += 1;
      // Someone else renames the group after Morrow froze the plan.
      if (options.groupBetweenReads && groupReads === 1) group = { ...group, name: "Renamed in Blackboard" };
      return;
    }
    if (pathname === createdHere) { json(response, created || { message: "not found" }, created ? 200 : 404); return; }

    // Group memberships use the same current-first, legacy-fallback policy as
    // the group records around them.
    const membersHere = servedVersion === "v1" ? membersV1Path : membersV2Path;
    if (pathname === membersHere) {
      json(response, { results: memberRecords(), paging: {} });
      memberReads += 1;
      // Someone else puts another person into the group after Morrow froze the plan.
      if (options.membershipBetweenReads && memberReads === 1) members = [...members, guestId];
      return;
    }
    const membership = new RegExp(`^${membersHere}/([^/]+)$`).exec(pathname);
    if (membership && (method === "PUT" || method === "DELETE")) {
      const userId = membership[1] || "";
      if (!options.ignoreMembership) {
        members = method === "PUT"
          ? [...members.filter((member) => member !== userId), userId]
          : members.filter((member) => member !== userId);
      }
      json(response, {}, 204);
      return;
    }
    missing();
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
  const client = new Client({ name: "blackboard-groups", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
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
    patchBodies: () => [...patches],
    createBodies: () => [...creates],
    savedGroup: () => ({ ...group }),
    savedMembers: () => [...members],
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
    operationId: "op:blackboard-groups-test",
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

describe("Blackboard groups, group sets and group membership", () => {
  it("lists the groups and the group sets of the course, and records the Learn version that answered", async () => {
    const fixture = await harness();
    const groups = await fixture.call("blackboard_list_course_groups");
    expect(structured(groups)).toMatchObject({
      schema: "morrow.blackboard.course-groups.v1",
      ok: true,
      courseId,
      apiVersion: "v2",
      count: 1,
      status: "api_configured_live_untested",
    });
    expect(rows(structured(groups).groups)[0]).toMatchObject({
      id: groupId, name: "Lab team 1", availability: { available: "Yes" }, groupSetId,
    });
    expect(summary(groups)).toBe("Morrow read the groups of the selected Blackboard course.");

    const sets = structured(await fixture.call("blackboard_list_course_group_sets"));
    expect(sets).toMatchObject({ schema: "morrow.blackboard.course-group-sets.v1", ok: true, apiVersion: "v2", count: 1 });
    expect(rows(sets.groupSets)[0]).toMatchObject({ id: groupSetId, name: "Lab teams" });

    const one = structured(await fixture.call("blackboard_read_course_group", { group_id: groupId }));
    expect(one).toMatchObject({ schema: "morrow.blackboard.course-group.v1", ok: true, apiVersion: "v2", groupId });

    expect(fixture.requests()).toContain(`GET ${groupsV2Path}`);
    expect(fixture.requests()).toContain(`GET ${groupSetsV2Path}`);
    expect(fixture.requests()).not.toContain(`GET ${groupsV1Path}`);
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("falls back to the v1 group routes when the site does not answer v2, and records which answered", async () => {
    const fixture = await harness({ legacyGroups: true });
    const groups = structured(await fixture.call("blackboard_list_course_groups"));
    expect(groups).toMatchObject({ ok: true, apiVersion: "v1", count: 1 });
    expect(fixture.requests()).toContain(`GET ${groupsV2Path}`);
    expect(fixture.requests()).toContain(`GET ${groupsV1Path}`);

    const one = structured(await fixture.call("blackboard_read_course_group", { group_id: groupId }));
    expect(one).toMatchObject({ ok: true, apiVersion: "v1", groupId });
    expect(fixture.requests()).toContain(`GET ${groupV2Path}`);
    expect(fixture.requests()).toContain(`GET ${groupV1Path}`);

    const members = structured(await fixture.call("blackboard_list_group_members", { group_id: groupId }));
    expect(members).toMatchObject({ ok: true, apiVersion: "v1", groupId, count: 1 });
    expect(fixture.requests()).toContain(`GET ${membersV2Path}`);
    expect(fixture.requests()).toContain(`GET ${membersV1Path}`);
  });

  it("reports a site that answers no group route as unavailable, and names both paths it asked", async () => {
    const fixture = await harness({ noGroupRoutes: true });
    const refused = structured(await fixture.call("blackboard_list_course_groups"));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_operation_unavailable" },
    });
    const message = String(problem(refused).message);
    expect(message).toContain(groupsV2Path);
    expect(message).toContain(groupsV1Path);
    expect(message).toContain("guesses no other path");
  });

  it("tells a group this course does not hold apart from a site that serves no group routes", async () => {
    const fixture = await harness();
    const refused = structured(await fixture.call("blackboard_read_course_group", { group_id: "_99_1" }));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_content_mismatch", message: "Blackboard has no group with this id in the selected course." },
    });
    // Both versions were asked for the record, then the collection said the site
    // does serve group routes.
    expect(fixture.requests()).toContain(`GET ${groupsV2Path}/_99_1`);
    expect(fixture.requests()).toContain(`GET ${groupsV1Path}/_99_1`);
    expect(fixture.requests()).toContain(`GET ${groupsV2Path}`);
  });

  it("names everyone in a group by a protected reference and returns no learner identity", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const result = await fixture.call("blackboard_list_group_members", { group_id: groupId });
    expect(structured(result)).toMatchObject({
      schema: "morrow.blackboard.group-members.v1",
      ok: true,
      courseId,
      groupId,
      count: 1,
      status: "api_configured_live_untested",
    });
    expect(rows(structured(result).members)).toEqual([{ learnerToken: reference }]);
    expect(fixture.requests()).toContain(`GET ${membersPath}`);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(studentName);
    expect(serialized).not.toContain(studentEmail);
    expect(serialized).not.toContain(studentId);
    expect(summary(result)).toBe("Morrow read the people in one group of the selected Blackboard course.");
  });

  it("refuses a group membership Blackboard returns for one person twice", async () => {
    const fixture = await harness({ duplicateGroupMembership: true });
    const reference = await studentReference(fixture);
    const refused = structured(await fixture.call("blackboard_plan_group_membership_removal", {
      group_id: groupId, learner_reference: reference,
    }));
    expect(refused).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_membership_mismatch" } });
    expect(String(problem(refused).message)).toContain("more than one membership of this group");
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("refuses a Blackboard user id in place of a protected learner reference, and sends nothing", async () => {
    const fixture = await harness();
    for (const name of ["blackboard_plan_group_membership", "blackboard_plan_group_membership_removal"]) {
      const refused = structured(await fixture.call(name, { group_id: groupId, learner_reference: studentId }));
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

  it("creates one group with exactly one POST and reads it back by the id Blackboard returned", async () => {
    const fixture = await harness();
    const plan = structured(await fixture.call("blackboard_plan_course_group", newGroup));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.course-group.plan.v1",
      ok: true,
      courseId,
      apiVersion: "v2",
      group: { name: newGroup.name, description: newGroup.description, available: "Yes" },
      reviewRequired: true,
      limits: { groups: 1, members: 0, learnersNamed: 0 },
      readback: "reviewed_fields",
      status: "api_configured_live_untested",
    });
    expect(String(plan.planDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(plan.deletionHeld)).toContain("does not delete a Blackboard group");
    expect(plan.effect_scope).toMatchObject({ provider: "blackboard" });
    expect(fixture.writeRequests()).toEqual([]);

    const result = await fixture.call(
      "blackboard_apply_reviewed_course_group",
      applyArguments(newGroup, String(plan.planDigest)),
    );
    expect(structured(result)).toMatchObject({
      schema: "morrow.blackboard.course-group.readback.v1",
      ok: true,
      resultState: "applied",
      groupId: createdGroupId,
      group: { id: createdGroupId, name: newGroup.name, description: newGroup.description, availability: { available: "Yes" } },
      readback: "reviewed_fields",
    });
    expect(fixture.writeRequests()).toEqual([`POST ${groupsV2Path}`]);
    expect(fixture.createBodies()).toEqual([
      { name: newGroup.name, description: newGroup.description, availability: { available: "Yes" } },
    ]);
    // The created group was re-read by the id Blackboard returned.
    expect(fixture.requests()).toContain(`GET ${groupsV2Path}/${createdGroupId}`);

    const verified = structured(await fixture.call("blackboard_verify_course_group", newGroup));
    expect(verified).toMatchObject({ schema: "morrow.blackboard.course-group.comparator.v1", ok: true, verified: true });
    expect(verified).not.toHaveProperty("diagnostics");
  });

  it("refuses a group named after a person on the course roster, before any request is planned", async () => {
    const fixture = await harness();
    const refused = structured(await fixture.call("blackboard_plan_course_group", {
      name: `${studentName} study group`, available: "Yes",
    }));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_operation_unavailable" },
    });
    expect(String(problem(refused).message)).toContain("names a person enrolled in the selected Blackboard course");
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("sends exactly one PATCH for a reviewed group change and reads the saved values back", async () => {
    const fixture = await harness();
    const planned = { group_id: groupId, patch };
    const plan = structured(await fixture.call("blackboard_plan_course_group_patch", planned));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.course-group-patch.plan.v1",
      ok: true,
      apiVersion: "v2",
      groupId,
      before: { id: groupId, name: "Lab team 1", availability: { available: "Yes" } },
      patch,
      limits: { fields: ["name", "description", "availability.available"], groups: 1 },
      readback: "protected_fields",
    });
    expect(String(plan.beforeDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.writeRequests()).toEqual([]);

    const result = await fixture.call(
      "blackboard_apply_reviewed_course_group_patch",
      applyArguments(planned, String(plan.planDigest)),
    );
    expect(structured(result)).toMatchObject({
      schema: "morrow.blackboard.course-group-patch.readback.v1",
      ok: true,
      resultState: "applied",
      groupId,
      group: { id: groupId, name: "Lab team A", availability: { available: "No" } },
      readback: "protected_fields",
    });
    expect(fixture.writeRequests()).toEqual([`PATCH ${groupV2Path}`]);
    expect(fixture.patchBodies()).toEqual([patch]);
    expect(fixture.savedGroup()).toMatchObject({ name: "Lab team A", availability: { available: "No" } });

    const verified = structured(await fixture.call("blackboard_verify_course_group_patch", planned));
    expect(verified).toMatchObject({ schema: "morrow.blackboard.course-group-patch.comparator.v1", ok: true, verified: true });
    expect(verified).not.toHaveProperty("diagnostics");
  });

  it("refuses a group changed between the plan and the dispatch, and sends no PATCH", async () => {
    const fixture = await harness({ groupBetweenReads: true });
    const planned = { group_id: groupId, patch };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_group_patch", planned);
    const refused = structured(await fixture.call(
      "blackboard_apply_reviewed_course_group_patch",
      applyArguments(planned, planDigest),
    ));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: {
        code: "blackboard_content_mismatch",
        message: "The Blackboard group Morrow read does not match the reviewed plan. It changed after review, or this request names a different group. The change was not sent.",
      },
    });
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("reports applied_or_unknown when the saved group is not the reviewed one", async () => {
    const fixture = await harness({ ignorePatch: true });
    const planned = { group_id: groupId, patch };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_course_group_patch", planned);
    const result = structured(await fixture.call(
      "blackboard_apply_reviewed_course_group_patch",
      applyArguments(planned, planDigest),
    ));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: {
        code: "blackboard_content_mismatch",
        message: "Blackboard did not return every reviewed and protected group value after the change.",
      },
    });
    expect(fixture.writeRequests()).toEqual([`PATCH ${groupV2Path}`]);

    const verified = structured(await fixture.call("blackboard_verify_course_group_patch", planned));
    expect(verified).toMatchObject({ ok: true, verified: false });
  });

  it("refuses a group change to anything but the name, the description and availability", async () => {
    const fixture = await harness();
    const refused = structured(await fixture.call("blackboard_plan_course_group_patch", {
      group_id: groupId, patch: { groupSetId: "_67_1" },
    }));
    expect(refused).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_response_invalid" } });
    expect(String(problem(refused).message)).toContain("does not delete a Blackboard group or a group set");
    expect(fixture.requests()).toEqual([]);
  });

  it("sends exactly one PUT to put a person into a group, and re-reads the group and its membership", async () => {
    const fixture = await harness();
    const reference = await referenceFor(fixture, "Guest");
    const planned = { group_id: groupId, learner_reference: reference };
    const plan = structured(await fixture.call("blackboard_plan_group_membership", planned));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.group-membership.plan.v1",
      ok: true,
      apiVersion: "v2",
      groupId,
      action: "add",
      learnerToken: reference,
      before: { group: { id: groupId }, count: 1 },
      limits: { groups: 1, people: 1 },
      readback: "protected_fields",
    });
    expect(fixture.writeRequests()).toEqual([]);

    const before = fixture.requests().length;
    const result = await fixture.call(
      "blackboard_apply_reviewed_group_membership",
      applyArguments(planned, String(plan.planDigest)),
    );
    expect(structured(result)).toMatchObject({
      schema: "morrow.blackboard.group-membership.readback.v1",
      ok: true,
      resultState: "applied",
      groupId,
      action: "add",
      learnerToken: reference,
      group: { id: groupId, name: "Lab team 1" },
      count: 2,
    });
    expect(fixture.writeRequests()).toEqual([`PUT ${guestMembershipPath}`]);
    expect(fixture.savedMembers()).toEqual([studentId, guestId]);

    // The readback re-read the group itself and everyone in it.
    const afterDispatch = fixture.requests().slice(before);
    const sent = afterDispatch.indexOf(`PUT ${guestMembershipPath}`);
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(afterDispatch.slice(sent)).toContain(`GET ${groupV2Path}`);
    expect(afterDispatch.slice(sent)).toContain(`GET ${membersPath}`);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(studentName);
    expect(serialized).not.toContain(guestId);

    const verified = structured(await fixture.call("blackboard_verify_group_membership", planned));
    expect(verified).toMatchObject({
      schema: "morrow.blackboard.group-membership.comparator.v1",
      ok: true,
      groupId,
      learnerToken: reference,
      verified: true,
    });
    expect(verified).not.toHaveProperty("diagnostics");
  });

  it("refuses a group membership changed between the plan and the dispatch, and sends nothing", async () => {
    const fixture = await harness({ membershipBetweenReads: true });
    const reference = await studentReference(fixture);
    const planned = { group_id: groupId, learner_reference: reference };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_group_membership_removal", planned);
    const refused = structured(await fixture.call(
      "blackboard_apply_reviewed_group_membership_removal",
      applyArguments(planned, planDigest),
    ));
    expect(refused).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: {
        code: "blackboard_content_mismatch",
        message: "The Blackboard group Morrow read does not match the reviewed plan. Who is in it changed after review, the group itself changed, or this request names a different person or group. The change was not sent.",
      },
    });
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("refuses a dispatch that names another person than the reviewed plan, and sends nothing", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const other = await referenceFor(fixture, "Guest");
    const planDigest = await planDigestOf(fixture, "blackboard_plan_group_membership_removal", {
      group_id: groupId, learner_reference: reference,
    });
    const refused = structured(await fixture.call(
      "blackboard_apply_reviewed_group_membership_removal",
      applyArguments({ group_id: groupId, learner_reference: other }, planDigest),
    ));
    expect(refused).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_membership_mismatch" } });
    expect(String(problem(refused).message)).toContain("not in the selected Blackboard group");
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("sends exactly one DELETE to take a person out of a group, and re-reads the group and its membership", async () => {
    const fixture = await harness();
    const reference = await studentReference(fixture);
    const planned = { group_id: groupId, learner_reference: reference };
    const plan = structured(await fixture.call("blackboard_plan_group_membership_removal", planned));
    expect(plan).toMatchObject({
      schema: "morrow.blackboard.group-membership-removal.plan.v1",
      ok: true,
      groupId,
      action: "remove",
      before: { count: 1 },
    });
    expect(rows(isJsonObject(plan.before) ? plan.before.members : [])).toEqual([{ learnerToken: reference }]);
    expect(fixture.writeRequests()).toEqual([]);

    const result = structured(await fixture.call(
      "blackboard_apply_reviewed_group_membership_removal",
      applyArguments(planned, String(plan.planDigest)),
    ));
    expect(result).toMatchObject({
      schema: "morrow.blackboard.group-membership-removal.readback.v1",
      ok: true,
      resultState: "applied",
      action: "remove",
      group: { id: groupId },
      count: 0,
    });
    expect(fixture.writeRequests()).toEqual([`DELETE ${studentMembershipPath}`]);
    expect(fixture.savedMembers()).toEqual([]);
    expect(fixture.requests().filter((entry) => entry === `GET ${membersPath}`).length).toBeGreaterThanOrEqual(2);

    const verified = structured(await fixture.call("blackboard_verify_group_membership_removal", planned));
    expect(verified).toMatchObject({
      schema: "morrow.blackboard.group-membership-removal.comparator.v1",
      ok: true,
      verified: true,
    });
  });

  it("refuses adding a person who is already in the group and removing one who is not", async () => {
    const fixture = await harness();
    const enrolled = await studentReference(fixture);
    const outside = await referenceFor(fixture, "Guest");
    const alreadyIn = structured(await fixture.call("blackboard_plan_group_membership", {
      group_id: groupId, learner_reference: enrolled,
    }));
    expect(alreadyIn).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_membership_mismatch" } });
    expect(String(problem(alreadyIn).message)).toContain("already in the selected Blackboard group");

    const notIn = structured(await fixture.call("blackboard_plan_group_membership_removal", {
      group_id: groupId, learner_reference: outside,
    }));
    expect(notIn).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "blackboard_membership_mismatch" } });
    expect(String(problem(notIn).message)).toContain("not in the selected Blackboard group");
    expect(fixture.writeRequests()).toEqual([]);
  });

  it("sends nothing for a replayed grant", async () => {
    const fixture = await harness();
    const reference = await referenceFor(fixture, "Guest");
    const planned = { group_id: groupId, learner_reference: reference };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_group_membership", planned);
    const grant = grantArguments(effectGrant(planDigest));
    expect(structured(await fixture.call(
      "blackboard_apply_reviewed_group_membership",
      applyArguments(planned, planDigest, grant),
    )).ok).toBe(true);
    const sent = fixture.writeRequests();

    const replay = structured(await fixture.call(
      "blackboard_apply_reviewed_group_membership",
      applyArguments(planned, planDigest, grant),
    ));
    expect(replay).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_patch_review_required", message: "This Blackboard effect grant was already dispatched, and Morrow sent that change to Blackboard. It sent nothing now." },
    });
    expect(fixture.writeRequests()).toEqual(sent);
  });

  it("reports applied_or_unknown when the group membership Blackboard returns is not the reviewed one", async () => {
    const fixture = await harness({ ignoreMembership: true });
    const reference = await referenceFor(fixture, "Guest");
    const planned = { group_id: groupId, learner_reference: reference };
    const planDigest = await planDigestOf(fixture, "blackboard_plan_group_membership", planned);
    const result = structured(await fixture.call(
      "blackboard_apply_reviewed_group_membership",
      applyArguments(planned, planDigest),
    ));
    expect(result).toMatchObject({
      ok: false,
      resultState: "applied_or_unknown",
      problem: { code: "blackboard_content_mismatch" },
    });
    expect(String(problem(result).message)).toContain("only this person added");
    expect(fixture.writeRequests()).toEqual([`PUT ${guestMembershipPath}`]);

    const verified = structured(await fixture.call("blackboard_verify_group_membership", planned));
    expect(verified).toMatchObject({ ok: true, verified: false });
  });
});
