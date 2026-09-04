#!/usr/bin/env node
import { stageCandidate, scanStagedCandidate } from "./lib/release-candidate.mjs";

const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profileName = profileIndex === -1
  ? (process.env.MORROW_RELEASE_PROFILE || "private-full")
  : args[profileIndex + 1];
if (!profileName || profileName.startsWith("--")) throw new Error("--profile requires a profile name");

try {
  const profileNames = args.includes("--all") ? ["private-full", "public-canvas"] : [profileName];
  const results = profileNames.map((name) => args.includes("--scan")
    ? scanStagedCandidate({ profileName: name })
    : stageCandidate({ profileName: name, verifyRebuild: args.includes("--verify-rebuild") }));
  const result = results.length === 1 ? results[0] : { schema: "morrow.release-candidates.v1", candidates: results };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const failed = results.some((entry) => args.includes("--scan") ? !entry.passed : entry.candidateBuilt !== true);
  if (failed) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`[morrow package] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
