import { describe, expect, it } from "vitest";
import { BatchSourceSettlementStore, DurableBatchStore } from "@morrow/batch-engine";
import {
  ProviderEffectBroker,
  effectOperationProjection,
  type EffectOperationRecord,
} from "@morrow/operation-journal";
import type { JsonObject } from "@morrow/contracts";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import type { GatewayRuntime } from "../src/runtime.js";

const catalogDigest = "c".repeat(64);

let sequence = 0;

function plan(broker: ProviderEffectBroker): EffectOperationRecord {
  const sourceOperationId = `operation:batch-atomic-${++sequence}`;
  return broker.create({
    publicToolName: "canvas_page_update",
    sourceId: "morrow-legacy",
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
  });
}

function harness(options: {
  readonly operationGet?: (broker: ProviderEffectBroker, operationId: string) => JsonObject;
  readonly clock?: { current: Date };
  readonly beforeApproval?: () => void;
} = {}): {
  runtime: MorrowRuntime;
  broker: ProviderEffectBroker;
  batchId: string;
  operations: readonly EffectOperationRecord[];
  close: () => void;
} {
  const clock = options.clock || { current: new Date() };
  const broker = new ProviderEffectBroker({ path: ":memory:", now: () => clock.current });
  const first = plan(broker);
  const second = plan(broker);
  const store = new DurableBatchStore({ path: ":memory:", encryptionKey: new Uint8Array(32).fill(7) });
  const created = store.create({
    name: "Atomic approval",
    mode: "stage_writes",
    catalogDigest,
    concurrency: 1,
    children: [
      {
        childId: "course:1",
        courseId: "42",
        publicToolName: "canvas_page_update",
        sourceId: "morrow-legacy",
        sourceToolName: "canvas_page_update",
        readOnly: false,
        sourceOperationId: first.sourceOperationId!,
        arguments: { course_id: "42", page_id: "42" },
      },
      {
        childId: "course:2",
        courseId: "43",
        publicToolName: "canvas_page_update",
        sourceId: "morrow-legacy",
        sourceToolName: "canvas_page_update",
        readOnly: false,
        sourceOperationId: second.sourceOperationId!,
        arguments: { course_id: "43", page_id: "43" },
      },
    ],
  });
  store.bindGatewayOperation(created.batch.batchId, "course:1", first.operationId, "awaiting_approval");
  store.bindGatewayOperation(created.batch.batchId, "course:2", second.operationId, "awaiting_approval");
  const settlements = new BatchSourceSettlementStore({ path: ":memory:" });
  const gateway = {
    config: { batchScheduler: { maxConcurrentReadWindows: 1 } },
    operationGet: (operationId: string) => options.operationGet
      ? options.operationGet(broker, operationId)
      : effectOperationProjection(broker.get(operationId)),
    approveOperation: (operationId: string) => effectOperationProjection(broker.approve(operationId)),
    approveOperations: (operationIds: readonly string[]) => {
      options.beforeApproval?.();
      return broker.approveAll(operationIds).map(effectOperationProjection);
    },
  } as unknown as GatewayRuntime;
  const runtime = new (MorrowRuntime as unknown as new (
    gateway: GatewayRuntime,
    batches: DurableBatchStore,
    settlements: BatchSourceSettlementStore,
    approval: unknown,
  ) => MorrowRuntime)(gateway, store, settlements, {});
  return {
    runtime,
    broker,
    batchId: created.batch.batchId,
    operations: [first, second],
    close: () => {
      settlements.close();
      store.close();
      broker.close();
    },
  };
}

describe("approveBatch atomicity", () => {
  it("leaves no grant when expiry crosses after preflight and before the write lock", () => {
    const clock = { current: new Date() };
    let expiry = 0;
    const fixture = harness({ clock, beforeApproval: () => { clock.current = new Date(expiry + 1); } });
    const realNow = Date.now;
    try {
      expiry = Date.parse(fixture.operations[0]!.approvalExpiresAt!);
      clock.current = new Date(expiry - 1);
      Date.now = () => clock.current.getTime();
      expect(() => fixture.runtime.approveBatch(fixture.batchId)).toThrow("batch approval preview expired");
      for (const operation of fixture.operations) {
        expect(fixture.broker.get(operation.operationId)).toMatchObject({ state: "awaiting_approval", approvalGrantDigest: null });
        expect(() => fixture.broker.reserveDispatch(operation.operationId)).toThrow("operation cannot dispatch from awaiting_approval");
      }
    } finally { Date.now = realNow; fixture.close(); }
  });

  it("approves every reviewed child together", () => {
    const fixture = harness();
    try {
      const approved = fixture.runtime.approveBatch(fixture.batchId);
      const children = approved.children as JsonObject[];
      expect(children.map((child) => (child.operation as JsonObject).state)).toEqual(["approved", "approved"]);
      expect(fixture.broker.get(fixture.operations[0]!.operationId).state).toBe("approved");
      expect(fixture.broker.get(fixture.operations[1]!.operationId).state).toBe("approved");
    } finally {
      fixture.close();
    }
  });

  it("approves nothing when a grant expired after the preview was read", () => {
    let reads = 0;
    const seen: string[] = [];
    const fixture = harness({
      operationGet: (broker, operationId) => {
        reads += 1;
        if (!seen.includes(operationId)) seen.push(operationId);
        const projection = effectOperationProjection(broker.get(operationId));
        // The preview render reads each child once; every later read sees the
        // first grant already past its expiry, as if time passed in between.
        if (reads > 2 && operationId === seen[0]) {
          return { ...projection, approvalExpiresAt: new Date(Date.now() - 1000).toISOString() };
        }
        return projection;
      },
    });
    try {
      expect(() => fixture.runtime.approveBatch(fixture.batchId)).toThrow("batch approval preview expired");
      expect(fixture.broker.get(fixture.operations[0]!.operationId).state).toBe("awaiting_approval");
      expect(fixture.broker.get(fixture.operations[1]!.operationId).state).toBe("awaiting_approval");
    } finally {
      fixture.close();
    }
  });

  it("refuses the whole durable approval group when its grants expired", () => {
    const clock = { current: new Date() };
    const fixture = harness({ clock });
    try {
      // Both grants expire behind the preview's back. The group transaction
      // refuses without persisting any approval or changing another child.
      clock.current = new Date(clock.current.getTime() + 16 * 60_000);
      expect(() => fixture.runtime.approveBatch(fixture.batchId)).toThrow("batch approval preview expired");
      expect(fixture.broker.get(fixture.operations[0]!.operationId).state).toBe("awaiting_approval");
      expect(fixture.broker.get(fixture.operations[1]!.operationId).state).toBe("awaiting_approval");
    } finally {
      fixture.close();
    }
  });
});
