import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openExactPrivateSqliteDatabase } from "@morrow/gateway-core";
import {
  RuntimeStateLease,
  hardenMorrowStateFiles,
} from "../src/state-lease.js";

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`operation did not settle within ${milliseconds} ms`)), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("RuntimeStateLease", () => {
  it("permits one live owner and releases ownership cleanly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-runtime-lease-"));
    const statePath = join(directory, "morrow.sqlite3");
    const first = RuntimeStateLease.acquire(statePath, { heartbeatMs: 60_000 });
    try {
      expect(first.health()).toMatchObject({
        active: true,
        statePath: join(await realpath(directory), "morrow.sqlite3"),
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

  it("reclaims a lock when its live PID belongs to a process started after the lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-reused-pid-lease-"));
    const statePath = join(directory, "morrow.sqlite3");
    const lockPath = `${statePath}.runtime.lock`;
    await writeFile(lockPath, `${JSON.stringify({
      schema: "morrow.runtime-lease.v1",
      nonce: "00000000-0000-4000-8000-000000000001",
      pid: process.pid,
      startedAt: "2026-09-03T00:00:00.000Z",
      heartbeatAt: "2026-09-03T00:00:00.000Z",
    })}\n`, { mode: 0o600 });

    const lease = RuntimeStateLease.acquire(statePath, {
      heartbeatMs: 60_000,
      processAlive: () => true,
      processMatches: (_pid, observedAt) => observedAt !== "2026-09-03T00:00:00.000Z",
    });
    try {
      expect(lease.health()).toMatchObject({ active: true, pid: process.pid });
      const replacement = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      expect(replacement.nonce).not.toBe("00000000-0000-4000-8000-000000000001");
    } finally {
      lease.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pins the canonical state parent across an ancestor-link retarget", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "morrow-canonical-lease-"));
    const firstRoot = join(directory, "first");
    const secondRoot = join(directory, "second");
    const alias = join(directory, "alias");
    await mkdir(join(firstRoot, "state"), { recursive: true });
    await mkdir(join(secondRoot, "state"), { recursive: true });
    await symlink(firstRoot, alias);
    const requestedStatePath = join(alias, "state", "morrow.sqlite3");
    const lease = RuntimeStateLease.acquire(requestedStatePath, { heartbeatMs: 60_000 });
    try {
      const canonicalStatePath = join(await realpath(join(firstRoot, "state")), "morrow.sqlite3");
      expect(lease.statePath).toBe(canonicalStatePath);
      await unlink(alias);
      await symlink(secondRoot, alias);
      lease.heartbeat();
      expect(await readFile(`${canonicalStatePath}.runtime.lock`, "utf8")).toContain(lease.health().heartbeatAt);
      await expect(stat(join(secondRoot, "state", "morrow.sqlite3.runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      lease.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a replacement of the canonical state parent", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "morrow-replaced-state-parent-"));
    const stateDirectory = join(directory, "state");
    const displacedDirectory = join(directory, "state.displaced");
    const statePath = join(stateDirectory, "morrow.sqlite3");
    await mkdir(stateDirectory, { mode: 0o700 });
    const lease = RuntimeStateLease.acquire(statePath, { heartbeatMs: 60_000 });
    try {
      await rename(stateDirectory, displacedDirectory);
      await mkdir(stateDirectory, { mode: 0o700 });
      await writeFile(`${statePath}.runtime.lock`, "replacement lease remains unchanged\n", { mode: 0o600 });
      expect(() => lease.heartbeat()).toThrow(/exact private runtime state lease/);
      expect(lease.health().active).toBe(false);
      expect(await readFile(`${statePath}.runtime.lock`, "utf8")).toBe("replacement lease remains unchanged\n");
      lease.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects linked, oversized, and non-private existing lease files without changing them", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "morrow-unsafe-lease-"));
    const statePath = join(directory, "morrow.sqlite3");
    const lockPath = `${statePath}.runtime.lock`;
    const victim = join(directory, "victim.json");
    const victimContent = "victim must remain byte exact\n";
    try {
      await writeFile(victim, victimContent, { mode: 0o600 });
      await symlink(victim, lockPath);
      expect(() => RuntimeStateLease.acquire(statePath, { heartbeatMs: 60_000 })).toThrow(/exact private file/);
      expect(await readFile(victim, "utf8")).toBe(victimContent);

      await unlink(lockPath);
      const oversized = "x".repeat(1_025);
      await writeFile(lockPath, oversized, { mode: 0o600 });
      expect(() => RuntimeStateLease.acquire(statePath, { heartbeatMs: 60_000 })).toThrow(/exact private file/);
      expect(await readFile(lockPath, "utf8")).toBe(oversized);

      await writeFile(lockPath, "{}\n", { mode: 0o600, flag: "w" });
      await chmod(lockPath, 0o644);
      expect(() => RuntimeStateLease.acquire(statePath, { heartbeatMs: 60_000 })).toThrow(/exact private file/);
      expect((await stat(lockPath)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not follow a replacement lease link during heartbeat", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "morrow-replaced-lease-link-"));
    const statePath = join(directory, "morrow.sqlite3");
    const lockPath = `${statePath}.runtime.lock`;
    const victim = join(directory, "victim.json");
    const victimContent = "heartbeat must not reach this file\n";
    const lease = RuntimeStateLease.acquire(statePath, { heartbeatMs: 60_000 });
    try {
      await writeFile(victim, victimContent, { mode: 0o600 });
      await unlink(lockPath);
      await symlink(victim, lockPath);
      expect(() => lease.heartbeat()).toThrow(/exact private runtime state lease/);
      expect(lease.health().active).toBe(false);
      expect(await readFile(victim, "utf8")).toBe(victimContent);
      lease.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops a serving lifecycle when the heartbeat timer loses the pinned lease file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-lease-loss-lifecycle-"));
    const statePath = join(directory, "morrow.sqlite3");
    const lockPath = `${statePath}.runtime.lock`;
    const displacedPath = `${lockPath}.displaced`;
    let serving = true;
    let resolveLost!: () => void;
    const lost = new Promise<void>((resolve) => { resolveLost = resolve; });
    const replacement = "replacement lease remains unchanged\n";
    const lease = RuntimeStateLease.acquire(statePath, {
      heartbeatMs: 500,
      onOwnershipLost: () => {
        serving = false;
        resolveLost();
      },
    });
    try {
      await rename(lockPath, displacedPath);
      await writeFile(lockPath, replacement, { mode: 0o600 });
      await within(lost, 2_000);
      expect(serving).toBe(false);
      expect(lease.health()).toMatchObject({ active: false });
      expect(await readFile(lockPath, "utf8")).toBe(replacement);
      lease.release();
    } finally {
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
    if (process.platform !== "win32") {
      const victim = join(directory, "linked-state-target");
      await rm(statePath, { force: true });
      await writeFile(victim, "linked target", { mode: 0o644 });
      await symlink(victim, statePath);
      expect(() => hardenMorrowStateFiles(statePath)).toThrow(/unsafe file/);
      expect((await stat(victim)).mode & 0o777).toBe(0o644);
    }
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps SQLite's process locks intact while hardening the live database and its WAL sidecars", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-state-locks-"));
    const statePath = join(directory, "morrow.sqlite3");
    const secondProcessJournalMode = (): string => {
      const probe = spawnSync(process.execPath, ["--input-type=module", "-e", [
        'import { DatabaseSync } from "node:sqlite";',
        `const database = new DatabaseSync(${JSON.stringify(statePath)});`,
        'try { process.stdout.write(String(database.prepare("PRAGMA journal_mode = DELETE").get().journal_mode)); }',
        'catch (error) { process.stdout.write(`refused:${error.message}`); }',
        "database.close();",
      ].join("\n")], { encoding: "utf8", timeout: 20_000 });
      if (probe.status !== 0) throw new Error(`journal probe failed: ${probe.stderr}`);
      return probe.stdout;
    };
    try {
      const opened = openExactPrivateSqliteDatabase(statePath, "test state");
      try {
        opened.database.exec("CREATE TABLE effects(value TEXT); INSERT INTO effects VALUES ('first');");
        await chmod(`${statePath}-wal`, 0o644);
        expect(secondProcessJournalMode()).toMatch(/^refused:.*locked/);
        hardenMorrowStateFiles(statePath);
        if (process.platform !== "win32") {
          for (const candidate of [statePath, `${statePath}-wal`, `${statePath}-shm`]) {
            expect((await stat(candidate)).mode & 0o077).toBe(0);
          }
        }
        expect(secondProcessJournalMode()).toMatch(/^refused:.*locked/);
        opened.database.exec("INSERT INTO effects VALUES ('second');");
        hardenMorrowStateFiles(statePath);
        expect(secondProcessJournalMode()).toMatch(/^refused:.*locked/);
        expect(opened.database.prepare("SELECT count(*) AS count FROM effects").get()).toMatchObject({ count: 2 });
      } finally {
        opened.database.close();
      }
      expect(secondProcessJournalMode()).toBe("delete");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
