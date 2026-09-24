import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entryPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const fakeUpstream = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const simulation = fileURLToPath(new URL("./fixtures/windows-powershell-simulation.cjs", import.meta.url));

// A Windows host starts one PowerShell process for each access-control
// question, and each start costs hundreds of milliseconds there. One owner
// start checks 24 distinct paths, which took 92 PowerShell starts when each
// read asked about its file and parent separately. Asking once per path per
// start, with a file and its parent, or several SQLite files, in one question,
// takes 17. The start must stay at or under this limit.
const OWNER_START_POWERSHELL_LIMIT = 20;

interface SimulatedInvocation {
  readonly at: number;
  readonly kind: "check" | "apply" | "apply-and-check" | "process" | "other";
  readonly paths?: readonly string[];
}

async function writeConfig(directory: string): Promise<string> {
  const configPath = join(directory, "morrow.upstreams.json");
  await writeFile(configPath, `${JSON.stringify({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "full",
    sourcePolicy: { requireAttestation: false },
    upstreams: [{
      id: "morrow-legacy",
      label: "Fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fakeUpstream],
      env: { FAKE_SOURCE: "morrow-legacy" },
      priority: 1,
      required: true,
      enabled: true,
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(directory, "gateway.sqlite3") },
    batchScheduler: { maxConcurrentWindows: 1 },
    maxCatalogTools: 100,
  })}\n`, "utf8");
  return configPath;
}

async function startSimulatedOwner(directory: string, configPath: string, logPath: string): Promise<{ stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ["--require", simulation, entryPath, "--morrow-local-owner"], {
    cwd: directory,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      HOME: directory,
      USERPROFILE: directory,
      MORROW_HOME: join(directory, ".morrow"),
      MORROW_UPSTREAMS_FILE: configPath,
      MORROW_POWERSHELL_SIMULATION_LOG: logPath,
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`the simulated owner did not become ready: ${stderr}`)), 20_000);
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("[morrow] local owner ready")) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`the simulated owner exited with ${code}: ${stderr}`));
    });
  });
  return {
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

describe("local owner start on Windows", () => {
  it("asks PowerShell about each path once and stays within a fixed number of PowerShell starts", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "morrow-owner-windows-acl-")));
    const logPath = join(directory, "powershell.jsonl");
    const configPath = await writeConfig(directory);
    const owner = await startSimulatedOwner(directory, configPath, logPath);
    try {
      expect(existsSync(join(directory, "gateway.sqlite3.local-owner.json"))).toBe(true);
      const invocations = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SimulatedInvocation);
      const acl = invocations.filter((entry) => entry.kind !== "process");
      expect(acl.filter((entry) => entry.kind === "other")).toEqual([]);

      // A path is asked about again only after Morrow changed its access control.
      const repeated: string[] = [];
      const answered = new Set<string>();
      for (const entry of acl) {
        if (entry.kind === "apply" || entry.kind === "apply-and-check") {
          for (const path of entry.paths ?? []) answered.delete(path);
        }
        if (entry.kind === "check" || entry.kind === "apply-and-check") {
          for (const path of entry.paths ?? []) {
            if (answered.has(path)) repeated.push(path.slice(directory.length));
            answered.add(path);
          }
        }
      }
      expect(repeated).toEqual([]);
      expect(acl.some((entry) => (entry.paths?.length ?? 0) > 1)).toBe(true);
      expect(acl.length).toBeLessThanOrEqual(OWNER_START_POWERSHELL_LIMIT);
    } finally {
      await owner.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
