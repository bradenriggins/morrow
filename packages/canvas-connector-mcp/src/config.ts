import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isJsonObject } from "@morrow/contracts";
import {
  canonicalPrivateStateFilePath,
  hardenPrivateDirectory,
  decodeExactUtf8,
  privateDirectoryAccessAccepted,
  privateFileAccessAccepted,
  processMatchesExactStart,
  readExactPrivateStateFile,
  withExactPrivateStateFileTransactionAsync,
} from "@morrow/gateway-core";

export interface CanvasConnectorConfig {
  readonly statePath: string;
  readonly catalogPath: string;
  readonly token: string;
  readonly port: number;
  readonly runtimeRevision: string;
  readonly allowedExtensionIds: readonly string[];
  readonly approveExtensionId: (extensionId: string) => Promise<void>;
}

interface ConnectorState {
  readonly schema: "morrow.canvas-connector.state.v1";
  readonly token: string;
  readonly port: number;
  readonly allowedExtensionIds: readonly string[];
}

/** The superseded connector-owned lock record, recognised only to remove a dead owner's lock. */
interface LegacyStateTransactionLock {
  readonly schema: "morrow.canvas-connector.state-transaction.v1";
  readonly nonce: string;
  readonly pid: number;
  readonly processStartedAt: string;
  readonly acquiredAt: number;
}

interface ExactPrivateBytes {
  readonly bytes: Buffer;
  readonly identity: Stats;
}

const stateQueues = new Map<string, Promise<void>>();
const MAX_STATE_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 4 * 1024;

async function withStateQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = stateQueues.get(path) || Promise.resolve();
  let release = (): void => undefined;
  const current = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => { release = resolve; }));
  stateQueues.set(path, current);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (stateQueues.get(path) === current) stateQueues.delete(path);
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactOwner(metadata: Stats): boolean {
  return typeof process.getuid !== "function" || metadata.uid === process.getuid();
}

function changedDuringAdmission(label: string): Error & { code: "EAGAIN" } {
  return Object.assign(new Error(`${label} changed during admission`), { code: "EAGAIN" as const });
}

async function unlinkIfSame(path: string, identity: Stats | null): Promise<void> {
  if (!identity) return;
  const current = await lstat(path).catch(() => null);
  if (current && sameFile(identity, current)) await unlink(path).catch(() => undefined);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dirname(path), constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function preparePrivateFile(path: string, content: string, maximum: number, label: string): Promise<Stats> {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > maximum) throw new Error(`${label} is too large`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  let created: Stats | null = null;
  try {
    created = await handle.stat();
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const prepared = await handle.stat();
    if (!created.isFile() || created.nlink !== 1 || !prepared.isFile() || prepared.nlink !== 1
      || !sameFile(created, prepared) || !exactOwner(prepared)) {
      throw new Error("connector private file owner is invalid");
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlinkIfSame(path, created);
    throw error;
  }
  try {
    await handle.close();
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
      || !sameFile(created, named) || !exactOwner(named)
      || !privateFileAccessAccepted(path, named.mode, { trustedRoot: dirname(path) })) {
      throw new Error("connector private file could not be admitted");
    }
    return named;
  } catch (error) {
    await unlinkIfSame(path, created);
    throw error;
  }
}

async function readPrivateBytes(path: string, maximum: number, label: string): Promise<ExactPrivateBytes> {
  const named = await lstat(path);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
    || named.size > maximum || !exactOwner(named)) {
    throw new Error(`${label} is not a bounded private regular file`);
  }
  if (!privateFileAccessAccepted(path, named.mode, { trustedRoot: dirname(path) })) {
    const current = await lstat(path);
    if (!sameFile(named, current)) throw changedDuringAdmission(label);
    throw new Error(`${label} is not a bounded private regular file`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximum
      || !exactOwner(opened) || !sameFile(named, opened)) {
      throw changedDuringAdmission(label);
    }
    const bytes = Buffer.alloc(maximum + 1);
    let offset = 0;
    for (;;) {
      const next = await handle.read(bytes, offset, bytes.length - offset, offset);
      offset += next.bytesRead;
      if (next.bytesRead === 0 || offset === bytes.length) break;
    }
    if (offset > maximum) throw new Error(`${label} is too large`);
    const after = await handle.stat();
    const current = await lstat(path);
    if (!sameFile(opened, after) || !sameFile(opened, current)
      || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw changedDuringAdmission(label);
    }
    return { bytes: bytes.subarray(0, offset), identity: after };
  } finally {
    await handle.close();
  }
}

function legacyStateTransactionLock(value: unknown): LegacyStateTransactionLock | null {
  if (!isJsonObject(value)
    || Object.keys(value).sort().join("\0") !== ["acquiredAt", "nonce", "pid", "processStartedAt", "schema"].join("\0")
    || value.schema !== "morrow.canvas-connector.state-transaction.v1"
    || typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.nonce)
    || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || Number(value.pid) > 2_147_483_647
    || typeof value.processStartedAt !== "string" || !Number.isFinite(Date.parse(value.processStartedAt))
    || !Number.isSafeInteger(value.acquiredAt) || Number(value.acquiredAt) < 0) return null;
  return value as unknown as LegacyStateTransactionLock;
}

function syncDirectorySync(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/**
 * Removes only a complete lock from the superseded connector-owned schema
 * whose owner process no longer runs, so a connector upgraded under a dead
 * owner's lock can enter the shared transaction.
 */
function reclaimLegacyStateTransaction(pathValue: string): void {
  const path = `${canonicalPrivateStateFilePath(pathValue, "connector state")}.transaction.lock`;
  let content: Buffer | null;
  try {
    content = readExactPrivateStateFile(path, { label: "connector legacy state transaction lock", maxBytes: MAX_LOCK_BYTES, minBytes: 1 });
  } catch {
    return;
  }
  if (content === null) return;
  let parsed: unknown;
  try { parsed = JSON.parse(decodeExactUtf8(content, "connector legacy state transaction lock")); } catch { return; }
  const owner = legacyStateTransactionLock(parsed);
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
    syncDirectorySync(path);
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    if (linked) {
      try { unlinkSync(claim); } catch { /* the claim is already gone */ }
    }
  }
}

/**
 * Serialises connector state changes across processes through the one
 * Gateway Core private-state transaction primitive; the in-process queue only
 * keeps this process from competing with itself for that lock.
 */
async function withStateTransaction<T>(path: string, work: () => Promise<T>): Promise<T> {
  return await withStateQueue(path, async () => {
    reclaimLegacyStateTransaction(path);
    return await withExactPrivateStateFileTransactionAsync(path, { label: "connector state" }, work);
  });
}

function exactPort(value: unknown): number {
  const port = Number(value ?? 32147);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("connector port is invalid");
  return port;
}

function exactIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !/^[a-p]{32}$/.test(entry))) {
    throw new TypeError("connector extension ids are invalid");
  }
  return [...new Set(value)].sort();
}

function parseState(value: unknown): ConnectorState {
  if (!isJsonObject(value) || value.schema !== "morrow.canvas-connector.state.v1") {
    throw new TypeError("connector state is invalid");
  }
  const token = String(value.token || "");
  if (token.length < 32 || token.length > 512) throw new TypeError("connector token is invalid");
  return {
    schema: "morrow.canvas-connector.state.v1",
    token,
    port: exactPort(value.port),
    allowedExtensionIds: exactIds(value.allowedExtensionIds),
  };
}

async function exactStatePath(input: string): Promise<string> {
  const requested = resolve(input);
  const requestedParent = dirname(requested);
  let created = false;
  try {
    await lstat(requestedParent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = await mkdir(requestedParent, { recursive: true, mode: 0o700 }) !== undefined;
  }
  const canonicalParent = await realpath(requestedParent);
  if (created && !hardenPrivateDirectory(canonicalParent)) throw new Error("connector state directory is not private");
  if (!privateDirectoryAccessAccepted(canonicalParent)) throw new Error("connector state directory is not private");
  return join(canonicalParent, basename(requested));
}

async function readState(path: string): Promise<ConnectorState> {
  const admitted = await readPrivateBytes(path, MAX_STATE_BYTES, "connector state file");
  return parseState(JSON.parse(decodeExactUtf8(admitted.bytes, "connector state file")) as unknown);
}

async function persist(path: string, state: ConnectorState): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  let prepared: Stats | null = null;
  try {
    prepared = await preparePrivateFile(temporary, `${JSON.stringify(state)}\n`, MAX_STATE_BYTES, "connector state file");
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(path);
    const saved = await readState(path);
    if (JSON.stringify(saved) !== JSON.stringify(state)) throw new Error("connector state readback mismatch");
  } finally {
    await unlinkIfSame(temporary, prepared);
  }
}

async function loadOrCreate(path: string): Promise<ConnectorState> {
  try {
    return await readState(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const state: ConnectorState = {
    schema: "morrow.canvas-connector.state.v1",
    token: randomBytes(48).toString("base64url"),
    port: 32147,
    allowedExtensionIds: [],
  };
  await persist(path, state);
  return state;
}

export async function loadCanvasConnectorConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): Promise<CanvasConnectorConfig> {
  const statePath = await exactStatePath(environment.MORROW_CANVAS_CONNECTOR_STATE || `${homedir()}/.morrow/canvas-connector.json`);
  const state = await withStateTransaction(statePath, async () => await loadOrCreate(statePath));
  const token = String(environment.MORROW_CANVAS_CONNECTOR_TOKEN || state.token).trim();
  if (token.length < 32 || token.length > 512) throw new TypeError("MORROW_CANVAS_CONNECTOR_TOKEN is invalid");
  const idsFromEnvironment = String(environment.MORROW_CANVAS_CONNECTOR_EXTENSION_IDS || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const allowedExtensionIds = idsFromEnvironment.length > 0 ? exactIds(idsFromEnvironment) : state.allowedExtensionIds;
  const catalogPath = resolve(
    workingDirectory,
    environment.MORROW_CANVAS_CATALOG_PATH || "artifacts/canvas-api/canvas-api-catalog.json",
  );
  return {
    statePath,
    catalogPath,
    token,
    port: exactPort(environment.MORROW_CANVAS_CONNECTOR_PORT || state.port),
    runtimeRevision: String(environment.MORROW_CANVAS_CONNECTOR_REVISION || "1.0.0-rc.2").trim(),
    allowedExtensionIds,
    approveExtensionId: async (extensionId: string) => {
      await withStateTransaction(statePath, async () => {
        const latest = await loadOrCreate(statePath);
        await persist(statePath, {
          ...latest,
          allowedExtensionIds: exactIds([...latest.allowedExtensionIds, extensionId]),
        });
      });
    },
  };
}
