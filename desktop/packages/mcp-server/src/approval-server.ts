import { existsSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { brandHead, brandHeader, serveBrandAsset } from "@morrow/bridge-loopback";
import { canvasOperationMap, loadCanvasApiCatalog } from "@morrow/canvas-api-catalog";
import { isCorrectableEffectOperation, type EffectOperationState, type EffectVerificationStatus } from "@morrow/operation-journal";
import type { ApprovalReviewContext, ApprovalReviewReadCache } from "./approval-context.js";
import { escapeHtml, formattedTextPreview } from "./approval-preview.js";
import { BLACKBOARD_CONTENT_PATCH_APPLY_TOOL } from "./blackboard-content-patch.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_APPROVAL_NONCES = 128;
const MAX_APPROVAL_NONCES_PER_TARGET = 8;
const HTTP_HEADERS_TIMEOUT_MS = 10_000;
const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 1_000;
const HTTP_SHUTDOWN_GRACE_MS = 250;
// WI-6.4: "Recent changes" (`/recent`) carries no operation id in its address, so nothing in the
// URL gates who can read it. The one-time entry code and the session it exchanges for are its
// only gate, sized and timed like the review page's own nonce and cookie (F19).
const RECENT_COOKIE_NAME = "morrow_recent";
const RECENT_ENTRY_TTL_MS = 900_000;
const RECENT_SESSION_TTL_MS = 900_000;
const MAX_RECENT_ENTRIES = 16;
const MAX_RECENT_SESSIONS = 16;
const RECENT_OPERATIONS_READ = 200;
const RECENT_CHANGES_SHOWN = 50;

/**
 * Fields that identify which item a change reaches, not what changes about it.
 * They read as machine identifiers on the review page (an ID, a URL slug), so
 * they always move into Technical details, whether or not the review context
 * resolved a human name for the item they point to.
 */
const STRUCTURAL_EDIT_FIELDS = ["course_id", "assignment_id", "quiz_id", "content_id", "connection_id", "target_section_id", "url_or_id"];

interface AcceptedHttpRequest {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

interface TrackedHttpRequest {
  readonly controller: AbortController;
  readonly release: () => void;
}

export class BoundedHttpServerLifecycle {
  private readonly sockets = new Set<Socket>();
  private readonly requests = new Map<IncomingMessage, TrackedHttpRequest>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly server: Server,
    private readonly shutdownGraceMs = HTTP_SHUTDOWN_GRACE_MS,
  ) {
    server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
    server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
    server.on("connection", (socket) => {
      if (this.closing) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  accept(request: IncomingMessage, response: ServerResponse): AcceptedHttpRequest | null {
    if (this.closing) return null;
    const controller = new AbortController();
    let released = false;
    const abort = (): void => controller.abort();
    const release = (): void => {
      if (released) return;
      released = true;
      request.off("aborted", abort);
      response.off("finish", release);
      response.off("close", close);
      this.requests.delete(request);
    };
    const close = (): void => {
      if (!response.writableEnded) controller.abort();
      release();
    };
    request.once("aborted", abort);
    response.once("finish", release);
    response.once("close", close);
    this.requests.set(request, { controller, release });
    return { signal: controller.signal, release };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeBounded();
    return this.closePromise;
  }

  private async closeBounded(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    });
    for (const [request, tracked] of this.requests) {
      tracked.controller.abort();
      if (!request.complete) request.destroy();
    }
    const forceClose = setTimeout(() => {
      for (const socket of this.sockets) socket.destroy();
      this.server.closeAllConnections?.();
    }, this.shutdownGraceMs);
    try {
      await closed;
    } finally {
      clearTimeout(forceClose);
      for (const tracked of this.requests.values()) tracked.release();
      this.requests.clear();
      this.sockets.clear();
    }
  }
}

// WI-4.4: the "do not ask again" bundle a review may offer, mirroring runtime.ts's own
// `RememberOfferResult` shape by value rather than by import, so this file stays free of a
// dependency on the runtime module the way its other controller methods already are.
export interface RememberOffer {
  readonly categoryId: string;
  readonly label: string;
  readonly joinsTimedGrant?: true;
}

/**
 * The key Morrow Bridge uses to sign one approval click. It leaves this process only toward the
 * Bridge, over the paired connection, and never appears in a page, header, or URL: a program that
 * reads the review page over HTTP gets the nonce but not the key, so it cannot approve.
 */
export interface ReviewApprovalPresence {
  readonly origin: string;
  readonly key: string;
}

const REVIEW_APPROVAL_PROOF_CONTEXT = "morrow.review-approval.v1";

/** The value Morrow Bridge adds to the approval form after a real click in the review tab. */
export function reviewApprovalProof(key: string, approvePath: string, nonce: string): string {
  return createHmac("sha256", Buffer.from(key, "base64url"))
    .update(`${REVIEW_APPROVAL_PROOF_CONTEXT}\n${approvePath}\n${nonce}`)
    .digest("base64url");
}

export interface ApprovalOperationController {
  operationGet(operationId: string): JsonObject;
  operationList(limit?: number): JsonObject;
  operationReviewContext?(operationId: string, cache?: ApprovalReviewReadCache): Promise<ApprovalReviewContext>;
  approveOperation(operationId: string): JsonObject;
  runApprovedOperation(operationId: string, signal: AbortSignal): Promise<unknown>;
  cancelOperation(operationId: string): JsonObject;
  setApprovalBaseUrl(baseUrl: string): void;
  /** Hands the approval key to the runtime, which sends it only to the paired Morrow Bridge. */
  setApprovalPresence?(presence: ReviewApprovalPresence): void;
  /** A review page with an approve button opened: send the key to Morrow Bridge again. */
  announceApprovalPresence?(): void;
  /**
   * Who each learner label on the review at `reviewPath` is, or null when the review names no
   * one or has ended. The runtime sends it only to the paired Morrow Bridge, which shows the names
   * in the review tab. This server never puts a name in a page or a JSON answer, because any
   * local program can read those.
   */
  setReviewLearnerNames?(reviewPath: string, names: Readonly<Record<string, string>> | null): void;
  batchApprovalGet?(batchId: string): JsonObject;
  batchApprovalStatus?(batchId: string): JsonObject;
  approveBatch?(batchId: string): JsonObject;
  runApprovedBatch?(batchId: string, signal: AbortSignal): Promise<unknown>;
  // WI-4.3/WI-4.4: only a single operation's review page offers "do not ask again" (a batch id
  // is never in the runtime's operation-record store, so an absent method or a lookup miss both
  // read the same way here: no offer). Optional so every existing test double, and any future
  // controller that never grants Edit access, still satisfies this interface unchanged.
  rememberOffer?(operationId: string): Promise<RememberOffer | null>;
  rememberKind?(operationId: string): Promise<"saved" | "failed">;
  cancelBatchApproval?(batchId: string): JsonObject;
  /**
   * WI-6.4: the name of the course or site a change reached, keyed by the operation's
   * `sourceBindingId`, for the "Recent changes" list. A cheap, already-known lookup, the
   * connections a person has open now, never a fresh platform read: the spec forbids reading
   * titles from the platform for 50 old operations, and a course name must cost no more than
   * that. Optional so every existing test double, and a controller with no open connections,
   * still satisfies this interface unchanged; a miss just leaves the course name off the row.
   */
  connectionName?(sourceBindingId: string | null): string | null | undefined;
  /**
   * Edit asked for in a conversation (`morrow_request_edit_access`). The page names the courses
   * and the kinds of change, and `approveEditAccess` is reached only after the same Morrow Bridge
   * signature an approval needs, so neither the assistant nor another local program can turn Edit
   * on. `approveEditAccess` answers `approved: true` only for the call that started the save.
   */
  editAccessGet?(editAccessId: string): JsonObject;
  approveEditAccess?(editAccessId: string): JsonObject;
  runApprovedEditAccess?(editAccessId: string, signal: AbortSignal): Promise<unknown>;
  cancelEditAccess?(editAccessId: string): JsonObject;
  /** Whether the status page of this unresolved change offers the person its close-out. */
  personCloseAvailable?(operationId: string): boolean;
  /** Closes the change after the person's own click on its status page, signed by Morrow Bridge. */
  confirmPersonClose?(operationId: string): Promise<JsonObject>;
}

interface ApprovalTarget {
  readonly kind: "operations" | "batches" | "edit-access";
  readonly id: string;
  readonly action?: "approve" | "cancel" | "close" | "status";
}

function approvalPath(pathname: string): ApprovalTarget | null {
  const match = /^\/(operations|batches|edit-access)\/([^/]+?)(?:\/(approve|cancel|close|status))?$/.exec(pathname);
  if (!match) return null;
  try {
    return {
      kind: match[1] as ApprovalTarget["kind"],
      id: decodeURIComponent(match[2]!),
      ...(match[3] ? { action: match[3] as ApprovalTarget["action"] } : {}),
    };
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, status: number, body: JsonObject): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, body: string, cookie?: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    ...(cookie ? { "set-cookie": cookie } : {}),
  });
  response.end(body);
}

// The card holds the whole page and the <h1> inside it names that page, so the
// card carries no label of its own. A second name here would conflict with it.
function pageShell(title: string, body: string, polling = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Morrow</title>${brandHead}<script src="/review-status.js" defer></script></head><body${polling ? ' data-polling="true"' : ""}><main class="wrap">${brandHeader}<article class="card">${body}</article><p class="foot">This review stays on your computer.</p></main></body></html>`;
}

const STATUS_SCRIPT = `const changeList = document.querySelector(".change-list");
if (changeList) {
  const items = [...changeList.querySelectorAll(".change-item")];
  const search = document.getElementById("change-search");
  const previous = document.getElementById("changes-previous");
  const next = document.getElementById("changes-next");
  const count = document.getElementById("changes-count");
  let page = 0;
  const render = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const matches = items.filter((item) => item.dataset.search.includes(query));
    const visible = matches.slice(page * 10, (page + 1) * 10);
    items.forEach((item) => { item.hidden = !visible.includes(item); });
    count.textContent = matches.length === 1 ? "Showing 1 change" : matches.length ? "Showing " + (page * 10 + 1) + "–" + Math.min((page + 1) * 10, matches.length) + " of " + matches.length + " changes" : "No changes match your search.";
    previous.disabled = page === 0;
    next.disabled = (page + 1) * 10 >= matches.length;
  };
  search.addEventListener("input", () => { page = 0; render(); });
  previous.addEventListener("click", () => { page = Math.max(0, page - 1); render(); });
  next.addEventListener("click", () => { page += 1; render(); });
  document.querySelector(".change-list-controls").hidden = false;
  document.querySelector(".change-pagination").hidden = false;
  render();
}
document.querySelectorAll(".recent-reverse-copy").forEach((button) => {
  const text = button.dataset.copyText || "";
  button.addEventListener("click", () => {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => { button.textContent = "Copied"; })
      .catch(() => { button.textContent = "Copy the text above instead"; });
  });
});
document.querySelectorAll(".question-preview").forEach((preview) => {
  const modes = preview.querySelector(".preview-modes");
  if (!modes) return;
  modes.hidden = false;
  const inputs = [...preview.querySelectorAll(".answer-input")];
  const practice = preview.querySelector(".practice-actions");
  const result = preview.querySelector(".practice-result");
  const reset = () => {
    inputs.forEach((input) => { input.checked = false; });
    result.replaceChildren();
    result.hidden = true;
  };
  inputs.forEach((input) => input.addEventListener("change", () => { result.replaceChildren(); result.hidden = true; }));
  modes.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    preview.dataset.mode = button.dataset.mode;
    modes.querySelectorAll("button").forEach((mode) => mode.setAttribute("aria-pressed", String(mode === button)));
    practice.hidden = button.dataset.mode !== "student";
    reset();
  }));
  preview.querySelectorAll(".answer-option").forEach((option) => option.addEventListener("click", (event) => {
    const input = option.querySelector("input");
    if (preview.dataset.mode === "student" && event.target !== input && !event.target.closest("details")) input.click();
  }));
  preview.querySelector(".practice-reset").addEventListener("click", reset);
  preview.querySelector(".practice-check").addEventListener("click", () => {
    result.replaceChildren();
    const message = document.createElement("p");
    message.className = "practice-message";
    if (!inputs.some((input) => input.checked)) message.textContent = "Choose an answer first.";
    else {
      const matches = inputs.every((input) => input.checked === (input.dataset.correct === "true"));
      message.textContent = matches ? "This matches the answer key." : "This does not match the answer key. You can try again.";
      result.append(message);
      const feedback = preview.querySelector('[data-feedback="' + (matches ? "correct" : "incorrect") + '"] .formatted-preview');
      if (feedback) result.append(feedback.cloneNode(true));
      const general = preview.querySelector('[data-feedback="neutral"] .formatted-preview');
      if (general) result.append(general.cloneNode(true));
      inputs.filter((input) => input.checked).forEach((input) => {
        const answerFeedback = input.closest("li").querySelector(".answer-feedback .formatted-preview");
        if (answerFeedback) result.append(answerFeedback.cloneNode(true));
      });
    }
    if (!result.contains(message)) result.append(message);
    result.hidden = false;
  });
});
const status = document.getElementById("work-status");
const statusNodes = document.querySelectorAll("[data-operation-status]");
let statusTimer;
function scheduleStatusRefresh(delay) {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(refreshStatus, delay);
}
async function refreshStatus() {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(location.pathname + "/status", {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("status unavailable");
    const result = await response.json();
    if (status.innerHTML !== result.html) status.innerHTML = result.html;
    Object.entries(result.states || {}).forEach(([index, text]) => {
      const element = statusNodes[Number(index)];
      if (element && typeof text === "string" && element.textContent !== text) element.textContent = text;
    });
    if (result.active) scheduleStatusRefresh(1000);
    else document.getElementById("stop-work")?.remove();
  } catch {
    status.textContent = "Morrow cannot refresh this result. Reload this page to check it. Do not repeat the change.";
    scheduleStatusRefresh(5000);
  } finally {
    clearTimeout(deadline);
  }
}
if (status && document.body.dataset.polling === "true") void refreshStatus();`;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

const EFFECT_STATES = new Set([
  "awaiting_approval", "approved", "dispatching", "awaiting_inner_approval", "awaiting_verification",
  "verified", "failed", "applied_or_unknown", "cancelled", "closed_by_person",
]);
const VERIFICATION_STATES = new Set(["not_requested", "unconfirmed", "verified", "mismatch"]);
const OPERATION_ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const EFFECT_RECEIPT_ID = /^effect:[a-f0-9-]{36}$/;

function technicalOperation(operation: JsonObject): JsonObject {
  const status: JsonObject = {};
  if (typeof operation.state === "string" && EFFECT_STATES.has(operation.state)) {
    status.state = operation.state;
  }
  if (typeof operation.verificationStatus === "string" && VERIFICATION_STATES.has(operation.verificationStatus)) {
    status.verification = operation.verificationStatus;
  }
  const receipt: JsonObject = {};
  if (typeof operation.effectReceiptId === "string" && EFFECT_RECEIPT_ID.test(operation.effectReceiptId)) {
    receipt.effectReceiptId = operation.effectReceiptId;
  }
  if (Number.isSafeInteger(operation.dispatchAttempt) && Number(operation.dispatchAttempt) >= 0) {
    receipt.dispatchAttempt = Number(operation.dispatchAttempt);
  }
  return {
    ...(typeof operation.operationId === "string" && OPERATION_ID.test(operation.operationId)
      ? { operationId: operation.operationId } : {}),
    ...(Object.keys(status).length ? { status } : {}),
    ...(Object.keys(receipt).length ? { receipt } : {}),
  };
}

function technicalDetails(target: ApprovalTarget, snapshot: JsonObject): JsonObject {
  const operations = target.kind === "batches" && Array.isArray(snapshot.children)
    ? snapshot.children.map((child) => object(object(child).operation)) : [snapshot];
  return {
    schema: "morrow.approval-technical-details.v1",
    status: reviewState(target, snapshot),
    operations: operations.map(technicalOperation),
  };
}

function operationsList(snapshot: JsonObject): JsonObject {
  const operations = Array.isArray(snapshot.operations) ? snapshot.operations.map(object) : [];
  return {
    schema: "morrow.approval-operations.list.v1",
    returned: operations.length,
    operations: operations.map(technicalOperation),
  };
}

function readableName(value: string): string {
  const names: Record<string, string> = {
    moodle_get_assignment_creation_form: "Prepare assignment",
    moodle_create_assignment: "Add assignment",
    moodle_get_quiz_creation_form: "Prepare quiz",
    moodle_create_quiz: "Add quiz",
    moodle_get_page_creation_form: "Prepare Page",
    moodle_create_page: "Add Page",
    moodle_get_label_creation_form: "Prepare text area",
    moodle_create_label: "Add text area",
    moodle_get_url_creation_form: "Prepare link",
    moodle_create_url: "Add link",
    moodle_get_resource_file_creation_form: "Prepare course file",
    moodle_create_resource_file: "Add course file",
    moodle_get_folder_file_creation_form: "Prepare Folder file",
    moodle_create_folder_file: "Add Folder file",
    moodle_get_imscp_package_creation_form: "Prepare IMS content package",
    moodle_create_imscp_package: "Add IMS content package",
    moodle_get_scorm_package_creation_form: "Prepare SCORM package",
    moodle_create_scorm_package: "Add SCORM package",
    moodle_get_forum_creation_form: "Prepare forum",
    moodle_create_forum: "Add forum",
    moodle_get_choice_creation_form: "Prepare choice",
    moodle_create_choice: "Add choice",
    moodle_get_book_creation_form: "Prepare Book",
    moodle_create_book: "Add Book",
    moodle_get_lesson_creation_form: "Prepare Lesson",
    moodle_create_lesson: "Add Lesson",
    moodle_get_glossary_creation_form: "Prepare Glossary",
    moodle_create_glossary: "Add Glossary",
    moodle_get_wiki_creation_form: "Prepare Wiki",
    moodle_create_wiki: "Add Wiki",
    moodle_get_feedback_creation_form: "Prepare Feedback",
    moodle_create_feedback: "Add Feedback",
    moodle_get_database_creation_form: "Prepare Database",
    moodle_create_database: "Add Database",
    moodle_get_workshop_creation_form: "Prepare Workshop",
    moodle_create_workshop: "Add Workshop",
    moodle_get_qbank_activity_creation_form: "Prepare question bank",
    moodle_create_qbank_activity: "Add question bank",
    moodle_create_subsection: "Add subsection",
    moodle_list_my_courses: "List courses",
    moodle_get_course: "View course",
    moodle_get_contents: "View course content",
    moodle_list_assignments: "List assignments",
    moodle_list_quizzes: "List quizzes",
    moodle_get_course_summary: "View course description",
    moodle_get_section: "View section",
    moodle_get_page: "View Page",
    moodle_get_label: "View text area",
    moodle_get_url: "View link",
    moodle_get_assignment: "View assignment",
    moodle_get_quiz: "View quiz",
    moodle_update_course_summary: "Edit description",
    moodle_update_section: "Edit section",
    moodle_update_page: "Edit Page",
    moodle_update_label: "Edit text area",
    moodle_update_url: "Edit link",
    moodle_update_assignment: "Edit assignment",
    moodle_update_quiz: "Edit quiz",
    moodle_update_grade_category: "Rename category",
    moodle_update_grade_item: "Rename grade item",
    moodle_update_grade_category_settings: "Change category settings",
    moodle_update_grade_item_settings: "Change grade item settings",
    rescale_existing_grades: "Effect on existing grades",
    moodle_delete_book_chapter: "Delete Book chapter",
    moodle_show_course: "Show course",
    moodle_hide_course: "Hide course",
    moodle_show_section: "Show section",
    moodle_hide_section: "Hide section",
    moodle_show_activity: "Show activity",
    moodle_hide_activity: "Hide activity",
    moodle_move_activity: "Move activity",
    blackboard_apply_reviewed_content_patch: "Edit item",
    blackboard_apply_reviewed_course_copy: "Copy Blackboard course",
    source_course_id: "Source Course ID",
    destination_course_id: "New Course ID",
    limit: "Maximum courses",
    course_id: "Course ID",
    section_id: "Section ID",
    module_id: "Activity ID",
    chapter_id: "Chapter ID",
    target_section_id: "Destination section",
    category_id: "Grade category ID",
    grade_item_id: "Manual grade item ID",
    fullname: "New name",
    item_name: "New name",
    current_section: "Current section",
    hidden: "Currently hidden",
    affected_chapters: "Chapters affected",
    summary: "Summary",
    content: "Content",
    filename: "File name",
    size_bytes: "File size in bytes",
    sha256: "File fingerprint (SHA-256)",
    external_url: "Web address",
    instructions: "Instructions",
    available_from: "Submissions open",
    due_date: "Due date and time",
    cutoff_at: "Final submission deadline",
    grading_due_at: "Grading due",
    open_at: "Open date and time",
    close_at: "Close date and time",
    question_text: "Question text",
    default_mark: "Default mark",
    answers: "Answers",
    answer_text: "Answer text",
    correct_answer: "Correct answer",
    feedback: "Answer feedback",
    visible: "Visible to learners",
    body: "Lesson content",
    canvas_create_page_courses: "Add Page",
    canvas_update_create_page_courses: "Edit Page",
    canvas_update_create_front_page_courses: "Edit home page",
    canvas_create_assignment: "Add assignment",
    canvas_edit_assignment: "Edit assignment",
    canvas_create_new_discussion_topic_courses: "Add discussion",
    canvas_update_topic_courses: "Edit discussion",
    canvas_create_new_quiz: "Add quiz",
    canvas_update_single_quiz: "Edit quiz",
    canvas_delete_file: "Remove file",
    canvas_update_file: "Edit file",
    canvas_delete_single: "Remove rubric",
    canvas_update_single_rubric: "Edit rubric",
    wiki_page_body: "Page content",
    wiki_page_title: "Page title",
    assignment_description: "Assignment instructions",
    assignment_name: "Assignment name",
    assignment_due_at: "Due date",
    assignment_unlock_at: "Available from",
    assignment_lock_at: "Available until",
    assignment_points_possible: "Points",
    assignment_submission_types: "Students submit",
    assignment_published: "Visible to students",
    wiki_page_published: "Visible to students",
    wiki_page_notify_of_update: "Notify students",
    wiki_page_editing_roles: "Who can edit",
    wiki_page_front_page: "Set as front page",
    published: "Visible to students",
    delayed_post_at: "Post on",
    require_initial_post: "Students post before seeing replies",
    is_announcement: "Post as an announcement",
    rubric_data: "Rubric criteria",
    long_description: "Description",
    points: "Points",
    quiz_instructions: "Quiz instructions",
    quiz_description: "Quiz description",
    quiz_quiz_settings_allow_backtracking: "Allow returning to previous questions",
    quiz_quiz_settings_calculator_type: "Calculator",
    quiz_quiz_settings_filter_ip_address: "Restrict access by IP address",
    quiz_quiz_settings_filters_ips: "Allowed IP address ranges",
    quiz_quiz_settings_has_time_limit: "Use a time limit",
    quiz_quiz_settings_session_time_limit_in_seconds: "Time limit in seconds",
    quiz_quiz_settings_multiple_attempts_multiple_attempts_enabled: "Allow multiple attempts",
    quiz_quiz_settings_multiple_attempts_attempt_limit: "Limit the number of attempts",
    quiz_quiz_settings_multiple_attempts_max_attempts: "Maximum attempts",
    quiz_quiz_settings_multiple_attempts_cooling_period: "Require a wait between attempts",
    quiz_quiz_settings_multiple_attempts_cooling_period_seconds: "Wait between attempts in seconds",
    quiz_quiz_settings_multiple_attempts_score_to_keep: "Score to keep",
    quiz_quiz_settings_one_at_a_time_type: "Question display",
    quiz_quiz_settings_require_student_access_code: "Require an access code",
    quiz_quiz_settings_student_access_code: "Access code",
    quiz_quiz_settings_shuffle_answers: "Shuffle answers",
    quiz_quiz_settings_shuffle_questions: "Shuffle questions",
    quiz_quiz_settings_result_view_settings_result_view_restricted: "Restrict students' results view",
    quiz_quiz_settings_result_view_settings_display_items: "Show questions in results",
    quiz_quiz_settings_result_view_settings_display_item_response: "Show student responses",
    quiz_quiz_settings_result_view_settings_display_item_response_qualifier: "Attempts that show student responses",
    quiz_quiz_settings_result_view_settings_display_item_response_correctness: "Show whether responses are correct",
    quiz_quiz_settings_result_view_settings_display_item_response_correctness_qualifier: "Attempts that show response correctness",
    quiz_quiz_settings_result_view_settings_display_item_correct_answer: "Show correct answers",
    quiz_quiz_settings_result_view_settings_display_item_feedback: "Show question feedback",
    quiz_quiz_settings_result_view_settings_display_points_awarded: "Show points earned",
    quiz_quiz_settings_result_view_settings_display_points_possible: "Show possible points",
    quiz_quiz_settings_result_view_settings_show_item_responses_at: "Start showing student responses",
    quiz_quiz_settings_result_view_settings_hide_item_responses_at: "Stop showing student responses",
    quiz_quiz_settings_result_view_settings_show_item_response_correctness_at: "Start showing response correctness",
    quiz_quiz_settings_result_view_settings_hide_item_response_correctness_at: "Stop showing response correctness",
    message: "Content preview",
    canvas_create_quiz_item: "Add quiz question",
    canvas_update_quiz_item: "Edit quiz question",
    canvas_delete_quiz_item: "Delete question",
    item_entry_title: "Question title",
    item_entry_item_body: "Question text",
    item_points_possible: "Points",
    item_entry_interaction_type_slug: "Question type",
    item_entry_scoring_algorithm: "Scoring method",
    item_entry_scoring_data: "Scoring settings",
    item_entry_interaction_data: "Answer options",
    due_at: "Due date",
    unlock_at: "Available from",
    lock_at: "Available until",
  };
  if (Object.hasOwn(names, value)) return names[value]!;
  const name = value.replace(/^canvas_/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\[\].]+/g, " ").trim()
    .replace(/\bid\b/gi, "ID").replace(/\bids\b/gi, "IDs").replace(/\burl\b/gi, "URL");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

let canvasPlainLabels: ReadonlyMap<string, string> | undefined;

/**
 * Every Canvas write operation's curated plain label (WI-3.5), read from the generated
 * catalog once and cached for the process. A missing catalog (an isolated test, a
 * packaging layout without the artifact) leaves the map empty; readableName's own
 * humanization of the tool name still names the change.
 */
function loadCanvasPlainLabels(): ReadonlyMap<string, string> {
  try {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), "../../../artifacts/canvas-api/canvas-api-catalog.json");
    if (!existsSync(path)) return new Map();
    const labels = new Map<string, string>();
    for (const operation of canvasOperationMap(loadCanvasApiCatalog(path)).values()) {
      if (operation.plainLabel) labels.set(operation.toolName, operation.plainLabel);
    }
    return labels;
  } catch {
    return new Map();
  }
}

/** The review title for a tool: its curated plain label when the catalog has one, else readableName's humanization. */
function reviewTitle(tool: string): string {
  canvasPlainLabels ??= loadCanvasPlainLabels();
  return canvasPlainLabels.get(tool) || readableName(tool);
}

function requestFields(request: JsonObject, omitted: readonly string[] = []): string {
  return Object.entries(request).filter(([key]) => key !== "_morrow" && !omitted.includes(key)).map(([key, value]) => {
    const richText = isRichText(key, value) || (Array.isArray(value) && value.some(isJsonObject));
    return `<div${richText ? ' class="rich-text"' : ""}><dt>${escapeHtml(readableName(key))}</dt><dd>${fieldValue(key, value)}</dd></div>`;
  }).join("");
}

function isRichText(key: string, value: unknown): value is string {
  return typeof value === "string" && /(?:^|_)(?:body|content|description|instructions|message|summary|question_text|answer_text|item_body|feedback|feedback_correct|feedback_incorrect|feedback_neutral)$/.test(key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase());
}

function moodleCivilDate(value: unknown): string | null {
  if (!isJsonObject(value)) return null;
  const year = value.year;
  const month = value.month;
  const day = value.day;
  const hour = value.hour;
  const minute = value.minute;
  if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number" || typeof hour !== "number" || typeof minute !== "number"
    || ![year, month, day, hour, minute].every(Number.isSafeInteger)
    || year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const civil = new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
  }).format(date);
  return `<span>${escapeHtml(civil)} <span class="preview-note">Moodle user’s configured time zone</span></span>`;
}

function fieldValue(key: string, value: unknown): string {
  if (key === "item_entry_answer_feedback" && isJsonObject(value)) return Object.entries(value).map(([id, content]) => `<section><p class="preview-label">Answer reference: ${escapeHtml(id)}</p>${typeof content === "string" ? formattedTextPreview("Answer feedback", content) : requestValue(content)}</section>`).join("");
  if (isRichText(key, value)) return formattedTextPreview(readableName(key), value);
  if (["available_from", "due_date", "cutoff_at", "grading_due_at", "open_at", "close_at"].includes(key)) {
    const civil = moodleCivilDate(value);
    if (civil) return civil;
  }
  if (typeof value === "string" && /(?:_at|date|Date)$/.test(key) && /^\d{4}-\d\d-\d\dT\d\d:\d\d.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))) {
    return `<time datetime="${escapeHtml(value)}">${escapeHtml(new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }))}</time>`;
  }
  return requestValue(value);
}

/**
 * The three Blackboard content fields a reviewed patch can change. The current
 * values and the requested values pass through the same labels in the same
 * order, so the reviewer reads one before-and-after instead of a nested patch
 * object.
 */
function blackboardContentFields(content: JsonObject): string {
  const availability = object(content.availability);
  const rows: readonly (readonly [string, string, unknown])[] = [
    ["title", "Title", content.title],
    ["description", "Description", content.description],
    ["visible", "Visible to students", availability.available],
  ];
  return rows.filter(([, , value]) => value !== undefined).map(([key, label, value]) => (
    `<div${isRichText(key, value) ? ' class="rich-text"' : ""}><dt>${label}</dt><dd>${fieldValue(key, value)}</dd></div>`
  )).join("");
}

function questionPreview(request: JsonObject, omitted: readonly string[], current?: JsonObject): string {
  const displayValue = (key: string): unknown => Object.hasOwn(request, key) ? request[key] : current?.[key];
  const title = typeof displayValue("item_entry_title") === "string" ? String(displayValue("item_entry_title")) : "Quiz question";
  const type = String(displayValue("item_entry_interaction_type_slug") || "");
  const typeNames: Record<string, string> = { choice: "Multiple choice", "multi-answer": "Multiple answer", "true-false": "True or false", essay: "Written response", matching: "Matching", ordering: "Ordering", categorization: "Categorization", "file-upload": "File upload", formula: "Formula", "rich-fill-blank": "Fill in the blank", "hot-spot": "Hot spot", numeric: "Numeric answer" };
  const covered = [...omitted, "item_entry_title", "item_entry_item_body", "item_points_possible"];
  if (typeNames[type]) covered.push("item_entry_interaction_type_slug");
  if (request.item_entry_type === "Item") covered.push("item_entry_type");
  const points = request.item_points_possible;
  const pointsLabel = typeof points === "number" || typeof points === "string"
    ? `<p class="question-points"><strong>${escapeHtml(points)}</strong> ${Number(points) === 1 ? "point" : "points"}</p>` : "";
  const itemBody = displayValue("item_entry_item_body");
  const body = typeof itemBody === "string" ? formattedTextPreview("Question text", itemBody) : "";
  const interaction = object(displayValue("item_entry_interaction_data"));
  const scoring = object(displayValue("item_entry_scoring_data"));
  const algorithm = String(displayValue("item_entry_scoring_algorithm") || "");
  const currentScoring = object(current?.item_entry_scoring_data);
  const currentAlgorithm = String(current?.item_entry_scoring_algorithm || "");
  const feedback = object(request.item_entry_answer_feedback);
  const trueFalse = type === "true-false" && typeof interaction.true_choice === "string" && typeof interaction.false_choice === "string";
  const choices = trueFalse
    ? [{ id: "true", item_body: escapeHtml(interaction.true_choice), position: 1 }, { id: "false", item_body: escapeHtml(interaction.false_choice), position: 2 }]
    : ["choice", "multi-answer"].includes(type) && Array.isArray(interaction.choices) ? interaction.choices.filter(isJsonObject) : [];
  const validChoices = choices.length > 0 && (trueFalse || choices.length === (interaction.choices as unknown[])?.length)
    && choices.every((choice) => typeof choice.id === "string" && choice.id && typeof choice.item_body === "string")
    && new Set(choices.map((choice) => choice.id)).size === choices.length;
  let answers = "";
  let modes = "";
  if (validChoices) {
    const ids = choices.map((choice) => String(choice.id));
    const key = trueFalse && typeof scoring.value === "boolean" ? [String(scoring.value)]
      : type === "multi-answer" && Array.isArray(scoring.value) ? scoring.value : [scoring.value];
    const validKey = (type === "multi-answer" ? ["AllOrNothing", "PartialScore"].includes(algorithm) : algorithm === "Equivalence")
      && key.length > 0 && key.every((id) => typeof id === "string" && ids.includes(id)) && new Set(key).size === key.length;
    const currentKey = trueFalse && typeof currentScoring.value === "boolean" ? [String(currentScoring.value)]
      : type === "multi-answer" && Array.isArray(currentScoring.value) ? currentScoring.value : [currentScoring.value];
    const validCurrentKey = (type === "multi-answer" ? ["AllOrNothing", "PartialScore"].includes(currentAlgorithm) : currentAlgorithm === "Equivalence")
      && currentKey.length > 0 && currentKey.every((id) => typeof id === "string" && ids.includes(id)) && new Set(currentKey).size === currentKey.length;
    const proposedKey = Object.hasOwn(request, "item_entry_scoring_data") && validCurrentKey;
    const ordered = choices.every((choice) => typeof choice.position === "number") ? [...choices].sort((a, b) => Number(a.position) - Number(b.position)) : choices;
    const previewId = randomBytes(8).toString("hex");
    const rows = ordered.map((choice, index) => {
      const correct = validKey && key.includes(String(choice.id));
      const explanation = typeof feedback[String(choice.id)] === "string"
        ? `<details class="answer-feedback"><summary>Feedback for this answer</summary>${formattedTextPreview("Answer feedback", String(feedback[String(choice.id)]))}</details>` : "";
      const input = validKey ? `<input class="answer-input" type="${type === "multi-answer" ? "checkbox" : "radio"}" name="answer-${previewId}" aria-labelledby="answer-${previewId}-${index}" data-correct="${correct}">` : "";
      const currentlyCorrect = validCurrentKey && currentKey.includes(String(choice.id));
      return `<li class="answer-option${correct ? " answer-correct" : ""}"><span class="answer-letter" aria-hidden="true">${index < 26 ? String.fromCharCode(65 + index) : index + 1}</span>${input}<div class="answer-content"><div id="answer-${previewId}-${index}">${formattedTextPreview("", String(choice.item_body))}</div>${currentlyCorrect && !correct ? '<span class="answer-key">Currently marked correct</span>' : ""}${correct ? `<span class="answer-key">${proposedKey ? "Will be marked correct" : "Marked correct"}</span>` : ""}${explanation}</div></li>`;
    }).join("");
    const scoringNote = algorithm === "AllOrNothing" ? "All correct answers are required for credit." : algorithm === "PartialScore" ? "Partial credit is enabled." : "";
    const answerText = (answerIds: readonly unknown[]) => choices.filter((choice) => answerIds.includes(String(choice.id))).map((choice) => formattedTextPreview("", String(choice.item_body))).join("");
    const answerChange = proposedKey && validCurrentKey && validKey
      ? `<div class="answer-key-change"><p class="preview-label">Current correct answer</p>${answerText(currentKey)}<p class="preview-label">Proposed correct answer</p>${answerText(key)}</div>` : "";
    answers = `<div class="question-answers"><p class="preview-label">${type === "multi-answer" ? "Select all that apply" : "Answer choices"}</p>${answerChange}<ol class="answer-options">${rows}</ol><p class="preview-note">${validKey ? "Answer key shown for your review." : "The answer key could not be shown. Check the question settings below."}${scoringNote ? " " + scoringNote : ""}</p></div>`;
    if (validKey) {
      modes = '<div class="preview-modes" role="group" aria-label="Question preview" hidden><button type="button" data-mode="key" aria-pressed="true">Answer key</button><button type="button" data-mode="student" aria-pressed="false">Try the question</button></div>';
      answers += '<div class="practice-actions" hidden><div class="practice-result" role="status" aria-live="polite" hidden></div><div class="practice-buttons"><button type="button" class="secondary practice-check">Check answer</button><button type="button" class="cancel practice-reset">Reset</button></div><p class="preview-note">Practice only. Nothing is submitted or saved to Canvas.</p></div>';
    }
    const interactionKeys = trueFalse ? ["true_choice", "false_choice"] : ["choices"];
    if (Object.keys(interaction).every((key) => interactionKeys.includes(key))
      && choices.every((choice) => Object.keys(choice).every((key) => ["id", "position", "item_body"].includes(key)))) covered.push("item_entry_interaction_data");
    if (validKey && Object.keys(scoring).every((key) => key === "value")) covered.push("item_entry_scoring_data", "item_entry_scoring_algorithm");
    if (Object.entries(feedback).every(([id, value]) => ids.includes(id) && typeof value === "string")) covered.push("item_entry_answer_feedback");
  }
  const feedbackRows = [["correct", "After a correct answer"], ["incorrect", "After an incorrect answer"], ["neutral", "For every answer"]].flatMap(([key, label]) => {
    const field = `item_entry_feedback_${key}`;
    if (typeof request[field] !== "string") return [];
    covered.push(field);
    return [`<section data-feedback="${key}"><h3>${label}</h3>${formattedTextPreview(label!, String(request[field]))}</section>`];
  }).join("");
  const feedbackPreview = feedbackRows ? `<details class="question-feedback"><summary>Feedback students will see</summary><div class="feedback-content">${feedbackRows}</div></details>` : "";
  const fields = requestFields(request, covered);
  return `<div class="question-preview" data-mode="key">${modes}<header class="question-heading"><div><p class="eyebrow">${escapeHtml(typeNames[type] || "Question preview")}</p><h2>${escapeHtml(title)}</h2></div>${pointsLabel}</header>${body}${answers}${feedbackPreview}${fields ? `<details class="question-settings"><summary>More question settings</summary><dl class="request">${fields}</dl></details>` : ""}</div>`;
}

function requestValue(value: unknown): string {
  if (Array.isArray(value) && value.length > 0 && value.every(isJsonObject)) {
    const columns = [...new Set(value.flatMap((entry) => Object.keys(entry).filter((key) => key !== "_morrow")))];
    if (columns.length > 0 && columns.length <= 8) return `<div class="value-table"><table><thead><tr>${columns.map((key) => `<th scope="col">${escapeHtml(readableName(key))}</th>`).join("")}</tr></thead><tbody>${value.map((entry) => `<tr>${columns.map((key) => `<td>${Object.hasOwn(entry, key) ? fieldValue(key, entry[key]) : "Not specified"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  if (Array.isArray(value)) return value.length
    ? `<ol class="values">${value.map((entry) => `<li>${requestValue(entry)}</li>`).join("")}</ol>` : "None";
  if (value !== null && typeof value === "object") return `<dl class="request">${requestFields(object(value)) || "Not set"}</dl>`;
  return escapeHtml(value === true ? "Yes" : value === false ? "No" : value === null ? "Not set" : value === "" ? "Empty" : value);
}

function changeKind(tool: unknown): string {
  const name = String(tool).replace(/^(canvas|moodle|blackboard)_/, "");
  if (/^(delete|remove|destroy)_/.test(name)) return "Remove";
  if (/^(create|add|copy|duplicate|import)_/.test(name)) return "Add";
  if (/^show_/.test(name)) return "Show";
  if (/^hide_/.test(name)) return "Hide";
  if (/^(update|edit|set|reorder|move)_/.test(name) || name === "apply_reviewed_content_patch") return "Edit";
  return "Change";
}

function visibilityDecision(tool: unknown, verified = false): string | null {
  const name = String(tool);
  if (name === "moodle_show_book_chapter") return verified
    ? "Moodle confirmed the Book chapter is visible."
    : "This will show the selected Moodle Book chapter and its direct subchapters, if any.";
  if (name === "moodle_hide_book_chapter") return verified
    ? "Moodle confirmed the Book chapter is hidden."
    : "This will hide the selected Moodle Book chapter and its direct subchapters, if any.";
  const target = name.endsWith("_course") ? "course" : name.endsWith("_section") ? "section" : name.endsWith("_activity") ? "activity" : null;
  if (!target || !name.startsWith("moodle_")) return null;
  if (!verified && name === "moodle_show_section") return "This will show the section again. Activities hidden before the section was hidden will stay hidden.";
  if (!verified && name === "moodle_hide_section") return "This will hide the section and its activities from learners.";
  if (name.includes("_show_")) return verified ? `Moodle confirmed that this ${target} is set to visible.` : `This will make the Moodle ${target} visible to learners.`;
  if (name.includes("_hide_")) return verified ? `Moodle confirmed that this ${target} is set to hidden.` : `This will hide the Moodle ${target} from learners.`;
  return null;
}

function moveDecision(tool: unknown, verified = false): string | null {
  if (tool !== "moodle_move_activity") return null;
  return verified
    ? "Moodle confirmed the activity moved to the end of the selected destination section and its visibility and access stayed unchanged."
    : "This moves the activity to the end of the selected destination section. Morrow checks that its visibility and access stay unchanged.";
}

function changeTitle(request: JsonObject, context: ApprovalReviewContext | undefined, fallback: string): string {
  const title = ["item_entry_title", "wiki_page_title", "assignment_name", "quiz_title", "module_name", "module_item_title", "rubric_title", "question_question_name", "title", "name"].map((key) => request[key])
    .find((value) => typeof value === "string" && value.trim());
  return typeof title === "string" ? title : context?.targets.filter((target) => target.field !== "connection_id").at(-1)?.name || fallback;
}

/**
 * The item a confirmed single change reached, and its address in the platform
 * when the review context read one. A batch confirms several items at once, so
 * it names none of them here; the change list below the summary already does.
 */
function resultItem(target: ApprovalTarget, snapshot: JsonObject, contexts?: ReadonlyMap<string, ApprovalReviewContext>): { name: string; url?: string } | undefined {
  if (target.kind !== "operations") return undefined;
  const context = contexts?.get(target.id);
  const request = object(object(snapshot.plan).arguments);
  const name = changeTitle(request, context, "");
  if (!name) return undefined;
  const url = context?.targets.filter((item) => item.url?.startsWith("https://")).at(-1)?.url;
  return url ? { name, url } : { name };
}

function reviewState(target: ApprovalTarget, snapshot: JsonObject): string {
  if (target.kind === "operations") return String(snapshot.state || "unavailable");
  const batch = object(snapshot.batch);
  const children = Array.isArray(snapshot.children) ? snapshot.children : [];
  if (batch.state === "completed" && (
    (children.length > 0 && children.every((child) => object(object(child).operation).state === "verified"))
    || (Number(snapshot.totalChildren) > 0 && Number(snapshot.confirmedChildren) === Number(snapshot.totalChildren))
  )) return "verified";
  if (batch.state !== "planned") return String(batch.state || "unavailable");
  if (children.length > 0 && children.every((child) => object(object(child).operation).state === "approved")) return "approved";
  return children.length > 0 && children.every((child) => object(object(child).operation).state === "awaiting_approval")
    ? "awaiting_approval" : "unavailable";
}

/**
 * A review is held when it addresses something it could not name. The review
 * itself says so: it lists one target for each object the change reaches, and a
 * review that could not identify them at all is marked unnamed. A change that
 * reaches no named object, such as one that only carries content, is shown by
 * its exact request and can be approved.
 */
/** Canvas answered for every unnamed target and holds none of them. */
function absentTargets(operations: readonly JsonObject[], contexts: ReadonlyMap<string, ApprovalReviewContext>): boolean {
  const unnamed = operations.flatMap((operation) => (contexts.get(String(operation.operationId))?.targets || [])
    .filter((target) => !target.name.trim()));
  return unnamed.length > 0 && unnamed.every((target) => target.state === "absent");
}

function namedTargetsMissing(operations: readonly JsonObject[], contexts: ReadonlyMap<string, ApprovalReviewContext>): boolean {
  return operations.some((operation) => {
    const plan = object(operation.plan);
    if (!/^(canvas|moodle|blackboard)_/.test(String(plan.tool))) return false;
    const context = contexts.get(String(operation.operationId));
    if (!context || context.unnamed) return true;
    const source = context.current?.current_section;
    return (plan.tool === "moodle_move_activity" && operation.state === "awaiting_approval" && (typeof source !== "string" || !source.trim()))
      || context.targets.some((item) => !item.name.trim());
  });
}

function keepOpenInstruction(platform: string): string {
  // Blackboard runs through this computer's own REST connection, so that review
  // needs no browser. Canvas, Moodle, and a mixed group still go through Chrome.
  return platform === "Blackboard"
    ? "Keep your assistant open while Morrow works."
    : "Keep your assistant and Chrome open while Morrow works.";
}

/**
 * The end of a task must feel complete, so a confirmed result gets its own shape:
 * a success mark, the item Canvas saved, a way to open it, and where to go next.
 * Every other state stays the plain, calm outcome section below. It never earns
 * the success mark, confirmed or not.
 */
function verifiedResultContent(platform: string, item?: { name: string; url?: string }, recentEntry?: string | null): string {
  const itemName = item?.name ? `<p class="result-item">${escapeHtml(item.name)}</p>` : "";
  const openLink = item?.url ? `<p><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open in ${escapeHtml(platform)}</a></p>` : "";
  const title = "Canvas saved the change. Morrow checked the result.".replaceAll("Canvas", platform);
  // The Recent changes page needs a one-time entry code; a bare /recent link answers 403.
  const recentLink = recentEntry ? `<p><a href="/recent?entry=${escapeHtml(recentEntry)}">See recent changes</a></p>` : "";
  return `<section class="outcome outcome-success"><svg class="success-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><circle cx="20" cy="20" r="17"></circle><path d="M12 21l6 6L29 13"></path></svg><h1>${title}</h1>${itemName}${openLink}<p>Return to your assistant. It continues on its own.</p>${recentLink}</section>`;
}

function stateContent(state: string, platform = "Canvas", attention: readonly unknown[] = [], item?: { name: string; url?: string }, recentEntry?: string | null): string {
  if (state === "verified") return verifiedResultContent(platform, item, recentEntry);
  const content: Record<string, [string, string]> = {
    approved: ["Changes not started", "Your approval was saved, but this request is not running. Return to your assistant and ask Morrow to check this saved request before starting anything else."],
    cancelled: ["Request cancelled", "Morrow will not start more changes for this request. Changes already sent may still finish. Return to the assistant where you started this request to check the result."],
    expired: ["Review expired", "Return to the assistant where you started this request and ask Morrow for a new review. Check the new request before approving it."],
    dispatching: ["Applying your changes", `Morrow will check the saved result in Canvas. This page updates automatically. ${keepOpenInstruction(platform)}`],
    running: ["Applying your changes", `Morrow will check the saved result in Canvas. This page updates automatically. ${keepOpenInstruction(platform)}`],
    awaiting_verification: ["Check the result", "Morrow could not confirm the saved result in Canvas. Return to your assistant and ask Morrow to check this saved request. Do not repeat the change."],
    awaiting_inner_approval: ["Review needed", "This request needs another approval before it can finish. Return to the assistant where you started this request for the next review step."],
    applied_or_unknown: ["Result unconfirmed", "Canvas may have received the changes. Return to your assistant and ask Morrow to check this saved request. If Morrow cannot check it, open the item in Canvas and confirm it yourself. Do not repeat the change."],
    closed_by_person: ["Closed after your check", "Morrow did not check this change itself. It is closed because you read the item and confirmed the saved state. Morrow will not send this change again."],
    inspection_required: ["Check results", "Canvas may have received some changes. Return to the assistant where you started this request and ask Morrow to check each result. Do not repeat the group of changes."],
    partial: ["Changes stopped", "Return to the assistant where you started this request to see which changes finished and which still need attention. Do not repeat the whole group."],
    paused: ["Work is paused", "Morrow is not starting more changes. Work already sent may still finish. Return to the assistant where you started this request to check the result or continue."],
    completed: ["Check results", "The work has stopped, but not every requested change has a confirmed result. Return to your assistant and ask Morrow to check the saved results. Do not repeat the group."],
    failed: ["Request stopped", "Return to the assistant where you started this request to find out what happened. Check the result before starting a new request."],
    interrupted: ["Work stopped", "Morrow is not running this request now. Return to your assistant and ask Morrow to check the saved result before trying again."],
  };
  const noChangeSent = state === "failed" && attention.includes("dispatch_failed_before_send");
  const savedOtherwise = state === "failed" && attention.includes("readback_did_not_match_frozen_comparator");
  const sameTargetBlocked = state === "approved" && attention.includes("provider_effect_target_conflict");
  const historicalTargetScopeBlocked = state === "approved" && attention.includes("provider_effect_target_scope_unknown");
  const [title, detail] = historicalTargetScopeBlocked
    ? ["Check earlier change", "An earlier change from an older Morrow version is still unresolved, so Morrow has not sent this change. That earlier change has no saved check. Open the item it changed in Canvas, confirm it yourself, then ask Morrow for a new review."]
    : sameTargetBlocked
    ? ["Check earlier change", "Morrow has not sent this change. An earlier change to the same target is still unresolved. Return to your assistant and ask Morrow to check that earlier request. If Morrow cannot check it, open that item in Canvas and confirm it yourself."]
    : noChangeSent
    // This ending now covers two cases: a change Morrow never dispatched, and a
    // change Canvas refused with a status that saved nothing. The wording must
    // stay true for both.
    ? ["No change was sent", "Morrow did not change anything in Canvas. Return to your assistant and ask Morrow to read the latest Canvas content and prepare a new review."]
    : savedOtherwise
    ? ["Did not save as approved", "Morrow sent this change and read Canvas again. Canvas does not hold the result you approved. Morrow will not send this change again. Open the item in Canvas, then ask your assistant for a new review if it still needs the change."]
    : content[state] || ["Check this request", "The request has changed or can no longer be approved here. Return to your assistant and ask Morrow to check its current status."];
  return `<section class="outcome"><h1>${title}</h1><p>${detail.replaceAll("Canvas", platform)}</p></section>`;
}

function statePage(state: string, platform?: string): string {
  return pageShell("Request status", stateContent(state, platform));
}

export function operationStatus(state: string, platform = "Canvas", verification?: unknown): string {
  if (state === "failed" && verification === "mismatch") return "Did not save as approved";
  const names: Record<string, string> = {
    awaiting_approval: "Not started", approved: "Not started", dispatching: "In progress",
    awaiting_verification: "Needs checking", applied_or_unknown: "Needs checking",
    awaiting_inner_approval: "Another review is needed", verified: "Confirmed in Canvas",
    closed_by_person: "Closed after your check",
    cancelled: "Cancelled", failed: "Did not finish",
  };
  return (names[state] || "Needs checking").replaceAll("Canvas", platform);
}

function platformName(tool: unknown): string {
  return String(tool).startsWith("moodle_") ? "Moodle" : String(tool).startsWith("blackboard_") ? "Blackboard" : "Canvas";
}

export function reviewPlatform(tools: readonly unknown[]): string {
  const names = [...new Set(tools.map(platformName))];
  return names.length > 1 ? "your learning platforms" : names[0] || "Canvas";
}

/**
 * The assistant that asked for this review, as it reported itself at connect
 * time. A batch carries it on the saved group; a single change carries it on the
 * frozen plan. Morrow shows the project by name, never as a path.
 */
function requestedByLine(snapshot: JsonObject, plans: readonly JsonObject[]): string {
  const candidates = [object(object(snapshot.batch).requestedBy), ...plans.map((plan) => object(plan.requestedBy))];
  const requestedBy = candidates.find((candidate) => typeof candidate.clientName === "string" && candidate.clientName);
  if (!requestedBy) return "";
  const version = typeof requestedBy.clientVersion === "string" && requestedBy.clientVersion !== "unstated"
    ? ` ${requestedBy.clientVersion}`
    : "";
  const project = typeof requestedBy.workspaceName === "string" && requestedBy.workspaceName
    ? `, working in ${escapeHtml(requestedBy.workspaceName)}`
    : "";
  return `<p class="preview-note">Asked for by ${escapeHtml(String(requestedBy.clientName) + version)}${project}. `
    + "This is the name that assistant reported, not proof of identity.</p>";
}

function snapshotPlatform(snapshot: JsonObject): string {
  if (typeof snapshot.platform === "string") return snapshot.platform;
  return Array.isArray(snapshot.children)
    ? reviewPlatform(snapshot.children.map((child) => object(object(object(child).operation).plan).tool))
    : platformName(object(snapshot.plan).tool);
}

/**
 * The read that names a change's target in the platform. The full page needs
 * it whenever it might show a named target or a result; the status poll needs
 * it only once a change is verified, so a review that is still dispatching
 * never pays for this read once a second.
 */
async function reviewContexts(
  controller: ApprovalOperationController,
  operations: readonly JsonObject[],
  signal: AbortSignal,
): Promise<Map<string, ApprovalReviewContext>> {
  const contexts = new Map<string, ApprovalReviewContext>();
  if (!controller.operationReviewContext) return contexts;
  const readCache: ApprovalReviewReadCache = new Map();
  for (let offset = 0; offset < operations.length; offset += 4) {
    await Promise.all(operations.slice(offset, offset + 4).map(async (operation) => {
      const operationId = String(operation.operationId || "");
      if (!operationId) return;
      try {
        contexts.set(operationId, await controller.operationReviewContext!(operationId, readCache));
      } catch { /* keep the exact request visible when Canvas cannot provide its name */ }
    }));
    signal.throwIfAborted();
  }
  return contexts;
}

/**
 * Who each learner label in the reviewed operations is, from Morrow's own learner vault. A label
 * two operations name differently is left out, so the Bridge never shows a guess.
 */
function reviewLearnerNames(contexts: ReadonlyMap<string, ApprovalReviewContext> | undefined): Record<string, string> | null {
  const names = new Map<string, string | null>();
  for (const context of contexts?.values() ?? []) {
    for (const [label, name] of Object.entries(context.learnerNames ?? {})) {
      if (!/^Student A[1-9][0-9]*$/u.test(label) || typeof name !== "string" || !name.trim()) continue;
      names.set(label, names.has(label) && names.get(label) !== name ? null : name);
    }
  }
  const known = [...names].filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return known.length ? Object.fromEntries(known) : null;
}

const ENDED_REVIEW_STATES = new Set(["cancelled", "closed_by_person", "expired", "unavailable"]);
const UNRESOLVED_REVIEW_STATES = new Set(["awaiting_verification", "applied_or_unknown"]);

function statusContent(target: ApprovalTarget, snapshot: JsonObject, active: boolean, contexts?: ReadonlyMap<string, ApprovalReviewContext>, rememberText?: string, recentEntry?: string | null): string {
  let state = reviewState(target, snapshot);
  if (active && state === "approved") state = "running";
  if (!active && ["running", "dispatching"].includes(state)) state = "interrupted";
  const children = Array.isArray(snapshot.children) ? snapshot.children : [];
  const confirmed = Number(snapshot.confirmedChildren || children.filter((child) => object(object(child).operation).state === "verified").length);
  const total = Number(snapshot.totalChildren || children.length);
  const platform = snapshotPlatform(snapshot);
  const attention = Array.isArray(snapshot.attention) ? snapshot.attention : [];
  const item = state === "verified" ? resultItem(target, snapshot, contexts) : undefined;
  return stateContent(state, platform, attention, item, recentEntry)
    + (total ? `<section class="section"><p>${confirmed} of ${total} changes confirmed in ${platform}.</p></section>` : "")
    + (rememberText ? `<section class="section remember-result"><p>${escapeHtml(rememberText)}</p></section>` : "");
}

// The nonce is issued on demand so a page that renders no form never takes a
// grant slot or sets a cookie the reader cannot use.
function html(
  target: ApprovalTarget,
  snapshot: JsonObject,
  grant: () => string,
  contexts: ReadonlyMap<string, ApprovalReviewContext>,
  active: boolean,
  rememberOffer: RememberOffer | null,
  rememberText: string | undefined,
  recentEntry: string | null,
  closeOffer = false,
): string {
  let issued: string | null = null;
  const nonce = (): string => (issued ??= grant());
  const summary = escapeHtml(JSON.stringify(technicalDetails(target, snapshot), null, 2));
  const escapedId = escapeHtml(encodeURIComponent(target.id));
  const batch = target.kind === "batches";
  const plan = object(snapshot.plan);
  const platform = snapshotPlatform(snapshot);
  const expiry = String(snapshot.approvalExpiresAt || snapshot.expiresAt || "");
  const expired = Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) <= Date.now();
  const state = reviewState(target, snapshot);
  if (state === "awaiting_approval" && expired) return statePage("expired", platform);
  const expiresAt = Number.isFinite(Date.parse(expiry))
    ? new Date(expiry).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "15 minutes after you opened this page";
  const operations = batch && Array.isArray(snapshot.children)
    ? snapshot.children.map((child) => object(object(child).operation)) : [snapshot];
  const plans = operations.map((operation) => object(operation.plan));
  const missingNames = namedTargetsMissing(operations, contexts);
  const limited = [...contexts.values()].some((context) => context.limited === true);
  const warnings: Record<string, string> = {
    destructive: "This removes content. It cannot be undone from this screen.",
    learner: "This changes student information or access. Check who is included.",
    grade: "This changes grades. Check each student and score.",
    blueprint: "This also affects linked courses. Check which courses are included.",
  };
  const risks = [...new Set(plans.map((entry) => warnings[String(object(entry.risk).approvalClass)]).filter(Boolean))];
  const commonTargets = batch ? (contexts.get(String(operations[0]?.operationId))?.targets || []).filter((target) => target.name.trim()
    && operations.every((operation) => {
      const candidate = object(operation.plan);
      return candidate.source === plans[0]?.source && candidate.sourceBindingId === plans[0]?.sourceBindingId
        && platformName(candidate.tool) === platformName(plans[0]?.tool)
        && object(candidate.arguments).connection_id === object(plans[0]?.arguments).connection_id
        && object(object(candidate.arguments)._morrow).source_binding_id === object(object(plans[0]?.arguments)._morrow).source_binding_id
        && JSON.stringify(object(candidate.arguments)[target.field]) === JSON.stringify(object(plans[0]?.arguments)[target.field])
        && contexts.get(String(operation.operationId))?.targets.some((item) => item.field === target.field && item.name === target.name);
    })) : [];
  const counts = new Map<string, number>();
  plans.forEach((entry) => { const kind = changeKind(entry.tool); counts.set(kind, (counts.get(kind) || 0) + 1); });
  const batchSummary = batch ? `<div class="batch-overview"><p>${[...counts].map(([kind, count]) => `${count} ${kind === "Add" ? (count === 1 ? "addition" : "additions") : kind === "Edit" ? (count === 1 ? "edit" : "edits") : kind === "Remove" ? (count === 1 ? "removal" : "removals") : (count === 1 ? "other change" : "other changes")}`).join(" · ")}</p>${commonTargets.length ? `<dl class="shared-destination">${commonTargets.map((target) => `<div><dt>${escapeHtml(target.label)}</dt><dd>${escapeHtml(target.name)}</dd></div>`).join("")}</dl>` : ""}<p class="preview-note">${state === "awaiting_approval" ? `Open any item to review its content. Approval includes all ${plans.length} changes, in the order shown.` : "Open any item to see its content and result."}</p></div>` : "";
  const changed = plans.map((entry, index) => {
    const context = contexts.get(String(operations[index]?.operationId));
    const targets = (context?.targets || []).filter((item) => item.name.trim());
    const destination = targets.filter((item) => !commonTargets.some((target) => target.field === item.field)).map((item) => {
      const name = escapeHtml(item.name);
      const linkedName = item.url?.startsWith("https://")
        ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${name}<span class="sr-only"> (opens in ${platformName(entry.tool)})</span></a>` : name;
      return `<div><dt>${escapeHtml(item.label)}</dt><dd>${linkedName}</dd></div>`;
    }).join("");
    const request = object(entry.arguments);
    const routing = object(request._morrow);
    const canvasContentGuard = object(routing.canvas_content_guard);
    const pageGuard = Object.keys(canvasContentGuard).length ? canvasContentGuard : object(routing.page_guard);
    const currentSection = typeof context?.current?.current_section === "string" ? context.current.current_section.trim() : "";
    const moveOrigin = entry.tool === "moodle_move_activity" && currentSection
      ? `<dl class="destination move-origin"><div><dt>From section</dt><dd>${escapeHtml(currentSection)}</dd></div></dl>` : "";
    const gradebookRename = ["moodle_update_grade_category", "moodle_update_grade_item"].includes(String(entry.tool));
    const gradebookCurrent = typeof context?.current?.gradebook_current_name === "string" ? context.current.gradebook_current_name.trim() : "";
    const gradebookProposed = typeof request[entry.tool === "moodle_update_grade_category" ? "fullname" : "item_name"] === "string"
      ? String(request[entry.tool === "moodle_update_grade_category" ? "fullname" : "item_name"]).trim() : "";
    const name = typeof entry.tool === "string" ? reviewTitle(entry.tool) : "Requested changes";
    const blackboardEdit = entry.tool === BLACKBOARD_CONTENT_PATCH_APPLY_TOOL;
    const blackboardPatch = blackboardEdit ? blackboardContentFields(object(request.patch)) : "";
    const blackboardCourseCopy = entry.tool === "blackboard_apply_reviewed_course_copy";
    const displayedRequest = blackboardCourseCopy
      ? { source_course_id: request.course_id, destination_course_id: request.destination_course_id }
      : request;
    const hiddenFields = ["expected_digest", "expected_connection", "tenant_id", "source_binding_id", "expected_plan_digest", "morrow_new_quiz_settings_guard", "morrow_new_quiz_lifecycle_guard", "morrow_new_quiz_effect_guard", "morrow_new_quiz_item_position_guard", ...STRUCTURAL_EDIT_FIELDS, ...targets.map((item) => item.field)];
    const guardedImageAlt = ["image_alt", "page_image_alt", "assignment_image_alt", "discussion_image_alt"].includes(String(pageGuard.kind));
    const guardedText = ["text", "page_text"].includes(String(pageGuard.kind));
    const changes = blackboardPatch
      ? blackboardPatch
      : gradebookRename && gradebookCurrent && gradebookProposed
      ? `<div><dt>Current name</dt><dd>${escapeHtml(gradebookCurrent)}</dd></div><div><dt>New name</dt><dd>${escapeHtml(gradebookProposed)}</dd></div>`
      : guardedImageAlt && Number.isSafeInteger(pageGuard.image_index) && typeof pageGuard.alt_text === "string" && typeof pageGuard.decorative === "boolean"
      ? `<div><dt>Image</dt><dd>Image ${pageGuard.image_index}</dd></div><div><dt>Alternative text</dt><dd>${pageGuard.decorative ? "Decorative image (empty alternative text)" : escapeHtml(pageGuard.alt_text)}</dd></div>`
      : guardedText && typeof pageGuard.find_text === "string" && typeof pageGuard.replace_text === "string"
      ? `<div><dt>Current text</dt><dd>${escapeHtml(pageGuard.find_text)}</dd></div><div><dt>Replacement</dt><dd>${pageGuard.replace_text === "" ? "Remove this text" : escapeHtml(pageGuard.replace_text)}</dd></div>`
      : requestFields(["moodle_create_page", "moodle_create_label", "moodle_create_url", "moodle_create_resource_file", "moodle_create_folder_file", "moodle_create_imscp_package", "moodle_create_scorm_package", "moodle_create_assignment", "moodle_create_quiz", "moodle_create_forum", "moodle_create_choice"].includes(String(entry.tool)) ? { ...displayedRequest, visible: false } : displayedRequest, hiddenFields);
    const addingQuestion = entry.tool === "canvas_create_quiz_item";
    const question = addingQuestion || entry.tool === "canvas_update_quiz_item";
    const preview = question ? questionPreview(request, hiddenFields, context?.question) : changes
      ? `<dl class="request">${changes}</dl>`
      : `<p>${visibilityDecision(entry.tool, operations[index]?.state === "verified") || moveDecision(entry.tool, operations[index]?.state === "verified") || (changeKind(entry.tool) === "Remove" ? "This item will be removed." : "This action applies to the item shown above.")}</p>`;
    const currentFields = !context?.current ? ""
      : blackboardEdit ? blackboardContentFields(context.current)
      : requestFields(context.current);
    const questionFields = Object.keys(request).filter((key) => key.startsWith("item_") && key !== "item_id");
    const scoreOnlyQuestion = question && questionFields.length === 1 && questionFields[0] === "item_entry_scoring_data";
    const before = entry.tool === "moodle_move_activity" || gradebookRename ? ""
      : scoreOnlyQuestion && context?.question
      ? '<p class="preview-note">Question details come from the current saved item. Only the answer key is in this request. Morrow will not write the question text, choices, or other settings.</p>'
      : question && context?.question
        ? '<p class="preview-note">Question details come from the current saved item. The requested changes are shown below.</p>'
      : currentFields
      ? `<details class="current-content"><summary>Current content and values</summary><dl class="request">${currentFields}</dl></details><p class="preview-label">Requested changes</p>`
      : changeKind(entry.tool) === "Edit" && entry.tool !== "moodle_move_activity" && !guardedText && !guardedImageAlt ? '<p class="preview-note">Requested values are shown below. Earlier values are not available in this review.</p>' : "";
    const contentName = pageGuard.kind === "assignment_image_alt" ? "Assignment description"
      : pageGuard.kind === "discussion_image_alt" ? "Discussion message" : "Page";
    const preservation = ["blackboard_apply_reviewed_course_announcement", "blackboard_apply_reviewed_course_announcement_patch"].includes(String(entry.tool))
      ? '<p>Blackboard can notify enrolled learners when an announcement is posted. Morrow cannot recall a notification that has already been sent.</p>'
      : gradebookRename ? '<p>Morrow changes only this name. It preserves the other gradebook settings and does not read or change learner grades or grade values.</p>'
      : guardedText ? '<p>Only this phrase will change. The other Page content and settings stay the same.</p><p>Morrow checks for newer edits before sending. Avoid editing this Page until the result is checked.</p>'
      : guardedImageAlt ? `<p>Only the selected image's alternative text will change. The other ${contentName} content and settings stay the same.</p><p>Morrow checks for newer edits before sending. Avoid editing this ${contentName} until the result is checked.</p>` : "";
    const content = `<section class="section change-content">${destination ? `<dl class="destination${addingQuestion ? " question-destination" : ""}">${destination}</dl>` : ""}${moveOrigin}${before}${preview}${preservation}</section>`;
    if (!batch) return content;
    const title = changeTitle(request, context, name);
    const kind = changeKind(entry.tool);
    const where = targets.map((item) => item.name).join(" · ");
    const rowWhere = targets.filter((item) => !commonTargets.some((target) => target.field === item.field)).map((item) => item.name).join(" · ");
    const metadata = (rowWhere !== title ? rowWhere : "") || [request.item_entry_interaction_type_slug ? readableName(String(request.item_entry_interaction_type_slug).replaceAll("-", " ")) : name,
      typeof request.item_points_possible === "number" ? `${request.item_points_possible} points` : ""].filter(Boolean).join(" · ");
    const sensitive = warnings[String(object(entry.risk).approvalClass)];
    return `<details class="change-item" data-search="${escapeHtml(`${title} ${where} ${name} ${kind}`.toLocaleLowerCase())}"><summary><span class="change-number">${index + 1}</span><span class="change-heading"><strong>${escapeHtml(title)}</strong><span class="change-context">${escapeHtml(metadata)}</span>${state !== "awaiting_approval" ? `<span data-operation-status>${operationStatus(String(operations[index]?.state), platformName(entry.tool), operations[index]?.verificationStatus)}</span>` : ""}</span><span class="change-kind${kind === "Remove" ? " removal" : ""}">${kind}</span></summary>${sensitive ? `<p class="item-warning">${escapeHtml(sensitive)}</p>` : ""}${content}</details>`;
  }).join("");
  const reviewContent = batch ? `<section class="batch-review"><div class="change-list-controls" hidden><label for="change-search">Find a change</label><input id="change-search" type="search" placeholder="Search titles or courses" autocomplete="off"></div><div class="change-list">${changed}</div><nav class="change-pagination" aria-label="Review pages" hidden><p id="changes-count" role="status" aria-live="polite"></p><div><button id="changes-previous" type="button" class="secondary">Previous</button><button id="changes-next" type="button" class="secondary">Next</button></div></nav></section>` : changed;
  if (state !== "awaiting_approval") {
    const stop = batch && active ? `<div class="actions" id="stop-work"><form method="post" action="/${target.kind}/${escapedId}/cancel"><input type="hidden" name="nonce" value="${escapeHtml(nonce())}"><button class="cancel" type="submit">Stop remaining changes</button></form></div>` : "";
    // Only the person closes a change Morrow could not settle. Morrow Bridge signs this form
    // after their own click, the same as an approval, so neither the assistant nor another
    // program on this computer can close it.
    const close = closeOffer && !batch && !active
      ? `<section class="section person-close"><h2>Checked it yourself?</h2><p>Open the item in Canvas. If it is the way you want it, close this request. Morrow will not send this change again, and the request will say that you checked it, not Morrow.</p><div class="actions"><form method="post" action="/${target.kind}/${escapedId}/close"><input type="hidden" name="nonce" value="${escapeHtml(nonce())}"><button class="secondary" type="submit">I checked it in Canvas: close this change</button></form></div></section>`.replaceAll("Canvas", platform)
      : "";
    return pageShell("Your result", `<div id="work-status" role="status" aria-live="polite" aria-atomic="true">${statusContent(target, snapshot, active, contexts, rememberText, recentEntry)}</div>${close}${commonTargets.length ? `<section class="section">${batchSummary}</section>` : ""}${reviewContent}${stop}<section class="section result-details"><details><summary>Technical details</summary><pre>${summary}</pre></details></section>`, active);
  }
  const addingQuestion = !batch && plan.tool === "canvas_create_quiz_item";
  const planRouting = object(object(plan.arguments)._morrow);
  const canvasContentGuard = object(planRouting.canvas_content_guard);
  const pageGuard = Object.keys(canvasContentGuard).length ? canvasContentGuard : object(planRouting.page_guard);
  const changingPageText = !batch && isJsonObject(pageGuard) && ["text", "page_text"].includes(String(pageGuard.kind));
  const changingImageAlt = !batch && isJsonObject(pageGuard) && ["image_alt", "page_image_alt", "assignment_image_alt", "discussion_image_alt"].includes(String(pageGuard.kind));
  const markingImageDecorative = changingImageAlt && pageGuard.decorative === true;
  // The same source that sets tier: "destructive" for the Bridge options: catalog risk,
  // carried onto the plan as `risk.approvalClass` (`effect-broker.ts`).
  const destructive = !batch && object(plan.risk).approvalClass === "destructive";
  const removalObjectName = destructive
    ? changeTitle(object(plan.arguments), contexts.get(String(operations[0]?.operationId)), readableName(String(plan.tool || "Review change")))
    : "";
  const title = batch ? `Review ${plans.length} changes` : addingQuestion ? "Add question?" : changingPageText ? "Edit Page text?" : changingImageAlt ? markingImageDecorative ? "Mark decorative?" : "Add image alt text?" : `${reviewTitle(String(plan.tool || "Review change"))}?`;
  const approveLabel = batch ? `Apply all ${plans.length} changes` : addingQuestion ? "Add this question" : changingPageText ? "Change this text" : changingImageAlt ? markingImageDecorative ? "Mark as decorative" : "Add alternative text" : destructive ? `Delete "${escapeHtml(removalObjectName)}"` : "Apply this change";
  const next = (limited
    ? '<p class="warning">Too many different courses or activities to review at once.</p><p>Return to your assistant and ask Morrow to split this into smaller groups. This page has not approved any changes.</p>'
    : missingNames
    ? absentTargets(operations, contexts)
      // Canvas answered and no longer holds what this change names, so the change
      // cannot be applied and checking the connection would not help.
      ? '<p class="warning">Canvas does not have the item this change names. It may have been renamed, moved, or removed since this change was prepared.</p><p>Return to your assistant and ask Morrow to read the latest Canvas content and prepare a new review. This page has not changed anything.</p>'
      : '<p class="warning">Morrow could not identify the course or a selected item in Canvas.</p><p>Nothing can be approved here until those details load. Check your Canvas connection, then reload this page.</p>'
    : `<p>${batch ? `Morrow will apply all ${plans.length} changes and check each result in Canvas. Searching does not change what you approve.` : addingQuestion ? "Morrow will add this question and check it in Canvas." : "Morrow applies these changes and checks them in Canvas."}</p><p class="keep-open">${keepOpenInstruction(platform)}</p><p class="presence-note">Approve here in Chrome with Morrow Bridge connected. A request from another program cannot approve.</p>`).replaceAll("Canvas", platform);
  // WI-4.4 (D2b, D3): only a single, rememberable change offers "do not ask again", never a
  // batch or a removal (`rememberOffer` already returns null for both). It rides in the same
  // form as the primary approve button, behind its own submit value, so one POST both approves
  // the change and asks the runtime to remember the bundle.
  const rememberButton = !batch && !missingNames && rememberOffer
    ? `<button name="remember" value="1" class="approve secondary" type="submit">${approveLabel}, and do not ask again for ${escapeHtml(rememberOffer.label.toLocaleLowerCase())} in this course</button>`
    : "";
  const approveForm = missingNames ? "" : `<form method="post" action="/${target.kind}/${escapedId}/approve"><input type="hidden" name="nonce" value="${escapeHtml(nonce())}"><button class="approve${destructive ? " danger" : ""}" type="submit">${approveLabel}</button>${rememberButton}</form>`;
  return pageShell(title, `<header class="hero${destructive ? " danger" : ""}"><h1>${escapeHtml(title)}</h1>${requestedByLine(snapshot, plans)}${batchSummary}${risks.map((risk) => `<p class="warning">${escapeHtml(risk)}</p>`).join("")}</header>${reviewContent}<footer class="decision"><div class="next-step">${next}</div><div class="actions">${approveForm}<form method="post" action="/${target.kind}/${escapedId}/cancel"><input type="hidden" name="nonce" value="${escapeHtml(nonce())}"><button class="cancel" type="submit">Cancel</button></form></div><details><summary>Technical details</summary><p class="details-help">Approval is for this request only and expires at ${escapeHtml(expiresAt)}. Changes are not undone automatically.</p><pre>${summary}</pre></details></footer>`);
}

/**
 * WI-6.4: the item a finished change reached, read from the frozen plan arguments already on
 * the operation record, never a fresh platform read (F28: the record has no item title, and the
 * status page linked from each row is where a title appears). `course_id` and `connection_id`
 * name the container, not the item, so they are skipped here the way the review page already
 * moves them to Technical details.
 */
function recentItemReference(request: JsonObject): string | null {
  for (const field of STRUCTURAL_EDIT_FIELDS) {
    if (field === "course_id" || field === "connection_id") continue;
    const value = request[field];
    if (typeof value === "string" && value.trim()) return `${readableName(field)}: ${value.trim()}`;
    if (typeof value === "number" && Number.isFinite(value)) return `${readableName(field)}: ${value}`;
  }
  return null;
}

function recentChangeTime(operation: JsonObject): string {
  const stamp = operation.terminalAt || operation.updatedAt || operation.createdAt;
  const time = typeof stamp === "string" ? Date.parse(stamp) : NaN;
  return Number.isFinite(time) ? new Date(time).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
}

function recentChangeRow(operation: JsonObject, index: number, controller: ApprovalOperationController): string {
  const plan = object(operation.plan);
  const tool = String(plan.tool || "");
  const platform = platformName(tool);
  const sourceBindingId = typeof operation.sourceBindingId === "string" ? operation.sourceBindingId : null;
  const courseName = controller.connectionName?.(sourceBindingId) || "";
  const itemReference = recentItemReference(object(plan.arguments));
  const context = [courseName, itemReference].filter((part): part is string => Boolean(part)).join(" · ") || platform;
  const operationId = String(operation.operationId || "");
  const statusUrl = `/operations/${encodeURIComponent(operationId)}`;
  const state = String(operation.state || "");
  const reverseRequest = `Reverse change ${operationId}.`;
  // A correction can be planned only for a change Morrow may have sent. A cancelled change, or one
  // that failed before it reached the platform, offers no undo request the assistant would refuse.
  const reverse = isCorrectableEffectOperation({
    state: state as EffectOperationState,
    verificationStatus: operation.verificationStatus as EffectVerificationStatus | null,
  })
    ? `<p>To undo this, ask your assistant: <code>${escapeHtml(reverseRequest)}</code></p><button type="button" class="recent-reverse-copy" data-copy-text="${escapeHtml(reverseRequest)}">Copy the request</button>`
    : "<p>Nothing was sent, so there is nothing to undo.</p>";
  return `<li class="recent-row"><span class="recent-number">${index + 1}</span><span class="recent-heading"><strong>${escapeHtml(reviewTitle(tool))}</strong><span class="recent-context">${escapeHtml(context)}</span></span><span class="recent-meta"><span class="recent-time">${escapeHtml(recentChangeTime(operation))}</span><span class="recent-state">${escapeHtml(operationStatus(state, platform, operation.verificationStatus))}</span></span><span class="recent-links"><a href="${escapeHtml(statusUrl)}">See this change</a><span class="recent-reverse">${reverse}</span></span></li>`;
}

/**
 * WI-6.4: the content of `/recent`. `operationList` already exists on the controller (F20), so
 * this reads a page of it, keeps only what reached a final state (`terminalAt` set), and shows
 * the newest 50. It calls no read method on the controller, so it never risks the live reads
 * `operationReviewContext` would make; a row names its item from the plan it already has.
 */
function recentChangesContent(controller: ApprovalOperationController): string {
  const snapshot = controller.operationList(RECENT_OPERATIONS_READ);
  const operations = Array.isArray(snapshot.operations) ? snapshot.operations.map(object) : [];
  const finished = operations.filter((operation) => typeof operation.terminalAt === "string").slice(0, RECENT_CHANGES_SHOWN);
  const list = finished.length
    ? `<ul class="recent-list">${finished.map((operation, index) => recentChangeRow(operation, index, controller)).join("")}</ul>`
    : `<p class="recent-empty">Morrow has not finished any changes yet.</p>`;
  return `<header class="hero"><h1>Recent changes</h1><p>Most recent first. A change that was cancelled or never sent says so and has nothing to undo.</p></header><section class="section recent-section">${list}</section>`;
}

const EDIT_ACCESS_ENDED: Readonly<Record<string, readonly [string, string]>> = {
  applying: ["Turning on Edit", "Morrow is saving Edit in Morrow Bridge. This page updates automatically. Keep Chrome open."],
  enabled: ["Edit is on", "Edit is on for these courses. It stays on until you return them to Plan in Morrow Bridge. Return to your assistant."],
  unconfirmed: ["Check each course", "Morrow could not confirm Edit for every course. Open Plan and Edit settings in Morrow Bridge to see what each course has now."],
  not_sent: ["Edit was not turned on", "A course connection changed before Morrow could save Edit, so nothing changed. Return to your assistant and ask again."],
  declined: ["Kept in Plan", "Morrow kept these courses in Plan. Nothing changed."],
  expired: ["Review expired", "Morrow did not turn on Edit. Return to your assistant and ask again if you still want Edit."],
};

/** Whether a selected course keeps a grant saved while Edit was timed, which ends by itself. */
function editAccessEndsSooner(view: JsonObject): boolean {
  return (Array.isArray(view.selections) ? view.selections.map(object) : []).some((selection) => typeof selection.grantEndsAt === "number");
}

function editAccessStatusContent(view: JsonObject): string {
  const [title, detail] = view.state === "enabled" && editAccessEndsSooner(view)
    ? ["Edit is on", "Edit is on for these courses. It stays on until you return a course to Plan in Morrow Bridge, except for a course this page says ends sooner. Return to your assistant."]
    : EDIT_ACCESS_ENDED[String(view.state)]
      ?? ["Check this request", "This Edit access review can no longer be answered here. Return to your assistant and ask again."];
  return `<section class="outcome"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></section>`;
}

/** Each course, its site, and the kinds of change the review names for it. */
function editAccessCourses(view: JsonObject, controller: ApprovalOperationController): string {
  const label = view.state === "awaiting_approval" ? "Changes Morrow can make without asking"
    : view.state === "enabled" ? "Changes Morrow now makes without asking"
      : "Changes your assistant asked for";
  const selections = Array.isArray(view.selections) ? view.selections.map(object) : [];
  return selections.map((selection) => {
    const actions = (Array.isArray(selection.actions) ? selection.actions : []).map(object);
    const endsAt = typeof selection.grantEndsAt === "number"
      ? new Date(selection.grantEndsAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : null;
    const ending = endsAt
      ? `<p class="warning">This course has Edit access from an earlier version of Morrow that ends ${escapeHtml(endsAt)}. These changes end with it, and the course returns to Plan.</p>`
      : "";
    // The course name comes from the connection lookup, the same projected
    // name the course list serves; the page never serves the Bridge's raw
    // courseName. Without a name the row names the platform, and the site
    // still names the connection.
    const courseName = controller.connectionName?.(typeof selection.sourceBindingId === "string" ? selection.sourceBindingId : null);
    const platform = providerPlatform(String(selection.provider ?? ""));
    return `<section class="section"><dl class="destination"><div><dt>Course</dt><dd>${escapeHtml(courseName || platform)}</dd></div><div><dt>Site</dt><dd>${escapeHtml(String(selection.site ?? ""))}</dd></div></dl><p class="preview-label">${label}</p><div class="formatted-preview"><ul>${actions.map((action) => `<li>${escapeHtml(String(action.label ?? ""))}</li>`).join("")}</ul></div>${ending}</section>`;
  }).join("");
}

function providerPlatform(provider: string): string {
  return provider === "canvas" ? "Canvas" : provider === "moodle" ? "Moodle" : provider;
}

// The nonce is issued only for a page that shows the form, as for an operation review.
function editAccessPage(target: ApprovalTarget, view: JsonObject, controller: ApprovalOperationController, grant: () => string, active: boolean): string {
  const courses = editAccessCourses(view, controller);
  if (view.state !== "awaiting_approval") {
    return pageShell("Edit access", `<div id="work-status" role="status" aria-live="polite" aria-atomic="true">${editAccessStatusContent(view)}</div>${courses}`, active);
  }
  const selections = Array.isArray(view.selections) ? view.selections.map(object) : [];
  const unchecked = [...new Set(selections.flatMap((selection) => (Array.isArray(selection.actions) ? selection.actions : [])
    .map(object).filter((action) => action.unchecked === true).map((action) => String(action.label ?? ""))))];
  const uncheckedNote = unchecked.length
    ? `<p class="warning">Morrow cannot check the saved result for ${unchecked.length} selected action${unchecked.length === 1 ? "" : "s"}: ${escapeHtml(unchecked.join(", "))}. Morrow reports those results as unconfirmed.</p>`
    : "";
  const expiry = Number(view.expiresAt);
  const expiresAt = Number.isFinite(expiry)
    ? new Date(expiry).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "15 minutes after it opened";
  const stays = editAccessEndsSooner(view)
    ? "Edit stays on until you return a course to Plan in Morrow Bridge, except for a course this page says ends sooner."
    : "Edit stays on for these courses until you return them to Plan in Morrow Bridge.";
  const path = `/${target.kind}/${escapeHtml(encodeURIComponent(target.id))}`;
  const nonce = escapeHtml(grant());
  return pageShell("Turn on Edit?", `<header class="hero"><h1>Turn on Edit?</h1><p>Your assistant asked Morrow to make these kinds of change without asking you each time.</p>${uncheckedNote}</header>${courses}<footer class="decision"><div class="next-step"><p>Changes Morrow already makes without asking in these courses stay on.</p><p>${stays}</p><p class="presence-note">Turn on Edit here in Chrome with Morrow Bridge connected. A request from another program cannot turn it on.</p></div><div class="actions"><form method="post" action="${path}/approve"><input type="hidden" name="nonce" value="${nonce}"><button class="approve" type="submit">Turn on Edit</button></form><form method="post" action="${path}/cancel"><input type="hidden" name="nonce" value="${nonce}"><button class="cancel" type="submit">Keep Plan</button></form></div><details><summary>Technical details</summary><p class="details-help">This review can be answered until ${escapeHtml(expiresAt)}. After that, ask your assistant again.</p></details></footer>`);
}

/** Why a close-out was refused, in the words the runtime gave the person. */
function closeRefusalText(result: JsonObject): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((entry) => object(entry).text).find((value): value is string => typeof value === "string" && value.length > 0);
  return text ?? "Return to your assistant and ask Morrow to check this request.";
}

function presenceRequiredPage(reviewPath: string, purpose: "approve" | "edit-access" | "close" = "approve"): string {
  if (purpose === "edit-access") {
    return pageShell("Turn on Edit in Chrome", `<section class="outcome"><h1>Turn on Edit in Chrome</h1><p>Morrow did not turn on Edit. Morrow accepts Turn on Edit only from a click on this page in Chrome with Morrow Bridge connected, not from a program that sends the form itself.</p><p><a href="${escapeHtml(reviewPath)}">Open the review again</a>, check that Morrow Bridge is connected, and select Turn on Edit there.</p></section>`);
  }
  if (purpose === "close") {
    return pageShell("Close this request in Chrome", `<section class="outcome"><h1>Close this request in Chrome</h1><p>Morrow did not close anything. Morrow closes a request only after a click on its page in Chrome with Morrow Bridge connected, not from a program that sends the form itself.</p><p><a href="${escapeHtml(reviewPath)}">Open the request again</a>, check that Morrow Bridge is connected, and select the button there.</p></section>`);
  }
  return pageShell("Approve this change in Chrome", `<section class="outcome"><h1>Approve this change in Chrome</h1><p>Morrow did not approve anything. Morrow accepts an approval only from a click on the review page in Chrome with Morrow Bridge connected, not from a program that sends the form itself.</p><p><a href="${escapeHtml(reviewPath)}">Open the review again</a>, check that Morrow Bridge is connected, and select the button there.</p></section>`);
}

function recentChangesRefusal(title: string, detail: string): string {
  return pageShell(title, `<section class="outcome"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></section>`);
}

function cookieValue(request: IncomingMessage, name: string): string | null {
  for (const part of String(request.headers.cookie || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function exactSecret(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function approvalCookieName(nonce: string): string {
  return `morrow_approval_${nonce}`;
}

async function readFormNonce(request: IncomingMessage): Promise<{ nonce: string | null; remember: boolean; presence: string | null }> {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return { nonce: null, remember: false, presence: null };
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 8_192) throw new Error("approval request is too large");
    chunks.push(buffer);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  return { nonce: form.get("nonce"), remember: form.get("remember") === "1", presence: form.get("presence") };
}

export class LoopbackApprovalServer {
  private readonly server: Server;
  private readonly httpLifecycle: BoundedHttpServerLifecycle;
  private readonly nonces = new Map<string, { targetKey: string; expiresAt: number; canApprove: boolean }>();
  private readonly work = new Map<string, Promise<unknown>>();
  // WI-4.4: the sentence the "do not ask again" grant left for one operation, read by both the
  // full result page and the status poll. Bounded the same way `nonces` is: a server that runs
  // for a long time must not grow this without limit from reviews nobody ever reopens.
  private readonly rememberResults = new Map<string, string>();
  // WI-6.4: `/recent` names no operation, so it needs its own gate. `recentEntries` holds each
  // one-time code, minted for the `morrow_recent_changes` tool, until it is exchanged once for a
  // `recentSessions` token, which the cookie then carries for its own 900-second lifetime.
  // A result page's link is tied to its operation (`targetKey`) and reused on every reload and
  // poll until it is spent, so page traffic cannot push out the code the tool handed out.
  private readonly recentEntries = new Map<string, { expiresAt: number; targetKey: string | null }>();
  private readonly recentSessions = new Map<string, number>();
  private readonly stopping = new AbortController();
  private readonly presenceKey = randomBytes(32).toString("base64url");
  private port: number | null = null;
  private approvalAdmissionOpen = true;
  private approvalPosts = 0;

  constructor(private readonly controller: ApprovalOperationController) {
    this.server = createServer((request, response) => {
      const accepted = this.httpLifecycle.accept(request, response);
      if (!accepted) {
        sendJson(response, 503, { schema: "morrow.problem.v1", code: "approval_server_closing" });
        return;
      }
      void this.handle(request, response, accepted.signal).finally(accepted.release);
    });
    this.httpLifecycle = new BoundedHttpServerLifecycle(this.server);
  }

  get baseUrl(): string | null {
    return this.port === null ? null : `http://${LOOPBACK_HOST}:${this.port}`;
  }

  /** The key this server hands to Morrow Bridge, for an in-process caller. Null before start. */
  get approvalPresence(): ReviewApprovalPresence | null {
    const origin = this.baseUrl;
    return origin ? { origin, key: this.presenceKey } : null;
  }

  /**
   * The shared local owner closes admission before its synchronous maintenance
   * snapshot. Existing approval posts remain counted until they settle.
   */
  setMaintenanceAdmission(open: boolean): void {
    this.approvalAdmissionOpen = open;
  }

  maintenanceQuiescent(): boolean {
    return !this.approvalAdmissionOpen && this.approvalPosts === 0 && this.work.size === 0;
  }

  private issueNonce(targetKey: string, canApprove: boolean): string {
    const now = Date.now();
    for (const [nonce, grant] of this.nonces) if (grant.expiresAt <= now) this.nonces.delete(nonce);
    const targetNonces = [...this.nonces].filter(([, grant]) => grant.targetKey === targetKey);
    while (targetNonces.length >= MAX_APPROVAL_NONCES_PER_TARGET) {
      const oldest = targetNonces.shift();
      if (oldest) this.nonces.delete(oldest[0]);
    }
    this.reclaimNonceSlot();
    let nonce: string;
    do nonce = randomBytes(32).toString("base64url"); while (this.nonces.has(nonce));
    this.nonces.set(nonce, { targetKey, expiresAt: now + 15 * 60_000, canApprove });
    return nonce;
  }

  /**
   * The global cap reclaims only a spare grant, the way a full file stage refuses
   * instead of dropping a pending one. A review that holds a single live grant
   * keeps it, so an unrelated page load can never answer its approval 409.
   */
  private reclaimNonceSlot(): void {
    while (this.nonces.size >= MAX_APPROVAL_NONCES) {
      const held = new Map<string, number>();
      for (const grant of this.nonces.values()) held.set(grant.targetKey, (held.get(grant.targetKey) ?? 0) + 1);
      const spare = [...this.nonces].find(([, grant]) => (held.get(grant.targetKey) ?? 0) > 1);
      if (!spare) throw new Error("too many reviews are open to start another one");
      this.nonces.delete(spare[0]);
    }
  }

  private revokeTargetNonces(targetKey: string): void {
    for (const [nonce, grant] of this.nonces) if (grant.targetKey === targetKey) this.nonces.delete(nonce);
  }

  private rememberText(target: ApprovalTarget): string | undefined {
    return target.kind === "operations" ? this.rememberResults.get(target.id) : undefined;
  }

  /**
   * WI-6.4: mints the one-time code the `morrow_recent_changes` tool sends as
   * `${baseUrl}/recent?entry=<code>`. Public because the tool calls it directly, the way it reads
   * `baseUrl` directly; `/recent` itself only ever consumes a code, never issues one.
   */
  issueRecentChangesEntry(targetKey: string | null = null): string {
    const now = Date.now();
    for (const [code, entry] of this.recentEntries) if (entry.expiresAt <= now) this.recentEntries.delete(code);
    if (targetKey !== null) {
      for (const [code, entry] of this.recentEntries) if (entry.targetKey === targetKey) return code;
    }
    while (this.recentEntries.size >= MAX_RECENT_ENTRIES) {
      // A result page can mint its link again on the next load; a code the tool handed out
      // cannot be handed out again, so a page's code goes first.
      const oldest = [...this.recentEntries].find(([, entry]) => entry.targetKey !== null)?.[0]
        ?? this.recentEntries.keys().next().value;
      if (oldest === undefined) break;
      this.recentEntries.delete(oldest);
    }
    let code: string;
    do code = randomBytes(32).toString("base64url"); while (this.recentEntries.has(code));
    this.recentEntries.set(code, { expiresAt: now + RECENT_ENTRY_TTL_MS, targetKey });
    return code;
  }

  /** The one-time entry code is spent for a 900-second session, held as the `/recent` cookie's value. */
  private issueRecentSession(): string {
    const now = Date.now();
    for (const [token, expiresAt] of this.recentSessions) if (expiresAt <= now) this.recentSessions.delete(token);
    while (this.recentSessions.size >= MAX_RECENT_SESSIONS) {
      const oldest = this.recentSessions.keys().next().value;
      if (oldest === undefined) break;
      this.recentSessions.delete(oldest);
    }
    let token: string;
    do token = randomBytes(32).toString("base64url"); while (this.recentSessions.has(token));
    this.recentSessions.set(token, now + RECENT_SESSION_TTL_MS);
    return token;
  }

  /**
   * WI-4.4: runs after `approveOperation` already succeeded and the change's own work has
   * started, never awaited by the request that approved it ("Approve first. A failed grant must
   * not stop the change."). `rememberOffer` is read again here, not carried from the
   * page load that showed the button: the bundle is decoration on top of an
   * approval the person already made, so reading them fresh is no less correct than the page's
   * own copy, and never risks approving on stale data.
   */
  private async rememberChoice(operationId: string): Promise<void> {
    let text = "Morrow could not save that choice. It asks again next time.";
    try {
      const offer = await this.controller.rememberOffer?.(operationId);
      if (offer && (await this.controller.rememberKind?.(operationId)) === "saved") {
        text = offer.joinsTimedGrant
          ? `Morrow does not ask again for ${offer.label.toLocaleLowerCase()} in this course until the Edit access this course already had ends.`
          : `Morrow does not ask again for ${offer.label.toLocaleLowerCase()} in this course until you return the course to Plan in Morrow Bridge.`;
      }
    } catch { /* the sentence already defaults to the failure case */ }
    if (this.rememberResults.size >= MAX_APPROVAL_NONCES && !this.rememberResults.has(operationId)) {
      const oldest = this.rememberResults.keys().next().value;
      if (oldest !== undefined) this.rememberResults.delete(oldest);
    }
    this.rememberResults.set(operationId, text);
  }

  /** Hands the review's label-to-name map to the runtime for Morrow Bridge. A failure changes nothing here. */
  private shareLearnerNames(target: ApprovalTarget, contexts: ReadonlyMap<string, ApprovalReviewContext> | undefined): void {
    try {
      this.controller.setReviewLearnerNames?.(`/${target.kind}/${target.id}`, reviewLearnerNames(contexts));
    } catch { /* the page still shows every learner by label */ }
  }

    async start(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, LOOPBACK_HOST, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("approval server did not bind a TCP address");
    this.port = (address as AddressInfo).port;
    const baseUrl = this.baseUrl;
    if (!baseUrl) throw new Error("approval server has no loopback URL");
    this.controller.setApprovalBaseUrl(baseUrl);
    this.controller.setApprovalPresence?.({ origin: baseUrl, key: this.presenceKey });
    return baseUrl;
  }

  private async handle(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
    const method = request.method || "GET";
    const url = new URL(request.url || "/", `http://${LOOPBACK_HOST}`);
    try {
      if (!this.baseUrl || request.headers.host !== new URL(this.baseUrl).host) {
        sendJson(response, 403, { schema: "morrow.problem.v1", code: "local_host_required" });
        return;
      }
      if (method === "GET" && serveBrandAsset(url.pathname, response)) return;
      if (method === "GET" && url.pathname === "/review-status.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(STATUS_SCRIPT);
        return;
      }
      if (method === "GET" && url.pathname === "/operations") {
        sendJson(response, 200, operationsList(this.controller.operationList()));
        return;
      }
      if (method === "GET" && url.pathname === "/recent") {
        const entry = url.searchParams.get("entry");
        if (entry) {
          const expiresAt = this.recentEntries.get(entry)?.expiresAt;
          this.recentEntries.delete(entry);
          if (!expiresAt || expiresAt <= Date.now()) {
            sendHtml(response, 409, recentChangesRefusal(
              "This link already opened, or it expired",
              "Ask your assistant for a new link to recent changes.",
            ));
            return;
          }
          const token = this.issueRecentSession();
          response.writeHead(303, {
            location: "/recent",
            "cache-control": "no-store",
            "set-cookie": `${RECENT_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/recent; Max-Age=900`,
          });
          response.end();
          return;
        }
        const sessionToken = cookieValue(request, RECENT_COOKIE_NAME);
        const sessionExpiresAt = sessionToken ? this.recentSessions.get(sessionToken) : undefined;
        if (!sessionToken || !sessionExpiresAt || sessionExpiresAt <= Date.now()) {
          if (sessionToken) this.recentSessions.delete(sessionToken);
          sendHtml(response, 403, recentChangesRefusal(
            "Ask your assistant for this link",
            "This page needs a current link from your assistant. Ask your assistant for recent changes.",
          ));
          return;
        }
        sendHtml(response, 200, pageShell("Recent changes", recentChangesContent(this.controller)));
        return;
      }
      const target = approvalPath(url.pathname);
      if (!target) {
        if (String(request.headers.accept || "").includes("text/html")) sendHtml(response, 404, statePage("unavailable"));
        else sendJson(response, 404, { schema: "morrow.problem.v1", code: "not_found" });
        return;
      }
      if (method === "GET" && (!target.action || target.action === "status") && target.kind === "edit-access") {
        const view = this.controller.editAccessGet?.(target.id);
        if (!view) throw new Error("edit access review is unavailable");
        const nonceKey = `${target.kind}:${target.id}`;
        const active = this.work.has(nonceKey) || view.state === "applying";
        if (target.action === "status") {
          sendJson(response, 200, { html: editAccessStatusContent(view), active, states: {} });
          return;
        }
        let nonce: string | null = null;
        const body = editAccessPage(target, view, this.controller, () => (nonce = this.issueNonce(nonceKey, true)), active);
        if (nonce) {
          try {
            this.controller.announceApprovalPresence?.();
          } catch { /* the page still loads; the Bridge asks the person to reload when it has no key */ }
        }
        sendHtml(
          response,
          200,
          body,
          nonce ? `${approvalCookieName(nonce)}=${nonce}; HttpOnly; SameSite=Strict; Path=/${target.kind}/${encodeURIComponent(target.id)}; Max-Age=900` : undefined,
        );
        return;
      }
      if (method === "GET" && (!target.action || target.action === "status")) {
        const snapshot = target.kind === "batches" && target.action === "status"
          ? this.controller.batchApprovalStatus?.(target.id)
          : target.kind === "batches"
            ? this.controller.batchApprovalGet?.(target.id)
          : this.controller.operationGet(target.id);
        if (!snapshot) throw new Error("batch approval is unavailable");
        const active = this.work.has(`${target.kind}:${target.id}`);
        const operations = target.kind === "batches" && Array.isArray(snapshot.children)
          ? snapshot.children.map((child) => object(object(child).operation)) : [snapshot];
        if (target.action === "status") {
          const states = object(snapshot.states);
          const verifiedNow = reviewState(target, snapshot) === "verified";
          const contexts = verifiedNow
            ? await reviewContexts(this.controller, operations, signal)
            : undefined;
          const recentEntry = verifiedNow ? this.issueRecentChangesEntry(`${target.kind}:${target.id}`) : null;
          if (verifiedNow) this.shareLearnerNames(target, contexts);
          sendJson(response, 200, { html: statusContent(target, snapshot, active, contexts, this.rememberText(target), recentEntry), active, states });
          return;
        }
        const expiry = Date.parse(String(snapshot.approvalExpiresAt || snapshot.expiresAt || ""));
        const state = reviewState(target, snapshot);
        const contexts = state !== "awaiting_approval" || !Number.isFinite(expiry) || expiry > Date.now()
          ? await reviewContexts(this.controller, operations, signal)
          : new Map<string, ApprovalReviewContext>();
        const nonceKey = `${target.kind}:${target.id}`;
        const canApprove = !namedTargetsMissing(operations, contexts);
        const cookiePath = `/${target.kind}/${encodeURIComponent(target.id)}`;
        let nonce: string | null = null;
        const rememberOffer = target.kind === "operations" && state === "awaiting_approval" && this.controller.rememberOffer
          ? await this.controller.rememberOffer(target.id).catch(() => null)
          : null;
        const recentEntry = state === "verified" ? this.issueRecentChangesEntry(`${target.kind}:${target.id}`) : null;
        const closeOffer = target.kind === "operations" && UNRESOLVED_REVIEW_STATES.has(state)
          && this.controller.personCloseAvailable?.(target.id) === true;
        const body = html(target, snapshot, () => (nonce = this.issueNonce(nonceKey, canApprove)), contexts, active, rememberOffer, this.rememberText(target), recentEntry, closeOffer);
        this.shareLearnerNames(target, ENDED_REVIEW_STATES.has(state) ? undefined : contexts);
        if (nonce && ((canApprove && state === "awaiting_approval") || closeOffer)) {
          try {
            this.controller.announceApprovalPresence?.();
          } catch { /* the page still loads; the Bridge asks the person to reload when it has no key */ }
        }
        sendHtml(
          response,
          200,
          body,
          nonce ? `${approvalCookieName(nonce)}=${nonce}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=900` : undefined,
        );
        return;
      }
      if (method === "POST" && (target.action === "approve" || target.action === "cancel"
        || (target.action === "close" && target.kind === "operations"))) {
        if (!this.approvalAdmissionOpen) {
          sendJson(response, 409, { schema: "morrow.problem.v1", code: "approval_maintenance_held" });
          return;
        }
        this.approvalPosts += 1;
        try {
        const nonceKey = `${target.kind}:${target.id}`;
        const requestOrigin = String(request.headers.origin || "");
        const requestReferer = String(request.headers.referer || "");
        const baseUrl = this.baseUrl;
        const originValid = requestOrigin === baseUrl;
        const refererValid = requestReferer === `${baseUrl}/${target.kind}/${encodeURIComponent(target.id)}`;
        const { nonce: formNonce, remember, presence } = await readFormNonce(request);
        signal.throwIfAborted();
        const expected = formNonce ? this.nonces.get(formNonce) : undefined;
        const cookieNonce = formNonce && expected ? cookieValue(request, approvalCookieName(formNonce)) : null;
        if (
          !expected
          || expected.targetKey !== nonceKey
          || (target.action === "approve" && !expected.canApprove)
          || expected.expiresAt <= Date.now()
          || !originValid
          || !refererValid
          || !exactSecret(cookieNonce, formNonce!)
        ) {
          if (formNonce && expected?.expiresAt && expected.expiresAt <= Date.now()) this.nonces.delete(formNonce);
          throw new Error("approval nonce is missing, expired, or invalid");
        }
        // The nonce and cookie prove only that the caller read the page, which any local HTTP
        // client can do. Approval also needs Morrow Bridge's signature over this exact form, which
        // it adds only after a real click in the review tab. A refusal keeps the nonce, so the
        // person can still approve in Chrome.
        if ((target.action === "approve" || target.action === "close")
          && !exactSecret(presence, reviewApprovalProof(this.presenceKey, url.pathname, formNonce!))) {
          if (String(request.headers.accept || "").includes("text/html")) {
            sendHtml(response, 403, presenceRequiredPage(`/${target.kind}/${encodeURIComponent(target.id)}`,
              target.action === "close" ? "close" : target.kind === "edit-access" ? "edit-access" : "approve"));
          } else sendJson(response, 403, { schema: "morrow.problem.v1", code: "approval_presence_required" });
          return;
        }
        this.revokeTargetNonces(nonceKey);
        if (target.action === "close") {
          if (!this.controller.confirmPersonClose || this.stopping.signal.aborted) throw new Error("person close is unavailable");
          const closed = await this.controller.confirmPersonClose(target.id);
          const cookie = `${approvalCookieName(formNonce!)}=; HttpOnly; SameSite=Strict; Path=/${target.kind}/${encodeURIComponent(target.id)}; Max-Age=0`;
          if (closed.isError === true) {
            sendHtml(response, 409, pageShell("Request not closed", `<section class="outcome"><h1>Request not closed</h1><p>Morrow did not close this request. ${escapeHtml(closeRefusalText(closed))}</p></section>`), cookie);
            return;
          }
          response.writeHead(303, {
            location: `/${target.kind}/${encodeURIComponent(target.id)}`,
            "cache-control": "no-store",
            "set-cookie": cookie,
          });
          response.end();
          return;
        }
        if (this.stopping.signal.aborted
          || (target.action === "approve" && target.kind === "batches" && !this.controller.runApprovedBatch)
          || (target.action === "approve" && target.kind === "edit-access" && !this.controller.runApprovedEditAccess)) {
          throw new Error("review execution is unavailable");
        }
        if (target.kind === "edit-access") {
          const answered = target.action === "approve"
            ? this.controller.approveEditAccess?.(target.id)
            : this.controller.cancelEditAccess?.(target.id);
          if (!answered) throw new Error("edit access review is unavailable");
          const spent = `${approvalCookieName(formNonce!)}=; HttpOnly; SameSite=Strict; Path=/${target.kind}/${encodeURIComponent(target.id)}; Max-Age=0`;
          if (target.action === "approve" && answered.approved !== true) {
            sendHtml(response, 409, pageShell("Edit access", editAccessStatusContent(answered)), spent);
            return;
          }
          if (target.action === "approve") {
            const work = Promise.resolve().then(() => this.controller.runApprovedEditAccess!(target.id, this.stopping.signal));
            this.work.set(nonceKey, work.catch(() => undefined).finally(() => this.work.delete(nonceKey)));
          }
          response.writeHead(303, { location: `/${target.kind}/${encodeURIComponent(target.id)}`, "cache-control": "no-store", "set-cookie": spent });
          response.end();
          return;
        }
        const result = target.kind === "batches"
          ? target.action === "approve"
            ? this.controller.approveBatch?.(target.id)
            : this.controller.cancelBatchApproval?.(target.id)
          : target.action === "approve"
            ? this.controller.approveOperation(target.id)
            : this.controller.cancelOperation(target.id);
        if (!result) throw new Error("batch approval action is unavailable");
        const resultState = reviewState(target, result);
        const approved = target.action === "approve" && resultState === "approved";
        const cookie = `${approvalCookieName(formNonce!)}=; HttpOnly; SameSite=Strict; Path=/${target.kind}/${encodeURIComponent(target.id)}; Max-Age=0`;
        if (target.action === "approve" && !approved) {
          sendHtml(response, 409, statePage(resultState, snapshotPlatform(result)), cookie);
          return;
        }
        if (approved) {
          const work = Promise.resolve().then(() => target.kind === "batches"
            ? this.controller.runApprovedBatch!(target.id, this.stopping.signal)
            : this.controller.runApprovedOperation(target.id, this.stopping.signal));
          this.work.set(nonceKey, work.catch(() => undefined).finally(() => this.work.delete(nonceKey)));
          // WI-4.4: approve first, remember second, and never let the grant hold up this
          // response. "A failed grant must not stop the change" (spec, WI-4.4 notes).
          if (remember && target.kind === "operations") void this.rememberChoice(target.id);
        }
        response.writeHead(303, {
          location: `/${target.kind}/${encodeURIComponent(target.id)}`,
          "cache-control": "no-store",
          "set-cookie": cookie,
        });
        response.end();
        return;
        } finally {
          this.approvalPosts -= 1;
        }
      }
      sendJson(response, 405, { schema: "morrow.problem.v1", code: "method_not_allowed" });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const message = error instanceof Error ? error.message : "approval action failed";
      if (String(request.headers.accept || "").includes("text/html")) {
        sendHtml(response, 409, pageShell("Review unavailable", '<section class="outcome"><h1>Review unavailable</h1><p>This review may have expired or the request may have changed. Return to your assistant and ask Morrow to check its current status.</p><p>Do not repeat the change until Morrow checks the saved result.</p></section>'));
      } else sendJson(response, 409, { schema: "morrow.problem.v1", code: "approval_action_refused", message });
    }
  }

  async close(): Promise<void> {
    if (this.port === null) return;
    this.stopping.abort();
    await this.httpLifecycle.close();
    await Promise.all(this.work.values());
    this.port = null;
    this.nonces.clear();
    this.recentEntries.clear();
    this.recentSessions.clear();
  }
}
