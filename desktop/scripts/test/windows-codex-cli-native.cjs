"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { detectAssistant, readCommandOutput, runBoundedCommand } = require("../../installer/shared/installer-controller.cjs");
const { windowsCommandShimInvocation } = require("../../installer/shared/assistant-app-detection.cjs");
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
      cwd: home, env: environment, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.error, undefined, "The native detector proof exceeded its process limit");
    assert.equal(result.status, 0, result.stderr);
    process.stdout.write(result.stdout);
    return;
  }

  assert.equal(os.homedir().toLowerCase(), path.join(input.prefix, "isolated-home").toLowerCase());
  const storeOutput = await readCommandOutput(windowsPowerShellPath(), [
    "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CODEX_APPX_QUERY,
  ], { timeoutMs: 10_000, maxBytes: 8 * 1024 });
  assert.notEqual(storeOutput, null, "The real Windows Store query must succeed");
  assert.deepEqual(parseAppxPackages(storeOutput), [], "This runner must have no OpenAI.Codex Store package");

  let cliVersion = null;
  if (input.phase === "installed") {
    const manifest = JSON.parse(await fs.readFile(path.join(input.prefix, "node_modules", "@openai", "codex", "package.json"), "utf8"));
    assert.equal(manifest.name, "@openai/codex");
    assert.equal(manifest.version, input.version);
    const invocation = windowsCommandShimInvocation(path.join(input.prefix, "node_modules", ".bin", "codex.cmd"));
    const result = await runBoundedCommand(invocation.executable, invocation.argumentsValue, {
      env: invocation.environment, timeoutMs: 10_000, maxOutputBytes: 4 * 1024,
    });
    assert.equal(result.code, 0, "The official CLI version probe must exit successfully");
    assert.equal(result.termination, null);
    cliVersion = result.stdout;
    assert.equal(cliVersion?.trim(), `codex-cli ${input.version}`, "The official installed CLI must execute --version");
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

module.exports = { argumentsFrom, main };
