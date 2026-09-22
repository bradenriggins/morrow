import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { openExactPrivateSqliteDatabase } from "@morrow/gateway-core";
import {
  ensureCausalSequenceTable,
  exactCausalSequence,
  nextDurableCausalSequence,
  type CausalSequenceAllocator,
} from "./causal-sequence.js";

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
  readonly sourceBindingId?: string;
  readonly targetIdentityDigest?: string;
  readonly actorDigest?: string;
}

export interface CompleteGatewayOperationInput {
  readonly upstreamResultDigest: string;
  readonly normalizedResultDigest: string;
  readonly sourceResultState?: string;
  readonly sourceTaskId?: string;
  readonly responseSucceeded?: boolean;
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
  readonly sourceBindingId: string | null;
  readonly targetIdentityDigest: string | null;
  readonly actorDigest: string | null;
  readonly state: GatewayOperationState;
  readonly responseSucceeded: boolean | null;
  readonly publicResultDelivered: boolean;
  readonly preparedCausalSequence: number | null;
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

export interface FindSuccessfulReadEvidenceInput {
  readonly sourceId: string;
  readonly sourceBindingId: string;
  readonly targetIdentityDigest: string;
  readonly actorDigest: string;
  readonly upstreamResultDigest: string;
  readonly afterCausalSequence: number;
  /**
   * A course connection made again by the same person on the same site carries a
   * new generation in its identity. The evidence has to come from that person,
   * that site and that course, which this pattern states; the generation itself
   * is not what makes the reading theirs. `actorDigest` still holds the reading
   * to the same signed-in person.
   */
  readonly sourceBindingPattern?: string;
  /**
   * The actor digest is frozen with the connection it was made through, so a
   * course connected again never matches it. When the evidence is matched by
   * `sourceBindingPattern` instead, that pattern already carries the person's
   * own fingerprint and the course, which is what makes the reading theirs.
   */
  readonly matchActorDigest?: boolean;
}

export interface GatewayOperationJournalOptions {
  readonly path: string;
  readonly now?: () => Date;
  readonly nextCausalSequence?: CausalSequenceAllocator;
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
  source_binding_id: string | null;
  target_identity_digest: string | null;
  actor_digest: string | null;
  state: GatewayOperationState;
  response_succeeded: number | null;
  public_result_delivered: number;
  prepared_causal_sequence: number | null;
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

function optionalBindingIdentity(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = exactString(value, label, 160);
  if (!/^[A-Za-z0-9_.:@-]+$/u.test(normalized)) throw new TypeError(`${label} has an invalid format`);
  return normalized;
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return exactString(value, label, maximum);
}

function rowRecord(row: SqlRow): GatewayOperationRecord {
  const sourceBindingId = optionalBindingIdentity(row.source_binding_id, "source binding id");
  const targetIdentityDigest = row.target_identity_digest === null
    ? null : exactDigest(row.target_identity_digest, "target identity digest");
  const actorDigest = row.actor_digest === null ? null : exactDigest(row.actor_digest, "actor digest");
  const authorityEvidenceCount = [sourceBindingId, targetIdentityDigest, actorDigest]
    .filter((value) => value !== null).length;
  if (authorityEvidenceCount !== 0 && authorityEvidenceCount !== 3) {
    throw new Error("gateway read authority evidence is incomplete");
  }
  if (row.response_succeeded !== null && row.response_succeeded !== 0 && row.response_succeeded !== 1) {
    throw new Error("gateway response success evidence is invalid");
  }
  if (row.public_result_delivered !== 0 && row.public_result_delivered !== 1) {
    throw new Error("gateway public delivery evidence is invalid");
  }
  const preparedCausalSequence = row.prepared_causal_sequence === null
    ? null
    : exactCausalSequence(row.prepared_causal_sequence, "gateway prepare causal sequence");
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
    sourceBindingId,
    targetIdentityDigest,
    actorDigest,
    state: row.state,
    responseSucceeded: row.response_succeeded === null ? null : row.response_succeeded === 1,
    publicResultDelivered: row.public_result_delivered === 1,
    preparedCausalSequence,
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
  private readonly allocateCausalSequence: CausalSequenceAllocator | null;
  private closed = false;
  private readonly selectById: StatementSync;

  constructor(options: GatewayOperationJournalOptions) {
    const opened = openExactPrivateSqliteDatabase(options.path, "Morrow operation journal", {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.path = opened.path;
    this.now = options.now ?? (() => new Date());
    this.allocateCausalSequence = options.nextCausalSequence ?? null;
    this.database = opened.database;
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
        source_binding_id TEXT,
        target_identity_digest TEXT,
        actor_digest TEXT,
        state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','response_received','failed_before_send','source_unknown')),
        response_succeeded INTEGER CHECK(response_succeeded IN (0,1)),
        public_result_delivered INTEGER NOT NULL DEFAULT 0 CHECK(public_result_delivered IN (0,1)),
        prepared_causal_sequence INTEGER CHECK(prepared_causal_sequence >= 1),
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
    ensureCausalSequenceTable(this.database);
    this.migrateReadAuthorityEvidence();
    this.database.exec(`
      DROP INDEX IF EXISTS gateway_operations_read_evidence;
      CREATE INDEX IF NOT EXISTS gateway_operations_read_evidence
        ON gateway_operations(
          source_id, source_binding_id, target_identity_digest, actor_digest,
          upstream_result_digest, public_result_delivered, prepared_causal_sequence DESC
        )
        WHERE read_only=1 AND state='response_received' AND response_succeeded=1 AND public_result_delivered=1;
    `);
    this.selectById = this.database.prepare(
      "SELECT * FROM gateway_operations WHERE operation_id = ?",
    );
    this.recoverInterruptedOperations();
  }

  private migrateReadAuthorityEvidence(): void {
    const columns = new Set((this.database.prepare("PRAGMA table_info(gateway_operations)").all() as { name: string }[])
      .map((column) => column.name));
    if (!columns.has("source_binding_id")) {
      this.database.exec("ALTER TABLE gateway_operations ADD COLUMN source_binding_id TEXT");
    }
    if (!columns.has("target_identity_digest")) {
      this.database.exec("ALTER TABLE gateway_operations ADD COLUMN target_identity_digest TEXT");
    }
    if (!columns.has("actor_digest")) {
      this.database.exec("ALTER TABLE gateway_operations ADD COLUMN actor_digest TEXT");
    }
    if (!columns.has("response_succeeded")) {
      this.database.exec("ALTER TABLE gateway_operations ADD COLUMN response_succeeded INTEGER CHECK(response_succeeded IN (0,1))");
    }
    if (!columns.has("public_result_delivered")) {
      this.database.exec("ALTER TABLE gateway_operations ADD COLUMN public_result_delivered INTEGER NOT NULL DEFAULT 0 CHECK(public_result_delivered IN (0,1))");
    }
    if (!columns.has("prepared_causal_sequence")) {
      // An operation from an older runtime has no durable causal relation to a
      // current effect. It stays in history but cannot close an effect.
      this.database.exec("ALTER TABLE gateway_operations ADD COLUMN prepared_causal_sequence INTEGER CHECK(prepared_causal_sequence >= 1)");
    }
  }

  private nextCausalSequence(): number {
    return this.allocateCausalSequence
      ? exactCausalSequence(this.allocateCausalSequence(), "Morrow causal sequence")
      : nextDurableCausalSequence(this.database);
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
    const sourceBindingId = optionalBindingIdentity(input.sourceBindingId, "source binding id");
    const targetIdentityDigest = input.targetIdentityDigest === undefined
      ? null : exactDigest(input.targetIdentityDigest, "target identity digest");
    const actorDigest = input.actorDigest === undefined ? null : exactDigest(input.actorDigest, "actor digest");
    const authorityEvidenceCount = [sourceBindingId, targetIdentityDigest, actorDigest]
      .filter((value) => value !== null).length;
    if (authorityEvidenceCount !== 0 && authorityEvidenceCount !== 3) {
      throw new TypeError("gateway read authority evidence must be complete");
    }
    if (authorityEvidenceCount === 3 && input.readOnly !== true) {
      throw new TypeError("gateway read authority evidence belongs only to a read-only operation");
    }
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
            || existing.source_binding_id !== sourceBindingId
            || existing.target_identity_digest !== targetIdentityDigest
            || existing.actor_digest !== actorDigest
          ) {
            throw new GatewayOperationConflictError(
              "The idempotency key is already bound to a different exact gateway request.",
            );
          }
          return { record: rowRecord(existing), created: false };
        }
      }

      const operationId = `gop:${randomUUID()}`;
      const preparedCausalSequence = this.nextCausalSequence();
      this.database.prepare(`
        INSERT INTO gateway_operations(
          operation_id, public_tool_name, source_id, source_tool_name, catalog_digest,
          request_digest, forwarded_request_digest, source_operation_id, idempotency_key,
          read_only, source_binding_id, target_identity_digest, actor_digest,
          state, prepared_causal_sequence, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, 1)
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
        sourceBindingId,
        targetIdentityDigest,
        actorDigest,
        preparedCausalSequence,
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
    if (input.responseSucceeded !== undefined && typeof input.responseSucceeded !== "boolean") {
      throw new TypeError("response succeeded must be a boolean");
    }
    const responseSucceeded = input.responseSucceeded === undefined ? null : input.responseSucceeded ? 1 : 0;
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
        SET state=?, response_succeeded=?, upstream_result_digest=?, normalized_result_digest=?,
            source_result_state=?, source_task_id=?, updated_at=?, terminal_at=?, revision=revision+1
        WHERE operation_id=? AND state='dispatched'
      `).run(
        terminalState,
        responseSucceeded,
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

  recordPublicReadDelivered(operationIdValue: string): GatewayOperationRecord {
    const operationId = optionalOperationIdentity(operationIdValue, "operation id");
    if (!operationId) throw new TypeError("operation id is required");
    const now = this.instant();
    return this.transaction(() => {
      const record = this.get(operationId);
      if (!record.readOnly || record.state !== "response_received" || record.responseSucceeded !== true
        || !record.sourceBindingId || !record.targetIdentityDigest || !record.actorDigest) {
        throw new GatewayOperationTransitionError("Only a successful authority-bound read can be marked delivered.");
      }
      if (record.publicResultDelivered) return record;
      const changed = this.database.prepare(`
        UPDATE gateway_operations
        SET public_result_delivered=1, updated_at=?, revision=revision+1
        WHERE operation_id=? AND read_only=1 AND state='response_received'
          AND response_succeeded=1 AND public_result_delivered=0
      `).run(now, operationId);
      if (Number(changed.changes) !== 1) {
        throw new GatewayOperationTransitionError("Gateway read delivery lost its response record.");
      }
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

  findSuccessfulReadEvidence(input: FindSuccessfulReadEvidenceInput): GatewayOperationRecord | null {
    this.assertOpen();
    const sourceBindingId = optionalBindingIdentity(input.sourceBindingId, "source binding id");
    if (!sourceBindingId) throw new TypeError("source binding id is required");
    const afterCausalSequence = exactCausalSequence(input.afterCausalSequence, "read evidence causal lower bound");
    // Exactly one wildcard, standing for the connection generation, inside an
    // otherwise valid binding identity.
    const pattern = input.sourceBindingPattern
      && optionalBindingIdentity(input.sourceBindingPattern.replace(/%/gu, "0"), "source binding pattern")
      && input.sourceBindingPattern.split("%").length === 2
      ? input.sourceBindingPattern
      : null;
    const matchActor = input.matchActorDigest !== false;
    const actorDigest = exactDigest(input.actorDigest, "actor digest");
    const row = this.database.prepare(`
      SELECT * FROM gateway_operations
      WHERE source_id=? AND (source_binding_id=?${pattern ? " OR source_binding_id LIKE ?" : ""})
        AND target_identity_digest=?${matchActor ? " AND actor_digest=?" : ""}
        AND upstream_result_digest=? AND prepared_causal_sequence>?
        AND read_only=1 AND state='response_received' AND response_succeeded=1
        AND public_result_delivered=1
      ORDER BY prepared_causal_sequence DESC, operation_id DESC
      LIMIT 1
    `).get(
      exactName(input.sourceId, "source id"),
      sourceBindingId,
      ...(pattern ? [pattern] : []),
      exactDigest(input.targetIdentityDigest, "target identity digest"),
      ...(matchActor ? [actorDigest] : []),
      exactDigest(input.upstreamResultDigest, "upstream result digest"),
      afterCausalSequence,
    ) as SqlRow | undefined;
    return row ? rowRecord(row) : null;
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

export * from "./effect-broker.js";
