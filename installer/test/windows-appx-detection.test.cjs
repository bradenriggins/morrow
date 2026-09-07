const assert = require("node:assert/strict");
const test = require("node:test");
const {
  APPX_QUERY_MAX_BYTES,
  CODEX_WINDOWS_APPX_IDENTITY,
  WINDOWS_CODEX_APPX_QUERY,
  detectWindowsCodexPackage
} = require("../shared/windows-appx-detection.cjs");

function trustedPackage(overrides = {}) {
  return {
    name: CODEX_WINDOWS_APPX_IDENTITY.name,
    publisher: CODEX_WINDOWS_APPX_IDENTITY.publisher,
    packageFamilyName: CODEX_WINDOWS_APPX_IDENTITY.packageFamilyName,
    packageFullName: "OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0",
    signatureKind: "Store",
    status: "Ok",
    architecture: "x64",
    ...overrides
  };
}

test("recognizes the signed OpenAI Codex package through bounded identity metadata", async () => {
  const calls = [];
  const detected = await detectWindowsCodexPackage({
    assistantId: "codex",
    runPowerShell: async (script) => {
      calls.push(script);
      return JSON.stringify(trustedPackage());
    }
  });

  assert.equal(detected, true);
  assert.deepEqual(calls, [WINDOWS_CODEX_APPX_QUERY]);
  assert.match(WINDOWS_CODEX_APPX_QUERY, /Get-AppxPackage -Name 'OpenAI\.Codex'/);
  assert.match(WINDOWS_CODEX_APPX_QUERY, /ConvertTo-Json -Compress/);
  assert.doesNotMatch(WINDOWS_CODEX_APPX_QUERY, /InstallLocation|Get-Command|Get-StartApps/);
  assert.equal(CODEX_WINDOWS_APPX_IDENTITY.applicationUserModelId, "OpenAI.Codex_2p2nqsd0c76g0!App");
  assert.equal(CODEX_WINDOWS_APPX_IDENTITY.executable, "app/ChatGPT.exe");
});

test("fails closed for wrong package identities, package state, and output", async () => {
  const cases = [
    trustedPackage({ name: "OpenAI.ChatGPT" }),
    trustedPackage({ publisher: "CN=untrusted" }),
    trustedPackage({ packageFamilyName: "OpenAI.Codex_untrusted" }),
    trustedPackage({ packageFullName: "OpenAI.Codex_26.901.6511.0_x64__untrusted" }),
    trustedPackage({ signatureKind: "Developer" }),
    trustedPackage({ status: "NeedsRemediation" }),
    trustedPackage({ architecture: "x86" })
  ];
  for (const candidate of cases) {
    assert.equal(await detectWindowsCodexPackage({
      assistantId: "codex",
      runPowerShell: async () => JSON.stringify(candidate)
    }), false);
  }
  assert.equal(await detectWindowsCodexPackage({
    assistantId: "codex",
    runPowerShell: async () => " ".repeat(APPX_QUERY_MAX_BYTES + 1)
  }), false);
  assert.equal(await detectWindowsCodexPackage({
    assistantId: "codex",
    runPowerShell: async () => JSON.stringify([trustedPackage(), trustedPackage()])
  }), false);
  assert.equal(await detectWindowsCodexPackage({
    assistantId: "codex",
    runPowerShell: async () => { throw new Error("PowerShell failed"); }
  }), false);
});

test("does not query Windows packages for another assistant", async () => {
  let called = false;
  assert.equal(await detectWindowsCodexPackage({
    assistantId: "claude-code",
    runPowerShell: async () => {
      called = true;
      return JSON.stringify(trustedPackage());
    }
  }), false);
  assert.equal(called, false);
});
