import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  BRIDGE_PATH,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMAS,
  MAX_BRIDGE_MESSAGE_BYTES,
  MIN_BRIDGE_TOKEN_LENGTH,
  createBridgeProblem,
  matchesBridgeEditPermission,
  normalizeBridgeEditPolicySet,
  normalizeBridgeEditOptionsResult,
  normalizeBridgeBindings,
  normalizeBridgeMaintenanceControl,
  normalizeBridgePrivateAttachment,
  normalizeBridgePrivateAttachments,
  normalizeBridgePrivateConversation,
  parseBridgeClientMessage,
  parseBridgeHello,
  parseBridgeJson,
  serializeBridgeMessage,
  type BridgeBinding,
  type BridgeProvider,
  type BridgeClientMessage,
  type BridgeCommand,
  type BridgeCommandKind,
  type BridgeEditPolicySet,
  type BridgeMaintenanceControl,
  type BridgeOuterGrant,
  type BridgePrivateAttachment,
  type BridgePrivateConversation,
  type BridgeHello,
  type BridgePing,
  type BridgeReady,
  type BridgeResult,
} from "@morrow/bridge-protocol";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { brandHead, brandHeader, serveBrandAsset } from "./brand.js";
export { brandHead, brandHeader, serveBrandAsset } from "./brand.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
/**
 * How many sent effect receipts one bridge process remembers. The record never
 * drops a receipt, so this is also the point at which the bridge refuses a new
 * change instead of forgetting an earlier one. It is far above a working day of
 * course changes, and it holds the record to a few megabytes.
 */
const DEFAULT_WRITE_RECEIPT_CAPACITY = 20_000;
const PRIVATE_MOODLE_RESOURCE_FILE_TOOL = "moodle_create_resource_file";
const PRIVATE_MOODLE_RESOURCE_FILE_OPERATION = "moodle.form.course.modedit.resource.file.create.write.v1";
const PRIVATE_MOODLE_FOLDER_FILE_TOOL = "moodle_create_folder_file";
const PRIVATE_MOODLE_FOLDER_FILE_OPERATION = "moodle.form.course.modedit.folder.file.create.write.v1";
const PRIVATE_MOODLE_IMSCP_PACKAGE_TOOL = "moodle_create_imscp_package";
const PRIVATE_MOODLE_IMSCP_PACKAGE_OPERATION = "moodle.form.course.modedit.imscp.package.create.write.v1";
const PRIVATE_MOODLE_SCORM_PACKAGE_TOOL = "moodle_create_scorm_package";
const PRIVATE_MOODLE_SCORM_PACKAGE_OPERATION = "moodle.form.course.modedit.scorm.package.create.write.v1";
const PRIVATE_MOODLE_H5P_ACTIVITY_TOOL = "moodle_create_h5pactivity";
const PRIVATE_MOODLE_H5P_ACTIVITY_OPERATION = "moodle.form.course.modedit.h5pactivity.create.write.v1";
const PRIVATE_MOODLE_H5P_REPLACE_TOOL = "moodle_replace_h5pactivity_package";
const PRIVATE_MOODLE_H5P_REPLACE_OPERATION = "moodle.form.course.modedit.h5pactivity.package.replace.write.v1";
const PRIVATE_MOODLE_RESOURCE_REPLACE_TOOL = "moodle_replace_resource_file";
const PRIVATE_MOODLE_RESOURCE_REPLACE_OPERATION = "moodle.form.course.modedit.resource.file.replace.write.v1";
const PRIVATE_MOODLE_SCORM_REPLACE_TOOL = "moodle_replace_scorm_package";
const PRIVATE_MOODLE_SCORM_REPLACE_OPERATION = "moodle.form.course.modedit.scorm.package.replace.write.v1";
const PRIVATE_MOODLE_FOLDER_ADD_TOOL = "moodle_add_folder_files";
const PRIVATE_MOODLE_FOLDER_ADD_OPERATION = "moodle.form.course.modedit.folder.files.add.write.v1";
const PRIVATE_CANVAS_COURSE_FILE_TOOL = "canvas_transfer_course_file";
const PRIVATE_CANVAS_COURSE_FILE_OPERATION = "canvas.private.course_file.transfer.v1";
const PRIVATE_CANVAS_CONVERSATION_TOOL = "canvas_send_private_conversation";
const PRIVATE_CANVAS_CONVERSATION_OPERATION = "canvas.private.conversation.send.v1";

function providerForToolName(toolName: string | undefined): BridgeProvider | undefined {
  if (!toolName) return undefined;
  if (toolName.startsWith("canvas_")) return "canvas";
  if (toolName.startsWith("moodle_")) return "moodle";
  if (toolName.startsWith("blackboard_")) return "blackboard";
  return undefined;
}
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;

export interface LoopbackBridgeOptions {
  readonly token: string;
  readonly expectedRuntimeRevision: string;
  readonly expectedCatalogDigest: string;
  readonly allowedExtensionIds?: readonly string[];
  readonly port?: number;
  readonly authTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly allowMissingOriginForTests?: boolean;
  /** How many sent effect receipts this bridge remembers. Default 20000. */
  readonly writeReceiptCapacity?: number;
  readonly pairingEnabled?: boolean;
  readonly onPairApproved?: (extensionId: string) => void | Promise<void>;
}

export interface BridgeInvocation {
  readonly kind: BridgeCommandKind;
  readonly toolName?: string;
  readonly operationKey?: string;
  readonly arguments?: JsonObject;
  readonly privateAttachment?: BridgePrivateAttachment;
  readonly privateAttachments?: readonly BridgePrivateAttachment[];
  readonly privateConversation?: BridgePrivateConversation;
  readonly sourceBindingId?: string;
  readonly taskId?: string;
  readonly editPolicySet?: BridgeEditPolicySet;
  readonly maintenance?: BridgeMaintenanceControl;
  readonly operationId?: string;
  readonly outerGrant?: BridgeOuterGrant;
  readonly timeoutMs?: number;
}

/**
 * A named reason the bridge has no listening port. Only one Morrow can hold the
 * Bridge port on a computer, so a second Morrow reports this instead of failing
 * to start.
 */
export interface LoopbackBridgeProblem {
  readonly code: "bridge_port_in_use";
  readonly port: number;
  readonly message: string;
}

export interface LoopbackBridgeHealth {
  readonly schema: "morrow.bridge.health.v1";
  readonly listening: boolean;
  readonly problem?: LoopbackBridgeProblem;
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number | null;
  readonly path: typeof BRIDGE_PATH;
  readonly connected: boolean;
  readonly generation: number;
  readonly extensionId: string | null;
  readonly runtimeRevision: string | null;
  readonly catalogDigest: string;
  readonly bindingCount: number;
  readonly pendingCount: number;
  readonly connectedAt: number | null;
  readonly lastSeenAt: number | null;
}

interface PendingRequest {
  readonly command: BridgeCommand;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (result: BridgeResult) => void;
  readonly reject: (error: Error) => void;
}

interface ActiveClient {
  readonly socket: WebSocket;
  readonly extensionId: string;
  readonly runtimeRevision: string;
  readonly catalogDigest: string;
  readonly generation: number;
  readonly connectedAt: number;
  bindings: readonly BridgeBinding[];
  lastSeenAt: number;
}

interface PairingRequest {
  readonly pairingId: string;
  readonly extensionId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: "pending" | "approved" | "denied";
}

export class BridgeUnavailableError extends Error {
  readonly code: string = "bridge_unavailable";
  constructor(message = "Morrow Bridge is not connected.", options?: ErrorOptions) {
    super(message, options);
    this.name = "BridgeUnavailableError";
  }
}

export function bridgePortInUseMessage(port: number): string {
  return `Another Morrow is already connected to Morrow Bridge on port ${port}. Close the other Morrow, or use one Morrow for all your assistants.`;
}

/**
 * The Bridge port is already held, so this Morrow has no Chrome connection. It
 * is a `BridgeUnavailableError` because nothing was sent to the extension.
 */
export class BridgePortInUseError extends BridgeUnavailableError {
  override readonly code = "bridge_port_in_use";
  readonly port: number;

  constructor(port: number, options?: ErrorOptions) {
    super(bridgePortInUseMessage(port), options);
    this.name = "BridgePortInUseError";
    this.port = port;
  }
}

export function bridgeWriteRecordFullMessage(capacity: number): string {
  return `Morrow has recorded the ${capacity} changes it sent since it started, and it cannot record another without forgetting one. It did not send this change. Restart Morrow, then ask for a fresh plan.`;
}

/**
 * Morrow keeps every gateway effect receipt it has sent so it can refuse a
 * second send of the same change. That record holds a fixed number of receipts.
 * When it is full Morrow refuses the new change rather than forget an earlier
 * receipt, because a forgotten receipt would be accepted a second time. Nothing
 * was sent. The gateway's own durable dispatch record stays the authority
 * across a restart, so a restarted Morrow still refuses a receipt it used.
 */
export class BridgeWriteRecordFullError extends BridgeUnavailableError {
  override readonly code = "bridge_write_record_full";
  readonly capacity: number;

  constructor(capacity: number) {
    super(bridgeWriteRecordFullMessage(capacity));
    this.name = "BridgeWriteRecordFullError";
    this.capacity = capacity;
  }
}

export class BridgeOutcomeUnknownError extends Error {
  readonly code = "bridge_outcome_unknown";
  readonly requestId: string;
  readonly operationId: string;
  readonly commandKind: BridgeCommandKind;
  readonly sent: boolean;

  constructor(command: BridgeCommand, message: string, sent = true) {
    super(message);
    this.name = "BridgeOutcomeUnknownError";
    this.requestId = command.requestId;
    this.operationId = command.operationId;
    this.commandKind = command.kind;
    this.sent = sent;
  }
}

function exactPort(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError("bridge port must be a whole number from 0 through 65535");
  }
  return value;
}

function exactCapacity(value: number | undefined): number {
  const resolved = value === undefined ? DEFAULT_WRITE_RECEIPT_CAPACITY : value;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 1_000_000) {
    throw new TypeError("writeReceiptCapacity must be a whole number from 1 through 1000000");
  }
  return resolved;
}

function exactTimeout(value: number | undefined, fallback: number, label: string): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < 100 || resolved > 10 * 60_000) {
    throw new TypeError(`${label} must be a whole number from 100 through 600000`);
  }
  return resolved;
}

function tokenBytes(token: string): Buffer {
  const normalized = String(token || "").trim();
  if (normalized.length < MIN_BRIDGE_TOKEN_LENGTH || normalized.length > 512) {
    throw new TypeError("bridge token must contain 32 to 512 characters");
  }
  return Buffer.from(normalized, "utf8");
}

function constantTimeTokenEquals(expected: Buffer, actual: string): boolean {
  const candidate = Buffer.from(String(actual || "").trim(), "utf8");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

function originExtensionId(origin: string | undefined): string | null {
  if (!origin) return null;
  return EXTENSION_ORIGIN.exec(origin.trim())?.[1] || null;
}

function rawText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function send(socket: WebSocket, message: BridgeReady | BridgeCommand | BridgePing): void {
  if (socket.readyState !== WebSocket.OPEN) throw new BridgeUnavailableError();
  socket.send(serializeBridgeMessage(message));
}

export class LoopbackBridgeServer {
  private readonly expectedToken: Buffer;
  private readonly expectedRuntimeRevision: string;
  private readonly expectedCatalogDigest: string;
  private readonly allowedExtensionIds: Set<string>;
  private readonly requestedPort: number;
  private readonly authTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly allowMissingOriginForTests: boolean;
  private readonly pairingEnabled: boolean;
  private readonly onPairApproved: ((extensionId: string) => void | Promise<void>) | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pairingRequests = new Map<string, PairingRequest>();
  /**
   * Every effect receipt this process has sent, held to `writeReceiptCapacity`
   * entries. Nothing is ever removed: a forgotten receipt would be accepted a
   * second time, so a full record refuses the new change instead.
   */
  private readonly usedOuterEffectReceipts = new Set<string>();
  private readonly writeReceiptCapacity: number;
  private readonly httpServer: HttpServer;
  private readonly webSocketServer: WebSocketServer;
  private active: ActiveClient | null = null;
  private generation = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private listeningPort: number | null = null;
  private started = false;
  private portInUse = false;

  constructor(options: LoopbackBridgeOptions) {
    this.expectedToken = tokenBytes(options.token);
    this.expectedRuntimeRevision = String(options.expectedRuntimeRevision || "").trim();
    this.expectedCatalogDigest = String(options.expectedCatalogDigest || "").trim();
    if (!this.expectedRuntimeRevision) throw new TypeError("expectedRuntimeRevision is required");
    if (!/^[0-9a-f]{64}$/.test(this.expectedCatalogDigest)) {
      throw new TypeError("expectedCatalogDigest must be a SHA-256 digest");
    }
    const ids = (options.allowedExtensionIds || []).map((value) => String(value).trim());
    if (ids.some((value) => !/^[a-p]{32}$/.test(value))) {
      throw new TypeError("allowed extension ids must use Chrome's 32-character id format");
    }
    this.allowedExtensionIds = new Set(ids);
    this.requestedPort = exactPort(options.port);
    this.authTimeoutMs = exactTimeout(options.authTimeoutMs, DEFAULT_AUTH_TIMEOUT_MS, "authTimeoutMs");
    this.callTimeoutMs = exactTimeout(options.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS, "callTimeoutMs");
    this.heartbeatMs = exactTimeout(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, "heartbeatMs");
    this.writeReceiptCapacity = exactCapacity(options.writeReceiptCapacity);
    this.allowMissingOriginForTests = options.allowMissingOriginForTests === true;
    this.pairingEnabled = options.pairingEnabled === true;
    this.onPairApproved = options.onPairApproved;

    this.httpServer = createServer((request, response) => void this.handleHttp(request, response));
    this.webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_MESSAGE_BYTES });
    this.httpServer.on("upgrade", (request, socket, head) => {
      const host = request.headers.host || `${LOOPBACK_HOST}:${this.requestedPort}`;
      let url: URL;
      try {
        url = new URL(request.url || "/", `http://${host}`);
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== BRIDGE_PATH || url.search || url.hash) {
        socket.destroy();
        return;
      }
      const extensionId = originExtensionId(request.headers.origin);
      if (!extensionId && !this.allowMissingOriginForTests) {
        socket.destroy();
        return;
      }
      if (extensionId && this.allowedExtensionIds.size > 0 && !this.allowedExtensionIds.has(extensionId)) {
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    });
    this.webSocketServer.on("connection", (socket, request) => {
      this.acceptUnauthenticated(socket, originExtensionId(request.headers.origin));
    });
  }

  private responseHeaders(contentType: string, origin?: string): Record<string, string> {
    return {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    };
  }

  private json(response: ServerResponse, status: number, value: unknown, origin?: string): void {
    response.writeHead(status, this.responseHeaders("application/json; charset=utf-8", origin));
    response.end(JSON.stringify(value));
  }

  private prunePairings(now = Date.now()): void {
    for (const [pairingId, request] of this.pairingRequests) {
      if (request.expiresAt <= now) this.pairingRequests.delete(pairingId);
    }
  }

  private async requestBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > 16_384) throw new RangeError("request body is too large");
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  private pairingOrigin(request: IncomingMessage): { origin: string; extensionId: string } | null {
    const origin = String(request.headers.origin || "").trim();
    const extensionId = originExtensionId(origin);
    return extensionId ? { origin, extensionId } : null;
  }

  private pairingUrl(path: string): string {
    if (this.listeningPort === null) throw new Error("bridge is not listening");
    return `http://${LOOPBACK_HOST}:${this.listeningPort}${path}`;
  }

  private pairingPage(request: PairingRequest): string {
    const extension = request.extensionId.replace(/[<>&"']/g, "");
    const pending = request.status === "pending";
    const title = pending ? "Connect Morrow to Chrome" : request.status === "approved" ? "Chrome connection approved" : "Connection cancelled";
    const content = pending
      ? `<p>Allow Morrow in your assistant to work with Canvas and Moodle through this Chrome extension.</p><p>Your learning-platform password and sign-in details stay in Chrome. You choose which Canvas or Moodle address to connect next.</p><div class="notice">Only continue if you started this from Morrow Bridge. Connecting does not approve changes to your courses.</div><details><summary>About this connection</summary><p class="details-help">This connection stays on your computer. You can disconnect in Morrow Bridge at any time.</p><p class="details-help">Extension ID: ${extension}</p></details><form class="actions" method="post" action="${BRIDGE_PATH}/pair/${request.pairingId}/decision"><button name="decision" value="approve">Allow connection</button><button class="secondary" name="decision" value="deny">Cancel connection</button></form>`
      : `<p>${request.status === "approved" ? "Open a signed-in Canvas or Moodle course in Chrome. Morrow Bridge identifies the platform and shows Connect Canvas or Connect Moodle." : "Morrow did not connect through this request. You can start again from Morrow Bridge when you are ready."}</p>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Morrow</title>${brandHead}</head><body><main class="wrap pairing">${brandHeader}<article class="card"><section class="outcome"><h1>${title}</h1>${content}</section></article><p class="foot">This page opens only on your computer.</p></main></body></html>`;
  }

  private pairingUnavailable(response: ServerResponse, status: number): void {
    response.writeHead(status, this.responseHeaders("text/html; charset=utf-8"));
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Start a new connection · Morrow</title>${brandHead}</head><body><main class="wrap pairing">${brandHeader}<article class="card"><section class="outcome"><h1>Start a new connection</h1><p>This connection request has expired or is no longer available. Open Morrow Bridge and select Connect Morrow to try again.</p></section></article><p class="foot">This page opens only on your computer.</p></main></body></html>`);
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = String(request.headers.host || "");
    if (!/^127\.0\.0\.1:\d+$/.test(host) || !this.pairingEnabled) {
      this.json(response, 404, { error: "not_found" });
      return;
    }
    const url = new URL(request.url || "/", `http://${host}`);
    if (request.method === "GET" && serveBrandAsset(url.pathname, response)) return;
    this.prunePairings();
    if (request.method === "OPTIONS" && url.pathname.startsWith(`${BRIDGE_PATH}/pair`)) {
      const identity = this.pairingOrigin(request);
      if (!identity) return this.json(response, 403, { error: "extension_origin_required" });
      response.writeHead(204, {
        ...this.responseHeaders("application/json", identity.origin),
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === `${BRIDGE_PATH}/pair`) {
      const identity = this.pairingOrigin(request);
      if (!identity) return this.json(response, 403, { error: "extension_origin_required" });
      try {
        const body = await this.requestBody(request);
        if (!isJsonObject(body) || body.extensionId !== identity.extensionId
          || body.catalogDigest !== this.expectedCatalogDigest
          || body.runtimeRevision !== this.expectedRuntimeRevision) {
          return this.json(response, 403, { error: "connector_identity_refused" }, identity.origin);
        }
        const pairingId = randomUUID();
        const createdAt = Date.now();
        const pairing: PairingRequest = { pairingId, extensionId: identity.extensionId, createdAt, expiresAt: createdAt + 10 * 60_000, status: "pending" };
        this.pairingRequests.set(pairingId, pairing);
        return this.json(response, 201, {
          schema: "morrow.bridge.pairing.v1",
          pairingId,
          status: pairing.status,
          approvalUrl: this.pairingUrl(`${BRIDGE_PATH}/pair/${pairingId}`),
          statusUrl: this.pairingUrl(`${BRIDGE_PATH}/pair/${pairingId}/status`),
          expiresAt: pairing.expiresAt,
        }, identity.origin);
      } catch {
        return this.json(response, 400, { error: "invalid_request" }, identity.origin);
      }
    }
    const match = new RegExp(`^${BRIDGE_PATH}/pair/([0-9a-f-]{36})(?:/(status|decision))?$`).exec(url.pathname);
    if (!match) return this.json(response, 404, { error: "not_found" });
    const pairing = this.pairingRequests.get(match[1]!);
    if (!pairing) {
      if (match[2] !== "status" && String(request.headers.accept || "").includes("text/html")) return this.pairingUnavailable(response, 404);
      return this.json(response, 404, { error: "pairing_not_found" });
    }
    if (match[2] === "status" && (request.method === "GET" || request.method === "POST")) {
      const identity = this.pairingOrigin(request);
      if (!identity || identity.extensionId !== pairing.extensionId) return this.json(response, 403, { error: "extension_identity_refused" });
      if (request.method === "POST") {
        try {
          const body = await this.requestBody(request);
          if (!isJsonObject(body) || body.extensionId !== identity.extensionId) {
            return this.json(response, 403, { error: "extension_identity_refused" }, identity.origin);
          }
        } catch {
          return this.json(response, 400, { error: "invalid_request" }, identity.origin);
        }
      }
      return this.json(response, 200, {
        schema: "morrow.bridge.pairing-status.v1",
        status: pairing.status,
        expiresAt: pairing.expiresAt,
        ...(pairing.status === "approved" ? { token: this.expectedToken.toString("utf8") } : {}),
      }, identity.origin);
    }
    if (!match[2] && request.method === "GET") {
      response.writeHead(200, this.responseHeaders("text/html; charset=utf-8"));
      response.end(this.pairingPage(pairing));
      return;
    }
    if (match[2] === "decision" && request.method === "POST") {
      const origin = String(request.headers.origin || "");
      if (origin !== `http://${host}`) {
        if (String(request.headers.accept || "").includes("text/html")) return this.pairingUnavailable(response, 403);
        return this.json(response, 403, { error: "local_origin_required" });
      }
      if (pairing.status !== "pending") {
        response.writeHead(303, { location: `${BRIDGE_PATH}/pair/${pairing.pairingId}`, "cache-control": "no-store" });
        response.end();
        return;
      }
      const bytes: Buffer[] = [];
      for await (const chunk of request) bytes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const decision = new URLSearchParams(Buffer.concat(bytes).toString("utf8")).get("decision");
      if (!['approve', 'deny'].includes(decision || "")) return this.json(response, 400, { error: "invalid_decision" });
      pairing.status = decision === "approve" ? "approved" : "denied";
      if (pairing.status === "approved") {
        this.allowedExtensionIds.add(pairing.extensionId);
        await this.onPairApproved?.(pairing.extensionId);
      }
      response.writeHead(303, { location: `${BRIDGE_PATH}/pair/${pairing.pairingId}`, "cache-control": "no-store" });
      response.end();
      return;
    }
    this.json(response, 405, { error: "method_not_allowed" });
  }

  async start(): Promise<{ host: typeof LOOPBACK_HOST; port: number; path: typeof BRIDGE_PATH }> {
    if (this.started) {
      if (this.listeningPort === null) throw new Error("bridge start is still pending");
      return { host: LOOPBACK_HOST, port: this.listeningPort, path: BRIDGE_PATH };
    }
    this.started = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        this.httpServer.once("error", onError);
        this.httpServer.listen(this.requestedPort, LOOPBACK_HOST, () => {
          this.httpServer.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      this.started = false;
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      this.portInUse = true;
      throw new BridgePortInUseError(this.requestedPort, { cause: error });
    }
    this.portInUse = false;
    const address = this.httpServer.address();
    if (!address || typeof address === "string") throw new Error("bridge did not bind a TCP address");
    this.listeningPort = (address as AddressInfo).port;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    return { host: LOOPBACK_HOST, port: this.listeningPort, path: BRIDGE_PATH };
  }

  private acceptUnauthenticated(socket: WebSocket, originId: string | null): void {
    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(4401, "authentication_required");
    }, this.authTimeoutMs);
    authTimer.unref?.();

    const onMessage = (data: RawData) => {
      let value: unknown;
      try {
        value = parseBridgeJson(rawText(data));
      } catch {
        socket.close(4400, "invalid_message");
        return;
      }
      if (!authenticated) {
        let hello: BridgeHello;
        try {
          hello = parseBridgeHello(value);
        } catch {
          socket.close(4401, "invalid_hello");
          return;
        }
        if (
          !constantTimeTokenEquals(this.expectedToken, hello.token)
          || hello.runtimeRevision !== this.expectedRuntimeRevision
          || hello.catalogDigest !== this.expectedCatalogDigest
          || (originId && hello.extensionId !== originId)
          || (this.allowedExtensionIds.size > 0 && !this.allowedExtensionIds.has(hello.extensionId))
        ) {
          socket.close(4403, "bridge_identity_refused");
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        this.activate(socket, hello);
        return;
      }
      this.handleClientMessage(socket, value);
    };
    socket.on("message", onMessage);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (this.active?.socket === socket) this.disconnectActive("The extension bridge disconnected after a command may have been sent.");
    });
  }

  private activate(socket: WebSocket, hello: BridgeHello): void {
    if (this.active && this.active.socket !== socket) {
      this.active.socket.close(4409, "superseded_by_new_connection");
      this.disconnectActive("The extension bridge connection was replaced.");
    }
    const generation = ++this.generation;
    const connectedAt = Date.now();
    this.active = {
      socket,
      extensionId: hello.extensionId,
      runtimeRevision: hello.runtimeRevision,
      catalogDigest: hello.catalogDigest,
      generation,
      connectedAt,
      bindings: normalizeBridgeBindings(hello.bindings),
      lastSeenAt: connectedAt,
    };
    send(socket, {
      schema: BRIDGE_SCHEMAS.ready,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation,
      acceptedExtensionId: hello.extensionId,
      catalogDigest: hello.catalogDigest,
      connectedAt,
    });
  }

  private handleClientMessage(socket: WebSocket, value: unknown): void {
    const active = this.active;
    if (!active || active.socket !== socket) {
      socket.close(4403, "inactive_connection");
      return;
    }
    let message: BridgeClientMessage;
    try {
      message = parseBridgeClientMessage(value);
    } catch {
      socket.close(4400, "invalid_message");
      return;
    }
    active.lastSeenAt = Date.now();
    if (message.schema === BRIDGE_SCHEMAS.bindings) {
      if (message.generation !== active.generation) return;
      active.bindings = normalizeBridgeBindings(message.bindings);
      return;
    }
    if (message.schema === BRIDGE_SCHEMAS.pong) return;
    if (message.schema !== BRIDGE_SCHEMAS.result) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (
      message.generation !== active.generation
      || message.generation !== pending.command.generation
      || message.operationId !== pending.command.operationId
    ) {
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      pending.reject(new BridgeOutcomeUnknownError(
        pending.command,
        "The bridge response did not match the connection generation or operation identity.",
      ));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.resolve(message);
  }

  private heartbeat(): void {
    const active = this.active;
    if (!active || active.socket.readyState !== WebSocket.OPEN) return;
    try {
      send(active.socket, {
        schema: BRIDGE_SCHEMAS.ping,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        generation: active.generation,
        sentAt: Date.now(),
      });
    } catch {
      this.disconnectActive("The extension bridge disconnected during heartbeat.");
    }
  }

  private disconnectActive(message: string): void {
    const active = this.active;
    this.active = null;
    for (const [requestId, pending] of this.pending) {
      if (!active || pending.command.generation === active.generation) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new BridgeOutcomeUnknownError(pending.command, message));
      }
    }
  }

  async invoke(invocation: BridgeInvocation): Promise<BridgeResult> {
    const active = this.active;
    if (!active || active.socket.readyState !== WebSocket.OPEN) throw this.unavailable();
    if (invocation.arguments && (Object.hasOwn(invocation.arguments, "privateAttachment") || Object.hasOwn(invocation.arguments, "privateAttachments") || Object.hasOwn(invocation.arguments, "privateConversation"))) {
      throw new TypeError("private bridge payload must be outside public bridge arguments");
    }
    const editPolicySet = invocation.kind === "edit_policy_set"
      ? normalizeBridgeEditPolicySet(invocation.editPolicySet)
      : undefined;
    const maintenance = invocation.kind === "bridge_maintenance"
      ? normalizeBridgeMaintenanceControl(invocation.maintenance)
      : undefined;
    const requiresKnownBinding = ["invoke_read", "invoke_write", "edit_policy_options_get"].includes(invocation.kind);
    const requiresCurrentBinding = ["invoke_read", "invoke_write"].includes(invocation.kind);
    const selectedBinding = invocation.sourceBindingId
      ? active.bindings.find((binding) => binding.sourceBindingId === invocation.sourceBindingId)
      : active.bindings.length === 1 ? active.bindings[0] : undefined;
    if (requiresKnownBinding && !selectedBinding) {
      throw new BridgeUnavailableError("The exact course connection is unavailable or changed. Create a fresh plan from a current binding.");
    }
    if (requiresCurrentBinding && selectedBinding?.runtimeVerified !== true) {
      throw new BridgeUnavailableError("The exact course connection is unavailable or changed. Create a fresh plan from a current binding.");
    }
    if (editPolicySet) {
      const bindings = new Map(active.bindings.map((binding) => [binding.sourceBindingId, binding]));
      for (const selection of editPolicySet.selections) {
        const binding = bindings.get(selection.sourceBindingId);
        if (!binding || (editPolicySet.mode === "edit" && binding.runtimeVerified !== true)) {
          throw new BridgeUnavailableError("The exact course connection is unavailable or changed. Create a fresh request from current bindings.");
        }
      }
    }
    const expectedProvider = providerForToolName(invocation.toolName);
    if (expectedProvider && selectedBinding && selectedBinding.provider !== expectedProvider) {
      throw new BridgeUnavailableError(`The exact ${expectedProvider} binding is unavailable or changed. Create a fresh plan from a current binding.`);
    }
    const privateAttachment = invocation.privateAttachment === undefined
      ? undefined
      : normalizeBridgePrivateAttachment(invocation.privateAttachment);
    const privateAttachments = invocation.privateAttachments === undefined
      ? undefined
      : normalizeBridgePrivateAttachments(invocation.privateAttachments);
    const privateConversation = invocation.privateConversation === undefined
      ? undefined
      : normalizeBridgePrivateConversation(invocation.privateConversation);
    const privateAttachmentAllowed = invocation.kind === "invoke_write" && ((
      selectedBinding?.provider === "moodle" && (
        (invocation.toolName === PRIVATE_MOODLE_RESOURCE_FILE_TOOL
          && invocation.operationKey === PRIVATE_MOODLE_RESOURCE_FILE_OPERATION)
        || (invocation.toolName === PRIVATE_MOODLE_FOLDER_FILE_TOOL
          && invocation.operationKey === PRIVATE_MOODLE_FOLDER_FILE_OPERATION)
        || (invocation.toolName === PRIVATE_MOODLE_IMSCP_PACKAGE_TOOL
          && invocation.operationKey === PRIVATE_MOODLE_IMSCP_PACKAGE_OPERATION)
        || (invocation.toolName === PRIVATE_MOODLE_SCORM_PACKAGE_TOOL
          && invocation.operationKey === PRIVATE_MOODLE_SCORM_PACKAGE_OPERATION)
        || (invocation.toolName === PRIVATE_MOODLE_H5P_ACTIVITY_TOOL
          && invocation.operationKey === PRIVATE_MOODLE_H5P_ACTIVITY_OPERATION)
        || (invocation.toolName === PRIVATE_MOODLE_H5P_REPLACE_TOOL
          && invocation.operationKey === PRIVATE_MOODLE_H5P_REPLACE_OPERATION)
        || (invocation.toolName === PRIVATE_MOODLE_RESOURCE_REPLACE_TOOL
          && invocation.operationKey === PRIVATE_MOODLE_RESOURCE_REPLACE_OPERATION)
        || (invocation.toolName === PRIVATE_MOODLE_SCORM_REPLACE_TOOL
          && invocation.operationKey === PRIVATE_MOODLE_SCORM_REPLACE_OPERATION)
      )
    ) || (
      invocation.toolName === PRIVATE_CANVAS_COURSE_FILE_TOOL
        && invocation.operationKey === PRIVATE_CANVAS_COURSE_FILE_OPERATION
        && selectedBinding?.provider === "canvas"
    ));
    if (privateAttachment && !privateAttachmentAllowed) {
      throw new BridgeUnavailableError("A private file attachment is only available for one exact reviewed course-file change.");
    }
    if (privateAttachmentAllowed && !privateAttachment) {
      throw new BridgeUnavailableError("This reviewed course-file change needs its staged private file attachment.");
    }
    if (privateAttachmentAllowed && invocation.toolName === PRIVATE_CANVAS_COURSE_FILE_TOOL && !privateAttachment?.content_type) {
      throw new BridgeUnavailableError("This Canvas course-file change needs the staged content type.");
    }
    const privateAttachmentsAllowed = invocation.kind === "invoke_write"
      && selectedBinding?.provider === "moodle"
      && invocation.toolName === PRIVATE_MOODLE_FOLDER_ADD_TOOL
      && invocation.operationKey === PRIVATE_MOODLE_FOLDER_ADD_OPERATION;
    if (privateAttachments && (!privateAttachmentsAllowed || privateAttachment)) {
      throw new BridgeUnavailableError("Private file attachments are only available for one exact reviewed Moodle Folder change.");
    }
    if (privateAttachmentsAllowed && !privateAttachments) {
      throw new BridgeUnavailableError("This reviewed Moodle Folder change needs its staged private files.");
    }
    const privateConversationAllowed = invocation.kind === "invoke_write" && selectedBinding?.provider === "canvas"
      && privateAttachment === undefined
      && invocation.toolName === PRIVATE_CANVAS_CONVERSATION_TOOL
      && invocation.operationKey === PRIVATE_CANVAS_CONVERSATION_OPERATION
      && privateConversation !== undefined;
    const privateConversationRoute = invocation.kind === "invoke_write"
      && invocation.toolName === PRIVATE_CANVAS_CONVERSATION_TOOL
      && invocation.operationKey === PRIVATE_CANVAS_CONVERSATION_OPERATION;
    if (privateConversationRoute && !privateConversation) {
      throw new BridgeUnavailableError("This private Canvas Inbox command needs its sealed reviewed payload.");
    }
    if (privateConversation && (!privateConversationAllowed || privateConversation.courseId !== selectedBinding?.courseId)) {
      throw new BridgeUnavailableError("A private Canvas Inbox payload is available only for its exact current course command.");
    }
    const now = Date.now();
    const timeoutMs = exactTimeout(invocation.timeoutMs, this.callTimeoutMs, "timeoutMs");
    const requestId = `bridge:${randomUUID()}`;
    const operationId = String(invocation.operationId || `operation:${randomUUID()}`).trim();
    if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(operationId)) {
      throw new TypeError("operationId has an invalid format");
    }
    if (["invoke_read", "invoke_write", "stage_write"].includes(invocation.kind) && !invocation.toolName) {
      throw new TypeError(`${invocation.kind} requires toolName`);
    }
    if (["invoke_read", "invoke_write"].includes(invocation.kind) && !invocation.operationKey) {
      throw new TypeError(`${invocation.kind} requires operationKey`);
    }
    if (invocation.kind === "task_get" && !invocation.taskId) {
      throw new TypeError("task_get requires taskId");
    }
    if (invocation.kind === "edit_policy_set" && !editPolicySet) {
      throw new TypeError("edit_policy_set requires an exact policy set");
    }
    if (invocation.kind === "bridge_maintenance" && !maintenance) {
      throw new TypeError("bridge_maintenance requires one exact maintenance control");
    }
    if (invocation.kind === "edit_policy_options_get" && !invocation.sourceBindingId) {
      throw new TypeError("edit_policy_options_get requires one exact sourceBindingId");
    }
    if (invocation.kind === "invoke_write" && !invocation.outerGrant) {
      throw new TypeError("invoke_write requires a gateway outer grant");
    }
    if (invocation.kind === "invoke_write" && invocation.outerGrant!.authorization?.kind === "edit_scope") {
      const authorization = invocation.outerGrant!.authorization;
      const permission = selectedBinding?.editPermission;
      if (authorization?.kind !== "edit_scope" || !expectedProvider || !selectedBinding || !permission
        || authorization.policyDigest !== permission.scopeDigest
        || authorization.policyRevision !== permission.revision) {
        throw new BridgeUnavailableError("The current edit permission no longer authorizes this change. Create a fresh plan from the current binding.");
      }
      const detailResponse = await this.invoke({
        kind: "edit_policy_options_get",
        sourceBindingId: selectedBinding.sourceBindingId,
        operationId: `edit-options:${randomUUID()}`,
      });
      if (!detailResponse.ok || !detailResponse.result) {
        throw new BridgeUnavailableError("Morrow could not read the current Edit permission for this course. Create a fresh plan from the current binding.");
      }
      let details;
      try {
        details = normalizeBridgeEditOptionsResult(detailResponse.result, selectedBinding.sourceBindingId);
      } catch {
        throw new BridgeUnavailableError("Morrow received an invalid current Edit permission for this course. Create a fresh plan from the current binding.");
      }
      const detailedPermission = details.editPermission;
      if (!details.runtimeVerified || details.provider !== selectedBinding.provider || details.catalogDigest !== active.catalogDigest
        || !detailedPermission || detailedPermission.sourceBindingId !== selectedBinding.sourceBindingId
        || detailedPermission.scopeDigest !== permission.scopeDigest || detailedPermission.revision !== permission.revision
        || detailedPermission.catalogDigest !== permission.catalogDigest || detailedPermission.expiresAt !== permission.expiresAt
        || !matchesBridgeEditPermission({ ...selectedBinding, editPermission: detailedPermission }, {
          provider: expectedProvider,
          catalogDigest: active.catalogDigest,
          operationKey: invocation.operationKey!,
          toolName: invocation.toolName!,
          arguments: invocation.arguments || {},
        })) {
        throw new BridgeUnavailableError("The current edit permission no longer authorizes this change. Create a fresh plan from the current binding.");
      }
    }
    if (["invoke_write", "stage_write"].includes(invocation.kind) && invocation.outerGrant) {
      if (this.usedOuterEffectReceipts.has(invocation.outerGrant.effectReceiptId)) {
        throw new BridgeOutcomeUnknownError({
          schema: BRIDGE_SCHEMAS.command,
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          requestId,
          operationId,
          kind: invocation.kind,
          generation: active.generation,
          createdAt: now,
          expiresAt: now + timeoutMs,
        }, "The gateway effect receipt was already used. Morrow will not resend this write.", false);
      }
      if (this.usedOuterEffectReceipts.size >= this.writeReceiptCapacity) {
        throw new BridgeWriteRecordFullError(this.writeReceiptCapacity);
      }
      this.usedOuterEffectReceipts.add(invocation.outerGrant.effectReceiptId);
    }
    const command: BridgeCommand = {
      schema: BRIDGE_SCHEMAS.command,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId,
      operationId,
      kind: invocation.kind,
      ...(invocation.toolName ? { toolName: invocation.toolName } : {}),
      ...(invocation.operationKey ? { operationKey: invocation.operationKey } : {}),
      ...(invocation.arguments ? { arguments: structuredClone(invocation.arguments) } : {}),
      ...(privateAttachment ? { privateAttachment } : {}),
      ...(privateAttachments ? { privateAttachments } : {}),
      ...(privateConversation ? { privateConversation } : {}),
      ...(selectedBinding ? { sourceBindingId: selectedBinding.sourceBindingId } : invocation.sourceBindingId ? { sourceBindingId: invocation.sourceBindingId } : {}),
      ...(invocation.taskId ? { taskId: invocation.taskId } : {}),
      ...(editPolicySet ? { editPolicySet } : {}),
      ...(maintenance ? { maintenance } : {}),
      ...(invocation.outerGrant ? { outerGrant: structuredClone(invocation.outerGrant) } : {}),
      generation: active.generation,
      createdAt: now,
      expiresAt: now + timeoutMs,
    };
    return await new Promise<BridgeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeOutcomeUnknownError(
          command,
          "The extension did not return a result before the bridge deadline. Morrow did not resend the command.",
        ));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { command, timer, resolve, reject });
      try {
        send(active.socket, command);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new BridgeUnavailableError());
      }
    });
  }

  listBindings(): readonly BridgeBinding[] {
    return this.active ? structuredClone(this.active.bindings) : [];
  }

  /** The reason a command cannot be sent, named when the Bridge port is held. */
  private unavailable(): BridgeUnavailableError {
    return this.portInUse ? new BridgePortInUseError(this.requestedPort) : new BridgeUnavailableError();
  }

  health(): LoopbackBridgeHealth {
    const active = this.active;
    return {
      schema: "morrow.bridge.health.v1",
      listening: this.started && this.listeningPort !== null,
      ...(this.portInUse
        ? { problem: { code: "bridge_port_in_use", port: this.requestedPort, message: bridgePortInUseMessage(this.requestedPort) } as const }
        : {}),
      host: LOOPBACK_HOST,
      port: this.listeningPort,
      path: BRIDGE_PATH,
      connected: Boolean(active && active.socket.readyState === WebSocket.OPEN),
      generation: active?.generation || this.generation,
      extensionId: active?.extensionId || null,
      runtimeRevision: active?.runtimeRevision || null,
      catalogDigest: this.expectedCatalogDigest,
      bindingCount: active?.bindings.length || 0,
      pendingCount: this.pending.size,
      connectedAt: active?.connectedAt || null,
      lastSeenAt: active?.lastSeenAt || null,
    };
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const active = this.active;
    if (active) active.socket.close(1001, "server_shutdown");
    this.disconnectActive("The extension bridge server closed.");
    await new Promise<void>((resolve) => this.webSocketServer.close(() => resolve()));
    if (this.started) {
      await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    }
    this.started = false;
    this.listeningPort = null;
  }
}

export function bridgeFailureResult(error: unknown): BridgeResult["problem"] {
  if (error instanceof BridgeOutcomeUnknownError) {
    return createBridgeProblem(
      error.code,
      "The bridge command may have reached the extension, but its result is unknown. Inspect the existing task or target before repeating it.",
      false,
      { requestId: error.requestId, operationId: error.operationId, kind: error.commandKind },
    );
  }
  if (error instanceof BridgeUnavailableError) {
    return createBridgeProblem(error.code, error.message, true);
  }
  return createBridgeProblem(
    "bridge_call_failed",
    "The local extension bridge could not complete the request.",
    true,
    error instanceof Error ? { name: error.name, message: error.message } : String(error),
  );
}
