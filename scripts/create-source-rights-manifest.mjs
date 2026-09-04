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
  ["connector/extension/brand/GoogleSansFlex-latin.woff2", {
    assetSha256: "843339f4e027cee857331299135de9f3be36fe2e23782c8f785262104ec5ad11",
    copyright: "Copyright 2015 Google LLC. All Rights Reserved.",
    license: "SIL-OFL-1.1",
    licensePath: "connector/extension/brand/FONT-LICENSE.txt",
    licenseSha256: "2ad6cadc54969a39d46fa01e37e5e78c54b9c06e4f0b15235a4105993a149126",
    sourceUrl: "https://fonts.google.com/specimen/Google+Sans+Flex",
  }],
  ["connector/extension/brand/FONT-LICENSE.txt", {
    assetSha256: "2ad6cadc54969a39d46fa01e37e5e78c54b9c06e4f0b15235a4105993a149126",
    copyright: "Copyright 2015 Google LLC. All Rights Reserved.",
    license: "SIL-OFL-1.1",
    licensePath: "connector/extension/brand/FONT-LICENSE.txt",
    licenseSha256: "2ad6cadc54969a39d46fa01e37e5e78c54b9c06e4f0b15235a4105993a149126",
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
