// Live entry for the Moodle safe proof. Cleanup is part of the run: a failed delete
// exits non-zero, and the proof refuses to start when cleanup cannot be attempted.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runMoodleSafeProof } from "./lib/moodle-safe-proof.mjs";

async function main() {
  if (process.env.MORROW_MOODLE_COURSE === undefined || String(process.env.MORROW_MOODLE_COURSE).trim() === "") {
    process.stderr.write("MORROW_MOODLE_COURSE is required. This proof does not default to a shared course.\n");
    process.exitCode = 1;
    return;
  }
  const { connect } = await import("./connect.mjs");
  const { makeTools } = await import("./lib/tools.mjs");
  const catalog = JSON.parse(readFileSync(new URL("../connector/extension/generated/moodle-browser-catalog.json", import.meta.url), "utf8"));
  const connected = await connect("morrow-moodle-safe-proof", { waitForBinding: false });
  const tools = makeTools(connected.client);
  const close = connected.close;
  try {
    const result = await runMoodleSafeProof({ tools, catalog });
    process.exitCode = result.exitCode;
    if (result.reason) process.stderr.write(`${result.reason}\n`);
  } finally {
    await close();
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked && !process.env.NODE_TEST_CONTEXT) await main();
