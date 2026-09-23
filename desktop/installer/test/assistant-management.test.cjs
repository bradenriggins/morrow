"use strict";

/**
 * Changing the materials folder after setup, and adding or removing an
 * assistant after setup. Every case here runs the controller against real
 * files: the assistant configuration files it rewrites, the Claude Desktop
 * bundle folder it removes, and the installer record it keeps.
 */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createInstallerController, errorDetails, repairRequiredState } = require("../shared/installer-controller.cjs");
const { envelope } = require("../shared/contract.cjs");
const { freshRecord } = require("../shared/state-policy.cjs");

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Claude Desktop runs on macOS and Windows. A Claude Desktop setup test uses
// this host's own platform where Claude Desktop runs, and macOS elsewhere: a
// setup made for one platform names paths the other platform cannot hold.
const CLAUDE_DESKTOP_PLATFORM = process.platform === "win32" ? "win32" : "darwin";

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-assistant-management-"));
  await fs.mkdir(path.join(root, "UserData"), { recursive: true });
  await fs.mkdir(path.join(root, "Home"), { recursive: true });
  await fs.mkdir(path.join(root, "Payload"), { recursive: true });
  // Writing an assistant's configuration restricts the file to this account on
  // win32 before checking its digest, through the real client-config module.
  const clientConfig = path.join(root, "Payload", "app", "packages", "client-config", "dist");
  await fs.mkdir(clientConfig, { recursive: true });
  await fs.writeFile(path.join(clientConfig, "index.js"), [
    "export function restrictToCurrentAccount() {}",
    "export function withoutMorrowCodexTable(content) {",
    "  const lines = content.split('\\n');",
    "  const start = lines.findIndex((line) => /^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:morrow|\\\"morrow\\\"|'morrow')\\s*\\]\\s*(?:#.*)?$/.test(line));",
    "  if (start === -1) return null;",
    "  const next = lines.findIndex((line, index) => index > start && line.trimStart().startsWith('['));",
    "  if (next === -1) {",
    "    const kept = lines.slice(0, start).join('\\n').trimEnd();",
    "    return kept ? `${kept}\\n` : '';",
    "  }",
    "  return [...lines.slice(0, start), ...lines.slice(next)].join('\\n');",
    "}",
    "export function withoutMorrowClientJson(content, container = 'mcpServers', serverName = 'morrow') {",
    "  const document = JSON.parse(content);",
    "  const servers = document?.[container];",
    "  if (!servers || typeof servers !== 'object' || !Object.hasOwn(servers, serverName)) return null;",
    "  delete servers[serverName];",
    "  return `${JSON.stringify(document, null, 2)}\\n`;",
    "}",
    ""
  ].join("\n"));
  test.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * The Codex table client-config writes, with the folder the assistant starts
 * Morrow in. The stand-in command runner below appends exactly this, as
 * `mcp install` does, so a rebind is a real write and a real read back.
 */
function codexTable(workspaceRoot) {
  return [
    "[mcp_servers.morrow]",
    "command = \"node\"",
    `cwd = "${workspaceRoot}"`,
    "env = { MORROW_UPSTREAMS_FILE = \"/Morrow/State/morrow.upstreams.json\" }",
    ""
  ].join("\n");
}

function claudeCodeEntry(workspaceRoot) {
  return { mcpServers: { morrow: { type: "stdio", command: "node", cwd: workspaceRoot, env: { MORROW_UPSTREAMS_FILE: "/Morrow/State/morrow.upstreams.json" } } } };
}

async function writeFile(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return sha256(await fs.readFile(target));
}

async function claudeSetupFixture(installer, name, installationId = name) {
  const directory = path.join(installer.paths.state, "ClaudeDesktop", name);
  await writeFile(path.join(directory, "Morrow.mcpb"), `${name} bundle`);
  await writeFile(path.join(directory, "bundle", "server", "launch.cjs"), `${name} launcher`);
  const canonical = await fs.realpath(directory);
  return {
    bundlePath: path.join(canonical, "Morrow.mcpb"),
    installationId,
    receiptPath: path.join(canonical, "connection.json"),
  };
}

async function claudeRuntimeFixture(installer) {
  for (const file of [installer.paths.node, installer.paths.server, installer.paths.upstreams]) await writeFile(file, "fixture");
  const serverBytes = await fs.readFile(installer.paths.server);
  await writeFile(installer.paths.mcpRuntimeManifest, `${JSON.stringify({
    schema: "morrow.mcp-runtime-manifest.v2",
    package: { name: "@morrow-lms/gateway", version: "1.0.0-rc.0" },
    entrypoint: {
      path: "packages/mcp-server/dist/index.js",
      bytes: serverBytes.length,
      sha256: sha256(serverBytes),
    },
    dependencies: [],
    directFiles: [],
  })}\n`);
}

/**
 * A controller whose command runner writes what `mcp install` writes: the
 * Morrow entry, bound to the folder the command names, into the file the
 * assistant reads. Every call it receives is recorded.
 */
function controller(root, overrides = {}) {
  const { beforeClientInstall, refuseClientId, ...controllerOverrides } = overrides;
  const calls = [];
  const installer = createInstallerController({
    app: { getPath: (name) => (name === "userData" ? path.join(root, "UserData") : root) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => "", openExternal: async () => {}, showItemInFolder: () => {} },
    platform: process.platform,
    homeDirectory: path.join(root, "Home"),
    testRoot: null,
    isTestMode: false,
    payloadRoot: path.join(root, "Payload"),
    productVersion: "1.0.0-rc.0",
    trustedBridgeReleaseManifestSha256: () => null,
    trustedMcpRuntimeManifestSha256: () => null,
    detectAssistant: async () => true,
    runCli: async (executable, argumentsValue) => {
      const args = argumentsValue.slice(1);
      calls.push(args);
      if (args[0] === "mcp" && args[1] === "install") {
        const workspaceRoot = args[args.indexOf("--workspace-root") + 1];
        const target = args[2] === "codex"
          ? path.join(root, "Home", ".codex", "config.toml")
          : path.join(args[args.indexOf("--client-project") + 1], ".mcp.json");
        let current = await fs.readFile(target, "utf8").catch(() => "");
        if (typeof beforeClientInstall === "function") {
          await beforeClientInstall({ args, target, current });
          current = await fs.readFile(target, "utf8").catch(() => "");
        }
        const expectedIndex = args.indexOf("--expected-config-sha256");
        if (expectedIndex !== -1 && sha256(Buffer.from(current)) !== args[expectedIndex + 1]) {
          return { code: 1, stdout: "", stderr: `Refusing to replace ${target} because it changed after Morrow recorded it` };
        }
        if (args[2] === refuseClientId) {
          return { code: 1, stdout: "", stderr: "Refusing to replace existing Morrow server morrow" };
        }
        if (args[2] === "codex") {
          const start = current.search(/(?:^|\n)\[mcp_servers\.morrow\]\n/);
          if (start === -1) {
            const kept = current.trimEnd();
            await writeFile(target, `${kept}${kept ? "\n\n" : ""}${codexTable(workspaceRoot)}`);
          } else {
            const body = start === 0 ? 0 : start + 1;
            const next = current.slice(body + 1).search(/\n\[/);
            const after = next === -1 ? "" : current.slice(body + 1 + next + 1);
            await writeFile(target, `${current.slice(0, body)}${codexTable(workspaceRoot)}${after ? `\n${after}` : ""}`);
          }
        } else {
          const document = current.trim() ? JSON.parse(current) : {};
          document.mcpServers = { ...(document.mcpServers || {}), ...claudeCodeEntry(workspaceRoot).mcpServers };
          await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    ...controllerOverrides
  });
  installer.acquireDesktopMutationGuard = async () => ({ kind: "owner", leaseId: "test-desktop-mutation" });
  installer.stopRuntimeForDesktopMutation = async (guard) => {
    await installer.closeRuntimeMonitor();
    return { ...guard, kind: "stopped", leaseToken: "test-desktop-mutation-token" };
  };
  installer.releaseDesktopMutationGuard = async (guard) => {
    if (installer.desktopMutationGuard === guard) installer.desktopMutationGuard = null;
  };
  return { installer, calls };
}

test("setting up an assistant for the first time does not require a recorded configuration digest", async () => {
  const root = await temporaryRoot();
  const { installer, calls } = controller(root);
  installer.ensureRuntime = async () => installer.paths;

  await installer.installAssistant("codex", null);

  assert.deepEqual(calls.map((entry) => entry[0]), ["setup", "mcp"]);
  assert.equal(calls[1].includes("--expected-config-sha256"), false);
  const target = path.join(root, "Home", ".codex", "config.toml");
  assert.equal((await installer.record()).configured.codex.sha256, sha256(await fs.readFile(target)));
});

test("a first-time setup rollback removes only Morrow from the configuration generation the client accepted", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "Home", ".codex", "config.toml");
  const capturedBefore = "[mcp_servers.other]\ncommand = \"old\"\n";
  const acceptedBefore = "[mcp_servers.other]\ncommand = \"new\"\n";
  await writeFile(target, capturedBefore);
  const { installer } = controller(root, {
    beforeClientInstall: async () => fs.writeFile(target, acceptedBefore),
  });
  installer.ensureRuntime = async () => installer.paths;
  installer.writeRecord = async () => { throw new Error("simulated later record failure"); };

  await assert.rejects(() => installer.installAssistant("codex", null), (error) => error.code === "setup_failed");

  assert.equal(await fs.readFile(target, "utf8"), acceptedBefore);
});

test("an edit at the first-time rollback boundary wins and is never replaced", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "Home", ".codex", "config.toml");
  const capturedBefore = "[mcp_servers.other]\ncommand = \"old\"\n";
  const acceptedBefore = "[mcp_servers.other]\ncommand = \"new\"\n";
  const boundaryEdit = "[mcp_servers.other]\ncommand = \"newest\"\n";
  const boundaryPath = `${target}.boundary-edit`;
  await writeFile(target, capturedBefore);
  await writeFile(boundaryPath, boundaryEdit);
  const { installer } = controller(root, {
    beforeClientInstall: async () => fs.writeFile(target, acceptedBefore),
  });
  installer.ensureRuntime = async () => installer.paths;
  installer.writeRecord = async () => { throw new Error("simulated later record failure"); };
  const originalRename = fs.rename;
  let injected = false;
  fs.rename = async (source, destination) => {
    if (!injected && source === target && String(destination).includes(".morrow-displaced-")) {
      injected = true;
      await originalRename(boundaryPath, target);
    }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(() => installer.installAssistant("codex", null), (error) => error.code === "setup_failed");
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(await fs.readFile(target, "utf8"), boundaryEdit);
  assert.deepEqual((await fs.readdir(path.dirname(target))).sort(), ["config.toml"]);
});

test("an assistant configuration changed during its atomic write is reported as a configuration conflict", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "Home", ".codex", "config.toml");
  const { installer } = controller(root, {
    runCli: async () => ({
      code: 1,
      stdout: "",
      stderr: `Refusing to replace ${target} because it changed during installation`
    })
  });

  await assert.rejects(
    () => installer.executeCli(["mcp", "install", "codex"]),
    (error) => error.code === "existing_morrow_configuration"
  );
});

test("removing an assistant after Codex rewrote its settings file removes only Morrow's table", async () => {
  const root = await temporaryRoot();
  const { installer, calls } = controller(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  const recorded = await writeFile(target, `model = "gpt-5"\n\n${codexTable(path.join(root, "Materials"))}`);
  // What Codex writes after Morrow: a new model, then a trusted project and a notice table after Morrow's.
  const rewritten = `model = "gpt-6"\n\n${codexTable(path.join(root, "Materials"))}\n[projects."/Users/t/course"]\ntrust_level = "trusted"\n\n[tui.notices]\nhide = true\n`;
  await writeFile(target, rewritten);
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target, sha256: recorded } }
  });

  await installer.removeAssistant("codex");

  assert.equal(await fs.readFile(target, "utf8"), `model = "gpt-6"\n\n[projects."/Users/t/course"]\ntrust_level = "trusted"\n\n[tui.notices]\nhide = true\n`);
  assert.deepEqual((await installer.record()).configured, {});
  assert.deepEqual(calls, [], "no command ran against that file");
  assert.equal(await fs.lstat(installer.assistantRemovalPath).then(() => true, () => false), false);
});

test("removing an entry Morrow did not write is refused, names the file, and changes nothing", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  const foreign = "[mcp_servers.morrow]\ncommand = \"someone-else\"\n";
  const recorded = await writeFile(target, foreign);
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: { codex: { target, sha256: recorded } } });
  const received = [];
  installer.clientConfigModule = async () => ({
    restrictToCurrentAccount() {},
    withoutMorrowCodexTable(content, name, options) {
      received.push(options);
      throw Object.assign(new Error("not written by Morrow"), { code: "config_entry_not_morrow", path: "Codex configuration" });
    }
  });

  await assert.rejects(() => installer.removeAssistant("codex"), (error) => {
    assert.equal(error.code, "assistant_configuration_changed");
    assert.equal(error.file, target);
    return true;
  });
  assert.deepEqual(received, [{ requireMorrowEntry: true }]);
  assert.equal(await fs.readFile(target, "utf8"), foreign);
  assert.deepEqual((await installer.record()).configured, { codex: { target, sha256: recorded } });
});

test("a refusal client-config names in --json mode reaches setup as its own public error for that file", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "Home", ".codex", "config.toml");
  for (const [code, publicCode] of [
    ["config_invalid", "assistant_config_invalid"],
    ["config_read_only", "assistant_config_read_only"],
    ["config_permission_denied", "assistant_config_permission_denied"],
    ["config_symlink", "assistant_config_symlink"],
    ["config_busy", "assistant_config_busy"],
    ["config_unreadable", "assistant_config_unreadable"],
    ["config_entry_not_morrow", "existing_morrow_configuration"],
    ["config_existing_entry", "existing_morrow_configuration"],
    ["config_changed", "existing_morrow_configuration"],
  ]) {
    const { installer } = controller(root, {
      runCli: async () => ({
        code: 1,
        stdout: "",
        stderr: `${JSON.stringify({ schema: "morrow.client-config-error.v1", code, path: target })}\n[morrow] technical detail\n`
      })
    });
    await assert.rejects(() => installer.executeCli(["mcp", "install", "codex", "--json"]), (error) => {
      assert.equal(error.code, publicCode, code);
      if (publicCode !== "existing_morrow_configuration") assert.equal(error.file, target, code);
      return true;
    });
  }
});

test("assistant removal preserves a pathname replaced at its final write boundary and keeps its tombstone", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  const original = `[mcp_servers.other]\ncommand = "other"\n\n${codexTable(path.join(root, "Materials"))}`;
  const replacement = "[mcp_servers.other]\ncommand = \"concurrent\"\n";
  const replacementPath = `${target}.concurrent`;
  const recorded = await writeFile(target, original);
  await writeFile(replacementPath, replacement);
  const record = {
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target, sha256: recorded } }
  };
  await installer.writeRecord(record);
  const originalRename = fs.rename;
  let injected = false;
  fs.rename = async (source, destination) => {
    if (!injected && source === target && String(destination).includes(".morrow-displaced-")) {
      injected = true;
      await originalRename(replacementPath, target);
    }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(
      () => installer.removeAssistant("codex"),
      (error) => error.code === "assistant_configuration_changed",
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(await fs.readFile(target, "utf8"), replacement);
  assert.deepEqual(JSON.parse(await fs.readFile(installer.recordPath, "utf8")), record);
  assert.equal(JSON.parse(await fs.readFile(installer.assistantRemovalPath, "utf8")).beforeSha256, recorded);
  assert.deepEqual((await fs.readdir(path.dirname(target))).sort(), ["config.toml"]);
});

test("assistant removal preserves bytes edited in place at its final write boundary", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  const original = `[mcp_servers.other]\ncommand = "other"\n\n${codexTable(path.join(root, "Materials"))}`;
  const boundaryEdit = "[mcp_servers.other]\ncommand = \"edited-in-place\"\n";
  const recorded = await writeFile(target, original);
  const admittedInode = (await fs.lstat(target)).ino;
  const record = {
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target, sha256: recorded } }
  };
  await installer.writeRecord(record);
  const originalRename = fs.rename;
  let injected = false;
  fs.rename = async (source, destination) => {
    if (!injected && source === target && String(destination).includes(".morrow-displaced-")) {
      injected = true;
      await fs.writeFile(target, boundaryEdit);
      assert.equal((await fs.lstat(target)).ino, admittedInode, "the boundary edit kept the admitted inode");
    }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(
      () => installer.removeAssistant("codex"),
      (error) => error.code === "assistant_configuration_changed",
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(await fs.readFile(target, "utf8"), boundaryEdit);
  assert.deepEqual(JSON.parse(await fs.readFile(installer.recordPath, "utf8")), record);
  assert.equal(JSON.parse(await fs.readFile(installer.assistantRemovalPath, "utf8")).beforeSha256, recorded);
  assert.deepEqual((await fs.readdir(path.dirname(target))).sort(), ["config.toml"]);
});

test("removing one assistant removes only its own entry, and leaves every other setting", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const materials = path.join(root, "Materials");
  const project = path.join(root, "Project");
  await fs.mkdir(project, { recursive: true });
  const codex = path.join(root, "Home", ".codex", "config.toml");
  const claudeCode = path.join(project, ".mcp.json");
  const codexSha256 = await writeFile(codex, `[mcp_servers.other]\ncommand = "other"\n\n${codexTable(materials)}`);
  const claudeCodeContent = `${JSON.stringify({ mcpServers: { other: { command: "other" }, morrow: claudeCodeEntry(materials).mcpServers.morrow } }, null, 2)}\n`;
  const claudeCodeSha256 = await writeFile(claudeCode, claudeCodeContent);
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target: codex, sha256: codexSha256 }, "claude-code": { target: claudeCode, sha256: claudeCodeSha256 } }
  });

  await installer.removeAssistant("codex");

  assert.equal(await fs.readFile(codex, "utf8"), "[mcp_servers.other]\ncommand = \"other\"\n", "the other server is kept exactly");
  assert.equal(await fs.readFile(claudeCode, "utf8"), claudeCodeContent, "the assistant that was not named is untouched");
  const record = await installer.record();
  assert.deepEqual(record.configured, { "claude-code": { target: claudeCode, sha256: claudeCodeSha256 } });
  assert.equal(record.selectedAssistantId, "claude-code", "the removed assistant is no longer the selected one");

  // The same removal for the JSON assistant keeps the rest of its document.
  await installer.removeAssistant("claude-code");
  assert.deepEqual(JSON.parse(await fs.readFile(claudeCode, "utf8")), { mcpServers: { other: { command: "other" } } });
  const emptied = await installer.record();
  assert.deepEqual(emptied.configured, {});
  assert.equal(emptied.selectedAssistantId, null);
});

test("JSON assistant removal uses the shared offset-preserving JSONC remover", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const project = path.join(root, "Project");
  const target = path.join(project, ".mcp.json");
  const content = "{\r\n"
    + "  // keep this comment\r\n"
    + "  \"mcpServers\": {\r\n"
    + "    \"other\": { \"command\": \"other\" },\r\n"
    + "    \"mo\\u0072row\": { \"command\": \"node\" }, /* keep this boundary */\r\n"
    + "  },\r\n"
    + "  \"large\": 9007199254740993123456789,\r\n"
    + "}\r\n";
  const expected = "{\r\n"
    + "  // keep this comment\r\n"
    + "  \"mcpServers\": {\r\n"
    + "    \"other\": { \"command\": \"other\" },\r\n"
    + "     /* keep this boundary */\r\n"
    + "  },\r\n"
    + "  \"large\": 9007199254740993123456789,\r\n"
    + "}\r\n";
  const recorded = await writeFile(target, content);
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "claude-code",
    configured: { "claude-code": { target, sha256: recorded } }
  });
  const calls = [];
  installer.clientConfigModule = async () => ({
    restrictToCurrentAccount() {},
    withoutMorrowClientJson(value, container, serverName, options) {
      calls.push([value, container, serverName, options]);
      if (value === content) return expected;
      if (value === expected) return null;
      throw new Error("unexpected JSONC source");
    }
  });

  await installer.removeAssistant("claude-code");

  assert.equal(await fs.readFile(target, "utf8"), expected);
  assert.deepEqual(calls, [
    [content, "mcpServers", "morrow", { requireMorrowEntry: true }],
    [expected, "mcpServers", "morrow", { requireMorrowEntry: true }],
  ]);
  assert.deepEqual((await installer.record()).configured, {});
  assert.equal(await fs.lstat(installer.assistantRemovalPath).then(() => true, () => false), false);
});

test("a durable removal tombstone recovers a confirmed file removal after the record commit fails", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const project = path.join(root, "Project");
  const target = path.join(project, ".mcp.json");
  const content = `${JSON.stringify({
    mcpServers: { other: { command: "other" }, morrow: { command: "node" } },
    large: "9007199254740993123456789",
  }, null, 2)}\n`;
  const expected = `${JSON.stringify({
    mcpServers: { other: { command: "other" } },
    large: "9007199254740993123456789",
  }, null, 2)}\n`;
  const recorded = await writeFile(target, content);
  const originalRecord = {
    ...freshRecord(),
    selectedAssistantId: "claude-code",
    configured: { "claude-code": { target, sha256: recorded } }
  };
  await installer.writeRecord(originalRecord);
  const durableWriteRecord = installer.writeRecord.bind(installer);
  let refusedCommit = false;
  installer.writeRecord = async (record) => {
    if (!refusedCommit && record.configured?.["claude-code"] === undefined) {
      refusedCommit = true;
      throw new Error("simulated record commit failure");
    }
    return durableWriteRecord(record);
  };

  await assert.rejects(() => installer.removeAssistant("claude-code"), /simulated record commit failure/);

  assert.equal(await fs.readFile(target, "utf8"), expected, "the external removal was confirmed before the record commit failed");
  assert.deepEqual(JSON.parse(await fs.readFile(installer.recordPath, "utf8")), originalRecord);
  const tombstone = JSON.parse(await fs.readFile(installer.assistantRemovalPath, "utf8"));
  assert.equal(tombstone.schema, "morrow.assistant-removal.v1");
  assert.equal(tombstone.assistantId, "claude-code");
  assert.equal(tombstone.target, target);
  assert.equal(tombstone.beforeSha256, recorded);
  assert.equal(tombstone.afterSha256, sha256(Buffer.from(expected)));
  assert.equal((await installer.state()).lifecycle, "repair_required");

  const { installer: restarted } = controller(root);
  let repeatedExternalWrites = 0;
  const writeAssistantConfiguration = restarted.writeAssistantConfiguration.bind(restarted);
  restarted.writeAssistantConfiguration = async (...args) => {
    repeatedExternalWrites += 1;
    return writeAssistantConfiguration(...args);
  };
  const recovered = await restarted.repairInstallerRecord();

  assert.equal(repeatedExternalWrites, 0, "recovery recognized the exact confirmed after digest");
  assert.deepEqual(recovered.configured, {});
  assert.equal(recovered.selectedAssistantId, null);
  assert.deepEqual((await restarted.record()).configured, {});
  assert.equal(await fs.readFile(target, "utf8"), expected);
  assert.equal(await fs.lstat(restarted.assistantRemovalPath).then(() => true, () => false), false);
});

test("recovery completes one removal when interruption happened after the tombstone but before mutation", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const project = path.join(root, "Project");
  const target = path.join(project, ".mcp.json");
  const content = `${JSON.stringify({ mcpServers: { morrow: { command: "node" }, other: { command: "other" } } }, null, 2)}\n`;
  const expected = `${JSON.stringify({ mcpServers: { other: { command: "other" } } }, null, 2)}\n`;
  const recorded = await writeFile(target, content);
  const originalRecord = {
    ...freshRecord(),
    selectedAssistantId: "claude-code",
    configured: { "claude-code": { target, sha256: recorded } }
  };
  await installer.writeRecord(originalRecord);
  const flushed = [];
  const originalOpen = fs.open;
  fs.open = async (...argumentsValue) => {
    const handle = await originalOpen(...argumentsValue);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      flushed.push(String(argumentsValue[0]));
      return originalSync();
    };
    return handle;
  };
  installer.writeAssistantConfiguration = async () => {
    const tombstone = JSON.parse(await fs.readFile(installer.assistantRemovalPath, "utf8"));
    assert.equal(tombstone.target, target);
    assert.equal(tombstone.beforeSha256, recorded);
    assert.equal(tombstone.afterSha256, sha256(Buffer.from(expected)));
    throw new Error("simulated interruption before mutation");
  };

  try {
    await assert.rejects(() => installer.removeAssistant("claude-code"), /simulated interruption before mutation/);
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(flushed.some((file) => file.startsWith(`${installer.assistantRemovalPath}.tmp-`)), true);
  if (process.platform !== "win32") assert.equal(flushed.includes(path.dirname(installer.assistantRemovalPath)), true);
  assert.equal(await fs.readFile(target, "utf8"), content);
  assert.deepEqual(JSON.parse(await fs.readFile(installer.recordPath, "utf8")), originalRecord);

  const { installer: restarted } = controller(root);
  let externalWrites = 0;
  const writeAssistantConfiguration = restarted.writeAssistantConfiguration.bind(restarted);
  restarted.writeAssistantConfiguration = async (...args) => {
    externalWrites += 1;
    return writeAssistantConfiguration(...args);
  };
  await restarted.repairInstallerRecord();

  assert.equal(externalWrites, 1);
  assert.equal(await fs.readFile(target, "utf8"), expected);
  assert.deepEqual((await restarted.record()).configured, {});
  assert.equal(await fs.lstat(restarted.assistantRemovalPath).then(() => true, () => false), false);
});

test("recovery refuses a tombstone retargeted away from the recorded assistant file", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const project = path.join(root, "Project");
  const target = path.join(project, ".mcp.json");
  const foreign = path.join(root, "OtherProject", ".mcp.json");
  const content = `${JSON.stringify({ mcpServers: { morrow: { command: "node" } } }, null, 2)}\n`;
  const foreignContent = `${JSON.stringify({ mcpServers: { private: { command: "other" } } }, null, 2)}\n`;
  const recorded = await writeFile(target, content);
  await writeFile(foreign, foreignContent);
  const originalRecord = {
    ...freshRecord(),
    selectedAssistantId: "claude-code",
    configured: { "claude-code": { target, sha256: recorded } }
  };
  await installer.writeRecord(originalRecord);
  installer.writeAssistantConfiguration = async () => { throw new Error("pause with valid tombstone"); };
  await assert.rejects(() => installer.removeAssistant("claude-code"), /pause with valid tombstone/);
  const tombstone = JSON.parse(await fs.readFile(installer.assistantRemovalPath, "utf8"));
  tombstone.target = foreign;
  await fs.writeFile(installer.assistantRemovalPath, `${JSON.stringify(tombstone)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(installer.assistantRemovalPath, 0o600);

  const { installer: restarted } = controller(root);
  await assert.rejects(() => restarted.repairInstallerRecord(), /assistant_removal_recovery_required/);

  assert.equal(await fs.readFile(target, "utf8"), content);
  assert.equal(await fs.readFile(foreign, "utf8"), foreignContent);
  assert.deepEqual(JSON.parse(await fs.readFile(restarted.recordPath, "utf8")), originalRecord);
});

test("removing Codex recognizes the quoted Morrow table written by valid TOML", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  const content = [
    "model = \"gpt-6\"",
    "",
    "[mcp_servers.\"morrow\"] # equivalent quoted key",
    "command = \"node\"",
    "required = true",
    ""
  ].join("\n");
  const recorded = await writeFile(target, content);
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target, sha256: recorded } }
  });

  await installer.removeAssistant("codex");

  assert.equal(await fs.readFile(target, "utf8"), "model = \"gpt-6\"\n");
  assert.deepEqual((await installer.record()).configured, {});
});

test("removing an assistant Morrow never configured changes nothing and is not an error", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: {} });
  await installer.removeAssistant("gemini-cli");
  assert.deepEqual(await installer.record(), { ...freshRecord(), selectedAssistantId: "codex", configured: {} });
  await assert.rejects(() => installer.removeAssistant("not-an-assistant"), (error) => error.code === "assistant_not_found");
});

test("removing Claude Desktop revokes every generated setup and leaves unrelated state", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const setupRoot = path.join(root, "UserData", "State", "ClaudeDesktop");
  const bundleDirectory = path.join(setupRoot, "setup-current");
  const otherDirectory = path.join(setupRoot, "setup-other");
  const unrelated = path.join(root, "UserData", "State", "support-note.txt");
  const bundlePath = path.join(bundleDirectory, "Morrow.mcpb");
  await writeFile(bundlePath, "bundle");
  await writeFile(path.join(bundleDirectory, "connection.json"), "{}\n");
  await writeFile(path.join(otherDirectory, "Morrow.mcpb"), "another bundle");
  await writeFile(unrelated, "keep this");
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "claude-desktop",
    configured: { "claude-desktop": { bundlePath, installationId: "an-installation", receiptPath: path.join(bundleDirectory, "connection.json") } }
  });

  await installer.removeAssistant("claude-desktop");

  assert.equal(await fs.lstat(bundleDirectory).then(() => true, () => false), false);
  assert.equal(await fs.lstat(otherDirectory).then(() => true, () => false), false, "an unrecorded old generation was revoked too");
  assert.equal(await fs.readFile(unrelated, "utf8"), "keep this");
  assert.deepEqual((await installer.record()).configured, {});
});

test("Claude replacement revokes old roots before activation and restores them when activation fails", async () => {
  const root = await temporaryRoot();
  const materials = path.join(root, "Materials");
  await fs.mkdir(materials);
  const { installer } = controller(root, { platform: CLAUDE_DESKTOP_PLATFORM });
  await claudeRuntimeFixture(installer);
  installer.ensureRuntime = async () => installer.paths;
  const old = await claudeSetupFixture(installer, "setup-old", "old-installation");
  const original = { ...freshRecord(), materialsFolder: materials, selectedAssistantId: "claude-desktop", configured: { "claude-desktop": old } };
  await installer.writeRecord(original);

  const writeRecord = installer.writeRecord.bind(installer);
  let activationObserved = false;
  installer.writeRecord = async (next) => {
    if (next.configured?.["claude-desktop"]?.installationId !== old.installationId) {
      activationObserved = true;
      assert.equal(await fs.lstat(path.dirname(old.bundlePath)).then(() => true, () => false), false,
        "the old source is unavailable before the active record changes");
    }
    return writeRecord(next);
  };
  await installer.installAssistant("claude-desktop", null);
  assert.equal(activationObserved, true);
  const active = (await installer.record()).configured["claude-desktop"];
  assert.notEqual(active.installationId, old.installationId);
  assert.equal(await fs.lstat(path.dirname(old.bundlePath)).then(() => true, () => false), false);

  await installer.removeClaudeDesktopSetup(active);
  const rollbackOld = await claudeSetupFixture(installer, "setup-rollback-old", "rollback-old");
  const rollbackRecord = { ...original, configured: { "claude-desktop": rollbackOld } };
  await writeRecord(rollbackRecord);
  installer.writeRecord = async (next) => {
    if (next.configured?.["claude-desktop"]?.installationId !== rollbackOld.installationId) {
      throw new Error("simulated activation failure");
    }
    return writeRecord(next);
  };
  await assert.rejects(() => installer.installAssistant("claude-desktop", null), { code: "setup_failed" });
  assert.deepEqual(await installer.record(), rollbackRecord);
  assert.equal((await fs.stat(rollbackOld.bundlePath)).isFile(), true, "rollback restored the old source root");
  assert.equal(await installer.readClaudeGenerationTransition(), null);
  assert.deepEqual((await installer.claudeSetupDirectories()).map((value) => path.basename(value)), ["setup-rollback-old"]);
});

test("Claude removal commits revocation before cleanup and a cleanup failure cannot restore authority", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const current = await claudeSetupFixture(installer, "setup-current", "current-installation");
  const stale = await claudeSetupFixture(installer, "setup-stale", "stale-installation");
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "claude-desktop", configured: { "claude-desktop": current } });
  const writeRecord = installer.writeRecord.bind(installer);
  let revokedBeforeCommit = false;
  installer.writeRecord = async (next) => {
    if (!next.configured?.["claude-desktop"]) {
      revokedBeforeCommit = true;
      assert.equal(await fs.lstat(path.dirname(current.bundlePath)).then(() => true, () => false), false);
      assert.equal(await fs.lstat(path.dirname(stale.bundlePath)).then(() => true, () => false), false);
    }
    return writeRecord(next);
  };
  const removeSetup = installer.removeClaudeDesktopSetup.bind(installer);
  installer.removeClaudeDesktopSetup = async (entry) => {
    if (path.basename(path.dirname(entry.bundlePath)).startsWith(".quarantine-")) throw new Error("simulated cleanup failure");
    return removeSetup(entry);
  };

  await installer.removeAssistant("claude-desktop");

  assert.equal(revokedBeforeCommit, true);
  assert.deepEqual((await installer.record()).configured, {});
  assert.equal(await installer.readClaudeGenerationTransition(), null, "cleanup runs only after the durable transition is cleared");
  assert.equal((await installer.claudeSetupDirectories(".quarantine-")).length, 2,
    "failed cleanup leaves only inert quarantine names");
});

test("Claude generation recovery restores before-state or completes committed after-state", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const old = await claudeSetupFixture(installer, "setup-old", "old-installation");
  let next = await claudeSetupFixture(installer, "setup-next", "next-installation");
  const before = { ...freshRecord(), selectedAssistantId: "claude-desktop", configured: { "claude-desktop": old } };
  let after = { ...before, configured: { "claude-desktop": next } };
  await installer.writeRecord(before);

  await installer.stageClaudeGenerationTransition(before, after, next);
  assert.equal(await fs.lstat(path.dirname(old.bundlePath)).then(() => true, () => false), false);
  assert.equal(await installer.recoverClaudeGenerationTransition(), "rolled_back");
  assert.equal((await fs.stat(old.bundlePath)).isFile(), true);
  assert.equal(await fs.lstat(path.dirname(next.bundlePath)).then(() => true, () => false), false);
  assert.equal(await installer.readClaudeGenerationTransition(), null);

  next = await claudeSetupFixture(installer, "setup-next", "next-installation");
  after = { ...before, configured: { "claude-desktop": next } };
  await installer.stageClaudeGenerationTransition(before, after, next);
  await installer.writeRecord(after);
  const { installer: recovered } = controller(root);
  assert.equal(await recovered.recoverClaudeGenerationTransition(), "committed");
  assert.deepEqual(await recovered.record(), after);
  assert.equal(await fs.lstat(path.dirname(old.bundlePath)).then(() => true, () => false), false);
  assert.equal((await fs.stat(next.bundlePath)).isFile(), true);

  const future = await claudeSetupFixture(installer, "setup-future", "future-installation");
  const futureRecord = { ...after, configured: { "claude-desktop": future } };
  await installer.stageClaudeGenerationTransition(after, futureRecord, future);
  await installer.writeRecord({ ...after, selectedAssistantId: null });
  await assert.rejects(() => installer.recoverClaudeGenerationTransition(), /claude_generation_recovery_required/);
  assert.notEqual(await installer.readClaudeGenerationTransition(), null, "an unbound third record leaves recovery fail-closed");
  assert.equal(await fs.lstat(path.dirname(next.bundlePath)).then(() => true, () => false), false,
    "the prior source stays quarantined while authority is ambiguous");
});

test("startup migrates a legacy Claude launcher to an authority-bound generation", async () => {
  const root = await temporaryRoot();
  const materials = path.join(root, "Materials");
  await fs.mkdir(materials);
  const { installer } = controller(root, { platform: CLAUDE_DESKTOP_PLATFORM });
  await claudeRuntimeFixture(installer);
  const legacy = await claudeSetupFixture(installer, "setup-legacy", "legacy-installation");
  await installer.writeRecord({
    ...freshRecord(),
    materialsFolder: materials,
    selectedAssistantId: "claude-desktop",
    configured: { "claude-desktop": legacy },
  });

  await installer.reconcileClaudeDesktopGenerationsAtStartup();

  const active = (await installer.record()).configured["claude-desktop"];
  assert.notEqual(active.installationId, legacy.installationId);
  assert.equal(await fs.lstat(path.dirname(legacy.bundlePath)).then(() => true, () => false), false);
  const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(active.bundlePath), "setup.json"), "utf8"));
  assert.equal(metadata.schema, "morrow.claude-desktop-setup.v3");
  assert.deepEqual(metadata.activeEntry, active);
  assert.equal(metadata.installerRecordPath, await fs.realpath(installer.recordPath));
});

test("a concurrent Claude mutation is refused while revocation owns the desktop transaction", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const current = await claudeSetupFixture(installer, "setup-current", "current-installation");
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "claude-desktop", configured: { "claude-desktop": current } });
  const writeRecord = installer.writeRecord.bind(installer);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const writing = new Promise((resolve) => { entered = resolve; });
  installer.writeRecord = async (next) => {
    if (!next.configured?.["claude-desktop"]) {
      entered();
      await held;
    }
    return writeRecord(next);
  };

  const removal = installer.removeAssistant("claude-desktop");
  await writing;
  await assert.rejects(() => installer.removeAssistant("claude-desktop"), { code: "active_or_uncertain_operations" });
  release();
  await removal;
  assert.deepEqual((await installer.record()).configured, {});
});

test("a removal is refused while another operation holds the runtime, and writes nothing", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  const content = codexTable(path.join(root, "Materials"));
  const recorded = await writeFile(target, content);
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: { codex: { target, sha256: recorded } } });

  installer.restartLeases.set("lease", { close: async () => {} });
  await assert.rejects(() => installer.removeAssistant("codex"), (error) => error.code === "active_or_uncertain_operations");
  installer.restartLeases.delete("lease");
  installer.bridgeLeaseId = "bridge-lease";
  await assert.rejects(() => installer.removeAssistant("codex"), (error) => error.code === "active_or_uncertain_operations");
  installer.bridgeLeaseId = null;

  assert.equal(await fs.readFile(target, "utf8"), content);
  assert.deepEqual((await installer.record()).configured, { codex: { target, sha256: recorded } });
});

test("changing the materials folder writes the new folder into every configured assistant", async () => {
  const root = await temporaryRoot();
  const first = path.join(root, "Materials");
  const chosen = path.join(root, "Fall biology");
  const project = path.join(root, "Project");
  for (const directory of [first, chosen, project]) await fs.mkdir(directory, { recursive: true });
  const codex = path.join(root, "Home", ".codex", "config.toml");
  const claudeCode = path.join(project, ".mcp.json");
  const codexSha256 = await writeFile(codex, `[mcp_servers.other]\ncommand = "other"\n\n${codexTable(first)}`);
  const claudeCodeSha256 = await writeFile(claudeCode, `${JSON.stringify(claudeCodeEntry(first), null, 2)}\n`);
  const { installer, calls } = controller(root, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) }
  });
  await installer.writeRecord({
    ...freshRecord(),
    materialsFolder: first,
    selectedAssistantId: "claude-code",
    configured: { codex: { target: codex, sha256: codexSha256 }, "claude-code": { target: claudeCode, sha256: claudeCodeSha256 } }
  });
  let closed = false;
  installer.runtimeMonitor = { close: async () => { closed = true; } };

  assert.equal(await installer.configureWorkspace(null), true);

  const canonical = await fs.realpath(chosen);
  assert.equal(closed, true, "the runtime that held the old folder was stopped");
  assert.equal((await installer.record()).materialsFolder, canonical);
  // Each assistant is written the folder that was chosen, and the settings
  // that were already in its file are still there.
  const codexContent = await fs.readFile(codex, "utf8");
  assert.equal(codexContent.includes(`cwd = "${canonical}"`), true);
  assert.equal(codexContent.includes(`cwd = "${first}"`), false, "the old folder is gone from the file");
  assert.match(codexContent, /^\[mcp_servers\.other\]\ncommand = "other"\n/);
  assert.equal(codexContent.match(/\[mcp_servers\.morrow\]/g).length, 1, "the entry is written once, not twice");
  assert.equal(JSON.parse(await fs.readFile(claudeCode, "utf8")).mcpServers.morrow.cwd, canonical);

  // The record carries the digest of each file as it is now, so the next
  // change reads a file it can still prove Morrow wrote.
  const record = await installer.record();
  assert.equal(record.configured.codex.sha256, sha256(await fs.readFile(codex)));
  assert.equal(record.configured["claude-code"].sha256, sha256(await fs.readFile(claudeCode)));
  // The client-config CLI names Claude Code "claude", as the install path does.
  assert.deepEqual(calls.map((entry) => `${entry[0]} ${entry[2] || ""}`.trim()), ["mcp codex", "mcp claude"]);
  // The project is the one the record describes, rebuilt from the file Morrow
  // recorded for that assistant, never a fresh guess.
  assert.equal(calls[1][calls[1].indexOf("--client-project") + 1], project);
  // Morrow re-points its own entry by what the entry is, not by the whole file's digest.
  for (const call of calls) {
    assert.equal(call.includes("--replace-morrow-entry"), true);
    assert.equal(call.includes("--expected-config-sha256"), false);
  }
});

test("choosing the folder that is already in use records the choice and rewrites no assistant", async () => {
  const root = await temporaryRoot();
  const materials = path.join(root, "Materials");
  await fs.mkdir(materials, { recursive: true });
  const codex = path.join(root, "Home", ".codex", "config.toml");
  const content = codexTable(materials);
  const codexSha256 = await writeFile(codex, content);
  const { installer, calls } = controller(root, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [materials] }) }
  });
  await installer.writeRecord({
    ...freshRecord(),
    materialsFolder: materials,
    selectedAssistantId: "codex",
    configured: { codex: { target: codex, sha256: codexSha256 } }
  });
  let closed = false;
  installer.runtimeMonitor = { close: async () => { closed = true; } };

  assert.equal(await installer.configureWorkspace(null), true);

  assert.equal((await installer.record()).materialsFolder, await fs.realpath(materials), "the choice is recorded");
  assert.deepEqual(calls, [], "no assistant was written again for a folder that did not change");
  assert.equal(closed, false, "the runtime kept running");
  assert.equal(await fs.readFile(codex, "utf8"), content);
});

test("a materials folder change is refused while another operation holds the runtime, and asks for no folder", async () => {
  const root = await temporaryRoot();
  const chosen = path.join(root, "Fall biology");
  await fs.mkdir(chosen, { recursive: true });
  let asked = 0;
  const { installer } = controller(root, {
    dialog: { showOpenDialog: async () => { asked += 1; return { canceled: false, filePaths: [chosen] }; } }
  });
  installer.restartLeases.set("lease", { close: async () => {} });

  await assert.rejects(() => installer.configureWorkspace(null), (error) => error.code === "active_or_uncertain_operations");
  assert.equal(asked, 0, "no folder was asked for from a refused change");
  assert.equal((await installer.record()).materialsFolder, undefined);
});

test("a foreign configured path enters record recovery before a folder change writes anything", async () => {
  const root = await temporaryRoot();
  const chosen = path.join(root, "Fall biology");
  await fs.mkdir(chosen, { recursive: true });
  // A record carried over from another computer: the Codex file it names is
  // not the file this computer's home folder produces.
  const foreign = path.join(root, "Elsewhere", ".codex", "config.toml");
  const foreignSha256 = await writeFile(foreign, codexTable(path.join(root, "Materials")));
  const { installer, calls } = controller(root, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) }
  });
  const stored = {
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target: foreign, sha256: foreignSha256 } }
  };
  await fs.mkdir(installer.paths.state, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(installer.paths.state, 0o700);
  await fs.writeFile(installer.recordPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  let closed = false;
  installer.runtimeMonitor = { close: async () => { closed = true; } };

  assert.equal((await installer.state()).lifecycle, "repair_required");
  await assert.rejects(() => installer.configureWorkspace(null), /record_invalid/);
  assert.equal(JSON.parse(await fs.readFile(installer.recordPath, "utf8")).materialsFolder, undefined, "the folder Morrow uses did not change");
  assert.equal(closed, false, "the runtime kept running");
  assert.deepEqual(calls, []);
  assert.equal(sha256(await fs.readFile(foreign)), foreignSha256);
});

test("a refused folder change keeps the assistant configuration and workspace record unchanged", async () => {
  const root = await temporaryRoot();
  const chosen = path.join(root, "Fall biology");
  await fs.mkdir(chosen, { recursive: true });
  const codex = path.join(root, "Home", ".codex", "config.toml");
  const originalMaterials = path.join(root, "Materials");
  await fs.mkdir(originalMaterials, { recursive: true });
  const original = codexTable(originalMaterials);
  const codexSha256 = await writeFile(codex, original);
  const { installer } = controller(root, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) },
    runCli: async () => ({ code: 1, stdout: "", stderr: "Refusing to replace existing Morrow server morrow" })
  });
  await installer.writeRecord({
    ...freshRecord(),
    materialsFolder: originalMaterials,
    selectedAssistantId: "codex",
    configured: { codex: { target: codex, sha256: codexSha256 } }
  });

  await assert.rejects(() => installer.configureWorkspace(null), (error) => error.code === "existing_morrow_configuration");
  assert.equal(await fs.readFile(codex, "utf8"), original);
  assert.equal((await installer.record()).materialsFolder, originalMaterials);
});

test("a later assistant refusal rolls every earlier folder rebind back", async () => {
  const root = await temporaryRoot();
  const originalMaterials = path.join(root, "Materials");
  const chosen = path.join(root, "Fall biology");
  const project = path.join(root, "Project");
  for (const directory of [originalMaterials, chosen, project]) await fs.mkdir(directory, { recursive: true });
  const codex = path.join(root, "Home", ".codex", "config.toml");
  const claudeCode = path.join(project, ".mcp.json");
  const originalCodex = `[mcp_servers.other]\ncommand = "other"\n\n${codexTable(originalMaterials)}`;
  const originalClaudeCode = `${JSON.stringify(claudeCodeEntry(originalMaterials), null, 2)}\n`;
  const codexSha256 = await writeFile(codex, originalCodex);
  const claudeCodeSha256 = await writeFile(claudeCode, originalClaudeCode);
  const { installer } = controller(root, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) },
    refuseClientId: "claude"
  });
  const originalRecord = {
    ...freshRecord(),
    materialsFolder: originalMaterials,
    selectedAssistantId: "claude-code",
    configured: {
      codex: { target: codex, sha256: codexSha256 },
      "claude-code": { target: claudeCode, sha256: claudeCodeSha256 }
    }
  };
  await installer.writeRecord(originalRecord);

  await assert.rejects(() => installer.configureWorkspace(null), (error) => error.code === "existing_morrow_configuration");

  assert.equal(await fs.readFile(codex, "utf8"), originalCodex);
  assert.equal(await fs.readFile(claudeCode, "utf8"), originalClaudeCode);
  assert.deepEqual(await installer.record(), originalRecord);
});

test("an assistant edit made before a folder rebind is kept, and only Morrow's entry moves", async () => {
  const root = await temporaryRoot();
  const originalMaterials = path.join(root, "Materials");
  const chosen = path.join(root, "Fall biology");
  for (const directory of [originalMaterials, chosen]) await fs.mkdir(directory, { recursive: true });
  const codex = path.join(root, "Home", ".codex", "config.toml");
  const original = codexTable(originalMaterials);
  const edited = `[mcp_servers.other]\ncommand = "newer"\n\n${original}\n[projects."/x"]\ntrust_level = "trusted"\n`;
  const recorded = await writeFile(codex, original);
  let changed = false;
  const { installer, calls } = controller(root, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) },
    beforeClientInstall: async ({ target }) => {
      if (changed) return;
      changed = true;
      await fs.writeFile(target, edited);
    }
  });
  await installer.writeRecord({
    ...freshRecord(),
    materialsFolder: originalMaterials,
    selectedAssistantId: "codex",
    configured: { codex: { target: codex, sha256: recorded } }
  });

  assert.equal(await installer.configureWorkspace(null), true);

  const canonical = await fs.realpath(chosen);
  const content = await fs.readFile(codex, "utf8");
  assert.equal(content, `[mcp_servers.other]\ncommand = "newer"\n\n${codexTable(canonical)}\n[projects."/x"]\ntrust_level = "trusted"\n`);
  assert.equal((await installer.record()).configured.codex.sha256, sha256(Buffer.from(content)));
  assert.equal(calls[0].includes("--replace-morrow-entry"), true);
});

test("an earlier assistant edit during a later rebind prevents the workspace commit", async () => {
  const root = await temporaryRoot();
  const originalMaterials = path.join(root, "Materials");
  const chosen = path.join(root, "Fall biology");
  const project = path.join(root, "Project");
  for (const directory of [originalMaterials, chosen, project]) await fs.mkdir(directory, { recursive: true });
  const codex = path.join(root, "Home", ".codex", "config.toml");
  const claudeCode = path.join(project, ".mcp.json");
  const originalCodex = codexTable(originalMaterials);
  const concurrentCodex = `[mcp_servers.other]\ncommand = "newer"\n\n${codexTable(chosen)}`;
  const originalClaudeCode = `${JSON.stringify(claudeCodeEntry(originalMaterials), null, 2)}\n`;
  const codexSha256 = await writeFile(codex, originalCodex);
  const claudeCodeSha256 = await writeFile(claudeCode, originalClaudeCode);
  const { installer } = controller(root, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) },
    beforeClientInstall: async ({ args }) => {
      if (args[2] === "claude") await fs.writeFile(codex, concurrentCodex);
    }
  });
  const originalRecord = {
    ...freshRecord(),
    materialsFolder: originalMaterials,
    selectedAssistantId: "claude-code",
    configured: {
      codex: { target: codex, sha256: codexSha256 },
      "claude-code": { target: claudeCode, sha256: claudeCodeSha256 }
    }
  };
  await installer.writeRecord(originalRecord);

  await assert.rejects(() => installer.configureWorkspace(null), (error) => error.code === "assistant_configuration_changed");

  assert.equal(await fs.readFile(codex, "utf8"), concurrentCodex);
  assert.equal(await fs.readFile(claudeCode, "utf8"), originalClaudeCode);
  assert.deepEqual(await installer.record(), originalRecord);
});

test("a folder change makes the Claude Desktop extension again, for the folder that was chosen", async () => {
  const root = await temporaryRoot();
  const chosen = path.join(root, "Fall biology");
  await fs.mkdir(chosen, { recursive: true });
  // Claude Desktop is configured by an extension a person approves, so the
  // folder is inside the extension Morrow generates.
  const { installer } = controller(root, {
    platform: CLAUDE_DESKTOP_PLATFORM,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) }
  });
  for (const file of [installer.paths.node, installer.paths.server, installer.paths.upstreams]) await writeFile(file, "fixture");
  const serverBytes = await fs.readFile(installer.paths.server);
  await writeFile(installer.paths.mcpRuntimeManifest, `${JSON.stringify({
    schema: "morrow.mcp-runtime-manifest.v2",
    package: { name: "@morrow-lms/gateway", version: "1.0.0-rc.0" },
    entrypoint: {
      path: "packages/mcp-server/dist/index.js",
      bytes: serverBytes.length,
      sha256: sha256(serverBytes)
    },
    dependencies: [],
    directFiles: []
  })}\n`);
  const previousBundle = path.join(root, "UserData", "State", "ClaudeDesktop", "setup-previous", "Morrow.mcpb");
  await writeFile(previousBundle, "the bundle for the folder in use now");
  await installer.writeRecord({
    ...freshRecord(),
    materialsFolder: path.join(root, "Materials"),
    selectedAssistantId: "claude-desktop",
    configured: { "claude-desktop": { bundlePath: previousBundle, installationId: "an-installation", receiptPath: path.join(path.dirname(previousBundle), "connection.json") } }
  });
  await fs.mkdir(path.join(root, "Materials"), { recursive: true });

  assert.equal(await installer.configureWorkspace(null), true);

  const entry = (await installer.record()).configured["claude-desktop"];
  assert.notEqual(entry.bundlePath, previousBundle);
  assert.equal((await fs.stat(entry.bundlePath)).isFile(), true, "the extension for the folder that was chosen is on disk");
  assert.notEqual(entry.installationId, "an-installation", "the new extension is a new connection to approve");
  assert.equal(await fs.lstat(path.dirname(previousBundle)).then(() => true, () => false), false, "the extension it replaces is gone");
  const launcher = await fs.readFile(path.join(path.dirname(entry.bundlePath), "bundle", "server", "launch.cjs"), "utf8");
  assert.equal(launcher.includes(JSON.stringify(await fs.realpath(chosen))), true, "the extension starts Morrow in the folder that was chosen");
});

/**
 * Loads installer/preload.cjs against a stand-in Electron, so the bridge it
 * exposes is the one this test calls. The module is removed from the cache
 * again, so nothing else loads the stand-in.
 */
function loadPreload() {
  const electronPath = require.resolve("electron", { paths: [path.resolve(__dirname, "..")] });
  const preloadPath = require.resolve("../preload.cjs");
  const invocations = [];
  let bridge = null;
  const previous = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    path: path.dirname(electronPath),
    loaded: true,
    children: [],
    paths: [],
    exports: {
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (...args) => { invocations.push(args); return { ok: true }; } }
    }
  };
  delete require.cache[preloadPath];
  try {
    require(preloadPath);
  } finally {
    delete require.cache[preloadPath];
    if (previous) require.cache[electronPath] = previous;
    else delete require.cache[electronPath];
  }
  return { bridge, invocations };
}

test("the setup page can ask for a removal, and for nothing the preload does not name", async () => {
  const { bridge, invocations } = loadPreload();
  await bridge.invoke("installer:remove-assistant", { assistantId: "codex" });
  assert.deepEqual(invocations, [["installer:remove-assistant", { assistantId: "codex" }]]);
  await assert.rejects(() => bridge.invoke("installer:remove-anything", {}), /Unsupported Morrow action\./);

  // The main process answers that channel, and the setup page asks for it.
  const installerRoot = path.resolve(__dirname, "..");
  const main = await fs.readFile(path.join(installerRoot, "main.cjs"), "utf8");
  const renderer = await fs.readFile(path.join(installerRoot, "renderer", "renderer.js"), "utf8");
  assert.match(main, /ipcMain\.handle\("installer:remove-assistant"/);
  assert.match(main, /await installer\.removeAssistant\(assertAssistantId\(input\.assistantId\)\);/);
  assert.match(renderer, /invoke\("installer:remove-assistant", \{ assistantId \}\)/);

  // The refusal a drifted settings file raises is a code the result envelope
  // carries, so the setup page reads that exact reason instead of a generic one.
  const refused = envelope(repairRequiredState(), errorDetails("assistant_configuration_changed"));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "assistant_configuration_changed");
  assert.equal(refused.error.message, "That assistant's settings file changed after Morrow wrote it.");
});

/** A runtime that is ready, with one connected course, without a payload. */
function readyRuntime() {
  return {
    schema: "morrow.installer-runtime.v1",
    health: { attempted: true, gatewayReady: true, bridgeConnected: true, canRestart: "yes" },
    bindings: { runtimeVerifiedCourseCount: 1, selectedCourseName: "BIOL 101" },
    firstPreview: { available: "yes", completed: false }
  };
}

test("two configured assistants both report configured, and the lifecycle stays ready", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const materials = path.join(root, "Materials");
  const project = path.join(root, "Project");
  for (const directory of [materials, project]) await fs.mkdir(directory, { recursive: true });
  const codex = path.join(root, "Home", ".codex", "config.toml");
  const claudeCode = path.join(project, ".mcp.json");
  const codexSha256 = await writeFile(codex, codexTable(materials));
  const claudeCodeSha256 = await writeFile(claudeCode, `${JSON.stringify(claudeCodeEntry(materials), null, 2)}\n`);
  await installer.writeRecord({
    ...freshRecord(),
    materialsFolder: materials,
    selectedAssistantId: "claude-code",
    configured: { codex: { target: codex, sha256: codexSha256 }, "claude-code": { target: claudeCode, sha256: claudeCodeSha256 } }
  });
  // The payload and the runtime are exercised by their own tests. This case is
  // about what the state says when more than one assistant is configured.
  installer.ensureRuntime = async () => installer.paths;
  installer.runtimeSnapshot = async () => readyRuntime();

  const state = await installer.state();
  assert.equal(state.lifecycle, "ready");
  assert.equal(state.materialsFolder, await fs.realpath(materials));
  const configured = state.assistants.filter((assistant) => assistant.configured === true).map((assistant) => assistant.id);
  assert.deepEqual(configured, ["codex", "claude-code"]);
  assert.equal(state.selectedAssistantId, "claude-code");
  assert.equal(state.assistants.find((assistant) => assistant.id === "codex").selected, false);

  // Removing the assistant that was selected leaves the other one ready.
  await installer.removeAssistant("claude-code");
  const after = await installer.state();
  assert.equal(after.lifecycle, "ready");
  assert.deepEqual(after.assistants.filter((assistant) => assistant.configured === true).map((assistant) => assistant.id), ["codex"]);
  assert.equal(after.selectedAssistantId, "codex");
});

test("an assistant added after setup does not take the lifecycle back while it waits for approval", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const materials = path.join(root, "Materials");
  await fs.mkdir(materials, { recursive: true });
  const codex = path.join(root, "Home", ".codex", "config.toml");
  const codexSha256 = await writeFile(codex, codexTable(materials));
  const bundlePath = path.join(root, "UserData", "State", "ClaudeDesktop", "setup-new", "Morrow.mcpb");
  await writeFile(bundlePath, "bundle");
  await installer.writeRecord({
    ...freshRecord(),
    materialsFolder: materials,
    // Claude Desktop was added second, so it is the most recent selection while
    // its approval inside Claude Desktop has not happened yet.
    selectedAssistantId: "claude-desktop",
    configured: {
      codex: { target: codex, sha256: codexSha256 },
      "claude-desktop": { bundlePath, installationId: "an-installation", receiptPath: path.join(path.dirname(bundlePath), "connection.json") }
    }
  });
  installer.ensureRuntime = async () => installer.paths;
  installer.runtimeSnapshot = async () => readyRuntime();

  const state = await installer.state();
  assert.equal(state.lifecycle, "ready", "the assistant that already works keeps the setup where it is");
  const claude = state.assistants.find((assistant) => assistant.id === "claude-desktop");
  assert.equal(claude.configured, false);
  assert.equal(claude.pending, true);
  assert.equal(state.assistants.find((assistant) => assistant.id === "codex").configured, true);
});

test("a saved configuration is not ready while its assistant is unavailable", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root, { detectAssistant: async () => false });
  const materials = path.join(root, "Materials");
  const codex = path.join(root, "Home", ".codex", "config.toml");
  await fs.mkdir(materials, { recursive: true });
  const codexSha256 = await writeFile(codex, codexTable(materials));
  await installer.writeRecord({
    ...freshRecord(),
    materialsFolder: materials,
    selectedAssistantId: "codex",
    configured: { codex: { target: codex, sha256: codexSha256 } },
  });
  installer.ensureRuntime = async () => installer.paths;
  installer.runtimeSnapshot = async () => readyRuntime();

  const state = await installer.state();
  const assistant = state.assistants.find((entry) => entry.id === "codex");
  assert.equal(assistant.configured, true);
  assert.equal(assistant.detected, false);
  assert.equal(state.lifecycle, "ready_for_assistant");
});

test("removing Morrow keeps the settings file's own mode, and refuses a read-only file", { skip: process.platform === "win32" }, async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  const recorded = await writeFile(target, `model = "gpt-6"\n\n${codexTable(path.join(root, "Materials"))}`);
  await fs.chmod(target, 0o644);
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: { codex: { target, sha256: recorded } } });
  await installer.removeAssistant("codex");
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);

  const locked = `model = "gpt-6"\n\n${codexTable(path.join(root, "Materials"))}`;
  const lockedSha256 = await writeFile(target, locked);
  await fs.chmod(target, 0o444);
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: { codex: { target, sha256: lockedSha256 } } });
  await assert.rejects(() => installer.removeAssistant("codex"), (error) => error.code === "assistant_config_read_only" && error.file === target);
  assert.equal(await fs.readFile(target, "utf8"), locked);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o444);
  await fs.chmod(target, 0o644);
});
