#!/usr/bin/env node
import { assertConformant } from "./lib/release-candidate.mjs";

try {
  const profileName = process.env.MORROW_RELEASE_PROFILE || "private-full";
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MORROW_") && key !== "MORROW_RELEASE_PROFILE") delete process.env[key];
  }
  const report = assertConformant({ profileName });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`[morrow weekend-check] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
