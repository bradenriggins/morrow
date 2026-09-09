/**
 * The contract between the packaged desktop app and packages/client-config.
 *
 * The desktop app never writes an assistant configuration file itself. It runs
 * the client-config CLI with the paths from its own payload layout, and reads
 * the file back. Two things therefore have to hold, and neither is proven by
 * either package's own tests: the paths that reach the assistant file are the
 * packaged ones, and the file the installer reads back is the file
 * client-config wrote. This test binds them together.
 *
 * Evidence class: hermetic file-layer proof on this computer's platform. It is
 * not proof that any assistant application read the file it produced, and it is
 * not proof of a Windows install. `morrowClientConfigPath` takes a platform, so
 * the documented Windows location is checked here from a Windows-shaped
 * environment; every other path in this file is produced by this computer's own
 * path rules.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MorrowClientConfigRefusal,
  SUPPORTED_MORROW_CLIENTS,
  installMorrowClient,
  morrowClientConfigPath,
} from "../../packages/client-config/dist/index.js";

const require = createRequire(import.meta.url);
const { clientConfigTarget } = require("../../installer/shared/installer-controller.cjs");
const { payloadLayout } = require("../../installer/shared/runtime.cjs");

/** The assistants the desktop app configures through the client-config CLI. */
const DESKTOP_ASSISTANTS = Object.freeze([
  { id: "codex", needsProject: false },
  { id: "claude-code", needsProject: true },
  { id: "gemini-cli", needsProject: true },
]);

/**
 * A payload the desktop app would ship, with the exact files installMorrowClient
 * requires to exist, plus the materials folder and the project the installer
 * passes. Everything is canonical, so an expected path is the written path.
 */
async function packagedInstallation(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "morrow-client-install-contract-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = payloadLayout(path.join(root, "Payload"), path.join(root, "UserData"));
  mkdirSync(path.dirname(paths.server), { recursive: true });
  writeFileSync(paths.server, "console.error('packaged Morrow MCP server fixture');\n", "utf8");
  mkdirSync(path.dirname(paths.node), { recursive: true });
  writeFileSync(paths.node, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(paths.node, 0o755);
  mkdirSync(paths.state, { recursive: true });
  writeFileSync(paths.upstreams, "{}\n", "utf8");
  const materials = path.join(root, "Materials");
  const project = path.join(root, "Project");
  const home = path.join(root, "Home");
  for (const directory of [materials, project, home]) mkdirSync(directory, { recursive: true });
  return { root, paths, materials, project, home };
}

/** The arguments installer/shared/installer-controller.cjs passes for one client. */
function installerOptions({ paths, materials, project }, client, scope) {
  return {
    client,
    scope,
    repositoryRoot: paths.appRoot,
    upstreamConfigPath: paths.upstreams,
    nodeCommand: paths.node,
    serverEntryPath: paths.server,
    workspaceRoot: materials,
    ...(scope === "project" ? { projectRoot: project } : {}),
  };
}

function withHome(home, work) {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return work();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
}

/** The refusal one call produced, so its code and next action can be read. */
function refusalOf(attempt) {
  try {
    attempt();
  } catch (error) {
    if (error instanceof MorrowClientConfigRefusal) return error;
    throw error;
  }
  throw new assert.AssertionError({ message: "expected a Morrow client configuration refusal" });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("every supported client is configured with the packaged Morrow paths, never a repository path", async (t) => {
  const installation = await packagedInstallation(t);
  const { paths, materials, project, home } = installation;
  const stdio = {
    type: "stdio",
    command: paths.node,
    args: [paths.server],
    cwd: materials,
    env: { MORROW_UPSTREAMS_FILE: paths.upstreams },
  };
  // Cursor documents no cwd field, so Morrow runs where Cursor starts it.
  const { cwd: _cursorHasNoCwd, ...cursorEntry } = stdio;
  const expected = {
    codex: { scope: "user", file: path.join(home, ".codex", "config.toml") },
    "claude-code": { scope: "project", file: path.join(project, ".mcp.json"), container: "mcpServers", entry: stdio },
    "claude-desktop": {
      scope: "user",
      file: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      container: "mcpServers",
      entry: stdio,
      platforms: ["darwin"],
    },
    "gemini-cli": {
      scope: "project",
      file: path.join(project, ".gemini", "settings.json"),
      container: "mcpServers",
      entry: { command: paths.node, args: [paths.server], cwd: materials, env: stdio.env, timeout: 900_000, trust: false },
    },
    cursor: { scope: "project", file: path.join(project, ".cursor", "mcp.json"), container: "mcpServers", entry: cursorEntry },
    vscode: { scope: "project", file: path.join(project, ".vscode", "mcp.json"), container: "servers", entry: stdio },
  };
  assert.deepEqual([...SUPPORTED_MORROW_CLIENTS].sort(), Object.keys(expected).sort(),
    "every supported client needs its packaged-path expectation here");

  for (const client of SUPPORTED_MORROW_CLIENTS) {
    const target = expected[client];
    if (target.platforms && !target.platforms.includes(process.platform)) continue;
    const installed = withHome(home, () => installMorrowClient(installerOptions(installation, client, target.scope)));
    assert.equal(installed.path, target.file, `${client} is written where its documentation says`);
    assert.equal(installed.changed, true);
    assert.match(installed.sha256, /^[0-9a-f]{64}$/);
    assert.equal((await stat(installed.path)).mode & 0o777, 0o600, `${client} keeps its configuration private`);
    const content = readFileSync(installed.path, "utf8");
    if (client === "codex") {
      assert.equal(content.includes("[mcp_servers.morrow]"), true);
      assert.equal(content.includes(`command = ${JSON.stringify(paths.node)}`), true);
      assert.equal(content.includes(`args = [${JSON.stringify(paths.server)}]`), true);
      assert.equal(content.includes(`cwd = ${JSON.stringify(materials)}`), true);
      assert.equal(content.includes(`env = { MORROW_UPSTREAMS_FILE = ${JSON.stringify(paths.upstreams)} }`), true);
      assert.equal(content.includes("startup_timeout_sec = 60"), true);
      assert.equal(content.includes("tool_timeout_sec = 900"), true);
    } else {
      assert.deepEqual(readJson(installed.path), { [target.container]: { morrow: target.entry } });
    }
    // The packaged app is the only Morrow on the computer: nothing may point at
    // a checkout, and the upstream file lives beside the installation's state.
    assert.equal(content.includes(paths.appRoot), true, `${client} names the packaged app root`);
    assert.equal(content.includes(process.execPath), false, `${client} never names the Node that ran setup`);
    assert.equal(paths.server.startsWith(`${paths.appRoot}${path.sep}`), true);
    assert.equal(paths.upstreams.startsWith(`${paths.state}${path.sep}`), true);
    // Installing the same packaged paths again changes nothing at all.
    const again = withHome(home, () => installMorrowClient(installerOptions(installation, client, target.scope)));
    assert.deepEqual(again, { ...installed, changed: false });
  }
});

test("the installer and client-config name the same file for every assistant the installer configures", async (t) => {
  const { project, home } = await packagedInstallation(t);
  for (const assistant of DESKTOP_ASSISTANTS) {
    const scope = assistant.needsProject ? "project" : "user";
    assert.equal(
      clientConfigTarget(assistant, home, assistant.needsProject ? project : null),
      morrowClientConfigPath({ client: assistant.id, scope, projectRoot: project, homeDirectory: home }),
      `${assistant.id} must be the same file on both sides`,
    );
  }
  // Claude Desktop is installed through its own bundle, not this table, and the
  // installer returns nothing rather than guessing a file for it.
  assert.equal(clientConfigTarget({ id: "claude-desktop" }, home, project), null);
});

test("installing Morrow keeps every unrelated setting, and repair replaces only the entry Morrow recorded", async (t) => {
  const installation = await packagedInstallation(t);
  const { paths, project, home } = installation;
  const existing = `${JSON.stringify({
    mcpServers: {
      "another-server": { command: "/usr/local/bin/other", args: ["--serve"], env: { OTHER: "1" } },
    },
    projectNotes: "kept by the person who wrote this file",
  }, null, 4)}\n`;
  const file = path.join(project, ".mcp.json");
  writeFileSync(file, existing, "utf8");

  const installed = withHome(home, () => installMorrowClient(installerOptions(installation, "claude-code", "project")));
  const merged = readJson(file);
  assert.deepEqual(merged.mcpServers["another-server"], { command: "/usr/local/bin/other", args: ["--serve"], env: { OTHER: "1" } });
  assert.equal(merged.projectNotes, "kept by the person who wrote this file");
  assert.equal(merged.mcpServers.morrow.args[0], paths.server);
  assert.equal(readFileSync(file, "utf8").includes('    "another-server"'), true, "the person's own indentation is kept");

  // A second Morrow entry is refused without the recorded digest, whatever it
  // says, so setup can never quietly replace an entry somebody else wrote.
  writeFileSync(file, `${JSON.stringify({ ...merged, mcpServers: { ...merged.mcpServers, morrow: { command: "somebody-elses-morrow" } } }, null, 4)}\n`, "utf8");
  const changedByHand = readFileSync(file, "utf8");
  assert.throws(
    () => withHome(home, () => installMorrowClient(installerOptions(installation, "claude-code", "project"))),
    /Refusing to replace existing Morrow server morrow/,
  );
  assert.equal(readFileSync(file, "utf8"), changedByHand, "the refused install changed nothing");

  // Repair carries the digest Morrow recorded. It replaces its own entry when
  // the file is still exactly what Morrow wrote, and refuses once anything else
  // has edited that file.
  const { createHash } = await import("node:crypto");
  const digestOf = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  const repaired = withHome(home, () => installMorrowClient({
    ...installerOptions(installation, "claude-code", "project"),
    expectedConfigSha256: digestOf(changedByHand),
  }));
  assert.equal(repaired.changed, true);
  assert.equal(readJson(file).mcpServers.morrow.args[0], paths.server);
  assert.deepEqual(readJson(file).mcpServers["another-server"], { command: "/usr/local/bin/other", args: ["--serve"], env: { OTHER: "1" } });
  assert.throws(
    () => withHome(home, () => installMorrowClient({
      ...installerOptions(installation, "claude-code", "project"),
      expectedConfigSha256: digestOf(existing),
    })),
    /changed after Morrow recorded it/,
  );
  assert.equal(digestOf(readFileSync(file, "utf8")), repaired.sha256, "the refused repair left the file it read back");
});

test("the documented Windows location is read from a Windows-shaped environment, or refused by name", async () => {
  const windowsDesktop = (overrides = {}) => morrowClientConfigPath({
    client: "claude-desktop",
    scope: "user",
    platform: "win32",
    ...overrides,
  });
  assert.equal(
    windowsDesktop({ applicationDataDirectory: "C:\\Users\\instructor\\AppData\\Roaming" }),
    "C:\\Users\\instructor\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  );
  // A roaming profile on a file server is an absolute Windows path too.
  assert.equal(
    windowsDesktop({ applicationDataDirectory: "\\\\campus-files\\staff\\instructor\\AppData\\Roaming" }),
    "\\\\campus-files\\staff\\instructor\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  );

  const previousApplicationData = process.env.APPDATA;
  try {
    // Morrow reads %APPDATA% from the environment when nothing hands it one.
    process.env.APPDATA = "D:\\Profiles\\instructor\\AppData\\Roaming";
    assert.equal(windowsDesktop(), "D:\\Profiles\\instructor\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
    for (const value of ["", "   ", "AppData\\Roaming", "..\\Roaming"]) {
      process.env.APPDATA = value;
      const refusal = refusalOf(() => windowsDesktop());
      assert.equal(refusal.code, "client_configuration_location_unknown");
      assert.equal(refusal.platform, "win32");
      assert.equal(refusal.nextAction.includes("Edit Config"), true, "the refusal names what to do instead");
    }
    delete process.env.APPDATA;
    assert.equal(refusalOf(() => windowsDesktop()).code, "client_configuration_location_unknown");
    // A Windows-shaped folder never produces a Windows path on another platform.
    assert.equal(
      morrowClientConfigPath({ client: "claude-desktop", scope: "user", platform: "darwin", homeDirectory: path.resolve("/tmp/morrow-home") }),
      path.join(path.resolve("/tmp/morrow-home"), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
  } finally {
    if (previousApplicationData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousApplicationData;
  }
});
