import { describe, expect, it } from "vitest";
import { moodleCourseListRequest, projectMoodleCourseList } from "../src/moodle-course-list.js";
import { GatewayRuntime } from "../src/runtime.js";

describe("Moodle course-list public projection", () => {
  it("keeps only course IDs and names", () => {
    const request = moodleCourseListRequest({ limit: 2, offset: 0 });
    expect(request).not.toBeNull();
    expect(projectMoodleCourseList({
      courses: [
        { id: 2, name: "Course two", summary: "private", contacts: [{ fullname: "Teacher Name" }] },
        { id: "3", name: "Course three", progress: 75 },
      ],
      offset: 0,
      limit: 2,
      next_offset: 2,
      complete: false,
      sesskey: "secret",
    }, request!)).toEqual({
      schema: "morrow.moodle-course-list.v1",
      provider: "moodle",
      courses: [{ id: "2", name: "Course two" }, { id: "3", name: "Course three" }],
      offset: 0,
      limit: 2,
      next_offset: 2,
      complete: false,
    });
  });

  it("refuses inconsistent paging and invalid course rows", () => {
    const request = moodleCourseListRequest({});
    expect(request).toEqual({ limit: 50, offset: 0 });
    expect(() => projectMoodleCourseList({ courses: [], offset: 0, limit: 50, next_offset: 1, complete: false }, request!)).toThrow("moodle_courses_invalid");
    expect(() => projectMoodleCourseList({ courses: [{ id: 1, name: "A" }, { id: 1, name: "B" }], offset: 0, limit: 50, next_offset: null, complete: true }, request!)).toThrow("moodle_courses_invalid");
  });

  it("keeps the public course-list projection through the compact capability wrapper", async () => {
    const runtime = Object.create(GatewayRuntime.prototype) as GatewayRuntime & { toolByPublicName: Map<string, unknown> };
    runtime.toolByPublicName = new Map();
    const value = {
      structuredContent: {
        schema: "morrow.result.v1",
        tool: "moodle_list_my_courses",
        backend: "canvas-session",
        status: "succeeded",
        phase: "read",
        data: {
          schema: "morrow.result.v1",
          tool: "moodle_list_my_courses",
          backend: "canvas-session",
          status: "succeeded",
          phase: "read",
          data: {
            schema: "morrow.moodle-course-list.v1",
            provider: "moodle",
            courses: [{ id: "2", name: "Course two" }],
            offset: 0,
            limit: 2,
            next_offset: null,
            complete: true,
          },
        },
      },
    };

    const result = await runtime.redactMcpEgress(value, {
      name: "moodle_list_my_courses",
      arguments: { limit: 2, offset: 0, _morrow: { source_binding_id: "moodle:test:c2" } },
    }, { bound: false, toolName: "morrow_capability_read" });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      tool: "moodle_list_my_courses",
      data: { courses: [{ id: "2", name: "Course two" }] },
    });
  });
});
