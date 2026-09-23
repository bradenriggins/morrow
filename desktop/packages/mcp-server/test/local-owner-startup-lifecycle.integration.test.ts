import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const fixtureUrl = pathToFileURL(fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url))).href;
const entryPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Waits for a process to write its PID to `path`. A busy computer only makes
 * this wait longer: it fails when `launcher` exits first, and the test's own
 * limit ends a wait that never settles.
 */
async function waitForPid(path: string, launcher: ChildProcessWithoutNullStreams): Promise<number> {
  for (;;) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {}
    if (launcher.exitCode !== null || launcher.signalCode !== null) {
      throw new Error(`the launched process exited before ${path} named a PID`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writeConfig(
  directory: string,
  journalPath: string,
  delayMs: number,
): Promise<{ configPath: string; upstreamPidPath: string; lifecyclePath: string }> {
  const configPath = join(directory, "morrow.upstreams.json");
  const upstreamPidPath = join(directory, "upstream.pid");
  const lifecyclePath = join(directory, "upstream.lifecycle");
  const delayedEntry = [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(upstreamPidPath)}, String(process.pid), "utf8");`,
    `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
    `await import(${JSON.stringify(fixtureUrl)});`,
  ].join(" ");
  await writeFile(configPath, `${JSON.stringify({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "full",
    sourcePolicy: { requireAttestation: false },
    upstreams: [{
      id: "morrow-legacy",
      label: "Delayed lifecycle fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: ["--input-type=module", "-e", delayedEntry],
      env: {
        FAKE_SOURCE: "morrow-legacy",
        FAKE_LIFECYCLE_LOG: lifecyclePath,
      },
      priority: 1,
      required: true,
      enabled: true,
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: journalPath },
    privacy: {
      canvasOrigin: "local",
      account: "local-account",
      principal: "local-principal",
      learnerVaultPath: join(directory, "learner-vault.json"),
    },
    maxCatalogTools: 20,
  }, null, 2)}\n`, "utf8");
  return { configPath, upstreamPidPath, lifecyclePath };
}

function launch(configPath: string, env: Record<string, string> = {}): {
  child: ChildProcessWithoutNullStreams;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
} {
  const child = spawn(process.execPath, [entryPath], {
    stdio: "pipe",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      MORROW_UPSTREAMS_FILE: configPath,
      ...env,
    },
  });
  let errorOutput = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exit, stderr: () => errorOutput };
}

describe("local owner startup lifecycle", () => {
  it("aborts a never-answering runtime connection when dedicated stdin ends", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-dedicated-startup-close-"));
    const { configPath, upstreamPidPath, lifecyclePath } = await writeConfig(directory, ":memory:", 60_000);
    const processRun = launch(configPath);
    let upstreamPid = 0;
    try {
      upstreamPid = await waitForPid(upstreamPidPath, processRun.child);
      processRun.child.stdin.end();

      await expect(processRun.exit).resolves.toEqual({ code: 0, signal: null });
      expect(processIsAlive(upstreamPid)).toBe(false);
      expect(existsSync(lifecyclePath)).toBe(false);
    } finally {
      if (processRun.child.exitCode === null && processRun.child.signalCode === null) processRun.child.kill("SIGKILL");
      if (upstreamPid && processIsAlive(upstreamPid)) process.kill(upstreamPid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("reclaims the exact owner and upstream launched by a timed-out proxy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-owner-startup-timeout-"));
    const journalPath = join(directory, "gateway.sqlite3");
    const ownerPath = `${journalPath}.local-owner.json`;
    const ownerStderrPath = join(directory, "owner.stderr");
    const { configPath, upstreamPidPath, lifecyclePath } = await writeConfig(directory, journalPath, 60_000);
    // The proxy's one-second start limit begins when the owner's upstream has
    // started, so the timed-out owner always has an upstream to reclaim.
    const processRun = launch(configPath, {
      MORROW_INSTALLER_TEST_MODE: "1",
      MORROW_LOCAL_OWNER_TEST_START_TIMEOUT_MS: "1000",
      MORROW_LOCAL_OWNER_TEST_START_TIMEOUT_AFTER_PATH: upstreamPidPath,
      MORROW_LOCAL_OWNER_TEST_STDERR_PATH: ownerStderrPath,
    });
    let upstreamPid = 0;
    try {
      upstreamPid = await waitForPid(upstreamPidPath, processRun.child);
      const result = await processRun.exit;

      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(processRun.stderr()).toContain("Morrow local owner did not become ready");
      expect(processIsAlive(upstreamPid)).toBe(false);
      expect(existsSync(ownerPath)).toBe(false);
      expect(existsSync(lifecyclePath)).toBe(false);
    } finally {
      if (processRun.child.exitCode === null && processRun.child.signalCode === null) processRun.child.kill("SIGKILL");
      if (upstreamPid && processIsAlive(upstreamPid)) process.kill(upstreamPid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("force-kills a stubborn exact owner and settles the startup failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-stubborn-owner-timeout-"));
    const journalPath = join(directory, "gateway.sqlite3");
    const ownerStderrPath = join(directory, "owner.stderr");
    const { configPath } = await writeConfig(directory, journalPath, 60_000);
    const ownerPidPath = join(directory, "owner.pid");
    // The proxy's one-second start limit begins when the stubborn owner has
    // started, so the proxy always has that owner to force-kill.
    const processRun = launch(configPath, {
      MORROW_INSTALLER_TEST_MODE: "1",
      MORROW_LOCAL_OWNER_TEST_START_TIMEOUT_MS: "1000",
      MORROW_LOCAL_OWNER_TEST_START_TIMEOUT_AFTER_PATH: ownerPidPath,
      MORROW_LOCAL_OWNER_TEST_STDERR_PATH: ownerStderrPath,
      MORROW_LOCAL_OWNER_TEST_STUBBORN_STARTUP: "1",
      MORROW_LOCAL_OWNER_TEST_STUBBORN_PID_PATH: ownerPidPath,
    });
    let ownerPid = 0;
    try {
      ownerPid = await waitForPid(ownerPidPath, processRun.child);
      const result = await processRun.exit;
      const ownerError = await readFile(ownerStderrPath, "utf8");
      expect(Number(/stubborn local owner pid=(\d+)/u.exec(ownerError)?.[1])).toBe(ownerPid);

      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(processRun.stderr()).toContain("Morrow local owner did not become ready");
      expect(Number.isSafeInteger(ownerPid)).toBe(true);
      expect(processIsAlive(ownerPid)).toBe(false);
    } finally {
      if (processRun.child.exitCode === null && processRun.child.signalCode === null) processRun.child.kill("SIGKILL");
      if (ownerPid && processIsAlive(ownerPid)) process.kill(ownerPid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
