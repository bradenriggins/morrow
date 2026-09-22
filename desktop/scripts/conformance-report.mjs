#!/usr/bin/env node
import { conformanceReport } from "./lib/release-candidate.mjs";

try {
  const report = conformanceReport({ profileName: process.env.MORROW_RELEASE_PROFILE || "private-full" });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`[morrow conformance] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
