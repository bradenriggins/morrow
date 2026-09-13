import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readExactTrustFile } from "./exact-trust-file.mjs";

export const WINDOWS_SMOKE_OBSERVATION_SCHEMA = "morrow.desktop-windows-smoke.v1";
export const WINDOWS_SMOKE_EVIDENCE_SCHEMA = "morrow.desktop-windows-smoke-evidence.v1";
export const WINDOWS_SMOKE_BINDING_SCHEMA = "morrow.desktop-windows-smoke-binding.v2";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const RUN_ID_PATTERN = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const MAX_PACKAGE_RECEIPT_BYTES = 1024 * 1024;
const MAX_WINDOWS_INSTALLER_BYTES = 1024 * 1024 * 1024;

function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

export function isWindowsSmokeBinding(value, expected = {}) {
  if (!exactKeys(value, ["schema", "runId", "sourceCommit", "packageReceipt", "releaseGraphSha256", "installer"])) return false;
  if (!exactKeys(value.packageReceipt, ["fileName", "sha256"])) return false;
  if (!exactKeys(value.installer, ["fileName", "sha256"])) return false;
  if (value.schema !== WINDOWS_SMOKE_BINDING_SCHEMA
    || !RUN_ID_PATTERN.test(value.runId)
    || !SOURCE_COMMIT_PATTERN.test(value.sourceCommit)
    || value.packageReceipt.fileName !== "package-receipt.json"
    || !SHA256_PATTERN.test(value.packageReceipt.sha256)
    || !SHA256_PATTERN.test(value.releaseGraphSha256)
    || typeof value.installer.fileName !== "string"
    || value.installer.fileName.length === 0
    || /[\\/]/.test(value.installer.fileName)
    || !SHA256_PATTERN.test(value.installer.sha256)) return false;
  return (expected.runId === undefined || value.runId === expected.runId)
    && (expected.sourceCommit === undefined || value.sourceCommit === expected.sourceCommit)
    && (expected.packageReceiptSha256 === undefined || value.packageReceipt.sha256 === expected.packageReceiptSha256)
    && (expected.releaseGraphSha256 === undefined || value.releaseGraphSha256 === expected.releaseGraphSha256)
    && (expected.installerFileName === undefined || value.installer.fileName === expected.installerFileName)
    && (expected.installerSha256 === undefined || value.installer.sha256 === expected.installerSha256);
}

export function createWindowsSmokeBinding({ runId, sourceCommit, packageReceiptSha256, releaseGraphSha256, installerFileName, installerSha256 }) {
  const binding = {
    schema: WINDOWS_SMOKE_BINDING_SCHEMA,
    runId: String(runId).toLowerCase(),
    sourceCommit: String(sourceCommit).toLowerCase(),
    packageReceipt: { fileName: "package-receipt.json", sha256: String(packageReceiptSha256).toLowerCase() },
    releaseGraphSha256: String(releaseGraphSha256).toLowerCase(),
    installer: { fileName: String(installerFileName), sha256: String(installerSha256).toLowerCase() },
  };
  if (!isWindowsSmokeBinding(binding)) throw new Error("Windows smoke evidence requires one exact run, package receipt, release graph, source commit, installer name, and installer SHA-256.");
  return binding;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Binds Windows smoke evidence to the package orchestrator's sealed release graph. */
export function createWindowsSmokeBindingFromPackage({ runId, sourceCommit, packageReceipt, installer }) {
  const requestedSource = String(sourceCommit).toLowerCase();
  const requestedRun = String(runId).toLowerCase();
  if (!SOURCE_COMMIT_PATTERN.test(requestedSource) || !RUN_ID_PATTERN.test(requestedRun)
    || basename(packageReceipt) !== "package-receipt.json"
    || dirname(resolve(packageReceipt)) !== dirname(resolve(installer))) {
    throw new Error("Windows smoke inputs must name one retained package receipt, installer, source, and run.");
  }
  const receiptBytes = readExactTrustFile(packageReceipt, {
    label: "Windows package receipt",
    maxBytes: MAX_PACKAGE_RECEIPT_BYTES,
  });
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    throw new Error("Windows package receipt is not valid JSON.");
  }
  const artifact = Array.isArray(receipt?.artifacts) && receipt.artifacts.length === 1
    ? receipt.artifacts[0]
    : null;
  const expectedName = `Morrow-${receipt?.version}-win-x64.exe`;
  if (receipt?.schema !== "morrow.desktop-installer.v1"
    || !/^\d+\.\d+\.\d+$/.test(receipt.version || "")
    || receipt.target !== "win32-x64"
    || receipt.source?.head !== requestedSource
    || receipt.source?.dirty !== false
    || receipt.payload?.releaseGraph?.schema !== "morrow.desktop-packager-admission.v1"
    || !SHA256_PATTERN.test(receipt.payload?.releaseGraph?.sha256 || "")
    || receipt.signing?.mode !== "unsigned_private_qa"
    || receipt.signing?.target !== "win32-x64"
    || receipt.signing?.publicRelease !== false
    || receipt.signing?.artifactSignature !== "authenticode_absent"
    || !artifact
    || artifact.name !== expectedName
    || !SHA256_PATTERN.test(artifact.sha256 || "")
    || basename(installer) !== artifact.name) {
    throw new Error("Windows package receipt is not the expected unsigned QA release graph.");
  }
  const installerBytes = readExactTrustFile(installer, {
    label: "Windows installer",
    maxBytes: MAX_WINDOWS_INSTALLER_BYTES,
  });
  const installerSha256 = sha256(installerBytes);
  if (installerSha256 !== artifact.sha256) throw new Error("Retained Windows installer changed after packaging.");
  return createWindowsSmokeBinding({
    runId: requestedRun,
    sourceCommit: requestedSource,
    packageReceiptSha256: sha256(receiptBytes),
    releaseGraphSha256: receipt.payload.releaseGraph.sha256,
    installerFileName: artifact.name,
    installerSha256,
  });
}

export function bindWindowsSmokeObservation(observation, binding) {
  if (!exactKeys(observation, ["schema", "runtime", "payload", "state", "codexConfig", "health", "runtimeTrace", "stateSecurity"])
    || observation.schema !== WINDOWS_SMOKE_OBSERVATION_SCHEMA
    || !isWindowsSmokeBinding(binding)) {
    throw new Error("Windows smoke evidence can bind only an exact application observation and release identity.");
  }
  return { schema: WINDOWS_SMOKE_EVIDENCE_SCHEMA, binding, observation };
}

export function windowsSmokeObservation(value, expectedBinding = {}) {
  if (!exactKeys(value, ["schema", "binding", "observation"])
    || value.schema !== WINDOWS_SMOKE_EVIDENCE_SCHEMA
    || !isWindowsSmokeBinding(value.binding, expectedBinding)
    || !exactKeys(value.observation, ["schema", "runtime", "payload", "state", "codexConfig", "health", "runtimeTrace", "stateSecurity"])
    || value.observation.schema !== WINDOWS_SMOKE_OBSERVATION_SCHEMA) return null;
  return value.observation;
}
