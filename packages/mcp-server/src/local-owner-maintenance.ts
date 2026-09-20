import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  canonicalPrivateStateFilePath,
  createExactPrivateStateFile,
  decodeExactUtf8,
  processMatchesRecordedLifetime,
  readExactPrivateStateFile,
  replaceExactPrivateStateFile,
  withExactPrivateStateFileTransaction,
  type ProcessLifetimeMatcher,
} from "@morrow/gateway-core";
import { RuntimeStateLease } from "./state-lease.js";

export {
  processMatchesRecordedLifetime,
  processMatchesRecordedLifetimeAsync,
  requestPathProcessMatches,
} from "@morrow/gateway-core";

export const LOCAL_OWNER_MAINTENANCE_SCHEMA = "morrow.local-owner-maintenance.v1";
export const LOCAL_OWNER_MAINTENANCE_REQUEST_SCHEMA = "morrow.local-owner-maintenance.request.v1";
export const LOCAL_OWNER_MAINTENANCE_PATH = "/morrow-maintenance/v1";
const LOCAL_OWNER_SCHEMA = "morrow.local-owner.v1";
const LOOPBACK_HOST = "127.0.0.1";
const LOCAL_OWNER_DESCRIPTOR_SUFFIX = ".local-owner.json";
const LOCAL_OWNER_MAINTENANCE_SUFFIX = ".local-owner-maintenance.json";
const LOCAL_OWNER_DESCRIPTOR_FILE_OPTIONS = {
  label: "local owner descriptor",
  minBytes: 1,
  maxBytes: 4_096,
} as const;
const LOCAL_OWNER_MAINTENANCE_FILE_OPTIONS = {
  label: "local owner maintenance lease",
  minBytes: 1,
  maxBytes: 4_096,
} as const;
const LOCAL_OWNER_MAINTENANCE_TRANSACTION_OPTIONS = {
  label: "local owner maintenance lease",
  timeoutMs: 1_000,
} as const;
const LOCAL_OWNER_MAINTENANCE_RESPONSE_MAX_BYTES = 8_192;
const LOCAL_OWNER_MAINTENANCE_RESPONSE_TIMEOUT_MS = 60_000;
const LOCAL_OWNER_ENDPOINT_KEYS = [
  "configDigest",
  "journalPath",
  "nonce",
  "pid",
  "port",
  "schema",
  "startedAt",
  "token",
] as const;
const LOCAL_OWNER_MAINTENANCE_KEYS = [
  "acquiredAt",
  "configDigest",
  "holderPid",
  "journalPath",
  "leaseId",
  "leaseToken",
  "monitorProxyPid",
  "ownerNonce",
  "ownerPid",
  "ownerPort",
  "ownerTokenDigest",
  "recovery",
  "schema",
  "workspaceRoot",
] as const;

export type LocalOwnerBridgeMaintenanceControl =
  | { readonly action: "status" }
  | { readonly action: "quiesce" }
  | { readonly action: "readback" }
  | { readonly action: "commit"; readonly previousManifestVersion: string; readonly quiesceEpoch: string }
  | { readonly action: "resume"; readonly quiesceEpoch: string; readonly fileLayerRestored: true }
  | { readonly action: "reload"; readonly quiesceEpoch: string };

export interface LocalOwnerIdentity {
  readonly nonce: string;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly journalPath: string;
  readonly configDigest: string;
  readonly startedAt: string;
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
  readonly processMatches?: ProcessLifetimeMatcher;
}

export interface LocalOwnerMaintenanceClearInput {
  readonly workspaceRoot: string;
  /** The new desktop holder after a private recovery, when applicable. */
  readonly holderPid?: number;
  readonly processAlive?: (pid: number) => boolean;
  readonly processMatches?: ProcessLifetimeMatcher;
}

export interface LocalOwnerStoppedMaintenanceInput {
  readonly holderPid: number;
  readonly workspaceRoot: string;
  readonly processMatches?: ProcessLifetimeMatcher;
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

function lifetimeMatcher(input: { processAlive?: (pid: number) => boolean; processMatches?: ProcessLifetimeMatcher }): ProcessLifetimeMatcher {
  if (input.processMatches) return input.processMatches;
  if (input.processAlive) return (pid) => input.processAlive!(pid);
  return processMatchesRecordedLifetime;
}

function uuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
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

// The workspace root is the only bound on the local files Morrow will read and stage for upload, so
// a root that holds the whole account or the whole disk is not a project folder. A client that
// starts Morrow without a working directory lands on one of these, and must be refused there.
export function workspaceRootTooBroad(root: string): boolean {
  if (dirname(root) === root) return true;
  let home = homedir();
  try {
    home = realpathSync(home);
  } catch {
    // An unreadable home directory still bounds the comparison by its configured path.
  }
  if (!isAbsolute(home)) return false;
  const homeFromRoot = relative(root, home);
  return homeFromRoot === "" || (!isAbsolute(homeFromRoot) && !homeFromRoot.startsWith(".."));
}

function canonicalWorkspace(value: unknown): string | null {
  if (!exactWorkspace(value) || workspaceRootTooBroad(value)) return null;
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
  if (source.action === "reload" && keys.length === 2
    && keys.includes("action") && keys.includes("quiesceEpoch")
    && typeof source.quiesceEpoch === "string" && /^[A-Za-z0-9._-]{16,256}$/.test(source.quiesceEpoch)) {
    return { action: "reload", quiesceEpoch: source.quiesceEpoch };
  }
  if (source.action === "commit" && keys.length === 3
    && ["action", "previousManifestVersion", "quiesceEpoch"].every((key) => keys.includes(key))
    && typeof source.previousManifestVersion === "string"
    && /^(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*)){0,3}$/.test(source.previousManifestVersion)
    && typeof source.quiesceEpoch === "string" && /^[A-Za-z0-9._-]{16,256}$/.test(source.quiesceEpoch)) {
    return { action: "commit", previousManifestVersion: source.previousManifestVersion, quiesceEpoch: source.quiesceEpoch };
  }
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
  return `${canonicalLocalOwnerJournalPath(journalPath)}${LOCAL_OWNER_MAINTENANCE_SUFFIX}`;
}

function ownerDescriptorPath(journalPath: string): string {
  return `${canonicalLocalOwnerJournalPath(journalPath)}${LOCAL_OWNER_DESCRIPTOR_SUFFIX}`;
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

function parseLocalOwnerEndpoint(value: string, journalPath: string): LocalOwnerEndpoint | null {
  try {
    const candidate = JSON.parse(value) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).sort().join("\0") !== LOCAL_OWNER_ENDPOINT_KEYS.join("\0")) return null;
    const parsed = candidate as Partial<LocalOwnerEndpoint>;
    if (parsed.schema !== LOCAL_OWNER_SCHEMA
      || !uuid(parsed.nonce)
      || exactPid(parsed.pid) === null
      || !Number.isSafeInteger(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535
      || !token(parsed.token)
      || typeof parsed.journalPath !== "string" || canonicalRecordedJournalPath(parsed.journalPath) !== journalPath
      || !digest(parsed.configDigest)
      || typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt))
      || new Date(parsed.startedAt).toISOString() !== parsed.startedAt) return null;
    return { ...parsed, journalPath } as LocalOwnerEndpoint;
  } catch {
    return null;
  }
}

function readLocalOwnerEndpoint(journalPathValue: string): LocalOwnerEndpoint | null {
  try {
    const journalPath = canonicalLocalOwnerJournalPath(journalPathValue);
    const content = readExactPrivateStateFile(ownerDescriptorPath(journalPath), LOCAL_OWNER_DESCRIPTOR_FILE_OPTIONS);
    return content ? parseLocalOwnerEndpoint(decodeExactUtf8(content, "local owner descriptor"), journalPath) : null;
  } catch {
    return null;
  }
}

function parseLease(value: string, journalPath: string): LocalOwnerMaintenanceLease | null {
  try {
    const candidate = JSON.parse(value) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).sort().join("\0") !== LOCAL_OWNER_MAINTENANCE_KEYS.join("\0")) return null;
    const parsed = candidate as Partial<LocalOwnerMaintenanceLease>;
    if (
      parsed.schema !== LOCAL_OWNER_MAINTENANCE_SCHEMA
      || !uuid(parsed.leaseId)
      || !token(parsed.leaseToken)
      || (parsed.ownerNonce !== null && !uuid(parsed.ownerNonce))
      || (parsed.ownerPid !== null && exactPid(parsed.ownerPid) === null)
      || (parsed.ownerPort !== null && (!Number.isSafeInteger(parsed.ownerPort) || Number(parsed.ownerPort) < 1 || Number(parsed.ownerPort) > 65_535))
      || (parsed.ownerTokenDigest !== null && !digest(parsed.ownerTokenDigest))
      || typeof parsed.journalPath !== "string" || canonicalRecordedJournalPath(parsed.journalPath) !== journalPath
      || !digest(parsed.configDigest)
      || exactPid(parsed.holderPid) === null
      || exactPid(parsed.monitorProxyPid) === null
      || !exactWorkspace(parsed.workspaceRoot)
      || typeof parsed.acquiredAt !== "string" || !Number.isFinite(Date.parse(parsed.acquiredAt))
      || new Date(parsed.acquiredAt).toISOString() !== parsed.acquiredAt
      || typeof parsed.recovery !== "boolean"
    ) return null;
    if ((parsed.ownerNonce === null) !== (parsed.ownerPid === null)
      || (parsed.ownerPid === null) !== (parsed.ownerPort === null)
      || (parsed.ownerPort === null) !== (parsed.ownerTokenDigest === null)) return null;
    return { ...parsed, journalPath } as LocalOwnerMaintenanceLease;
  } catch {
    return null;
  }
}

export function readLocalOwnerMaintenanceLease(journalPathValue: string): LocalOwnerMaintenanceLease | null {
  try {
    const journalPath = canonicalLocalOwnerJournalPath(journalPathValue);
    const content = readExactPrivateStateFile(localOwnerMaintenancePath(journalPath), LOCAL_OWNER_MAINTENANCE_FILE_OPTIONS);
    return content ? parseLease(decodeExactUtf8(content, "local owner maintenance lease"), journalPath) : null;
  } catch {
    return null;
  }
}

export function localOwnerMaintenanceMarkerPresent(journalPathValue: string): boolean {
  try {
    lstatSync(localOwnerMaintenancePath(journalPathValue));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function maintenanceLeaseFingerprint(journalPathValue: string): string | null {
  try {
    const journalPath = canonicalLocalOwnerJournalPath(journalPathValue);
    const path = localOwnerMaintenancePath(journalPath);
    const content = readExactPrivateStateFile(path, LOCAL_OWNER_MAINTENANCE_FILE_OPTIONS);
    return content && parseLease(decodeExactUtf8(content, "local owner maintenance lease"), journalPath)
      ? createHash("sha256").update(content).digest("hex")
      : null;
  } catch {
    return null;
  }
}

function writeExclusive(path: string, lease: LocalOwnerMaintenanceLease): void {
  const journalPath = canonicalLocalOwnerJournalPath(lease.journalPath);
  const content = exactMaintenanceLeaseContent(lease, journalPath);
  withExactPrivateStateFileTransaction(path, LOCAL_OWNER_MAINTENANCE_TRANSACTION_OPTIONS, () => {
    if (!createExactPrivateStateFile(path, content, LOCAL_OWNER_MAINTENANCE_FILE_OPTIONS)) {
      throw new Error("local owner maintenance lease already exists");
    }
  });
}

function replaceUnbroken(path: string, previousFingerprint: string, lease: LocalOwnerMaintenanceLease): boolean {
  const journalPath = canonicalLocalOwnerJournalPath(lease.journalPath);
  const content = exactMaintenanceLeaseContent(lease, journalPath);
  return withExactPrivateStateFileTransaction(path, LOCAL_OWNER_MAINTENANCE_TRANSACTION_OPTIONS, () => {
    const current = readExactPrivateStateFile(path, LOCAL_OWNER_MAINTENANCE_FILE_OPTIONS);
    if (!current || !exactSecret(createHash("sha256").update(current).digest("hex"), previousFingerprint)
      || !parseLease(decodeExactUtf8(current, "local owner maintenance lease"), journalPath)) return false;
    replaceExactPrivateStateFile(path, content, LOCAL_OWNER_MAINTENANCE_FILE_OPTIONS);
    return true;
  });
}

function exactMaintenanceLeaseContent(lease: LocalOwnerMaintenanceLease, journalPath: string): Buffer {
  const content = Buffer.from(`${JSON.stringify(lease)}\n`, "utf8");
  const parsed = parseLease(content.toString("utf8"), journalPath);
  if (!parsed || parsed.journalPath !== lease.journalPath || parsed.leaseId !== lease.leaseId) {
    throw new TypeError("local owner maintenance lease is invalid");
  }
  return content;
}

export function createLocalOwnerMaintenanceLease(
  owner: LocalOwnerIdentity,
  input: LocalOwnerMaintenanceAcquireInput,
): LocalOwnerMaintenanceLease {
  const journalPath = canonicalLocalOwnerJournalPath(owner.journalPath);
  if (!uuid(owner.nonce) || exactPid(owner.pid) === null || !Number.isSafeInteger(owner.port) || owner.port < 1 || owner.port > 65_535
    || !token(owner.token) || !digest(owner.configDigest) || !Number.isFinite(Date.parse(owner.startedAt)) || !exactWorkspace(input.workspaceRoot)
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
  const journalPath = canonicalLocalOwnerJournalPath(lease.journalPath);
  writeExclusive(localOwnerMaintenancePath(journalPath), lease);
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
  const journalPath = canonicalLocalOwnerJournalPath(owner.journalPath);
  const current = readLocalOwnerMaintenanceLease(journalPath);
  const fingerprint = maintenanceLeaseFingerprint(journalPath);
  const processMatches = lifetimeMatcher(input);
  if (!current || !fingerprint || current.recovery || exactPid(input.holderPid) === null || !exactWorkspace(input.workspaceRoot)
    || processMatches(current.holderPid, current.acquiredAt) !== false
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
  try {
    const canonicalJournalPath = canonicalLocalOwnerJournalPath(journalPath);
    const path = localOwnerMaintenancePath(canonicalJournalPath);
    return withExactPrivateStateFileTransaction(path, LOCAL_OWNER_MAINTENANCE_TRANSACTION_OPTIONS, () => {
      const current = readLocalOwnerMaintenanceLease(canonicalJournalPath);
      if (!current || !exactSecret(current.leaseId, leaseId) || !exactSecret(current.leaseToken, leaseToken)) return false;
      unlinkSync(path);
      return true;
    });
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
  const processMatches = lifetimeMatcher(input);
  const replacementHolder = input.holderPid !== undefined && exactPid(input.holderPid) !== null
    && current?.holderPid === input.holderPid && processMatches(input.holderPid, current.acquiredAt) === true;
  if (!current || !exactWorkspace(input.workspaceRoot) || current.workspaceRoot !== input.workspaceRoot
    || (!replacementHolder && processMatches(current.holderPid, current.acquiredAt) !== false)
    || (current.ownerPid !== null && processMatches(current.ownerPid, current.acquiredAt) !== false)) return false;
  return removeExactLocalOwnerMaintenanceLease(journalPathValue, current.leaseId, current.leaseToken);
}

function stoppedMaintenanceLease(
  journalPath: string,
  input: LocalOwnerStoppedMaintenanceInput,
): LocalOwnerMaintenanceLease {
  return {
    schema: LOCAL_OWNER_MAINTENANCE_SCHEMA,
    leaseId: randomUUID(),
    leaseToken: randomBytes(32).toString("base64url"),
    ownerNonce: null,
    ownerPid: null,
    ownerPort: null,
    ownerTokenDigest: null,
    journalPath,
    configDigest: "0".repeat(64),
    holderPid: input.holderPid,
    monitorProxyPid: input.holderPid,
    workspaceRoot: input.workspaceRoot,
    acquiredAt: new Date().toISOString(),
    recovery: true,
  };
}

/**
 * Establishes a durable maintenance guard when no runtime owner is running.
 * The marker is written first so new runtimes stop at admission. Acquiring the
 * runtime lock then closes the race with a process that passed admission just
 * before the marker appeared. The marker remains after the probe lock is
 * released and must be removed with its exact lease secret.
 */
export function acquireStoppedLocalOwnerMaintenanceLease(
  journalPathValue: string,
  input: LocalOwnerStoppedMaintenanceInput,
): LocalOwnerMaintenanceLease | null {
  const journalPath = canonicalLocalOwnerJournalPath(journalPathValue);
  const workspaceRoot = canonicalWorkspace(input.workspaceRoot);
  if (workspaceRoot === null || exactPid(input.holderPid) === null || input.holderPid !== process.pid) return null;
  const lease = stoppedMaintenanceLease(journalPath, { ...input, workspaceRoot });
  try {
    writeExclusive(localOwnerMaintenancePath(journalPath), lease);
  } catch {
    return null;
  }
  let probe: RuntimeStateLease | null = null;
  let accepted = false;
  try {
    probe = RuntimeStateLease.acquire(journalPath, { pid: input.holderPid, heartbeatMs: 60_000 });
    const descriptorPath = ownerDescriptorPath(journalPath);
    let descriptorPresent = false;
    try {
      lstatSync(descriptorPath);
      descriptorPresent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    if (descriptorPresent) {
      const endpoint = readLocalOwnerEndpoint(journalPath);
      if (!endpoint || lifetimeMatcher(input)(endpoint.pid, endpoint.startedAt) !== false) return null;
    }
    accepted = true;
    return lease;
  } catch {
    return null;
  } finally {
    probe?.release();
    if (!accepted) removeExactLocalOwnerMaintenanceLease(journalPath, lease.leaseId, lease.leaseToken);
  }
}

/**
 * Converts a committed live-owner lease into a stopped-runtime guard without a
 * delete/recreate gap. Success proves that the exact recorded owner is dead.
 */
export function replaceDeadLocalOwnerMaintenanceLeaseWithStoppedGuard(
  journalPathValue: string,
  input: LocalOwnerStoppedMaintenanceInput,
): LocalOwnerMaintenanceLease | null {
  const journalPath = canonicalLocalOwnerJournalPath(journalPathValue);
  const workspaceRoot = canonicalWorkspace(input.workspaceRoot);
  const current = readLocalOwnerMaintenanceLease(journalPath);
  const fingerprint = maintenanceLeaseFingerprint(journalPath);
  if (workspaceRoot === null || exactPid(input.holderPid) === null || input.holderPid !== process.pid
    || !current || !fingerprint || current.workspaceRoot !== workspaceRoot || current.holderPid !== input.holderPid
    || lifetimeMatcher(input)(input.holderPid, current.acquiredAt) !== true
    || (current.ownerPid !== null && lifetimeMatcher(input)(current.ownerPid, current.acquiredAt) !== false)) return null;
  const replacement = stoppedMaintenanceLease(journalPath, { ...input, workspaceRoot });
  return replaceUnbroken(localOwnerMaintenancePath(journalPath), fingerprint, replacement) ? replacement : null;
}

function exactClientInput(input: LocalOwnerMaintenanceClientInput): LocalOwnerMaintenanceClientInput | null {
  if (!input || typeof input !== "object"
    || !["acquire", "release", "commit", "recover", "bridge"].includes(input.action)
    || exactPid(input.holderPid) === null
    || canonicalWorkspace(input.workspaceRoot) === null
    || typeof input.journalPath !== "string" || !isAbsolute(input.journalPath)
    || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) return null;
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

function cancelResponseStream(
  stream: { cancel?: (reason?: unknown) => unknown } | null | undefined,
  reason: string,
): void {
  try {
    const cancellation = stream?.cancel?.(reason);
    if (cancellation && typeof (cancellation as Promise<unknown>).catch === "function") {
      void (cancellation as Promise<unknown>).catch(() => undefined);
    }
  } catch { /* The response is already refused. */ }
}

function settleWithAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason || new Error("local owner maintenance request aborted"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => reject(signal.reason || new Error("local owner maintenance request aborted")));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string | null> {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined
    && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > LOCAL_OWNER_MAINTENANCE_RESPONSE_MAX_BYTES)) {
    cancelResponseStream(response.body, "local_owner_maintenance_response_too_large");
    return null;
  }
  if (!response.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    cancelResponseStream(response.body, "local_owner_maintenance_response_invalid");
    return null;
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const part = await settleWithAbort(reader.read(), signal);
      if (part.done) {
        complete = true;
        break;
      }
      if (!(part.value instanceof Uint8Array)) return null;
      bytes += part.value.byteLength;
      if (bytes > LOCAL_OWNER_MAINTENANCE_RESPONSE_MAX_BYTES) return null;
      chunks.push(part.value);
    }
  } catch {
    return null;
  } finally {
    if (!complete) {
      cancelResponseStream(reader, signal.aborted
        ? "local_owner_maintenance_response_interrupted"
        : bytes > LOCAL_OWNER_MAINTENANCE_RESPONSE_MAX_BYTES
          ? "local_owner_maintenance_response_too_large"
          : "local_owner_maintenance_response_invalid");
    }
    try { reader.releaseLock(); } catch { /* The refused stream no longer owns request progress. */ }
  }
  try {
    return decodeExactUtf8(Buffer.concat(chunks), "local owner maintenance response");
  } catch {
    return null;
  }
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
  let journalPath: string;
  try {
    journalPath = canonicalLocalOwnerJournalPath(exact.journalPath);
  } catch {
    throw new LocalOwnerMaintenanceClientError("local_owner_unavailable");
  }
  const endpoint = readLocalOwnerEndpoint(journalPath);
  if (!endpoint || processMatchesRecordedLifetime(endpoint.pid, endpoint.startedAt) !== true) {
    throw new LocalOwnerMaintenanceClientError("local_owner_unavailable");
  }
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
  const deadline = AbortSignal.timeout(LOCAL_OWNER_MAINTENANCE_RESPONSE_TIMEOUT_MS);
  const signal = exact.signal ? AbortSignal.any([exact.signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await settleWithAbort(Promise.resolve(fetcher(`http://${LOOPBACK_HOST}:${endpoint.port}${LOCAL_OWNER_MAINTENANCE_PATH}`, {
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
      signal,
    })), signal);
  } catch {
    throw new LocalOwnerMaintenanceClientError("local_owner_unavailable");
  }
  const text = await boundedResponseText(response, signal);
  if (text === null) throw new LocalOwnerMaintenanceClientError("local_owner_maintenance_response_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new LocalOwnerMaintenanceClientError("local_owner_maintenance_response_invalid"); }
  if (!response.ok) throw new LocalOwnerMaintenanceClientError(problemCode(parsed) || "local_owner_maintenance_refused");
  const result = exactClientResult(parsed, exact.action, exact.holderPid, "monitorProxyPid" in exact ? exact.monitorProxyPid : undefined);
  if (!result) throw new LocalOwnerMaintenanceClientError("local_owner_maintenance_response_invalid");
  return result;
}
