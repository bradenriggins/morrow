import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The gate on Morrow's desktop claims. Each test compares a document against the
 * thing that makes the claim true: the build configuration electron-builder is
 * handed, the Bridge module that removes a rollback copy, the retention policy
 * the app renders, and the receipt a run wrote. This keeps a desktop document from
 * describe an application, an artifact, or a proof that does not exist.
 *
 * Receipts under `output/` are local evidence and are not tracked, so a missing
 * one is reported as a diagnostic rather than a failure. A receipt that is
 * present has to say what the documents say it says.
 */
const root = new URL("../../", import.meta.url);
const rootPath = fileURLToPath(root);
const require = createRequire(import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");
// `.github/` is at the repository root, one level above the desktop product; every other named
// path is relative to the desktop product.
const present = (relativePath) => existsSync(new URL(relativePath, relativePath.startsWith(".github/") ? new URL("../", root) : root));

/** The documents that carry a desktop claim, public first. */
const DOCS = [
  "README.md",
  "LIMITATIONS.md",
  "installer/UPDATES.md",
  "installer/WINDOWS-DEPLOYMENT.md",
  "docs/implementation/STARTER-RELEASE-BOARD.md",
  "docs/implementation/MORROW-REMAINING-WORK.md",
  "docs/implementation/MORROW-1.0-COMPLETION-GOAL.md",
];

const BUILD_CONFIG = "installer/electron-builder.config.cjs";
const MAC_SMOKE_RECEIPT = "output/desktop-mac-smoke-2026-09-06/receipt.json";

/** Top-level directories a document may name a file inside. */
const REPOSITORY_ROOTS = new Set([
  "artifacts", "config", "connector", "docs", "installer", "packages", "scripts", "work", ".github",
]);

/** A local receipt or build-output directory: real evidence, but untracked (gitignored), so it can be absent in a clean checkout. */
const LOCAL_EVIDENCE_ROOTS = new Set(["output", "artifacts"]);

const collapse = (value) => value.replace(/\s+/g, " ").trim();

/** A document as one line, so an assertion on a sentence survives its wrapping. */
const flat = (relativePath) => collapse(read(relativePath));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function writePayloadFile(payload, relative, content) {
  const target = join(payload, ...relative.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return { path: relative, bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

/**
 * Repository paths a document names inside backticks or a Markdown link, with
 * any trailing `:line` or `:line-line` reference removed. A path holding a
 * placeholder (`<version>`, `*`, `$`) is not a real path and is skipped.
 */
function namedPaths(text) {
  const found = new Map();
  const candidates = [
    ...[...text.matchAll(/`([^`\n]+)`/g)].map(([, value]) => value),
    ...[...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(([, value]) => value),
  ];
  for (const raw of candidates) {
    const target = raw.split("#")[0].replace(/:\d+(?:-\d+)?$/, "").replace(/^(?:\.\.\/)+/, "");
    if (!target.includes("/") || /[<>*$\s]/.test(target)) continue;
    const first = target.split("/")[0];
    if (!REPOSITORY_ROOTS.has(first) && !LOCAL_EVIDENCE_ROOTS.has(first)) continue;
    if (!found.has(target)) found.set(target, text.slice(0, text.indexOf(raw)).split("\n").length);
  }
  return found;
}

/** Heading sections, plus the text before the first heading. */
function headingSections(text) {
  const found = [];
  const headings = [...text.matchAll(/^#{1,6} .*$/gm)];
  const intro = text.slice(0, headings.length > 0 ? headings[0].index : text.length);
  if (collapse(intro)) found.push({ heading: "(document intro)", line: 1, text: intro });
  for (const [index, heading] of headings.entries()) {
    const next = headings[index + 1];
    found.push({
      heading: collapse(heading[0]),
      line: text.slice(0, heading.index).split("\n").length,
      text: text.slice(heading.index, next ? next.index : text.length),
    });
  }
  return found;
}

/**
 * Loads installer/electron-builder.config.cjs the way electron-builder does:
 * against a real prepared payload on disk, with no signed-release environment.
 * This is what the documents describe when they name an artifact or a platform.
 */
function loadBuildConfig(t) {
  const payload = mkdtempSync(join(tmpdir(), "morrow-desktop-doc-claims-"));
  t.after(() => rmSync(payload, { recursive: true, force: true }));
  const target = process.platform === "win32" ? "win32-x64" : "darwin-arm64";
  writePayloadFile(payload, target === "win32-x64" ? "runtime/node/node.exe" : "runtime/node/bin/node", "doc-claims node runtime fixture");
  const definitions = [
    ["connector/extension/manifest.json", ["app/connector/extension/manifest.json"], '{"name":"Morrow Bridge"}\n'],
    ["installer/runtime-monitor.mjs", ["app/installer/runtime-monitor.mjs"], "export const monitor = true;\n"],
    ["installer/process-lifetime.cjs", ["app/installer/process-lifetime.cjs"], "module.exports = {};\n"],
    ["packages/canvas-connector-mcp/dist/index.js", ["app/packages/canvas-connector-mcp/dist/index.js"], "export const connector = true;\n"],
    ["packages/client-config/dist/cli.js", ["app/packages/client-config/dist/cli.js"], "export const cli = true;\n"],
    ["packages/mcp-server/dist/index.js", ["app/node_modules/@morrow-lms/gateway/dist/index.js", "app/packages/mcp-server/dist/index.js"], "export const gateway = true;\n"],
    ["packages/mcp-server/package.json", ["app/node_modules/@morrow-lms/gateway/package.json", "app/packages/mcp-server/package.json"], '{"name":"@morrow-lms/gateway","version":"1.0.0"}\n'],
  ];
  const files = [];
  for (const [sourcePath, destinations, content] of definitions) {
    for (const destination of destinations) writePayloadFile(payload, destination, content);
    files.push({ path: sourcePath, bytes: Buffer.byteLength(content), sha256: sha256(content), destinations: [...destinations].sort() });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const appRecord = (relative) => {
    const content = readFileSync(join(payload, "app", ...relative.split("/")));
    return { path: relative, bytes: content.byteLength, sha256: sha256(content) };
  };
  const packageJson = appRecord("node_modules/@morrow-lms/gateway/package.json");
  const gatewayEntry = appRecord("node_modules/@morrow-lms/gateway/dist/index.js");
  const mcpRuntime = {
    schema: "morrow.mcp-runtime-manifest.v2",
    package: { name: "@morrow-lms/gateway", version: "1.0.0" },
    entrypoint: appRecord("packages/mcp-server/dist/index.js"),
    dependencies: [{
      name: "@morrow-lms/gateway",
      version: "1.0.0",
      packageJson,
      files: [gatewayEntry, packageJson].sort((left, right) => left.path.localeCompare(right.path)),
    }],
    directFiles: [
      "installer/runtime-monitor.mjs",
      "installer/process-lifetime.cjs",
      "packages/canvas-connector-mcp/dist/index.js",
      "packages/client-config/dist/cli.js",
      "packages/mcp-server/dist/index.js",
    ].map(appRecord).sort((left, right) => left.path.localeCompare(right.path)),
  };
  const mcp = writePayloadFile(payload, "app/mcp-runtime-manifest.json", `${JSON.stringify(mcpRuntime)}\n`);
  const bridgeFile = files.find((record) => record.path === "connector/extension/manifest.json");
  writePayloadFile(payload, "app/bridge-release/extension/manifest.json", '{"name":"Morrow Bridge"}\n');
  writePayloadFile(payload, "app/bridge-release/manifest.json", `${JSON.stringify({
    schema: "morrow.bridge-release.v1",
    version: "1.0.0",
    extensionId: "abeloclekioohahgedmjcdbpllfjfhko",
    manifestSha256: bridgeFile.sha256,
    permissions: [],
    hostPermissions: [],
    optionalHostPermissions: [],
    files: [{ path: "manifest.json", bytes: bridgeFile.bytes, sha256: bridgeFile.sha256 }],
  })}\n`);
  writePayloadFile(payload, "app/package-input-manifest.json", `${JSON.stringify({
    schema: "morrow.desktop-package-input.v2",
    source: { head: "a".repeat(40), dirty: false, statusSha256: "b".repeat(64) },
    dependencyMaterialization: {
      schema: "morrow.runtime-dependency-materialization.v1",
      packageManager: { declared: "pnpm@10.6.1", observed: "10.6.1" },
      lockfile: { path: "pnpm-lock.yaml", sha256: "c".repeat(64), integritySource: "pnpm-lock.yaml packages resolution.integrity" },
      install: { mode: "isolated_frozen_install", network: "offline", scripts: "disabled", flags: ["--prod", "--frozen-lockfile", "--offline", "--ignore-scripts", "--verify-store-integrity"] },
      dependencies: [{ name: "fixture", version: "1.0.0", integrity: "sha512-AAAA" }],
    },
    files,
    mcpRuntime: { path: "app/mcp-runtime-manifest.json", sha256: mcp.sha256 },
  })}\n`);

  const configPath = require.resolve(join(rootPath, BUILD_CONFIG));
  const previousPayload = process.env.MORROW_INSTALLER_PAYLOAD;
  const previousSigned = process.env.MORROW_SIGNED_RELEASE;
  const previousTargetPlatform = process.env.MORROW_TARGET_PLATFORM;
  process.env.MORROW_INSTALLER_PAYLOAD = payload;
  // The build config only packages darwin/win32. The target platform is a
  // test-harness declaration here, so this file also runs on Linux CI.
  process.env.MORROW_TARGET_PLATFORM = "darwin";
  delete process.env.MORROW_SIGNED_RELEASE;
  delete require.cache[configPath];
  try {
    return require(configPath);
  } finally {
    delete require.cache[configPath];
    if (previousPayload === undefined) delete process.env.MORROW_INSTALLER_PAYLOAD;
    else process.env.MORROW_INSTALLER_PAYLOAD = previousPayload;
    if (previousSigned === undefined) delete process.env.MORROW_SIGNED_RELEASE;
    else process.env.MORROW_SIGNED_RELEASE = previousSigned;
    if (previousTargetPlatform === undefined) delete process.env.MORROW_TARGET_PLATFORM;
    else process.env.MORROW_TARGET_PLATFORM = previousTargetPlatform;
  }
}

/** The artifact file names one platform block produces, from the config alone. */
function artifactNames(config, platform, block, version) {
  const names = [];
  for (const entry of block.target) {
    for (const arch of entry.arch) {
      names.push(config.artifactName
        .replace("${version}", version)
        .replace("${os}", platform)
        .replace("${arch}", arch)
        .replace("${ext}", entry.target === "nsis" ? "exe" : entry.target));
    }
  }
  return names;
}

test("every repository path the desktop documents name exists", () => {
  const missing = [];
  for (const doc of DOCS) {
    for (const [target, line] of namedPaths(read(doc))) {
      if (LOCAL_EVIDENCE_ROOTS.has(target.split("/")[0])) continue;
      if (!present(target)) missing.push(`${doc}:${line} -> ${target}`);
    }
  }
  assert.deepEqual(missing, [], "a desktop document names a file that is not in this repository");
});

test("the local receipts the desktop documents cite are present, or the run has not happened here", (t) => {
  const absent = [];
  for (const doc of DOCS) {
    for (const [target, line] of namedPaths(read(doc))) {
      if (!LOCAL_EVIDENCE_ROOTS.has(target.split("/")[0])) continue;
      if (!present(target)) absent.push(`${doc}:${line} -> ${target}`);
    }
  }
  // `output/` is untracked local evidence. A clean clone has none of it, so this
  // reports what is missing instead of failing a checkout that never ran a build.
  if (absent.length > 0) t.diagnostic(`local receipts not present in this checkout:\n  ${absent.join("\n  ")}`);
});

test("the README names the desktop artifacts the build configuration actually produces", (t) => {
  const config = loadBuildConfig(t);
  const version = JSON.parse(read("installer/package.json")).version;
  const readme = read("README.md");

  const mac = artifactNames(config, "mac", config.mac, version).map((name) => name.replace(version, "<version>"));
  const win = artifactNames(config, "win", config.win, version).map((name) => name.replace(version, "<version>"));
  assert.deepEqual(mac, ["Morrow-<version>-mac-arm64.dmg", "Morrow-<version>-mac-arm64.zip"]);
  assert.deepEqual(win, ["Morrow-<version>-win-x64.exe"]);
  for (const name of ["Morrow-<version>-mac-arm64.dmg", "Morrow-<version>-win-x64.exe"]) {
    assert.ok(readme.includes(name), `README.md must name the artifact the build produces: ${name}`);
  }

  const architectures = new Set([
    ...config.mac.target.flatMap((entry) => entry.arch),
    ...config.win.target.flatMap((entry) => entry.arch),
  ]);
  assert.deepEqual([...architectures].sort(), ["arm64", "x64"], "the config builds Apple silicon macOS and x64 Windows only");
  assert.match(readme, /There is no Intel macOS build and no Linux build\./,
    "the config declares no Intel macOS and no Linux target, so README.md must say so");

  // Without MORROW_SIGNED_RELEASE the mac identity is cleared and code signing is
  // not forced, so every artifact this checkout can build is unsigned.
  assert.equal(config.mac.identity, null);
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.extraMetadata.morrow.desktopUpdates.enabled, false);
  for (const doc of ["README.md", "LIMITATIONS.md"]) {
    assert.match(read(doc), /unsigned/i, `${doc} must state that the desktop build is unsigned`);
  }
  assert.match(readme, /Nothing is signed with an Apple Developer ID or notarized; the macOS app carries an ad-hoc signature/,
    "README.md must state that nothing carries an Apple identity and that the macOS app is ad-hoc signed");
  assert.equal(typeof config.afterPack, "function", "the unsigned macOS bundle must be ad-hoc sealed after packing");
});

test("the README leads with the desktop app and keeps the archive and source routes under engineering evidence", () => {
  const readme = read("README.md");
  const sections = headingSections(readme);
  const heading = (value) => sections.findIndex((section) => section.heading === value);

  const app = heading("## The Morrow desktop app");
  const evidence = heading("## Development and engineering evidence");
  assert.notEqual(app, -1, "README.md must carry a desktop app section");
  assert.notEqual(evidence, -1, "README.md must carry a development and engineering evidence section");
  assert.ok(app < evidence, "the desktop app must come before the engineering evidence");

  const archive = heading("### The macOS Apple silicon MCP archive");
  const source = heading("### Install from source for development");
  assert.ok(archive > evidence, "the MCP archive section must sit under engineering evidence");
  assert.ok(source > evidence, "the source setup section must sit under engineering evidence");
  assert.ok(sections.slice(evidence + 1, archive).every((section) => section.heading.startsWith("###")) || archive === evidence + 1,
    "nothing may separate the engineering evidence heading from its own subsections");

  assert.match(sections[evidence].text, /Neither is the consumer installation\./,
    "the engineering evidence section must state that it is not the consumer installation");
  assert.match(sections[archive].text, /historical engineering evidence/,
    "the MCP archive section must say the archive is historical engineering evidence");

  // The consumer route names both parts of the product, and no other section may
  // claim to be the installation.
  assert.match(sections[heading("## What a user installs")].text, /\*\*The Morrow desktop app\*\*/);
  assert.match(sections[heading("## What a user installs")].text, /\*\*Morrow Bridge\*\*/);
});

test("no desktop document publishes a download link for a desktop artifact", () => {
  const published = [];
  for (const doc of DOCS) {
    const text = read(doc);
    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].split("?")[0].split("#")[0];
      if (!/\.(dmg|exe|pkg|msi|zip)$/i.test(target)) continue;
      published.push(`${doc}:${text.slice(0, match.index).split("\n").length} -> ${match[1]}`);
    }
  }
  assert.deepEqual(published, [], "no signed desktop release exists, so no document may link to one");
});

test("the Bridge rollback-copy claim is what the Bridge module does", async (t) => {
  const { pruneBridgeRollbackCopies } = require(join(rootPath, "installer/shared/bridge-updates.cjs"));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "morrow-desktop-doc-rollback-")));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const backups = join(state, "bridge-backups");
  mkdirSync(join(backups, "bridge-2026-09-07"), { recursive: true });
  mkdirSync(join(backups, "bridge-2026-09-06"), { recursive: true });
  writeFileSync(join(backups, "bridge-2026-09-07", "manifest.json"), "{}\n", "utf8");

  const result = await pruneBridgeRollbackCopies({ stateDirectory: state });
  assert.deepEqual(result.referenced, [], "no installation record means no rollback copy is referenced");
  assert.deepEqual([...result.removed].sort(), [
    join(backups, "bridge-2026-09-06"),
    join(backups, "bridge-2026-09-07"),
  ], "an unreferenced rollback copy is removed at startup");
  assert.deepEqual(result.retained, []);
  assert.equal(existsSync(join(backups, "bridge-2026-09-07")), false);

  const updates = flat("installer/UPDATES.md");
  assert.match(updates, /the next start removes every rollback copy the current installation record does not reference/);
  assert.match(updates, /prove with a fresh `lstat` that the copy is gone/);
  // The removal is proved by a fresh lstat and reported when it cannot be. No
  // document may describe it as a plain delete.
  const unproven = DOCS.filter((doc) => /deletes the rollback copy/.test(flat(doc)));
  assert.deepEqual(unproven, [], "the app removes the rollback copy and proves the removal; it does not simply delete it");
  assert.match(updates, /reported as `rollback_copy_retained` instead of being reported as done/,
    "installer/UPDATES.md must keep the unproven-removal state");
});

test("the app rollback status in the update guide matches the code", () => {
  const updates = flat("installer/UPDATES.md");
  assert.match(updates, /Reacquiring the previous signed desktop artifact is \*\*not implemented\*\*\./);
  const controller = read("installer/shared/updates.cjs");
  assert.doesNotMatch(controller, /reinstallPrevious|downgradeTo|rollbackApplication/,
    "installer/UPDATES.md says no app rollback exists; the controller must not have grown one");
  assert.match(updates, /`update_rolled_back`/, "the guide must keep the state a failed new-version start reports");
  assert.match(controller, /update_rolled_back/, "installer/shared/updates.cjs must report that state");
});

test("the gateway MCP health readback the update guide describes is the one the runtime performs", () => {
  const runtime = read("packages/mcp-server/src/runtime.ts");
  assert.match(runtime, /export function mcpRuntimeHealthFromPayload\(/,
    "the gateway must derive its runtime identity from the payload it started from");
  assert.match(runtime, /mcp-runtime-manifest\.json/);
  const monitor = read("installer/shared/runtime-monitor.mjs");
  assert.doesNotMatch(monitor, /MORROW_MCP_RUNTIME_(?:PACKAGE_VERSION|MANIFEST_SHA256)/,
    "the app must not hand the gateway the values it then reads back");
  assert.match(flat("installer/UPDATES.md"), /The app sends neither value to the gateway\./);
});

test("the data-removal action the Windows guide describes is the one the policy produces", () => {
  const { retentionSnapshot } = require(join(rootPath, "installer/shared/state-policy.cjs"));
  const userData = join(rootPath, "fixture", "UserData");
  const credentials = join(rootPath, "fixture", "home", ".morrow", "credentials", "blackboard");
  const snapshot = retentionSnapshot({
    platform: "win32",
    userData,
    state: join(userData, "State"),
    backups: join(userData, "State", "Backups"),
    bridge: join(userData, "Bridge"),
    materials: join(userData, "Materials"),
    blackboardCredentials: credentials,
    blackboardConfiguration: join(rootPath, "fixture", "home", ".morrow", "blackboard-learn.json"),
    assistantConfigurations: [{ title: "ChatGPT", path: join(rootPath, "fixture", "home", ".codex", "config.toml") }],
  });

  assert.equal(snapshot.appRemoval, "removes_application_only");
  assert.equal(snapshot.explicitRemovalRequired, true);
  assert.equal(snapshot.uninstall, "windows_settings_apps");
  const removable = snapshot.locations.filter((location) => location.removable).map((location) => location.id);
  assert.deepEqual(removable, [
    "state",
    "backups",
    "bridge",
    "materials",
    "blackboard_credentials",
    "blackboard_configuration",
  ]);
  const assistant = snapshot.locations.find((location) => location.id === "assistant_configuration");
  assert.equal(assistant.removable, false);
  assert.equal(assistant.keptReason, "assistant_configuration");

  const guide = flat("installer/WINDOWS-DEPLOYMENT.md");
  // A document may describe a data-removal action only while the policy actually
  // marks something removable. If that ever stops being true, the claim goes too.
  if (removable.length > 0) {
    assert.match(guide, /The action is \*\*Remove Morrow's data\*\*/,
      "the action exists in the product, so the guide must name it");
  } else {
    const claiming = DOCS.filter((doc) => /data-removal action/i.test(flat(doc)));
    assert.deepEqual(claiming, [], "the retention policy marks nothing removable, so no document may name a data-removal action");
  }
  assert.match(guide, /It never removes an assistant's own configuration file\./);
  assert.match(guide, /Settings, Apps, Morrow, Uninstall/,
    "the guide must state the removal step this platform uses, which the policy names as windows_settings_apps");
});

test("every section that states a Windows desktop result keeps its unverified qualifier", () => {
  // Sections that reach for the Windows evidence machinery by name. Each has to
  // carry the constraint that keeps its result honest.
  const subject = /desktop-windows-smoke\.mjs|windows-2022/i;
  const qualifier = /live-unverified|no receipt|manual dispatch|workflow_dispatch|refuses to run|native Windows only|only on native Windows|has not been dispatched|No signed Windows artifact/i;
  const unqualified = [];
  for (const doc of DOCS) {
    for (const section of headingSections(read(doc))) {
      if (!subject.test(section.text) || qualifier.test(section.text)) continue;
      unqualified.push(`${doc}:${section.line} ${section.heading}`);
    }
  }
  assert.deepEqual(unqualified, [], "a section that states a Windows desktop result must say it is not proved here");
});

test("the macOS smoke receipt the documents cite says what they say it says", (t) => {
  if (!present(MAC_SMOKE_RECEIPT)) {
    t.diagnostic(`${MAC_SMOKE_RECEIPT} is not in this checkout; the macOS run has not happened here`);
    return;
  }
  const receipt = JSON.parse(read(MAC_SMOKE_RECEIPT));
  assert.equal(receipt.runtime.ready, true);
  assert.equal(receipt.payload.withinResources, true);
  assert.equal(receipt.state.withinTestRoot, true);
  assert.equal(receipt.codexConfig.withinTestRoot, true);
  assert.equal(receipt.health.gatewayReady, true);
  // The documents say this run did not prove the Chrome bridge listener. The
  // receipt is why: the port was already held, so the listener stayed unbound.
  assert.equal(receipt.runtimeTrace.portBinding, "unbound");
  assert.equal(receipt.health.bridgeConnected, false);
  assert.match(flat("LIMITATIONS.md"), /passing contained receipt under `scripts\/test\/desktop-mac-smoke\.mjs`/);
});
