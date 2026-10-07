"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { detectAssistant, runBoundedCommand } = require("../../installer/shared/installer-controller.cjs");
const { probeWindowsCommandShim, windowsCommandShimInvocation } = require("../../installer/shared/assistant-app-detection.cjs");
const { WINDOWS_CODEX_APPX_QUERY, parseAppxPackages } = require("../../installer/shared/windows-appx-detection.cjs");
const { windowsPowerShellPath } = require("../../installer/shared/process-lifetime.cjs");

function argumentsFrom(values) {
  assert.ok(values.length === 3 || values.length === 4, "Expected phase, prefix, pinned version, and optional worker flag");
  const [phase, prefix, version, worker] = values;
  assert.ok(phase === "absent" || phase === "installed", "Expected absent or installed phase");
  assert.ok(prefix && path.isAbsolute(prefix), "The CLI prefix must be absolute");
  assert.match(version || "", /^\d+\.\d+\.\d+$/, "Expected a pinned stable Codex version");
  assert.ok(worker === undefined || worker === "--worker", "Unexpected argument");
  return { phase, prefix, version, worker: worker === "--worker" };
}

async function inspectShim(candidate) {
  const invocation = windowsCommandShimInvocation(candidate);
  const escaped = await runBoundedCommand(invocation.executable, invocation.argumentsValue, {
    env: invocation.environment, timeoutMs: 10_000, maxOutputBytes: 4 * 1024,
  });
  const literal = spawnSync(invocation.executable, invocation.argumentsValue, {
    env: invocation.environment, encoding: "utf8", windowsVerbatimArguments: true,
    timeout: 10_000, maxBuffer: 4 * 1024,
  });
  const detected = await probeWindowsCommandShim(candidate);
  process.stdout.write(`${JSON.stringify({
    schema: "morrow.windows-command-shim-diagnostic.v1",
    candidate,
    executable: invocation.executable,
    argumentsValue: invocation.argumentsValue,
    escaped: { code: escaped.code, termination: escaped.termination, stdout: escaped.stdout, stderr: escaped.stderr },
    literal: { code: literal.status, error: literal.error?.message ?? null, stdout: literal.stdout, stderr: literal.stderr },
    productionProbe: detected,
  })}\n`);
  return { literal, detected };
}

async function readStorePackages(runCommand = runBoundedCommand, emit = (value) => process.stdout.write(value)) {
  const startedAt = Date.now();
  const result = await runCommand(windowsPowerShellPath(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CODEX_APPX_QUERY,
  ], { timeoutMs: 30_000, maxOutputBytes: 8 * 1024 });
  emit(`${JSON.stringify({
    schema: "morrow.windows-store-query-diagnostic.v1",
    durationMs: Date.now() - startedAt,
    code: result.code,
    termination: result.termination,
    stdout: result.stdout,
    stderr: result.stderr,
  })}\n`);
  assert.equal(result.termination, null, "The real Windows Store query must finish within its proof limit");
  assert.equal(result.code, 0, `The real Windows Store query must succeed: ${result.stderr}`);
  const packages = parseAppxPackages(result.stdout);
  assert.notEqual(packages, null, "The real Windows Store query must return valid package metadata");
  return packages;
}

async function main(values = process.argv.slice(2)) {
  assert.equal(process.platform, "win32", "This proof requires native Windows");
  const input = argumentsFrom(values);
  if (!input.worker) {
    const home = path.join(input.prefix, "isolated-home");
    await fs.mkdir(home, { recursive: true });
    const nodeDirectory = path.dirname(process.execPath);
    const systemDirectory = path.join(process.env.SystemRoot, "System32");
    const environment = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      CODEX_HOME: path.join(home, ".codex"),
      PATH: [
        ...(input.phase === "installed" ? [path.join(input.prefix, "node_modules", ".bin")] : []),
        nodeDirectory,
        systemDirectory,
      ].join(path.delimiter),
    };
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    const result = spawnSync(process.execPath, [__filename, ...values, "--worker"], {
      cwd: home, env: environment, encoding: "utf8", timeout: 90_000,
    });
    assert.equal(result.error, undefined, "The native detector proof exceeded its process limit");
    process.stdout.write(result.stdout);
    assert.equal(result.status, 0, result.stderr);
    return;
  }

  assert.equal(os.homedir().toLowerCase(), path.join(input.prefix, "isolated-home").toLowerCase());
  assert.deepEqual(await readStorePackages(), [], "This runner must have no OpenAI.Codex Store package");

  let cliVersion = null;
  if (input.phase === "installed") {
    const manifest = JSON.parse(await fs.readFile(path.join(input.prefix, "node_modules", "@openai", "codex", "package.json"), "utf8"));
    assert.equal(manifest.name, "@openai/codex");
    assert.equal(manifest.version, input.version);
    const result = await runBoundedCommand(process.execPath, [
      path.join(input.prefix, "node_modules", "@openai", "codex", manifest.bin.codex), "--version",
    ], {
      timeoutMs: 10_000, maxOutputBytes: 4 * 1024,
    });
    assert.equal(result.code, 0, `The official CLI version probe must exit successfully: ${result.stderr}`);
    assert.equal(result.termination, null);
    cliVersion = result.stdout;
    assert.equal(cliVersion?.trim(), `codex-cli ${input.version}`, "The official installed CLI must execute --version");
    const official = await inspectShim(path.join(input.prefix, "node_modules", ".bin", "codex.cmd"));
    const fixtureDirectory = path.join(input.prefix, "shim & ! (space)");
    await fs.mkdir(fixtureDirectory, { recursive: true });
    const fixture = path.join(fixtureDirectory, "codex.cmd");
    await fs.writeFile(fixture, "@echo off\r\necho native-command-shim-fixture\r\n", "utf8");
    const specialPath = await inspectShim(fixture);
    assert.equal(official.literal.status, 0, "The literal command line must execute the official npm shim");
    assert.equal(official.literal.stdout.trim(), `codex-cli ${input.version}`);
    assert.equal(specialPath.literal.status, 0, "The literal command line must execute a shim with spaces and metacharacters in its path");
    assert.equal(specialPath.literal.stdout.trim(), "native-command-shim-fixture");
    assert.equal(official.detected, true, "The production shim probe must execute the official npm CLI");
    assert.equal(specialPath.detected, true, "The production shim probe must execute a path with spaces and metacharacters");
  }

  const detected = await detectAssistant({ id: "codex" });
  assert.equal(detected, input.phase === "installed", "The ordinary installer detector must follow real CLI availability without a Store app");
  process.stdout.write(`${JSON.stringify({
    schema: "morrow.windows-codex-cli-detection.v1",
    phase: input.phase,
    storeAbsent: true,
    detected,
    cliVersion: cliVersion?.trim() ?? null,
  })}\n`);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { argumentsFrom, main, readStorePackages };
