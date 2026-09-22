#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseCatalogAliasRules,
  parseSourceCatalog,
  reconcileCatalogs,
} from "../packages/gateway-core/dist/index.js";

function parseArguments(argv) {
  const sources = [];
  let aliases = "";
  let output = "artifacts/catalogs/reconciliation.json";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      const value = argv[++index];
      if (!value) throw new Error("--source requires a path");
      sources.push(value);
    } else if (arg === "--aliases") {
      aliases = argv[++index] || "";
      if (!aliases) throw new Error("--aliases requires a path");
    } else if (arg === "--output") {
      output = argv[++index] || "";
      if (!output) throw new Error("--output requires a path");
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  if (sources.length < 2) {
    throw new Error("Provide at least two --source catalog paths");
  }
  return { sources, aliases, output };
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"));
}

async function writeAtomic(path, value) {
  const target = resolve(process.cwd(), path);
  await mkdir(resolve(target, ".."), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return target;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const catalogs = [];
  for (const path of args.sources) catalogs.push(parseSourceCatalog(await readJson(path)));
  const aliases = args.aliases
    ? parseCatalogAliasRules(await readJson(args.aliases))
    : [];
  const report = reconcileCatalogs(catalogs, {
    aliases,
    sourcePriority: catalogs.map((catalog) => catalog.source.id),
  });
  const target = await writeAtomic(args.output, report);
  process.stdout.write([
    `sources=${report.counts.catalogs}`,
    `sourceTools=${report.counts.sourceTools}`,
    `rows=${report.counts.rows}`,
    `compatible=${report.counts.compatible}`,
    `contractDrift=${report.counts.contractDrift}`,
    `reviewRequired=${report.counts.reviewRequired}`,
    `digest=${report.digest}`,
    `wrote=${target}`,
    "",
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`[morrow-catalog-reconcile] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
