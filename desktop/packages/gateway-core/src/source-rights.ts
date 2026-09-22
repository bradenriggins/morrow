import { createHash } from "node:crypto";
import { SOURCE_DISPOSITIONS, type SourceDisposition } from "./privacy.js";

export interface SourceRightsRecord {
  readonly path: string;
  readonly sha256: string;
  readonly disposition: SourceDisposition;
  readonly review: string;
  readonly thirdParty?: ThirdPartySourceEvidence;
}

export interface ThirdPartySourceEvidence {
  readonly assetSha256: string;
  readonly copyright: string;
  readonly license: "SIL-OFL-1.1";
  readonly licensePath: string;
  readonly licenseSha256: string;
  readonly sourceUrl: string;
}

export interface SourceRightsManifest {
  readonly schema: "morrow.source-rights.v1";
  readonly files: readonly SourceRightsRecord[];
}

export interface PublicAssemblyInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const PUBLIC_DISPOSITIONS = new Set<SourceDisposition>([
  "direct_owned",
  "adapted_owned",
  "clean_reimplementation",
  "third_party_redistributable",
]);
const PRIVATE_MARKER = new RegExp(`(?:${["ch", "cp"].join("")}|${["meridian", "vps"].join("-")})`, "i");

function exactPath(value: unknown): string {
  const path = typeof value === "string" ? value.trim().replaceAll("\\", "/") : "";
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("source rights path is invalid");
  }
  return path;
}

function exactSha256(value: unknown, label: string, path: string): string {
  const digest = typeof value === "string" ? value.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError(`${label} is invalid for ${path}`);
  return digest;
}

function thirdPartyEvidence(value: unknown, path: string, assetSha256: string): ThirdPartySourceEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`third-party source evidence is required for ${path}`);
  }
  const evidence = value as Record<string, unknown>;
  const sourceUrl = typeof evidence.sourceUrl === "string" ? evidence.sourceUrl.trim() : "";
  try {
    if (new URL(sourceUrl).protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new TypeError(`third-party source URL is invalid for ${path}`);
  }
  const copyright = typeof evidence.copyright === "string" ? evidence.copyright.trim() : "";
  if (!copyright || copyright.length > 500) throw new TypeError(`third-party copyright is invalid for ${path}`);
  if (evidence.license !== "SIL-OFL-1.1") throw new TypeError(`third-party license is invalid for ${path}`);
  const evidenceAssetSha256 = exactSha256(evidence.assetSha256, "third-party asset digest", path);
  if (evidenceAssetSha256 !== assetSha256) throw new TypeError(`third-party asset digest does not match ${path}`);
  return {
    sourceUrl,
    copyright,
    license: "SIL-OFL-1.1",
    assetSha256: evidenceAssetSha256,
    licensePath: exactPath(evidence.licensePath),
    licenseSha256: exactSha256(evidence.licenseSha256, "third-party license digest", path),
  };
}

export function parseSourceRightsManifest(value: unknown): SourceRightsManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("source rights manifest must be an object");
  const root = value as Record<string, unknown>;
  if (root.schema !== "morrow.source-rights.v1" || !Array.isArray(root.files)) {
    throw new TypeError("source rights manifest has an unsupported schema");
  }
  const paths = new Set<string>();
  const files = root.files.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("source rights record must be an object");
    const record = value as Record<string, unknown>;
    const path = exactPath(record.path);
    const disposition = record.disposition as SourceDisposition;
    if (!SOURCE_DISPOSITIONS.includes(disposition)) throw new TypeError(`source rights disposition is invalid for ${path}`);
    const sha256 = exactSha256(record.sha256, "source rights digest", path);
    const review = typeof record.review === "string" ? record.review.trim() : "";
    if (!review || review.length > 500) throw new TypeError(`source rights review is invalid for ${path}`);
    if (paths.has(path)) throw new TypeError(`source rights path is duplicated: ${path}`);
    paths.add(path);
    const thirdParty = disposition === "third_party_redistributable"
      ? thirdPartyEvidence(record.thirdParty, path, sha256)
      : undefined;
    if (disposition !== "third_party_redistributable" && record.thirdParty !== undefined) {
      throw new TypeError(`third-party source evidence is only valid for third-party content: ${path}`);
    }
    return { path, sha256, disposition, review, ...(thirdParty ? { thirdParty } : {}) };
  });
  const records = new Map(files.map((record) => [record.path, record]));
  for (const record of files) {
    if (!record.thirdParty) continue;
    const licenseRecord = records.get(record.thirdParty.licensePath);
    if (!licenseRecord || licenseRecord.sha256 !== record.thirdParty.licenseSha256) {
      throw new TypeError(`third-party license record is invalid for ${record.path}`);
    }
  }
  return { schema: "morrow.source-rights.v1", files };
}

export function validatePublicAssemblyInputs(
  manifestValue: unknown,
  inputs: readonly PublicAssemblyInput[],
): void {
  const manifest = parseSourceRightsManifest(manifestValue);
  const records = new Map(manifest.files.map((record) => [record.path, record]));
  for (const input of inputs) {
    const path = exactPath(input.path);
    const record = records.get(path);
    if (!record) throw new Error(`public assembly input lacks source-rights record: ${path}`);
    if (!PUBLIC_DISPOSITIONS.has(record.disposition)) {
      throw new Error(`public assembly input has blocked disposition ${record.disposition}: ${path}`);
    }
    const bytes = Buffer.from(input.bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
      throw new Error(`public assembly input digest drift: ${path}`);
    }
    if (PRIVATE_MARKER.test(bytes.toString("utf8"))) {
      throw new Error(`public assembly input contains a private marker: ${path}`);
    }
  }
}
