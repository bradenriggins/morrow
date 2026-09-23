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
const upgradePath = "scripts/test/desktop-windows-upgrade.ps1";
const boundedRunnerPath = "installer/test/run-bounded-tests.cjs";
const macSmokePath = "scripts/test/desktop-mac-smoke.mjs";
// Workflow paths are relative to the repository root, one level above the desktop product.
const repositoryRoot = join(root, "..");
const inventory = readFileSync(join(repositoryRoot, inventoryPath), "utf8");
const release = readFileSync(join(repositoryRoot, releasePath), "utf8");
const upgrade = readFileSync(join(root, upgradePath), "utf8");
const boundedRunner = readFileSync(join(root, boundedRunnerPath), "utf8");
const macSmoke = readFileSync(join(root, macSmokePath), "utf8");
const versioningPath = "docs/versioning.md";
const versioning = readFileSync(join(repositoryRoot, versioningPath), "utf8");
const WINDOWS_APPLICATION_METADATA = Object.freeze({
  companyName: "Braden Riggins",
  productName: "Morrow",
  fileDescription: "Morrow",
  fileVersion: "1.0.4",
  productVersion: "1.0.4.0"
});

function metadataMismatches(value) {
  return Object.entries(WINDOWS_APPLICATION_METADATA)
    .filter(([field, expected]) => value[field] !== expected)
    .map(([field]) => field);
}

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
  assert.ok(existsSync(join(repositoryRoot, inventoryPath)), `${inventoryPath} must exist for that citation to hold`);
});

test("the release workflow is dispatch-only and builds both desktop platforms", () => {
  const trigger = /\non:\n((?: {2}.*\n|\n)*)/.exec(release);
  assert.ok(trigger, `${releasePath} must declare its triggers`);
  assert.equal(trigger[1].trim(), "workflow_dispatch:", "desktop packaging runs when a person asks for it");
  const releaseJobs = jobs(release);
  assert.deepEqual([...releaseJobs.keys()].sort(), ["macos-installer", "windows-installer"]);
  assert.match(releaseJobs.get("windows-installer"), /^ {4}runs-on: windows-2022$/m);
  assert.match(releaseJobs.get("windows-installer"), /^ {4}timeout-minutes: 120$/m);
  assert.match(releaseJobs.get("macos-installer"), /^ {4}runs-on: macos-14$/m);
  assert.equal((release.match(/^\s+node-version: 22\.23\.2$/gm) || []).length, 2,
    "both package jobs must use the exact Node release embedded in the payload");
  for (const reference of release.matchAll(/uses:\s+([^\s@]+)@([^\s]+)/g)) {
    assert.match(reference[2], /^[0-9a-f]{40}$/, `${reference[1]} must be pinned to an immutable commit`);
  }
  assert.equal((release.match(/^\s+if: success\(\)$/gm) || []).length, 2,
    "only complete successful platform evidence may use the normal artifact names");
  assert.equal((release.match(/^\s+if-no-files-found: error$/gm) || []).length, 2);
});

test("each release job runs in the desktop product directory and uploads from it", () => {
  for (const [id, job] of jobs(release)) {
    assert.match(job, /^ {4}defaults:\n {6}run:\n {8}working-directory: desktop$/m, `${id} must run its commands in desktop/`);
    assert.match(job, /^ {10}cache-dependency-path: desktop\/pnpm-lock\.yaml$/m, `${id} must key the pnpm cache on the desktop lockfile`);
    // upload-artifact paths are relative to the checkout, not to working-directory.
    for (const [, path] of job.matchAll(/^ {10}path: (.+)$/gm)) assert.match(path, /^desktop\//, `${id} uploads ${path} from outside desktop/`);
  }
});

test("the Windows job runs bounded tests and packages through one retained release graph", () => {
  const job = jobs(release).get("windows-installer");
  const commands = [...job.matchAll(/^\s+run: (?!\|)(.+)$/gm)].map((match) => match[1].trim());
  const ordered = [
    "pnpm install --frozen-lockfile",
    "pnpm --dir installer --ignore-workspace install --frozen-lockfile",
    "pnpm build",
    "pnpm --dir installer --ignore-workspace test:bounded:files",
    "pnpm --dir installer --ignore-workspace test:bounded:suite",
  ];
  let previous = -1;
  for (const command of ordered) {
    const position = commands.indexOf(command);
    assert.ok(position > previous, `the Windows job must run ${command} after ${previous < 0 ? "checkout" : ordered[ordered.indexOf(command) - 1]}`);
    previous = position;
  }
  assert.match(job, /Test each installer contract file with a process limit\n {8}timeout-minutes: 23/);
  assert.match(job, /Test the complete installer contract suite with a process limit\n {8}timeout-minutes: 7/);
  assert.match(job, /Upgrade the exact published 3720 build and preserve its state\n {8}timeout-minutes: 32/);
  assert.match(job, /Install, start, damage and repair the sealed payload, uninstall, and check retained data\n {8}timeout-minutes: 30/);
  assert.match(job, /node scripts\/package-mcp-bundle\.mjs --target win32-x64 --unsigned-qa --output \$env:MORROW_WINDOWS_PACKAGE_OUTPUT/);
  assert.match(job, /Copy-Item -LiteralPath \(Join-Path \$env:MORROW_WINDOWS_PACKAGE_OUTPUT 'receipt\.json'\) -Destination \(Join-Path \$env:MORROW_WINDOWS_ARTIFACT_ROOT 'package-receipt\.json'\)/);
  assert.match(job, /desktop-windows-smoke\.mjs --installer \$env:MORROW_WINDOWS_INSTALLER --package-receipt/);
  assert.doesNotMatch(job, /pnpm --dir installer --ignore-workspace package:win/);
  assert.doesNotMatch(boundedRunner, /const failures = \[\]/);
  assert.match(boundedRunner, /scripts\/lib\/owned-process\.mjs/);
  assert.match(boundedRunner, /runOwnedProcess/);
  assert.doesNotMatch(boundedRunner, /\bspawn(?:Sync)?\(/);
  assert.match(boundedRunner, /assertPassed\(result, FILE_TIMEOUT_MS\);/);
});

test("the Windows job upgrades the exact published 3720 artifact before its final smoke", () => {
  const job = jobs(release).get("windows-installer");
  const oldUrl = "https://github.com/bradenriggins/morrow-downloads/releases/download/v1.0.0/Morrow-1.0.0-win-x64-3720b76b-baseline.exe";
  const oldSha256 = "2750cd7b6746fb7f6701a92920158691eb9ad787732826597f6de4c3ed0fadf1";
  const oldSourceHead = "3720b76bfd5dc5d132627777be4034bf9ef0dae5";
  const upgradeHarness = "scripts/test/desktop-windows-upgrade.ps1";
  assert.ok(existsSync(join(root, upgradeHarness)), `${upgradeHarness} must exist`);
  assert.ok(job.includes(`$oldUrl = '${oldUrl}'`));
  assert.ok(job.includes(`$oldSha256 = '${oldSha256}'`));
  assert.ok(job.includes(`$oldSourceHead = '${oldSourceHead}'`));
  assert.match(job, /Invoke-WebRequest -Uri \$oldUrl -OutFile \$oldInstaller/);
  assert.match(job, /Get-FileHash -LiteralPath \$oldInstaller -Algorithm SHA256/);
  assert.match(job, /if \(\$downloadedHash -ne \$oldSha256\) \{ throw/);
  assert.match(job, /\$newSourceHead = \$env:GITHUB_SHA\.ToLowerInvariant\(\)/);
  assert.match(job, /\$stateDir = Join-Path \$env:LOCALAPPDATA "MorrowUpgradeTest-\$runId"/);
  assert.doesNotMatch(job, /\$stateDir = Join-Path \$env:RUNNER_TEMP/);
  assert.match(job, /& scripts\/test\/desktop-windows-upgrade\.ps1/);
  for (const parameter of ["OldInstaller", "OldSha256", "OldSourceHead", "NewInstaller", "NewSha256", "NewSourceHead", "InstallDirectory", "StateDirectory", "Receipt"]) {
    assert.match(job, new RegExp(`-${parameter}\\s`), `the Windows upgrade invocation must pass -${parameter}`);
  }
  assert.match(job, /\$receipt = Join-Path \$env:MORROW_WINDOWS_ARTIFACT_ROOT 'upgrade\.json'/);
  assert.match(job, /\$receipt = Join-Path \$env:MORROW_WINDOWS_ARTIFACT_ROOT "smoke\.json"/);
  assert.match(job, /desktop-windows-smoke\.mjs[^\r\n]+--source \$env:GITHUB_SHA --run-id \$runId/);
  assert.doesNotMatch(job, /upgrade-receipt\.json/);
  assert.doesNotMatch(job, /"receipt\.json"/);
  assert.ok(job.indexOf(upgradeHarness) < job.indexOf("desktop-windows-smoke.mjs"), "the pinned upgrade must finish before the final isolated smoke");
  assert.match(upgrade, /\$ExpectedWindowsApplicationMetadata = \[ordered\]@\{/);
  for (const [field, value] of Object.entries(WINDOWS_APPLICATION_METADATA)) {
    assert.match(upgrade, new RegExp(`^  ${field} = '${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"));
  }
  assert.match(upgrade, /function Assert-AppMetadata\(\$Value\)/);
  assert.match(upgrade, /Assert-AppMetadata \$newApp/);
  assert.ok(upgrade.includes(`$PinnedOldSha256 = '${oldSha256}'`));
  assert.ok(upgrade.includes(`$PinnedOldSourceHead = '${oldSourceHead}'`));
  assert.match(upgrade, /\$Pinned3720LegacyAclClassification = 'additional_principal_sensitive_access_allow'/);
  assert.match(upgrade, /\$OldSha256 -ne \$PinnedOldSha256 -or \$OldSourceHead -ne \$PinnedOldSourceHead/);
  assert.match(upgrade, /\$resolvedStateDirectory\.StartsWith\(\$localAppDataRoot, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(upgrade, /upgrade state directory must use this account local application data boundary/);
  assert.match(upgrade, /"upgrade-\$Label\.json"/);
  assert.ok(upgrade.indexOf('"upgrade-$Label.json"') < upgrade.indexOf("Assert-ReadyReceipt $value $Label"), "each native app receipt must survive even when its readiness assertion fails");
  assert.match(upgrade, /\$allowedPinned3720Acl = \$AllowPinned3720Acl -and \$stateAcl -eq \$legacy -and \$descriptorAcl -eq \$legacy/);
  assert.match(upgrade, /\$oldCold = Run-App 'before-upgrade-cold' \$false \$true/);
  assert.match(upgrade, /\$oldRetryUsed = -not \$oldCold\.health\.gatewayReady/);
  assert.doesNotMatch(upgrade, /Retryable-GatewayWarmup/);
  assert.match(upgrade, /\$oldReady = if \(\$oldRetryUsed\) \{ Run-App 'before-upgrade-retry' \$true \$true \} else \{ \$oldCold \}/);
  assert.match(upgrade, /\$newReady = Run-App 'after-upgrade'\r?\n/);
  assert.match(upgrade, /coldGatewayReady = \[bool\]\$oldCold\.health\.gatewayReady/);
  assert.match(upgrade, /retryUsedIffColdNotReady = \[bool\]\(\$oldRetryUsed -eq \(-not \[bool\]\$oldCold\.health\.gatewayReady\)\)/);
  assert.match(upgrade, /finalGatewayReady = \[bool\]\$oldReady\.health\.gatewayReady/);
  assert.match(upgrade, /stateSecurity = \[ordered\]@\{/);
  assert.match(upgrade, /retention = \[ordered\]@\{/);
  assert.match(upgrade, /exactAcrossUpgrade = @\(\$retainedAfterUpgrade/);
  assert.match(upgrade, /\$stateAfterInstall = Compare-Files \$stateBefore \(Capture-Files \$stateTargets\)/);
  assert.ok(upgrade.indexOf("$stateAfterInstall = Compare-Files") < upgrade.indexOf("$newReady = Run-App 'after-upgrade'"), "the installer must preserve state before the upgraded runtime can change it");
  assert.match(upgrade, /applicationStateExactAfterInstall = @\(\$stateAfterInstall/);
  assert.match(upgrade, /\$cleanupDeadline = \(Get-Date\)\.AddSeconds\(30\)/);
  assert.match(upgrade, /\$uninstallSnapshot = Uninstall-CleanupSnapshot/);
  assert.match(upgrade, /if \(Test-UninstallComplete \$uninstallSnapshot\) \{ break \}/);
  assert.match(upgrade, /while \(\(Get-Date\) -lt \$cleanupDeadline\)/);
  assert.ok(upgrade.indexOf("Run-Process $uninstaller") < upgrade.indexOf("$uninstallSnapshot = Uninstall-CleanupSnapshot"), "the harness must wait for the uninstaller before it checks cleanup");
  assert.ok(upgrade.indexOf("$uninstallSnapshot = Uninstall-CleanupSnapshot") < upgrade.indexOf("$retainedAfterUninstall = Compare-Files"), "the final retention read must wait for the complete cleanup predicate");
  assert.match(upgrade, /upgrade-uninstall-residue\.json/);
  assert.match(upgrade, /processId = \$_\.ProcessId; name = \$_\.Name/);
  assert.match(upgrade, /commandReferencesState = \[bool\]/);
  assert.match(upgrade, /installDirectoryPresent = \[bool\]\$uninstallSnapshot\.installDirectoryPresent/);
  assert.ok(upgrade.indexOf("upgrade-uninstall-residue.json") < upgrade.indexOf("The uninstaller did not finish complete cleanup before the deadline; residue receipt="), "the residue receipt must be written before the failure is reported");
  assert.match(upgrade, /exactAcrossUninstall = \[bool\]\(@\(\$stateAfterUninstall/);
  assert.match(upgrade, /acceptedAs = if \(\$oldReady\.stateSecurity\.state\.acl -eq \$PrivateAclClassification\) \{ 'private' \} else \{ 'pinned_3720_legacy' \}/);
  assert.match(upgrade, /descriptorAcl = \$newReady\.stateSecurity\.descriptor\.acl\r?\n\s+acceptedAs = 'private'/);
  assert.match(upgrade, /if \(\$uninstallSignature -ne 'NotSigned'\) \{ throw/);
  assert.ok(upgrade.indexOf("$uninstallSignature -ne 'NotSigned'") < upgrade.indexOf("Run-Process $uninstaller"), "the harness must reject an unexpected uninstaller signature before it runs that file");
});

test("the Windows executable VersionInfo identity rejects every field mutation", () => {
  assert.deepEqual(metadataMismatches({ ...WINDOWS_APPLICATION_METADATA }), []);
  for (const [field, value] of Object.entries(WINDOWS_APPLICATION_METADATA)) {
    const mutated = { ...WINDOWS_APPLICATION_METADATA, [field]: `${value}-mutated` };
    assert.deepEqual(metadataMismatches(mutated), [field], `${field} must remain an exact VersionInfo value`);
  }
});

test("the macOS job installs, builds, tests the built runtime, and keeps the artifact unsigned", () => {
  const job = jobs(release).get("macos-installer");
  const commands = [...job.matchAll(/^\s+run: (?!\|)(.+)$/gm)].map((match) => match[1].trim());
  const ordered = [
    "pnpm install --frozen-lockfile",
    "pnpm --dir installer --ignore-workspace install --frozen-lockfile",
    "pnpm build",
    "pnpm --dir installer --ignore-workspace test"
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
  const argv = argumentVector(options, {
    "--disk-image": join(directory, "Morrow-1.0.4-mac-arm64.dmg"),
    "--package-receipt": join(directory, "package-receipt.json"),
    "--receipt": join(directory, "receipt.json"),
    "--source": "a".repeat(40),
    "--run-id": "b".repeat(32)
  });

  const accepted = node([harness, ...argv]);
  assert.equal(accepted.status, 1);
  assert.doesNotMatch(accepted.stderr, /Usage:/, "the harness must accept the options the workflow passes");
  assert.match(accepted.stderr, /package-receipt\.json/, "the parsed command reaches its missing package input");

  const rejected = node([harness, "--not-an-option", directory]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Usage:/, "option rejection is what the accepted run above is measured against");
});

/**
 * docs/versioning.md step 4 builds the files educators download with --unsigned-release on the
 * maintainer's computers. The QA workflow tests other bytes, so step 4 must start the exact files
 * it publishes, with the same harness options the workflow passes (the tests above prove the
 * harnesses accept them), before `gh release create`.
 *
 * Failure mode pinned down (written before the fix; final sweep 2026-09-23): step 4 went from the
 * packaging command straight to SHA256SUMS and `gh release create`, and the macOS harness refused
 * the --unsigned-release receipt, so no published installer had ever been started by a smoke test.
 */
test("the release procedure smoke-tests the exact installers it publishes, before it publishes them", () => {
  const start = versioning.indexOf("4. **");
  const end = versioning.indexOf("\n5. **", start);
  assert.ok(start >= 0 && end > start, `${versioningPath} must keep the Desktop publishing step as step 4`);
  const step = versioning.slice(start, end);
  const publish = step.indexOf("gh release create desktop/vX.Y.Z");
  assert.ok(publish > 0, `${versioningPath} step 4 must publish with gh release create`);
  const published = step.slice(publish).split("`")[0];

  for (const [id, harness, fileOption, file] of [
    ["macos-installer", "scripts/test/desktop-mac-smoke.mjs", "--disk-image", "Morrow-X.Y.Z-mac-arm64.dmg"],
    ["windows-installer", "scripts/test/desktop-windows-smoke.mjs", "--installer", "Morrow-X.Y.Z-win-x64.exe"],
  ]) {
    const command = step.match(new RegExp(`\`(node ${harness.replaceAll(".", "\\.")} [^\`]+)\``));
    assert.ok(command, `${versioningPath} step 4 must run ${harness}`);
    assert.ok(command.index < publish, `${versioningPath} step 4 must run ${harness} before gh release create`);
    const documented = [...command[1].matchAll(/(?<=\s)--[a-z][a-z0-9-]*/g)].map((match) => match[0]);
    assert.deepEqual(documented, invocationOptions(jobs(release).get(id), harness),
      `${versioningPath} must pass ${harness} the options ${releasePath} passes it`);
    // A placeholder such as <mac folder> holds a space, so a value runs to the next option.
    const value = (option) => new RegExp(`${option} (.+?)(?= --|$)`).exec(command[1])?.[1] ?? "";
    assert.ok(value(fileOption).endsWith(file), `the ${harness} run must start ${file}`);
    assert.ok(published.includes(` ${file} `), `the file ${harness} starts must be the ${file} that step 4 publishes`);
    assert.equal(value("--source"), "<tag commit>", `the ${harness} run must bind the commit the tag names`);
  }
});

test("the macOS job mounts and tests the same disk image it uploads", () => {
  const job = jobs(release).get("macos-installer");
  assert.match(job, /cp "\$\{images\[0\]\}" "\$artifactRoot\/\$\(basename "\$\{images\[0\]\}"\)"/);
  assert.match(job, /cp "\$\{archives\[0\]\}" "\$artifactRoot\/\$\(basename "\$\{archives\[0\]\}"\)"/);
  assert.match(job, /echo "MORROW_MAC_DISK_IMAGE=\$artifactRoot\/\$\(basename "\$\{images\[0\]\}"\)" >> "\$GITHUB_ENV"/);
  assert.match(macSmoke, /run\("\/usr\/bin\/hdiutil", \["attach", diskImage, "-nobrowse", "-readonly", "-mountpoint", mountRoot\]/,
    "the evidence producer must mount the bound DMG itself");
  assert.match(macSmoke, /operation\(join\(mountRoot, "Morrow\.app"\)\)/);
  assert.doesNotMatch(job, /--app\b/, "the workflow cannot substitute an app outside the retained DMG");
  assert.doesNotMatch(job, /MORROW_MAC_ARCHIVE|ditto -x -k/, "the smoke must not substitute the unuploaded ZIP for the retained disk image");
  assert.match(job, /--receipt "\$MORROW_MAC_ARTIFACT_ROOT\/receipt\.json"/);
  assert.match(job, /--disk-image "\$MORROW_MAC_DISK_IMAGE"/);
  assert.match(job, /--package-receipt "\$MORROW_MAC_ARTIFACT_ROOT\/package-receipt\.json"/);
  assert.match(job, /--source "\$GITHUB_SHA" --run-id "\$MORROW_MAC_RUN_ID"/);
  const uploaded = /^\s+path: (.+)$/m.exec(job);
  assert.ok(uploaded, "the macOS job must upload a directory");
  // The upload path is relative to the checkout; $PWD is the job's working directory, desktop/.
  assert.match(job, /^ {8}working-directory: desktop$/m);
  const uploadedFromDesktop = uploaded[1].trim().replace(/^desktop\//, "");
  assert.notEqual(uploadedFromDesktop, uploaded[1].trim(), "the upload path must name the desktop working directory");
  assert.ok(job.includes(`artifactRoot="$PWD/${uploadedFromDesktop}"`), "the uploaded directory must be the one the job writes its receipts into");
});

test("each release job preflights the signed release configuration and reports it", () => {
  for (const [id, target] of [["windows-installer", "win32-x64"], ["macos-installer", "darwin-arm64"]]) {
    const job = jobs(release).get(id);
    const step = new RegExp(`- name: Preflight the signed release configuration\\n(?: {8}.*\\n)*? {8}run: node installer/signed-release-preflight\\.cjs --target ${target} --summary`);
    assert.match(job, step, `${id} must preflight the signed configuration for ${target}`);
    const commands = [...job.matchAll(/^\s+run: (?!\|)(.+)$/gm)].map((match) => match[1].trim());
    assert.ok(commands.indexOf(`node installer/signed-release-preflight.cjs --target ${target} --summary`) > commands.indexOf("pnpm --dir installer --ignore-workspace install --frozen-lockfile"));
    for (const name of target.startsWith("darwin")
      ? ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "GH_TOKEN"]
      : ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "GH_TOKEN"]) {
      assert.match(job, new RegExp(`^ {10}${name}: \\$\\{\\{ secrets\\.MORROW_${name} \\}\\}$`, "m"), `${id} preflight reads ${name}`);
    }
  }
});
