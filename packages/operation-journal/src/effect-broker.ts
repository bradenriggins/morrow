import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeRequestedBy, sha256Json, type JsonObject, type RequestedByIdentity } from "@morrow/contracts";

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
  "closed_by_person",
] as const);

export type EffectOperationState = typeof EFFECT_OPERATION_STATES[number];

export const EFFECT_TARGET_IDENTITY_VERSION = "morrow.effect-target.v3";

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
  readonly editPolicyDigest?: string;
  readonly editPolicyRevision?: number;
}

export type EffectAuthorization =
  | { readonly kind: "review" }
  | {
      readonly kind: "edit_scope";
      readonly policyDigest: string;
      readonly policyRevision: number;
    };

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
  readonly authorization?: EffectAuthorization;
  /** The assistant that asked for this operation, as that assistant reported itself. */
  readonly requestedBy?: RequestedByIdentity;
}

export interface EffectOperationRecord {
  readonly schema: "morrow.operation.v1";
  readonly operationId: string;
  readonly publicToolName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly catalogDigest: string;
  readonly targetIdentityDigest: string | null;
  readonly targetIdentityVersion: string | null;
  readonly requestDigest: string;
  readonly forwardedRequestDigest: string;
  readonly forwardedRequest: JsonObject;
  readonly planDigest: string;
  readonly plan: JsonObject;
  readonly sourceOperationId: string | null;
  readonly sourceBindingId: string | null;
  readonly readback: FrozenReadbackPlan | null;
  readonly connectorReadDescriptor: JsonObject | null;
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
  readonly personObservedStateDigest: string | null;
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
  target_identity_digest: string | null;
  target_identity_version: string | null;
  provider_principal_digest: string | null;
  request_digest: string;
  forwarded_request_digest: string;
  forwarded_request_json: string;
  plan_digest: string;
  plan_json: string;
  source_operation_id: string | null;
  source_binding_id: string | null;
  readback_json: string | null;
  connector_read_descriptor_json: string | null;
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
  person_observed_state_digest: string | null;
  verification_status: "not_requested" | "unconfirmed" | "verified" | null;
  attention_json: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,160}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TERMINAL = new Set<EffectOperationState>([
  "verified", "failed", "applied_or_unknown", "cancelled", "closed_by_person",
]);

/**
 * The states in which one sent provider effect still holds its target. A record
 * leaves this set only through a verified readback, a settled failure, or a
 * person-confirmed close-out.
 */
const TARGET_HOLDING_STATES = "'dispatching','awaiting_inner_approval','awaiting_verification','applied_or_unknown'";

/**
 * The states from which a record is still unresolved and can be checked again or
 * closed by a person.
 */
const UNRESOLVED_STATES: readonly EffectOperationState[] = ["awaiting_verification", "applied_or_unknown"];

export class ProviderEffectTargetConflictError extends Error {
  readonly code = "provider_effect_target_conflict";
  /** The unresolved operation that holds the target. The person needs its id to resolve it. */
  readonly operationId: string;

  constructor(operationId: string) {
    super(`A prior provider effect for this exact target is still unresolved (${operationId}). Morrow will not send an overlapping change.`);
    this.name = "ProviderEffectTargetConflictError";
    this.operationId = operationId;
  }
}

export class ProviderEffectTargetScopeUnknownError extends Error {
  readonly code = "provider_effect_target_scope_unknown";
  /** The dispatched record whose target scope is unknown. The person needs its id to resolve it. */
  readonly operationId: string;

  constructor(operationId: string) {
    super(`An earlier dispatched provider effect (${operationId}) predates the current target identity and needs checking before Morrow can send another connector change.`);
    this.name = "ProviderEffectTargetScopeUnknownError";
    this.operationId = operationId;
  }
}

export class ProviderEffectTargetIdentityVersionError extends Error {
  readonly code = "provider_effect_target_identity_replan_required";

  constructor() {
    super("This saved connector plan predates the current target identity and must be prepared again before Morrow can send it.");
    this.name = "ProviderEffectTargetIdentityVersionError";
  }
}

export interface DispatchReservationOptions {
  readonly enforceHistoricalTargetScopeBarrier?: boolean;
}

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
  const editPolicyDigest = object.editPolicyDigest === undefined
    ? undefined
    : digest(object.editPolicyDigest, "authority edit policy digest");
  const editPolicyRevision = object.editPolicyRevision === undefined
    ? undefined
    : object.editPolicyRevision;
  if (editPolicyDigest === undefined && editPolicyRevision !== undefined) {
    throw new TypeError("authority edit policy revision requires an edit policy digest");
  }
  if (editPolicyDigest !== undefined && (!Number.isSafeInteger(editPolicyRevision) || Number(editPolicyRevision) < 1)) {
    throw new TypeError("authority edit policy revision must be a positive safe integer");
  }
  return {
    profileDigest: String(object.profileDigest),
    actorDigest: String(object.actorDigest),
    providerPrincipalDigest: String(object.providerPrincipalDigest),
    connectionGeneration: Number(connectionGeneration),
    catalogDigest: String(object.catalogDigest),
    approvalClass,
    targetSetDigest: String(object.targetSetDigest),
    ...(editPolicyDigest ? { editPolicyDigest } : {}),
    ...(editPolicyDigest ? { editPolicyRevision: Number(editPolicyRevision) } : {}),
  };
}

function effectAuthorization(value: unknown): EffectAuthorization {
  if (value === undefined) return { kind: "review" };
  const object = jsonObject(value, "effect authorization");
  if (object.kind === "review") return { kind: "review" };
  if (object.kind !== "edit_scope") throw new TypeError("effect authorization kind is invalid");
  const policyDigest = digest(object.policyDigest, "effect authorization policy digest");
  if (!Number.isSafeInteger(object.policyRevision) || Number(object.policyRevision) < 1) {
    throw new TypeError("effect authorization policy revision must be a positive safe integer");
  }
  return { kind: "edit_scope", policyDigest, policyRevision: Number(object.policyRevision) };
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
    targetIdentityDigest: row.target_identity_digest,
    targetIdentityVersion: row.target_identity_version,
    requestDigest: row.request_digest,
    forwardedRequestDigest: row.forwarded_request_digest,
    forwardedRequest: parseJsonObject(row.forwarded_request_json, "forwarded request"),
    planDigest: row.plan_digest,
    plan: parseJsonObject(row.plan_json, "plan"),
    sourceOperationId: row.source_operation_id,
    sourceBindingId: row.source_binding_id,
    readback: parseReadback(row.readback_json),
    connectorReadDescriptor: row.connector_read_descriptor_json
      ? parseJsonObject(row.connector_read_descriptor_json, "connector read descriptor")
      : null,
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
    personObservedStateDigest: row.person_observed_state_digest,
    verificationStatus: row.verification_status,
    attention: Array.isArray(attention) ? attention.filter((entry): entry is string => typeof entry === "string") : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

/**
 * One definition of the operation table. The constructor creates it and the
 * state-constraint migration rebuilds an older table from it, so the CHECK list
 * and the column list can never drift apart.
 */
const EFFECT_OPERATION_COLUMNS = Object.freeze([
  "operation_id", "public_tool_name", "source_id", "source_tool_name", "catalog_digest",
  "target_identity_digest", "target_identity_version", "provider_principal_digest",
  "request_digest", "forwarded_request_digest", "forwarded_request_json", "plan_digest", "plan_json",
  "source_operation_id", "source_binding_id", "readback_json", "connector_read_descriptor_json",
  "correction_of", "state", "approval_grant_digest", "approval_expires_at", "approval_consumed_at",
  "effect_receipt_id", "dispatch_attempt", "upstream_result_digest", "source_result_state",
  "source_task_id", "readback_digest", "person_observed_state_digest", "verification_status",
  "attention_json", "created_at", "updated_at", "terminal_at",
] as const);

interface EffectOperationsTableOptions {
  readonly ifNotExists?: boolean;
  /**
   * Keeps the three columns that older databases added with ALTER TABLE
   * nullable. Rows written before those columns hold NULL, and the
   * historical-target-scope barrier depends on that NULL staying exactly as it
   * is, so a rebuilt legacy table must not tighten them.
   */
  readonly legacyNullableIdentity?: boolean;
}

function effectOperationsTableDdl(name: string, options: EffectOperationsTableOptions = {}): string {
  const identity = options.legacyNullableIdentity ? "TEXT" : "TEXT NOT NULL";
  return `CREATE TABLE ${options.ifNotExists ? "IF NOT EXISTS " : ""}${name} (
        operation_id TEXT PRIMARY KEY,
        public_tool_name TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_tool_name TEXT NOT NULL,
        catalog_digest TEXT NOT NULL,
        target_identity_digest ${identity},
        target_identity_version ${identity},
        provider_principal_digest ${identity},
        request_digest TEXT NOT NULL,
        forwarded_request_digest TEXT NOT NULL,
        forwarded_request_json TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        source_operation_id TEXT,
        source_binding_id TEXT,
        readback_json TEXT,
        connector_read_descriptor_json TEXT,
        correction_of TEXT,
        state TEXT NOT NULL CHECK(state IN (${EFFECT_OPERATION_STATES.map((state) => `'${state}'`).join(",")})),
        approval_grant_digest TEXT,
        approval_expires_at TEXT,
        approval_consumed_at TEXT,
        effect_receipt_id TEXT,
        dispatch_attempt INTEGER NOT NULL CHECK(dispatch_attempt >= 0 AND dispatch_attempt <= 1),
        upstream_result_digest TEXT,
        source_result_state TEXT,
        source_task_id TEXT,
        readback_digest TEXT,
        person_observed_state_digest TEXT,
        verification_status TEXT CHECK(verification_status IN ('not_requested','unconfirmed','verified')),
        attention_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT
      ) STRICT;`;
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
      ${effectOperationsTableDdl("provider_effect_operations", { ifNotExists: true })}
      CREATE INDEX IF NOT EXISTS provider_effect_operations_recent
        ON provider_effect_operations(created_at DESC, operation_id DESC);
      CREATE INDEX IF NOT EXISTS provider_effect_operations_state
        ON provider_effect_operations(state, updated_at DESC);
    `);
    this.ensureTargetIdentityColumns();
    this.ensureOperationStateConstraint();
    this.database.exec(`
      DROP INDEX IF EXISTS provider_effect_operations_target_state;
      CREATE INDEX IF NOT EXISTS provider_effect_operations_target_state
        ON provider_effect_operations(target_identity_digest, state);
      CREATE INDEX IF NOT EXISTS provider_effect_operations_historical_target_scope
        ON provider_effect_operations(target_identity_version, dispatch_attempt, state);
    `);
    this.recoverInterrupted();
  }

  private ensureTargetIdentityColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(provider_effect_operations)")
      .all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("target_identity_digest")) {
      this.database.exec("ALTER TABLE provider_effect_operations ADD COLUMN target_identity_digest TEXT");
    }
    if (!names.has("target_identity_version")) {
      // Historical rows must stay unversioned. Their raw provider scope was not
      // retained, so a v3 target identity cannot be reconstructed safely.
      this.database.exec("ALTER TABLE provider_effect_operations ADD COLUMN target_identity_version TEXT");
    }
    if (!names.has("provider_principal_digest")) {
      this.database.exec("ALTER TABLE provider_effect_operations ADD COLUMN provider_principal_digest TEXT");
    }
    if (!names.has("connector_read_descriptor_json")) {
      // A record written before this column has no retained read comparator. It
      // stays unresolved; nothing is reconstructed for it.
      this.database.exec("ALTER TABLE provider_effect_operations ADD COLUMN connector_read_descriptor_json TEXT");
    }
    if (!names.has("person_observed_state_digest")) {
      this.database.exec("ALTER TABLE provider_effect_operations ADD COLUMN person_observed_state_digest TEXT");
    }
    const legacy = this.database.prepare(`
      SELECT operation_id, plan_json FROM provider_effect_operations
      WHERE provider_principal_digest IS NULL
    `).all() as { operation_id: string; plan_json: string }[];
    const update = this.database.prepare(`
      UPDATE provider_effect_operations SET provider_principal_digest=? WHERE operation_id=?
    `);
    for (const row of legacy) {
      try {
        const plan = parseJsonObject(row.plan_json, "legacy plan");
        const authority = authoritySnapshot(plan.authority);
        update.run(authority.providerPrincipalDigest, row.operation_id);
      } catch {
        // A legacy record without an intact authority remains conservatively unresolved.
      }
    }
  }

  /**
   * SQLite keeps a CHECK constraint inside the table definition, so a database
   * written before closed_by_person existed would refuse the new state. The
   * table is rebuilt once from the single definition above. Every row is copied
   * column for column, so an existing record keeps its state, its receipts and
   * its attention; the only change is that one more state is now allowed.
   */
  private ensureOperationStateConstraint(): void {
    const table = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_effect_operations'
    `).get() as { sql: string } | undefined;
    if (!table || table.sql.includes("'closed_by_person'")) return;
    const columns = EFFECT_OPERATION_COLUMNS.join(", ");
    this.transaction(() => {
      this.database.exec(effectOperationsTableDdl("provider_effect_operations_next", { legacyNullableIdentity: true }));
      this.database.exec(`
        INSERT INTO provider_effect_operations_next(${columns})
        SELECT ${columns} FROM provider_effect_operations;
        DROP TABLE provider_effect_operations;
        ALTER TABLE provider_effect_operations_next RENAME TO provider_effect_operations;
        CREATE INDEX IF NOT EXISTS provider_effect_operations_recent
          ON provider_effect_operations(created_at DESC, operation_id DESC);
        CREATE INDEX IF NOT EXISTS provider_effect_operations_state
          ON provider_effect_operations(state, updated_at DESC);
      `);
    });
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
    const authorization = effectAuthorization(input.authorization);
    if (authority.catalogDigest !== catalogDigest) throw new Error("authority catalog digest does not match the operation catalog");
    if (authorization.kind === "edit_scope" && (
      authority.editPolicyDigest !== authorization.policyDigest
      || authority.editPolicyRevision !== authorization.policyRevision
    )) {
      throw new Error("edit authorization does not match the frozen authority");
    }
    const sourceOperationId = input.sourceOperationId
      ? identifier(input.sourceOperationId, "source operation id")
      : null;
    // A plan field, not an authority field: naming the requester must not move
    // the frozen authority digest or the target-conflict identity.
    const requestedBy = normalizeRequestedBy(input.requestedBy);
    const plan: JsonObject = {
      schema: "morrow.plan.v1",
      tool: publicToolName,
      source: sourceId,
      sourceTool: sourceToolName,
      catalogDigest,
      authority,
      authorization,
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
      ...(requestedBy ? { requestedBy } : {}),
    };
    const operationId = `op:${randomUUID()}`;
    const planDigest = sha256Json(plan);
    const approvalGrantDigest = authorization.kind === "edit_scope"
      ? sha256Json({
          operationId,
          planDigest,
          authority,
          authorization,
          approvalExpiresAt: expiry,
          nonce: randomBytes(32).toString("base64url"),
        })
      : null;
    const initialState: EffectOperationState = authorization.kind === "edit_scope" ? "approved" : "awaiting_approval";
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
          target_identity_digest, target_identity_version, provider_principal_digest,
          request_digest, forwarded_request_digest, forwarded_request_json, plan_digest, plan_json,
          source_operation_id, source_binding_id, readback_json, correction_of,
          state, approval_grant_digest, approval_expires_at, dispatch_attempt, verification_status,
          attention_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'not_requested', '[]', ?, ?)
      `).run(
        operationId,
        publicToolName,
        sourceId,
        sourceToolName,
        catalogDigest,
        authority.targetSetDigest,
        EFFECT_TARGET_IDENTITY_VERSION,
        authority.providerPrincipalDigest,
        sha256Json(request),
        sha256Json(forwardedRequest),
        JSON.stringify(forwardedRequest),
        planDigest,
        JSON.stringify(plan),
        sourceOperationId,
        input.sourceBindingId ? identifier(input.sourceBindingId, "source binding id") : null,
        readback ? JSON.stringify(readback) : null,
        input.correctionOf ? identifier(input.correctionOf, "correction operation id") : null,
        initialState,
        approvalGrantDigest,
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

  hasActiveOperations(): boolean {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT 1 FROM provider_effect_operations
      WHERE state='dispatching' LIMIT 1
    `).get();
    return row !== undefined;
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

  recordTargetConflict(
    operationIdValue: string,
    reason: "provider_effect_target_conflict" | "provider_effect_target_scope_unknown" = "provider_effect_target_conflict",
  ): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    return this.transaction(() => {
      const current = this.get(operationId);
      if (current.state !== "approved" || current.dispatchAttempt !== 0 || current.attention.includes(reason)) return current;
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET attention_json=?, updated_at=? WHERE operation_id=?
      `).run(JSON.stringify([...current.attention, reason]), this.instant(), operationId);
      return this.get(operationId);
    });
  }

  reserveDispatch(
    operationIdValue: string,
    currentAuthorityValue?: EffectAuthoritySnapshot,
    options: DispatchReservationOptions = {},
  ): EffectOperationRecord {
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
      if (options.enforceHistoricalTargetScopeBarrier && current.targetIdentityVersion !== EFFECT_TARGET_IDENTITY_VERSION) {
        throw new ProviderEffectTargetIdentityVersionError();
      }
      if (options.enforceHistoricalTargetScopeBarrier && current.targetIdentityVersion === EFFECT_TARGET_IDENTITY_VERSION) {
        const unknownHistoricalScope = this.database.prepare(`
          SELECT operation_id FROM provider_effect_operations
          WHERE operation_id<>?
            AND dispatch_attempt>0
            AND state IN (${TARGET_HOLDING_STATES})
            AND (target_identity_version IS NULL OR target_identity_version<>?)
          LIMIT 1
        `).get(operationId, EFFECT_TARGET_IDENTITY_VERSION) as { operation_id: string } | undefined;
        if (unknownHistoricalScope) throw new ProviderEffectTargetScopeUnknownError(unknownHistoricalScope.operation_id);
      }
      const conflict = this.database.prepare(`
        SELECT operation_id FROM provider_effect_operations
        WHERE operation_id<>?
          AND target_identity_digest=?
          AND state IN (${TARGET_HOLDING_STATES})
        LIMIT 1
      `).get(
        operationId,
        frozenAuthority.targetSetDigest,
      ) as { operation_id: string } | undefined;
      if (conflict) throw new ProviderEffectTargetConflictError(conflict.operation_id);
      if (current.dispatchAttempt !== 0) throw new Error("operation already has a dispatch attempt");
      const receipt = `effect:${randomUUID()}`;
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state='dispatching', effect_receipt_id=?, dispatch_attempt=1,
            approval_consumed_at=?, attention_json='[]', updated_at=? WHERE operation_id=?
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

  /**
   * Keeps the connector's read-only comparator with the operation record after
   * the write was sent. It is written once, never replaces an existing one, and
   * only for a record that has actually dispatched, so a later check reads the
   * route the connector itself chose at the time of the change.
   */
  recordConnectorReadDescriptor(operationIdValue: string, descriptorValue: unknown): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    const descriptor = jsonObject(descriptorValue, "connector read descriptor");
    return this.transaction(() => {
      const current = this.get(operationId);
      if (current.connectorReadDescriptor || current.dispatchAttempt < 1) return current;
      if (!UNRESOLVED_STATES.includes(current.state)) return current;
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET connector_read_descriptor_json=?, updated_at=? WHERE operation_id=?
      `).run(JSON.stringify(descriptor), this.instant(), operationId);
      return this.get(operationId);
    });
  }

  /**
   * Closes one unresolved record because a person checked the saved state
   * themselves. Morrow proves nothing here: the record keeps its unconfirmed
   * verification status and retains the digest of the read the person looked at,
   * so the ending is always readable as "a person checked this", never as
   * "Morrow confirmed this". It sends nothing, and it is the only exit from an
   * unresolved record that does not carry Morrow's own fresh evidence.
   */
  closeAfterPersonCheck(operationIdValue: string, observedStateDigestValue: string): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    const observedStateDigest = digest(observedStateDigestValue, "observed state digest");
    const now = this.instant();
    return this.transaction(() => {
      const current = this.get(operationId);
      if (!UNRESOLVED_STATES.includes(current.state)) {
        throw new Error(`operation cannot be closed by a person from ${current.state}`);
      }
      this.database.prepare(`
        UPDATE provider_effect_operations
        SET state='closed_by_person', person_observed_state_digest=?, attention_json=?,
            updated_at=?, terminal_at=? WHERE operation_id=?
      `).run(
        observedStateDigest,
        JSON.stringify(["closed_after_person_checked_saved_state"]),
        now,
        now,
        operationId,
      );
      return this.get(operationId);
    });
  }

  recordReadback(operationIdValue: string, readbackDigestValue: string, verified: boolean): EffectOperationRecord {
    const operationId = identifier(operationIdValue, "operation id");
    const now = this.instant();
    return this.transaction(() => {
      const current = this.get(operationId);
      if (!UNRESOLVED_STATES.includes(current.state)) {
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
  const requestedBy = normalizeRequestedBy(record.plan.requestedBy);
  return structuredClone({
    ...projection,
    ...(requestedBy ? { requestedBy } : {}),
  }) as unknown as JsonObject;
}
