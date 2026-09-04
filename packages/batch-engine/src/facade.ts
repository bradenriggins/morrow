import {
  DurableBatchStore as InternalDurableBatchStore,
  type BatchChildRecord,
  type BatchDetail,
  type BatchExecutionResult,
  type BatchExecutor,
  type BatchRecord,
  type BatchState,
  type BatchWindowResult,
  type CreateBatchInput,
  type DurableBatchStoreOptions,
  type FrozenBatchManifest,
  type RunBatchWindowOptions,
} from "./index.js";
import { sha256Text, type JsonObject } from "@morrow/contracts";

const TERMINAL_BATCH_STATES = new Set<BatchState>([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "inspection_required",
]);

export interface BatchStoreHealth {
  readonly schema: "morrow.batch-store.health.v1";
  readonly path: string;
  readonly open: boolean;
  readonly totalBatches: number;
  readonly activeBatches: number;
  readonly inspectionRequiredBatches: number;
}

export interface BatchChildrenPage {
  readonly batch: BatchRecord;
  readonly offset: number;
  readonly returned: number;
  readonly nextOffset: number | null;
  readonly children: readonly BatchChildRecord[];
}

export class DurableBatchStore {
  readonly path: string;
  private readonly inner: InternalDurableBatchStore;
  private closed = false;

  constructor(options: DurableBatchStoreOptions) {
    this.inner = new InternalDurableBatchStore(options);
    this.path = this.inner.path;
  }

  create(input: CreateBatchInput): BatchDetail {
    return this.inner.create(input);
  }

  getBatch(batchId: string): BatchRecord {
    return this.inner.getBatch(batchId);
  }

  get(batchId: string): BatchDetail {
    return this.inner.get(batchId);
  }

  getManifest(batchId: string): FrozenBatchManifest {
    return this.inner.getManifest(batchId);
  }

  bindGatewayOperation(
    batchId: string,
    childId: string,
    operationId: string,
    operationState: string,
  ): BatchChildRecord {
    return this.inner.bindGatewayOperation(batchId, childId, operationId, operationState);
  }

  deferSourceSettlement(batchId: string): BatchRecord {
    return this.inner.deferSourceSettlement(batchId);
  }

  finalizeSourceSettlement(
    batchId: string,
    state: "completed" | "partial" | "failed" | "cancelled" | "inspection_required",
  ): BatchRecord {
    return this.inner.finalizeSourceSettlement(batchId, state);
  }

  list(limit = 50): readonly BatchRecord[] {
    return this.inner.list(limit);
  }

  listPage(offset = 0, limit = 100) {
    return this.inner.listPage(offset, limit);
  }

  listChildren(batchId: string, offsetValue = 0, limitValue = 100): BatchChildrenPage {
    return this.inner.listChildren(batchId, offsetValue, limitValue);
  }

  listNonterminal(offset = 0, limit = 100) {
    return this.inner.listNonterminal(offset, limit);
  }

  pause(batchId: string): BatchRecord {
    return this.inner.pause(batchId);
  }

  cancel(batchId: string): BatchRecord {
    return this.inner.cancel(batchId);
  }

  quarantine(batchId: string): BatchRecord {
    return this.inner.quarantine(batchId);
  }

  beginRun(
    batchId: string,
    expectedCatalogDigest: string,
    expected: { readonly courseSetDigest?: string; readonly profileDigest?: string } = {},
  ): BatchRecord {
    try {
      return this.inner.beginRun(batchId, expectedCatalogDigest, expected);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("stale") || message.includes("expired")) {
        this.inner.pause(batchId);
      }
      throw error;
    }
  }

  resume(
    batchId: string,
    expectedCatalogDigest: string,
    expected: { readonly courseSetDigest?: string; readonly profileDigest?: string } = {},
  ): BatchRecord {
    return this.beginRun(batchId, expectedCatalogDigest, expected);
  }

  claimPending(batchId: string, limit: number): readonly BatchChildRecord[] {
    return this.inner.claimPending(batchId, limit);
  }

  readArguments(batchId: string, childId: string): JsonObject {
    return this.inner.readArguments(batchId, childId);
  }

  settleChild(
    batchId: string,
    childId: string,
    result: BatchExecutionResult,
  ): BatchChildRecord {
    return this.inner.settleChild(batchId, childId, result);
  }

  finishWindow(batchId: string): BatchRecord {
    return this.inner.finishWindow(batchId);
  }

  health(): BatchStoreHealth {
    const batches = this.inner.list(200);
    return {
      schema: "morrow.batch-store.health.v1",
      path: this.path,
      open: !this.closed,
      totalBatches: batches.length,
      activeBatches: batches.filter((batch) => ["planned", "running", "paused"].includes(batch.state)).length,
      inspectionRequiredBatches: batches.filter((batch) => batch.state === "inspection_required").length,
    };
  }

  close(): void {
    if (this.closed) return;
    this.inner.close();
    this.closed = true;
  }
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

function windowRate(
  batch: BatchRecord,
  manifest: FrozenBatchManifest,
  override: RunBatchWindowOptions["ratePolicy"],
  random: () => number,
): { concurrency: number; backoffMs: number } {
  const policy = { ...manifest.ratePolicy, ...override };
  let concurrency = batch.concurrency;
  if (policy.requestCost && policy.rateLimitRemaining !== undefined) {
    concurrency = Math.min(concurrency, Math.max(1, Math.floor(policy.rateLimitRemaining / policy.requestCost)));
  }
  const retryAfterMs = policy.retryAfterMs || 0;
  const jitterRatio = policy.jitterRatio ?? 0.1;
  const boundedRandom = Math.max(0, Math.min(1, random()));
  return {
    concurrency,
    backoffMs: retryAfterMs + Math.floor(retryAfterMs * jitterRatio * boundedRandom),
  };
}

export async function runBatchWindow(
  store: DurableBatchStore,
  batchId: string,
  executor: BatchExecutor,
  options: RunBatchWindowOptions,
): Promise<BatchWindowResult> {
  const started = store.beginRun(batchId, options.expectedCatalogDigest, {
    ...(options.expectedCourseSetDigest ? { courseSetDigest: options.expectedCourseSetDigest } : {}),
    ...(options.expectedProfileDigest ? { profileDigest: options.expectedProfileDigest } : {}),
  });
  const rate = windowRate(started, store.getManifest(batchId), options.ratePolicy, options.random || Math.random);
  if (TERMINAL_BATCH_STATES.has(started.state)) {
    return {
      schema: "morrow.batch-window.v1",
      batch: started,
      processed: 0,
      remaining: 0,
      children: [],
      effectiveConcurrency: rate.concurrency,
      backoffMs: 0,
    };
  }
  if (rate.backoffMs > 0) {
    await (options.sleep || ((milliseconds) => new Promise<void>((resolveValue) => setTimeout(resolveValue, milliseconds))))(rate.backoffMs);
  }
  const maxChildren = Math.max(1, Math.min(options.maxChildren ?? 50, 500));
  const claimed = store.claimPending(batchId, maxChildren);
  const settled = await mapLimit(claimed, rate.concurrency, async (child) => {
    try {
      const argumentsValue = store.readArguments(child.batchId, child.childId);
      const result = await executor({ batch: started, child, arguments: argumentsValue });
      return store.settleChild(child.batchId, child.childId, result);
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      const digest = sha256Text(detail);
      return store.settleChild(child.batchId, child.childId, {
        state: "unknown",
        resultDigest: digest,
        errorDigest: digest,
        sourceResultState: "batch_executor_threw",
      });
    }
  });
  const batch = store.finishWindow(batchId);
  return {
    schema: "morrow.batch-window.v1",
    batch,
    processed: settled.length,
    remaining: batch.pendingChildren,
    children: settled,
    effectiveConcurrency: rate.concurrency,
    backoffMs: rate.backoffMs,
  };
}
