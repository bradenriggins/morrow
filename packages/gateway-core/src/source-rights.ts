import { createHash } from "node:crypto";
import { SOURCE_DISPOSITIONS, type SourceDisposition } from "./privacy.js";

export interface SourceRightsRecord {
  readonly path: string;
  readonly sha256: string;
  readonly disposition: SourceDisposition;
  readonly review: string;
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
]);
const PRIVATE_MARKER = new RegExp(`(?:${["ch", "cp"].join("")}|${["meridian", "vps"].join("-")})`, "i");

function exactPath(value: unknown): string {
  const path = typeof value === "string" ? value.trim().replaceAll("\\", "/") : "";
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("source rights path is invalid");
  }
  return path;
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
    const sha256 = typeof record.sha256 === "string" ? record.sha256.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError(`source rights digest is invalid for ${path}`);
    const review = typeof record.review === "string" ? record.review.trim() : "";
    if (!review || review.length > 500) throw new TypeError(`source rights review is invalid for ${path}`);
    if (paths.has(path)) throw new TypeError(`source rights path is duplicated: ${path}`);
    paths.add(path);
    return { path, sha256, disposition, review };
  });
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
