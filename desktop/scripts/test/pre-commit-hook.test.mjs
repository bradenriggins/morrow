import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../../.githooks/pre-commit", import.meta.url));

/**
 * A throwaway monorepo with the real hook installed the documented way, and `pnpm` and `python3`
 * replaced by stubs that record where they ran and with what arguments. The stubs exit with
 * `STUB_STATUS`, so a failing suite shows up as a refused commit.
 */
function repository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-pre-commit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, ".stub-bin");
  const log = join(root, ".stub-log");
  mkdirSync(bin);
  for (const name of ["pnpm", "python3"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s %s %s\\n' "${name}" "$PWD" "$*" >> "${log}"\nexit "\${STUB_STATUS:-0}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const work = join(root, "repo");
  mkdirSync(join(work, "desktop", ".githooks"), { recursive: true });
  mkdirSync(join(work, "morrow-for-muse"), { recursive: true });
  mkdirSync(join(work, ".github", "workflows"), { recursive: true });
  writeFileSync(join(work, "desktop", ".githooks", "pre-commit"), readFileSync(hook));
  chmodSync(join(work, "desktop", ".githooks", "pre-commit"), 0o755);
  const git = (...args) => {
    const run = spawnSync("git", args, { cwd: work, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return run;
  };
  assert.equal(git("init", "-q").status, 0);
  git("config", "user.email", "hook@example.com");
  git("config", "user.name", "Hook Test");
  git("config", "commit.gpgsign", "false");
  assert.equal(git("config", "core.hooksPath", "desktop/.githooks").status, 0);
  writeFileSync(join(work, "README.md"), "root\n");
  git("add", "README.md", "desktop/.githooks/pre-commit");
  assert.equal(spawnSync("git", ["commit", "-q", "--no-verify", "-m", "base"], { cwd: work }).status, 0);
  const commit = (path, status = 0) => {
    writeFileSync(join(work, path), `${Date.now()}-${Math.random()}\n`);
    git("add", path);
    const run = spawnSync("git", ["commit", "-q", "-m", `change ${path}`], {
      cwd: work, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_STATUS: String(status) },
    });
    let calls = [];
    try { calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean); } catch {}
    rmSync(log, { force: true });
    return { status: run.status, stderr: run.stderr, calls };
  };
  return { work, commit };
}

test("a desktop change runs the desktop gate from desktop/", (t) => {
  const { work, commit } = repository(t);
  const result = commit("desktop/file.txt");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [`pnpm ${join(work, "desktop")} test`]);
});

test("a workflow change runs the desktop gate, because desktop tests read the workflows", (t) => {
  const { work, commit } = repository(t);
  assert.deepEqual(commit(".github/workflows/ci.yml").calls, [`pnpm ${join(work, "desktop")} test`]);
});

test("a Muse change runs the Muse suite from morrow-for-muse/ and not the desktop gate", (t) => {
  const { work, commit } = repository(t);
  const result = commit("morrow-for-muse/file.txt");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [`python3 ${join(work, "morrow-for-muse")} -m pytest -q`]);
});

test("a change to root files only runs no suite", (t) => {
  const { commit } = repository(t);
  const result = commit("README.md");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test("a failing suite refuses the commit", (t) => {
  const { commit } = repository(t);
  assert.notEqual(commit("desktop/file.txt", 1).status, 0);
  assert.notEqual(commit("morrow-for-muse/file.txt", 1).status, 0);
});
