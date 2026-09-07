const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalDirectory, isComplete, payloadLayout, runtimeStatus, verifyMcpRuntime } = require("../shared/runtime.cjs");

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function writeMcpRuntimeFixture(root) {
  const app = path.join(root, "app");
  const gatewayFiles = [
    ["package.json", JSON.stringify({ name: "@morrow-lms/gateway", version: "1.0.0-rc.0" })],
    ["dist/index.js", "fixture"],
    ["dist/runtime.js", "gateway sibling"],
    ["dist/local-owner-maintenance.js", "fixture"],
    ["dist/local-owner-sidecar-access.js", "fixture"],
  ];
  const files = [];
  for (const [relative, content] of gatewayFiles) {
    const direct = path.join(app, "packages", "mcp-server", relative);
    const installed = path.join(app, "node_modules", "@morrow-lms", "gateway", relative);
    await fs.mkdir(path.dirname(direct), { recursive: true });
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.writeFile(direct, content);
    await fs.writeFile(installed, content);
    files.push({
      path: `node_modules/@morrow-lms/gateway/${relative}`,
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
    });
  }
  const manifest = {
    schema: "morrow.mcp-runtime-manifest.v1",
    package: { name: "@morrow-lms/gateway", version: "1.0.0-rc.0" },
    entrypoint: { path: "packages/mcp-server/dist/index.js", bytes: Buffer.byteLength("fixture"), sha256: sha256("fixture") },
    dependencies: [{
      name: "@morrow-lms/gateway",
      version: "1.0.0-rc.0",
      packageJson: files[0],
      files,
    }],
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestSha256 = sha256(bytes);
  await fs.writeFile(path.join(app, "mcp-runtime-manifest.json"), bytes);
  await fs.writeFile(path.join(app, "package-input-manifest.json"), `${JSON.stringify({
    schema: "morrow.desktop-package-input.v1",
    mcpRuntime: { path: "app/mcp-runtime-manifest.json", sha256: manifestSha256 },
  })}\n`);
  return manifestSha256;
}

async function payload(root) {
  const files = process.platform === "win32"
    ? ["runtime/node/node.exe"]
    : ["runtime/node/bin/node"];
  files.push(
    "app/packages/client-config/dist/cli.js",
    "app/packages/mcp-server/dist/index.js",
    "app/packages/mcp-server/dist/local-owner-maintenance.js",
    "app/packages/mcp-server/dist/local-owner-sidecar-access.js",
    "app/packages/canvas-connector-mcp/dist/index.js",
    "app/connector/extension/manifest.json",
    "app/installer/runtime-monitor.mjs",
    "app/bridge-release/manifest.json",
    "app/bridge-release/extension/manifest.json"
  );
  await Promise.all(files.map(async (relative) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "fixture");
  }));
  return writeMcpRuntimeFixture(root);
}

test("runtime code stays in the immutable packaged payload while state is separate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const immutablePayload = path.join(root, "MorrowPayload");
  const userData = path.join(root, "user-data");
  const manifestSha256 = await payload(immutablePayload);
  const installed = payloadLayout(immutablePayload, userData);
  assert.equal(await isComplete(installed.payload), true);
  assert.match(installed.node, /MorrowPayload/);
  assert.match(installed.state, /user-data/);
  assert.doesNotMatch(installed.node, /user-data/);
  assert.equal(await fs.readFile(installed.monitorScript, "utf8"), "fixture");
  assert.deepEqual(await verifyMcpRuntime(installed.payload, manifestSha256), {
    schema: "morrow.mcp-runtime.health.v1",
    packageVersion: "1.0.0-rc.0",
    manifestSha256,
  });
});

test("MCP startup verification rejects a tampered direct gateway sibling", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-runtime-tamper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payloadRoot = path.join(root, "MorrowPayload");
  const manifestSha256 = await payload(payloadRoot);
  assert.ok(await verifyMcpRuntime(payloadRoot, manifestSha256));
  await fs.writeFile(path.join(payloadRoot, "app", "packages", "mcp-server", "dist", "runtime.js"), "tampered");
  assert.equal(await verifyMcpRuntime(payloadRoot, manifestSha256), null);
});

test("materials workspace resolves a selected symlink directory once", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const actual = path.join(root, "actual");
  const linked = path.join(root, "linked");
  await fs.mkdir(actual);
  await fs.symlink(actual, linked);
  assert.equal(await canonicalDirectory(linked), await fs.realpath(actual));
  await assert.rejects(() => canonicalDirectory(path.join(root, "missing")), /ENOENT/);
});

test("a complete payload remains uncertain until the shared-owner gateway reports ready", () => {
  assert.equal(runtimeStatus(false, { health: { gatewayReady: true } }), "repair_required");
  assert.equal(runtimeStatus(true, { health: { gatewayReady: "unknown" } }), "uncertain");
  assert.equal(runtimeStatus(true, { health: { gatewayReady: false } }), "uncertain");
  assert.equal(runtimeStatus(true, { health: { gatewayReady: true } }), "ready");
});

test("configuration rollback leaves a newer assistant edit untouched", async (t) => {
  const { captureConfiguration, restoreConfiguration } = require("../shared/runtime.cjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, "config.toml");
  await fs.writeFile(config, "before");
  const snapshot = await captureConfiguration(config, path.join(root, "backups"));
  await fs.writeFile(config, "morrow installed");
  const expected = require("node:crypto").createHash("sha256").update("morrow installed").digest("hex");
  await fs.writeFile(config, "newer assistant edit");
  assert.equal(await restoreConfiguration(snapshot, expected), false);
  assert.equal(await fs.readFile(config, "utf8"), "newer assistant edit");
});
