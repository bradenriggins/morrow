import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  StreamableHTTPClientTransport,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpHttpHandler,
  type McpServer,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { sha256Json } from "@morrow/contracts";
import {
  canonicalPrivateStateFilePath,
  decodeExactUtf8,
  readExactPrivateStateFile,
  replaceExactPrivateStateFile,
  withExactPrivateStateFileTransaction,
} from "@morrow/gateway-core";
import type { GatewayConfig } from "./config.js";
import { createFullMorrowServer } from "./full-server.js";
import { BoundedHttpServerLifecycle } from "./approval-server.js";
import { MorrowRuntime } from "./morrow-runtime.js";
import { mcpRuntimeHealthFromPayload } from "./runtime.js";
import {
  LOCAL_OWNER_MAINTENANCE_PATH,
  LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA,
  createLocalOwnerMaintenanceLease,
  localOwnerMaintenanceMarkerPresent,
  localOwnerMaintenanceMatches,
  normalizeLocalOwnerBridgeMaintenanceControl,
  processMatchesRecordedLifetimeAsync,
  requestPathProcessMatches,
  readLocalOwnerMaintenanceLease,
  recoverExactLocalOwnerMaintenanceLease,
  removeExactLocalOwnerMaintenanceLease,
  writeLocalOwnerMaintenanceLease,
} from "./local-owner-maintenance.js";
import { RuntimeStateLease, hardenMorrowStateFiles } from "./state-lease.js";
import { StrictStdioServerTransport } from "./strict-stdio.js";
import { PrivateChatContinuationLedger } from "./private-chat.js";

const OWNER_SCHEMA = "morrow.local-owner.v1";
const LOOPBACK_HOST = "127.0.0.1";
const OWNER_PATH = "/mcp";
const PROXY_PID_HEADER = "x-morrow-proxy-pid";
const PROXY_WORKSPACE_HEADER = "x-morrow-workspace";
const OWNER_START_TIMEOUT_MS = 30_000;
const OWNER_STARTUP_CLOSE_TIMEOUT_MS = 5_000;
const OWNER_TERMINATE_GRACE_MS = 1_500;
const OWNER_KILL_WAIT_MS = 1_500;
const OWNER_START_GRACE_MS = 30_000;
const OWNER_IDLE_MS = 1_000;
const OWNER_PENDING_IDLE_CHECK_MS = 1_000;
const OWNER_SESSION_REAP_MS = 1_000;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_MODERN_PROXY_REQUESTS = 64;
const MAX_WORKSPACE_HEADER_CHARS = 4_096;
const MAX_WORKSPACE_ROOT_BYTES = 3_072;
const OWNER_DESCRIPTOR_MAX_BYTES = 4_096;
const OWNER_DESCRIPTOR_SUFFIX = ".local-owner.json";
const OWNER_DESCRIPTOR_FILE_OPTIONS = {
  label: "local owner descriptor",
  minBytes: 1,
  maxBytes: OWNER_DESCRIPTOR_MAX_BYTES,
} as const;
const OWNER_DESCRIPTOR_TRANSACTION_OPTIONS = {
  label: "local owner descriptor",
  timeoutMs: 1_000,
} as const;
const OWNER_DESCRIPTOR_KEYS = [
  "configDigest",
  "journalPath",
  "nonce",
  "pid",
  "port",
  "schema",
  "startedAt",
  "token",
] as const;

interface WorkspaceAdmission {
  readonly root: string;
  readonly encoded: string;
}

interface OwnerDescriptor {
  readonly schema: typeof OWNER_SCHEMA;
  readonly nonce: string;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly journalPath: string;
  readonly configDigest: string;
  readonly startedAt: string;
}

interface ClientPresence {
  readonly proxyPid: number;
  readonly observedAt: string;
  readonly workspace: WorkspaceAdmission;
}

interface Session extends ClientPresence {
  id: string | null;
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

interface ProxyPresence extends ClientPresence {
  readonly requestStateKey: Uint8Array;
  readonly privateChatContinuations: PrivateChatContinuationLedger;
}

interface MaintenanceRequest {
  readonly action: "acquire" | "release" | "commit" | "recover" | "bridge" | "retire";
  readonly runtimeIdentity?: string;
  readonly holderPid: number;
  readonly monitorProxyPid?: number;
  readonly leaseId?: string;
  readonly leaseToken?: string;
  readonly control?: unknown;
}

const RUNTIME_IDENTITY = /^(?:source|[a-f0-9]{64})$/;

/**
 * The build this process runs: the digest of the sealed MCP runtime manifest
 * beside its payload, or `source` for a checkout without one. The value is
 * re-read from disk on each call, so an owner can compare the build it started
 * with against the files now installed at its own path.
 */
function localOwnerRuntimeIdentity(): string {
  if (process.env.MORROW_INSTALLER_TEST_MODE === "1" && process.env.MORROW_LOCAL_OWNER_TEST_RUNTIME_IDENTITY_FILE) {
    try {
      const value = readFileSync(process.env.MORROW_LOCAL_OWNER_TEST_RUNTIME_IDENTITY_FILE, "utf8").trim();
      return RUNTIME_IDENTITY.test(value) ? value : "source";
    } catch {
      return "source";
    }
  }
  return mcpRuntimeHealthFromPayload()?.manifestSha256 ?? "source";
}

function durableJournalPath(config: GatewayConfig): string | null {
  const value = String(config.operationJournal.path || "").trim();
  return value && value !== ":memory:" ? resolve(value) : null;
}

function ownerDescriptorPath(journalPath: string): string {
  return `${journalPath}${OWNER_DESCRIPTOR_SUFFIX}`;
}

function canonicalLocalOwnerJournalPath(journalPath: string): string {
  return canonicalPrivateStateFilePath(resolve(journalPath), "local owner state");
}

function canonicalRecordedJournalPath(journalPath: string): string | null {
  if (!isAbsolute(journalPath) || /[\0\r\n]/.test(journalPath)) return null;
  const requested = resolve(journalPath);
  try {
    return resolve(realpathSync(dirname(requested)), basename(requested));
  } catch {
    return null;
  }
}

function ownerConfigDigest(config: GatewayConfig): string {
  return sha256Json(config);
}

function testOwnerStderrDescriptor(): number | null {
  if (process.env.MORROW_INSTALLER_TEST_MODE !== "1") return null;
  const configured = process.env.MORROW_LOCAL_OWNER_TEST_STDERR_PATH;
  if (!configured || !isAbsolute(configured) || /[\0\r\n]/.test(configured)) return null;
  try {
    return openSync(
      configured,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      0o600,
    );
  } catch {
    return null;
  }
}

function ownerStartTimeoutMs(): number {
  if (process.env.MORROW_INSTALLER_TEST_MODE !== "1") return OWNER_START_TIMEOUT_MS;
  const configured = Number(process.env.MORROW_LOCAL_OWNER_TEST_START_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured >= 25 && configured <= OWNER_START_TIMEOUT_MS
    ? configured
    : OWNER_START_TIMEOUT_MS;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForLaunchedOwnerExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolveExit) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once("exit", onExit);
  });
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
    stdio: "ignore",
    windowsHide: true,
  });
  const settled = await settlesWithin(new Promise<void>((resolveKill) => {
    killer.once("error", () => resolveKill());
    killer.once("exit", () => resolveKill());
  }), OWNER_TERMINATE_GRACE_MS);
  killer.removeAllListeners();
  if (!settled && killer.exitCode === null && killer.signalCode === null) {
    try { killer.kill("SIGKILL"); } catch {}
    await waitForLaunchedOwnerExit(killer, OWNER_KILL_WAIT_MS);
  }
  killer.removeAllListeners();
  killer.unref();
}

async function terminateLaunchedOwner(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !Number.isSafeInteger(child.pid)) return;
  const pid = child.pid!;
  child.ref();
  try {
    if (process.platform === "win32") await runTaskkill(pid, false);
    else {
      try { child.kill("SIGTERM"); } catch {}
    }
    if (await waitForLaunchedOwnerExit(child, OWNER_TERMINATE_GRACE_MS)) return;
    if (process.platform === "win32") await runTaskkill(pid, true);
    else {
      try { child.kill("SIGKILL"); } catch {}
    }
    if (!await waitForLaunchedOwnerExit(child, OWNER_KILL_WAIT_MS)) {
      throw new Error(`Morrow local owner process ${pid} did not exit after forced shutdown.`);
    }
  } finally {
    child.removeAllListeners("error");
    child.removeAllListeners("exit");
    child.unref();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function parseOwnerDescriptor(value: string, journalPath: string): OwnerDescriptor | null {
  try {
    const candidate = JSON.parse(value) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).sort().join("\0") !== OWNER_DESCRIPTOR_KEYS.join("\0")) return null;
    const parsed = candidate as Partial<OwnerDescriptor>;
    const recordedJournalPath = typeof parsed.journalPath === "string" ? canonicalRecordedJournalPath(parsed.journalPath) : null;
    if (
      parsed.schema !== OWNER_SCHEMA
      || typeof parsed.nonce !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed.nonce)
      || !Number.isSafeInteger(parsed.pid)
      || Number(parsed.pid) < 1
      || Number(parsed.pid) > 2_147_483_647
      || !Number.isSafeInteger(parsed.port)
      || Number(parsed.port) < 1
      || Number(parsed.port) > 65_535
      || typeof parsed.token !== "string"
      || !/^[A-Za-z0-9_-]{40,160}$/.test(parsed.token)
      || recordedJournalPath !== journalPath
      || typeof parsed.configDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(parsed.configDigest)
      || typeof parsed.startedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.startedAt))
      || new Date(parsed.startedAt).toISOString() !== parsed.startedAt
    ) return null;
    return { ...parsed, journalPath } as OwnerDescriptor;
  } catch {
    return null;
  }
}

function readOwnerDescriptor(journalPathValue: string): OwnerDescriptor | null {
  try {
    const journalPath = canonicalLocalOwnerJournalPath(journalPathValue);
    const content = readExactPrivateStateFile(ownerDescriptorPath(journalPath), OWNER_DESCRIPTOR_FILE_OPTIONS);
    return content ? parseOwnerDescriptor(decodeExactUtf8(content, "local owner descriptor"), journalPath) : null;
  } catch {
    return null;
  }
}

function removeOwnerDescriptor(journalPathValue: string, nonce: string): void {
  const journalPath = canonicalLocalOwnerJournalPath(journalPathValue);
  const path = ownerDescriptorPath(journalPath);
  withExactPrivateStateFileTransaction(path, OWNER_DESCRIPTOR_TRANSACTION_OPTIONS, () => {
    const current = readOwnerDescriptor(journalPath);
    if (current?.nonce !== nonce) return;
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
}

function writeOwnerDescriptor(journalPathValue: string, descriptor: OwnerDescriptor): void {
  const journalPath = canonicalLocalOwnerJournalPath(journalPathValue);
  const path = ownerDescriptorPath(journalPath);
  const content = Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8");
  const parsed = parseOwnerDescriptor(content.toString("utf8"), journalPath);
  if (!parsed || parsed.journalPath !== descriptor.journalPath || parsed.nonce !== descriptor.nonce) {
    throw new TypeError("local owner descriptor is invalid");
  }
  withExactPrivateStateFileTransaction(path, OWNER_DESCRIPTOR_TRANSACTION_OPTIONS, () => {
    replaceExactPrivateStateFile(path, content, OWNER_DESCRIPTOR_FILE_OPTIONS);
  });
}

function ownerUrl(descriptor: OwnerDescriptor): URL {
  return new URL(`http://${LOOPBACK_HOST}:${descriptor.port}${OWNER_PATH}`);
}

function exactAuthorization(value: string | undefined, token: string): boolean {
  if (!value) return false;
  const received = Buffer.from(value, "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function proxyProcessId(value: string | string[] | undefined): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function encodeWorkspaceRoot(root: string): string | null {
  const bytes = Buffer.from(root, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_WORKSPACE_ROOT_BYTES) return null;
  const encoded = bytes.toString("base64url");
  return encoded && encoded.length <= MAX_WORKSPACE_HEADER_CHARS ? encoded : null;
}

function admittedWorkspace(root: string, encoded?: string): WorkspaceAdmission | null {
  if (!root || !isAbsolute(root) || /[\0\r\n]/.test(root)) return null;
  let canonical: string;
  try {
    canonical = realpathSync(root);
    if (canonical !== root || !statSync(canonical).isDirectory()) return null;
  } catch {
    return null;
  }
  const canonicalEncoded = encodeWorkspaceRoot(canonical);
  if (!canonicalEncoded || (encoded !== undefined && encoded !== canonicalEncoded)) return null;
  return { root: canonical, encoded: canonicalEncoded };
}

function currentWorkspaceAdmission(): WorkspaceAdmission {
  let root: string;
  try {
    root = realpathSync(process.cwd());
  } catch {
    throw new Error("Morrow could not admit the current assistant workspace.");
  }
  const admitted = admittedWorkspace(root);
  if (!admitted) throw new Error("Morrow could not admit the current assistant workspace.");
  return admitted;
}

function oneHeaderValue(request: IncomingMessage, name: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] || "");
  }
  return values.length === 1 ? values[0]! : null;
}

function admittedWorkspaceFromRequest(request: IncomingMessage): WorkspaceAdmission | null {
  const encoded = oneHeaderValue(request, PROXY_WORKSPACE_HEADER);
  return admittedWorkspaceFromEncoded(encoded);
}

function admittedWorkspaceFromEncoded(encoded: string | null): WorkspaceAdmission | null {
  if (!encoded || encoded.length > MAX_WORKSPACE_HEADER_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_WORKSPACE_ROOT_BYTES || bytes.toString("base64url") !== encoded) return null;
  const root = bytes.toString("utf8");
  if (!Buffer.from(root, "utf8").equals(bytes)) return null;
  return admittedWorkspace(root, encoded);
}

function sendProblem(response: ServerResponse, status: number, code: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ schema: "morrow.problem.v1", code }));
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function requestLengthIsAllowed(request: IncomingMessage): boolean {
  const value = request.headers["content-length"];
  if (typeof value !== "string" || !value) return true;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_HTTP_BODY_BYTES;
}

class HttpBodyTooLargeError extends Error {}
class HttpBodyInvalidUtf8Error extends Error {}

async function readBoundedHttpBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<Buffer | undefined> {
  const method = request.method || "GET";
  if (method === "GET" || method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  for await (const part of request) {
    signal.throwIfAborted();
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    if (chunk.byteLength > MAX_HTTP_BODY_BYTES - bytes) {
      request.pause();
      throw new HttpBodyTooLargeError("Morrow local owner request body exceeds the byte limit.");
    }
    bytes += chunk.byteLength;
    chunks.push(chunk);
    try {
      decoder.decode(chunk, { stream: true });
    } catch {
      request.pause();
      throw new HttpBodyInvalidUtf8Error("Morrow local owner request body is not valid UTF-8.");
    }
  }
  signal.throwIfAborted();
  try {
    decoder.decode();
  } catch {
    throw new HttpBodyInvalidUtf8Error("Morrow local owner request body is not valid UTF-8.");
  }
  return Buffer.concat(chunks, bytes);
}

function rejectOversizedRequest(request: IncomingMessage, response: ServerResponse): void {
  request.pause();
  if (response.destroyed || response.writableEnded) {
    request.destroy();
    return;
  }
  response.setHeader("connection", "close");
  response.once("finish", () => request.socket.destroySoon());
  sendProblem(response, 413, "local_owner_message_too_large");
}

function exactMaintenanceRequest(value: unknown): MaintenanceRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const action = source.action;
  const base = source.schema === LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA
    && (action === "acquire" || action === "release" || action === "commit" || action === "recover" || action === "bridge" || action === "retire")
    && Object.entries(source).every(([key]) => ["schema", "action", "holderPid", "monitorProxyPid", "leaseId", "leaseToken", "control", "runtimeIdentity"].includes(key));
  const holderPid = exactPid(source.holderPid);
  const monitorProxyPid = exactPid(source.monitorProxyPid);
  if (!base || holderPid === null) return null;
  if (action === "retire") {
    if (Object.keys(source).length !== 4 || typeof source.runtimeIdentity !== "string"
      || !RUNTIME_IDENTITY.test(source.runtimeIdentity)) return null;
    return { action, holderPid, runtimeIdentity: source.runtimeIdentity };
  }
  if (source.runtimeIdentity !== undefined) return null;
  if (action === "acquire") {
    if (Object.keys(source).length !== 4 || monitorProxyPid === null) return null;
    return { action, holderPid, monitorProxyPid };
  }
  if (action === "recover") {
    if (Object.keys(source).length !== 5 || typeof source.leaseId !== "string" || !/^[0-9a-f-]{36}$/i.test(source.leaseId)
      || typeof source.leaseToken !== "string" || !/^[A-Za-z0-9_-]{40,160}$/.test(source.leaseToken)) return null;
    return { action, holderPid, leaseId: source.leaseId, leaseToken: source.leaseToken };
  }
  if (action === "bridge") {
    const control = normalizeLocalOwnerBridgeMaintenanceControl(source.control);
    if (!control) return null;
    if (control.action === "status") {
      if (Object.keys(source).length !== 4) return null;
      return { action, holderPid, control };
    }
    if (Object.keys(source).length !== 6 || typeof source.leaseId !== "string" || !/^[0-9a-f-]{36}$/i.test(source.leaseId)
      || typeof source.leaseToken !== "string" || !/^[A-Za-z0-9_-]{40,160}$/.test(source.leaseToken)) return null;
    return { action, holderPid, control, leaseId: source.leaseId, leaseToken: source.leaseToken };
  }
  if (Object.keys(source).length !== 5 || typeof source.leaseId !== "string" || !/^[0-9a-f-]{36}$/i.test(source.leaseId)
    || typeof source.leaseToken !== "string" || !/^[A-Za-z0-9_-]{40,160}$/.test(source.leaseToken)) return null;
  return { action, holderPid, leaseId: source.leaseId, leaseToken: source.leaseToken };
}

function exactPid(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647 ? Number(value) : null;
}

type ModernRequestId = string | number;

function modernRequestId(message: JSONRPCMessage): ModernRequestId | null {
  if (!("method" in message) || !("id" in message)) return null;
  return typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
}

function cancelledModernRequestId(message: JSONRPCMessage): ModernRequestId | null {
  if (!("method" in message) || message.method !== "notifications/cancelled"
    || !message.params || typeof message.params !== "object") return null;
  const requestId = (message.params as { requestId?: unknown }).requestId;
  return typeof requestId === "string" || typeof requestId === "number" ? requestId : null;
}

function modernMessageProtocol(message: JSONRPCMessage): string | null {
  if (!("method" in message) || !message.params || typeof message.params !== "object") return null;
  const metadata = (message.params as { _meta?: unknown })._meta;
  if (!metadata || typeof metadata !== "object") return null;
  const version = (metadata as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"];
  return typeof version === "string" ? version : null;
}

function modernRequestKey(id: ModernRequestId): string {
  return `${typeof id}:${String(id)}`;
}

async function readMaintenanceRequest(request: IncomingMessage): Promise<MaintenanceRequest | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.byteLength;
    if (bytes > 8_192) {
      request.pause();
      return null;
    }
    chunks.push(chunk);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return exactMaintenanceRequest(JSON.parse(text));
  } catch {
    return null;
  }
}

async function asWebRequest(request: IncomingMessage, port: number, signal: AbortSignal): Promise<Request> {
  const method = request.method || "GET";
  const body = await readBoundedHttpBody(request, signal);
  return new Request(`http://${LOOPBACK_HOST}:${port}${request.url || "/"}`, {
    method,
    headers: requestHeaders(request),
    ...(body ? { body: body as unknown as BodyInit, duplex: "half" } : {}),
    signal,
  });
}

async function sendWebResponse(source: Response, target: ServerResponse): Promise<void> {
  if (target.destroyed || target.writableEnded) return;
  target.writeHead(source.status, Object.fromEntries(source.headers.entries()));
  if (!source.body) {
    target.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(source.body as never), target);
  } catch (error) {
    if (!target.destroyed) throw error;
  }
}

function terminalWorkAbsent(runtime: MorrowRuntime): boolean {
  return !runtime.hasActiveWork();
}

async function runDedicatedStdio(config: GatewayConfig): Promise<void> {
  const workspace = currentWorkspaceAdmission();
  const startupInput = new PassThrough({ highWaterMark: MAX_HTTP_BODY_BYTES });
  process.stdin.pipe(startupInput);
  let lease: RuntimeStateLease | null = null;
  let runtime: MorrowRuntime | null = null;
  let runtimeConnection: Promise<MorrowRuntime | null> | null = null;
  let serverHandle: StdioServerHandle | null = null;
  let closePromise: Promise<void> | null = null;
  let closing = false;
  const startupController = new AbortController();
  const close = (): Promise<void> => {
    closing = true;
    startupController.abort(new Error("Morrow dedicated runtime closed during startup."));
    closePromise ??= (async () => {
      try {
        if (serverHandle) await serverHandle.close();
        if (runtime) await runtime.close();
        else if (runtimeConnection) {
          await settlesWithin(runtimeConnection, OWNER_STARTUP_CLOSE_TIMEOUT_MS);
        }
      } finally {
        process.stdin.unpipe(startupInput);
        startupInput.destroy();
        lease?.release();
      }
    })();
    return closePromise;
  };
  lease = RuntimeStateLease.acquire(config.operationJournal.path, {
    onOwnershipLost: (error) => {
      console.error(`[morrow] runtime state lease lost: ${error.message}`);
      return close().finally(() => process.exit(1));
    },
  });
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  process.once("exit", () => lease?.release());
  startupInput.once("finish", () => void close());
  try {
    const connecting = (async (): Promise<MorrowRuntime | null> => {
      const connected = await MorrowRuntime.connect(config, {
        statePath: lease!.statePath,
        signal: startupController.signal,
      });
      if (!closing) return connected;
      await connected.close();
      return null;
    })();
    runtimeConnection = connecting;
    runtime = await connecting;
    if (runtimeConnection === connecting) runtimeConnection = null;
    if (!runtime) return;
    hardenMorrowStateFiles(lease.statePath);
    console.error(
      `[morrow] connected ${runtime.gateway.catalog.tools.length} upstream tools; `
      + `catalog=${runtime.gateway.catalog.digest}; state=${lease.statePath}; lease=active`,
    );
    serverHandle = serveStdio(() => createFullMorrowServer(runtime!, {
      workspaceRoot: workspace.root,
      proxyPid: process.pid,
    }), {
      onerror: (error) => console.error(`[morrow] protocol error ${error.message}`),
      transport: new StrictStdioServerTransport({ input: startupInput }),
    });
  } catch (error) {
    const interrupted = closing && startupController.signal.aborted;
    await close();
    if (interrupted) return;
    throw error;
  }
}

export async function runLocalOwner(config: GatewayConfig): Promise<void> {
  if (
    process.env.MORROW_INSTALLER_TEST_MODE === "1"
    && process.env.MORROW_LOCAL_OWNER_TEST_STUBBORN_STARTUP === "1"
  ) {
    console.error(`[morrow-test] stubborn local owner pid=${process.pid}`);
    process.on("SIGINT", () => undefined);
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1_000);
    await new Promise<void>(() => undefined);
  }
  const requestedJournalPath = durableJournalPath(config);
  if (!requestedJournalPath) throw new Error("Morrow local owner requires a durable operation journal path.");
  let leaseLossHandler: (error: Error) => void | Promise<void> = (error) => {
    console.error(`[morrow] runtime state lease lost before owner startup: ${error.message}`);
    process.exit(1);
  };
  const lease = RuntimeStateLease.acquire(requestedJournalPath, {
    onOwnershipLost: (error) => leaseLossHandler(error),
  });
  const journalPath = lease.statePath;
  if (localOwnerMaintenanceMarkerPresent(journalPath)) {
    lease.release();
    throw new Error("Morrow local owner is held for authenticated desktop maintenance.");
  }
  const configDigest = ownerConfigDigest(config);
  const startupRuntimeIdentity = localOwnerRuntimeIdentity();
  const nonce = randomUUID();
  let runtime: MorrowRuntime | null = null;
  let runtimeConnection: Promise<MorrowRuntime | null> | null = null;
  let httpServer: Server | null = null;
  let httpLifecycle: BoundedHttpServerLifecycle | null = null;
  let modernHandler: McpHttpHandler | null = null;
  let descriptor: OwnerDescriptor | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  const startupController = new AbortController();
  let activeMcpRequests = 0;
  let maintenanceState: "open" | "acquiring" | "held" = "open";
  let idleTimer: NodeJS.Timeout | null = null;
  let sessionReapTimer: NodeJS.Timeout | null = null;
  let startupGraceDeadline = 0;
  const sessions = new Map<string, Session>();
  const modernProxies = new Map<number, ProxyPresence>();

  const clientPresences = (): readonly ClientPresence[] => [
    ...sessions.values(),
    ...modernProxies.values(),
  ];

  const removeModernProxy = (presence: ProxyPresence): void => {
    if (modernProxies.get(presence.proxyPid) !== presence) return;
    modernProxies.delete(presence.proxyPid);
    presence.privateChatContinuations.clear();
    presence.requestStateKey.fill(0);
  };

  const hasClientPresence = (): boolean => sessions.size !== 0 || modernProxies.size !== 0;

  const clearIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const clearSessionReap = (): void => {
    if (sessionReapTimer) clearTimeout(sessionReapTimer);
    sessionReapTimer = null;
  };

  const closeSession = async (session: Session): Promise<void> => {
    if (session.id) sessions.delete(session.id);
    await session.server.close();
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    startupController.abort(new Error("Morrow local owner closed during startup."));
    closePromise = (async () => {
      clearIdle();
      clearSessionReap();
      try {
        const httpClosing = httpLifecycle?.close();
        if (modernHandler) await modernHandler.close();
        if (httpClosing) await httpClosing;
        await Promise.all([...sessions.values()].map((session) => closeSession(session).catch(() => undefined)));
        sessions.clear();
        for (const presence of [...modernProxies.values()]) removeModernProxy(presence);
        if (runtime) await runtime.close();
        else if (runtimeConnection) {
          await settlesWithin(runtimeConnection, OWNER_STARTUP_CLOSE_TIMEOUT_MS);
        }
      } finally {
        if (descriptor) removeOwnerDescriptor(journalPath, descriptor.nonce);
        lease.release();
      }
    })();
    return closePromise;
  };
  leaseLossHandler = (error) => {
    console.error(`[morrow] runtime state lease lost: ${error.message}`);
    return close().finally(() => process.exit(1));
  };

  const scheduleIdle = (): void => {
    if (closing || hasClientPresence() || activeMcpRequests !== 0 || !runtime || maintenanceState !== "open") return;
    if (idleTimer) return;
    const delay = startupGraceDeadline > Date.now()
      ? startupGraceDeadline - Date.now()
      : terminalWorkAbsent(runtime) ? OWNER_IDLE_MS : OWNER_PENDING_IDLE_CHECK_MS;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (hasClientPresence() || activeMcpRequests !== 0 || !runtime || maintenanceState !== "open") return;
      if (startupGraceDeadline > Date.now() || !terminalWorkAbsent(runtime)) {
        scheduleIdle();
        return;
      }
      void close().finally(() => process.exit(0));
    }, delay);
    idleTimer.unref();
  };

  const scheduleSessionReap = (): void => {
    if (closing || !hasClientPresence() || sessionReapTimer) return;
    sessionReapTimer = setTimeout(() => {
      sessionReapTimer = null;
      const dead = [...sessions.values()].filter((session) => requestPathProcessMatches(session.proxyPid, session.observedAt) === false);
      for (const session of dead) removeSession(session);
      for (const presence of [...modernProxies.values()]) {
        if (requestPathProcessMatches(presence.proxyPid, presence.observedAt) === false) {
          removeModernProxy(presence);
        }
      }
      if (!hasClientPresence()) scheduleIdle();
      else scheduleSessionReap();
    }, OWNER_SESSION_REAP_MS);
    sessionReapTimer.unref();
  };

  const removeSession = (session: Session): void => {
    if (session.id) sessions.delete(session.id);
    void session.server.close().catch(() => undefined);
    if (!hasClientPresence()) clearSessionReap();
    else scheduleSessionReap();
    scheduleIdle();
  };

  const recordModernProxy = (proxyPid: number, workspace: WorkspaceAdmission): ProxyPresence | null => {
    const existing = modernProxies.get(proxyPid);
    if (existing) {
      const sameProcess = requestPathProcessMatches(existing.proxyPid, existing.observedAt);
      if (sameProcess !== false) return existing.workspace.encoded === workspace.encoded ? existing : null;
      removeModernProxy(existing);
    }
    const presence: ProxyPresence = {
      proxyPid,
      observedAt: new Date().toISOString(),
      workspace,
      requestStateKey: randomBytes(32),
      privateChatContinuations: new PrivateChatContinuationLedger(),
    };
    modernProxies.set(proxyPid, presence);
    startupGraceDeadline = 0;
    clearIdle();
    scheduleSessionReap();
    return presence;
  };

  const createSession = async (proxyPid: number, workspace: WorkspaceAdmission): Promise<Session> => {
    if (!runtime || !descriptor) throw new Error("Morrow local owner is not ready.");
    let session: Session;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      allowedHosts: [`${LOOPBACK_HOST}:${descriptor.port}`],
      enableDnsRebindingProtection: true,
      onsessioninitialized: (sessionId) => {
        session.id = sessionId;
        sessions.set(sessionId, session);
        startupGraceDeadline = 0;
        clearIdle();
        scheduleSessionReap();
      },
      onsessionclosed: () => {
        removeSession(session);
      },
    });
    // The client identity a record names comes from this session: the stdio
    // process that connected, the project it was admitted for, and the name the
    // assistant reports at initialize.
    const server = createFullMorrowServer(runtime, { workspaceRoot: workspace.root, proxyPid });
    session = { id: null, proxyPid, observedAt: new Date().toISOString(), workspace, server, transport };
    await server.connect(transport);
    return session;
  };

  const currentOwnerMatches = (): boolean => {
    if (!descriptor) return false;
    const fresh = readOwnerDescriptor(journalPath);
    return fresh?.nonce === descriptor.nonce
      && fresh.pid === descriptor.pid
      && fresh.port === descriptor.port
      && fresh.journalPath === descriptor.journalPath
      && fresh.configDigest === descriptor.configDigest
      && exactAuthorization(`Bearer ${fresh.token}`, descriptor.token);
  };

  const reopenAfterFailedMaintenance = (): void => {
    maintenanceState = "open";
    runtime?.approval.setMaintenanceAdmission(true);
    scheduleIdle();
  };

  const maintenanceError = (response: ServerResponse, code: string): void => {
    sendProblem(response, 409, code);
  };

  const handleMaintenance = async (
    request: IncomingMessage,
    response: ServerResponse,
    proxyPid: number,
    workspace: WorkspaceAdmission,
    signal: AbortSignal,
  ): Promise<void> => {
    if (request.method !== "POST" || !requestLengthIsAllowed(request)) {
      sendProblem(response, 405, "local_owner_maintenance_method_required");
      return;
    }
    const input = await readMaintenanceRequest(request);
    signal.throwIfAborted();
    if (!input || input.holderPid !== proxyPid || !processAlive(input.holderPid)) {
      maintenanceError(response, "local_owner_maintenance_request_invalid");
      return;
    }
    if (!currentOwnerMatches() || !runtime || !descriptor) {
      maintenanceError(response, "local_owner_maintenance_owner_changed");
      return;
    }
    // A client from a newer installed build asks this owner to stand down. It
    // retires only when its own install path now holds exactly that build and
    // it started from a different one, and only with no request or effect in
    // flight. A connected but idle client does not keep an outdated build in
    // service: it reconnects and starts the current owner.
    if (input.action === "retire") {
      const requested = input.runtimeIdentity;
      if (!requested || requested === "source" || requested === startupRuntimeIdentity
        || requested !== localOwnerRuntimeIdentity()) {
        maintenanceError(response, "local_owner_retire_refused");
        return;
      }
      if (maintenanceState !== "open" || localOwnerMaintenanceMarkerPresent(journalPath)) {
        maintenanceError(response, "local_owner_maintenance_work_active");
        return;
      }
      maintenanceState = "acquiring";
      runtime.approval.setMaintenanceAdmission(false);
      if (activeMcpRequests !== 0 || !runtime.maintenanceQuiescent()) {
        reopenAfterFailedMaintenance();
        maintenanceError(response, "local_owner_maintenance_work_active");
        return;
      }
      maintenanceState = "held";
      response.writeHead(202, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
      response.once("finish", () => {
        void close().finally(() => process.exit(0));
      });
      response.end(JSON.stringify({ schema: "morrow.local-owner-maintenance.v1", status: "retiring" }));
      return;
    }
      if (input.action === "recover") {
        const marker = readLocalOwnerMaintenanceLease(journalPath);
        for (const session of [...sessions.values()]) {
          if (requestPathProcessMatches(session.proxyPid, session.observedAt) === false) removeSession(session);
        }
        for (const presence of [...modernProxies.values()]) {
          if (requestPathProcessMatches(presence.proxyPid, presence.observedAt) === false) {
            removeModernProxy(presence);
          }
        }
        if (maintenanceState !== "held" || !marker || !input.leaseId || !input.leaseToken
          || activeMcpRequests !== 0 || hasClientPresence() || !runtime.maintenanceQuiescent()) {
        maintenanceError(response, "local_owner_maintenance_work_active");
        return;
      }
      const recovered = recoverExactLocalOwnerMaintenanceLease(descriptor, {
        holderPid: input.holderPid,
        workspaceRoot: workspace.root,
        previousLeaseId: input.leaseId,
        previousLeaseToken: input.leaseToken,
      });
      if (!recovered) {
        maintenanceError(response, "local_owner_maintenance_recovery_refused");
        return;
      }
      response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
      response.end(JSON.stringify({
        schema: "morrow.local-owner-maintenance.v1",
        status: "recovered",
        leaseId: recovered.leaseId,
        leaseToken: recovered.leaseToken,
        ownerNonce: descriptor.nonce,
        holderPid: recovered.holderPid,
      }));
      return;
    }
    if (input.action === "bridge") {
      const control = normalizeLocalOwnerBridgeMaintenanceControl(input.control);
      if (!control) {
        maintenanceError(response, "local_owner_bridge_maintenance_invalid");
        return;
      }
      if (control.action !== "status") {
        const leaseRecord = readLocalOwnerMaintenanceLease(journalPath);
        if (maintenanceState !== "held" || !leaseRecord || !input.leaseId || !input.leaseToken
          || activeMcpRequests !== 0 || !runtime.maintenanceQuiescent()
          || !localOwnerMaintenanceMatches(leaseRecord, descriptor, input.holderPid, workspace.root, input.leaseId, input.leaseToken)) {
          maintenanceError(response, "local_owner_maintenance_lease_required");
          return;
        }
      }
      try {
        const result = await runtime.bridgeMaintenance(control);
        response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
        response.end(JSON.stringify({ schema: "morrow.local-owner-maintenance.v1", status: "bridge", result }));
      } catch {
        maintenanceError(response, "local_owner_bridge_maintenance_unavailable");
      }
      return;
    }
    if (input.action === "acquire") {
      const monitorProxyPid = input.monitorProxyPid;
      if (monitorProxyPid === undefined) {
        maintenanceError(response, "local_owner_maintenance_request_invalid");
        return;
      }
      if (maintenanceState !== "open" || localOwnerMaintenanceMarkerPresent(journalPath)) {
        maintenanceError(response, "local_owner_maintenance_already_held");
        return;
      }
      maintenanceState = "acquiring";
      runtime.approval.setMaintenanceAdmission(false);
      for (const session of [...sessions.values()]) {
        if (requestPathProcessMatches(session.proxyPid, session.observedAt) === false) removeSession(session);
      }
      for (const presence of [...modernProxies.values()]) {
        if (requestPathProcessMatches(presence.proxyPid, presence.observedAt) === false) {
          removeModernProxy(presence);
        }
      }
      const monitorSessions = clientPresences();
      const monitorOnly = monitorSessions.every((session) => session.proxyPid === monitorProxyPid);
      const monitorPresent = monitorSessions.some((session) => session.proxyPid === monitorProxyPid);
      const monitorLifetimes = await Promise.all(monitorSessions
        .filter((session) => session.proxyPid === monitorProxyPid)
        .map((session) => processMatchesRecordedLifetimeAsync(session.proxyPid, session.observedAt)));
      const monitorAlive = monitorLifetimes.length > 0
        && monitorLifetimes.every((lifetime) => lifetime === true);
      // Each condition has its own answer. One code for all of them leaves the
      // person, and anyone helping them, with no way to tell which is true.
      const refusal = activeMcpRequests !== 0
        ? "local_owner_request_in_flight"
        : !runtime.maintenanceQuiescent()
        ? "local_owner_approval_running"
        : !monitorPresent || !monitorOnly || !monitorAlive
        ? "local_owner_other_client_connected"
        : null;
      if (refusal) {
        reopenAfterFailedMaintenance();
        maintenanceError(response, refusal);
        return;
      }
      try {
        const leaseRecord = createLocalOwnerMaintenanceLease(descriptor, {
          holderPid: input.holderPid,
          monitorProxyPid,
          workspaceRoot: workspace.root,
        });
        writeLocalOwnerMaintenanceLease(leaseRecord);
        maintenanceState = "held";
        response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
        response.end(JSON.stringify({
          schema: "morrow.local-owner-maintenance.v1",
          status: "held",
          leaseId: leaseRecord.leaseId,
          leaseToken: leaseRecord.leaseToken,
          ownerNonce: leaseRecord.ownerNonce,
          holderPid: leaseRecord.holderPid,
          monitorProxyPid: leaseRecord.monitorProxyPid,
        }));
      } catch {
        reopenAfterFailedMaintenance();
        maintenanceError(response, "local_owner_maintenance_unconfirmed");
      }
      return;
    }
    const leaseRecord = readLocalOwnerMaintenanceLease(journalPath);
    if (maintenanceState !== "held" || !leaseRecord || !input.leaseId || !input.leaseToken
      || activeMcpRequests !== 0 || !runtime.maintenanceQuiescent()
      || !localOwnerMaintenanceMatches(leaseRecord, descriptor, input.holderPid, workspace.root, input.leaseId, input.leaseToken)) {
      maintenanceError(response, "local_owner_maintenance_lease_required");
      return;
    }
    if (input.action === "release") {
      if (!removeExactLocalOwnerMaintenanceLease(journalPath, input.leaseId, input.leaseToken)) {
        maintenanceError(response, "local_owner_maintenance_lease_changed");
        return;
      }
      runtime.approval.setMaintenanceAdmission(true);
      maintenanceState = "open";
      response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
      response.end(JSON.stringify({ schema: "morrow.local-owner-maintenance.v1", status: "released", leaseId: input.leaseId }));
      scheduleIdle();
      return;
    }
    response.writeHead(202, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
    response.once("finish", () => {
      void close().finally(() => process.exit(0));
    });
    response.end(JSON.stringify({ schema: "morrow.local-owner-maintenance.v1", status: "closing", leaseId: input.leaseId }));
  };

  const handleHttp = async (request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> => {
    clearIdle();
    let resolveDisconnect: (() => void) | null = null;
    const disconnected = new Promise<void>((resolveDisconnectPromise) => {
      resolveDisconnect = resolveDisconnectPromise;
    });
    const abortDisconnect = () => resolveDisconnect?.();
    if (signal.aborted) abortDisconnect();
    else signal.addEventListener("abort", abortDisconnect, { once: true });
    let countedMcpRequest = false;
    const finishMcpRequest = (): void => {
      if (!countedMcpRequest) return;
      countedMcpRequest = false;
      activeMcpRequests -= 1;
    };
    try {
      const proxyPid = proxyProcessId(request.headers[PROXY_PID_HEADER]);
      if (
        request.socket.remoteAddress !== LOOPBACK_HOST
        || request.headers.origin !== undefined
        || request.headers.host !== `${LOOPBACK_HOST}:${descriptor?.port}`
        || !exactAuthorization(request.headers.authorization, descriptor?.token || "")
        || proxyPid === null
      ) {
        sendProblem(response, 403, "local_owner_auth_required");
        return;
      }
      const workspace = admittedWorkspaceFromRequest(request);
      if (!workspace) {
        sendProblem(response, 403, "local_owner_workspace_required");
        return;
      }
      const url = new URL(request.url || "/", `http://${LOOPBACK_HOST}:${descriptor?.port || 0}`);
      if (url.pathname === LOCAL_OWNER_MAINTENANCE_PATH && !url.search) {
        await handleMaintenance(request, response, proxyPid, workspace, signal);
        return;
      }
      if (url.pathname !== OWNER_PATH || url.search || !["POST", "DELETE", "GET"].includes(request.method || "")) {
        sendProblem(response, 404, "local_owner_endpoint_not_found");
        return;
      }
      if (!requestLengthIsAllowed(request)) {
        rejectOversizedRequest(request, response);
        return;
      }
      if (request.method === "GET") {
        response.writeHead(405, { allow: "POST, DELETE" });
        response.end();
        return;
      }
      if (request.method === "POST") {
        if (maintenanceState !== "open") {
          maintenanceError(response, "local_owner_maintenance_held");
          return;
        }
        activeMcpRequests += 1;
        countedMcpRequest = true;
      }
      const webRequest = await asWebRequest(request, descriptor!.port, signal);
      if (modernHandler && !await isLegacyRequest(webRequest)) {
        if (!recordModernProxy(proxyPid, workspace)) {
          sendProblem(response, 403, "local_owner_session_workspace_required");
          return;
        }
        const webResponse = await Promise.race<Response | null>([
          modernHandler.fetch(webRequest),
          disconnected.then(() => null),
        ]);
        finishMcpRequest();
        if (webResponse) await sendWebResponse(webResponse, response);
        return;
      }
      const sessionId = typeof request.headers["mcp-session-id"] === "string"
        ? request.headers["mcp-session-id"]
        : "";
      let session: Session | undefined;
      let created = false;
      if (sessionId) {
        session = sessions.get(sessionId);
        if (!session) {
          sendProblem(response, 404, "local_owner_session_not_found");
          return;
        }
        if (session.proxyPid !== proxyPid) {
          sendProblem(response, 403, "local_owner_session_owner_required");
          return;
        }
        if (session.workspace.encoded !== workspace.encoded) {
          sendProblem(response, 403, "local_owner_session_workspace_required");
          return;
        }
      } else if (request.method === "POST") {
        session = await createSession(proxyPid, workspace);
        created = true;
      } else {
        sendProblem(response, 400, "local_owner_session_required");
        return;
      }
      const webResponse = await Promise.race<Response | null>([
        session.transport.handleRequest(webRequest),
        disconnected.then(() => null),
      ]);
      if (webResponse && session.server.server.getNegotiatedProtocolVersion() === MODERN_PROTOCOL_VERSION
        && !recordModernProxy(proxyPid, workspace)) {
        sendProblem(response, 403, "local_owner_session_workspace_required");
        return;
      }
      finishMcpRequest();
      if (webResponse) await sendWebResponse(webResponse, response);
      if (created && !session.id) await closeSession(session);
    } catch (error) {
      if (error instanceof HttpBodyTooLargeError) {
        rejectOversizedRequest(request, response);
        return;
      }
      if (error instanceof HttpBodyInvalidUtf8Error) {
        sendProblem(response, 400, "local_owner_message_invalid_utf8");
        return;
      }
      if (!response.writableEnded) sendProblem(response, 500, "local_owner_request_failed");
      if (!signal.aborted) console.error(`[morrow] local owner request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      signal.removeEventListener("abort", abortDisconnect);
      finishMcpRequest();
      scheduleIdle();
    }
  };

  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  process.once("exit", () => {
    if (descriptor) removeOwnerDescriptor(journalPath, descriptor.nonce);
    lease.release();
  });

  try {
    const connecting = (async (): Promise<MorrowRuntime | null> => {
      const connected = await MorrowRuntime.connect(config, {
        statePath: journalPath,
        signal: startupController.signal,
      });
      if (!closing) return connected;
      await connected.close();
      return null;
    })();
    runtimeConnection = connecting;
    runtime = await connecting;
    if (runtimeConnection === connecting) runtimeConnection = null;
    if (!runtime) return;
    hardenMorrowStateFiles(journalPath);
    modernHandler = createMcpHandler((context) => {
      if (!runtime || !context.requestInfo) throw new Error("Morrow local owner modern request context is unavailable.");
      const proxyPid = proxyProcessId(context.requestInfo.headers.get(PROXY_PID_HEADER) || undefined);
      const workspace = admittedWorkspaceFromEncoded(context.requestInfo.headers.get(PROXY_WORKSPACE_HEADER));
      if (proxyPid === null || !workspace) throw new Error("Morrow local owner modern request identity is invalid.");
      const presence = modernProxies.get(proxyPid);
      if (!presence || presence.workspace.encoded !== workspace.encoded) {
        throw new Error("Morrow local owner modern request presence is unavailable.");
      }
      return createFullMorrowServer(runtime, {
        workspaceRoot: workspace.root,
        proxyPid,
        requestStateKey: presence.requestStateKey,
        privateChatContinuations: presence.privateChatContinuations,
      });
    }, {
      legacy: "reject",
      onerror: (error) => console.error(`[morrow] local owner modern protocol error: ${error.message}`),
    });
    httpServer = createServer((request, response) => {
      const accepted = httpLifecycle?.accept(request, response);
      if (!accepted) {
        sendProblem(response, 503, "local_owner_closing");
        return;
      }
      void handleHttp(request, response, accepted.signal).finally(accepted.release);
    });
    httpLifecycle = new BoundedHttpServerLifecycle(httpServer);
    await new Promise<void>((resolveListen, rejectListen) => {
      httpServer!.once("error", rejectListen);
      httpServer!.listen(0, LOOPBACK_HOST, () => {
        httpServer!.off("error", rejectListen);
        resolveListen();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Morrow local owner did not bind a loopback address.");
    descriptor = {
      schema: OWNER_SCHEMA,
      nonce,
      pid: process.pid,
      port: (address as AddressInfo).port,
      token: randomBytes(32).toString("base64url"),
      journalPath,
      configDigest,
      startedAt: new Date().toISOString(),
    };
    writeOwnerDescriptor(journalPath, descriptor);
    startupGraceDeadline = Date.now() + OWNER_START_GRACE_MS;
    console.error(
      `[morrow] local owner ready; tools=${runtime.gateway.catalog.tools.length}; `
      + `catalog=${runtime.gateway.catalog.digest}; state=${journalPath}; lease=active`,
    );
    scheduleIdle();
  } catch (error) {
    const interrupted = closing && startupController.signal.aborted;
    await close();
    if (interrupted) return;
    throw error;
  }
}

/**
 * Asks a live owner whether it is still the build this client was installed
 * with. `current` means the owner may serve this client; `retiring` means it
 * accepted and is closing; `busy` means it is an outdated build with work in
 * flight. An owner that predates this request cannot report its build, so it
 * keeps its earlier behaviour and is treated as `current`.
 */
async function askOwnerToRetireForBuild(
  descriptor: OwnerDescriptor,
  runtimeIdentity: string,
): Promise<"current" | "retiring" | "busy"> {
  if (runtimeIdentity === "source") return "current";
  const workspace = currentWorkspaceAdmission();
  let response: Response;
  try {
    response = await fetch(new URL(LOCAL_OWNER_MAINTENANCE_PATH, `http://${LOOPBACK_HOST}:${descriptor.port}`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
        [PROXY_PID_HEADER]: String(process.pid),
        [PROXY_WORKSPACE_HEADER]: workspace.encoded,
      },
      body: JSON.stringify({
        schema: LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA,
        action: "retire",
        holderPid: process.pid,
        runtimeIdentity,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return "current";
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (response.status === 202 && record.status === "retiring") return "retiring";
  if (response.status === 409 && record.code === "local_owner_maintenance_work_active") return "busy";
  return "current";
}

async function waitForOwner(journalPath: string, configDigest: string): Promise<OwnerDescriptor> {
  const entryPath = process.argv[1];
  if (!entryPath) throw new Error("Morrow cannot locate its local owner entry point.");
  if (localOwnerMaintenanceMarkerPresent(journalPath)) {
    throw new Error("Morrow local owner is held for authenticated desktop maintenance.");
  }
  let launchedChild: ChildProcess | null = null;
  let launchError: Error | null = null;
  let ready = false;
  const deadline = Date.now() + ownerStartTimeoutMs();
  const runtimeIdentity = localOwnerRuntimeIdentity();
  const retirementChecked = new Set<string>();
  const retiringOwners = new Set<string>();
  try {
    for (;;) {
      if (launchError) throw launchError;
      const descriptor = readOwnerDescriptor(journalPath);
      const descriptorLifetime = descriptor
        ? await processMatchesRecordedLifetimeAsync(descriptor.pid, descriptor.startedAt)
        : false;
      if (descriptor && descriptorLifetime === true) {
        if (descriptor.configDigest !== configDigest) {
          throw new Error(
            "Morrow local owner configuration does not match this client. "
            + "Use the same Morrow upstream configuration for this operation journal.",
          );
        }
        if (!retirementChecked.has(descriptor.nonce)) {
          // An owner that accepted retirement is closing. It is never attached to, even when a
          // later request to it fails, because the failure would only mean it has begun to close.
          const build = retiringOwners.has(descriptor.nonce)
            ? "retiring"
            : await askOwnerToRetireForBuild(descriptor, runtimeIdentity);
          if (build === "current") {
            retirementChecked.add(descriptor.nonce);
          } else {
            if (build === "retiring") retiringOwners.add(descriptor.nonce);
            if (Date.now() >= deadline) {
              throw new Error("Morrow is finishing work on its previous version. Try again in a moment.");
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, build === "busy" ? 250 : 25));
            continue;
          }
        }
        if (launchedChild?.pid !== undefined && descriptor.pid !== launchedChild.pid) {
          await terminateLaunchedOwner(launchedChild);
          launchedChild = null;
        }
        ready = true;
        return descriptor;
      }
      if (descriptor && descriptorLifetime === false) removeOwnerDescriptor(journalPath, descriptor.nonce);
      if (!launchedChild) {
        const stderr = testOwnerStderrDescriptor();
        try {
          launchedChild = spawn(process.execPath, [entryPath, "--morrow-local-owner"], {
            detached: true,
            stdio: stderr === null ? "ignore" : ["ignore", "ignore", stderr],
            env: process.env,
            windowsHide: true,
          });
          launchedChild.once("error", (error) => { launchError = error; });
        } finally {
          if (stderr !== null) closeSync(stderr);
        }
        launchedChild.unref();
      }
      if (Date.now() >= deadline) throw new Error("Morrow local owner did not become ready.");
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  } finally {
    if (!ready && launchedChild) await terminateLaunchedOwner(launchedChild);
  }
}

async function closeProxy(
  stdio: StrictStdioServerTransport,
  http: StreamableHTTPClientTransport,
  state: { closed: boolean },
): Promise<void> {
  if (state.closed) return;
  state.closed = true;
  try {
    await Promise.race([
      http.terminateSession().catch(() => undefined),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  } finally {
    await http.close();
    await stdio.close();
  }
}

export async function runLocalOwnerProxy(config: GatewayConfig): Promise<void> {
  const requestedJournalPath = durableJournalPath(config);
  if (!requestedJournalPath) {
    await runDedicatedStdio(config);
    return;
  }
  const journalPath = canonicalLocalOwnerJournalPath(requestedJournalPath);
  const workspace = currentWorkspaceAdmission();
  const descriptor = await waitForOwner(journalPath, ownerConfigDigest(config));
  const http = new StreamableHTTPClientTransport(ownerUrl(descriptor), {
    requestInit: {
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        [PROXY_PID_HEADER]: String(process.pid),
        [PROXY_WORKSPACE_HEADER]: workspace.encoded,
      },
    },
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const stdio = new StrictStdioServerTransport();
  const state = { closed: false };
  let initialization: Promise<void> | null = null;
  let initialized = false;
  let initializationId: string | number | null = null;
  let modernProtocol = false;
  const activeModernRequests = new Map<string, AbortController>();
  const settleModernRequest = (id: ModernRequestId, controller?: AbortController): void => {
    const key = modernRequestKey(id);
    if (controller && activeModernRequests.get(key) !== controller) return;
    activeModernRequests.delete(key);
  };
  const close = async (): Promise<void> => {
    for (const controller of activeModernRequests.values()) {
      controller.abort(new Error("Morrow local owner proxy closed."));
    }
    activeModernRequests.clear();
    await closeProxy(stdio, http, state);
  };
  const fail = (error: unknown): void => {
    if (state.closed) return;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[morrow] local owner connection failed: ${detail}`);
    void close().finally(() => process.exit(1));
  };

  http.onmessage = (message: JSONRPCMessage) => {
    if ("id" in message && ("result" in message || "error" in message)
      && (typeof message.id === "string" || typeof message.id === "number")) {
      settleModernRequest(message.id);
    }
    if (
      initializationId !== null
      && "id" in message
      && message.id === initializationId
      && "result" in message
      && message.result
      && typeof message.result === "object"
      && typeof (message.result as { protocolVersion?: unknown }).protocolVersion === "string"
    ) {
      http.setProtocolVersion((message.result as { protocolVersion: string }).protocolVersion);
    }
    void stdio.send(message).catch(fail);
  };
  http.onerror = fail;
  stdio.onerror = (error) => console.error(`[morrow] protocol error ${error.message}`);
  stdio.onmessage = (message: JSONRPCMessage) => {
    const send = async (): Promise<void> => {
      if (state.closed) return;
      const envelopeVersion = modernMessageProtocol(message);
      if (envelopeVersion === MODERN_PROTOCOL_VERSION) {
        modernProtocol = true;
        http.setProtocolVersion(envelopeVersion);
      }
      const cancelledId = modernProtocol ? cancelledModernRequestId(message) : null;
      if (cancelledId !== null) {
        const key = modernRequestKey(cancelledId);
        const controller = activeModernRequests.get(key);
        if (controller) {
          activeModernRequests.delete(key);
          controller.abort(new Error("The MCP client cancelled this request."));
          return;
        }
      }
      const requestId = modernProtocol ? modernRequestId(message) : null;
      if (requestId === null) {
        await http.send(message);
        return;
      }
      const key = modernRequestKey(requestId);
      if (activeModernRequests.has(key) || activeModernRequests.size >= MAX_ACTIVE_MODERN_PROXY_REQUESTS) {
        await stdio.send({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32600, message: "Morrow refused an invalid or excessive concurrent request." },
        });
        return;
      }
      const controller = new AbortController();
      activeModernRequests.set(key, controller);
      try {
        await http.send(message, {
          requestSignal: controller.signal,
          onRequestStreamEnd: () => settleModernRequest(requestId, controller),
        });
      } catch (error) {
        settleModernRequest(requestId, controller);
        if (!controller.signal.aborted) throw error;
      }
    };
    if (!initialized && !initialization && "method" in message && message.method === "initialize") {
      const protocolVersion = message.params
        && typeof message.params === "object"
        && typeof (message.params as { protocolVersion?: unknown }).protocolVersion === "string"
        ? (message.params as { protocolVersion: string }).protocolVersion
        : null;
      if (protocolVersion) {
        modernProtocol = protocolVersion === MODERN_PROTOCOL_VERSION;
        http.setProtocolVersion(protocolVersion);
      }
      initializationId = "id" in message && (typeof message.id === "string" || typeof message.id === "number")
        ? message.id
        : null;
      initialization = send().then(() => {
        initialized = true;
      });
      void initialization.catch(fail);
      return;
    }
    if (initialization) {
      void initialization.then(send).catch(fail);
      return;
    }
    void send().catch(fail);
  };
  stdio.onclose = () => void close();
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await http.start();
  await stdio.start();
}
