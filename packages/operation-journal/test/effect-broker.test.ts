import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  EFFECT_TARGET_IDENTITY_VERSION,
  ProviderEffectBroker,
  ProviderEffectTargetConflictError,
  ProviderEffectTargetScopeUnknownError,
} from "../src/index.js";

const roots: string[] = [];
let sequence = 0;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function create(broker: ProviderEffectBroker, input: Partial<Parameters<ProviderEffectBroker["create"]>[0]> = {}) {
  const sourceOperationId = `operation:effect-${++sequence}`;
  return broker.create({
    publicToolName: "canvas_page_update",
    sourceId: "example-legacy",
    sourceToolName: "canvas_page_update",
    catalogDigest: "a".repeat(64),
    request: { page_id: "42", title: "Original" },
    forwardedRequest: { page_id: "42", title: "Original", _morrow: { operation_id: sourceOperationId } },
    sourceOperationId,
    authority: {
      profileDigest: "1".repeat(64),
      actorDigest: "2".repeat(64),
      providerPrincipalDigest: "3".repeat(64),
      connectionGeneration: 1,
      catalogDigest: "a".repeat(64),
      approvalClass: "standard",
      targetSetDigest: "4".repeat(64),
    },
    ...input,
  });
}

function authorityForTarget(target: string) {
  return {
    profileDigest: "1".repeat(64),
    actorDigest: "2".repeat(64),
    providerPrincipalDigest: "3".repeat(64),
    connectionGeneration: 1,
    catalogDigest: "a".repeat(64),
    approvalClass: "standard",
    targetSetDigest: target.repeat(64),
  } as const;
}

function writeUnversionedEffectDatabase(path: string): void {
  const database = new DatabaseSync(path);
  const now = "2026-09-06T00:00:00.000Z";
  const authority = {
    profileDigest: "1".repeat(64),
    actorDigest: "2".repeat(64),
    providerPrincipalDigest: "3".repeat(64),
    connectionGeneration: 1,
    catalogDigest: "a".repeat(64),
    approvalClass: "standard",
    targetSetDigest: "4".repeat(64),
  };
  database.exec(`
    CREATE TABLE provider_effect_operations (
      operation_id TEXT PRIMARY KEY,
      public_tool_name TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_tool_name TEXT NOT NULL,
      catalog_digest TEXT NOT NULL,
      target_identity_digest TEXT,
      provider_principal_digest TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      forwarded_request_digest TEXT NOT NULL,
      forwarded_request_json TEXT NOT NULL,
      plan_digest TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      source_operation_id TEXT,
      source_binding_id TEXT,
      readback_json TEXT,
      correction_of TEXT,
      state TEXT NOT NULL,
      approval_grant_digest TEXT,
      approval_expires_at TEXT,
      approval_consumed_at TEXT,
      effect_receipt_id TEXT,
      dispatch_attempt INTEGER NOT NULL,
      upstream_result_digest TEXT,
      source_result_state TEXT,
      source_task_id TEXT,
      readback_digest TEXT,
      verification_status TEXT,
      attention_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    ) STRICT;
  `);
  const insert = database.prepare(`
    INSERT INTO provider_effect_operations(
      operation_id, public_tool_name, source_id, source_tool_name, catalog_digest,
      target_identity_digest, provider_principal_digest,
      request_digest, forwarded_request_digest, forwarded_request_json, plan_digest, plan_json,
      state, dispatch_attempt, verification_status, attention_json, created_at, updated_at
    ) VALUES (?, 'canvas_page_update', ?, 'canvas_page_update', ?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', 1, 'unconfirmed', '[]', ?, ?)
  `);
  for (const [operationId, targetIdentityDigest] of [
    ["op:legacy-null-target", null],
    ["op:legacy-v2-target", "2".repeat(64)],
  ] as const) {
    insert.run(
      operationId,
      "canvas-connector-a",
      authority.catalogDigest,
      targetIdentityDigest,
      authority.providerPrincipalDigest,
      "5".repeat(64),
      "6".repeat(64),
      JSON.stringify({ course_id: "42" }),
      "7".repeat(64),
      JSON.stringify({ authority, arguments: { course_id: "42" } }),
      now,
      now,
    );
  }
  database.prepare(`
    INSERT INTO provider_effect_operations(
      operation_id, public_tool_name, source_id, source_tool_name, catalog_digest,
      target_identity_digest, provider_principal_digest,
      request_digest, forwarded_request_digest, forwarded_request_json, plan_digest, plan_json,
      state, approval_grant_digest, approval_expires_at, dispatch_attempt, verification_status,
      attention_json, created_at, updated_at
    ) VALUES ('op:legacy-approved-plan', 'canvas_page_update', 'canvas-connector-a', 'canvas_page_update', ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, '2030-01-01T00:00:00.000Z', 0, 'unconfirmed', '[]', ?, ?)
  `).run(
    authority.catalogDigest,
    "3".repeat(64),
    authority.providerPrincipalDigest,
    "a".repeat(64),
    "b".repeat(64),
    JSON.stringify({ course_id: "42" }),
    "c".repeat(64),
    JSON.stringify({ authority, arguments: { course_id: "42" } }),
    "d".repeat(64),
    now,
    now,
  );
  database.close();
}

/**
 * A database written by a Morrow that predates the closed_by_person state. Its
 * CHECK constraint is the old list, so opening it proves the migration runs.
 */
function writeCheckedLegacyEffectDatabase(path: string): void {
  const database = new DatabaseSync(path);
  const now = "2026-09-06T00:00:00.000Z";
  const authority = {
    profileDigest: "1".repeat(64),
    actorDigest: "2".repeat(64),
    providerPrincipalDigest: "3".repeat(64),
    connectionGeneration: 1,
    catalogDigest: "a".repeat(64),
    approvalClass: "standard",
    targetSetDigest: "4".repeat(64),
  };
  database.exec(`
    CREATE TABLE provider_effect_operations (
      operation_id TEXT PRIMARY KEY,
      public_tool_name TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_tool_name TEXT NOT NULL,
      catalog_digest TEXT NOT NULL,
      target_identity_digest TEXT,
      target_identity_version TEXT,
      provider_principal_digest TEXT,
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
      dispatch_attempt INTEGER NOT NULL,
      upstream_result_digest TEXT,
      source_result_state TEXT,
      source_task_id TEXT,
      readback_digest TEXT,
      verification_status TEXT,
      attention_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    ) STRICT;
  `);
  database.prepare(`
    INSERT INTO provider_effect_operations(
      operation_id, public_tool_name, source_id, source_tool_name, catalog_digest,
      target_identity_digest, target_identity_version, provider_principal_digest,
      request_digest, forwarded_request_digest, forwarded_request_json, plan_digest, plan_json,
      state, approval_consumed_at, effect_receipt_id, dispatch_attempt, verification_status,
      attention_json, created_at, updated_at, terminal_at
    ) VALUES ('op:legacy-uncertain', 'canvas_page_update', 'canvas-connector-a', 'canvas_page_update', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied_or_unknown', ?, 'effect:legacy', 1, 'unconfirmed', ?, ?, ?, ?)
  `).run(
    authority.catalogDigest,
    authority.targetSetDigest,
    EFFECT_TARGET_IDENTITY_VERSION,
    authority.providerPrincipalDigest,
    "5".repeat(64),
    "6".repeat(64),
    JSON.stringify({ course_id: "42" }),
    "7".repeat(64),
    JSON.stringify({ authority, arguments: { course_id: "42" } }),
    now,
    JSON.stringify(["provider_effect_may_have_landed"]),
    now,
    now,
    now,
  );
  // The old constraint refuses the new state, which is what the migration fixes.
  expect(() => database.prepare(
    "UPDATE provider_effect_operations SET state='closed_by_person' WHERE operation_id='op:legacy-uncertain'",
  ).run()).toThrow(/CHECK constraint/);
  database.close();
}

describe("ProviderEffectBroker", () => {
  it("freezes plans and binds one expiring, single-use approval grant", () => {
    let clock = new Date("2026-09-04T00:00:00.000Z");
    const broker = new ProviderEffectBroker({ path: ":memory:", now: () => clock });
    const request = { page_id: "42", title: "Original" };
    const operation = create(broker, { request });
    request.title = "Mutated";
    expect((broker.get(operation.operationId).plan.arguments as { title: string }).title).toBe("Original");

    const approved = broker.approve(operation.operationId);
    expect(approved.approvalGrantDigest).toMatch(/^[0-9a-f]{64}$/);
    const dispatched = broker.reserveDispatch(operation.operationId);
    expect(dispatched.state).toBe("dispatching");
    expect(dispatched.dispatchAttempt).toBe(1);
    expect(() => broker.reserveDispatch(operation.operationId)).toThrow("cannot dispatch");

    const stale = create(broker);
    broker.approve(stale.operationId);
    expect(() => broker.reserveDispatch(stale.operationId, {
      ...(stale.plan.authority as Parameters<ProviderEffectBroker["reserveDispatch"]>[1]),
      connectionGeneration: 2,
    })).toThrow(/authority changed/);

    const expiring = create(broker, { approvalTtlMs: 60_000 });
    clock = new Date("2026-09-04T00:01:01.000Z");
    expect(broker.approve(expiring.operationId).state).toBe("cancelled");
    broker.close();
  });

  it("records ambiguity, fresh comparator evidence, and correction lineage", () => {
    const broker = new ProviderEffectBroker({ path: ":memory:" });
    const unknown = create(broker);
    broker.approve(unknown.operationId);
    broker.reserveDispatch(unknown.operationId);
    expect(broker.settleFailure(unknown.operationId, { timeout: true }, true).state).toBe("applied_or_unknown");

    const verified = create(broker, {
      authority: authorityForTarget("5"),
      readback: { tool: "canvas_page_get", arguments: { page_id: "42" }, expectedDigest: "b".repeat(64) },
    });
    broker.approve(verified.operationId);
    broker.reserveDispatch(verified.operationId);
    broker.settleResponse(verified.operationId, { upstreamResultDigest: "c".repeat(64) });
    expect(broker.recordReadback(verified.operationId, "d".repeat(64), false).state).toBe("awaiting_verification");
    expect(broker.recordReadback(verified.operationId, "b".repeat(64), true).state).toBe("verified");

    const innerApproval = create(broker, {
      authority: authorityForTarget("6"),
      readback: { tool: "canvas_page_get", arguments: { page_id: "42" }, expectedDigest: "e".repeat(64) },
    });
    broker.approve(innerApproval.operationId);
    broker.reserveDispatch(innerApproval.operationId);
    broker.settleResponse(innerApproval.operationId, {
      upstreamResultDigest: "f".repeat(64),
      innerApprovalRequired: true,
    });
    expect(() => broker.recordReadback(innerApproval.operationId, "e".repeat(64), true)).toThrow();

    const correction = create(broker, { authority: authorityForTarget("5"), correctionOf: verified.operationId });
    expect(correction.correctionOf).toBe(verified.operationId);
    expect(correction.operationId).not.toBe(verified.operationId);
    broker.close();
  });

  it("marks an interrupted dispatch ambiguous on restart and never replays it", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-effects-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    const first = new ProviderEffectBroker({ path });
    const operation = create(first);
    first.approve(operation.operationId);
    first.reserveDispatch(operation.operationId);
    first.close();

    const restarted = new ProviderEffectBroker({ path });
    expect(restarted.get(operation.operationId)).toMatchObject({
      state: "applied_or_unknown",
      dispatchAttempt: 1,
      attention: ["process_restart_after_dispatch"],
    });
    expect(() => restarted.reserveDispatch(operation.operationId)).toThrow();
    restarted.close();
  });

  it("blocks an overlapping target across clients, permits another course, and releases only after a safe result", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-effects-conflict-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    const first = new ProviderEffectBroker({ path });
    const second = new ProviderEffectBroker({ path });
    const target42 = authorityForTarget("4");
    const target43 = authorityForTarget("5");
    const firstTarget = create(first, { authority: target42, sourceOperationId: "operation:client-a" });
    const sameTarget = create(second, {
      authority: target42,
      sourceOperationId: "operation:client-b",
      request: { page_id: "42", title: "Different requested value" },
      forwardedRequest: { page_id: "42", title: "Different requested value", _morrow: { operation_id: "operation:client-b" } },
    });
    const differentCourse = create(second, {
      authority: target43,
      sourceOperationId: "operation:client-c",
      request: { page_id: "43", title: "Concurrent course" },
      forwardedRequest: { page_id: "43", title: "Concurrent course", _morrow: { operation_id: "operation:client-c" } },
    });
    first.approve(firstTarget.operationId);
    second.approve(sameTarget.operationId);
    second.approve(differentCourse.operationId);
    expect(first.reserveDispatch(firstTarget.operationId)).toMatchObject({ state: "dispatching" });
    expect(() => second.reserveDispatch(sameTarget.operationId)).toThrow(ProviderEffectTargetConflictError);
    expect(second.recordTargetConflict(sameTarget.operationId)).toMatchObject({
      state: "approved", dispatchAttempt: 0, attention: ["provider_effect_target_conflict"],
    });
    expect(first.get(sameTarget.operationId).attention).toEqual(["provider_effect_target_conflict"]);
    expect(second.reserveDispatch(differentCourse.operationId)).toMatchObject({ state: "dispatching" });
    expect(first.settleFailure(firstTarget.operationId, { refusedBeforeSend: true }, false)).toMatchObject({ state: "failed" });
    expect(second.reserveDispatch(sameTarget.operationId)).toMatchObject({ state: "dispatching", attention: [] });
    first.close();
    second.close();
  });

  it("blocks one provider object across connector sources and principals", () => {
    const broker = new ProviderEffectBroker({ path: ":memory:" });
    const sharedTarget = authorityForTarget("8");
    const first = create(broker, {
      sourceId: "canvas-connector-a",
      authority: { ...sharedTarget, actorDigest: "6".repeat(64), providerPrincipalDigest: "7".repeat(64) },
    });
    const sameObjectOtherPrincipal = create(broker, {
      sourceId: "canvas-connector-b",
      authority: { ...sharedTarget, actorDigest: "8".repeat(64), providerPrincipalDigest: "9".repeat(64) },
    });
    const differentSite = create(broker, {
      sourceId: "canvas-connector-b",
      authority: authorityForTarget("9"),
    });

    broker.approve(first.operationId);
    broker.approve(sameObjectOtherPrincipal.operationId);
    broker.approve(differentSite.operationId);
    expect(broker.reserveDispatch(first.operationId)).toMatchObject({ state: "dispatching" });
    expect(() => broker.reserveDispatch(sameObjectOtherPrincipal.operationId))
      .toThrow(ProviderEffectTargetConflictError);
    expect(broker.reserveDispatch(differentSite.operationId)).toMatchObject({ state: "dispatching" });
    broker.close();
  });

  it("keeps a restarted uncertain target blocked until a verified readback", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-effects-restart-conflict-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    const target = authorityForTarget("7");
    const first = new ProviderEffectBroker({ path });
    const sent = create(first, { authority: target, sourceOperationId: "operation:restart-a" });
    first.approve(sent.operationId);
    first.reserveDispatch(sent.operationId);
    first.close();

    const restarted = new ProviderEffectBroker({ path });
    const next = create(restarted, { authority: target, sourceOperationId: "operation:restart-b" });
    restarted.approve(next.operationId);
    expect(() => restarted.reserveDispatch(next.operationId)).toThrow(ProviderEffectTargetConflictError);
    expect(restarted.recordReadback(sent.operationId, "8".repeat(64), true)).toMatchObject({ state: "verified" });
    expect(restarted.reserveDispatch(next.operationId)).toMatchObject({ state: "dispatching" });
    restarted.close();
  });

  it("clears a locked target through a verified readback or a person-confirmed close-out, and not otherwise", () => {
    const broker = new ProviderEffectBroker({ path: ":memory:" });
    const readback = { tool: "canvas_page_get", arguments: { page_id: "42" }, expectedDigest: "b".repeat(64) };
    const sent = (target: string, suffix: string) => {
      const operation = create(broker, {
        authority: authorityForTarget(target),
        sourceOperationId: `operation:exit-${suffix}`,
        readback,
      });
      broker.approve(operation.operationId);
      broker.reserveDispatch(operation.operationId);
      return operation.operationId;
    };
    const queued = (target: string, suffix: string) => {
      const operation = create(broker, {
        authority: authorityForTarget(target),
        sourceOperationId: `operation:queued-${suffix}`,
      });
      broker.approve(operation.operationId);
      return operation.operationId;
    };

    // Exit 1: Morrow's own fresh readback matches, so the record is verified and
    // the target is free.
    const verifiedWrite = sent("4", "verified");
    broker.settleResponse(verifiedWrite, { upstreamResultDigest: "c".repeat(64) });
    const afterVerified = queued("4", "verified");
    expect(() => broker.reserveDispatch(afterVerified)).toThrow(ProviderEffectTargetConflictError);
    expect(broker.recordReadback(verifiedWrite, readback.expectedDigest, true)).toMatchObject({
      state: "verified", verificationStatus: "verified", attention: [],
    });
    expect(broker.reserveDispatch(afterVerified)).toMatchObject({ state: "dispatching" });

    // Exit 2: nothing proves the change, so a person checked the saved state and
    // closed it. Morrow still does not claim it verified the change.
    const uncertainWrite = sent("5", "person");
    broker.settleFailure(uncertainWrite, { gatewayUnreachable: true }, true);
    expect(broker.get(uncertainWrite).state).toBe("applied_or_unknown");
    const afterPersonClose = queued("5", "person");
    expect(() => broker.reserveDispatch(afterPersonClose)).toThrow(ProviderEffectTargetConflictError);
    const closed = broker.closeAfterPersonCheck(uncertainWrite, "9".repeat(64));
    expect(closed).toMatchObject({
      state: "closed_by_person",
      verificationStatus: "unconfirmed",
      personObservedStateDigest: "9".repeat(64),
      attention: ["closed_after_person_checked_saved_state"],
    });
    expect(closed.terminalAt).toBe(closed.updatedAt);
    expect(broker.reserveDispatch(afterPersonClose)).toMatchObject({ state: "dispatching" });

    // Exit 3: the fresh readback did not match, so the record stays unresolved
    // and keeps holding its target.
    const unresolvedWrite = sent("6", "unresolved");
    broker.settleResponse(unresolvedWrite, { upstreamResultDigest: "d".repeat(64) });
    expect(broker.recordReadback(unresolvedWrite, "e".repeat(64), false)).toMatchObject({
      state: "awaiting_verification",
      verificationStatus: "unconfirmed",
      attention: ["readback_did_not_match_frozen_comparator"],
      terminalAt: null,
    });
    const afterUnresolved = queued("6", "unresolved");
    expect(() => broker.reserveDispatch(afterUnresolved)).toThrow(ProviderEffectTargetConflictError);

    // A settled record is never reopened, and a close-out without a real digest
    // is refused before anything is written.
    expect(() => broker.closeAfterPersonCheck(verifiedWrite, "9".repeat(64))).toThrow(/cannot be closed by a person/);
    expect(() => broker.closeAfterPersonCheck(uncertainWrite, "9".repeat(64))).toThrow(/cannot be closed by a person/);
    expect(() => broker.closeAfterPersonCheck(unresolvedWrite, "not-a-digest")).toThrow(/SHA-256/);
    expect(broker.get(unresolvedWrite).state).toBe("awaiting_verification");
    broker.close();
  });

  it("names the operation that holds a blocked target in both refusals", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-effects-blocking-id-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    writeUnversionedEffectDatabase(path);
    const broker = new ProviderEffectBroker({ path });

    const held = create(broker, { authority: authorityForTarget("4"), sourceOperationId: "operation:holds-target" });
    broker.approve(held.operationId);
    broker.reserveDispatch(held.operationId);
    broker.settleResponse(held.operationId, { upstreamResultDigest: "c".repeat(64) });
    const blocked = create(broker, { authority: authorityForTarget("4"), sourceOperationId: "operation:blocked" });
    broker.approve(blocked.operationId);
    try {
      broker.reserveDispatch(blocked.operationId);
      expect.unreachable("the overlapping target must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderEffectTargetConflictError);
      expect((error as ProviderEffectTargetConflictError).operationId).toBe(held.operationId);
      expect((error as Error).message).toContain(held.operationId);
    }

    const historical = create(broker, { authority: authorityForTarget("7"), sourceOperationId: "operation:after-legacy" });
    broker.approve(historical.operationId);
    try {
      broker.reserveDispatch(historical.operationId, undefined, { enforceHistoricalTargetScopeBarrier: true });
      expect.unreachable("the unversioned historical scope must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderEffectTargetScopeUnknownError);
      const blocking = (error as ProviderEffectTargetScopeUnknownError).operationId;
      expect(["op:legacy-null-target", "op:legacy-v2-target"]).toContain(blocking);
      expect((error as Error).message).toContain(blocking);
    }
    broker.close();
  });

  it("adds the person close-out state to an existing database without changing a saved row", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-effects-person-close-migration-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    writeCheckedLegacyEffectDatabase(path);

    const broker = new ProviderEffectBroker({ path });
    expect(broker.get("op:legacy-uncertain")).toMatchObject({
      state: "applied_or_unknown",
      dispatchAttempt: 1,
      verificationStatus: "unconfirmed",
      attention: ["provider_effect_may_have_landed"],
      personObservedStateDigest: null,
    });
    expect(broker.closeAfterPersonCheck("op:legacy-uncertain", "a".repeat(64))).toMatchObject({
      state: "closed_by_person",
      personObservedStateDigest: "a".repeat(64),
      attention: ["closed_after_person_checked_saved_state"],
    });
    broker.close();

    const reopened = new ProviderEffectBroker({ path });
    expect(reopened.get("op:legacy-uncertain").state).toBe("closed_by_person");
    reopened.close();
  });

  it("keeps unversioned dispatched effects as a global connector barrier without treating old drafts as sent", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-effects-legacy-target-scope-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    writeUnversionedEffectDatabase(path);

    const broker = new ProviderEffectBroker({ path });
    expect(broker.get("op:legacy-null-target")).toMatchObject({
      targetIdentityDigest: null,
      targetIdentityVersion: null,
      state: "applied_or_unknown",
      dispatchAttempt: 1,
    });
    expect(broker.get("op:legacy-v2-target")).toMatchObject({
      targetIdentityDigest: "2".repeat(64),
      targetIdentityVersion: null,
      state: "applied_or_unknown",
      dispatchAttempt: 1,
    });
    expect(() => broker.reserveDispatch("op:legacy-approved-plan", undefined, {
      enforceHistoricalTargetScopeBarrier: true,
    })).toThrow("predates the current target identity");
    expect(broker.get("op:legacy-approved-plan")).toMatchObject({
      targetIdentityVersion: null,
      state: "approved",
      dispatchAttempt: 0,
    });

    const sameSource = create(broker, {
      sourceId: "canvas-connector-a",
      sourceOperationId: "operation:v3-same-source",
      authority: authorityForTarget("7"),
    });
    const differentSource = create(broker, {
      sourceId: "canvas-connector-b",
      sourceOperationId: "operation:v3-different-source",
      authority: authorityForTarget("8"),
    });
    expect(sameSource.targetIdentityVersion).toBe(EFFECT_TARGET_IDENTITY_VERSION);
    expect(differentSource.targetIdentityVersion).toBe(EFFECT_TARGET_IDENTITY_VERSION);
    broker.approve(sameSource.operationId);
    broker.approve(differentSource.operationId);

    for (const operation of [sameSource, differentSource]) {
      expect(() => broker.reserveDispatch(operation.operationId, undefined, {
        enforceHistoricalTargetScopeBarrier: true,
      })).toThrow(ProviderEffectTargetScopeUnknownError);
      expect(broker.get(operation.operationId)).toMatchObject({
        state: "approved",
        dispatchAttempt: 0,
      });
      expect(broker.recordTargetConflict(operation.operationId, "provider_effect_target_scope_unknown").attention)
        .toContain("provider_effect_target_scope_unknown");
    }

    broker.close();
  });
});
