/**
 * Reads one Classic Quiz submission list as an aggregate before data crosses
 * the browser bridge. Canvas QuizSubmission rows contain learner-linked data,
 * so this function returns only fixed count fields.
 */
export async function executeCanvasClassicQuizSubmissionSummaryInPage(rawInput) {
  const PROVIDER = "canvas";
  const OPERATION = "canvas.api.v1.course.quiz.submissions.aggregate.read.v1";
  const TOOL = "canvas_get_classic_quiz_submission_summary";
  const SCHEMA = "morrow.canvas-classic-quiz-submission-summary.v1";
  const MAX_RESPONSE_BYTES = 1024 * 1024;
  const MAX_PAGES = 25;
  const MAX_ATTEMPTS = 10_000;
  const ID = /^[1-9][0-9]{0,18}$/;
  const STATES = Object.freeze(["untaken", "pending_review", "complete", "settings_only", "preview"]);
  const stateSet = new Set(STATES);
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const fail = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: "canvas_classic_quiz_submission_summary_incomplete" });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const operation = input?.operation;
  const args = input?.arguments;
  const binding = input?.binding;
  if (!object(input) || !object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || Object.keys(args).length !== 2 || !id(args.course_id) || !id(args.quiz_id)
    || !object(binding) || typeof binding.origin !== "string" || !id(binding.courseId) || !id(binding.principalId)
    || binding.courseId !== id(args.course_id) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) {
    return fail("canvas_classic_quiz_submission_summary_arguments_invalid");
  }
  const courseId = id(args.course_id);
  const quizId = id(args.quiz_id);
  let origin;
  try { origin = new URL(binding.origin); } catch { return fail("canvas_classic_quiz_submission_summary_context_invalid"); }
  if (origin.protocol !== "https:" || origin.origin !== binding.origin || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || globalThis.location?.origin !== origin.origin) return fail("canvas_classic_quiz_submission_summary_context_invalid");
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
  const json = async (expected) => {
    let response;
    try {
      response = await fetch(expected, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json+canvas-string-ids" },
      });
    } catch { return null; }
    const text = await boundedText(response, expected);
    if (text === "limit") return "limit";
    if (typeof text !== "string") return null;
    try { return JSON.parse(text); } catch { return null; }
  };
  const paginationUrl = (raw, path) => {
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
    const keys = [...next.searchParams.keys()];
    if (keys.some((key) => key !== "page" && key !== "per_page")
      || next.searchParams.getAll("per_page").length !== 1 || next.searchParams.get("per_page") !== "100"
      || next.searchParams.getAll("page").length !== 1 || !next.searchParams.get("page") || next.searchParams.get("page").length > 1_024) return "invalid";
    return next;
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
  const quizPath = `${coursePath}/quizzes/${encodeURIComponent(quizId)}`;
  const submissionsPath = `${quizPath}/submissions`;
  try {
    const profile = await json(route("/api/v1/users/self/profile"));
    if (profile === "limit") return incomplete();
    if (!object(profile) || id(profile.id) !== binding.principalId) return fail("canvas_classic_quiz_submission_summary_context_changed");
    const course = await json(route(coursePath));
    if (course === "limit") return incomplete();
    if (!object(course) || id(course.id) !== courseId) return fail("canvas_classic_quiz_submission_summary_target_unavailable");
    const quiz = await json(route(quizPath));
    if (quiz === "limit") return incomplete();
    if (!object(quiz) || id(quiz.id) !== quizId) return fail("canvas_classic_quiz_submission_summary_target_unavailable");
    const counts = { untaken: 0, pending_review: 0, complete: 0, settings_only: 0, preview: 0 };
    const visited = new Set();
    let page = route(submissionsPath, { per_page: "100" });
    let pagesRead = 0;
    let attemptCount = 0;
    for (;;) {
      if (!sameContext()) return fail("canvas_classic_quiz_submission_summary_context_changed");
      if (pagesRead >= MAX_PAGES) return incomplete();
      if (visited.has(page.href)) return fail("canvas_classic_quiz_submission_pagination_refused");
      visited.add(page.href);
      let response;
      try {
        response = await fetch(page, {
          method: "GET", credentials: "include", cache: "no-store", redirect: "error",
          headers: { Accept: "application/json+canvas-string-ids" },
        });
      } catch { return fail("canvas_classic_quiz_submission_summary_unavailable"); }
      const raw = await boundedText(response, page);
      if (raw === "limit") return incomplete();
      if (typeof raw !== "string") return fail("canvas_classic_quiz_submission_summary_unavailable");
      let payload;
      try { payload = JSON.parse(raw); } catch { return fail("canvas_classic_quiz_submission_response_invalid"); }
      const rows = object(payload) && Array.isArray(payload.quiz_submissions) ? payload.quiz_submissions : null;
      if (!rows || attemptCount + rows.length > MAX_ATTEMPTS) return rows ? incomplete() : fail("canvas_classic_quiz_submission_response_invalid");
      for (const row of rows) {
        const state = object(row) ? row.workflow_state : null;
        if (!object(row) || id(row.quiz_id) !== quizId || typeof state !== "string" || !stateSet.has(state)) {
          return fail("canvas_classic_quiz_submission_response_invalid");
        }
        counts[state] += 1;
      }
      attemptCount += rows.length;
      pagesRead += 1;
      const next = paginationUrl(response.headers.get("link"), submissionsPath);
      if (next === "invalid") return fail("canvas_classic_quiz_submission_pagination_refused");
      if (!next) break;
      page = next;
    }
    const profileAfter = await json(route("/api/v1/users/self/profile"));
    const courseAfter = await json(route(coursePath));
    const quizAfter = await json(route(quizPath));
    if (profileAfter === "limit" || courseAfter === "limit" || quizAfter === "limit") return incomplete();
    if (!sameContext() || !object(profileAfter) || id(profileAfter.id) !== binding.principalId
      || !object(courseAfter) || id(courseAfter.id) !== courseId || !object(quizAfter) || id(quizAfter.id) !== quizId) {
      return fail("canvas_classic_quiz_submission_summary_context_changed");
    }
    const data = {
      schema: SCHEMA,
      provider: PROVIDER,
      course_id: Number(courseId),
      quiz_id: Number(quizId),
      attempt_count: attemptCount,
      complete_count: counts.complete,
      pending_review_count: counts.pending_review,
      workflow_state_counts: counts,
      proof: {
        method: "GET /api/v1/courses/:course_id/quizzes/:quiz_id/submissions",
        complete: true,
        pagination_complete: true,
        pages_read: pagesRead,
        response_row_count: attemptCount,
        needs_grading_count_proven: false,
      },
    };
    const snapshotDigest = await digest(data);
    if (!snapshotDigest) return fail("canvas_classic_quiz_submission_digest_unavailable");
    return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
  } catch {
    return fail("canvas_classic_quiz_submission_summary_unavailable");
  }
}
