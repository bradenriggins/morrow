import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const entryPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function waitUntil(predicate: () => boolean, detail: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function writeConfig(directory: string): Promise<{ configPath: string; journalPath: string }> {
  const configPath = join(directory, "morrow.upstreams.json");
  const journalPath = join(directory, "gateway.sqlite3");
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
      args: [fixturePath],
      env: { FAKE_SOURCE: "morrow-legacy" },
      priority: 1,
      required: true,
      enabled: true,
      outputPrivacy: {
        canvas_page_get: {
          allowedFields: ["source", "course_id"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 2_000,
          freeText: "allow",
          learnerTokens: false,
          artifactInspection: "deny",
        },
      },
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
  return { configPath, journalPath };
}

describe("local owner state-lease lifecycle", () => {
  it("closes the serving owner after its heartbeat loses the exact lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-owner-lease-loss-"));
    const { configPath, journalPath } = await writeConfig(directory);
    const ownerPath = `${journalPath}.local-owner.json`;
    const lockPath = `${journalPath}.runtime.lock`;
    const displacedPath = `${lockPath}.displaced`;
    const replacement = "replacement lease remains byte exact\n";
    let stderr = "";
    const owner = spawn(process.execPath, [entryPath, "--morrow-local-owner"], {
      env: { ...process.env, MORROW_UPSTREAMS_FILE: configPath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    owner.stderr.setEncoding("utf8");
    owner.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      owner.once("error", reject);
      owner.once("exit", (code, signal) => resolve({ code, signal }));
    });

    try {
      await waitUntil(() => {
        if (owner.exitCode !== null || owner.signalCode !== null) {
          throw new Error(`local owner exited before readiness: ${stderr}`);
        }
        return existsSync(ownerPath) && existsSync(lockPath);
      }, "local owner readiness", 8_000);

      await rename(lockPath, displacedPath);
      await writeFile(lockPath, replacement, { flag: "wx", mode: 0o600 });

      const result = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("local owner kept serving after lease loss")), 13_000);
          timer.unref();
        }),
      ]);
      expect(result).toEqual({ code: 1, signal: null });
      expect(stderr).toContain("runtime state lease lost");
      expect(await readFile(lockPath, "utf8")).toBe(replacement);
      expect(existsSync(ownerPath)).toBe(false);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      await exited.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
