#!/usr/bin/env node

const command = process.argv[2];
if (command === "dev-approval") {
  process.stderr.write("[morrow] The approval surface remains owned by the configured donor runtime. No local approval server is admitted.\n");
  process.exitCode = 1;
} else {
  process.stderr.write("[morrow] Unsupported release command.\n");
  process.exitCode = 1;
}
