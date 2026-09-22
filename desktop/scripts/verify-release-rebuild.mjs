#!/usr/bin/env node

import { resolve } from "node:path";
import { stageCandidate } from "./lib/release-candidate.mjs";

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? "" : args[index + 1] || "";
};
const root = valueFor("--root");
const profile = valueFor("--profile");
if (!root || !profile || profile.startsWith("--")) throw new Error("--root and --profile are required");

const receipt = stageCandidate({ root: resolve(root), profileName: profile, verifyRebuild: false });
process.stdout.write(JSON.stringify({
  schema: "morrow.independent-candidate-rebuild.v1",
  commit: receipt.commit,
  tree: receipt.tree,
  profile: receipt.profile,
  packageDigest: receipt.packageDigest,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
}));
