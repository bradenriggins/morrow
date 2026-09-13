import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { privateDirectoryAccessAccepted, privateFileAccessAccepted } from "./private-file-access.js";
import { processMatchesExactStart, readProcessStartedAt } from "./process-lifetime.js";

export interface ExactPrivateStateFileOptions {
  readonly label: string;
  readonly maxBytes: number;
  readonly minBytes?: number;
}

export interface ExactPrivateStateTransactionOptions {
  readonly label: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

interface TransactionOwner {
  readonly schema: "morrow.exact-private-state-transaction.v1";
  readonly nonce: string;
  readonly pid: number;
  readonly processStartedAt: string;
  readonly acquiredAt: number;
}

interface HeldTransaction extends TransactionOwner {
  readonly path: string;
  readonly label: string;
}

const MAX_TRANSACTION_OWNER_BYTES = 1_024;
const MAX_TRANSACTION_TIMEOUT_MS = 60_000;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
let currentProcessStartedAt: string | null | undefined;

/** Converts exact authority bytes to text without inventing replacement characters. */
export function decodeExactUtf8(content: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function exactLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function boundedDuration(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration < 0 || duration > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return duration;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unlinkCreated(path: string, identity: Stats | null): void {
  if (!identity) return;
  try {
    const current = lstatSync(path);
    if (sameFile(identity, current)) unlinkSync(path);
  } catch { /* preserve the primary failure */ }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/**
 * Creates the parent when needed, rejects a linked immediate parent, and pins
 * subsequent work to its current canonical directory.
 */
export function canonicalPrivateStateFilePath(pathValue: string, label: string): string {
  const requestedPath = resolve(pathValue);
  const requestedParent = dirname(requestedPath);
  mkdirSync(requestedParent, { recursive: true, mode: 0o700 });
  const parent = lstatSync(requestedParent);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error(`${label} parent is not one exact directory`);
  }
  return resolve(realpathSync(requestedParent), basename(requestedPath));
}

/** Reads one bounded, single-link, owner-controlled private regular file. */
function readExactPrivateStateFileWithLinks(
  pathValue: string,
  options: ExactPrivateStateFileOptions,
  linkCount: number,
): Buffer | null {
  const path = resolve(pathValue);
  const maxBytes = exactLimit(options.maxBytes, `${options.label} maximum bytes`);
  const minBytes = exactLimit(options.minBytes ?? 0, `${options.label} minimum bytes`);
  if (minBytes > maxBytes) throw new TypeError(`${options.label} byte limits are invalid`);
  let named: Stats;
  try { named = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== linkCount
    || named.size < minBytes || named.size > maxBytes
    || (typeof process.getuid === "function" && named.uid !== process.getuid())
    || !privateFileAccessAccepted(path, named.mode, { trustedRoot: dirname(path) })) {
    throw new Error(`${options.label} is not one exact private file`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== linkCount || !sameFile(named, opened)) {
      throw new Error(`${options.label} changed during admission`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length < minBytes || length > maxBytes) throw new Error(`${options.label} violates its byte bound`);
    const afterRead = fstatSync(descriptor);
    const current = lstatSync(path);
    if (!sameFile(opened, afterRead) || !sameFile(opened, current)
      || afterRead.nlink !== linkCount || current.nlink !== linkCount
      || opened.size !== afterRead.size || opened.mtimeMs !== afterRead.mtimeMs
      || opened.ctimeMs !== afterRead.ctimeMs) {
      throw new Error(`${options.label} changed while it was read`);
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

/** Reads one bounded, single-link, owner-controlled private regular file. */
export function readExactPrivateStateFile(
  pathValue: string,
  options: ExactPrivateStateFileOptions,
): Buffer | null {
  return readExactPrivateStateFileWithLinks(pathValue, options, 1);
}

/** Exclusively creates, flushes, verifies, and durably publishes one private file. */
export function createExactPrivateStateFile(
  pathValue: string,
  content: Uint8Array,
  options: ExactPrivateStateFileOptions,
): boolean {
  const path = canonicalPrivateStateFilePath(pathValue, options.label);
  const bytes = Buffer.from(content);
  const maxBytes = exactLimit(options.maxBytes, `${options.label} maximum bytes`);
  const minBytes = exactLimit(options.minBytes ?? 0, `${options.label} minimum bytes`);
  if (bytes.length < minBytes || bytes.length > maxBytes) throw new Error(`${options.label} violates its byte bound`);
  let descriptor: number | null = null;
  let createdIdentity: Stats | null = null;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    createdIdentity = fstatSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    const admitted = readExactPrivateStateFile(path, options);
    if (!admitted?.equals(bytes)) throw new Error(`${options.label} failed exact readback`);
    syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* preserve the primary failure */ }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    unlinkCreated(path, createdIdentity);
    throw error;
  }
}

/** Atomically replaces, verifies, and durably publishes one private file. */
export function replaceExactPrivateStateFile(
  pathValue: string,
  content: Uint8Array,
  options: ExactPrivateStateFileOptions,
): void {
  const path = canonicalPrivateStateFilePath(pathValue, options.label);
  const temporary = resolve(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    if (!createExactPrivateStateFile(temporary, content, options)) {
      throw new Error(`${options.label} temporary file already exists`);
    }
    renameSync(temporary, path);
    const admitted = readExactPrivateStateFile(path, options);
    if (!admitted?.equals(Buffer.from(content))) throw new Error(`${options.label} failed exact readback`);
    syncDirectory(dirname(path));
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* preserve the primary failure */ }
    throw error;
  }
}

function transactionOptions(label: string): ExactPrivateStateFileOptions {
  return { label: `${label} transaction owner`, minBytes: 1, maxBytes: MAX_TRANSACTION_OWNER_BYTES };
}

function parseTransactionOwner(content: Buffer, label: string): TransactionOwner {
  let value: unknown;
  try { value = JSON.parse(decodeExactUtf8(content, `${label} transaction owner`)); } catch {
    throw new Error(`${label} transaction owner is invalid`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== ["acquiredAt", "nonce", "pid", "processStartedAt", "schema"].join("\0")) {
    throw new Error(`${label} transaction owner is invalid`);
  }
  const owner = value as Partial<TransactionOwner>;
  if (owner.schema !== "morrow.exact-private-state-transaction.v1"
    || typeof owner.nonce !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(owner.nonce)
    || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || Number(owner.pid) > 2_147_483_647
    || typeof owner.processStartedAt !== "string" || !Number.isFinite(Date.parse(owner.processStartedAt))
    || new Date(owner.processStartedAt).toISOString() !== owner.processStartedAt
    || !Number.isSafeInteger(owner.acquiredAt) || Number(owner.acquiredAt) < 0) {
    throw new Error(`${label} transaction owner is invalid`);
  }
  return owner as TransactionOwner;
}

function sameTransactionOwner(left: TransactionOwner, right: TransactionOwner): boolean {
  return left.schema === right.schema && left.nonce === right.nonce && left.pid === right.pid
    && left.processStartedAt === right.processStartedAt && left.acquiredAt === right.acquiredAt;
}

function readTransactionOwner(path: string, label: string, linkCount = 1): TransactionOwner | null {
  const content = readExactPrivateStateFileWithLinks(path, transactionOptions(label), linkCount);
  return content ? parseTransactionOwner(content, label) : null;
}

type InterruptedClaimKind = "reclaim" | "release";

interface InterruptedClaim {
  readonly kind: InterruptedClaimKind;
  readonly owner: TransactionOwner;
}

/**
 * Recognises a two-link owner whose nonce-derived reclaim or release claim
 * is the same private inode. Either claim proves a reaper or the owner itself
 * had already decided to remove this lock before it stopped, so a later
 * acquirer may finish that exact interrupted step.
 */
function readInterruptedClaim(path: string, label: string): InterruptedClaim | null {
  const current = lstatSync(path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 2) return null;
  const owner = readTransactionOwner(path, label, 2);
  if (!owner) return null;
  for (const kind of ["reclaim", "release"] as const) {
    const claimPath = `${path}.${kind}-${owner.nonce}`;
    let claim: Stats;
    try { claim = lstatSync(claimPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!sameFile(current, claim) || claim.nlink !== 2) {
      throw new Error(`${label} transaction ${kind} claim is invalid`);
    }
    const claimedOwner = readTransactionOwner(claimPath, label, 2);
    if (!claimedOwner || !sameTransactionOwner(claimedOwner, owner)) {
      throw new Error(`${label} transaction ${kind} claim is invalid`);
    }
    return { kind, owner };
  }
  return null;
}

function unlinkExactName(path: string, expected: Stats, label: string): void {
  let current: Stats;
  try { current = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sameFile(current, expected)) throw new Error(`${label} changed before cleanup`);
  unlinkSync(path);
}

function exactCurrentProcessStart(label: string): string {
  if (currentProcessStartedAt === undefined) {
    const startedAt = readProcessStartedAt(process.pid);
    currentProcessStartedAt = startedAt === null ? null : new Date(startedAt).toISOString();
  }
  if (currentProcessStartedAt === null) throw new Error(`${label} transaction process lifetime is unavailable`);
  return currentProcessStartedAt;
}

function reclaimTransactionOwner(path: string, owner: TransactionOwner, label: string): boolean {
  if (processMatchesExactStart(owner.pid, owner.processStartedAt) !== false) return false;
  const claimPath = `${path}.reclaim-${owner.nonce}`;
  let claim: Stats | null = null;
  let cleanupClaim = false;
  try {
    linkSync(path, claimPath);
    claim = lstatSync(claimPath);
    cleanupClaim = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try { claim = lstatSync(claimPath); } catch (inspectionError) {
      if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw inspectionError;
    }
  }
  try {
    const current = lstatSync(path);
    if (!claim || !sameFile(claim, current) || claim.nlink !== 2 || current.nlink !== 2) return false;
    const claimedOwner = readTransactionOwner(claimPath, label, 2);
    if (!claimedOwner || !sameTransactionOwner(claimedOwner, owner)
      || processMatchesExactStart(claimedOwner.pid, claimedOwner.processStartedAt) !== false) return false;
    cleanupClaim = true;
    unlinkSync(path);
    syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    if (cleanupClaim && claim) {
      unlinkExactName(claimPath, claim, `${label} transaction reclaim claim`);
      syncDirectory(dirname(path));
    }
  }
}

/**
 * Finishes a release that its owner started but did not complete: the owner
 * linked `<lock>.release-<nonce>` and then stopped before unlinking the lock.
 * Only a lock whose owner process no longer runs is finished here; a live
 * owner completes its own release.
 */
function finishInterruptedRelease(path: string, owner: TransactionOwner, label: string): boolean {
  if (processMatchesExactStart(owner.pid, owner.processStartedAt) !== false) return false;
  const claimPath = `${path}.release-${owner.nonce}`;
  try {
    const claim = lstatSync(claimPath);
    const current = lstatSync(path);
    if (!sameFile(claim, current) || claim.nlink !== 2 || current.nlink !== 2) return false;
    const claimedOwner = readTransactionOwner(claimPath, label, 2);
    if (!claimedOwner || !sameTransactionOwner(claimedOwner, owner)) return false;
    unlinkSync(path);
    unlinkExactName(claimPath, claim, `${label} transaction release claim`);
    syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function finishInterruptedClaim(path: string, claim: InterruptedClaim, label: string): boolean {
  return claim.kind === "release"
    ? finishInterruptedRelease(path, claim.owner, label)
    : reclaimTransactionOwner(path, claim.owner, label);
}

function publishTransactionOwner(path: string, preparedPath: string, owner: TransactionOwner, label: string): boolean {
  let linked = false;
  try {
    linkSync(preparedPath, path);
    linked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    unlinkSync(preparedPath);
    syncDirectory(dirname(path));
    const admitted = readTransactionOwner(path, label);
    if (!admitted || !sameTransactionOwner(admitted, owner)) {
      throw new Error(`${label} transaction owner failed exact readback`);
    }
    return true;
  } catch (error) {
    if (linked) {
      try { unlinkSync(preparedPath); } catch { /* preserve the publication failure */ }
      try { releaseTransaction({ ...owner, path, label }); } catch { /* keep uncertain ownership fail-closed */ }
    }
    throw error;
  }
}

interface TransactionAdmission {
  readonly owner: TransactionOwner;
  readonly path: string;
  readonly preparedPath: string;
  readonly label: string;
  readonly deadline: number;
  readonly pollIntervalMs: number;
  admissionFailure: unknown;
}

type TransactionAdmissionStep =
  | { readonly kind: "held"; readonly held: HeldTransaction }
  | { readonly kind: "retry" }
  | { readonly kind: "wait"; readonly milliseconds: number };

function prepareTransactionAdmission(pathValue: string, options: ExactPrivateStateTransactionOptions): TransactionAdmission {
  const target = canonicalPrivateStateFilePath(pathValue, options.label);
  const parent = lstatSync(dirname(target));
  if ((typeof process.getuid === "function" && parent.uid !== process.getuid())
    || !privateDirectoryAccessAccepted(dirname(target))) {
    throw new Error(`${options.label} transaction parent is not one exact private directory`);
  }
  const path = `${target}.transaction.lock`;
  const timeoutMs = boundedDuration(options.timeoutMs, 10_000, MAX_TRANSACTION_TIMEOUT_MS, `${options.label} transaction timeout`);
  const pollIntervalMs = boundedDuration(options.pollIntervalMs, 10, 1_000, `${options.label} transaction poll interval`);
  if (pollIntervalMs < 1) throw new TypeError(`${options.label} transaction poll interval is invalid`);
  const owner: TransactionOwner = {
    schema: "morrow.exact-private-state-transaction.v1",
    nonce: randomUUID(),
    pid: process.pid,
    processStartedAt: exactCurrentProcessStart(options.label),
    acquiredAt: Date.now(),
  };
  const preparedPath = `${path}.prepare-${owner.pid}-${owner.nonce}`;
  if (!createExactPrivateStateFile(
    preparedPath,
    Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"),
    transactionOptions(options.label),
  )) throw new Error(`${options.label} transaction preparation already exists`);
  return { owner, path, preparedPath, label: options.label, deadline: performance.now() + timeoutMs, pollIntervalMs, admissionFailure: null };
}

/** One admission attempt: publish this owner, or resolve the conflict that blocks it. */
function admitTransactionOnce(admission: TransactionAdmission): TransactionAdmissionStep {
  const { path, preparedPath, owner, label } = admission;
  if (publishTransactionOwner(path, preparedPath, owner, label)) {
    return { kind: "held", held: { ...owner, path, label } };
  }
  let current: TransactionOwner | null;
  try {
    current = readTransactionOwner(path, label);
    admission.admissionFailure = null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "retry" };
    let interrupted: InterruptedClaim | null;
    try {
      interrupted = readInterruptedClaim(path, label);
    } catch (claimError) {
      if ((claimError as NodeJS.ErrnoException).code === "ENOENT") return { kind: "retry" };
      admission.admissionFailure = claimError;
      interrupted = null;
    }
    current = null;
    if (interrupted) {
      admission.admissionFailure = null;
      if (finishInterruptedClaim(path, interrupted, label)) return { kind: "retry" };
    }
    let metadata: Stats | null = null;
    try { metadata = lstatSync(path); } catch (inspectionError) {
      if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") return { kind: "retry" };
      throw inspectionError;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw error;
    admission.admissionFailure ??= error;
  }
  if (current && reclaimTransactionOwner(path, current, label)) return { kind: "retry" };
  const remaining = admission.deadline - performance.now();
  if (remaining <= 0) {
    if (admission.admissionFailure) throw admission.admissionFailure;
    throw new Error(`${label} is busy in another process`);
  }
  return { kind: "wait", milliseconds: Math.min(admission.pollIntervalMs, Math.max(1, remaining)) };
}

function discardTransactionPreparation(admission: TransactionAdmission): void {
  try { unlinkSync(admission.preparedPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function acquireTransaction(pathValue: string, options: ExactPrivateStateTransactionOptions): HeldTransaction {
  const admission = prepareTransactionAdmission(pathValue, options);
  try {
    for (;;) {
      const step = admitTransactionOnce(admission);
      if (step.kind === "held") return step.held;
      if (step.kind === "wait") Atomics.wait(waitCell, 0, 0, step.milliseconds);
    }
  } finally {
    discardTransactionPreparation(admission);
  }
}

async function acquireTransactionAsync(pathValue: string, options: ExactPrivateStateTransactionOptions): Promise<HeldTransaction> {
  const admission = prepareTransactionAdmission(pathValue, options);
  try {
    for (;;) {
      const step = admitTransactionOnce(admission);
      if (step.kind === "held") return step.held;
      if (step.kind === "wait") await new Promise<void>((resolve) => setTimeout(resolve, step.milliseconds));
    }
  } finally {
    discardTransactionPreparation(admission);
  }
}

function releaseTransaction(lock: HeldTransaction): void {
  const claimPath = `${lock.path}.release-${lock.nonce}`;
  try {
    linkSync(lock.path, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${lock.label} transaction ownership changed`);
    }
    throw error;
  }
  try {
    const claimed = lstatSync(claimPath);
    const current = lstatSync(lock.path);
    const owner = readTransactionOwner(claimPath, lock.label, 2);
    if (!sameFile(claimed, current) || claimed.nlink !== 2 || current.nlink !== 2
      || !owner || !sameTransactionOwner(owner, lock)) {
      throw new Error(`${lock.label} transaction ownership changed`);
    }
    unlinkSync(lock.path);
  } finally {
    try { unlinkSync(claimPath); } finally { syncDirectory(dirname(lock.path)); }
  }
}

/**
 * Runs one asynchronous decision under the same bounded process-shared
 * ownership as {@link withExactPrivateStateFileTransaction}. Waiting between
 * admission attempts yields to the event loop instead of blocking it.
 */
export async function withExactPrivateStateFileTransactionAsync<T>(
  pathValue: string,
  options: ExactPrivateStateTransactionOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireTransactionAsync(pathValue, options);
  try {
    return await operation();
  } finally {
    releaseTransaction(lock);
  }
}

/** Runs one synchronous fresh-read decision under bounded process-shared ownership. */
export function withExactPrivateStateFileTransaction<T>(
  pathValue: string,
  options: ExactPrivateStateTransactionOptions,
  operation: () => T,
): T {
  const lock = acquireTransaction(pathValue, options);
  try {
    const result = operation();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new TypeError(`${options.label} transaction operation must be synchronous`);
    }
    return result;
  } finally {
    releaseTransaction(lock);
  }
}
