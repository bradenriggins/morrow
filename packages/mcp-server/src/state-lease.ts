import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const LEASE_SCHEMA = "morrow.runtime-lease.v1";
const DEFAULT_HEARTBEAT_MS = 10_000;
const INVALID_LEASE_GRACE_MS = 30_000;

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

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return true;
  }
}

function safeChmod(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* best effort on non-POSIX filesystems */ }
}

export function hardenMorrowStateFiles(statePathValue: string): void {
  const statePath = String(statePathValue || "").trim();
  if (!statePath || statePath === ":memory:") return;
  const path = resolve(statePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  safeChmod(dirname(path), 0o700);
  for (const candidate of [
    path,
    `${path}-wal`,
    `${path}-shm`,
    `${path}.batch.key`,
    `${path}.runtime.lock`,
  ]) {
    if (existsSync(candidate)) safeChmod(candidate, 0o600);
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
      || typeof parsed.startedAt !== "string"
      || typeof parsed.heartbeatAt !== "string"
    ) return null;
    return parsed as LeaseRecord;
  } catch {
    return null;
  }
}

function readLease(path: string): LeaseRecord | null {
  try {
    return parseLease(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeLease(path: string, descriptor: number | null, record: LeaseRecord): void {
  const content = `${JSON.stringify(record)}\n`;
  if (descriptor !== null) {
    writeFileSync(descriptor, content, "utf8");
  } else {
    writeFileSync(path, content, { encoding: "utf8", flag: "w", mode: 0o600 });
  }
  safeChmod(path, 0o600);
}

function reclaimableLease(
  path: string,
  processAlive: (pid: number) => boolean,
  nowMs: number,
): boolean {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    return true;
  }
  const lease = readLease(path);
  if (lease && processAlive(lease.pid)) return false;
  if (!lease && nowMs - before.mtimeMs < INVALID_LEASE_GRACE_MS) return false;
  let after;
  try {
    after = lstatSync(path);
  } catch {
    return true;
  }
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

export class RuntimeStateLease {
  readonly statePath: string;
  readonly lockPath: string | null;
  readonly pid: number;
  readonly startedAt: string;

  private readonly nonce: string;
  private readonly now: () => Date;
  private readonly heartbeatMs: number;
  private heartbeatAtValue: string;
  private timer: NodeJS.Timeout | null = null;
  private activeValue: boolean;

  private constructor(
    statePath: string,
    lockPath: string | null,
    pid: number,
    nonce: string,
    startedAt: string,
    heartbeatMs: number,
    now: () => Date,
    active: boolean,
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
    if (active) {
      this.timer = setInterval(() => {
        try { this.heartbeat(); } catch { /* startup owner remains authoritative */ }
      }, heartbeatMs);
      this.timer.unref();
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
      );
    }

    const statePath = resolve(rawStatePath);
    const lockPath = `${statePath}.runtime.lock`;
    const processAlive = options.processAlive ?? defaultProcessAlive;
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    safeChmod(dirname(statePath), 0o700);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let descriptor: number | null = null;
      try {
        descriptor = openSync(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        const record: LeaseRecord = {
          schema: LEASE_SCHEMA,
          nonce,
          pid,
          startedAt,
          heartbeatAt: startedAt,
        };
        writeLease(lockPath, descriptor, record);
        closeSync(descriptor);
        descriptor = null;
        hardenMorrowStateFiles(statePath);
        return new RuntimeStateLease(
          statePath,
          lockPath,
          pid,
          nonce,
          startedAt,
          heartbeatMs,
          now,
          true,
        );
      } catch (error) {
        if (descriptor !== null) {
          try { closeSync(descriptor); } catch { /* preserve original error */ }
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (!reclaimableLease(lockPath, processAlive, now().getTime())) {
          const current = readLease(lockPath);
          const owner = current ? `process ${current.pid}` : "another starting process";
          throw new Error(
            `Morrow state is already leased by ${owner}. Use one Morrow server for this state path or configure a separate state path.`,
          );
        }
        try { unlinkSync(lockPath); } catch (unlinkError) {
          const unlinkCode = (unlinkError as NodeJS.ErrnoException).code;
          if (unlinkCode !== "ENOENT") throw unlinkError;
        }
      }
    }
    throw new Error("Morrow could not acquire its local runtime state lease.");
  }

  get active(): boolean {
    return this.activeValue;
  }

  heartbeat(): void {
    if (!this.activeValue || !this.lockPath) return;
    const current = readLease(this.lockPath);
    if (!current || current.nonce !== this.nonce || current.pid !== this.pid) {
      this.activeValue = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      throw new Error("Morrow lost ownership of its local runtime state lease.");
    }
    const heartbeatAt = this.now().toISOString();
    writeLease(this.lockPath, null, {
      ...current,
      heartbeatAt,
    });
    this.heartbeatAtValue = heartbeatAt;
    hardenMorrowStateFiles(this.statePath);
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
    if (!this.activeValue || !this.lockPath) return;
    const current = readLease(this.lockPath);
    if (current?.nonce === this.nonce && current.pid === this.pid) {
      try { unlinkSync(this.lockPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.activeValue = false;
  }
}
