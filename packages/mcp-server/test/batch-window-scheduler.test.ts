import { describe, expect, it } from "vitest";
import {
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

describe("BatchWindowScheduler", () => {
  it("serializes work for the same batch and preserves submission order", async () => {
    const scheduler = new BatchWindowScheduler({ maxConcurrentWindows: 2 });
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

    await Promise.resolve();
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
    const scheduler = new BatchWindowScheduler({ maxConcurrentWindows: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let active = 0;
    let maximumActive = 0;
    const jobs = gates.map((gate, index) => scheduler.run(`batch:${index + 1}`, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate.promise;
      active -= 1;
      return index;
    }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scheduler.health()).toMatchObject({
      activeWindows: 2,
      waitingWindows: 2,
      runningBatchCount: 2,
    });
    gates[0]!.resolve();
    gates[1]!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    const scheduler = new BatchWindowScheduler({ maxConcurrentWindows: 1 });
    const runningGate = deferred();
    let queuedStarted = false;
    const running = scheduler.run("batch:running", () => runningGate.promise);
    const queued = scheduler.run("batch:queued", async () => {
      queuedStarted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scheduler.health().waitingWindows).toBe(1);
    scheduler.close();
    await expect(queued).rejects.toBeInstanceOf(BatchWindowSchedulerClosedError);
    expect(queuedStarted).toBe(false);
    runningGate.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(scheduler.health().open).toBe(false);
  });
});
