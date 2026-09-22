#!/usr/bin/env node
import { assertConformant } from "./lib/release-candidate.mjs";

try {
  const report = assertConformant({ profileName: process.env.MORROW_RELEASE_PROFILE || "private-full" });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`[morrow weekend-check] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
