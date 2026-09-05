import { isDeepStrictEqual } from "node:util";
import { isJsonObject, type JsonObject, type JsonSchema } from "@morrow/contracts";
import type { LmsApiClient, LmsApiOperation, LmsRead } from "./lms-api-types.js";

const DOCUMENTATION = "https://devportal-docstore.s3.amazonaws.com/learn-swagger-4000.21.0.json";
const PRIMARY_ID = /^_\d+_\d+$/;
const idSchema = { type: "string", pattern: PRIMARY_ID.source, description: "Exact Blackboard primary ID, such as _123_1." };
const pageProperties = {
  offset: { type: "integer", minimum: 0 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
};

function schema(properties: JsonObject, required: readonly string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function checkKeys(args: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("Unexpected Blackboard input field.");
}

function primaryId(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !PRIMARY_ID.test(value)) throw new Error("An exact Blackboard primary ID is required.");
  return value;
}

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("Blackboard returned an invalid object.");
  return value;
}

function page(args: JsonObject): { offset: number; limit: number } {
  const offset = Object.hasOwn(args, "offset") ? args.offset : 0;
  const limit = Object.hasOwn(args, "limit") ? args.limit : 100;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Blackboard paging requires a nonnegative offset and a limit from 1 to 100.");
  }
  return { offset, limit };
}

function collection(value: unknown, limit: number): JsonObject {
  const result = object(value);
  if (!Array.isArray(result.results) || result.results.length > limit || !result.results.every(isJsonObject)) {
    throw new Error("Blackboard returned an invalid result page.");
  }
  if (result.paging !== undefined) {
    const paging = object(result.paging);
    if (paging.nextPage !== undefined && typeof paging.nextPage !== "string") throw new Error("Blackboard returned invalid paging.");
  }
  return result;
}

async function course(client: LmsApiClient, courseId: string): Promise<JsonObject> {
  const result = object(await client.blackboard(`/learn/api/public/v3/courses/${courseId}?fields=id,courseId,name,ultraStatus,closedComplete`));
  if (result.id !== courseId || typeof result.name !== "string") throw new Error("Blackboard returned a different or invalid course.");
  return result;
}

function courseTarget(value: JsonObject) {
  return { field: "course_id", label: "Course", name: String(value.name) };
}

async function readContent(client: LmsApiClient, args: JsonObject): Promise<LmsRead> {
  const courseId = primaryId(args.course_id);
  const contentId = primaryId(args.content_id);
  const currentCourse = await course(client, courseId);
  const content = object(await client.blackboard(`/learn/api/public/v1/courses/${courseId}/contents/${contentId}?includeInActivityTracking=false`));
  if (content.id !== contentId || typeof content.title !== "string"
    || (content.courseId !== undefined && content.courseId !== courseId)) {
    throw new Error("Blackboard returned a different or invalid content item.");
  }
  return {
    data: { course: currentCourse, content },
    targets: [courseTarget(currentCourse), { field: "content_id", label: "Content", name: content.title }],
  };
}

function changeBody(args: JsonObject): JsonObject {
  checkKeys(args, ["course_id", "content_id", "title", "body"]);
  primaryId(args.course_id);
  primaryId(args.content_id);
  const patch: JsonObject = {};
  if (Object.hasOwn(args, "title")) {
    if (typeof args.title !== "string" || args.title.trim().length === 0) throw new Error("The content title must contain text.");
    patch.title = args.title;
  }
  if (Object.hasOwn(args, "body")) {
    if (typeof args.body !== "string") throw new Error("The content body must be a string.");
    patch.body = args.body;
  }
  if (Object.keys(patch).length === 0) throw new Error("Provide a content title or body change.");
  return patch;
}

function documentSnapshot(read: LmsRead, args: JsonObject): { course: JsonObject; content: JsonObject } {
  const data = object(read.data);
  const currentCourse = object(data.course);
  const content = object(data.content);
  if (currentCourse.id !== primaryId(args.course_id) || content.id !== primaryId(args.content_id)) {
    throw new Error("The Blackboard snapshot does not match the requested target.");
  }
  if (currentCourse.closedComplete !== false || !["Classic", "Ultra"].includes(String(currentCourse.ultraStatus))) {
    throw new Error("The Blackboard course is closed or its course view is not supported for changes.");
  }
  if (!isJsonObject(content.contentHandler) || content.contentHandler.id !== "resource/x-bb-document") {
    throw new Error("Only a verified Blackboard document body item supports this change.");
  }
  return { course: currentCourse, content };
}

function protectedContent(content: JsonObject, patch: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(content).filter(([key]) => key !== "modified" && !Object.hasOwn(patch, key)));
}

export const BLACKBOARD_API_OPERATIONS: readonly LmsApiOperation[] = [
  {
    name: "blackboard_list_my_courses", provider: "blackboard", title: "List my Blackboard courses",
    description: "Read one page of the connected educator's course memberships using documented /users/me/courses. Includes Blackboard paging; does not claim a complete course list. Every returned membership must match the connected principal. Current-user route: https://blackboard.github.io/rest-apis/learn/advanced/soap-to-rest-mapping",
    documentation: DOCUMENTATION,
    inputSchema: schema(pageProperties),
    async read(client, args) {
      checkKeys(args, ["offset", "limit"]);
      const principalId = primaryId(client.principalId);
      const { offset, limit } = page(args);
      const memberships = collection(await client.blackboard(`/learn/api/public/v1/users/me/courses?expand=course&offset=${offset}&limit=${limit}`), limit);
      for (const member of memberships.results as JsonObject[]) {
        if (member.userId !== principalId) throw new Error("Blackboard returned a membership for a different or unknown principal.");
        const courseId = primaryId(member.courseId);
        if (member.course !== undefined && object(member.course).id !== courseId) throw new Error("Blackboard returned a mismatched course membership.");
      }
      return { data: { memberships, offset, limit } };
    },
  },
  {
    name: "blackboard_get_course", provider: "blackboard", title: "Read a Blackboard course",
    description: "Read an exact course's current name, primary ID, course view, and closed state through the documented v3 REST endpoint. Requires access to the course; v3 is available since Learn 3800.1.0.",
    documentation: DOCUMENTATION,
    inputSchema: schema({ course_id: idSchema }, ["course_id"]),
    async read(client, args) {
      checkKeys(args, ["course_id"]);
      const currentCourse = await course(client, primaryId(args.course_id));
      return { data: { course: currentCourse }, targets: [courseTarget(currentCourse)] };
    },
  },
  {
    name: "blackboard_list_contents", provider: "blackboard", title: "List Blackboard course contents",
    description: "Read one page of top-level course content and its paging information. This is not a recursive or complete course inventory. Documented public REST access follows course and content permissions.",
    documentation: DOCUMENTATION,
    inputSchema: schema({ course_id: idSchema, ...pageProperties }, ["course_id"]),
    async read(client, args) {
      checkKeys(args, ["course_id", "offset", "limit"]);
      const courseId = primaryId(args.course_id);
      const { offset, limit } = page(args);
      const currentCourse = await course(client, courseId);
      const contents = collection(await client.blackboard(`/learn/api/public/v1/courses/${courseId}/contents?recursive=false&offset=${offset}&limit=${limit}`), limit);
      for (const content of contents.results as JsonObject[]) primaryId(content.id);
      return { data: { course: currentCourse, contents, offset, limit }, targets: [courseTarget(currentCourse)] };
    },
  },
  {
    name: "blackboard_list_content_children", provider: "blackboard", title: "List Blackboard content children",
    description: "Read one page of direct children for one exact Blackboard content item. Reads the parent first for target context, requests recursive=false, and does not traverse deeper content. Every returned child must belong to the requested course and parent when Blackboard supplies those IDs.",
    documentation: DOCUMENTATION,
    inputSchema: schema({ course_id: idSchema, content_id: idSchema, ...pageProperties }, ["course_id", "content_id"]),
    async read(client, args) {
      checkKeys(args, ["course_id", "content_id", "offset", "limit"]);
      const courseId = primaryId(args.course_id);
      const contentId = primaryId(args.content_id);
      const { offset, limit } = page(args);
      const parent = await readContent(client, args);
      const children = collection(await client.blackboard(`/learn/api/public/v1/courses/${courseId}/contents/${contentId}/children?recursive=false&skipUltraDocumentBodyAndKnowledgeChecks=false&includeInActivityTracking=false&offset=${offset}&limit=${limit}`), limit);
      for (const child of children.results as JsonObject[]) {
        primaryId(child.id);
        if ((child.courseId !== undefined && child.courseId !== courseId)
          || (child.parentId !== undefined && child.parentId !== contentId)) {
          throw new Error("Blackboard returned a child outside the requested content parent or course.");
        }
      }
      return { data: { ...object(parent.data), children, offset, limit }, targets: parent.targets };
    },
  },
  {
    name: "blackboard_get_content", provider: "blackboard", title: "Read Blackboard content",
    description: "Read one exact content item with its current course state. Uses documented public REST content access and disables activity tracking for this read. The result can be used to review a document title or body change.",
    documentation: DOCUMENTATION,
    inputSchema: schema({ course_id: idSchema, content_id: idSchema }, ["course_id", "content_id"]),
    async read(client, args) {
      checkKeys(args, ["course_id", "content_id"]);
      return readContent(client, args);
    },
  },
  {
    name: "blackboard_update_content", provider: "blackboard", title: "Change a Blackboard document",
    description: "Change only title and/or body on a verified resource/x-bb-document item in an open Original or Ultra course. Requires course.content.MODIFY and delegated write scope. Ultra body must use BbML; Original body must use safe HTML. Does not edit Ultra document wrappers, assessments, or question banks. Verified by a fresh content read.",
    documentation: DOCUMENTATION,
    reviewTool: "blackboard_get_content",
    inputSchema: {
      ...schema({ course_id: idSchema, content_id: idSchema, title: { type: "string", minLength: 1, pattern: "\\S" }, body: { type: "string" } }, ["course_id", "content_id"]),
      anyOf: [{ required: ["title"] }, { required: ["body"] }],
    },
    async read(client, args) {
      changeBody(args);
      const snapshot = await readContent(client, args);
      documentSnapshot(snapshot, args);
      return snapshot;
    },
    change: {
      async apply(client, args, before) {
        const patch = changeBody(args);
        documentSnapshot(before, args);
        await client.blackboard(`/learn/api/public/v1/courses/${args.course_id}/contents/${args.content_id}`, "PATCH", patch);
      },
      matches(before, after, args) {
        try {
          const patch = changeBody(args);
          const previous = documentSnapshot(before, args);
          const current = documentSnapshot(after, args);
          return Object.entries(patch).every(([key, value]) => current.content[key] === value)
            && isDeepStrictEqual(previous.course, current.course)
            && isDeepStrictEqual(protectedContent(previous.content, patch), protectedContent(current.content, patch));
        } catch {
          return false;
        }
      },
    },
  },
];
