import { spawnSync } from "node:child_process";

export type ProcessLifetimeMatcher = (pid: number, observedAt: string) => boolean | null;

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

export function readProcessStartedAt(pid: number): number | null {
  if (!exactPid(pid) || !processAlive(pid)) return null;
  if (process.platform === "win32") {
    const executable = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$process = [System.Diagnostics.Process]::GetProcessById(${pid})`,
      "$process.StartTime.ToUniversalTime().ToString('o')",
    ].join("; ");
    const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 8 * 1024,
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) return null;
    const startedAt = Date.parse(result.stdout.trim());
    return Number.isFinite(startedAt) ? startedAt : null;
  }
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 3_000,
    maxBuffer: 8 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return null;
  const startedAt = Date.parse(result.stdout.trim());
  return Number.isFinite(startedAt) ? startedAt : null;
}

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

/** Whether this PID has the exact start time recorded by current authority. */
export function processMatchesExactStart(
  pid: number,
  recordedStartedAt: string,
  readStartedAt: (pid: number) => number | null = readProcessStartedAt,
): boolean | null {
  const expected = Date.parse(recordedStartedAt);
  if (!exactPid(pid) || !Number.isFinite(expected) || !processAlive(pid)) return false;
  const startedAt = readStartedAt(pid);
  return startedAt === null ? null : startedAt === expected;
}
