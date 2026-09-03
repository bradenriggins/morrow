import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  canonicalJson,
  isJsonObject,
  sha256Json,
  sha256Text,
  type JsonObject,
} from "@morrow/contracts";

export const BATCH_MODES = Object.freeze(["read_only", "stage_writes"] as const);
export type BatchMode = typeof BATCH_MODES[number];

export const BATCH_STATES = Object.freeze([
  "planned",
  "running",
  "paused",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "inspection_required",
] as const);
export type BatchState = typeof BATCH_STATES[number];

export const BATCH_CHILD_STATES = Object.freeze([
  "pending",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
] as const);
export type BatchChildState = typeof BATCH_CHILD_STATES[number];

export const MAX_BATCH_CHILDREN = 10_000;
export const MAX_BATCH_ARGUMENT_BYTES = 64 * 1024;
export const MAX_BATCH_MANIFEST_BYTES = 8 * 1024 * 1024;

export interface CreateBatchChildInput {
  readonly childId?: string;
  readonly publicToolName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly readOnly: boolean;
  readonly arguments: JsonObject;
  readonly idempotencyKey?: string;
  readonly sourceOperationId?: string;
}

export interface CreateBatchInput {
  readonly name: string;
  readonly mode: BatchMode;
  readonly catalogDigest: string;
  readonly concurrency: number;
  readonly children: readonly CreateBatchChildInput[];
}

export interface BatchRecord {
  readonly schema: "morrow.batch.v1";
  readonly batchId: string;
  readonly name: string;
  readonly mode: BatchMode;
  readonly catalogDigest: string;
  readonly manifestDigest: string;
  readonly state: BatchState;
  readonly concurrency: number;
  readonly totalChildren: number;
  readonly pendingChildren: number;
  readonly runningChildren: number;
  readonly succeededChildren: number;
  readonly failedChildren: number;
  readonly unknownChildren: number;
  readonly cancelledChildren: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly terminalAt: string | null;
  readonly revision: number;
}

export interface BatchChildRecord {
  readonly schema: "morrow.batch-child.v1";
  readonly batchId: string;
  readonly childId: string;
  readonly ordinal: number;
  readonly publicToolName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly readOnly: boolean;
  readonly requestDigest: string;
  readonly idempotencyKey: string;
  readonly sourceOperationId: string | null;
  readonly state: BatchChildState;
  readonly attemptCount: number;
  readonly gatewayOperationId: string | null;
  readonly gatewayOperationState: string | null;
  readonly sourceResultState: string | null;
  readonly sourceTaskId: string | null;
  readonly resultDigest: string | null;
  readonly errorDigest: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly terminalAt: string | null;
  readonly revision: number;
}

export interface BatchDetail {
  readonly batch: BatchRecord;
  readonly children: readonly BatchChildRecord[];
}

export interface BatchExecutionResult {
  readonly state: "succeeded" | "failed" | "unknown";
  readonly resultDigest: string;
  readonly gatewayOperationId?: string;
  readonly gatewayOperationState?: string;
  readonly sourceResultState?: string;
  readonly sourceTaskId?: string;
  readonly errorDigest?: string;
}

export interface BatchExecutorInput {
  readonly batch: BatchRecord;
  readonly child: BatchChildRecord;
  readonly arguments: JsonObject;
}

export type BatchExecutor = (input: BatchExecutorInput) => Promise<BatchExecutionResult>;

export interface RunBatchWindowOptions {
  readonly maxChildren?: number;
  readonly expectedCatalogDigest: string;
}

export interface BatchWindowResult {
  readonly schema: "morrow.batch-window.v1";
  readonly batch: BatchRecord;
  readonly processed: number;
  readonly remaining: number;
  readonly children: readonly BatchChildRecord[];
}

export interface DurableBatchStoreOptions {
  readonly path: string;
  readonly encryptionKey: Uint8Array;
  readonly now?: () => Date;
}

interface BatchRow {
  batch_id: string;
  name: string;
  mode: BatchMode;
  catalog_digest: string;
  manifest_digest: string;
  state: BatchState;
  concurrency: number;
  total_children: number;
  pending_children: number;
  running_children: number;
  succeeded_children: number;
  failed_children: number;
  unknown_children: number;
  cancelled_children: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  terminal_at: string | null;
  revision: number;
}

interface ChildRow {
  batch_id: string;
  child_id: string;
  ordinal: number;
  public_tool_name: string;
  source_id: string;
  source_tool_name: string;
  read_only: number;
  request_digest: string;
  request_ciphertext: string;
  request_iv: string;
  request_tag: string;
  idempotency_key: string;
  source_operation_id: string | null;
  state: BatchChildState;
  attempt_count: number;
  gateway_operation_id: string | null;
  gateway_operation_state: string | null;
  source_result_state: string | null;
  source_task_id: string | null;
  result_digest: string | null;
  error_digest: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  terminal_at: string | null;
  revision: number;
}

const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9_.:@-]{1,160}$/;
const TERMINAL_CHILD_STATES = new Set<BatchChildState>([
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
]);
const TERMINAL_BATCH_STATES = new Set<BatchState>([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "inspection_required",
]);

function exactString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

function exactName(value: unknown, label: string): string {
  const normalized = exactString(value, label, 160);
  if (!NAME.test(normalized)) throw new TypeError(`${label} has an invalid format`);
  return normalized;
}

function exactDigest(value: unknown, label: string): string {
  const normalized = exactString(value, label, 64);
  if (!SHA256.test(normalized)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return normalized;
}

function exactConcurrency(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 16) {
    throw new TypeError("batch concurrency must be a whole number from 1 through 16");
  }
  return Number(value);
}

function exactKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.length !== 32) throw new TypeError("batch encryption key must contain exactly 32 bytes");
  return key;
}

function childId(value: string | undefined, ordinal: number): string {
  const resolved = value ? exactName(value, "child id") : `child:${String(ordinal).padStart(6, "0")}`;
  return resolved;
}

function batchRecord(row: BatchRow): BatchRecord {
  return {
    schema: "morrow.batch.v1",
    batchId: row.batch_id,
    name: row.name,
    mode: row.mode,
    catalogDigest: row.catalog_digest,
    manifestDigest: row.manifest_digest,
    state: row.state,
    concurrency: row.concurrency,
    totalChildren: row.total_children,
    pendingChildren: row.pending_children,
    runningChildren: row.running_children,
    succeededChildren: row.succeeded_children,
    failedChildren: row.failed_children,
    unknownChildren: row.unknown_children,
    cancelledChildren: row.cancelled_children,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
    revision: row.revision,
  };
}

function childRecord(row: ChildRow): BatchChildRecord {
  return {
    schema: "morrow.batch-child.v1",
    batchId: row.batch_id,
    childId: row.child_id,
    ordinal: row.ordinal,
    publicToolName: row.public_tool_name,
    sourceId: row.source_id,
    sourceToolName: row.source_tool_name,
    readOnly: row.read_only === 1,
    requestDigest: row.request_digest,
    idempotencyKey: row.idempotency_key,
    sourceOperationId: row.source_operation_id,
    state: row.state,
    attemptCount: row.attempt_count,
    gatewayOperationId: row.gateway_operation_id,
    gatewayOperationState: row.gateway_operation_state,
    sourceResultState: row.source_result_state,
    sourceTaskId: row.source_task_id,
    resultDigest: row.result_digest,
    errorDigest: row.error_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
    revision: row.revision,
  };
}

function encryptedRequest(
  key: Buffer,
  batchId: string,
  childIdValue: string,
  requestDigest: string,
  value: JsonObject,
): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${batchId}\0${childIdValue}\0${requestDigest}`, "utf8"));
  const plaintext = Buffer.from(canonicalJson(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptedRequest(key: Buffer, row: ChildRow): JsonObject {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(row.request_iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(`${row.batch_id}\0${row.child_id}\0${row.request_digest}`, "utf8"));
  decipher.setAuthTag(Buffer.from(row.request_tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.request_ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as unknown;
  if (!isJsonObject(parsed) || sha256Json(parsed) !== row.request_digest) {
    throw new Error("batch child request failed authenticated readback");
  }
  return parsed;
}

export function loadOrCreateBatchEncryptionKey(pathValue: string): Uint8Array {
  const path = resolve(pathValue);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    if (existing.length !== 32) throw new Error("batch state key has an invalid length");
    try { chmodSync(path, 0o600); } catch { /* best effort outside POSIX */ }
    return existing;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${key.toString("base64url")}\n`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const existing = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    if (existing.length !== 32) throw new Error("batch state key has an invalid length");
    return existing;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return key;
}

export class DurableBatchStore {
  readonly path: string;
  private readonly database: DatabaseSync;
  private readonly key: Buffer;
  private readonly now: () => Date;
  private closed = false;
  private readonly selectBatch: StatementSync;
  private readonly selectChild: StatementSync;

  constructor(options: DurableBatchStoreOptions) {
    this.path = options.path === ":memory:" ? ":memory:" : resolve(options.path);
    this.key = exactKey(options.encryptionKey);
    this.now = options.now ?? (() => new Date());
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      ${this.path === ":memory:" ? "" : "PRAGMA journal_mode = WAL;"}
      CREATE TABLE IF NOT EXISTS gateway_batches (
        batch_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('read_only','stage_writes')),
        catalog_digest TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('planned','running','paused','completed','partial','failed','cancelled','inspection_required')),
        concurrency INTEGER NOT NULL CHECK(concurrency BETWEEN 1 AND 16),
        total_children INTEGER NOT NULL,
        pending_children INTEGER NOT NULL,
        running_children INTEGER NOT NULL,
        succeeded_children INTEGER NOT NULL,
        failed_children INTEGER NOT NULL,
        unknown_children INTEGER NOT NULL,
        cancelled_children INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        terminal_at TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS gateway_batch_children (
        batch_id TEXT NOT NULL REFERENCES gateway_batches(batch_id) ON DELETE CASCADE,
        child_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        public_tool_name TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_tool_name TEXT NOT NULL,
        read_only INTEGER NOT NULL CHECK(read_only IN (0,1)),
        request_digest TEXT NOT NULL,
        request_ciphertext TEXT NOT NULL,
        request_iv TEXT NOT NULL,
        request_tag TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        source_operation_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','unknown','cancelled')),
        attempt_count INTEGER NOT NULL,
        gateway_operation_id TEXT,
        gateway_operation_state TEXT,
        source_result_state TEXT,
        source_task_id TEXT,
        result_digest TEXT,
        error_digest TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        terminal_at TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        PRIMARY KEY(batch_id, child_id),
        UNIQUE(batch_id, ordinal),
        UNIQUE(batch_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS gateway_batch_children_state
        ON gateway_batch_children(batch_id, state, ordinal);
    `);
    this.selectBatch = this.database.prepare("SELECT * FROM gateway_batches WHERE batch_id=?");
    this.selectChild = this.database.prepare(
      "SELECT * FROM gateway_batch_children WHERE batch_id=? AND child_id=?",
    );
    this.recoverRunningChildren();
  }

  private instant(): string {
    return this.now().toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("batch store is closed");
  }

  private transaction<T>(body: () => T): T {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = body();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  private recoverRunningChildren(): void {
    const now = this.instant();
    this.transaction(() => {
      const batches = this.database.prepare(`
        SELECT DISTINCT batch_id FROM gateway_batch_children WHERE state='running'
      `).all() as { batch_id: string }[];
      this.database.prepare(`
        UPDATE gateway_batch_children
        SET state='unknown', gateway_operation_state=COALESCE(gateway_operation_state, 'process_restart'),
            error_digest=?, updated_at=?, terminal_at=?, revision=revision+1
        WHERE state='running'
      `).run(sha256Text("process_restart_during_batch_child"), now, now);
      for (const batch of batches) this.refreshCounts(batch.batch_id, "inspection_required");
    });
  }

  private refreshCounts(batchId: string, forcedState?: BatchState): BatchRecord {
    const counts = this.database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN state='running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END) AS unknown_count,
        SUM(CASE WHEN state='cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM gateway_batch_children WHERE batch_id=?
    `).get(batchId) as Record<string, number>;
    const current = this.getBatch(batchId);
    let state = forcedState ?? current.state;
    const pending = Number(counts.pending || 0);
    const running = Number(counts.running || 0);
    const succeeded = Number(counts.succeeded || 0);
    const failed = Number(counts.failed || 0);
    const unknown = Number(counts.unknown_count || 0);
    const cancelled = Number(counts.cancelled || 0);
    if (!forcedState && current.state === "running" && pending === 0 && running === 0) {
      if (unknown > 0) state = "inspection_required";
      else if (succeeded === Number(counts.total || 0)) state = "completed";
      else if (succeeded > 0) state = "partial";
      else if (cancelled === Number(counts.total || 0)) state = "cancelled";
      else state = "failed";
    }
    const now = this.instant();
    const terminalAt = TERMINAL_BATCH_STATES.has(state) ? now : current.terminalAt;
    this.database.prepare(`
      UPDATE gateway_batches
      SET state=?, total_children=?, pending_children=?, running_children=?, succeeded_children=?,
          failed_children=?, unknown_children=?, cancelled_children=?, updated_at=?, terminal_at=?, revision=revision+1
      WHERE batch_id=?
    `).run(
      state,
      Number(counts.total || 0),
      pending,
      running,
      succeeded,
      failed,
      unknown,
      cancelled,
      now,
      terminalAt,
      batchId,
    );
    return this.getBatch(batchId);
  }

  create(input: CreateBatchInput): BatchDetail {
    const name = exactString(input.name, "batch name", 200);
    if (!BATCH_MODES.includes(input.mode)) throw new TypeError("batch mode is invalid");
    const catalogDigest = exactDigest(input.catalogDigest, "catalog digest");
    const concurrency = exactConcurrency(input.concurrency);
    if (!Array.isArray(input.children) || input.children.length < 1 || input.children.length > MAX_BATCH_CHILDREN) {
      throw new TypeError(`batch must contain 1 through ${MAX_BATCH_CHILDREN} children`);
    }
    const batchId = `bat:${randomUUID()}`;
    const normalized = input.children.map((child, index) => {
      if (!isJsonObject(child.arguments)) throw new TypeError(`child ${index + 1} arguments must be an object`);
      const argumentsClone = structuredClone(child.arguments);
      const text = canonicalJson(argumentsClone);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > MAX_BATCH_ARGUMENT_BYTES) {
        throw new RangeError(`child ${index + 1} arguments exceed ${MAX_BATCH_ARGUMENT_BYTES} bytes`);
      }
      const id = childId(child.childId, index + 1);
      return {
        childId: id,
        ordinal: index + 1,
        publicToolName: exactName(child.publicToolName, "public tool name"),
        sourceId: exactName(child.sourceId, "source id"),
        sourceToolName: exactName(child.sourceToolName, "source tool name"),
        readOnly: child.readOnly === true,
        arguments: argumentsClone,
        requestDigest: sha256Json(argumentsClone),
        idempotencyKey: child.idempotencyKey
          ? exactName(child.idempotencyKey, "idempotency key")
          : `batch:${sha256Text(`${batchId}\0${id}`).slice(0, 48)}`,
        sourceOperationId: child.sourceOperationId
          ? exactName(child.sourceOperationId, "source operation id")
          : (input.mode === "stage_writes"
            ? `operation:${sha256Text(`${batchId}\0${id}\0source`).slice(0, 48)}`
            : null),
        bytes,
      };
    });
    if (new Set(normalized.map((child) => child.childId)).size !== normalized.length) {
      throw new TypeError("batch child ids must be unique");
    }
    if (new Set(normalized.map((child) => child.idempotencyKey)).size !== normalized.length) {
      throw new TypeError("batch child idempotency keys must be unique");
    }
    const totalBytes = normalized.reduce((sum, child) => sum + child.bytes, 0);
    if (totalBytes > MAX_BATCH_MANIFEST_BYTES) {
      throw new RangeError(`batch arguments exceed ${MAX_BATCH_MANIFEST_BYTES} bytes`);
    }
    if (input.mode === "read_only" && normalized.some((child) => !child.readOnly)) {
      throw new TypeError("read_only batches may contain only read-only children");
    }
    if (input.mode === "stage_writes" && normalized.some((child) => child.readOnly || child.sourceId !== "morrow-legacy")) {
      throw new TypeError("stage_writes batches currently require Morrow legacy write children only");
    }
    const manifestDigest = sha256Json({
      name,
      mode: input.mode,
      catalogDigest,
      concurrency,
      children: normalized.map((child) => ({
        childId: child.childId,
        ordinal: child.ordinal,
        publicToolName: child.publicToolName,
        sourceId: child.sourceId,
        sourceToolName: child.sourceToolName,
        readOnly: child.readOnly,
        requestDigest: child.requestDigest,
        idempotencyKey: child.idempotencyKey,
        sourceOperationId: child.sourceOperationId,
      })),
    });
    const now = this.instant();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO gateway_batches(
          batch_id, name, mode, catalog_digest, manifest_digest, state, concurrency,
          total_children, pending_children, running_children, succeeded_children,
          failed_children, unknown_children, cancelled_children, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, 1)
      `).run(
        batchId,
        name,
        input.mode,
        catalogDigest,
        manifestDigest,
        concurrency,
        normalized.length,
        normalized.length,
        now,
        now,
      );
      const insert = this.database.prepare(`
        INSERT INTO gateway_batch_children(
          batch_id, child_id, ordinal, public_tool_name, source_id, source_tool_name, read_only,
          request_digest, request_ciphertext, request_iv, request_tag, idempotency_key,
          source_operation_id, state, attempt_count, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, 1)
      `);
      for (const child of normalized) {
        const encrypted = encryptedRequest(
          this.key,
          batchId,
          child.childId,
          child.requestDigest,
          child.arguments,
        );
        insert.run(
          batchId,
          child.childId,
          child.ordinal,
          child.publicToolName,
          child.sourceId,
          child.sourceToolName,
          child.readOnly ? 1 : 0,
          child.requestDigest,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          child.idempotencyKey,
          child.sourceOperationId,
          now,
          now,
        );
      }
    });
    return this.get(batchId);
  }

  getBatch(batchIdValue: string): BatchRecord {
    this.assertOpen();
    const batchId = exactName(batchIdValue, "batch id");
    const row = this.selectBatch.get(batchId) as BatchRow | undefined;
    if (!row) throw new Error("batch does not exist");
    return batchRecord(row);
  }

  get(batchIdValue: string): BatchDetail {
    const batch = this.getBatch(batchIdValue);
    const rows = this.database.prepare(`
      SELECT * FROM gateway_batch_children WHERE batch_id=? ORDER BY ordinal ASC
    `).all(batch.batchId) as unknown as ChildRow[];
    return { batch, children: rows.map(childRecord) };
  }

  list(limitValue = 50): readonly BatchRecord[] {
    this.assertOpen();
    const limit = Math.max(1, Math.min(Number(limitValue) || 50, 200));
    return (this.database.prepare(`
      SELECT * FROM gateway_batches ORDER BY created_at DESC, batch_id DESC LIMIT ?
    `).all(limit) as unknown as BatchRow[]).map(batchRecord);
  }

  pause(batchIdValue: string): BatchRecord {
    const batchId = exactName(batchIdValue, "batch id");
    return this.transaction(() => {
      const current = this.getBatch(batchId);
      if (!new Set<BatchState>(["planned", "running"]).has(current.state)) return current;
      this.database.prepare(`
        UPDATE gateway_batches SET state='paused', updated_at=?, revision=revision+1 WHERE batch_id=?
      `).run(this.instant(), batchId);
      return this.getBatch(batchId);
    });
  }

  cancel(batchIdValue: string): BatchRecord {
    const batchId = exactName(batchIdValue, "batch id");
    return this.transaction(() => {
      const current = this.getBatch(batchId);
      if (TERMINAL_BATCH_STATES.has(current.state)) return current;
      const now = this.instant();
      this.database.prepare(`
        UPDATE gateway_batch_children
        SET state='cancelled', updated_at=?, terminal_at=?, revision=revision+1
        WHERE batch_id=? AND state='pending'
      `).run(now, now, batchId);
      const counts = this.database.prepare(`
        SELECT
          SUM(CASE WHEN state='running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END) AS unknown_count,
          SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) AS succeeded,
          SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed
        FROM gateway_batch_children WHERE batch_id=?
      `).get(batchId) as Record<string, number>;
      const forcedState: BatchState = Number(counts.running || 0) > 0 || Number(counts.unknown_count || 0) > 0
        ? "inspection_required"
        : Number(counts.succeeded || 0) > 0 || Number(counts.failed || 0) > 0
          ? "partial"
          : "cancelled";
      return this.refreshCounts(batchId, forcedState);
    });
  }

  beginRun(batchIdValue: string, expectedCatalogDigestValue: string): BatchRecord {
    const batchId = exactName(batchIdValue, "batch id");
    const expectedCatalogDigest = exactDigest(expectedCatalogDigestValue, "expected catalog digest");
    return this.transaction(() => {
      const current = this.getBatch(batchId);
      if (TERMINAL_BATCH_STATES.has(current.state)) return current;
      if (current.catalogDigest !== expectedCatalogDigest) {
        this.database.prepare(`
          UPDATE gateway_batches
          SET state='paused', updated_at=?, revision=revision+1 WHERE batch_id=?
        `).run(this.instant(), batchId);
        throw new Error("batch catalog digest is stale; create a new frozen batch");
      }
      const now = this.instant();
      this.database.prepare(`
        UPDATE gateway_batches
        SET state='running', started_at=COALESCE(started_at, ?), updated_at=?, revision=revision+1
        WHERE batch_id=?
      `).run(now, now, batchId);
      return this.getBatch(batchId);
    });
  }

  claimPending(batchIdValue: string, limitValue: number): readonly BatchChildRecord[] {
    const batchId = exactName(batchIdValue, "batch id");
    const limit = Math.max(1, Math.min(Math.trunc(limitValue), 500));
    return this.transaction(() => {
      const batch = this.getBatch(batchId);
      if (batch.state !== "running") return [];
      const rows = this.database.prepare(`
        SELECT * FROM gateway_batch_children
        WHERE batch_id=? AND state='pending'
        ORDER BY ordinal ASC LIMIT ?
      `).all(batchId, limit) as unknown as ChildRow[];
      const now = this.instant();
      const update = this.database.prepare(`
        UPDATE gateway_batch_children
        SET state='running', attempt_count=attempt_count+1, started_at=COALESCE(started_at, ?),
            updated_at=?, revision=revision+1
        WHERE batch_id=? AND child_id=? AND state='pending'
      `);
      const claimed: BatchChildRecord[] = [];
      for (const row of rows) {
        const result = update.run(now, now, batchId, row.child_id);
        if (Number(result.changes) === 1) {
          claimed.push(childRecord(this.selectChild.get(batchId, row.child_id) as ChildRow));
        }
      }
      this.refreshCounts(batchId);
      return claimed;
    });
  }

  readArguments(batchIdValue: string, childIdValue: string): JsonObject {
    this.assertOpen();
    const batchId = exactName(batchIdValue, "batch id");
    const childIdResolved = exactName(childIdValue, "child id");
    const row = this.selectChild.get(batchId, childIdResolved) as ChildRow | undefined;
    if (!row) throw new Error("batch child does not exist");
    return decryptedRequest(this.key, row);
  }

  settleChild(
    batchIdValue: string,
    childIdValue: string,
    result: BatchExecutionResult,
  ): BatchChildRecord {
    const batchId = exactName(batchIdValue, "batch id");
    const childIdResolved = exactName(childIdValue, "child id");
    if (!new Set(["succeeded", "failed", "unknown"]).has(result.state)) {
      throw new TypeError("batch child result state is invalid");
    }
    const resultDigest = exactDigest(result.resultDigest, "result digest");
    const gatewayOperationId = result.gatewayOperationId
      ? exactName(result.gatewayOperationId, "gateway operation id")
      : null;
    const gatewayOperationState = result.gatewayOperationState
      ? exactString(result.gatewayOperationState, "gateway operation state", 120)
      : null;
    const sourceResultState = result.sourceResultState
      ? exactString(result.sourceResultState, "source result state", 120)
      : null;
    const sourceTaskId = result.sourceTaskId
      ? exactString(result.sourceTaskId, "source task id", 160)
      : null;
    const errorDigest = result.errorDigest
      ? exactDigest(result.errorDigest, "error digest")
      : null;
    const now = this.instant();
    return this.transaction(() => {
      const row = this.selectChild.get(batchId, childIdResolved) as ChildRow | undefined;
      if (!row) throw new Error("batch child does not exist");
      if (row.state !== "running") throw new Error(`cannot settle child from ${row.state}`);
      this.database.prepare(`
        UPDATE gateway_batch_children
        SET state=?, gateway_operation_id=?, gateway_operation_state=?, source_result_state=?,
            source_task_id=?, result_digest=?, error_digest=?, updated_at=?, terminal_at=?, revision=revision+1
        WHERE batch_id=? AND child_id=? AND state='running'
      `).run(
        result.state,
        gatewayOperationId,
        gatewayOperationState,
        sourceResultState,
        sourceTaskId,
        resultDigest,
        errorDigest,
        now,
        now,
        batchId,
        childIdResolved,
      );
      this.refreshCounts(batchId);
      return childRecord(this.selectChild.get(batchId, childIdResolved) as ChildRow);
    });
  }

  finishWindow(batchIdValue: string): BatchRecord {
    return this.transaction(() => this.refreshCounts(exactName(batchIdValue, "batch id")));
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function runBatchWindow(
  store: DurableBatchStore,
  batchId: string,
  executor: BatchExecutor,
  options: RunBatchWindowOptions,
): Promise<BatchWindowResult> {
  const started = store.beginRun(batchId, options.expectedCatalogDigest);
  if (TERMINAL_BATCH_STATES.has(started.state)) {
    return { schema: "morrow.batch-window.v1", batch: started, processed: 0, remaining: 0, children: [] };
  }
  const maxChildren = Math.max(1, Math.min(options.maxChildren ?? 50, 500));
  const claimed = store.claimPending(batchId, maxChildren);
  const settled = await mapLimit(claimed, started.concurrency, async (child) => {
    try {
      const argumentsValue = store.readArguments(child.batchId, child.childId);
      const result = await executor({ batch: started, child, arguments: argumentsValue });
      return store.settleChild(child.batchId, child.childId, result);
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      return store.settleChild(child.batchId, child.childId, {
        state: "unknown",
        resultDigest: sha256Text(detail),
        errorDigest: sha256Text(detail),
        sourceResultState: "batch_executor_threw",
      });
    }
  });
  const batch = store.finishWindow(batchId);
  return {
    schema: "morrow.batch-window.v1",
    batch,
    processed: settled.length,
    remaining: batch.pendingChildren,
    children: settled,
  };
}

export function batchDetailProjection(detail: BatchDetail): JsonObject {
  return {
    batch: detail.batch,
    children: detail.children,
  };
}
