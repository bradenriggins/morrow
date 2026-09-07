const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const seed = process.env.MORROW_INSTALLER_PAYLOAD;
if (!seed || !path.isAbsolute(seed)) {
  throw new Error("MORROW_INSTALLER_PAYLOAD must be an absolute path to the prepared Morrow payload.");
}

const manifest = require("./package.json");
const signedRelease = process.env.MORROW_SIGNED_RELEASE === "1";
const bridgeReleaseManifest = path.join(seed, "app", "bridge-release", "manifest.json");
if (!fs.existsSync(bridgeReleaseManifest)) {
  throw new Error("Prepared Morrow payload is missing its Bridge release manifest.");
}
const mcpRuntimeManifest = path.join(seed, "app", "mcp-runtime-manifest.json");
const packageInputManifest = path.join(seed, "app", "package-input-manifest.json");
if (!fs.existsSync(mcpRuntimeManifest) || !fs.existsSync(packageInputManifest)) {
  throw new Error("Prepared Morrow payload is missing its MCP runtime manifest binding.");
}
if (signedRelease && !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(manifest.version)) {
  throw new Error("A signed Morrow release must use a stable SemVer version.");
}
const bridgeReleaseManifestSha256 = crypto.createHash("sha256").update(fs.readFileSync(bridgeReleaseManifest)).digest("hex");
const mcpRuntimeManifestSha256 = crypto.createHash("sha256").update(fs.readFileSync(mcpRuntimeManifest)).digest("hex");
let packageInput;
try { packageInput = JSON.parse(fs.readFileSync(packageInputManifest, "utf8")); } catch { throw new Error("Prepared Morrow payload has an invalid package input manifest."); }
if (!packageInput || packageInput.schema !== "morrow.desktop-package-input.v1"
  || !packageInput.mcpRuntime || packageInput.mcpRuntime.path !== "app/mcp-runtime-manifest.json"
  || packageInput.mcpRuntime.sha256 !== mcpRuntimeManifestSha256) {
  throw new Error("Prepared Morrow payload MCP runtime manifest is not bound by its package input manifest.");
}
const desktopUpdates = Object.freeze({
  enabled: signedRelease,
  feedId: "morrow-github-stable",
  provider: "github",
  owner: "example-owner",
  repo: "morrow",
  channel: "latest"
});
const mac = {
  category: "public.app-category.education",
  icon: "assets/morrow.icns",
  target: [
    { target: "dmg", arch: ["arm64"] },
    { target: "zip", arch: ["arm64"] }
  ]
};
if (!signedRelease) mac.identity = null;

module.exports = {
  appId: "app.meetmorrow.installer",
  productName: "Morrow",
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
      desktopUpdates,
      bridgeRelease: { manifestSha256: bridgeReleaseManifestSha256 },
      mcpRuntime: { manifestSha256: mcpRuntimeManifestSha256 }
    }
  },
  publish: [{
    provider: "github",
    owner: "example-owner",
    repo: "morrow",
    channel: "latest",
    releaseType: "release"
  }],
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
  win: {
    icon: "assets/morrow.ico",
    target: [{ target: "nsis", arch: ["x64"] }]
  },
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
