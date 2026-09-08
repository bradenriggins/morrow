const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { blackboardPaths, blackboardTenantIdFromBaseUrl, configureBlackboard, deriveBlackboardSourceBindingId, readBlackboardHealth, removeBlackboardTenant, selectBlackboardCourses } = require("../shared/blackboard.cjs");

const TENANT = "learn-example-edu";
// The binding packages/blackboard-learn-api/src/binding.ts derives for this
// site, account and course. The Blackboard source re-derives every stored
// binding when it loads and refuses one that does not match, so an installer
// that writes a different identity here connects nothing.
const DERIVED_BINDING = "blackboard:3e63872e397074e7b974d86023a5a94bf882090a5a61ace4275e31bdc6e81866";
const PACKAGE_BINDING = path.join(__dirname, "..", "..", "packages", "blackboard-learn-api", "dist", "binding.js");

function privateAccess(file, mode) {
  try {
    const parent = fsSync.lstatSync(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return false;
    return process.platform === "win32" || ((mode & 0o077) === 0 && (parent.mode & 0o022) === 0);
  } catch { return false; }
}

async function writeCredential({ directory, destination, credentialRevision, applicationSecret }) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(destination)}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify({ schema: "morrow.blackboard-learn.credential.v1", credentialRevision, applicationSecret })}\n`, { mode: 0o600, flag: "w" });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, destination);
  await fs.chmod(destination, 0o600);
}

function input(applicationSecret = "credential-for-example") {
  return { baseUrl: "https://learn.example.edu/", applicationKey: "application-key-for-example", applicationSecret };
}

function discovered(principalId = "_123_1", courses = [
  { courseId: "_45_1", title: "Biology" },
  { courseId: "_46_2", title: "Chemistry" },
]) {
  return async () => ({ principalId, courses });
}

async function setup(root, options = {}) {
  return configureBlackboard({
    home: root,
    input: { ...input(options.secret), ...options.input },
    discoverConnection: options.discoverConnection || discovered(),
    writeCredential: options.writeCredential || writeCredential,
    privateFileAccessAccepted: options.privateFileAccessAccepted || privateAccess,
    writeConfigFile: options.writeConfigFile
  });
}

async function selectCourses(root, courseBindings, options = {}) {
  return selectBlackboardCourses({ home: root, input: { tenantId: options.tenantId || TENANT, courseBindings }, privateFileAccessAccepted: options.privateFileAccessAccepted || privateAccess, writeConfigFile: options.writeConfigFile });
}

async function storedConfig(root) {
  return JSON.parse(await fs.readFile(blackboardPaths(root, TENANT).config, "utf8"));
}

// Setup saves one connection at a time. A second stored connection is written
// here directly, the way a configuration file that carries two of them holds
// them, so a removal is proved to take exactly one of them away.
async function addStoredTenant(root, { id, baseUrl, applicationSecret }) {
  const paths = blackboardPaths(root, id);
  const credentialRevision = crypto.randomUUID();
  await writeCredential({ directory: paths.credentialDirectory, destination: paths.credential, credentialRevision, applicationSecret });
  const config = JSON.parse(await fs.readFile(paths.config, "utf8"));
  config.tenants.push({ id, baseUrl, applicationKey: `application-key-for-${id}`, credentialRef: "file", credentialRevision, principalId: "_123_1", courseBindings: [] });
  await fs.writeFile(paths.config, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return paths;
}

function removeTenant(root, tenantId, options = {}) {
  return removeBlackboardTenant({ home: root, tenantId, privateFileAccessAccepted: options.privateFileAccessAccepted || privateAccess, writeConfigFile: options.writeConfigFile });
}

test("Blackboard setup seals the credential route and keeps it out of public state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    const health = await setup(root);
    const paths = blackboardPaths(root, TENANT);
    const config = JSON.parse(await fs.readFile(paths.config, "utf8"));
    const credential = JSON.parse(await fs.readFile(paths.credential, "utf8"));
    assert.equal(config.tenants[0].credentialRef, "file");
    assert.match(config.tenants[0].credentialRevision, /^[0-9a-f-]{36}$/);
    assert.equal(credential.credentialRevision, config.tenants[0].credentialRevision);
    assert.equal(credential.applicationSecret, "credential-for-example");
    assert.equal(JSON.stringify(config).includes("credential-for-example"), false);
    const serialized = JSON.stringify(health);
    for (const forbidden of ["application-key-for-example", "credential-for-example", "credentialRef", "credentialRevision", paths.credential]) assert.equal(serialized.includes(forbidden), false, `${forbidden} entered public state`);
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), health);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a config-write failure restores an exact prior credential pair and never publishes the new route", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    const before = await setup(root, { secret: "old-credential" });
    const paths = blackboardPaths(root, TENANT);
    const oldCredential = await fs.readFile(paths.credential, "utf8");
    await assert.rejects(() => setup(root, { secret: "new-credential", writeConfigFile: async () => { throw new Error("config disk failure"); } }), /config disk failure/);
    assert.equal(await fs.readFile(paths.credential, "utf8"), oldCredential);
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), before);
    assert.equal((await fs.readFile(paths.config, "utf8")).includes("new-credential"), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a credential-write failure leaves the existing configuration unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    const before = await setup(root, { secret: "old-credential" });
    const paths = blackboardPaths(root, TENANT);
    const oldConfig = await fs.readFile(paths.config, "utf8");
    await assert.rejects(() => setup(root, { writeCredential: async () => { throw new Error("credential disk failure"); } }), /credential disk failure/);
    assert.equal(await fs.readFile(paths.config, "utf8"), oldConfig);
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a failed Windows ACL confirmation leaves an old route and new credential unusable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root, { secret: "old-credential" });
    let accepted = 0;
    await assert.rejects(() => setup(root, {
      secret: "new-credential",
      privateFileAccessAccepted: () => ++accepted <= 2,
    }), /Blackboard credential access is not private/);
    assert.deepEqual(
      await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }),
      { schema: "morrow.blackboard.health.v1", status: "not_configured", tenants: [] },
    );
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a linked credentials ancestor or DACL preparation failure writes no credential", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    const morrow = path.join(root, ".morrow");
    const external = path.join(root, "external");
    await fs.mkdir(morrow, { mode: 0o700 });
    await fs.mkdir(external, { mode: 0o700 });
    await fs.symlink(external, path.join(morrow, "credentials"));
    let writerCalled = false;
    await assert.rejects(() => configureBlackboard({
      home: root,
      input: input(),
      discoverConnection: discovered(),
      privateFileAccessAccepted: privateAccess,
      prepareCredentialDirectory: async ({ directory }) => {
        if ((await fs.lstat(path.dirname(directory))).isSymbolicLink()) throw new Error("Windows directory DACL is not private");
      },
      writeCredential: async () => { writerCalled = true; },
    }), /DACL/);
    assert.equal(writerCalled, false);
    assert.equal(fsSync.existsSync(path.join(external, "blackboard", `${TENANT}.secret`)), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Blackboard health fails closed for insecure, linked, and Windows-refused routing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    const paths = blackboardPaths(root, TENANT);
    const absent = { schema: "morrow.blackboard.health.v1", status: "not_configured", tenants: [] };
    if (process.platform !== "win32") {
      await fs.chmod(paths.config, 0o644);
      assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), absent);
      await fs.chmod(paths.config, 0o600);
    }
    await fs.chmod(paths.credentialDirectory, 0o700);
    const linked = `${paths.credential}.linked`;
    await fs.rename(paths.credential, linked);
    await fs.symlink(linked, paths.credential);
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), absent);
    await fs.unlink(paths.credential); await fs.rename(linked, paths.credential);
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: () => false }), absent);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Blackboard health refuses oversized private routing files before parsing them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    const absent = { schema: "morrow.blackboard.health.v1", status: "not_configured", tenants: [] };
    await setup(root);
    const paths = blackboardPaths(root, TENANT);
    await fs.writeFile(paths.config, " ".repeat(1024 * 1024 + 1), { mode: 0o600 });
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), absent);
    await fs.rm(root, { recursive: true, force: true });
    const nextRoot = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
    try {
      await setup(nextRoot);
      const nextPaths = blackboardPaths(nextRoot, TENANT);
      await fs.writeFile(nextPaths.credential, " ".repeat(16 * 1024 + 1), { mode: 0o600 });
      assert.deepEqual(await readBlackboardHealth(nextRoot, { privateFileAccessAccepted: privateAccess }), absent);
    } finally { await fs.rm(nextRoot, { recursive: true, force: true }); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Blackboard setup rejects a non-origin URL before credential provisioning and clears the input secret", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  const candidate = input("credential-for-example");
  try {
    let called = false;
    candidate.baseUrl = "https://learn.example.edu/learn/api";
    await assert.rejects(() => configureBlackboard({ home: root, input: candidate, writeCredential: async () => { called = true; }, privateFileAccessAccepted: privateAccess }), /HTTPS base URL/);
    assert.equal(called, false); assert.equal(candidate.applicationSecret, "");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("the tenant name comes from the Blackboard web address, and a typed one is refused", async () => {
  assert.equal(blackboardTenantIdFromBaseUrl("https://learn.example.edu"), "learn-example-edu");
  assert.equal(blackboardTenantIdFromBaseUrl("https://LEARN.Example.edu/"), "learn-example-edu");
  assert.equal(blackboardTenantIdFromBaseUrl("https://2u.example.edu"), "bb-2u-example-edu");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    const health = await setup(root);
    assert.deepEqual(health.tenants.map((tenant) => tenant.id), [TENANT]);
    assert.equal((await storedConfig(root)).tenants[0].id, TENANT);
    await assert.rejects(() => setup(root, { input: { tenantId: "typed-name" } }), /Blackboard setup is invalid/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("setup records only the account and courses Blackboard discovery returns", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    const health = await setup(root, { discoverConnection: discovered("_777_1", [{ courseId: "_46_2", title: "Verified Chemistry" }]) });
    assert.deepEqual(health.tenants[0], {
      id: TENANT,
      baseUrl: "https://learn.example.edu",
      principalId: "_777_1",
      accountVerified: true,
      availableCourses: [{ courseId: "_46_2", title: "Verified Chemistry" }],
      courseBindings: []
    });
    await assert.rejects(() => selectCourses(root, [{ courseId: "_45_1" }]), /was not discovered/);
    await selectCourses(root, [{ courseId: "_46_2" }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("failed Blackboard discovery writes neither configuration nor credential", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await assert.rejects(() => setup(root, { discoverConnection: async () => { throw new Error("Blackboard account read failed"); } }), /account read failed/);
    const paths = blackboardPaths(root, TENANT);
    assert.equal(fsSync.existsSync(paths.config), false);
    assert.equal(fsSync.existsSync(paths.credential), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("course selection stores the binding the Blackboard source derives and shows it in public state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    assert.deepEqual((await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess })).tenants[0].courseBindings, []);
    const health = await selectCourses(root, [{ courseId: "_45_1" }]);
    assert.equal(deriveBlackboardSourceBindingId("https://learn.example.edu", "_123_1", "_45_1"), DERIVED_BINDING);
    assert.deepEqual(health.tenants[0].courseBindings, [{ sourceBindingId: DERIVED_BINDING, courseId: "_45_1" }]);
    assert.deepEqual((await storedConfig(root)).tenants[0].courseBindings, [{ courseId: "_45_1", sourceBindingId: DERIVED_BINDING }]);
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), health);

    const paths = blackboardPaths(root, TENANT);
    const serialized = JSON.stringify(health);
    for (const forbidden of ["application-key-for-example", "credential-for-example", "credentialRef", "credentialRevision", paths.credential]) assert.equal(serialized.includes(forbidden), false, `${forbidden} entered public state`);

    const replaced = await selectCourses(root, [{ courseId: "_45_1" }, { courseId: "_46_2" }]);
    assert.deepEqual(replaced.tenants[0].courseBindings.map((binding) => binding.courseId), ["_45_1", "_46_2"]);
    const cleared = await selectCourses(root, []);
    assert.deepEqual(cleared.tenants[0].courseBindings, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("the installer derives the same binding the Blackboard source package derives", async (t) => {
  if (!fsSync.existsSync(PACKAGE_BINDING)) t.skip("packages/blackboard-learn-api is not built; the pinned vector above still holds the contract");
  else {
    const { deriveBlackboardSourceBindingId: packaged } = await import(`file://${PACKAGE_BINDING}`);
    for (const [baseUrl, principalId, courseId] of [
      ["https://learn.example.edu", "_123_1", "_45_1"],
      ["https://learn.example.edu/", "_9_1", "_10_2"],
      ["https://bb.other.ac.uk", "_1_1", "_2_1"],
    ]) assert.equal(deriveBlackboardSourceBindingId(baseUrl, principalId, courseId), packaged(baseUrl, principalId, courseId));
  }
});

test("a course selection refuses a binding that does not derive from the stored account and web address", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    const stored = await fs.readFile(blackboardPaths(root, TENANT).config, "utf8");
    const otherOrigin = deriveBlackboardSourceBindingId("https://learn.other.edu", "_123_1", "_45_1");
    const otherAccount = deriveBlackboardSourceBindingId("https://learn.example.edu", "_777_1", "_45_1");
    for (const sourceBindingId of [otherOrigin, otherAccount, "blackboard:typed-by-hand"]) {
      await assert.rejects(() => selectCourses(root, [{ courseId: "_45_1", sourceBindingId }]), /does not match its tenant principal and course/);
    }
    await assert.rejects(() => selectCourses(root, [{ courseId: "_45_1" }], { tenantId: "another-site" }), /Blackboard tenant is not configured/);
    await assert.rejects(() => selectCourses(root, [{ courseId: "45" }]), /Blackboard course id is invalid/);
    await assert.rejects(() => selectCourses(root, [{ courseId: "_45_1" }, { courseId: "_45_1" }]), /duplicated/);
    assert.equal(await fs.readFile(blackboardPaths(root, TENANT).config, "utf8"), stored);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a course-selection write failure leaves the stored courses exactly as they were", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    const before = await selectCourses(root, [{ courseId: "_45_1" }]);
    const paths = blackboardPaths(root, TENANT);
    const stored = await fs.readFile(paths.config, "utf8");

    await assert.rejects(() => selectCourses(root, [{ courseId: "_46_2" }], { writeConfigFile: async () => { throw new Error("config disk failure"); } }), /config disk failure/);
    assert.equal(await fs.readFile(paths.config, "utf8"), stored);
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), before);

    // A different current digest belongs to another writer. The failed
    // transaction must leave those exact bytes alone rather than restore its
    // old selection over them.
    const external = stored.replace("application-key-for-example", "key-written-by-another-process");
    let writes = 0;
    await assert.rejects(() => selectCourses(root, [{ courseId: "_46_2" }], {
      writeConfigFile: async (file) => {
        writes += 1;
        await fs.writeFile(file, external, { mode: 0o600 });
      },
    }), /Blackboard course selection write is unconfirmed/);
    assert.equal(writes, 1);
    assert.equal(await fs.readFile(paths.config, "utf8"), external);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a saved course reports no connection when the secret its configuration names cannot be opened", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    // The secret this configuration names is gone, so nothing on this computer
    // can sign in to Blackboard. Writing the course list is still the right
    // thing to do, and the status a course selection answers with is the one
    // the app shows, not a connection inferred from that write.
    await fs.rm(blackboardPaths(root, TENANT).credential);
    const health = await selectCourses(root, [{ courseId: "_45_1" }]);
    assert.deepEqual(health, { schema: "morrow.blackboard.health.v1", status: "not_configured", tenants: [] });
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), health);
    assert.deepEqual((await storedConfig(root)).tenants[0].courseBindings, [{ courseId: "_45_1", sourceBindingId: DERIVED_BINDING }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("setup keeps one Blackboard connection, and a replaced site leaves no configuration or secret behind", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    await selectCourses(root, [{ courseId: "_45_1" }]);
    const first = blackboardPaths(root, TENANT);

    const health = await setup(root, { secret: "other-credential", input: { baseUrl: "https://learn.other.edu" } });
    const second = blackboardPaths(root, "learn-other-edu");
    assert.deepEqual(health.tenants.map((tenant) => tenant.baseUrl), ["https://learn.other.edu"]);
    assert.deepEqual(health.tenants[0].courseBindings, []);
    assert.deepEqual((await storedConfig(root)).tenants.map((tenant) => tenant.id), ["learn-other-edu"]);
    assert.equal(fsSync.existsSync(first.credential), false, "the replaced connection's secret stayed on this computer");
    assert.equal(JSON.parse(await fs.readFile(second.credential, "utf8")).applicationSecret, "other-credential");
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), health);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a failed replacement keeps the saved connection and writes no second secret", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    const before = await setup(root);
    await selectCourses(root, [{ courseId: "_45_1" }]);
    const saved = await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess });
    const first = blackboardPaths(root, TENANT);
    const storedCredential = await fs.readFile(first.credential, "utf8");
    const stored = await fs.readFile(first.config, "utf8");

    await assert.rejects(() => setup(root, {
      secret: "other-credential",
      input: { baseUrl: "https://learn.other.edu" },
      writeConfigFile: async () => { throw new Error("config disk failure"); },
    }), /config disk failure/);

    assert.equal(await fs.readFile(first.config, "utf8"), stored);
    assert.equal(await fs.readFile(first.credential, "utf8"), storedCredential);
    assert.equal(fsSync.existsSync(blackboardPaths(root, "learn-other-edu").credential), false);
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), saved);
    assert.deepEqual(saved.tenants[0].courseBindings, [{ sourceBindingId: DERIVED_BINDING, courseId: "_45_1" }]);
    assert.deepEqual(before.tenants.map((tenant) => tenant.id), [TENANT]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a setup rollback leaves a concurrent configuration unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    const first = blackboardPaths(root, TENANT);
    const storedCredential = await fs.readFile(first.credential, "utf8");
    const stored = await fs.readFile(first.config, "utf8");
    const external = stored.replace("application-key-for-example", "key-written-by-another-process");
    let writes = 0;
    await assert.rejects(() => setup(root, {
      secret: "other-credential",
      input: { baseUrl: "https://learn.other.edu" },
      writeConfigFile: async (file) => {
        writes += 1;
        await fs.writeFile(file, external, { mode: 0o600 });
      },
    }), /Blackboard configuration write is unconfirmed/);

    assert.equal(writes, 1);
    assert.equal(await fs.readFile(first.config, "utf8"), external);
    assert.equal(await fs.readFile(first.credential, "utf8"), storedCredential);
    assert.equal(fsSync.existsSync(blackboardPaths(root, "learn-other-edu").credential), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("saving a different account or web address releases the courses that proved the old one", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    await selectCourses(root, [{ courseId: "_45_1" }]);
    const resaved = await setup(root, { secret: "rotated-credential" });
    assert.deepEqual(resaved.tenants[0].courseBindings, [{ sourceBindingId: DERIVED_BINDING, courseId: "_45_1" }]);
    const repointed = await setup(root, { discoverConnection: discovered("_777_1") });
    assert.deepEqual(repointed.tenants[0].courseBindings, []);
    assert.deepEqual((await storedConfig(root)).tenants[0].courseBindings, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("removing a connection takes its entry and its secret away and leaves another connection as it was", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    await selectCourses(root, [{ courseId: "_45_1" }]);
    const other = await addStoredTenant(root, { id: "learn-other-edu", baseUrl: "https://learn.other.edu", applicationSecret: "other-credential" });
    const first = blackboardPaths(root, TENANT);
    const otherCredential = await fs.readFile(other.credential, "utf8");

    const result = await removeTenant(root, TENANT);

    assert.equal(result.schema, "morrow.blackboard.removal.v1");
    assert.equal(result.tenantId, TENANT);
    assert.equal(result.status, "removed");
    assert.equal(result.credential, "absent");
    assert.equal(fsSync.existsSync(first.credential), false, "the removed connection's secret stayed on this computer");
    assert.deepEqual((await storedConfig(root)).tenants.map((tenant) => tenant.id), ["learn-other-edu"]);
    assert.deepEqual(result.health.tenants.map((tenant) => tenant.id), ["learn-other-edu"]);
    assert.equal(result.health.status, "api_configured_live_untested");
    assert.equal(await fs.readFile(other.credential, "utf8"), otherCredential, "the connection that was kept lost its secret");
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), result.health);

    const serialized = JSON.stringify(result);
    for (const forbidden of ["credential-for-example", "other-credential", "application-key-for-example", "credentialRef", "credentialRevision", first.credential]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} entered the removal answer`);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("removing the last connection leaves no Blackboard connection and no secret behind", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    await selectCourses(root, [{ courseId: "_45_1" }]);
    const paths = blackboardPaths(root, TENANT);

    const result = await removeTenant(root, TENANT);

    assert.equal(result.status, "removed");
    assert.deepEqual(result.health, { schema: "morrow.blackboard.health.v1", status: "not_configured", tenants: [] });
    assert.deepEqual((await storedConfig(root)).tenants, []);
    assert.equal(fsSync.existsSync(paths.credential), false);
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), result.health);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("removing a name no configuration carries changes nothing and reports the state as it is", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    const empty = await removeTenant(root, "learn-example-edu");
    assert.equal(empty.status, "not_configured");
    assert.equal(empty.credential, "absent");
    assert.deepEqual(empty.health, { schema: "morrow.blackboard.health.v1", status: "not_configured", tenants: [] });
    assert.equal(fsSync.existsSync(blackboardPaths(root, TENANT).config), false, "a removal made a configuration file");

    const saved = await setup(root);
    await selectCourses(root, [{ courseId: "_45_1" }]);
    const paths = blackboardPaths(root, TENANT);
    const storedBytes = await fs.readFile(paths.config, "utf8");
    const storedCredential = await fs.readFile(paths.credential, "utf8");

    const result = await removeTenant(root, "learn-other-edu");

    assert.equal(result.status, "not_configured");
    assert.equal(result.tenantId, "learn-other-edu");
    assert.equal(result.credential, "absent");
    assert.deepEqual(result.health.tenants.map((tenant) => tenant.id), [TENANT]);
    assert.deepEqual(result.health.tenants[0].courseBindings, [{ sourceBindingId: DERIVED_BINDING, courseId: "_45_1" }]);
    assert.equal(await fs.readFile(paths.config, "utf8"), storedBytes);
    assert.equal(await fs.readFile(paths.credential, "utf8"), storedCredential);
    assert.deepEqual(saved.tenants.map((tenant) => tenant.id), [TENANT]);

    for (const name of ["../../elsewhere", "Learn-Example-Edu", "", "learn.example.edu"]) {
      await assert.rejects(() => removeTenant(root, name), /Blackboard tenant name is invalid/);
    }
    assert.equal(await fs.readFile(paths.config, "utf8"), storedBytes);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a secret Morrow could not remove is reported as still on this computer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    const paths = blackboardPaths(root, TENANT);
    // A path in the place of the secret file that one removal call cannot take
    // away. What the removal reports has to come from the file system.
    await fs.rm(paths.credential);
    await fs.mkdir(paths.credential, { mode: 0o700 });

    const result = await removeTenant(root, TENANT);

    assert.equal(result.status, "incomplete");
    assert.equal(result.credential, "present");
    assert.equal(fsSync.existsSync(paths.credential), true);
    assert.deepEqual(result.health, { schema: "morrow.blackboard.health.v1", status: "not_configured", tenants: [] });
    assert.deepEqual((await storedConfig(root)).tenants, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a removal whose write does not land keeps the connection and its secret", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-blackboard-"));
  try {
    await setup(root);
    await selectCourses(root, [{ courseId: "_45_1" }]);
    const saved = await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess });
    const paths = blackboardPaths(root, TENANT);
    const storedBytes = await fs.readFile(paths.config, "utf8");
    const storedCredential = await fs.readFile(paths.credential, "utf8");

    await assert.rejects(() => removeTenant(root, TENANT, { writeConfigFile: async () => { throw new Error("config disk failure"); } }), /config disk failure/);
    assert.equal(await fs.readFile(paths.config, "utf8"), storedBytes);
    assert.equal(await fs.readFile(paths.credential, "utf8"), storedCredential, "a refused removal took the secret away");
    assert.deepEqual(await readBlackboardHealth(root, { privateFileAccessAccepted: privateAccess }), saved);

    // A concurrent configuration change is never overwritten by a failed
    // removal, and the named credential stays present because removal did not land.
    const external = storedBytes.replace("application-key-for-example", "key-written-by-another-process");
    let writes = 0;
    await assert.rejects(() => removeTenant(root, TENANT, {
      writeConfigFile: async (file) => {
        writes += 1;
        await fs.writeFile(file, external, { mode: 0o600 });
      }
    }), /Blackboard removal write is unconfirmed/);
    assert.equal(writes, 1);
    assert.equal(await fs.readFile(paths.credential, "utf8"), storedCredential);
    assert.equal(await fs.readFile(paths.config, "utf8"), external);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
