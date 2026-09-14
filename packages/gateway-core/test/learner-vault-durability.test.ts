import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  LearnerVault,
  readProcessStartedAt,
  withExactPrivateStateFileTransaction,
} from "../src/index.js";

const scope = {
  canvasOrigin: "https://canvas.example.test",
  account: "1",
  course: "42",
  principal: "instructor:7",
  profile: "private-full",
};

interface WorkerResult {
  readonly learnerId: string;
  readonly label: string;
}

type WorkerProcess = ChildProcessByStdio<null, Readable, Readable>;

function transactionOwner(pid: number, processStartedAt: string): string {
  return `${JSON.stringify({
    schema: "morrow.exact-private-state-transaction.v1",
    nonce: "00000000-0000-4000-8000-000000000099",
    pid,
    processStartedAt,
    acquiredAt: Date.now(),
  })}\n`;
}

async function waitUntilReady(paths: readonly string[], children: readonly WorkerProcess[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    if (paths.every(existsSync)) return;
    const exited = children.find((child) => child.exitCode !== null);
    if (exited) throw new Error(`learner vault worker exited before its barrier: ${exited.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("learner vault workers did not reach their barrier");
}

async function collectWorker(child: WorkerProcess): Promise<WorkerResult> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("learner vault worker did not exit"));
    }, 5_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (value) => { clearTimeout(timer); resolve(value); });
  });
  if (code !== 0) throw new Error(`learner vault worker exited ${code}: ${stderr || stdout}`);
  return JSON.parse(stdout.trim()) as WorkerResult;
}

describe("learner vault durable ownership", () => {
  it("fresh-reads before each replacement so stale instances preserve both mappings", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-learner-vault-merge-"));
    try {
      const path = join(directory, "state", "vault.json");
      const first = new LearnerVault(path);
      const second = new LearnerVault(path);
      expect(first.tokenize(scope, { id: "17", name: "Ada Lovelace" })).toBe("Student A1");
      expect(second.tokenize(scope, { id: "18", name: "Rowan Clarke" })).toBe("Student A2");
      const restarted = new LearnerVault(path);
      expect(restarted.resolve(scope, "Student A1").id).toBe("17");
      expect(restarted.resolve(scope, "Student A2").id).toBe("18");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fresh-reads durable authority before resolving a cached identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-learner-vault-resolve-"));
    try {
      const path = join(directory, "vault.json");
      const vault = new LearnerVault(path);
      const label = vault.tokenize(scope, { id: "17", name: "Ada Lovelace" });
      if (process.platform === "win32") return;
      chmodSync(path, 0o644);
      expect(() => vault.resolve(scope, label)).toThrow(/vault is not one exact private file/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reclaims an exact owner record when the PID belongs to a later process", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-state-reused-pid-"));
    try {
      const path = join(directory, "state", "record.json");
      const lockPath = `${path}.transaction.lock`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const startedAt = readProcessStartedAt(process.pid);
      expect(startedAt).not.toBeNull();
      writeFileSync(lockPath, transactionOwner(process.pid, new Date(startedAt! - 60_000).toISOString()), {
        mode: 0o600,
        flag: "wx",
      });
      let entered = false;
      withExactPrivateStateFileTransaction(path, { label: "test state" }, () => { entered = true; });
      expect(entered).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      expect(readdirSync(dirname(path))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finishes an exact stale reclaim whose first reaper stopped after linking its claim", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-state-abandoned-reclaim-"));
    try {
      const path = join(directory, "state", "record.json");
      const lockPath = `${path}.transaction.lock`;
      const claimPath = `${lockPath}.reclaim-00000000-0000-4000-8000-000000000099`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const startedAt = readProcessStartedAt(process.pid);
      expect(startedAt).not.toBeNull();
      writeFileSync(lockPath, transactionOwner(process.pid, new Date(startedAt! - 60_000).toISOString()), {
        mode: 0o600,
        flag: "wx",
      });
      linkSync(lockPath, claimPath);

      let entered = false;
      withExactPrivateStateFileTransaction(
        path,
        { label: "test state", timeoutMs: 100, pollIntervalMs: 5 },
        () => { entered = true; },
      );

      expect(entered).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(claimPath)).toBe(false);
      expect(readdirSync(dirname(path))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finishes an interrupted release whose owner died between linking its release claim and unlinking the lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-state-interrupted-release-"));
    try {
      const path = join(directory, "state", "record.json");
      const lockPath = `${path}.transaction.lock`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const worker = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "interrupted-release-worker.mjs"), path], {
        stdio: ["ignore", "pipe", "pipe"],
      }) as WorkerProcess;
      let stdout = "";
      worker.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      worker.stderr.setEncoding("utf8").on("data", () => undefined);
      const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
        const timer = setTimeout(() => { worker.kill("SIGKILL"); reject(new Error("release worker did not stop")); }, 5_000);
        worker.once("error", (error) => { clearTimeout(timer); reject(error); });
        worker.once("close", (_code, value) => { clearTimeout(timer); resolve(value); });
      });
      expect(signal).toBe("SIGKILL");
      const nonce = stdout.match(/^claimed (\S+)/)?.[1];
      expect(nonce).toBeDefined();
      const claimPath = `${lockPath}.release-${nonce}`;
      expect(lstatSync(lockPath).nlink).toBe(2);
      expect(lstatSync(claimPath).ino).toBe(lstatSync(lockPath).ino);

      let entered = false;
      withExactPrivateStateFileTransaction(
        path,
        { label: "test state", timeoutMs: 200, pollIntervalMs: 5 },
        () => { entered = true; },
      );

      expect(entered).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(claimPath)).toBe(false);
      expect(readdirSync(dirname(path))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not adopt a release name that is not the stale owner's exact inode", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-state-false-release-"));
    try {
      const path = join(directory, "record.json");
      const lockPath = `${path}.transaction.lock`;
      const claimPath = `${lockPath}.release-00000000-0000-4000-8000-000000000099`;
      const startedAt = readProcessStartedAt(process.pid);
      expect(startedAt).not.toBeNull();
      const owner = transactionOwner(process.pid, new Date(startedAt! - 60_000).toISOString());
      writeFileSync(lockPath, owner, { mode: 0o600, flag: "wx" });
      linkSync(lockPath, join(directory, "lock-alias"));
      writeFileSync(claimPath, owner, { mode: 0o600, flag: "wx" });

      let entered = false;
      expect(() => withExactPrivateStateFileTransaction(
        path,
        { label: "test state", timeoutMs: 50, pollIntervalMs: 5 },
        () => { entered = true; },
      )).toThrow(/release claim is invalid/);

      expect(entered).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
      expect(existsSync(claimPath)).toBe(true);
      expect(lstatSync(lockPath).nlink).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not adopt a reclaim name that is not the stale owner's exact inode", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-state-false-reclaim-"));
    try {
      const path = join(directory, "record.json");
      const lockPath = `${path}.transaction.lock`;
      const claimPath = `${lockPath}.reclaim-00000000-0000-4000-8000-000000000099`;
      const startedAt = readProcessStartedAt(process.pid);
      expect(startedAt).not.toBeNull();
      const owner = transactionOwner(process.pid, new Date(startedAt! - 60_000).toISOString());
      writeFileSync(lockPath, owner, { mode: 0o600, flag: "wx" });
      writeFileSync(claimPath, owner, { mode: 0o600, flag: "wx" });

      let entered = false;
      expect(() => withExactPrivateStateFileTransaction(
        path,
        { label: "test state", timeoutMs: 50, pollIntervalMs: 5 },
        () => { entered = true; },
      )).toThrow(/busy in another process/);

      expect(entered).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
      expect(existsSync(claimPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps damaged or linked owner state as a fail-closed barrier", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-private-state-damaged-lock-"));
    try {
      const path = join(directory, "record.json");
      const lockPath = `${path}.transaction.lock`;
      writeFileSync(lockPath, "{}\n", { mode: 0o600, flag: "wx" });
      let entered = false;
      expect(() => withExactPrivateStateFileTransaction(
        path,
        { label: "test state", timeoutMs: 25, pollIntervalMs: 5 },
        () => { entered = true; },
      )).toThrow(/transaction owner is invalid/);
      expect(entered).toBe(false);
      rmSync(lockPath);

      const startedAt = readProcessStartedAt(process.pid);
      expect(startedAt).not.toBeNull();
      writeFileSync(lockPath, transactionOwner(process.pid, new Date(startedAt!).toISOString()), {
        mode: 0o600,
        flag: "wx",
      });
      const alias = join(directory, "owner-alias.json");
      linkSync(lockPath, alias);
      expect(() => withExactPrivateStateFileTransaction(
        path,
        { label: "test state", timeoutMs: 25, pollIntervalMs: 5 },
        () => { entered = true; },
      )).toThrow(/not one exact private file/);
      expect(entered).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
      expect(existsSync(alias)).toBe(true);
      if (process.platform !== "win32") {
        rmSync(lockPath);
        rmSync(alias);
        chmodSync(directory, 0o755);
        expect(() => withExactPrivateStateFileTransaction(path, { label: "test state" }, () => undefined))
          .toThrow(/parent is not one exact private directory/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves every mapping across repeated real-process races", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "learner-vault-worker.mjs");
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const directory = mkdtempSync(join(tmpdir(), "morrow-learner-vault-process-"));
      const barrier = join(directory, "barrier");
      const path = join(directory, "state", "vault.json");
      mkdirSync(barrier, { mode: 0o700 });
      const children = ["17", "18"].map((learnerId) => spawn(
        process.execPath,
        [fixture, path, barrier, learnerId],
        { stdio: ["ignore", "pipe", "pipe"] },
      ));
      try {
        await waitUntilReady([join(barrier, "ready-17"), join(barrier, "ready-18")], children);
        const resultsPromise = Promise.all(children.map(collectWorker));
        await writeFile(join(barrier, "go"), "go\n", { flag: "wx" });
        const results = await resultsPromise;
        expect(results.map((result) => result.label).sort()).toEqual(["Student A1", "Student A2"]);
        const restarted = new LearnerVault(path);
        for (const result of results) expect(restarted.resolve(scope, result.label).id).toBe(result.learnerId);
        expect([restarted.resolve(scope, "Student A1").id, restarted.resolve(scope, "Student A2").id].sort())
          .toEqual(["17", "18"]);
        expect(readdirSync(dirname(path)).sort()).toEqual(["vault.json", "vault.json.key"]);
        await access(path);
      } finally {
        for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
