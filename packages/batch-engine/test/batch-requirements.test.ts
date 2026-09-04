import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Json } from "@morrow/contracts";
import {
  DurableBatchStore,
  resolveBatchCourseSet,
  runBatchWindow,
} from "../src/public.js";

const catalogDigest = "a".repeat(64);
const profileDigest = "b".repeat(64);

function readChild(index: number) {
  return {
    childId: `course:${index}`,
    courseId: String(index),
    publicToolName: "canvas_page_get",
    sourceId: "meridian",
    sourceToolName: "canvas_page_get",
    readOnly: true,
    arguments: { course_id: String(index) },
  };
}

function readBatch(store: DurableBatchStore, count: number) {
  return store.create({
    name: `Read ${count} courses`,
    mode: "read_only",
    catalogDigest,
    concurrency: 8,
    operationFamily: "course_read",
    profileDigest,
    expiresAt: "2030-01-01T00:00:00.000Z",
    courseSet: {
      source: "explicit",
      courseIds: Array.from({ length: count }, (_, index) => String(index + 1)),
      complete: true,
      paginationComplete: true,
    },
    children: Array.from({ length: count }, (_, index) => readChild(index + 1)),
  });
}

describe("BAT durable batch requirements", () => {
  it("BAT-01 freezes the 25-course course set and complete manifest facts", () => {
    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: randomBytes(32) });
    const created = readBatch(store, 25);
    expect(created.manifest).toMatchObject({
      schema: "morrow.batch-manifest.v2",
      operationFamily: "course_read",
      profileDigest,
      approvalCoverageChildCount: 25,
      requestEstimate: 25,
      courseSet: { complete: true, courseIds: Array.from({ length: 25 }, (_, index) => String(index + 1)) },
    });
    expect(created.manifest.children).toHaveLength(25);
    expect(created.batch.manifestDigest).toBe(sha256Json(created.manifest));
    store.close();
  });

  it("persists the frozen manifest only as authenticated ciphertext", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-frozen-manifest-"));
    const path = join(directory, "morrow.sqlite3");
    const key = randomBytes(32);
    try {
      const store = new DurableBatchStore({ path, encryptionKey: key });
      const created = store.create({
        name: "Encrypted manifest",
        mode: "read_only",
        catalogDigest,
        concurrency: 1,
        operationFamily: "private-manifest-marker",
        profileDigest,
        expiresAt: "2030-01-01T00:00:00.000Z",
        courseSet: {
          source: "explicit",
          courseIds: ["private-course-marker"],
          complete: true,
          paginationComplete: true,
        },
        children: [{ ...readChild(1), courseId: "private-course-marker", arguments: { course_id: "private-course-marker" } }],
      });
      store.close();
      expect(readFileSync(path).includes(Buffer.from("private-manifest-marker"))).toBe(false);
      expect(readFileSync(path).includes(Buffer.from("private-course-marker"))).toBe(false);

      const reopened = new DurableBatchStore({ path, encryptionKey: key });
      expect(reopened.getManifest(created.batch.batchId).operationFamily).toBe("private-manifest-marker");
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("BAT-02 and BAT-09 retain all child facts and reduce a 100-course mixed result to partial", async () => {
    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: randomBytes(32) });
    const created = readBatch(store, 100);
    const result = await runBatchWindow(store, created.batch.batchId, async ({ child }) => ({
      state: child.ordinal === 50 ? "failed" : "succeeded",
      resultDigest: sha256Json({ childId: child.childId }),
    }), {
      expectedCatalogDigest: catalogDigest,
      expectedCourseSetDigest: created.manifest.courseSet.digest,
      expectedProfileDigest: profileDigest,
      maxChildren: 100,
    });
    expect(result.batch).toMatchObject({ state: "partial", succeededChildren: 99, failedChildren: 1 });
    expect(store.listChildren(created.batch.batchId, 0, 100).children).toHaveLength(100);
    store.close();
  });

  it("BAT-05 and BAT-06 stop pending children while preserving running child truth", () => {
    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: randomBytes(32) });
    const created = readBatch(store, 3);
    store.beginRun(created.batch.batchId, catalogDigest, {
      courseSetDigest: created.manifest.courseSet.digest,
      profileDigest,
    });
    const [running] = store.claimPending(created.batch.batchId, 1);
    expect(running?.state).toBe("running");
    expect(store.pause(created.batch.batchId).state).toBe("paused");
    expect(store.claimPending(created.batch.batchId, 2)).toEqual([]);
    store.beginRun(created.batch.batchId, catalogDigest, {
      courseSetDigest: created.manifest.courseSet.digest,
      profileDigest,
    });
    expect(store.cancel(created.batch.batchId).state).toBe("inspection_required");
    expect(store.get(created.batch.batchId).children.filter((child) => child.state === "cancelled")).toHaveLength(2);
    const settled = store.settleChild(created.batch.batchId, running!.childId, {
      state: "succeeded",
      resultDigest: sha256Json({ childId: running!.childId }),
    });
    expect(settled.state).toBe("succeeded");
    store.close();
  });

  it("BAT-07 and BAT-08 block incomplete discovery and target-set drift", () => {
    expect(() => resolveBatchCourseSet({
      source: "account_search",
      courseIds: ["1"],
      complete: false,
      allCoursesRequested: true,
      paginationComplete: false,
    })).toThrow(/incomplete course discovery/);

    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: randomBytes(32) });
    const created = readBatch(store, 1);
    expect(() => store.beginRun(created.batch.batchId, catalogDigest, {
      courseSetDigest: "c".repeat(64),
      profileDigest,
    })).toThrow(/target or profile facts are stale/);
    expect(store.getBatch(created.batch.batchId).state).toBe("paused");
    store.close();
  });

  it("uses response-aware bounded concurrency and jittered Retry-After backoff", async () => {
    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: randomBytes(32) });
    const created = readBatch(store, 4);
    let slept = 0;
    const result = await runBatchWindow(store, created.batch.batchId, async ({ child }) => ({
      state: "succeeded",
      resultDigest: sha256Json({ childId: child.childId }),
    }), {
      expectedCatalogDigest: catalogDigest,
      expectedCourseSetDigest: created.manifest.courseSet.digest,
      expectedProfileDigest: profileDigest,
      maxChildren: 4,
      ratePolicy: { requestCost: 2, rateLimitRemaining: 4, retryAfterMs: 100, jitterRatio: 0.2 },
      random: () => 0.5,
      sleep: async (milliseconds) => { slept = milliseconds; },
    });
    expect(result).toMatchObject({ effectiveConcurrency: 2, backoffMs: 110, processed: 4 });
    expect(slept).toBe(110);
    store.close();
  });
});
