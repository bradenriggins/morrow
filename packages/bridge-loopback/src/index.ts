import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  BRIDGE_PATH,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMAS,
  MAX_BRIDGE_MESSAGE_BYTES,
  MIN_BRIDGE_TOKEN_LENGTH,
  createBridgeProblem,
  normalizeBridgeBindings,
  parseBridgeClientMessage,
  parseBridgeHello,
  parseBridgeJson,
  serializeBridgeMessage,
  type BridgeBinding,
  type BridgeClientMessage,
  type BridgeCommand,
  type BridgeCommandKind,
  type BridgeOuterGrant,
  type BridgeHello,
  type BridgePing,
  type BridgeReady,
  type BridgeResult,
} from "@morrow/bridge-protocol";
import type { JsonObject } from "@morrow/contracts";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;

export interface LoopbackBridgeOptions {
  readonly token: string;
  readonly expectedDonorRevision: string;
  readonly expectedCatalogDigest: string;
  readonly allowedExtensionIds?: readonly string[];
  readonly port?: number;
  readonly authTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly allowMissingOriginForTests?: boolean;
}

export interface BridgeInvocation {
  readonly kind: BridgeCommandKind;
  readonly toolName?: string;
  readonly arguments?: JsonObject;
  readonly sourceBindingId?: string;
  readonly taskId?: string;
  readonly operationId?: string;
  readonly outerGrant?: BridgeOuterGrant;
  readonly timeoutMs?: number;
}

export interface LoopbackBridgeHealth {
  readonly schema: "morrow.bridge.health.v1";
  readonly listening: boolean;
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number | null;
  readonly path: typeof BRIDGE_PATH;
  readonly connected: boolean;
  readonly generation: number;
  readonly extensionId: string | null;
  readonly donorRevision: string | null;
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
  readonly donorRevision: string;
  readonly catalogDigest: string;
  readonly generation: number;
  readonly connectedAt: number;
  bindings: readonly BridgeBinding[];
  lastSeenAt: number;
}

export class BridgeUnavailableError extends Error {
  readonly code = "bridge_unavailable";
  constructor(message = "The Morrow legacy extension bridge is not connected.") {
    super(message);
    this.name = "BridgeUnavailableError";
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
  private readonly expectedDonorRevision: string;
  private readonly expectedCatalogDigest: string;
  private readonly allowedExtensionIds: ReadonlySet<string>;
  private readonly requestedPort: number;
  private readonly authTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly allowMissingOriginForTests: boolean;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly usedOuterEffectReceipts = new Set<string>();
  private readonly httpServer: HttpServer;
  private readonly webSocketServer: WebSocketServer;
  private active: ActiveClient | null = null;
  private generation = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private listeningPort: number | null = null;
  private started = false;

  constructor(options: LoopbackBridgeOptions) {
    this.expectedToken = tokenBytes(options.token);
    this.expectedDonorRevision = String(options.expectedDonorRevision || "").trim();
    this.expectedCatalogDigest = String(options.expectedCatalogDigest || "").trim();
    if (!this.expectedDonorRevision) throw new TypeError("expectedDonorRevision is required");
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
    this.allowMissingOriginForTests = options.allowMissingOriginForTests === true;

    this.httpServer = createServer((request, response) => {
      response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
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

  async start(): Promise<{ host: typeof LOOPBACK_HOST; port: number; path: typeof BRIDGE_PATH }> {
    if (this.started) {
      if (this.listeningPort === null) throw new Error("bridge start is still pending");
      return { host: LOOPBACK_HOST, port: this.listeningPort, path: BRIDGE_PATH };
    }
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.httpServer.once("error", onError);
      this.httpServer.listen(this.requestedPort, LOOPBACK_HOST, () => {
        this.httpServer.off("error", onError);
        resolve();
      });
    });
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
          || hello.donorRevision !== this.expectedDonorRevision
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
      donorRevision: hello.donorRevision,
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
    if (!active || active.socket.readyState !== WebSocket.OPEN) throw new BridgeUnavailableError();
    const now = Date.now();
    const timeoutMs = exactTimeout(invocation.timeoutMs, this.callTimeoutMs, "timeoutMs");
    const requestId = `bridge:${randomUUID()}`;
    const operationId = String(invocation.operationId || `operation:${randomUUID()}`).trim();
    if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(operationId)) {
      throw new TypeError("operationId has an invalid format");
    }
    if (["invoke_read", "stage_write"].includes(invocation.kind) && !invocation.toolName) {
      throw new TypeError(`${invocation.kind} requires toolName`);
    }
    if (invocation.kind === "task_get" && !invocation.taskId) {
      throw new TypeError("task_get requires taskId");
    }
    if (invocation.kind === "stage_write" && invocation.outerGrant) {
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
      this.usedOuterEffectReceipts.add(invocation.outerGrant.effectReceiptId);
    }
    const command: BridgeCommand = {
      schema: BRIDGE_SCHEMAS.command,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId,
      operationId,
      kind: invocation.kind,
      ...(invocation.toolName ? { toolName: invocation.toolName } : {}),
      ...(invocation.arguments ? { arguments: structuredClone(invocation.arguments) } : {}),
      ...(invocation.sourceBindingId ? { sourceBindingId: invocation.sourceBindingId } : {}),
      ...(invocation.taskId ? { taskId: invocation.taskId } : {}),
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

  health(): LoopbackBridgeHealth {
    const active = this.active;
    return {
      schema: "morrow.bridge.health.v1",
      listening: this.started && this.listeningPort !== null,
      host: LOOPBACK_HOST,
      port: this.listeningPort,
      path: BRIDGE_PATH,
      connected: Boolean(active && active.socket.readyState === WebSocket.OPEN),
      generation: active?.generation || this.generation,
      extensionId: active?.extensionId || null,
      donorRevision: active?.donorRevision || null,
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
