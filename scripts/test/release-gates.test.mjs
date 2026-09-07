import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  browserHarnessState,
  deterministicZip,
  buildCycloneDxSbom,
  publicPackageManifest,
  scanCandidateEntries,
  sha256,
  stageCandidate,
  stageCandidateSet,
  BROWSER_HARNESS_IDS,
  BROWSER_HARNESS_NOT_RUN_STATUSES,
  BROWSER_HARNESS_RAN_STATUSES,
  BROWSER_HARNESS_RECEIPT_PATH,
  REQUIRED_BROWSER_HARNESS_PASSES,
  REQUIRED_EXTERNAL_RECEIPTS,
  REQUIRED_PROMOTION_RECEIPTS,
  validateSourceOriginLedger,
  ZERO_TOLERANCE_TARGETS,
  zeroToleranceState,
} from "../lib/release-candidate.mjs";
import { HARNESSES, harnessReceipt, planHarnesses, runHarness } from "../run-browser-harnesses.mjs";

/**
 * The browser gate the release reads. `pnpm test:browser` runs the harnesses that `pnpm check`
 * cannot — Chromium, a person answering a Chrome permission prompt, native Windows — and writes the
 * receipt these helpers build here, so the tests below check the receipt the runner actually writes.
 */
const HARNESS_BY_ID = new Map(HARNESSES.map((harness) => [harness.id, harness]));

/** The result rows an attended run on a host without the Windows installer produces. */
function attendedResults() {
  return planHarnesses({ attended: true }).map((planned) => (planned.run
    ? { id: planned.harness.id, status: "passed" }
    : { id: planned.harness.id, status: planned.status, reason: planned.reason }));
}

/** Writes the receipt and the logs `pnpm test:browser` writes into `root`, and returns the receipt. */
function writeBrowserHarnessProof(root, { commit, tree, workingTreeClean = true, results = attendedResults() }) {
  const receiptPath = resolve(root, BROWSER_HARNESS_RECEIPT_PATH);
  mkdirSync(dirname(receiptPath), { recursive: true });
  const harnesses = results.map((result) => {
    const script = HARNESS_BY_ID.get(result.id)?.script ?? null;
    if (!BROWSER_HARNESS_RAN_STATUSES.includes(result.status)) {
      return { id: result.id, script, status: result.status, reason: result.reason };
    }
    const log = `${result.id}.log`;
    const data = `${result.id} ${result.status}\n`;
    writeFileSync(resolve(dirname(receiptPath), log), data);
    return {
      id: result.id,
      script,
      status: result.status,
      exitCode: result.status === "passed" ? 0 : 1,
      durationMs: 1_000,
      timeoutMs: HARNESS_BY_ID.get(result.id)?.timeoutMs ?? 1_000,
      log,
      logSha256: sha256(data),
    };
  });
  const receipt = harnessReceipt({
    commit,
    tree,
    workingTreeClean,
    attended: true,
    startedAt: "2026-09-07T00:00:00.000Z",
    finishedAt: "2026-09-07T00:01:00.000Z",
    host: { platform: process.platform, arch: process.arch, nodeVersion: process.version },
    harnesses,
  });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** Reads the receipt from its default place in the fixture, whatever this shell configured. */
function useDefaultReceiptPath(t) {
  const configured = process.env.MORROW_BROWSER_HARNESS_RECEIPT_PATH;
  delete process.env.MORROW_BROWSER_HARNESS_RECEIPT_PATH;
  t.after(() => {
    if (configured !== undefined) process.env.MORROW_BROWSER_HARNESS_RECEIPT_PATH = configured;
  });
}

/** A git fixture whose ignored directories match this repository's, so a written receipt keeps the tree clean. */
function gitFixture(suffix) {
  const root = mkdtempSync(resolve(tmpdir(), `morrow-${suffix}-`));
  writeFileSync(resolve(root, ".gitignore"), "artifacts/\noutput/\n");
  writeFileSync(resolve(root, "package.json"), '{"name":"morrow-test","version":"1.0.0"}\n');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Morrow Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return {
    root,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(),
  };
}

test("candidate archive bytes are deterministic", () => {
  const entries = [
    { path: "b.json", data: Buffer.from('{"b":2}\n') },
    { path: "a.md", data: Buffer.from("candidate\n") },
  ];
  const first = deterministicZip(entries);
  const second = deterministicZip([...entries].reverse());
  assert.deepEqual(first, second);
  assert.equal(sha256(first), sha256(second));
});

test("candidate SBOM is deterministic and names each staged package", () => {
  const sourceFiles = [
    { path: "package.json", data: Buffer.from('{"name":"morrow","version":"1.0.0"}') },
    { path: "packages/gateway/package.json", data: Buffer.from('{"name":"@morrow/gateway","version":"1.0.0"}') },
  ];
  const first = buildCycloneDxSbom({ candidateName: "morrow-v1.0.0-rc.0-test", sourceFiles });
  const second = buildCycloneDxSbom({ candidateName: "morrow-v1.0.0-rc.0-test", sourceFiles: [...sourceFiles].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(first.components.map((component) => component.name), ["@morrow/gateway", "morrow"]);
});

test("public candidate package only exposes shipped commands", () => {
  const manifest = JSON.parse(publicPackageManifest(Buffer.from(JSON.stringify({
    name: "morrow",
    scripts: {
      build: "pnpm -r build",
      "package:connector": "node scripts/package-canvas-connector.mjs",
      "package:rc": "node scripts/package-profile.mjs --all",
      test: "pnpm test",
    },
  }))).toString("utf8"));
  assert.deepEqual(manifest.scripts, {
    build: "pnpm -r build",
    "package:connector": "node scripts/package-canvas-connector.mjs",
  });
});

test("public package scan checks docs, JSON, and source maps", () => {
  const scan = scanCandidateEntries([
    { path: "docs/example.md", data: Buffer.from("CHCP marker") },
    { path: "examples/config.json", data: Buffer.from('{"path":"/Users/example"}') },
    { path: "bundle.js.map", data: Buffer.from("-----BEGIN PRIVATE KEY-----") },
  ], "public");
  assert.equal(scan.passed, false);
  assert.deepEqual(scan.violations.map((entry) => entry.marker).sort(), [
    "absolute_user_path",
    "private_example-kit_marker",
    "private_key",
  ]);
});

test("source-origin validation fails closed until every staged file is reviewed", () => {
  const root = mkdtempSync(resolve(tmpdir(), "morrow-release-ledger-"));
  try {
    mkdirSync(resolve(root, "config"), { recursive: true });
    const files = [{ path: "packages/example.js", sha256: "a".repeat(64), bytes: 1 }];
    writeFileSync(resolve(root, "config/source-origin-ledger.json"), JSON.stringify({
      schema: "morrow.source-origin-ledger.v1",
      status: "blocked-pending-per-file-review",
      entries: [],
    }));
    const blocked = validateSourceOriginLedger({ root, files, commit: "b".repeat(40) });
    assert.equal(blocked.passed, false);
    assert.deepEqual(blocked.missing, ["packages/example.js"]);

    writeFileSync(resolve(root, "config/source-origin-ledger.json"), JSON.stringify({
      schema: "morrow.source-origin-ledger.v1",
      status: "reviewed",
      candidateCommit: "b".repeat(40),
      entries: [{
        path: "packages/example.js",
        sourceCommit: "d".repeat(40),
        originalPath: "packages/example.js",
        ownership: "new",
        dependencies: [],
        testMapping: ["scripts/test/release-gates.test.mjs"],
        reviewer: "release-review",
        beforeDigest: "c".repeat(64),
        afterDigest: "a".repeat(64),
      }],
    }));
    assert.equal(validateSourceOriginLedger({ root, files, commit: "b".repeat(40) }).passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate set receipts bind the final digest of every profile", (t) => {
  useDefaultReceiptPath(t);
  const root = mkdtempSync(resolve(tmpdir(), "morrow-release-set-"));
  try {
    mkdirSync(resolve(root, "config"), { recursive: true });
    mkdirSync(resolve(root, "artifacts/canvas-api"), { recursive: true });
    const packageBytes = Buffer.from('{"name":"morrow-test","version":"1.0.0"}\n');
    writeFileSync(resolve(root, ".gitignore"), "artifacts/\noutput/\n");
    writeFileSync(resolve(root, "package.json"), packageBytes);
    writeFileSync(resolve(root, "config/release-profiles.json"), JSON.stringify({
      schema: "morrow.release-profiles.v1",
      candidateVersion: "1.0.0",
      profiles: {
        "private-full": { visibility: "private", include: ["package.json"], exclude: [] },
        "public-canvas": { visibility: "private", include: ["package.json"], exclude: [] },
      },
    }));
    writeFileSync(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"), JSON.stringify({
      catalogDigest: "e".repeat(64),
    }));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Morrow Test"], { cwd: root });
    execFileSync("git", ["add", ".gitignore", "package.json", "config/release-profiles.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(resolve(root, "config/source-origin-ledger.json"), JSON.stringify({
      schema: "morrow.source-origin-ledger.v1",
      status: "reviewed",
      candidateCommit: sourceCommit,
      entries: [{
        path: "package.json",
        sourceCommit,
        originalPath: "package.json",
        ownership: "new",
        dependencies: [],
        testMapping: ["scripts/test/release-gates.test.mjs"],
        reviewer: "release-review",
        beforeDigest: sha256(Buffer.alloc(0)),
        afterDigest: sha256(packageBytes),
      }],
    }));
    execFileSync("git", ["add", "config/source-origin-ledger.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "ledger"], { cwd: root });

    const receipts = stageCandidateSet({
      root,
      profileNames: ["private-full", "public-canvas"],
      verifyRebuild: true,
    });
    const expected = {
      privateFull: receipts[0].packageDigest,
      publicCanvas: receipts[1].packageDigest,
    };
    for (const receipt of receipts) {
      assert.equal(receipt.externalReceipts.binding.catalogDigest, "e".repeat(64));
      assert.deepEqual(receipt.externalReceipts.binding.candidateDigests, expected);
      assert.deepEqual(receipt.promotionReceipts.binding.candidateDigests, expected);
      assert.deepEqual(receipt.zeroTolerance.binding.candidateDigests, expected);
    }
    const binding = {
      commit: receipts[0].commit,
      tree: receipts[0].tree,
      catalogDigest: "e".repeat(64),
      candidateDigests: expected,
    };
    const evidenceRoot = "artifacts/release/evidence-test";
    mkdirSync(resolve(root, evidenceRoot), { recursive: true });
    const log = resolve(root, evidenceRoot, "proof.log");
    writeFileSync(log, "passed");
    const evidence = [{ path: "proof.log", sha256: sha256("passed") }];
    writeFileSync(resolve(root, "artifacts/release/zero-tolerance-receipt.json"), JSON.stringify({
      schema: "morrow.zero-tolerance-receipt.v1", status: "passed", binding, evidenceRoot,
      checks: ZERO_TOLERANCE_TARGETS.map((id) => ({
        id, status: "passed", count: 0, evidence,
        receiptDigest: sha256(JSON.stringify({ binding, id, evidenceDigests: evidence })),
      })),
    }));
    assert.equal(zeroToleranceState(root).passed, true);
    writeFileSync(log, "changed after verification");
    assert.equal(zeroToleranceState(root).passed, false);

    writeFileSync(log, "passed");
    const staleDigest = "f".repeat(64);
    const writeExternalReceipts = (candidateDigests) => writeFileSync(resolve(root, "artifacts/release/external-receipts.json"), JSON.stringify({
      receipts: [...REQUIRED_EXTERNAL_RECEIPTS, ...REQUIRED_PROMOTION_RECEIPTS].map((id) => ({
        id,
        status: "verified",
        receiptDigest: "d".repeat(64),
        verifier: "release-test",
        verifiedAt: "2026-09-05T00:00:00.000Z",
        commit: binding.commit,
        catalogDigest: binding.catalogDigest,
        candidateDigests,
      })),
    }));
    writeExternalReceipts(expected);
    writeFileSync(resolve(root, "artifacts/candidates/private-full/receipt.json"), JSON.stringify({
      packageDigest: staleDigest,
    }));
    const singleProfile = stageCandidate({ root, profileName: "private-full", verifyRebuild: true });
    assert.equal(singleProfile.packageDigest, expected.privateFull);
    assert.deepEqual(singleProfile.externalReceipts.binding.candidateDigests, expected);
    assert.equal(singleProfile.externalReceipts.passed, true);
    assert.equal(singleProfile.promotionReceipts.passed, true);
    assert.equal(singleProfile.zeroTolerance.passed, true);
    assert.equal(singleProfile.browserHarness.passed, false);
    assert.equal(singleProfile.promotable, false, "a candidate with every other receipt is still not promotable with no browser result");
    assert.deepEqual(singleProfile.blockingReasons, BROWSER_HARNESS_IDS.map((id) => `browser_harness_result_missing:${id}`).sort());

    writeBrowserHarnessProof(root, { commit: receipts[0].commit, tree: receipts[0].tree });
    const withBrowserProof = stageCandidate({ root, profileName: "private-full", verifyRebuild: true });
    assert.equal(withBrowserProof.browserHarness.passed, true);
    assert.deepEqual(withBrowserProof.blockingReasons, []);
    assert.equal(withBrowserProof.promotable, true);
    assert.equal(withBrowserProof.stablePromotionReady, true);

    const staleBinding = { ...binding, candidateDigests: { ...expected, privateFull: staleDigest } };
    writeFileSync(resolve(root, "artifacts/release/zero-tolerance-receipt.json"), JSON.stringify({
      schema: "morrow.zero-tolerance-receipt.v1", status: "passed", binding: staleBinding, evidenceRoot,
      checks: ZERO_TOLERANCE_TARGETS.map((id) => ({
        id, status: "passed", count: 0, evidence,
        receiptDigest: sha256(JSON.stringify({ binding: staleBinding, id, evidenceDigests: evidence })),
      })),
    }));
    assert.equal(zeroToleranceState(root).passed, false);

    writeExternalReceipts(staleBinding.candidateDigests);
    writeFileSync(resolve(root, "artifacts/candidates/private-full/receipt.json"), JSON.stringify({
      packageDigest: staleDigest,
    }));
    const rejected = stageCandidate({ root, profileName: "private-full", verifyRebuild: true });
    assert.equal(rejected.externalReceipts.passed, false);
    assert.equal(rejected.promotionReceipts.passed, false);
    assert.equal(rejected.zeroTolerance.passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pnpm test:browser runs the harnesses pnpm check cannot, and names the rest", () => {
  const rootPackage = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"));
  assert.equal(rootPackage.scripts["test:browser"], "pnpm build && node scripts/run-browser-harnesses.mjs");
  assert.equal(rootPackage.scripts["test:browser:attended"], "pnpm build && node scripts/run-browser-harnesses.mjs --attended");
  assert.match(rootPackage.scripts["scripts:test"], /^node --test (?:--test-concurrency=2 )?scripts\/test\/\*\.test\.mjs$/,
    "the always-on gate globs test files only, which is why these harnesses need their own command");

  assert.deepEqual(HARNESSES.map((harness) => harness.id), [...BROWSER_HARNESS_IDS],
    "the runner and the release gate must name the same harnesses");
  for (const harness of HARNESSES) {
    assert.equal(existsSync(resolve(import.meta.dirname, "../..", harness.script)), true, `${harness.script} must exist`);
    assert.match(harness.summary, /\S/);
  }

  const unattended = planHarnesses({ attended: false });
  assert.deepEqual(unattended.filter((planned) => planned.run).map((planned) => planned.harness.id),
    ["canvas_connector_browser", "bridge_maintenance_cft"]);
  for (const planned of unattended.filter((entry) => !entry.run)) {
    assert.ok(BROWSER_HARNESS_NOT_RUN_STATUSES.includes(planned.status), `${planned.harness.id} needs a not-run status`);
    assert.match(planned.reason, /\S/, `${planned.harness.id} must say why it did not run`);
  }
  assert.equal(unattended.find((planned) => planned.harness.id === "canvas_file_optional_permission").status, "not-run-unattended");
  assert.equal(unattended.find((planned) => planned.harness.id === "desktop_windows_smoke").status, "not-run-on-this-host");

  const attended = planHarnesses({ attended: true });
  assert.deepEqual(attended.filter((planned) => planned.run).map((planned) => planned.harness.id), [...REQUIRED_BROWSER_HARNESS_PASSES],
    "every harness the release requires to pass must be one a command on this host can run");
  assert.equal(attended.find((planned) => planned.harness.id === "desktop_windows_smoke").run, false);
  for (const planned of attended.filter((entry) => entry.run)) {
    assert.ok(planned.harness.timeoutMs > 0, `${planned.harness.id} must run under its own timeout`);
  }
});

test("the browser gate reads a receipt only while it belongs to this checkout", (t) => {
  useDefaultReceiptPath(t);
  const { root, commit, tree } = gitFixture("browser-harness-binding");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { commit, catalogDigest: null, candidateDigests: { privateFull: null, publicCanvas: null } };

  const none = browserHarnessState(root, binding);
  assert.equal(none.path, null);
  assert.equal(none.passed, false);
  assert.deepEqual(none.harnesses.map((entry) => entry.status), BROWSER_HARNESS_IDS.map(() => "missing"));

  writeBrowserHarnessProof(root, { commit, tree });
  const accepted = browserHarnessState(root, binding);
  assert.equal(accepted.boundToHead, true);
  assert.equal(accepted.passed, true);
  assert.deepEqual(accepted.harnesses.filter((entry) => entry.required).map((entry) => entry.status),
    REQUIRED_BROWSER_HARNESS_PASSES.map(() => "passed"));
  assert.equal(accepted.harnesses.find((entry) => entry.id === "desktop_windows_smoke").status, "not-run-on-this-host");

  const logPath = resolve(root, dirname(BROWSER_HARNESS_RECEIPT_PATH), "canvas_connector_browser.log");
  const recorded = readFileSync(logPath);
  writeFileSync(logPath, "a different run\n");
  const edited = browserHarnessState(root, binding);
  assert.equal(edited.harnesses.find((entry) => entry.id === "canvas_connector_browser").status, "missing");
  assert.equal(edited.passed, false);
  writeFileSync(logPath, recorded);
  assert.equal(browserHarnessState(root, binding).passed, true);

  writeBrowserHarnessProof(root, { commit: "0".repeat(40), tree });
  const otherCommit = browserHarnessState(root, binding);
  assert.equal(otherCommit.boundToHead, false);
  assert.deepEqual(otherCommit.harnesses.map((entry) => entry.status), BROWSER_HARNESS_IDS.map(() => "missing"));

  writeBrowserHarnessProof(root, { commit, tree, workingTreeClean: false });
  assert.equal(browserHarnessState(root, binding).boundToHead, false);

  writeBrowserHarnessProof(root, { commit, tree });
  writeFileSync(resolve(root, "uncommitted.txt"), "source changed after the run\n");
  assert.equal(browserHarnessState(root, binding).boundToHead, false,
    "a run against a changed working tree is not a result for this commit");
});

test("the browser gate counts only a recorded pass, and never a harness that did not run", (t) => {
  useDefaultReceiptPath(t);
  const { root, commit, tree } = gitFixture("browser-harness-results");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { commit, catalogDigest: null, candidateDigests: { privateFull: null, publicCanvas: null } };
  const stateOf = (results) => {
    writeBrowserHarnessProof(root, { commit, tree, results });
    return browserHarnessState(root, binding);
  };

  const withoutPermissionProof = stateOf(attendedResults().filter((entry) => entry.id !== "canvas_file_optional_permission"));
  assert.equal(withoutPermissionProof.passed, false);
  assert.deepEqual(withoutPermissionProof.harnesses.filter((entry) => entry.blocking).map((entry) => entry.id),
    ["canvas_file_optional_permission"]);

  const permissionProofNotRun = stateOf(attendedResults().map((entry) => (entry.id === "canvas_file_optional_permission"
    ? { id: entry.id, status: "not-run-unattended", reason: "no person answered the Chrome prompts" }
    : entry)));
  assert.equal(permissionProofNotRun.harnesses.find((entry) => entry.id === "canvas_file_optional_permission").status, "not-run-unattended");
  assert.equal(permissionProofNotRun.passed, false, "a proof that did not run is recorded, and it is not a pass");

  for (const status of ["failed", "timed-out"]) {
    const chromiumUnpassed = stateOf(attendedResults().map((entry) => (entry.id === "canvas_connector_browser"
      ? { id: entry.id, status }
      : entry)));
    assert.equal(chromiumUnpassed.harnesses.find((entry) => entry.id === "canvas_connector_browser").status, status);
    assert.equal(chromiumUnpassed.passed, false);
  }

  const windowsFailed = stateOf(attendedResults().map((entry) => (entry.id === "desktop_windows_smoke"
    ? { id: entry.id, status: "failed" }
    : entry)));
  assert.equal(windowsFailed.passed, false, "the Windows smoke does not have to run here, but a recorded failure blocks");

  const windowsNotRunElsewhere = stateOf(attendedResults());
  assert.equal(windowsNotRunElsewhere.passed, true);
  assert.equal(windowsNotRunElsewhere.harnesses.find((entry) => entry.id === "desktop_windows_smoke").required, false);
});

test("a harness result is the run that happened: its own timeout, and the log it was hashed from", async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "morrow-browser-harness-run-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = (body) => {
    const path = resolve(directory, `${body.replace(/\W+/g, "-")}.mjs`);
    writeFileSync(path, body);
    return path;
  };

  const completed = await runHarness(
    { id: "fixture_pass", script: script('process.stdout.write("fixture harness ran\\n");'), timeoutMs: 30_000 },
    { logPath: resolve(directory, "fixture_pass.log") },
  );
  assert.equal(completed.status, "passed");
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.timeoutMs, 30_000);
  const log = readFileSync(resolve(directory, "fixture_pass.log"));
  assert.equal(log.toString("utf8"), "fixture harness ran\n");
  assert.equal(completed.logSha256, sha256(log), "the receipt has to name the digest of the log it wrote");

  const failed = await runHarness(
    { id: "fixture_fail", script: script('process.stderr.write("fixture harness refused\\n");process.exit(3);'), timeoutMs: 30_000 },
    { logPath: resolve(directory, "fixture_fail.log") },
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 3);
  assert.match(readFileSync(resolve(directory, "fixture_fail.log"), "utf8"), /fixture harness refused/);

  const started = Date.now();
  const stopped = await runHarness(
    { id: "fixture_timeout", script: script("setTimeout(() => {}, 120_000);"), timeoutMs: 750 },
    { logPath: resolve(directory, "fixture_timeout.log") },
  );
  assert.equal(stopped.status, "timed-out", "a harness that outlives its own timeout is stopped and recorded as a machine result");
  assert.ok(Date.now() - started < 30_000, "the timeout must stop the harness, not wait for it");
  assert.notEqual(stopped.status, "passed");
});
