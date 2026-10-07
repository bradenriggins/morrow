const assert = require("node:assert/strict");
const test = require("node:test");
const { finalizeSignedDmg } = require("../signed-dmg.cjs");

test("DMG notarization and stapling finish before the final blockmap and update digest", async () => {
  const calls = [];
  const event = { file: "/tmp/Morrow.dmg", target: {}, packager: {}, safeArtifactName: "Morrow.dmg", isWriteUpdateInfo: true, updateInfo: { sha512: "before-stapling" } };
  await finalizeSignedDmg(event, { signedRelease: true, dependencies: {
    options: (file) => ({ appPath: file, appleId: "fixture" }),
    notarize: async (options) => { calls.push(["notarize-and-staple", options.appPath]); },
    createBlockmap: async (file) => { calls.push(["blockmap", file]); return { sha512: "after-stapling" }; },
  } });
  assert.deepEqual(calls, [["notarize-and-staple", event.file], ["blockmap", event.file]]);
  assert.deepEqual(event.updateInfo, { sha512: "after-stapling" });
});

test("unsigned artifacts and blockmap events never call the notary service", async () => {
  const dependencies = { options: () => { throw new Error("must not run"); } };
  await finalizeSignedDmg({ file: "/tmp/Morrow.dmg" }, { signedRelease: false, dependencies });
  await finalizeSignedDmg({ file: "/tmp/Morrow.dmg.blockmap" }, { signedRelease: true, dependencies });
});

test("failed notarization cannot produce a final update digest", async () => {
  const event = { file: "/tmp/Morrow.dmg", isWriteUpdateInfo: true };
  await assert.rejects(finalizeSignedDmg(event, { signedRelease: true, dependencies: {
    options: () => ({ appPath: event.file }),
    notarize: async () => { throw new Error("not accepted"); },
    createBlockmap: async () => { throw new Error("must not run"); },
  } }), /not accepted/);
  assert.equal(event.updateInfo, undefined);
});
