#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseSourceCatalog } from "../packages/gateway-core/dist/index.js";

async function main() {
  const paths = process.argv.length > 2
    ? process.argv.slice(2)
    : ["artifacts/catalogs/example-legacy.canvas.json", "artifacts/catalogs/meridian.live.json"];
  if (paths.length < 2) throw new Error("Provide at least two source catalog paths");
  const catalogs = await Promise.all(paths.map(async (path) => (
    parseSourceCatalog(JSON.parse(await readFile(resolve(path), "utf8")))
  )));
  const duplicates = new Set();
  for (const catalog of catalogs) {
    if (duplicates.has(catalog.source.id)) throw new Error(`Duplicate catalog source ${catalog.source.id}`);
    duplicates.add(catalog.source.id);
  }
  process.stdout.write(catalogs.map((catalog) => (
    `${catalog.source.id}\t${catalog.count}\t${catalog.digest}`
  )).join("\n") + "\n");
}

main().catch((error) => {
  process.stderr.write(`[morrow-catalog-check] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
