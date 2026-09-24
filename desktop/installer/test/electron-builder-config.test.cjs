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
const { PACKAGED_BRIDGE_DELIVERY } = require("../shared/bridge-delivery.cjs");
const {
  PACKAGER_ADMISSION_ENV,
  REVIEWED_GRAPH_SHA256_ENV,
  createPackagerAdmission,
  writePackagerAdmission,
} = require("../shared/packager-admission.cjs");
const { UPDATE_FEED: CANONICAL_UPDATE_FEED } = require("../shared/update-feed.cjs");

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
  feedId: CANONICAL_UPDATE_FEED.id,
  provider: CANONICAL_UPDATE_FEED.provider,
  owner: CANONICAL_UPDATE_FEED.owner,
  repo: CANONICAL_UPDATE_FEED.repo,
  channel: CANONICAL_UPDATE_FEED.channel
};

/**
 * Distinct manifest bodies, so the two digests the build metadata carries are
 * different values and neither assertion passes on the other one's digest.
 */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writePayloadFile(payload, relative, content) {
  const target = path.join(payload, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return { path: relative, bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

// The payload every case prepares targets the desktop the config packages for:
// Windows on a Windows host, otherwise macOS. A host the config cannot package
// on (Linux CI) loads it as a cross-build for that same target.
const PAYLOAD_TARGET = process.platform === "win32" ? "win32-x64" : "darwin-arm64";
const TARGET_PLATFORM = PAYLOAD_TARGET === "win32-x64" ? "win32" : "darwin";

/**
 * Writes a complete, small payload graph. Invalid-manifest options and a custom
 * package input let refusal cases change only the contract under test.
 */
async function preparedPayload(t, { invalidBridge = false, invalidMcp = false, invalidDependency = false, packageInput } = {}) {
  const payload = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-config-"));
  t.after(() => fs.rm(payload, { recursive: true, force: true }));
  const target = PAYLOAD_TARGET;
  const nodePath = target === "win32-x64" ? "runtime/node/node.exe" : "runtime/node/bin/node";
  const node = await writePayloadFile(payload, nodePath, "morrow-node-runtime-fixture");
  const definitions = [
    ["connector/extension/manifest.json", ["app/connector/extension/manifest.json"], '{"name":"Morrow Bridge"}\n'],
    ["installer/runtime-monitor.mjs", ["app/installer/runtime-monitor.mjs"], "export const monitor = true;\n"],
    ["installer/process-lifetime.cjs", ["app/installer/process-lifetime.cjs"], "module.exports = {};\n"],
    ["packages/canvas-connector-mcp/dist/index.js", ["app/packages/canvas-connector-mcp/dist/index.js"], "export const connector = true;\n"],
    ["packages/client-config/dist/cli.js", ["app/packages/client-config/dist/cli.js"], "export const cli = true;\n"],
    ["packages/mcp-server/dist/index.js", ["app/node_modules/@morrow-lms/gateway/dist/index.js", "app/packages/mcp-server/dist/index.js"], "export const gateway = true;\n"],
    ["packages/mcp-server/package.json", ["app/node_modules/@morrow-lms/gateway/package.json", "app/packages/mcp-server/package.json"], '{"name":"@morrow-lms/gateway","version":"1.0.0"}\n'],
  ];
  const files = [];
  for (const [sourcePath, destinations, content] of definitions) {
    for (const destination of destinations) await writePayloadFile(payload, destination, content);
    files.push({ path: sourcePath, bytes: Buffer.byteLength(content), sha256: sha256(content), destinations: [...destinations].sort() });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const appRecord = async (relative) => {
    const content = await fs.readFile(path.join(payload, "app", ...relative.split("/")));
    return { path: relative, bytes: content.byteLength, sha256: sha256(content) };
  };
  const entrypoint = await appRecord("packages/mcp-server/dist/index.js");
  const packageJson = await appRecord("node_modules/@morrow-lms/gateway/package.json");
  const gatewayEntry = await appRecord("node_modules/@morrow-lms/gateway/dist/index.js");
  const directFiles = await Promise.all([
    "installer/runtime-monitor.mjs",
    "installer/process-lifetime.cjs",
    "packages/canvas-connector-mcp/dist/index.js",
    "packages/client-config/dist/cli.js",
    "packages/mcp-server/dist/index.js",
  ].map(appRecord));
  const mcpRuntime = invalidMcp
    ? { schema: "morrow.mcp-runtime-manifest.v1" }
    : {
      schema: "morrow.mcp-runtime-manifest.v2",
      package: { name: "@morrow-lms/gateway", version: "1.0.0" },
      entrypoint,
      dependencies: [{
        name: "@morrow-lms/gateway",
        version: "1.0.0",
        packageJson,
        files: [gatewayEntry, packageJson].sort((left, right) => left.path.localeCompare(right.path)),
      }],
      directFiles: directFiles.sort((left, right) => left.path.localeCompare(right.path)),
    };
  const mcpBytes = `${JSON.stringify(mcpRuntime)}\n`;
  const mcp = await writePayloadFile(payload, "app/mcp-runtime-manifest.json", mcpBytes);
  const bridgeFile = files.find((record) => record.path === "connector/extension/manifest.json");
  const bridgeRelease = invalidBridge
    ? { schema: "morrow.bridge-release.invalid" }
    : {
      schema: "morrow.bridge-release.v1",
      version: "1.0.0",
      extensionId: "abeloclekioohahgedmjcdbpllfjfhko",
      manifestSha256: bridgeFile.sha256,
      permissions: [],
      hostPermissions: [],
      optionalHostPermissions: [],
      files: [{ path: "manifest.json", bytes: bridgeFile.bytes, sha256: bridgeFile.sha256 }],
    };
  await writePayloadFile(payload, "app/bridge-release/extension/manifest.json", '{"name":"Morrow Bridge"}\n');
  const bridge = await writePayloadFile(payload, "app/bridge-release/manifest.json", `${JSON.stringify(bridgeRelease)}\n`);
  const source = { head: "a".repeat(40), dirty: false, statusSha256: "b".repeat(64) };
  const binding = packageInput === undefined
    ? {
      schema: "morrow.desktop-package-input.v2",
      source,
      dependencyMaterialization: {
        schema: "morrow.runtime-dependency-materialization.v1",
        packageManager: { declared: "pnpm@10.6.1", observed: "10.6.1" },
        lockfile: { path: "pnpm-lock.yaml", sha256: "c".repeat(64), integritySource: "pnpm-lock.yaml packages resolution.integrity" },
        install: { mode: "isolated_frozen_install", network: "offline", scripts: "disabled", flags: ["--prod", "--frozen-lockfile", "--offline", "--ignore-scripts", "--verify-store-integrity"] },
        dependencies: [{ name: "fixture", version: "1.0.0", integrity: "sha512-AAAA" }],
      },
      files,
      mcpRuntime: { path: "app/mcp-runtime-manifest.json", sha256: mcp.sha256 },
    }
    : packageInput;
  if (invalidDependency) binding.dependencyMaterialization.install.network = "online";
  const input = await writePayloadFile(payload, "app/package-input-manifest.json", `${JSON.stringify(binding)}\n`);
  let admission = null;
  let admissionPath = null;
  if (!invalidBridge && !invalidMcp && !invalidDependency && packageInput === undefined) {
    admission = createPackagerAdmission({ payload, target });
    admissionPath = path.join(path.dirname(payload), `${path.basename(payload)}-admission.json`);
    writePackagerAdmission(admissionPath, admission);
    t.after(() => fs.rm(admissionPath, { force: true }));
  }
  return {
    payload,
    target,
    admission,
    admissionPath,
    bridgeReleaseSha256: bridge.sha256,
    mcpRuntimeSha256: mcp.sha256,
    packageInputSha256: input.sha256,
    nodeSha256: node.sha256,
  };
}

/**
 * Loads the config for one payload and one release environment. `version`
 * replaces the installer version the config validates, so the prerelease
 * refusal and the stable signed build are both read here whatever version the
 * checkout currently carries. Every change is undone before returning.
 */
function loadConfig({ payload, signedRelease = false, version = null, chromeStoreLive = null, admissionPath, reviewedGraphSha256 }) {
  const previousPayload = process.env.MORROW_INSTALLER_PAYLOAD;
  const previousSigned = process.env.MORROW_SIGNED_RELEASE;
  const previousStore = process.env.MORROW_CHROME_STORE_LIVE;
  const previousAdmission = process.env[PACKAGER_ADMISSION_ENV];
  const previousReviewedGraph = process.env[REVIEWED_GRAPH_SHA256_ENV];
  const previousTargetPlatform = process.env.MORROW_TARGET_PLATFORM;
  process.env.MORROW_TARGET_PLATFORM = TARGET_PLATFORM;
  const manifest = require(manifestPath);
  const manifestModule = require.cache[manifestPath];
  const previousManifest = manifestModule.exports;
  if (payload === null) delete process.env.MORROW_INSTALLER_PAYLOAD;
  else process.env.MORROW_INSTALLER_PAYLOAD = payload;
  if (signedRelease) process.env.MORROW_SIGNED_RELEASE = "1";
  else delete process.env.MORROW_SIGNED_RELEASE;
  if (chromeStoreLive === null) delete process.env.MORROW_CHROME_STORE_LIVE;
  else process.env.MORROW_CHROME_STORE_LIVE = chromeStoreLive;
  if (admissionPath === undefined) delete process.env[PACKAGER_ADMISSION_ENV];
  else process.env[PACKAGER_ADMISSION_ENV] = admissionPath;
  if (reviewedGraphSha256 === undefined) delete process.env[REVIEWED_GRAPH_SHA256_ENV];
  else process.env[REVIEWED_GRAPH_SHA256_ENV] = reviewedGraphSha256;
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
    if (previousStore === undefined) delete process.env.MORROW_CHROME_STORE_LIVE;
    else process.env.MORROW_CHROME_STORE_LIVE = previousStore;
    if (previousAdmission === undefined) delete process.env[PACKAGER_ADMISSION_ENV];
    else process.env[PACKAGER_ADMISSION_ENV] = previousAdmission;
    if (previousReviewedGraph === undefined) delete process.env[REVIEWED_GRAPH_SHA256_ENV];
    else process.env[REVIEWED_GRAPH_SHA256_ENV] = previousReviewedGraph;
    if (previousTargetPlatform === undefined) delete process.env.MORROW_TARGET_PLATFORM;
    else process.env.MORROW_TARGET_PLATFORM = previousTargetPlatform;
  }
}

test("the packaged application is the installer source, sealed, with a fixed file allowlist", async (t) => {
  const { payload, admission, bridgeReleaseSha256, mcpRuntimeSha256, packageInputSha256, nodeSha256 } = await preparedPayload(t);
  const config = loadConfig({ payload });
  assert.equal(config.directories.app, installerRoot);
  assert.equal(config.directories.buildResources, "assets");
  assert.deepEqual(config.files, PACKAGED_FILES);
  assert.equal(config.asar, true);
  assert.deepEqual(config.extraResources, [{ from: payload, to: "MorrowPayload", filter: ["**/*"] }]);
  assert.equal(config.extraMetadata.morrow.bridgeRelease.manifestSha256, bridgeReleaseSha256);
  assert.equal(config.extraMetadata.morrow.mcpRuntime.manifestSha256, mcpRuntimeSha256);
  assert.equal(config.extraMetadata.morrow.mcpRuntime.nodeSha256, nodeSha256);
  assert.equal(config.extraMetadata.morrow.packageInput.manifestSha256, packageInputSha256);
  assert.deepEqual(config.extraMetadata.morrow.releaseGraph, {
    schema: admission.schema,
    sha256: admission.graphSha256,
    sourceHead: admission.source.head,
  });
});

test("the build identifies as Morrow Desktop while keeping its internal executable and artifact names stable", async (t) => {
  const { payload } = await preparedPayload(t);
  const config = loadConfig({ payload });
  const manifest = require(manifestPath);
  assert.equal(config.appId, "app.meetmorrow.installer");
  assert.equal(config.productName, "Morrow Desktop");
  assert.equal(config.executableName, "Morrow");
  assert.equal(config.dmg.title, "Morrow Desktop");
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
  assert.equal(config.win.signExecutable, false);
  assert.equal(Object.hasOwn(config.win, "sign"), false);
  // The unsigned bundle still gets an ad-hoc seal after packing, or Gatekeeper
  // reports a quarantined download as damaged instead of offering Open Anyway.
  assert.equal(typeof config.afterPack, "function");
  assert.equal(config.extraMetadata.morrow.desktopUpdates.enabled, false);
  assert.deepEqual(config.publish, [], "an unsigned build must not emit metadata for the production update feed");
});

test("a signed release of a stable version code-signs and turns updates on", async (t) => {
  const { payload, admission, admissionPath } = await preparedPayload(t);
  const config = loadConfig({ payload, signedRelease: true, version: "1.0.0", admissionPath, reviewedGraphSha256: admission.graphSha256 });
  assert.equal(config.forceCodeSigning, true);
  assert.equal(Object.hasOwn(config.mac, "identity"), false);
  assert.equal(Object.hasOwn(config.win, "sign"), false);
  assert.equal(Object.hasOwn(config.win, "signExecutable"), false);
  assert.equal(config.extraMetadata.morrow.desktopUpdates.enabled, true);
  assert.deepEqual(config.publish, [{
    provider: "github",
    owner: "bradenriggins",
    repo: "morrow-downloads",
    channel: "latest",
    releaseType: "release"
  }]);
});

test("a signed release refuses a prerelease version", async (t) => {
  const { payload, admission, admissionPath } = await preparedPayload(t);
  assert.throws(
    () => loadConfig({ payload, signedRelease: true, version: "1.0.0-rc.1", admissionPath, reviewedGraphSha256: admission.graphSha256 }),
    { message: "A signed Morrow release must use a stable SemVer version." }
  );
});

/**
 * The Chrome route the packaged app will show. A Store route needs a separate
 * publication proof and packaged receipt contract, so no environment value
 * may change the current temporary route.
 */
test("ambient state cannot select a Chrome Web Store route", async (t) => {
  const { payload, admission, admissionPath } = await preparedPayload(t);
  assert.equal(loadConfig({ payload }).extraMetadata.morrow.bridgeDelivery, PACKAGED_BRIDGE_DELIVERY);
  for (const value of ["0", "", "1", "true", "yes", "available"]) {
    assert.equal(
      loadConfig({ payload, chromeStoreLive: value }).extraMetadata.morrow.bridgeDelivery,
      PACKAGED_BRIDGE_DELIVERY,
      `ambient MORROW_CHROME_STORE_LIVE=${JSON.stringify(value)} cannot select a delivery route`,
    );
  }
  assert.equal(loadConfig({ payload, signedRelease: true, version: "1.0.0", admissionPath, reviewedGraphSha256: admission.graphSha256 }).extraMetadata.morrow.bridgeDelivery, PACKAGED_BRIDGE_DELIVERY);
});

test("a signed release requires the external reviewed release graph and its independent digest", async (t) => {
  const { payload, admission, admissionPath } = await preparedPayload(t);
  assert.throws(
    () => loadConfig({ payload, signedRelease: true, version: "1.0.0" }),
    new RegExp(`Signed Morrow packaging requires ${PACKAGER_ADMISSION_ENV} and ${REVIEWED_GRAPH_SHA256_ENV}`),
  );
  assert.throws(
    () => loadConfig({ payload, signedRelease: true, version: "1.0.0", admissionPath }),
    new RegExp(`requires both ${PACKAGER_ADMISSION_ENV} and ${REVIEWED_GRAPH_SHA256_ENV}`),
  );
  assert.throws(
    () => loadConfig({ payload, signedRelease: true, version: "1.0.0", admissionPath, reviewedGraphSha256: "f".repeat(64) }),
    /does not match the reviewed release graph digest/,
  );
  assert.doesNotThrow(
    () => loadConfig({ payload, signedRelease: true, version: "1.0.0", admissionPath, reviewedGraphSha256: admission.graphSha256 }),
  );
});

test("a signed release refuses changed payload bytes after the release graph was reviewed", async (t) => {
  const { payload, target, admission, admissionPath } = await preparedPayload(t);
  const nodePath = target === "win32-x64" ? "runtime/node/node.exe" : "runtime/node/bin/node";
  await fs.appendFile(path.join(payload, ...nodePath.split("/")), "\nsubstituted after review\n");
  assert.throws(
    () => loadConfig({ payload, signedRelease: true, version: "1.0.0", admissionPath, reviewedGraphSha256: admission.graphSha256 }),
    /does not match the reviewed release graph/,
  );
});

test("afterPack verifies the copied resources against the same reviewed release graph", async (t) => {
  const { payload, target, admission, admissionPath } = await preparedPayload(t);
  const config = loadConfig({ payload, signedRelease: true, version: "1.0.0", admissionPath, reviewedGraphSha256: admission.graphSha256 });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-output-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const resources = path.join(output, "resources");
  const packaged = path.join(resources, "MorrowPayload");
  await fs.mkdir(resources, { recursive: true });
  await fs.cp(payload, packaged, { recursive: true });
  const context = {
    appOutDir: output,
    electronPlatformName: target === "win32-x64" ? "win32" : "darwin",
    packager: { getResourcesDir: () => resources, appInfo: { productFilename: "Morrow" } },
  };
  await assert.doesNotReject(config.afterPack(context));
  await assert.rejects(
    config.afterPack({ ...context, electronPlatformName: target === "win32-x64" ? "darwin" : "win32" }),
    /target does not match the reviewed desktop release graph/,
  );
  const nodePath = target === "win32-x64" ? "runtime/node/node.exe" : "runtime/node/bin/node";
  await fs.appendFile(path.join(packaged, ...nodePath.split("/")), "\nchanged in packaged resources\n");
  await assert.rejects(config.afterPack(context), /does not match the reviewed release graph/);
});

test("the signed build publishes to, and looks for updates on, the GitHub stable feed", async (t) => {
  const { payload, admission, admissionPath } = await preparedPayload(t);
  const config = loadConfig({ payload, signedRelease: true, version: "1.0.0", admissionPath, reviewedGraphSha256: admission.graphSha256 });
  const { enabled, ...feed } = config.extraMetadata.morrow.desktopUpdates;
  assert.equal(typeof enabled, "boolean");
  assert.deepEqual(feed, UPDATE_FEED);
  const guide = await fs.readFile(path.join(installerRoot, "UPDATES.md"), "utf8");
  assert.match(guide, new RegExp("`" + CANONICAL_UPDATE_FEED.owner + "/" + CANONICAL_UPDATE_FEED.repo + "`"));
  assert.doesNotMatch(guide, /`bradenriggins\/morrow`/);
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
  const { payload } = await preparedPayload(t, { invalidBridge: true });
  assert.throws(
    () => loadConfig({ payload }),
    /Prepared Morrow payload Bridge release manifest is invalid/
  );
});

test("a payload with an invalid MCP runtime manifest is refused", async (t) => {
  const { payload } = await preparedPayload(t, { invalidMcp: true });
  assert.throws(
    () => loadConfig({ payload }),
    /Prepared Morrow payload MCP runtime manifest is invalid/,
  );
});

test("a payload whose package input manifest does not bind the MCP runtime manifest is refused", async (t) => {
  const { payload } = await preparedPayload(t, {
    packageInput: {
      schema: "morrow.desktop-package-input.v2",
      mcpRuntime: { path: "app/mcp-runtime-manifest.json", sha256: sha256("a different manifest\n") }
    }
  });
  assert.throws(
    () => loadConfig({ payload }),
    /Prepared Morrow payload package input graph is invalid/
  );
});

test("a payload without frozen offline dependency materialization is refused", async (t) => {
  const { payload } = await preparedPayload(t, { invalidDependency: true });
  assert.throws(
    () => loadConfig({ payload }),
    /Prepared Morrow payload package input graph is invalid/,
  );
});

test("a build refuses the legacy package input schema that could select mutable dependencies", async (t) => {
  const { payload } = await preparedPayload(t, {
    packageInput: {
      schema: "morrow.desktop-package-input.v1",
      mcpRuntime: { path: "app/mcp-runtime-manifest.json", sha256: "f".repeat(64) }
    }
  });
  assert.throws(
    () => loadConfig({ payload }),
    /Prepared Morrow payload package input graph is invalid/
  );
});
