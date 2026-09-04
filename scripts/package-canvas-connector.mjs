#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deterministicZip, stableJson } from "./lib/release-candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(root, "connector/extension");
const outputRoot = resolve(root, "artifacts/connector");
const archivePath = resolve(outputRoot, "morrow-canvas-connector-v1.0.0.zip");
const receiptPath = resolve(outputRoot, "receipt.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
    });
}

function extensionId(publicKey) {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((value) => String.fromCharCode(97 + value)).join("");
}

const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8"));
const sourceFiles = files(extensionRoot).map((path) => ({
  path: relative(extensionRoot, path).replaceAll("\\", "/"),
  data: readFileSync(path),
}));
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
  files: sourceFiles.map((entry) => ({ path: entry.path, bytes: entry.data.byteLength, sha256: sha256(entry.data) })),
};
const receiptBytes = stableJson(receipt);

if (process.argv.includes("--check")) {
  const existingArchive = readFileSync(archivePath);
  const existingReceipt = readFileSync(receiptPath, "utf8");
  if (!existingArchive.equals(archive) || existingReceipt !== receiptBytes) throw new Error("Canvas connector package is stale");
} else {
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(archivePath, archive, { mode: 0o600 });
  writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
}

if (!statSync(archivePath).isFile()) throw new Error("Canvas connector archive was not created");
process.stdout.write(`${JSON.stringify(receipt)}\n`);
