import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ROOT_FILE_READERS, pathFilters, productsFor } from "./lib/ci-path-filters.mjs";

const hook = fileURLToPath(new URL("../../.githooks/pre-commit", import.meta.url));
const ci = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");

/**
 * The `run:` commands of one ci.yml job, in step order. A run step the parser
 * cannot recognize (an unexpected indentation, a shell form it has not seen)
 * must fail loudly here rather than silently vanish from the expectation, so
 * every line that carries a run step must either be read or throw.
 */
function jobRuns(workflow, job) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) throw new Error(`ci.yml has no ${job} job`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  const body = lines.slice(start + 1, end === -1 ? lines.length : end);
  let blockScalar = null;
  let blockIndent = 0;
  let skipScalar = null;
  const runs = [];
  for (const line of body) {
    if (skipScalar !== null) {
      if (/^\s*$/.test(line) || /^ {11}/.test(line)) continue;
      skipScalar = null;
    }
    if (blockScalar !== null) {
      if (/^\s*$/.test(line) || new RegExp(`^ {${blockIndent}}`).test(line)) {
        blockScalar.push(line.slice(blockIndent));
        continue;
      }
      runs.push(blockScalar.join("\n"));
      blockScalar = null;
    }
    const run = /^(?: {6}| {8})- run: (.+)$/.exec(line) ?? /^ {8}run: (.+)$/.exec(line) ?? /^ {10}run: (.+)$/.exec(line);
    if (run) {
      if (run[1] === "|" || run[1] === ">" || run[1] === "|-" || run[1] === ">-") {
        blockScalar = [];
        blockIndent = (line.match(/^ */) ?? [""])[0].length + 2;
        continue;
      }
      runs.push(run[1]);
      continue;
    }
    const otherScalar = /^ {10}([\w-]+): ([|>][-+]?)$/.exec(line);
    if (otherScalar) {
      skipScalar = 10;
      continue;
    }
    if (skipScalar !== null && (/^\s*$/.test(line) || /^ {11}/.test(line))) continue;
    skipScalar = null;
    if (/^ {6}run:$/.test(line)) continue;
    if (/^(?: {6}| {8})(?:- )?(?:name|uses|with|if|timeout-minutes|env|working-directory|version|node-version|python-version):/.test(line)) continue;
    if (/^ {4}\S/.test(line)) continue;
    if (/^- /.test(line.trim()) || /run:/.test(line)) {
      throw new Error(`ci.yml ${job} has a run step this test does not recognize, so the pre-commit hook may stop mirroring it: ${JSON.stringify(line)}`);
    }
  }
  if (blockScalar !== null) runs.push(blockScalar.join("\n"));
  return runs;
}

/** Every job of the workflow, so a canary can sweep each one for unread run steps. */
function jobNames(workflow) {
  const names = [];
  for (const [index, line] of workflow.split("\n").entries()) {
    if (/^ {2}[a-z-]+:$/.test(line)) names.push([index, line.trim().replace(/:$/, "")]);
  }
  return names;
}

const allJobs = jobNames(ci);

/** The one run of `job` that `predicate` names, for the hook to mirror. */
function exactlyOne(runs, job, predicate, what) {
  const found = runs.filter(predicate);
  assert.equal(found.length, 1, `ci.yml ${job} must name exactly one ${what}: [${runs.join("; ")}]`);
  return found[0];
}

const repositoryRuns = jobRuns(ci, "check-repository");
const desktopRuns = jobRuns(ci, "check-desktop");
const museRuns = jobRuns(ci, "check-muse");

// The hook runs the suite commands, not the dependency installs that prepare
// them and not the browser harnesses, which need a display this machine may
// not have. Each expected command below is read out of ci.yml, so a workflow
// edit that the hook does not mirror fails here.
const gates = exactlyOne(repositoryRuns, "check-repository", (run) => run.startsWith("node --test"), "repository text gate");
const desktopSuite = exactlyOne(desktopRuns, "check-desktop", (run) => run === "pnpm check", "desktop suite");
const museSuite = museRuns.filter((run) => !run.startsWith("pip install"));

/**
 * ci.yml speaks in runner terms. The hook's substitutions, asserted on every
 * call below: `python` is the workflow's pinned interpreter, the hook runs
 * MORROW_MUSE_PYTHON (a python that has cryptography; default python3), and
 * $RUNNER_TEMP/carve becomes a fresh mktemp directory.
 */
const args = (run) => run.replace(/^python /, "python3 ").replaceAll('"$RUNNER_TEMP/carve/morrow-muse-connector', '"<temp>/morrow-muse-connector').replaceAll('"', "");
const stubLine = (name, cwd, run) => `${name} ${cwd} ${args(run).replace(/^\S+ /, "")}`;

/** Expected stub calls for a commit of `path`, derived from ci.yml. */
function expectedCalls(path, work) {
  const calls = [stubLine("node", work, gates)];
  for (const product of productsFor(pathFilters(ci), path)) {
    if (product === "desktop") {
      calls.push(stubLine("pnpm", join(work, "desktop"), desktopSuite));
    } else {
      for (const run of museSuite) calls.push(stubLine(args(run).split(" ")[0], join(work, "morrow-for-muse"), run));
    }
  }
  return calls.map((call) => call.replace(/\/[^ ]*morrow-pre-commit-muse\.\w+\//g, "<temp>/"));
}

/**
 * A throwaway monorepo with the real hook installed the documented way, and `pnpm`, `python3`,
 * `node` and `bash` replaced by stubs that record where they ran and with what arguments. The
 * stubs exit with `STUB_STATUS`, so a failing suite shows up as a refused commit.
 */
function repository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-pre-commit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, ".stub-bin");
  const log = join(root, ".stub-log");
  mkdirSync(bin);
  for (const name of ["pnpm", "python3", "node", "bash"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s %s %s\\n' "${name}" "$PWD" "$*" >> "${log}"\nexit "\${STUB_STATUS:-0}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const work = join(root, "repo");
  mkdirSync(join(work, "desktop", ".githooks"), { recursive: true });
  mkdirSync(join(work, "morrow-for-muse"), { recursive: true });
  mkdirSync(join(work, ".github", "workflows"), { recursive: true });
  writeFileSync(join(work, "desktop", ".githooks", "pre-commit"), readFileSync(hook));
  chmodSync(join(work, "desktop", ".githooks", "pre-commit"), 0o755);
  const git = (...args2) => {
    const run = spawnSync("git", args2, { cwd: work, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
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
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), `${Date.now()}-${Math.random()}\n`);
    git("add", path);
    const run = spawnSync("git", ["commit", "-q", "-m", `change ${path}`], {
      cwd: work, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_STATUS: String(status) },
    });
    let calls = [];
    try { calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean); } catch {}
    rmSync(log, { force: true });
    return { status: run.status, stderr: run.stderr, calls: calls.map((call) => call.replace(/\/[^ ]*morrow-pre-commit-muse\.\w+\//g, "<temp>/")) };
  };
  return { work, commit };
}

test("a desktop change runs the desktop suite from desktop/", (t) => {
  const { work, commit } = repository(t);
  const result = commit("desktop/file.txt");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, expectedCalls("desktop/file.txt", work));
});

test("a workflow change runs both products' steps, because both suites read the workflows", (t) => {
  const { work, commit } = repository(t);
  const result = commit(".github/workflows/ci.yml");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, expectedCalls(".github/workflows/ci.yml", work));
});

test("a Muse change runs the Muse suite from morrow-for-muse/ and not the desktop suite", (t) => {
  const { work, commit } = repository(t);
  const result = commit("morrow-for-muse/file.txt");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, expectedCalls("morrow-for-muse/file.txt", work));
});

test("a change to files only the repository gates read runs the gates only", (t) => {
  const { work, commit } = repository(t);
  const result = commit("README.md");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, expectedCalls("README.md", work));
});

// The hook exists to run the same steps before a commit that CI runs for it. Written before the
// fix (final sweep 2026-09-23): a commit that changed only .gitattributes, LICENSE, .gitignore or
// docs/versioning.md ran no suite although each is a root file a product suite reads, and no
// commit ran the repository text gates. Every path below is swept against the steps ci.yml names.
test("each change runs exactly the steps CI runs for it, derived from ci.yml", (t) => {
  const { work, commit } = repository(t);
  const paths = ["desktop/file.txt", "morrow-for-muse/file.txt", ".github/workflows/ci.yml", ...Object.keys(ROOT_FILE_READERS)];
  const wrong = paths.flatMap((path) => {
    const result = commit(path);
    const expected = expectedCalls(path, work);
    return result.status === 0 && result.calls.join("\n") === expected.join("\n")
      ? []
      : [`${path}: the hook ran [${result.calls.join("; ")}] (exit ${result.status}), CI runs [${expected.join("; ")}]`];
  });
  assert.deepEqual(wrong, []);
});

// The mirror is only as good as jobRuns' reading of ci.yml. A suite step the
// parser overlooks would vanish from the expectation and from these tests with
// no failure anywhere, so the parser must read every run step and refuse one it
// cannot recognize.
test("jobRuns reads a suite step written as a block scalar", () => {
  const scratch = [
    "  job:",
    "    steps:",
    "      - run: pip install stub",
    "      - name: The suite",
    "        run: |",
    "          node --test one.test.mjs",
    "          node --test two.test.mjs",
  ].join("\n");
  assert.deepEqual(jobRuns(scratch, "job"), ["pip install stub", "node --test one.test.mjs\nnode --test two.test.mjs"]);
  const dashed = [
    "  job:",
    "    steps:",
    "      - run: |",
    "        pnpm check",
  ].join("\n");
  assert.deepEqual(jobRuns(dashed, "job"), ["pnpm check"]);
});

test("jobRuns refuses a run step it does not recognize", () => {
  const scratch = [
    "  job:",
    "    steps:",
    "      - run: echo recognized",
    "      - name: Odd indent",
    "            run: echo unrecognized",
  ].join("\n");
  assert.throws(() => jobRuns(scratch, "job"), /unrecognized/);
});

// The parser must read every run step in ci.yml, not only the jobs the hook
// mirrors. The count canary makes an unrecognized form anywhere in the
// workflow fail loudly instead of silently dropping that step from the
// expectation.
test("the parser recognizes every run step in ci.yml", () => {
  let recognized = 0;
  for (const [, job] of allJobs) {
    try {
      recognized += jobRuns(ci, job).length;
    } catch (error) {
      assert.fail(`${error.message} (job ${job})`);
    }
  }
  // A step's run key sits at 6 spaces with a dash, 8 as a step's second key,
  // or 10 as a key of a named step. The bare 6-space `run:` of `defaults:` is
  // not a step, so it counts neither way.
  const total = ci.split("\n").filter((line) => /^(?: {6}- run:| {8}run:| {10}run:)/.test(line)).length;
  assert.equal(
    recognized,
    total,
    `jobRuns recognized ${recognized} of ci.yml's ${total} run steps; an unrecognized step form hides a suite from the hook's expectation`,
  );
});

test("a failing suite refuses the commit", (t) => {
  const { commit } = repository(t);
  assert.notEqual(commit("desktop/file.txt", 1).status, 0);
  assert.notEqual(commit("morrow-for-muse/file.txt", 1).status, 0);
  assert.notEqual(commit("README.md", 1).status, 0);
});
