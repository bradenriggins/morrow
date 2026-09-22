import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// A host with no `ps` and no way to start one: every child-process entry
// point fails, so only procfs can answer, and no request path may block.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const absent = (): never => { throw Object.assign(new Error("spawn /bin/ps ENOENT"), { code: "ENOENT" }); };
  return { ...actual, spawnSync: absent, spawn: absent, execFileSync: absent, execSync: absent };
});

const { LearnerVault, processMatchesRecordedLifetime, requestPathProcessMatches, withExactPrivateStateFileTransaction } = await import("../src/index.js");

const scope = {
  canvasOrigin: "https://canvas.example.test",
  account: "1",
  course: "42",
  principal: "instructor:7",
  profile: "private-full",
};

describe.runIf(process.platform === "linux")("process lifetime without ps", () => {
  it("constructs the learner vault and acquires transactions", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-no-ps-"));
    try {
      const statePath = join(directory, "state");
      mkdirSync(statePath, { mode: 0o700 });
      const vault = new LearnerVault(join(statePath, "vault.json"));
      const label = vault.tokenize(scope, { id: "18", name: "Jane Doe" });
      expect(label).toMatch(/\S/);
      let entered = false;
      withExactPrivateStateFileTransaction(join(statePath, "record.json"), { label: "test state" }, () => { entered = true; });
      expect(entered).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("settles liveness checks on the request path without a synchronous process spawn", () => {
    const observedAt = new Date().toISOString();
    expect(requestPathProcessMatches(process.pid, observedAt)).toBe(true);
    expect(processMatchesRecordedLifetime(process.pid, observedAt)).toBe(true);
    expect(requestPathProcessMatches(2_147_483_647, observedAt)).toBe(false);
  });
});
