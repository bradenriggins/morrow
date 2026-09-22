import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  canonicalPrivateStateFilePath,
  processMatchesExactStart,
  readExactPrivateStateFile,
  replaceExactPrivateStateFile,
  withExactPrivateStateFileTransaction,
} from "@morrow/gateway-core";

const MAX_DURABLE_STATE_BYTES = 1_048_576;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface LegacyTransactionOwner {
  readonly schema: "morrow.blackboard.state-transaction.v1";
  readonly nonce: string;
  readonly pid: number;
  readonly acquiredAt: number;
  readonly processStartedAt: string;
}

export interface DurableJsonState<T> {
  readonly revision: number;
  readonly value: T;
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function legacyOwner(value: unknown): LegacyTransactionOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== ["acquiredAt", "nonce", "pid", "processStartedAt", "schema"].join("\0")) return null;
  const owner = value as Partial<LegacyTransactionOwner>;
  if (owner.schema !== "morrow.blackboard.state-transaction.v1"
    || typeof owner.nonce !== "string" || !/^[0-9a-f-]{36}$/u.test(owner.nonce)
    || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1
    || !Number.isSafeInteger(owner.acquiredAt) || Number(owner.acquiredAt) < 0
    || typeof owner.processStartedAt !== "string" || !Number.isFinite(Date.parse(owner.processStartedAt))) return null;
  return owner as LegacyTransactionOwner;
}

/** Removes only a complete dead lock from the superseded Blackboard transaction schema. */
function reclaimLegacyTransaction(pathValue: string): void {
  const target = canonicalPrivateStateFilePath(pathValue, "Blackboard state");
  const path = `${target}.transaction.lock`;
  const content = readExactPrivateStateFile(path, {
    label: "Blackboard legacy state transaction",
    maxBytes: 4_096,
    minBytes: 1,
  });
  if (content === null) return;
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(content)); } catch { return; }
  const owner = legacyOwner(parsed);
  if (!owner || processMatchesExactStart(owner.pid, owner.processStartedAt) !== false) return;
  const before = lstatSync(path);
  const claim = `${path}.legacy-reclaim-${process.pid}-${randomUUID()}`;
  let linked = false;
  try {
    linkSync(path, claim);
    linked = true;
    const current = lstatSync(path);
    const claimed = lstatSync(claim);
    if (!sameFile(before, current) || !sameFile(current, claimed)
      || current.nlink !== 2 || claimed.nlink !== 2
      || current.size !== before.size || current.mtimeMs !== before.mtimeMs) return;
    unlinkSync(path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    if (linked) {
      try { unlinkSync(claim); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      syncDirectory(dirname(path));
    }
  }
}

/** Runs one fresh-read state decision while every cooperating process is excluded. */
export function withDurableStateTransaction<T>(
  path: string,
  action: () => T,
  _now: () => number = Date.now,
): T {
  reclaimLegacyTransaction(path);
  return withExactPrivateStateFileTransaction(path, {
    label: "Blackboard state",
    timeoutMs: 5_000,
    pollIntervalMs: 10,
  }, action);
}

/** Reads one bounded exact private JSON state file. A missing file is revision zero. */
export function readDurableJsonState<T>(
  pathValue: string,
  maxBytes: number,
  parse: (value: unknown) => DurableJsonState<T>,
  empty: () => T,
): DurableJsonState<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DURABLE_STATE_BYTES) {
    throw new TypeError("Blackboard state byte limit is invalid");
  }
  const path = canonicalPrivateStateFilePath(pathValue, "Blackboard state");
  const content = readExactPrivateStateFile(path, { label: "Blackboard state", maxBytes, minBytes: 1 });
  if (content === null) return { revision: 0, value: empty() };
  return parse(JSON.parse(decoder.decode(content)) as unknown);
}

/** Fsyncs and atomically replaces one exact private state file while its transaction is held. */
export function replaceDurableState(path: string, content: string): void {
  replaceExactPrivateStateFile(path, Buffer.from(content, "utf8"), {
    label: "Blackboard state",
    maxBytes: MAX_DURABLE_STATE_BYTES,
    minBytes: 1,
  });
}
