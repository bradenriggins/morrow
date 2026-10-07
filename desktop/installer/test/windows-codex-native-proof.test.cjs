"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { argumentsFrom, main, readStorePackages } = require("../../scripts/test/windows-codex-cli-native.cjs");

test("native Windows CLI proof requires explicit phase, absolute prefix, and pinned version", () => {
  const prefix = path.resolve("test-prefix");
  assert.deepEqual(argumentsFrom(["installed", prefix, "0.160.1"]), {
    phase: "installed", prefix, version: "0.160.1", worker: false,
  });
  for (const values of [[], ["other", prefix, "0.160.1"], ["absent", "relative", "0.160.1"],
    ["absent", prefix, "latest"], ["absent", prefix, "0.160.1", "extra"],
    ["absent", prefix, "0.160.1", "--worker", "extra"]]) {
    assert.throws(() => argumentsFrom(values));
  }
});

test("native Windows CLI proof refuses another operating system", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(main([]), /requires native Windows/);
});

test("the Store precondition accepts only a successful bounded query with valid metadata", async () => {
  const diagnostics = [];
  const emit = (value) => diagnostics.push(JSON.parse(value));
  const runCommand = async (executable, args, options) => {
    assert.match(executable.toLowerCase(), /powershell\.exe$/);
    assert.ok(args.includes("-NoLogo") && args.includes("-NonInteractive"));
    assert.equal(options.timeoutMs, 30_000);
    assert.equal(options.maxOutputBytes, 8 * 1024);
    return { code: 0, termination: null, stdout: "", stderr: "" };
  };
  assert.deepEqual(await readStorePackages(runCommand, emit), []);
  for (const result of [
    { code: null, termination: "timeout", stdout: "", stderr: "" },
    { code: 1, termination: null, stdout: "", stderr: "Store query failed" },
    { code: 0, termination: null, stdout: "invalid", stderr: "" },
  ]) {
    await assert.rejects(readStorePackages(async () => result, emit));
    assert.equal(diagnostics.at(-1).code, result.code);
    assert.equal(diagnostics.at(-1).termination, result.termination);
    assert.equal(diagnostics.at(-1).stderr, result.stderr);
  }
});

test("Windows CI checks absence before installing the pinned official CLI and checks it afterward", () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, "../../../.github/workflows/ci.yml"), "utf8");
  const windows = workflow.split("  check-desktop-windows:\n")[1].split("  check-desktop-macos:\n")[0];
  const absent = windows.indexOf("node scripts/test/windows-codex-cli-native.cjs absent $cliPrefix 0.160.1");
  const install = windows.indexOf("npm install --prefix $cliPrefix --no-save --no-package-lock --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org @openai/codex@0.160.1");
  const installed = windows.indexOf("node scripts/test/windows-codex-cli-native.cjs installed $cliPrefix 0.160.1");
  assert.ok(absent >= 0 && install > absent && installed > install);
  assert.match(windows, /Join-Path \$env:RUNNER_TEMP 'morrow-codex-cli-only'/);
});
