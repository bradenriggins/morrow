import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256Text } from "@morrow/contracts";
import type { BatchMode, BatchState } from "./index.js";

export const BATCH_RECOVERY_MODES = Object.freeze(["inspect", "apply_safe"] as const);
export type BatchRecoveryMode = typeof BATCH_RECOVERY_MODES[number];

export const BATCH_RECOVERY_ACTIONS = Object.freeze([
  "retry_read_only",
  "source_task_recovered",
  "failed_before_send",
  "inspection_required",
] as const);
export type BatchRecoveryAction = typeof BATCH_RECOVERY_ACTIONS[number];

export interface RecoverBatchStateInput {
  readonly path: string;
  readonly batchId: string;
  readonly mode: BatchRecoveryMode;
  readonly afterOrdinal?: number;
  readonly maxChildren?: number;
  readonly now?: () => Date;
}

export interface BatchRecoveryChild {
  readonly schema: "morrow.batch-recovery-child.v1";
  readonly childId: string;
  readonly ordinal: number;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly sourceOperationId: string | null;
  readonly action: BatchRecoveryAction;
  readonly applied: boolean;
  readonly gatewayOperationId: string | null;
  readonly gatewayOperationState: string | null;
  readonly sourceTaskId: string | null;
  readonly sourceResultState: string | null;
  readonly detailDigest: string;
}

export interface BatchRecoveryResult {
  readonly schema: "morrow.batch-recovery.v1";
  readonly batchId: string;
  readonly mode: BatchRecoveryMode;
  readonly batchMode: BatchMode;
  readonly stateBefore: BatchState;
  readonly stateAfter: BatchState;
  readonly afterOrdinal: number;
  readonly scanned: number;
  readonly applied: number;
  readonly retryReadOnly: number;
  readonly sourceTasksRecovered: number;
  readonly failedBeforeSend: number;
  readonly inspectionRequired: number;
  readonly unknownChildrenBefore: number;
  readonly unknownChildrenAfter: number;
  readonly pendingChildrenAfter: number;
  readonly nextAfterOrdinal: number | null;
  readonly children: readonly BatchRecoveryChild[];
  readonly providerDispatches: 0;
}

interface BatchRow {
  batch_id: string;
  mode: BatchMode;
  state: BatchState;
}

interface ChildRow {
  batch_id: string;
  child_id: string;
  ordinal: number;
  source_id: string;
  source_tool_name: string;
  source_operation_id: string | null;
  state: string;
}

interface OperationRow {
  operation_id: string;
  state: string;
  source_result_state: string | null;
  source_task_id: string | null;
  normalized_result_digest: string | null;
  upstream_result_digest: string | null;
  error_digest: string | null;
}

interface CountRow {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  unknown_count: number;
  cancelled: number;
}

const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,160}$/;
const RECOVERABLE_BATCH_STATES = new Set<BatchState>(["paused", "inspection_required"]);
const TERMINAL_BATCH_STATES = new Set<BatchState>([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "inspection_required",
]);

function exactIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new TypeError(`${label} has an invalid format`);
  return normalized;
}

function exactMode(value: unknown): BatchRecoveryMode {
  if (!BATCH_RECOVERY_MODES.includes(value as BatchRecoveryMode)) {
    throw new TypeError("batch recovery mode is invalid");
  }
  return value as BatchRecoveryMode;
}

function exactAfterOrdinal(value: unknown): number {
  if (value === undefined) return 0;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("afterOrdinal must be a non-negative whole number");
  }
  return number;
}

function exactLimit(value: unknown): number {
  if (value === undefined) return 100;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 500) {
    throw new TypeError("maxChildren must be a whole number from 1 through 500");
  }
  return number;
}

function databasePath(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized === ":memory:") {
    throw new Error("Batch recovery requires a durable file-backed Morrow state database.");
  }
  return resolve(normalized);
}

function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
  `);
  const requiredTables = new Set(["gateway_batches", "gateway_batch_children", "gateway_operations"]);
  const tables = database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('gateway_batches','gateway_batch_children','gateway_operations')
  `).all() as unknown as { name: string }[];
  for (const row of tables) requiredTables.delete(String(row.name));
  if (requiredTables.size > 0) {
    database.close();
    throw new Error(`Morrow state database is missing ${[...requiredTables].sort().join(", ")}.`);
  }
  return database;
}

function countRow(database: DatabaseSync, batchId: string): CountRow {
  const row = database.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state='running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END) AS unknown_count,
      SUM(CASE WHEN state='cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM gateway_batch_children WHERE batch_id=?
  `).get(batchId) as unknown as Partial<CountRow> | undefined;
  return {
    total: Number(row?.total || 0),
    pending: Number(row?.pending || 0),
    running: Number(row?.running || 0),
    succeeded: Number(row?.succeeded || 0),
    failed: Number(row?.failed || 0),
    unknown_count: Number(row?.unknown_count || 0),
    cancelled: Number(row?.cancelled || 0),
  };
}

function derivedBatchState(current: BatchState, counts: CountRow): BatchState {
  if (counts.running > 0 || counts.unknown_count > 0) return "inspection_required";
  if (counts.pending > 0) return "paused";
  if (counts.total === 0) return current;
  if (counts.succeeded === counts.total) return "completed";
  if (counts.cancelled === counts.total) return "cancelled";
  if (counts.failed === counts.total) return "failed";
  if (counts.succeeded > 0 || counts.cancelled > 0) return "partial";
  return current;
}

function updateBatchCounts(
  database: DatabaseSync,
  batchId: string,
  current: BatchState,
  now: string,
): { state: BatchState; counts: CountRow } {
  const counts = countRow(database, batchId);
  const state = derivedBatchState(current, counts);
  const terminalAt = TERMINAL_BATCH_STATES.has(state) && state !== "inspection_required"
    ? now
    : null;
  database.prepare(`
    UPDATE gateway_batches
    SET state=?, total_children=?, pending_children=?, running_children=?, succeeded_children=?,
        failed_children=?, unknown_children=?, cancelled_children=?, updated_at=?, terminal_at=?,
        revision=revision+1
    WHERE batch_id=?
  `).run(
    state,
    counts.total,
    counts.pending,
    counts.running,
    counts.succeeded,
    counts.failed,
    counts.unknown_count,
    counts.cancelled,
    now,
    terminalAt,
    batchId,
  );
  return { state, counts };
}

function operationForChild(
  database: DatabaseSync,
  child: ChildRow,
): OperationRow | null {
  if (!child.source_operation_id) return null;
  const row = database.prepare(`
    SELECT operation_id, state, source_result_state, source_task_id,
           normalized_result_digest, upstream_result_digest, error_digest
    FROM gateway_operations
    WHERE source_id=? AND source_operation_id=?
    ORDER BY created_at DESC, operation_id DESC LIMIT 1
  `).get(child.source_id, child.source_operation_id) as unknown as OperationRow | undefined;
  return row || null;
}

function childDecision(
  batchMode: BatchMode,
  child: ChildRow,
  operation: OperationRow | null,
): Omit<BatchRecoveryChild, "schema" | "applied"> {
  if (batchMode === "read_only") {
    return {
      childId: child.child_id,
      ordinal: child.ordinal,
      sourceId: child.source_id,
      sourceToolName: child.source_tool_name,
      sourceOperationId: child.source_operation_id,
      action: "retry_read_only",
      gatewayOperationId: operation?.operation_id || null,
      gatewayOperationState: operation?.state || null,
      sourceTaskId: operation?.source_task_id || null,
      sourceResultState: operation?.source_result_state || null,
      detailDigest: sha256Text("read_only_unknown_is_safe_to_retry"),
    };
  }

  if (operation?.state === "response_received" && operation.source_task_id) {
    return {
      childId: child.child_id,
      ordinal: child.ordinal,
      sourceId: child.source_id,
      sourceToolName: child.source_tool_name,
      sourceOperationId: child.source_operation_id,
      action: "source_task_recovered",
      gatewayOperationId: operation.operation_id,
      gatewayOperationState: operation.state,
      sourceTaskId: operation.source_task_id,
      sourceResultState: operation.source_result_state,
      detailDigest: sha256Text("source_task_recovered_from_gateway_operation"),
    };
  }

  if (operation?.state === "failed_before_send") {
    return {
      childId: child.child_id,
      ordinal: child.ordinal,
      sourceId: child.source_id,
      sourceToolName: child.source_tool_name,
      sourceOperationId: child.source_operation_id,
      action: "failed_before_send",
      gatewayOperationId: operation.operation_id,
      gatewayOperationState: operation.state,
      sourceTaskId: null,
      sourceResultState: operation.source_result_state,
      detailDigest: operation.error_digest || sha256Text("gateway_failed_before_send"),
    };
  }

  return {
    childId: child.child_id,
    ordinal: child.ordinal,
    sourceId: child.source_id,
    sourceToolName: child.source_tool_name,
    sourceOperationId: child.source_operation_id,
    action: "inspection_required",
    gatewayOperationId: operation?.operation_id || null,
    gatewayOperationState: operation?.state || null,
    sourceTaskId: operation?.source_task_id || null,
    sourceResultState: operation?.source_result_state || null,
    detailDigest: operation?.error_digest || sha256Text(
      operation ? `gateway_${operation.state}` : "gateway_operation_missing",
    ),
  };
}

function applyDecision(
  database: DatabaseSync,
  batchId: string,
  decision: Omit<BatchRecoveryChild, "schema" | "applied">,
  now: string,
): boolean {
  if (decision.action === "inspection_required") {
    if (!decision.gatewayOperationId) return false;
    const result = database.prepare(`
      UPDATE gateway_batch_children
      SET gateway_operation_id=?, gateway_operation_state=?, source_result_state=?,
          source_task_id=COALESCE(source_task_id, ?), error_digest=?, updated_at=?,
          revision=revision+1
      WHERE batch_id=? AND child_id=? AND state='unknown'
    `).run(
      decision.gatewayOperationId,
      decision.gatewayOperationState,
      decision.sourceResultState,
      decision.sourceTaskId,
      decision.detailDigest,
      now,
      batchId,
      decision.childId,
    );
    return Number(result.changes) === 1;
  }

  if (decision.action === "retry_read_only") {
    const result = database.prepare(`
      UPDATE gateway_batch_children
      SET state='pending', gateway_operation_id=NULL, gateway_operation_state=NULL,
          source_result_state=NULL, source_task_id=NULL, result_digest=NULL, error_digest=NULL,
          started_at=NULL, terminal_at=NULL, updated_at=?, revision=revision+1
      WHERE batch_id=? AND child_id=? AND state='unknown' AND read_only=1
    `).run(now, batchId, decision.childId);
    return Number(result.changes) === 1;
  }

  if (decision.action === "source_task_recovered") {
    const operation = database.prepare(`
      SELECT normalized_result_digest, upstream_result_digest FROM gateway_operations
      WHERE operation_id=?
    `).get(decision.gatewayOperationId) as unknown as {
      normalized_result_digest: string | null;
      upstream_result_digest: string | null;
    } | undefined;
    const resultDigest = operation?.normalized_result_digest
      || operation?.upstream_result_digest
      || decision.detailDigest;
    const result = database.prepare(`
      UPDATE gateway_batch_children
      SET state='succeeded', gateway_operation_id=?, gateway_operation_state=?,
          source_result_state=?, source_task_id=?, result_digest=?, error_digest=NULL,
          updated_at=?, terminal_at=?, revision=revision+1
      WHERE batch_id=? AND child_id=? AND state='unknown'
    `).run(
      decision.gatewayOperationId,
      decision.gatewayOperationState,
      decision.sourceResultState,
      decision.sourceTaskId,
      resultDigest,
      now,
      now,
      batchId,
      decision.childId,
    );
    return Number(result.changes) === 1;
  }

  const result = database.prepare(`
    UPDATE gateway_batch_children
    SET state='failed', gateway_operation_id=?, gateway_operation_state=?,
        source_result_state=?, source_task_id=NULL, result_digest=NULL, error_digest=?,
        updated_at=?, terminal_at=?, revision=revision+1
    WHERE batch_id=? AND child_id=? AND state='unknown'
  `).run(
    decision.gatewayOperationId,
    decision.gatewayOperationState,
    decision.sourceResultState,
    decision.detailDigest,
    now,
    now,
    batchId,
    decision.childId,
  );
  return Number(result.changes) === 1;
}

export function recoverBatchState(input: RecoverBatchStateInput): BatchRecoveryResult {
  const path = databasePath(input.path);
  const batchId = exactIdentifier(input.batchId, "batch id");
  const mode = exactMode(input.mode);
  const afterOrdinal = exactAfterOrdinal(input.afterOrdinal);
  const maxChildren = exactLimit(input.maxChildren);
  const now = (input.now ?? (() => new Date()))().toISOString();
  const database = openDatabase(path);

  try {
    database.exec("BEGIN IMMEDIATE");
    const batch = database.prepare(`
      SELECT batch_id, mode, state FROM gateway_batches WHERE batch_id=?
    `).get(batchId) as unknown as BatchRow | undefined;
    if (!batch) throw new Error("batch does not exist");
    if (!RECOVERABLE_BATCH_STATES.has(batch.state)) {
      throw new Error(`batch recovery requires paused or inspection_required state, not ${batch.state}`);
    }

    const before = countRow(database, batchId);
    const rows = database.prepare(`
      SELECT batch_id, child_id, ordinal, source_id, source_tool_name,
             source_operation_id, state
      FROM gateway_batch_children
      WHERE batch_id=? AND state='unknown' AND ordinal>?
      ORDER BY ordinal ASC LIMIT ?
    `).all(batchId, afterOrdinal, maxChildren) as unknown as ChildRow[];

    const children: BatchRecoveryChild[] = [];
    for (const row of rows) {
      const decision = childDecision(batch.mode, row, operationForChild(database, row));
      const applied = mode === "apply_safe"
        ? applyDecision(database, batchId, decision, now)
        : false;
      children.push({ schema: "morrow.batch-recovery-child.v1", ...decision, applied });
    }

    const updated = mode === "apply_safe"
      ? updateBatchCounts(database, batchId, batch.state, now)
      : { state: batch.state, counts: before };
    const remainingAfterCursor = database.prepare(`
      SELECT COUNT(*) AS count FROM gateway_batch_children
      WHERE batch_id=? AND state='unknown' AND ordinal>?
    `).get(batchId, rows.at(-1)?.ordinal || afterOrdinal) as unknown as { count: number };
    database.exec("COMMIT");

    return {
      schema: "morrow.batch-recovery.v1",
      batchId,
      mode,
      batchMode: batch.mode,
      stateBefore: batch.state,
      stateAfter: updated.state,
      afterOrdinal,
      scanned: children.length,
      applied: children.filter((child) => child.applied).length,
      retryReadOnly: children.filter((child) => child.action === "retry_read_only").length,
      sourceTasksRecovered: children.filter((child) => child.action === "source_task_recovered").length,
      failedBeforeSend: children.filter((child) => child.action === "failed_before_send").length,
      inspectionRequired: children.filter((child) => child.action === "inspection_required").length,
      unknownChildrenBefore: before.unknown_count,
      unknownChildrenAfter: updated.counts.unknown_count,
      pendingChildrenAfter: updated.counts.pending,
      nextAfterOrdinal: Number(remainingAfterCursor.count || 0) > 0 && rows.length > 0
        ? rows.at(-1)!.ordinal
        : null,
      children,
      providerDispatches: 0,
    };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    database.close();
  }
}
