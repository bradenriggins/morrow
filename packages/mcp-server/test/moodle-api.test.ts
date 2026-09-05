import { describe, expect, it, vi } from "vitest";
import { projectOutput } from "@morrow/gateway-core";
import { MOODLE_API_OPERATIONS } from "../src/moodle-api.js";
import type { LmsApiClient } from "../src/lms-api-types.js";

const getCourse = MOODLE_API_OPERATIONS.find((operation) => operation.name === "moodle_get_course")!;
const listQuizzes = MOODLE_API_OPERATIONS.find((operation) => operation.name === "moodle_list_quizzes")!;
const update = MOODLE_API_OPERATIONS.find((operation) => operation.name === "moodle_update_course_summary")!;
const course = {
  id: 17, fullname: "Educator sandbox", shortname: "EDU", summary: "Old summary", summaryformat: 0,
  visible: 0, categoryid: 3, format: "topics", startdate: 100, enddate: 200, timemodified: 1,
};

function client(moodle: LmsApiClient["moodle"]): LmsApiClient {
  return {
    baseUrl: "https://moodle.example.edu/learning",
    principalId: "9",
    signal: new AbortController().signal,
    moodle,
    blackboard: async () => { throw new Error("Unexpected provider."); },
  };
}

describe("Moodle API operations", () => {
  it("binds the reviewed course to one summary write and checks exact readback with protected fields", async () => {
    let stored = { ...course };
    const moodle = vi.fn<LmsApiClient["moodle"]>(async (name, args) => {
      if (name === "core_course_get_courses") {
        expect(args).toEqual({ options: { ids: [17] } });
        return [{ ...stored }];
      }
      expect(name).toBe("core_course_update_courses");
      expect(args).toEqual({ courses: [{ id: 17, summary: "<p>New summary</p>", summaryformat: 1 }] });
      stored = { ...stored, summary: "<p>New summary</p>", summaryformat: 1, timemodified: 2 };
      return { warnings: [] };
    });
    const connected = client(moodle);
    const args = { course_id: 17, summary: "<p>New summary</p>" };
    const before = await getCourse.read(connected, args);
    expect(before.targets).toEqual([{ field: "course_id", label: "Course", name: "Educator sandbox" }]);
    expect(await update.read(connected, args)).toEqual(before);
    expect(update.requiredFunctions).toEqual(["core_course_get_courses", "core_course_update_courses"]);
    await update.change!.apply(connected, args, before);
    const after = await update.read(connected, args);
    expect(update.change!.matches(before, after, args)).toBe(true);
    expect(update.change!.matches(before, { ...after, data: { ...stored, summaryformat: 0 } }, args)).toBe(false);
    expect(update.change!.matches(before, { ...after, data: { ...stored, visible: 1 } }, args)).toBe(false);
  });

  it("rejects a mismatched course and failed or incomplete Moodle writes", async () => {
    const wrongCourse = client(async () => [{ ...course, id: 18 }]);
    await expect(update.read(wrongCourse, { course_id: 17 })).rejects.toThrow("exact requested course");
    const failed = vi.fn<LmsApiClient["moodle"]>(async () => { throw new Error("Moodle request failed."); });
    const args = { course_id: 17, summary: "Updated" };
    await expect(update.change!.apply(client(failed), args, { data: { ...course, id: 18 } }))
      .rejects.toThrow("course identity changed");
    expect(failed).not.toHaveBeenCalled();
    await expect(update.change!.apply(client(failed), args, { data: course })).rejects.toThrow("Moodle request failed");
    expect(failed).toHaveBeenCalledTimes(1);
    await expect(update.change!.apply(client(async () => ({ warnings: [{ warningcode: "1" }] })), args, { data: course }))
      .rejects.toThrow("incomplete or invalid result");
  });

  it("removes quiz passwords before gateway output projection while preserving quiz settings", async () => {
    const password = "SYNTHETIC-EXAM-ACCESS-123";
    const result = await listQuizzes.read(client(async (name) => {
      if (name === "core_course_get_courses") return [{ ...course }];
      return {
        quizzes: [{ id: 5, course: 17, name: "Exam 1", password, timelimit: 3600, attempts: 2 }],
        warnings: [],
      };
    }), { course_id: 17 });
    const projected = projectOutput({ content: [], structuredContent: { data: result.data } }, {
      descriptor: {
        allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 100,
        maxBytes: 100_000, freeText: "allow", learnerTokens: false, artifactInspection: "deny", aiClientAdmission: "allow",
      },
    });

    expect(result.data).toMatchObject({ quizzes: [{ id: 5, name: "Exam 1", timelimit: 3600, attempts: 2 }] });
    expect(JSON.stringify(projected)).not.toContain(password);
    expect(JSON.stringify(projected)).not.toContain('"password"');
    expect(projected).toMatchObject({ structuredContent: { data: { quizzes: [{ id: 5, timelimit: 3600, attempts: 2 }] } } });
  });
});
