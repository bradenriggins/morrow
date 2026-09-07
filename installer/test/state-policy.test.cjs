const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  STATE_SCHEMA,
  STATE_VERSION,
  insideDirectory,
  inspectRecord,
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

test("only a place inside Morrow's own folders is removable, and every other one carries its reason", () => {
  const current = snapshot();
  for (const id of ["state", "backups", "bridge", "materials", "blackboard_credentials"]) {
    assert.equal(location(current, id).removable, true, `${id} is inside the folders Morrow owns`);
    assert.equal(location(current, id).keptReason, null);
  }
  // The Blackboard site file sits beside the credential folder, not inside it,
  // so the removal boundary leaves it alone.
  assert.equal(location(current, "blackboard_configuration").removable, false);
  assert.equal(location(current, "blackboard_configuration").keptReason, "outside_morrow_data");
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
