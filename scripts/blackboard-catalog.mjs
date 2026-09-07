#!/usr/bin/env node

// Writes artifacts/blackboard/blackboard-rest-catalog.json from the Blackboard
// operation registry: one row for each registered tool.
//   node scripts/blackboard-catalog.mjs           writes the catalog
//   node scripts/blackboard-catalog.mjs --check    fails when it is stale
// The registry is TypeScript, so build the package first:
//   pnpm --dir packages/blackboard-learn-api build

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const library = resolve(root, "packages/blackboard-learn-api/dist/library.js");
const output = resolve(root, "artifacts/blackboard/blackboard-rest-catalog.json");

if (!existsSync(library)) {
  throw new Error("The Blackboard package is not built. Run pnpm --dir packages/blackboard-learn-api build first.");
}
const { blackboardRestCatalog } = await import(pathToFileURL(library).href);
const catalog = blackboardRestCatalog();
const text = JSON.stringify(catalog, null, 2) + "\n";

if (check) {
  const current = await readFile(output, "utf8").catch(() => "");
  if (current !== text) {
    throw new Error(`The generated Blackboard REST catalog is stale: ${output}. Run node scripts/blackboard-catalog.mjs.`);
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, text, "utf8");
}

process.stdout.write(JSON.stringify({ check, output, tools: catalog.counts.tools, writes: catalog.counts.writes }) + "\n");
