import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_FORUM_ACTIVITY_SUMMARY_OPERATION = "moodle.form.forum.activity_summary.read.v1";
export const MOODLE_FORUM_ACTIVITY_SUMMARY_TOOL = "moodle_get_forum_activity_summary";
export const MOODLE_FORUM_ACTIVITY_SUMMARY_SCHEMA = "morrow.moodle-forum-activity-summary.v1";

const PAGE_SIZE = 50;
const MAX_DISCUSSIONS = 500;
const MAX_PAGE_REQUESTS = (MAX_DISCUSSIONS / PAGE_SIZE) + 1;
const MAX_REPLIES = MAX_DISCUSSIONS * 10_000;

export type MoodleForumActivitySummary = Readonly<{
  schema: typeof MOODLE_FORUM_ACTIVITY_SUMMARY_SCHEMA;
  provider: "moodle";
  discussion_count: number;
  reply_count: number;
  proof: Readonly<{
    method: "mod_forum_get_forum_discussions";
    complete: true;
    exact_module_binding: "course_modedit_form";
    required_capability: "mod/forum:viewdiscussion";
    scope: "current_principal_permitted_discussions";
    group_scope: "native_default_permitted_groups";
    sort_order: "created_asc";
    page_size: typeof PAGE_SIZE;
    page_request_limit: typeof MAX_PAGE_REQUESTS;
    page_request_count: number;
    discussion_limit: typeof MAX_DISCUSSIONS;
    reply_limit: typeof MAX_REPLIES;
  }>;
}>;

export type MoodleForumActivitySummaryExpectation = Readonly<{ courseId: number; moduleId: number }>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function aggregate(value: JsonObject): MoodleForumActivitySummary {
  const discussionCount = count(value.discussion_count, MAX_DISCUSSIONS);
  const replyCount = count(value.reply_count, MAX_REPLIES);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (discussionCount === null || replyCount === null || !proof
    || proof.method !== "mod_forum_get_forum_discussions" || proof.complete !== true
    || proof.exact_module_binding !== "course_modedit_form" || proof.required_capability !== "mod/forum:viewdiscussion"
    || proof.scope !== "current_principal_permitted_discussions" || proof.group_scope !== "native_default_permitted_groups"
    || proof.sort_order !== "created_asc" || proof.page_size !== PAGE_SIZE || proof.page_request_limit !== MAX_PAGE_REQUESTS
    || count(proof.page_request_count, MAX_PAGE_REQUESTS) === null || proof.discussion_limit !== MAX_DISCUSSIONS
    || proof.reply_limit !== MAX_REPLIES) {
    throw new Error("moodle_forum_activity_summary_invalid");
  }
  return {
    schema: MOODLE_FORUM_ACTIVITY_SUMMARY_SCHEMA,
    provider: "moodle",
    discussion_count: discussionCount,
    reply_count: replyCount,
    proof: {
      method: "mod_forum_get_forum_discussions",
      complete: true,
      exact_module_binding: "course_modedit_form",
      required_capability: "mod/forum:viewdiscussion",
      scope: "current_principal_permitted_discussions",
      group_scope: "native_default_permitted_groups",
      sort_order: "created_asc",
      page_size: PAGE_SIZE,
      page_request_limit: MAX_PAGE_REQUESTS,
      page_request_count: count(proof.page_request_count, MAX_PAGE_REQUESTS)!,
      discussion_limit: MAX_DISCUSSIONS,
      reply_limit: MAX_REPLIES,
    },
  };
}

/**
 * Drops every Forum source field except the bounded aggregate and its proof.
 * Course, module, and Forum identifiers remain validation-only data and never
 * enter the public representation.
 */
export function projectMoodleForumActivitySummary(
  value: unknown,
  expected: MoodleForumActivitySummaryExpectation,
): MoodleForumActivitySummary {
  if (!isJsonObject(value) || value.schema !== MOODLE_FORUM_ACTIVITY_SUMMARY_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.module_id) !== expected.moduleId || !positiveId(value.forum_id)) {
    throw new Error("moodle_forum_activity_summary_invalid");
  }
  return aggregate(value);
}

/**
 * Re-validates a summary that already carries the public shape, which MCP
 * egress sees. That shape has no course, module, or Forum identifier, so egress
 * can prove the bounded aggregate and its proof but not the requested target.
 * A value that still carries an identifier did not come from this projection
 * and is refused.
 */
export function projectPublicMoodleForumActivitySummary(value: unknown): MoodleForumActivitySummary {
  if (!isJsonObject(value) || value.schema !== MOODLE_FORUM_ACTIVITY_SUMMARY_SCHEMA || value.provider !== "moodle"
    || "course_id" in value || "module_id" in value || "forum_id" in value) {
    throw new Error("moodle_forum_activity_summary_invalid");
  }
  return aggregate(value);
}

export function projectMoodleForumActivitySummaryBrowserResult(
  browserData: unknown,
  expected: MoodleForumActivitySummaryExpectation,
): JsonObject {
  return projectMoodleForumActivitySummary(browserData, expected) as JsonObject;
}

export function projectPublicMoodleForumActivitySummaryResult(publicData: unknown): JsonObject {
  return projectPublicMoodleForumActivitySummary(publicData) as JsonObject;
}
