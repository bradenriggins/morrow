import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import {
  canonicalPrivateStateFilePath,
  createExactPrivateStateFile,
  decodeExactUtf8,
  hardenPrivateDirectory,
  privateFileAccessAccepted,
  processMatchesRecordedLifetime,
  readExactPrivateStateFile,
  type ProcessLifetimeMatcher,
} from "@morrow/gateway-core";

const LEASE_SCHEMA = "morrow.runtime-lease.v1";
const DEFAULT_HEARTBEAT_MS = 10_000;
const INVALID_LEASE_GRACE_MS = 30_000;
const LEASE_MAX_BYTES = 1_024;
const LEASE_FILE_OPTIONS = Object.freeze({
  label: "Morrow runtime state lease",
  maxBytes: LEASE_MAX_BYTES,
  minBytes: 2,
});

interface LeaseRecord {
  readonly schema: typeof LEASE_SCHEMA;
  readonly nonce: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly heartbeatAt: string;
}

export interface RuntimeStateLeaseOptions {
  readonly heartbeatMs?: number;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly processAlive?: (pid: number) => boolean;
  readonly processMatches?: ProcessLifetimeMatcher;
  readonly onOwnershipLost?: (error: Error) => void | Promise<void>;
}

export interface RuntimeStateLeaseHealth {
  readonly schema: "morrow.runtime-lease.health.v1";
  readonly active: boolean;
  readonly statePath: string;
  readonly lockPath: string | null;
  readonly pid: number;
  readonly startedAt: string;
  readonly heartbeatAt: string;
}

function exactHeartbeat(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(value) || value < 500 || value > 60_000) {
    throw new TypeError("runtime lease heartbeat must be a whole number from 500 through 60000");
  }
  return value;
}

function exactPid(value: number | undefined): number {
  const pid = value ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError("runtime lease pid is invalid");
  return pid;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function hardenMorrowStateFiles(statePathValue: string): void {
  const statePath = String(statePathValue || "").trim();
  if (!statePath || statePath === ":memory:") return;
  const path = canonicalPrivateStateFilePath(statePath, "Morrow runtime state");
  const directory = dirname(path);
  if (!hardenPrivateDirectory(directory)) {
    throw new Error("Morrow runtime state directory is not private");
  }
  for (const candidate of [
    path,
    `${path}-wal`,
    `${path}-shm`,
    `${path}.batch.key`,
    `${path}.runtime.lock`,
  ]) {
    let named: Stats;
    try {
      named = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
      throw new Error("Morrow runtime state contains an unsafe file");
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let descriptor: number;
    try {
      descriptor = openSync(candidate, constants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || !sameFile(named, opened)) {
        throw new Error("Morrow runtime state file changed during privacy hardening");
      }
      fchmodSync(descriptor, 0o600);
      const hardened = fstatSync(descriptor);
      let current: Stats;
      try {
        current = lstatSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!sameFile(opened, hardened) || !sameFile(opened, current)
        || !privateFileAccessAccepted(candidate, hardened.mode, { trustedRoot: directory })) {
        throw new Error("Morrow runtime state file privacy could not be enforced");
      }
    } finally {
      closeSync(descriptor);
    }
  }
}

function parseLease(value: string): LeaseRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<LeaseRecord>;
    if (
      parsed.schema !== LEASE_SCHEMA
      || typeof parsed.nonce !== "string"
      || !/^[0-9a-f-]{36}$/i.test(parsed.nonce)
      || !Number.isSafeInteger(parsed.pid)
      || Number(parsed.pid) < 1
      || typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt))
      || typeof parsed.heartbeatAt !== "string" || !Number.isFinite(Date.parse(parsed.heartbeatAt))
    ) return null;
    return parsed as LeaseRecord;
  } catch {
    return null;
  }
}

function readLease(path: string): LeaseRecord | null {
  const content = readExactPrivateStateFile(path, LEASE_FILE_OPTIONS);
  if (content === null) return null;
  try { return parseLease(decodeExactUtf8(content, "Morrow runtime state lease")); } catch { return null; }
}

function leaseBytes(record: LeaseRecord): Buffer {
  const content = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (content.byteLength < LEASE_FILE_OPTIONS.minBytes || content.byteLength > LEASE_FILE_OPTIONS.maxBytes) {
    throw new Error("Morrow runtime state lease violates its byte bound");
  }
  return content;
}

function reclaimableLease(
  path: string,
  processMatches: ProcessLifetimeMatcher,
  nowMs: number,
): Stats | null | undefined {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const lease = readLease(path);
  if (lease && processMatches(lease.pid, lease.startedAt) !== false) return null;
  if (!lease && nowMs - before.mtimeMs < INVALID_LEASE_GRACE_MS) return null;
  let after: Stats;
  try {
    after = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return sameFile(before, after)
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    ? after
    : undefined;
}

function readPinnedLease(
  path: string,
  descriptor: number,
  identity: Stats,
  parentIdentity: Stats,
): LeaseRecord | null {
  const before = fstatSync(descriptor);
  const parent = lstatSync(dirname(path));
  const named = lstatSync(path);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !sameFile(parentIdentity, parent)
    || !before.isFile() || before.nlink !== 1 || !sameFile(identity, before) || !sameFile(identity, named)
    || !privateFileAccessAccepted(path, named.mode, { trustedRoot: dirname(path) })) {
    throw new Error("Morrow lost ownership of its exact private runtime state lease");
  }
  const buffer = Buffer.alloc(LEASE_MAX_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(descriptor, buffer, length, buffer.length - length, length);
    if (count === 0) break;
    length += count;
  }
  if (length < LEASE_FILE_OPTIONS.minBytes || length > LEASE_FILE_OPTIONS.maxBytes) {
    throw new Error("Morrow runtime state lease violates its byte bound");
  }
  const after = fstatSync(descriptor);
  const currentParent = lstatSync(dirname(path));
  const current = lstatSync(path);
  if (!sameFile(parentIdentity, currentParent) || !sameFile(identity, after) || !sameFile(identity, current)
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error("Morrow runtime state lease changed while it was read");
  }
  try { return parseLease(decodeExactUtf8(buffer.subarray(0, length), "Morrow runtime state lease")); } catch { return null; }
}

function openPinnedLease(
  path: string,
  expected: LeaseRecord,
  parentIdentity: Stats,
): { descriptor: number; identity: Stats } {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDWR | noFollow);
  try {
    const identity = fstatSync(descriptor);
    const current = readPinnedLease(path, descriptor, identity, parentIdentity);
    if (!current || current.nonce !== expected.nonce || current.pid !== expected.pid
      || current.startedAt !== expected.startedAt || current.heartbeatAt !== expected.heartbeatAt) {
      throw new Error("Morrow runtime state lease changed during acquisition");
    }
    return { descriptor, identity };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function writePinnedLease(
  path: string,
  descriptor: number,
  identity: Stats,
  parentIdentity: Stats,
  record: LeaseRecord,
): void {
  const content = leaseBytes(record);
  let written = 0;
  while (written < content.length) {
    const count = writeSync(descriptor, content, written, content.length - written, written);
    if (count === 0) throw new Error("Morrow runtime state lease write made no progress");
    written += count;
  }
  ftruncateSync(descriptor, content.length);
  fsyncSync(descriptor);
  const stored = readPinnedLease(path, descriptor, identity, parentIdentity);
  if (!stored || stored.nonce !== record.nonce || stored.pid !== record.pid
    || stored.startedAt !== record.startedAt || stored.heartbeatAt !== record.heartbeatAt) {
    throw new Error("Morrow runtime state lease failed exact readback");
  }
}

function unlinkPinnedLease(path: string, identity: Stats): boolean {
  try {
    const current = lstatSync(path);
    if (!sameFile(identity, current)) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class RuntimeStateLease {
  readonly statePath: string;
  readonly lockPath: string | null;
  readonly pid: number;
  readonly startedAt: string;

  private readonly nonce: string;
  private readonly now: () => Date;
  private readonly heartbeatMs: number;
  private readonly identity: Stats | null;
  private readonly parentIdentity: Stats | null;
  private readonly onOwnershipLost: ((error: Error) => void | Promise<void>) | undefined;
  private descriptor: number | null;
  private heartbeatAtValue: string;
  private timer: NodeJS.Timeout | null = null;
  private activeValue: boolean;
  private ownershipLossNotified = false;

  private constructor(
    statePath: string,
    lockPath: string | null,
    pid: number,
    nonce: string,
    startedAt: string,
    heartbeatMs: number,
    now: () => Date,
    active: boolean,
    descriptor: number | null,
    identity: Stats | null,
    parentIdentity: Stats | null,
    onOwnershipLost: ((error: Error) => void | Promise<void>) | undefined,
  ) {
    this.statePath = statePath;
    this.lockPath = lockPath;
    this.pid = pid;
    this.nonce = nonce;
    this.startedAt = startedAt;
    this.heartbeatAtValue = startedAt;
    this.heartbeatMs = heartbeatMs;
    this.now = now;
    this.activeValue = active;
    this.descriptor = descriptor;
    this.identity = identity;
    this.parentIdentity = parentIdentity;
    this.onOwnershipLost = onOwnershipLost;
    if (active) {
      this.timer = setInterval(() => {
        try {
          this.heartbeat();
        } catch (error) {
          this.notifyOwnershipLost(error instanceof Error ? error : new Error(String(error)));
        }
      }, heartbeatMs);
      this.timer.unref();
    }
  }

  private deactivate(): void {
    this.activeValue = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.descriptor !== null) closeSync(this.descriptor);
    this.descriptor = null;
  }

  private notifyOwnershipLost(error: Error): void {
    if (this.ownershipLossNotified) return;
    this.ownershipLossNotified = true;
    if (!this.onOwnershipLost) {
      queueMicrotask(() => { throw error; });
      return;
    }
    try {
      const result = this.onOwnershipLost(error);
      if (result) void Promise.resolve(result).catch((callbackError: unknown) => {
        queueMicrotask(() => { throw callbackError; });
      });
    } catch (callbackError) {
      queueMicrotask(() => { throw callbackError; });
    }
  }

  static acquire(
    statePathValue: string,
    options: RuntimeStateLeaseOptions = {},
  ): RuntimeStateLease {
    const rawStatePath = String(statePathValue || "").trim();
    if (!rawStatePath) throw new TypeError("runtime state path is required");
    const now = options.now ?? (() => new Date());
    const pid = exactPid(options.pid);
    const heartbeatMs = exactHeartbeat(options.heartbeatMs);
    const nonce = randomUUID();
    const startedAt = now().toISOString();
    if (rawStatePath === ":memory:") {
      return new RuntimeStateLease(
        rawStatePath,
        null,
        pid,
        nonce,
        startedAt,
        heartbeatMs,
        now,
        false,
        null,
        null,
        null,
        options.onOwnershipLost,
      );
    }

    const statePath = canonicalPrivateStateFilePath(rawStatePath, "Morrow runtime state");
    const lockPath = `${statePath}.runtime.lock`;
    const processMatches = options.processMatches
      ?? (options.processAlive ? (candidate: number) => options.processAlive!(candidate) : processMatchesRecordedLifetime);
    const parentPath = dirname(statePath);
    if (!hardenPrivateDirectory(parentPath)) {
      throw new Error("Morrow runtime state directory is not private");
    }
    const parentIdentity = lstatSync(parentPath);
    if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) {
      throw new Error("Morrow runtime state parent is not one exact directory");
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record: LeaseRecord = {
        schema: LEASE_SCHEMA,
        nonce,
        pid,
        startedAt,
        heartbeatAt: startedAt,
      };
      if (createExactPrivateStateFile(lockPath, leaseBytes(record), LEASE_FILE_OPTIONS)) {
        let pinned: { descriptor: number; identity: Stats } | null = null;
        try {
          pinned = openPinnedLease(lockPath, record, parentIdentity);
          hardenMorrowStateFiles(statePath);
          const hardenedParent = lstatSync(parentPath);
          if (!sameFile(parentIdentity, hardenedParent)) {
            throw new Error("Morrow runtime state parent changed during acquisition");
          }
        } catch (error) {
          if (pinned) {
            try { unlinkPinnedLease(lockPath, pinned.identity); } catch { /* preserve the primary failure */ }
            closeSync(pinned.descriptor);
          }
          throw error;
        }
        return new RuntimeStateLease(
          statePath,
          lockPath,
          pid,
          nonce,
          startedAt,
          heartbeatMs,
          now,
          true,
          pinned.descriptor,
          pinned.identity,
          parentIdentity,
          options.onOwnershipLost,
        );
      }
      const reclaimable = reclaimableLease(lockPath, processMatches, now().getTime());
      if (reclaimable === null) {
        const current = readLease(lockPath);
        const owner = current ? `process ${current.pid}` : "another starting process";
        throw new Error(
          `Morrow state is already leased by ${owner}. Use one Morrow server for this state path or configure a separate state path.`,
        );
      }
      if (reclaimable && !unlinkPinnedLease(lockPath, reclaimable)) continue;
    }
    throw new Error("Morrow could not acquire its local runtime state lease.");
  }

  get active(): boolean {
    return this.activeValue;
  }

  heartbeat(): void {
    if (!this.activeValue || !this.lockPath) return;
    const descriptor = this.descriptor;
    const identity = this.identity;
    const parentIdentity = this.parentIdentity;
    if (descriptor === null || identity === null || parentIdentity === null) {
      this.deactivate();
      throw new Error("Morrow lost ownership of its local runtime state lease.");
    }
    try {
      const current = readPinnedLease(this.lockPath, descriptor, identity, parentIdentity);
      if (!current || current.nonce !== this.nonce || current.pid !== this.pid
        || current.startedAt !== this.startedAt) {
        throw new Error("Morrow lost ownership of its local runtime state lease.");
      }
      const heartbeatAt = this.now().toISOString();
      writePinnedLease(this.lockPath, descriptor, identity, parentIdentity, {
        ...current,
        heartbeatAt,
      });
      this.heartbeatAtValue = heartbeatAt;
      hardenMorrowStateFiles(this.statePath);
    } catch (error) {
      this.deactivate();
      throw error;
    }
  }

  health(): RuntimeStateLeaseHealth {
    return {
      schema: "morrow.runtime-lease.health.v1",
      active: this.activeValue,
      statePath: this.statePath,
      lockPath: this.lockPath,
      pid: this.pid,
      startedAt: this.startedAt,
      heartbeatAt: this.heartbeatAtValue,
    };
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.activeValue || !this.lockPath) {
      this.deactivate();
      return;
    }
    const descriptor = this.descriptor;
    const identity = this.identity;
    const parentIdentity = this.parentIdentity;
    let releaseError: unknown;
    try {
      if (descriptor === null || identity === null || parentIdentity === null) {
        throw new Error("Morrow lost ownership of its local runtime state lease.");
      }
      const current = readPinnedLease(this.lockPath, descriptor, identity, parentIdentity);
      if (current?.nonce === this.nonce && current.pid === this.pid
        && current.startedAt === this.startedAt) {
        unlinkPinnedLease(this.lockPath, identity);
      }
    } catch (error) {
      releaseError = error;
    } finally {
      this.deactivate();
    }
    if (releaseError !== undefined) throw releaseError;
  }
}
