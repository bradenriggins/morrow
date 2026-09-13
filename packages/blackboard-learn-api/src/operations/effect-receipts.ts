import { homedir } from "node:os";
import { resolve } from "node:path";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { BLACKBOARD_ID, BlackboardApiError } from "../types.js";
import type { BlackboardEffectGrant } from "../effect-grant.js";
import { blackboardTool, type BlackboardOperationModule } from "./definition.js";
import { readDurableJsonState, replaceDurableState, withDurableStateTransaction } from "./durable-state.js";

const EFFECT_STATE_SCHEMA_V1 = "morrow.blackboard-learn.effects.v1";
const EFFECT_STATE_SCHEMA_V2 = "morrow.blackboard-learn.effects.v2";
const EFFECT_STATE_SCHEMA = "morrow.blackboard-learn.effects.v3";

/** The path that keeps the effect record only in this process, for a test. */
export const BLACKBOARD_EFFECT_STATE_IN_MEMORY = ":memory:";

/**
 * How many spent effect receipts one record file holds. Each reviewed Blackboard
 * change spends one, so this bound is far above ordinary use: it exists to keep a
 * corrupted or tampered file from being read as an unbounded document, and to
 * refuse rather than to drop a record Morrow still needs.
 */
const MAX_EFFECTS = 5_000;
const MAX_STATE_BYTES = 1_048_576;
/**
 * How long a settled record is kept. A settled record proves only that its
 * receipt was spent, and the grant that carries a receipt is signed with a
 * secret that exists for one Gateway process, so a receipt cannot come back
 * after the Gateway that minted it has stopped. An unresolved record is never
 * dropped by age: it is waiting for a person.
 */
const SETTLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RECORD_FULL = "Blackboard effect record is full";
const RECORD_INVALID = "Blackboard effect record is invalid";

/**
 * How far one reviewed Blackboard change got.
 *
 * `reserved`: the receipt is spent and nothing has left this process.
 * `sent`: the change request left this process. Morrow cannot prove what
 * reached Blackboard from here on, so this phase is written before the request.
 * `verified`: a readback proved the reviewed values are saved.
 * `uncertain`: the dispatch failed after the request left this process.
 */
export type BlackboardEffectPhase = "reserved" | "sent" | "verified" | "uncertain";

/** What an explicit fresh read of the exact item found afterwards. */
export type BlackboardEffectFinding = "reviewed_values_saved" | "reviewed_values_not_saved";

/** Provider identities returned by the exact create request that spent one receipt. */
export type BlackboardCreateEvidence =
  | { readonly kind: "ultra-assignment"; readonly contentId: string; readonly gradeColumnId: string }
  | { readonly kind: "course-group"; readonly apiVersion: "v1" | "v2"; readonly groupId: string }
  | { readonly kind: "course-announcement"; readonly announcementId: string };

/** The complete source-owned identity of one effect receipt. */
export interface BlackboardEffectReceiptReference {
  readonly gatewayProcessId: string;
  readonly receiptId: string;
  readonly operationId: string;
}

const PHASES: readonly BlackboardEffectPhase[] = ["reserved", "sent", "verified", "uncertain"];
const FINDINGS: readonly BlackboardEffectFinding[] = ["reviewed_values_saved", "reviewed_values_not_saved"];
/** The phases in which one change still holds the item it was sent to. */
const HOLDING_PHASES: readonly BlackboardEffectPhase[] = ["sent", "uncertain"];

const RECEIPT_ID = /^effect:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GATEWAY_PROCESS_ID = /^[A-Za-z0-9:_-]{8,300}$/;
const OPERATION_ID = /^op:[A-Za-z0-9_-]{1,160}$/;
const TENANT_ID = /^[a-z][a-z0-9-]{0,79}$/;
const TARGET_TYPE = /^[a-z][a-z0-9-]{0,63}$/;
const TARGET_KEY = /^[0-9a-f]{64}$/;

/**
 * The exact Blackboard item or collection one reviewed change was addressed
 * to. Content patches retain their Blackboard content id for compatibility
 * with existing records. Every other change stores a type and a digest of its
 * target identity, so no person or other roster-protected value is written to
 * this record.
 */
export type BlackboardEffectTarget =
  | {
    readonly tenantId: string;
    readonly courseId: string;
    readonly contentId: string;
    readonly targetType?: never;
    readonly targetKey?: never;
  }
  | {
    readonly tenantId: string;
    readonly courseId: string;
    readonly targetType: string;
    readonly targetKey: string;
    readonly contentId?: never;
  };

interface StoredEffect {
  readonly receiptId: string;
  readonly gatewayProcessId: string;
  readonly operationId: string;
  readonly phase: BlackboardEffectPhase;
  readonly target?: BlackboardEffectTarget;
  readonly claimedAt: number;
  readonly updatedAt: number;
  /** The signed grant cannot be presented at or after this epoch millisecond. */
  readonly grantNotAfter?: number;
  /** Set only by an explicit fresh read of the item after the change. */
  readonly finding?: BlackboardEffectFinding;
  readonly checkedAt?: number;
  /** Written immediately after the exact create response names its new object. */
  readonly providerEvidence?: BlackboardCreateEvidence;
}

/**
 * The record of one dispatch, from the receipt it spent to what Morrow could
 * prove afterwards. The dispatch route holds it and reports each phase as it
 * happens, so a run that ends between two phases leaves the earlier one on
 * disk.
 */
export interface BlackboardEffectDispatch {
  /** Written before the change request leaves this process. It refuses when it cannot be written. */
  markSent(): void;
  /** Persists the provider identities returned by this exact create before any readback. */
  recordProviderEvidence(evidence: BlackboardCreateEvidence): void;
  /** Written after a readback proved the reviewed values are saved. */
  markVerified(): void;
  /** Written when the dispatch failed after the request left this process. */
  markUncertain(): void;
}

/**
 * Where the effect record lives: the app-private state directory beside the
 * Blackboard setup file. `MORROW_BLACKBOARD_EFFECT_STATE` moves it, the way
 * `MORROW_BLACKBOARD_CONFIG` moves the setup file.
 */
export function blackboardEffectStatePath(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.MORROW_BLACKBOARD_EFFECT_STATE || `${homedir()}/.morrow/blackboard-effects.json`);
}

function key(gatewayProcessId: string, receiptId: string): string {
  return `${gatewayProcessId}\u0000${receiptId}`;
}

function exactTarget(value: unknown): BlackboardEffectTarget | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value) || typeof value.tenantId !== "string" || !TENANT_ID.test(value.tenantId)
    || typeof value.courseId !== "string" || !BLACKBOARD_ID.test(value.courseId)) {
    throw new TypeError(RECORD_INVALID);
  }
  const legacy = typeof value.contentId === "string" && BLACKBOARD_ID.test(value.contentId)
    && value.targetType === undefined && value.targetKey === undefined;
  if (legacy) return { tenantId: value.tenantId, courseId: value.courseId, contentId: value.contentId as string };
  if (value.contentId === undefined && typeof value.targetType === "string" && TARGET_TYPE.test(value.targetType)
    && typeof value.targetKey === "string" && TARGET_KEY.test(value.targetKey)) {
    return { tenantId: value.tenantId, courseId: value.courseId, targetType: value.targetType, targetKey: value.targetKey };
  }
  throw new TypeError(RECORD_INVALID);
}

function exactTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(RECORD_INVALID);
  return value;
}

function exactCreateEvidence(value: unknown): BlackboardCreateEvidence | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value) || typeof value.kind !== "string") throw new TypeError(RECORD_INVALID);
  const keys = Object.keys(value).sort().join("\0");
  if (value.kind === "ultra-assignment" && keys === "contentId\0gradeColumnId\0kind"
    && typeof value.contentId === "string" && BLACKBOARD_ID.test(value.contentId)
    && typeof value.gradeColumnId === "string" && BLACKBOARD_ID.test(value.gradeColumnId)) {
    return { kind: value.kind, contentId: value.contentId, gradeColumnId: value.gradeColumnId };
  }
  if (value.kind === "course-group" && keys === "apiVersion\0groupId\0kind"
    && (value.apiVersion === "v1" || value.apiVersion === "v2")
    && typeof value.groupId === "string" && BLACKBOARD_ID.test(value.groupId)) {
    return { kind: value.kind, apiVersion: value.apiVersion, groupId: value.groupId };
  }
  if (value.kind === "course-announcement" && keys === "announcementId\0kind"
    && typeof value.announcementId === "string" && BLACKBOARD_ID.test(value.announcementId)) {
    return { kind: value.kind, announcementId: value.announcementId };
  }
  throw new TypeError(RECORD_INVALID);
}

function parseEffects(value: unknown): { readonly revision: number; readonly value: Map<string, StoredEffect> } {
  if (!isJsonObject(value) || ![EFFECT_STATE_SCHEMA, EFFECT_STATE_SCHEMA_V2, EFFECT_STATE_SCHEMA_V1].includes(String(value.schema)) || !Array.isArray(value.effects)
    || value.effects.length > MAX_EFFECTS) {
    throw new TypeError(RECORD_INVALID);
  }
  const revision = value.schema === EFFECT_STATE_SCHEMA_V1
    ? 0
    : exactTime(value.revision);
  const effects = new Map<string, StoredEffect>();
  for (const entry of value.effects) {
    if (!isJsonObject(entry) || typeof entry.receiptId !== "string" || !RECEIPT_ID.test(entry.receiptId)
      || typeof entry.gatewayProcessId !== "string" || !GATEWAY_PROCESS_ID.test(entry.gatewayProcessId)
      || typeof entry.operationId !== "string" || !OPERATION_ID.test(entry.operationId)
      || typeof entry.phase !== "string" || !PHASES.includes(entry.phase as BlackboardEffectPhase)
      || (entry.finding !== undefined
        && (typeof entry.finding !== "string" || !FINDINGS.includes(entry.finding as BlackboardEffectFinding)))) {
      throw new TypeError(RECORD_INVALID);
    }
    const target = exactTarget(entry.target);
    const stored: StoredEffect = {
      receiptId: entry.receiptId,
      gatewayProcessId: entry.gatewayProcessId,
      operationId: entry.operationId,
      phase: entry.phase as BlackboardEffectPhase,
      ...(target ? { target } : {}),
      claimedAt: exactTime(entry.claimedAt),
      updatedAt: exactTime(entry.updatedAt),
      ...(entry.grantNotAfter === undefined ? {} : { grantNotAfter: exactTime(entry.grantNotAfter) }),
      ...(entry.finding !== undefined
        ? { finding: entry.finding as BlackboardEffectFinding, checkedAt: exactTime(entry.checkedAt) }
        : {}),
      ...(entry.providerEvidence === undefined ? {} : { providerEvidence: exactCreateEvidence(entry.providerEvidence)! }),
    };
    const identity = key(stored.gatewayProcessId, stored.receiptId);
    if (effects.has(identity)) throw new TypeError(RECORD_INVALID);
    effects.set(identity, stored);
  }
  return { revision, value: effects };
}

function serializeEffects(revision: number, effects: ReadonlyMap<string, StoredEffect>): string {
  const ordered = [...effects.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([, effect]) => effect);
  return `${JSON.stringify({ schema: EFFECT_STATE_SCHEMA, revision, effects: ordered })}\n`;
}

/** Whether this record is still waiting for a person or for a fresh read. */
function unresolvedEffect(effect: StoredEffect): boolean {
  return HOLDING_PHASES.includes(effect.phase) && effect.finding === undefined;
}

function sameTarget(effect: StoredEffect, target: BlackboardEffectTarget): boolean {
  if (effect.target === undefined
    || effect.target.tenantId !== target.tenantId
    || effect.target.courseId !== target.courseId) return false;
  if ("contentId" in effect.target || "contentId" in target) {
    return "contentId" in effect.target && "contentId" in target
      && effect.target.contentId === target.contentId;
  }
  return effect.target.targetType === target.targetType && effect.target.targetKey === target.targetKey;
}

/**
 * Morrow's own durable record of the Blackboard changes it has already sent.
 *
 * One row for each spent effect receipt, keyed by the Gateway process that
 * minted the grant and the receipt in it. Two things depend on it. A receipt is
 * one-use even if this server restarts under a Gateway that is still running,
 * because the row outlives the process that spent it. And a change that left
 * this process without a confirmed outcome keeps the item it was sent to: the
 * next change to that item is refused until an explicit fresh read of the item
 * says what is saved there now. Morrow never resends a change to resolve one.
 *
 * Every Blackboard dispatch reports each phase here and reports what reached
 * Blackboard in its own result (`resultState`), which is what the Gateway's
 * operation journal records.
 *
 * The record holds Morrow operation ids, Blackboard course ids, legacy content
 * ids, and hashed target identities. It holds no learner, no credential, and no
 * dispatch secret. It is written as one private file and replaced atomically.
 * When it cannot be read or written, Morrow keeps reading Blackboard, which
 * sends no change, and refuses every change instead of spending a receipt it
 * cannot account for.
 */
export class BlackboardEffectReceipts {
  private readonly path: string;
  private readonly now: () => number;
  private memoryEffects = new Map<string, StoredEffect>();
  private memoryRevision = 0;

  constructor(path: string = BLACKBOARD_EFFECT_STATE_IN_MEMORY, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  /** Whether this record survives a restart. */
  get durable(): boolean {
    return this.path !== BLACKBOARD_EFFECT_STATE_IN_MEMORY;
  }

  /**
   * Refuses a receipt this installation already spent, whether it was spent by
   * this run or by an earlier one. The grant itself is checked by the caller;
   * this is the one-use rule.
   */
  assertUnspent(grant: BlackboardEffectGrant): void {
    this.read((effects) => this.requireUnspent(effects, grant));
  }

  /**
   * Refuses a change to an item that an earlier sent change still holds. It is
   * called before an instructor reviews a change and again before a reviewed
   * change is sent, so a person is never asked to approve a change Morrow would
   * then refuse.
   */
  assertTargetFree(target: BlackboardEffectTarget): void {
    this.read((effects) => this.requireTargetFree(effects, target));
  }

  /**
   * Spends one receipt and returns the record of the dispatch it belongs to. A
   * route that names the item it is about to change also takes that item, so an
   * unconfirmed change holds it afterwards.
   */
  claim(grant: BlackboardEffectGrant, target: BlackboardEffectTarget): BlackboardEffectDispatch {
    const identity = key(grant.gatewayProcessId, grant.effectReceiptId);
    this.change((effects) => {
      this.requireUnspent(effects, grant);
      this.requireTargetFree(effects, target);
      const at = this.now();
      effects.set(identity, {
        receiptId: grant.effectReceiptId,
        gatewayProcessId: grant.gatewayProcessId,
        operationId: grant.operationId,
        phase: "reserved",
        target,
        claimedAt: at,
        updatedAt: at,
        grantNotAfter: grant.notAfter,
      });
    });
    return {
      markSent: () => this.advance(identity, "sent"),
      recordProviderEvidence: (evidence) => this.recordProviderEvidence(identity, evidence),
      // A phase Morrow cannot write after the request has left keeps the
      // earlier phase, which is the safe direction: the record stays
      // unresolved and asks a person to look at the item.
      markVerified: () => { try { this.advance(identity, "verified"); } catch { /* recorded as sent */ } },
      markUncertain: () => { try { this.advance(identity, "uncertain"); } catch { /* recorded as sent */ } },
    };
  }

  /**
   * Records what one explicit fresh read of an item found after a change was
   * sent to it. This is the only way an unconfirmed change lets go of its item,
   * and it is a read: Morrow sends no change here and repeats none.
   */
  recordComparison(target: BlackboardEffectTarget, verified: boolean): void {
    this.change((effects) => {
      const held = [...effects.entries()].filter(([, effect]) => unresolvedEffect(effect) && sameTarget(effect, target));
      if (held.length === 0) return false;
      const at = this.now();
      for (const [identity, effect] of held) {
        effects.set(identity, {
          ...effect,
          phase: verified ? "verified" : effect.phase,
          finding: verified ? "reviewed_values_saved" : "reviewed_values_not_saved",
          checkedAt: at,
          updatedAt: at,
        });
      }
      return true;
    });
  }

  /** Reads provider create evidence only through its exact receipt and operation identity. */
  createEvidence(
    reference: BlackboardEffectReceiptReference,
    target: BlackboardEffectTarget,
    kind: BlackboardCreateEvidence["kind"],
  ): BlackboardCreateEvidence | null {
    return this.read((effects) => {
      const effect = effects.get(key(reference.gatewayProcessId, reference.receiptId));
      if (!effect || effect.operationId !== reference.operationId || !sameTarget(effect, target)
        || effect.providerEvidence?.kind !== kind) return null;
      return structuredClone(effect.providerEvidence);
    });
  }

  /** Settles only the exact receipt whose persisted create identity was read. */
  recordCreateComparison(
    reference: BlackboardEffectReceiptReference,
    target: BlackboardEffectTarget,
    kind: BlackboardCreateEvidence["kind"],
    verified: boolean,
  ): void {
    this.change((effects) => {
      const identity = key(reference.gatewayProcessId, reference.receiptId);
      const effect = effects.get(identity);
      if (!effect || effect.operationId !== reference.operationId || !sameTarget(effect, target)
        || effect.providerEvidence?.kind !== kind || !unresolvedEffect(effect)) return false;
      const at = this.now();
      effects.set(identity, {
        ...effect,
        phase: verified ? "verified" : effect.phase,
        finding: verified ? "reviewed_values_saved" : "reviewed_values_not_saved",
        checkedAt: at,
        updatedAt: at,
      });
      return true;
    });
  }

  /**
   * The changes Morrow sent and could not confirm, oldest first. A person reads
   * this to know which Blackboard items to open and check.
   */
  unresolved(): JsonObject {
    return this.read((stored) => {
      const effects = [...stored.values()]
      .filter((effect) => unresolvedEffect(effect))
      .sort((left, right) => left.claimedAt - right.claimedAt)
      .map((effect): JsonObject => ({
        operationId: effect.operationId,
        phase: effect.phase,
        ...(effect.target
          ? {
            tenantId: effect.target.tenantId,
            courseId: effect.target.courseId,
            ...(effect.target.contentId ? { contentId: effect.target.contentId } : { targetType: effect.target.targetType }),
          }
          : {}),
        startedAt: new Date(effect.claimedAt).toISOString(),
        updatedAt: new Date(effect.updatedAt).toISOString(),
      }));
      return {
        schema: "morrow.blackboard.unresolved-effects.v1",
        ok: true,
        effects,
        count: effects.length,
        status: "api_configured_live_untested",
      };
    });
  }

  private advance(identity: string, phase: BlackboardEffectPhase): void {
    this.change((effects) => {
      const effect = effects.get(identity);
      if (!effect) throw new TypeError(RECORD_INVALID);
      const allowed = (effect.phase === "reserved" && phase === "sent")
        || (effect.phase === "sent" && (phase === "verified" || phase === "uncertain"));
      if (!allowed) throw new TypeError(RECORD_INVALID);
      effects.set(identity, { ...effect, phase, updatedAt: this.now() });
    });
  }

  private recordProviderEvidence(identity: string, evidenceValue: BlackboardCreateEvidence): void {
    const evidence = exactCreateEvidence(evidenceValue)!;
    this.change((effects) => {
      const effect = effects.get(identity);
      if (!effect || effect.phase !== "sent" || effect.providerEvidence !== undefined) throw new TypeError(RECORD_INVALID);
      effects.set(identity, { ...effect, providerEvidence: evidence, updatedAt: this.now() });
    });
  }

  private requireUnspent(effects: ReadonlyMap<string, StoredEffect>, grant: BlackboardEffectGrant): void {
    const spent = effects.get(key(grant.gatewayProcessId, grant.effectReceiptId));
    if (!spent) return;
    throw new BlackboardApiError(
      "blackboard_patch_review_required",
      spent.phase === "reserved"
        ? "This Blackboard effect grant was already dispatched."
        : "This Blackboard effect grant was already dispatched, and Morrow sent that change to Blackboard. It sent nothing now.",
    );
  }

  private requireTargetFree(effects: ReadonlyMap<string, StoredEffect>, target: BlackboardEffectTarget): void {
    const holder = [...effects.values()].find((effect) => unresolvedEffect(effect) && sameTarget(effect, target));
    if (!holder) return;
    throw new BlackboardApiError(
      "blackboard_effect_unresolved",
      `Morrow already sent a change to this Blackboard item and could not confirm what reached Blackboard, so it sent nothing now. Return to your assistant and ask Morrow to check that saved request (${holder.operationId}), or open the item in Blackboard and check it yourself. Do not repeat the change.`,
    );
  }

  private currentState(): { readonly revision: number; readonly value: Map<string, StoredEffect> } {
    if (!this.durable) return { revision: this.memoryRevision, value: new Map(this.memoryEffects) };
    return readDurableJsonState(this.path, MAX_STATE_BYTES, parseEffects, () => new Map());
  }

  private read<T>(action: (effects: ReadonlyMap<string, StoredEffect>) => T): T {
    try {
      if (!this.durable) return action(this.memoryEffects);
      return withDurableStateTransaction(this.path, () => action(this.currentState().value), this.now);
    } catch (error) {
      if (error instanceof BlackboardApiError) throw error;
      throw this.unusable(error);
    }
  }

  private change(action: (effects: Map<string, StoredEffect>) => void | boolean): void {
    try {
      const transact = (): void => {
        const state = this.currentState();
        const effects = state.value;
        const changed = action(effects);
        if (changed === false) return;
        const now = this.now();
        for (const [identity, stored] of effects) {
          const expiredAudit = stored.updatedAt + SETTLED_RETENTION_MS <= now;
          const grantExpired = stored.grantNotAfter !== undefined && stored.grantNotAfter <= now;
          if (!unresolvedEffect(stored) && expiredAudit && grantExpired) effects.delete(identity);
        }
        if (effects.size > MAX_EFFECTS) throw new TypeError(RECORD_FULL);
        const revision = state.revision + 1;
        if (!Number.isSafeInteger(revision)) throw new TypeError(RECORD_INVALID);
        if (this.durable) replaceDurableState(this.path, serializeEffects(revision, effects));
        else {
          this.memoryEffects = effects;
          this.memoryRevision = revision;
        }
      };
      if (this.durable) withDurableStateTransaction(this.path, transact, this.now);
      else transact();
    } catch (error) {
      if (error instanceof BlackboardApiError) throw error;
      throw this.unusable(error);
    }
  }

  private unusable(error: unknown): BlackboardApiError {
    const detail = error instanceof Error && error.message === RECORD_FULL
      ? "Its record of the Blackboard changes it has already sent is full."
      : "It could not read or write that record as one exact private file.";
    return new BlackboardApiError(
      "blackboard_effect_record_unavailable",
      `Morrow could not use its own record of the Blackboard changes it has already sent, so it changed nothing in Blackboard. ${detail}`,
    );
  }
}

/**
 * The read a person is shown when a Blackboard change left Morrow without a
 * confirmed outcome. It reads this installation's own record and sends no
 * Blackboard request, so it carries no capability block: it is not a Morrow
 * catalog capability.
 */
export const blackboardEffectReceiptsModule: BlackboardOperationModule = {
  id: "effect-receipts",
  tools: [
    blackboardTool({
      name: "blackboard_unresolved_effects",
      title: "List unconfirmed Blackboard changes",
      description: "List the Blackboard changes Morrow sent and could not confirm. Each one needs a person to open the item in Blackboard and check it. This tool sends no Blackboard request and repeats no change.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      capability: null,
      rest: { method: null, pathTemplate: null, access: "read", entitlement: "none", reviewRoute: null, readbackComparator: null },
      run: async (runtime) => runtime.unresolvedEffects(),
    }),
  ],
};
