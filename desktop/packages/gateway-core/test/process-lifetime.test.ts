import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROCESS_LIFETIME_CACHE_MS,
  createRequestPathProcessMatcher,
  linuxProcessStartedAtFromStat,
  parseProcessStartOutput,
  processMatchesExactStart,
  processMatchesRecordedLifetimeAsync,
  readProcessStartedAt,
  readProcessStartedAtAsync,
} from "../src/process-lifetime.js";

const ENGLISH_START = "Tue Mar  3 16:40:12 2026";
const GERMAN_START = "Di 3. Mär 16:40:12 2026";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A procfs tree naming one process that started 123.45 s after a fixed boot. */
function procFixture(pid: number, ticks = 12_345): string {
  const root = mkdtempSync(join(tmpdir(), "morrow-proc-"));
  roots.push(root);
  writeFileSync(join(root, "stat"), "cpu  1 2 3 4\nbtime 1700000000\nprocesses 42\n");
  mkdirSync(join(root, String(pid)));
  writeFileSync(join(root, String(pid), "stat"), `${pid} (node (x) y) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 ${ticks} 1000 200 18446744073709551615\n`);
  return root;
}

const absentPs = (): never => { throw Object.assign(new Error("spawn /bin/ps ENOENT"), { code: "ENOENT" }); };

function localisedPs(calls: string[] = []): typeof import("node:child_process").spawnSync {
  return ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push(String(options.env?.LC_ALL));
    return { status: 0, stdout: `${options.env?.LC_ALL === "C" ? ENGLISH_START : GERMAN_START}\n`, stderr: "", pid: 1, output: [], signal: null };
  }) as unknown as typeof import("node:child_process").spawnSync;
}

describe("process lifetime", () => {
  it("parses a procfs stat line whose command name carries spaces and parentheses", () => {
    expect(linuxProcessStartedAtFromStat("7 (a (b) c) S 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 250 0 0 0\n", 1_000_000)).toBe(1_002_500);
    expect(linuxProcessStartedAtFromStat("garbage", 1_000_000)).toBeNull();
  });

  it("reads a Linux start time from procfs and never starts a process", () => {
    const root = procFixture(process.pid);
    expect(readProcessStartedAt(process.pid, { platform: "linux", procRoot: root, spawnSync: absentPs })).toBe(1_700_000_000_000 + 123_450);
  });

  it.runIf(process.platform === "linux")("agrees with the live kernel about this process", () => {
    const startedAt = readProcessStartedAt(process.pid, { spawnSync: absentPs });
    expect(startedAt).not.toBeNull();
    expect(startedAt!).toBeLessThanOrEqual(performance.timeOrigin);
    expect(startedAt!).toBeGreaterThan(performance.timeOrigin - 60_000);
  });

  it("reads a localised ps through the C locale so month names parse", () => {
    const calls: string[] = [];
    expect(parseProcessStartOutput(GERMAN_START)).toBeNull();
    expect(readProcessStartedAt(process.pid, { platform: "darwin", spawnSync: localisedPs(calls) })).toBe(Date.parse(ENGLISH_START));
    expect(calls).toEqual(["C"]);
  });

  it("answers null instead of throwing when the platform query is unavailable", async () => {
    expect(readProcessStartedAt(process.pid, { platform: "darwin", spawnSync: absentPs })).toBeNull();
    expect(await readProcessStartedAtAsync(process.pid, { platform: "darwin", spawn: absentPs as unknown as typeof spawn })).toBeNull();
    expect(readProcessStartedAt(0)).toBeNull();
  });

  it("matches exact starts by whole second because ps records whole seconds", () => {
    const read = (): number => 1_700_000_000_920;
    expect(processMatchesExactStart(process.pid, new Date(1_700_000_000_000).toISOString(), read)).toBe(true);
    expect(processMatchesExactStart(process.pid, new Date(1_700_000_001_000).toISOString(), read)).toBe(false);
    expect(processMatchesExactStart(process.pid, "not-a-time", read)).toBe(false);
    expect(processMatchesExactStart(process.pid, new Date(1_700_000_000_000).toISOString(), () => null)).toBeNull();
  });

  it("waits for an authoritative process lifetime on lifecycle paths", async () => {
    const observedAt = new Date(1_700_000_001_000).toISOString();
    expect(await processMatchesRecordedLifetimeAsync(process.pid, observedAt, async () => 1_700_000_000_000)).toBe(true);
    expect(await processMatchesRecordedLifetimeAsync(process.pid, observedAt, async () => 1_700_000_002_000)).toBe(false);
    expect(await processMatchesRecordedLifetimeAsync(process.pid, observedAt, async () => null)).toBeNull();
    expect(await processMatchesRecordedLifetimeAsync(process.pid, "not-a-time", async () => 1_700_000_000_000)).toBe(false);
    expect(await processMatchesRecordedLifetimeAsync(2_147_483_647, observedAt, async () => 1_700_000_000_000)).toBe(false);
  });

  it("serves concurrent request-path liveness checks from one background query and never blocks", async () => {
    let spawned = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fakeSpawn = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawned += 1;
      expect(command).toBe("/bin/ps");
      expect(args).toEqual(["-o", "lstart=", "-p", String(process.pid)]);
      expect(options.env?.LC_ALL).toBe("C");
      const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(process.argv[1]); process.exit(0); })", ENGLISH_START], { stdio: ["pipe", "pipe", "ignore"] });
      void gate.then(() => child.stdin?.end());
      return child;
    }) as unknown as typeof spawn;
    const matches = createRequestPathProcessMatcher({ platform: "darwin", spawn: fakeSpawn });
    const observedAt = new Date(Date.parse(ENGLISH_START) + 1_000).toISOString();

    const answers = Array.from({ length: 32 }, () => matches(process.pid, observedAt));
    expect(answers).toEqual(Array.from({ length: 32 }, () => null));
    expect(spawned).toBe(1);

    release!();
    await matches.settled();
    expect(matches(process.pid, observedAt)).toBe(true);
    expect(matches(process.pid, new Date(Date.parse(ENGLISH_START) - 1_000).toISOString())).toBe(false);
    expect(spawned).toBe(1);
    expect(PROCESS_LIFETIME_CACHE_MS).toBeGreaterThan(0);
  });

  it("answers Linux request-path liveness from procfs without any child process", () => {
    const root = procFixture(process.pid);
    const matches = createRequestPathProcessMatcher({ platform: "linux", procRoot: root, spawn: absentPs as unknown as typeof spawn });
    expect(matches(process.pid, new Date(1_700_000_000_000 + 200_000).toISOString())).toBe(true);
    expect(matches(process.pid, new Date(1_700_000_000_000).toISOString())).toBe(false);
    expect(matches(2_147_483_647, new Date().toISOString())).toBe(false);
  });
});
