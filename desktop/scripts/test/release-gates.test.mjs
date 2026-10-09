import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import {
  browserHarnessState,
  conformanceReport,
  deterministicZip,
  externalReceiptClaim,
  buildCycloneDxSbom,
  publicPackageManifest,
  loadReleaseProfiles,
  MAX_RELEASE_TRUST_INPUT_BYTES,
  profileIncludes,
  scanCandidateEntries,
  scanStagedCandidate,
  sha256,
  stableJson,
  stageCandidate,
  stageCandidateSet,
  BROWSER_HARNESS_IDS,
  BROWSER_HARNESS_NOT_RUN_STATUSES,
  BROWSER_HARNESS_RAN_STATUSES,
  BROWSER_HARNESS_RECEIPT_PATH,
  REQUIRED_BROWSER_HARNESS_PASSES,
  requiredEvidenceForProfile,
  validateSourceOriginLedger,
  validateReleasePackageVersions,
  ZERO_TOLERANCE_TARGETS,
  zeroToleranceState,
} from "../lib/release-candidate.mjs";
import { HARNESSES, harnessReceipt, planHarnesses, runHarness } from "../run-browser-harnesses.mjs";

/**
 * The browser gate the release reads. `pnpm test:browser` runs the harnesses that `pnpm check`
 * cannot (Chromium, a person answering a Chrome permission prompt, and native Windows) and writes the
 * receipt these helpers build here, so the tests below check the receipt the runner actually writes.
 */
const HARNESS_BY_ID = new Map(HARNESSES.map((harness) => [harness.id, harness]));
const EXPECTED_EXTERNAL_RECEIPTS = Object.freeze([
  "blackboard_authorization",
  "blackboard_no_live_tenant_exception",
  "canvas_authorization",
  "canvas_live_proof",
  "client_parity",
  "moodle_authorization",
  "moodle_live_proof",
]);
const EXPECTED_PROMOTION_RECEIPTS = Object.freeze(["independent_clean_machine", "publication_authorization"]);
const AUTHORIZATION_RECEIPTS = new Set([
  "blackboard_authorization",
  "blackboard_no_live_tenant_exception",
  "canvas_authorization",
  "moodle_authorization",
  "publication_authorization",
]);

/** The result rows an attended run on a host without the Windows installer produces. */
function attendedResults() {
  return planHarnesses({ attended: true }).map((planned) => (planned.run
    ? { id: planned.harness.id, status: "passed" }
    : { id: planned.harness.id, status: planned.status, reason: planned.reason }));
}

/** Attended results plus a Windows smoke log that actually passed. */
function promotionResults() {
  return attendedResults().map((entry) => (entry.id === "desktop_windows_smoke"
    ? { id: entry.id, status: "passed" }
    : entry));
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
    const data = result.status === "passed"
      ? `${result.id}\nℹ tests 1\nℹ pass 1\nℹ fail 0\n`
      : `${result.id} ${result.status}\nℹ tests 1\nℹ pass 0\nℹ fail 1\n`;
    writeFileSync(resolve(dirname(receiptPath), log), data);
    return {
      id: result.id,
      script,
      status: result.status,
      exitCode: result.status === "passed" ? 0 : 1,
      durationMs: 1_000,
      timeoutMs: HARNESS_BY_ID.get(result.id)?.timeoutMs ?? 1_000,
      log,
      logBytes: Buffer.byteLength(data),
      logTruncated: false,
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

test("candidate SBOM resolves exact production versions and every transitive component", () => {
  const sourceFiles = [
    {
      path: "package.json",
      data: Buffer.from(JSON.stringify({
        name: "morrow",
        version: "1.0.0",
        dependencies: { alpha: "^1.0.0" },
        devDependencies: { ignored: "^9.0.0" },
      })),
    },
    {
      path: "pnpm-lock.yaml",
      data: Buffer.from(`lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      alpha:
        specifier: ^1.0.0
        version: 1.2.3
    devDependencies:
      ignored:
        specifier: ^9.0.0
        version: 9.9.9

packages:

  alpha@1.2.3: {}
  beta@2.4.6: {}
  ignored@9.9.9: {}

snapshots:

  alpha@1.2.3:
    dependencies:
      beta: 2.4.6

  beta@2.4.6: {}

  ignored@9.9.9: {}
`),
    },
  ];
  const sbom = buildCycloneDxSbom({ candidateName: "morrow-v1.0.0-test", sourceFiles });
  assert.deepEqual(sbom.components.map(({ name, version }) => ({ name, version })), [
    { name: "alpha", version: "1.2.3" },
    { name: "beta", version: "2.4.6" },
    { name: "morrow", version: "1.0.0" },
  ]);
  assert.equal(sbom.components.some((component) => component.name === "ignored"), false);
  assert.deepEqual(sbom.dependencies, [
    { ref: "pkg:npm/alpha@1.2.3", dependsOn: ["pkg:npm/beta@2.4.6"] },
    { ref: "pkg:npm/beta@2.4.6", dependsOn: [] },
    { ref: "pkg:npm/morrow@1.0.0", dependsOn: ["pkg:npm/alpha@1.2.3"] },
  ]);
});

test("one frozen root manifest owns every release version", () => {
  const root = { path: "package.json", data: Buffer.from('{"name":"morrow","version":"7.4.3"}') };
  const installer = { path: "installer/package.json", data: Buffer.from('{"name":"morrow-desktop","version":"7.4.3"}') };
  assert.equal(validateReleasePackageVersions({ sourceFiles: [root, installer], version: "7.4.3" }), true);
  assert.throws(() => validateReleasePackageVersions({
    sourceFiles: [root, { ...installer, data: Buffer.from('{"name":"morrow-desktop","version":"1.0.0"}') }],
    version: "7.4.3",
  }), /installer and root package versions do not match/);
  assert.throws(() => validateReleasePackageVersions({ sourceFiles: [root], version: "1.0.0" }),
    /staged root package version does not match/);
});

test("release evidence requirements derive from every included provider", () => {
  const profile = {
    providers: {
      canvas: { authorizationReceipt: "canvas_authorization", liveProofReceipt: "canvas_live_proof" },
      moodle: { authorizationReceipt: "moodle_authorization", liveProofReceipt: "moodle_live_proof" },
      blackboard: { authorizationReceipt: "blackboard_authorization", liveProofExceptionReceipt: "blackboard_no_live_tenant_exception" },
    },
    externalEvidenceReceipts: ["client_parity"],
    promotionEvidenceReceipts: [...EXPECTED_PROMOTION_RECEIPTS],
  };
  assert.deepEqual(requiredEvidenceForProfile(profile), {
    external: [...EXPECTED_EXTERNAL_RECEIPTS],
    promotion: [...EXPECTED_PROMOTION_RECEIPTS],
  });
  assert.throws(() => requiredEvidenceForProfile({
    ...profile,
    providers: { ...profile.providers, moodle: { authorizationReceipt: "moodle_authorization" } },
  }), /requires one live proof or signed exception/);
  assert.throws(() => requiredEvidenceForProfile({
    ...profile,
    providers: { ...profile.providers, blackboard: {
      authorizationReceipt: "blackboard_authorization",
      liveProofReceipt: "blackboard_live_proof",
      liveProofExceptionReceipt: "blackboard_no_live_tenant_exception",
    } },
  }), /requires one live proof or signed exception/);
});

test("public candidate package only exposes shipped commands", () => {
  const manifest = JSON.parse(publicPackageManifest(Buffer.from(JSON.stringify({
    name: "morrow",
    scripts: {
      build: "pnpm -r build",
      "canvas:readback:sync": "node scripts/sync-canvas-readback-plan.mjs",
      "canvas:readback:check": "node scripts/sync-canvas-readback-plan.mjs --check",
      "package:connector": "node scripts/package-canvas-connector.mjs",
      "package:rc": "node scripts/package-profile.mjs --all",
      test: "pnpm test",
    },
  }))).toString("utf8"));
  assert.deepEqual(manifest.scripts, {
    build: "pnpm -r build",
    "canvas:readback:sync": "node scripts/sync-canvas-readback-plan.mjs",
    "canvas:readback:check": "node scripts/sync-canvas-readback-plan.mjs --check",
    "package:connector": "node scripts/package-canvas-connector.mjs",
  });
});

test("the public candidate retains every module its connector package command loads", () => {
  const root = resolve(import.meta.dirname, "../..");
  const profile = loadReleaseProfiles(root).profiles["public-canvas"];
  for (const path of [
    "installer/shared/bridge-delivery.cjs",
    "installer/shared/bridge-updates.cjs",
    "installer/shared/packager-admission.cjs",
    "installer/shared/process-lifetime.cjs",
  ]) {
    assert.equal(profileIncludes(path, profile), true, `${path} is loaded by a retained packaging command`);
  }
});

test("release configuration admission refuses links and oversized files", () => {
  const root = mkdtempSync(resolve(tmpdir(), "morrow-release-config-admission-"));
  const config = resolve(root, "config");
  const path = resolve(config, "release-profiles.json");
  const target = resolve(config, "target.json");
  try {
    mkdirSync(config, { recursive: true });
    writeFileSync(target, '{"schema":"morrow.release-profiles.v2","profiles":{}}\n');
    if (process.platform !== "win32") {
      symlinkSync(target, path);
      assert.throws(() => loadReleaseProfiles(root), /not a bounded regular file/);
      unlinkSync(path);
    }
    writeFileSync(path, "{}");
    truncateSync(path, MAX_RELEASE_TRUST_INPUT_BYTES + 1);
    assert.throws(() => loadReleaseProfiles(root), /not a bounded regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    "private_chcp_marker",
    "private_key",
  ]);
});

for (const layout of ["standalone", "monorepo"]) {
test(`public candidate rights and origin evidence bind the post-transform package bytes in ${layout}`, (t) => {
  useDefaultReceiptPath(t);
  const repository = mkdtempSync(resolve(tmpdir(), "morrow-release-derived-rights-"));
  const root = layout === "monorepo" ? resolve(repository, "desktop") : repository;
  try {
    mkdirSync(resolve(root, "config"), { recursive: true });
    const packageBytes = Buffer.from(`${JSON.stringify({
      name: "morrow-test",
      version: "1.0.0",
      scripts: { build: "pnpm build", "package:rc": "node private-release.mjs", test: "node --test" },
    }, null, 2)}\n`);
    const sourceDigest = sha256(packageBytes);
    writeFileSync(resolve(root, ".gitignore"), "artifacts/\noutput/\n");
    writeFileSync(resolve(root, "package.json"), packageBytes);
    writeFileSync(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(resolve(root, "config/release-profiles.json"), JSON.stringify({
      schema: "morrow.release-profiles.v2",
      profiles: {
        "public-canvas": {
          visibility: "public",
          providers: {},
          externalEvidenceReceipts: [],
          promotionEvidenceReceipts: [],
          include: ["package.json"],
          exclude: [],
        },
      },
    }));
    writeFileSync(resolve(root, "config/source-rights.manifest.json"), JSON.stringify({
      schema: "morrow.source-rights.v1",
      files: [{ path: "package.json", sha256: sourceDigest, disposition: "direct_owned", review: "release review" }],
    }));
    execFileSync("git", ["init", "-q"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Morrow Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "source"], { cwd: root });
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
        testMapping: [],
        reviewer: "release review",
        beforeDigest: null,
        afterDigest: sourceDigest,
      }],
    }));
    execFileSync("git", ["add", "config/source-origin-ledger.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "rights evidence"], { cwd: root });

    const receipt = stageCandidate({ root, profileName: "public-canvas", verifyRebuild: true });
    const stageRoot = resolve(root, "artifacts/candidates/public-canvas/stage");
    const stagedPackage = readFileSync(resolve(stageRoot, "package.json"));
    const stagedDigest = sha256(stagedPackage);
    const rights = JSON.parse(readFileSync(resolve(stageRoot, "release/source-rights.manifest.json"), "utf8"));
    const origin = JSON.parse(readFileSync(resolve(stageRoot, "release/source-origin-ledger.json"), "utf8"));
    const expectedDerivation = {
      schema: "morrow.release-manifest-derivation.v1",
      transform: "public-package-manifest",
      sourceSha256: sourceDigest,
      stagedSha256: stagedDigest,
    };
    assert.notEqual(stagedDigest, sourceDigest);
    assert.equal(JSON.parse(stagedPackage).scripts["package:rc"], undefined);
    assert.deepEqual(rights.files, [{
      path: "package.json",
      sha256: stagedDigest,
      disposition: "direct_owned",
      review: "release review",
      derivation: expectedDerivation,
    }]);
    assert.equal(origin.entries[0].afterDigest, stagedDigest);
    assert.deepEqual(origin.entries[0].derivation, expectedDerivation);
    assert.equal(receipt.sourceRights.sourceInput.manifestSha256, sha256(readFileSync(resolve(root, "config/source-rights.manifest.json"))));
    assert.equal(receipt.deterministicRebuild.verified, true);
    assert.equal(receipt.sourceRights.passed, true);
    assert.equal(receipt.sourceOrigin.passed, true);
    const scan = scanStagedCandidate({ root, profileName: "public-canvas" });
    assert.equal(scan.sourceRights.passed, true);
    assert.equal(scan.sourceOrigin.passed, true);
    assert.equal(scan.passed, true);

    const conformance = conformanceReport({ root, profileName: "public-canvas" });
    assert.equal(conformance.checks.find((check) => check.id === "frozen_lockfile_tracked").passed, true);

    writeFileSync(resolve(stageRoot, "release/source-rights.manifest.json"), readFileSync(resolve(root, "config/source-rights.manifest.json")));
    const rejected = scanStagedCandidate({ root, profileName: "public-canvas" });
    assert.equal(rejected.sourceRights.passed, false);
    assert.equal(rejected.passed, false);
    writeFileSync(resolve(root, "package.json"), `${JSON.stringify({ name: "morrow-test", version: "1.0.1" })}\n`);
    execFileSync("git", ["add", "package.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "changed selected source"], { cwd: root });
    const changedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const staleOrigin = validateSourceOriginLedger({ root, files: [{ path: "package.json", sha256: sourceDigest }], commit: changedCommit });
    assert.equal(staleOrigin.candidateCommitMatches, false);
    assert.equal(staleOrigin.passed, false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
}

test("a public package is not reported built while its source rights are missing", (t) => {
  useDefaultReceiptPath(t);
  const root = mkdtempSync(resolve(tmpdir(), "morrow-release-missing-rights-"));
  try {
    mkdirSync(resolve(root, "config"), { recursive: true });
    const packageBytes = Buffer.from('{"name":"morrow-test","version":"1.0.0","scripts":{"build":"node build.mjs"}}\n');
    writeFileSync(resolve(root, ".gitignore"), "artifacts/\noutput/\n");
    writeFileSync(resolve(root, "package.json"), packageBytes);
    writeFileSync(resolve(root, "config/release-profiles.json"), JSON.stringify({
      schema: "morrow.release-profiles.v2",
      profiles: {
        "public-canvas": {
          visibility: "public",
          providers: {},
          externalEvidenceReceipts: [],
          promotionEvidenceReceipts: [],
          include: ["package.json"],
          exclude: [],
        },
      },
    }));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Morrow Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "source"], { cwd: root });
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
        testMapping: [],
        reviewer: "release review",
        beforeDigest: null,
        afterDigest: sha256(packageBytes),
      }],
    }));
    execFileSync("git", ["add", "config/source-origin-ledger.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "origin"], { cwd: root });

    const receipt = stageCandidate({ root, profileName: "public-canvas" });
    assert.equal(receipt.sourceOrigin.passed, true);
    assert.equal(receipt.sourceRights.passed, false);
    assert.equal(receipt.candidateBuilt, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      }, {
        path: "extra.txt",
        sourceCommit: "d".repeat(40),
        originalPath: "extra.txt",
        ownership: "new",
        dependencies: [],
        testMapping: [],
        reviewer: "release-review",
        beforeDigest: "c".repeat(64),
        afterDigest: "a".repeat(64),
      }],
    }));
    const fabricated = validateSourceOriginLedger({ root, files, commit: "b".repeat(40) });
    assert.equal(fabricated.passed, false);
    assert.deepEqual(fabricated.invalid, ["packages/example.js"]);
    assert.deepEqual(fabricated.unexpected, ["extra.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the committed source-origin ledger is unreviewed, and the old self-stamp is not a review", () => {
  const desktop = resolve(import.meta.dirname, "../..");
  const ledgerText = readFileSync(resolve(desktop, "config/source-origin-ledger.json"), "utf8");
  assert.doesNotMatch(ledgerText, /codex-plan-convergence-review/);
  assert.doesNotMatch(ledgerText, /"status": "reviewed"/);
  const ledger = JSON.parse(ledgerText);
  assert.equal(ledger.status, "unreviewed");
  assert.ok(ledger.entries.length > 0);
  assert.ok(ledger.entries.every((entry) => entry.reviewer === null));
  assert.ok(ledger.entries.every((entry) => entry.beforeDigest === null || /^[0-9a-f]{64}$/.test(entry.beforeDigest)));
  const head = execFileSync("git", ["-C", desktop, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const commitPresent = (revision) => {
    try {
      execFileSync("git", ["-C", desktop, "cat-file", "-e", `${revision}^{commit}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  // Each entry is checked against its own source commit and that commit's parent, not only
  // the ledger's candidate commit. A depth-1 CI checkout has neither until they are fetched.
  const parentsPresent = (revision) => {
    let listed;
    try {
      listed = execFileSync("git", ["-C", desktop, "rev-list", "--parents", "-n", "1", revision], { encoding: "utf8" }).trim();
    } catch {
      return false;
    }
    return listed.split(" ").slice(1).filter(Boolean).every((parent) => commitPresent(parent));
  };
  const needed = new Set(
    ledger.entries
      .map((entry) => entry.sourceCommit)
      .filter((commit) => typeof commit === "string" && /^[0-9a-f]{40,64}$/i.test(commit)),
  );
  if (typeof ledger.candidateCommit === "string" && /^[0-9a-f]{40,64}$/i.test(ledger.candidateCommit)) needed.add(ledger.candidateCommit);
  const missing = [...needed].filter((commit) => !commitPresent(commit) || !parentsPresent(commit));
  for (let offset = 0; offset < missing.length; offset += 40) {
    execFileSync("git", ["-C", desktop, "fetch", "--depth=2", "origin", ...missing.slice(offset, offset + 40)], { stdio: "ignore" });
  }
  const generated = validateSourceOriginLedger({
    root: desktop,
    commit: head,
    ledgerData: ledgerText,
    files: ledger.entries.map((entry) => ({ path: entry.path, sha256: entry.afterDigest, bytes: 1 })),
  });
  assert.equal(generated.ledgerStatus, "unreviewed");
  assert.equal(generated.passed, false, "a freshly generated ledger is not a completed review");
  assert.deepEqual(generated.invalid, []);
  assert.deepEqual(generated.unexpected, []);

  const root = mkdtempSync(resolve(tmpdir(), "morrow-origin-self-stamp-"));
  try {
    const packageBytes = Buffer.from('{"name":"morrow-test","version":"1.0.0"}\n');
    writeFileSync(resolve(root, "package.json"), packageBytes);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Morrow Test"], { cwd: root });
    execFileSync("git", ["add", "package.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const entry = {
      path: "package.json",
      sourceCommit,
      originalPath: "package.json",
      ownership: "new",
      dependencies: [],
      testMapping: [],
      reviewer: "codex-plan-convergence-review",
      beforeDigest: null,
      afterDigest: sha256(packageBytes),
    };
    writeFileSync(resolve(root, "ledger.json"), JSON.stringify({
      schema: "morrow.source-origin-ledger.v1",
      status: "reviewed",
      candidateCommit: sourceCommit,
      entries: [entry],
    }));
    const stamped = validateSourceOriginLedger({
      root,
      files: [{ path: "package.json", sha256: sha256(packageBytes), bytes: packageBytes.length }],
      commit: sourceCommit,
      ledgerPath: "ledger.json",
    });
    assert.equal(stamped.passed, false, "the generator's old reviewer name is not a completed review");
    assert.deepEqual(stamped.invalid, ["package.json"]);

    writeFileSync(resolve(root, "ledger.json"), JSON.stringify({
      schema: "morrow.source-origin-ledger.v1",
      status: "unreviewed",
      candidateCommit: sourceCommit,
      entries: [{ ...entry, reviewer: null }],
    }));
    const unreviewed = validateSourceOriginLedger({
      root,
      files: [{ path: "package.json", sha256: sha256(packageBytes), bytes: packageBytes.length }],
      commit: sourceCommit,
      ledgerPath: "ledger.json",
    });
    assert.equal(unreviewed.ledgerStatus, "unreviewed");
    assert.equal(unreviewed.passed, false);
    assert.deepEqual(unreviewed.invalid, []);
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
    const packageBytes = Buffer.from('{"name":"morrow-test","version":"7.4.3"}\n');
    writeFileSync(resolve(root, ".gitignore"), "artifacts/\noutput/\n");
    writeFileSync(resolve(root, "package.json"), packageBytes);
    writeFileSync(resolve(root, "config/release-profiles.json"), JSON.stringify({
      schema: "morrow.release-profiles.v2",
      profiles: {
        "private-full": {
          visibility: "private", include: ["package.json"], exclude: [],
          providers: {
            canvas: { authorizationReceipt: "canvas_authorization", liveProofReceipt: "canvas_live_proof" },
            moodle: { authorizationReceipt: "moodle_authorization", liveProofReceipt: "moodle_live_proof" },
            blackboard: { authorizationReceipt: "blackboard_authorization", liveProofExceptionReceipt: "blackboard_no_live_tenant_exception" },
          },
          externalEvidenceReceipts: ["client_parity"],
          promotionEvidenceReceipts: [...EXPECTED_PROMOTION_RECEIPTS],
        },
        "public-canvas": {
          visibility: "private", include: ["package.json"], exclude: [],
          providers: {
            canvas: { authorizationReceipt: "canvas_authorization", liveProofReceipt: "canvas_live_proof" },
            moodle: { authorizationReceipt: "moodle_authorization", liveProofReceipt: "moodle_live_proof" },
            blackboard: { authorizationReceipt: "blackboard_authorization", liveProofExceptionReceipt: "blackboard_no_live_tenant_exception" },
          },
          externalEvidenceReceipts: ["client_parity"],
          promotionEvidenceReceipts: [...EXPECTED_PROMOTION_RECEIPTS],
        },
      },
    }));
    const authorizationKey = generateKeyPairSync("ed25519");
    const authorizationKeyId = "release-test-key";
    writeFileSync(resolve(root, "config/release-evidence-policy.json"), JSON.stringify({
      schema: "morrow.release-evidence-policy.v1",
      receipts: Object.fromEntries([...EXPECTED_EXTERNAL_RECEIPTS, ...EXPECTED_PROMOTION_RECEIPTS]
        .map((id) => [id, { kind: AUTHORIZATION_RECEIPTS.has(id) ? "authorization" : "evidence" }])),
      trustedAuthorizationKeys: [{
        keyId: authorizationKeyId,
        algorithm: "ed25519",
        publicKeyPem: authorizationKey.publicKey.export({ type: "spki", format: "pem" }),
      }],
    }));
    writeFileSync(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"), JSON.stringify({
      catalogDigest: "e".repeat(64),
    }));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Morrow Test"], { cwd: root });
    execFileSync("git", ["add", ".gitignore", "package.json", "config/release-profiles.json", "config/release-evidence-policy.json"], { cwd: root });
    execFileSync("git", ["add", "-f", "artifacts/canvas-api/canvas-api-catalog.json"], { cwd: root });
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
        beforeDigest: null,
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
    assert.deepEqual(receipts.map((receipt) => receipt.version), ["7.4.3", "7.4.3"]);
    assert.ok(receipts.every((receipt) => receipt.candidateName.startsWith("morrow-v7.4.3-")));
    assert.ok(receipts.every((receipt) => receipt.packagePath.includes("morrow-v7.4.3-")));
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
    const proof = "ℹ tests 1\nℹ pass 1\nℹ fail 0\n";
    writeFileSync(log, proof);
    const evidence = [{ path: "proof.log", sha256: sha256(proof) }];
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

    const failedProof = "ℹ tests 1\nℹ pass 0\nℹ fail 1\n";
    writeFileSync(log, failedProof);
    const failedEvidence = [{ path: "proof.log", sha256: sha256(failedProof) }];
    writeFileSync(resolve(root, "artifacts/release/zero-tolerance-receipt.json"), JSON.stringify({
      schema: "morrow.zero-tolerance-receipt.v1", status: "passed", binding, evidenceRoot,
      checks: ZERO_TOLERANCE_TARGETS.map((id) => ({
        id, status: "passed", count: 0, evidence: failedEvidence,
        receiptDigest: sha256(JSON.stringify({ binding, id, evidenceDigests: failedEvidence })),
      })),
    }));
    assert.equal(zeroToleranceState(root).passed, false, "a log that does not show a pass does not count");
    writeFileSync(log, proof);
    writeFileSync(resolve(root, "artifacts/release/zero-tolerance-receipt.json"), JSON.stringify({
      schema: "morrow.zero-tolerance-receipt.v1", status: "passed", binding, evidenceRoot,
      checks: ZERO_TOLERANCE_TARGETS.map((id) => ({
        id, status: "passed", count: 0, evidence,
        receiptDigest: sha256(JSON.stringify({ binding, id, evidenceDigests: evidence })),
      })),
    }));
    const staleDigest = "f".repeat(64);
    const externalEvidenceRoot = "artifacts/release/evidence-external-test";
    mkdirSync(resolve(root, externalEvidenceRoot), { recursive: true });
    const writeExternalReceipts = (candidateDigests, mutate = (entry) => entry) => {
      const receipts = [...EXPECTED_EXTERNAL_RECEIPTS, ...EXPECTED_PROMOTION_RECEIPTS].map((id) => {
        const evidencePath = `${id}.json`;
        const evidenceBytes = stableJson({ schema: "morrow.test-evidence.v1", id, result: "verified", candidateDigests });
        writeFileSync(resolve(root, externalEvidenceRoot, evidencePath), evidenceBytes);
        const entry = {
          id,
          status: "verified",
          receiptDigest: sha256(evidenceBytes),
          evidence: { path: evidencePath, sha256: sha256(evidenceBytes) },
          verifier: "release-test",
          verifiedAt: "2026-09-05T00:00:00.000Z",
          commit: binding.commit,
          catalogDigest: binding.catalogDigest,
          candidateDigests,
        };
        entry.signature = {
          algorithm: "ed25519",
          keyId: authorizationKeyId,
          value: sign(null, Buffer.from(stableJson(externalReceiptClaim(entry))), authorizationKey.privateKey).toString("base64"),
        };
        return mutate(entry);
      });
      writeFileSync(resolve(root, "artifacts/release/external-receipts.json"), JSON.stringify({
        schema: "morrow.external-receipts.v2",
        evidenceRoot: externalEvidenceRoot,
        receipts,
      }));
    };
    writeExternalReceipts(expected);
    const catalogPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
    const catalogBytes = readFileSync(catalogPath);
    writeFileSync(catalogPath, JSON.stringify({ catalogDigest: "f".repeat(64) }));
    const frozenCatalogBinding = stageCandidate({ root, profileName: "private-full", verifyRebuild: false });
    assert.equal(frozenCatalogBinding.externalReceipts.binding.catalogDigest, "e".repeat(64));
    assert.equal(frozenCatalogBinding.externalReceipts.passed, true,
      "ignored working-tree catalog bytes cannot select the evidence identity for a HEAD candidate");
    writeFileSync(catalogPath, catalogBytes);

    const validReceiptPath = resolve(root, "artifacts/candidates/private-full/receipt.json");
    const validReceipt = readFileSync(validReceiptPath);
    const unrelatedArchive = resolve(root, externalEvidenceRoot, "unrelated.zip");
    writeFileSync(unrelatedArchive, "not the deterministic candidate archive\n");
    const redirectedReceipt = JSON.parse(validReceipt.toString("utf8"));
    redirectedReceipt.packagePath = relative(root, unrelatedArchive);
    redirectedReceipt.packageDigest = sha256(readFileSync(unrelatedArchive));
    redirectedReceipt.packageBytes = readFileSync(unrelatedArchive).length;
    writeFileSync(validReceiptPath, JSON.stringify(redirectedReceipt));
    const redirectedScan = scanStagedCandidate({ root, profileName: "private-full" });
    assert.equal(redirectedScan.receiptMatches, false);
    assert.equal(redirectedScan.passed, false, "a receipt cannot redirect the scan to unrelated bytes");
    writeFileSync(validReceiptPath, validReceipt);

    if (process.platform !== "win32") {
      const stagedPackage = resolve(root, "artifacts/candidates/private-full/stage/package.json");
      const stagedPackageBytes = readFileSync(stagedPackage);
      const stagedPackageTarget = resolve(root, externalEvidenceRoot, "staged-package.json");
      writeFileSync(stagedPackageTarget, stagedPackageBytes);
      unlinkSync(stagedPackage);
      symlinkSync(stagedPackageTarget, stagedPackage);
      assert.throws(() => scanStagedCandidate({ root, profileName: "private-full" }), /not a bounded regular file/,
        "candidate admission cannot follow a replacement link even when its target has the expected bytes");
      unlinkSync(stagedPackage);
      writeFileSync(stagedPackage, stagedPackageBytes);
    }

    const rogueKey = generateKeyPairSync("ed25519");
    const roguePolicy = resolve(root, "artifacts/release/rogue-evidence-policy.json");
    writeFileSync(roguePolicy, JSON.stringify({
      schema: "morrow.release-evidence-policy.v1",
      receipts: { publication_authorization: { kind: "authorization" } },
      trustedAuthorizationKeys: [{
        keyId: "rogue-key",
        algorithm: "ed25519",
        publicKeyPem: rogueKey.publicKey.export({ type: "spki", format: "pem" }),
      }],
    }));
    writeExternalReceipts(expected, (entry) => entry.id === "publication_authorization"
      ? {
        ...entry,
        signature: {
          algorithm: "ed25519",
          keyId: "rogue-key",
          value: sign(null, Buffer.from(stableJson(externalReceiptClaim(entry))), rogueKey.privateKey).toString("base64"),
        },
      }
      : entry);
    process.env.MORROW_RELEASE_EVIDENCE_POLICY_PATH = roguePolicy;
    try {
      assert.equal(stageCandidate({ root, profileName: "private-full", verifyRebuild: true }).promotionReceipts.passed, false,
        "an environment path cannot replace the tracked authorization trust root");
    } finally {
      delete process.env.MORROW_RELEASE_EVIDENCE_POLICY_PATH;
    }
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
    const windowsNotRun = stageCandidate({ root, profileName: "private-full", verifyRebuild: false });
    assert.equal(windowsNotRun.browserHarness.harnesses.find((entry) => entry.id === "desktop_windows_smoke").status, "not-run-on-this-host");
    assert.equal(windowsNotRun.browserHarness.passed, false);
    assert.equal(windowsNotRun.promotable, false);
    assert.ok(windowsNotRun.blockingReasons.includes("browser_harness_not_passed:desktop_windows_smoke"));

    writeBrowserHarnessProof(root, { commit: receipts[0].commit, tree: receipts[0].tree, results: promotionResults() });
    const withBrowserProof = stageCandidate({ root, profileName: "private-full", verifyRebuild: true });
    assert.equal(withBrowserProof.browserHarness.passed, true);
    assert.deepEqual(withBrowserProof.blockingReasons, []);
    assert.equal(withBrowserProof.promotable, true);
    assert.equal(withBrowserProof.stablePromotionReady, true);
    const zeroPath = resolve(root, "artifacts/release/zero-tolerance-receipt.json");
    const browserPath = resolve(root, BROWSER_HARNESS_RECEIPT_PATH);
    const outside = mkdtempSync(resolve(tmpdir(), "morrow-redirected-receipts-"));
    writeFileSync(resolve(outside, "zero-tolerance-receipt.json"), readFileSync(zeroPath));
    writeFileSync(resolve(outside, "receipt.json"), readFileSync(browserPath));
    for (const name of readdirSync(dirname(browserPath))) {
      if (name.endsWith(".log")) writeFileSync(resolve(outside, name), readFileSync(resolve(dirname(browserPath), name)));
    }
    rmSync(zeroPath);
    writeBrowserHarnessProof(root, { commit: receipts[0].commit, tree: receipts[0].tree });
    process.env.MORROW_ZERO_TOLERANCE_RECEIPT_PATH = resolve(outside, "zero-tolerance-receipt.json");
    process.env.MORROW_BROWSER_HARNESS_RECEIPT_PATH = resolve(outside, "receipt.json");
    try {
      const redirected = stageCandidate({ root, profileName: "private-full", verifyRebuild: false });
      assert.equal(redirected.zeroTolerance.passed, false, "a redirected zero-tolerance receipt does not count");
      assert.equal(redirected.browserHarness.passed, false, "a redirected browser receipt does not count");
      assert.equal(conformanceReport({ root, profileName: "private-full" }).checks
        .find((entry) => entry.id === "current_browser_harness_evidence").passed, false);
    } finally {
      delete process.env.MORROW_ZERO_TOLERANCE_RECEIPT_PATH;
      delete process.env.MORROW_BROWSER_HARNESS_RECEIPT_PATH;
      writeFileSync(zeroPath, readFileSync(resolve(outside, "zero-tolerance-receipt.json")));
      writeBrowserHarnessProof(root, { commit: receipts[0].commit, tree: receipts[0].tree, results: promotionResults() });
    }
    assert.deepEqual(withBrowserProof.deterministicRebuild, {
      verified: true,
      digest: withBrowserProof.packageDigest,
      commit: withBrowserProof.commit,
      tree: withBrowserProof.tree,
      profile: "private-full",
      isolation: "fresh_git_checkout_and_process",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    });
    for (const missingId of EXPECTED_EXTERNAL_RECEIPTS) {
      const externalPath = resolve(root, "artifacts/release/external-receipts.json");
      const withoutOne = JSON.parse(readFileSync(externalPath, "utf8"));
      withoutOne.receipts = withoutOne.receipts.filter((entry) => entry.id !== missingId);
      writeFileSync(externalPath, JSON.stringify(withoutOne));
      const missing = stageCandidate({ root, profileName: "private-full", verifyRebuild: false });
      assert.equal(missing.externalReceipts.receipts.find((entry) => entry.id === missingId)?.blocking, true,
        `${missingId} must independently block the selected provider profile`);
      writeExternalReceipts(expected);
    }
    assert.equal(conformanceReport({ root, profileName: "private-full" }).checks
      .find((entry) => entry.id === "external_live_receipts").passed, true);
    writeFileSync(resolve(root, externalEvidenceRoot, "client_parity.json"), "withdrawn\n");
    assert.equal(conformanceReport({ root, profileName: "private-full" }).checks
      .find((entry) => entry.id === "external_live_receipts").passed, false,
    "final conformance must reload current evidence instead of trusting the candidate receipt");
    writeExternalReceipts(expected);
    const diagnosticOnly = stageCandidate({ root, profileName: "private-full", verifyRebuild: false });
    assert.equal(diagnosticOnly.promotable, false);
    assert.equal(diagnosticOnly.stablePromotionReady, false);
    assert.ok(diagnosticOnly.blockingReasons.includes("deterministic_rebuild_missing"));

    writeExternalReceipts(expected, (entry) => entry.id === "canvas_live_proof"
      ? { ...entry, signature: undefined }
      : entry);
    assert.equal(stageCandidate({ root, profileName: "private-full", verifyRebuild: false }).externalReceipts.passed, false,
      "a self-written evidence file whose hash matches is not verification");
    writeExternalReceipts(expected, (entry) => entry.id === "client_parity"
      ? { ...entry, receiptDigest: "d".repeat(64), evidence: { ...entry.evidence, sha256: "d".repeat(64) } }
      : entry);
    assert.equal(stageCandidate({ root, profileName: "private-full", verifyRebuild: true }).externalReceipts.passed, false,
      "a digest that resolves to no retained evidence bytes must fail");
    writeExternalReceipts(expected, (entry) => entry.id === "publication_authorization"
      ? { ...entry, signature: { ...entry.signature, keyId: "unknown-key" } }
      : entry);
    assert.equal(stageCandidate({ root, profileName: "private-full", verifyRebuild: true }).promotionReceipts.passed, false,
      "an authorization from an untrusted signer must fail");
    writeExternalReceipts(expected);
    writeFileSync(resolve(root, externalEvidenceRoot, "canvas_authorization.json"), "changed after authorization\n");
    assert.equal(stageCandidate({ root, profileName: "private-full", verifyRebuild: true }).externalReceipts.passed, false,
      "authorization evidence changed after signing must fail");
    writeExternalReceipts(expected);

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

    const profilePath = resolve(root, "config/release-profiles.json");
    const frozenProfiles = readFileSync(profilePath);
    const changedProfiles = JSON.parse(frozenProfiles.toString("utf8"));
    changedProfiles.profiles["private-full"].include = ["*"];
    writeFileSync(profilePath, JSON.stringify(changedProfiles));
    assert.throws(() => stageCandidate({ root, profileName: "private-full" }), /must match HEAD/,
      "uncommitted profile rules cannot choose bytes while the receipt still names HEAD");
    writeFileSync(profilePath, frozenProfiles);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pnpm test:browser runs the harnesses pnpm check cannot, and names the rest", () => {
  const rootPackage = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"));
  assert.equal(rootPackage.scripts["test:browser"], "pnpm build && node scripts/run-browser-harnesses.mjs");
  assert.equal(rootPackage.scripts["test:browser:attended"], "pnpm build && node scripts/run-browser-harnesses.mjs --attended");
  assert.deepEqual(rootPackage.scripts["scripts:test"].split(" && "), [
    "node --test --test-concurrency=2 scripts/test/*.test.mjs",
    "node --test connector/extension-test/versioning.test.mjs",
  ], "the always-on gate runs its test-file glob and the registered Store-update regression");
  assert.doesNotMatch(rootPackage.scripts["scripts:test"], /run-browser-harnesses\.mjs/,
    "browser harnesses need their own command");

  assert.deepEqual(HARNESSES.map((harness) => harness.id), [...BROWSER_HARNESS_IDS],
    "the runner and the release gate must name the same harnesses");
  for (const harness of HARNESSES) {
    assert.equal(existsSync(resolve(import.meta.dirname, "../..", harness.script)), true, `${harness.script} must exist`);
    assert.ok(!rootPackage.scripts["scripts:test"].includes(harness.script), `${harness.id} must stay outside the always-on gate`);
    assert.match(harness.summary, /\S/);
  }

  const unattended = planHarnesses({ attended: false });
  assert.deepEqual(unattended.filter((planned) => planned.run).map((planned) => planned.harness.id),
    ["canvas_connector_browser", "account_access_browser", "bridge_recovery_first_use", "bridge_maintenance_cft", "installer_renderer_layout", "desktop_first_use"]);
  assert.deepEqual(HARNESS_BY_ID.get("account_access_browser")?.args, ["--account-access-only"]);
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

  writeBrowserHarnessProof(root, { commit, tree, results: promotionResults() });
  const accepted = browserHarnessState(root, binding);
  assert.equal(accepted.boundToHead, true);
  assert.equal(accepted.passed, true);
  assert.deepEqual(accepted.harnesses.filter((entry) => REQUIRED_BROWSER_HARNESS_PASSES.includes(entry.id)).map((entry) => entry.status),
    REQUIRED_BROWSER_HARNESS_PASSES.map(() => "passed"));
  assert.equal(accepted.harnesses.find((entry) => entry.id === "desktop_windows_smoke").status, "passed");

  writeBrowserHarnessProof(root, { commit, tree });
  const windowsRecordedNotRun = browserHarnessState(root, binding);
  assert.equal(windowsRecordedNotRun.harnesses.find((entry) => entry.id === "desktop_windows_smoke").status, "not-run-on-this-host");
  assert.equal(windowsRecordedNotRun.harnesses.find((entry) => entry.id === "desktop_windows_smoke").blocking, true);
  assert.equal(windowsRecordedNotRun.passed, false, "not-run-on-this-host does not satisfy the Windows smoke");
  writeBrowserHarnessProof(root, { commit, tree, results: promotionResults() });

  const logPath = resolve(root, dirname(BROWSER_HARNESS_RECEIPT_PATH), "canvas_connector_browser.log");
  const recorded = readFileSync(logPath);
  writeFileSync(logPath, "a different run\n");
  const edited = browserHarnessState(root, binding);
  assert.equal(edited.harnesses.find((entry) => entry.id === "canvas_connector_browser").status, "missing");
  assert.equal(edited.passed, false);
  writeFileSync(logPath, recorded);
  assert.equal(browserHarnessState(root, binding).passed, true);

  const claimed = JSON.parse(readFileSync(resolve(root, BROWSER_HARNESS_RECEIPT_PATH), "utf8"));
  const neutral = "suite ended without a passing summary\n";
  const canvas = claimed.harnesses.find((entry) => entry.id === "canvas_connector_browser");
  canvas.logBytes = Buffer.byteLength(neutral);
  canvas.logSha256 = sha256(neutral);
  canvas.status = "passed";
  writeFileSync(logPath, neutral);
  writeFileSync(resolve(root, BROWSER_HARNESS_RECEIPT_PATH), `${JSON.stringify(claimed, null, 2)}\n`);
  assert.equal(browserHarnessState(root, binding).harnesses.find((entry) => entry.id === "canvas_connector_browser").status, "missing");
  assert.equal(browserHarnessState(root, binding).passed, false, "a harness log that does not show a pass does not count");
  writeBrowserHarnessProof(root, { commit, tree, results: promotionResults() });

  const receiptPath = resolve(root, BROWSER_HARNESS_RECEIPT_PATH);
  const truncated = JSON.parse(readFileSync(receiptPath, "utf8"));
  truncated.harnesses.find((entry) => entry.id === "canvas_connector_browser").logTruncated = true;
  writeFileSync(receiptPath, `${JSON.stringify(truncated, null, 2)}\n`);
  assert.equal(browserHarnessState(root, binding).passed, false, "truncated evidence cannot be promoted by relabeling its result");

  writeBrowserHarnessProof(root, { commit, tree });
  const wrongLength = JSON.parse(readFileSync(receiptPath, "utf8"));
  wrongLength.harnesses.find((entry) => entry.id === "canvas_connector_browser").logBytes += 1;
  writeFileSync(receiptPath, `${JSON.stringify(wrongLength, null, 2)}\n`);
  assert.equal(browserHarnessState(root, binding).passed, false, "the receipt must bind the exact retained evidence length");

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
    ["canvas_file_optional_permission", "desktop_windows_smoke"]);

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
  assert.equal(windowsNotRunElsewhere.passed, false);
  assert.equal(windowsNotRunElsewhere.harnesses.find((entry) => entry.id === "desktop_windows_smoke").status, "not-run-on-this-host");
  assert.equal(windowsNotRunElsewhere.harnesses.find((entry) => entry.id === "desktop_windows_smoke").required, true);
  assert.equal(stateOf(promotionResults()).passed, true);
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
  assert.equal(completed.logBytes, log.byteLength);
  assert.equal(completed.logTruncated, false);
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

  const excessive = await runHarness(
    { id: "fixture_excessive_output", script: script("process.stdout.write(Buffer.alloc(8192, 97));"), timeoutMs: 30_000 },
    { logPath: resolve(directory, "fixture_excessive_output.log"), maxLogBytes: 4_096 },
  );
  const boundedLog = readFileSync(resolve(directory, "fixture_excessive_output.log"));
  assert.equal(excessive.status, "failed", "truncated browser evidence cannot be recorded as a passing run");
  assert.equal(excessive.logTruncated, true);
  assert.equal(excessive.logBytes, 4_096);
  assert.equal(boundedLog.byteLength, 4_096);
  assert.equal(excessive.logSha256, sha256(boundedLog));
});

test("package commands fail when the candidate is not promotable, and an explicit scan does not", () => {
  const root = mkdtempSync(resolve(tmpdir(), "morrow-package-promotable-"));
  try {
    mkdirSync(resolve(root, "config"), { recursive: true });
    const packageBytes = Buffer.from('{"name":"morrow-test","version":"1.0.0"}\n');
    writeFileSync(resolve(root, ".gitignore"), "artifacts/\noutput/\n");
    writeFileSync(resolve(root, "package.json"), packageBytes);
    writeFileSync(resolve(root, "config/release-profiles.json"), JSON.stringify({
      schema: "morrow.release-profiles.v2",
      profiles: {
        "private-full": {
          visibility: "private",
          include: ["package.json"],
          exclude: [],
          providers: {},
          externalEvidenceReceipts: [],
          promotionEvidenceReceipts: [],
        },
      },
    }));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Morrow Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
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
        testMapping: [],
        reviewer: "release-review",
        beforeDigest: null,
        afterDigest: sha256(packageBytes),
      }],
    }));
    execFileSync("git", ["add", "config/source-origin-ledger.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "ledger"], { cwd: root });

    const script = resolve(import.meta.dirname, "../package-profile.mjs");
    const packaged = spawnSync(process.execPath, [script, "--profile", "private-full", "--root", root], { encoding: "utf8" });
    assert.equal(packaged.status, 1, packaged.stderr);
    const receipt = JSON.parse(packaged.stdout);
    assert.equal(receipt.promotable, false);
    assert.ok(receipt.blockingReasons.length > 0);
    assert.equal(receipt.candidateBuilt, true);

    const scanned = spawnSync(process.execPath, [script, "--profile", "private-full", "--root", root, "--scan"], { encoding: "utf8" });
    assert.equal(scanned.status, 0, scanned.stderr);
    assert.equal(JSON.parse(scanned.stdout).passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
