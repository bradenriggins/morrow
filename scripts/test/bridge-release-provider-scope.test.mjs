import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BRIDGE_SOURCE_FILES, captureBridgeRelease } from "../package-mcp-bundle.mjs";

const root = resolve(new URL("../../", import.meta.url).pathname);

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

test("the packager applies the installer's exact Chrome extension version contract", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-bridge-version-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "extension");
  cpSync(join(root, "connector/extension"), source, { recursive: true, dereference: true });
  const manifestPath = join(source, "manifest.json");
  const original = JSON.parse(readFileSync(manifestPath, "utf8"));
  const writeVersion = (version) => writeFileSync(manifestPath, `${JSON.stringify({ ...original, version }, null, 2)}\n`);

  for (const version of ["1.2.3-beta", "1.2.3.4.5", "01.2.3", "1.2.65536"]) {
    writeVersion(version);
    assert.throws(() => captureBridgeRelease(source), /version is invalid/, version);
  }

  writeVersion("1.2.3.4");
  assert.equal(captureBridgeRelease(source).extensionManifest.version, "1.2.3.4");
});
