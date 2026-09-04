#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const HELD = /(?:^|[^a-z0-9])(mindtap|connect)(?:[_-][a-z0-9_-]+)?/gi;
const ALLOWED_POLICY_FIELDS = new Set(["excludeNames", "excludePrefixes", "heldProviderIds"]);

function heldTokens(value) {
  return [...String(value).matchAll(HELD)].map((match) => match[0].trim().toLowerCase());
}

function jsonMatches(value, path = "$") {
  if (typeof value === "string") {
    return heldTokens(value).map((token) => ({ path, token }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => jsonMatches(entry, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => (
    ALLOWED_POLICY_FIELDS.has(key)
      ? []
      : jsonMatches(entry, `${path}.${key}`)
  ));
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error("Provide catalog, package, schema, source-map, or example paths to scan");
  const matches = [];
  for (const path of paths) {
    const text = await readFile(path, "utf8");
    try {
      for (const match of jsonMatches(JSON.parse(text))) {
        matches.push({ path: `${path}:${match.path}`, token: match.token });
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        for (const token of heldTokens(text)) matches.push({ path, token });
      } else {
        throw error;
      }
    }
  }
  if (matches.length > 0) {
    throw new Error(`Held provider material found: ${matches.map((match) => `${match.path}:${match.token}`).join(", ")}`);
  }
  process.stdout.write(`held-provider-scan=clean inputs=${paths.length}\n`);
}

main().catch((error) => {
  process.stderr.write(`[morrow-held-provider-scan] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
