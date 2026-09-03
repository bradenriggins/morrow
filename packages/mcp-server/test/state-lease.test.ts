import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RuntimeStateLease,
  hardenMorrowStateFiles,
} from "../src/state-lease.js";

describe("RuntimeStateLease", () => {
  it("permits one live owner and releases ownership cleanly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-runtime-lease-"));
    const statePath = join(directory, "morrow.sqlite3");
    const first = RuntimeStateLease.acquire(statePath, { heartbeatMs: 60_000 });
    try {
      expect(first.health()).toMatchObject({
        active: true,
        statePath,
        pid: process.pid,
      });
      expect(() => RuntimeStateLease.acquire(statePath, { heartbeatMs: 60_000 }))
        .toThrow(/already leased/);
      first.heartbeat();
      const lockPath = `${statePath}.runtime.lock`;
      const stored = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      expect(stored).toMatchObject({
        schema: "morrow.runtime-lease.v1",
        pid: process.pid,
      });
      expect(stored).not.toHaveProperty("statePath");
      expect(stored).not.toHaveProperty("token");
      if (process.platform !== "win32") {
        expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      }
    } finally {
      first.release();
    }

    const second = RuntimeStateLease.acquire(statePath, { heartbeatMs: 60_000 });
    second.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("reclaims a lock whose recorded process is no longer alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-stale-lease-"));
    const statePath = join(directory, "morrow.sqlite3");
    const lockPath = `${statePath}.runtime.lock`;
    await writeFile(lockPath, `${JSON.stringify({
      schema: "morrow.runtime-lease.v1",
      nonce: "00000000-0000-4000-8000-000000000000",
      pid: 999_999,
      startedAt: "2026-09-03T00:00:00.000Z",
      heartbeatAt: "2026-09-03T00:00:00.000Z",
    })}\n`, { mode: 0o600 });

    const lease = RuntimeStateLease.acquire(statePath, {
      heartbeatMs: 60_000,
      processAlive: () => false,
    });
    try {
      expect(lease.health()).toMatchObject({ active: true, pid: process.pid });
      const replacement = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      expect(replacement.pid).toBe(process.pid);
      expect(replacement.nonce).not.toBe("00000000-0000-4000-8000-000000000000");
    } finally {
      lease.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hardens existing local state artifacts and skips in-memory state", async () => {
    const memoryLease = RuntimeStateLease.acquire(":memory:");
    expect(memoryLease.health()).toMatchObject({ active: false, lockPath: null });
    memoryLease.release();

    const directory = await mkdtemp(join(tmpdir(), "morrow-state-mode-"));
    const statePath = join(directory, "morrow.sqlite3");
    await writeFile(statePath, "fixture", { mode: 0o644 });
    await writeFile(`${statePath}.batch.key`, "fixture", { mode: 0o644 });
    hardenMorrowStateFiles(statePath);
    if (process.platform !== "win32") {
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      expect((await stat(`${statePath}.batch.key`)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    await rm(directory, { recursive: true, force: true });
  });
});
