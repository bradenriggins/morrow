import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { brandHead, brandHeader, serveBrandAsset } from "@morrow/bridge-loopback";
import type { ApprovalReviewContext, ApprovalReviewReadCache } from "./approval-context.js";

const LOOPBACK_HOST = "127.0.0.1";
const PREVIEW_STYLE = "body{margin:8px;font:14px/1.6 system-ui;overflow-wrap:anywhere}p:first-child{margin-top:0}";
const PREVIEW_STYLE_HASH = createHash("sha256").update(PREVIEW_STYLE).digest("base64");

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
    "content-security-policy": `default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'sha256-${PREVIEW_STYLE_HASH}'; img-src 'self'; font-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    ...(cookie ? { "set-cookie": cookie } : {}),
  });
  response.end(body);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pageShell(title: string, eyebrow: string, body: string, polling = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Morrow</title>${brandHead}${polling ? '<script src="/review-status.js" defer></script>' : ""}</head><body><main class="wrap">${brandHeader}<article class="card" aria-label="${escapeHtml(eyebrow)}">${body}</article><p class="foot">This page opens only on your computer.</p></main></body></html>`;
}

const STATUS_SCRIPT = `const status = document.getElementById("work-status");
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
if (status) void refreshStatus();`;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function readableName(value: string): string {
  const names: Record<string, string> = {
    moodle_update_course_summary: "Update the Moodle course description",
    blackboard_update_content: "Update the Blackboard lesson",
    summary: "Course description",
    body: "Lesson content",
    canvas_create_quiz_item: "Add a quiz question",
    canvas_update_quiz_item: "Update a quiz question",
    canvas_delete_quiz_item: "Delete a quiz question",
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
    const richText = ["item_entry_item_body", "question_question_text", "wiki_page_body", "assignment_description", "summary", "body"].includes(key) && typeof value === "string";
    const preview = richText ? formattedTextPreview(readableName(key), value as string) : requestValue(value);
    return `<div${richText ? ' class="rich-text"' : ""}><dt>${escapeHtml(readableName(key))}</dt><dd>${preview}</dd></div>`;
  }).join("");
}

function formattedTextPreview(label: string, value: string): string {
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-${PREVIEW_STYLE_HASH}'; form-action 'none'; base-uri 'none'"><meta name="color-scheme" content="light dark"><style>${PREVIEW_STYLE}</style></head><body>${value}</body></html>`;
  const mediaNotice = /<(?:img|video|audio|iframe|embed|object)\b/i.test(value)
    ? '<span class="preview-note">Images and videos are not loaded in this preview.</span>' : "";
  return `<iframe class="text-preview" title="${escapeHtml(label)} preview" sandbox referrerpolicy="no-referrer" srcdoc="${escapeHtml(document)}"></iframe>${mediaNotice}`;
}

function requestValue(value: unknown): string {
  if (Array.isArray(value)) return value.length
    ? `<ol class="values">${value.map((entry) => `<li>${requestValue(entry)}</li>`).join("")}</ol>` : "None";
  if (value !== null && typeof value === "object") return `<dl class="request">${requestFields(object(value)) || "Not set"}</dl>`;
  return escapeHtml(value === true ? "Yes" : value === false ? "No" : value === null ? "Not set" : value === "" ? "Empty" : value);
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
    const targets = contexts.get(String(operation.operationId))?.targets || [];
    return targets.some((item) => !item.name.trim()) || ["course_id", "assignment_id", "quiz_id", "content_id", "connection_id"].some((field) =>
      field in request && !targets.some((item) => item.field === field && item.name.trim()));
  });
}

function keepOpenInstruction(platform: string): string {
  return platform === "Canvas" ? "Keep your AI app and Chrome open while Morrow works." : "Keep your AI app open while Morrow works.";
}

function stateContent(state: string, platform = "Canvas"): string {
  const content: Record<string, [string, string]> = {
    approved: ["Changes have not started", "Your approval was saved, but this request is not running. Ask Morrow in your chat to check this saved request before starting anything else."],
    verified: ["Changes confirmed", "Morrow checked Canvas and confirmed the requested result."],
    cancelled: ["Request cancelled", "Morrow will not start more changes for this request. Changes already sent may still finish. Return to your AI conversation to check the result."],
    expired: ["This review has expired", "Return to your AI conversation and ask Morrow for a new review. Check the new request before approving it."],
    dispatching: ["Applying your changes", `Morrow will check the saved result in Canvas. This page updates automatically. ${keepOpenInstruction(platform)}`],
    running: ["Applying your changes", `Morrow will check the saved result in Canvas. This page updates automatically. ${keepOpenInstruction(platform)}`],
    awaiting_verification: ["The result needs checking", "Morrow could not confirm the saved result in Canvas. Ask Morrow in your chat to check this saved request. Do not repeat the change."],
    awaiting_inner_approval: ["Another review is needed", "This request needs another approval before it can finish. Return to your AI conversation for the next review step."],
    applied_or_unknown: ["The result is not yet confirmed", "Canvas may have received the changes. Return to your AI conversation and ask Morrow to check the result before trying again."],
    inspection_required: ["Some results need checking", "Canvas may have received some changes. Return to your AI conversation and ask Morrow to check each result. Do not repeat the group of changes."],
    partial: ["Some requests did not finish", "Return to your AI conversation to see which changes finished and which still need attention. Do not repeat the whole group."],
    paused: ["Work is paused", "Morrow is not starting more changes. Work already sent may still finish. Return to your AI conversation to check the result or continue."],
    completed: ["Some results need checking", "The work has stopped, but not every requested change has a confirmed result. Ask Morrow in your chat to check the saved results. Do not repeat the group."],
    failed: ["This request did not finish", "Return to your AI conversation to find out what happened. Check the result before starting a new request."],
    interrupted: ["Work stopped before confirmation", "Morrow is not running this request now. Ask Morrow in your chat to check the saved result before trying again."],
  };
  const [title, detail] = content[state] || ["Check this request", "The request has changed or can no longer be approved here. Return to your AI conversation and ask Morrow to check its current status."];
  return `<section class="outcome"><p class="eyebrow">Request status</p><h1>${title}</h1><p>${detail.replaceAll("Canvas", platform)}</p></section>`;
}

function statePage(state: string): string {
  return pageShell("Request status", "Request status", stateContent(state));
}

export function operationStatus(state: string, platform = "Canvas"): string {
  const names: Record<string, string> = {
    awaiting_approval: "Not started", approved: "Not started", dispatching: "In progress",
    awaiting_verification: "Needs checking", applied_or_unknown: "Needs checking",
    awaiting_inner_approval: "Another review is needed", verified: "Confirmed in Canvas",
    cancelled: "Cancelled", failed: "Did not finish",
  };
  return (names[state] || "Needs checking").replaceAll("Canvas", platform);
}

function platformName(tool: unknown): string {
  return String(tool).startsWith("moodle_") ? "Moodle" : String(tool).startsWith("blackboard_") ? "Blackboard" : "Canvas";
}

function statusContent(target: ApprovalTarget, snapshot: JsonObject, active: boolean): string {
  let state = reviewState(target, snapshot);
  if (active && state === "approved") state = "running";
  if (!active && ["running", "dispatching"].includes(state)) state = "interrupted";
  const children = Array.isArray(snapshot.children) ? snapshot.children : [];
  const confirmed = Number(snapshot.confirmedChildren || children.filter((child) => object(object(child).operation).state === "verified").length);
  const total = Number(snapshot.totalChildren || children.length);
  const platform = platformName(object(snapshot.plan).tool);
  return stateContent(state, platform) + (total ? `<section class="section"><p>${confirmed} of ${total} changes confirmed in ${platform}.</p></section>` : "");
}

function html(target: ApprovalTarget, snapshot: JsonObject, nonce: string, contexts: ReadonlyMap<string, ApprovalReviewContext>, active: boolean): string {
  const summary = escapeHtml(JSON.stringify(snapshot, null, 2));
  const escapedId = escapeHtml(encodeURIComponent(target.id));
  const batch = target.kind === "batches";
  const plan = object(snapshot.plan);
  const platform = platformName(plan.tool);
  const expiry = String(snapshot.approvalExpiresAt || snapshot.expiresAt || "");
  const expired = Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) <= Date.now();
  const state = reviewState(target, snapshot);
  if (state === "awaiting_approval" && expired) return statePage("expired");
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
  const changed = plans.map((entry, index) => {
    const context = contexts.get(String(operations[index]?.operationId));
    const targets = (context?.targets || []).filter((item) => item.name.trim());
    const destination = targets.map((item) => {
      const name = escapeHtml(item.name);
      const linkedName = item.url?.startsWith("https://")
        ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${name}<span class="sr-only"> (opens in ${platformName(entry.tool)})</span></a>` : name;
      return `<div><dt>${escapeHtml(item.label)}</dt><dd>${linkedName}</dd></div>`;
    }).join("");
    const request = object(entry.arguments);
    const pageGuard = entry.tool === "canvas_update_create_page_courses" ? object(object(request._morrow).page_guard) : {};
    const name = typeof entry.tool === "string" ? readableName(entry.tool) : "Requested changes";
    const hiddenFields = ["expected_digest", "expected_connection", ...(missingNames ? ["course_id", "assignment_id", "quiz_id", "content_id", "connection_id"] : []), ...targets.map((item) => item.field)];
    const changes = typeof pageGuard.find_text === "string" && typeof pageGuard.replace_text === "string"
      ? `<div><dt>Current text</dt><dd>${escapeHtml(pageGuard.find_text)}</dd></div><div><dt>Replacement</dt><dd>${pageGuard.replace_text === "" ? "Remove this text" : escapeHtml(pageGuard.replace_text)}</dd></div>`
      : requestFields(request, hiddenFields);
    const preservation = pageGuard.find_text ? '<p>Only this phrase will change. The other page content and settings stay the same.</p><p>Morrow checks for newer edits before sending. Avoid editing this page until the result is checked.</p>' : "";
    const resultLabel = batch && state !== "awaiting_approval" ? `<p data-operation-status>${operationStatus(String(operations[index]?.state), platformName(entry.tool))}</p>` : "";
    return `<section class="section">${batch ? `<h2>${index + 1}. ${escapeHtml(name)}</h2>` : ""}${resultLabel}${destination ? `<dl class="destination">${destination}</dl>` : ""}<dl class="request">${changes}</dl>${preservation}</section>`;
  }).join("");
  if (state !== "awaiting_approval") {
    const stop = batch && active ? `<div class="actions" id="stop-work"><form method="post" action="/${target.kind}/${escapedId}/cancel"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button class="cancel" type="submit">Stop remaining changes</button></form></div>` : "";
    return pageShell("Your result", "Your result", `<div id="work-status" role="status" aria-live="polite" aria-atomic="true">${statusContent(target, snapshot, active)}</div>${changed}${stop}<section class="section"><details><summary>Technical details</summary><pre>${summary}</pre></details></section>`, active);
  }
  const addingQuestion = !batch && plan.tool === "canvas_create_quiz_item";
  const changingPageText = !batch && plan.tool === "canvas_update_create_page_courses" && isJsonObject(object(object(plan.arguments)._morrow).page_guard);
  const title = batch ? `Check these ${plans.length} changes` : addingQuestion ? "Add this quiz question?" : changingPageText ? "Change this page text?" : `${readableName(String(plan.tool || "Review this change"))}?`;
  const approveLabel = batch ? "Apply these changes" : addingQuestion ? "Add this question" : changingPageText ? "Change this text" : "Apply this change";
  const next = (limited
    ? '<p class="warning">Too many different courses or activities to review at once.</p><p>Ask Morrow in your chat to split this into smaller groups. This page has not approved any changes.</p>'
    : missingNames
    ? '<p class="warning">Morrow could not identify the course or activity in Canvas.</p><p>Nothing can be approved here until those details load. Check your Canvas connection, then reload this page.</p>'
    : `<p>One click starts the work. Morrow applies these changes, checks them in Canvas, and shows the result here.</p><p>${keepOpenInstruction(platform)}</p>`).replaceAll("Canvas", platform);
  const approveForm = missingNames ? "" : `<form method="post" action="/${target.kind}/${escapedId}/approve"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button class="approve" type="submit">${approveLabel}</button></form>`;
  return pageShell(title, "Before Morrow makes changes", `<header class="hero"><p class="eyebrow">Before Morrow makes changes</p><h1>${escapeHtml(title)}</h1><p>${addingQuestion ? "Check the course, quiz, and question below." : "Check that this matches what you asked for."}</p>${risks.map((risk) => `<p class="warning">${escapeHtml(risk)}</p>`).join("")}</header>${changed}<section class="section next-step">${next}<details><summary>Technical details</summary><p class="details-help">Approval is for this request only and expires at ${escapeHtml(expiresAt)}. Changes are not undone automatically.</p><pre>${summary}</pre></details></section><div class="actions">${approveForm}<form method="post" action="/${target.kind}/${escapedId}/cancel"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button class="cancel" type="submit">Cancel</button></form></div>`);
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

  constructor(private readonly controller: ApprovalOperationController) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  get baseUrl(): string | null {
    return this.port === null ? null : `http://${LOOPBACK_HOST}:${this.port}`;
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
        sendJson(response, 200, this.controller.operationList());
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
          sendHtml(response, 409, statePage(resultState), cookie);
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
      }
      sendJson(response, 405, { schema: "morrow.problem.v1", code: "method_not_allowed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "approval action failed";
      if (String(request.headers.accept || "").includes("text/html")) {
        sendHtml(response, 409, pageShell("Review could not be completed", "Check this request", '<section class="outcome"><p class="eyebrow">Check this request</p><h1>Review could not be completed</h1><p>This review may have expired or the request may have changed. Return to your AI conversation and ask Morrow to check its current status.</p><p>Do not repeat the change until Morrow checks the result in Canvas.</p></section>'));
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
