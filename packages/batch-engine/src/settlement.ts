import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  isJsonObject,
  sha256Json,
  type JsonObject,
} from "@morrow/contracts";

export const BATCH_SOURCE_SETTLEMENT_STATES = Object.freeze([
  "not_started",
  "awaiting_approval",
  "running",
  "succeeded",
  "failed_no_effect",
  "failed_effect_possible",
  "cancelled",
  "reverted",
  "inspection_required",
  "unknown",
] as const);

export type BatchSourceSettlementState = typeof BATCH_SOURCE_SETTLEMENT_STATES[number];

export const BATCH_SOURCE_OUTCOMES = Object.freeze([
  "not_applicable",
  "not_started",
  "awaiting_approval",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "reverted",
  "inspection_required",
] as const);

export type BatchSourceOutcome = typeof BATCH_SOURCE_OUTCOMES[number];

export interface BatchSourceResultCounts {
  readonly done: number;
  readonly unconfirmed: number;
  readonly failed: number;
  readonly rollbackFailed: number;
  readonly skipped: number;
  readonly undone: number;
  readonly notStarted: number;
}

export interface BatchSourceSettlementRecord {
  readonly schema: "morrow.batch-source-settlement.v1";
  readonly batchId: string;
  readonly childId: string;
  readonly sourceId: string;
  readonly sourceBindingId: string | null;
  readonly sourceTaskId: string | null;
  readonly state: BatchSourceSettlementState;
  readonly taskStatus: string | null;
  readonly taskOutcome: string | null;
  readonly verificationStatus: string | null;
  readonly resultCounts: BatchSourceResultCounts;
  readonly taskDigest: string | null;
  readonly stageGatewayOperationId: string | null;
  readonly reconciliationGatewayOperationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly checkedAt: string | null;
  readonly revision: number;
}

export interface BatchSourceSettlementSummary {
  readonly schema: "morrow.batch-source-settlement-summary.v1";
  readonly batchId: string;
  readonly outcome: BatchSourceOutcome;
  readonly total: number;
  readonly notStarted: number;
  readonly awaitingApproval: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failedNoEffect: number;
  readonly failedEffectPossible: number;
  readonly cancelled: number;
  readonly reverted: number;
  readonly inspectionRequired: number;
  readonly unknown: number;
  readonly terminal: boolean;
  readonly requiresAttention: boolean;
}

export interface InitializeSourceSettlementChild {
  readonly childId: string;
  readonly sourceId: string;
  readonly sourceBindingId?: string;
}

export interface ProjectedSourceTask {
  readonly taskId: string;
  readonly status: string;
  readonly outcome?: string;
  readonly terminal?: boolean;
  readonly verificationStatus?: string | null;
  readonly resultCounts?: Partial<BatchSourceResultCounts>;
}

export interface BatchSourceSettlementStoreOptions {
  readonly path: string;
  readonly now?: () => Date;
}

interface SettlementRow {
  batch_id: string;
  child_id: string;
  source_id: string;
  source_binding_id: string | null;
  source_task_id: string | null;
  state: BatchSourceSettlementState;
  task_status: string | null;
  task_outcome: string | null;
  verification_status: string | null;
  done_count: number;
  unconfirmed_count: number;
  failed_count: number;
  rollback_failed_count: number;
  skipped_count: number;
  undone_count: number;
  not_started_count: number;
  task_digest: string | null;
  stage_gateway_operation_id: string | null;
  reconciliation_gateway_operation_id: string | null;
  created_at: string;
  updated_at: string;
  checked_at: string | null;
  revision: number;
}

const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,160}$/;
const TASK_STATUS_MAX = 120;
const TERMINAL_STATES = new Set<BatchSourceSettlementState>([
  "succeeded",
  "failed_no_effect",
  "failed_effect_possible",
  "cancelled",
  "reverted",
]);

function exactIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new TypeError(`${label} has an invalid format`);
  return normalized;
}

function optionalIdentifier(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return exactIdentifier(value, label);
}

function boundedStateText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().slice(0, TASK_STATUS_MAX);
  return normalized || null;
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizedCounts(value: unknown): BatchSourceResultCounts {
  const input = isJsonObject(value) ? value : {};
  return {
    done: count(input.done),
    unconfirmed: count(input.unconfirmed),
    failed: count(input.failed),
    rollbackFailed: count(input.rollbackFailed),
    skipped: count(input.skipped),
    undone: count(input.undone),
    notStarted: count(input.notStarted),
  };
}

function record(row: SettlementRow): BatchSourceSettlementRecord {
  return {
    schema: "morrow.batch-source-settlement.v1",
    batchId: row.batch_id,
    childId: row.child_id,
    sourceId: row.source_id,
    sourceBindingId: row.source_binding_id,
    sourceTaskId: row.source_task_id,
    state: row.state,
    taskStatus: row.task_status,
    taskOutcome: row.task_outcome,
    verificationStatus: row.verification_status,
    resultCounts: {
      done: row.done_count,
      unconfirmed: row.unconfirmed_count,
      failed: row.failed_count,
      rollbackFailed: row.rollback_failed_count,
      skipped: row.skipped_count,
      undone: row.undone_count,
      notStarted: row.not_started_count,
    },
    taskDigest: row.task_digest,
    stageGatewayOperationId: row.stage_gateway_operation_id,
    reconciliationGatewayOperationId: row.reconciliation_gateway_operation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    checkedAt: row.checked_at,
    revision: row.revision,
  };
}

export function sourceSettlementStateFromTask(
  task: ProjectedSourceTask,
): BatchSourceSettlementState {
  const status = boundedStateText(task.status) || "unknown";
  const outcome = boundedStateText(task.outcome);
  if (outcome && BATCH_SOURCE_SETTLEMENT_STATES.includes(outcome as BatchSourceSettlementState)) {
    return outcome as BatchSourceSettlementState;
  }
  if (["awaiting_confirmation", "awaiting_approval", "pending_approval"].includes(status)) {
    return "awaiting_approval";
  }
  if (["running", "approved", "resuming", "undoing"].includes(status)) return "running";
  if (["cancelled", "denied"].includes(status)) return "cancelled";
  if (status === "undone") return "reverted";
  if (status === "paused") return "inspection_required";
  const counts = normalizedCounts(task.resultCounts);
  const effectPossible = counts.done > 0
    || counts.unconfirmed > 0
    || counts.rollbackFailed > 0
    || counts.undone > 0;
  if (status === "failed") return effectPossible ? "failed_effect_possible" : "failed_no_effect";
  if (status === "completed") {
    if (
      counts.unconfirmed > 0
      || counts.failed > 0
      || counts.rollbackFailed > 0
      || counts.skipped > 0
      || counts.notStarted > 0
    ) return "inspection_required";
    if (counts.undone > 0 && counts.done === 0) return "reverted";
    return "succeeded";
  }
  return "unknown";
}

function summaryOutcome(counts: Omit<BatchSourceSettlementSummary, "schema" | "batchId" | "outcome" | "terminal" | "requiresAttention">): BatchSourceOutcome {
  if (counts.total === 0) return "not_applicable";
  if (counts.inspectionRequired > 0 || counts.unknown > 0 || counts.failedEffectPossible > 0) {
    return "inspection_required";
  }
  if (counts.running > 0) return "running";
  if (counts.awaitingApproval > 0) return "awaiting_approval";
  if (counts.notStarted > 0) return "not_started";
  if (counts.succeeded === counts.total) return "succeeded";
  if (counts.cancelled === counts.total) return "cancelled";
  if (counts.reverted === counts.total) return "reverted";
  if (counts.failedNoEffect === counts.total) return "failed";
  return "partial";
}

export class BatchSourceSettlementStore {
  readonly path: string;
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: BatchSourceSettlementStoreOptions) {
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
      ${this.path === ":memory:" ? "" : "PRAGMA journal_mode = WAL;"}
      CREATE TABLE IF NOT EXISTS gateway_batch_source_settlements (
        batch_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_binding_id TEXT,
        source_task_id TEXT,
        state TEXT NOT NULL CHECK(state IN (
          'not_started','awaiting_approval','running','succeeded','failed_no_effect',
          'failed_effect_possible','cancelled','reverted','inspection_required','unknown'
        )),
        task_status TEXT,
        task_outcome TEXT,
        verification_status TEXT,
        done_count INTEGER NOT NULL DEFAULT 0,
        unconfirmed_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        rollback_failed_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        undone_count INTEGER NOT NULL DEFAULT 0,
        not_started_count INTEGER NOT NULL DEFAULT 0,
        task_digest TEXT,
        stage_gateway_operation_id TEXT,
        reconciliation_gateway_operation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        checked_at TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        PRIMARY KEY(batch_id, child_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS gateway_batch_source_settlement_state
        ON gateway_batch_source_settlements(batch_id, state, child_id);
      CREATE INDEX IF NOT EXISTS gateway_batch_source_settlement_task
        ON gateway_batch_source_settlements(source_id, source_task_id);
    `);
  }

  private instant(): string {
    return this.now().toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("batch source settlement store is closed");
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

  initialize(batchIdValue: string, children: readonly InitializeSourceSettlementChild[]): void {
    const batchId = exactIdentifier(batchIdValue, "batch id");
    const now = this.instant();
    this.transaction(() => {
      const insert = this.database.prepare(`
        INSERT OR IGNORE INTO gateway_batch_source_settlements(
          batch_id, child_id, source_id, source_binding_id, state, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, 'not_started', ?, ?, 1)
      `);
      for (const child of children) {
        const childId = exactIdentifier(child.childId, "child id");
        const sourceId = exactIdentifier(child.sourceId, "source id");
        const sourceBindingId = optionalIdentifier(child.sourceBindingId, "source binding id");
        insert.run(batchId, childId, sourceId, sourceBindingId, now, now);
        const existing = this.get(batchId, childId);
        if (existing.sourceId !== sourceId || existing.sourceBindingId !== sourceBindingId) {
          throw new Error("batch source settlement identity changed");
        }
      }
    });
  }

  get(batchIdValue: string, childIdValue: string): BatchSourceSettlementRecord {
    this.assertOpen();
    const batchId = exactIdentifier(batchIdValue, "batch id");
    const childId = exactIdentifier(childIdValue, "child id");
    const row = this.database.prepare(`
      SELECT * FROM gateway_batch_source_settlements WHERE batch_id=? AND child_id=?
    `).get(batchId, childId) as SettlementRow | undefined;
    if (!row) throw new Error("batch source settlement does not exist");
    return record(row);
  }

  list(batchIdValue: string, offsetValue = 0, limitValue = 500): readonly BatchSourceSettlementRecord[] {
    this.assertOpen();
    const batchId = exactIdentifier(batchIdValue, "batch id");
    const offset = Math.max(0, Math.trunc(offsetValue));
    const limit = Math.max(1, Math.min(Math.trunc(limitValue), 500));
    return (this.database.prepare(`
      SELECT * FROM gateway_batch_source_settlements
      WHERE batch_id=? ORDER BY child_id ASC LIMIT ? OFFSET ?
    `).all(batchId, limit, offset) as unknown as SettlementRow[]).map(record);
  }

  reconcilable(batchIdValue: string, limitValue = 100): readonly BatchSourceSettlementRecord[] {
    this.assertOpen();
    const batchId = exactIdentifier(batchIdValue, "batch id");
    const limit = Math.max(1, Math.min(Math.trunc(limitValue), 500));
    return (this.database.prepare(`
      SELECT * FROM gateway_batch_source_settlements
      WHERE batch_id=? AND source_task_id IS NOT NULL
        AND state IN ('awaiting_approval','running','inspection_required','unknown')
      ORDER BY child_id ASC LIMIT ?
    `).all(batchId, limit) as unknown as SettlementRow[]).map(record);
  }

  markStaged(
    batchIdValue: string,
    childIdValue: string,
    input: {
      readonly sourceTaskId: string;
      readonly gatewayOperationId?: string;
      readonly taskStatus?: string;
    },
  ): BatchSourceSettlementRecord {
    const batchId = exactIdentifier(batchIdValue, "batch id");
    const childId = exactIdentifier(childIdValue, "child id");
    const sourceTaskId = exactIdentifier(input.sourceTaskId, "source task id");
    const gatewayOperationId = optionalIdentifier(input.gatewayOperationId, "gateway operation id");
    const taskStatus = boundedStateText(input.taskStatus) || "awaiting_confirmation";
    const now = this.instant();
    return this.transaction(() => {
      const existing = this.get(batchId, childId);
      if (existing.sourceTaskId && existing.sourceTaskId !== sourceTaskId) {
        throw new Error("batch child source task identity changed");
      }
      this.database.prepare(`
        UPDATE gateway_batch_source_settlements
        SET source_task_id=?, state='awaiting_approval', task_status=?, task_outcome='awaiting_approval',
            stage_gateway_operation_id=COALESCE(stage_gateway_operation_id, ?),
            updated_at=?, checked_at=?, revision=revision+1
        WHERE batch_id=? AND child_id=?
      `).run(sourceTaskId, taskStatus, gatewayOperationId, now, now, batchId, childId);
      return this.get(batchId, childId);
    });
  }

  markDispatchResult(
    batchIdValue: string,
    childIdValue: string,
    state: "failed" | "unknown",
    gatewayOperationId?: string,
  ): BatchSourceSettlementRecord {
    const batchId = exactIdentifier(batchIdValue, "batch id");
    const childId = exactIdentifier(childIdValue, "child id");
    const gateway = optionalIdentifier(gatewayOperationId, "gateway operation id");
    const settlementState: BatchSourceSettlementState = state === "unknown"
      ? "inspection_required"
      : "failed_no_effect";
    const now = this.instant();
    return this.transaction(() => {
      this.get(batchId, childId);
      this.database.prepare(`
        UPDATE gateway_batch_source_settlements
        SET state=?, task_outcome=?, stage_gateway_operation_id=COALESCE(stage_gateway_operation_id, ?),
            updated_at=?, checked_at=?, revision=revision+1
        WHERE batch_id=? AND child_id=?
      `).run(settlementState, settlementState, gateway, now, now, batchId, childId);
      return this.get(batchId, childId);
    });
  }

  applyTaskProjection(
    batchIdValue: string,
    childIdValue: string,
    taskValue: unknown,
    reconciliationGatewayOperationId?: string,
  ): BatchSourceSettlementRecord {
    const batchId = exactIdentifier(batchIdValue, "batch id");
    const childId = exactIdentifier(childIdValue, "child id");
    if (!isJsonObject(taskValue)) throw new TypeError("source task projection must be an object");
    const taskId = exactIdentifier(taskValue.taskId, "source task id");
    const status = boundedStateText(taskValue.status) || "unknown";
    const outcome = boundedStateText(taskValue.outcome);
    const verificationStatus = boundedStateText(taskValue.verificationStatus);
    const resultCounts = normalizedCounts(taskValue.resultCounts);
    const projection: ProjectedSourceTask = {
      taskId,
      status,
      ...(outcome ? { outcome } : {}),
      ...(typeof taskValue.terminal === "boolean" ? { terminal: taskValue.terminal } : {}),
      ...(verificationStatus ? { verificationStatus } : {}),
      resultCounts,
    };
    const settlementState = sourceSettlementStateFromTask(projection);
    const taskDigest = sha256Json({
      taskId,
      status,
      outcome,
      terminal: taskValue.terminal === true,
      verificationStatus,
      resultCounts,
    });
    const reconciliationOperation = optionalIdentifier(
      reconciliationGatewayOperationId,
      "reconciliation gateway operation id",
    );
    const now = this.instant();
    return this.transaction(() => {
      const existing = this.get(batchId, childId);
      if (!existing.sourceTaskId || existing.sourceTaskId !== taskId) {
        throw new Error("source task projection does not match the batch child task identity");
      }
      this.database.prepare(`
        UPDATE gateway_batch_source_settlements
        SET state=?, task_status=?, task_outcome=?, verification_status=?,
            done_count=?, unconfirmed_count=?, failed_count=?, rollback_failed_count=?,
            skipped_count=?, undone_count=?, not_started_count=?, task_digest=?,
            reconciliation_gateway_operation_id=?, updated_at=?, checked_at=?, revision=revision+1
        WHERE batch_id=? AND child_id=?
      `).run(
        settlementState,
        status,
        outcome,
        verificationStatus,
        resultCounts.done,
        resultCounts.unconfirmed,
        resultCounts.failed,
        resultCounts.rollbackFailed,
        resultCounts.skipped,
        resultCounts.undone,
        resultCounts.notStarted,
        taskDigest,
        reconciliationOperation,
        now,
        now,
        batchId,
        childId,
      );
      return this.get(batchId, childId);
    });
  }

  summary(batchIdValue: string): BatchSourceSettlementSummary {
    this.assertOpen();
    const batchId = exactIdentifier(batchIdValue, "batch id");
    const row = this.database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN state='not_started' THEN 1 ELSE 0 END) AS not_started,
        SUM(CASE WHEN state='awaiting_approval' THEN 1 ELSE 0 END) AS awaiting_approval,
        SUM(CASE WHEN state='running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN state='failed_no_effect' THEN 1 ELSE 0 END) AS failed_no_effect,
        SUM(CASE WHEN state='failed_effect_possible' THEN 1 ELSE 0 END) AS failed_effect_possible,
        SUM(CASE WHEN state='cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN state='reverted' THEN 1 ELSE 0 END) AS reverted,
        SUM(CASE WHEN state='inspection_required' THEN 1 ELSE 0 END) AS inspection_required,
        SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END) AS unknown_count
      FROM gateway_batch_source_settlements WHERE batch_id=?
    `).get(batchId) as Record<string, number>;
    const counts = {
      total: count(row.total),
      notStarted: count(row.not_started),
      awaitingApproval: count(row.awaiting_approval),
      running: count(row.running),
      succeeded: count(row.succeeded),
      failedNoEffect: count(row.failed_no_effect),
      failedEffectPossible: count(row.failed_effect_possible),
      cancelled: count(row.cancelled),
      reverted: count(row.reverted),
      inspectionRequired: count(row.inspection_required),
      unknown: count(row.unknown_count),
    };
    const outcome = summaryOutcome(counts);
    return {
      schema: "morrow.batch-source-settlement-summary.v1",
      batchId,
      outcome,
      ...counts,
      terminal: counts.total === 0 || (
        counts.notStarted === 0
        && counts.awaitingApproval === 0
        && counts.running === 0
        && counts.inspectionRequired === 0
        && counts.unknown === 0
      ),
      requiresAttention: ["inspection_required", "partial", "failed"].includes(outcome),
    };
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

export function taskProjectionFromGatewayResult(value: unknown): JsonObject | null {
  if (!isJsonObject(value) || !isJsonObject(value.structuredContent)) return null;
  const structured = value.structuredContent;
  if (structured.ok !== true || !isJsonObject(structured.task)) return null;
  return structured.task;
}
