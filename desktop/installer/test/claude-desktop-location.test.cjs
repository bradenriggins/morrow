"use strict";

/*
 * Ways Claude Desktop location answers can fail, written before the change:
 * - Morrow reports Claude Desktop installed on a computer that does not have it.
 * - A Claude.app that is not Anthropic's (another bundle id) counts as Claude Desktop.
 * - Claude Desktop installed outside /Applications (~/Applications, found by Spotlight) is missed.
 * - On Windows, the Store (MSIX) install is missed because it has no Program Files folder.
 * - On Windows, an MSIX install keeps Claude's files under
 *   %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude, so Morrow looks for the
 *   extension receipt at %APPDATA%\Claude and never finds it.
 * - A folder that only looks like the MSIX package (wrong shape) is accepted.
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  claudeDesktopLauncherLocations,
  detectClaudeDesktop,
  resolveClaudeDesktopLauncher,
} = require("../shared/claude-desktop.cjs");

const APPDATA = "C:\\Users\\Teacher\\AppData\\Roaming";
const LOCALAPPDATA = "C:\\Users\\Teacher\\AppData\\Local";
const SUFFIX = ["Claude Extensions", "local.mcpb.morrow.morrow", "server", "launch.cjs"];

function existing(paths) {
  const set = new Set(paths.map((entry) => entry.toLowerCase()));
  return async (candidate) => set.has(String(candidate).toLowerCase());
}

test("Windows lists the documented and the MSIX-virtualized launcher, both declared at %APPDATA%", () => {
  const locations = claudeDesktopLauncherLocations({
    platform: "win32",
    appDataDirectory: APPDATA,
    localAppDataDirectory: LOCALAPPDATA,
    packageFolders: ["Claude_pzs8sxrjxfjjc", "Claude_not-a-package", "SomethingElse_abc"],
  });
  const declared = path.win32.join(APPDATA, "Claude", ...SUFFIX);
  assert.deepEqual(locations, [
    { declared, physical: declared },
    { declared, physical: path.win32.join(LOCALAPPDATA, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", ...SUFFIX) },
  ]);
});

test("the launcher Morrow checks is whichever of those exists", async () => {
  const msix = path.win32.join(LOCALAPPDATA, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", ...SUFFIX);
  const declared = path.win32.join(APPDATA, "Claude", ...SUFFIX);
  const options = { platform: "win32", appDataDirectory: APPDATA, localAppDataDirectory: LOCALAPPDATA };
  const readdir = async () => ["Claude_pzs8sxrjxfjjc"];
  assert.deepEqual(await resolveClaudeDesktopLauncher({ ...options, readdir, exists: existing([msix]) }), { declared, physical: msix });
  assert.deepEqual(await resolveClaudeDesktopLauncher({ ...options, readdir, exists: existing([declared, msix]) }), { declared, physical: declared });
  assert.equal(await resolveClaudeDesktopLauncher({ ...options, readdir, exists: existing([]) }), null);
  const mac = await resolveClaudeDesktopLauncher({ platform: "darwin", homeDirectory: "/Users/Teacher", exists: existing([]) });
  assert.equal(mac, null);
});

test("macOS finds Anthropic's Claude.app in Applications, in the home Applications folder, or by Spotlight", async () => {
  const bundles = new Map([
    ["/Applications/Claude.app", "com.anthropic.claudefordesktop"],
    ["/Users/Teacher/Applications/Claude.app", "com.anthropic.claudefordesktop"],
    ["/Volumes/Work/Claude.app", "com.anthropic.claudefordesktop"],
    ["/Applications/Claude.app-lookalike", "com.example.claude"],
  ]);
  const readBundleIdentifier = async (candidate) => bundles.get(candidate) || null;
  const base = { platform: "darwin", homeDirectory: "/Users/Teacher", readBundleIdentifier, findByBundleIdentifier: async () => [] };
  assert.equal(await detectClaudeDesktop({ ...base, exists: existing(["/Applications/Claude.app"]) }), true);
  assert.equal(await detectClaudeDesktop({ ...base, exists: existing(["/Users/Teacher/Applications/Claude.app"]) }), true);
  assert.equal(await detectClaudeDesktop({ ...base, exists: existing([]) }), false);
  assert.equal(await detectClaudeDesktop({
    ...base,
    exists: existing(["/Applications/Claude.app"]),
    readBundleIdentifier: async () => "com.example.claude",
  }), false, "a Claude.app that is not Anthropic's does not count");
  assert.equal(await detectClaudeDesktop({
    ...base,
    exists: existing([]),
    findByBundleIdentifier: async (identifier) => identifier === "com.anthropic.claudefordesktop" ? ["/Volumes/Work/Claude.app"] : [],
  }), true, "Spotlight finds it elsewhere");
});

test("Windows finds the installer copy or the Store (MSIX) package, and nothing else", async () => {
  const base = { platform: "win32", localAppDataDirectory: LOCALAPPDATA, programFilesDirectory: "C:\\Program Files", readdir: async () => [] };
  assert.equal(await detectClaudeDesktop({ ...base, exists: existing([path.win32.join(LOCALAPPDATA, "AnthropicClaude", "claude.exe")]) }), true);
  assert.equal(await detectClaudeDesktop({ ...base, exists: existing([]), readdir: async () => ["Claude_pzs8sxrjxfjjc"] }), true);
  assert.equal(await detectClaudeDesktop({ ...base, exists: existing([]), readdir: async () => ["Claude_x", "OpenAI.Codex_2p2nqsd0c76g0"] }), false);
  assert.equal(await detectClaudeDesktop({ ...base, exists: existing([]) }), false);
  assert.equal(await detectClaudeDesktop({ platform: "linux", exists: existing([]) }), false);
});
