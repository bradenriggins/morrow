// The reviewed bytes the plan carried are capped at 1 MiB. The bound is
// asserted by the plan schema (packages/mcp-server/src/canvas-new-quiz-hot-spot.ts
// size_bytes) and enforced again by the service worker's
// MAX_PRIVATE_FILE_BYTES before any dispatch, so this module only re-states it.
export const MAX_CANVAS_HOT_SPOT_IMAGE_BYTES = 1024 * 1024;

/**
 * The unsigned image URL a New Quizzes Hot Spot item carries.
 *
 * Canvas answers the media upload request with one signed URL, and its own
 * documentation says of the create that follows: "note: the query params
 * present on the signed url are not included here". So the item carries that
 * same URL with its query string and fragment removed, and nothing else. A URL
 * that is not https, or that carries a user name or a password, is refused
 * rather than trimmed, because trimming it would hide where the bytes went.
 */
export function unsignedHotSpotImageUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) throw new Error("canvas_hot_spot_upload_url_refused");
  let url;
  try { url = new URL(value); } catch { throw new Error("canvas_hot_spot_upload_url_refused"); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw new Error("canvas_hot_spot_upload_url_refused");
  url.search = "";
  url.hash = "";
  if (url.href.includes("?") || url.href.includes("#")) throw new Error("canvas_hot_spot_upload_url_refused");
  return url.href;
}

/**
 * This function is intentionally self-contained. Chrome serializes only the
 * supplied function body for a MAIN-world injection, so every helper it needs
 * lives inside it.
 *
 * It runs the two halves of the reviewed Hot Spot chain that must happen in the
 * signed-in Canvas page: `initialize` reads the current course, quiz, and
 * complete saved question list and asks Canvas for one signed media upload URL;
 * `complete` reads all of that again, then creates the question with the
 * unsigned URL and rereads what Canvas saved. The signed PUT of the image bytes
 * happens in the service worker between the two, because only the service
 * worker can observe that cross-origin response.
 */
export async function executeCanvasNewQuizHotSpotInPage(input) {
  const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const decimalId = (value) => {
    const id = String(value ?? "");
    return /^[1-9][0-9]{0,18}$/.test(id) ? id : "";
  };
  // connector/extension/src/canvas-write-outcome.js holds this one rule. Chrome
  // serializes an injected function without its module scope, so this copy of
  // the expression is checked against that file by
  // scripts/test/canvas-write-outcome-class.test.mjs.
  const canvasWriteOutcomeUncertain = (status) => !(
    Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (text) => Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const unsignedImageUrl = (value) => {
    if (typeof value !== "string" || value.length < 1 || value.length > 8192) throw new Error("canvas_hot_spot_upload_url_refused");
    let url;
    try { url = new URL(value); } catch { throw new Error("canvas_hot_spot_upload_url_refused"); }
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw new Error("canvas_hot_spot_upload_url_refused");
    url.search = "";
    url.hash = "";
    if (url.href.includes("?") || url.href.includes("#")) throw new Error("canvas_hot_spot_upload_url_refused");
    return url.href;
  };
  const failure = (error, sent = false, outcomeUnknown = false, status) => ({
    schema: "morrow.canvas-new-quiz-hot-spot.v1",
    ok: false,
    sent,
    outcomeUnknown,
    ...(Number.isSafeInteger(status) ? { status } : {}),
    ...(sent ? { verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error } } : {}),
    error,
  });

  const MAX_ITEMS = 10000;
  const PAGE_LIMIT = 100;
  let createDispatched = false;
  let createStatus;
  try {
    if (!plainObject(input) || !plainObject(input.binding) || !["initialize", "complete"].includes(input.mode)) {
      throw new Error("canvas_hot_spot_binding_invalid");
    }
    const canvasOrigin = typeof input.binding.origin === "string" ? input.binding.origin : "";
    const courseId = decimalId(input.binding.courseId);
    const principalId = decimalId(input.binding.principalId);
    const assignmentId = decimalId(input.assignmentId);
    const beforeItemsSha256 = typeof input.beforeItemsSha256 === "string" && /^[a-f0-9]{64}$/.test(input.beforeItemsSha256)
      ? input.beforeItemsSha256
      : "";
    if (!canvasOrigin || !courseId || !principalId || !assignmentId || !beforeItemsSha256 || location.origin !== canvasOrigin) {
      throw new Error("canvas_hot_spot_binding_invalid");
    }
    const origin = new URL(canvasOrigin);
    if (origin.protocol !== "https:" || origin.href !== canvasOrigin + "/") throw new Error("canvas_hot_spot_binding_invalid");

    const canvasFetch = async (pathname, options = {}) => {
      let response;
      try {
        response = await fetch(new URL(pathname, canvasOrigin), {
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          ...options,
          headers: { Accept: "application/json+canvas-string-ids", ...(options.headers || {}) },
        });
      } catch {
        throw new Error("canvas_hot_spot_transport_unavailable");
      }
      let received;
      try { received = new URL(response.url); } catch { throw new Error("canvas_hot_spot_origin_changed"); }
      if (received.origin !== canvasOrigin) throw new Error("canvas_hot_spot_origin_changed");
      return response;
    };
    const canvasJson = async (pathname, options = {}) => {
      const response = await canvasFetch(pathname, options);
      if (!response.ok) throw new Error("canvas_hot_spot_http_" + response.status);
      return await response.json();
    };
    const quizPath = `/api/quiz/v1/courses/${encodeURIComponent(courseId)}/quizzes/${encodeURIComponent(assignmentId)}`;
    const currentBinding = async () => {
      const profile = await canvasJson("/api/v1/users/self/profile");
      if (decimalId(profile?.id) !== principalId) throw new Error("canvas_principal_changed");
      const course = await canvasJson("/api/v1/courses/" + encodeURIComponent(courseId));
      if (decimalId(course?.id) !== courseId) throw new Error("canvas_hot_spot_course_changed");
      const quiz = await canvasJson(quizPath);
      if (decimalId(quiz?.id) !== assignmentId) throw new Error("canvas_hot_spot_quiz_changed");
    };
    // The complete saved question list is the authority on what this quiz
    // holds. A partial list would make both the freshness check and the
    // readback meaningless, so an incomplete read is an error, never a shorter
    // list.
    const membership = async () => {
      const rows = [];
      let next = `${quizPath}/items?per_page=${PAGE_LIMIT}`;
      let pages = 0;
      while (next && pages < Math.ceil(MAX_ITEMS / PAGE_LIMIT)) {
        const response = await canvasFetch(next);
        if (!response.ok) throw new Error("canvas_hot_spot_item_list_read_failed");
        const page = await response.json();
        if (!Array.isArray(page) || page.length > PAGE_LIMIT || rows.length + page.length > MAX_ITEMS) {
          throw new Error("canvas_hot_spot_item_list_incomplete");
        }
        rows.push(...page);
        pages += 1;
        const link = response.headers.get("Link") || "";
        const found = link.split(",").map((entry) => entry.trim())
          .find((entry) => /;\s*rel="?next"?\s*$/.test(entry));
        const href = found ? /^<([^>]+)>/.exec(found)?.[1] : "";
        if (!href) { next = null; break; }
        let parsed;
        try { parsed = new URL(href, canvasOrigin); } catch { throw new Error("canvas_hot_spot_item_list_incomplete"); }
        if (parsed.origin !== canvasOrigin || !parsed.pathname.startsWith(quizPath + "/items")) {
          throw new Error("canvas_hot_spot_item_list_incomplete");
        }
        next = parsed.pathname + parsed.search;
      }
      if (next) throw new Error("canvas_hot_spot_item_list_incomplete");
      const ids = new Set();
      const positions = new Set();
      const positioned = [];
      for (const row of rows) {
        const id = plainObject(row) ? decimalId(row.id) : "";
        const position = plainObject(row) && Number.isSafeInteger(row.position) && row.position >= 1 ? row.position : null;
        const entryType = plainObject(row) && typeof row.entry_type === "string" && row.entry_type.length <= 100
          && row.entry_type.trim() === row.entry_type ? row.entry_type : "";
        if (!id || !entryType || position === null || ids.has(id) || positions.has(position)) {
          throw new Error("canvas_hot_spot_item_list_invalid");
        }
        ids.add(id);
        positions.add(position);
        positioned.push({ id, position, entry_type: entryType });
      }
      return positioned.sort((left, right) => left.position - right.position);
    };
    const currentMembership = async () => {
      const items = await membership();
      if (await digest(stable(items)) !== beforeItemsSha256) throw new Error("canvas_hot_spot_item_list_stale");
      return items;
    };

    await currentBinding();
    const before = await currentMembership();

    if (input.mode === "initialize") {
      const started = await canvasJson(`${quizPath}/items/media_upload_url`);
      const uploadUrl = plainObject(started) && typeof started.url === "string" ? started.url : "";
      if (!uploadUrl) throw new Error("canvas_hot_spot_upload_url_missing");
      let signed;
      try { signed = new URL(uploadUrl); } catch { throw new Error("canvas_hot_spot_upload_url_refused"); }
      if (signed.protocol !== "https:" || signed.username || signed.password) throw new Error("canvas_hot_spot_upload_url_refused");
      // Proves the trimmed form is a usable URL before any byte is sent.
      unsignedImageUrl(uploadUrl);
      return {
        schema: "morrow.canvas-new-quiz-hot-spot.v1",
        ok: true,
        sent: false,
        outcomeUnknown: false,
        data: { course_id: courseId, assignment_id: assignmentId, item_count: before.length, upload_url: signed.href },
      };
    }

    const template = input.item;
    if (!plainObject(template) || template.entry_type !== "Item" || !plainObject(template.entry)
      || template.entry.interaction_type_slug !== "hot-spot" || !plainObject(template.entry.interaction_data)
      || Object.hasOwn(template.entry.interaction_data, "image_url")) {
      throw new Error("canvas_hot_spot_payload_invalid");
    }
    if (typeof input.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.payloadSha256)
      || await digest(stable(template)) !== input.payloadSha256) {
      throw new Error("canvas_hot_spot_payload_changed");
    }
    const imageUrl = unsignedImageUrl(input.upload_url);
    const item = {
      ...template,
      entry: { ...template.entry, interaction_data: { ...template.entry.interaction_data, image_url: imageUrl } },
    };
    const csrfCookie = document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("_csrf_token="));
    const csrf = csrfCookie ? decodeURIComponent(csrfCookie.slice("_csrf_token=".length)) : "";
    if (!csrf) throw new Error("canvas_csrf_context_missing");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) throw new Error("canvas_request_expired_before_send");

    createDispatched = true;
    const created = await canvasFetch(`${quizPath}/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "X-CSRF-Token": csrf,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ item }),
    });
    createStatus = created.status;
    if (!created.ok) throw new Error("canvas_hot_spot_create_http_" + created.status);
    let body;
    try { body = await created.json(); } catch { throw new Error("canvas_hot_spot_create_response_invalid"); }
    const createdId = decimalId(plainObject(body) ? body.id : "");
    if (!createdId) throw new Error("canvas_hot_spot_create_response_invalid");

    // Nothing above is treated as proof. What Canvas saved is read back: the
    // question by the id Canvas returned, and the complete saved list again.
    const saved = await canvasJson(`${quizPath}/items/${encodeURIComponent(createdId)}`);
    const savedEntry = plainObject(saved) ? saved.entry : null;
    const savedInteraction = plainObject(savedEntry) ? savedEntry.interaction_data : null;
    if (!plainObject(saved) || decimalId(saved.id) !== createdId || saved.entry_type !== "Item"
      || !plainObject(savedEntry) || savedEntry.interaction_type_slug !== "hot-spot"
      || !plainObject(savedInteraction) || savedInteraction.image_url !== imageUrl) {
      return {
        schema: "morrow.canvas-new-quiz-hot-spot.v1",
        ok: false, sent: true, outcomeUnknown: true, status: createStatus,
        verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "canvas_hot_spot_item_readback_mismatch" },
        error: "canvas_hot_spot_item_readback_mismatch",
      };
    }
    const after = await membership();
    const beforeIds = before.map((entry) => entry.id);
    const afterIds = after.map((entry) => entry.id);
    const additions = afterIds.filter((id) => !beforeIds.includes(id));
    const removed = beforeIds.filter((id) => !afterIds.includes(id));
    if (after.length !== before.length + 1 || additions.length !== 1 || additions[0] !== createdId || removed.length !== 0) {
      return {
        schema: "morrow.canvas-new-quiz-hot-spot.v1",
        ok: false, sent: true, outcomeUnknown: true, status: createStatus,
        verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "canvas_hot_spot_membership_mismatch" },
        error: "canvas_hot_spot_membership_mismatch",
      };
    }
    return {
      schema: "morrow.canvas-new-quiz-hot-spot.v1",
      ok: true,
      sent: true,
      outcomeUnknown: false,
      status: createStatus,
      verification: {
        schema: "morrow.browser-verification.v1",
        status: "verified",
        strategy: "new-quiz-item-lifecycle",
        evidence: "created_item_reread_and_complete_item_list_reread",
        targets: [
          { type: "canvas_course", id: courseId },
          { type: "canvas_new_quiz", id: assignmentId },
          { type: "canvas_new_quiz_item", id: createdId },
        ],
      },
      data: {
        course_id: courseId,
        assignment_id: assignmentId,
        item_id: createdId,
        item_count: after.length,
        image_url: imageUrl,
        interaction_type_slug: "hot-spot",
      },
    };
  } catch (error) {
    return failure(
      String(error?.message || error),
      createDispatched,
      createDispatched && canvasWriteOutcomeUncertain(createStatus),
      createStatus,
    );
  }
}
