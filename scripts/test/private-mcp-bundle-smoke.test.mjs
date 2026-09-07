import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const requestedPayload = process.env.MORROW_DESKTOP_PAYLOAD_SMOKE_ROOT?.trim();
const payloadRoot = requestedPayload ? resolve(requestedPayload) : "";
const smoke = requestedPayload ? test : test.skip;

function regularFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const file = join(current, entry.name);
    if (lstatSync(file).isSymbolicLink()) throw new Error(`payload contains a symlink: ${file}`);
    return entry.isDirectory() ? regularFiles(root, file) : [file];
  });
}

smoke("prepared desktop payload keeps executable runtime immutable and Bridge release receipt complete", () => {
  const node = process.platform === "win32"
    ? join(payloadRoot, "runtime", "node", "node.exe")
    : join(payloadRoot, "runtime", "node", "bin", "node");
  for (const file of [
    node,
    join(payloadRoot, "app", "packages", "client-config", "dist", "cli.js"),
    join(payloadRoot, "app", "packages", "mcp-server", "dist", "index.js"),
    join(payloadRoot, "app", "installer", "runtime-monitor.mjs"),
    join(payloadRoot, "app", "bridge-release", "manifest.json"),
    join(payloadRoot, "app", "bridge-release", "extension", "manifest.json"),
  ]) assert.equal(statSync(file).isFile(), true, `${file} is missing`);

  assert.equal(existsSync(join(payloadRoot, "app", "morrow.upstreams.json")), false);
  assert.equal(existsSync(join(payloadRoot, "State")), false);
  assert.equal(existsSync(join(payloadRoot, "Materials")), false);
  const release = JSON.parse(readFileSync(join(payloadRoot, "app", "bridge-release", "manifest.json"), "utf8"));
  assert.equal(release.schema, "morrow.bridge-release.v1");
  assert.equal(release.extensionId, "abeloclekioohahgedmjcdbpllfjfhko");
  assert.equal(release.files.some((file) => file.path === "morrow-bridge-active-folder.json"), false);
  assert.ok(release.files.length > 0);
  assert.equal(regularFiles(join(payloadRoot, "app", "node_modules")).length > 0, true);
});
