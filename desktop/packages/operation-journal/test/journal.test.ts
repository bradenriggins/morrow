import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Json } from "@morrow/contracts";
import {
  GatewayOperationConflictError,
  GatewayOperationJournal,
  ProviderEffectBroker,
  classifySourceResult,
} from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function input() {
  return {
    publicToolName: "edit_page",
    sourceId: "morrow-legacy",
    sourceToolName: "edit_page",
    catalogDigest: "a".repeat(64),
    requestDigest: sha256Json({ course_id: "42", title: "A" }),
    forwardedRequestDigest: sha256Json({ course_id: "42", title: "A", _morrow: { operation_id: "operation:test-1234" } }),
    sourceOperationId: "operation:test-1234",
    idempotencyKey: "operation:test-1234",
    readOnly: false,
  } as const;
}

describe("GatewayOperationJournal", () => {
  it("persists prepare, dispatch, and source response truth", () => {
    const journal = new GatewayOperationJournal({ path: ":memory:" });
    const prepared = journal.prepare(input());
    expect(prepared.created).toBe(true);
    expect(prepared.record.state).toBe("prepared");
    journal.markDispatched(prepared.record.operationId);
    const complete = journal.recordResponse(prepared.record.operationId, {
      upstreamResultDigest: "b".repeat(64),
      normalizedResultDigest: "c".repeat(64),
      sourceResultState: "awaiting_confirmation",
      sourceTaskId: "task-1",
    });
    expect(complete.state).toBe("response_received");
    expect(complete.sourceTaskId).toBe("task-1");
    expect(journal.health().totalOperations).toBe(1);
    journal.close();
  });

  it("does not create a second operation for the same exact idempotency key", () => {
    const journal = new GatewayOperationJournal({ path: ":memory:" });
    const first = journal.prepare(input());
    const replay = journal.prepare(input());
    expect(replay.created).toBe(false);
    expect(replay.record.operationId).toBe(first.record.operationId);
    expect(() => journal.prepare({ ...input(), requestDigest: "d".repeat(64) }))
      .toThrow(GatewayOperationConflictError);
    journal.close();
  });

  it("retains complete read authority and successful-response evidence", () => {
    let causalSequence = 40;
    const journal = new GatewayOperationJournal({
      path: ":memory:",
      nextCausalSequence: () => ++causalSequence,
    });
    const authority = {
      sourceBindingId: "canvas:course-42",
      targetIdentityDigest: "d".repeat(64),
      actorDigest: "e".repeat(64),
    };
    const prepared = journal.prepare({
      ...input(),
      publicToolName: "read_page",
      sourceToolName: "read_page",
      sourceOperationId: undefined,
      idempotencyKey: undefined,
      readOnly: true,
      ...authority,
    });
    expect(prepared.record).toMatchObject({ ...authority, responseSucceeded: null });
    journal.markDispatched(prepared.record.operationId);
    const complete = journal.recordResponse(prepared.record.operationId, {
      upstreamResultDigest: "b".repeat(64),
      normalizedResultDigest: "c".repeat(64),
      responseSucceeded: true,
    });
    expect(complete).toMatchObject({
      ...authority,
      responseSucceeded: true,
      publicResultDelivered: false,
      state: "response_received",
    });
    const delivered = journal.recordPublicReadDelivered(prepared.record.operationId);
    expect(delivered).toMatchObject({
      publicResultDelivered: true,
      preparedCausalSequence: 41,
      responseSucceeded: true,
    });
    for (let index = 0; index < 201; index += 1) {
      const decoy = journal.prepare({
        ...input(),
        publicToolName: "read_page",
        sourceToolName: "read_page",
        sourceOperationId: undefined,
        idempotencyKey: undefined,
        readOnly: true,
        ...authority,
        targetIdentityDigest: sha256Json({ decoy: index }),
      });
      journal.markDispatched(decoy.record.operationId);
      journal.recordResponse(decoy.record.operationId, {
        upstreamResultDigest: sha256Json({ decoy: index }),
        normalizedResultDigest: sha256Json({ normalizedDecoy: index }),
        responseSucceeded: true,
      });
    }
    expect(journal.findSuccessfulReadEvidence({
      sourceId: "morrow-legacy",
      ...authority,
      upstreamResultDigest: "b".repeat(64),
      afterCausalSequence: 40,
    })?.operationId).toBe(prepared.record.operationId);
    expect(journal.findSuccessfulReadEvidence({
      sourceId: "morrow-legacy",
      ...authority,
      upstreamResultDigest: "b".repeat(64),
      afterCausalSequence: delivered.preparedCausalSequence!,
    })).toBeNull();
    expect(journal.findSuccessfulReadEvidence({
      sourceId: "morrow-legacy",
      ...authority,
      actorDigest: "f".repeat(64),
      upstreamResultDigest: "b".repeat(64),
      afterCausalSequence: 40,
    })).toBeNull();
    expect(() => journal.prepare({
      ...input(),
      readOnly: true,
      sourceBindingId: authority.sourceBindingId,
    })).toThrow(/authority evidence must be complete/);
    expect(() => journal.prepare({ ...input(), ...authority })).toThrow(/belongs only to a read-only operation/);
    journal.close();
  });

  it("recovers prepared and dispatched operations without replay", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-journal-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    const first = new GatewayOperationJournal({ path });
    const prepared = first.prepare({ ...input(), idempotencyKey: "operation:prepared-1234", sourceOperationId: "operation:prepared-1234" });
    const dispatched = first.prepare({ ...input(), idempotencyKey: "operation:dispatched-1234", sourceOperationId: "operation:dispatched-1234", requestDigest: "e".repeat(64), forwardedRequestDigest: "f".repeat(64) });
    first.markDispatched(dispatched.record.operationId);
    first.close();

    const recovered = new GatewayOperationJournal({ path });
    expect(recovered.get(prepared.record.operationId).state).toBe("failed_before_send");
    expect(recovered.get(dispatched.record.operationId).state).toBe("source_unknown");
    expect(recovered.health().unknownOperations).toBe(1);
    recovered.close();
  });

  it("adds read authority columns to an existing journal without changing old records", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-journal-authority-migration-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE gateway_operations (
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
    `);
    database.close();

    const journal = new GatewayOperationJournal({ path });
    const prepared = journal.prepare(input());
    expect(prepared.record).toMatchObject({
      sourceBindingId: null,
      targetIdentityDigest: null,
      actorDigest: null,
      responseSucceeded: null,
      publicResultDelivered: false,
      preparedCausalSequence: 1,
    });
    journal.close();
  });

  it("keeps read-delivery causal order across journal restarts", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-journal-causal-order-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    const authority = {
      sourceBindingId: "canvas:course-42",
      targetIdentityDigest: "d".repeat(64),
      actorDigest: "e".repeat(64),
    };
    const deliver = (journal: GatewayOperationJournal, digest: string) => {
      const prepared = journal.prepare({
        ...input(),
        publicToolName: "read_page",
        sourceToolName: "read_page",
        sourceOperationId: undefined,
        idempotencyKey: undefined,
        readOnly: true,
        ...authority,
      });
      journal.markDispatched(prepared.record.operationId);
      journal.recordResponse(prepared.record.operationId, {
        upstreamResultDigest: digest,
        normalizedResultDigest: digest,
        responseSucceeded: true,
      });
      return journal.recordPublicReadDelivered(prepared.record.operationId);
    };

    const first = new GatewayOperationJournal({ path });
    const firstRead = deliver(first, "1".repeat(64));
    first.close();
    const restarted = new GatewayOperationJournal({ path });
    const laterRead = deliver(restarted, "2".repeat(64));
    expect(laterRead.preparedCausalSequence)
      .toBeGreaterThan(firstRead.preparedCausalSequence!);
    restarted.close();
  });

  it("orders person-close evidence across effect and read journals even when every timestamp is equal", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-journal-effect-causal-order-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    const now = () => new Date("2026-09-14T12:00:00.000Z");
    const authority = {
      sourceBindingId: "canvas:course-42",
      targetIdentityDigest: "d".repeat(64),
      actorDigest: "e".repeat(64),
    };
    const journal = new GatewayOperationJournal({ path, now });
    const effects = new ProviderEffectBroker({ path, now });
    const operation = effects.create({
      publicToolName: "edit_page",
      sourceId: "morrow-legacy",
      sourceToolName: "edit_page",
      catalogDigest: "a".repeat(64),
      request: { course_id: "42", page_id: "7" },
      forwardedRequest: { course_id: "42", page_id: "7" },
      sourceBindingId: authority.sourceBindingId,
      authority: {
        profileDigest: "1".repeat(64),
        actorDigest: authority.actorDigest,
        providerPrincipalDigest: "3".repeat(64),
        connectionGeneration: 1,
        catalogDigest: "a".repeat(64),
        approvalClass: "content",
        targetSetDigest: authority.targetIdentityDigest,
      },
    });
    effects.approve(operation.operationId);
    effects.reserveDispatch(operation.operationId);

    const startRead = () => {
      const prepared = journal.prepare({
        ...input(),
        publicToolName: "read_page",
        sourceToolName: "read_page",
        sourceOperationId: undefined,
        idempotencyKey: undefined,
        readOnly: true,
        ...authority,
      });
      journal.markDispatched(prepared.record.operationId);
      return prepared.record.operationId;
    };
    const deliverRead = (operationId: string) => {
      journal.recordResponse(operationId, {
        upstreamResultDigest: "b".repeat(64),
        normalizedResultDigest: "c".repeat(64),
        responseSucceeded: true,
      });
      return journal.recordPublicReadDelivered(operationId);
    };

    const duringDispatchId = startRead();
    const unresolved = effects.settleFailure(operation.operationId, { timeout: true }, true);
    const duringDispatch = deliverRead(duringDispatchId);
    expect(duringDispatch.createdAt).toBe(unresolved.updatedAt);
    expect(duringDispatch.preparedCausalSequence)
      .toBeLessThan(unresolved.personCloseCausalSequence!);
    expect(journal.findSuccessfulReadEvidence({
      sourceId: "morrow-legacy",
      ...authority,
      upstreamResultDigest: "b".repeat(64),
      afterCausalSequence: unresolved.personCloseCausalSequence!,
    })).toBeNull();

    const afterUnknown = deliverRead(startRead());
    expect(afterUnknown.createdAt).toBe(unresolved.updatedAt);
    expect(journal.findSuccessfulReadEvidence({
      sourceId: "morrow-legacy",
      ...authority,
      upstreamResultDigest: "b".repeat(64),
      afterCausalSequence: unresolved.personCloseCausalSequence!,
    })?.operationId).toBe(afterUnknown.operationId);
    expect(effects.closeAfterPersonCheck(
      operation.operationId,
      "b".repeat(64),
      afterUnknown.preparedCausalSequence!,
    ).state).toBe("closed_by_person");
    effects.close();
    journal.close();
  });

  it("classifies nested source task and uncertainty state", () => {
    expect(classifySourceResult({
      structuredContent: {
        result: { resultState: "bridge_outcome_unknown", taskId: "task-7" },
      },
    })).toEqual({ state: "bridge_outcome_unknown", taskId: "task-7" });
  });

  it("PRIV-07 stores error digests without raw private markers", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-journal-private-log-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    const journal = new GatewayOperationJournal({ path });
    const prepared = journal.prepare(input());
    journal.markDispatched(prepared.record.operationId);
    journal.recordSourceUnknown(prepared.record.operationId, new Error("raw-page-body CHCP_PRIVATE_MARKER"));
    journal.close();
    expect(readFileSync(path).includes("raw-page-body")).toBe(false);
    expect(readFileSync(path).includes("CHCP_PRIVATE_MARKER")).toBe(false);
  });
});
