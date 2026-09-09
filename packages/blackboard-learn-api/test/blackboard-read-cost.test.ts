import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { BlackboardLearnRuntime } from "../src/runtime.js";
import type { BlackboardTenant } from "../src/types.js";

const courseId = "_22_1";
const contentId = "_33_1";
const principalId = "_11_1";
const studentId = "_44_1";

/** Each provider request this lane counts, written the way the fixture logs it. */
const TOKEN = "POST /learn/api/public/v1/oauth2/token";
const ACCOUNT = "GET /learn/api/public/v1/users/me";
const PRINCIPAL = `GET /learn/api/public/v1/users/${principalId}`;
const PRINCIPAL_MEMBERSHIP = `GET /learn/api/public/v1/courses/${courseId}/users/${principalId}`;
const ROSTER = `GET /learn/api/public/v1/courses/${courseId}/users`;
const COURSE = `GET /learn/api/public/v3/courses/${courseId}`;
const CONTENTS = `GET /learn/api/public/v1/courses/${courseId}/contents`;
const COURSE_CHANGE_CHECK = `GET /learn/api/public/v3/courses/${courseId}`;
const CONTENT = `GET /learn/api/public/v1/courses/${courseId}/contents/${contentId}`;

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await close?.();
  close = undefined;
});

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function diagnostics(result: JsonObject): JsonObject {
  if (!isJsonObject(result.diagnostics)) throw new Error("The Blackboard result reported no provider cost.");
  return result.diagnostics;
}

/**
 * One local Blackboard fixture that records every request it answers, because
 * what this lane proves is how many provider requests one Morrow call costs.
 */
async function harness(options: { readonly tokenLifetime?: number } = {}) {
  const requests: string[] = [];
  const content: JsonObject = {
    id: contentId,
    courseId,
    contentHandler: { id: "resource/x-bb-document" },
    title: "Welcome Jane Doe",
    description: "Jane Doe posts her questions here.",
    availability: { available: "Yes" },
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "http://fixture").pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      json(response, { access_token: "temporary-token", expires_in: options.tokenLifetime || 3600 }); return;
    }
    if (pathname === "/learn/api/public/v1/users/me") { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/users/${principalId}`) { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/users/${principalId}`) {
      json(response, { id: "_membership_1", courseId, userId: principalId }); return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/users`) {
      json(response, { results: [{
        id: "_membership_2", courseId, userId: studentId, courseRoleId: "Student", availability: { available: "Yes" },
        user: { id: studentId, name: { given: "Jane", family: "Doe" }, contact: { email: "jane.doe@example.edu" }, userName: "jane.doe" },
      }], paging: {} }); return;
    }
    if (pathname === `/learn/api/public/v3/courses/${courseId}`) {
      json(response, { id: courseId, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false }); return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}`) { json(response, { id: courseId, name: "Biology" }); return; }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/contents`) {
      json(response, { results: [content], paging: {} }); return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/contents/${contentId}`) { json(response, content); return; }
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
  const runtime = new BlackboardLearnRuntime([tenant]);
  close = async () => { await new Promise<void>((resolve) => server.close(() => resolve())); };
  const scope = { tenantId: "fixture", sourceBindingId: binding, courseId };
  return {
    requests: () => [...requests],
    /** Start a new count, so the next call's requests stand on their own. */
    clear: () => { requests.length = 0; },
    readCourse: () => runtime.readCourse(scope),
    listContents: () => runtime.listContents(scope),
    readContent: () => runtime.readContent({ ...scope, contentId }),
    rosterSummary: () => runtime.rosterSummary(scope),
    plan: (patch: JsonObject) => runtime.planContentPatch({ ...scope, contentId, patch }),
    verify: (patch: JsonObject) => runtime.verifyContentPatch({ ...scope, contentId, patch }),
  };
}

describe("Blackboard read cost", () => {
  it("costs six provider requests for the first content read and three for the next one", async () => {
    const fixture = await harness();
    const first = await fixture.readContent();
    expect(first).toMatchObject({ ok: true, contentId });
    // The first read pays for the credential, the account, the account's course
    // membership, and the roster it will redact this course's text against.
    expect(fixture.requests()).toEqual([TOKEN, ACCOUNT, PRINCIPAL, PRINCIPAL_MEMBERSHIP, ROSTER, CONTENT]);
    expect(diagnostics(first)).toEqual({ providerRequests: 6 });

    fixture.clear();
    const second = await fixture.readContent();
    // The fresh account and course-membership check stays. The roster does not
    // repeat: one content read costs at most three provider requests.
    expect(fixture.requests()).toEqual([PRINCIPAL, PRINCIPAL_MEMBERSHIP, CONTENT]);
    expect(diagnostics(second)).toEqual({ providerRequests: 3 });

    // The held roster still redacts: the learner leaves as a protected token.
    const serialized = JSON.stringify(second);
    expect(serialized).not.toContain("Jane");
    expect(serialized).not.toContain("jane.doe@example.edu");
    expect(serialized).toContain("Student A");
  });

  it("reads the course roster once for a listing and the item reads that follow it", async () => {
    const fixture = await harness();
    const listed = await fixture.listContents();
    const item = await fixture.readContent();
    const course = await fixture.readCourse();
    expect(listed).toMatchObject({ ok: true, count: 1 });
    // One roster read carries all three reads. Each read still makes its own
    // account and course-membership check.
    expect(fixture.requests()).toEqual([
      TOKEN, ACCOUNT, PRINCIPAL, PRINCIPAL_MEMBERSHIP, ROSTER, CONTENTS,
      PRINCIPAL, PRINCIPAL_MEMBERSHIP, CONTENT,
      PRINCIPAL, PRINCIPAL_MEMBERSHIP, COURSE,
    ]);
    expect(fixture.requests().filter((entry) => entry === ROSTER)).toEqual([ROSTER]);
    expect(diagnostics(listed)).toEqual({ providerRequests: 6 });
    expect(diagnostics(item)).toEqual({ providerRequests: 3 });
    expect(diagnostics(course)).toEqual({ providerRequests: 3 });
    for (const result of [listed, item, course]) {
      expect(JSON.stringify(result)).not.toContain("Jane");
    }
  });

  it("verifies a reviewed patch from the item alone, with no roster and no course-membership read", async () => {
    const fixture = await harness();
    const verified = await fixture.verify({ title: "Welcome Jane Doe" });
    // The account read is what binds this credential to the configured
    // integration account. Nothing else about the course is read.
    expect(fixture.requests()).toEqual([TOKEN, ACCOUNT, CONTENT]);
    expect(fixture.requests().filter((entry) => entry !== TOKEN)).toHaveLength(2);
    expect(fixture.requests()).not.toContain(ROSTER);
    expect(fixture.requests()).not.toContain(PRINCIPAL);
    expect(fixture.requests()).not.toContain(PRINCIPAL_MEMBERSHIP);
    // The Gateway freezes this exact payload when it plans the operation and
    // compares the whole result against that digest, so it carries no
    // diagnostics and no other new field.
    expect(Object.keys(verified).sort()).toEqual([
      "contentId", "courseId", "ok", "schema", "sourceBindingId", "status", "tenantId", "verified",
    ]);
    expect(verified).toMatchObject({ ok: true, verified: true });
    // The compared title carries a learner name and the result still holds none:
    // this route returns one boolean, so it has nothing to redact.
    expect(JSON.stringify(verified)).not.toContain("Jane");

    fixture.clear();
    const again = await fixture.verify({ title: "A different reviewed title" });
    expect(fixture.requests()).toEqual([CONTENT]);
    expect(again).toMatchObject({ ok: true, verified: false });
  });

  it("reads the roster again for a roster summary", async () => {
    const fixture = await harness();
    await fixture.readCourse();
    fixture.clear();
    const summary = await fixture.rosterSummary();
    expect(fixture.requests()).toEqual([PRINCIPAL, PRINCIPAL_MEMBERSHIP, ROSTER]);
    expect(diagnostics(summary)).toEqual({ providerRequests: 3 });
    expect(summary).toMatchObject({ ok: true, count: 1 });
    const learners = Array.isArray(summary.learners) ? summary.learners : [];
    expect(learners.map((learner) => (isJsonObject(learner) ? learner.courseRoleId : undefined))).toEqual(["Student"]);
    expect(JSON.stringify(summary)).not.toContain("Jane");
  });

  it("reads the roster again for a change plan", async () => {
    const fixture = await harness();
    await fixture.readContent();
    fixture.clear();
    const plan = await fixture.plan({ title: "Reviewed title" });
    // A plan is reviewed and then dispatched, so it reads the roster inside its
    // own operation rather than reusing the one a read left behind.
    expect(fixture.requests()).toEqual([PRINCIPAL, PRINCIPAL_MEMBERSHIP, ROSTER, COURSE_CHANGE_CHECK, CONTENT]);
    expect(plan).toMatchObject({ schema: "morrow.blackboard.content-patch.plan.v1", reviewRequired: true });
    expect(JSON.stringify(plan)).not.toContain("Jane");
  });

  it("does not reuse a held roster past its bound", async () => {
    const fixture = await harness();
    await fixture.readContent();
    fixture.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      const stale = await fixture.readContent();
      expect(fixture.requests()).toEqual([PRINCIPAL, PRINCIPAL_MEMBERSHIP, ROSTER, CONTENT]);
      expect(diagnostics(stale)).toEqual({ providerRequests: 4 });
      expect(JSON.stringify(stale)).not.toContain("Jane");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reuse a held roster after the credential changed", async () => {
    // A one-second token forces a new access token before each request, which
    // is what a live Blackboard token expiry does between two reads.
    const fixture = await harness({ tokenLifetime: 1 });
    await fixture.readContent();
    fixture.clear();
    const afterNewToken = await fixture.readContent();
    expect(fixture.requests().filter((entry) => entry === ROSTER)).toEqual([ROSTER]);
    expect(JSON.stringify(afterNewToken)).not.toContain("Jane");
  });
});
