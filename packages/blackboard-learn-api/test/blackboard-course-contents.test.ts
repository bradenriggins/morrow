import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../src/binding.js";
import { BlackboardLearnRuntime } from "../src/runtime.js";
import { createBlackboardLearnMcpServer } from "../src/server.js";
import type { BlackboardTenant } from "../src/types.js";

const courseId = "_22_1";
const otherCourseId = "_23_1";
const principalId = "_11_1";
const studentId = "_44_1";
const folderId = "_100_1";
const documentId = "_101_1";
const deepRootId = "_201_1";
const deepestReadId = "_204_1";
const contentsPath = `/learn/api/public/v1/courses/${courseId}/contents`;
const coursesPath = `/learn/api/public/v1/users/${principalId}/courses`;
const CONTENT_FIELDS = "id,parentId,title,description,body,position,availability,contentHandler,hasChildren";
const STRUCTURE_FIELDS = "id,parentId,title,position,availability,contentHandler,hasChildren";
const COURSE_FIELDS = "id,courseId,name,ultraStatus,closedComplete,availability";

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

function rows(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value) || value.some((entry) => !isJsonObject(entry))) {
    throw new Error("The Blackboard result did not carry a list of records.");
  }
  return value as readonly JsonObject[];
}

function contentItem(id: string, title: string, position: number, parentId?: string): JsonObject {
  return {
    id,
    ...(parentId ? { parentId } : {}),
    title,
    position,
    hasChildren: false,
    contentHandler: { id: "resource/x-bb-document" },
    availability: { available: "Yes" },
  };
}

function folderItem(id: string, title: string, position: number, parentId?: string): JsonObject {
  return { ...contentItem(id, title, position, parentId), hasChildren: true, contentHandler: { id: "resource/x-bb-folder" } };
}

/** One membership of the configured account, with the course record Blackboard expands into it. */
function membership(id: string, course: JsonObject): JsonObject {
  return { id, userId: principalId, courseId: course.id, courseRoleId: "Instructor", course };
}

const boundCourse: JsonObject = {
  id: courseId, courseId: "BIO-101", name: "Biology with Jane Doe", ultraStatus: "Ultra", availability: { available: "Yes" },
};
const unboundCourse: JsonObject = {
  id: otherCourseId, courseId: "CHM-101", name: "Chemistry", ultraStatus: "Original", availability: { available: "No" },
};

interface FixtureOptions {
  readonly tree?: "two-level" | "wide" | "deep";
  /** Answer this one item's children read with this status instead of a list. */
  readonly childrenStatus?: { readonly parentId: string; readonly status: number };
  /** Answer a children read with a next page on another origin. */
  readonly offOriginChildrenNextPage?: boolean;
  /** Answer the v3 course read the way a Learn version that does not serve it does. */
  readonly v3Missing?: boolean;
  readonly memberships?: readonly JsonObject[];
}

/** The content tree one fixture serves: the top level, and the children of each item. */
function contentTree(shape: FixtureOptions["tree"] = "two-level"): { readonly root: readonly JsonObject[]; readonly children: ReadonlyMap<string, readonly JsonObject[]> } {
  const children = new Map<string, readonly JsonObject[]>();
  if (shape === "wide") {
    const root = Array.from({ length: 250 }, (_, index) => contentItem(`_${300 + index}_1`, `Item ${index + 1}`, index + 1));
    return { root, children };
  }
  if (shape === "deep") {
    const chain = ["_201_1", "_202_1", "_203_1", "_204_1", "_205_1"];
    chain.forEach((id, index) => {
      const child = chain[index + 1];
      if (!child) return;
      children.set(id, [folderItem(child, `Level ${index + 2}`, 1, id)]);
    });
    return { root: [folderItem(deepRootId, "Level 1", 1)], children };
  }
  children.set(folderId, [
    contentItem("_110_1", "Week 1", 1, folderId),
    contentItem("_111_1", "Week 2", 2, folderId),
  ]);
  return { root: [folderItem(folderId, "Module 1 with Jane Doe", 1), contentItem(documentId, "Syllabus", 2)], children };
}

async function harness(options: FixtureOptions = {}) {
  const requests: string[] = [];
  const queries = new Map<string, string>();
  const tree = contentTree(options.tree);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://fixture");
    const pathname = url.pathname;
    requests.push(`${request.method} ${pathname}`);
    queries.set(pathname, url.search);
    if (pathname === "/learn/api/public/v1/oauth2/token") { json(response, { access_token: "temporary-token", expires_in: 3600 }); return; }
    if (pathname === "/learn/api/public/v1/users/me") { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/users/${principalId}`) { json(response, { id: principalId }); return; }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/users/${principalId}`) {
      json(response, { id: "_m10_1", courseId, userId: principalId }); return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}/users`) { json(response, { results: roster, paging: {} }); return; }
    if (pathname === coursesPath) {
      json(response, { results: options.memberships || [membership("_m20_1", boundCourse), membership("_m21_1", unboundCourse)], paging: {} });
      return;
    }
    if (pathname === `/learn/api/public/v3/courses/${courseId}`) {
      if (options.v3Missing) { json(response, { message: "not found" }, 404); return; }
      json(response, { id: courseId, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false, availability: { available: "Yes" } });
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${courseId}`) {
      json(response, { id: courseId, courseId: "BIO-101", name: "Biology", availability: { available: "Yes" } }); return;
    }
    if (pathname === contentsPath) { json(response, { results: tree.root, paging: {} }); return; }
    const child = /^\/learn\/api\/public\/v1\/courses\/([^/]+)\/contents\/([^/]+)\/children$/.exec(pathname);
    if (child && child[1] === courseId) {
      const parentId = child[2]!;
      if (options.childrenStatus?.parentId === parentId) { json(response, { message: "refused" }, options.childrenStatus.status); return; }
      json(response, {
        results: tree.children.get(parentId) || [],
        paging: options.offOriginChildrenNextPage
          ? { nextPage: `https://outside.example/learn/api/public/v1/courses/${courseId}/contents/${parentId}/children` }
          : {},
      });
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
  const runtime = new BlackboardLearnRuntime([tenant]);
  const client = new Client({ name: "blackboard-course-contents", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const running = serveStdio(() => createBlackboardLearnMcpServer(runtime), { transport: right });
  await client.connect(left);
  close = async () => {
    await client.close();
    await running.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const scope = { tenant_id: "fixture", source_binding_id: binding, course_id: courseId };
  return {
    binding,
    requests: () => [...requests],
    query: (path: string) => queries.get(path) || "",
    call: (name: string, args: JsonObject = scope) => client.callTool({ name, arguments: { ...scope, ...args } }),
  };
}

describe("Blackboard course and content-tree reads", () => {
  it("reads one level of children and maps a two-level tree, with one level pinned on every listing", async () => {
    const fixture = await harness();
    const children = structured(await fixture.call("blackboard_list_content_children", { content_id: folderId }));
    expect(children).toMatchObject({
      ok: true,
      courseId,
      contentId: folderId,
      count: 2,
      status: "api_configured_live_untested",
    });
    expect(rows(children.children).map((entry) => entry.id)).toEqual(["_110_1", "_111_1"]);
    expect(rows(children.children)[0]).toMatchObject({
      id: "_110_1", parentId: folderId, title: "Week 1", position: 1, hasChildren: false,
      contentHandler: { id: "resource/x-bb-document" },
    });
    const childrenQuery = fixture.query(`/learn/api/public/v1/courses/${courseId}/contents/${folderId}/children`);
    expect(childrenQuery).toContain("recursive=false");
    expect(childrenQuery).toContain(`fields=${encodeURIComponent(CONTENT_FIELDS)}`);

    const inventory = structured(await fixture.call("blackboard_inventory_course_contents"));
    expect(inventory).toMatchObject({
      ok: true, courseId, count: 4, complete: true, unread: [], limits: { maxItems: 200, maxDepth: 4 },
    });
    expect(rows(inventory.items).map((entry) => [entry.id, entry.depth])).toEqual([
      [folderId, 1], [documentId, 1], ["_110_1", 2], ["_111_1", 2],
    ]);
    // The inventory maps the course. It asks for structure, not item text.
    expect(fixture.query(contentsPath)).toContain(`fields=${encodeURIComponent(STRUCTURE_FIELDS)}`);
    expect(fixture.query(contentsPath)).toContain("recursive=false");

    // The existing course-content listing carries the same one-level pin.
    structured(await fixture.call("blackboard_list_course_contents"));
    expect(fixture.query(contentsPath)).toContain(`fields=${encodeURIComponent(CONTENT_FIELDS)}`);
  });

  it("returns no roster name or e-mail address in a serialized tree or course list", async () => {
    const fixture = await harness();
    const inventory = await fixture.call("blackboard_inventory_course_contents");
    const inventoryText = JSON.stringify(inventory);
    expect(inventoryText).not.toContain("Jane Doe");
    expect(inventoryText).not.toContain("jane.doe@example.edu");
    expect(inventoryText).not.toContain("Ada Byron");
    expect(inventoryText).toContain("Module 1 with");
    expect(inventoryText).toContain("Syllabus");

    const courses = await fixture.call("blackboard_list_my_courses");
    const coursesText = JSON.stringify(courses);
    expect(coursesText).not.toContain("Jane Doe");
    expect(coursesText).not.toContain("jane.doe@example.edu");
    expect(coursesText).toContain("Biology with");
  });

  it("stops the inventory at the item ceiling and names every item it did not read", async () => {
    const fixture = await harness({ tree: "wide" });
    const result = await fixture.call("blackboard_inventory_course_contents");
    const inventory = structured(result);
    expect(inventory).toMatchObject({ ok: true, count: 200, complete: false });
    const unread = rows(inventory.unread);
    expect(unread).toHaveLength(50);
    expect(unread[0]).toMatchObject({ id: "_500_1", depth: 1, reason: "item_ceiling" });
    expect(unread[0]?.detail).toContain("stopped this inventory at 200 items");
    expect(rows(inventory.items)).toHaveLength(200);
    // The text an assistant reads never reports a partial map as the whole course.
    expect(summary(result)).toBe("Morrow mapped part of the content of the selected Blackboard course. The result names every item it did not read.");
  });

  it("stops the inventory at the depth ceiling and names the item it did not open", async () => {
    const fixture = await harness({ tree: "deep" });
    const inventory = structured(await fixture.call("blackboard_inventory_course_contents"));
    expect(inventory).toMatchObject({ ok: true, count: 4, complete: false });
    expect(rows(inventory.items).map((entry) => entry.depth)).toEqual([1, 2, 3, 4]);
    expect(rows(inventory.unread)).toEqual([{
      id: deepestReadId,
      depth: 5,
      reason: "depth_ceiling",
      detail: "Morrow reads 4 levels of a Blackboard course, so it did not read what is inside this item.",
    }]);
  });

  it("records one item whose children Blackboard refused, and keeps reading the rest", async () => {
    const fixture = await harness({ childrenStatus: { parentId: folderId, status: 403 } });
    const inventory = structured(await fixture.call("blackboard_inventory_course_contents"));
    expect(inventory).toMatchObject({ ok: true, count: 2, complete: false });
    expect(rows(inventory.items).map((entry) => entry.id)).toEqual([folderId, documentId]);
    expect(rows(inventory.unread)[0]).toMatchObject({ id: folderId, depth: 2, reason: "children_unread" });
    expect(String(rows(inventory.unread)[0]?.detail)).toContain("HTTP 403");
  });

  it("refuses a course outside the configured connection without sending a Blackboard request", async () => {
    const fixture = await harness();
    const otherCourse = structured(await fixture.call("blackboard_inventory_course_contents", { course_id: otherCourseId }));
    expect(otherCourse).toMatchObject({
      ok: false, resultState: "not_sent", problem: { code: "blackboard_scope_binding_mismatch" },
    });
    const otherBinding = structured(await fixture.call("blackboard_list_content_children", {
      source_binding_id: "blackboard:0000", content_id: folderId,
    }));
    expect(otherBinding).toMatchObject({ ok: false, problem: { code: "blackboard_scope_binding_mismatch" } });
    const otherTenant = structured(await fixture.call("blackboard_get_course_availability", { tenant_id: "other" }));
    expect(otherTenant).toMatchObject({ ok: false, problem: { code: "blackboard_scope_binding_required" } });
    expect(fixture.requests()).toEqual([]);
  });

  it("refuses a next page outside this tenant instead of recording it as one unread item", async () => {
    const fixture = await harness({ offOriginChildrenNextPage: true });
    const children = structured(await fixture.call("blackboard_list_content_children", { content_id: folderId }));
    expect(children).toMatchObject({
      ok: false, resultState: "not_sent", problem: { code: "blackboard_pagination_refused" },
    });
    const inventory = structured(await fixture.call("blackboard_inventory_course_contents"));
    expect(inventory).toMatchObject({ ok: false, problem: { code: "blackboard_pagination_refused" } });
    expect(inventory.items).toBeUndefined();
  });

  it("lists the integration account's courses and marks the one this installation is connected to", async () => {
    const fixture = await harness();
    const result = structured(await fixture.call("blackboard_list_my_courses"));
    expect(result).toMatchObject({ ok: true, count: 2, complete: true, unread: [] });
    const courses = rows(result.courses);
    expect(courses[0]).toMatchObject({
      id: courseId, courseId: "BIO-101", ultraStatus: "Ultra", availability: { available: "Yes" },
      connected: true, sourceBindingId: fixture.binding,
    });
    expect(courses[1]).toMatchObject({ id: otherCourseId, courseId: "CHM-101", ultraStatus: "Original", connected: false });
    expect(courses[1]?.sourceBindingId).toBeUndefined();
    expect(fixture.query(coursesPath)).toContain("expand=course");
  });

  it("leaves out a membership with no course record and refuses one that names another account", async () => {
    const partial = await harness({
      memberships: [membership("_m20_1", boundCourse), { id: "_m22_1", userId: principalId, courseId: otherCourseId }],
    });
    const result = structured(await partial.call("blackboard_list_my_courses"));
    expect(result).toMatchObject({ ok: true, count: 1, complete: false });
    expect(rows(result.unread)).toEqual([{
      id: otherCourseId,
      reason: "course_unread",
      detail: "Blackboard did not return this membership's own course record, so Morrow left the course out of this list.",
    }]);
    await close?.(); close = undefined;

    const foreign = await harness({
      memberships: [{ id: "_m23_1", userId: studentId, courseId: otherCourseId, course: unboundCourse }],
    });
    expect(structured(await foreign.call("blackboard_list_my_courses"))).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "blackboard_scope_binding_mismatch" },
    });
  });

  it("reads course availability from the v3 course read, and names what a v1 fallback did not report", async () => {
    const fixture = await harness();
    const result = structured(await fixture.call("blackboard_get_course_availability"));
    expect(result).toMatchObject({
      ok: true,
      courseId,
      apiVersion: "v3",
      ultraStatus: "Ultra",
      closedComplete: false,
      availability: { available: "Yes" },
      unreported: [],
    });
    expect(fixture.query(`/learn/api/public/v3/courses/${courseId}`)).toBe(`?fields=${COURSE_FIELDS}`);
    await close?.(); close = undefined;

    const older = await harness({ v3Missing: true });
    const fallback = structured(await older.call("blackboard_get_course_availability"));
    expect(fallback).toMatchObject({
      ok: true, apiVersion: "v1", availability: { available: "Yes" }, unreported: ["ultraStatus", "closedComplete"],
    });
    expect(fallback.ultraStatus).toBeUndefined();
    expect(fallback.closedComplete).toBeUndefined();
    expect(older.requests()).toContain(`GET /learn/api/public/v1/courses/${courseId}`);
  });
});
