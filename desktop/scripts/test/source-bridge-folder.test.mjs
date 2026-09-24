import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { bridgeReleaseManifest, captureBridgeRelease } from "../package-mcp-bundle.mjs";
import { prepareSourceBridgeFolder } from "../source-bridge-folder.mjs";
import { createBridgeMaintenance } from "../../connector/extension/src/bridge-maintenance.js";

/**
 * A Bridge loaded from source pairs the way the desktop app's Bridge does: `pnpm run setup` writes
 * an active-folder marker into `connector/extension` and records the same challenge beside the
 * connector state, so Connect Morrow can prove the folder. These cases run the real marker reader
 * Morrow Bridge uses, the real connector config, and the real loopback server.
 */
const root = resolve(new URL("../../", import.meta.url).pathname);
const MARKER = "morrow-bridge-active-folder.json";

function sourceTree(t) {
  const directory = mkdtempSync(join(tmpdir(), "morrow-source-bridge-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const extensionRoot = join(directory, "connector", "extension");
  cpSync(join(root, "connector", "extension"), extensionRoot, { recursive: true, filter: (source) => !source.endsWith(MARKER) });
  return { extensionRoot, stateDirectory: join(directory, ".morrow") };
}

/** Morrow Bridge's own reader, over the files in `extensionRoot`, as Chrome serves an unpacked folder. */
function bridgeReader(extensionRoot, manifest) {
  const id = "abeloclekioohahgedmjcdbpllfjfhko";
  return createBridgeMaintenance({
    chromeApi: {
      runtime: { id, getManifest: () => manifest, getURL: (path) => `chrome-extension://${id}/${path}` },
      storage: { local: { get: async () => ({}), set: async () => undefined } },
      management: { getSelf: async () => ({ id, version: manifest.version, installType: "development" }) },
    },
    fetchImpl: async (url) => {
      try {
        return new Response(readFileSync(join(extensionRoot, new URL(url).pathname.slice(1))));
      } catch {
        return new Response("", { status: 404 });
      }
    },
  });
}

test("a source Bridge folder pairs with Morrow through the proof its marker makes", async (t) => {
  const { extensionRoot, stateDirectory } = sourceTree(t);
  const manifest = JSON.parse(readFileSync(join(extensionRoot, "manifest.json"), "utf8"));
  const prepared = prepareSourceBridgeFolder({ extensionRoot, stateDirectory });
  assert.equal(prepared.extensionId, "abeloclekioohahgedmjcdbpllfjfhko", "the id Chrome gives the Bridge's pinned key");
  assert.equal(statSync(join(stateDirectory, "bridge-installation.json")).mode & 0o777, 0o600);
  assert.equal(statSync(stateDirectory).mode & 0o777, 0o700);

  const folder = await bridgeReader(extensionRoot, manifest).activeFolderSecret();
  assert.deepEqual(folder, { extensionId: prepared.extensionId, challengeId: prepared.challengeId, nonce: folder.nonce });

  const { loadCanvasConnectorConfig } = await import("../../packages/canvas-connector-mcp/dist/config.js");
  const config = await loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: join(stateDirectory, "canvas-connector.json") }, root);
  assert.deepEqual(await config.pairingSecret(), folder, "the connector reads the same secret the Bridge folder holds");

  const { LoopbackBridgeServer } = await import("../../packages/bridge-loopback/dist/index.js");
  const { bridgePairingProofPayload } = await import("../../packages/bridge-protocol/dist/index.js");
  const server = new LoopbackBridgeServer({
    token: config.token,
    expectedRuntimeRevision: "7".repeat(40),
    expectedCatalogDigest: "a".repeat(64),
    port: 0,
    pairingEnabled: true,
    pairingSecret: config.pairingSecret,
    onPairApproved: config.approveExtensionId,
  });
  t.after(() => server.close());
  const address = await server.start();
  const origin = `chrome-extension://${folder.extensionId}`;
  const offer = await (await fetch(`http://${address.host}:${address.port}${address.path}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ extensionId: folder.extensionId, catalogDigest: "a".repeat(64), runtimeRevision: "7".repeat(40) }),
  })).json();
  const proof = createHmac("sha256", Buffer.from(folder.nonce, "utf8")).update(bridgePairingProofPayload({
    pairingId: offer.pairingId, challenge: offer.challenge, extensionId: folder.extensionId, activeFolderChallengeId: folder.challengeId,
  })).digest("base64url");
  const confirmed = await fetch(offer.confirmUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ extensionId: folder.extensionId, activeFolderChallengeId: folder.challengeId, proof }),
  });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), { schema: "morrow.bridge.pairing-result.v2", status: "approved", token: config.token });
  const saved = JSON.parse(readFileSync(join(stateDirectory, "canvas-connector.json"), "utf8"));
  assert.deepEqual(saved.allowedExtensionIds, [folder.extensionId]);
});

test("running setup again replaces the secret in the folder and in the record together", async (t) => {
  const { extensionRoot, stateDirectory } = sourceTree(t);
  const first = prepareSourceBridgeFolder({ extensionRoot, stateDirectory });
  const firstMarker = JSON.parse(readFileSync(join(extensionRoot, MARKER), "utf8"));
  const second = prepareSourceBridgeFolder({ extensionRoot, stateDirectory });
  assert.notEqual(second.challengeId, first.challengeId);
  const marker = JSON.parse(readFileSync(join(extensionRoot, MARKER), "utf8"));
  assert.equal(marker.challengeId, second.challengeId);
  assert.notEqual(marker.nonce, firstMarker.nonce);
  const { loadCanvasConnectorConfig } = await import("../../packages/canvas-connector-mcp/dist/config.js");
  const config = await loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: join(stateDirectory, "canvas-connector.json") }, root);
  assert.deepEqual(await config.pairingSecret(), { challengeId: marker.challengeId, nonce: marker.nonce, extensionId: marker.extensionId });
});

test("the marker is local state that no Bridge release ever carries", (t) => {
  const { extensionRoot, stateDirectory } = sourceTree(t);
  const before = captureBridgeRelease(extensionRoot).files.map((file) => file.path);
  prepareSourceBridgeFolder({ extensionRoot, stateDirectory });
  const after = captureBridgeRelease(extensionRoot).files.map((file) => file.path);
  assert.deepEqual(after, before);
  assert.equal(after.includes(MARKER), false);
  const ignored = readFileSync(join(root, ".gitignore"), "utf8").split("\n");
  assert.ok(ignored.includes(`/connector/extension/${MARKER}`), "git ignores the marker, so it is never committed");
});

// The desktop app writes its Bridge folder and its record with the installer's own module. The
// connector reads the secret from that record, and Morrow Bridge reads it from that folder's marker.
test("the Bridge folder the desktop app sets up gives the connector and the Bridge the same secret", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-app-bridge-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { initializeBridgeDirectory, issueBridgeActiveFolderChallenge } = createRequire(import.meta.url)("../../installer/shared/bridge-updates.cjs");
  const bundled = join(directory, "bundle");
  const sourceDirectory = join(bundled, "extension");
  cpSync(join(root, "connector", "extension"), sourceDirectory, { recursive: true, filter: (source) => !source.endsWith(MARKER) });
  const release = captureBridgeRelease(sourceDirectory);
  mkdirSync(bundled, { recursive: true });
  const releaseManifestPath = join(bundled, "manifest.json");
  writeFileSync(releaseManifestPath, `${JSON.stringify(bridgeReleaseManifest(sourceDirectory))}\n`);
  const options = {
    sourceDirectory,
    releaseManifestPath,
    trustedReleaseManifestSha256: createHash("sha256").update(readFileSync(releaseManifestPath)).digest("hex"),
    expectedExtensionId: "abeloclekioohahgedmjcdbpllfjfhko",
    stateDirectory: join(directory, "State"),
    bridgeDirectory: join(directory, "Bridge"),
  };
  await initializeBridgeDirectory({ ...options, initialChallenge: { challengeId: "morrow-app-challenge-0123456789abcdef", nonce: "app-folder-secret-with-enough-entropy-for-pairing" } });

  const { loadCanvasConnectorConfig } = await import("../../packages/canvas-connector-mcp/dist/config.js");
  const config = await loadCanvasConnectorConfig({ MORROW_CANVAS_CONNECTOR_STATE: join(options.stateDirectory, "canvas-connector.json") }, root);
  const folder = await bridgeReader(options.bridgeDirectory, release.extensionManifest).activeFolderSecret();
  assert.deepEqual(await config.pairingSecret(), folder);
  assert.equal(folder.challengeId, "morrow-app-challenge-0123456789abcdef");

  // Repair issues a new challenge, and the next pairing reads the new one from both places.
  await issueBridgeActiveFolderChallenge({ stateDirectory: options.stateDirectory, bridgeDirectory: options.bridgeDirectory, expectedExtensionId: options.expectedExtensionId, challenge: { challengeId: "morrow-app-challenge-repaired-0123456789", nonce: "repaired-folder-secret-with-enough-entropy" } });
  const repaired = await bridgeReader(options.bridgeDirectory, release.extensionManifest).activeFolderSecret();
  assert.equal(repaired.challengeId, "morrow-app-challenge-repaired-0123456789");
  assert.deepEqual(await config.pairingSecret(), repaired);
});
