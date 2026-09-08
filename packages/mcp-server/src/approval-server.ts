import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { brandHead, brandHeader, serveBrandAsset } from "@morrow/bridge-loopback";
import type { ApprovalReviewContext, ApprovalReviewReadCache } from "./approval-context.js";
import { escapeHtml, formattedTextPreview } from "./approval-preview.js";
import { BLACKBOARD_CONTENT_PATCH_APPLY_TOOL } from "./blackboard-content-patch.js";

const LOOPBACK_HOST = "127.0.0.1";

export interface ApprovalOperationController {
  operationGet(operationId: string): JsonObject;
  operationList(limit?: number): JsonObject;
  operationReviewContext?(operationId: string, cache?: ApprovalReviewReadCache): Promise<ApprovalReviewContext>;
  approveOperation(operationId: string): JsonObject;
  runApprovedOperation(operationId: string): Promise<unknown>;
  cancelOperation(operationId: string): JsonObject;
  setApprovalBaseUrl(baseUrl: string): void;
  batchApprovalGet?(batchId: string): JsonObject;
  batchApprovalStatus?(batchId: string): JsonObject;
  approveBatch?(batchId: string): JsonObject;
  runApprovedBatch?(batchId: string, signal: AbortSignal): Promise<unknown>;
  cancelBatchApproval?(batchId: string): JsonObject;
}

interface ApprovalTarget {
  readonly kind: "operations" | "batches";
  readonly id: string;
  readonly action?: "approve" | "cancel" | "status";
}

function approvalPath(pathname: string): ApprovalTarget | null {
  const match = /^\/(operations|batches)\/([^/]+?)(?:\/(approve|cancel|status))?$/.exec(pathname);
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
async function refreshStatus() {
  try {
    const response = await fetch(location.pathname + "/status", { cache: "no-store" });
    if (!response.ok) throw new Error("status unavailable");
    const result = await response.json();
    if (status.innerHTML !== result.html) status.innerHTML = result.html;
    Object.entries(result.states || {}).forEach(([index, text]) => {
      const element = statusNodes[Number(index)];
      if (element && typeof text === "string" && element.textContent !== text) element.textContent = text;
    });
    if (result.active) setTimeout(refreshStatus, 1000);
    else document.getElementById("stop-work")?.remove();
  } catch {
    status.textContent = "Morrow cannot refresh this result. Reload this page to check it. Do not repeat the change.";
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
const VERIFICATION_STATES = new Set(["not_requested", "unconfirmed", "verified"]);
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

function namedTargetsMissing(operations: readonly JsonObject[], contexts: ReadonlyMap<string, ApprovalReviewContext>): boolean {
  return operations.some((operation) => {
    const plan = object(operation.plan);
    if (!/^(canvas|moodle|blackboard)_/.test(String(plan.tool))) return false;
    const request = object(plan.arguments);
    const blackboardCourseCopy = plan.tool === "blackboard_apply_reviewed_course_copy"
      && typeof request.course_id === "string" && request.course_id.trim().length > 0
      && typeof request.destination_course_id === "string" && request.destination_course_id.trim().length > 0;
    const context = contexts.get(String(operation.operationId));
    const targets = context?.targets || [];
    const source = context?.current?.current_section;
    return (plan.tool === "moodle_move_activity" && operation.state === "awaiting_approval" && (typeof source !== "string" || !source.trim()))
      || targets.some((item) => !item.name.trim()) || ["id", ...(!blackboardCourseCopy ? ["course_id"] : []), "assignment_id", "quiz_id", "content_id", "connection_id", "topic_id", "file_id", "item_id", "rubric_id", "module_id", "section_id", "target_section_id", "category_id", "grade_item_id", "bank_id", "group_id", "account_id", "url_or_id"].some((field) =>
      field in request && !targets.some((item) => item.field === field && item.name.trim()));
  });
}

function keepOpenInstruction(platform: string): string {
  // Blackboard runs through this computer's own REST connection, so that review
  // needs no browser. Canvas, Moodle, and a mixed group still go through Chrome.
  return platform === "Blackboard"
    ? "Keep your assistant open while Morrow works."
    : "Keep your assistant and Chrome open while Morrow works.";
}

function stateContent(state: string, platform = "Canvas", attention: readonly unknown[] = []): string {
  const content: Record<string, [string, string]> = {
    approved: ["Changes not started", "Your approval was saved, but this request is not running. Return to your assistant and ask Morrow to check this saved request before starting anything else."],
    verified: ["Changes confirmed", "Morrow checked Canvas and confirmed the requested result."],
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
    : content[state] || ["Check this request", "The request has changed or can no longer be approved here. Return to your assistant and ask Morrow to check its current status."];
  return `<section class="outcome"><h1>${title}</h1><p>${detail.replaceAll("Canvas", platform)}</p></section>`;
}

function statePage(state: string, platform?: string): string {
  return pageShell("Request status", stateContent(state, platform));
}

export function operationStatus(state: string, platform = "Canvas"): string {
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

function statusContent(target: ApprovalTarget, snapshot: JsonObject, active: boolean): string {
  let state = reviewState(target, snapshot);
  if (active && state === "approved") state = "running";
  if (!active && ["running", "dispatching"].includes(state)) state = "interrupted";
  const children = Array.isArray(snapshot.children) ? snapshot.children : [];
  const confirmed = Number(snapshot.confirmedChildren || children.filter((child) => object(object(child).operation).state === "verified").length);
  const total = Number(snapshot.totalChildren || children.length);
  const platform = snapshotPlatform(snapshot);
  const attention = Array.isArray(snapshot.attention) ? snapshot.attention : [];
  return stateContent(state, platform, attention) + (total ? `<section class="section"><p>${confirmed} of ${total} changes confirmed in ${platform}.</p></section>` : "");
}

function html(target: ApprovalTarget, snapshot: JsonObject, nonce: string, contexts: ReadonlyMap<string, ApprovalReviewContext>, active: boolean): string {
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
    const name = typeof entry.tool === "string" ? readableName(entry.tool) : "Requested changes";
    const blackboardEdit = entry.tool === BLACKBOARD_CONTENT_PATCH_APPLY_TOOL;
    const blackboardPatch = blackboardEdit ? blackboardContentFields(object(request.patch)) : "";
    const blackboardCourseCopy = entry.tool === "blackboard_apply_reviewed_course_copy";
    const displayedRequest = blackboardCourseCopy
      ? { source_course_id: request.course_id, destination_course_id: request.destination_course_id }
      : request;
    const hiddenFields = ["expected_digest", "expected_connection", "tenant_id", "source_binding_id", "expected_plan_digest", "morrow_new_quiz_settings_guard", ...(missingNames ? ["course_id", "assignment_id", "quiz_id", "content_id", "connection_id", "target_section_id"] : []), ...targets.map((item) => item.field)];
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
    return `<details class="change-item" data-search="${escapeHtml(`${title} ${where} ${name} ${kind}`.toLocaleLowerCase())}"><summary><span class="change-number">${index + 1}</span><span class="change-heading"><strong>${escapeHtml(title)}</strong><span class="change-context">${escapeHtml(metadata)}</span>${state !== "awaiting_approval" ? `<span data-operation-status>${operationStatus(String(operations[index]?.state), platformName(entry.tool))}</span>` : ""}</span><span class="change-kind${kind === "Remove" ? " removal" : ""}">${kind}</span></summary>${sensitive ? `<p class="item-warning">${escapeHtml(sensitive)}</p>` : ""}${content}</details>`;
  }).join("");
  const reviewContent = batch ? `<section class="batch-review"><div class="change-list-controls" hidden><label for="change-search">Find a change</label><input id="change-search" type="search" placeholder="Search titles or courses" autocomplete="off"></div><div class="change-list">${changed}</div><nav class="change-pagination" aria-label="Review pages" hidden><p id="changes-count" role="status" aria-live="polite"></p><div><button id="changes-previous" type="button" class="secondary">Previous</button><button id="changes-next" type="button" class="secondary">Next</button></div></nav></section>` : changed;
  if (state !== "awaiting_approval") {
    const stop = batch && active ? `<div class="actions" id="stop-work"><form method="post" action="/${target.kind}/${escapedId}/cancel"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button class="cancel" type="submit">Stop remaining changes</button></form></div>` : "";
    return pageShell("Your result", `<div id="work-status" role="status" aria-live="polite" aria-atomic="true">${statusContent(target, snapshot, active)}</div>${commonTargets.length ? `<section class="section">${batchSummary}</section>` : ""}${reviewContent}${stop}<section class="section result-details"><details><summary>Technical details</summary><pre>${summary}</pre></details></section>`, active);
  }
  const addingQuestion = !batch && plan.tool === "canvas_create_quiz_item";
  const planRouting = object(object(plan.arguments)._morrow);
  const canvasContentGuard = object(planRouting.canvas_content_guard);
  const pageGuard = Object.keys(canvasContentGuard).length ? canvasContentGuard : object(planRouting.page_guard);
  const changingPageText = !batch && isJsonObject(pageGuard) && ["text", "page_text"].includes(String(pageGuard.kind));
  const changingImageAlt = !batch && isJsonObject(pageGuard) && ["image_alt", "page_image_alt", "assignment_image_alt", "discussion_image_alt"].includes(String(pageGuard.kind));
  const markingImageDecorative = changingImageAlt && pageGuard.decorative === true;
  const title = batch ? `Review ${plans.length} changes` : addingQuestion ? "Add question?" : changingPageText ? "Edit Page text?" : changingImageAlt ? markingImageDecorative ? "Mark decorative?" : "Add image alt text?" : `${readableName(String(plan.tool || "Review change"))}?`;
  const approveLabel = batch ? `Apply all ${plans.length} changes` : addingQuestion ? "Add this question" : changingPageText ? "Change this text" : changingImageAlt ? markingImageDecorative ? "Mark as decorative" : "Add alternative text" : "Apply this change";
  const next = (limited
    ? '<p class="warning">Too many different courses or activities to review at once.</p><p>Return to your assistant and ask Morrow to split this into smaller groups. This page has not approved any changes.</p>'
    : missingNames
    ? '<p class="warning">Morrow could not identify the course or a selected item in Canvas.</p><p>Nothing can be approved here until those details load. Check your Canvas connection, then reload this page.</p>'
    : `<p>${batch ? `Morrow will apply all ${plans.length} changes and check each result in Canvas. Searching does not change what you approve.` : addingQuestion ? "Morrow will add this question and check it in Canvas." : "Morrow applies these changes and checks them in Canvas."}</p><p class="keep-open">${keepOpenInstruction(platform)}</p>`).replaceAll("Canvas", platform);
  const approveForm = missingNames ? "" : `<form method="post" action="/${target.kind}/${escapedId}/approve"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button class="approve" type="submit">${approveLabel}</button></form>`;
  return pageShell(title, `<header class="hero"><h1>${escapeHtml(title)}</h1>${requestedByLine(snapshot, plans)}${batchSummary}${risks.map((risk) => `<p class="warning">${escapeHtml(risk)}</p>`).join("")}</header>${reviewContent}<footer class="decision"><div class="next-step">${next}</div><div class="actions">${approveForm}<form method="post" action="/${target.kind}/${escapedId}/cancel"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button class="cancel" type="submit">Cancel</button></form></div><details><summary>Technical details</summary><p class="details-help">Approval is for this request only and expires at ${escapeHtml(expiresAt)}. Changes are not undone automatically.</p><pre>${summary}</pre></details></footer>`);
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

async function readFormNonce(request: IncomingMessage): Promise<string | null> {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return null;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 8_192) throw new Error("approval request is too large");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("nonce");
}

export class LoopbackApprovalServer {
  private readonly server: Server;
  private readonly nonces = new Map<string, { value: string; expiresAt: number; canApprove: boolean }>();
  private readonly work = new Map<string, Promise<unknown>>();
  private readonly stopping = new AbortController();
  private port: number | null = null;
  private approvalAdmissionOpen = true;
  private approvalPosts = 0;

  constructor(private readonly controller: ApprovalOperationController) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  get baseUrl(): string | null {
    return this.port === null ? null : `http://${LOOPBACK_HOST}:${this.port}`;
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
    return baseUrl;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
      const target = approvalPath(url.pathname);
      if (!target) {
        if (String(request.headers.accept || "").includes("text/html")) sendHtml(response, 404, statePage("unavailable"));
        else sendJson(response, 404, { schema: "morrow.problem.v1", code: "not_found" });
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
        if (target.action === "status") {
          const states = object(snapshot.states);
          sendJson(response, 200, { html: statusContent(target, snapshot, active), active, states });
          return;
        }
        const contexts = new Map<string, ApprovalReviewContext>();
        const operations = target.kind === "batches" && Array.isArray(snapshot.children)
          ? snapshot.children.map((child) => object(object(child).operation)) : [snapshot];
        const expiry = Date.parse(String(snapshot.approvalExpiresAt || snapshot.expiresAt || ""));
        if (this.controller.operationReviewContext
          && (reviewState(target, snapshot) !== "awaiting_approval" || !Number.isFinite(expiry) || expiry > Date.now())) {
          const readCache: ApprovalReviewReadCache = new Map();
          for (let offset = 0; offset < operations.length; offset += 4) {
            await Promise.all(operations.slice(offset, offset + 4).map(async (operation) => {
              const operationId = String(operation.operationId || "");
              if (!operationId) return;
              try {
                contexts.set(operationId, await this.controller.operationReviewContext!(operationId, readCache));
              } catch { /* keep the exact request visible when Canvas cannot provide its name */ }
            }));
          }
        }
        const nonce = randomBytes(32).toString("base64url");
        const nonceKey = `${target.kind}:${target.id}`;
        this.nonces.set(nonceKey, { value: nonce, expiresAt: Date.now() + 15 * 60_000, canApprove: !namedTargetsMissing(operations, contexts) });
        const cookiePath = `/${target.kind}/${encodeURIComponent(target.id)}`;
        sendHtml(
          response,
          200,
          html(target, snapshot, nonce, contexts, active),
          `morrow_approval=${nonce}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=900`,
        );
        return;
      }
      if (method === "POST" && (target.action === "approve" || target.action === "cancel")) {
        if (!this.approvalAdmissionOpen) {
          sendJson(response, 409, { schema: "morrow.problem.v1", code: "approval_maintenance_held" });
          return;
        }
        this.approvalPosts += 1;
        try {
        const nonceKey = `${target.kind}:${target.id}`;
        const expected = this.nonces.get(nonceKey);
        const requestOrigin = String(request.headers.origin || "");
        const requestReferer = String(request.headers.referer || "");
        const baseUrl = this.baseUrl;
        const originValid = requestOrigin === baseUrl;
        const refererValid = requestReferer === `${baseUrl}/${target.kind}/${encodeURIComponent(target.id)}`;
        const formNonce = await readFormNonce(request);
        const cookieNonce = cookieValue(request, "morrow_approval");
        if (
          !expected
          || (target.action === "approve" && !expected.canApprove)
          || expected.expiresAt <= Date.now()
          || !originValid
          || !refererValid
          || !exactSecret(formNonce, expected.value)
          || !exactSecret(cookieNonce, expected.value)
        ) {
          this.nonces.delete(nonceKey);
          throw new Error("approval nonce is missing, expired, or invalid");
        }
        this.nonces.delete(nonceKey);
        if (this.stopping.signal.aborted || (target.action === "approve" && target.kind === "batches" && !this.controller.runApprovedBatch)) {
          throw new Error("review execution is unavailable");
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
        const cookie = `morrow_approval=; HttpOnly; SameSite=Strict; Path=/${target.kind}/${encodeURIComponent(target.id)}; Max-Age=0`;
        if (target.action === "approve" && !approved) {
          sendHtml(response, 409, statePage(resultState, snapshotPlatform(result)), cookie);
          return;
        }
        if (approved) {
          const work = Promise.resolve().then(() => target.kind === "batches"
            ? this.controller.runApprovedBatch!(target.id, this.stopping.signal)
            : this.controller.runApprovedOperation(target.id));
          this.work.set(nonceKey, work.catch(() => undefined).finally(() => this.work.delete(nonceKey)));
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
      const message = error instanceof Error ? error.message : "approval action failed";
      if (String(request.headers.accept || "").includes("text/html")) {
        sendHtml(response, 409, pageShell("Review unavailable", '<section class="outcome"><h1>Review unavailable</h1><p>This review may have expired or the request may have changed. Return to your assistant and ask Morrow to check its current status.</p><p>Do not repeat the change until Morrow checks the saved result.</p></section>'));
      } else sendJson(response, 409, { schema: "morrow.problem.v1", code: "approval_action_refused", message });
    }
  }

  async close(): Promise<void> {
    if (this.port === null) return;
    this.stopping.abort();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all(this.work.values());
    this.port = null;
    this.nonces.clear();
  }
}
