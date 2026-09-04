import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonObject } from "@morrow/contracts";

const LOOPBACK_HOST = "127.0.0.1";

export interface ApprovalOperationController {
  operationGet(operationId: string): JsonObject;
  operationList(limit?: number): JsonObject;
  approveOperation(operationId: string): JsonObject;
  cancelOperation(operationId: string): JsonObject;
  setApprovalBaseUrl(baseUrl: string): void;
}

function operationPath(pathname: string): { operationId: string; action?: "approve" | "cancel" } | null {
  const match = /^\/operations\/([^/]+?)(?:\/(approve|cancel))?$/.exec(pathname);
  if (!match) return null;
  try {
    return { operationId: decodeURIComponent(match[1]!), ...(match[2] ? { action: match[2] as "approve" | "cancel" } : {}) };
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
    "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "set-cookie": cookie,
  });
  response.end(body);
}

function html(operationId: string, operation: JsonObject, nonce: string): string {
  const summary = JSON.stringify(operation, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const escapedId = operationId.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  return `<!doctype html><meta charset="utf-8"><title>Morrow approval</title><h1>Morrow approval</h1><p>Review the frozen operation. Approval can be used once.</p><pre>${summary}</pre><form method="post" action="/operations/${escapedId}/approve"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">Approve once</button></form><form method="post" action="/operations/${escapedId}/cancel"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">Cancel</button></form>`;
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
      if (method === "GET" && url.pathname === "/operations") {
        sendJson(response, 200, this.controller.operationList());
        return;
      }
      const target = operationPath(url.pathname);
      if (!target) {
        sendJson(response, 404, { schema: "morrow.problem.v1", code: "not_found" });
        return;
      }
      if (method === "GET" && !target.action) {
        const operation = this.controller.operationGet(target.operationId);
        const nonce = randomBytes(32).toString("base64url");
        this.nonces.set(target.operationId, { value: nonce, expiresAt: Date.now() + 15 * 60_000 });
        const cookiePath = `/operations/${encodeURIComponent(target.operationId)}`;
        sendHtml(
          response,
          200,
          html(target.operationId, operation, nonce),
          `morrow_approval=${nonce}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=900`,
        );
        return;
      }
      if (method === "POST" && target.action) {
        const expected = this.nonces.get(target.operationId);
        const requestOrigin = String(request.headers.origin || "");
        const requestReferer = String(request.headers.referer || "");
        const baseUrl = this.baseUrl;
        const originValid = !requestOrigin || requestOrigin === baseUrl;
        const refererValid = !requestReferer || requestReferer === `${baseUrl}/operations/${encodeURIComponent(target.operationId)}`;
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
          this.nonces.delete(target.operationId);
          throw new Error("approval nonce is missing, expired, or invalid");
        }
        this.nonces.delete(target.operationId);
        const result = target.action === "approve"
          ? this.controller.approveOperation(target.operationId)
          : this.controller.cancelOperation(target.operationId);
        sendJson(response, 200, result);
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
