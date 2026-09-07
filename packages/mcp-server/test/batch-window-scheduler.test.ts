import { describe, expect, it } from "vitest";
import {
  BatchWindowQueueAbortedError,
  BatchWindowQueueFullError,
  BatchWindowQueueTimeoutError,
  BatchWindowScheduler,
  BatchWindowSchedulerClosedError,
} from "../src/batch-window-scheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("scheduler state did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("BatchWindowScheduler", () => {
  it("serializes work for the same batch and preserves submission order", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 2 });
    const firstGate = deferred();
    const events: string[] = [];
    const first = scheduler.run("batch:one", async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
      return 1;
    });
    const second = scheduler.run("batch:one", async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await waitUntil(() => events.length === 1);
    expect(events).toEqual(["first:start"]);
    expect(scheduler.health()).toMatchObject({
      runningBatchCount: 1,
      queuedBatchOperationCount: 1,
    });
    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(scheduler.health()).toMatchObject({
      activeWindows: 0,
      runningBatchCount: 0,
      queuedBatchOperationCount: 0,
    });
    scheduler.close();
  });

  it("caps active windows across different batches", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let active = 0;
    let maximumActive = 0;
    const jobs = gates.map((gate, index) => scheduler.run(`batch:${index + 1}`, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate.promise;
      active -= 1;
      return index;
    }, { mode: "read_only", concurrency: 4 }));

    await waitUntil(() => scheduler.health().waitingWindows === 2);
    expect(scheduler.health()).toMatchObject({
      activeWindows: 2,
      waitingWindows: 2,
      runningBatchCount: 2,
    });
    gates[0]!.resolve();
    gates[1]!.resolve();
    await waitUntil(() => scheduler.health().waitingWindows === 0);
    expect(scheduler.health()).toMatchObject({
      activeWindows: 2,
      waitingWindows: 0,
      runningBatchCount: 2,
    });
    gates[2]!.resolve();
    gates[3]!.resolve();
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3]);
    expect(maximumActive).toBe(2);
    scheduler.close();
  });

  it("rejects queued windows after close without starting them", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 1 });
    const runningGate = deferred();
    let queuedStarted = false;
    const running = scheduler.run("batch:running", () => runningGate.promise);
    const queued = scheduler.run("batch:queued", async () => {
      queuedStarted = true;
    });
    await waitUntil(() => scheduler.health().waitingWindows === 1);
    expect(scheduler.health().waitingWindows).toBe(1);
    scheduler.close();
    await expect(queued).rejects.toBeInstanceOf(BatchWindowSchedulerClosedError);
    expect(queuedStarted).toBe(false);
    runningGate.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(scheduler.health().open).toBe(false);
  });

  it("reports which batch holds each window and which runs wait for one", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 1 });
    const holdingGate = deferred();
    const holding = scheduler.run("batch:holding", () => holdingGate.promise, { holder: "claude-session-1" });
    await waitUntil(() => scheduler.health().activeWindows === 1);
    const waiting = scheduler.run("batch:waiting", async () => "second", { queueTimeoutMs: 0 });
    await waitUntil(() => scheduler.health().waitingWindows === 1);

    const health = scheduler.health();
    expect(health.maxQueuedWindows).toBe(32);
    expect(health.queueTimeoutMs).toBe(60_000);
    expect(health.maxConcurrentReadWindows).toBe(1);
    expect(health.maxConcurrentWriteWindows).toBe(1);
    expect(health.maxConcurrentReadRequests).toBe(8);
    expect(health.activeBatches).toEqual([
      {
        batchId: "batch:holding",
        holder: "claude-session-1",
        mode: "stage_writes",
        concurrency: 1,
        startedAt: expect.any(String),
      },
    ]);
    expect(Number.isNaN(Date.parse(health.activeBatches[0]!.startedAt))).toBe(false);
    expect(health.waiting).toEqual([
      {
        batchId: "batch:waiting",
        holder: "unattributed",
        mode: "stage_writes",
        concurrency: 1,
        queuedAt: expect.any(String),
      },
    ]);

    holdingGate.resolve();
    await expect(holding).resolves.toBeUndefined();
    await expect(waiting).resolves.toBe("second");
    expect(scheduler.health()).toMatchObject({ activeBatches: [], waiting: [], activeWindows: 0 });
    scheduler.close();
  });

  it("removes a queued run when the caller cancels, and never starts its work", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 1 });
    const holdingGate = deferred();
    const holding = scheduler.run("batch:holding", () => holdingGate.promise, { holder: "session-a" });
    await waitUntil(() => scheduler.health().activeWindows === 1);
    const cancel = new AbortController();
    let queuedStarted = false;
    const queued = scheduler.run("batch:cancelled", async () => {
      queuedStarted = true;
    }, { signal: cancel.signal, holder: "session-b" });
    await waitUntil(() => scheduler.health().waitingWindows === 1);

    cancel.abort();
    const error = await queued.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BatchWindowQueueAbortedError);
    expect((error as BatchWindowQueueAbortedError).batchId).toBe("batch:cancelled");
    expect(queuedStarted).toBe(false);
    expect(scheduler.health()).toMatchObject({ waitingWindows: 0, waiting: [], activeWindows: 1 });

    holdingGate.resolve();
    await expect(holding).resolves.toBeUndefined();
    await expect(scheduler.run("batch:after", async () => "free")).resolves.toBe("free");
    scheduler.close();
  });

  it("refuses an already cancelled caller without queueing it", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 1 });
    const holdingGate = deferred();
    const holding = scheduler.run("batch:holding", () => holdingGate.promise, { holder: "session-a" });
    await waitUntil(() => scheduler.health().activeWindows === 1);
    const cancel = new AbortController();
    cancel.abort();

    const error = await scheduler.run("batch:cancelled", async () => "started", { signal: cancel.signal })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BatchWindowQueueAbortedError);
    expect(scheduler.health().waitingWindows).toBe(0);

    holdingGate.resolve();
    await expect(holding).resolves.toBeUndefined();
    scheduler.close();
  });

  it("stops a queued run at the queue timeout and names the batch that holds the window", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 1 });
    const holdingGate = deferred();
    const holding = scheduler.run("batch:inventory", () => holdingGate.promise, { holder: "session-a" });
    await waitUntil(() => scheduler.health().activeWindows === 1);
    const startedAt = scheduler.health().activeBatches[0]!.startedAt;
    let queuedStarted = false;
    const queued = scheduler.run("batch:audit", async () => {
      queuedStarted = true;
    }, { queueTimeoutMs: 25, holder: "session-b" });

    const error = await queued.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BatchWindowQueueTimeoutError);
    const timeout = error as BatchWindowQueueTimeoutError;
    expect(timeout.batchId).toBe("batch:audit");
    expect(timeout.holder).toBe("session-b");
    expect(timeout.waitedMs).toBe(25);
    expect(timeout.queueDepth).toBe(1);
    expect(timeout.activeBatches).toEqual([
      { batchId: "batch:inventory", holder: "session-a", mode: "stage_writes", concurrency: 1, startedAt },
    ]);
    expect(timeout.message).toContain("Group batch:inventory holds a batch window");
    expect(queuedStarted).toBe(false);
    expect(scheduler.health()).toMatchObject({ waitingWindows: 0, activeWindows: 1 });

    holdingGate.resolve();
    await expect(holding).resolves.toBeUndefined();
    await expect(scheduler.run("batch:later", async () => "free")).resolves.toBe("free");
    scheduler.close();
  });

  it("lets two runs of one batch take turns, and cancels the second on request", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 2 });
    const holdingGate = deferred();
    const holding = scheduler.run("batch:same", () => holdingGate.promise, { holder: "session-a" });
    await waitUntil(() => scheduler.health().runningBatchCount === 1);
    const cancel = new AbortController();
    let cancelledStarted = false;
    const cancelled = scheduler.run("batch:same", async () => {
      cancelledStarted = true;
    }, { signal: cancel.signal, queueTimeoutMs: 25, holder: "session-b" });
    let waitingStarted = false;
    const waiting = scheduler.run("batch:same", async () => {
      waitingStarted = true;
      return "second turn";
    }, { queueTimeoutMs: 25, holder: "session-c" });
    await waitUntil(() => scheduler.health().queuedBatchOperationCount === 2);

    cancel.abort();
    const error = await cancelled.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BatchWindowQueueAbortedError);
    expect(cancelledStarted).toBe(false);
    // A same-batch turn has no deadline, so the third run is still waiting after its 25 ms timeout.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(waitingStarted).toBe(false);
    expect(scheduler.health().queuedBatchOperationCount).toBe(1);

    holdingGate.resolve();
    await expect(holding).resolves.toBeUndefined();
    await expect(waiting).resolves.toBe("second turn");
    expect(scheduler.health().queuedBatchOperationCount).toBe(0);
    await expect(scheduler.run("batch:same", async () => "free")).resolves.toBe("free");
    scheduler.close();
  });

  it("refuses a run beyond the waiting-run cap instead of queueing without a bound", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 1 });
    const holdingGate = deferred();
    const holding = scheduler.run("batch:holding", () => holdingGate.promise, { holder: "session-a" });
    await waitUntil(() => scheduler.health().activeWindows === 1);
    const queued = Array.from({ length: scheduler.maxQueuedWindows }, (_value, index) => scheduler.run(
      `batch:queued-${index}`,
      async () => index,
      { queueTimeoutMs: 0, holder: "session-b" },
    ));
    await waitUntil(() => scheduler.health().waitingWindows === scheduler.maxQueuedWindows);

    let refusedStarted = false;
    const error = await scheduler.run("batch:overflow", async () => {
      refusedStarted = true;
    }, { queueTimeoutMs: 0 }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BatchWindowQueueFullError);
    const full = error as BatchWindowQueueFullError;
    expect(full.queueDepth).toBe(32);
    expect(full.maxQueuedWindows).toBe(32);
    expect(full.activeBatches).toEqual([
      {
        batchId: "batch:holding",
        holder: "session-a",
        mode: "stage_writes",
        concurrency: 1,
        startedAt: expect.any(String),
      },
    ]);
    expect(refusedStarted).toBe(false);

    holdingGate.resolve();
    await expect(holding).resolves.toBeUndefined();
    await expect(Promise.all(queued)).resolves.toEqual(queued.map((_value, index) => index));
    expect(scheduler.health()).toMatchObject({ activeWindows: 0, waitingWindows: 0 });
    scheduler.close();
  });

  it("runs two read groups together while their frozen request rates fit the bridge budget", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 2 });
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    const read = (name: string, concurrency: number, gate: ReturnType<typeof deferred>) => scheduler.run(
      `batch:${name}`,
      async () => {
        started.push(name);
        await gate.promise;
        return name;
      },
      { mode: "read_only", concurrency, holder: `session-${name}` },
    );

    const first = read("inventory", 4, gates[0]!);
    const second = read("audit", 4, gates[1]!);
    await waitUntil(() => scheduler.health().activeReadWindows === 2);
    expect(scheduler.health()).toMatchObject({
      activeReadWindows: 2,
      activeWriteWindows: 0,
      activeReadRequests: 8,
      waitingWindows: 0,
    });
    expect(started).toEqual(["inventory", "audit"]);

    const third = read("third", 1, gates[2]!);
    await waitUntil(() => scheduler.health().waitingWindows === 1);
    expect(started).toEqual(["inventory", "audit"]);

    gates[0]!.resolve();
    await expect(first).resolves.toBe("inventory");
    await waitUntil(() => started.length === 3);
    expect(scheduler.health()).toMatchObject({ activeReadWindows: 2, activeReadRequests: 5 });
    gates[1]!.resolve();
    gates[2]!.resolve();
    await expect(Promise.all([second, third])).resolves.toEqual(["audit", "third"]);
    expect(scheduler.health()).toMatchObject({ activeReadWindows: 0, activeReadRequests: 0 });
    scheduler.close();
  });

  it("runs a read group that claims the whole bridge budget on its own", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 2 });
    const wideGate = deferred();
    let narrowStarted = false;
    const wide = scheduler.run("batch:wide", () => wideGate.promise, { mode: "read_only", concurrency: 8 });
    await waitUntil(() => scheduler.health().activeReadRequests === 8);
    const narrow = scheduler.run("batch:narrow", async () => {
      narrowStarted = true;
      return "narrow";
    }, { mode: "read_only", concurrency: 1, queueTimeoutMs: 0 });
    await waitUntil(() => scheduler.health().waitingWindows === 1);
    expect(narrowStarted).toBe(false);
    expect(scheduler.health()).toMatchObject({ activeReadWindows: 1, activeReadRequests: 8 });

    wideGate.resolve();
    await expect(wide).resolves.toBeUndefined();
    await expect(narrow).resolves.toBe("narrow");
    scheduler.close();
  });

  it("never runs two write groups at the same time", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 2 });
    const holdingGate = deferred();
    let secondStarted = false;
    const holding = scheduler.run("batch:write-one", () => holdingGate.promise, {
      mode: "stage_writes",
      concurrency: 4,
      holder: "session-a",
    });
    await waitUntil(() => scheduler.health().activeWriteWindows === 1);
    const second = scheduler.run("batch:write-two", async () => {
      secondStarted = true;
      return "second";
    }, { mode: "stage_writes", concurrency: 4, queueTimeoutMs: 0, holder: "session-b" });
    await waitUntil(() => scheduler.health().waitingWindows === 1);
    expect(secondStarted).toBe(false);
    expect(scheduler.health()).toMatchObject({ activeWriteWindows: 1, activeReadWindows: 0 });

    holdingGate.resolve();
    await expect(holding).resolves.toBeUndefined();
    await expect(second).resolves.toBe("second");
    expect(scheduler.health()).toMatchObject({ activeWriteWindows: 0, waitingWindows: 0 });
    scheduler.close();
  });

  it("never runs a read group beside a write group, in either order", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 2 });
    const writeGate = deferred();
    let readStarted = false;
    const write = scheduler.run("batch:write", () => writeGate.promise, { mode: "stage_writes", concurrency: 1 });
    await waitUntil(() => scheduler.health().activeWriteWindows === 1);
    const read = scheduler.run("batch:read", async () => {
      readStarted = true;
      return "read";
    }, { mode: "read_only", concurrency: 1, queueTimeoutMs: 0 });
    await waitUntil(() => scheduler.health().waitingWindows === 1);
    expect(readStarted).toBe(false);
    writeGate.resolve();
    await expect(write).resolves.toBeUndefined();
    await expect(read).resolves.toBe("read");

    const readAgainGate = deferred();
    let writeAgainStarted = false;
    const readAgain = scheduler.run("batch:read-again", () => readAgainGate.promise, {
      mode: "read_only",
      concurrency: 1,
    });
    await waitUntil(() => scheduler.health().activeReadWindows === 1);
    const writeAgain = scheduler.run("batch:write-again", async () => {
      writeAgainStarted = true;
      return "write";
    }, { mode: "stage_writes", concurrency: 1, queueTimeoutMs: 0 });
    await waitUntil(() => scheduler.health().waitingWindows === 1);
    expect(writeAgainStarted).toBe(false);
    readAgainGate.resolve();
    await expect(readAgain).resolves.toBeUndefined();
    await expect(writeAgain).resolves.toBe("write");
    scheduler.close();
  });

  it("gives a run that names no mode the strictest window", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 2 });
    const holdingGate = deferred();
    let secondStarted = false;
    const holding = scheduler.run("batch:unnamed-one", () => holdingGate.promise);
    await waitUntil(() => scheduler.health().activeWindows === 1);
    expect(scheduler.health()).toMatchObject({ activeWriteWindows: 1, activeReadWindows: 0 });
    const second = scheduler.run("batch:unnamed-two", async () => {
      secondStarted = true;
      return "second";
    }, { queueTimeoutMs: 0 });
    await waitUntil(() => scheduler.health().waitingWindows === 1);
    expect(secondStarted).toBe(false);

    holdingGate.resolve();
    await expect(holding).resolves.toBeUndefined();
    await expect(second).resolves.toBe("second");
    scheduler.close();
  });

  it("keeps queue order when the waiting run at the head does not fit yet", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 2 });
    const runningGate = deferred();
    const wideGate = deferred();
    const started: string[] = [];
    const running = scheduler.run("batch:running", () => runningGate.promise, { mode: "read_only", concurrency: 4 });
    await waitUntil(() => scheduler.health().activeReadRequests === 4);
    const wide = scheduler.run("batch:wide", async () => {
      started.push("wide");
      await wideGate.promise;
      return "wide";
    }, { mode: "read_only", concurrency: 8, queueTimeoutMs: 0 });
    const narrow = scheduler.run("batch:narrow", async () => {
      started.push("narrow");
      return "narrow";
    }, { mode: "read_only", concurrency: 4, queueTimeoutMs: 0 });
    await waitUntil(() => scheduler.health().waitingWindows === 2);
    // The narrow run fits beside the running one, but the wide run asked first.
    expect(started).toEqual([]);

    runningGate.resolve();
    await expect(running).resolves.toBeUndefined();
    await waitUntil(() => started.length === 1);
    expect(started).toEqual(["wide"]);
    expect(scheduler.health()).toMatchObject({ activeReadRequests: 8, waitingWindows: 1 });

    wideGate.resolve();
    await expect(wide).resolves.toBe("wide");
    await expect(narrow).resolves.toBe("narrow");
    expect(started).toEqual(["wide", "narrow"]);
    scheduler.close();
  });

  it("starts a waiting run as soon as the cancelled run ahead of it leaves the queue", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentReadWindows: 2 });
    const runningGate = deferred();
    const cancel = new AbortController();
    let wideStarted = false;
    const running = scheduler.run("batch:running", () => runningGate.promise, { mode: "read_only", concurrency: 4 });
    await waitUntil(() => scheduler.health().activeReadRequests === 4);
    const wide = scheduler.run("batch:wide", async () => {
      wideStarted = true;
    }, { mode: "read_only", concurrency: 8, signal: cancel.signal, queueTimeoutMs: 0 });
    const narrow = scheduler.run("batch:narrow", async () => "narrow", {
      mode: "read_only",
      concurrency: 4,
      queueTimeoutMs: 0,
    });
    await waitUntil(() => scheduler.health().waitingWindows === 2);

    cancel.abort();
    await expect(wide).rejects.toBeInstanceOf(BatchWindowQueueAbortedError);
    await expect(narrow).resolves.toBe("narrow");
    expect(wideStarted).toBe(false);
    expect(scheduler.health()).toMatchObject({ activeReadWindows: 1, activeReadRequests: 4, waitingWindows: 0 });

    runningGate.resolve();
    await expect(running).resolves.toBeUndefined();
    scheduler.close();
  });
});
