import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DurableBatchStore,
  MAX_BATCH_CHILDREN,
} from "../src/public.js";

const catalogDigest = "d".repeat(64);

describe("DurableBatchStore scale campaign", () => {
  it("freezes, encrypts, and pages ten thousand explicit course operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-batch-scale-"));
    const path = join(directory, "morrow.sqlite3");
    const marker = "plaintext-scale-marker-course-10000";
    const store = new DurableBatchStore({
      path,
      encryptionKey: randomBytes(32),
    });

    try {
      expect(MAX_BATCH_CHILDREN).toBe(10_000);
      const created = store.create({
        name: "Ten thousand course reads",
        mode: "read_only",
        catalogDigest,
        concurrency: 16,
        children: Array.from({ length: MAX_BATCH_CHILDREN }, (_, index) => {
          const number = index + 1;
          return {
            childId: `course:${String(number).padStart(5, "0")}`,
            publicToolName: "canvas_page_get",
            sourceId: "meridian",
            sourceToolName: "canvas_page_get",
            readOnly: true,
            arguments: {
              course_id: String(number),
              marker: number === MAX_BATCH_CHILDREN ? marker : `course-${number}`,
            },
          };
        }),
      });

      expect(created.batch).toMatchObject({
        totalChildren: 10_000,
        pendingChildren: 10_000,
        concurrency: 16,
        state: "planned",
      });
      expect(created.batch.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(created.children).toHaveLength(10_000);
      expect(created.children.every((child) => !("arguments" in child))).toBe(true);

      const first = store.listChildren(created.batch.batchId, 0, 500);
      expect(first).toMatchObject({ offset: 0, returned: 500, nextOffset: 500 });
      expect(first.children[0]).toMatchObject({
        ordinal: 1,
        childId: "course:00001",
      });

      const last = store.listChildren(created.batch.batchId, 9_500, 500);
      expect(last).toMatchObject({ offset: 9_500, returned: 500, nextOffset: null });
      expect(last.children.at(-1)).toMatchObject({
        ordinal: 10_000,
        childId: "course:10000",
      });
      expect(last.children.every((child) => !("arguments" in child))).toBe(true);
    } finally {
      store.close();
    }

    try {
      const files = await readdir(directory);
      const persistedBytes = Buffer.concat(await Promise.all(
        files
          .filter((name) => name.startsWith("morrow.sqlite3"))
          .map((name) => readFile(join(directory, name))),
      ));
      expect(persistedBytes.includes(Buffer.from(marker, "utf8"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
