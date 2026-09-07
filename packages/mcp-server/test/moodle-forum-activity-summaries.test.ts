import { describe, expect, it } from "vitest";
import {
  MOODLE_FORUM_ACTIVITY_SUMMARY_SCHEMA,
  projectMoodleForumActivitySummary,
  projectPublicMoodleForumActivitySummary,
} from "../src/moodle-forum-activity-summaries.js";

const aggregate = {
  schema: MOODLE_FORUM_ACTIVITY_SUMMARY_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  forum_id: 71,
  discussion_count: 50,
  reply_count: 51,
  proof: {
    method: "mod_forum_get_forum_discussions",
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "mod/forum:viewdiscussion",
    scope: "current_principal_permitted_discussions",
    group_scope: "native_default_permitted_groups",
    sort_order: "created_asc",
    page_size: 50,
    page_request_limit: 11,
    page_request_count: 2,
    discussion_limit: 500,
    reply_limit: 5_000_000,
  },
};

describe("Moodle Forum activity-summary projection", () => {
  it("keeps only the aggregate and proof when browser data includes Forum source fields", () => {
    const result = projectMoodleForumActivitySummary({
      ...aggregate,
      raw_discussions: [{ id: 501, discussion: 123, userid: 7, userfullname: "Jane Moodle", subject: "private subject", message: "private body", groupid: 9, numunread: 1 }],
      attachments: [{ filename: "private-file.pdf" }],
    }, { courseId: 2, moduleId: 8 });
    expect(result).toEqual({
      schema: MOODLE_FORUM_ACTIVITY_SUMMARY_SCHEMA,
      provider: "moodle",
      discussion_count: 50,
      reply_count: 51,
      proof: aggregate.proof,
    });
    const serialized = JSON.stringify(result);
    for (const privateValue of ["Jane Moodle", "private subject", "private body", "private-file.pdf", '"course_id"', '"module_id"', '"forum_id"', '"id":501']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("refuses a changed target, incomplete proof, and invalid bounds", () => {
    expect(() => projectMoodleForumActivitySummary({ ...aggregate, module_id: 9 }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_forum_activity_summary_invalid");
    expect(() => projectMoodleForumActivitySummary({ ...aggregate, proof: { ...aggregate.proof, complete: false } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_forum_activity_summary_invalid");
    expect(() => projectMoodleForumActivitySummary({ ...aggregate, discussion_count: 501 }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_forum_activity_summary_invalid");
    expect(() => projectMoodleForumActivitySummary({ ...aggregate, reply_count: 5_000_001 }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_forum_activity_summary_invalid");
    expect(() => projectMoodleForumActivitySummary({ ...aggregate, proof: { ...aggregate.proof, page_request_count: 12 } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_forum_activity_summary_invalid");
  });

  it("re-validates the public shape at egress and refuses a value that still carries an identifier", () => {
    const projected = projectMoodleForumActivitySummary(aggregate, { courseId: 2, moduleId: 8 });
    expect(projectPublicMoodleForumActivitySummary(projected)).toEqual(projected);
    for (const identifier of ["course_id", "module_id", "forum_id"]) {
      expect(() => projectPublicMoodleForumActivitySummary({ ...projected, [identifier]: 2 }), identifier)
        .toThrow("moodle_forum_activity_summary_invalid");
    }
    expect(() => projectPublicMoodleForumActivitySummary({ ...projected, proof: { ...aggregate.proof, complete: false } }))
      .toThrow("moodle_forum_activity_summary_invalid");
    expect(() => projectPublicMoodleForumActivitySummary({ ...projected, reply_count: 5_000_001 }))
      .toThrow("moodle_forum_activity_summary_invalid");
  });
});
