import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { bridgeReleaseManifest } from "../package-mcp-bundle.mjs";
import { BRIDGE_SEAL, BRIDGE_VERSION, assertPackagedBridgeMatchesCheckout, qualifyRetainedCheckout, remoteRunnerRequired, verifyQaSource, verifySealedBridge, verifyRetainedPackageContract } from "./sealed-desktop-bridge.mjs";

const extension = resolve(import.meta.dirname, "../../connector/extension");
const releaseBytes = Buffer.from(`${JSON.stringify(bridgeReleaseManifest(extension), null, 2)}\n`);

test("the actual retained QA receipt admits its unsigned release classification and no substitute", () => {
  const bytes = readFileSync(resolve(import.meta.dirname, "fixtures/sealed-qa-37649115964-package-receipt.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "5a780d0d06f5ec2c2a6ef43d61721e80f1ab159e1f475fd50528943fcb02a46b");
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.source.head, "1ed0c70c82dc74b2a506e6ac0004bad29fbfa43a");
  assert.equal(receipt.bridgeRelease, undefined, "the installer receipt has no invented Bridge-release field");
  verifyRetainedPackageContract(receipt);
  for (const mode of ["unsigned_private_qa", "signed_release", "signed", undefined]) {
    assert.throws(() => verifyRetainedPackageContract({ ...receipt, signing: { ...receipt.signing, mode } }), /retained_unsigned_release_signing_required/);
  }
  assert.throws(() => verifyRetainedPackageContract({ ...receipt, signing: { ...receipt.signing, automaticUpdates: true } }));
  assert.throws(() => verifyRetainedPackageContract({ ...receipt, schema: "invented" }));
});

test("remote qualification validates the retained archive before extraction and launch", () => {
  const workflow = readFileSync(resolve(import.meta.dirname, "../../../.github/workflows/sealed-desktop-bridge.yml"), "utf8");
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.doesNotMatch(workflow, /37649115964/);
  assert.doesNotMatch(workflow, /1ed0c70c82dc74b2a506e6ac0004bad29fbfa43a/);
  assert.doesNotMatch(workflow, /\bdefault:/);
  assert.match(workflow, /PACKAGE_SOURCE !== sha/);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/m);
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /--artifact-metadata "\$RUNNER_TEMP\/qa-artifacts.json"/);
  assert.doesNotMatch(workflow, /gh run download|actions\/download-artifact|secrets\./);
  assert.ok(workflow.indexOf('verifyQaSource(JSON.parse') < workflow.indexOf('sealed-qa-artifact.py select'));
  assert.ok(workflow.indexOf('sealed-qa-artifact.py extract') < workflow.indexOf('node scripts/test/sealed-desktop-bridge.mjs'));
  for (const block of workflow.matchAll(/^        run: \|\n((?:^          .*\n)+)/gm)) {
    const script = block[1].split("\n").map((line) => line.slice(10)).join("\n");
    const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("artifact extraction rejects digest changes, traversal, and links before writing", () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3",
    [resolve(import.meta.dirname, "sealed-qa-artifact.test.py")], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", timeout: 30_000,
    });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("the native pairing harness refuses this local Mac and every unsupported runner", () => {
  assert.throws(() => remoteRunnerRequired({}, "darwin", "arm64"), /remote_macos_actions_runner_required/);
  const environment = { GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "sealed Desktop Bridge qualification" };
  assert.doesNotThrow(() => remoteRunnerRequired(environment, "darwin", "arm64"));
  assert.throws(() => remoteRunnerRequired(environment, "linux", "x64"));
  assert.throws(() => remoteRunnerRequired({ ...environment, GITHUB_WORKFLOW: "ci" }, "darwin", "arm64"));
});

test("the retained 1.0.14 receipt stays historical and is not proof of this checkout", () => {
  const bytes = readFileSync(resolve(import.meta.dirname, "fixtures/sealed-qa-37649115964-package-receipt.json"));
  const receipt = JSON.parse(bytes);
  const version = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")).version;
  assert.equal(receipt.version, "1.0.14");
  assert.notEqual(version, receipt.version);
  assert.throws(() => qualifyRetainedCheckout(receipt, { version, head: receipt.source.head }), /retained_desktop_version_mismatch/);
  assert.throws(() => qualifyRetainedCheckout({ ...receipt, version }, { version, head: "a".repeat(40) }), /retained_source_head_mismatch/);
  const changedCheckout = Buffer.from(releaseBytes.toString("utf8").replace(`"version": "${BRIDGE_VERSION}"`, '"version": "9.9.9"'));
  assert.equal(createHash("sha256").update(releaseBytes).digest("hex"), BRIDGE_SEAL);
  assert.throws(() => assertPackagedBridgeMatchesCheckout(releaseBytes, changedCheckout), /packaged_bridge_does_not_match_checkout/);
});

test("the retained artifact requires its successful QA run and exact package source", () => {
  const source = "1ed0c70c82dc74b2a506e6ac0004bad29fbfa43a";
  const record = { databaseId: 37649115964, headSha: source, conclusion: "success", workflowName: "desktop installer QA" };
  assert.doesNotThrow(() => verifyQaSource(record, source, "37649115964"));
  for (const changed of [{ headSha: "a".repeat(40) }, { conclusion: "failure" }, { databaseId: 1 }, { workflowName: "ci" }]) {
    assert.throws(() => verifyQaSource({ ...record, ...changed }, source, "37649115964"), /successful_qa_source_binding_required/);
  }
});

test("the verifier accepts the exact release and the app's sole added active-folder marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "sealed-bridge-contract-"));
  try {
    await cp(extension, root, { recursive: true });
    assert.equal((await verifySealedBridge(root, releaseBytes)).version, BRIDGE_VERSION);
    await writeFile(join(root, "morrow-bridge-active-folder.json"), "{}\n");
    await assert.rejects(verifySealedBridge(root, releaseBytes), /unsealed_bridge_file_refused/);
    await verifySealedBridge(root, releaseBytes, { activeFolderMarker: true });
    await writeFile(join(root, "extra.js"), "// injected\n");
    await assert.rejects(verifySealedBridge(root, releaseBytes, { activeFolderMarker: true }), /unsealed_bridge_file_refused/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changed sealed bytes and a symlink cannot qualify an extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "sealed-bridge-contract-"));
  try {
    await cp(extension, root, { recursive: true });
    await writeFile(join(root, "src/service-worker.js"), "// changed\n");
    await assert.rejects(verifySealedBridge(root, releaseBytes), /sealed_bridge_file_changed/);
    await rm(join(root, "src/service-worker.js"));
    await symlink(join(extension, "src/service-worker.js"), join(root, "src/service-worker.js"));
    await assert.rejects(verifySealedBridge(root, releaseBytes), /bridge_symbolic_link_refused/);
    await assert.rejects(verifySealedBridge(root, Buffer.from("{}")), /exact_bridge_release_seal_required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
