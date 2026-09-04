import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonObject } from "@morrow/contracts";
import { brandHead, brandHeader, serveBrandAsset } from "@morrow/bridge-loopback";

const LOOPBACK_HOST = "127.0.0.1";

export interface ApprovalOperationController {
  operationGet(operationId: string): JsonObject;
  operationList(limit?: number): JsonObject;
  approveOperation(operationId: string): JsonObject;
  cancelOperation(operationId: string): JsonObject;
  setApprovalBaseUrl(baseUrl: string): void;
  batchApprovalGet?(batchId: string): JsonObject;
  approveBatch?(batchId: string): JsonObject;
  cancelBatchApproval?(batchId: string): JsonObject;
}

interface ApprovalTarget {
  readonly kind: "operations" | "batches";
  readonly id: string;
  readonly action?: "approve" | "cancel";
}

function approvalPath(pathname: string): ApprovalTarget | null {
  const match = /^\/(operations|batches)\/([^/]+?)(?:\/(approve|cancel))?$/.exec(pathname);
  if (!match) return null;
  try {
    return {
      kind: match[1] as ApprovalTarget["kind"],
      id: decodeURIComponent(match[2]!),
      ...(match[3] ? { action: match[3] as "approve" | "cancel" } : {}),
    };
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, status: number, body: JsonObject): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, body: string, cookie: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "set-cookie": cookie,
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

function pageShell(title: string, eyebrow: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Morrow</title>${brandHead}</head><body><main class="wrap">${brandHeader}<article class="card" aria-label="${escapeHtml(eyebrow)}">${body}</article><p class="foot">Local review · 127.0.0.1 · No Canvas credential is shown</p></main></body></html>`;
}

function html(target: ApprovalTarget, snapshot: JsonObject, nonce: string): string {
  const summary = escapeHtml(JSON.stringify(snapshot, null, 2));
  const escapedId = escapeHtml(encodeURIComponent(target.id));
  const noun = target.kind === "batches" ? "batch" : "operation";
  const plan = snapshot.plan && typeof snapshot.plan === "object" && !Array.isArray(snapshot.plan)
    ? snapshot.plan as JsonObject
    : snapshot;
  const tool = typeof plan.tool === "string" ? plan.tool : target.kind === "batches" ? "Multi-course batch" : "Canvas operation";
  const risk = plan.risk && typeof plan.risk === "object" && !Array.isArray(plan.risk)
    ? String((plan.risk as JsonObject).approvalClass || "standard")
    : target.kind === "batches" ? "Per operation" : "standard";
  const request = plan.arguments && typeof plan.arguments === "object" && !Array.isArray(plan.arguments)
    ? plan.arguments as JsonObject : {};
  const changed = Object.entries(request).filter(([key]) => key !== "_morrow").map(([key, value]) =>
    `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</dd></div>`).join("");
  const expiry = String(snapshot.approvalExpiresAt || snapshot.expiresAt || "");
  const expiresAt = Number.isFinite(Date.parse(expiry))
    ? new Date(expiry).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "long" })
    : "15 minutes after page load";
  const targetCount = plan.targetSet && typeof plan.targetSet === "object" && !Array.isArray(plan.targetSet)
    ? String((plan.targetSet as JsonObject).count || 1)
    : String(snapshot.targetCount || 1);
  return pageShell(`Review ${noun}`, `Awaiting your decision`, `<header class="hero"><p class="eyebrow">Awaiting your decision</p><h1>Review this ${noun}</h1><p>Morrow froze this request before any Canvas write. Approval applies only to the exact plan below and can be used once.</p><div class="notice">Review and approve this request yourself. MCP tools cannot submit this decision.</div></header><div class="facts"><div class="fact"><span>Operation</span><strong title="${escapeHtml(tool)}">${escapeHtml(tool)}</strong></div><div class="fact"><span>Targets</span><strong>${escapeHtml(targetCount)}</strong></div><div class="fact"><span>Risk</span><strong>${escapeHtml(risk)}</strong></div></div>${changed ? `<section class="section"><h2>Requested values and targets</h2><dl class="request">${changed}</dl></section>` : ""}<section class="section"><h2>Frozen evidence</h2><p>This plan expires at ${escapeHtml(expiresAt)}. Expand the record to inspect its complete targets, arguments, authority, catalog digest, and readback method.</p><details><summary>Show complete frozen plan</summary><pre>${summary}</pre></details></section><div class="actions"><form method="post" action="/${target.kind}/${escapedId}/approve"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button class="approve" type="submit">Approve once</button></form><form method="post" action="/${target.kind}/${escapedId}/cancel"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button class="cancel" type="submit">Cancel request</button></form></div>`);
}

function outcomeHtml(target: ApprovalTarget, action: "approve" | "cancel"): string {
  const noun = target.kind === "batches" ? "batch" : "operation";
  const approved = action === "approve";
  return pageShell(
    approved ? "Approved" : "Cancelled",
    approved ? "Approval recorded" : "Request cancelled",
    `<section class="outcome"><p class="eyebrow">${approved ? "Approval recorded" : "Request cancelled"}</p><h1>${approved ? "Approved once" : "Nothing will be sent"}</h1><p>${approved ? `Morrow recorded approval for this exact ${noun}. Canvas has not changed yet. Return to your AI conversation so Morrow can recheck authority, dispatch once, and verify the result.` : `Morrow cancelled this ${noun}. It cannot dispatch this request.`}</p></section>`,
  );
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
  private readonly nonces = new Map<string, { value: string; expiresAt: number }>();
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
      if (method === "GET" && url.pathname === "/operations") {
        sendJson(response, 200, this.controller.operationList());
        return;
      }
      const target = approvalPath(url.pathname);
      if (!target) {
        sendJson(response, 404, { schema: "morrow.problem.v1", code: "not_found" });
        return;
      }
      if (method === "GET" && !target.action) {
        const snapshot = target.kind === "batches"
          ? this.controller.batchApprovalGet?.(target.id)
          : this.controller.operationGet(target.id);
        if (!snapshot) throw new Error("batch approval is unavailable");
        const nonce = randomBytes(32).toString("base64url");
        const nonceKey = `${target.kind}:${target.id}`;
        this.nonces.set(nonceKey, { value: nonce, expiresAt: Date.now() + 15 * 60_000 });
        const cookiePath = `/${target.kind}/${encodeURIComponent(target.id)}`;
        sendHtml(
          response,
          200,
          html(target, snapshot, nonce),
          `morrow_approval=${nonce}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=900`,
        );
        return;
      }
      if (method === "POST" && target.action) {
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
        const result = target.kind === "batches"
          ? target.action === "approve"
            ? this.controller.approveBatch?.(target.id)
            : this.controller.cancelBatchApproval?.(target.id)
          : target.action === "approve"
            ? this.controller.approveOperation(target.id)
            : this.controller.cancelOperation(target.id);
        if (!result) throw new Error("batch approval action is unavailable");
        sendHtml(
          response,
          200,
          outcomeHtml(target, target.action),
          `morrow_approval=; HttpOnly; SameSite=Strict; Path=/${target.kind}/${encodeURIComponent(target.id)}; Max-Age=0`,
        );
        return;
      }
      sendJson(response, 405, { schema: "morrow.problem.v1", code: "method_not_allowed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "approval action failed";
      sendJson(response, 409, { schema: "morrow.problem.v1", code: "approval_action_refused", message });
    }
  }

  async close(): Promise<void> {
    if (this.port === null) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
    this.port = null;
    this.nonces.clear();
  }
}
