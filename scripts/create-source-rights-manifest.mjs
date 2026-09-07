#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maxBuffer = 64 * 1024 * 1024;

function git(args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tracked(path) {
  return execFileSync("git", ["-C", root, "show", `HEAD:${path}`], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
  });
}

function matches(path, rule) {
  if (rule === "*") return true;
  if (rule.endsWith("*/test/")) {
    const prefix = rule.slice(0, -7);
    return path.startsWith(prefix) && /\/test\//.test(path.slice(prefix.length));
  }
  return rule === path || (rule.endsWith("/") && path.startsWith(rule));
}

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value.trim();
}

const adaptedPrefixes = [
  "packages/batch-engine/",
  "packages/bridge-loopback/",
  "packages/bridge-protocol/",
  "packages/contracts/",
  "packages/gateway-core/",
  "packages/mcp-server/",
  "packages/operation-journal/",
  "packages/upstream-mcp/",
];

const thirdPartyFiles = new Map([
  ["connector/extension/brand/Manrope-variable.ttf", {
    assetSha256: "d0639be45d0af36e798172419d7bd173c4bd4f29e2b76cbb69db1d11bf8b0a40",
    copyright: "Copyright 2018 The Manrope Project Authors (https://github.com/sharanda/manrope)",
    license: "SIL-OFL-1.1",
    licensePath: "connector/extension/brand/Manrope-OFL.txt",
    licenseSha256: "e01b637272e0cbdfb240184dd98ea5cc671556d9894dae2668d92ab2c906787c",
    sourceUrl: "https://github.com/google/fonts/tree/main/ofl/manrope",
  }],
  ["connector/extension/brand/Manrope-OFL.txt", {
    assetSha256: "e01b637272e0cbdfb240184dd98ea5cc671556d9894dae2668d92ab2c906787c",
    copyright: "Copyright 2018 The Manrope Project Authors (https://github.com/sharanda/manrope)",
    license: "SIL-OFL-1.1",
    licensePath: "connector/extension/brand/Manrope-OFL.txt",
    licenseSha256: "e01b637272e0cbdfb240184dd98ea5cc671556d9894dae2668d92ab2c906787c",
    sourceUrl: "https://openfontlicense.org",
  }],
]);

const reviewer = option("--reviewer");
const authorization = option("--authorization");
const profiles = JSON.parse(readFileSync(resolve(root, "config/release-profiles.json"), "utf8"));
const profile = profiles.profiles?.["public-canvas"];
if (!profile || profile.visibility !== "public") throw new Error("public-canvas release profile is invalid");

const files = git(["ls-tree", "-r", "--name-only", "HEAD"])
  .split("\n")
  .map((path) => path.trim())
  .filter(Boolean)
  .filter((path) => profile.include.some((rule) => matches(path, rule)))
  .filter((path) => !(profile.exclude || []).some((rule) => matches(path, rule)))
  .sort()
  .map((path) => {
    const thirdParty = thirdPartyFiles.get(path);
    const bytes = tracked(path);
    const digest = sha256(bytes);
    if (thirdParty && thirdParty.assetSha256 !== digest) {
      throw new Error(`third-party asset digest drift: ${path}`);
    }
    const disposition = thirdParty
      ? "third_party_redistributable"
      : adaptedPrefixes.some((prefix) => path.startsWith(prefix))
      ? "adapted_owned"
      : "direct_owned";
    return {
      path,
      sha256: digest,
      disposition,
      review: `${authorization}; reviewer=${reviewer}; source=HEAD`,
      ...(thirdParty ? { thirdParty } : {}),
    };
  });

const manifest = {
  schema: "morrow.source-rights.v1",
  files,
};
writeFileSync(
  resolve(root, "config/source-rights.manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify({ schema: manifest.schema, files: files.length, reviewer })}\n`);
