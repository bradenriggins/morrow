import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * Morrow Desktop ships for macOS on Apple silicon and Windows on x64, never Linux. The required
 * pull-request check must therefore run the desktop contracts on those two platforms, not only on
 * the Linux runner, or a platform-only defect merges green and surfaces first in a manual release
 * run.
 */
const root = new URL("../../", import.meta.url);
// The workflows live at the repository root, one level above the desktop product.
const repositoryRoot = new URL("../", root);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const ci = readFileSync(new URL(".github/workflows/ci.yml", repositoryRoot), "utf8");
const release = readFileSync(new URL(".github/workflows/desktop-release.yml", repositoryRoot), "utf8");

/** Each pull-request job for a shipped platform, and the release job whose runner and tests it matches. */
const NATIVE_JOBS = [
  { id: "check-desktop-windows", platform: "win32", releaseJob: "windows-installer" },
  { id: "check-desktop-macos", platform: "darwin", releaseJob: "macos-installer" },
];

/** The body of one job, from its two-space header to the next one. */
function job(workflow, id) {
  const match = new RegExp(`^  ${id}:\n((?: {4,}.*\n|\n)*)`, "m").exec(workflow);
  assert.ok(match, `the workflow must declare the ${id} job`);
  return match[1];
}

/** The single-line commands one job runs, in order. */
function commands(body) {
  return [...body.matchAll(/^\s+(?:- )?run: (?!\|)(.+)$/gm)].map((match) => match[1].trim());
}

test("each shipped platform has a pull-request desktop job on the release runner", () => {
  for (const { id, releaseJob } of NATIVE_JOBS) {
    const body = job(ci, id);
    const runner = /^ {4}runs-on: (\S+)$/m.exec(job(release, releaseJob))?.[1];
    assert.ok(runner, `desktop-release.yml ${releaseJob} must name its runner`);
    assert.match(body, new RegExp(`^ {4}runs-on: ${runner}$`, "m"), `${id} must run where ${releaseJob} runs`);
    assert.match(body, /^ {4}needs: changes$/m, `${id} must wait for change detection`);
    assert.match(body, /^ {4}if: needs\.changes\.outputs\.desktop == 'true'$/m, `${id} must run for every desktop change`);
    assert.match(body, /^ {4}defaults:\n {6}run:\n {8}working-directory: desktop$/m, `${id} must run in desktop/`);
    assert.match(body, /^ {4}timeout-minutes: \d+$/m, `${id} must be time-bounded`);
    assert.match(body, /^ {10}node-version: 22\.23\.2$/m, `${id} must use the exact Node release the payload embeds`);
    assert.match(body, /^ {10}version: 10\.6\.1$/m, `${id} must use the pinned pnpm release`);
  }
});

test("each pull-request platform job runs the release job's install, build, and installer test commands in order", () => {
  for (const { id, releaseJob } of NATIVE_JOBS) {
    const expected = commands(job(release, releaseJob)).filter((command) => command.startsWith("pnpm "));
    assert.ok(expected.some((command) => /--ignore-workspace test/.test(command)), `${releaseJob} must test the installer`);
    const actual = commands(job(ci, id));
    let previous = -1;
    for (const command of expected) {
      const position = actual.indexOf(command);
      assert.ok(position > previous, `${id} must run "${command}" after the commands before it, as ${releaseJob} does`);
      previous = position;
    }
  }
});

/**
 * The desktop-relative test files one job runs. `pnpm <script>` expands through package.json, and
 * every installer command covers the whole installer suite, since each one runs every file in
 * installer/test.
 */
function testsRunBy(body) {
  const files = new Set();
  let installerSuite = false;
  const visit = (command) => {
    for (const part of command.split("&&").map((value) => value.trim())) {
      const alias = /^pnpm ([a-z0-9:-]+)$/.exec(part);
      if (alias && Object.hasOwn(manifest.scripts, alias[1])) {
        visit(manifest.scripts[alias[1]]);
        continue;
      }
      if (/^pnpm --dir installer --ignore-workspace (?:test|test:bounded:files|test:bounded:suite)$/.test(part)) {
        installerSuite = true;
        continue;
      }
      const vitest = /^pnpm --dir (packages\/[a-z0-9-]+) exec vitest run (.+)$/.exec(part);
      if (vitest) {
        for (const file of vitest[2].split(/\s+/)) files.add(`${vitest[1]}/${file}`);
        continue;
      }
      const nodeTest = /^node --test (.+)$/.exec(part);
      if (nodeTest) for (const file of nodeTest[1].split(/\s+/).filter((value) => !value.startsWith("--"))) files.add(file);
    }
  };
  for (const command of commands(body)) visit(command);
  return (file) => files.has(file) || (installerSuite && file.startsWith("installer/test/"));
}

/** The guards that run a test only on `platform`: vitest's skipIf and runIf, an early return, and a node:test skip option. */
function onlyOn(platform) {
  const is = `process\\.platform === "${platform}"`;
  const isNot = `process\\.platform !== "${platform}"`;
  return [`skipIf\\(${isNot}\\)`, `runIf\\(${is}\\)`, `if \\(${isNot}\\) return\\b`, `${isNot}\\s*\\?\\s*["'\`]`, `${is}\\s*\\?\\s*false\\b`];
}

/** The guards that skip a test only on `platform`. */
function notOn(platform) {
  const is = `process\\.platform === "${platform}"`;
  const isNot = `process\\.platform !== "${platform}"`;
  return [`skipIf\\(${is}\\)`, `runIf\\(${isNot}\\)`, `if \\(${is}\\) return\\b`, `${is}\\s*\\?\\s*["'\`]`, `${isNot}\\s*\\?\\s*false\\b`];
}

/** Guards that leave a test unrun on Linux, and the platforms where it does run. */
const PLATFORM_GUARDS = [
  { platforms: ["darwin"], pattern: new RegExp(onlyOn("darwin").join("|")) },
  { platforms: ["win32"], pattern: new RegExp(onlyOn("win32").join("|")) },
  { platforms: ["darwin", "win32"], pattern: new RegExp(notOn("linux").join("|")) },
];

function desktopTestFiles() {
  const directories = [
    "installer/test",
    "scripts/test",
    ...readdirSync(new URL("packages/", root)).map((name) => `packages/${name}/test`),
  ];
  return directories.flatMap((directory) => {
    let names;
    try {
      names = readdirSync(new URL(`${directory}/`, root));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return names.filter((name) => /\.test\.(?:c|m)?(?:js|ts)$/.test(name)).map((name) => `${directory}/${name}`);
  });
}

test("every desktop test that Linux skips runs in a pull-request job on a platform it runs on", () => {
  const runs = new Map(NATIVE_JOBS.map(({ id, platform }) => [platform, { id, covers: testsRunBy(job(ci, id)) }]));
  const guarded = [];
  const unrun = [];
  for (const file of desktopTestFiles()) {
    const source = readFileSync(new URL(file, root), "utf8");
    for (const { platforms, pattern } of PLATFORM_GUARDS) {
      if (!pattern.test(source)) continue;
      guarded.push(file);
      if (!platforms.some((platform) => runs.get(platform).covers(file))) {
        unrun.push(`${file} runs only on ${platforms.join(" or ")}, and no ${platforms.map((platform) => runs.get(platform).id).join(" or ")} command runs it`);
      }
    }
  }
  // The scan must see the guards it exists for, or a changed guard spelling would pass it vacuously.
  for (const known of [
    "packages/gateway-core/test/private-file-access.test.ts",
    "packages/client-config/test/client-config.test.ts",
    "scripts/test/desktop-release-workflow.test.mjs",
    "scripts/test/desktop-update-harness.test.mjs",
    "installer/test/installer-controller.test.cjs",
    "installer/test/adversarial.test.cjs",
  ]) {
    assert.ok(guarded.includes(known), `the platform-guard scan no longer recognizes the guard in ${known}`);
  }
  assert.deepEqual(unrun, [], "a desktop test that Linux skips must run in the pull-request job for its platform");
});

/** The `run: |` script of one job, dedented, and the environment its `${{ }}` expressions produce. */
function aggregator() {
  const body = job(ci, "check");
  const needs = /^ {4}needs: \[([^\]]+)\]$/m.exec(body)?.[1].split(",").map((value) => value.trim());
  assert.ok(needs, "the check job must list the jobs it aggregates");
  const env = [...body.matchAll(/^ {10}([A-Z_]+): \$\{\{ needs\.([a-z-]+)\.(result|outputs\.[a-z]+) \}\}$/gm)]
    .map(([, name, need, field]) => ({ name, need, field }));
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^ {8}run: \|$/.test(line));
  assert.ok(start >= 0, "the check job must run one aggregation script");
  const script = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
    script.push(line.slice(10));
  }
  return { needs, env, script: script.join("\n") };
}

function aggregate({ needs, env, script }, outcome) {
  const values = Object.fromEntries(env.map(({ name, need, field }) => {
    const value = field === "result" ? outcome.results[need] : outcome.outputs[field.slice("outputs.".length)];
    assert.ok(value !== undefined, `the scenario gives no value for ${name} (needs.${need}.${field})`);
    return [name, value];
  }));
  assert.deepEqual(Object.keys(outcome.results).sort(), [...needs].sort());
  const run = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...values },
  });
  assert.equal(run.error, undefined, `bash could not run the aggregation script: ${run.error?.message}`);
  return run.status;
}

test("the required check fails whenever a changed product's job on any platform did not pass", () => {
  const check = aggregator();
  for (const { id } of NATIVE_JOBS) {
    assert.ok(check.needs.includes(id), `the check job must wait for ${id}`);
  }
  const suites = check.needs.filter((id) => id !== "changes");
  for (const id of suites) {
    assert.ok(check.env.some(({ need, field }) => need === id && field === "result"), `the check job must read the ${id} result`);
  }
  const passing = {
    outputs: { desktop: "true", muse: "true" },
    results: Object.fromEntries(check.needs.map((id) => [id, "success"])),
  };
  assert.equal(aggregate(check, passing), 0, "every changed product passed on every platform, so the check passes");

  for (const id of suites) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      const status = aggregate(check, { ...passing, results: { ...passing.results, [id]: result } });
      assert.equal(status, 1, `the check must fail when ${id} is ${result} for a changed product`);
    }
  }

  const museOnly = {
    outputs: { desktop: "false", muse: "true" },
    results: Object.fromEntries(check.needs.map((id) => [id, ["check-muse", "changes", REPOSITORY_JOB].includes(id) ? "success" : "skipped"])),
  };
  assert.equal(aggregate(check, museOnly), 0, "desktop jobs that skip because the desktop did not change pass the check");
});

/**
 * The repository text gates read every tracked file, the root documents and Morrow for Muse
 * included. A change to a root document or to Muse alone skips the desktop suite, so the gates run
 * in their own job on every change, from the repository root, with nothing to install.
 */
const REPOSITORY_JOB = "check-repository";
const REPOSITORY_GATES = ["desktop/scripts/test/no-em-dash.test.mjs", "desktop/scripts/test/product-claims.test.mjs", "desktop/scripts/test/repository-policy.test.mjs"];

test("the repository text gates run on every change, and the required check needs them", () => {
  const body = job(ci, REPOSITORY_JOB);
  assert.doesNotMatch(body, /^ {4}if:/m, `${REPOSITORY_JOB} must run for every change`);
  assert.doesNotMatch(body, /working-directory:/, `${REPOSITORY_JOB} must run from the repository root`);
  assert.match(body, /^ {4}timeout-minutes: \d+$/m, `${REPOSITORY_JOB} must be time-bounded`);
  assert.match(body, /^ {10}node-version: 22\.23\.2$/m, `${REPOSITORY_JOB} must use the Node release the other jobs use`);
  assert.deepEqual(commands(body), [`node --test ${REPOSITORY_GATES.join(" ")}`]);
  for (const gate of REPOSITORY_GATES) {
    const source = readFileSync(new URL(gate, repositoryRoot), "utf8");
    assert.doesNotMatch(source, /^import .* from "(?!node:|\.)/m, `${gate} must need nothing that ${REPOSITORY_JOB} does not install`);
  }

  const check = aggregator();
  assert.ok(check.needs.includes(REPOSITORY_JOB), `the check job must wait for ${REPOSITORY_JOB}`);
  const rootDocumentOnly = {
    outputs: { desktop: "false", muse: "false" },
    results: Object.fromEntries(check.needs.map((id) => [id, ["changes", REPOSITORY_JOB].includes(id) ? "success" : "skipped"])),
  };
  assert.equal(aggregate(check, rootDocumentOnly), 0, "a root-document change passes when the repository text gates pass");
  for (const result of ["failure", "cancelled", "skipped"]) {
    const status = aggregate(check, { ...rootDocumentOnly, results: { ...rootDocumentOnly.results, [REPOSITORY_JOB]: result } });
    assert.equal(status, 1, `the check must fail when ${REPOSITORY_JOB} is ${result}, whichever products changed`);
  }
});
