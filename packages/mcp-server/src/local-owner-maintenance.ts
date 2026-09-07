import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { chmodSync, lstatSync, linkSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { localOwnerSidecarAccessAccepted } from "./local-owner-sidecar-access.js";

export const LOCAL_OWNER_MAINTENANCE_SCHEMA = "morrow.local-owner-maintenance.v1";
export const LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA = "morrow.local-owner-maintenance.request.v1";
export const LOCAL_OWNER_MAINTENANCE_PATH = "/morrow-maintenance/v1";
const LOCAL_OWNER_SCHEMA = "morrow.local-owner.v1";
const LOOPBACK_HOST = "127.0.0.1";

export type LocalOwnerBridgeMaintenanceControl =
  | { readonly action: "status" }
  | { readonly action: "quiesce" }
  | { readonly action: "readback" }
  | { readonly action: "resume"; readonly quiesceEpoch: string; readonly fileLayerRestored: true };

export interface LocalOwnerIdentity {
  readonly nonce: string;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly journalPath: string;
  readonly configDigest: string;
}

export interface LocalOwnerMaintenanceLease {
  readonly schema: typeof LOCAL_OWNER_MAINTENANCE_SCHEMA;
  readonly leaseId: string;
  readonly leaseToken: string;
  readonly ownerNonce: string | null;
  readonly ownerPid: number | null;
  readonly ownerPort: number | null;
  readonly ownerTokenDigest: string | null;
  readonly journalPath: string;
  readonly configDigest: string;
  readonly holderPid: number;
  readonly monitorProxyPid: number;
  readonly workspaceRoot: string;
  readonly acquiredAt: string;
  readonly recovery: boolean;
}

export interface LocalOwnerMaintenanceAcquireInput {
  readonly holderPid: number;
  readonly monitorProxyPid: number;
  readonly workspaceRoot: string;
}

export interface LocalOwnerMaintenanceOwnerRecoveryInput {
  readonly holderPid: number;
  readonly workspaceRoot: string;
  readonly previousLeaseId: string;
  readonly previousLeaseToken: string;
  readonly processAlive?: (pid: number) => boolean;
}

export interface LocalOwnerMaintenanceClearInput {
  readonly workspaceRoot: string;
  /** The new desktop holder after a private recovery, when applicable. */
  readonly holderPid?: number;
  readonly processAlive?: (pid: number) => boolean;
}

interface LocalOwnerEndpoint {
  readonly schema: typeof LOCAL_OWNER_SCHEMA;
  readonly nonce: string;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly journalPath: string;
  readonly configDigest: string;
  readonly startedAt: string;
}

export type LocalOwnerMaintenanceClientInput =
  | {
    readonly action: "acquire";
    readonly journalPath: string;
    readonly holderPid: number;
    readonly monitorProxyPid: number;
    readonly workspaceRoot: string;
    readonly signal?: AbortSignal;
  }
  | {
    readonly action: "bridge";
    readonly journalPath: string;
    readonly holderPid: number;
    readonly workspaceRoot: string;
    readonly control: { readonly action: "status" };
    readonly signal?: AbortSignal;
  }
  | {
    readonly action: "bridge";
    readonly journalPath: string;
    readonly holderPid: number;
    readonly workspaceRoot: string;
    readonly control: Exclude<LocalOwnerBridgeMaintenanceControl, { readonly action: "status" }>;
    readonly leaseId: string;
    readonly leaseToken: string;
    readonly signal?: AbortSignal;
  }
  | {
    readonly action: "release" | "commit";
    readonly journalPath: string;
    readonly holderPid: number;
    readonly workspaceRoot: string;
    readonly leaseId: string;
    readonly leaseToken: string;
    readonly signal?: AbortSignal;
  }
  | {
    /** Closes a stale held owner after an app has atomically recovered its lease. */
    readonly action: "recover";
    readonly journalPath: string;
    readonly holderPid: number;
    readonly workspaceRoot: string;
    readonly leaseId: string;
    readonly leaseToken: string;
    readonly signal?: AbortSignal;
  };

export type LocalOwnerMaintenanceClientResult =
  | {
    readonly schema: typeof LOCAL_OWNER_MAINTENANCE_SCHEMA;
    readonly status: "held";
    readonly leaseId: string;
    readonly leaseToken: string;
    readonly ownerNonce: string;
    readonly holderPid: number;
    readonly monitorProxyPid: number;
  }
  | {
    readonly schema: typeof LOCAL_OWNER_MAINTENANCE_SCHEMA;
    readonly status: "recovered";
    readonly leaseId: string;
    readonly leaseToken: string;
    readonly ownerNonce: string;
    readonly holderPid: number;
  }
  | {
    readonly schema: typeof LOCAL_OWNER_MAINTENANCE_SCHEMA;
    readonly status: "released" | "closing";
    readonly leaseId: string;
  }
  | {
    readonly schema: typeof LOCAL_OWNER_MAINTENANCE_SCHEMA;
    readonly status: "bridge";
    readonly result: Readonly<Record<string, unknown>>;
  };

export class LocalOwnerMaintenanceClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "LocalOwnerMaintenanceClientError";
    this.code = code;
  }
}

function exactPid(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647 ? Number(value) : null;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function token(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,160}$/.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function exactWorkspace(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !/[\0\r\n]/.test(value) && resolve(value) === value;
}

function canonicalWorkspace(value: unknown): string | null {
  if (!exactWorkspace(value)) return null;
  try {
    const canonical = realpathSync(value);
    return canonical === value && statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

export function normalizeLocalOwnerBridgeMaintenanceControl(value: unknown): LocalOwnerBridgeMaintenanceControl | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if ((source.action === "status" || source.action === "quiesce" || source.action === "readback")
    && keys.length === 1 && keys[0] === "action") return { action: source.action };
  if (source.action !== "resume" || keys.length !== 3
    || !["action", "quiesceEpoch", "fileLayerRestored"].every((key) => keys.includes(key))
    || typeof source.quiesceEpoch !== "string" || !/^[A-Za-z0-9._-]{16,256}$/.test(source.quiesceEpoch)
    || source.fileLayerRestored !== true) return null;
  return { action: "resume", quiesceEpoch: source.quiesceEpoch, fileLayerRestored: true };
}

function tokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSecret(left: string, right: string): boolean {
  const received = Buffer.from(left, "utf8");
  const expected = Buffer.from(right, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function localOwnerMaintenancePath(journalPath: string): string {
  return `${resolve(journalPath)}.local-owner-maintenance.json`;
}

function ownerDescriptorPath(journalPath: string): string {
  return `${resolve(journalPath)}.local-owner.json`;
}

function parseLocalOwnerEndpoint(value: string, journalPath: string): LocalOwnerEndpoint | null {
  try {
    const parsed = JSON.parse(value) as Partial<LocalOwnerEndpoint>;
    if (parsed.schema !== LOCAL_OWNER_SCHEMA
      || !uuid(parsed.nonce)
      || exactPid(parsed.pid) === null
      || !Number.isSafeInteger(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535
      || !token(parsed.token)
      || typeof parsed.journalPath !== "string" || resolve(parsed.journalPath) !== journalPath
      || !digest(parsed.configDigest)
      || typeof parsed.startedAt !== "string") return null;
    return parsed as LocalOwnerEndpoint;
  } catch {
    return null;
  }
}

function readLocalOwnerEndpoint(journalPathValue: string): LocalOwnerEndpoint | null {
  const journalPath = resolve(journalPathValue);
  const path = ownerDescriptorPath(journalPath);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !localOwnerSidecarAccessAccepted(path, stat.mode)) return null;
    return parseLocalOwnerEndpoint(readFileSync(path, "utf8"), journalPath);
  } catch {
    return null;
  }
}

function parseLease(value: string, journalPath: string): LocalOwnerMaintenanceLease | null {
  try {
    const parsed = JSON.parse(value) as Partial<LocalOwnerMaintenanceLease>;
    if (
      parsed.schema !== LOCAL_OWNER_MAINTENANCE_SCHEMA
      || !uuid(parsed.leaseId)
      || !token(parsed.leaseToken)
      || (parsed.ownerNonce !== null && !uuid(parsed.ownerNonce))
      || (parsed.ownerPid !== null && exactPid(parsed.ownerPid) === null)
      || (parsed.ownerPort !== null && (!Number.isSafeInteger(parsed.ownerPort) || Number(parsed.ownerPort) < 1 || Number(parsed.ownerPort) > 65_535))
      || (parsed.ownerTokenDigest !== null && !digest(parsed.ownerTokenDigest))
      || typeof parsed.journalPath !== "string" || resolve(parsed.journalPath) !== journalPath
      || !digest(parsed.configDigest)
      || exactPid(parsed.holderPid) === null
      || exactPid(parsed.monitorProxyPid) === null
      || !exactWorkspace(parsed.workspaceRoot)
      || typeof parsed.acquiredAt !== "string"
      || typeof parsed.recovery !== "boolean"
    ) return null;
    if ((parsed.ownerNonce === null) !== (parsed.ownerPid === null)
      || (parsed.ownerPid === null) !== (parsed.ownerPort === null)
      || (parsed.ownerPort === null) !== (parsed.ownerTokenDigest === null)) return null;
    return parsed as LocalOwnerMaintenanceLease;
  } catch {
    return null;
  }
}

export function readLocalOwnerMaintenanceLease(journalPathValue: string): LocalOwnerMaintenanceLease | null {
  const journalPath = resolve(journalPathValue);
  const path = localOwnerMaintenancePath(journalPath);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !localOwnerSidecarAccessAccepted(path, stat.mode)) return null;
    return parseLease(readFileSync(path, "utf8"), journalPath);
  } catch {
    return null;
  }
}

export function localOwnerMaintenanceMarkerPresent(journalPathValue: string): boolean {
  try { lstatSync(localOwnerMaintenancePath(resolve(journalPathValue))); return true; } catch { return false; }
}

export function maintenanceLeaseFingerprint(journalPathValue: string): string | null {
  const path = localOwnerMaintenancePath(resolve(journalPathValue));
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !localOwnerSidecarAccessAccepted(path, stat.mode)) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function writeExclusive(path: string, lease: LocalOwnerMaintenanceLease): void {
  const temporary = `${path}.${lease.leaseId}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    safeChmod(temporary, 0o600);
    linkSync(temporary, path);
    safeChmod(path, 0o600);
    safeChmod(dirname(path), 0o700);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function replaceUnbroken(path: string, previousFingerprint: string, lease: LocalOwnerMaintenanceLease): boolean {
  const before = maintenanceLeaseFingerprint(path.slice(0, -".local-owner-maintenance.json".length));
  if (!before || !exactSecret(before, previousFingerprint)) return false;
  const temporary = `${path}.${lease.leaseId}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    safeChmod(temporary, 0o600);
    // rename replaces the marker without a visible delete/recreate gap.
    const latest = maintenanceLeaseFingerprint(path.slice(0, -".local-owner-maintenance.json".length));
    if (!latest || !exactSecret(latest, previousFingerprint)) return false;
    renameSync(temporary, path);
    safeChmod(path, 0o600);
    return true;
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function safeChmod(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* best effort on non-POSIX filesystems */ }
}

export function createLocalOwnerMaintenanceLease(
  owner: LocalOwnerIdentity,
  input: LocalOwnerMaintenanceAcquireInput,
): LocalOwnerMaintenanceLease {
  const journalPath = resolve(owner.journalPath);
  if (!uuid(owner.nonce) || exactPid(owner.pid) === null || !Number.isSafeInteger(owner.port) || owner.port < 1 || owner.port > 65_535
    || !token(owner.token) || !digest(owner.configDigest) || !exactWorkspace(input.workspaceRoot)
    || exactPid(input.holderPid) === null || exactPid(input.monitorProxyPid) === null) {
    throw new TypeError("local owner maintenance identity is invalid");
  }
  return {
    schema: LOCAL_OWNER_MAINTENANCE_SCHEMA,
    leaseId: randomUUID(),
    leaseToken: randomBytes(32).toString("base64url"),
    ownerNonce: owner.nonce,
    ownerPid: owner.pid,
    ownerPort: owner.port,
    ownerTokenDigest: tokenDigest(owner.token),
    journalPath,
    configDigest: owner.configDigest,
    holderPid: input.holderPid,
    monitorProxyPid: input.monitorProxyPid,
    workspaceRoot: input.workspaceRoot,
    acquiredAt: new Date().toISOString(),
    recovery: false,
  };
}

export function writeLocalOwnerMaintenanceLease(lease: LocalOwnerMaintenanceLease): void {
  writeExclusive(localOwnerMaintenancePath(lease.journalPath), lease);
}

export function localOwnerMaintenanceMatches(
  lease: LocalOwnerMaintenanceLease,
  owner: LocalOwnerIdentity,
  holderPid: number,
  workspaceRoot: string,
  leaseId: string,
  leaseToken: string,
): boolean {
  // monitorProxyPid binds the session that granted an acquisition. A recovery
  // cannot know the replacement monitor PID until that monitor reconnects, so
  // release and commit bind it live in local-owner.ts instead of retaining a
  // dead child PID in the durable lease.
  return lease.recovery === false
    && lease.ownerNonce === owner.nonce
    && lease.ownerPid === owner.pid
    && lease.ownerPort === owner.port
    && lease.ownerTokenDigest === tokenDigest(owner.token)
    && lease.configDigest === owner.configDigest
    && lease.holderPid === holderPid
    && lease.workspaceRoot === workspaceRoot
    && exactSecret(lease.leaseId, leaseId)
    && exactSecret(lease.leaseToken, leaseToken);
}

/**
 * Runs inside a still-live local owner after its desktop holder has died. It
 * rotates only the exact held lease that names this owner, without opening
 * ordinary MCP admission or dropping the maintenance marker.
 */
export function recoverExactLocalOwnerMaintenanceLease(
  owner: LocalOwnerIdentity,
  input: LocalOwnerMaintenanceOwnerRecoveryInput,
): LocalOwnerMaintenanceLease | null {
  const journalPath = resolve(owner.journalPath);
  const current = readLocalOwnerMaintenanceLease(journalPath);
  const fingerprint = maintenanceLeaseFingerprint(journalPath);
  const processAlive = input.processAlive ?? defaultProcessAlive;
  if (!current || !fingerprint || current.recovery || exactPid(input.holderPid) === null || !exactWorkspace(input.workspaceRoot)
    || processAlive(current.holderPid)
    || !localOwnerMaintenanceMatches(current, owner, current.holderPid, input.workspaceRoot, input.previousLeaseId, input.previousLeaseToken)) return null;
  const replacement: LocalOwnerMaintenanceLease = {
    ...current,
    leaseId: randomUUID(),
    leaseToken: randomBytes(32).toString("base64url"),
    holderPid: input.holderPid,
    workspaceRoot: input.workspaceRoot,
    acquiredAt: new Date().toISOString(),
    recovery: false,
  };
  return replaceUnbroken(localOwnerMaintenancePath(journalPath), fingerprint, replacement) ? replacement : null;
}

export function removeExactLocalOwnerMaintenanceLease(journalPath: string, leaseId: string, leaseToken: string): boolean {
  const current = readLocalOwnerMaintenanceLease(journalPath);
  if (!current || !exactSecret(current.leaseId, leaseId) || !exactSecret(current.leaseToken, leaseToken)) return false;
  try {
    unlinkSync(localOwnerMaintenancePath(resolve(journalPath)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clears a held maintenance marker only after its owner is dead. The original
 * holder must also be dead, unless the caller is the exact replacement holder
 * recorded by a private recovery. Callers use this after a private commit has
 * closed the owner, before starting a normal new monitor.
 */
export function clearDeadLocalOwnerMaintenanceLease(
  journalPathValue: string,
  input: LocalOwnerMaintenanceClearInput,
): boolean {
  const current = readLocalOwnerMaintenanceLease(journalPathValue);
  const processAlive = input.processAlive ?? defaultProcessAlive;
  const replacementHolder = input.holderPid !== undefined && exactPid(input.holderPid) !== null
    && current?.holderPid === input.holderPid && processAlive(input.holderPid);
  if (!current || !exactWorkspace(input.workspaceRoot) || current.workspaceRoot !== input.workspaceRoot
    || (!replacementHolder && processAlive(current.holderPid))
    || (current.ownerPid !== null && processAlive(current.ownerPid))) return false;
  return removeExactLocalOwnerMaintenanceLease(journalPathValue, current.leaseId, current.leaseToken);
}

function exactClientInput(input: LocalOwnerMaintenanceClientInput): LocalOwnerMaintenanceClientInput | null {
  if (!input || typeof input !== "object"
    || !["acquire", "release", "commit", "recover", "bridge"].includes(input.action)
    || exactPid(input.holderPid) === null
    || canonicalWorkspace(input.workspaceRoot) === null
    || typeof input.journalPath !== "string" || !isAbsolute(input.journalPath)) return null;
  if (input.action === "recover") return uuid(input.leaseId) && token(input.leaseToken) ? input : null;
  if (input.action === "acquire") return input;
  if (input.action === "bridge") {
    const control = normalizeLocalOwnerBridgeMaintenanceControl(input.control);
    if (!control) return null;
    if (control.action === "status") return input;
    return "leaseId" in input && "leaseToken" in input && uuid(input.leaseId) && token(input.leaseToken) ? input : null;
  }
  return uuid(input.leaseId) && token(input.leaseToken) ? input : null;
}

async function boundedResponseText(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8_192) return null;
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function problemCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return source.schema === "morrow.problem.v1" && typeof source.code === "string" && /^[a-z0-9_]{1,120}$/.test(source.code)
    ? source.code
    : null;
}

function exactClientResult(value: unknown, action: LocalOwnerMaintenanceClientInput["action"], holderPid: number, monitorProxyPid?: number): LocalOwnerMaintenanceClientResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.schema !== LOCAL_OWNER_MAINTENANCE_SCHEMA || typeof source.status !== "string") return null;
  if (action === "bridge") {
    if (source.status !== "bridge" || !source.result || typeof source.result !== "object" || Array.isArray(source.result)
      || Object.keys(source).some((key) => !["schema", "status", "result"].includes(key))) return null;
    return { schema: LOCAL_OWNER_MAINTENANCE_SCHEMA, status: "bridge", result: source.result as Readonly<Record<string, unknown>> };
  }
  if (!uuid(source.leaseId)) return null;
  if (action === "acquire") {
    if (source.status !== "held" || !token(source.leaseToken) || !uuid(source.ownerNonce)
      || exactPid(source.holderPid) !== holderPid || exactPid(source.monitorProxyPid) !== monitorProxyPid
      || Object.keys(source).some((key) => !["schema", "status", "leaseId", "leaseToken", "ownerNonce", "holderPid", "monitorProxyPid"].includes(key))) return null;
    return {
      schema: LOCAL_OWNER_MAINTENANCE_SCHEMA,
      status: "held",
      leaseId: source.leaseId,
      leaseToken: source.leaseToken,
      ownerNonce: source.ownerNonce,
      holderPid,
      monitorProxyPid,
    };
  }
  if (action === "recover") {
    if (source.status !== "recovered" || !token(source.leaseToken) || !uuid(source.ownerNonce)
      || exactPid(source.holderPid) !== holderPid
      || Object.keys(source).some((key) => !["schema", "status", "leaseId", "leaseToken", "ownerNonce", "holderPid"].includes(key))) return null;
    return {
      schema: LOCAL_OWNER_MAINTENANCE_SCHEMA,
      status: "recovered",
      leaseId: source.leaseId,
      leaseToken: source.leaseToken,
      ownerNonce: source.ownerNonce,
      holderPid,
    };
  }
  const status = action === "release" ? "released" : "closing";
  if (source.status !== status || Object.keys(source).some((key) => !["schema", "status", "leaseId"].includes(key))) return null;
  return { schema: LOCAL_OWNER_MAINTENANCE_SCHEMA, status, leaseId: source.leaseId };
}

/**
 * Authenticated private-main client for the local owner's maintenance endpoint.
 * It reads the owner descriptor only from the hardened journal sidecar and
 * binds the request to the app holder, its monitor proxy, and a canonical
 * materials workspace. It never starts or restarts an owner.
 */
export async function requestLocalOwnerMaintenance(
  input: LocalOwnerMaintenanceClientInput,
  fetcher: typeof fetch = fetch,
): Promise<LocalOwnerMaintenanceClientResult> {
  const exact = exactClientInput(input);
  if (!exact) throw new LocalOwnerMaintenanceClientError("local_owner_maintenance_request_invalid");
  const workspaceRoot = canonicalWorkspace(exact.workspaceRoot);
  if (!workspaceRoot) throw new LocalOwnerMaintenanceClientError("local_owner_workspace_required");
  const journalPath = resolve(exact.journalPath);
  const endpoint = readLocalOwnerEndpoint(journalPath);
  if (!endpoint) throw new LocalOwnerMaintenanceClientError("local_owner_unavailable");
  const body = exact.action === "acquire"
    ? {
      schema: LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA,
      action: exact.action,
      holderPid: exact.holderPid,
      monitorProxyPid: exact.monitorProxyPid,
    }
    : exact.action === "recover"
      ? {
        schema: LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA,
        action: exact.action,
        holderPid: exact.holderPid,
        leaseId: exact.leaseId,
        leaseToken: exact.leaseToken,
      }
      : exact.action === "bridge"
        ? {
          schema: LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA,
          action: exact.action,
          holderPid: exact.holderPid,
          control: exact.control,
          ...("leaseId" in exact ? { leaseId: exact.leaseId, leaseToken: exact.leaseToken } : {}),
        }
        : {
      schema: LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA,
      action: exact.action,
      holderPid: exact.holderPid,
      leaseId: exact.leaseId,
      leaseToken: exact.leaseToken,
    };
  let response: Response;
  try {
    response = await fetcher(`http://${LOOPBACK_HOST}:${endpoint.port}${LOCAL_OWNER_MAINTENANCE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json",
        "x-morrow-proxy-pid": String(exact.holderPid),
        "x-morrow-workspace": Buffer.from(workspaceRoot, "utf8").toString("base64url"),
      },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      ...(exact.signal ? { signal: exact.signal } : {}),
    });
  } catch {
    throw new LocalOwnerMaintenanceClientError("local_owner_unavailable");
  }
  const text = await boundedResponseText(response);
  if (text === null) throw new LocalOwnerMaintenanceClientError("local_owner_maintenance_response_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new LocalOwnerMaintenanceClientError("local_owner_maintenance_response_invalid"); }
  if (!response.ok) throw new LocalOwnerMaintenanceClientError(problemCode(parsed) || "local_owner_maintenance_refused");
  const result = exactClientResult(parsed, exact.action, exact.holderPid, "monitorProxyPid" in exact ? exact.monitorProxyPid : undefined);
  if (!result) throw new LocalOwnerMaintenanceClientError("local_owner_maintenance_response_invalid");
  return result;
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
