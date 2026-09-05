import { isDeepStrictEqual } from "node:util";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import type { LmsApiClient, LmsApiOperation, LmsRead } from "./lms-api-types.js";

const courseSchema = {
  type: "object",
  properties: { course_id: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
  required: ["course_id"],
  additionalProperties: false,
};
const source = "https://github.com/moodle/moodle/blob/v5.2.2/public/";

function courseId(args: JsonObject): number {
  if (typeof args.course_id !== "number" || !Number.isSafeInteger(args.course_id) || args.course_id < 1) {
    throw new Error("Moodle course_id must be a positive integer.");
  }
  return args.course_id;
}

function withoutWarnings(value: unknown): JsonObject {
  if (!isJsonObject(value) || !Array.isArray(value.warnings) || value.warnings.length !== 0) {
    throw new Error("Moodle returned an incomplete or invalid result.");
  }
  return value;
}

async function readCourse(client: LmsApiClient, args: JsonObject): Promise<LmsRead> {
  const id = courseId(args);
  const response = await client.moodle("core_course_get_courses", { options: { ids: [id] } });
  if (!Array.isArray(response) || response.length !== 1 || !isJsonObject(response[0])
    || response[0].id !== id || typeof response[0].fullname !== "string" || !response[0].fullname.trim()
    || typeof response[0].summary !== "string" || typeof response[0].summaryformat !== "number") {
    throw new Error("Moodle did not return the exact requested course.");
  }
  return {
    data: response[0],
    targets: [{ field: "course_id", label: "Course", name: response[0].fullname }],
  };
}

function protectedCourseFields(value: JsonObject): JsonObject {
  const { summary: _summary, summaryformat: _summaryformat, timemodified: _timemodified, ...fields } = value;
  return fields;
}

export const MOODLE_API_OPERATIONS: readonly LmsApiOperation[] = [
  {
    name: "moodle_list_my_courses",
    provider: "moodle",
    title: "List my Moodle courses",
    description: "List courses where the connected Moodle user is enrolled.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    documentation: `${source}enrol/externallib.php#L406`,
    requiredFunctions: ["core_enrol_get_users_courses"],
    async read(client) {
      const userid = Number(client.principalId);
      if (!/^[1-9]\d*$/.test(client.principalId) || !Number.isSafeInteger(userid)) {
        throw new Error("Moodle did not identify the connected user.");
      }
      const data = await client.moodle("core_enrol_get_users_courses", { userid, returnusercount: false });
      if (!Array.isArray(data)) throw new Error("Moodle returned an invalid course list.");
      return { data };
    },
  },
  {
    name: "moodle_get_course",
    provider: "moodle",
    title: "Get a Moodle course",
    description: "Read the exact Moodle course and its current summary before a change.",
    inputSchema: courseSchema,
    documentation: `${source}course/externallib.php#L683`,
    requiredFunctions: ["core_course_get_courses"],
    read: readCourse,
  },
  {
    name: "moodle_get_contents",
    provider: "moodle",
    title: "Get Moodle course contents",
    description: "Read the sections, activities, and content files visible to the connected user.",
    inputSchema: courseSchema,
    documentation: `${source}course/externallib.php#L61`,
    requiredFunctions: ["core_course_get_courses", "core_course_get_contents"],
    async read(client, args) {
      const course = await readCourse(client, args);
      const data = await client.moodle("core_course_get_contents", { courseid: courseId(args), options: [] });
      if (!Array.isArray(data)) throw new Error("Moodle returned invalid course contents.");
      return { data, targets: course.targets };
    },
  },
  {
    name: "moodle_list_assignments",
    provider: "moodle",
    title: "List Moodle assignments",
    description: "Read assignment settings for one Moodle course. This does not create or change assignments.",
    inputSchema: courseSchema,
    documentation: `${source}mod/assign/externallib.php#L235`,
    requiredFunctions: ["core_course_get_courses", "mod_assign_get_assignments"],
    async read(client, args) {
      const course = await readCourse(client, args);
      const id = courseId(args);
      const data = withoutWarnings(await client.moodle("mod_assign_get_assignments", {
        courseids: [id], capabilities: [], includenotenrolledcourses: true,
      }));
      if (!Array.isArray(data.courses) || data.courses.some((entry) => !isJsonObject(entry) || entry.id !== id)) {
        throw new Error("Moodle returned assignments for an unexpected course.");
      }
      return { data, targets: course.targets };
    },
  },
  {
    name: "moodle_list_quizzes",
    provider: "moodle",
    title: "List Moodle quizzes",
    description: "Read quiz settings for one Moodle course. This does not create quizzes or author questions.",
    inputSchema: courseSchema,
    documentation: `${source}mod/quiz/classes/external.php#L62`,
    requiredFunctions: ["core_course_get_courses", "mod_quiz_get_quizzes_by_courses"],
    async read(client, args) {
      const course = await readCourse(client, args);
      const id = courseId(args);
      const data = withoutWarnings(await client.moodle("mod_quiz_get_quizzes_by_courses", { courseids: [id] }));
      if (!Array.isArray(data.quizzes) || data.quizzes.some((entry) => !isJsonObject(entry) || entry.course !== id)) {
        throw new Error("Moodle returned quizzes for an unexpected course.");
      }
      const quizzes = data.quizzes.map((quiz) => {
        const { password: _password, ...settings } = quiz as JsonObject;
        return settings;
      });
      return { data: { ...data, quizzes }, targets: course.targets };
    },
  },
  {
    name: "moodle_update_course_summary",
    provider: "moodle",
    title: "Update a Moodle course summary",
    description: "Replace only the course summary with HTML, then verify the summary and unchanged course settings.",
    inputSchema: {
      ...courseSchema,
      properties: { ...courseSchema.properties, summary: { type: "string", maxLength: 40000 } },
      required: ["course_id", "summary"],
    },
    documentation: `${source}course/externallib.php#L1151`,
    requiredFunctions: ["core_course_get_courses", "core_course_update_courses"],
    reviewTool: "moodle_get_course",
    read: readCourse,
    change: {
      async apply(client, args, before) {
        const id = courseId(args);
        if (!isJsonObject(before.data) || before.data.id !== id) {
          throw new Error("Moodle course identity changed before the update.");
        }
        if (typeof args.summary !== "string" || args.summary.length > 40000) {
          throw new Error("Moodle summary must contain at most 40000 characters.");
        }
        withoutWarnings(await client.moodle("core_course_update_courses", {
          courses: [{ id, summary: args.summary, summaryformat: 1 }],
        }));
      },
      matches(before, after, args) {
        return isJsonObject(before.data) && isJsonObject(after.data)
          && before.data.id === args.course_id && after.data.id === args.course_id
          && after.data.summary === args.summary && after.data.summaryformat === 1
          && isDeepStrictEqual(protectedCourseFields(before.data), protectedCourseFields(after.data));
      },
    },
  },
];
