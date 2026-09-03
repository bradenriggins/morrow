import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";

export const GATEWAY_OPERATION_STATES = Object.freeze([
  "prepared",
  "dispatched",
  "response_received",
  "failed_before_send",
  "source_unknown",
] as const);

export type GatewayOperationState = typeof GATEWAY_OPERATION_STATES[number];

export interface PrepareGatewayOperationInput {
  readonly publicToolName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly catalogDigest: string;
  readonly requestDigest: string;
  readonly forwardedRequestDigest: string;
  readonly sourceOperationId?: string;
  readonly idempotencyKey?: string;
  readonly readOnly: boolean;
}

export interface CompleteGatewayOperationInput {
  readonly upstreamResultDigest: string;
  readonly normalizedResultDigest: string;
  readonly sourceResultState?: string;
  readonly sourceTaskId?: string;
}

export interface GatewayOperationRecord {
  readonly schema: "morrow.gateway-operation.v1";
  readonly operationId: string;
  readonly publicToolName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly catalogDigest: string;
  readonly requestDigest: string;
  readonly forwardedRequestDigest: string;
  readonly sourceOperationId: string | null;
  readonly idempotencyKey: string | null;
  readonly readOnly: boolean;
  readonly state: GatewayOperationState;
  readonly upstreamResultDigest: string | null;
  readonly normalizedResultDigest: string | null;
  readonly sourceResultState: string | null;
  readonly sourceTaskId: string | null;
  readonly errorDigest: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dispatchedAt: string | null;
  readonly terminalAt: string | null;
  readonly revision: number;
}

export interface PreparedGatewayOperation {
  readonly record: GatewayOperationRecord;
  readonly created: boolean;
}

export interface GatewayOperationJournalHealth {
  readonly schema: "morrow.gateway-operation-journal.health.v1";
  readonly path: string;
  readonly open: boolean;
  readonly totalOperations: number;
  readonly unresolvedOperations: number;
  readonly unknownOperations: number;
}

export interface ListGatewayOperationsInput {
  readonly sourceId?: string;
  readonly publicToolName?: string;
  readonly state?: GatewayOperationState;
  readonly limit?: number;
}

export interface GatewayOperationJournalOptions {
  readonly path: string;
  readonly now?: () => Date;
}

export class GatewayOperationConflictError extends Error {
  readonly code = "gateway_operation_conflict";
  constructor(message: string) {
    super(message);
    this.name = "GatewayOperationConflictError";
  }
}

export class GatewayOperationTransitionError extends Error {
  readonly code = "gateway_operation_transition_invalid";
  constructor(message: string) {
    super(message);
    this.name = "GatewayOperationTransitionError";
  }
}

interface SqlRow {
  operation_id: string;
  public_tool_name: string;
  source_id: string;
  source_tool_name: string;
  catalog_digest: string;
  request_digest: string;
  forwarded_request_digest: string;
  source_operation_id: string | null;
  idempotency_key: string | null;
  read_only: number;
  state: GatewayOperationState;
  upstream_result_digest: string | null;
  normalized_result_digest: string | null;
  source_result_state: string | null;
  source_task_id: string | null;
  error_digest: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  terminal_at: string | null;
  revision: number;
}

const EXACT_NAME = /^[A-Za-z0-9_.-]{1,160}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9_.:-]{8,160}$/;
const TERMINAL_STATES = new Set<GatewayOperationState>([
  "response_received",
  "failed_before_send",
  "source_unknown",
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
  if (!EXACT_NAME.test(normalized)) throw new TypeError(`${label} has an invalid format`);
  return normalized;
}

function exactDigest(value: unknown, label: string): string {
  const normalized = exactString(value, label, 64);
  if (!SHA256.test(normalized)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return normalized;
}

function optionalOperationIdentity(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = exactString(value, label, 160);
  if (!OPERATION_ID.test(normalized)) throw new TypeError(`${label} has an invalid format`);
  return normalized;
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return exactString(value, label, maximum);
}

function rowRecord(row: SqlRow): GatewayOperationRecord {
  return {
    schema: "morrow.gateway-operation.v1",
    operationId: row.operation_id,
    publicToolName: row.public_tool_name,
    sourceId: row.source_id,
    sourceToolName: row.source_tool_name,
    catalogDigest: row.catalog_digest,
    requestDigest: row.request_digest,
    forwardedRequestDigest: row.forwarded_request_digest,
    sourceOperationId: row.source_operation_id,
    idempotencyKey: row.idempotency_key,
    readOnly: row.read_only === 1,
    state: row.state,
    upstreamResultDigest: row.upstream_result_digest,
    normalizedResultDigest: row.normalized_result_digest,
    sourceResultState: row.source_result_state,
    sourceTaskId: row.source_task_id,
    errorDigest: row.error_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
    terminalAt: row.terminal_at,
    revision: row.revision,
  };
}

function sourceStateFromValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized || undefined;
}

export function classifySourceResult(value: unknown): {
  readonly state?: string;
  readonly taskId?: string;
} {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown, depth: number): { state?: string; taskId?: string } => {
    if (depth > 6 || candidate === null || typeof candidate !== "object" || seen.has(candidate)) return {};
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const found = visit(entry, depth + 1);
        if (found.state || found.taskId) return found;
      }
      return {};
    }
    const object = candidate as Record<string, unknown>;
    const state = sourceStateFromValue(
      object.resultState
      ?? object.result_state
      ?? object.effectState
      ?? object.effect_state
      ?? object.executionState
      ?? object.execution_state
      ?? object.status,
    );
    const rawTaskId = object.taskId ?? object.task_id;
    const taskId = (typeof rawTaskId === "string" || typeof rawTaskId === "number")
      ? String(rawTaskId).trim().slice(0, 160) || undefined
      : undefined;
    if (state || taskId) return { ...(state ? { state } : {}), ...(taskId ? { taskId } : {}) };
    for (const key of ["structuredContent", "result", "task", "receipt", "operation"]) {
      const found = visit(object[key], depth + 1);
      if (found.state || found.taskId) return found;
    }
    return {};
  };
  return visit(value, 0);
}

export class GatewayOperationJournal {
  readonly path: string;
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private closed = false;
  private readonly selectById: StatementSync;

  constructor(options: GatewayOperationJournalOptions) {
    this.path = options.path === ":memory:" ? ":memory:" : resolve(options.path);
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
      CREATE TABLE IF NOT EXISTS gateway_operations (
        operation_id TEXT PRIMARY KEY,
        public_tool_name TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_tool_name TEXT NOT NULL,
        catalog_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        forwarded_request_digest TEXT NOT NULL,
        source_operation_id TEXT,
        idempotency_key TEXT,
        read_only INTEGER NOT NULL CHECK(read_only IN (0,1)),
        state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','response_received','failed_before_send','source_unknown')),
        upstream_result_digest TEXT,
        normalized_result_digest TEXT,
        source_result_state TEXT,
        source_task_id TEXT,
        error_digest TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dispatched_at TEXT,
        terminal_at TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS gateway_operations_idempotency
        ON gateway_operations(source_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS gateway_operations_recent
        ON gateway_operations(created_at DESC, operation_id DESC);
      CREATE INDEX IF NOT EXISTS gateway_operations_state
        ON gateway_operations(state, updated_at DESC);
      CREATE TABLE IF NOT EXISTS gateway_operation_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL REFERENCES gateway_operations(operation_id) ON DELETE CASCADE,
        from_state TEXT,
        to_state TEXT NOT NULL,
        detail_digest TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS gateway_operation_events_operation
        ON gateway_operation_events(operation_id, event_id);
    `);
    this.selectById = this.database.prepare(
      "SELECT * FROM gateway_operations WHERE operation_id = ?",
    );
    this.recoverInterruptedOperations();
  }

  private instant(): string {
    return this.now().toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("gateway operation journal is closed");
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

  private insertEvent(
    operationId: string,
    fromState: GatewayOperationState | null,
    toState: GatewayOperationState,
    detail?: unknown,
  ): void {
    this.database.prepare(`
      INSERT INTO gateway_operation_events(operation_id, from_state, to_state, detail_digest, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      operationId,
      fromState,
      toState,
      detail === undefined ? null : sha256Json(detail),
      this.instant(),
    );
  }

  private recoverInterruptedOperations(): void {
    const now = this.instant();
    this.transaction(() => {
      const prepared = this.database.prepare(
        "SELECT operation_id FROM gateway_operations WHERE state = 'prepared'",
      ).all() as { operation_id: string }[];
      for (const row of prepared) {
        this.database.prepare(`
          UPDATE gateway_operations
          SET state='failed_before_send', source_result_state='process_restart_before_dispatch',
              error_digest=?, updated_at=?, terminal_at=?, revision=revision+1
          WHERE operation_id=? AND state='prepared'
        `).run(sha256Text("process_restart_before_dispatch"), now, now, row.operation_id);
        this.insertEvent(row.operation_id, "prepared", "failed_before_send", {
          reason: "process_restart_before_dispatch",
        });
      }
      const dispatched = this.database.prepare(
        "SELECT operation_id FROM gateway_operations WHERE state = 'dispatched'",
      ).all() as { operation_id: string }[];
      for (const row of dispatched) {
        this.database.prepare(`
          UPDATE gateway_operations
          SET state='source_unknown', source_result_state='process_restart_after_dispatch',
              error_digest=?, updated_at=?, terminal_at=?, revision=revision+1
          WHERE operation_id=? AND state='dispatched'
        `).run(sha256Text("process_restart_after_dispatch"), now, now, row.operation_id);
        this.insertEvent(row.operation_id, "dispatched", "source_unknown", {
          reason: "process_restart_after_dispatch",
        });
      }
    });
  }

  prepare(input: PrepareGatewayOperationInput): PreparedGatewayOperation {
    const publicToolName = exactName(input.publicToolName, "public tool name");
    const sourceId = exactName(input.sourceId, "source id");
    const sourceToolName = exactName(input.sourceToolName, "source tool name");
    const catalogDigest = exactDigest(input.catalogDigest, "catalog digest");
    const requestDigest = exactDigest(input.requestDigest, "request digest");
    const forwardedRequestDigest = exactDigest(input.forwardedRequestDigest, "forwarded request digest");
    const sourceOperationId = optionalOperationIdentity(input.sourceOperationId, "source operation id");
    const idempotencyKey = optionalOperationIdentity(input.idempotencyKey, "idempotency key");
    const now = this.instant();

    return this.transaction(() => {
      if (idempotencyKey) {
        const existing = this.database.prepare(`
          SELECT * FROM gateway_operations WHERE source_id=? AND idempotency_key=?
        `).get(sourceId, idempotencyKey) as SqlRow | undefined;
        if (existing) {
          if (
            existing.public_tool_name !== publicToolName
            || existing.source_tool_name !== sourceToolName
            || existing.catalog_digest !== catalogDigest
            || existing.request_digest !== requestDigest
            || existing.forwarded_request_digest !== forwardedRequestDigest
          ) {
            throw new GatewayOperationConflictError(
              "The idempotency key is already bound to a different exact gateway request.",
            );
          }
          return { record: rowRecord(existing), created: false };
        }
      }

      const operationId = `gop:${randomUUID()}`;
      this.database.prepare(`
        INSERT INTO gateway_operations(
          operation_id, public_tool_name, source_id, source_tool_name, catalog_digest,
          request_digest, forwarded_request_digest, source_operation_id, idempotency_key,
          read_only, state, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, 1)
      `).run(
        operationId,
        publicToolName,
        sourceId,
        sourceToolName,
        catalogDigest,
        requestDigest,
        forwardedRequestDigest,
        sourceOperationId,
        idempotencyKey,
        input.readOnly ? 1 : 0,
        now,
        now,
      );
      this.insertEvent(operationId, null, "prepared");
      return { record: this.get(operationId), created: true };
    });
  }

  markDispatched(operationIdValue: string): GatewayOperationRecord {
    const operationId = optionalOperationIdentity(operationIdValue, "operation id");
    if (!operationId) throw new TypeError("operation id is required");
    const now = this.instant();
    return this.transaction(() => {
      const record = this.get(operationId);
      if (record.state !== "prepared") {
        throw new GatewayOperationTransitionError(
          `Cannot dispatch a gateway operation from ${record.state}.`,
        );
      }
      const changed = this.database.prepare(`
        UPDATE gateway_operations
        SET state='dispatched', dispatched_at=?, updated_at=?, revision=revision+1
        WHERE operation_id=? AND state='prepared'
      `).run(now, now, operationId);
      if (Number(changed.changes) !== 1) {
        throw new GatewayOperationTransitionError("Gateway dispatch lost its prepared record.");
      }
      this.insertEvent(operationId, "prepared", "dispatched");
      return this.get(operationId);
    });
  }

  recordResponse(operationIdValue: string, input: CompleteGatewayOperationInput): GatewayOperationRecord {
    const operationId = optionalOperationIdentity(operationIdValue, "operation id");
    if (!operationId) throw new TypeError("operation id is required");
    const upstreamResultDigest = exactDigest(input.upstreamResultDigest, "upstream result digest");
    const normalizedResultDigest = exactDigest(input.normalizedResultDigest, "normalized result digest");
    const sourceResultState = optionalBoundedString(input.sourceResultState, "source result state", 120);
    const sourceTaskId = optionalBoundedString(input.sourceTaskId, "source task id", 160);
    const now = this.instant();
    const terminalState: GatewayOperationState = [
      "unknown",
      "indeterminate",
      "applied_or_unknown",
      "write_may_have_landed",
      "bridge_outcome_unknown",
    ].includes(String(sourceResultState || "").toLowerCase())
      ? "source_unknown"
      : "response_received";
    return this.transaction(() => {
      const record = this.get(operationId);
      if (record.state !== "dispatched") {
        throw new GatewayOperationTransitionError(
          `Cannot record a gateway response from ${record.state}.`,
        );
      }
      const changed = this.database.prepare(`
        UPDATE gateway_operations
        SET state=?, upstream_result_digest=?, normalized_result_digest=?,
            source_result_state=?, source_task_id=?, updated_at=?, terminal_at=?, revision=revision+1
        WHERE operation_id=? AND state='dispatched'
      `).run(
        terminalState,
        upstreamResultDigest,
        normalizedResultDigest,
        sourceResultState,
        sourceTaskId,
        now,
        now,
        operationId,
      );
      if (Number(changed.changes) !== 1) {
        throw new GatewayOperationTransitionError("Gateway response lost its dispatched record.");
      }
      this.insertEvent(operationId, "dispatched", terminalState, {
        upstreamResultDigest,
        normalizedResultDigest,
        sourceResultState,
        sourceTaskId,
      });
      return this.get(operationId);
    });
  }

  recordFailedBeforeSend(operationIdValue: string, error: unknown): GatewayOperationRecord {
    const operationId = optionalOperationIdentity(operationIdValue, "operation id");
    if (!operationId) throw new TypeError("operation id is required");
    const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    const now = this.instant();
    return this.transaction(() => {
      const record = this.get(operationId);
      if (record.state !== "prepared") {
        throw new GatewayOperationTransitionError(
          `Cannot record a pre-send failure from ${record.state}.`,
        );
      }
      this.database.prepare(`
        UPDATE gateway_operations
        SET state='failed_before_send', error_digest=?, source_result_state='failed_before_send',
            updated_at=?, terminal_at=?, revision=revision+1
        WHERE operation_id=? AND state='prepared'
      `).run(sha256Text(detail), now, now, operationId);
      this.insertEvent(operationId, "prepared", "failed_before_send", { error: detail });
      return this.get(operationId);
    });
  }

  recordSourceUnknown(operationIdValue: string, error: unknown): GatewayOperationRecord {
    const operationId = optionalOperationIdentity(operationIdValue, "operation id");
    if (!operationId) throw new TypeError("operation id is required");
    const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    const now = this.instant();
    return this.transaction(() => {
      const record = this.get(operationId);
      if (record.state !== "dispatched") {
        throw new GatewayOperationTransitionError(
          `Cannot record an unknown source outcome from ${record.state}.`,
        );
      }
      this.database.prepare(`
        UPDATE gateway_operations
        SET state='source_unknown', error_digest=?, source_result_state='gateway_call_failed_after_dispatch',
            updated_at=?, terminal_at=?, revision=revision+1
        WHERE operation_id=? AND state='dispatched'
      `).run(sha256Text(detail), now, now, operationId);
      this.insertEvent(operationId, "dispatched", "source_unknown", { error: detail });
      return this.get(operationId);
    });
  }

  get(operationIdValue: string): GatewayOperationRecord {
    this.assertOpen();
    const operationId = optionalOperationIdentity(operationIdValue, "operation id");
    if (!operationId) throw new TypeError("operation id is required");
    const row = this.selectById.get(operationId) as SqlRow | undefined;
    if (!row) throw new Error("gateway operation does not exist");
    return rowRecord(row);
  }

  list(input: ListGatewayOperationsInput = {}): readonly GatewayOperationRecord[] {
    this.assertOpen();
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (input.sourceId) {
      conditions.push("source_id = ?");
      values.push(exactName(input.sourceId, "source id"));
    }
    if (input.publicToolName) {
      conditions.push("public_tool_name = ?");
      values.push(exactName(input.publicToolName, "public tool name"));
    }
    if (input.state) {
      if (!GATEWAY_OPERATION_STATES.includes(input.state)) throw new TypeError("state is invalid");
      conditions.push("state = ?");
      values.push(input.state);
    }
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    values.push(limit);
    const sql = `SELECT * FROM gateway_operations${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY created_at DESC, operation_id DESC LIMIT ?`;
    return (this.database.prepare(sql).all(...values) as unknown as SqlRow[]).map(rowRecord);
  }

  health(): GatewayOperationJournalHealth {
    this.assertOpen();
    const total = this.database.prepare("SELECT COUNT(*) AS count FROM gateway_operations").get() as { count: number };
    const unresolved = this.database.prepare(`
      SELECT COUNT(*) AS count FROM gateway_operations WHERE state IN ('prepared','dispatched')
    `).get() as { count: number };
    const unknown = this.database.prepare(`
      SELECT COUNT(*) AS count FROM gateway_operations WHERE state='source_unknown'
    `).get() as { count: number };
    return {
      schema: "morrow.gateway-operation-journal.health.v1",
      path: this.path,
      open: true,
      totalOperations: Number(total.count),
      unresolvedOperations: Number(unresolved.count),
      unknownOperations: Number(unknown.count),
    };
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

export function operationRecordProjection(record: GatewayOperationRecord): JsonObject {
  return {
    schema: record.schema,
    operationId: record.operationId,
    publicToolName: record.publicToolName,
    sourceId: record.sourceId,
    sourceToolName: record.sourceToolName,
    catalogDigest: record.catalogDigest,
    requestDigest: record.requestDigest,
    forwardedRequestDigest: record.forwardedRequestDigest,
    sourceOperationId: record.sourceOperationId,
    idempotencyKey: record.idempotencyKey,
    readOnly: record.readOnly,
    state: record.state,
    upstreamResultDigest: record.upstreamResultDigest,
    normalizedResultDigest: record.normalizedResultDigest,
    sourceResultState: record.sourceResultState,
    sourceTaskId: record.sourceTaskId,
    errorDigest: record.errorDigest,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    dispatchedAt: record.dispatchedAt,
    terminalAt: record.terminalAt,
    revision: record.revision,
    terminal: TERMINAL_STATES.has(record.state),
  };
}
