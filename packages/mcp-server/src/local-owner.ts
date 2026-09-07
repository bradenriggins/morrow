import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  lstatSync,
  openSync,
  realpathSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  StreamableHTTPClientTransport,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client";
import {
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { sha256Json } from "@morrow/contracts";
import type { GatewayConfig } from "./config.js";
import { createFullMorrowServer } from "./full-server.js";
import { MorrowRuntime } from "./morrow-runtime.js";
import {
  LOCAL_OWNER_MAINTENANCE_PATH,
  LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA,
  createLocalOwnerMaintenanceLease,
  localOwnerMaintenanceMarkerPresent,
  localOwnerMaintenanceMatches,
  normalizeLocalOwnerBridgeMaintenanceControl,
  readLocalOwnerMaintenanceLease,
  recoverExactLocalOwnerMaintenanceLease,
  removeExactLocalOwnerMaintenanceLease,
  writeLocalOwnerMaintenanceLease,
} from "./local-owner-maintenance.js";
import { localOwnerSidecarAccessAccepted } from "./local-owner-sidecar-access.js";
import { RuntimeStateLease, hardenMorrowStateFiles } from "./state-lease.js";
import { StrictStdioServerTransport } from "./strict-stdio.js";

const OWNER_SCHEMA = "morrow.local-owner.v1";
const LOOPBACK_HOST = "127.0.0.1";
const OWNER_PATH = "/mcp";
const PROXY_PID_HEADER = "x-morrow-proxy-pid";
const PROXY_WORKSPACE_HEADER = "x-morrow-workspace";
const OWNER_START_TIMEOUT_MS = 30_000;
const OWNER_START_GRACE_MS = 30_000;
const OWNER_IDLE_MS = 1_000;
const OWNER_PENDING_IDLE_CHECK_MS = 1_000;
const OWNER_SESSION_REAP_MS = 1_000;
const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACE_HEADER_CHARS = 4_096;
const MAX_WORKSPACE_ROOT_BYTES = 3_072;

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

interface Session {
  id: string | null;
  readonly proxyPid: number;
  readonly workspace: WorkspaceAdmission;
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

interface MaintenanceRequest {
  readonly action: "acquire" | "release" | "commit" | "recover" | "bridge";
  readonly holderPid: number;
  readonly monitorProxyPid?: number;
  readonly leaseId?: string;
  readonly leaseToken?: string;
  readonly control?: unknown;
}

function durableJournalPath(config: GatewayConfig): string | null {
  const value = String(config.operationJournal.path || "").trim();
  return value && value !== ":memory:" ? resolve(value) : null;
}

function ownerDescriptorPath(journalPath: string): string {
  return `${journalPath}.local-owner.json`;
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

function safeChmod(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* best effort on non-POSIX filesystems */ }
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
    const parsed = JSON.parse(value) as Partial<OwnerDescriptor>;
    if (
      parsed.schema !== OWNER_SCHEMA
      || typeof parsed.nonce !== "string"
      || !/^[0-9a-f-]{36}$/i.test(parsed.nonce)
      || !Number.isSafeInteger(parsed.pid)
      || Number(parsed.pid) < 1
      || !Number.isSafeInteger(parsed.port)
      || Number(parsed.port) < 1
      || Number(parsed.port) > 65_535
      || typeof parsed.token !== "string"
      || !/^[A-Za-z0-9_-]{40,160}$/.test(parsed.token)
      || typeof parsed.journalPath !== "string"
      || resolve(parsed.journalPath) !== journalPath
      || typeof parsed.configDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(parsed.configDigest)
      || typeof parsed.startedAt !== "string"
    ) return null;
    return parsed as OwnerDescriptor;
  } catch {
    return null;
  }
}

function readOwnerDescriptor(journalPath: string): OwnerDescriptor | null {
  const path = ownerDescriptorPath(journalPath);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !localOwnerSidecarAccessAccepted(path, stat.mode)) return null;
    return parseOwnerDescriptor(readFileSync(path, "utf8"), journalPath);
  } catch {
    return null;
  }
}

function removeOwnerDescriptor(journalPath: string, nonce: string): void {
  const path = ownerDescriptorPath(journalPath);
  const current = readOwnerDescriptor(journalPath);
  if (current?.nonce !== nonce) return;
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writeOwnerDescriptor(journalPath: string, descriptor: OwnerDescriptor): void {
  const path = ownerDescriptorPath(journalPath);
  const temporary = `${path}.${descriptor.nonce}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    safeChmod(temporary, 0o600);
    renameSync(temporary, path);
    safeChmod(path, 0o600);
    safeChmod(dirname(path), 0o700);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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
  if (!encoded || encoded.length > MAX_WORKSPACE_HEADER_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_WORKSPACE_ROOT_BYTES || bytes.toString("base64url") !== encoded) return null;
  const root = bytes.toString("utf8");
  if (!Buffer.from(root, "utf8").equals(bytes)) return null;
  return admittedWorkspace(root, encoded);
}

function sendProblem(response: ServerResponse, status: number, code: string): void {
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

function exactMaintenanceRequest(value: unknown): MaintenanceRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const action = source.action;
  const base = source.schema === LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA
    && (action === "acquire" || action === "release" || action === "commit" || action === "recover" || action === "bridge")
    && Object.entries(source).every(([key]) => ["schema", "action", "holderPid", "monitorProxyPid", "leaseId", "leaseToken", "control"].includes(key));
  const holderPid = exactPid(source.holderPid);
  const monitorProxyPid = exactPid(source.monitorProxyPid);
  if (!base || holderPid === null) return null;
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

async function readMaintenanceRequest(request: IncomingMessage): Promise<MaintenanceRequest | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.byteLength;
    if (bytes > 8_192) return null;
    chunks.push(chunk);
  }
  try { return exactMaintenanceRequest(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { return null; }
}

function asWebRequest(request: IncomingMessage, port: number, signal: AbortSignal): Request {
  const method = request.method || "GET";
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>;
  return new Request(`http://${LOOPBACK_HOST}:${port}${request.url || "/"}`, {
    method,
    headers: requestHeaders(request),
    ...(body ? { body, duplex: "half" } : {}),
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

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function runDedicatedStdio(config: GatewayConfig): Promise<void> {
  const workspace = currentWorkspaceAdmission();
  const lease = RuntimeStateLease.acquire(config.operationJournal.path);
  let runtime: MorrowRuntime | null = null;
  let serverHandle: StdioServerHandle | null = null;
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      if (serverHandle) await serverHandle.close();
      if (runtime) await runtime.close();
    } finally {
      lease.release();
    }
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  process.once("exit", () => lease.release());
  process.stdin.once("end", () => void close());
  try {
    runtime = await MorrowRuntime.connect(config);
    hardenMorrowStateFiles(config.operationJournal.path);
    console.error(
      `[morrow] connected ${runtime.gateway.catalog.tools.length} upstream tools; `
      + `catalog=${runtime.gateway.catalog.digest}; state=${config.operationJournal.path}; lease=active`,
    );
    serverHandle = serveStdio(() => createFullMorrowServer(runtime!, {
      workspaceRoot: workspace.root,
      proxyPid: process.pid,
    }), {
      onerror: (error) => console.error(`[morrow] protocol error ${error.message}`),
      transport: new StrictStdioServerTransport(),
    });
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runLocalOwner(config: GatewayConfig): Promise<void> {
  const journalPath = durableJournalPath(config);
  if (!journalPath) throw new Error("Morrow local owner requires a durable operation journal path.");
  if (localOwnerMaintenanceMarkerPresent(journalPath)) {
    throw new Error("Morrow local owner is held for authenticated desktop maintenance.");
  }
  const configDigest = ownerConfigDigest(config);
  const lease = RuntimeStateLease.acquire(journalPath);
  const nonce = randomUUID();
  let runtime: MorrowRuntime | null = null;
  let httpServer: Server | null = null;
  let descriptor: OwnerDescriptor | null = null;
  let closing = false;
  let activeMcpRequests = 0;
  let maintenanceState: "open" | "acquiring" | "held" = "open";
  let idleTimer: NodeJS.Timeout | null = null;
  let sessionReapTimer: NodeJS.Timeout | null = null;
  let startupGraceDeadline = 0;
  const sessions = new Map<string, Session>();

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

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearIdle();
    clearSessionReap();
    try {
      if (httpServer) await closeHttpServer(httpServer);
      await Promise.all([...sessions.values()].map((session) => closeSession(session).catch(() => undefined)));
      sessions.clear();
      if (runtime) await runtime.close();
    } finally {
      if (descriptor) removeOwnerDescriptor(journalPath, descriptor.nonce);
      lease.release();
    }
  };

  const scheduleIdle = (): void => {
    if (closing || sessions.size !== 0 || activeMcpRequests !== 0 || !runtime || maintenanceState !== "open") return;
    if (idleTimer) return;
    const delay = startupGraceDeadline > Date.now()
      ? startupGraceDeadline - Date.now()
      : terminalWorkAbsent(runtime) ? OWNER_IDLE_MS : OWNER_PENDING_IDLE_CHECK_MS;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (sessions.size !== 0 || activeMcpRequests !== 0 || !runtime || maintenanceState !== "open") return;
      if (startupGraceDeadline > Date.now() || !terminalWorkAbsent(runtime)) {
        scheduleIdle();
        return;
      }
      void close().finally(() => process.exit(0));
    }, delay);
    idleTimer.unref();
  };

  const scheduleSessionReap = (): void => {
    if (closing || sessions.size === 0 || sessionReapTimer) return;
    sessionReapTimer = setTimeout(() => {
      sessionReapTimer = null;
      const dead = [...sessions.values()].filter((session) => !processAlive(session.proxyPid));
      for (const session of dead) removeSession(session);
      if (sessions.size === 0) scheduleIdle();
      else scheduleSessionReap();
    }, OWNER_SESSION_REAP_MS);
    sessionReapTimer.unref();
  };

  const removeSession = (session: Session): void => {
    if (session.id) sessions.delete(session.id);
    void session.server.close().catch(() => undefined);
    if (sessions.size === 0) clearSessionReap();
    else scheduleSessionReap();
    scheduleIdle();
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
    session = { id: null, proxyPid, workspace, server, transport };
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
  ): Promise<void> => {
    if (request.method !== "POST" || !requestLengthIsAllowed(request)) {
      sendProblem(response, 405, "local_owner_maintenance_method_required");
      return;
    }
    const input = await readMaintenanceRequest(request);
    if (!input || input.holderPid !== proxyPid || !processAlive(input.holderPid)) {
      maintenanceError(response, "local_owner_maintenance_request_invalid");
      return;
    }
    if (!currentOwnerMatches() || !runtime || !descriptor) {
      maintenanceError(response, "local_owner_maintenance_owner_changed");
      return;
    }
    if (input.action === "recover") {
      const marker = readLocalOwnerMaintenanceLease(journalPath);
      for (const session of [...sessions.values()]) {
        if (!processAlive(session.proxyPid)) removeSession(session);
      }
      if (maintenanceState !== "held" || !marker || !input.leaseId || !input.leaseToken
        || activeMcpRequests !== 0 || sessions.size !== 0 || !runtime.maintenanceQuiescent()) {
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
      const monitorSessions = [...sessions.values()];
      const monitorOnly = monitorSessions.every((session) => session.proxyPid === monitorProxyPid);
      const monitorPresent = monitorSessions.some((session) => session.proxyPid === monitorProxyPid);
      const monitorAlive = processAlive(monitorProxyPid);
      if (activeMcpRequests !== 0 || !monitorPresent || !monitorOnly || !monitorAlive || !runtime.maintenanceQuiescent()) {
        reopenAfterFailedMaintenance();
        maintenanceError(response, "local_owner_maintenance_work_active");
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

  const handleHttp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    clearIdle();
    const abort = new AbortController();
    const abortRequest = () => abort.abort();
    request.once("aborted", abortRequest);
    response.once("close", () => {
      if (!response.writableEnded) abort.abort();
    });
    let resolveDisconnect: (() => void) | null = null;
    const disconnected = new Promise<void>((resolveDisconnectPromise) => {
      resolveDisconnect = resolveDisconnectPromise;
    });
    const abortDisconnect = () => resolveDisconnect?.();
    if (abort.signal.aborted) abortDisconnect();
    else abort.signal.addEventListener("abort", abortDisconnect, { once: true });
    let countedMcpRequest = false;
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
        await handleMaintenance(request, response, proxyPid, workspace);
        return;
      }
      if (url.pathname !== OWNER_PATH || url.search || !["POST", "DELETE", "GET"].includes(request.method || "")) {
        sendProblem(response, 404, "local_owner_endpoint_not_found");
        return;
      }
      if (!requestLengthIsAllowed(request)) {
        sendProblem(response, 413, "local_owner_message_too_large");
        return;
      }
      if (request.method === "GET") {
        response.writeHead(405, { allow: "POST, DELETE" });
        response.end();
        return;
      }
      const sessionId = typeof request.headers["mcp-session-id"] === "string"
        ? request.headers["mcp-session-id"]
        : "";
      let session: Session | undefined;
      let created = false;
      if (request.method === "POST") {
        if (maintenanceState !== "open") {
          maintenanceError(response, "local_owner_maintenance_held");
          return;
        }
        activeMcpRequests += 1;
        countedMcpRequest = true;
      }
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
        session.transport.handleRequest(asWebRequest(request, descriptor!.port, abort.signal)),
        disconnected.then(() => null),
      ]);
      if (webResponse) await sendWebResponse(webResponse, response);
      if (created && !session.id) await closeSession(session);
    } catch (error) {
      if (!response.writableEnded) sendProblem(response, 500, "local_owner_request_failed");
      console.error(`[morrow] local owner request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      request.off("aborted", abortRequest);
      abort.signal.removeEventListener("abort", abortDisconnect);
      if (countedMcpRequest) activeMcpRequests -= 1;
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
    runtime = await MorrowRuntime.connect(config, { statePath: journalPath });
    hardenMorrowStateFiles(journalPath);
    httpServer = createServer((request, response) => void handleHttp(request, response));
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
    await close();
    throw error;
  }
}

async function waitForOwner(journalPath: string, configDigest: string): Promise<OwnerDescriptor> {
  const entryPath = process.argv[1];
  if (!entryPath) throw new Error("Morrow cannot locate its local owner entry point.");
  if (localOwnerMaintenanceMarkerPresent(journalPath)) {
    throw new Error("Morrow local owner is held for authenticated desktop maintenance.");
  }
  let launched = false;
  const deadline = Date.now() + OWNER_START_TIMEOUT_MS;
  for (;;) {
    const descriptor = readOwnerDescriptor(journalPath);
    if (descriptor && processAlive(descriptor.pid)) {
      if (descriptor.configDigest !== configDigest) {
        throw new Error(
          "Morrow local owner configuration does not match this client. "
          + "Use the same Morrow upstream configuration for this operation journal.",
        );
      }
      return descriptor;
    }
    if (descriptor && !processAlive(descriptor.pid)) removeOwnerDescriptor(journalPath, descriptor.nonce);
    if (!launched) {
      const stderr = testOwnerStderrDescriptor();
      let child;
      try {
        child = spawn(process.execPath, [entryPath, "--morrow-local-owner"], {
          detached: true,
          stdio: stderr === null ? "ignore" : ["ignore", "ignore", stderr],
          env: process.env,
          windowsHide: true,
        });
      } finally {
        if (stderr !== null) closeSync(stderr);
      }
      child.unref();
      launched = true;
    }
    if (Date.now() >= deadline) throw new Error("Morrow local owner did not become ready.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
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
  const journalPath = durableJournalPath(config);
  if (!journalPath) {
    await runDedicatedStdio(config);
    return;
  }
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
  const close = async (): Promise<void> => closeProxy(stdio, http, state);
  const fail = (error: unknown): void => {
    if (state.closed) return;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[morrow] local owner connection failed: ${detail}`);
    void close();
  };

  http.onmessage = (message: JSONRPCMessage) => {
    void stdio.send(message).catch(fail);
  };
  http.onerror = fail;
  stdio.onerror = (error) => console.error(`[morrow] protocol error ${error.message}`);
  stdio.onmessage = (message: JSONRPCMessage) => {
    const send = async (): Promise<void> => {
      if (!state.closed) await http.send(message);
    };
    if (!initialized && !initialization && "method" in message && message.method === "initialize") {
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
