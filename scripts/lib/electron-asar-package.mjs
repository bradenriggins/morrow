import { TextDecoder } from "node:util";
import { readExactTrustFile } from "./exact-trust-file.mjs";

const MAX_ASAR_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024;

function safeWhole(value, label) {
  const number = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid.`);
  return number;
}

/** Reads the packaged package.json from one bounded, identity-stable Electron ASAR. */
export function readElectronAsarPackage(archive) {
  const data = readExactTrustFile(archive, { label: "Electron ASAR", maxBytes: MAX_ASAR_BYTES });
  if (data.byteLength < 20 || data.readUInt32LE(0) !== 4) throw new Error("Electron ASAR header is invalid.");
  const headerLength = data.readUInt32LE(4);
  if (headerLength < 12 || headerLength > data.byteLength - 8) throw new Error("Electron ASAR metadata length is invalid.");
  const header = data.subarray(8, 8 + headerLength);
  if (header.readUInt32LE(0) + 4 !== header.length) throw new Error("Electron ASAR metadata is invalid.");
  const jsonLength = header.readUInt32LE(4);
  if (jsonLength < 2 || jsonLength > header.length - 8) throw new Error("Electron ASAR tree length is invalid.");
  let tree;
  try {
    tree = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header.subarray(8, 8 + jsonLength)));
  } catch {
    throw new Error("Electron ASAR tree is invalid.");
  }
  const entry = tree?.files?.["package.json"];
  if (!entry || entry.unpacked === true) throw new Error("Electron ASAR has no packaged package.json.");
  const entrySize = safeWhole(entry.size, "Electron ASAR package.json size");
  const entryOffset = safeWhole(entry.offset, "Electron ASAR package.json offset");
  const offset = 8 + headerLength + entryOffset;
  if (entrySize > MAX_PACKAGE_BYTES || offset < 0 || offset + entrySize > data.byteLength) {
    throw new Error("Electron ASAR package.json range is invalid.");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset, offset + entrySize)));
  } catch {
    throw new Error("Electron ASAR package.json is invalid.");
  }
}

export function electronAsarReleaseIdentity(applicationPackage, binding) {
  const releaseGraph = applicationPackage?.morrow?.releaseGraph;
  if (releaseGraph?.schema !== "morrow.desktop-packager-admission.v1"
    || releaseGraph.sourceHead !== binding.sourceCommit
    || releaseGraph.sha256 !== binding.releaseGraphSha256) {
    throw new Error("Installed Morrow does not carry the retained package receipt's source and release graph.");
  }
  return Object.freeze({ sourceCommit: releaseGraph.sourceHead, releaseGraphSha256: releaseGraph.sha256 });
}
