import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const inventoryPath = ".github/workflows/windows-chatgpt-inventory.yml";
const releasePath = ".github/workflows/desktop-release.yml";
const inventory = readFileSync(join(root, inventoryPath), "utf8");
const release = readFileSync(join(root, releasePath), "utf8");

/** The `jobs:` mapping, keyed by job id. Job ids are the only keys at two spaces of indentation. */
function jobs(workflow) {
  const lines = workflow.split("\n");
  const found = new Map();
  let current = null;
  for (let index = lines.indexOf("jobs:") + 1; index > 0 && index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) break;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      found.set(current, []);
    } else if (current) found.get(current).push(line);
  }
  return new Map([...found].map(([id, body]) => [id, body.join("\n")]));
}

/** Every `run: |` script in one job, dedented to what the shell actually receives. */
function shellScripts(job) {
  const lines = job.split("\n");
  const scripts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^(\s+)run: \|\s*$/.exec(lines[index]);
    if (!header) continue;
    const body = [];
    const indent = `${header[1]}  `;
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      if (lines[inner].trim() !== "" && !lines[inner].startsWith(indent)) break;
      body.push(lines[inner].slice(indent.length));
    }
    scripts.push(body.join("\n"));
  }
  return scripts;
}

/**
 * The option names one job passes to one script. The workflow is the source of
 * these names, so a renamed or mistyped option reaches the assertions below
 * instead of a dispatched run.
 */
function invocationOptions(job, script) {
  const line = job.split("\n").find((candidate) => candidate.includes(script));
  assert.ok(line, `${releasePath} must invoke ${script}`);
  return [...line.matchAll(/(?<=\s)--[a-z][a-z0-9-]*/g)].map((match) => match[0]);
}

/**
 * A real argument vector for the option names the workflow uses. An option the
 * workflow adds and this map does not carry fails here rather than silently
 * dropping out of the executed check.
 */
function argumentVector(options, values) {
  const argv = [];
  for (const option of options) {
    assert.ok(Object.hasOwn(values, option), `${option} is passed by ${releasePath} but this test has no value for it`);
    argv.push(option);
    if (values[option] !== null) argv.push(values[option]);
  }
  return argv;
}

function node(argv) {
  return spawnSync(process.execPath, argv, { cwd: root, encoding: "utf8" });
}

test("the ported inventory workflow is dispatch-only, read-only, and time-bounded", () => {
  const inventoryJobs = jobs(inventory);
  assert.deepEqual([...inventoryJobs.keys()], ["inventory"]);
  const trigger = /\non:\n((?: {2}.*\n|\n)*)/.exec(inventory);
  assert.ok(trigger, `${inventoryPath} must declare its triggers`);
  assert.equal(trigger[1].trim(), "workflow_dispatch:", "the sibling's push trigger names a branch that does not exist here");
  assert.match(inventory, /^permissions:\n {2}contents: read$/m);
  const job = inventoryJobs.get("inventory");
  assert.match(job, /^ {4}runs-on: windows-2022$/m);
  assert.match(job, /^ {4}timeout-minutes: 5$/m);

  const scripts = shellScripts(job);
  assert.equal(scripts.length, 1, "the inventory job runs one script");
  const changing = scripts[0].match(/\b(?:Add|Clear|Copy|Install|Invoke|Move|New|Out|Remove|Rename|Set|Start|Stop|Uninstall|Write)-[A-Za-z]+/g);
  assert.equal(changing, null, `the inventory reads Windows state and changes none of it, but it calls ${changing?.join(", ")}`);
  assert.match(scripts[0], /Get-AppxPackage/);
  assert.match(scripts[0], /morrow\.windows-compatible-assistant-inventory\.v1/);
});

test("the hard-coded Windows assistant identity names the inventory workflow that reproduces it", () => {
  const detection = readFileSync(join(root, "installer/shared/windows-appx-detection.cjs"), "utf8");
  const comment = /((?:^\/\/.*\n)+)const CODEX_WINDOWS_APPX_IDENTITY = /m.exec(detection);
  assert.ok(comment, "installer/shared/windows-appx-detection.cjs must explain where the identity came from");
  assert.ok(comment[1].includes(inventoryPath), `the identity comment must cite ${inventoryPath} as its reproducible source`);
  assert.ok(existsSync(join(root, inventoryPath)), `${inventoryPath} must exist for that citation to hold`);
});

test("the release workflow is dispatch-only and builds both desktop platforms", () => {
  const trigger = /\non:\n((?: {2}.*\n|\n)*)/.exec(release);
  assert.ok(trigger, `${releasePath} must declare its triggers`);
  assert.equal(trigger[1].trim(), "workflow_dispatch:", "desktop packaging runs when a person asks for it");
  const releaseJobs = jobs(release);
  assert.deepEqual([...releaseJobs.keys()].sort(), ["macos-installer", "windows-installer"]);
  assert.match(releaseJobs.get("windows-installer"), /^ {4}runs-on: windows-2022$/m);
  assert.match(releaseJobs.get("macos-installer"), /^ {4}runs-on: macos-14$/m);
});

test("the macOS job installs, tests, builds, and keeps the artifact unsigned", () => {
  const job = jobs(release).get("macos-installer");
  const commands = [...job.matchAll(/^\s+run: (?!\|)(.+)$/gm)].map((match) => match[1].trim());
  const ordered = [
    "pnpm install --frozen-lockfile",
    "pnpm --dir installer --ignore-workspace install --frozen-lockfile",
    "pnpm --dir installer --ignore-workspace test",
    "pnpm build"
  ];
  let previous = -1;
  for (const command of ordered) {
    const position = commands.indexOf(command);
    assert.ok(position > previous, `the macOS job must run ${command} after ${previous < 0 ? "checkout" : ordered[ordered.indexOf(command) - 1]}`);
    previous = position;
  }
  assert.match(job, /^ {10}MORROW_SIGNED_RELEASE: "0"$/m);
  assert.match(job, /^ {10}CSC_IDENTITY_AUTO_DISCOVERY: "false"$/m);
  assert.match(job, /^\s+unset CSC_LINK /m, "the job must not inherit a signing certificate from the runner");
  assert.doesNotMatch(job, /--publish(?!\s+never)/, "a QA dispatch publishes nothing");
  assert.match(job, /uses: actions\/upload-artifact@/, "the receipts have to leave the runner to be read");
});

test("the shell scripts in the macOS job are valid bash", (t) => {
  const bash = spawnSync("bash", ["-c", "exit 0"], { encoding: "utf8" });
  if (bash.status !== 0) return t.skip("this host has no bash to check the job scripts with");
  const scripts = shellScripts(jobs(release).get("macos-installer"));
  assert.ok(scripts.length >= 2, "the macOS job packages and then starts the application");
  for (const script of scripts) {
    const checked = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(checked.status, 0, `a macOS job script is not valid bash:\n${checked.stderr}`);
  }
});

test("the packaging command the macOS job runs is accepted by the packaging script", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-desktop-release-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const job = jobs(release).get("macos-installer");
  const options = invocationOptions(job, "scripts/package-mcp-bundle.mjs");
  assert.ok(options.includes("--unsigned-qa"), "packaging without a signing proof requires --unsigned-qa");
  assert.match(job, /--target darwin-arm64\b/, "the macOS job must package the Apple silicon target");

  const argv = argumentVector(options, { "--target": "darwin-arm64", "--unsigned-qa": null, "--output": directory });
  const accepted = node(["scripts/package-mcp-bundle.mjs", ...argv]);
  assert.equal(accepted.status, 1, accepted.stderr);
  assert.match(accepted.stderr, /Destination already exists/, "the packaging script must reach its work with these options");

  const rejected = node(["scripts/package-mcp-bundle.mjs", ...argv, "--not-an-option"]);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Unknown package option/, "option rejection is what the accepted run above is measured against");
});

test("the smoke command the macOS job runs is accepted by the smoke harness", (t) => {
  if (process.platform !== "darwin") return t.skip("the macOS smoke harness refuses to parse its options off macOS");
  const directory = mkdtempSync(join(tmpdir(), "morrow-desktop-release-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const job = jobs(release).get("macos-installer");
  const harness = "scripts/test/desktop-mac-smoke.mjs";
  const options = invocationOptions(job, harness);
  const argv = argumentVector(options, { "--app": join(directory, "Absent.app"), "--receipt": join(directory, "receipt.json") });

  const accepted = node([harness, ...argv]);
  assert.equal(accepted.status, 1);
  assert.doesNotMatch(accepted.stderr, /Usage:/, "the harness must accept the options the workflow passes");
  assert.match(accepted.stderr, /--app must name a macOS application bundle/);

  const rejected = node([harness, "--not-an-option", directory]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Usage:/, "option rejection is what the accepted run above is measured against");
});

test("the macOS job hands the harness the bundle it just built and keeps its receipts", () => {
  const job = jobs(release).get("macos-installer");
  assert.match(job, /ditto -x -k "\$MORROW_MAC_ARCHIVE" "\$bundleRoot"/, "Morrow.app comes from the archive the packaging step kept");
  assert.match(job, /--app "\$bundleRoot\/Morrow\.app"/);
  assert.match(job, /--receipt "\$MORROW_MAC_ARTIFACT_ROOT\/receipt\.json"/);
  const uploaded = /^\s+path: (.+)$/m.exec(job);
  assert.ok(uploaded, "the macOS job must upload a directory");
  assert.ok(job.includes(`artifactRoot="$PWD/${uploaded[1].trim()}"`), "the uploaded directory must be the one the job writes its receipts into");
});
