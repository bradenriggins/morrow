import { MAX_READ_BATCH_CONCURRENCY } from "@morrow/batch-engine";

/** Whole milliseconds a run waits for a window another batch holds before Morrow refuses it. */
const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;
/** Runs allowed to wait for a batch window at one time. */
const MAX_QUEUED_WINDOWS = 32;
const UNATTRIBUTED_HOLDER = "unattributed";

/**
 * Read groups that may hold a batch window together, and the requests they may have in flight at
 * once. Both numbers come from a measurement on this machine, not from an assumption. The harness
 * ran 48 one-request read children of one frozen manifest through the loopback bridge, against a
 * connected fixture that answered every command after 25 milliseconds, which stands in for the
 * browser round trip:
 *
 *   4 requests in flight: one group frozen at 4, one window       488 ms
 *   4 requests in flight: two groups frozen at 4, one window      443 ms and 431 ms
 *   8 requests in flight: one group frozen at 8, one window       228 ms
 *   8 requests in flight: two groups frozen at 4, two windows     224 ms and 227 ms
 *
 * Two read groups at 4 each cost what one read group at 8 costs, so the path answers to the number
 * of requests in flight rather than to the number of groups. Eight is what the batch engine already
 * allows one frozen read manifest, so the read windows share that one budget: a group frozen at 4
 * runs beside another group frozen at 4, and a group frozen at 8 runs alone. The same harness with
 * an immediate fixture never had more than one request in flight and held 471 to 738 requests a
 * second at every window count from 1 through 4, so the extra window costs nothing when the browser
 * answers quickly. Sixteen requests in flight was faster again in the fixture, at 141 to 155 ms, but
 * that fixture has no anchor tab; every real command is injected into one tab for each site, and
 * that ceiling cannot be measured on this machine, so the budget stays at the frozen manifest limit.
 */
const DEFAULT_MAX_CONCURRENT_READ_WINDOWS = 2;
const MAX_CONCURRENT_READ_WINDOWS = MAX_READ_BATCH_CONCURRENCY;
/**
 * Morrow runs one write group at a time and runs no other group beside it. A staged write dispatches
 * an approved provider effect and settles from a fresh readback through the same anchor tab, so a
 * second group in flight would read Canvas while that readback decides the first group's outcome.
 */
const MAX_CONCURRENT_WRITE_WINDOWS = 1;

export type BatchWindowMode = "read_only" | "stage_writes";

export interface BatchWindowHolder {
  readonly batchId: string;
  readonly holder: string;
  readonly mode: BatchWindowMode;
  readonly concurrency: number;
  readonly startedAt: string;
}

export interface BatchWindowWaiting {
  readonly batchId: string;
  readonly holder: string;
  readonly mode: BatchWindowMode;
  readonly concurrency: number;
  readonly queuedAt: string;
}

export interface BatchWindowSchedulerHealth {
  readonly schema: "morrow.batch-window-scheduler.health.v1";
  readonly open: boolean;
  readonly maxConcurrentReadWindows: number;
  readonly maxConcurrentWriteWindows: number;
  readonly maxConcurrentReadRequests: number;
  readonly maxQueuedWindows: number;
  readonly queueTimeoutMs: number;
  readonly activeWindows: number;
  readonly activeReadWindows: number;
  readonly activeWriteWindows: number;
  readonly activeReadRequests: number;
  readonly waitingWindows: number;
  readonly runningBatchCount: number;
  readonly queuedBatchOperationCount: number;
  readonly activeBatches: readonly BatchWindowHolder[];
  readonly waiting: readonly BatchWindowWaiting[];
}

export interface BatchWindowSchedulerOptions {
  readonly maxConcurrentReadWindows?: number;
}

export interface BatchWindowRunOptions {
  /** Stops the queue wait as soon as the calling request is cancelled. */
  readonly signal?: AbortSignal;
  /** Whole milliseconds to wait for a window another batch holds. 0 waits without a deadline. */
  readonly queueTimeoutMs?: number;
  /** Plain label for the caller that asked for this window. */
  readonly holder?: string;
  /** The frozen mode of this batch. A run that does not name one claims the strictest window. */
  readonly mode?: BatchWindowMode;
  /** The frozen request rate of this batch. A read run that does not name one claims the whole read budget. */
  readonly concurrency?: number;
}

interface WindowRequest {
  readonly batchId: string;
  readonly holder: string;
  readonly mode: BatchWindowMode;
  readonly concurrency: number;
  readonly queueTimeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

interface PermitWaiter {
  readonly request: WindowRequest;
  readonly queuedAt: string;
  granted: boolean;
  readonly promise: Promise<void>;
  readonly grant: () => void;
  readonly fail: (error: Error) => void;
}

function exactReadWindowLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CONCURRENT_READ_WINDOWS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENT_READ_WINDOWS) {
    throw new TypeError(
      `maxConcurrentReadWindows must be a whole number from 1 through ${MAX_CONCURRENT_READ_WINDOWS}`,
    );
  }
  return value;
}

function exactRunConcurrency(value: number | undefined): number {
  if (value === undefined) return MAX_READ_BATCH_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_READ_BATCH_CONCURRENCY) {
    throw new TypeError(
      `batch window concurrency must be a whole number from 1 through ${MAX_READ_BATCH_CONCURRENCY}`,
    );
  }
  return value;
}

function exactQueueTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_QUEUE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 0 || value > 3_600_000) {
    throw new TypeError("queueTimeoutMs must be a whole number of milliseconds from 0 through 3600000");
  }
  return value;
}

function exactBatchKey(value: string): string {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_.:@-]{1,160}$/.test(normalized)) {
    throw new TypeError("batch scheduler key has an invalid format");
  }
  return normalized;
}

/** Keeps a caller label printable and bounded, because it is shown to a person. */
function exactHolderLabel(value: string | undefined): string {
  const printable = Array.from(String(value ?? ""))
    .filter((character) => character >= " " && character <= "~")
    .join("")
    .trim()
    .slice(0, 160);
  return printable || UNATTRIBUTED_HOLDER;
}

function holderSummary(activeBatches: readonly BatchWindowHolder[]): string {
  const current = activeBatches[0];
  if (!current) return "No group holds a batch window now.";
  return `Group ${current.batchId} holds a batch window. It started at ${current.startedAt} for ${current.holder}.`;
}

export class BatchWindowSchedulerClosedError extends Error {
  readonly code = "batch_scheduler_closed";

  constructor() {
    super("The Morrow batch window scheduler is closed.");
    this.name = "BatchWindowSchedulerClosedError";
  }
}

export class BatchWindowQueueAbortedError extends Error {
  readonly code = "batch_window_queue_aborted";
  readonly batchId: string;
  readonly holder: string;

  constructor(input: { readonly batchId: string; readonly holder: string }) {
    super("Morrow stopped waiting for a batch window because the caller cancelled the request.");
    this.name = "BatchWindowQueueAbortedError";
    this.batchId = input.batchId;
    this.holder = input.holder;
  }
}

export class BatchWindowQueueTimeoutError extends Error {
  readonly code = "batch_window_queue_timeout";
  readonly batchId: string;
  readonly holder: string;
  readonly waitedMs: number;
  readonly queueDepth: number;
  readonly activeBatches: readonly BatchWindowHolder[];

  constructor(input: {
    readonly batchId: string;
    readonly holder: string;
    readonly waitedMs: number;
    readonly queueDepth: number;
    readonly activeBatches: readonly BatchWindowHolder[];
  }) {
    super(
      `Morrow waited ${Math.round(input.waitedMs / 1000)} seconds for a batch window and did not start this run. `
      + holderSummary(input.activeBatches),
    );
    this.name = "BatchWindowQueueTimeoutError";
    this.batchId = input.batchId;
    this.holder = input.holder;
    this.waitedMs = input.waitedMs;
    this.queueDepth = input.queueDepth;
    this.activeBatches = input.activeBatches;
  }
}

export class BatchWindowQueueFullError extends Error {
  readonly code = "batch_window_queue_full";
  readonly batchId: string;
  readonly holder: string;
  readonly queueDepth: number;
  readonly maxQueuedWindows: number;
  readonly activeBatches: readonly BatchWindowHolder[];

  constructor(input: {
    readonly batchId: string;
    readonly holder: string;
    readonly queueDepth: number;
    readonly maxQueuedWindows: number;
    readonly activeBatches: readonly BatchWindowHolder[];
  }) {
    super(
      `Morrow did not start this run. ${input.queueDepth} runs already wait for a batch window, `
      + `and Morrow allows ${input.maxQueuedWindows}. ${holderSummary(input.activeBatches)}`,
    );
    this.name = "BatchWindowQueueFullError";
    this.batchId = input.batchId;
    this.holder = input.holder;
    this.queueDepth = input.queueDepth;
    this.maxQueuedWindows = input.maxQueuedWindows;
    this.activeBatches = input.activeBatches;
  }
}

export class BatchWindowScheduler {
  readonly maxConcurrentReadWindows: number;
  readonly maxConcurrentWriteWindows = MAX_CONCURRENT_WRITE_WINDOWS;
  readonly maxConcurrentReadRequests = MAX_READ_BATCH_CONCURRENCY;
  readonly maxQueuedWindows = MAX_QUEUED_WINDOWS;
  readonly defaultQueueTimeoutMs = DEFAULT_QUEUE_TIMEOUT_MS;

  private readonly tails = new Map<string, Promise<void>>();
  private readonly runningBatches = new Map<string, BatchWindowHolder>();
  private readonly permitWaiters: PermitWaiter[] = [];
  private activeReadWindows = 0;
  private activeWriteWindows = 0;
  private activeReadRequests = 0;
  private queuedBatchOperations = 0;
  private open = true;

  constructor(options: BatchWindowSchedulerOptions = {}) {
    this.maxConcurrentReadWindows = exactReadWindowLimit(options.maxConcurrentReadWindows);
  }

  private assertOpen(): void {
    if (!this.open) throw new BatchWindowSchedulerClosedError();
  }

  private activeBatchList(): readonly BatchWindowHolder[] {
    return [...this.runningBatches.values()];
  }

  private queueTimeoutError(request: WindowRequest): BatchWindowQueueTimeoutError {
    return new BatchWindowQueueTimeoutError({
      batchId: request.batchId,
      holder: request.holder,
      waitedMs: request.queueTimeoutMs,
      queueDepth: this.permitWaiters.length,
      activeBatches: this.activeBatchList(),
    });
  }

  /**
   * Waits for one queue step. The wait stops on caller cancellation, and on the deadline when the
   * caller gives one. `deadlineAt` is epoch milliseconds; 0 waits without a deadline.
   */
  private waitInQueue(pending: Promise<unknown>, request: WindowRequest, deadlineAt: number): Promise<void> {
    if (!request.signal && deadlineAt === 0) return pending.then(() => undefined);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let detachAbort: (() => void) | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        detachAbort?.();
        if (error) reject(error);
        else resolve();
      };
      pending.then(
        () => finish(),
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      );
      if (request.signal) {
        if (request.signal.aborted) {
          finish(new BatchWindowQueueAbortedError({ batchId: request.batchId, holder: request.holder }));
          return;
        }
        const onAbort = (): void => finish(
          new BatchWindowQueueAbortedError({ batchId: request.batchId, holder: request.holder }),
        );
        request.signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => request.signal?.removeEventListener("abort", onAbort);
      }
      if (deadlineAt > 0) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          finish(this.queueTimeoutError(request));
          return;
        }
        timer = setTimeout(() => finish(this.queueTimeoutError(request)), remaining);
        timer.unref?.();
      }
    });
  }

  private enqueueWaiter(request: WindowRequest): PermitWaiter {
    let grant!: () => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      grant = resolve;
      fail = reject;
    });
    const waiter: PermitWaiter = {
      request,
      queuedAt: new Date().toISOString(),
      granted: false,
      promise,
      grant: () => {
        waiter.granted = true;
        grant();
      },
      fail,
    };
    this.permitWaiters.push(waiter);
    return waiter;
  }

  private dropWaiter(waiter: PermitWaiter): void {
    const index = this.permitWaiters.indexOf(waiter);
    if (index < 0) return;
    this.permitWaiters.splice(index, 1);
    this.startWaitingRuns();
  }

  /**
   * Reports whether this run fits beside the runs that hold windows now. A write group runs alone:
   * it waits for every read window, and no other group starts while it holds one.
   */
  private windowFits(request: WindowRequest): boolean {
    if (this.activeWriteWindows > 0) return false;
    if (request.mode === "stage_writes") return this.activeReadWindows === 0;
    return this.activeReadWindows < this.maxConcurrentReadWindows
      && this.activeReadRequests + request.concurrency <= this.maxConcurrentReadRequests;
  }

  private takeWindow(request: WindowRequest): void {
    if (request.mode === "stage_writes") {
      this.activeWriteWindows += 1;
      return;
    }
    this.activeReadWindows += 1;
    this.activeReadRequests += request.concurrency;
  }

  /**
   * Starts the waiting runs at the head of the queue that fit now. It stops at the first run that
   * does not fit, so a group that asked for the whole read budget is not passed over indefinitely.
   */
  private startWaitingRuns(): void {
    while (this.permitWaiters.length > 0) {
      const next = this.permitWaiters[0]!;
      if (!this.windowFits(next.request)) return;
      this.permitWaiters.shift();
      this.takeWindow(next.request);
      next.grant();
    }
  }

  private async acquireWindow(request: WindowRequest): Promise<void> {
    this.assertOpen();
    if (this.permitWaiters.length === 0 && this.windowFits(request)) {
      this.takeWindow(request);
      return;
    }
    if (request.signal?.aborted) {
      throw new BatchWindowQueueAbortedError({ batchId: request.batchId, holder: request.holder });
    }
    if (this.permitWaiters.length >= this.maxQueuedWindows) {
      throw new BatchWindowQueueFullError({
        batchId: request.batchId,
        holder: request.holder,
        queueDepth: this.permitWaiters.length,
        maxQueuedWindows: this.maxQueuedWindows,
        activeBatches: this.activeBatchList(),
      });
    }
    const waiter = this.enqueueWaiter(request);
    const deadlineAt = request.queueTimeoutMs > 0 ? Date.now() + request.queueTimeoutMs : 0;
    try {
      await this.waitInQueue(waiter.promise, request, deadlineAt);
    } catch (error) {
      if (waiter.granted) this.releaseWindow(request);
      else this.dropWaiter(waiter);
      throw error;
    }
  }

  private releaseWindow(request: WindowRequest): void {
    if (request.mode === "stage_writes") {
      this.activeWriteWindows = Math.max(0, this.activeWriteWindows - 1);
    } else {
      this.activeReadWindows = Math.max(0, this.activeReadWindows - 1);
      this.activeReadRequests = Math.max(0, this.activeReadRequests - request.concurrency);
    }
    this.startWaitingRuns();
  }

  async run<T>(
    batchIdValue: string,
    work: () => Promise<T> | T,
    options: BatchWindowRunOptions = {},
  ): Promise<T> {
    const batchId = exactBatchKey(batchIdValue);
    const mode = options.mode ?? "stage_writes";
    const request: WindowRequest = {
      batchId,
      holder: exactHolderLabel(options.holder),
      mode,
      // A write window holds no share of the read budget, so an unnamed write rate reports as one.
      concurrency: exactRunConcurrency(mode === "stage_writes" ? options.concurrency ?? 1 : options.concurrency),
      queueTimeoutMs: exactQueueTimeout(options.queueTimeoutMs),
      signal: options.signal,
    };
    this.assertOpen();
    const previous = this.tails.get(batchId) || Promise.resolve();
    let releaseKey!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseKey = resolve;
    });
    const currentTail = previous.catch(() => undefined).then(() => currentGate);
    this.tails.set(batchId, currentTail);
    this.queuedBatchOperations += 1;
    let counted = true;
    const uncount = (): void => {
      if (!counted) return;
      counted = false;
      this.queuedBatchOperations = Math.max(0, this.queuedBatchOperations - 1);
    };

    try {
      // Two runs of one batch take turns without a deadline. Three assistants share one batch this
      // way, so a refusal here would drop work the caller meant to divide. Cancellation still applies.
      await this.waitInQueue(previous.catch(() => undefined), request, 0);
      uncount();
      this.assertOpen();
      await this.acquireWindow(request);
      this.runningBatches.set(batchId, {
        batchId,
        holder: request.holder,
        mode: request.mode,
        concurrency: request.concurrency,
        startedAt: new Date().toISOString(),
      });
      try {
        return await work();
      } finally {
        this.runningBatches.delete(batchId);
        this.releaseWindow(request);
      }
    } finally {
      uncount();
      releaseKey();
      if (this.tails.get(batchId) === currentTail) {
        this.tails.delete(batchId);
      }
    }
  }

  health(): BatchWindowSchedulerHealth {
    return {
      schema: "morrow.batch-window-scheduler.health.v1",
      open: this.open,
      maxConcurrentReadWindows: this.maxConcurrentReadWindows,
      maxConcurrentWriteWindows: this.maxConcurrentWriteWindows,
      maxConcurrentReadRequests: this.maxConcurrentReadRequests,
      maxQueuedWindows: this.maxQueuedWindows,
      queueTimeoutMs: this.defaultQueueTimeoutMs,
      activeWindows: this.activeReadWindows + this.activeWriteWindows,
      activeReadWindows: this.activeReadWindows,
      activeWriteWindows: this.activeWriteWindows,
      activeReadRequests: this.activeReadRequests,
      waitingWindows: this.permitWaiters.length,
      runningBatchCount: this.runningBatches.size,
      queuedBatchOperationCount: this.queuedBatchOperations,
      activeBatches: this.activeBatchList(),
      waiting: this.permitWaiters.map((waiter) => ({
        batchId: waiter.request.batchId,
        holder: waiter.request.holder,
        mode: waiter.request.mode,
        concurrency: waiter.request.concurrency,
        queuedAt: waiter.queuedAt,
      })),
    };
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    const error = new BatchWindowSchedulerClosedError();
    for (const waiter of this.permitWaiters.splice(0)) waiter.fail(error);
  }
}
