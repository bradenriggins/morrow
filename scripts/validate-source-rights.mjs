#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { validatePublicAssemblyInputs } from "../packages/gateway-core/dist/index.js";

function valueAfter(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function options(args) {
  let manifest = "";
  let inputs = "";
  let root = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--manifest") manifest = valueAfter(args, index++, flag);
    else if (flag === "--inputs") inputs = valueAfter(args, index++, flag);
    else if (flag === "--root") root = valueAfter(args, index++, flag);
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!manifest || !inputs) throw new Error("Usage: validate-source-rights.mjs --manifest <manifest.json> --inputs <inputs.json> [--root <repo>]");
  return { manifest: resolve(manifest), inputs: resolve(inputs), root: resolve(root) };
}

function withinRoot(root, path) {
  const candidate = resolve(root, path);
  const relation = relative(root, candidate);
  if (!relation || relation.startsWith("../") || relation === "..") {
    throw new Error(`Public assembly input is outside the repository root: ${path}`);
  }
  return { path: relation.replaceAll("\\", "/"), candidate };
}

async function main() {
  const option = options(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(option.manifest, "utf8"));
  const input = JSON.parse(await readFile(option.inputs, "utf8"));
  if (!input || typeof input !== "object" || !Array.isArray(input.files)) {
    throw new Error("inputs must use an object with a files array");
  }
  const files = await Promise.all(input.files.map(async (path) => {
    const resolved = withinRoot(option.root, String(path));
    return { path: resolved.path, bytes: await readFile(resolved.candidate) };
  }));
  validatePublicAssemblyInputs(manifest, files);
  process.stdout.write(`public-source-rights=ok files=${files.length}\n`);
}

main().catch((error) => {
  process.stderr.write(`[morrow-source-rights] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
