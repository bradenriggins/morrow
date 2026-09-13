import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  RUNTIME_DEPENDENCY_NAMES,
  assertPayloadSnapshot,
  assertUnsignedWindowsExecutable,
  cacheVerifiedArchive,
  captureBridgeRelease,
  desktopInstallerReceipt,
  materializeRuntimeDependencies,
  rebuildWorkspaceReleaseOutputs,
  unsignedBuilderEnvironment,
  windowsAuthenticodeCertificateTable,
  workspacePackages
} from "../package-mcp-bundle.mjs";

const root = resolve(new URL("../../", import.meta.url).pathname);
const builder = resolve(root, "scripts/package-mcp-bundle.mjs");
const requireInstaller = createRequire(import.meta.url);
const {
  createPackagerAdmission,
  verifyPackagerAdmission,
} = requireInstaller(resolve(root, "installer/shared/packager-admission.cjs"));

function sealedInput(payload) {
  return {
    manifest: JSON.parse(readFileSync(join(payload, "app/package-input-manifest.json"), "utf8")),
    manifestBytes: readFileSync(join(payload, "app/package-input-manifest.json")),
    mcpRuntime: { bytes: readFileSync(join(payload, "app/mcp-runtime-manifest.json")) }
  };
}

test("final desktop receipt retains the immutable payload source checkpoint", () => {
  const source = {
    head: "a".repeat(40),
    dirty: true,
    statusSha256: "b".repeat(64),
    inputManifestSha256: "c".repeat(64),
    inputManifestFileCount: 42,
    mcpRuntimeManifestSha256: "d".repeat(64),
    dependencyMaterialization: { schema: "morrow.runtime-dependency-materialization.v1" },
    reproducibleFrom: "app/package-input-manifest.json",
    note: "fixture immutable source checkpoint",
  };
  const releaseGraph = {
    schema: "morrow.desktop-packager-admission.v1",
    target: "darwin-arm64",
    source: { head: source.head, dirty: source.dirty, statusSha256: source.statusSha256 },
    graphSha256: "f".repeat(64),
  };
  const receipt = desktopInstallerReceipt({
    target: "darwin-arm64",
    artifacts: [{ name: "Morrow.dmg", sha256: "e".repeat(64) }],
    payloadReceipt: { node: { version: "22.23.2" }, source },
    signing: { mode: "unsigned_private_qa" },
    releaseGraph,
  });
  assert.deepEqual(receipt.source, source);
  assert.notEqual(receipt.source, source);
  source.note = "mutated after final receipt";
  source.dependencyMaterialization.schema = "mutated";
  assert.equal(receipt.source.note, "fixture immutable source checkpoint");
  assert.equal(receipt.source.dependencyMaterialization.schema, "morrow.runtime-dependency-materialization.v1");
  assert.deepEqual(receipt.payload.releaseGraph, {
    schema: "morrow.desktop-packager-admission.v1",
    sha256: "f".repeat(64),
  });
  assert.equal(receipt.verification.packagerAdmission, true);
  assert.throws(() => desktopInstallerReceipt({
    target: "darwin-arm64",
    artifacts: [],
    payloadReceipt: { node: {}, source: { ...source, inputManifestSha256: null } },
    signing: { mode: "unsigned_private_qa" },
    releaseGraph,
  }), /immutable payload source checkpoint/);
  assert.throws(() => desktopInstallerReceipt({
    target: "darwin-arm64",
    artifacts: [],
    payloadReceipt: { node: {}, source },
    signing: { mode: "unsigned_private_qa" },
  }), /reviewed payload release graph/);
});

test("desktop payload seals the actual gateway package, records its source provenance, and rejects a tampered sibling module", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-desktop-provenance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const payload = join(directory, "payload");
  const receipt = JSON.parse(execFileSync(process.execPath, [builder, "--target", "darwin-arm64", "--prepare-desktop-payload", payload], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  }));
  const sealed = sealedInput(payload);
  const releaseGraph = createPackagerAdmission({ payload, target: "darwin-arm64" });
  const admitted = verifyPackagerAdmission({ payload, target: "darwin-arm64", admission: releaseGraph });
  const runtime = JSON.parse(sealed.mcpRuntime.bytes.toString("utf8"));
  assert.equal(admitted.graphSha256, releaseGraph.graphSha256);
  assert.deepEqual(admitted.source, sealed.manifest.source);
  assert.equal(admitted.packageInputManifestSha256, receipt.source.inputManifestSha256);
  assert.equal(admitted.mcpRuntimeManifestSha256, receipt.source.mcpRuntimeManifestSha256);
  assert.equal(runtime.schema, "morrow.mcp-runtime-manifest.v2");
  assert.equal(runtime.package.name, "@morrow-lms/gateway");
  assert.equal(runtime.package.version, JSON.parse(readFileSync(join(payload, "app/packages/mcp-server/package.json"), "utf8")).version);
  assert.equal(receipt.source.mcpRuntimeManifestSha256, sealed.manifest.mcpRuntime.sha256);
  assert.equal(sealed.manifest.schema, "morrow.desktop-package-input.v2");
  assert.deepEqual(sealed.manifest.source, { head: receipt.source.head, dirty: receipt.source.dirty, statusSha256: receipt.source.statusSha256 });
  assert.deepEqual(receipt.source.dependencyMaterialization, sealed.manifest.dependencyMaterialization);
  assert.equal(sealed.manifest.dependencyMaterialization.packageManager.declared, "pnpm@10.6.1");
  assert.equal(sealed.manifest.dependencyMaterialization.packageManager.observed, "10.6.1");
  assert.equal(sealed.manifest.dependencyMaterialization.lockfile.sha256, createHash("sha256").update(readFileSync(join(root, "pnpm-lock.yaml"))).digest("hex"));
  assert.equal(sealed.manifest.dependencyMaterialization.install.mode, "isolated_frozen_install");
  assert.equal(sealed.manifest.dependencyMaterialization.install.network, "offline");
  assert.equal(sealed.manifest.dependencyMaterialization.install.scripts, "disabled");
  assert.deepEqual(sealed.manifest.dependencyMaterialization.dependencies.map((item) => item.name), [...RUNTIME_DEPENDENCY_NAMES].sort());
  for (const dependency of sealed.manifest.dependencyMaterialization.dependencies) assert.match(dependency.integrity, /^sha512-/);
  assert.match(receipt.source.head, /^[0-9a-f]{40}$/);
  assert.equal(receipt.source.inputManifestSha256, createHash("sha256").update(sealed.manifestBytes).digest("hex"));
  assert.equal(receipt.source.inputManifestFileCount, sealed.manifest.files.length);
  const expectedDirectFiles = sealed.manifest.files.flatMap((record) => record.destinations
    .filter((destination) => destination.startsWith("app/packages/") || destination.startsWith("app/installer/"))
    .map((destination) => ({ path: destination.slice("app/".length), bytes: record.bytes, sha256: record.sha256 })))
    .sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(runtime.directFiles, expectedDirectFiles);
  assert.equal(receipt.source.reproducibleFrom, "app/package-input-manifest.json");
  assert.match(receipt.source.note, /dirty[\s\S]*inputManifestSha256/);
  for (const path of [
    "node_modules/postcss/node_modules/.bin/nanoid",
    "node_modules/cross-spawn/node_modules/.bin/node-which"
  ]) {
    assert.equal(existsSync(join(payload, "app", path)), false);
    assert.equal(sealed.manifest.files.some((file) => file.path === path), false);
  }
  assertPayloadSnapshot(payload, sealed);

  const sibling = join(payload, "app/packages/mcp-server/dist/config.js");
  chmodSync(sibling, 0o600);
  writeFileSync(sibling, `${readFileSync(sibling, "utf8")}\n// tampered\n`);
  assert.throws(() => assertPayloadSnapshot(payload, sealed), /sealed source snapshot|dependency file changed/);
  assert.throws(
    () => verifyPackagerAdmission({ payload, target: "darwin-arm64", admission: releaseGraph }),
    /does not match the reviewed release graph|differs from its package input graph|differs from its MCP runtime graph/,
  );
});

test("release dependency materialization ignores a poisoned live package tree and resolves frozen offline bytes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-release-dependency-input-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  mkdirSync(join(source, "packages"), { recursive: true });
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]) cpSync(join(root, file), join(source, file));
  for (const entry of workspacePackages()) {
    const target = join(source, "packages", entry.directory);
    mkdirSync(target, { recursive: true });
    cpSync(join(entry.source, "package.json"), join(target, "package.json"));
  }

  const poisoned = join(source, "packages/client-config/node_modules/@iarna/toml");
  mkdirSync(join(poisoned, ".."), { recursive: true });
  cpSync(join(root, "packages/client-config/node_modules/@iarna/toml"), poisoned, { recursive: true, dereference: true });
  const marker = "MORROW_RELEASE_AUDIT_UNVERIFIED_DEPENDENCY_BYTES";
  writeFileSync(join(poisoned, "toml.js"), `${readFileSync(join(poisoned, "toml.js"), "utf8")}\n// ${marker}\n`);
  const resolvesFromPoisonedTree = createRequire(join(source, "packages/client-config/package.json")).resolve("@iarna/toml");
  assert.match(readFileSync(resolvesFromPoisonedTree, "utf8"), new RegExp(marker));

  const materialized = materializeRuntimeDependencies(workspacePackages(source), join(directory, "release"), source);
  const isolatedToml = materialized.dependencies.get("@iarna/toml");
  assert.ok(isolatedToml);
  assert.equal(readFileSync(join(isolatedToml, "toml.js"), "utf8").includes(marker), false);
  assert.notEqual(resolve(isolatedToml), resolve(poisoned));
  assert.equal(materialized.provenance.lockfile.sha256, createHash("sha256").update(readFileSync(join(source, "pnpm-lock.yaml"))).digest("hex"));
});

test("Bridge package source refuses an extra unreviewed file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-bridge-provenance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bridge = join(directory, "extension");
  cpSync(join(root, "connector/extension"), bridge, { recursive: true, dereference: true });
  writeFileSync(join(bridge, "unreviewed.js"), "export const unexpected = true;\n");
  assert.throws(() => captureBridgeRelease(bridge), /audited allowlist/);
});

test("an interrupted archive download cannot poison the shared package cache", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-runtime-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const archive = join(directory, "node-runtime.tar.xz");
  const complete = Buffer.from("complete verified Node runtime archive");
  const expected = createHash("sha256").update(complete).digest("hex");
  writeFileSync(archive, "poisoned partial bytes");

  const interrupted = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(complete.subarray(0, 8));
      controller.error(new Error("synthetic interrupted transfer"));
    },
  }));
  await assert.rejects(
    cacheVerifiedArchive(archive, expected, async () => interrupted),
    /synthetic interrupted transfer/,
  );
  assert.equal(existsSync(archive), false);
  assert.deepEqual(readdirSync(directory), []);

  const cached = await cacheVerifiedArchive(archive, expected, async () => new Response(complete));
  assert.equal(cached, archive);
  assert.deepEqual(readFileSync(archive), complete);
  assert.deepEqual(readdirSync(directory), ["node-runtime.tar.xz"]);
});

function windowsExecutable(certificateBytes = 0) {
  const pe = 64;
  const optional = pe + 24;
  const optionalBytes = 240;
  const certificateOffset = optional + optionalBytes;
  const data = Buffer.alloc(certificateOffset + certificateBytes);
  data.writeUInt16LE(0x5a4d, 0);
  data.writeUInt32LE(pe, 0x3c);
  data.writeUInt32LE(0x00004550, pe);
  data.writeUInt16LE(optionalBytes, pe + 20);
  data.writeUInt16LE(0x20b, optional);
  data.writeUInt32LE(16, optional + 108);
  if (certificateBytes > 0) {
    data.writeUInt32LE(certificateOffset, optional + 112 + (4 * 8));
    data.writeUInt32LE(certificateBytes, optional + 112 + (4 * 8) + 4);
  }
  return data;
}

test("unsigned Windows packaging strips signing authority and rejects a signed artifact", (t) => {
  const environment = unsignedBuilderEnvironment({
    PATH: process.env.PATH,
    CSC_LINK: "certificate",
    WIN_CSC_LINK: "windows-certificate",
    AZURE_CLIENT_SECRET: "cloud-secret",
    GITHUB_TOKEN: "publish-token",
    MORROW_CHROME_STORE_LIVE: "1",
  });
  assert.equal(environment.PATH, process.env.PATH);
  for (const name of ["CSC_LINK", "WIN_CSC_LINK", "AZURE_CLIENT_SECRET", "GITHUB_TOKEN", "MORROW_CHROME_STORE_LIVE"]) {
    assert.equal(Object.hasOwn(environment, name), false, name);
  }
  assert.equal(environment.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.equal(environment.MORROW_SIGNED_RELEASE, "0");

  const directory = mkdtempSync(join(tmpdir(), "morrow-windows-authenticode-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const unsigned = join(directory, "unsigned.exe");
  const signed = join(directory, "signed.exe");
  writeFileSync(unsigned, windowsExecutable());
  writeFileSync(signed, windowsExecutable(16));
  assert.deepEqual(windowsAuthenticodeCertificateTable(unsigned), { present: false, offset: 0, bytes: 0 });
  assert.equal(assertUnsignedWindowsExecutable(unsigned), "authenticode_absent");
  assert.deepEqual(windowsAuthenticodeCertificateTable(signed), { present: true, offset: 328, bytes: 16 });
  assert.throws(() => assertUnsignedWindowsExecutable(signed), /Authenticode-signed installer/);
});

test("release output capture replaces every stale ignored workspace build", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-release-rebuild-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of [
    "batch-engine", "blackboard-learn-api", "bridge-loopback", "bridge-protocol", "canvas-api-catalog", "canvas-connector-mcp", "client-config",
    "contracts", "gateway-core", "legacy-bridge-mcp", "mcp-server", "operation-journal", "upstream-mcp",
  ]) {
    const packageRoot = join(directory, "packages", name);
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: `@fixture/${name}`, version: "1.0.0" })}\n`);
    writeFileSync(join(packageRoot, "dist", "stale.js"), "unreviewed stale executable\n");
  }

  const rebuilt = rebuildWorkspaceReleaseOutputs(directory, (packages) => {
    for (const entry of packages) {
      assert.equal(existsSync(join(entry.source, "dist", "stale.js")), false);
      mkdirSync(join(entry.source, "dist"), { recursive: true });
      writeFileSync(join(entry.source, "dist", "index.js"), `export const packageName = ${JSON.stringify(entry.name)};\n`);
    }
  });
  assert.equal(rebuilt.length, 13);
  for (const entry of rebuilt) {
    assert.equal(existsSync(join(entry.source, "dist", "stale.js")), false);
    assert.match(readFileSync(join(entry.source, "dist", "index.js"), "utf8"), /packageName/);
  }
});
