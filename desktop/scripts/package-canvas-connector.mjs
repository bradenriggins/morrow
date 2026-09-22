#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deterministicZip, stableJson } from "./lib/deterministic-archive.mjs";
import { bridgeReleaseManifest, captureBridgeRelease } from "./package-mcp-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(root, "connector/extension");
const outputRoot = resolve(root, "artifacts/connector");
const receiptPath = resolve(outputRoot, "receipt.json");
const releaseLedgerPath = resolve(root, "connector/release-ledger.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function extensionId(publicKey) {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((value) => String.fromCharCode(97 + value)).join("");
}

const bridge = captureBridgeRelease(extensionRoot);
const manifest = bridge.extensionManifest;
const sealedRelease = bridgeReleaseManifest(extensionRoot);
const sealedReleaseSha256 = sha256(`${JSON.stringify(sealedRelease, null, 2)}\n`);
const releaseLedger = JSON.parse(readFileSync(releaseLedgerPath, "utf8"));
if (releaseLedger?.schema !== "morrow.bridge-release-ledger.v1" || !Array.isArray(releaseLedger.releases)
  || releaseLedger.releases.length === 0) throw new Error("Morrow Bridge release ledger is invalid");
const currentRelease = releaseLedger.releases.at(-1);
if (currentRelease?.version !== manifest.version || currentRelease?.releaseManifestSha256 !== sealedReleaseSha256) {
  throw new Error("Morrow Bridge source changed without a new sealed release ledger entry");
}
const archivePath = resolve(outputRoot, `morrow-canvas-connector-v${manifest.version}.zip`);
const plannerPath = resolve(extensionRoot, "generated/canvas-readback-plan.js");
const builtPlannerPath = resolve(root, "packages/canvas-api-catalog/dist/readback-plan.js");
const admissionPath = resolve(extensionRoot, "generated/canvas-operation-admission.js");
const builtAdmissionPath = resolve(root, "packages/canvas-api-catalog/dist/operation-admission.js");
const sourceFiles = bridge.files;
const planner = readFileSync(plannerPath, "utf8");
const builtPlanner = readFileSync(builtPlannerPath, "utf8").replace(/\n\/\/# sourceMappingURL=.*(?:\n|$)/, "\n");
const admission = readFileSync(admissionPath, "utf8");
const builtAdmission = readFileSync(builtAdmissionPath, "utf8")
  .replace(/\n\/\/# sourceMappingURL=.*(?:\n|$)/, "\n")
  .replaceAll('from "./readback-plan.js"', 'from "./canvas-readback-plan.js"')
  .replaceAll('from "./semantic-target.js"', 'from "./canvas-semantic-target.js"');
if (planner !== builtPlanner) throw new Error("Generated Canvas readback planner is stale");
if (/\bnode:|\brequire\s*\(/.test(planner) || !/export\s+function\s+planBrowserReadback/.test(planner)) {
  throw new Error("Generated Canvas readback planner is not browser-safe ESM");
}
if (admission !== builtAdmission) throw new Error("Generated Canvas operation admission module is stale");
if (/\bnode:|\brequire\s*\(/.test(admission) || !/export\s+function\s+canvasOperationAdmission/.test(admission)) {
  throw new Error("Generated Canvas operation admission module is not browser-safe ESM");
}
const archive = deterministicZip(sourceFiles);
const catalog = JSON.parse(readFileSync(resolve(extensionRoot, "generated/canvas-api-catalog.json"), "utf8"));
const receipt = {
  schema: "morrow.canvas-connector-package.v1",
  name: manifest.name,
  version: manifest.version,
  manifestVersion: manifest.manifest_version,
  extensionId: extensionId(manifest.key),
  catalogDigest: catalog.catalogDigest,
  operationCount: catalog.counts.totalOperations,
  newQuizzesOperationCount: catalog.counts.newQuizzesOperations,
  itemBankOperationCount: catalog.counts.itemBankOperations,
  archive: relative(root, archivePath).replaceAll("\\", "/"),
  archiveSha256: sha256(archive),
  archiveBytes: archive.byteLength,
  sourceManifestSha256: sha256(stableJson(sourceFiles.map((entry) => ({ path: entry.path, bytes: entry.data.byteLength, sha256: sha256(entry.data) })))),
  files: sourceFiles.map((entry) => ({ path: entry.path, bytes: entry.data.byteLength, sha256: sha256(entry.data) })),
};
const receiptBytes = stableJson(receipt);
const checking = process.argv.includes("--check");

if (checking) {
  const rebuilt = deterministicZip(sourceFiles);
  if (!rebuilt.equals(archive) || sha256(rebuilt) !== receipt.archiveSha256) {
    throw new Error("Canvas connector package rebuild is not deterministic");
  }
} else {
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(archivePath, archive, { mode: 0o600 });
  writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
}

if (!checking && !statSync(archivePath).isFile()) throw new Error("Canvas connector archive was not created");
process.stdout.write(`${JSON.stringify({ ...receipt, check: checking })}\n`);
