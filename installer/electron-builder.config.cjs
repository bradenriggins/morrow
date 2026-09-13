const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { PACKAGED_BRIDGE_DELIVERY } = require("./shared/bridge-delivery.cjs");
const {
  PACKAGER_ADMISSION_ENV,
  REVIEWED_GRAPH_SHA256_ENV,
  admitPackagerPayload,
  verifyPackagerAdmission,
} = require("./shared/packager-admission.cjs");
const { desktopUpdateMetadata, electronBuilderPublish } = require("./shared/update-feed.cjs");

const seed = process.env.MORROW_INSTALLER_PAYLOAD;
if (!seed || !path.isAbsolute(seed)) {
  throw new Error("MORROW_INSTALLER_PAYLOAD must be an absolute path to the prepared Morrow payload.");
}

const manifest = require("./package.json");
const signedRelease = process.env.MORROW_SIGNED_RELEASE === "1";
if (signedRelease && !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(manifest.version)) {
  throw new Error("A signed Morrow release must use a stable SemVer version.");
}
// Cross-building from another host sets MORROW_TARGET_PLATFORM, because the
// payload carries the target's runtime layout while this process may not run
// on the target.
const targetPlatform = process.env.MORROW_TARGET_PLATFORM || process.platform;
if (!["darwin", "win32"].includes(targetPlatform)) throw new Error(`Morrow desktop packaging does not support ${targetPlatform}.`);
const desktopTarget = targetPlatform === "win32" ? "win32-x64" : "darwin-arm64";
const packagerAdmission = admitPackagerPayload({
  payload: seed,
  target: desktopTarget,
  signedRelease,
  admissionPath: process.env[PACKAGER_ADMISSION_ENV],
  reviewedGraphSha256: process.env[REVIEWED_GRAPH_SHA256_ENV],
});
const releaseGraph = packagerAdmission.binding;
const desktopUpdates = desktopUpdateMetadata(signedRelease);
const mac = {
  category: "public.app-category.education",
  icon: "assets/morrow.icns",
  target: [
    { target: "dmg", arch: ["arm64"] },
    { target: "zip", arch: ["arm64"] }
  ]
};
if (!signedRelease) mac.identity = null;
const win = {
  icon: "assets/morrow.ico",
  target: [{ target: "nsis", arch: ["x64"] }]
};
if (!signedRelease) win.sign = false;

// With identity null, electron-builder skips signing and the bundle keeps only
// Electron's linker-signed binary with no sealed resources. Gatekeeper reads a
// quarantined download in that state as damaged and never offers Open Anyway.
// An ad-hoc signature carries no Apple identity, so the release stays unsigned,
// but it seals the bundle so macOS shows the documented Open Anyway route. It
// signs nested code only; the payload under Resources is sealed by hash, not
// changed. The verification below checks its bytes immediately before sealing.
function packagedPayload(context) {
  const resources = typeof context.packager?.getResourcesDir === "function"
    ? context.packager.getResourcesDir(context.appOutDir)
    : context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  return path.join(resources, "MorrowPayload");
}

async function verifyPayloadAndAdHocSign(context) {
  const builtTarget = context.electronPlatformName === "win32" ? "win32-x64"
    : context.electronPlatformName === "darwin" ? "darwin-arm64" : null;
  if (builtTarget !== desktopTarget) throw new Error("Electron builder target does not match the reviewed desktop release graph.");
  verifyPackagerAdmission({ payload: packagedPayload(context), target: desktopTarget, admission: packagerAdmission.admission });
  if (signedRelease || context.electronPlatformName !== "darwin") return;
  const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", bundle], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "inherit" });
}

module.exports = {
  afterPack: verifyPayloadAndAdHocSign,
  appId: "app.meetmorrow.installer",
  productName: "Morrow",
  copyright: "Copyright © 2026 Braden Riggins",
  artifactName: "Morrow-${version}-${os}-${arch}.${ext}",
  directories: {
    app: __dirname,
    output: process.env.MORROW_INSTALLER_OUTPUT || "dist",
    buildResources: "assets"
  },
  files: [
    "main.cjs",
    "preload.cjs",
    "renderer/**/*",
    "shared/**/*",
    "assets/**/*",
    "package.json"
  ],
  extraResources: [{ from: seed, to: "MorrowPayload", filter: ["**/*"] }],
  asar: true,
  forceCodeSigning: signedRelease,
  extraMetadata: {
    morrow: {
      bridgeDelivery: PACKAGED_BRIDGE_DELIVERY,
      desktopUpdates,
      releaseGraph: { schema: releaseGraph.schema, sha256: releaseGraph.graphSha256, sourceHead: releaseGraph.source.head },
      bridgeRelease: { manifestSha256: releaseGraph.bridgeReleaseManifestSha256 },
      mcpRuntime: { manifestSha256: releaseGraph.mcpRuntimeManifestSha256, nodeSha256: releaseGraph.nodeSha256 },
      packageInput: { manifestSha256: releaseGraph.packageInputManifestSha256 }
    }
  },
  publish: signedRelease ? [electronBuilderPublish()] : [],
  mac,
  dmg: {
    title: "Morrow",
    background: "assets/dmg-background.png",
    icon: "assets/morrow.icns",
    iconSize: 128,
    contents: [
      { x: 176, y: 274 },
      { x: 484, y: 274, type: "link", path: "/Applications" }
    ],
    window: { width: 660, height: 430 }
  },
  win,
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: false,
    packElevateHelper: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true
  }
};
