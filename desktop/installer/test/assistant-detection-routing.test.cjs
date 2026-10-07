"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const shared = path.resolve(__dirname, "../shared");

function detection({ assistantId = "codex", platform = "win32", store = false, cli = false, application = false }) {
  const script = `
    const shared = ${JSON.stringify(shared)};
    const calls = [];
    const appx = require(shared + '/windows-appx-detection.cjs');
    const apps = require(shared + '/assistant-app-detection.cjs');
    appx.detectWindowsCodexPackage = async () => { calls.push('store'); return ${store}; };
    apps.detectAssistantApplication = async () => { calls.push('application'); return ${application}; };
    apps.detectAssistantCommand = async ({ command }) => { calls.push(command); return ${cli}; };
    apps.detectGeminiCli = async () => { calls.push('gemini'); return ${cli}; };
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    const { detectAssistant } = require(shared + '/installer-controller.cjs');
    detectAssistant({ id: ${JSON.stringify(assistantId)} }).then(
      (detected) => console.log(JSON.stringify({ detected, calls })),
      (error) => { console.error(error); process.exitCode = 1; }
    );
  `;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Windows detects the Store assistant without probing Codex CLI", () => {
  assert.deepEqual(detection({ store: true }), { detected: true, calls: ["store"] });
});

test("Windows detects Codex CLI when the Store assistant is absent", () => {
  assert.deepEqual(detection({ cli: true }), { detected: true, calls: ["store", "codex"] });
});

test("Windows reports the assistant absent when neither Store nor Codex CLI is available", () => {
  assert.deepEqual(detection({}), { detected: false, calls: ["store", "codex"] });
});

test("macOS detects the desktop assistant without probing Codex CLI", () => {
  assert.deepEqual(detection({ platform: "darwin", application: true }), { detected: true, calls: ["application"] });
});

test("macOS still detects Codex CLI without a desktop assistant", () => {
  assert.deepEqual(detection({ platform: "darwin", cli: true }), { detected: true, calls: ["application", "codex"] });
});

for (const [assistantId, command] of [["claude-code", "claude"], ["gemini-cli", "gemini"]]) {
  for (const cli of [true, false]) {
    test(`Windows ${assistantId} detection reports CLI availability ${cli}`, () => {
      assert.deepEqual(detection({ assistantId, cli }), { detected: cli, calls: ["application", command] });
    });
  }
}
