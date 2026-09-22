#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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
  return {
    manifest: resolve(manifest || resolve(root, "config/source-rights.manifest.json")),
    inputs: inputs ? resolve(inputs) : "",
    root: resolve(root),
  };
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
  let files;
  if (option.inputs) {
    const input = JSON.parse(await readFile(option.inputs, "utf8"));
    if (!input || typeof input !== "object" || !Array.isArray(input.files)) {
      throw new Error("inputs must use an object with a files array");
    }
    files = await Promise.all(input.files.map(async (path) => {
      const resolved = withinRoot(option.root, String(path));
      return { path: resolved.path, bytes: await readFile(resolved.candidate) };
    }));
  } else {
    const profileConfig = JSON.parse(await readFile(resolve(option.root, "config/release-profiles.json"), "utf8"));
    const profile = profileConfig.profiles?.["public-canvas"];
    if (!profile || profile.visibility !== "public") throw new Error("public-canvas release profile is invalid");
    const matches = (path, rule) => {
      if (rule === "*") return true;
      if (rule.endsWith("*/test/")) {
        const prefix = rule.slice(0, -7);
        return path.startsWith(prefix) && /\/test\//.test(path.slice(prefix.length));
      }
      return rule === path || (rule.endsWith("/") && path.startsWith(rule));
    };
    const paths = execFileSync("git", ["-C", option.root, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" })
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean)
      .filter((path) => profile.include.some((rule) => matches(path, rule)))
      .filter((path) => !(profile.exclude || []).some((rule) => matches(path, rule)));
    files = paths.map((path) => ({
      path,
      bytes: execFileSync("git", ["-C", option.root, "show", `HEAD:${path}`], { maxBuffer: 64 * 1024 * 1024 }),
    }));
  }
  validatePublicAssemblyInputs(manifest, files);
  process.stdout.write(`public-source-rights=ok files=${files.length}\n`);
}

main().catch((error) => {
  process.stderr.write(`[morrow-source-rights] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
