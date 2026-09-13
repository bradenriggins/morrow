import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_PATH = resolve(ROOT, "connector/extension/generated/moodle-browser-catalog.json");
export const MAX_MOODLE_JSON_INTEGER = Number.MAX_SAFE_INTEGER;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSchema(value, state) {
  if (Array.isArray(value)) {
    for (const entry of value) normalizeSchema(entry, state);
    return;
  }
  if (!isObject(value)) return;
  if (value.type === "integer") {
    if (Array.isArray(value.enum)) {
      if (!value.enum.every((entry) => Number.isSafeInteger(entry))) {
        throw new Error("Moodle browser catalog has an integer enum outside JavaScript's exact integer range.");
      }
    } else {
      if (value.minimum !== undefined && !Number.isSafeInteger(value.minimum)) {
        throw new Error("Moodle browser catalog has an inexact integer minimum.");
      }
      if (value.maximum === undefined || value.maximum > MAX_MOODLE_JSON_INTEGER) {
        value.maximum = MAX_MOODLE_JSON_INTEGER;
        state.changes += 1;
      } else if (!Number.isSafeInteger(value.maximum)) {
        throw new Error("Moodle browser catalog has an inexact integer maximum.");
      }
    }
  }
  for (const entry of Object.values(value)) normalizeSchema(entry, state);
}

export function normalizedMoodleIdentifierCatalog(value) {
  if (!isObject(value) || value.schema !== "morrow.browser-catalog.v1" || value.provider !== "moodle" || !Array.isArray(value.operations)) {
    throw new Error("Moodle browser catalog is invalid.");
  }
  const catalog = structuredClone(value);
  const state = { changes: 0 };
  for (const operation of catalog.operations) {
    if (!isObject(operation) || !isObject(operation.inputSchema)) throw new Error("Moodle browser catalog operation is invalid.");
    normalizeSchema(operation.inputSchema, state);
  }
  return { catalog, changes: state.changes };
}

export function synchronizedMoodleIdentifierCatalog() {
  const before = readFileSync(TARGET_PATH, "utf8");
  const parsed = JSON.parse(before);
  const { catalog, changes } = normalizedMoodleIdentifierCatalog(parsed);
  return { before, after: `${JSON.stringify(catalog, null, 2)}\n`, changes };
}

export function syncMoodleIdentifierContract({ check = false } = {}) {
  const synchronized = synchronizedMoodleIdentifierCatalog();
  if (check) {
    if (synchronized.before !== synchronized.after) {
      throw new Error("moodle-browser-catalog.json has an unsafe or stale integer contract. Run node scripts/sync-moodle-identifier-contract.mjs.");
    }
    return { check: true, target: TARGET_PATH };
  }
  if (synchronized.before !== synchronized.after) writeFileSync(TARGET_PATH, synchronized.after);
  return { check: false, target: TARGET_PATH, changes: synchronized.changes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(syncMoodleIdentifierContract({ check: process.argv.includes("--check") })));
}
