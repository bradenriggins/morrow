#!/usr/bin/env node
import { stageCandidate, scanStagedCandidate } from "./lib/release-candidate.mjs";

const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profileName = profileIndex === -1
  ? (process.env.MORROW_RELEASE_PROFILE || "private-full")
  : args[profileIndex + 1];
if (!profileName || profileName.startsWith("--")) throw new Error("--profile requires a profile name");

try {
  const result = args.includes("--scan")
    ? scanStagedCandidate({ profileName })
    : stageCandidate({ profileName, verifyRebuild: args.includes("--verify-rebuild") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if ((args.includes("--scan") && !result.passed) || (!args.includes("--scan") && !result.markerScan.passed)) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`[morrow package] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
