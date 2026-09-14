const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  CODEX_BUNDLE_IDENTIFIER,
  commandDirectories,
  detectAssistantApplication,
  detectAssistantCommand,
  probeWindowsCommandShim,
  WINDOWS_COMMAND_SHIM_ENV,
  windowsCommandShimInvocation,
} = require("../shared/assistant-app-detection.cjs");

function readerFixture(directory, entries, identifiers) {
  const readCalls = [];
  return {
    readCalls,
    input: {
      assistantId: "codex",
      applicationDirectories: [directory],
      exists: async (candidate) => entries.has(candidate),
      readBundleIdentifier: async (candidate) => {
        readCalls.push(candidate);
        const value = identifiers.get(candidate);
        if (value instanceof Error) throw value;
        return value || null;
      }
    }
  };
}

test("recognizes ChatGPT.app only when metadata identifies the Codex desktop bundle", async () => {
  const applications = path.join("fixture", "Applications");
  const chatGpt = path.join(applications, "ChatGPT.app");

  const valid = readerFixture(applications, new Set([chatGpt]), new Map([[chatGpt, CODEX_BUNDLE_IDENTIFIER]]));
  assert.equal(await detectAssistantApplication(valid.input), true);
  assert.deepEqual(valid.readCalls, [chatGpt]);

  const consumerChatGpt = readerFixture(applications, new Set([chatGpt]), new Map([[chatGpt, "com.openai.chat"]]));
  assert.equal(await detectAssistantApplication(consumerChatGpt.input), false);
  assert.deepEqual(consumerChatGpt.readCalls, [chatGpt]);

  const filenameOnly = readerFixture(applications, new Set([chatGpt]), new Map());
  assert.equal(await detectAssistantApplication(filenameOnly.input), false);
  assert.deepEqual(filenameOnly.readCalls, [chatGpt]);

  const unreadable = readerFixture(applications, new Set([chatGpt]), new Map([[chatGpt, new Error("unreadable metadata")]]));
  assert.equal(await detectAssistantApplication(unreadable.input), false);
  assert.deepEqual(unreadable.readCalls, [chatGpt]);
});

test("requires exact Codex product identity for every application filename", async () => {
  const applications = path.join("fixture", "Applications");
  const codex = path.join(applications, "Codex.app");
  const input = readerFixture(applications, new Set([codex]), new Map([[codex, CODEX_BUNDLE_IDENTIFIER]]));
  assert.equal(await detectAssistantApplication(input.input), true);
  assert.deepEqual(input.readCalls, [codex]);

  const wrongIdentity = readerFixture(applications, new Set([codex]), new Map([[codex, "com.example.lookalike"]]));
  assert.equal(await detectAssistantApplication(wrongIdentity.input), false);
});

test("does not apply the ChatGPT bundle exception to another assistant", async () => {
  const applications = path.join("fixture", "Applications");
  const chatGpt = path.join(applications, "ChatGPT.app");
  const fixture = readerFixture(applications, new Set([chatGpt]), new Map([[chatGpt, CODEX_BUNDLE_IDENTIFIER]]));
  fixture.input.assistantId = "claude-code";
  assert.equal(await detectAssistantApplication(fixture.input), false);
  assert.deepEqual(fixture.readCalls, []);
});

test("never treats Claude Desktop or a filename-only Claude Code app as Claude Code", async () => {
  const applications = path.join("fixture", "Applications");
  for (const name of ["Claude.app", "Claude Code.app"]) {
    const candidate = path.join(applications, name);
    const fixture = readerFixture(applications, new Set([candidate]), new Map([[candidate, "com.anthropic.claudefordesktop"]]));
    fixture.input.assistantId = "claude-code";
    assert.equal(await detectAssistantApplication(fixture.input), false);
    assert.deepEqual(fixture.readCalls, []);
  }
});

test("searches the local command directory and only absolute PATH entries", () => {
  assert.deepEqual(commandDirectories({
    platform: "darwin",
    home: "/Users/example",
    pathValue: "relative:/custom/bin::/usr/bin",
  }), ["/Users/example/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/custom/bin"]);
});

test("probes the documented native Windows Claude executable outside PATH", async () => {
  const home = String.raw`C:\Users\example`;
  const nativeClaude = path.win32.join(home, ".local", "bin", "claude.exe");
  assert.deepEqual(commandDirectories({
    platform: "win32",
    home,
    pathValue: String.raw`C:\Windows\System32`,
  }), [path.win32.join(home, ".local", "bin"), String.raw`C:\Windows\System32`]);

  const probes = [];
  const detected = await detectAssistantCommand({
    command: "claude",
    platform: "win32",
    home,
    pathValue: String.raw`C:\Windows\System32`,
    realpath: async (candidate) => {
      if (candidate !== nativeClaude) throw new Error("missing");
      return candidate;
    },
    stat: async (candidate) => ({ isFile: () => candidate === nativeClaude }),
    probe: async (candidate) => { probes.push(candidate); return candidate === nativeClaude; },
  });

  assert.equal(detected, true);
  assert.deepEqual(probes, [nativeClaude]);
});

test("routes an absolute Windows command shim through cmd.exe without putting its path in command text", async () => {
  const home = String.raw`C:\Users\Example & Team`;
  const shim = path.win32.join(home, ".local", "bin", "claude 100% & (safe)!^.cmd");
  const comSpec = String.raw`C:\Windows\System32\cmd.exe`;
  const invocation = windowsCommandShimInvocation(shim, {
    comSpec,
    environment: { PATH: String.raw`C:\Windows\System32` },
  });
  assert.equal(invocation.executable, comSpec);
  assert.deepEqual(invocation.argumentsValue, [
    "/d", "/s", "/v:off", "/c", `""%${WINDOWS_COMMAND_SHIM_ENV}%" --version"`,
  ]);
  assert.equal(invocation.argumentsValue.some((value) => value.includes(shim)), false);
  assert.equal(invocation.environment[WINDOWS_COMMAND_SHIM_ENV], shim);

  const ordinaryProbes = [];
  const shimProbes = [];
  const detected = await detectAssistantCommand({
    command: "claude",
    platform: "win32",
    home,
    pathValue: "",
    realpath: async (candidate) => {
      if (!candidate.toLowerCase().endsWith(".cmd")) throw new Error("missing");
      return shim;
    },
    stat: async () => ({ isFile: () => true }),
    probe: async (candidate) => { ordinaryProbes.push(candidate); return false; },
    probeWindowsShim: async (candidate) => { shimProbes.push(candidate); return true; },
  });
  assert.equal(detected, true);
  assert.deepEqual(ordinaryProbes, []);
  assert.deepEqual(shimProbes, [shim]);
});

function stalledChild(pid = 43_210) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  child.kill = () => true;
  return child;
}

test("a stalled Windows command shim probe is bounded and reclaims the complete process tree", async () => {
  const shim = String.raw`C:\Users\Example & Team\claude.cmd`;
  const command = stalledChild();
  const calls = [];
  const terminations = [];
  const spawnProcess = (executable, argumentsValue, options) => {
    calls.push([executable, argumentsValue, options]);
    return command;
  };

  const available = await probeWindowsCommandShim(shim, {
    comSpec: String.raw`C:\Windows\System32\cmd.exe`,
    environment: { PATH: String.raw`C:\Windows\System32` },
    spawnProcess,
    terminateTree: (child, force) => { terminations.push([child, force]); },
    timeoutMs: 10,
    killGraceMs: 10,
    finalGraceMs: 10,
    maxBytes: 64,
  });

  assert.equal(available, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], String.raw`C:\Windows\System32\cmd.exe`);
  assert.equal(calls[0][1].some((value) => value.includes(shim)), false);
  assert.equal(calls[0][2].env[WINDOWS_COMMAND_SHIM_ENV], shim);
  assert.deepEqual(terminations, [[command, false], [command, true]]);
});

test("requires a real executable with a successful bounded version probe", async () => {
  const calls = [];
  const files = new Map([
    ["/Users/example/.local/bin/claude", { isFile: () => true }],
    ["/custom/bin/claude", { isFile: () => true }],
  ]);
  const detected = await detectAssistantCommand({
    command: "claude",
    platform: "darwin",
    home: "/Users/example",
    pathValue: "relative:/custom/bin",
    realpath: async (candidate) => {
      if (!files.has(candidate)) throw new Error("missing");
      return candidate;
    },
    stat: async (candidate) => files.get(candidate),
    access: async (candidate) => {
      calls.push(["access", candidate]);
      if (candidate.includes(".local")) throw new Error("not executable");
    },
    probe: async (candidate) => {
      calls.push(["probe", candidate]);
      return candidate === "/custom/bin/claude";
    },
  });
  assert.equal(detected, true);
  assert.deepEqual(calls, [
    ["access", "/Users/example/.local/bin/claude"],
    ["access", "/custom/bin/claude"],
    ["probe", "/custom/bin/claude"],
  ]);
});
