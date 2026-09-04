import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const RELEASE_VERSION = "1.0.0-rc.0";
export const REQUIRED_EXTERNAL_RECEIPTS = Object.freeze([
  "authorized_live_canvas",
  "client_parity",
]);
export const REQUIRED_PROMOTION_RECEIPTS = Object.freeze([
  "independent_clean_machine",
  "publication_authorization",
]);
export const ZERO_TOLERANCE_TARGETS = Object.freeze([
  "unapproved_provider_writes",
  "out_of_scope_targets_accepted",
  "duplicate_writes_after_ambiguous_delivery",
  "verified_results_with_unmet_postconditions",
  "unknown_effects_displayed_as_success",
  "stale_approvals_accepted",
  "catalog_rows_without_disposition",
  "held_provider_rows_enabled",
  "credentials_or_covered_identity_in_protected_output",
  "private_marker_in_public_candidate",
  "required_weekend_proof_silently_skipped",
]);

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, "../..");
const DOS_TIME = ((0 << 11) | (0 << 5) | 0) >>> 0;
const DOS_DATE = (((2020 - 1980) << 9) | (1 << 5) | 1) >>> 0;

function git(root, args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, stableJson(value), { mode: 0o600 });
}

function trackedFiles(root) {
  return git(root, ["ls-tree", "-r", "--name-only", "HEAD"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

function trackedBuffer(root, path) {
  return execFileSync("git", ["-C", root, "show", `HEAD:${path}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function profileRuleMatches(path, rule) {
  if (rule === "*") return true;
  if (rule.endsWith("*/test/")) {
    const prefix = rule.slice(0, -7);
    return path.startsWith(prefix) && /\/test\//.test(path.slice(prefix.length));
  }
  return rule === path || (rule.endsWith("/") && path.startsWith(rule));
}

function profileIncludes(path, profile) {
  return profile.include.some((rule) => profileRuleMatches(path, rule))
    && !(profile.exclude || []).some((rule) => profileRuleMatches(path, rule));
}

export function loadReleaseProfiles(root = DEFAULT_ROOT) {
  const value = readJson(resolve(root, "config/release-profiles.json"));
  if (value.schema !== "morrow.release-profiles.v1" || value.candidateVersion !== RELEASE_VERSION) {
    throw new Error("Release profile configuration has an unsupported schema or candidate version.");
  }
  return value;
}

function loadProfile(root, profileName) {
  const profiles = loadReleaseProfiles(root);
  const profile = profiles.profiles?.[profileName];
  if (!profile || !Array.isArray(profile.include) || !["private", "public"].includes(profile.visibility)) {
    throw new Error(`Unknown or invalid release profile: ${profileName}`);
  }
  return profile;
}

function assertOutputPath(root, output) {
  const allowed = resolve(root, "artifacts/candidates");
  const candidate = resolve(output);
  if (candidate === allowed || !candidate.startsWith(`${allowed}${sep}`)) {
    throw new Error("Candidate output must be a child of artifacts/candidates.");
  }
  return candidate;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function deterministicZip(entries) {
  let offset = 0;
  const local = [];
  const central = [];
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralData, end]);
}

export function buildCycloneDxSbom({ candidateName, sourceFiles, version = RELEASE_VERSION }) {
  const manifests = sourceFiles
    .filter((file) => file.path === "package.json" || /^packages\/[^/]+\/package\.json$/.test(file.path))
    .map((file) => ({ path: file.path, packageJson: JSON.parse(Buffer.from(file.data).toString("utf8")) }));
  const workspaceNames = new Set(manifests.map(({ packageJson }) => packageJson.name));
  const externalVersions = new Map();
  for (const { packageJson } of manifests) {
    for (const [name, range] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
      if (!workspaceNames.has(name)) externalVersions.set(name, String(range));
    }
  }
  const components = [
    ...manifests.map(({ path, packageJson }) => ({
      type: "library",
      name: packageJson.name,
      version: packageJson.version,
      "bom-ref": `pkg:npm/${encodeURIComponent(packageJson.name)}@${packageJson.version}`,
      properties: [{ name: "morrow:source-path", value: path }],
    })),
    ...[...externalVersions].map(([name, versionRange]) => ({
      type: "library",
      name,
      version: versionRange,
      "bom-ref": `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(versionRange)}`,
      properties: [{ name: "morrow:version-source", value: "manifest range; pnpm lockfile included" }],
    })),
  ]
    .sort((left, right) => left.name.localeCompare(right.name));
  const dependencies = manifests.map(({ packageJson }) => ({
    ref: `pkg:npm/${encodeURIComponent(packageJson.name)}@${packageJson.version}`,
    dependsOn: Object.entries(packageJson.dependencies || {}).map(([name, range]) => workspaceNames.has(name)
      ? `pkg:npm/${encodeURIComponent(name)}@${manifests.find((entry) => entry.packageJson.name === name)?.packageJson.version}`
      : `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(String(range))}`).sort(),
  })).sort((left, right) => left.ref.localeCompare(right.ref));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: candidateName,
        version,
      },
    },
    components,
    dependencies,
  };
}

function checksumManifest(entries) {
  return `${[...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${sha256(entry.data)}  ${entry.path}`)
    .join("\n")}\n`;
}

function validDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function validateSourceOriginLedger({ root = DEFAULT_ROOT, files, commit }) {
  const ledgerPath = resolve(root, "config/source-origin-ledger.json");
  if (!existsSync(ledgerPath)) {
    return { schema: "morrow.source-origin-validation.v1", passed: false, reason: "ledger_missing", missing: files };
  }
  let ledger;
  try {
    ledger = JSON.parse(Buffer.from(trackedBuffer(root, "config/source-origin-ledger.json")).toString("utf8"));
  } catch {
    ledger = readJson(ledgerPath);
  }
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const missing = [];
  const invalid = [];
  for (const file of files) {
    const entry = byPath.get(file.path);
    if (!entry) {
      missing.push(file.path);
      continue;
    }
    const valid = typeof entry.sourceCommit === "string" && /^[0-9a-f]{40,64}$/i.test(entry.sourceCommit)
      && typeof entry.originalPath === "string" && entry.originalPath.length > 0
      && ["new", "adapted", "generated"].includes(entry.ownership)
      && Array.isArray(entry.dependencies)
      && Array.isArray(entry.testMapping)
      && typeof entry.reviewer === "string" && entry.reviewer.trim().length > 0
      && validDigest(entry.beforeDigest)
      && entry.afterDigest === file.sha256;
    if (!valid) invalid.push(file.path);
  }
  const unexpected = entries
    .map((entry) => entry.path)
    .filter((path) => !files.some((file) => file.path === path))
    .sort();
  let candidateCommitMatches = ledger.candidateCommit === commit;
  if (!candidateCommitMatches && existsSync(resolve(root, ".git")) && typeof ledger.candidateCommit === "string" && /^[0-9a-f]{40,64}$/i.test(ledger.candidateCommit)) {
    try {
      git(root, ["merge-base", "--is-ancestor", ledger.candidateCommit, commit]);
      const changed = git(root, ["diff", "--name-only", `${ledger.candidateCommit}..${commit}`, "--", ...files.map((file) => file.path)])
        .trim();
      candidateCommitMatches = changed === "";
    } catch {
      candidateCommitMatches = false;
    }
  }
  const reviewed = ledger.status === "reviewed" && candidateCommitMatches;
  return {
    schema: "morrow.source-origin-validation.v1",
    ledgerPath: relative(root, ledgerPath),
    ledgerStatus: ledger.status || "unknown",
    candidateCommit: ledger.candidateCommit || null,
    candidateCommitMatches,
    passed: reviewed && missing.length === 0 && invalid.length === 0 && unexpected.length === 0,
    missing,
    invalid,
    unexpected,
  };
}

function sourceRightsState(root, files, visibility) {
  if (visibility !== "public") {
    return { schema: "morrow.source-rights-validation.v1", required: false, passed: true, missing: [], invalid: [] };
  }
  const path = resolve(root, "config/source-rights.manifest.json");
  const manifest = existsSync(path) ? readJson(path) : { files: [] };
  const records = new Map((Array.isArray(manifest.files) ? manifest.files : []).map((entry) => [entry.path, entry]));
  const allowed = new Set(["direct_owned", "adapted_owned", "clean_reimplementation"]);
  const missing = [];
  const invalid = [];
  for (const file of files) {
    const entry = records.get(file.path);
    if (!entry) {
      missing.push(file.path);
      continue;
    }
    if (!allowed.has(entry.disposition) || entry.sha256 !== file.sha256 || typeof entry.review !== "string" || !entry.review.trim()) {
      invalid.push(file.path);
    }
  }
  return {
    schema: "morrow.source-rights-validation.v1",
    required: true,
    manifestPath: relative(root, path),
    passed: manifest.schema === "morrow.source-rights.v1" && missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
}

const PUBLIC_MARKERS = Object.freeze([
  { id: "private_example-kit_marker", expression: /(?:\bexample-kit\b|example-kit[_-]|example-attestation-repo|example-lms-vps)/i },
  { id: "absolute_user_path", expression: /\/(?:Users|home)\/[^/\s]+/ },
  { id: "private_key", expression: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/ },
  { id: "secret_literal", expression: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}/ },
]);
const PRIVATE_MARKERS = Object.freeze([
  { id: "private_key", expression: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]{32,}-----END(?: [A-Z]+)? PRIVATE KEY-----/ },
  { id: "secret_literal", expression: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}/ },
]);

export function scanCandidateEntries(entries, visibility) {
  const markers = visibility === "public" ? PUBLIC_MARKERS : PRIVATE_MARKERS;
  const violations = [];
  for (const entry of entries) {
    const text = Buffer.from(entry.data).toString("utf8");
    for (const marker of markers) {
      if (marker.expression.test(text)) violations.push({ path: entry.path, marker: marker.id });
    }
  }
  return {
    schema: "morrow.candidate-marker-scan.v1",
    visibility,
    scannedFileCount: entries.length,
    scannedExtensions: [".js", ".json", ".map", ".md", ".mjs", ".ts", ".txt"],
    passed: violations.length === 0,
    violations,
  };
}

function externalReceiptSet(root, ids) {
  const path = process.env.MORROW_EXTERNAL_RECEIPTS_PATH
    ? resolve(process.env.MORROW_EXTERNAL_RECEIPTS_PATH)
    : resolve(root, "artifacts/release/external-receipts.json");
  const supplied = existsSync(path) ? readJson(path) : { receipts: [] };
  const byId = new Map((Array.isArray(supplied.receipts) ? supplied.receipts : []).map((entry) => [entry.id, entry]));
  const receipts = ids.map((id) => {
    const entry = byId.get(id);
    const verified = entry?.status === "verified"
      && validDigest(entry.receiptDigest)
      && typeof entry.verifier === "string"
      && typeof entry.verifiedAt === "string";
    return {
      id,
      status: verified ? "verified" : "missing",
      blocking: !verified,
      ...(verified ? { receiptDigest: entry.receiptDigest } : {}),
    };
  });
  return { path: existsSync(path) ? path : null, receipts, passed: receipts.every((entry) => !entry.blocking) };
}

function externalReceiptState(root) {
  return externalReceiptSet(root, REQUIRED_EXTERNAL_RECEIPTS);
}

function promotionReceiptState(root) {
  return externalReceiptSet(root, REQUIRED_PROMOTION_RECEIPTS);
}

function zeroToleranceState(root) {
  const path = process.env.MORROW_ZERO_TOLERANCE_RECEIPT_PATH
    ? resolve(process.env.MORROW_ZERO_TOLERANCE_RECEIPT_PATH)
    : resolve(root, "artifacts/release/zero-tolerance-receipt.json");
  const supplied = existsSync(path) ? readJson(path) : { checks: [] };
  const byId = new Map((Array.isArray(supplied.checks) ? supplied.checks : []).map((entry) => [entry.id, entry]));
  const checks = ZERO_TOLERANCE_TARGETS.map((id) => {
    const entry = byId.get(id);
    const passed = entry?.status === "passed" && entry.count === 0 && validDigest(entry.receiptDigest);
    return { id, status: passed ? "passed" : "missing", count: passed ? 0 : null, blocking: !passed };
  });
  return { path: existsSync(path) ? path : null, checks, passed: checks.every((entry) => !entry.blocking) };
}

export function validateAppendixCPathMap(root = DEFAULT_ROOT) {
  const path = resolve(root, "config/appendix-c-path-map.json");
  if (!existsSync(path)) return { passed: false, reason: "appendix_c_path_map_missing" };
  const value = readJson(path);
  const mappings = Array.isArray(value.mappings) ? value.mappings : [];
  const seen = new Set();
  const invalid = [];
  for (const mapping of mappings) {
    if (typeof mapping.plannedPath !== "string" || seen.has(mapping.plannedPath)) {
      invalid.push(String(mapping.plannedPath));
      continue;
    }
    seen.add(mapping.plannedPath);
    if (!Array.isArray(mapping.actualPaths) || typeof mapping.status !== "string") invalid.push(mapping.plannedPath);
    for (const actualPath of mapping.actualPaths || []) {
      if (!existsSync(resolve(root, actualPath))) invalid.push(`${mapping.plannedPath}:${actualPath}`);
    }
  }
  return {
    schema: "morrow.appendix-c-path-map-validation.v1",
    passed: value.schema === "morrow.appendix-c-path-map.v1"
      && value.status === "ratified-for-current-gateway-architecture"
      && mappings.length === 33
      && mappings.every((mapping) => !["not-implemented", "owned-by-donor"].includes(mapping.status))
      && invalid.length === 0,
    mappingCount: mappings.length,
    invalid,
  };
}

function candidateDirectory(root, profile) {
  return resolve(root, "artifacts/candidates", profile);
}

function candidateName(profile) {
  return `morrow-v${RELEASE_VERSION}-${process.platform}-${process.arch}-${profile}`;
}

export function stageCandidate({ root = DEFAULT_ROOT, profileName = "private-full", verifyRebuild = false }) {
  const profile = loadProfile(root, profileName);
  const output = assertOutputPath(root, candidateDirectory(root, profileName));
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const sourceFiles = trackedFiles(root)
    .filter((path) => profileIncludes(path, profile))
    .map((path) => ({ path, data: trackedBuffer(root, path) }));
  const files = sourceFiles.map((file) => ({ path: file.path, bytes: file.data.length, sha256: sha256(file.data) }));
  const sourceOrigin = validateSourceOriginLedger({ root, files, commit });
  const sourceRights = sourceRightsState(root, files, profile.visibility);
  const markerScan = scanCandidateEntries(sourceFiles, profile.visibility);
  const externalReceipts = externalReceiptState(root);
  const promotionReceipts = promotionReceiptState(root);
  const zeroTolerance = zeroToleranceState(root);
  const stageManifest = {
    schema: "morrow.candidate-stage.v1",
    candidateName: candidateName(profileName),
    version: RELEASE_VERSION,
    profile: profileName,
    visibility: profile.visibility,
    commit,
    tree,
    sourceFiles: files,
    sourceFilesDigest: sha256(stableJson(files)),
    sourceOrigin,
    sourceRights,
    markerScan,
    localEvidenceOnly: true,
  };

  rmSync(output, { recursive: true, force: true });
  const stageRoot = resolve(output, "stage");
  for (const file of sourceFiles) {
    const target = resolve(stageRoot, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, file.data, { mode: 0o600 });
  }
  const sbomData = Buffer.from(stableJson(buildCycloneDxSbom({
    candidateName: candidateName(profileName),
    sourceFiles,
  })));
  const checksumData = Buffer.from(checksumManifest([
    ...sourceFiles,
    { path: "release/sbom.cdx.json", data: sbomData },
  ]));
  const completedStageManifest = {
    ...stageManifest,
    sbom: { path: "release/sbom.cdx.json", sha256: sha256(sbomData) },
    checksums: { path: "release/checksums.sha256", sha256: sha256(checksumData) },
  };
  const stageManifestData = Buffer.from(stableJson(completedStageManifest));
  const stageManifestPath = resolve(stageRoot, "release/stage-manifest.json");
  mkdirSync(dirname(stageManifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(stageManifestPath, stageManifestData, { mode: 0o600 });
  writeFileSync(resolve(stageRoot, "release/sbom.cdx.json"), sbomData, { mode: 0o600 });
  writeFileSync(resolve(stageRoot, "release/checksums.sha256"), checksumData, { mode: 0o600 });

  const archiveEntries = [
    ...sourceFiles,
    { path: "release/checksums.sha256", data: checksumData },
    { path: "release/sbom.cdx.json", data: sbomData },
    { path: "release/stage-manifest.json", data: stageManifestData },
  ];
  const archive = deterministicZip(archiveEntries);
  const archiveDigest = sha256(archive);
  const archivePath = resolve(output, `${candidateName(profileName)}.zip`);
  writeFileSync(archivePath, archive, { mode: 0o600 });
  const rebuilt = verifyRebuild ? deterministicZip(archiveEntries) : null;
  if (rebuilt && !rebuilt.equals(archive)) throw new Error("Deterministic rebuild proof failed.");

  const blockers = [
    ...(markerScan.passed ? [] : ["candidate_marker_scan_failed"]),
    ...(sourceOrigin.passed ? [] : ["source_origin_ledger_incomplete"]),
    ...(sourceRights.passed ? [] : ["source_rights_manifest_incomplete"]),
    ...externalReceipts.receipts.filter((entry) => entry.blocking).map((entry) => `external_receipt_missing:${entry.id}`),
    ...zeroTolerance.checks.filter((entry) => entry.blocking).map((entry) => `zero_tolerance_evidence_missing:${entry.id}`),
  ].sort();
  const receipt = {
    schema: "morrow.release-receipt.v1",
    candidateName: candidateName(profileName),
    version: RELEASE_VERSION,
    profile: profileName,
    packagePath: relative(root, archivePath),
    packageDigest: archiveDigest,
    packageBytes: archive.length,
    commit,
    tree,
    stageManifestDigest: sha256(stageManifestData),
    sbomDigest: sha256(sbomData),
    checksumsDigest: sha256(checksumData),
    deterministicRebuild: verifyRebuild ? { verified: true, digest: sha256(rebuilt) } : { verified: false },
    sourceOrigin,
    sourceRights,
    markerScan,
    externalReceipts,
    promotionReceipts,
    zeroTolerance,
    localEvidenceOnly: true,
    promotable: blockers.length === 0,
    stablePromotionReady: blockers.length === 0 && promotionReceipts.passed,
    blockingReasons: blockers,
  };
  writeJson(resolve(output, "receipt.json"), receipt);
  return receipt;
}

export function readCandidateReceipt(root = DEFAULT_ROOT, profileName = "private-full") {
  const path = resolve(candidateDirectory(root, profileName), "receipt.json");
  if (!existsSync(path)) return null;
  return readJson(path);
}

export function scanStagedCandidate({ root = DEFAULT_ROOT, profileName = "private-full" }) {
  const receipt = readCandidateReceipt(root, profileName);
  if (!receipt) throw new Error(`No ${profileName} candidate receipt exists. Run package:rc first.`);
  const stageManifestPath = resolve(candidateDirectory(root, profileName), "stage/release/stage-manifest.json");
  const manifest = readJson(stageManifestPath);
  const stageRoot = resolve(candidateDirectory(root, profileName), "stage");
  const entries = manifest.sourceFiles.map((file) => ({
    path: file.path,
    data: readFileSync(resolve(stageRoot, file.path)),
  })).concat([
    { path: "release/checksums.sha256", data: readFileSync(resolve(stageRoot, "release/checksums.sha256")) },
    { path: "release/sbom.cdx.json", data: readFileSync(resolve(stageRoot, "release/sbom.cdx.json")) },
    { path: "release/stage-manifest.json", data: readFileSync(stageManifestPath) },
  ]);
  const scan = scanCandidateEntries(entries, manifest.visibility);
  const archivePath = resolve(root, receipt.packagePath);
  const archiveMatches = existsSync(archivePath) && sha256(readFileSync(archivePath)) === receipt.packageDigest;
  const sourceFilesMatch = manifest.sourceFiles.every((file) => {
    const path = resolve(stageRoot, file.path);
    return existsSync(path) && statSync(path).isFile() && sha256(readFileSync(path)) === file.sha256;
  });
  const stageManifestMatches = sha256(readFileSync(stageManifestPath)) === receipt.stageManifestDigest;
  const sbomMatches = sha256(readFileSync(resolve(stageRoot, "release/sbom.cdx.json"))) === receipt.sbomDigest;
  const checksumsMatch = sha256(readFileSync(resolve(stageRoot, "release/checksums.sha256"))) === receipt.checksumsDigest;
  const report = {
    schema: "morrow.package-scan-report.v1",
    profile: profileName,
    candidateName: receipt.candidateName,
    packageDigest: receipt.packageDigest,
    archiveMatches,
    sourceFilesMatch,
    stageManifestMatches,
    sbomMatches,
    checksumsMatch,
    scan,
    passed: archiveMatches && sourceFilesMatch && stageManifestMatches && sbomMatches && checksumsMatch && scan.passed,
  };
  writeJson(resolve(root, "artifacts/release", `package-scan-${profileName}.json`), report);
  return report;
}

export function conformanceReport({ root = DEFAULT_ROOT, profileName = "private-full" }) {
  const packageJson = readJson(resolve(root, "package.json"));
  const lockTracked = (() => {
    try {
      git(root, ["cat-file", "-e", "HEAD:pnpm-lock.yaml"]);
      return true;
    } catch {
      return false;
    }
  })();
  const appendix = validateAppendixCPathMap(root);
  const receipt = readCandidateReceipt(root, profileName);
  const currentCommit = git(root, ["rev-parse", "HEAD"]).trim();
  const currentTree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  let packageScan = null;
  try {
    if (receipt) packageScan = scanStagedCandidate({ root, profileName });
  } catch {
    packageScan = null;
  }
  const otherProfileName = profileName === "private-full" ? "public-canvas" : "private-full";
  const otherReceipt = readCandidateReceipt(root, otherProfileName);
  let otherPackageScan = null;
  try {
    if (otherReceipt) otherPackageScan = scanStagedCandidate({ root, profileName: otherProfileName });
  } catch {
    otherPackageScan = null;
  }
  const checks = [
    { id: "candidate_version", passed: packageJson.version === RELEASE_VERSION },
    { id: "frozen_lockfile_tracked", passed: lockTracked },
    { id: "appendix_c_path_map", passed: appendix.passed },
    { id: "candidate_receipt", passed: receipt !== null },
    { id: "candidate_bound_to_head", passed: receipt?.commit === currentCommit && receipt?.tree === currentTree },
    { id: "candidate_package_integrity", passed: packageScan?.passed === true },
    { id: "other_profile_candidate_receipt", passed: otherReceipt !== null },
    { id: "other_profile_bound_to_head", passed: otherReceipt?.commit === currentCommit && otherReceipt?.tree === currentTree },
    { id: "other_profile_package_integrity", passed: otherPackageScan?.passed === true },
    { id: "candidate_marker_scan", passed: receipt?.markerScan?.passed === true },
    { id: "source_origin_ledger", passed: receipt?.sourceOrigin?.passed === true },
    { id: "source_rights", passed: receipt?.sourceRights?.passed === true },
    { id: "external_live_receipts", passed: receipt?.externalReceipts?.passed === true },
    { id: "zero_tolerance_receipt", passed: receipt?.zeroTolerance?.passed === true },
    { id: "candidate_promotable", passed: receipt?.promotable === true },
  ];
  const report = {
    schema: "morrow.conformance-report.v1",
    profile: profileName,
    commit: git(root, ["rev-parse", "HEAD"]).trim(),
    checks,
    appendix,
    receiptPath: receipt ? relative(root, resolve(candidateDirectory(root, profileName), "receipt.json")) : null,
    passed: checks.every((check) => check.passed),
  };
  writeJson(resolve(root, "artifacts/release/conformance-report.json"), report);
  return report;
}

export function assertConformant(options) {
  const report = conformanceReport(options);
  if (!report.passed) {
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.id).join(", ");
    throw new Error(`Weekend definition of done is blocked: ${failed}`);
  }
  return report;
}
