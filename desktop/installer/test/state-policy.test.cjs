const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  STATE_SCHEMA,
  STATE_VERSION,
  insideDirectory,
  inspectRecord,
  readPrivateRegularFile,
  retentionSnapshot,
  uninstallPolicy,
  uninstallStep
} = require("../shared/state-policy.cjs");

const at = (...parts) => path.resolve(path.sep, "morrow-fixture", ...parts);

const USER_DATA = at("UserData");
const HOME = at("Home");
const CREDENTIALS = path.join(HOME, ".morrow", "credentials", "blackboard");

function snapshot(overrides = {}) {
  return retentionSnapshot({
    platform: "darwin",
    userData: USER_DATA,
    state: path.join(USER_DATA, "State"),
    backups: path.join(USER_DATA, "State", "Backups"),
    bridge: path.join(USER_DATA, "Bridge"),
    materials: path.join(USER_DATA, "Materials"),
    blackboardCredentials: CREDENTIALS,
    blackboardConfiguration: path.join(HOME, ".morrow", "blackboard-learn.json"),
    assistantConfigurations: [{ title: "ChatGPT", path: path.join(HOME, ".codex", "config.toml") }],
    ...overrides
  });
}

function location(current, id) {
  const found = current.locations.filter((entry) => entry.id === id);
  assert.equal(found.length, 1, `one ${id} location`);
  return found[0];
}

test("only the current installer record schema can authorize state use", () => {
  assert.equal(inspectRecord(null).compatible, true);
  assert.equal(inspectRecord({ schema: STATE_SCHEMA, version: STATE_VERSION, configured: {} }).compatible, true);
  assert.deepEqual(inspectRecord({ schema: STATE_SCHEMA, version: STATE_VERSION + 1 }).reason, "migration_required");
  assert.deepEqual(inspectRecord({ schema: "unexpected", version: 1 }).reason, "migration_required");
});

test("installer records admit only exact assistant identities, canonical paths, and canonical digests", () => {
  const home = at("Home");
  const target = at("Home", ".codex", "config.toml");
  const bundleRoot = at("UserData", "State", "ClaudeDesktop", "install-1");
  const record = {
    schema: STATE_SCHEMA,
    version: STATE_VERSION,
    selectedAssistantId: "codex",
    materialsFolder: at("Materials"),
    configured: {
      codex: { target, sha256: "a".repeat(64) },
      "claude-desktop": {
        bundlePath: path.join(bundleRoot, "Morrow.mcpb"),
        installationId: "install-1",
        receiptPath: path.join(bundleRoot, "connection.json"),
      },
    },
  };
  assert.deepEqual(inspectRecord(record, { homeDirectory: home }), { compatible: true, record });

  const invalid = [
    { ...record, unknown: true },
    { ...record, selectedAssistantId: "other" },
    { ...record, materialsFolder: `${at("Materials")}${path.sep}..${path.sep}Other` },
    { ...record, configured: { other: { target, sha256: "a".repeat(64) } } },
    { ...record, configured: { codex: { target: "relative/config.toml", sha256: "a".repeat(64) } } },
    { ...record, configured: { codex: { target: at("Home", ".mcp.json"), sha256: "a".repeat(64) } } },
    { ...record, configured: { "claude-code": { target, sha256: "a".repeat(64) } } },
    { ...record, configured: { "gemini-cli": { target: at("Project", "settings.json"), sha256: "a".repeat(64) } } },
    { ...record, configured: { codex: { target, sha256: "A".repeat(64) } } },
    { ...record, configured: { codex: { target, sha256: "a".repeat(64), extra: true } } },
    { ...record, configured: { "claude-desktop": {
      bundlePath: path.join(bundleRoot, "Other.mcpb"), installationId: "install-1",
      receiptPath: path.join(bundleRoot, "connection.json"),
    } } },
    { ...record, configured: { "claude-desktop": {
      bundlePath: path.join(bundleRoot, "Morrow.mcpb"), installationId: "../other",
      receiptPath: path.join(bundleRoot, "connection.json"),
    } } },
  ];
  for (const value of invalid) assert.equal(inspectRecord(value, { homeDirectory: home }).reason, "record_invalid");
});

test("the private regular-file reader bounds bytes and rejects non-files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-state-policy-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "installer.json");
  await fs.writeFile(file, "private record", { mode: 0o600 });
  assert.equal((await readPrivateRegularFile(file, { maxBytes: 32, platform: process.platform })).toString(), "private record");
  await assert.rejects(() => readPrivateRegularFile(file, { maxBytes: 4, platform: process.platform }), /private_file_not_admitted/);
  await assert.rejects(() => readPrivateRegularFile(root, { maxBytes: 32, platform: process.platform }), /private_file_not_admitted/);
});

test("the private regular-file reader accepts ctime precision drift but still rejects mtime drift", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-state-policy-ctime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "installer.json");
  await fs.writeFile(file, "private record", { mode: 0o600 });
  const originalOpen = fs.open;
  const readWithDrift = async ({ ctimeMs = 0, mtimeMs = 0 }) => {
    let calls = 0;
    fs.open = async (...argumentsValue) => {
      const handle = await originalOpen(...argumentsValue);
      const originalStat = handle.stat.bind(handle);
      handle.stat = async (...statArguments) => {
        const info = await originalStat(...statArguments);
        calls += 1;
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
          ctimeMs: info.ctimeMs + ctimeMs * calls,
          mtimeMs: info.mtimeMs + mtimeMs * calls,
        });
      };
      return handle;
    };
    try {
      return await readPrivateRegularFile(file, { maxBytes: 32, platform: process.platform });
    } finally {
      fs.open = originalOpen;
    }
  };

  assert.equal((await readWithDrift({ ctimeMs: 0.5 })).toString(), "private record");
  await assert.rejects(() => readWithDrift({ mtimeMs: 0.5 }), /private_file_changed_during_/);
});

test("the private regular-file reader refuses links and nonprivate mode before reading", {
  skip: process.platform === "win32" ? "POSIX link and mode admission needs a POSIX host" : false,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-state-policy-private-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside.json");
  const link = path.join(root, "installer.json");
  await fs.writeFile(outside, "outside", { mode: 0o600 });
  await fs.symlink(outside, link);
  await assert.rejects(() => readPrivateRegularFile(link, { maxBytes: 32, platform: process.platform }), /private_file_not_admitted/);
  await fs.rm(link);
  await fs.writeFile(link, "shared", { mode: 0o644 });
  await assert.rejects(() => readPrivateRegularFile(link, { maxBytes: 32, platform: process.platform }), /private_file_not_admitted/);

  const privateRoot = path.join(root, "private");
  const linkedRoot = path.join(root, "linked");
  await fs.mkdir(privateRoot, { mode: 0o700 });
  await fs.writeFile(path.join(privateRoot, "installer.json"), "private", { mode: 0o600 });
  await fs.symlink(privateRoot, linkedRoot);
  await assert.rejects(
    () => readPrivateRegularFile(path.join(linkedRoot, "installer.json"), { maxBytes: 32, trustedRoot: linkedRoot }),
    /private_file_ancestor_not_admitted/,
  );
});

test("uninstall retains learning state, backups, and the Blackboard secret until a separate explicit removal", () => {
  const policy = uninstallPolicy();
  assert.equal(policy.appRemoval, "removes_application_only");
  assert.equal(policy.explicitRemovalRequired, true);
  assert.deepEqual(policy.retained, ["state", "materials", "assistant_configuration", "backups", "blackboard_credentials"]);
});

test("the retention snapshot names every place this installation keeps data, by its exact path", () => {
  const current = snapshot();
  assert.equal(current.schema, "morrow.installer-retention.v1");
  assert.equal(current.appRemoval, "removes_application_only");
  assert.equal(current.explicitRemovalRequired, true);
  assert.equal(current.uninstall, "move_to_trash");
  assert.equal(current.removal, null);
  assert.deepEqual(current.locations.map((entry) => entry.id), [
    "state", "backups", "bridge", "materials", "blackboard_credentials", "blackboard_configuration", "assistant_configuration"
  ]);
  assert.deepEqual(current.locations.map((entry) => entry.path), [
    path.join(USER_DATA, "State"),
    path.join(USER_DATA, "State", "Backups"),
    path.join(USER_DATA, "Bridge"),
    path.join(USER_DATA, "Materials"),
    CREDENTIALS,
    path.join(HOME, ".morrow", "blackboard-learn.json"),
    path.join(HOME, ".codex", "config.toml")
  ]);
  assert.equal(location(current, "assistant_configuration").label, "ChatGPT settings file");
  for (const entry of current.locations) assert.ok(entry.label.length > 0, `${entry.id} is named in plain language`);
});

test("only app-owned data is removable, and every other place carries its reason", () => {
  const current = snapshot();
  for (const id of ["state", "bridge", "materials", "blackboard_credentials"]) {
    assert.equal(location(current, id).removable, true, `${id} is inside the folders Morrow owns`);
    assert.equal(location(current, id).keptReason, null);
  }
  // Copies of a person's assistant settings stay, so a removal never takes away the way back.
  assert.equal(location(current, "backups").removable, false);
  assert.equal(location(current, "backups").keptReason, "assistant_backup");
  // The Blackboard route is app-owned even though it sits beside the secret
  // folder. It must be removed with the secret so no dangling pair remains.
  assert.equal(location(current, "blackboard_configuration").removable, true);
  assert.equal(location(current, "blackboard_configuration").keptReason, null);
  // An assistant's own configuration file is never removable here, even when a
  // person keeps that file inside Morrow's own folder.
  const inside = snapshot({ assistantConfigurations: [{ title: "ChatGPT", path: path.join(USER_DATA, "config.toml") }] });
  assert.equal(location(inside, "assistant_configuration").removable, false);
  assert.equal(location(inside, "assistant_configuration").keptReason, "assistant_configuration");
});

test("a materials folder a person chose outside Morrow's own folder is named but never removed", () => {
  const chosen = path.join(HOME, "Documents", "Fall biology");
  const current = snapshot({ materials: chosen });
  assert.equal(location(current, "materials").path, chosen);
  assert.equal(location(current, "materials").removable, false);
  assert.equal(location(current, "materials").keptReason, "outside_morrow_data");
});

test("the snapshot names the uninstall step of the computer it runs on and skips a place it has no path for", () => {
  assert.equal(uninstallStep("darwin"), "move_to_trash");
  assert.equal(uninstallStep("win32"), "windows_settings_apps");
  assert.equal(uninstallStep("linux"), "unknown");
  assert.equal(snapshot({ platform: "win32" }).uninstall, "windows_settings_apps");

  const partial = snapshot({ materials: null, assistantConfigurations: [], blackboardConfiguration: "relative/path" });
  assert.deepEqual(partial.locations.map((entry) => entry.id), ["state", "backups", "bridge", "blackboard_credentials"]);
});

test("the removal boundary accepts the folder itself and refuses a sibling that starts with its name", () => {
  assert.equal(insideDirectory(USER_DATA, USER_DATA), true);
  assert.equal(insideDirectory(USER_DATA, path.join(USER_DATA, "State", "Backups")), true);
  assert.equal(insideDirectory(USER_DATA, `${USER_DATA}-old`), false);
  assert.equal(insideDirectory(USER_DATA, path.join(USER_DATA, "..", "Home")), false);
  assert.equal(insideDirectory(USER_DATA, "Materials"), false);
  assert.equal(insideDirectory(null, USER_DATA), false);
});
