import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isJsonObject } from "@morrow/contracts";
import {
  hardenPrivateDirectory,
  decodeExactUtf8,
  privateDirectoryAccessAccepted,
  privateFileAccessAccepted,
  processMatchesExactStart,
  readProcessStartedAt,
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

interface StateTransactionLock {
  readonly schema: "morrow.canvas-connector.state-transaction.v1";
  readonly nonce: string;
  readonly pid: number;
  readonly processStartedAt: string;
  readonly acquiredAt: number;
}

interface HeldStateTransactionLock extends StateTransactionLock {
  readonly path: string;
}

interface ExactPrivateBytes {
  readonly bytes: Buffer;
  readonly identity: Stats;
}

const stateQueues = new Map<string, Promise<void>>();
const MAX_STATE_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 4 * 1024;
const LOCK_WAIT_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;

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

async function readPrivateBytes(path: string, maximum: number, label: string, maximumLinks = 1): Promise<ExactPrivateBytes> {
  const named = await lstat(path);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink < 1 || named.nlink > maximumLinks
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
    if (!opened.isFile() || opened.nlink < 1 || opened.nlink > maximumLinks || opened.size > maximum
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

function parseStateTransactionLock(value: unknown): StateTransactionLock {
  if (!isJsonObject(value)
    || Object.keys(value).sort().join("\0") !== ["acquiredAt", "nonce", "pid", "processStartedAt", "schema"].join("\0")
    || value.schema !== "morrow.canvas-connector.state-transaction.v1"
    || typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.nonce)
    || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || Number(value.pid) > 2_147_483_647
    || typeof value.processStartedAt !== "string" || !Number.isFinite(Date.parse(value.processStartedAt))
    || !Number.isSafeInteger(value.acquiredAt) || Number(value.acquiredAt) < 0) {
    throw new Error("connector state transaction lock is invalid");
  }
  return value as unknown as StateTransactionLock;
}

async function readStateTransactionLock(path: string): Promise<StateTransactionLock> {
  const admitted = await readPrivateBytes(path, MAX_LOCK_BYTES, "connector state transaction lock", 2);
  let record: StateTransactionLock;
  try { record = parseStateTransactionLock(JSON.parse(decodeExactUtf8(admitted.bytes, "connector state transaction lock")) as unknown); } catch (error) {
    if (error instanceof Error && error.message === "connector state transaction lock is invalid") throw error;
    throw new Error("connector state transaction lock is invalid");
  }
  const current = await lstat(path);
  if (!sameFile(admitted.identity, current)) throw changedDuringAdmission("connector state transaction lock");
  if (current.nlink === 1) return record;
  const claimSuffix = `.reclaim-${record.nonce}`;
  const peerPaths = path.endsWith(claimSuffix)
    ? [path.slice(0, -claimSuffix.length)]
    : [
        `${path}${claimSuffix}`,
        `${path.slice(0, -".transaction.lock".length)}.lock-${record.pid}-${record.nonce}`,
      ];
  const peers = await Promise.all(peerPaths.map(async (peerPath) => await lstat(peerPath).catch(() => null)));
  if (peers.some((peer) => peer && sameFile(current, peer))) return record;
  const refreshed = await lstat(path);
  if (!sameFile(current, refreshed)) throw changedDuringAdmission("connector state transaction lock");
  if (refreshed.nlink === 1) return record;
  throw new Error("connector state transaction lock is not a bounded private regular file");
}

async function publishStateTransactionLock(
  path: string,
  record: StateTransactionLock,
  preparedPath: string,
  prepared: Stats,
): Promise<boolean> {
  if (!sameFile(prepared, await lstat(preparedPath))) throw new Error("connector state transaction lock preparation changed");
  let published = false;
  try {
    try {
      await link(preparedPath, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    if (!sameFile(prepared, await lstat(path))) throw new Error("connector state transaction lock publication changed");
    await unlink(preparedPath);
    await syncDirectory(path);
    const saved = await readStateTransactionLock(path);
    if (JSON.stringify(saved) !== JSON.stringify(record)) throw new Error("connector state transaction lock readback mismatch");
    return true;
  } catch (error) {
    if (published) {
      const current = await lstat(path).catch(() => null);
      if (current && sameFile(prepared, current)) {
        await unlink(path).catch(() => undefined);
        await syncDirectory(path).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function reclaimStateTransactionLock(path: string, record: StateTransactionLock): Promise<boolean> {
  if (processMatchesExactStart(record.pid, record.processStartedAt) !== false) return false;
  const claimPath = `${path}.reclaim-${record.nonce}`;
  let claimed: Stats | null = null;
  let cleanupClaim = false;
  try {
    await link(path, claimPath);
    claimed = await lstat(claimPath);
    cleanupClaim = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    claimed = await lstat(claimPath).catch(() => null);
    if (!claimed) return false;
  }
  try {
    const [current, claimedRecord] = await Promise.all([
      lstat(path).catch(() => null),
      readStateTransactionLock(claimPath),
    ]);
    if (claimedRecord.nonce !== record.nonce
      || processMatchesExactStart(claimedRecord.pid, claimedRecord.processStartedAt) !== false) return false;
    cleanupClaim = true;
    if (!current || !sameFile(claimed, current)) return false;
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await syncDirectory(path);
    return true;
  } finally {
    if (cleanupClaim) await unlinkIfSame(claimPath, claimed);
  }
}

async function acquireStateTransactionLock(path: string): Promise<HeldStateTransactionLock> {
  const processStartedAt = readProcessStartedAt(process.pid);
  if (processStartedAt === null) throw new Error("connector state transaction process lifetime is unavailable");
  const record: StateTransactionLock = {
    schema: "morrow.canvas-connector.state-transaction.v1",
    nonce: randomBytes(16).toString("hex"),
    pid: process.pid,
    processStartedAt: new Date(processStartedAt).toISOString(),
    acquiredAt: Date.now(),
  };
  const preparedPath = `${path}.lock-${record.pid}-${record.nonce}`;
  let prepared: Stats | null = null;
  try {
    prepared = await preparePrivateFile(
      preparedPath,
      `${JSON.stringify(record)}\n`,
      MAX_LOCK_BYTES,
      "connector state transaction lock",
    );
    const deadline = performance.now() + LOCK_TIMEOUT_MS;
    while (performance.now() <= deadline) {
      if (await publishStateTransactionLock(`${path}.transaction.lock`, record, preparedPath, prepared)) {
        return { ...record, path: `${path}.transaction.lock` };
      }
      let current: StateTransactionLock;
      try {
        current = await readStateTransactionLock(`${path}.transaction.lock`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EAGAIN") continue;
        throw error;
      }
      if (await reclaimStateTransactionLock(`${path}.transaction.lock`, current)) continue;
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
    throw new Error("connector state is busy in another process");
  } finally {
    await unlinkIfSame(preparedPath, prepared);
  }
}

async function releaseStateTransactionLock(lock: HeldStateTransactionLock): Promise<void> {
  const current = await readStateTransactionLock(lock.path);
  if (current.nonce !== lock.nonce || current.pid !== lock.pid || current.processStartedAt !== lock.processStartedAt) {
    throw new Error("connector state transaction ownership changed");
  }
  await unlink(lock.path);
  await syncDirectory(lock.path);
}

async function withStateTransaction<T>(path: string, work: () => Promise<T>): Promise<T> {
  return await withStateQueue(path, async () => {
    const lock = await acquireStateTransactionLock(path);
    try { return await work(); } finally { await releaseStateTransactionLock(lock); }
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
