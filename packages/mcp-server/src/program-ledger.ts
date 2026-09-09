import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { BATCH_CHILD_STATES, MAX_BATCH_CHILDREN } from "@morrow/batch-engine";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { EFFECT_OPERATION_STATES } from "@morrow/operation-journal";
import * as z from "zod/v4";
import { auditChildTargetKey } from "./course-inventory.js";
import { resolveResultArtifact, type ResultArtifactPage } from "./result-artifacts.js";
import type { GatewayRuntime } from "./runtime.js";

/** Exactly one of these is assigned to every discovered inventory target. */
export const PROGRAM_LEDGER_FINAL_STATES = Object.freeze([
  "repaired_and_verified",
  "manually_checked",
  "not_applicable_with_evidence",
  "unread",
  "blocked",
  "held",
  "evidence_ready_pending_review",
] as const);

export type ProgramLedgerFinalState = typeof PROGRAM_LEDGER_FINAL_STATES[number];

const SIGNAL_FIELDS = ["image_tags_without_alt", "heading_level_jumps", "tables_without_th", "embedded_media_tags"] as const;
const MAX_SIGNAL_WALK_DEPTH = 12;
const MAX_SIGNAL_WALK_NODES = 20_000;
const REASON_CODE = /^[a-z][a-z0-9_]{2,80}$/;

export const PROGRAM_LEDGER_GUIDANCE = `# Program accessibility ledger

\`morrow_program_ledger\` states one final state for every target a selected-program inventory discovered. It reads nothing. It derives each state from a saved \`morrow.course-inventory.v1\` report, the audit results for that inventory's audit children, and any repair operation records the caller supplies.

## Final states

- \`repaired_and_verified\`: the repair operation record is verified and its re-audit returned complete evidence with no remaining source signal.
- \`manually_checked\`: a person recorded their own manual check of this target. It is that person's statement, not Morrow evidence.
- \`not_applicable_with_evidence\`: the target was read and the HTML source-signal checks do not apply to it, for example a plain-text file.
- \`unread\`: Morrow did not read this target's content. An incomplete source list, an absent audit result, and a body over the complete-evidence limit all land here.
- \`blocked\`: the target has an explicit block reason, an audit failure code, an unavailable provider, or an unresolved provider effect.
- \`held\`: the target has a source signal and its remediation route is held.
- \`evidence_ready_pending_review\`: evidence exists and a person must review it. A read with no source signal lands here. It is never a pass.

## Derivation order

Each target takes the first rule that matches.

1. A repair whose operation is \`applied_or_unknown\` becomes \`blocked\` with \`unresolved_provider_effect\`. Morrow does not repeat that write.
2. A repair whose operation and verification are both \`verified\`, with a re-audit that returns \`evidence_ready\` and zero source signals, becomes \`repaired_and_verified\`. Any other repair becomes \`evidence_ready_pending_review\` with the reason that says which part is missing.
3. A recorded manual check becomes \`manually_checked\`. It never replaces rule 1.
4. An inventory target with \`batch_eligibility: "blocked"\` becomes \`unread\` with its source list's coverage-gap code and reason.
5. A missing, pending, or cancelled audit result becomes \`unread\`. A failed or uncertain audit result becomes \`blocked\` with its structured failure code.
6. An audit with \`status: "blocked"\` becomes \`blocked\` with its \`block_reason\`. An unavailable provider becomes \`blocked\`.
7. An audit whose content was not observed becomes \`unread\` with the content reason code.
8. An audit with at least one source signal becomes \`held\` when its remediation route is held, and \`evidence_ready_pending_review\` otherwise.
9. An audit with \`status: "evidence_ready"\` and zero source signals becomes \`evidence_ready_pending_review\`, never a pass.

## Refusals

The ledger refuses when any inventory course has \`status: "course_refused"\`, and when the inventory and the supplied child set disagree on target identity: an unknown child, a duplicate child, a supplied identity that does not match the inventory audit child, or an audit report bound to a different course or target kind.

## Limits

Every state here comes from local audit and operation records. The ledger proves no live course result. Four source signals do not establish WCAG conformance, and the ledger's \`conformance_claim\` is fixed to \`none\`. Unread, blocked, held, and pending-review targets are not passed targets, and a target with no source signal is not a passed target. Captions, transcripts, keyboard behavior, focus order, contrast, equations, file bytes, learner rendering, and external-tool accessibility stay manual review.`;

const LEDGER_LIMITS = Object.freeze([
  "Every final state here is derived from local audit and operation records. This ledger proves no live course result; it is live-unverified.",
  "The four saved-source signals do not establish WCAG conformance. This ledger makes no accessibility conformance claim.",
  "Unread, blocked, held, and pending-review targets are not passed targets. A target with no source signal is not a passed target.",
  "A recorded manual check is the person's own statement about work done outside Morrow. It is not Morrow evidence.",
  "Captions, transcripts, keyboard behavior, focus order, contrast, equations, file bytes, learner rendering, and external-tool accessibility remain manual review.",
]);

const jsonObject = z.record(z.string(), z.unknown());
const identifier = z.string().min(1).max(160);

const repairSchema = z.strictObject({
  operation_id: identifier,
  operation_state: z.enum(EFFECT_OPERATION_STATES),
  verification_status: z.enum(["not_requested", "unconfirmed", "verified"]).optional(),
  re_audit: jsonObject.optional(),
});

const auditChildResultSchema = z.strictObject({
  child_id: identifier,
  state: z.enum(BATCH_CHILD_STATES),
  course_id: identifier.optional(),
  source_binding_id: identifier.optional(),
  target: jsonObject.optional(),
  report: jsonObject.optional(),
  repair: repairSchema.optional(),
});

const manualCheckSchema = z.strictObject({
  course_id: identifier,
  source_binding_id: identifier,
  target: jsonObject,
  checked_at: z.string().datetime(),
  note: z.string().min(1).max(500),
});

export const programLedgerInputSchema = z.strictObject({
  inventory: jsonObject,
  audit_children: z.array(auditChildResultSchema).max(MAX_BATCH_CHILDREN).default([]),
  manual_checks: z.array(manualCheckSchema).max(MAX_BATCH_CHILDREN).default([]),
});

export type ProgramLedgerInput = z.infer<typeof programLedgerInputSchema>;
export type ProgramLedgerAuditChildResult = z.infer<typeof auditChildResultSchema>;
export type ProgramLedgerManualCheck = z.infer<typeof manualCheckSchema>;

type ProgramLedgerErrorCode =
  | "inventory_report_unavailable"
  | "course_refused"
  | "target_identity_disagreement";

export class ProgramLedgerError extends Error {
  readonly code: ProgramLedgerErrorCode;

  constructor(message: string, code: ProgramLedgerErrorCode) {
    super(message);
    this.code = code;
  }
}

interface InventoryTarget {
  readonly courseId: string;
  readonly sourceBindingId: string;
  readonly sourceList: string;
  readonly target: JsonObject;
  readonly eligible: boolean;
  readonly key: string;
  readonly coverageGap?: JsonObject;
}

interface SignalCounts {
  readonly total: number;
  readonly counts: JsonObject;
  readonly observed: boolean;
  readonly notApplicable: boolean;
}

interface DerivedState {
  readonly finalState: ProgramLedgerFinalState;
  readonly reason: string;
  readonly detail: string;
  readonly evidence: JsonObject;
}

interface InventoryAuditChild {
  readonly key: string;
  readonly courseId: string;
  readonly kind: unknown;
}

function targetKey(courseId: string, sourceBindingId: string, target: JsonObject): string {
  return auditChildTargetKey({ courseId, sourceBindingId, arguments: { target } });
}

function reasonCode(value: unknown, fallback: string): string {
  return typeof value === "string" && REASON_CODE.test(value) ? value : fallback;
}

function sentence(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_000 ? value : fallback;
}

/**
 * Count the four saved-source signals anywhere in one audit record. Nested
 * assessment fields carry their own signal block, so a top-level-only count
 * could call a target signal-free while a nested answer still has one.
 */
function collectSignals(report: JsonObject): SignalCounts {
  const counts: Record<string, number> = { image_tags_without_alt: 0, heading_level_jumps: 0, tables_without_th: 0, embedded_media_tags: 0 };
  let observed = false;
  let notApplicable = false;
  let visited = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_SIGNAL_WALK_DEPTH || visited > MAX_SIGNAL_WALK_NODES) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isJsonObject(value)) return;
    const signals = value.observed_source_signals;
    if (isJsonObject(signals)) {
      if (signals.status === "not_applicable") notApplicable = true;
      for (const field of SIGNAL_FIELDS) {
        const list = signals[field];
        if (Array.isArray(list)) {
          counts[field] = (counts[field] ?? 0) + list.length;
          observed = true;
        }
      }
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  };
  visit(report, 0);
  return {
    total: SIGNAL_FIELDS.reduce((total, field) => total + (counts[field] ?? 0), 0),
    counts: { ...counts },
    observed,
    notApplicable,
  };
}

function auditRecord(value: unknown): JsonObject | undefined {
  return isJsonObject(value) && value.schema === "morrow.course-audit.v1" ? value : undefined;
}

function problemRecord(value: unknown): JsonObject | undefined {
  return isJsonObject(value) && value.schema === "morrow.problem.v1" ? value : undefined;
}

function contentDigest(report: JsonObject | undefined): string | undefined {
  const content = report && isJsonObject(report.content_evidence) ? report.content_evidence : undefined;
  const digest = content?.sha256;
  return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

function remediationHeld(report: JsonObject | undefined): JsonObject | undefined {
  const remediation = report && isJsonObject(report.remediation) ? report.remediation : undefined;
  return typeof remediation?.status === "string" && remediation.status.endsWith("_held") ? remediation : undefined;
}

function inventoryCourses(report: JsonObject): JsonObject[] {
  if (report.schema !== "morrow.course-inventory.v1" || !Array.isArray(report.courses)) {
    throw new ProgramLedgerError("The supplied report is not a selected-program inventory.", "inventory_report_unavailable");
  }
  return report.courses.map((course) => {
    if (!isJsonObject(course) || typeof course.course_id !== "string" || typeof course.source_binding_id !== "string"
      || !Array.isArray(course.targets)) {
      throw new ProgramLedgerError("A selected-program inventory course record is invalid.", "inventory_report_unavailable");
    }
    if (course.status === "course_refused") {
      throw new ProgramLedgerError("One selected course was refused during inventory. Morrow will not build a program ledger over a refused course.", "course_refused");
    }
    return course;
  });
}

function courseCoverageGap(course: JsonObject, sourceList: string): JsonObject | undefined {
  if (!Array.isArray(course.coverage_gaps)) return undefined;
  const gap = course.coverage_gaps.find((candidate) => isJsonObject(candidate) && candidate.list === sourceList && candidate.blocking === true);
  return isJsonObject(gap) ? gap : undefined;
}

function inventoryTargets(courses: readonly JsonObject[]): InventoryTarget[] {
  const targets: InventoryTarget[] = [];
  const seen = new Set<string>();
  for (const course of courses) {
    for (const candidate of course.targets as unknown[]) {
      if (!isJsonObject(candidate) || !isJsonObject(candidate.target) || typeof candidate.course_id !== "string"
        || typeof candidate.source_binding_id !== "string" || typeof candidate.source_list !== "string") {
        throw new ProgramLedgerError("A selected-program inventory target record is invalid.", "inventory_report_unavailable");
      }
      const key = targetKey(candidate.course_id, candidate.source_binding_id, candidate.target);
      if (seen.has(key)) {
        throw new ProgramLedgerError("The selected-program inventory lists one target twice.", "target_identity_disagreement");
      }
      seen.add(key);
      const eligible = candidate.batch_eligibility === "eligible";
      const gap = eligible ? undefined : courseCoverageGap(course, candidate.source_list);
      targets.push({
        courseId: candidate.course_id,
        sourceBindingId: candidate.source_binding_id,
        sourceList: candidate.source_list,
        target: candidate.target,
        eligible,
        key,
        ...(gap ? { coverageGap: gap } : {}),
      });
    }
  }
  return targets;
}

function inventoryAuditChildren(report: JsonObject): Map<string, InventoryAuditChild> {
  if (!Array.isArray(report.audit_children)) {
    throw new ProgramLedgerError("The selected-program inventory has no audit child collection.", "inventory_report_unavailable");
  }
  const children = new Map<string, InventoryAuditChild>();
  for (const candidate of report.audit_children) {
    if (!isJsonObject(candidate) || typeof candidate.childId !== "string" || candidate.tool !== "morrow_audit_course") {
      throw new ProgramLedgerError("A selected-program inventory audit child is invalid.", "inventory_report_unavailable");
    }
    const argumentsValue = isJsonObject(candidate.arguments) ? candidate.arguments : {};
    const target = isJsonObject(argumentsValue.target) ? argumentsValue.target : {};
    children.set(candidate.childId, {
      key: auditChildTargetKey(candidate),
      courseId: String(candidate.courseId),
      kind: target.kind,
    });
  }
  return children;
}

/**
 * Bind one supplied batch result to one inventory target. Every disagreement
 * here means the caller paired results from a different inventory, so the
 * ledger refuses rather than stating a state for the wrong target.
 */
function bindAuditChildren(
  report: JsonObject,
  targetsByKey: ReadonlyMap<string, InventoryTarget>,
  children: readonly ProgramLedgerAuditChildResult[],
): Map<string, ProgramLedgerAuditChildResult> {
  const inventoryChildren = inventoryAuditChildren(report);
  const bound = new Map<string, ProgramLedgerAuditChildResult>();
  for (const child of children) {
    const declared = inventoryChildren.get(child.child_id);
    if (!declared) {
      throw new ProgramLedgerError("A supplied audit result names a child this inventory did not create.", "target_identity_disagreement");
    }
    if (child.course_id !== undefined || child.source_binding_id !== undefined || child.target !== undefined) {
      if (child.course_id === undefined || child.source_binding_id === undefined || child.target === undefined) {
        throw new ProgramLedgerError("A supplied audit result carries a partial target identity.", "target_identity_disagreement");
      }
      if (targetKey(child.course_id, child.source_binding_id, child.target) !== declared.key) {
        throw new ProgramLedgerError("A supplied audit result does not match its inventory target identity.", "target_identity_disagreement");
      }
    }
    if (!targetsByKey.has(declared.key)) {
      throw new ProgramLedgerError("A supplied audit result names a target this inventory did not discover.", "target_identity_disagreement");
    }
    if (bound.has(declared.key)) {
      throw new ProgramLedgerError("Two supplied audit results name the same inventory target.", "target_identity_disagreement");
    }
    const audit = auditRecord(child.report);
    if (audit) {
      const course = isJsonObject(audit.course) ? audit.course : {};
      const auditTarget = isJsonObject(audit.target) ? audit.target : {};
      if (String(course.id) !== declared.courseId || auditTarget.kind !== declared.kind) {
        throw new ProgramLedgerError("A supplied audit report is bound to a different course or target kind.", "target_identity_disagreement");
      }
    }
    bound.set(declared.key, child);
  }
  return bound;
}

function bindManualChecks(
  targetsByKey: ReadonlyMap<string, InventoryTarget>,
  checks: readonly ProgramLedgerManualCheck[],
): Map<string, ProgramLedgerManualCheck> {
  const bound = new Map<string, ProgramLedgerManualCheck>();
  for (const check of checks) {
    const key = targetKey(check.course_id, check.source_binding_id, check.target);
    if (!targetsByKey.has(key)) {
      throw new ProgramLedgerError("A recorded manual check names a target this inventory did not discover.", "target_identity_disagreement");
    }
    if (bound.has(key)) {
      throw new ProgramLedgerError("Two recorded manual checks name the same inventory target.", "target_identity_disagreement");
    }
    bound.set(key, check);
  }
  return bound;
}

function derive(target: InventoryTarget, child: ProgramLedgerAuditChildResult | undefined, manual: ProgramLedgerManualCheck | undefined): DerivedState {
  const audit = auditRecord(child?.report);
  const problem = problemRecord(child?.report);
  const repair = child?.repair;
  const reAudit = auditRecord(repair?.re_audit);
  const current = reAudit ?? audit;
  const signals = current ? collectSignals(current) : undefined;
  const digest = contentDigest(current);
  const currentStatus = typeof current?.status === "string" ? current.status : undefined;
  const evidence = (auditStatus: string): JsonObject => ({
    audit_status: auditStatus,
    ...(digest ? { content_sha256: digest } : {}),
    ...(signals?.observed ? { signals: signals.counts } : {}),
    ...(repair ? { operation_id: repair.operation_id, verification_status: repair.verification_status ?? "not_recorded" } : {}),
  });

  // A repair record decides the state first: an unresolved provider effect is a
  // write-safety fact that no later read or manual note may mask.
  if (repair) {
    if (repair.operation_state === "applied_or_unknown") {
      return {
        finalState: "blocked",
        reason: "unresolved_provider_effect",
        detail: "A repair for this target has an unresolved provider effect. Morrow cannot say whether that change reached the course and will not repeat it.",
        evidence: evidence(currentStatus ?? "not_attempted"),
      };
    }
    if (repair.operation_state === "verified" && repair.verification_status === "verified") {
      if (reAudit && currentStatus === "evidence_ready" && signals && signals.total === 0) {
        return {
          finalState: "repaired_and_verified",
          reason: "repair_verified_and_signal_absent",
          detail: "The repair operation is verified and the re-audit returned complete evidence with no remaining source signal.",
          evidence: evidence("evidence_ready"),
        };
      }
      if (reAudit && signals && signals.total > 0) {
        return {
          finalState: "evidence_ready_pending_review",
          reason: "repair_verified_signal_still_present",
          detail: "The repair operation is verified, but the re-audit still returns a source signal for this target.",
          evidence: evidence(currentStatus ?? "not_attempted"),
        };
      }
      return {
        finalState: "evidence_ready_pending_review",
        reason: "repair_verified_re_audit_incomplete",
        detail: "The repair operation is verified, but no complete re-audit of this target followed it.",
        evidence: evidence(currentStatus ?? "not_attempted"),
      };
    }
    return {
      finalState: "evidence_ready_pending_review",
      reason: "repair_not_verified",
      detail: `The repair operation for this target is ${repair.operation_state}. Morrow did not verify a saved change here.`,
      evidence: evidence(currentStatus ?? "not_attempted"),
    };
  }

  // Only a person can state a manual check, so it replaces a derived unread or
  // blocked state. It cannot replace an unresolved provider effect above.
  if (manual) {
    return {
      finalState: "manually_checked",
      reason: "manual_review_recorded",
      detail: `A person recorded a manual check on ${manual.checked_at}: ${manual.note}`,
      evidence: evidence(currentStatus ?? "not_attempted"),
    };
  }

  if (!target.eligible) {
    return {
      finalState: "unread",
      reason: reasonCode(target.coverageGap?.code, "source_list_incomplete"),
      detail: sentence(target.coverageGap?.reason, "This target came from a source list Morrow could not read completely, so it was never eligible for an audit."),
      evidence: evidence("not_attempted"),
    };
  }

  if (!child || child.state === "pending" || child.state === "running" || child.state === "cancelled") {
    return {
      finalState: "unread",
      reason: "audit_result_absent",
      detail: "No completed audit result was supplied for this discovered target.",
      evidence: evidence("not_attempted"),
    };
  }
  if (child.state === "failed" || problem) {
    return {
      finalState: "blocked",
      reason: reasonCode(problem?.code, "audit_failed"),
      detail: "The audit of this target returned a structured failure. Morrow read no content here.",
      evidence: evidence("error"),
    };
  }
  if (child.state === "unknown") {
    return {
      finalState: "blocked",
      reason: "audit_result_uncertain",
      detail: "The audit result for this target is uncertain. Inspect the saved child before running it again.",
      evidence: evidence("error"),
    };
  }
  if (!current) {
    return {
      finalState: "unread",
      reason: "audit_result_absent",
      detail: "The audit child succeeded, but no saved audit report was supplied for this target.",
      evidence: evidence("not_returned"),
    };
  }

  if (currentStatus === "blocked") {
    return {
      finalState: "blocked",
      reason: reasonCode(current.block_reason, "audit_blocked"),
      detail: "Morrow did not read this target's content. It is not a passed target and it needs manual review.",
      evidence: evidence("blocked"),
    };
  }
  if (currentStatus === "provider_unavailable") {
    return {
      finalState: "blocked",
      reason: "provider_unavailable",
      detail: "The selected provider has no current connection for this target.",
      evidence: evidence("provider_unavailable"),
    };
  }

  const content = isJsonObject(current.content_evidence) ? current.content_evidence : undefined;
  if (content?.status !== "observed") {
    return {
      finalState: "unread",
      reason: reasonCode(content?.reason, "content_not_observed"),
      detail: sentence(content?.detail ?? content?.reason, "Morrow did not observe this target's content. This is not a passed check."),
      evidence: evidence(currentStatus ?? "evidence_incomplete"),
    };
  }

  if (signals && signals.total > 0) {
    const held = remediationHeld(current);
    if (held) {
      return {
        finalState: "held",
        reason: "remediation_route_held",
        detail: sentence(held.reason, "The remediation route for this target is held."),
        evidence: evidence(currentStatus ?? "evidence_ready"),
      };
    }
    return {
      finalState: "evidence_ready_pending_review",
      reason: "source_signal_requires_review",
      detail: "This target returned at least one saved-source signal. A person must review it in the course.",
      evidence: evidence(currentStatus ?? "evidence_ready"),
    };
  }

  if (currentStatus === "evidence_partial_course_association") {
    return {
      finalState: "evidence_ready_pending_review",
      reason: "course_association_not_established",
      detail: "This read does not prove that the target belongs to the selected course, so its evidence needs review.",
      evidence: evidence(currentStatus),
    };
  }
  if (signals && signals.notApplicable && !signals.observed) {
    return {
      finalState: "not_applicable_with_evidence",
      reason: "html_source_signal_checks_not_applicable",
      detail: "This target's saved source is plain text, so the HTML source-signal checks do not apply. Contextual and learner-view review still applies.",
      evidence: evidence(currentStatus ?? "evidence_ready"),
    };
  }
  if (currentStatus === "evidence_ready") {
    return {
      finalState: "evidence_ready_pending_review",
      reason: "no_source_signal_observed",
      detail: "This target returned no saved-source signal. That is not an accessibility pass; a person must still review it.",
      evidence: evidence("evidence_ready"),
    };
  }
  return {
    finalState: "evidence_ready_pending_review",
    reason: "partial_evidence_requires_review",
    detail: "This audit returned incomplete evidence for the target. A person must review what is missing.",
    evidence: evidence(currentStatus ?? "evidence_incomplete"),
  };
}

function listCounters(courses: readonly JsonObject[]): { readonly unreadLists: number; readonly truncatedLists: number } {
  let unreadLists = 0;
  let truncatedLists = 0;
  for (const course of courses) {
    if (!Array.isArray(course.lists)) continue;
    for (const list of course.lists) {
      if (!isJsonObject(list)) continue;
      if (list.status === "unavailable") unreadLists += 1;
      else if (list.status === "truncated" || list.truncated === true) truncatedLists += 1;
    }
  }
  return { unreadLists, truncatedLists };
}

function manualReviewCategories(report: JsonObject, courses: readonly JsonObject[]): JsonObject[] {
  const coverage = isJsonObject(report.coverage) ? report.coverage : {};
  const sources: unknown[] = [coverage.residual_coverage, ...courses.map((course) => course.residual_coverage)];
  const categories: JsonObject[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (!isJsonObject(entry) || typeof entry.category !== "string") continue;
      const reason = typeof entry.reason === "string" ? entry.reason : "";
      const identity = `${entry.category} ${reason}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      categories.push({ category: entry.category, reason });
    }
  }
  return categories;
}

/**
 * Derive one final state for every discovered inventory target. This function
 * reads nothing; it states only what the supplied local records already say.
 */
export function buildProgramAuditLedger(
  report: JsonObject,
  children: readonly ProgramLedgerAuditChildResult[] = [],
  manualChecks: readonly ProgramLedgerManualCheck[] = [],
): JsonObject {
  const courses = inventoryCourses(report);
  const targets = inventoryTargets(courses);
  const targetsByKey = new Map(targets.map((target) => [target.key, target]));
  const boundChildren = bindAuditChildren(report, targetsByKey, children);
  const boundManualChecks = bindManualChecks(targetsByKey, manualChecks);

  const finalStates: Record<string, number> = Object.fromEntries(PROGRAM_LEDGER_FINAL_STATES.map((state) => [state, 0]));
  const entries: JsonObject[] = targets.map((target) => {
    const derived = derive(target, boundChildren.get(target.key), boundManualChecks.get(target.key));
    finalStates[derived.finalState] = (finalStates[derived.finalState] ?? 0) + 1;
    return {
      course_id: target.courseId,
      target: target.target,
      source_list: target.sourceList,
      final_state: derived.finalState,
      reason: derived.reason,
      detail: derived.detail,
      evidence: derived.evidence,
    };
  });

  const lists = listCounters(courses);
  const coverage = isJsonObject(report.coverage) ? report.coverage : {};
  return {
    schema: "morrow.program-audit-ledger.v1",
    provider: typeof report.provider === "string" ? report.provider : "unknown",
    scope: "selected_program",
    observed_at: new Date().toISOString(),
    conformance_claim: "none",
    inventory: {
      schema: "morrow.course-inventory.v1",
      observed_at: typeof report.observed_at === "string" ? report.observed_at : null,
      coverage_status: typeof coverage.status === "string" ? coverage.status : "unknown",
      coverage_complete: coverage.complete === true,
      course_ids: courses.map((course) => String(course.course_id)),
    },
    entries,
    counters: {
      total_targets: entries.length,
      final_states: finalStates,
      unread_lists: lists.unreadLists,
      truncated_lists: lists.truncatedLists,
      manual_review_required: manualReviewCategories(report, courses),
    },
    limits: [...LEDGER_LIMITS],
  };
}

function resolveInventoryReport(runtime: GatewayRuntime, value: JsonObject): JsonObject {
  if (value.schema === "morrow.course-inventory.v1") return value;
  const resolved = resolveResultArtifact({ structuredContent: value }, (handle, offset) => (
    runtime.resultPage(handle, offset) as unknown as ResultArtifactPage
  ));
  const content = isJsonObject(resolved.structuredContent) ? resolved.structuredContent : undefined;
  if (!content || content.schema !== "morrow.course-inventory.v1") {
    throw new ProgramLedgerError("The supplied inventory handle did not resolve to a selected-program inventory.", "inventory_report_unavailable");
  }
  return content;
}

function ledgerFailure(error: unknown): CallToolResult {
  const ledgerError = error instanceof ProgramLedgerError ? error : undefined;
  const detail = ledgerError?.message ?? "Morrow could not build the program accessibility ledger.";
  return {
    isError: true,
    content: [{ type: "text", text: `Program ledger unavailable. ${detail}` }],
    structuredContent: {
      schema: "morrow.problem.v1",
      code: ledgerError?.code ?? "program_ledger_unavailable",
      detail_digest: sha256Text(error instanceof Error ? `${error.name}:${error.message}` : String(error)),
    },
  };
}

function ledgerSummary(ledger: JsonObject): string {
  const counters = isJsonObject(ledger.counters) ? ledger.counters : {};
  const finalStates = isJsonObject(counters.final_states) ? counters.final_states : {};
  const count = (value: unknown): number => (typeof value === "number" ? value : 0);
  const state = (name: ProgramLedgerFinalState): number => count(finalStates[name]);
  const total = count(counters.total_targets);
  const truncatedLists = count(counters.truncated_lists);
  const unreadLists = count(counters.unread_lists);
  return [
    `Program accessibility ledger: ${total} discovered target${total === 1 ? "" : "s"}, one final state each.`,
    `${state("repaired_and_verified")} repaired and verified, ${state("manually_checked")} manually checked, ${state("not_applicable_with_evidence")} not applicable with evidence, ${state("evidence_ready_pending_review")} pending review, ${state("unread")} unread, ${state("blocked")} blocked, ${state("held")} held.`,
    `${truncatedLists} truncated and ${unreadLists} unread source list${truncatedLists + unreadLists === 1 ? "" : "s"}.`,
    "These states come from local audit and operation records only. This ledger proves no live course result and makes no accessibility conformance claim.",
  ].join(" ");
}

export function collectProgramLedger(runtime: GatewayRuntime, value: unknown): CallToolResult {
  try {
    const input = programLedgerInputSchema.parse(value);
    const report = resolveInventoryReport(runtime, input.inventory);
    const ledger = buildProgramAuditLedger(report, input.audit_children, input.manual_checks);
    return {
      content: [{ type: "text", text: ledgerSummary(ledger) }],
      structuredContent: ledger,
    };
  } catch (error) {
    return ledgerFailure(error);
  }
}

export function registerProgramLedgerResource(server: McpServer): void {
  server.registerResource("program-audit-ledger-guidance", "morrow://guidance/program-audit-ledger-v1", {
    title: "Program accessibility ledger states and limits",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, text: PROGRAM_LEDGER_GUIDANCE }] }));
}

export function registerProgramLedgerTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_program_ledger", {
    title: "State one final accessibility state for every discovered target",
    description: "Combine a saved selected-program inventory with the audit results for its audit children and state exactly one final state for every discovered target: repaired and verified, manually checked, not applicable with evidence, unread, blocked, held, or evidence ready pending review. Refuses when a selected course was refused, and when the inventory and the supplied results disagree on target identity. Read the `morrow://guidance/program-audit-ledger-v1` resource before reporting these states. This tool reads no course, makes no edit, and makes no accessibility conformance claim.",
    inputSchema: programLedgerInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (value, _context: ServerContext) => collectProgramLedger(runtime, value));
}
