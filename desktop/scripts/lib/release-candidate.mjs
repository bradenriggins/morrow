import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { deterministicZip, stableJson } from "./deterministic-archive.mjs";
import { readExactTrustFile, readExactTrustJson } from "./exact-trust-file.mjs";

export { deterministicZip, stableJson } from "./deterministic-archive.mjs";

const EXTERNAL_EVIDENCE_ROOT = /^artifacts\/release\/evidence-[a-zA-Z0-9-]+$/;
const EXTERNAL_EVIDENCE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const MAX_EXTERNAL_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const MAX_RELEASE_TRUST_INPUT_BYTES = 8 * 1024 * 1024;
/**
 * The browser and permission gate. `pnpm scripts:test` globs `scripts/test/*.test.mjs`, so the
 * harnesses that drive a real Chromium, ask a person for a Chrome permission, or install the Windows
 * app are outside `pnpm check`. `pnpm test:browser` (`scripts/run-browser-harnesses.mjs`) runs them
 * and writes the receipt read here, so a candidate cannot be promoted with no recorded browser
 * result. A harness that did not run is recorded as not run; only `passed` counts as a pass.
 */
export const BROWSER_HARNESS_SCHEMA = "morrow.browser-harness-receipt.v2";
export const BROWSER_HARNESS_RECEIPT_PATH = "output/browser-harness/receipt.json";
export const BROWSER_HARNESS_IDS = Object.freeze([
  "canvas_connector_browser",
  "bridge_maintenance_cft",
  "installer_renderer_layout",
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
  "installer_renderer_layout",
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
  return readExactTrustJson(path, {
    label: "Release JSON input",
    maxBytes: MAX_RELEASE_TRUST_INPUT_BYTES,
  });
}

function exactFileDigestMatches(path, expectedDigest, label) {
  try {
    return sha256(readExactTrustFile(path, {
      label,
      maxBytes: MAX_EXTERNAL_EVIDENCE_BYTES,
    })) === expectedDigest;
  } catch {
    return false;
  }
}

function readExpectedCandidateFile(path, expected, label) {
  return readExactTrustFile(path, {
    label,
    maxBytes: Math.max(1, expected.length),
  });
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
  if (value.schema !== "morrow.release-profiles.v2") {
    throw new Error("Release profile configuration has an unsupported schema.");
  }
  return value;
}

export function releaseIdentity(root = DEFAULT_ROOT) {
  const packageData = trackedBuffer(root, "package.json");
  const manifest = JSON.parse(Buffer.from(packageData).toString("utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || typeof manifest.version !== "string" || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("The frozen root package manifest has no valid release version.");
  }
  return { version: manifest.version, packageSha256: sha256(packageData) };
}

export function validateReleasePackageVersions({ sourceFiles, version }) {
  const manifests = new Map(sourceFiles
    .filter((file) => ["package.json", "installer/package.json"].includes(file.path))
    .map((file) => [file.path, JSON.parse(Buffer.from(file.data).toString("utf8"))]));
  if (manifests.get("package.json")?.version !== version) {
    throw new Error("The staged root package version does not match the frozen release identity.");
  }
  if (manifests.has("installer/package.json") && manifests.get("installer/package.json")?.version !== version) {
    throw new Error("The frozen installer and root package versions do not match.");
  }
  return true;
}

function loadProfile(root, profileName) {
  const profiles = loadReleaseProfiles(root);
  const profile = profiles.profiles?.[profileName];
  if (!profile || !Array.isArray(profile.include) || !["private", "public"].includes(profile.visibility)) {
    throw new Error(`Unknown or invalid release profile: ${profileName}`);
  }
  return profile;
}

function assertFrozenReleaseProfiles(root) {
  const path = "config/release-profiles.json";
  let frozen;
  try {
    frozen = trackedBuffer(root, path);
  } catch {
    throw new Error("Release profile configuration must be tracked at HEAD before packaging.");
  }
  const working = readExactTrustFile(resolve(root, path), {
    label: "Release profile configuration",
    maxBytes: MAX_RELEASE_TRUST_INPUT_BYTES,
  });
  if (!working.equals(frozen)) {
    throw new Error("Release profile configuration must match HEAD before packaging.");
  }
}

export function requiredEvidenceForProfile(profile) {
  if (!profile?.providers || typeof profile.providers !== "object" || Array.isArray(profile.providers)
    || !Array.isArray(profile.externalEvidenceReceipts) || !Array.isArray(profile.promotionEvidenceReceipts)) {
    throw new Error("Release profile evidence policy is missing.");
  }
  const external = [...profile.externalEvidenceReceipts];
  for (const [provider, policy] of Object.entries(profile.providers)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(provider) || !policy || typeof policy !== "object" || Array.isArray(policy)
      || typeof policy.authorizationReceipt !== "string") {
      throw new Error("Release profile provider evidence policy is invalid.");
    }
    const live = [policy.liveProofReceipt, policy.liveProofExceptionReceipt].filter((value) => typeof value === "string");
    if (live.length !== 1) throw new Error("Each release provider requires one live proof or signed exception receipt.");
    external.push(policy.authorizationReceipt, live[0]);
  }
  const promotion = [...profile.promotionEvidenceReceipts];
  const valid = (id) => typeof id === "string" && /^[a-z][a-z0-9_]{2,79}$/.test(id);
  if (![...external, ...promotion].every(valid) || new Set(external).size !== external.length
    || new Set(promotion).size !== promotion.length || external.some((id) => promotion.includes(id))) {
    throw new Error("Release profile evidence receipt identities are invalid or duplicated.");
  }
  return { external: external.sort(), promotion: promotion.sort() };
}

function yamlValue(value) {
  const text = String(value || "").trim();
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
  return text;
}

function yamlMapping(line, indentation) {
  if (!line.startsWith(" ".repeat(indentation)) || line[indentation] === " ") return null;
  const match = /^(?:(?:'((?:[^']|'')*)')|([^:]+)):\s*(.*)$/.exec(line.slice(indentation));
  if (!match) return null;
  return { key: match[1] === undefined ? match[2].trim() : match[1].replaceAll("''", "'"), value: yamlValue(match[3]) };
}

function parsePnpmLockGraph(data, path) {
  const lines = Buffer.from(data).toString("utf8").split(/\r?\n/);
  if (!lines.some((line) => /^lockfileVersion:\s*['"]?9\.0['"]?\s*$/.test(line))) {
    throw new Error(`SBOM requires pnpm lockfile version 9.0: ${path}`);
  }
  const importers = new Map();
  const snapshots = new Map();
  let section = "";
  let parent = "";
  let dependencyClass = "";
  let dependencyName = "";
  for (const line of lines) {
    if (/^[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(line)) {
      section = line.slice(0, -1);
      parent = "";
      dependencyClass = "";
      dependencyName = "";
      continue;
    }
    if (section === "importers") {
      const importer = yamlMapping(line, 2);
      if (importer) {
        parent = importer.key;
        importers.set(parent, new Map());
        dependencyClass = "";
        dependencyName = "";
        continue;
      }
      const kind = yamlMapping(line, 4);
      if (kind) {
        dependencyClass = ["dependencies", "optionalDependencies"].includes(kind.key) ? kind.key : "";
        dependencyName = "";
        continue;
      }
      const dependency = yamlMapping(line, 6);
      if (dependency && dependencyClass) {
        dependencyName = dependency.key;
        if (dependency.value) importers.get(parent).set(dependencyName, dependency.value);
        continue;
      }
      const field = yamlMapping(line, 8);
      if (field?.key === "version" && dependencyClass && dependencyName) {
        importers.get(parent).set(dependencyName, field.value);
      }
      continue;
    }
    if (section === "snapshots") {
      const snapshot = yamlMapping(line, 2);
      if (snapshot) {
        parent = snapshot.key;
        snapshots.set(parent, new Map());
        dependencyClass = "";
        continue;
      }
      const kind = yamlMapping(line, 4);
      if (kind) {
        dependencyClass = ["dependencies", "optionalDependencies"].includes(kind.key) ? kind.key : "";
        continue;
      }
      const dependency = yamlMapping(line, 6);
      if (dependency && dependencyClass && dependency.value) snapshots.get(parent).set(dependency.key, dependency.value);
    }
  }
  return { path, importers, snapshots };
}

function packageRef(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function snapshotVersion(name, key) {
  const prefix = `${name}@`;
  if (!key.startsWith(prefix)) throw new Error(`SBOM lockfile package identity is invalid: ${key}`);
  const version = key.slice(prefix.length).replace(/\(.+$/, "");
  if (!version) throw new Error(`SBOM lockfile package version is invalid: ${key}`);
  return version;
}

function resolveSnapshotKey(graph, name, resolution) {
  if (typeof resolution !== "string" || !resolution || resolution.startsWith("link:") || resolution.startsWith("workspace:")) return null;
  const exact = `${name}@${resolution}`;
  if (graph.snapshots.has(exact)) return exact;
  const version = resolution.replace(/\(.+$/, "");
  const candidates = [...graph.snapshots.keys()].filter((key) => key.startsWith(`${name}@`) && snapshotVersion(name, key) === version);
  if (candidates.length !== 1) throw new Error(`SBOM cannot resolve one exact lockfile package: ${name}@${resolution}`);
  return candidates[0];
}

function assertOutputPath(root, output) {
  const allowed = resolve(root, "artifacts/candidates");
  const candidate = resolve(output);
  if (candidate === allowed || !candidate.startsWith(`${allowed}${sep}`)) {
    throw new Error("Candidate output must be a child of artifacts/candidates.");
  }
  return candidate;
}

export function buildCycloneDxSbom({ candidateName, sourceFiles, evidence = [], version }) {
  const manifests = sourceFiles
    .filter((file) => file.path === "package.json" || /^(?:packages\/[^/]+|installer)\/package\.json$/.test(file.path))
    .map((file) => ({ path: file.path, packageJson: JSON.parse(Buffer.from(file.data).toString("utf8")) }));
  const workspaceByName = new Map(manifests.map((entry) => [entry.packageJson.name, entry]));
  const rootManifest = manifests.find(({ path }) => path === "package.json")?.packageJson;
  const releaseVersion = version ?? rootManifest?.version;
  if (typeof releaseVersion !== "string" || !releaseVersion) throw new Error("SBOM release version is unavailable.");
  const lockfiles = new Map(sourceFiles
    .filter((file) => file.path === "pnpm-lock.yaml" || file.path.endsWith("/pnpm-lock.yaml"))
    .map((file) => [file.path, parsePnpmLockGraph(file.data, file.path)]));
  const dependenciesByRef = new Map();
  const externalComponents = new Map();
  const workspaceRef = (name) => {
    const workspace = workspaceByName.get(name);
    if (!workspace) throw new Error(`SBOM runtime dependency is not staged: ${name}`);
    return packageRef(name, workspace.packageJson.version);
  };
  const addDependency = (from, to) => {
    if (!dependenciesByRef.has(from)) dependenciesByRef.set(from, new Set());
    dependenciesByRef.get(from).add(to);
  };
  const lockForManifest = (manifestPath) => {
    const directory = manifestPath === "package.json" ? "" : manifestPath.slice(0, -"/package.json".length);
    const local = directory ? `${directory}/pnpm-lock.yaml` : "pnpm-lock.yaml";
    return { graph: lockfiles.get(local) || lockfiles.get("pnpm-lock.yaml"), importer: lockfiles.has(local) ? "." : (directory || ".") };
  };
  const visitSnapshot = (graph, key) => {
    const separator = key.startsWith("@") ? key.indexOf("@", key.indexOf("/") + 1) : key.indexOf("@");
    if (separator < 1) throw new Error(`SBOM lockfile package identity is invalid: ${key}`);
    const name = key.slice(0, separator);
    const exactVersion = snapshotVersion(name, key);
    const ref = packageRef(name, exactVersion);
    if (externalComponents.has(ref)) return ref;
    externalComponents.set(ref, {
      type: "library",
      name,
      version: exactVersion,
      "bom-ref": ref,
      properties: [{ name: "morrow:version-source", value: graph.path }],
    });
    dependenciesByRef.set(ref, new Set());
    for (const [childName, childResolution] of graph.snapshots.get(key) || []) {
      const child = workspaceByName.has(childName)
        ? workspaceRef(childName)
        : visitSnapshot(graph, resolveSnapshotKey(graph, childName, childResolution));
      addDependency(ref, child);
    }
    return ref;
  };
  for (const manifest of manifests) {
    const ref = workspaceRef(manifest.packageJson.name);
    dependenciesByRef.set(ref, new Set());
    const declared = { ...manifest.packageJson.dependencies, ...manifest.packageJson.optionalDependencies };
    if (Object.keys(declared).length === 0) continue;
    const { graph, importer } = lockForManifest(manifest.path);
    if (!graph || !graph.importers.has(importer)) throw new Error(`SBOM has no lockfile importer for ${manifest.path}`);
    for (const name of Object.keys(declared).sort()) {
      const resolution = graph.importers.get(importer).get(name);
      if (!resolution) throw new Error(`SBOM has no exact lockfile version for ${manifest.path} dependency ${name}`);
      const target = workspaceByName.has(name)
        ? workspaceRef(name)
        : visitSnapshot(graph, resolveSnapshotKey(graph, name, resolution));
      addDependency(ref, target);
    }
  }
  const components = [
    ...manifests.map(({ path, packageJson }) => ({
      type: "library",
      name: packageJson.name,
      version: packageJson.version,
      "bom-ref": packageRef(packageJson.name, packageJson.version),
      properties: [{ name: "morrow:source-path", value: path }],
    })),
    ...externalComponents.values(),
  ]
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const dependencies = [...dependenciesByRef]
    .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: candidateName,
        version: releaseVersion,
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

function exactCandidateDerivation(entry, file, transformation, digestField) {
  if (!transformation) return entry.derivation === undefined && entry[digestField] === file.sha256;
  const derivation = entry.derivation;
  return entry[digestField] === file.sha256
    && file.sha256 === transformation.stagedSha256
    && derivation?.schema === "morrow.release-manifest-derivation.v1"
    && derivation.transform === "public-package-manifest"
    && derivation.sourceSha256 === transformation.sourceSha256
    && derivation.stagedSha256 === transformation.stagedSha256
    && Object.keys(derivation).sort().join("\0") === "schema\0sourceSha256\0stagedSha256\0transform";
}

function transformationMap(transformations = []) {
  return new Map(transformations
    .filter((entry) => entry.sourceSha256 !== entry.stagedSha256)
    .map((entry) => [entry.path, entry]));
}

export function validateSourceOriginLedger({
  root = DEFAULT_ROOT,
  files,
  commit,
  ledgerData = null,
  ledgerPath = "config/source-origin-ledger.json",
  transformations = [],
}) {
  const absoluteLedgerPath = resolve(root, ledgerPath);
  let bytes = ledgerData === null ? null : Buffer.from(ledgerData);
  if (bytes === null && !existsSync(absoluteLedgerPath)) {
    return { schema: "morrow.source-origin-validation.v1", passed: false, reason: "ledger_missing", missing: files.map((file) => file.path) };
  }
  if (bytes === null) {
    try {
      bytes = trackedBuffer(root, ledgerPath);
    } catch {
      bytes = readExactTrustFile(absoluteLedgerPath, {
        label: "Source origin ledger",
        maxBytes: MAX_RELEASE_TRUST_INPUT_BYTES,
      });
    }
  }
  const ledger = JSON.parse(bytes.toString("utf8"));
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const derived = transformationMap(transformations);
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
      && exactCandidateDerivation(entry, file, derived.get(file.path), "afterDigest");
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
    ledgerPath,
    ledgerSha256: sha256(bytes),
    ledgerStatus: ledger.status || "unknown",
    candidateCommit: ledger.candidateCommit || null,
    candidateCommitMatches,
    passed: reviewed && missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    unexpected,
  };
}

function sourceRightsState(root, files, visibility, {
  manifestData = null,
  manifestPath = "config/source-rights.manifest.json",
  transformations = [],
} = {}) {
  if (visibility !== "public") {
    return { schema: "morrow.source-rights-validation.v1", required: false, passed: true, missing: [], invalid: [] };
  }
  let bytes = manifestData === null ? null : Buffer.from(manifestData);
  if (bytes === null) {
    try {
      bytes = trackedBuffer(root, manifestPath);
    } catch {
      bytes = null;
    }
  }
  const manifest = bytes ? JSON.parse(bytes.toString("utf8")) : { files: [] };
  const records = new Map((Array.isArray(manifest.files) ? manifest.files : []).map((entry) => [entry.path, entry]));
  const stagedFiles = new Map(files.map((file) => [file.path, file]));
  const derived = transformationMap(transformations);
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
    if (!allowed.has(entry.disposition) || !exactCandidateDerivation(entry, file, derived.get(file.path), "sha256")
      || typeof entry.review !== "string" || !entry.review.trim() || !thirdPartyValid) {
      invalid.push(file.path);
    }
  }
  return {
    schema: "morrow.source-rights-validation.v1",
    required: true,
    manifestPath,
    manifestSha256: bytes ? sha256(bytes) : null,
    passed: manifest.schema === "morrow.source-rights.v1" && missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
}

const PUBLIC_MARKERS = Object.freeze([
  { id: "private_chcp_marker", expression: /(?:\bchcp\b|chcp[_-]|chcp-team-agent-kit|meridian-vps)/i },
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

export function externalReceiptClaim(entry) {
  return {
    schema: "morrow.external-receipt-claim.v1",
    id: entry.id,
    evidence: entry.evidence,
    verifiedAt: entry.verifiedAt,
    commit: entry.commit,
    catalogDigest: entry.catalogDigest,
    candidateDigests: entry.candidateDigests,
  };
}

function externalEvidenceValid(root, supplied, entry) {
  if (!EXTERNAL_EVIDENCE_ROOT.test(supplied.evidenceRoot || "")
    || !entry?.evidence || !EXTERNAL_EVIDENCE_FILE.test(entry.evidence.path || "")
    || !validDigest(entry.evidence.sha256) || entry.receiptDigest !== entry.evidence.sha256) return false;
  const evidencePath = resolve(root, supplied.evidenceRoot, entry.evidence.path);
  try {
    return exactFileDigestMatches(evidencePath, entry.evidence.sha256, "External release evidence");
  } catch {
    return false;
  }
}

function externalReceiptPolicy(root, id) {
  let policy;
  try { policy = JSON.parse(trackedBuffer(root, "config/release-evidence-policy.json").toString("utf8")); } catch { return null; }
  if (policy?.schema !== "morrow.release-evidence-policy.v1" || !Array.isArray(policy.trustedAuthorizationKeys)
    || !policy.receipts || typeof policy.receipts !== "object" || Array.isArray(policy.receipts)) return null;
  const receipt = policy.receipts[id];
  return receipt && ["evidence", "authorization"].includes(receipt.kind) ? { policy, receipt } : null;
}

function authorizationReceiptValid(root, entry) {
  const configured = externalReceiptPolicy(root, entry.id);
  if (!configured) return false;
  if (configured.receipt.kind === "evidence") return true;
  const signature = entry.signature;
  const key = configured.policy.trustedAuthorizationKeys.find((candidate) => candidate?.keyId === signature?.keyId
    && candidate?.algorithm === "ed25519" && typeof candidate.publicKeyPem === "string");
  if (!key || signature?.algorithm !== "ed25519" || typeof signature.value !== "string") return false;
  let bytes;
  try { bytes = Buffer.from(signature.value, "base64"); } catch { return false; }
  if (bytes.length !== 64 || bytes.toString("base64") !== signature.value) return false;
  try {
    return verifySignature(null, Buffer.from(stableJson(externalReceiptClaim(entry))), createPublicKey(key.publicKeyPem), bytes);
  } catch {
    return false;
  }
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
      && externalEvidenceValid(root, supplied, entry)
      && authorizationReceiptValid(root, entry)
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

function externalReceiptState(root, binding, profile) {
  return externalReceiptSet(root, requiredEvidenceForProfile(profile).external, binding);
}

function promotionReceiptState(root, binding, profile) {
  return externalReceiptSet(root, requiredEvidenceForProfile(profile).promotion, binding);
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
        return existsSync(evidencePath)
          && exactFileDigestMatches(evidencePath, evidence.sha256, "Zero-tolerance evidence");
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
  if (!/^[a-z0-9_-]+\.log$/.test(entry.log || "") || !validDigest(entry.logSha256)
    || !Number.isSafeInteger(entry.logBytes) || entry.logBytes < 0 || entry.logBytes > MAX_EXTERNAL_EVIDENCE_BYTES
    || entry.logTruncated !== false) return false;
  const logPath = resolve(receiptDirectory, entry.log);
  if (!existsSync(logPath)) return false;
  try {
    const bytes = readExactTrustFile(logPath, {
      label: "Browser harness evidence",
      maxBytes: MAX_EXTERNAL_EVIDENCE_BYTES,
    });
    return bytes.byteLength === entry.logBytes && sha256(bytes) === entry.logSha256;
  } catch {
    return false;
  }
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
  const catalog = (() => {
    for (const path of ["artifacts/canvas-api/canvas-api-catalog.json", "artifacts/catalogs/merged-capabilities.json"]) {
      try { return JSON.parse(trackedBuffer(root, path).toString("utf8")); } catch { /* try the next frozen catalog */ }
    }
    return {};
  })();
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

function candidateName(profile, version) {
  return `morrow-v${version}-${process.platform}-${process.arch}-${profile}`;
}

function independentCandidateRebuild({ root, profileName, commit, tree, expectedDigest }) {
  const scratch = mkdtempSync(resolve(tmpdir(), "morrow-release-rebuild-"));
  const checkout = resolve(scratch, "source");
  try {
    execFileSync("git", ["clone", "--quiet", "--no-local", root, checkout], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync("git", ["-C", checkout, "checkout", "--quiet", "--detach", commit], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const raw = execFileSync(process.execPath, [resolve(HERE, "../verify-release-rebuild.mjs"), "--root", checkout, "--profile", profileName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("MORROW_") && name !== "NODE_OPTIONS")),
    });
    const rebuilt = JSON.parse(raw);
    if (rebuilt?.schema !== "morrow.independent-candidate-rebuild.v1" || rebuilt.commit !== commit || rebuilt.tree !== tree
      || rebuilt.profile !== profileName || rebuilt.packageDigest !== expectedDigest) {
      throw new Error("Independent rebuild proof failed.");
    }
    return {
      verified: true,
      digest: rebuilt.packageDigest,
      commit,
      tree,
      profile: profileName,
      isolation: "fresh_git_checkout_and_process",
      nodeVersion: rebuilt.nodeVersion,
      platform: rebuilt.platform,
      arch: rebuilt.arch,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

function candidateEvidence(root, visibility, profileFiles, transformations) {
  if (visibility !== "public") return [];
  const included = new Set(profileFiles.map((file) => file.path));
  const derived = transformationMap(transformations);
  const bindToShippedBytes = (record, digestField) => {
    const transformation = derived.get(record.path);
    if (!transformation) return record;
    return {
      ...record,
      [digestField]: transformation.stagedSha256,
      derivation: {
        schema: "morrow.release-manifest-derivation.v1",
        transform: "public-package-manifest",
        sourceSha256: transformation.sourceSha256,
        stagedSha256: transformation.stagedSha256,
      },
    };
  };
  const sourceRights = { sourcePath: "config/source-rights.manifest.json", path: "release/source-rights.manifest.json" };
  const sourceOrigin = { sourcePath: "config/source-origin-ledger.json", path: "release/source-origin-ledger.json" };
  return [sourceRights, sourceOrigin].flatMap((entry) => {
    try {
      const sourceData = trackedBuffer(root, entry.sourcePath);
      const source = JSON.parse(Buffer.from(sourceData).toString("utf8"));
      const data = entry === sourceOrigin
        ? Buffer.from(stableJson({
          ...source,
          entries: source.entries
            .filter((record) => included.has(record.path))
            .map((record) => ({
              ...bindToShippedBytes(record, "afterDigest"),
              testMapping: Array.isArray(record.testMapping)
                ? record.testMapping.filter((path) => included.has(path))
                : [],
            })),
        }))
        : Buffer.from(stableJson({
          ...source,
          files: source.files
            .filter((record) => included.has(record.path))
            .map((record) => bindToShippedBytes(record, "sha256")),
        }));
      return [{ ...entry, data, sourceSha256: sha256(sourceData) }];
    } catch {
      return [];
    }
  });
}

function expectedCandidateGraph(root, profileName) {
  const profile = loadProfile(root, profileName);
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const identity = releaseIdentity(root);
  const profileSourceFiles = trackedFiles(root)
    .filter((path) => profileIncludes(path, profile))
    .map((path) => ({ path, data: trackedBuffer(root, path) }));
  validateReleasePackageVersions({ sourceFiles: profileSourceFiles, version: identity.version });
  const profileFiles = profileSourceFiles.map((file) => ({ path: file.path, bytes: file.data.length, sha256: sha256(file.data) }));
  const sourceOriginInput = validateSourceOriginLedger({ root, files: profileFiles, commit });
  const sourceRightsInput = sourceRightsState(root, profileFiles, profile.visibility);
  const staged = candidateSourceFiles(profileSourceFiles, profile.visibility);
  const sourceFiles = staged.files;
  const files = sourceFiles.map((file) => ({ path: file.path, bytes: file.data.length, sha256: sha256(file.data) }));
  const transformations = staged.publicPackage?.manifests || [];
  const releaseEvidence = candidateEvidence(root, profile.visibility, files, transformations);
  const evidenceData = (path) => releaseEvidence.find((entry) => entry.path === path)?.data ?? null;
  const stagedSourceOrigin = profile.visibility === "public"
    ? validateSourceOriginLedger({
      root,
      files,
      commit,
      ledgerData: evidenceData("release/source-origin-ledger.json"),
      ledgerPath: "release/source-origin-ledger.json",
      transformations,
    })
    : sourceOriginInput;
  const stagedSourceRights = profile.visibility === "public"
    ? sourceRightsState(root, files, profile.visibility, {
      manifestData: evidenceData("release/source-rights.manifest.json"),
      manifestPath: "release/source-rights.manifest.json",
      transformations,
    })
    : sourceRightsInput;
  const sourceOrigin = {
    ...stagedSourceOrigin,
    sourceInput: {
      ledgerPath: sourceOriginInput.ledgerPath,
      ledgerSha256: sourceOriginInput.ledgerSha256 || null,
      passed: sourceOriginInput.passed,
    },
    passed: sourceOriginInput.passed && stagedSourceOrigin.passed,
  };
  const sourceRights = {
    ...stagedSourceRights,
    sourceInput: {
      manifestPath: sourceRightsInput.manifestPath || null,
      manifestSha256: sourceRightsInput.manifestSha256 || null,
      passed: sourceRightsInput.passed,
    },
    passed: sourceRightsInput.passed && stagedSourceRights.passed,
  };
  const markerScan = scanCandidateEntries(sourceFiles, profile.visibility);
  const baseManifest = {
    schema: "morrow.candidate-stage.v1",
    candidateName: candidateName(profileName, identity.version),
    version: identity.version,
    versionSource: { path: "package.json", sha256: identity.packageSha256 },
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
  const sbomData = Buffer.from(stableJson(buildCycloneDxSbom({
    candidateName: baseManifest.candidateName,
    sourceFiles,
    evidence: releaseEvidence,
    version: identity.version,
  })));
  const checksumData = Buffer.from(checksumManifest([
    ...sourceFiles,
    ...releaseEvidence,
    { path: "release/sbom.cdx.json", data: sbomData },
  ]));
  const stageManifest = {
    ...baseManifest,
    sbom: { path: "release/sbom.cdx.json", sha256: sha256(sbomData) },
    checksums: { path: "release/checksums.sha256", sha256: sha256(checksumData) },
  };
  const stageManifestData = Buffer.from(stableJson(stageManifest));
  const archiveEntries = [
    ...sourceFiles,
    ...releaseEvidence,
    { path: "release/checksums.sha256", data: checksumData },
    { path: "release/sbom.cdx.json", data: sbomData },
    { path: "release/stage-manifest.json", data: stageManifestData },
  ];
  const archive = deterministicZip(archiveEntries);
  return {
    profile,
    commit,
    tree,
    identity,
    sourceFiles,
    files,
    releaseEvidence,
    transformations,
    sourceOrigin,
    sourceRights,
    markerScan,
    stageManifest,
    stageManifestData,
    sbomData,
    checksumData,
    archiveEntries,
    archive,
  };
}

export function stageCandidate({ root = DEFAULT_ROOT, profileName = "private-full", verifyRebuild = false }) {
  assertFrozenReleaseProfiles(root);
  const profile = loadProfile(root, profileName);
  const output = assertOutputPath(root, candidateDirectory(root, profileName));
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const identity = releaseIdentity(root);
  const profileSourceFiles = trackedFiles(root)
    .filter((path) => profileIncludes(path, profile))
    .map((path) => ({ path, data: trackedBuffer(root, path) }));
  validateReleasePackageVersions({ sourceFiles: profileSourceFiles, version: identity.version });
  const profileFiles = profileSourceFiles.map((file) => ({ path: file.path, bytes: file.data.length, sha256: sha256(file.data) }));
  const sourceOriginInput = validateSourceOriginLedger({ root, files: profileFiles, commit });
  const sourceRightsInput = sourceRightsState(root, profileFiles, profile.visibility);
  const staged = candidateSourceFiles(profileSourceFiles, profile.visibility);
  const sourceFiles = staged.files;
  const files = sourceFiles.map((file) => ({ path: file.path, bytes: file.data.length, sha256: sha256(file.data) }));
  const transformations = staged.publicPackage?.manifests || [];
  const releaseEvidence = candidateEvidence(root, profile.visibility, files, transformations);
  const evidenceData = (path) => releaseEvidence.find((entry) => entry.path === path)?.data ?? null;
  const stagedSourceOrigin = profile.visibility === "public"
    ? validateSourceOriginLedger({
      root,
      files,
      commit,
      ledgerData: evidenceData("release/source-origin-ledger.json"),
      ledgerPath: "release/source-origin-ledger.json",
      transformations,
    })
    : sourceOriginInput;
  const stagedSourceRights = profile.visibility === "public"
    ? sourceRightsState(root, files, profile.visibility, {
      manifestData: evidenceData("release/source-rights.manifest.json"),
      manifestPath: "release/source-rights.manifest.json",
      transformations,
    })
    : sourceRightsInput;
  const sourceOrigin = {
    ...stagedSourceOrigin,
    sourceInput: {
      ledgerPath: sourceOriginInput.ledgerPath,
      ledgerSha256: sourceOriginInput.ledgerSha256 || null,
      passed: sourceOriginInput.passed,
    },
    passed: sourceOriginInput.passed && stagedSourceOrigin.passed,
  };
  const sourceRights = {
    ...stagedSourceRights,
    sourceInput: {
      manifestPath: sourceRightsInput.manifestPath || null,
      manifestSha256: sourceRightsInput.manifestSha256 || null,
      passed: sourceRightsInput.passed,
    },
    passed: sourceRightsInput.passed && stagedSourceRights.passed,
  };
  const markerScan = scanCandidateEntries(sourceFiles, profile.visibility);
  const stageManifest = {
    schema: "morrow.candidate-stage.v1",
    candidateName: candidateName(profileName, identity.version),
    version: identity.version,
    versionSource: { path: "package.json", sha256: identity.packageSha256 },
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
    candidateName: candidateName(profileName, identity.version),
    sourceFiles,
    evidence: releaseEvidence,
    version: identity.version,
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
  const archivePath = resolve(output, `${candidateName(profileName, identity.version)}.zip`);
  writeFileSync(archivePath, archive, { mode: 0o600 });
  const deterministicRebuild = verifyRebuild
    ? independentCandidateRebuild({ root, profileName, commit, tree, expectedDigest: archiveDigest })
    : { verified: false };
  const binding = currentEvidenceBinding(root, { profileName, packageDigest: archiveDigest });
  const externalReceipts = externalReceiptState(root, binding, profile);
  const promotionReceipts = promotionReceiptState(root, binding, profile);
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
    ...(deterministicRebuild.verified ? [] : ["deterministic_rebuild_missing"]),
  ].sort();
  const receipt = {
    schema: "morrow.release-receipt.v1",
    candidateName: candidateName(profileName, identity.version),
    version: identity.version,
    versionSource: { path: "package.json", sha256: identity.packageSha256 },
    profile: profileName,
    packagePath: relative(root, archivePath),
    packageDigest: archiveDigest,
    packageBytes: archive.length,
    commit,
    tree,
    stageManifestDigest: sha256(stageManifestData),
    sbomDigest: sha256(sbomData),
    checksumsDigest: sha256(checksumData),
    deterministicRebuild,
    sourceOrigin,
    sourceRights,
    markerScan,
    externalReceipts,
    promotionReceipts,
    zeroTolerance,
    browserHarness,
    localEvidenceOnly: true,
    candidateBuilt: markerScan.passed && sourceOrigin.passed && sourceRights.passed,
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
  assertFrozenReleaseProfiles(root);
  const receipt = readCandidateReceipt(root, profileName);
  if (!receipt) throw new Error(`No ${profileName} candidate receipt exists. Run package:rc first.`);
  const expected = expectedCandidateGraph(root, profileName);
  const output = candidateDirectory(root, profileName);
  const expectedArchivePath = resolve(output, `${expected.stageManifest.candidateName}.zip`);
  const expectedPackagePath = relative(root, expectedArchivePath);
  const stageManifestPath = resolve(candidateDirectory(root, profileName), "stage/release/stage-manifest.json");
  const stageManifestData = readExpectedCandidateFile(stageManifestPath, expected.stageManifestData, "Candidate stage manifest");
  const manifest = JSON.parse(stageManifestData.toString("utf8"));
  const stageRoot = resolve(candidateDirectory(root, profileName), "stage");
  const sourceFiles = expected.sourceFiles.map((file) => ({
    path: file.path,
    data: readExpectedCandidateFile(resolve(stageRoot, file.path), file.data, `Staged candidate file ${file.path}`),
  }));
  const releaseEvidence = expected.releaseEvidence.map((evidence) => ({
    path: evidence.path,
    data: readExpectedCandidateFile(resolve(stageRoot, evidence.path), evidence.data, `Staged release evidence ${evidence.path}`),
  }));
  const releaseFiles = [
    {
      path: "release/checksums.sha256",
      data: readExpectedCandidateFile(resolve(stageRoot, "release/checksums.sha256"), expected.checksumData, "Candidate checksums"),
    },
    {
      path: "release/sbom.cdx.json",
      data: readExpectedCandidateFile(resolve(stageRoot, "release/sbom.cdx.json"), expected.sbomData, "Candidate SBOM"),
    },
    {
      path: "release/stage-manifest.json",
      data: stageManifestData,
    },
  ];
  const entries = sourceFiles.concat(releaseEvidence, releaseFiles);
  const scan = scanCandidateEntries(entries, manifest.visibility);
  const expectedArchive = deterministicZip(entries);
  const archiveMatches = existsSync(expectedArchivePath)
    && readExpectedCandidateFile(expectedArchivePath, expected.archive, "Candidate archive").equals(expectedArchive)
    && expectedArchive.equals(expected.archive);
  const sourceFilesMatch = sourceFiles.length === expected.sourceFiles.length
    && sourceFiles.every((file, index) => file.path === expected.sourceFiles[index].path
      && file.data.equals(expected.sourceFiles[index].data));
  const evidenceMatches = releaseEvidence.length === expected.releaseEvidence.length
    && releaseEvidence.every((file, index) => file.path === expected.releaseEvidence[index].path
      && file.data.equals(expected.releaseEvidence[index].data));
  const stageManifestMatches = releaseFiles[2].data.equals(expected.stageManifestData);
  const sbomMatches = releaseFiles[1].data.equals(expected.sbomData);
  const checksumsMatch = releaseFiles[0].data.equals(expected.checksumData);
  const checksumContentsMatch = checksumsMatch;
  const files = sourceFiles.map((file) => ({ path: file.path, bytes: file.data.length, sha256: sha256(file.data) }));
  const evidenceData = (path) => releaseEvidence.find((entry) => entry.path === path)?.data ?? null;
  const sourceOrigin = manifest.visibility === "public"
    ? validateSourceOriginLedger({
      root,
      files,
      commit: expected.commit,
      ledgerData: evidenceData("release/source-origin-ledger.json"),
      ledgerPath: "release/source-origin-ledger.json",
      transformations: expected.transformations,
    })
    : expected.sourceOrigin;
  const sourceRights = manifest.visibility === "public"
    ? sourceRightsState(root, files, manifest.visibility, {
      manifestData: evidenceData("release/source-rights.manifest.json"),
      manifestPath: "release/source-rights.manifest.json",
      transformations: expected.transformations,
    })
    : expected.sourceRights;
  const receiptMatches = receipt.schema === "morrow.release-receipt.v1"
    && receipt.profile === profileName
    && receipt.candidateName === expected.stageManifest.candidateName
    && receipt.version === expected.identity.version
    && receipt.versionSource?.path === "package.json"
    && receipt.versionSource?.sha256 === expected.identity.packageSha256
    && receipt.commit === expected.commit
    && receipt.tree === expected.tree
    && receipt.packagePath === expectedPackagePath
    && receipt.packageDigest === sha256(expected.archive)
    && receipt.packageBytes === expected.archive.length
    && receipt.stageManifestDigest === sha256(expected.stageManifestData)
    && receipt.sbomDigest === sha256(expected.sbomData)
    && receipt.checksumsDigest === sha256(expected.checksumData);
  const report = {
    schema: "morrow.package-scan-report.v1",
    profile: profileName,
    candidateName: receipt.candidateName,
    packageDigest: receipt.packageDigest,
    receiptMatches,
    archiveMatches,
    sourceFilesMatch,
    evidenceMatches,
    stageManifestMatches,
    sbomMatches,
    checksumsMatch,
    checksumContentsMatch,
    sourceOrigin,
    sourceRights,
    scan,
    passed: receiptMatches && archiveMatches && sourceFilesMatch && evidenceMatches && stageManifestMatches && sbomMatches && checksumsMatch
      && checksumContentsMatch && sourceOrigin.passed && sourceRights.passed && scan.passed,
  };
  writeJson(resolve(root, "artifacts/release", `package-scan-${profileName}.json`), report);
  return report;
}

export function conformanceReport({ root = DEFAULT_ROOT, profileName = "private-full" }) {
  const identity = releaseIdentity(root);
  const profile = loadProfile(root, profileName);
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
  const currentBinding = currentEvidenceBinding(root);
  const currentExternalReceipts = externalReceiptState(root, currentBinding, profile);
  const currentPromotionReceipts = promotionReceiptState(root, currentBinding, profile);
  const checks = [
    { id: "candidate_version", passed: receipt?.version === identity.version
      && receipt?.versionSource?.path === "package.json" && receipt?.versionSource?.sha256 === identity.packageSha256 },
    { id: "frozen_lockfile_tracked", passed: lockTracked },
    { id: "appendix_c_path_map", passed: appendix.passed },
    { id: "candidate_receipt", passed: receipt !== null },
    { id: "candidate_bound_to_head", passed: receipt?.commit === currentCommit && receipt?.tree === currentTree },
    { id: "candidate_package_integrity", passed: packageScan?.passed === true },
    { id: "candidate_independent_rebuild", passed: receipt?.deterministicRebuild?.verified === true
      && receipt?.deterministicRebuild?.digest === receipt?.packageDigest },
    { id: "other_profile_candidate_receipt", passed: otherReceipt !== null },
    { id: "other_profile_bound_to_head", passed: otherReceipt?.commit === currentCommit && otherReceipt?.tree === currentTree },
    { id: "other_profile_package_integrity", passed: otherPackageScan?.passed === true },
    { id: "other_profile_independent_rebuild", passed: otherReceipt?.deterministicRebuild?.verified === true
      && otherReceipt?.deterministicRebuild?.digest === otherReceipt?.packageDigest },
    { id: "candidate_marker_scan", passed: receipt?.markerScan?.passed === true },
    { id: "source_origin_ledger", passed: receipt?.sourceOrigin?.passed === true },
    { id: "source_rights", passed: receipt?.sourceRights?.passed === true },
    { id: "external_live_receipts", passed: currentExternalReceipts.passed },
    { id: "zero_tolerance_receipt", passed: receipt?.zeroTolerance?.passed === true },
    { id: "browser_harness_receipt", passed: receipt?.browserHarness?.passed === true },
    { id: "candidate_promotable", passed: receipt?.promotable === true },
    { id: "promotion_receipts", passed: currentPromotionReceipts.passed },
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
