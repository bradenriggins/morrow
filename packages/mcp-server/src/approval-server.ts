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

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function html(operationId: string, operation: JsonObject): string {
  const summary = JSON.stringify(operation, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const escapedId = operationId.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  return `<!doctype html><meta charset="utf-8"><title>Morrow approval</title><h1>Morrow approval</h1><p>Review the frozen operation. Approval can be used once.</p><pre>${summary}</pre><form method="post" action="/operations/${escapedId}/approve"><button type="submit">Approve once</button></form><form method="post" action="/operations/${escapedId}/cancel"><button type="submit">Cancel</button></form>`;
}

export class LoopbackApprovalServer {
  private readonly server: Server;
  private port: number | null = null;

  constructor(private readonly controller: ApprovalOperationController) {
    this.server = createServer((request, response) => this.handle(request, response));
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

  private handle(request: IncomingMessage, response: ServerResponse): void {
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
        sendHtml(response, 200, html(target.operationId, operation));
        return;
      }
      if (method === "POST" && target.action === "approve") {
        sendJson(response, 200, this.controller.approveOperation(target.operationId));
        return;
      }
      if (method === "POST" && target.action === "cancel") {
        sendJson(response, 200, this.controller.cancelOperation(target.operationId));
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
  }
}
