/**
 * Reads the configuration electron-builder is actually handed. Every case loads
 * installer/electron-builder.config.cjs against a real prepared payload on disk
 * and the release environment under test, so a widened packaged-file allowlist,
 * a flipped asar, a changed platform target, or a signing default that drifts
 * fails here instead of in a shipped build.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const installerRoot = path.resolve(__dirname, "..");
const configPath = require.resolve("../electron-builder.config.cjs");
const manifestPath = require.resolve("../package.json");

/** Everything the packaged application is allowed to contain besides the payload. */
const PACKAGED_FILES = [
  "main.cjs",
  "preload.cjs",
  "renderer/**/*",
  "shared/**/*",
  "assets/**/*",
  "package.json"
];

/** The NSIS answers a one-click, per-user Windows install depends on. */
const NSIS = {
  oneClick: true,
  perMachine: false,
  allowElevation: false,
  allowToChangeInstallationDirectory: false,
  packElevateHelper: false,
  createDesktopShortcut: true,
  createStartMenuShortcut: true,
  runAfterFinish: true
};

/**
 * The update feed the build metadata must name. installer/main.cjs holds the
 * same values in UPDATE_FEED and disables updates when the metadata it was
 * built with does not match them field for field.
 */
const UPDATE_FEED = {
  feedId: "morrow-github-stable",
  provider: "github",
  owner: "example-owner",
  repo: "morrow",
  channel: "latest"
};

/**
 * Distinct manifest bodies, so the two digests the build metadata carries are
 * different values and neither assertion passes on the other one's digest.
 */
const BRIDGE_RELEASE_MANIFEST = '{"schema":"morrow.bridge-release.v1"}\n';
const MCP_RUNTIME_MANIFEST = '{"schema":"morrow.mcp-runtime.v1"}\n';

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Writes a prepared payload holding the three manifests the config reads.
 * `bridgeRelease: null` leaves the Bridge manifest out, and `packageInput`
 * replaces the binding manifest, so the refusal cases get the payload they need.
 */
async function preparedPayload(t, { bridgeRelease = BRIDGE_RELEASE_MANIFEST, packageInput } = {}) {
  const payload = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-config-"));
  t.after(() => fs.rm(payload, { recursive: true, force: true }));
  const appDirectory = path.join(payload, "app");
  await fs.mkdir(path.join(appDirectory, "bridge-release"), { recursive: true });
  if (bridgeRelease !== null) {
    await fs.writeFile(path.join(appDirectory, "bridge-release", "manifest.json"), bridgeRelease, "utf8");
  }
  await fs.writeFile(path.join(appDirectory, "mcp-runtime-manifest.json"), MCP_RUNTIME_MANIFEST, "utf8");
  const binding = packageInput === undefined
    ? {
      schema: "morrow.desktop-package-input.v1",
      mcpRuntime: { path: "app/mcp-runtime-manifest.json", sha256: sha256(MCP_RUNTIME_MANIFEST) }
    }
    : packageInput;
  await fs.writeFile(path.join(appDirectory, "package-input-manifest.json"), `${JSON.stringify(binding)}\n`, "utf8");
  return {
    payload,
    bridgeReleaseSha256: bridgeRelease === null ? null : sha256(bridgeRelease),
    mcpRuntimeSha256: sha256(MCP_RUNTIME_MANIFEST)
  };
}

/**
 * Loads the config for one payload and one release environment. `version`
 * replaces the installer version the config validates, so the prerelease
 * refusal and the stable signed build are both read here whatever version the
 * checkout currently carries. Every change is undone before returning.
 */
function loadConfig({ payload, signedRelease = false, version = null }) {
  const previousPayload = process.env.MORROW_INSTALLER_PAYLOAD;
  const previousSigned = process.env.MORROW_SIGNED_RELEASE;
  const manifest = require(manifestPath);
  const manifestModule = require.cache[manifestPath];
  const previousManifest = manifestModule.exports;
  if (payload === null) delete process.env.MORROW_INSTALLER_PAYLOAD;
  else process.env.MORROW_INSTALLER_PAYLOAD = payload;
  if (signedRelease) process.env.MORROW_SIGNED_RELEASE = "1";
  else delete process.env.MORROW_SIGNED_RELEASE;
  if (version !== null) manifestModule.exports = { ...manifest, version };
  delete require.cache[configPath];
  try {
    return require(configPath);
  } finally {
    manifestModule.exports = previousManifest;
    delete require.cache[configPath];
    if (previousPayload === undefined) delete process.env.MORROW_INSTALLER_PAYLOAD;
    else process.env.MORROW_INSTALLER_PAYLOAD = previousPayload;
    if (previousSigned === undefined) delete process.env.MORROW_SIGNED_RELEASE;
    else process.env.MORROW_SIGNED_RELEASE = previousSigned;
  }
}

test("the packaged application is the installer source, sealed, with a fixed file allowlist", async (t) => {
  const { payload, bridgeReleaseSha256, mcpRuntimeSha256 } = await preparedPayload(t);
  const config = loadConfig({ payload });
  assert.equal(config.directories.app, installerRoot);
  assert.equal(config.directories.buildResources, "assets");
  assert.deepEqual(config.files, PACKAGED_FILES);
  assert.equal(config.asar, true);
  assert.deepEqual(config.extraResources, [{ from: payload, to: "MorrowPayload", filter: ["**/*"] }]);
  assert.equal(config.extraMetadata.morrow.bridgeRelease.manifestSha256, bridgeReleaseSha256);
  assert.equal(config.extraMetadata.morrow.mcpRuntime.manifestSha256, mcpRuntimeSha256);
});

test("the build is identified as Morrow and its artifacts name the version, platform and architecture", async (t) => {
  const { payload } = await preparedPayload(t);
  const config = loadConfig({ payload });
  const manifest = require(manifestPath);
  assert.equal(config.appId, "app.meetmorrow.installer");
  assert.equal(config.productName, "Morrow");
  assert.deepEqual(manifest.author, { name: "Braden Riggins" });
  assert.equal(config.copyright, "Copyright © 2026 Braden Riggins");
  assert.equal(config.artifactName, "Morrow-${version}-${os}-${arch}.${ext}");
});

test("the build targets exactly a macOS arm64 disk image and zip and a Windows x64 one-click installer", async (t) => {
  const { payload } = await preparedPayload(t);
  const config = loadConfig({ payload });
  assert.deepEqual(config.mac.target, [
    { target: "dmg", arch: ["arm64"] },
    { target: "zip", arch: ["arm64"] }
  ]);
  assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.deepEqual(config.nsis, NSIS);
});

test("an unsigned build does not code-sign and ships with updates turned off", async (t) => {
  const { payload } = await preparedPayload(t);
  const config = loadConfig({ payload });
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.mac.identity, null);
  assert.equal(config.extraMetadata.morrow.desktopUpdates.enabled, false);
});

test("a signed release of a stable version code-signs and turns updates on", async (t) => {
  const { payload } = await preparedPayload(t);
  const config = loadConfig({ payload, signedRelease: true, version: "1.0.0" });
  assert.equal(config.forceCodeSigning, true);
  assert.equal(Object.hasOwn(config.mac, "identity"), false);
  assert.equal(config.extraMetadata.morrow.desktopUpdates.enabled, true);
});

test("a signed release refuses a prerelease version", async (t) => {
  const { payload } = await preparedPayload(t);
  assert.throws(
    () => loadConfig({ payload, signedRelease: true, version: "1.0.0-rc.1" }),
    { message: "A signed Morrow release must use a stable SemVer version." }
  );
});

test("the build publishes to, and looks for updates on, the GitHub stable feed", async (t) => {
  const { payload } = await preparedPayload(t);
  const config = loadConfig({ payload });
  assert.deepEqual(config.publish, [{
    provider: "github",
    owner: "example-owner",
    repo: "morrow",
    channel: "latest",
    releaseType: "release"
  }]);
  const { enabled, ...feed } = config.extraMetadata.morrow.desktopUpdates;
  assert.equal(typeof enabled, "boolean");
  assert.deepEqual(feed, UPDATE_FEED);
});

test("a build without an absolute prepared payload is refused", async () => {
  assert.throws(
    () => loadConfig({ payload: null }),
    { message: "MORROW_INSTALLER_PAYLOAD must be an absolute path to the prepared Morrow payload." }
  );
  assert.throws(
    () => loadConfig({ payload: "relative/payload" }),
    { message: "MORROW_INSTALLER_PAYLOAD must be an absolute path to the prepared Morrow payload." }
  );
});

test("a payload without its Bridge release manifest is refused", async (t) => {
  const { payload } = await preparedPayload(t, { bridgeRelease: null });
  assert.throws(
    () => loadConfig({ payload }),
    { message: "Prepared Morrow payload is missing its Bridge release manifest." }
  );
});

test("a payload whose package input manifest does not bind the MCP runtime manifest is refused", async (t) => {
  const { payload } = await preparedPayload(t, {
    packageInput: {
      schema: "morrow.desktop-package-input.v1",
      mcpRuntime: { path: "app/mcp-runtime-manifest.json", sha256: sha256("a different manifest\n") }
    }
  });
  assert.throws(
    () => loadConfig({ payload }),
    { message: "Prepared Morrow payload MCP runtime manifest is not bound by its package input manifest." }
  );
});
