"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const runnerPath = path.join(__dirname, "run-bounded-tests.cjs");

test("the bounded suite runner cancels one file with --test-timeout so it cannot hold the suite budget", () => {
  const runner = fs.readFileSync(runnerPath, "utf8");
  assert.match(runner, /const FILE_TIMEOUT_MS = process\.platform === "win32" \? 600_000 : 60_000;/);
  assert.match(runner, /const SUITE_TIMEOUT_MS = process\.platform === "win32" \? 900_000 : 300_000;/);
  assert.match(runner, /`--test-timeout=\$\{FILE_TIMEOUT_MS\}`/);
});

test("a hung test file is cancelled by --test-timeout instead of the suite process bound", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-bounded-timeout-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hung = path.join(directory, "hung.test.cjs");
  fs.writeFileSync(hung, `"use strict";
const test = require("node:test");
test("never settles", async () => {
  for (;;) await new Promise((resolve) => setTimeout(resolve, 20));
});
`);
  const { runOwnedProcess } = await import("../../scripts/lib/owned-process.mjs");
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const started = Date.now();
  const result = await runOwnedProcess(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--test-timeout=500",
    hung,
  ], {
    environment,
    timeoutMs: 8_000,
    killGraceMs: 500,
    finalGraceMs: 500,
    maxOutputBytes: 16_384,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, false, "the suite-level process bound must not be the one that ends the hung test");
  assert.notEqual(result.code, 0);
  assert.ok(elapsed < 4_000, `hung test ran ${elapsed} ms; it must not consume the suite budget`);
  assert.match(`${result.stdout}${result.stderr}`, /timed out/i);
});
