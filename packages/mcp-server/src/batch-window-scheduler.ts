export interface BatchWindowSchedulerHealth {
  readonly schema: "morrow.batch-window-scheduler.health.v1";
  readonly open: boolean;
  readonly maxConcurrentWindows: number;
  readonly activeWindows: number;
  readonly waitingWindows: number;
  readonly runningBatchCount: number;
  readonly queuedBatchOperationCount: number;
}

export interface BatchWindowSchedulerOptions {
  readonly maxConcurrentWindows?: number;
}

interface PermitWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function exactWindowLimit(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new TypeError("maxConcurrentWindows must be a whole number from 1 through 16");
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

export class BatchWindowSchedulerClosedError extends Error {
  readonly code = "batch_scheduler_closed";

  constructor() {
    super("The Morrow batch window scheduler is closed.");
    this.name = "BatchWindowSchedulerClosedError";
  }
}

export class BatchWindowScheduler {
  readonly maxConcurrentWindows: number;

  private readonly tails = new Map<string, Promise<void>>();
  private readonly runningBatches = new Set<string>();
  private readonly permitWaiters: PermitWaiter[] = [];
  private activeWindows = 0;
  private queuedBatchOperations = 0;
  private open = true;

  constructor(options: BatchWindowSchedulerOptions = {}) {
    this.maxConcurrentWindows = exactWindowLimit(options.maxConcurrentWindows);
  }

  private assertOpen(): void {
    if (!this.open) throw new BatchWindowSchedulerClosedError();
  }

  private async acquireWindow(): Promise<void> {
    this.assertOpen();
    if (this.activeWindows < this.maxConcurrentWindows) {
      this.activeWindows += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.permitWaiters.push({ resolve, reject });
    });
  }

  private releaseWindow(): void {
    const next = this.permitWaiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.activeWindows = Math.max(0, this.activeWindows - 1);
  }

  async run<T>(batchIdValue: string, work: () => Promise<T> | T): Promise<T> {
    const batchId = exactBatchKey(batchIdValue);
    this.assertOpen();
    const previous = this.tails.get(batchId) || Promise.resolve();
    let releaseKey!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseKey = resolve;
    });
    const currentTail = previous.catch(() => undefined).then(() => currentGate);
    this.tails.set(batchId, currentTail);
    this.queuedBatchOperations += 1;

    await previous.catch(() => undefined);
    this.queuedBatchOperations = Math.max(0, this.queuedBatchOperations - 1);
    try {
      this.assertOpen();
      await this.acquireWindow();
      this.runningBatches.add(batchId);
      try {
        return await work();
      } finally {
        this.runningBatches.delete(batchId);
        this.releaseWindow();
      }
    } finally {
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
      maxConcurrentWindows: this.maxConcurrentWindows,
      activeWindows: this.activeWindows,
      waitingWindows: this.permitWaiters.length,
      runningBatchCount: this.runningBatches.size,
      queuedBatchOperationCount: this.queuedBatchOperations,
    };
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    const error = new BatchWindowSchedulerClosedError();
    for (const waiter of this.permitWaiters.splice(0)) waiter.reject(error);
  }
}
