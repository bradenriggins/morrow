import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Json } from "@morrow/contracts";
import {
  DurableBatchStore,
  loadOrCreateBatchEncryptionKey,
  runBatchWindow,
} from "../src/public.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function child(index: number, readOnly = true) {
  return {
    childId: `course:${index}`,
    publicToolName: readOnly ? "canvas_page_get" : "edit_page",
    sourceId: readOnly ? "meridian" : "morrow-legacy",
    sourceToolName: readOnly ? "canvas_page_get" : "edit_page",
    readOnly,
    arguments: { course_id: String(index), secretMarker: `private-${index}` },
    ...(!readOnly ? { sourceOperationId: `operation:batch-${index}` } : {}),
  };
}

describe("DurableBatchStore", () => {
  it("creates and reloads one exact private batch encryption key", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-batch-key-"));
    roots.push(root);
    const path = join(root, "state.key");
    const first = loadOrCreateBatchEncryptionKey(path);
    const second = loadOrCreateBatchEncryptionKey(path);
    expect(Buffer.from(second)).toEqual(Buffer.from(first));
    expect(lstatSync(path).isFile()).toBe(true);
    if (process.platform !== "win32") expect(lstatSync(path).mode & 0o077).toBe(0);
  });

  it("refuses linked, multiply linked, oversized, and broadly readable batch keys", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-batch-key-admission-"));
    roots.push(root);
    const valid = `${Buffer.alloc(32, 7).toString("base64url")}\n`;

    const oversized = join(root, "oversized.key");
    writeFileSync(oversized, "x".repeat(129), { mode: 0o600 });
    expect(() => loadOrCreateBatchEncryptionKey(oversized)).toThrow(/exact private file/);

    if (process.platform !== "win32") {
      const target = join(root, "target.key");
      writeFileSync(target, valid, { mode: 0o600 });
      const linked = join(root, "linked.key");
      symlinkSync(target, linked);
      expect(() => loadOrCreateBatchEncryptionKey(linked)).toThrow(/exact private file/);

      const alias = join(root, "alias.key");
      linkSync(target, alias);
      expect(() => loadOrCreateBatchEncryptionKey(target)).toThrow(/exact private file/);
      expect(() => loadOrCreateBatchEncryptionKey(alias)).toThrow(/exact private file/);

      const broad = join(root, "broad.key");
      writeFileSync(broad, valid, { mode: 0o600 });
      chmodSync(broad, 0o644);
      expect(() => loadOrCreateBatchEncryptionKey(broad)).toThrow(/exact private file/);
    }
  });

  it("freezes, encrypts, runs, and reports a read batch", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-batch-"));
    roots.push(root);
    const path = join(root, "morrow.sqlite3");
    const key = loadOrCreateBatchEncryptionKey(join(root, "state.key"));
    const store = new DurableBatchStore({ path, encryptionKey: key });
    const created = store.create({
      name: "Read three courses",
      mode: "read_only",
      catalogDigest: "a".repeat(64),
      concurrency: 2,
      children: [child(1), child(2), child(3)],
    });
    expect(created.batch.totalChildren).toBe(3);
    expect(created.children[0]?.requestDigest).toBe(sha256Json({ course_id: "1", secretMarker: "private-1" }));

    const result = await runBatchWindow(store, created.batch.batchId, async ({ child: row, arguments: args }) => ({
      state: "succeeded",
      resultDigest: sha256Json({ child: row.childId, course: args.course_id }),
      gatewayOperationId: `gop:${row.ordinal}-12345678`,
      gatewayOperationState: "response_received",
    }), { expectedCatalogDigest: "a".repeat(64), maxChildren: 10 });
    expect(result.batch.state).toBe("completed");
    expect(result.batch.succeededChildren).toBe(3);
    expect(result.children).toHaveLength(3);
    store.close();

    const bytes = readFileSync(path);
    expect(bytes.includes(Buffer.from("private-1"))).toBe(false);
  });

  it("allows staged-write batches only for write children", () => {
    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: new Uint8Array(32).fill(7) });
    expect(() => store.create({
      name: "Invalid",
      mode: "stage_writes",
      catalogDigest: "a".repeat(64),
      concurrency: 1,
      children: [child(1, true)],
    })).toThrow(/only write children/);
    const created = store.create({
      name: "Stage one write",
      mode: "stage_writes",
      catalogDigest: "a".repeat(64),
      concurrency: 1,
      children: [child(2, false)],
    });
    expect(created.batch.state).toBe("planned");
    store.close();
  });

  it("reports the unrun children of a quarantined batch as remaining", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-batch-quarantined-"));
    roots.push(root);
    const path = join(root, "morrow.sqlite3");
    const key = new Uint8Array(32).fill(11);
    const first = new DurableBatchStore({ path, encryptionKey: key });
    const created = first.create({
      name: "Interrupted three",
      mode: "read_only",
      catalogDigest: "a".repeat(64),
      concurrency: 1,
      children: [child(1), child(2), child(3)],
    });
    first.beginRun(created.batch.batchId, "a".repeat(64));
    first.claimPending(created.batch.batchId, 1);
    first.close();

    const recovered = new DurableBatchStore({ path, encryptionKey: key });
    const result = await runBatchWindow(recovered, created.batch.batchId, async () => ({
      state: "succeeded",
      resultDigest: "b".repeat(64),
    }), { expectedCatalogDigest: "a".repeat(64) });
    expect(result.batch.state).toBe("inspection_required");
    expect(result.processed).toBe(0);
    expect(result.batch.pendingChildren).toBe(2);
    expect(result.remaining).toBe(2);
    recovered.close();
  });

  it("turns interrupted running children into inspection-required truth", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-batch-restart-"));
    roots.push(root);
    const path = join(root, "morrow.sqlite3");
    const key = new Uint8Array(32).fill(9);
    const first = new DurableBatchStore({ path, encryptionKey: key });
    const created = first.create({
      name: "Interrupted",
      mode: "read_only",
      catalogDigest: "a".repeat(64),
      concurrency: 1,
      children: [child(1)],
    });
    first.beginRun(created.batch.batchId, "a".repeat(64));
    first.claimPending(created.batch.batchId, 1);
    first.close();

    const recovered = new DurableBatchStore({ path, encryptionKey: key });
    const detail = recovered.get(created.batch.batchId);
    expect(detail.batch.state).toBe("inspection_required");
    expect(detail.children[0]?.state).toBe("unknown");
    recovered.close();
  });

  it("pauses a stale catalog instead of running it", async () => {
    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: new Uint8Array(32).fill(5) });
    const created = store.create({
      name: "Stale",
      mode: "read_only",
      catalogDigest: "a".repeat(64),
      concurrency: 1,
      children: [child(1)],
    });
    await expect(runBatchWindow(store, created.batch.batchId, async () => ({
      state: "succeeded",
      resultDigest: "b".repeat(64),
    }), { expectedCatalogDigest: "c".repeat(64) })).rejects.toThrow(/stale/);
    expect(store.getBatch(created.batch.batchId).state).toBe("paused");
    store.close();
  });
});
