#!/usr/bin/env node
import {
  stageCandidate,
  stageCandidateSet,
  scanStagedCandidate,
} from "./lib/release-candidate.mjs";

const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profileName = profileIndex === -1
  ? (process.env.MORROW_RELEASE_PROFILE || "private-full")
  : args[profileIndex + 1];
if (!profileName || profileName.startsWith("--")) throw new Error("--profile requires a profile name");
const rootIndex = args.indexOf("--root");
const root = rootIndex === -1 ? undefined : args[rootIndex + 1];
if (rootIndex !== -1 && (!root || root.startsWith("--"))) throw new Error("--root requires a directory");

try {
  const profileNames = args.includes("--all") ? ["private-full", "public-canvas"] : [profileName];
  const verifyRebuild = args.includes("--verify-rebuild");
  const scan = args.includes("--scan");
  const placed = root ? { root } : {};
  const results = scan
    ? profileNames.map((name) => scanStagedCandidate({ profileName: name, ...placed }))
    : profileNames.length > 1
      ? stageCandidateSet({ profileNames, verifyRebuild, ...placed })
      : [stageCandidate({ profileName: profileNames[0], verifyRebuild, ...placed })];
  const result = results.length === 1 ? results[0] : { schema: "morrow.release-candidates.v1", candidates: results };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // A scan reports archive integrity and keeps a non-zero exit for a failed scan.
  // Packaging and receipt commands fail when the candidate is not promotable.
  const failed = results.some((entry) => scan ? entry.passed !== true : entry.promotable !== true);
  if (failed) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`[morrow package] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
