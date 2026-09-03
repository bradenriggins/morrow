import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayOperationJournal } from "@morrow/operation-journal";
import { sha256Json, sha256Text } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import {
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

function createWriteBatch(store: DurableBatchStore, sourceOperationId: string) {
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
    }],
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

  it("recovers a known staged task from the gateway journal without resending it", async () => {
    const fixture = await workspace("recover-task");
    try {
      const sourceOperationId = "operation:recover-task-0001";
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
        stateAfter: "completed",
        sourceTasksRecovered: 1,
        inspectionRequired: 0,
        providerDispatches: 0,
      });
      expect(recovered.children[0]).toMatchObject({
        action: "source_task_recovered",
        applied: true,
        sourceTaskId: "task:recover-9",
      });

      const finalStore = new DurableBatchStore({ path: fixture.path, encryptionKey: fixture.key });
      expect(finalStore.get(created.batch.batchId).children[0]).toMatchObject({
        state: "succeeded",
        sourceTaskId: "task:recover-9",
        sourceResultState: "awaiting_confirmation",
      });
      finalStore.close();
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
});
