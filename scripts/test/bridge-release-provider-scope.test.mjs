import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_SOURCE_FILES, captureBridgeRelease } from "../package-mcp-bundle.mjs";

// The packaged Bridge connects Canvas and Moodle. Blackboard uses the official REST API in the Morrow
// app, so the extension carries no Blackboard session module and no browser token exchange.
// docs/implementation/THREE-LMS-BRIDGE-PARITY.md records why the browser path was removed.
const BROWSER_TOKEN_EXCHANGE_MARKERS = Object.freeze([
  "createBlackboardSessionCore",
  "PUBLIC_PKCE_TOKEN_EXCHANGE_ENABLED",
  "oauth2/authorizationcode",
  "oauth2/token",
  "code_challenge",
]);

test("the packaged Bridge ships the Canvas and Moodle modules and no Blackboard session module", () => {
  const release = captureBridgeRelease();
  const paths = release.files.map((file) => file.path);
  assert.ok(paths.includes("src/service-worker.js"));
  assert.ok(paths.includes("src/canvas-content.js"));
  assert.ok(paths.includes("src/moodle-executor.js"));
  assert.deepEqual(paths.filter((path) => /blackboard/i.test(path)), []);
  assert.deepEqual(BRIDGE_SOURCE_FILES.filter((path) => /blackboard/i.test(path)), []);
  for (const file of release.files) {
    const text = file.data.toString("utf8");
    for (const marker of BROWSER_TOKEN_EXCHANGE_MARKERS) {
      assert.equal(text.includes(marker), false, `${file.path} contains ${marker}`);
    }
  }
});

test("the Bridge describes only the platforms it connects", () => {
  const { extensionManifest } = captureBridgeRelease();
  assert.match(extensionManifest.description, /Canvas and Moodle/);
  assert.doesNotMatch(extensionManifest.description, /Blackboard/i);
});
