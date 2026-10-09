import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayOperationJournal } from "@morrow/operation-journal";
import { sha256Json, sha256Text } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import {
  BatchSourceSettlementStore,
  DurableBatchStore,
  recoverBatchState,
} from "../src/public.js";

const catalogDigest = "c".repeat(64);

async function workspace(label: string): Promise<{
  directory: string;
  path: string;
  key: Uint8Array;
}> {
  const directory = await mkdtemp(join(tmpdir(), `morrow-${label}-`));
  return {
    directory,
    path: join(directory, "morrow.sqlite3"),
    key: randomBytes(32),
  };
}

function createReadBatch(store: DurableBatchStore) {
  return store.create({
    name: "Interrupted read",
    mode: "read_only",
    catalogDigest,
    concurrency: 1,
    children: [{
      childId: "course:1",
      publicToolName: "canvas_page_get",
      sourceId: "meridian",
      sourceToolName: "canvas_page_get",
      readOnly: true,
      arguments: { course_id: "1" },
    }],
  });
}

function createWriteBatch(store: DurableBatchStore, sourceOperationId: string, withDependent = false) {
  return store.create({
    name: "Interrupted staged write",
    mode: "stage_writes",
    catalogDigest,
    concurrency: 1,
    children: [{
      childId: "course:9",
      publicToolName: "edit_page",
      sourceId: "morrow-legacy",
      sourceToolName: "edit_page",
      readOnly: false,
      sourceOperationId,
      arguments: {
        course_id: "9",
        _morrow: { source_binding_id: "canvas:9" },
      },
    }, ...(withDependent ? [{
      childId: "course:10",
      publicToolName: "edit_page",
      sourceId: "morrow-legacy",
      sourceToolName: "edit_page",
      readOnly: false,
      sourceOperationId: `${sourceOperationId}-next`,
      dependencyChildIds: ["course:9"],
      arguments: {
        course_id: "10",
        _morrow: { source_binding_id: "canvas:10" },
      },
    }] : [])],
  });
}

function interruptBatch(store: DurableBatchStore, batchId: string): void {
  store.beginRun(batchId, catalogDigest);
  expect(store.claimPending(batchId, 1)).toHaveLength(1);
  store.close();
}

function recoverRunningChild(path: string, key: Uint8Array): DurableBatchStore {
  return new DurableBatchStore({ path, encryptionKey: key });
}

function prepareGatewayOperation(
  journal: GatewayOperationJournal,
  sourceOperationId: string,
) {
  const request = { course_id: "9", _morrow: { operation_id: sourceOperationId } };
  return journal.prepare({
    publicToolName: "edit_page",
    sourceId: "morrow-legacy",
    sourceToolName: "edit_page",
    catalogDigest,
    requestDigest: sha256Json(request),
    forwardedRequestDigest: sha256Json(request),
    sourceOperationId,
    idempotencyKey: sourceOperationId,
    readOnly: false,
  }).record;
}

describe("recoverBatchState", () => {
  it("resets unknown read-only work to pending without any provider dispatch", async () => {
    const fixture = await workspace("recover-read");
    try {
      const journal = new GatewayOperationJournal({ path: fixture.path });
      journal.close();
      const store = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      const created = createReadBatch(store);
      interruptBatch(store, created.batch.batchId);

      const recoveredStore = recoverRunningChild(fixture.path, fixture.key);
      expect(recoveredStore.getBatch(created.batch.batchId).state).toBe("inspection_required");
      recoveredStore.close();

      const preview = recoverBatchState({
        path: fixture.path,
        batchId: created.batch.batchId,
        mode: "inspect",
      });
      expect(preview).toMatchObject({
        stateBefore: "inspection_required",
        stateAfter: "inspection_required",
        retryReadOnly: 1,
        applied: 0,
        providerDispatches: 0,
      });

      const applied = recoverBatchState({
        path: fixture.path,
        batchId: created.batch.batchId,
        mode: "apply_safe",
      });
      expect(applied).toMatchObject({
        stateAfter: "paused",
        retryReadOnly: 1,
        applied: 1,
        unknownChildrenAfter: 0,
        pendingChildrenAfter: 1,
        providerDispatches: 0,
      });

      const finalStore = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      expect(finalStore.get(created.batch.batchId).children[0]).toMatchObject({
        state: "pending",
        attemptCount: 1,
        gatewayOperationId: null,
      });
      finalStore.close();
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("leaves an unconfirmed staged task unsettled and does not run its dependent", async () => {
    const fixture = await workspace("recover-task");
    try {
      const sourceOperationId = "operation:recover-task-0001";
      const store = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      const created = createWriteBatch(store, sourceOperationId, true);
      store.beginRun(created.batch.batchId, catalogDigest);
      expect(store.claimPending(created.batch.batchId, 1)).toHaveLength(1);

      const journal = new GatewayOperationJournal({ path: fixture.path });
      const prepared = prepareGatewayOperation(journal, sourceOperationId);
      journal.markDispatched(prepared.operationId);
      journal.recordResponse(prepared.operationId, {
        upstreamResultDigest: sha256Text("staged-response"),
        normalizedResultDigest: sha256Text("normalized-staged-response"),
        responseSucceeded: true,
        sourceResultState: "awaiting_confirmation",
        sourceTaskId: "task:recover-9",
      });
      journal.close();
      store.close();

      const recoveredStore = recoverRunningChild(fixture.path, fixture.key);
      recoveredStore.close();
      const recovered = recoverBatchState({
        path: fixture.path,
        batchId: created.batch.batchId,
        mode: "apply_safe",
      });
      expect(recovered).toMatchObject({
        stateAfter: "inspection_required",
        sourceTasksRecovered: 0,
        inspectionRequired: 1,
        providerDispatches: 0,
      });
      expect(recovered.children[0]).toMatchObject({
        action: "inspection_required",
        applied: true,
        sourceTaskId: "task:recover-9",
        sourceResultState: "awaiting_confirmation",
      });

      const finalStore = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      expect(finalStore.get(created.batch.batchId).children).toEqual([
        expect.objectContaining({
          childId: "course:9",
          state: "unknown",
          sourceTaskId: "task:recover-9",
          sourceResultState: "awaiting_confirmation",
        }),
        expect.objectContaining({ childId: "course:10", state: "pending" }),
      ]);
      expect(finalStore.getBatch(created.batch.batchId)).toMatchObject({
        state: "inspection_required",
        terminalAt: null,
      });
      expect(finalStore.beginRun(created.batch.batchId, catalogDigest).state).toBe("inspection_required");
      expect(finalStore.claimPending(created.batch.batchId, 2)).toEqual([]);
      expect(finalStore.get(created.batch.batchId).children[1]).toMatchObject({
        childId: "course:10",
        state: "pending",
      });
      finalStore.close();
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps the outer effect binding when it recovers a staged task", async () => {
    const fixture = await workspace("recover-binding");
    try {
      const sourceOperationId = "operation:recover-binding-0001";
      const outerOperationId = "op:recover-binding-outer-0001";
      const store = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      const created = createWriteBatch(store, sourceOperationId);
      store.bindGatewayOperation(created.batch.batchId, "course:9", outerOperationId, "approved");
      store.beginRun(created.batch.batchId, catalogDigest);
      expect(store.claimPending(created.batch.batchId, 1)).toHaveLength(1);

      const journal = new GatewayOperationJournal({ path: fixture.path });
      const prepared = prepareGatewayOperation(journal, sourceOperationId);
      journal.markDispatched(prepared.operationId);
      journal.recordResponse(prepared.operationId, {
        upstreamResultDigest: sha256Text("staged-response"),
        normalizedResultDigest: sha256Text("normalized-staged-response"),
        sourceResultState: "awaiting_confirmation",
        sourceTaskId: "task:recover-binding",
      });
      journal.close();
      store.close();

      const recoveredStore = recoverRunningChild(fixture.path, fixture.key);
      recoveredStore.close();
      const recovered = recoverBatchState({
        path: fixture.path,
        batchId: created.batch.batchId,
        mode: "apply_safe",
      });
      expect(recovered.children[0]).toMatchObject({
        action: "inspection_required",
        applied: true,
        gatewayOperationId: outerOperationId,
        gatewayOperationState: "approved",
        sourceTaskId: "task:recover-binding",
        sourceResultState: "awaiting_confirmation",
      });

      const finalStore = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      expect(finalStore.get(created.batch.batchId).children[0]).toMatchObject({
        state: "unknown",
        gatewayOperationId: outerOperationId,
        gatewayOperationState: "approved",
        sourceTaskId: "task:recover-binding",
        sourceResultState: "awaiting_confirmation",
      });
      finalStore.close();
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps the outer effect binding on failed and inspection-required recovery", async () => {
    const failedFixture = await workspace("recover-binding-failed");
    const unknownFixture = await workspace("recover-binding-unknown");
    try {
      const failedOperationId = "operation:recover-binding-failed-1";
      const failedOuterId = "op:recover-binding-failed-outer-1";
      const failedStore = new DurableBatchStore({
        path: failedFixture.path,
        encryptionKey: failedFixture.key,
      });
      const failedBatch = createWriteBatch(failedStore, failedOperationId);
      failedStore.bindGatewayOperation(failedBatch.batch.batchId, "course:9", failedOuterId, "approved");
      failedStore.beginRun(failedBatch.batch.batchId, catalogDigest);
      failedStore.claimPending(failedBatch.batch.batchId, 1);
      const failedJournal = new GatewayOperationJournal({ path: failedFixture.path });
      prepareGatewayOperation(failedJournal, failedOperationId);
      failedJournal.close();
      const recoveredFailedJournal = new GatewayOperationJournal({ path: failedFixture.path });
      recoveredFailedJournal.close();
      failedStore.close();
      const reopenedFailedStore = recoverRunningChild(failedFixture.path, failedFixture.key);
      reopenedFailedStore.close();

      const failedRecovery = recoverBatchState({
        path: failedFixture.path,
        batchId: failedBatch.batch.batchId,
        mode: "apply_safe",
      });
      expect(failedRecovery.children[0]).toMatchObject({
        action: "failed_before_send",
        applied: true,
        gatewayOperationId: failedOuterId,
      });
      const failedFinal = new DurableBatchStore({ path: failedFixture.path, encryptionKey: failedFixture.key });
      expect(failedFinal.get(failedBatch.batch.batchId).children[0]).toMatchObject({
        state: "failed",
        gatewayOperationId: failedOuterId,
      });
      failedFinal.close();

      const unknownOperationId = "operation:recover-binding-unknown-1";
      const unknownOuterId = "op:recover-binding-unknown-outer-1";
      const unknownStore = new DurableBatchStore({
        path: unknownFixture.path,
        encryptionKey: unknownFixture.key,
      });
      const unknownBatch = createWriteBatch(unknownStore, unknownOperationId);
      unknownStore.bindGatewayOperation(unknownBatch.batch.batchId, "course:9", unknownOuterId, "dispatching");
      unknownStore.beginRun(unknownBatch.batch.batchId, catalogDigest);
      unknownStore.claimPending(unknownBatch.batch.batchId, 1);
      const unknownJournal = new GatewayOperationJournal({ path: unknownFixture.path });
      const unknownPrepared = prepareGatewayOperation(unknownJournal, unknownOperationId);
      unknownJournal.markDispatched(unknownPrepared.operationId);
      unknownJournal.close();
      const recoveredUnknownJournal = new GatewayOperationJournal({ path: unknownFixture.path });
      recoveredUnknownJournal.close();
      unknownStore.close();
      const reopenedUnknownStore = recoverRunningChild(unknownFixture.path, unknownFixture.key);
      reopenedUnknownStore.close();

      const unknownRecovery = recoverBatchState({
        path: unknownFixture.path,
        batchId: unknownBatch.batch.batchId,
        mode: "apply_safe",
      });
      expect(unknownRecovery.children[0]).toMatchObject({
        action: "inspection_required",
        applied: true,
        gatewayOperationId: unknownOuterId,
        gatewayOperationState: "dispatching",
      });
      const unknownFinal = new DurableBatchStore({ path: unknownFixture.path, encryptionKey: unknownFixture.key });
      expect(unknownFinal.get(unknownBatch.batch.batchId).children[0]).toMatchObject({
        state: "unknown",
        gatewayOperationId: unknownOuterId,
        gatewayOperationState: "dispatching",
      });
      unknownFinal.close();
    } finally {
      await rm(failedFixture.directory, { recursive: true, force: true });
      await rm(unknownFixture.directory, { recursive: true, force: true });
    }
  });

  it("completes a recovered staged task once its source settlement is terminal", async () => {
    const fixture = await workspace("recover-task-settled");
    try {
      const sourceOperationId = "operation:recover-settled-0001";
      const store = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      const created = createWriteBatch(store, sourceOperationId);
      store.beginRun(created.batch.batchId, catalogDigest);
      expect(store.claimPending(created.batch.batchId, 1)).toHaveLength(1);

      const journal = new GatewayOperationJournal({ path: fixture.path });
      const prepared = prepareGatewayOperation(journal, sourceOperationId);
      journal.markDispatched(prepared.operationId);
      journal.recordResponse(prepared.operationId, {
        upstreamResultDigest: sha256Text("staged-response"),
        normalizedResultDigest: sha256Text("normalized-staged-response"),
        responseSucceeded: true,
        sourceResultState: "completed",
        sourceTaskId: "task:recover-settled",
      });
      journal.close();
      store.close();

      const settlements = new BatchSourceSettlementStore({ path: fixture.path });
      settlements.initialize(created.batch.batchId, [{
        childId: "course:9",
        sourceId: "morrow-legacy",
        sourceBindingId: "canvas:9",
      }]);
      settlements.markStaged(created.batch.batchId, "course:9", {
        sourceTaskId: "task:recover-settled",
      });
      expect(settlements.applyTaskProjection(created.batch.batchId, "course:9", {
        taskId: "task:recover-settled",
        status: "completed",
        outcome: "succeeded",
        terminal: true,
        verificationStatus: "verified",
        resultCounts: { done: 1 },
      }).state).toBe("succeeded");
      settlements.close();

      const recoveredStore = recoverRunningChild(fixture.path, fixture.key);
      recoveredStore.close();
      const recovered = recoverBatchState({
        path: fixture.path,
        batchId: created.batch.batchId,
        mode: "apply_safe",
      });
      expect(recovered).toMatchObject({
        stateAfter: "completed",
        sourceTasksRecovered: 1,
        providerDispatches: 0,
      });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("settles a proven pre-send failure but leaves an uncertain write unreplayed", async () => {
    const failedFixture = await workspace("recover-failed-before-send");
    const unknownFixture = await workspace("recover-unknown-write");
    try {
      const failedOperationId = "operation:failed-before-send-1";
      const failedStore = new DurableBatchStore({
        path: failedFixture.path,
        encryptionKey: failedFixture.key,
      });
      const failedBatch = createWriteBatch(failedStore, failedOperationId);
      failedStore.beginRun(failedBatch.batch.batchId, catalogDigest);
      failedStore.claimPending(failedBatch.batch.batchId, 1);
      const failedJournal = new GatewayOperationJournal({ path: failedFixture.path });
      prepareGatewayOperation(failedJournal, failedOperationId);
      failedJournal.close();
      const recoveredFailedJournal = new GatewayOperationJournal({ path: failedFixture.path });
      recoveredFailedJournal.close();
      failedStore.close();
      const reopenedFailedStore = recoverRunningChild(failedFixture.path, failedFixture.key);
      reopenedFailedStore.close();

      const failedRecovery = recoverBatchState({
        path: failedFixture.path,
        batchId: failedBatch.batch.batchId,
        mode: "apply_safe",
      });
      expect(failedRecovery).toMatchObject({
        stateAfter: "failed",
        failedBeforeSend: 1,
        inspectionRequired: 0,
        providerDispatches: 0,
      });

      const unknownOperationId = "operation:unknown-write-0001";
      const unknownStore = new DurableBatchStore({
        path: unknownFixture.path,
        encryptionKey: unknownFixture.key,
      });
      const unknownBatch = createWriteBatch(unknownStore, unknownOperationId);
      unknownStore.beginRun(unknownBatch.batch.batchId, catalogDigest);
      unknownStore.claimPending(unknownBatch.batch.batchId, 1);
      const unknownJournal = new GatewayOperationJournal({ path: unknownFixture.path });
      const unknownPrepared = prepareGatewayOperation(unknownJournal, unknownOperationId);
      unknownJournal.markDispatched(unknownPrepared.operationId);
      unknownJournal.close();
      const recoveredUnknownJournal = new GatewayOperationJournal({ path: unknownFixture.path });
      recoveredUnknownJournal.close();
      unknownStore.close();
      const reopenedUnknownStore = recoverRunningChild(unknownFixture.path, unknownFixture.key);
      reopenedUnknownStore.close();

      const unknownRecovery = recoverBatchState({
        path: unknownFixture.path,
        batchId: unknownBatch.batch.batchId,
        mode: "apply_safe",
      });
      expect(unknownRecovery).toMatchObject({
        stateAfter: "inspection_required",
        failedBeforeSend: 0,
        inspectionRequired: 1,
        unknownChildrenAfter: 1,
        providerDispatches: 0,
      });
      expect(unknownRecovery.children[0]).toMatchObject({
        action: "inspection_required",
        applied: true,
        gatewayOperationState: "source_unknown",
      });
    } finally {
      await rm(failedFixture.directory, { recursive: true, force: true });
      await rm(unknownFixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps a failed recorded task failed and does not run a later child", async () => {
    const fixture = await workspace("recover-recorded-failed");
    try {
      const sourceOperationId = "operation:recover-recorded-failed-1";
      const store = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      const created = createWriteBatch(store, sourceOperationId, true);
      store.beginRun(created.batch.batchId, catalogDigest);
      expect(store.claimPending(created.batch.batchId, 1)).toHaveLength(1);
      const journal = new GatewayOperationJournal({ path: fixture.path });
      const prepared = prepareGatewayOperation(journal, sourceOperationId);
      journal.markDispatched(prepared.operationId);
      journal.recordResponse(prepared.operationId, {
        upstreamResultDigest: sha256Text("failed-staged-response"),
        normalizedResultDigest: sha256Text("normalized-failed-staged-response"),
        responseSucceeded: false,
        sourceResultState: "failed",
        sourceTaskId: "task:recover-failed",
      });
      journal.close();
      store.close();

      const recoveredStore = recoverRunningChild(fixture.path, fixture.key);
      recoveredStore.close();
      const recovered = recoverBatchState({
        path: fixture.path,
        batchId: created.batch.batchId,
        mode: "apply_safe",
      });
      expect(recovered.children[0]).toMatchObject({
        action: "recorded_result_failed",
        applied: true,
        sourceTaskId: "task:recover-failed",
        sourceResultState: "failed",
      });
      expect(recovered.sourceTasksRecovered).toBe(0);

      const finalStore = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      expect(finalStore.get(created.batch.batchId).children[0]).toMatchObject({
        state: "failed",
        sourceTaskId: "task:recover-failed",
        sourceResultState: "failed",
      });
      finalStore.beginRun(created.batch.batchId, catalogDigest);
      expect(finalStore.claimPending(created.batch.batchId, 2)).toEqual([]);
      expect(finalStore.get(created.batch.batchId).children[1]).toMatchObject({
        childId: "course:10",
        state: "unknown",
        gatewayOperationState: "dependency_unverified",
      });
      finalStore.close();
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps an issued task id when a later pre-send failure is the newest journal row", async () => {
    const fixture = await workspace("recover-later-presend");
    try {
      const sourceOperationId = "operation:recover-later-presend-1";
      let now = Date.parse("2026-03-01T00:00:00.000Z");
      const store = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      const created = createWriteBatch(store, sourceOperationId);
      store.beginRun(created.batch.batchId, catalogDigest);
      expect(store.claimPending(created.batch.batchId, 1)).toHaveLength(1);
      const journal = new GatewayOperationJournal({ path: fixture.path, now: () => new Date(now) });
      const prepared = prepareGatewayOperation(journal, sourceOperationId);
      journal.markDispatched(prepared.operationId);
      journal.recordResponse(prepared.operationId, {
        upstreamResultDigest: sha256Text("issued-staged-response"),
        normalizedResultDigest: sha256Text("normalized-issued-staged-response"),
        responseSucceeded: true,
        sourceResultState: "awaiting_confirmation",
        sourceTaskId: "task:issued-earlier",
      });
      now += 60_000;
      const retryRequest = { course_id: "9", _morrow: { operation_id: sourceOperationId }, retry: 1 };
      journal.prepare({
        publicToolName: "edit_page",
        sourceId: "morrow-legacy",
        sourceToolName: "edit_page",
        catalogDigest,
        requestDigest: sha256Json(retryRequest),
        forwardedRequestDigest: sha256Json(retryRequest),
        sourceOperationId,
        idempotencyKey: `${sourceOperationId}:retry`,
        readOnly: false,
      });
      journal.close();
      const restarted = new GatewayOperationJournal({ path: fixture.path, now: () => new Date(now) });
      restarted.close();
      store.close();

      const recoveredStore = recoverRunningChild(fixture.path, fixture.key);
      recoveredStore.close();
      const recovered = recoverBatchState({
        path: fixture.path,
        batchId: created.batch.batchId,
        mode: "apply_safe",
      });
      expect(recovered.children[0]).toMatchObject({
        action: "inspection_required",
        applied: true,
        sourceTaskId: "task:issued-earlier",
        sourceResultState: "awaiting_confirmation",
      });
      const finalStore = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      expect(finalStore.get(created.batch.batchId).children[0]).toMatchObject({
        state: "unknown",
        sourceTaskId: "task:issued-earlier",
        sourceResultState: "awaiting_confirmation",
      });
      expect(finalStore.get(created.batch.batchId).children[0]?.state).not.toBe("failed");
      finalStore.close();
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
