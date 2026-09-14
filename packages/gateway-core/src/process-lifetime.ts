import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type ProcessLifetimeMatcher = (pid: number, observedAt: string) => boolean | null;

export interface ProcessLifetimeSourceOptions {
  readonly platform?: NodeJS.Platform;
  /** The procfs root read on Linux. Tests point it at a fixture tree. */
  readonly procRoot?: string;
  readonly spawnSync?: typeof spawnSync;
  readonly spawn?: typeof spawn;
}

/** Linux reports `/proc` clock ticks in USER_HZ, which is fixed at 100 for that interface. */
const LINUX_TICKS_PER_SECOND = 100;
const PROCESS_QUERY_TIMEOUT_MS = 3_000;
const PROCESS_QUERY_MAX_BYTES = 8 * 1024;
const PROCESS_QUERY_ATTEMPTS = 3;
/**
 * How long a request-path liveness answer may rely on a start time read
 * earlier. `process.kill(pid, 0)` still runs on every call, so a dead process
 * is never reported alive; only a process id reused by a new process inside
 * this window can be mistaken for the recorded one.
 */
export const PROCESS_LIFETIME_CACHE_MS = 5_000;

function exactPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
}

function processAlive(pid: number): boolean {
  if (!exactPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const linuxBootTimeByRoot = new Map<string, number | null>();

/** The boot instant in epoch milliseconds, read once per procfs root so every answer shares one origin. */
function linuxBootTimeMs(procRoot: string): number | null {
  const known = linuxBootTimeByRoot.get(procRoot);
  if (known !== undefined) return known;
  let value: number | null = null;
  try {
    const match = readFileSync(`${procRoot}/stat`, "utf8").match(/^btime\s+([0-9]+)\s*$/mu);
    value = match ? Number(match[1]) * 1_000 : null;
  } catch {
    value = null;
  }
  if (value !== null && !Number.isSafeInteger(value)) value = null;
  linuxBootTimeByRoot.set(procRoot, value);
  return value;
}

/** Parses the `starttime` clock-tick field of one `/proc/<pid>/stat` line into epoch milliseconds. */
export function linuxProcessStartedAtFromStat(stat: string, bootTimeMs: number): number | null {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  // Fields after the command name begin at field 3 (state); starttime is field 22.
  const ticks = Number(fields[22 - 3]);
  if (!Number.isSafeInteger(ticks) || ticks < 0) return null;
  return bootTimeMs + Math.floor(ticks * (1_000 / LINUX_TICKS_PER_SECOND));
}

function linuxProcessStartedAt(pid: number, procRoot: string): number | null {
  const bootTimeMs = linuxBootTimeMs(procRoot);
  if (bootTimeMs === null) return null;
  let stat: string;
  try {
    stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  return linuxProcessStartedAtFromStat(stat, bootTimeMs);
}

interface ProcessQuery {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function processStartQuery(pid: number, platform: NodeJS.Platform): ProcessQuery {
  if (platform === "win32") {
    const executable = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$process = [System.Diagnostics.Process]::GetProcessById(${pid})`,
      "$process.StartTime.ToUniversalTime().ToString('o')",
    ].join("; ");
    return { executable, arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], env: process.env };
  }
  // `LC_ALL=C` fixes the month names so a localised system prints a form Date.parse reads.
  return { executable: "/bin/ps", arguments: ["-o", "lstart=", "-p", String(pid)], env: { ...process.env, LC_ALL: "C" } };
}

/** Parses one `ps -o lstart=` or PowerShell start-time line into epoch milliseconds. */
export function parseProcessStartOutput(output: string): number | null {
  const startedAt = Date.parse(String(output || "").trim());
  return Number.isFinite(startedAt) ? startedAt : null;
}

function queriedProcessStartedAt(pid: number, platform: NodeJS.Platform, run: typeof spawnSync): number | null {
  const query = processStartQuery(pid, platform);
  for (let attempt = 0; attempt < PROCESS_QUERY_ATTEMPTS; attempt += 1) {
    let result: ReturnType<typeof spawnSync>;
    try {
      result = run(query.executable, [...query.arguments], {
        encoding: "utf8",
        env: query.env,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer: PROCESS_QUERY_MAX_BYTES,
        windowsHide: true,
      });
    } catch {
      continue;
    }
    if (result.error) continue;
    if (result.status !== 0) return null;
    return parseProcessStartOutput(String(result.stdout));
  }
  return null;
}

function queryProcessStartedAt(pid: number, platform: NodeJS.Platform, run: typeof spawn): Promise<number | null> {
  const query = processStartQuery(pid, platform);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = run(query.executable, [...query.arguments], {
        env: query.env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let bytes = 0;
    const output: Buffer[] = [];
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* the process already ended */ }
      finish(null);
    }, PROCESS_QUERY_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= PROCESS_QUERY_MAX_BYTES) output.push(Buffer.from(chunk));
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      finish(code === 0 && bytes <= PROCESS_QUERY_MAX_BYTES ? parseProcessStartOutput(Buffer.concat(output).toString("utf8")) : null);
    });
  });
}

/**
 * The exact start instant of one live process, or null when no source can
 * state it. Linux reads procfs and never starts a process. Other platforms
 * ask the operating system through one bounded child process, so call this
 * once per lifecycle decision, never per request.
 */
export function readProcessStartedAt(pid: number, options: ProcessLifetimeSourceOptions = {}): number | null {
  if (!exactPid(pid) || !processAlive(pid)) return null;
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    const fromProc = linuxProcessStartedAt(pid, options.procRoot ?? "/proc");
    if (fromProc !== null) return fromProc;
  }
  return queriedProcessStartedAt(pid, platform, options.spawnSync ?? spawnSync);
}

/** The same answer as {@link readProcessStartedAt}, without blocking the event loop on any platform. */
export async function readProcessStartedAtAsync(pid: number, options: ProcessLifetimeSourceOptions = {}): Promise<number | null> {
  if (!exactPid(pid) || !processAlive(pid)) return null;
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    const fromProc = linuxProcessStartedAt(pid, options.procRoot ?? "/proc");
    if (fromProc !== null) return fromProc;
  }
  return queryProcessStartedAt(pid, platform, options.spawn ?? spawn);
}

interface CachedProcessStart {
  startedAt: number | null;
  refreshedAt: number;
  refresh: Promise<void> | null;
}

/**
 * Builds a liveness matcher for request paths. It never starts a process
 * synchronously: Linux answers from procfs, and every other platform answers
 * from a start time cached for at most {@link PROCESS_LIFETIME_CACHE_MS} and
 * refreshed in the background. Until the first refresh settles the answer is
 * null, which callers already treat as "not proven dead".
 */
export function createRequestPathProcessMatcher(options: ProcessLifetimeSourceOptions = {}): ProcessLifetimeMatcher & {
  readonly settled: () => Promise<void>;
} {
  const platform = options.platform ?? process.platform;
  const procRoot = options.procRoot ?? "/proc";
  const run = options.spawn ?? spawn;
  const cache = new Map<number, CachedProcessStart>();
  const startedAtFor = (pid: number): number | null | undefined => {
    if (platform === "linux") {
      const fromProc = linuxProcessStartedAt(pid, procRoot);
      if (fromProc !== null) return fromProc;
    }
    const now = Date.now();
    let entry = cache.get(pid);
    if (entry && now - entry.refreshedAt <= PROCESS_LIFETIME_CACHE_MS) return entry.startedAt;
    if (!entry) {
      entry = { startedAt: null, refreshedAt: 0, refresh: null };
      cache.set(pid, entry);
    }
    if (!entry.refresh) {
      const current = entry;
      current.refresh = queryProcessStartedAt(pid, platform, run).then((startedAt) => {
        current.startedAt = startedAt;
        current.refreshedAt = Date.now();
        current.refresh = null;
      });
    }
    return entry.refreshedAt === 0 ? undefined : entry.startedAt;
  };
  const matcher = (pid: number, observedAt: string): boolean | null => {
    const boundary = Date.parse(observedAt);
    if (!exactPid(pid) || !Number.isFinite(boundary) || !processAlive(pid)) {
      cache.delete(pid);
      return false;
    }
    const startedAt = startedAtFor(pid);
    if (startedAt === undefined || startedAt === null) return null;
    return startedAt <= boundary;
  };
  return Object.assign(matcher, {
    settled: async (): Promise<void> => {
      await Promise.all([...cache.values()].map((entry) => entry.refresh ?? Promise.resolve()));
    },
  });
}

/** The process-wide request-path matcher shared by every owner request. */
export const requestPathProcessMatches: ProcessLifetimeMatcher = createRequestPathProcessMatcher();

/** Whether this PID still denotes the process observed by a durable record. */
export function processMatchesRecordedLifetime(
  pid: number,
  observedAt: string,
  readStartedAt: (pid: number) => number | null = readProcessStartedAt,
): boolean | null {
  const boundary = Date.parse(observedAt);
  if (!exactPid(pid) || !Number.isFinite(boundary) || !processAlive(pid)) return false;
  const startedAt = readStartedAt(pid);
  return startedAt === null ? null : startedAt <= boundary;
}

/**
 * The asynchronous form for lifecycle decisions that must wait for an
 * authoritative process-start answer without blocking the event loop.
 */
export async function processMatchesRecordedLifetimeAsync(
  pid: number,
  observedAt: string,
  readStartedAt: (pid: number) => Promise<number | null> = readProcessStartedAtAsync,
): Promise<boolean | null> {
  const boundary = Date.parse(observedAt);
  if (!exactPid(pid) || !Number.isFinite(boundary) || !processAlive(pid)) return false;
  const startedAt = await readStartedAt(pid);
  if (!processAlive(pid)) return false;
  return startedAt === null ? null : startedAt <= boundary;
}

/** Whether this PID has the exact start time recorded by current authority. */
export function processMatchesExactStart(
  pid: number,
  recordedStartedAt: string,
  readStartedAt: (pid: number) => number | null = readProcessStartedAt,
): boolean | null {
  const expected = Date.parse(recordedStartedAt);
  if (!exactPid(pid) || !Number.isFinite(expected) || !processAlive(pid)) return false;
  const startedAt = readStartedAt(pid);
  // Recorded starts may come from a whole-second source such as `ps`, while
  // procfs answers to the tick, so identity is the same whole second.
  return startedAt === null ? null : Math.floor(startedAt / 1_000) === Math.floor(expected / 1_000);
}
