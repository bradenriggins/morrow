import { describe, expect, it } from "vitest";
import type { JsonObject } from "@morrow/contracts";
import { BLACKBOARD_API_OPERATIONS } from "../src/blackboard-api.js";
import type { LmsApiClient } from "../src/lms-api-types.js";

function fixture() {
  const course = { id: "_12_1", courseId: "BIO101", name: "Biology", ultraStatus: "Ultra", closedComplete: false };
  const content: JsonObject = {
    id: "_34_1", title: "Week 1", body: "<p>Before</p>", parentId: "_33_1",
    contentHandler: { id: "resource/x-bb-document" }, availability: { available: "No" }, modified: "2026-09-01T00:00:00Z",
  };
  const folder: JsonObject = {
    id: "_33_1", courseId: course.id, title: "Week 1 materials",
    contentHandler: { id: "resource/x-bb-folder", isBbPage: true },
  };
  const children: JsonObject[] = [{
    id: "_35_1", courseId: course.id, parentId: folder.id, title: "Study notes", body: "<p>Read before class.</p>",
    contentHandler: { id: "resource/x-bb-document" },
  }];
  const calls: { path: string; method: string; body?: JsonObject }[] = [];
  const client: LmsApiClient = {
    baseUrl: "https://learn.example.invalid", principalId: "_7_1", signal: new AbortController().signal,
    async moodle() { throw new Error("Unexpected Moodle request."); },
    async blackboard(path, method = "GET", body) {
      calls.push({ path, method, ...(body ? { body } : {}) });
      if (path === "/learn/api/public/v3/courses/_12_1?fields=id,courseId,name,ultraStatus,closedComplete") return structuredClone(course);
      if (path === "/learn/api/public/v1/courses/_12_1/contents/_34_1?includeInActivityTracking=false") return structuredClone(content);
      if (path === "/learn/api/public/v1/courses/_12_1/contents/_33_1?includeInActivityTracking=false") return structuredClone(folder);
      if (path === "/learn/api/public/v1/courses/_12_1/contents/_33_1/children?recursive=false&skipUltraDocumentBodyAndKnowledgeChecks=false&includeInActivityTracking=false&offset=0&limit=1") {
        return { results: structuredClone(children), paging: { nextPage: "/next-children" } };
      }
      if (path === "/learn/api/public/v1/courses/_12_1/contents/_34_1" && method === "PATCH") {
        Object.assign(content, body, { modified: "2026-09-04T00:00:00Z" });
        return structuredClone(content);
      }
      if (path === "/learn/api/public/v1/users/me/courses?expand=course&offset=0&limit=100") {
        return { results: [{ userId: "_7_1", courseId: course.id, courseRoleId: "Instructor", course }], paging: { nextPage: "/next-page" } };
      }
      throw new Error(`Unexpected Blackboard request: ${method} ${path}`);
    },
  };
  return { client, calls, course, content, children };
}

function operation(name: string) {
  const result = BLACKBOARD_API_OPERATIONS.find((item) => item.name === name);
  if (!result) throw new Error(`Missing operation: ${name}`);
  return result;
}

describe("Blackboard REST operations", () => {
  it("binds an own-course page and identical document snapshots, then verifies a minimal change", async () => {
    const { client, calls, content } = fixture();
    const list = await operation("blackboard_list_my_courses").read(client, {});
    expect(list.data).toMatchObject({ memberships: { paging: { nextPage: "/next-page" } }, offset: 0, limit: 100 });
    const args = { course_id: "_12_1", content_id: "_34_1", title: "Week 1: Start here" };
    const update = operation("blackboard_update_content");
    const review = await operation("blackboard_get_content").read(client, { course_id: args.course_id, content_id: args.content_id });
    const before = await update.read(client, args);
    expect(before).toEqual(review);
    expect(before.targets).toEqual([
      { field: "course_id", label: "Course", name: "Biology" },
      { field: "content_id", label: "Content", name: "Week 1" },
    ]);
    await update.change!.apply(client, args, before);
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([
      { path: "/learn/api/public/v1/courses/_12_1/contents/_34_1", method: "PATCH", body: { title: args.title } },
    ]);
    const after = await update.read(client, args);
    expect(update.change!.matches(before, after, args)).toBe(true);
    expect(content.body).toBe("<p>Before</p>");
    content.availability = { available: "Yes" };
    expect(update.change!.matches(before, await update.read(client, args), args)).toBe(false);
  });

  it("refuses an unsupported wrapper or wrong returned identity before sending a change", async () => {
    const { client, calls, content } = fixture();
    const update = operation("blackboard_update_content");
    const args = { course_id: "_12_1", content_id: "_34_1", body: "<p>After</p>" };
    content.contentHandler = { id: "resource/x-bb-folder", isBbPage: true };
    await expect(update.read(client, args)).rejects.toThrow("verified Blackboard document body");
    content.contentHandler = { id: "resource/x-bb-document" };
    content.id = "_99_1";
    await expect(update.read(client, args)).rejects.toThrow("different or invalid content");
    await expect(update.read(client, { ...args, content_id: "../other" })).rejects.toThrow("exact Blackboard primary ID");
    await expect(update.read(client, { ...args, availability: { available: "Yes" } })).rejects.toThrow("Unexpected Blackboard input");
    await expect(operation("blackboard_list_my_courses").read({ ...client, principalId: "_8_1" }, {})).rejects.toThrow("different or unknown principal");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("reads one direct page of nested Blackboard documents from an exact folder", async () => {
    const { client, calls } = fixture();
    const listed = await operation("blackboard_list_content_children").read(client, {
      course_id: "_12_1", content_id: "_33_1", offset: 0, limit: 1,
    });
    expect(listed).toMatchObject({
      data: {
        course: { id: "_12_1", name: "Biology" },
        content: { id: "_33_1", contentHandler: { id: "resource/x-bb-folder", isBbPage: true } },
        children: { results: [{ id: "_35_1", parentId: "_33_1", contentHandler: { id: "resource/x-bb-document" } }], paging: { nextPage: "/next-children" } },
        offset: 0,
        limit: 1,
      },
      targets: [
        { field: "course_id", label: "Course", name: "Biology" },
        { field: "content_id", label: "Content", name: "Week 1 materials" },
      ],
    });
    expect(calls).toEqual([
      { path: "/learn/api/public/v3/courses/_12_1?fields=id,courseId,name,ultraStatus,closedComplete", method: "GET" },
      { path: "/learn/api/public/v1/courses/_12_1/contents/_33_1?includeInActivityTracking=false", method: "GET" },
      { path: "/learn/api/public/v1/courses/_12_1/contents/_33_1/children?recursive=false&skipUltraDocumentBodyAndKnowledgeChecks=false&includeInActivityTracking=false&offset=0&limit=1", method: "GET" },
    ]);
  });

  it("rejects a listed child that names a different parent", async () => {
    const { client, children } = fixture();
    children[0]!.parentId = "_99_1";
    await expect(operation("blackboard_list_content_children").read(client, {
      course_id: "_12_1", content_id: "_33_1", offset: 0, limit: 1,
    })).rejects.toThrow("outside the requested content parent or course");
  });
});
