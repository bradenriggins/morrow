/**
 * Reads three instructor-facing Canvas course aggregates before any data
 * crosses the browser bridge.
 *
 * Canvas Submission rows carry learner identities, scores, comments, and
 * attachment names. This function reads them in the page world, counts them
 * there, and emits fixed count fields only. One function serves all three
 * operations because `chrome.scripting.executeScript` serializes the function
 * it runs: a shared bounded fetch, pagination, and binding core is written
 * once instead of three times.
 *
 * Every route is same-origin, checks the exact response URL, caps response
 * bytes and pages, re-checks the binding before and after the read, and
 * refuses with an explicit `*_incomplete` state when a bound stops the
 * aggregation. A partial count is never returned.
 */
export async function executeCanvasCourseSummaryInPage(rawInput) {
  const PROVIDER = "canvas";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PAGES = 25;
  const MAX_SUBMISSION_PAGES = 50;
  const MAX_ROWS = 10_000;
  const MAX_ASSIGNMENTS = 200;
  const MAX_ITEMS = 2_000;
  const MAX_WINDOW_DAYS = 365;
  const MINIMUM_COHORT = 5;
  const DAY_MS = 24 * 60 * 60 * 1_000;
  const ID = /^[1-9][0-9]{0,18}$/;
  const SUBMISSION_STATES = Object.freeze(["unsubmitted", "submitted", "graded", "pending_review"]);
  const submissionStateSet = new Set(SUBMISSION_STATES);
  const SCORE_BUCKETS = Object.freeze(["below_60", "60_to_69", "70_to_79", "80_to_89", "90_and_above"]);
  const ACTIVITY_KINDS = Object.freeze([
    Object.freeze({ kind: "pages", segment: "pages" }),
    Object.freeze({ kind: "assignments", segment: "assignments" }),
    Object.freeze({ kind: "discussions", segment: "discussion_topics" }),
    Object.freeze({ kind: "quizzes", segment: "quizzes" }),
    Object.freeze({ kind: "modules", segment: "modules" }),
  ]);
  const ACTIVITY_TIMESTAMP_FIELD = "updated_at";
  const OPERATIONS = new Map([
    ["canvas.api.v1.course.assignment.submissions.aggregate.read.v1", {
      tool: "canvas_get_assignment_submission_summary",
      schema: "morrow.canvas-assignment-submission-summary.v1",
      prefix: "canvas_assignment_submission_summary",
      args: ["assignment_id", "course_id"],
    }],
    ["canvas.api.v1.course.gradebook.aggregate.read.v1", {
      tool: "canvas_get_course_gradebook_summary",
      schema: "morrow.canvas-course-gradebook-summary.v1",
      prefix: "canvas_course_gradebook_summary",
      args: ["course_id"],
    }],
    ["canvas.api.v1.course.activity.aggregate.read.v1", {
      tool: "canvas_get_course_activity_summary",
      schema: "morrow.canvas-course-activity-summary.v1",
      prefix: "canvas_course_activity_summary",
      args: ["course_id", "days"],
    }],
  ]);
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const windowDays = (value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_WINDOW_DAYS ? value : 0;
  const points = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const operation = object(input) ? input.operation : null;
  const spec = object(operation) && typeof operation.key === "string" ? OPERATIONS.get(operation.key) : undefined;
  const prefix = spec ? spec.prefix : "canvas_course_summary";
  const fail = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: `${prefix}_incomplete` });
  const args = object(input) ? input.arguments : null;
  const binding = object(input) ? input.binding : null;
  if (!object(input) || !spec || operation.toolName !== spec.tool || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== spec.args.length || spec.args.some((name) => !Object.hasOwn(args, name))
    || !id(args.course_id)
    || (spec.args.includes("assignment_id") && !id(args.assignment_id))
    || (spec.args.includes("days") && !windowDays(args.days))
    || !object(binding) || typeof binding.origin !== "string" || !id(binding.courseId) || !id(binding.principalId)
    || binding.courseId !== id(args.course_id) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) {
    return fail(`${prefix}_arguments_invalid`);
  }
  const courseId = id(args.course_id);
  const assignmentId = spec.args.includes("assignment_id") ? id(args.assignment_id) : "";
  const days = spec.args.includes("days") ? windowDays(args.days) : 0;
  let origin;
  try { origin = new URL(binding.origin); } catch { return fail(`${prefix}_context_invalid`); }
  if (origin.protocol !== "https:" || origin.origin !== binding.origin || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || globalThis.location?.origin !== origin.origin) return fail(`${prefix}_context_invalid`);
  const sameContext = () => globalThis.location?.origin === origin.origin && Date.now() <= input.expiresAt;
  const route = (path, query) => {
    const value = new URL(path, origin);
    if (query) value.search = new URLSearchParams(query).toString();
    return value;
  };
  const exactResponseUrl = (actual, expected) => {
    try {
      const received = new URL(actual);
      return received.href === expected.href && received.origin === origin.origin && !received.username && !received.password && !received.hash;
    } catch { return false; }
  };
  const boundedText = async (response, expected) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
    if (!response?.ok || !exactResponseUrl(response.url, expected) || !sameContext() || !response.body
      || typeof response.body.getReader !== "function" || typeof globalThis.TextDecoder !== "function") return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let result = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || (bytes += next.value.byteLength) > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return "limit";
        }
        result += decoder.decode(next.value, { stream: true });
      }
      return result + decoder.decode();
    } catch {
      try { await reader.cancel(); } catch {}
      return null;
    }
  };
  const request = async (expected) => {
    try {
      return await fetch(expected, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json+canvas-string-ids" },
      });
    } catch { return null; }
  };
  const json = async (expected) => {
    const response = await request(expected);
    if (!response) return null;
    const text = await boundedText(response, expected);
    if (text === "limit") return "limit";
    if (typeof text !== "string") return null;
    try { return JSON.parse(text); } catch { return null; }
  };
  /**
   * Accepts one `next` link only when it names the same route with the exact
   * query this read sent, plus one `page` value. Any other key, a repeated
   * key, a changed value, or a foreign origin is refused.
   */
  const paginationUrl = (raw, path, fixed) => {
    if (raw === null || raw === "") return null;
    if (typeof raw !== "string" || raw.length > 8_192) return "invalid";
    const matches = [];
    for (const part of raw.split(",")) {
      const match = /^\s*<([^<>]+)>\s*;\s*rel="([^"]+)"(?:\s*;\s*[^,]+)?\s*$/.exec(part);
      if (!match) return "invalid";
      if (match[2].split(/\s+/).includes("next")) matches.push(match[1]);
    }
    if (matches.length === 0) return null;
    if (matches.length !== 1) return "invalid";
    let next;
    try { next = new URL(matches[0], origin); } catch { return "invalid"; }
    if (next.origin !== origin.origin || next.pathname !== path || next.username || next.password || next.hash) return "invalid";
    const allowed = new Set([...Object.keys(fixed), "page"]);
    for (const key of next.searchParams.keys()) if (!allowed.has(key)) return "invalid";
    for (const [key, value] of Object.entries(fixed)) {
      const values = next.searchParams.getAll(key);
      if (values.length !== 1 || values[0] !== value) return "invalid";
    }
    const pages = next.searchParams.getAll("page");
    if (pages.length !== 1 || !pages[0] || pages[0].length > 1_024) return "invalid";
    return next;
  };
  /**
   * Reads one bounded course-scoped list. `onPage` counts the rows in the page
   * world and returns a refusal state, or an empty string when the page was
   * counted. The rows themselves never leave this function.
   */
  const readList = async (path, fixed, maxPages, onPage) => {
    const visited = new Set();
    let page = route(path, fixed);
    let pagesRead = 0;
    for (;;) {
      if (!sameContext()) return { state: "context_changed" };
      if (pagesRead >= maxPages) return { state: "incomplete" };
      if (visited.has(page.href)) return { state: "pagination_refused" };
      visited.add(page.href);
      const response = await request(page);
      if (!response) return { state: "unavailable" };
      const raw = await boundedText(response, page);
      if (raw === "limit") return { state: "incomplete" };
      if (typeof raw !== "string") return { state: "unavailable" };
      let payload;
      try { payload = JSON.parse(raw); } catch { return { state: "response_invalid" }; }
      if (!Array.isArray(payload)) return { state: "response_invalid" };
      const outcome = onPage(payload);
      if (outcome) return { state: outcome };
      pagesRead += 1;
      const next = paginationUrl(response.headers.get("link"), path, fixed);
      if (next === "invalid") return { state: "pagination_refused" };
      if (!next) return { state: "complete", pagesRead };
      page = next;
    }
  };
  const listFailure = (result) => {
    if (result.state === "incomplete") return incomplete();
    if (result.state === "context_changed") return fail(`${prefix}_context_changed`);
    if (result.state === "pagination_refused") return fail(`${prefix}_pagination_refused`);
    if (result.state === "response_invalid") return fail(`${prefix}_response_invalid`);
    return fail(`${prefix}_unavailable`);
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") return "";
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const coursePath = `/api/v1/courses/${encodeURIComponent(courseId)}`;
  const assignmentPath = `${coursePath}/assignments/${encodeURIComponent(assignmentId)}`;
  const profilePath = "/api/v1/users/self/profile";
  const bucketOf = (ratio) => ratio < 0.6 ? "below_60" : ratio < 0.7 ? "60_to_69" : ratio < 0.8 ? "70_to_79" : ratio < 0.9 ? "80_to_89" : "90_and_above";
  try {
    const profile = await json(route(profilePath));
    if (profile === "limit") return incomplete();
    if (!object(profile) || id(profile.id) !== binding.principalId) return fail(`${prefix}_context_changed`);
    const course = await json(route(coursePath));
    if (course === "limit") return incomplete();
    if (!object(course) || id(course.id) !== courseId) return fail(`${prefix}_target_unavailable`);

    let data = null;
    if (spec.tool === "canvas_get_assignment_submission_summary") {
      const assignment = await json(route(assignmentPath));
      if (assignment === "limit") return incomplete();
      if (!object(assignment) || id(assignment.id) !== assignmentId) return fail(`${prefix}_target_unavailable`);
      // Canvas reports needs_grading_count on the Assignment record only for a
      // role with grading rights. It is never inferred from the rows below.
      const needsGrading = Number.isSafeInteger(assignment.needs_grading_count) && assignment.needs_grading_count >= 0
        && assignment.needs_grading_count <= MAX_ROWS
        ? assignment.needs_grading_count
        : null;
      const counts = { unsubmitted: 0, submitted: 0, graded: 0, pending_review: 0 };
      let lateCount = 0;
      let missingCount = 0;
      let excusedCount = 0;
      let rowCount = 0;
      const submissionsPath = `${assignmentPath}/submissions`;
      const result = await readList(submissionsPath, { per_page: "100" }, MAX_PAGES, (rows) => {
        if (rowCount + rows.length > MAX_ROWS) return "incomplete";
        for (const row of rows) {
          const state = object(row) ? row.workflow_state : null;
          const late = object(row) ? row.late : null;
          const missing = object(row) ? row.missing : null;
          const excused = object(row) ? row.excused : null;
          if (!object(row) || id(row.assignment_id) !== assignmentId || typeof state !== "string" || !submissionStateSet.has(state)
            || (late !== null && late !== undefined && typeof late !== "boolean")
            || (missing !== null && missing !== undefined && typeof missing !== "boolean")
            || (excused !== null && excused !== undefined && typeof excused !== "boolean")) {
            return "response_invalid";
          }
          counts[state] += 1;
          if (late === true) lateCount += 1;
          if (missing === true) missingCount += 1;
          if (excused === true) excusedCount += 1;
        }
        rowCount += rows.length;
        return "";
      });
      if (result.state !== "complete") return listFailure(result);
      const assignmentAfter = await json(route(assignmentPath));
      if (assignmentAfter === "limit") return incomplete();
      if (!object(assignmentAfter) || id(assignmentAfter.id) !== assignmentId) return fail(`${prefix}_context_changed`);
      data = {
        schema: spec.schema,
        provider: PROVIDER,
        course_id: Number(courseId),
        assignment_id: Number(assignmentId),
        submission_count: rowCount,
        workflow_state_counts: counts,
        late_count: lateCount,
        missing_count: missingCount,
        excused_count: excusedCount,
        needs_grading_count: needsGrading,
        proof: {
          method: "GET /api/v1/courses/:course_id/assignments/:assignment_id/submissions",
          complete: true,
          pagination_complete: true,
          pages_read: result.pagesRead,
          response_row_count: rowCount,
          needs_grading_count_source: needsGrading === null ? "unavailable" : "assignment_record",
        },
      };
    }

    if (spec.tool === "canvas_get_course_gradebook_summary") {
      const assignments = new Map();
      const assignmentList = await readList(`${coursePath}/assignments`, { per_page: "100" }, MAX_PAGES, (rows) => {
        if (assignments.size + rows.length > MAX_ASSIGNMENTS) return "incomplete";
        for (const row of rows) {
          const rowId = object(row) ? id(row.id) : "";
          const possible = object(row) ? row.points_possible : null;
          if (!rowId || assignments.has(rowId)
            || (possible !== null && possible !== undefined && typeof possible !== "number")) return "response_invalid";
          assignments.set(rowId, {
            pointsPossible: points(possible),
            submitted: 0,
            graded: 0,
            pendingReview: 0,
            scored: 0,
            buckets: { below_60: 0, "60_to_69": 0, "70_to_79": 0, "80_to_89": 0, "90_and_above": 0 },
          });
        }
        return "";
      });
      if (assignmentList.state !== "complete") return listFailure(assignmentList);
      let rowCount = 0;
      const submissionQuery = { "student_ids[]": "all", per_page: "100" };
      const submissionList = await readList(`${coursePath}/students/submissions`, submissionQuery, MAX_SUBMISSION_PAGES, (rows) => {
        if (rowCount + rows.length > MAX_ROWS) return "incomplete";
        for (const row of rows) {
          const state = object(row) ? row.workflow_state : null;
          const target = object(row) ? assignments.get(id(row.assignment_id)) : undefined;
          const score = object(row) ? row.score : null;
          const excused = object(row) ? row.excused : null;
          if (!object(row) || !target || typeof state !== "string" || !submissionStateSet.has(state)
            || (score !== null && score !== undefined && typeof score !== "number")
            || (excused !== null && excused !== undefined && typeof excused !== "boolean")) {
            return "response_invalid";
          }
          if (state === "submitted") target.submitted += 1;
          if (state === "graded") target.graded += 1;
          if (state === "pending_review") target.pendingReview += 1;
          if (state === "graded" && excused !== true && typeof score === "number" && Number.isFinite(score) && target.pointsPossible > 0) {
            target.scored += 1;
            target.buckets[bucketOf(score / target.pointsPossible)] += 1;
          }
        }
        rowCount += rows.length;
        return "";
      });
      if (submissionList.state !== "complete") return listFailure(submissionList);
      const rows = [...assignments.entries()]
        .sort((left, right) => Number(left[0]) - Number(right[0]))
        .map(([rowId, entry]) => {
          // A distribution is published only when every published bucket holds
          // at least MINIMUM_COHORT scores. A cohort under that threshold, or a
          // single thin bucket inside it, would let one learner's score be
          // recovered, so the whole distribution for that assignment is dropped.
          const state = entry.pointsPossible <= 0
            ? "unscored_assignment"
            : entry.scored < MINIMUM_COHORT
              ? "suppressed_cohort_below_minimum"
              : SCORE_BUCKETS.some((bucket) => entry.buckets[bucket] > 0 && entry.buckets[bucket] < MINIMUM_COHORT)
                ? "suppressed_bucket_below_minimum"
                : "reported";
          return {
            assignment_id: Number(rowId),
            submitted_count: entry.submitted,
            graded_count: entry.graded,
            ungraded_count: entry.submitted + entry.pendingReview,
            scored_count: entry.scored,
            score_distribution_state: state,
            score_distribution: state === "reported" ? { ...entry.buckets } : null,
          };
        });
      data = {
        schema: spec.schema,
        provider: PROVIDER,
        course_id: Number(courseId),
        assignment_count: rows.length,
        submission_count: rowCount,
        minimum_cohort: MINIMUM_COHORT,
        assignments: rows,
        proof: {
          method: "GET /api/v1/courses/:course_id/students/submissions",
          complete: true,
          pagination_complete: true,
          assignment_pages_read: assignmentList.pagesRead,
          submission_pages_read: submissionList.pagesRead,
          response_row_count: rowCount,
          ungraded_definition: "submitted_and_pending_review",
          score_scale: "percentage_of_points_possible",
          minimum_bucket_population: MINIMUM_COHORT,
        },
      };
    }

    if (spec.tool === "canvas_get_course_activity_summary") {
      const windowStart = Date.now() - (days * DAY_MS);
      const kinds = {};
      let pagesRead = 0;
      for (const entry of ACTIVITY_KINDS) {
        let changed = 0;
        let items = 0;
        let timestamped = true;
        const result = await readList(`${coursePath}/${entry.segment}`, { per_page: "100" }, MAX_PAGES, (rows) => {
          if (items + rows.length > MAX_ITEMS) return "incomplete";
          for (const row of rows) {
            if (!object(row)) return "response_invalid";
            const stamp = typeof row[ACTIVITY_TIMESTAMP_FIELD] === "string" ? Date.parse(row[ACTIVITY_TIMESTAMP_FIELD]) : Number.NaN;
            // A row without this exact field cannot be placed in the window.
            // The kind reports that it is unavailable rather than counting it
            // as unchanged, which would understate the real activity.
            if (!Number.isFinite(stamp)) timestamped = false;
            else if (stamp >= windowStart) changed += 1;
          }
          items += rows.length;
          return "";
        });
        if (result.state !== "complete") return listFailure(result);
        pagesRead += result.pagesRead;
        kinds[entry.kind] = timestamped
          ? { state: "counted", changed_count: changed, item_count: items }
          : { state: "timestamp_unavailable", changed_count: null, item_count: items };
      }
      data = {
        schema: spec.schema,
        provider: PROVIDER,
        course_id: Number(courseId),
        window_days: days,
        window_start: new Date(windowStart).toISOString(),
        kinds,
        proof: {
          method: "GET /api/v1/courses/:course_id/{pages,assignments,discussion_topics,quizzes,modules}",
          complete: true,
          pagination_complete: true,
          pages_read: pagesRead,
          timestamp_field: ACTIVITY_TIMESTAMP_FIELD,
          item_limit_per_kind: MAX_ITEMS,
        },
      };
    }

    if (!data) return fail(`${prefix}_arguments_invalid`);
    const profileAfter = await json(route(profilePath));
    const courseAfter = await json(route(coursePath));
    if (profileAfter === "limit" || courseAfter === "limit") return incomplete();
    if (!sameContext() || !object(profileAfter) || id(profileAfter.id) !== binding.principalId
      || !object(courseAfter) || id(courseAfter.id) !== courseId) {
      return fail(`${prefix}_context_changed`);
    }
    const snapshotDigest = await digest(data);
    if (!snapshotDigest) return fail(`${prefix}_digest_unavailable`);
    return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
  } catch {
    return fail(`${prefix}_unavailable`);
  }
}
