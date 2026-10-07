"use strict";

const { createRequire } = require("node:module");

function builderNotarization() {
  const builder = createRequire(require.resolve("electron-builder/package.json"));
  const appBuilder = createRequire(builder.resolve("app-builder-lib/package.json"));
  return {
    notarize: appBuilder("@electron/notarize").notarize,
    options: appBuilder("app-builder-lib/out/mac/MacTargetHelper").MacTargetHelper.getNotarizeOptions,
    createBlockmap: appBuilder("app-builder-lib/out/targets/differentialUpdateInfoBuilder").createBlockmap,
  };
}

async function finalizeSignedDmg(event, { signedRelease, dependencies } = {}) {
  if (!signedRelease || !event.file?.endsWith(".dmg")) return;
  const { notarize, options, createBlockmap } = dependencies || builderNotarization();
  const credentials = options(event.file);
  if (!credentials) throw new Error("Signed disk image notarization credentials are missing.");
  await notarize(credentials);
  // Stapling changes the DMG. Refresh the builder's blockmap before it creates update metadata.
  if (event.isWriteUpdateInfo) {
    event.updateInfo = await createBlockmap(event.file, event.target, event.packager, event.safeArtifactName);
  }
}

module.exports = { finalizeSignedDmg };
