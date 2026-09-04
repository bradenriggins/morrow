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

type RatePolicy = NonNullable<RunBatchWindowOptions["ratePolicy"]>;

function mergeRateObservations(
  current: RatePolicy,
  observations: readonly (BatchExecutionResult["ratePolicy"] | undefined)[],
): RatePolicy {
  const valid = observations.filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (valid.length === 0) return { ...current, retryAfterMs: undefined };
  const requestCosts = valid.map((value) => value.requestCost).filter((value): value is number => (
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000
  ));
  const remainingValues = valid.map((value) => value.rateLimitRemaining).filter((value): value is number => (
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000
  ));
  const retryValues = valid.map((value) => value.retryAfterMs).filter((value): value is number => (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 300_000
  ));
  return {
    ...current,
    retryAfterMs: retryValues.length > 0 ? Math.max(...retryValues) : undefined,
    ...(requestCosts.length > 0 ? { requestCost: Math.max(...requestCosts) } : {}),
    ...(remainingValues.length > 0 ? { rateLimitRemaining: Math.min(...remainingValues) } : {}),
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
  const manifest = store.getManifest(batchId);
  const random = options.random || Math.random;
  const sleep = options.sleep || ((milliseconds: number) => new Promise<void>((resolveValue) => setTimeout(resolveValue, milliseconds)));
  let policy: RatePolicy = { ...manifest.ratePolicy, ...options.ratePolicy };
  let rate = windowRate(started, manifest, policy, random);
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
  const maxChildren = Math.max(1, Math.min(options.maxChildren ?? 50, 500));
  const claimed = store.claimPending(batchId, maxChildren);
  const settled: BatchChildRecord[] = [];
  let next = 0;
  let minimumConcurrency = rate.concurrency;
  let totalBackoffMs = 0;
  while (next < claimed.length) {
    if (rate.backoffMs > 0) {
      await sleep(rate.backoffMs);
      totalBackoffMs += rate.backoffMs;
      policy = { ...policy, retryAfterMs: undefined };
    }
    const wave = claimed.slice(next, next + rate.concurrency);
    next += wave.length;
    const executions = await Promise.all(wave.map(async (child) => {
      try {
        const argumentsValue = store.readArguments(child.batchId, child.childId);
        const result = await executor({ batch: started, child, arguments: argumentsValue });
        return { child, result };
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
        const digest = sha256Text(detail);
        return {
          child,
          result: {
            state: "unknown" as const,
            resultDigest: digest,
            errorDigest: digest,
            sourceResultState: "batch_executor_threw",
          },
        };
      }
    }));
    for (const execution of executions) {
      settled.push(store.settleChild(execution.child.batchId, execution.child.childId, execution.result));
    }
    policy = mergeRateObservations(policy, executions.map((execution) => execution.result.ratePolicy));
    rate = windowRate(started, manifest, policy, random);
    minimumConcurrency = Math.min(minimumConcurrency, rate.concurrency);
  }
  const batch = store.finishWindow(batchId);
  return {
    schema: "morrow.batch-window.v1",
    batch,
    processed: settled.length,
    remaining: batch.pendingChildren,
    children: settled,
    effectiveConcurrency: minimumConcurrency,
    backoffMs: totalBackoffMs,
  };
}
