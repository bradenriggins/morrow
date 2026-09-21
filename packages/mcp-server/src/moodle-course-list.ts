import type { JsonObject } from "@morrow/contracts";

export const MOODLE_COURSE_LIST_TOOL = "moodle_list_my_courses";
export const MOODLE_COURSE_LIST_OPERATION = "moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1";

export type MoodleCourseListRequest = Readonly<{ limit: number; offset: number }>;

function positiveId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value) ? value : null;
}

export function moodleCourseListRequest(value: Readonly<Record<string, unknown>>): MoodleCourseListRequest | null {
  const limit = value.limit === undefined ? 50 : value.limit;
  const offset = value.offset === undefined ? 0 : value.offset;
  return Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= 100
    && Number.isSafeInteger(offset) && Number(offset) >= 0 && Number(offset) <= 10_000
    ? { limit: Number(limit), offset: Number(offset) }
    : null;
}

/** Rebuild the site-level course page from its two public fields only. */
export function projectMoodleCourseList(value: unknown, request: MoodleCourseListRequest): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("moodle_courses_invalid");
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.courses) || source.courses.length > request.limit
    || source.offset !== request.offset || source.limit !== request.limit || typeof source.complete !== "boolean") {
    throw new Error("moodle_courses_invalid");
  }
  const courses: JsonObject[] = [];
  const ids = new Set<string>();
  for (const item of source.courses) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("moodle_courses_invalid");
    const course = item as Record<string, unknown>;
    const id = positiveId(course.id);
    const name = typeof course.name === "string" && course.name.length > 0 && course.name.length <= 4_096
      && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(course.name)
      ? course.name
      : null;
    if (!id || !name || ids.has(id)) throw new Error("moodle_courses_invalid");
    ids.add(id);
    courses.push({ id, name });
  }
  const nextOffset = source.next_offset;
  if (source.complete === true) {
    if (nextOffset !== null) throw new Error("moodle_courses_invalid");
  } else if (!Number.isSafeInteger(nextOffset) || Number(nextOffset) !== request.offset + courses.length || courses.length === 0) {
    throw new Error("moodle_courses_invalid");
  }
  return {
    schema: "morrow.moodle-course-list.v1",
    provider: "moodle",
    courses,
    offset: request.offset,
    limit: request.limit,
    next_offset: nextOffset as number | null,
    complete: source.complete,
  };
}
