#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildPublicationManifestCandidate,
  parseSourceCatalog,
} from "../packages/gateway-core/dist/index.js";
import { sha256Json } from "../packages/contracts/dist/index.js";

function usage() {
  return [
    "Usage: node scripts/create-publication-policy.mjs --source <catalog.json> [--source <catalog.json> ...] --selection <selections.json> --out <policy.json> [--force]",
    "",
    "The selection file must use morrow.publication-selections.v1 and name every public tool, source, and exact source tool explicitly.",
    "This command does not infer aliases, include source-only tools automatically, or publish held providers.",
    "",
  ].join("\n");
}

function nextValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args) {
  const sourcePaths = [];
  let selectionPath = "";
  let outputPath = "";
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (flag === "--force") {
      force = true;
      continue;
    }
    const value = nextValue(args, index, flag);
    index += 1;
    if (flag === "--source") sourcePaths.push(resolve(value));
    else if (flag === "--selection") selectionPath = resolve(value);
    else if (flag === "--out") outputPath = resolve(value);
    else throw new Error(`Unknown option ${flag}`);
  }
  if (sourcePaths.length === 0) throw new Error("At least one --source catalog is required");
  if (!selectionPath) throw new Error("--selection is required");
  if (!outputPath) throw new Error("--out is required");
  return { sourcePaths, selectionPath, outputPath, force };
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label} ${path}`, { cause: error });
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomic(path, content, force) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await chmod(dirname(path), 0o700); } catch { /* best effort */ }
  if (!force && await exists(path)) {
    throw new Error(`Refusing to overwrite ${path} without --force`);
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { await chmod(temporary, 0o600); } catch { /* best effort */ }
    await rename(temporary, path);
    try { await chmod(path, 0o600); } catch { /* best effort */ }
  } catch (error) {
    try { await unlink(temporary); } catch { /* preserve original error */ }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceCatalogs = await Promise.all(options.sourcePaths.map(async (path) => (
    parseSourceCatalog(await readJson(path, "source catalog"))
  )));
  const selections = await readJson(options.selectionPath, "publication selections");
  const manifest = buildPublicationManifestCandidate(sourceCatalogs, selections);
  await writeAtomic(
    options.outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    options.force,
  );
  process.stdout.write([
    `output=${options.outputPath}`,
    `sources=${manifest.sources.length}`,
    `tools=${manifest.tools.length}`,
    `manifestDigest=${sha256Json(manifest)}`,
    "",
  ].join("\n"));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[morrow-publication] ${message}\n\n${usage()}`);
  process.exitCode = 1;
});
