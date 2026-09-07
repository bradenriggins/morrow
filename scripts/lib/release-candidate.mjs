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
import { deterministicZip, stableJson } from "./deterministic-archive.mjs";

export { deterministicZip, stableJson } from "./deterministic-archive.mjs";

export const RELEASE_VERSION = "1.0.0";
export const REQUIRED_EXTERNAL_RECEIPTS = Object.freeze([
  "authorized_live_canvas",
  "client_parity",
]);
export const REQUIRED_PROMOTION_RECEIPTS = Object.freeze([
  "independent_clean_machine",
  "publication_authorization",
]);
/**
 * The browser and permission gate. `pnpm scripts:test` globs `scripts/test/*.test.mjs`, so the
 * harnesses that drive a real Chromium, ask a person for a Chrome permission, or install the Windows
 * app are outside `pnpm check`. `pnpm test:browser` (`scripts/run-browser-harnesses.mjs`) runs them
 * and writes the receipt read here, so a candidate cannot be promoted with no recorded browser
 * result. A harness that did not run is recorded as not run; only `passed` counts as a pass.
 */
export const BROWSER_HARNESS_SCHEMA = "morrow.browser-harness-receipt.v1";
export const BROWSER_HARNESS_RECEIPT_PATH = "output/browser-harness/receipt.json";
export const BROWSER_HARNESS_IDS = Object.freeze([
  "canvas_connector_browser",
  "bridge_maintenance_cft",
  "canvas_file_optional_permission",
  "desktop_windows_smoke",
]);
/**
 * The harnesses a release candidate cannot be promoted without. `desktop_windows_smoke` is not one
 * of them: it runs on native Windows through the `windows-2022` job in
 * `.github/workflows/desktop-release.yml`, and this receipt only has to record what happened to it
 * here. It still blocks if it is recorded as run and did not pass.
 */
export const REQUIRED_BROWSER_HARNESS_PASSES = Object.freeze([
  "canvas_connector_browser",
  "bridge_maintenance_cft",
  "canvas_file_optional_permission",
]);
/** A harness that ran keeps its log; a harness that did not run keeps a reason. */
export const BROWSER_HARNESS_RAN_STATUSES = Object.freeze(["passed", "failed", "timed-out"]);
export const BROWSER_HARNESS_NOT_RUN_STATUSES = Object.freeze(["not-run-on-this-host", "not-run-unattended"]);

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

function git(root, args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
    maxBuffer: 64 * 1024 * 1024,
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

/** True when a release profile selects one tracked path. Exported so a test can check a profile's selection. */
export function profileIncludes(path, profile) {
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

export function buildCycloneDxSbom({ candidateName, sourceFiles, evidence = [], version = RELEASE_VERSION }) {
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
      properties: evidence.map((entry) => ({
        name: "morrow:release-evidence",
        value: `${entry.path}:${sha256(entry.data)}`,
      })).sort((left, right) => left.value.localeCompare(right.value)),
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

function validThirdPartyEvidence(entry, files) {
  const evidence = entry?.thirdParty;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const sourceUrl = typeof evidence.sourceUrl === "string" ? evidence.sourceUrl.trim() : "";
  try {
    if (new URL(sourceUrl).protocol !== "https:") return false;
  } catch {
    return false;
  }
  const licensePath = typeof evidence.licensePath === "string" ? evidence.licensePath : "";
  const licenseFile = files.get(licensePath);
  return evidence.license === "SIL-OFL-1.1"
    && typeof evidence.copyright === "string"
    && evidence.copyright.trim().length > 0
    && validDigest(evidence.assetSha256)
    && evidence.assetSha256 === entry.sha256
    && validDigest(evidence.licenseSha256)
    && licenseFile?.sha256 === evidence.licenseSha256;
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
    passed: reviewed && missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    unexpected,
  };
}

function sourceRightsState(root, files, visibility) {
  if (visibility !== "public") {
    return { schema: "morrow.source-rights-validation.v1", required: false, passed: true, missing: [], invalid: [] };
  }
  const manifestPath = "config/source-rights.manifest.json";
  let manifestData = null;
  try {
    manifestData = trackedBuffer(root, manifestPath);
  } catch {
    manifestData = null;
  }
  const manifest = manifestData ? JSON.parse(Buffer.from(manifestData).toString("utf8")) : { files: [] };
  const records = new Map((Array.isArray(manifest.files) ? manifest.files : []).map((entry) => [entry.path, entry]));
  const stagedFiles = new Map(files.map((file) => [file.path, file]));
  const allowed = new Set(["direct_owned", "adapted_owned", "clean_reimplementation", "third_party_redistributable"]);
  const missing = [];
  const invalid = [];
  for (const file of files) {
    const entry = records.get(file.path);
    if (!entry) {
      missing.push(file.path);
      continue;
    }
    const thirdPartyValid = entry.disposition !== "third_party_redistributable" || validThirdPartyEvidence(entry, stagedFiles);
    if (!allowed.has(entry.disposition) || entry.sha256 !== file.sha256 || typeof entry.review !== "string" || !entry.review.trim() || !thirdPartyValid) {
      invalid.push(file.path);
    }
  }
  return {
    schema: "morrow.source-rights-validation.v1",
    required: true,
    manifestPath,
    manifestSha256: manifestData ? sha256(manifestData) : null,
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

function externalReceiptSet(root, ids, binding = currentEvidenceBinding(root)) {
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
      && entry.verifier.trim().length > 0
      && typeof entry.verifiedAt === "string"
      && Number.isFinite(Date.parse(entry.verifiedAt))
      && entry.commit === binding.commit
      && entry.catalogDigest === binding.catalogDigest
      && entry.candidateDigests?.privateFull === binding.candidateDigests.privateFull
      && entry.candidateDigests?.publicCanvas === binding.candidateDigests.publicCanvas;
    return {
      id,
      status: verified ? "verified" : "missing",
      blocking: !verified,
      ...(verified ? { receiptDigest: entry.receiptDigest } : {}),
    };
  });
  return { path: existsSync(path) ? path : null, binding, receipts, passed: receipts.every((entry) => !entry.blocking) };
}

function externalReceiptState(root, binding) {
  return externalReceiptSet(root, REQUIRED_EXTERNAL_RECEIPTS, binding);
}

function promotionReceiptState(root, binding) {
  return externalReceiptSet(root, REQUIRED_PROMOTION_RECEIPTS, binding);
}

export function zeroToleranceState(root, binding = currentEvidenceBinding(root)) {
  const path = process.env.MORROW_ZERO_TOLERANCE_RECEIPT_PATH
    ? resolve(process.env.MORROW_ZERO_TOLERANCE_RECEIPT_PATH)
    : resolve(root, "artifacts/release/zero-tolerance-receipt.json");
  const supplied = existsSync(path) ? readJson(path) : { checks: [] };
  const bindingMatches = supplied.status === "passed"
    && !git(root, ["status", "--porcelain", "--untracked-files=normal"]).trim()
    && supplied.binding?.tree === git(root, ["rev-parse", "HEAD^{tree}"]).trim()
    && supplied.binding?.commit === binding.commit
    && supplied.binding?.catalogDigest === binding.catalogDigest
    && supplied.binding?.candidateDigests?.privateFull === binding.candidateDigests.privateFull
    && supplied.binding?.candidateDigests?.publicCanvas === binding.candidateDigests.publicCanvas;
  const byId = new Map((Array.isArray(supplied.checks) ? supplied.checks : []).map((entry) => [entry.id, entry]));
  const checks = ZERO_TOLERANCE_TARGETS.map((id) => {
    const entry = byId.get(id);
    const evidenceValid = Array.isArray(entry?.evidence) && entry.evidence.length > 0
      && typeof supplied.evidenceRoot === "string"
      && /^artifacts\/release\/evidence-[a-zA-Z0-9-]+$/.test(supplied.evidenceRoot)
      && entry.evidence.every((evidence) => {
        if (!/^[a-zA-Z0-9-]+\.log$/.test(evidence.path) || !validDigest(evidence.sha256)) return false;
        const evidencePath = resolve(root, supplied.evidenceRoot, evidence.path);
        return existsSync(evidencePath) && sha256(readFileSync(evidencePath)) === evidence.sha256;
      });
    const passed = bindingMatches && evidenceValid && entry?.status === "passed" && entry.count === 0
      && entry.receiptDigest === sha256(JSON.stringify({ binding: supplied.binding, id, evidenceDigests: entry.evidence }));
    return { id, status: passed ? "passed" : "missing", count: passed ? 0 : null, blocking: !passed };
  });
  return { path: existsSync(path) ? path : null, binding, bindingMatches, checks, passed: checks.every((entry) => !entry.blocking) };
}

/**
 * One recorded browser-harness result, or false when the receipt does not carry a usable one. A
 * harness that ran is believed only while its log is still the log that was hashed, so an edited
 * receipt cannot claim a pass. A harness that did not run has to say why.
 */
function recordedHarnessResult(receiptDirectory, entry) {
  if (!entry || typeof entry.status !== "string") return false;
  if (BROWSER_HARNESS_NOT_RUN_STATUSES.includes(entry.status)) {
    return typeof entry.reason === "string" && entry.reason.trim().length > 0;
  }
  if (!BROWSER_HARNESS_RAN_STATUSES.includes(entry.status)) return false;
  if (!/^[a-z0-9_-]+\.log$/.test(entry.log || "") || !validDigest(entry.logSha256)) return false;
  const logPath = resolve(receiptDirectory, entry.log);
  return existsSync(logPath) && sha256(readFileSync(logPath)) === entry.logSha256;
}

export function browserHarnessState(root, binding = currentEvidenceBinding(root)) {
  const path = process.env.MORROW_BROWSER_HARNESS_RECEIPT_PATH
    ? resolve(process.env.MORROW_BROWSER_HARNESS_RECEIPT_PATH)
    : resolve(root, BROWSER_HARNESS_RECEIPT_PATH);
  const supplied = existsSync(path) ? readJson(path) : {};
  const boundToHead = supplied.schema === BROWSER_HARNESS_SCHEMA
    && supplied.workingTreeClean === true
    && !git(root, ["status", "--porcelain", "--untracked-files=normal"]).trim()
    && supplied.commit === binding.commit
    && supplied.tree === git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const byId = new Map((Array.isArray(supplied.harnesses) ? supplied.harnesses : []).map((entry) => [entry.id, entry]));
  const harnesses = BROWSER_HARNESS_IDS.map((id) => {
    const entry = byId.get(id);
    const recorded = boundToHead && recordedHarnessResult(dirname(path), entry);
    const status = recorded ? entry.status : "missing";
    const required = REQUIRED_BROWSER_HARNESS_PASSES.includes(id);
    const blocking = required
      ? status !== "passed"
      : !recorded || (BROWSER_HARNESS_RAN_STATUSES.includes(status) && status !== "passed");
    return { id, status, required, blocking };
  });
  return {
    path: existsSync(path) ? path : null,
    binding,
    boundToHead,
    harnesses,
    passed: harnesses.every((entry) => !entry.blocking),
  };
}

function currentEvidenceBinding(root, { profileName, packageDigest } = {}) {
  const receiptDigest = (profile) => {
    const path = resolve(root, "artifacts/candidates", profile, "receipt.json");
    if (!existsSync(path)) return null;
    const receipt = readJson(path);
    return validDigest(receipt.packageDigest) ? receipt.packageDigest : null;
  };
  const canvasCatalogPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
  const mergedCatalogPath = resolve(root, "artifacts/catalogs/merged-capabilities.json");
  const catalog = existsSync(canvasCatalogPath)
    ? readJson(canvasCatalogPath)
    : existsSync(mergedCatalogPath)
      ? readJson(mergedCatalogPath)
      : {};
  const candidateDigests = {
    privateFull: receiptDigest("private-full"),
    publicCanvas: receiptDigest("public-canvas"),
  };
  const digestKey = profileName === "private-full"
    ? "privateFull"
    : profileName === "public-canvas"
      ? "publicCanvas"
      : null;
  if (digestKey && validDigest(packageDigest)) candidateDigests[digestKey] = packageDigest;
  return {
    commit: git(root, ["rev-parse", "HEAD"]).trim(),
    catalogDigest: validDigest(catalog.catalogDigest)
      ? catalog.catalogDigest
      : validDigest(catalog.digest)
        ? catalog.digest
        : null,
    candidateDigests,
  };
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
      && value.status === "ratified-for-standalone-connector-architecture"
      && mappings.length === 32
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

const PUBLIC_ROOT_SCRIPTS = new Set([
  "build",
  "clean",
  "typecheck",
  "start",
  "setup",
  "morrow",
  "clients:render",
  "catalog:canvas",
  "catalog:canvas:check",
  "canvas:readback:sync",
  "canvas:readback:check",
  "package:connector",
  "package:connector:check",
]);

export function publicPackageManifest(data) {
  const manifest = JSON.parse(Buffer.from(data).toString("utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !manifest.scripts || typeof manifest.scripts !== "object") {
    throw new Error("Public candidate requires a root package manifest with scripts.");
  }
  const scripts = Object.fromEntries(Object.entries(manifest.scripts)
    .filter(([name]) => PUBLIC_ROOT_SCRIPTS.has(name)));
  return Buffer.from(stableJson({ ...manifest, scripts }));
}

function publicWorkspacePackageManifest(data) {
  const manifest = JSON.parse(Buffer.from(data).toString("utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Public candidate package manifest is invalid.");
  }
  const scripts = manifest.scripts && typeof manifest.scripts === "object"
    ? Object.fromEntries(Object.entries(manifest.scripts).filter(([name]) => name !== "test"))
    : undefined;
  return Buffer.from(stableJson({ ...manifest, ...(scripts ? { scripts } : {}) }));
}

function candidateSourceFiles(sourceFiles, visibility) {
  if (visibility !== "public") return { files: sourceFiles, publicPackage: null };
  const sourcePackage = sourceFiles.find((file) => file.path === "package.json");
  if (!sourcePackage) throw new Error("Public candidate requires package.json.");
  const publicPackage = publicPackageManifest(sourcePackage.data);
  const manifests = [];
  return {
    files: sourceFiles.map((file) => {
      const data = file.path === "package.json"
        ? publicPackage
        : /^packages\/[^/]+\/package\.json$/.test(file.path)
          ? publicWorkspacePackageManifest(file.data)
          : file.data;
      if (data !== file.data) {
        manifests.push({
          path: file.path,
          sourceSha256: sha256(file.data),
          stagedSha256: sha256(data),
          scripts: Object.keys(JSON.parse(data.toString("utf8")).scripts || {}).sort(),
        });
      }
      return data === file.data ? file : { ...file, data };
    }),
    publicPackage: { manifests },
  };
}

function candidateEvidence(root, visibility, profileFiles) {
  if (visibility !== "public") return [];
  const sourceRights = { sourcePath: "config/source-rights.manifest.json", path: "release/source-rights.manifest.json" };
  const sourceOrigin = { sourcePath: "config/source-origin-ledger.json", path: "release/source-origin-ledger.json" };
  return [sourceRights, sourceOrigin].flatMap((entry) => {
    try {
      const sourceData = trackedBuffer(root, entry.sourcePath);
      const data = entry === sourceOrigin
        ? Buffer.from(stableJson({
          ...JSON.parse(Buffer.from(sourceData).toString("utf8")),
          entries: JSON.parse(Buffer.from(sourceData).toString("utf8")).entries
            .filter((record) => profileFiles.some((file) => file.path === record.path))
            .map((record) => ({
              ...record,
              testMapping: Array.isArray(record.testMapping)
                ? record.testMapping.filter((path) => profileFiles.some((file) => file.path === path))
                : [],
            })),
        }))
        : sourceData;
      return [{ ...entry, data, sourceSha256: sha256(sourceData) }];
    } catch {
      return [];
    }
  });
}

export function stageCandidate({ root = DEFAULT_ROOT, profileName = "private-full", verifyRebuild = false }) {
  const profile = loadProfile(root, profileName);
  const output = assertOutputPath(root, candidateDirectory(root, profileName));
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const profileSourceFiles = trackedFiles(root)
    .filter((path) => profileIncludes(path, profile))
    .map((path) => ({ path, data: trackedBuffer(root, path) }));
  const profileFiles = profileSourceFiles.map((file) => ({ path: file.path, bytes: file.data.length, sha256: sha256(file.data) }));
  const sourceOrigin = validateSourceOriginLedger({ root, files: profileFiles, commit });
  const sourceRights = sourceRightsState(root, profileFiles, profile.visibility);
  const staged = candidateSourceFiles(profileSourceFiles, profile.visibility);
  const sourceFiles = staged.files;
  const files = sourceFiles.map((file) => ({ path: file.path, bytes: file.data.length, sha256: sha256(file.data) }));
  const releaseEvidence = candidateEvidence(root, profile.visibility, profileFiles);
  const markerScan = scanCandidateEntries(sourceFiles, profile.visibility);
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
    ...(staged.publicPackage ? { publicPackage: staged.publicPackage } : {}),
    evidence: releaseEvidence.map((entry) => ({
      sourcePath: entry.sourcePath,
      sourceSha256: entry.sourceSha256,
      path: entry.path,
      sha256: sha256(entry.data),
    })),
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
  for (const evidence of releaseEvidence) {
    const target = resolve(stageRoot, evidence.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, evidence.data, { mode: 0o600 });
  }
  const sbomData = Buffer.from(stableJson(buildCycloneDxSbom({
    candidateName: candidateName(profileName),
    sourceFiles,
    evidence: releaseEvidence,
  })));
  const checksumData = Buffer.from(checksumManifest([
    ...sourceFiles,
    ...releaseEvidence,
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
    ...releaseEvidence,
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
  const binding = currentEvidenceBinding(root, { profileName, packageDigest: archiveDigest });
  const externalReceipts = externalReceiptState(root, binding);
  const promotionReceipts = promotionReceiptState(root, binding);
  const zeroTolerance = zeroToleranceState(root, binding);
  const browserHarness = browserHarnessState(root, binding);

  const blockers = [
    ...(markerScan.passed ? [] : ["candidate_marker_scan_failed"]),
    ...(sourceOrigin.passed ? [] : ["source_origin_ledger_incomplete"]),
    ...(sourceRights.passed ? [] : ["source_rights_manifest_incomplete"]),
    ...externalReceipts.receipts.filter((entry) => entry.blocking).map((entry) => `external_receipt_missing:${entry.id}`),
    ...zeroTolerance.checks.filter((entry) => entry.blocking).map((entry) => `zero_tolerance_evidence_missing:${entry.id}`),
    ...browserHarness.harnesses.filter((entry) => entry.blocking)
      .map((entry) => `${entry.status === "missing" ? "browser_harness_result_missing" : "browser_harness_not_passed"}:${entry.id}`),
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
    browserHarness,
    localEvidenceOnly: true,
    candidateBuilt: markerScan.passed && sourceOrigin.passed,
    promotable: blockers.length === 0,
    stablePromotionReady: blockers.length === 0 && promotionReceipts.passed,
    blockingReasons: blockers,
  };
  writeJson(resolve(output, "receipt.json"), receipt);
  return receipt;
}

export function stageCandidateSet({
  root = DEFAULT_ROOT,
  profileNames,
  verifyRebuild = false,
}) {
  for (const profileName of profileNames) {
    stageCandidate({ root, profileName, verifyRebuild });
  }
  return profileNames.map((profileName) => (
    stageCandidate({ root, profileName, verifyRebuild })
  ));
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
  const sourceFiles = manifest.sourceFiles.map((file) => ({
    path: file.path,
    data: readFileSync(resolve(stageRoot, file.path)),
  }));
  const releaseEvidence = (Array.isArray(manifest.evidence) ? manifest.evidence : []).map((evidence) => ({
    path: evidence.path,
    data: readFileSync(resolve(stageRoot, evidence.path)),
  }));
  const releaseFiles = [
    { path: "release/checksums.sha256", data: readFileSync(resolve(stageRoot, "release/checksums.sha256")) },
    { path: "release/sbom.cdx.json", data: readFileSync(resolve(stageRoot, "release/sbom.cdx.json")) },
    { path: "release/stage-manifest.json", data: readFileSync(stageManifestPath) },
  ];
  const entries = sourceFiles.concat(releaseEvidence, releaseFiles);
  const scan = scanCandidateEntries(entries, manifest.visibility);
  const archivePath = resolve(root, receipt.packagePath);
  const archiveMatches = existsSync(archivePath) && sha256(readFileSync(archivePath)) === receipt.packageDigest;
  const sourceFilesMatch = manifest.sourceFiles.every((file) => {
    const path = resolve(stageRoot, file.path);
    return existsSync(path) && statSync(path).isFile() && sha256(readFileSync(path)) === file.sha256;
  });
  const evidenceMatches = (Array.isArray(manifest.evidence) ? manifest.evidence : []).every((evidence) => {
    const path = resolve(stageRoot, evidence.path);
    return existsSync(path) && statSync(path).isFile() && sha256(readFileSync(path)) === evidence.sha256;
  });
  const stageManifestMatches = sha256(readFileSync(stageManifestPath)) === receipt.stageManifestDigest;
  const sbomMatches = sha256(readFileSync(resolve(stageRoot, "release/sbom.cdx.json"))) === receipt.sbomDigest;
  const checksumsMatch = sha256(readFileSync(resolve(stageRoot, "release/checksums.sha256"))) === receipt.checksumsDigest;
  const checksumContentsMatch = readFileSync(resolve(stageRoot, "release/checksums.sha256")).equals(Buffer.from(checksumManifest([
    ...sourceFiles,
    ...releaseEvidence,
    { path: "release/sbom.cdx.json", data: readFileSync(resolve(stageRoot, "release/sbom.cdx.json")) },
  ])));
  const report = {
    schema: "morrow.package-scan-report.v1",
    profile: profileName,
    candidateName: receipt.candidateName,
    packageDigest: receipt.packageDigest,
    archiveMatches,
    sourceFilesMatch,
    evidenceMatches,
    stageManifestMatches,
    sbomMatches,
    checksumsMatch,
    checksumContentsMatch,
    scan,
    passed: archiveMatches && sourceFilesMatch && evidenceMatches && stageManifestMatches && sbomMatches && checksumsMatch && checksumContentsMatch && scan.passed,
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
    { id: "browser_harness_receipt", passed: receipt?.browserHarness?.passed === true },
    { id: "candidate_promotable", passed: receipt?.promotable === true },
    { id: "promotion_receipts", passed: promotionReceiptState(root).passed },
    { id: "current_zero_tolerance_evidence", passed: zeroToleranceState(root).passed },
    { id: "current_browser_harness_evidence", passed: browserHarnessState(root).passed },
    { id: "stable_promotion_ready", passed: receipt?.stablePromotionReady === true },
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
