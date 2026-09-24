import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { BRIDGE_SOURCE_FILES, bridgeReleaseManifest, copyBridgeRelease } from "../package-mcp-bundle.mjs";

const root = resolve(new URL("../../", import.meta.url).pathname);
const extensionRoot = resolve(root, "connector", "extension");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function releaseManifestDigest(manifest) {
  return sha256(`${JSON.stringify(manifest, null, 2)}\n`);
}

function fixtureLedger(extension) {
  const manifest = bridgeReleaseManifest(extension);
  return {
    schema: "morrow.bridge-release-ledger.v1",
    releases: [{ version: manifest.version, releaseManifestSha256: releaseManifestDigest(manifest) }]
  };
}

test("the newest release ledger entry is the Bridge source in this checkout", () => {
  const ledger = JSON.parse(readFileSync(resolve(root, "connector", "release-ledger.json"), "utf8"));
  const manifest = bridgeReleaseManifest(extensionRoot);
  const current = ledger.releases.at(-1);
  assert.equal(current.version, manifest.version, "the ledger names an older Bridge version than the manifest");
  assert.equal(current.releaseManifestSha256, releaseManifestDigest(manifest),
    "the Bridge source changed after the newest sealed release ledger entry");
});

test("packaging refuses Bridge bytes the newest ledger entry does not seal", () => {
  const fixture = mkdtempSync(join(tmpdir(), "morrow-bridge-seal-"));
  try {
    const appRoot = join(fixture, "app");
    const connector = join(fixture, "connector");
    const extension = join(connector, "extension");
    mkdirSync(extension, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    for (const path of BRIDGE_SOURCE_FILES) {
      mkdirSync(dirname(join(extension, path)), { recursive: true });
      cpSync(resolve(extensionRoot, path), join(extension, path));
    }
    writeFileSync(join(connector, "release-ledger.json"), `${JSON.stringify(fixtureLedger(extension), null, 2)}\n`);

    const sealed = copyBridgeRelease(appRoot, extension, connector);
    assert.equal(sealed.manifestSha256, sha256(readFileSync(join(appRoot, "bridge-release", "manifest.json"))));

    // The packager stages connector/extension under a temporary path, so the guard has to check
    // those bytes against the ledger too: a staged copy that differs from the sealed release
    // would otherwise seal changed Bridge files under an already sealed version.
    writeFileSync(join(extension, "generated", "canvas-readback-plan.js"), "// changed after the seal\n");
    assert.throws(
      () => copyBridgeRelease(appRoot, extension, connector),
      /Morrow Bridge source changed without a new sealed release ledger entry/
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
