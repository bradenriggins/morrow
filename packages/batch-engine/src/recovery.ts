import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  canonicalJson,
  isJsonObject,
  sha256Json,
  sha256Text,
  type JsonObject,
} from "@morrow/contracts";
import { openExactPrivateSqliteDatabase } from "@morrow/gateway-core";
import {
  bindCanvasResultArtifactArguments,
  decryptCanvasResultBindingArtifact,
  type CanvasBindingChild,
} from "./canvas-result-binding.js";
import type { BatchMode, BatchState, FrozenBatchManifest } from "./index.js";

export const BATCH_RECOVERY_MODES = Object.freeze(["inspect", "apply_safe"] as const);
export type BatchRecoveryMode = typeof BATCH_RECOVERY_MODES[number];

export const BATCH_RECOVERY_ACTIONS = Object.freeze([
  "retry_read_only",
  "source_task_recovered",
  "direct_effect_verified",
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
  readonly encryptionKey?: Uint8Array;
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
  public_tool_name: string;
  source_id: string;
  source_tool_name: string;
  source_operation_id: string | null;
  gateway_operation_id: string | null;
  state: string;
  request_digest: string;
  request_ciphertext: string;
  request_iv: string;
  request_tag: string;
  bound_request_digest: string | null;
  bound_request_ciphertext: string | null;
  bound_request_iv: string | null;
  bound_request_tag: string | null;
}

interface ManifestRow {
  batch_id: string;
  manifest_digest: string;
  manifest_ciphertext: string;
  manifest_iv: string;
  manifest_tag: string;
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

interface VerifiedDirectEffectRow {
  operation_id: string;
  public_tool_name: string;
  source_id: string;
  source_tool_name: string;
  source_operation_id: string | null;
  source_binding_id: string | null;
  target_identity_digest: string | null;
  upstream_result_digest: string;
  source_result_state: string | null;
  readback_digest: string;
  result_binding_artifact_json: string | null;
}

interface BoundDependent {
  readonly childId: string;
  readonly digest: string;
  readonly arguments: JsonObject;
}

type ResultBindingRecovery =
  | { readonly status: "none" }
  | { readonly status: "ready"; readonly dependents: readonly BoundDependent[] }
  | { readonly status: "inspection_required"; readonly dependentChildIds: readonly string[] };

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

function exactKey(value: Uint8Array | undefined): Buffer | null {
  if (value === undefined) return null;
  const key = Buffer.from(value);
  if (key.length !== 32) throw new TypeError("batch encryption key must contain exactly 32 bytes");
  return key;
}

function decryptJson(
  key: Buffer,
  ciphertext: string,
  iv: string,
  tag: string,
  aad: string,
  digest: string,
  label: string,
): JsonObject {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as unknown;
  if (!isJsonObject(parsed) || sha256Json(parsed) !== digest) {
    throw new Error(`${label} failed authenticated readback`);
  }
  return parsed;
}

function decryptedManifest(key: Buffer, row: ManifestRow): FrozenBatchManifest {
  return decryptJson(
    key,
    row.manifest_ciphertext,
    row.manifest_iv,
    row.manifest_tag,
    `${row.batch_id}\0manifest\0${row.manifest_digest}`,
    row.manifest_digest,
    "batch manifest",
  ) as unknown as FrozenBatchManifest;
}

function decryptedRequest(key: Buffer, row: ChildRow): JsonObject {
  return decryptJson(
    key,
    row.request_ciphertext,
    row.request_iv,
    row.request_tag,
    `${row.batch_id}\0${row.child_id}\0${row.request_digest}`,
    row.request_digest,
    "batch child request",
  );
}

function encryptedBoundRequest(
  key: Buffer,
  batchId: string,
  childId: string,
  requestDigest: string,
  value: JsonObject,
): { readonly ciphertext: string; readonly iv: string; readonly tag: string } {
  const plaintext = Buffer.from(canonicalJson(value), "utf8");
  if (plaintext.length > 64 * 1024) throw new RangeError("batch child bound request is too large");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${batchId}\0${childId}\0bound-request\0${requestDigest}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

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
  const database = openExactPrivateSqliteDatabase(path, "Morrow batch recovery database", {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  }).database;
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

function verifiedDirectEffectForChild(
  database: DatabaseSync,
  child: ChildRow,
): VerifiedDirectEffectRow | null {
  if (!child.gateway_operation_id?.startsWith("op:") || !child.source_operation_id) return null;
  const table = database.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type='table' AND name='provider_effect_operations'
  `).get() as unknown as { present: number } | undefined;
  if (!table) return null;
  const effectColumns = new Set((database.prepare("PRAGMA table_info(provider_effect_operations)")
    .all() as { name: string }[]).map((column) => column.name));
  const artifactColumn = effectColumns.has("result_binding_artifact_json")
    ? "result_binding_artifact_json" : "NULL AS result_binding_artifact_json";
  const row = database.prepare(`
    SELECT operation_id, public_tool_name, source_id, source_tool_name,
           source_operation_id, source_binding_id, target_identity_digest,
           upstream_result_digest, source_result_state, readback_digest,
           ${artifactColumn}
    FROM provider_effect_operations
    WHERE operation_id=?
      AND source_id=?
      AND source_tool_name=?
      AND source_operation_id=?
      AND source_task_id IS NULL
      AND state='verified'
      AND verification_status='verified'
      AND upstream_result_digest IS NOT NULL
      AND readback_digest IS NOT NULL
    LIMIT 1
  `).get(
    child.gateway_operation_id,
    child.source_id,
    child.source_tool_name,
    child.source_operation_id,
  ) as unknown as VerifiedDirectEffectRow | undefined;
  return row || null;
}

function resultBindingRecovery(
  database: DatabaseSync,
  batchId: string,
  sourceRow: ChildRow,
  effect: VerifiedDirectEffectRow,
  key: Buffer | null,
): ResultBindingRecovery {
  const manifestRow = database.prepare(`
    SELECT * FROM gateway_batch_manifests WHERE batch_id=?
  `).get(batchId) as unknown as ManifestRow | undefined;
  if (!manifestRow || !key) {
    // We cannot know whether this source has result-bound dependents without
    // authenticating the frozen manifest. Keep a verified create unresolved.
    return sourceRow.public_tool_name === "canvas_create_page_courses"
      || sourceRow.public_tool_name === "canvas_create_assignment"
      ? { status: "inspection_required", dependentChildIds: [] }
      : { status: "none" };
  }
  let manifest: FrozenBatchManifest;
  try {
    manifest = decryptedManifest(key, manifestRow);
  } catch {
    return { status: "inspection_required", dependentChildIds: [] };
  }
  const dependentManifests = manifest.children.filter(
    (child) => child.resultBinding?.sourceChildId === sourceRow.child_id,
  );
  if (dependentManifests.length === 0) return { status: "none" };
  const dependentChildIds = dependentManifests.map((child) => child.childId);
  if (!effect.result_binding_artifact_json) {
    return { status: "inspection_required", dependentChildIds };
  }
  try {
    const artifact = decryptCanvasResultBindingArtifact(
      key,
      {
        operationId: effect.operation_id,
        publicToolName: effect.public_tool_name,
        sourceId: effect.source_id,
        sourceToolName: effect.source_tool_name,
        sourceOperationId: effect.source_operation_id,
        sourceBindingId: effect.source_binding_id,
        targetIdentityDigest: effect.target_identity_digest,
        upstreamResultDigest: effect.upstream_result_digest,
        readbackDigest: effect.readback_digest,
      },
      JSON.parse(effect.result_binding_artifact_json) as unknown,
    );
    const sourceManifest = manifest.children.find((child) => child.childId === sourceRow.child_id);
    if (!sourceManifest) throw new Error("batch source child is absent from its manifest");
    const source: CanvasBindingChild = {
      childId: sourceRow.child_id,
      courseId: sourceManifest.courseId,
      publicToolName: sourceRow.public_tool_name,
      sourceId: sourceRow.source_id,
      sourceToolName: sourceRow.source_tool_name,
      arguments: decryptedRequest(key, sourceRow),
      dependencyChildIds: sourceManifest.dependencyChildIds,
    };
    const dependents = dependentManifests.map((dependentManifest): BoundDependent => {
      const dependentRow = database.prepare(`
        SELECT * FROM gateway_batch_children WHERE batch_id=? AND child_id=?
      `).get(batchId, dependentManifest.childId) as unknown as ChildRow | undefined;
      if (!dependentRow || dependentRow.state !== "pending"
        || dependentRow.gateway_operation_id !== null
        || dependentRow.bound_request_digest !== null
        || dependentRow.bound_request_ciphertext !== null
        || dependentRow.bound_request_iv !== null
        || dependentRow.bound_request_tag !== null) {
        throw new Error("batch result-bound child cannot be recovered from its current state");
      }
      const dependent: CanvasBindingChild = {
        childId: dependentRow.child_id,
        courseId: dependentManifest.courseId,
        publicToolName: dependentRow.public_tool_name,
        sourceId: dependentRow.source_id,
        sourceToolName: dependentRow.source_tool_name,
        arguments: decryptedRequest(key, dependentRow),
        dependencyChildIds: dependentManifest.dependencyChildIds,
      };
      const argumentsValue = bindCanvasResultArtifactArguments(
        dependentManifest.resultBinding!,
        source,
        dependent,
        artifact,
      );
      return {
        childId: dependent.childId,
        digest: sha256Json(argumentsValue),
        arguments: argumentsValue,
      };
    });
    return { status: "ready", dependents };
  } catch {
    return { status: "inspection_required", dependentChildIds };
  }
}

function childDecision(
  batchMode: BatchMode,
  child: ChildRow,
  operation: OperationRow | null,
  verifiedDirectEffect: VerifiedDirectEffectRow | null,
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

  if (verifiedDirectEffect) {
    return {
      childId: child.child_id,
      ordinal: child.ordinal,
      sourceId: child.source_id,
      sourceToolName: child.source_tool_name,
      sourceOperationId: child.source_operation_id,
      action: "direct_effect_verified",
      gatewayOperationId: verifiedDirectEffect.operation_id,
      gatewayOperationState: "verified",
      sourceTaskId: null,
      sourceResultState: verifiedDirectEffect.source_result_state,
      detailDigest: verifiedDirectEffect.readback_digest,
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
  bindingRecovery: ResultBindingRecovery = { status: "none" },
  key: Buffer | null = null,
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
    if (bindingRecovery.status === "inspection_required") {
      if (Number(result.changes) !== 1) {
        throw new Error("batch result-binding source changed during recovery");
      }
      const markDependent = database.prepare(`
        UPDATE gateway_batch_children
        SET state='unknown', gateway_operation_state='result_binding_inspection_required',
            error_digest=?, updated_at=?, terminal_at=?, revision=revision+1
        WHERE batch_id=? AND child_id=? AND state='pending'
      `);
      for (const childId of bindingRecovery.dependentChildIds) {
        const marked = markDependent.run(decision.detailDigest, now, now, batchId, childId);
        if (Number(marked.changes) !== 1) {
          throw new Error("batch result-bound dependent changed during recovery");
        }
      }
    }
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

  if (decision.action === "direct_effect_verified") {
    if (bindingRecovery.status === "ready") {
      if (!key) throw new Error("batch result binding recovery requires its encryption key");
      const saveBound = database.prepare(`
        UPDATE gateway_batch_children
        SET bound_request_digest=?, bound_request_ciphertext=?, bound_request_iv=?, bound_request_tag=?,
            updated_at=?, revision=revision+1
        WHERE batch_id=? AND child_id=? AND state='pending'
          AND bound_request_digest IS NULL AND bound_request_ciphertext IS NULL
          AND bound_request_iv IS NULL AND bound_request_tag IS NULL
      `);
      for (const dependent of bindingRecovery.dependents) {
        const encrypted = encryptedBoundRequest(
          key,
          batchId,
          dependent.childId,
          dependent.digest,
          dependent.arguments,
        );
        const saved = saveBound.run(
          dependent.digest,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          now,
          batchId,
          dependent.childId,
        );
        if (Number(saved.changes) !== 1) {
          throw new Error("batch result-bound dependent changed during recovery");
        }
      }
    }
    const result = database.prepare(`
      UPDATE gateway_batch_children
      SET state='succeeded', gateway_operation_id=?, gateway_operation_state='verified',
          source_result_state=?, source_task_id=NULL, result_digest=?, error_digest=NULL,
          updated_at=?, terminal_at=?, revision=revision+1
      WHERE batch_id=? AND child_id=? AND state='unknown'
    `).run(
      decision.gatewayOperationId,
      decision.sourceResultState,
      decision.detailDigest,
      now,
      now,
      batchId,
      decision.childId,
    );
    if (bindingRecovery.status === "ready" && Number(result.changes) !== 1) {
      throw new Error("batch result-binding source changed during recovery");
    }
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
  const key = exactKey(input.encryptionKey);
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
      SELECT *
      FROM gateway_batch_children
      WHERE batch_id=? AND state='unknown' AND ordinal>?
      ORDER BY ordinal ASC LIMIT ?
    `).all(batchId, afterOrdinal, maxChildren) as unknown as ChildRow[];

    const children: BatchRecoveryChild[] = [];
    for (const row of rows) {
      const directEffect = verifiedDirectEffectForChild(database, row);
      let decision = childDecision(
        batch.mode,
        row,
        operationForChild(database, row),
        directEffect,
      );
      const bindingRecovery = directEffect && decision.action === "direct_effect_verified"
        ? resultBindingRecovery(database, batchId, row, directEffect, key)
        : { status: "none" as const };
      if (bindingRecovery.status === "inspection_required") {
        decision = {
          ...decision,
          action: "inspection_required",
          gatewayOperationState: "verified_result_binding_inspection_required",
          detailDigest: sha256Text("result_binding_artifact_unavailable"),
        };
      }
      const applied = mode === "apply_safe"
        ? applyDecision(database, batchId, decision, now, bindingRecovery, key)
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
