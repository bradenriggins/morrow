import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readProcessStartedAt } from "@morrow/gateway-core";
import { afterEach, describe, expect, it } from "vitest";
import { loadCanvasConnectorConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];
const raceFixturePath = fileURLToPath(new URL("./fixtures/config-state-race.mjs", import.meta.url));

interface ConfigRaceWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<{ readonly phase: "ready"; readonly token: string }>;
  readonly outcome: Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>;
}

function configRaceWorker(path: string, extensionId: string, barrierPath: string): ConfigRaceWorker {
  // Node 22 prints an ExperimentalWarning for node:sqlite on stderr; the product
  // cannot suppress Node's own startup warning from inside the worker, so the
  // harness disables warnings. The assertion below still catches any real
  // worker stderr output.
  const child = spawn(process.execPath, ["--no-warnings", raceFixturePath, path, extensionId, barrierPath], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let readySettled = false;
  let resolveReady!: (value: { readonly phase: "ready"; readonly token: string }) => void;
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<{ readonly phase: "ready"; readonly token: string }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (readySettled || !stdout.includes("\n")) return;
    try {
      const parsed = JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as { phase?: unknown; token?: unknown };
      if (parsed.phase !== "ready" || typeof parsed.token !== "string") throw new Error("worker ready record is invalid");
      readySettled = true;
      resolveReady({ phase: "ready", token: parsed.token });
    } catch (error) {
      readySettled = true;
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const outcome = new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve) => {
    child.once("close", (code) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error(`config race worker exited before ready (${String(code)}): ${stderr}`));
      }
      resolve({ code, stdout, stderr });
    });
  });
  return { child, ready, outcome };
}

const LOCK_NONCE = "00000000-0000-4000-8000-000000000099";

/** An owner record in the shared Gateway Core transaction schema the connector now uses. */
function lockRecord(pid: number, processStartedAt: number): string {
  return `${JSON.stringify({
    schema: "morrow.exact-private-state-transaction.v1",
    nonce: LOCK_NONCE,
    pid,
    processStartedAt: new Date(processStartedAt).toISOString(),
    acquiredAt: Date.now(),
  })}\n`;
}

/** A lock left by the superseded connector-owned lock implementation. */
function legacyLockRecord(pid: number, processStartedAt: number): string {
  return `${JSON.stringify({
    schema: "morrow.canvas-connector.state-transaction.v1",
    nonce: "0".repeat(32),
    pid,
    processStartedAt: new Date(processStartedAt).toISOString(),
    acquiredAt: Date.now(),
  })}\n`;
}

function extensionIdFor(index: number): string {
  return index.toString(16).padStart(32, "0").replace(/[0-9a-f]/g, (digit) => (
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16))
  ));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "morrow-connector-config-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.json");
}

describe("Canvas connector config", () => {
  it("creates one stable token across concurrent first loads", async () => {
    const path = await statePath();
    const configs = await Promise.all(Array.from({ length: 20 }, async () => await loadCanvasConnectorConfig({
      MORROW_CANVAS_CONNECTOR_STATE: path,
    }, process.cwd())));

    expect(new Set(configs.map((config) => config.token))).toHaveLength(1);
    const persisted = JSON.parse(await readFile(path, "utf8")) as { token: string; allowedExtensionIds: string[] };
    expect(persisted.token).toBe(configs[0]!.token);
    expect(persisted.allowedExtensionIds).toEqual([]);
  });

  it("preserves every extension approved concurrently", async () => {
    const path = await statePath();
    const configs = await Promise.all(Array.from({ length: 8 }, async () => await loadCanvasConnectorConfig({
      MORROW_CANVAS_CONNECTOR_STATE: path,
    }, process.cwd())));
    const extensionIds = "abcdefghijklmnop".split("").map((character) => character.repeat(32));

    await Promise.all(extensionIds.map(async (extensionId, index) => {
      await configs[index % configs.length]!.approveExtensionId(extensionId);
    }));

    const persisted = JSON.parse(await readFile(path, "utf8")) as { allowedExtensionIds: string[] };
    expect(persisted.allowedExtensionIds).toEqual(extensionIds);
  });

  it("preserves one token and every approval across repeated operating-system process races", async () => {
    const extensionIds = "abcdefghijklmnop".split("").map((character) => character.repeat(32));
    for (let round = 0; round < 3; round += 1) {
      const path = await statePath();
      const barrierPath = `${path}.barrier`;
      const workers = extensionIds.map((extensionId) => configRaceWorker(path, extensionId, barrierPath));
      try {
        const ready = await Promise.all(workers.map(async (worker) => await worker.ready));
        expect(new Set(ready.map((record) => record.token))).toHaveLength(1);
        await writeFile(barrierPath, "ready\n", { flag: "wx", mode: 0o600 });
        const outcomes = await Promise.all(workers.map(async (worker) => await worker.outcome));
        expect(outcomes.map(({ code, stderr }) => ({ code, stderr }))).toEqual(
          extensionIds.map(() => ({ code: 0, stderr: "" })),
        );
        expect(outcomes.every(({ stdout }) => stdout.includes('"phase":"done"'))).toBe(true);
        const persisted = JSON.parse(await readFile(path, "utf8")) as { token: string; allowedExtensionIds: string[] };
        expect(persisted.token).toBe(ready[0]!.token);
        expect(persisted.allowedExtensionIds).toEqual(extensionIds);
      } finally {
        for (const worker of workers) {
          if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
        }
        await Promise.all(workers.map(async (worker) => await worker.outcome));
      }
    }
  }, 60_000);

  it("waits for an exact live owner and reclaims its lock after that process exits", async () => {
    const path = await statePath();
    const holder = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setTimeout(() => {}, 300)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout!.once("data", () => { resolve(); });
        holder.once("error", reject);
        holder.once("exit", (code) => { if (code !== 0) reject(new Error(`lock holder exited with ${String(code)}`)); });
      });
      const startedAt = readProcessStartedAt(holder.pid!);
      expect(startedAt).not.toBeNull();
      await writeFile(`${path}.transaction.lock`, lockRecord(holder.pid!, startedAt!), { mode: 0o600, flag: "wx" });
      const started = Date.now();
      await loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: path }, process.cwd());
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      await expect(readFile(`${path}.transaction.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    }
  }, 10_000);

  it("reclaims a lock whose live PID has a different exact process lifetime", async () => {
    const path = await statePath();
    const lockPath = `${path}.transaction.lock`;
    const claimPath = `${lockPath}.reclaim-${LOCK_NONCE}`;
    const startedAt = readProcessStartedAt(process.pid);
    expect(startedAt).not.toBeNull();
    await writeFile(lockPath, lockRecord(process.pid, startedAt! - 60_000), { mode: 0o600, flag: "wx" });
    await link(lockPath, claimPath);

    const config = await loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: path }, process.cwd());

    expect(config.token.length).toBeGreaterThanOrEqual(32);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(claimPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects linked, oversized, and broadly readable transaction locks through the shared primitive", async () => {
    const startedAt = readProcessStartedAt(process.pid);
    expect(startedAt).not.toBeNull();
    const lock = `${await statePath()}.transaction.lock`;
    const linkedTarget = lockRecord(process.pid, startedAt!);
    await writeFile(`${lock}.target`, linkedTarget, { mode: 0o600 });
    await symlink(`${lock}.target`, lock);
    const hardLinked = `${await statePath()}.transaction.lock`;
    await writeFile(hardLinked, lockRecord(process.pid, startedAt!), { mode: 0o600 });
    await link(hardLinked, `${hardLinked}.other-name`);
    const broad = `${await statePath()}.transaction.lock`;
    await writeFile(broad, lockRecord(process.pid, startedAt!), { mode: 0o600 });
    await chmod(broad, 0o644);
    const oversized = `${await statePath()}.transaction.lock`;
    await writeFile(oversized, "x".repeat(4 * 1024 + 1), { mode: 0o600 });

    // A damaged lock stays a fail-closed barrier until the shared admission bound passes.
    const load = (lockPath: string) => loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: lockPath.slice(0, -".transaction.lock".length) }, process.cwd());
    await Promise.all([
      expect(load(lock)).rejects.toThrow("connector state transaction owner is not one exact private file"),
      expect(load(hardLinked)).rejects.toThrow("connector state transaction owner is not one exact private file"),
      expect(load(broad)).rejects.toThrow("connector state transaction owner"),
      expect(load(oversized)).rejects.toThrow("connector state transaction owner"),
    ]);
    expect(await readFile(`${lock}.target`, "utf8")).toBe(linkedTarget);
  }, 30_000);

  it("reclaims only a dead owner's lock from the superseded connector lock schema", async () => {
    const path = await statePath();
    const lockPath = `${path}.transaction.lock`;
    const startedAt = readProcessStartedAt(process.pid);
    expect(startedAt).not.toBeNull();
    const liveLegacy = legacyLockRecord(process.pid, startedAt!);
    await writeFile(lockPath, liveLegacy, { mode: 0o600, flag: "wx" });
    await expect(loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: path }, process.cwd()))
      .rejects.toThrow("connector state transaction owner is invalid");
    expect(await readFile(lockPath, "utf8")).toBe(liveLegacy);

    await rm(lockPath);
    await writeFile(lockPath, legacyLockRecord(process.pid, startedAt! - 60_000), { mode: 0o600, flag: "wx" });
    const config = await loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: path }, process.cwd());
    expect(config.token.length).toBeGreaterThanOrEqual(32);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("refuses malformed extension ids before changing state", async () => {
    const path = await statePath();
    const config = await loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: path }, process.cwd());
    await expect(config.approveExtensionId("not-a-chrome-extension-id")).rejects.toThrow("connector extension ids are invalid");
    const persisted = JSON.parse(await readFile(path, "utf8")) as { allowedExtensionIds: string[] };
    expect(persisted.allowedExtensionIds).toEqual([]);
  });

  it("refuses linked, oversized, and broadly readable bearer-token state", async () => {
    const linked = await statePath();
    const target = `${linked}.target`;
    const state = `${JSON.stringify({
      schema: "morrow.canvas-connector.state.v1",
      token: "t".repeat(48),
      port: 32147,
      allowedExtensionIds: [],
    })}\n`;
    await writeFile(target, state, { mode: 0o600 });
    await symlink(target, linked);
    await expect(loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: linked }, process.cwd()))
      .rejects.toThrow("bounded private regular file");

    const broad = await statePath();
    await writeFile(broad, state, { mode: 0o600 });
    await chmod(broad, 0o644);
    await expect(loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: broad }, process.cwd()))
      .rejects.toThrow("bounded private regular file");

    const oversized = await statePath();
    await writeFile(oversized, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    await expect(loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: oversized }, process.cwd()))
      .rejects.toThrow("bounded private regular file");

    const growth = await statePath();
    let allowedExtensionIds: string[] = [];
    let nextExtensionId = "";
    for (let index = 0; ; index += 1) {
      const candidate = extensionIdFor(index);
      const candidateState = `${JSON.stringify({
        schema: "morrow.canvas-connector.state.v1",
        token: "t".repeat(48),
        port: 32147,
        allowedExtensionIds: [...allowedExtensionIds, candidate],
      })}\n`;
      if (Buffer.byteLength(candidateState) > 64 * 1024) {
        nextExtensionId = candidate;
        break;
      }
      allowedExtensionIds = [...allowedExtensionIds, candidate];
    }
    const acceptedState = `${JSON.stringify({
      schema: "morrow.canvas-connector.state.v1",
      token: "t".repeat(48),
      port: 32147,
      allowedExtensionIds,
    })}\n`;
    await writeFile(growth, acceptedState, { mode: 0o600 });
    const growthConfig = await loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: growth }, process.cwd());
    await expect(growthConfig.approveExtensionId(nextExtensionId)).rejects.toThrow("connector state file is too large");
    expect(await readFile(growth, "utf8")).toBe(acceptedState);
  });

  it("refuses malformed UTF-8 instead of changing the saved bearer token", async () => {
    const path = await statePath();
    await writeFile(path, Buffer.concat([
      Buffer.from(`{"schema":"morrow.canvas-connector.state.v1","token":"${"a".repeat(40)}`),
      Buffer.from([0xff]),
      Buffer.from(`${"b".repeat(8)}","port":32147,"allowedExtensionIds":[]}\n`),
    ]), { mode: 0o600 });

    await expect(loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: path }, process.cwd()))
      .rejects.toThrow("connector state file is not valid UTF-8");
  });

  it("binds a configured parent alias to the canonical state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "morrow-connector-config-alias-"));
    temporaryDirectories.push(root);
    const first = join(root, "first");
    const second = join(root, "second");
    const alias = join(root, "active");
    await mkdir(first, { mode: 0o700 });
    await mkdir(second, { mode: 0o700 });
    await symlink(first, alias, "dir");

    const config = await loadCanvasConnectorConfig({
      MORROW_CANVAS_CONNECTOR_STATE: join(alias, "state.json"),
    }, process.cwd());
    expect(config.statePath).toBe(join(await realpath(first), "state.json"));

    await rm(alias);
    await symlink(second, alias, "dir");
    const extensionId = "a".repeat(32);
    await config.approveExtensionId(extensionId);
    expect(JSON.parse(await readFile(join(first, "state.json"), "utf8")).allowedExtensionIds).toEqual([extensionId]);
    expect(await readdir(second)).toEqual([]);
  });
});
