import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prepares a source checkout's Morrow Bridge folder to pair, as the desktop app prepares its own
 * Bridge folder. Morrow pairs only a Bridge that proves it holds the secret in its folder's
 * active-folder marker, and the connector reads the same secret from `bridge-installation.json`
 * beside its state. The marker is local state: git ignores it and no Bridge release carries it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "morrow-bridge-active-folder.json";
const CHALLENGE_SCHEMA = "morrow.bridge.active-folder-challenge.v1";

/** The id Chrome gives an unpacked extension with this manifest key. */
function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...digest].map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join("");
}

function writePrivate(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function prepareSourceBridgeFolder({
  extensionRoot = resolve(ROOT, "connector", "extension"),
  stateDirectory = resolve(ROOT, ".morrow"),
} = {}) {
  const manifest = JSON.parse(readFileSync(join(extensionRoot, "manifest.json"), "utf8"));
  if (typeof manifest.key !== "string" || typeof manifest.version !== "string") {
    throw new Error("connector/extension/manifest.json names no key or version");
  }
  const extensionId = extensionIdFromKey(manifest.key);
  const challenge = {
    challengeId: `morrow-${randomUUID().replaceAll("-", "")}`,
    nonce: randomBytes(32).toString("base64url"),
    extensionId,
    manifestVersion: manifest.version,
  };
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  writePrivate(join(extensionRoot, MARKER), { schema: CHALLENGE_SCHEMA, ...challenge });
  writePrivate(join(stateDirectory, "bridge-installation.json"), {
    schema: "morrow.bridge-source-folder.v1",
    extensionId,
    bridgeDirectory: extensionRoot,
    activeFolderChallenge: challenge,
  });
  return { extensionId, challengeId: challenge.challengeId, bridgeDirectory: extensionRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const prepared = prepareSourceBridgeFolder();
  process.stdout.write(`Morrow Bridge folder ready to pair: ${prepared.bridgeDirectory}\n`);
}
