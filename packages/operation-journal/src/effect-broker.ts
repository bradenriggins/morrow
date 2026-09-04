import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256Json, type JsonObject } from "@morrow/contracts";

export const EFFECT_OPERATION_STATES = Object.freeze([
  "awaiting_approval",
  "approved",
  "dispatching",
  "awaiting_inner_approval",
  "awaiting_verification",
  "verified",
  "failed",
  "applied_or_unknown",
  "cancelled",
] as const);

export type EffectOperationState = typeof EFFECT_OPERATION_STATES[number];

export interface FrozenReadbackPlan {
  readonly tool: string;
  readonly arguments: JsonObject;
  readonly expectedDigest: string;
}

export interface EffectAuthoritySnapshot {
  readonly profileDigest: string;
  readonly actorDigest: string;
  readonly providerPrincipalDigest: string;
  readonly connectionGeneration: number;
  readonly catalogDigest: string;
  readonly approvalClass: string;
  readonly targetSetDigest: string;
}

export interface CreateEffectOperationInput {
  readonly publicToolName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly catalogDigest: string;
  readonly request: JsonObject;
  readonly forwardedRequest: JsonObject;
  readonly sourceOperationId?: string;
  readonly sourceBindingId?: string;
  readonly readback?: FrozenReadbackPlan;
  readonly correctionOf?: string;
  readonly approvalTtlMs?: number;
  readonly authority: EffectAuthoritySnapshot;
}

export interface EffectOperationRecord {
  readonly schema: "morrow.operation.v1";
  readonly operationId: string;
  readonly publicToolName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly catalogDigest: string;
  readonly requestDigest: string;
  readonly forwardedRequestDigest: string;
  readonly forwardedRequest: JsonObject;
  readonly planDigest: string;
  readonly plan: JsonObject;
  readonly sourceOperationId: string | null;
  readonly sourceBindingId: string | null;
  readonly readback: FrozenReadbackPlan | null;
  readonly correctionOf: string | null;
  readonly state: EffectOperationState;
  readonly approvalGrantDigest: string | null;
  readonly approvalExpiresAt: string | null;
  readonly approvalConsumedAt: string | null;
  readonly effectReceiptId: string | null;
  readonly dispatchAttempt: number;
  readonly upstreamResultDigest: string | null;
  readonly sourceResultState: string | null;
  readonly sourceTaskId: string | null;
  readonly readbackDigest: string | null;
  readonly verificationStatus: "not_requested" | "unconfirmed" | "verified" | null;
  readonly attention: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
}

export interface ProviderEffectBrokerOptions {
  readonly path: string;
  readonly now?: () => Date;
}

interface EffectRow {
  operation_id: string;
  public_tool_name: string;
  source_id: string;
  source_tool_name: string;
  catalog_digest: string;
  request_digest: string;
  forwarded_request_digest: string;
  forwarded_request_json: string;
  plan_digest: string;
  plan_json: string;
  source_operation_id: string | null;
  source_binding_id: string | null;
  readback_json: string | null;
  correction_of: string | null;
  state: EffectOperationState;
  approval_grant_digest: string | null;
  approval_expires_at: string | null;
  approval_consumed_at: string | null;
  effect_receipt_id: string | null;
  dispatch_attempt: number;
  upstream_result_digest: string | null;
  source_result_state: string | null;
  source_task_id: string | null;
  readback_digest: string | null;
  verification_status: "not_requested" | "unconfirmed" | "verified" | null;
  attention_json: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,160}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TERMINAL = new Set<EffectOperationState>(["verified", "failed", "applied_or_unknown", "cancelled"]);

function identifier(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER.test(text)) throw new TypeError(`${label} has an invalid format`);
  return text;
}

function digest(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!DIGEST.test(text)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return text;
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return structuredClone(value) as JsonObject;
}

function parseJsonObject(value: string, label: string): JsonObject {
  return jsonObject(JSON.parse(value) as unknown, label);
}

function parseReadback(value: string | null): FrozenReadbackPlan | null {
  if (!value) return null;
  const parsed = parseJsonObject(value, "readback");
  return {
    tool: identifier(parsed.tool, "readback tool"),
    arguments: jsonObject(parsed.arguments, "readback arguments"),
    expectedDigest: digest(parsed.expectedDigest, "readback expected digest"),
  };
}

function authoritySnapshot(value: unknown): EffectAuthoritySnapshot {
  const object = jsonObject(value, "authority");
  for (const field of ["profileDigest", "actorDigest", "providerPrincipalDigest", "catalogDigest", "targetSetDigest"] as const) {
    digest(object[field], `authority ${field}`);
  }
  const connectionGeneration = object.connectionGeneration;
  if (!Number.isSafeInteger(connectionGeneration) || Number(connectionGeneration) < 0) {
    throw new TypeError("authority connectionGeneration must be a non-negative integer");
  }
  const approvalClass = identifier(object.approvalClass, "authority approval class");
  return {
    profileDigest: String(object.profileDigest),
    actorDigest: String(object.actorDigest),
    providerPrincipalDigest: String(object.providerPrincipalDigest),
    connectionGeneration: Number(connectionGeneration),
    catalogDigest: String(object.catalogDigest),
    approvalClass,
    targetSetDigest: String(object.targetSetDigest),
  };
}

function rowRecord(row: EffectRow): EffectOperationRecord {
  const attention = JSON.parse(row.attention_json) as unknown;
  return {
    schema: "morrow.operation.v1",
    operationId: row.operation_id,
    publicToolName: row.public_tool_name,
    sourceId: row.source_id,
    sourceToolName: row.source_tool_name,
    catalogDigest: row.catalog_digest,
    requestDigest: row.request_digest,
    forwardedRequestDigest: row.forwarded_request_digest,
    forwardedRequest: parseJsonObject(row.forwarded_request_json, "forwarded request"),
    planDigest: row.plan_digest,
    plan: parseJsonObject(row.plan_json, "plan"),
    sourceOperationId: row.source_operation_id,
    sourceBindingId: row.source_binding_id,
    readback: parseReadback(row.readback_json),
    correctionOf: row.correction_of,
    state: row.state,
    approvalGrantDigest: row.approval_grant_digest,
    approvalExpiresAt: row.approval_expires_at,
    approvalConsumedAt: row.approval_consumed_at,
    effectReceiptId: row.effect_receipt_id,
    dispatchAttempt: row.dispatch_attempt,
    upstreamResultDigest: row.upstream_result_digest,
    sourceResultState: row.source_result_state,
    sourceTaskId: row.source_task_id,
    readbackDigest: row.readback_digest,
    verificationStatus: row.verification_status,
    attention: Array.isArray(attention) ? attention.filter((entry): entry is string => typeof entry === "string") : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

export class ProviderEffectBroker {
  readonly path: string;
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: ProviderEffectBrokerOptions) {
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
      CREATE TABLE IF NOT EXISTS provider_effect_operations (
        operation_id TEXT PRIMARY KEY,
        public_tool_name TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_tool_name TEXT NOT NULL,
        catalog_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        forwarded_request_digest TEXT NOT NULL,
        forwarded_request_json TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        source_operation_id TEXT,
        source_binding_id TEXT,
        readback_json TEXT,
        correction_of TEXT,
        state TEXT NOT NULL CHECK(state IN ('awaiting_approval','approved','dispatching','awaiting_inner_approval','awaiting_verification','verified','failed','applied_or_unknown','cancelled')),
        approval_grant_digest TEXT,
        approval_expires_at TEXT,
        approval_consumed_at TEXT,
        effect_receipt_id TEXT,
        dispatch_attempt INTEGER NOT NULL CHECK(dispatch_attempt >= 0 AND dispatch_attempt <= 1),
        upstream_result_digest TEXT,
        source_result_state TEXT,
        source_task_id TEXT,
        readback_digest TEXT,
        verification_status TEXT CHECK(verification_status IN ('not_requested','unconfirmed','verified')),
        attention_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS provider_effect_operations_recent
        ON provider_effect_operations(created_at DESC, operation_id DESC);
      CREATE INDEX IF NOT EXISTS provider_effect_operations_state
        ON provider_effect_operations(state, updated_at DESC);
    `);
    this.recoverInterrupted();
  }

  private instant(): string {
    return this.now().toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("provider effect broker is closed");
  }

  private transaction<T>(work: () => T): T {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  private recoverInterrupted(): void {
    const now = this.instant();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state='applied_or_unknown', attention_json=?, updated_at=?, terminal_at=?
        WHERE state='dispatching'
      `).run(JSON.stringify(["process_restart_after_dispatch"]), now, now);
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state='cancelled', attention_json=?, updated_at=?, terminal_at=?
        WHERE state='awaiting_approval' AND approval_expires_at < ?
      `).run(JSON.stringify(["approval_expired"]), now, now, now);
    });
  }

  create(input: CreateEffectOperationInput): EffectOperationRecord {
    const request = jsonObject(input.request, "request");
    const forwardedRequest = jsonObject(input.forwardedRequest, "forwarded request");
    const readback = input.readback
      ? {
          tool: identifier(input.readback.tool, "readback tool"),
          arguments: jsonObject(input.readback.arguments, "readback arguments"),
          expectedDigest: digest(input.readback.expectedDigest, "readback expected digest"),
        }
      : null;
    const now = this.instant();
    const expiry = new Date(this.now().getTime() + Math.max(60_000, Math.min(input.approvalTtlMs ?? 15 * 60_000, 24 * 60 * 60_000))).toISOString();
    const publicToolName = identifier(input.publicToolName, "public tool name");
    const sourceId = identifier(input.sourceId, "source id");
    const sourceToolName = identifier(input.sourceToolName, "source tool name");
    const catalogDigest = digest(input.catalogDigest, "catalog digest");
    const authority = authoritySnapshot(input.authority);
    if (authority.catalogDigest !== catalogDigest) throw new Error("authority catalog digest does not match the operation catalog");
    const sourceOperationId = input.sourceOperationId
      ? identifier(input.sourceOperationId, "source operation id")
      : null;
    const plan: JsonObject = {
      schema: "morrow.plan.v1",
      tool: publicToolName,
      source: sourceId,
      sourceTool: sourceToolName,
      catalogDigest,
      authority,
      arguments: request,
      orderedChildren: [{ sequence: 1, tool: sourceToolName, targetDigest: authority.targetSetDigest }],
      changedFields: Object.keys(request).filter((field) => field !== "_morrow").sort(),
      preservedFields: ["all_unspecified_fields"],
      targetSet: { count: 1, digest: authority.targetSetDigest },
      risk: { approvalClass: authority.approvalClass },
      requestCost: { providerRequests: readback ? 2 : 1 },
      ...(input.sourceBindingId ? { sourceBindingId: identifier(input.sourceBindingId, "source binding id") } : {}),
      ...(readback ? { readback } : {}),
      undo: { supported: false, reason: "no_frozen_pre_state_or_correction_payload" },
      ...(input.correctionOf ? { correctionOf: identifier(input.correctionOf, "correction operation id") } : {}),
    };
    const operationId = `op:${randomUUID()}`;
    const planDigest = sha256Json(plan);
    return this.transaction(() => {
      if (sourceOperationId) {
        const existing = this.database.prepare(`
          SELECT * FROM provider_effect_operations WHERE source_operation_id=?
          ORDER BY created_at ASC LIMIT 1
        `).get(sourceOperationId) as EffectRow | undefined;
        if (existing) {
          const record = rowRecord(existing);
          if (
            record.publicToolName !== publicToolName
            || record.sourceId !== sourceId
            || record.sourceToolName !== sourceToolName
            || record.catalogDigest !== catalogDigest
            || record.requestDigest !== sha256Json(request)
            || record.forwardedRequestDigest !== sha256Json(forwardedRequest)
          ) {
            throw new Error("source operation identity is already bound to a different frozen plan");
          }
          return record;
        }
      }
      this.database.prepare(`
        INSERT INTO provider_effect_operations(
          operation_id, public_tool_name, source_id, source_tool_name, catalog_digest,
          request_digest, forwarded_request_digest, forwarded_request_json, plan_digest, plan_json,
          source_operation_id, source_binding_id, readback_json, correction_of,
          state, approval_expires_at, dispatch_attempt, verification_status,
          attention_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, 0, 'not_requested', '[]', ?, ?)
      `).run(
        operationId,
        publicToolName,
        sourceId,
        sourceToolName,
        catalogDigest,
        sha256Json(request),
        sha256Json(forwardedRequest),
        JSON.stringify(forwardedRequest),
        planDigest,
        JSON.stringify(plan),
        sourceOperationId,
        input.sourceBindingId ? identifier(input.sourceBindingId, "source binding id") : null,
        readback ? JSON.stringify(readback) : null,
        input.correctionOf ? identifier(input.correctionOf, "correction operation id") : null,
        expiry,
        now,
        now,
      );
      this.database.prepare(`
        UPDATE provider_effect_operations SET verification_status=? WHERE operation_id=?
      `).run(readback ? "unconfirmed" : "not_requested", operationId);
      return this.get(operationId);
    });
  }

  get(operationIdValue: string): EffectOperationRecord {
    this.assertOpen();
    const operationId = identifier(operationIdValue, "operation id");
    const row = this.database.prepare("SELECT * FROM provider_effect_operations WHERE operation_id=?")
      .get(operationId) as EffectRow | undefined;
    if (!row) throw new Error("provider effect operation does not exist");
    return rowRecord(row);
  }

  list(limitValue = 50): readonly EffectOperationRecord[] {
    this.assertOpen();
    const limit = Math.max(1, Math.min(Math.trunc(limitValue), 200));
    return (this.database.prepare(`
      SELECT * FROM provider_effect_operations ORDER BY created_at DESC, operation_id DESC LIMIT ?
    `).all(limit) as unknown as EffectRow[]).map(rowRecord);
  }

  approve(operationIdValue: string): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    const now = this.instant();
    return this.transaction(() => {
      const current = this.get(operationId);
      if (current.state !== "awaiting_approval") {
        throw new Error(`operation cannot be approved from ${current.state}`);
      }
      if (!current.approvalExpiresAt || current.approvalExpiresAt <= now) {
        this.database.prepare(`
          UPDATE provider_effect_operations
          SET state='cancelled', attention_json=?, updated_at=?, terminal_at=? WHERE operation_id=?
        `).run(JSON.stringify(["approval_expired"]), now, now, operationId);
        return this.get(operationId);
      }
      const grantDigest = sha256Json({
        operationId,
        planDigest: current.planDigest,
        authority: current.plan.authority,
        approvalExpiresAt: current.approvalExpiresAt,
        nonce: randomBytes(32).toString("base64url"),
      });
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state='approved', approval_grant_digest=?, updated_at=? WHERE operation_id=?
      `).run(grantDigest, now, operationId);
      return this.get(operationId);
    });
  }

  cancel(operationIdValue: string): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    const now = this.instant();
    return this.transaction(() => {
      const current = this.get(operationId);
      if (!["awaiting_approval", "approved"].includes(current.state)) {
        throw new Error(`operation cannot be cancelled from ${current.state}`);
      }
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state='cancelled', attention_json=?, updated_at=?, terminal_at=? WHERE operation_id=?
      `).run(JSON.stringify(["cancelled_before_dispatch"]), now, now, operationId);
      return this.get(operationId);
    });
  }

  reserveDispatch(operationIdValue: string, currentAuthorityValue?: EffectAuthoritySnapshot): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    const now = this.instant();
    return this.transaction(() => {
      const current = this.get(operationId);
      if (current.state !== "approved" || !current.approvalGrantDigest) {
        throw new Error(`operation cannot dispatch from ${current.state}`);
      }
      const frozenAuthority = authoritySnapshot(current.plan.authority);
      const currentAuthority = authoritySnapshot(currentAuthorityValue || frozenAuthority);
      if (sha256Json(currentAuthority) !== sha256Json(frozenAuthority)) {
        throw new Error("operation authority changed after approval");
      }
      if (!current.approvalExpiresAt || current.approvalExpiresAt <= now) {
        this.database.prepare(`
          UPDATE provider_effect_operations
          SET state='cancelled', attention_json=?, updated_at=?, terminal_at=? WHERE operation_id=?
        `).run(JSON.stringify(["approval_expired_before_dispatch"]), now, now, operationId);
        return this.get(operationId);
      }
      if (current.dispatchAttempt !== 0) throw new Error("operation already has a dispatch attempt");
      const receipt = `effect:${randomUUID()}`;
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state='dispatching', effect_receipt_id=?, dispatch_attempt=1,
            approval_consumed_at=?, updated_at=? WHERE operation_id=?
      `).run(receipt, now, now, operationId);
      return this.get(operationId);
    });
  }

  settleResponse(operationIdValue: string, input: {
    readonly upstreamResultDigest: string;
    readonly sourceResultState?: string;
    readonly sourceTaskId?: string;
    readonly innerApprovalRequired?: boolean;
  }): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    const now = this.instant();
    return this.transaction(() => {
      const current = this.get(operationId);
      if (current.state !== "dispatching") throw new Error(`operation cannot settle from ${current.state}`);
      const innerApproval = input.innerApprovalRequired === true;
      const state: EffectOperationState = innerApproval ? "awaiting_inner_approval" : "awaiting_verification";
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state=?, upstream_result_digest=?, source_result_state=?, source_task_id=?,
            attention_json=?, updated_at=? WHERE operation_id=?
      `).run(
        state,
        digest(input.upstreamResultDigest, "upstream result digest"),
        input.sourceResultState?.slice(0, 120) || null,
        input.sourceTaskId ? identifier(input.sourceTaskId, "source task id") : null,
        JSON.stringify(innerApproval ? ["inner_approval_required"] : ["fresh_readback_required"]),
        now,
        operationId,
      );
      return this.get(operationId);
    });
  }

  settleInnerApproval(
    operationIdValue: string,
    outcome: "ready_for_readback" | "failed_no_effect" | "effect_unknown",
  ): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    const now = this.instant();
    return this.transaction(() => {
      const current = this.get(operationId);
      if (current.state !== "awaiting_inner_approval") {
        throw new Error(`inner operation cannot settle from ${current.state}`);
      }
      const state: EffectOperationState = outcome === "ready_for_readback"
        ? "awaiting_verification"
        : outcome === "failed_no_effect"
          ? "failed"
          : "applied_or_unknown";
      const attention = outcome === "ready_for_readback"
        ? ["fresh_readback_required"]
        : outcome === "failed_no_effect"
          ? ["inner_operation_failed_without_effect"]
          : ["inner_operation_effect_unknown"];
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state=?, attention_json=?, updated_at=?, terminal_at=? WHERE operation_id=?
      `).run(
        state,
        JSON.stringify(attention),
        now,
        state === "awaiting_verification" ? null : now,
        operationId,
      );
      return this.get(operationId);
    });
  }

  settleFailure(operationIdValue: string, detail: unknown, mayHaveApplied: boolean): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    const now = this.instant();
    return this.transaction(() => {
      const current = this.get(operationId);
      if (current.state !== "dispatching") throw new Error(`operation cannot fail from ${current.state}`);
      const state: EffectOperationState = mayHaveApplied ? "applied_or_unknown" : "failed";
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state=?, attention_json=?, updated_at=?, terminal_at=? WHERE operation_id=?
      `).run(state, JSON.stringify([mayHaveApplied ? "provider_effect_may_have_landed" : "dispatch_failed_before_send", sha256Json(detail)]), now, now, operationId);
      return this.get(operationId);
    });
  }

  recordReadback(operationIdValue: string, readbackDigestValue: string, verified: boolean): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    const now = this.instant();
    return this.transaction(() => {
      const current = this.get(operationId);
      if (!["awaiting_verification", "applied_or_unknown"].includes(current.state)) {
        throw new Error(`operation cannot verify from ${current.state}`);
      }
      const state: EffectOperationState = verified ? "verified" : current.state;
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state=?, readback_digest=?, verification_status=?, attention_json=?,
            updated_at=?, terminal_at=? WHERE operation_id=?
      `).run(
        state,
        digest(readbackDigestValue, "readback digest"),
        verified ? "verified" : "unconfirmed",
        JSON.stringify(verified ? [] : ["readback_did_not_match_frozen_comparator"]),
        now,
        verified ? now : null,
        operationId,
      );
      return this.get(operationId);
    });
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

export function effectOperationProjection(record: EffectOperationRecord): JsonObject {
  const { forwardedRequest: _forwardedRequest, ...projection } = record;
  return structuredClone(projection) as unknown as JsonObject;
}
