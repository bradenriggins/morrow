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

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-assistant-management-"));
  await fs.mkdir(path.join(root, "UserData"), { recursive: true });
  await fs.mkdir(path.join(root, "Home"), { recursive: true });
  await fs.mkdir(path.join(root, "Payload"), { recursive: true });
  // Writing an assistant's configuration restricts the file to this account on
  // win32 before checking its digest, through the real client-config module.
  const clientConfig = path.join(root, "Payload", "app", "packages", "client-config", "dist");
  await fs.mkdir(clientConfig, { recursive: true });
  await fs.writeFile(path.join(clientConfig, "index.js"), "export function restrictToCurrentAccount() {}\n");
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
    "required = true",
    ""
  ].join("\n");
}

function claudeCodeEntry(workspaceRoot) {
  return { mcpServers: { morrow: { type: "stdio", command: "node", cwd: workspaceRoot } } };
}

async function writeFile(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return sha256(await fs.readFile(target));
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
          const withoutMorrow = current.replace(/(?:^|\n)\[mcp_servers\.morrow\]\n[\s\S]*$/, "").trimEnd();
          await writeFile(target, `${withoutMorrow}${withoutMorrow ? "\n\n" : ""}${codexTable(workspaceRoot)}`);
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

test("removing an assistant whose settings file changed after Morrow wrote it is refused, and changes nothing", async () => {
  const root = await temporaryRoot();
  const { installer, calls } = controller(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  const recorded = await writeFile(target, codexTable(path.join(root, "Materials")));
  const edited = `[mcp_servers.other]\ncommand = "other"\n\n${codexTable(path.join(root, "Materials"))}`;
  await writeFile(target, edited);
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target, sha256: recorded } }
  });

  await assert.rejects(() => installer.removeAssistant("codex"), (error) => {
    assert.equal(error.code, "assistant_configuration_changed");
    assert.equal(error.message, "That assistant's settings file changed after Morrow wrote it.");
    assert.equal(error.recovery, `Morrow left ${target} exactly as it is. Open it, remove the morrow entry yourself, then select Check status.`);
    return true;
  });
  assert.equal(await fs.readFile(target, "utf8"), edited, "the file is exactly as it was, byte for byte");
  assert.deepEqual((await installer.record()).configured, { codex: { target, sha256: recorded } });
  assert.deepEqual(calls, [], "no command ran against that file");
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

test("removing an assistant Morrow never configured changes nothing and is not an error", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: {} });
  await installer.removeAssistant("gemini-cli");
  assert.deepEqual(await installer.record(), { ...freshRecord(), selectedAssistantId: "codex", configured: {} });
  await assert.rejects(() => installer.removeAssistant("not-an-assistant"), (error) => error.code === "assistant_not_found");
});

test("removing Claude Desktop removes the bundle Morrow made and nothing beside it", async () => {
  const root = await temporaryRoot();
  const { installer } = controller(root);
  const setupRoot = path.join(root, "UserData", "State", "ClaudeDesktop");
  const bundleDirectory = path.join(setupRoot, "setup-current");
  const otherDirectory = path.join(setupRoot, "setup-other");
  const bundlePath = path.join(bundleDirectory, "Morrow.mcpb");
  await writeFile(bundlePath, "bundle");
  await writeFile(path.join(bundleDirectory, "connection.json"), "{}\n");
  await writeFile(path.join(otherDirectory, "Morrow.mcpb"), "another bundle");
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "claude-desktop",
    configured: { "claude-desktop": { bundlePath, installationId: "an-installation", receiptPath: path.join(bundleDirectory, "connection.json") } }
  });

  await installer.removeAssistant("claude-desktop");

  assert.equal(await fs.lstat(bundleDirectory).then(() => true, () => false), false);
  assert.equal((await fs.stat(path.join(otherDirectory, "Morrow.mcpb"))).isFile(), true, "only the recorded bundle was removed");
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
  assert.equal(calls[0][calls[0].indexOf("--expected-config-sha256") + 1], codexSha256);
  assert.equal(calls[1][calls[1].indexOf("--expected-config-sha256") + 1], claudeCodeSha256);
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

test("a folder change stops before it writes anything when the record names a file this computer cannot rebuild", async () => {
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
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target: foreign, sha256: foreignSha256 } }
  });
  let closed = false;
  installer.runtimeMonitor = { close: async () => { closed = true; } };

  await assert.rejects(() => installer.configureWorkspace(null), (error) => error.code === "setup_failed");
  assert.equal((await installer.record()).materialsFolder, undefined, "the folder Morrow uses did not change");
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

test("a concurrent assistant edit during folder rebind is never replaced or rolled back", async () => {
  const root = await temporaryRoot();
  const originalMaterials = path.join(root, "Materials");
  const chosen = path.join(root, "Fall biology");
  for (const directory of [originalMaterials, chosen]) await fs.mkdir(directory, { recursive: true });
  const codex = path.join(root, "Home", ".codex", "config.toml");
  const original = codexTable(originalMaterials);
  const edited = `[mcp_servers.other]\ncommand = "newer"\n\n${original}`;
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
  const originalRecord = {
    ...freshRecord(),
    materialsFolder: originalMaterials,
    selectedAssistantId: "codex",
    configured: { codex: { target: codex, sha256: recorded } }
  };
  await installer.writeRecord(originalRecord);

  await assert.rejects(() => installer.configureWorkspace(null), (error) => error.code === "existing_morrow_configuration");

  assert.equal(await fs.readFile(codex, "utf8"), edited);
  assert.deepEqual(await installer.record(), originalRecord);
  assert.equal(calls[0][calls[0].indexOf("--expected-config-sha256") + 1], recorded);
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
  // folder is inside the extension Morrow generates. The platform is fixed
  // here because Claude Desktop documents this file for macOS and Windows.
  const { installer } = controller(root, {
    platform: "darwin",
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) }
  });
  for (const file of [installer.paths.node, installer.paths.server, installer.paths.upstreams]) await writeFile(file, "fixture");
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
