import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  FileStageError,
  FileStageStore,
  MAX_STAGED_FILE_BYTES,
  MAX_PENDING_FILE_STAGES,
  type FileStageScope,
} from "../src/file-staging.js";

const now = 1_789_000_000_000;
const scope: FileStageScope = {
  provider: "moodle",
  sourceBindingId: "moodle:chemistry",
  origin: "https://moodle.example.edu",
  siteUrl: "https://moodle.example.edu/learn",
  principalFingerprint: "1".repeat(64),
  sessionGeneration: 1,
  catalogDigest: "2".repeat(64),
  courseId: "42",
  toolName: "moodle_create_resource_file",
  operationKey: "moodle.form.course.modedit.resource.file.create.write.v1",
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stage(store = new FileStageStore({ now: () => now })) {
  const bytes = new Uint8Array([0, 71, 85, 73, 68, 69, 10]);
  const receipt = store.stage({ bytes, filename: "week-1-guide.txt", scope, expiresAt: now + 60_000 });
  return { store, bytes, receipt };
}

describe("FileStageStore", () => {
  it("binds one verified manifest to one exact Moodle operation and consumes it once", () => {
    const { store, bytes, receipt } = stage();
    expect(receipt.manifest).toEqual({ filename: "week-1-guide.txt", sizeBytes: bytes.byteLength, sha256: digest(bytes) });
    expect(JSON.stringify(receipt)).not.toContain("71,85,73,68");

    const binding = { handle: receipt.handle, scope, manifest: receipt.manifest, operationId: "operation:resource-42" };
    store.bind(binding);
    expect(() => store.verify({ ...binding, scope: { ...scope, sessionGeneration: 2 } })).toThrow("file_stage_binding_refused");
    store.verify(binding);
    const dispatch = store.consume(binding);

    expect(dispatch.manifest).toEqual(receipt.manifest);
    expect(dispatch.bytes).toEqual(bytes);
    expect(() => store.consume(binding)).toThrowError(FileStageError);
    expect(() => store.consume(binding)).toThrow("file_stage_unavailable");
  });

  it("refuses a different site, manifest, or operation before exposing staged bytes", () => {
    const { store, receipt } = stage();
    const wrongScope = { ...scope, siteUrl: "https://moodle.example.edu/other" };
    const binding = { handle: receipt.handle, scope, manifest: receipt.manifest, operationId: "operation:resource-42" };

    expect(() => store.bind({ ...binding, scope: wrongScope })).toThrow("file_stage_binding_refused");
    expect(() => store.bind({ ...binding, manifest: { ...receipt.manifest, sha256: "f".repeat(64) } })).toThrow("file_stage_binding_refused");
    store.bind(binding);
    expect(() => store.consume({ ...binding, operationId: "operation:resource-43" })).toThrow("file_stage_binding_refused");
    expect(store.consume(binding).bytes).toEqual(new Uint8Array([0, 71, 85, 73, 68, 69, 10]));
  });

  it("refuses invalid or expired bytes before an operation can bind them", () => {
    const clock = { now };
    const store = new FileStageStore({ now: () => clock.now });
    expect(() => store.stage({ bytes: new Uint8Array(), filename: "empty.bin", scope, expiresAt: now + 60_000 })).toThrow("file_stage_invalid");
    expect(() => store.stage({ bytes: new Uint8Array(MAX_STAGED_FILE_BYTES + 1).fill(1), filename: "large.bin", scope, expiresAt: now + 60_000 })).toThrow("file_stage_invalid");

    const { receipt } = stage(store);
    clock.now += 60_000;
    expect(store.reap()).toBe(1);
    expect(() => store.bind({ handle: receipt.handle, scope, manifest: receipt.manifest, operationId: "operation:resource-42" })).toThrow("file_stage_unavailable");
  });

  it("zeroes and removes bound bytes at expiry while the store is idle", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const expired: Array<{ handle: string; operationId: string | null }> = [];
      const store = new FileStageStore({
        onExpire: (handle, operationId) => expired.push({ handle, operationId }),
      });
      const { receipt } = stage(store);
      const binding = { handle: receipt.handle, scope, manifest: receipt.manifest, operationId: "operation:idle-expiry" };
      store.bind(binding);
      const retained = (store as unknown as { stages: Map<string, { bytes: Buffer }> }).stages.get(receipt.handle)!.bytes;
      expect([...retained]).toEqual([0, 71, 85, 73, 68, 69, 10]);

      vi.advanceTimersByTime(60_000);

      expect([...retained]).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(expired).toEqual([{ handle: receipt.handle, operationId: binding.operationId }]);
      expect(() => store.verify(binding)).toThrow("file_stage_unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves valid all-zero binary bytes and bounds outstanding stages", () => {
    const store = new FileStageStore({ now: () => now });
    const bytes = new Uint8Array([0, 0, 0]);
    const receipt = store.stage({ bytes, filename: "binary.bin", scope, expiresAt: now + 60_000 });
    bytes.fill(9);
    const binding = { handle: receipt.handle, scope, manifest: receipt.manifest, operationId: "operation:binary-42" };
    store.bind(binding);
    expect(store.consume(binding).bytes).toEqual(new Uint8Array([0, 0, 0]));
    const receipts = Array.from({ length: MAX_PENDING_FILE_STAGES }, () => stage(store).receipt);
    expect(() => stage(store)).toThrow("file_stage_capacity_reached");
    store.discard(receipts[0]!.handle);
    expect(() => stage(store)).not.toThrow();
    store.clear();
    expect(() => stage(store)).not.toThrow();
  });
});
