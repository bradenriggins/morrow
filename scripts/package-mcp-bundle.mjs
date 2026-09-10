#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = resolve(ROOT, "installer");
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const VERSION = String(PACKAGE.version);
const NODE_VERSION = "22.23.2";
const BRIDGE_EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";
const BRIDGE_SOURCE_FILES = Object.freeze([
  "brand/Manrope-OFL.txt", "brand/Manrope-variable.ttf", "brand/morrow-knot-128.png", "brand/morrow-knot.svg",
  "brand/review.css", "brand/theme.css",
  "generated/canvas-api-catalog.json", "generated/canvas-browser-catalog.json", "generated/canvas-operation-admission.js", "generated/canvas-readback-plan.js", "generated/canvas-semantic-target.js", "generated/moodle-browser-catalog.json",
  "manifest.json", "onboarding/onboarding-install.js", "onboarding/onboarding-state.js", "onboarding/onboarding.css", "onboarding/onboarding.html", "onboarding/onboarding.js",
  "popup/popup-view.js", "popup/popup.css", "popup/popup.html", "popup/popup.js",
  "render-check/render-check-host.html", "render-check/render-check-host.js", "render-check/render-check.html", "render-check/render-check.js",
  "settings/settings.css", "settings/settings.html", "settings/settings.js",
  "src/bridge-maintenance.js", "src/bridge-problem-copy.js", "src/bridge-transport.js", "src/canvas-classic-quiz-submission-read.js", "src/canvas-content.js", "src/canvas-conversations.js", "src/canvas-course-summary-read.js", "src/canvas-file-content.js",
  "src/canvas-file-signals.js", "src/canvas-file-transfer.js", "src/canvas-new-quiz-hot-spot.js", "src/canvas-operation-readback.js", "src/canvas-write-outcome.js", "src/course-connection-intent.js", "src/course-data-consent.js", "src/edit-policy.js", "src/item-bank-credential.js", "src/item-bank-executor.js", "src/item-bank-fan-out.js", "src/item-bank-frames.js", "src/item-bank-guard.js",
  "src/moodle-activity-content-executor.js", "src/moodle-activity-content-read.js", "src/moodle-activity-lifecycle-executor.js", "src/moodle-assignment-submission-read.js", "src/moodle-backup-executor.js", "src/moodle-bbb-executor.js", "src/moodle-calendar-executor.js", "src/moodle-completion-executor.js", "src/moodle-course-settings-executor.js", "src/moodle-enrolment-executor.js", "src/moodle-executor.js", "src/moodle-forum-activity-summary-read.js", "src/moodle-forum-post-executor.js", "src/moodle-forum-read.js", "src/moodle-glossary-wiki-executor.js", "src/moodle-grade-report-read.js", "src/moodle-gradebook-executor.js", "src/moodle-groups-executor.js", "src/moodle-groups-read.js", "src/moodle-h5p-executor.js", "src/moodle-learner-submission-read.js", "src/moodle-lesson-executor.js", "src/moodle-lesson-read.js", "src/moodle-lti-executor.js", "src/moodle-participants-read.js", "src/moodle-privacy.js", "src/moodle-qbank-executor.js", "src/moodle-qbank-question-executor.js", "src/moodle-question-impact-read.js", "src/moodle-quiz-attempt-detail-read.js", "src/moodle-quiz-attempt-summary-read.js", "src/moodle-quiz-structure-executor.js", "src/moodle-reports-read.js", "src/moodle-restrictions-executor.js", "src/moodle-scorm-executor.js",
  "src/moodle-scorm-report-read.js", "src/moodle-section-executor.js", "src/moodle-site-inventory-read.js", "src/moodle-subsection-executor.js", "src/moodle-workshop-executor.js", "src/new-quiz-item-guard.js", "src/new-quiz-write-contract.js", "src/protected-request.js", "src/quiz-bank-draw-executor.js", "src/quiz-item-payload.js", "src/service-worker.js", "src/verification.js"
]);
const WORKSPACE_PACKAGE_DIRECTORIES = Object.freeze([
  "batch-engine", "blackboard-learn-api", "bridge-loopback", "bridge-protocol", "canvas-api-catalog", "canvas-connector-mcp", "client-config",
  "contracts", "gateway-core", "legacy-bridge-mcp", "mcp-server", "operation-journal", "upstream-mcp"
]);
const RUNTIME_DEPENDENCY_NAMES = Object.freeze([
  "@iarna/toml", "@modelcontextprotocol/client", "@modelcontextprotocol/core", "@modelcontextprotocol/server", "cross-spawn", "dayjs", "deepmerge",
  "dom-serializer", "domelementtype", "domhandler", "domutils", "entities", "escape-string-regexp", "eventsource", "eventsource-parser",
  "htmlparser2", "is-plain-object", "isexe", "jose", "launder", "nanoid", "parse-srcset", "path-key", "picocolors", "pkce-challenge",
  "postcss", "sanitize-html", "shebang-command", "shebang-regex", "source-map-js", "which", "ws", "zod"
]);
const SECRET_MARKERS = Object.freeze([
  ["private_key", /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]{32,}-----END(?: [A-Z]+)? PRIVATE KEY-----/],
  ["openai_secret", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["stripe_secret", /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_=-]{20,}\b/],
  ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/]
]);
const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    platform: "darwin", arch: "arm64", extension: "tar.xz",
    archive: `node-v${NODE_VERSION}-darwin-arm64.tar.xz`,
    sha256: "5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1",
    electron: ["package:mac"], label: "macOS on Apple silicon"
  }),
  "win32-x64": Object.freeze({
    platform: "win32", arch: "x64", extension: "zip",
    archive: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
    electron: ["package:win"], label: "Windows on x64"
  })
});

function die(message, exitCode = 1) {
  process.stderr.write(`[morrow desktop package] ${message}\n`);
  process.exit(exitCode);
}

function parse(args) {
  if (args.length === 1 && args[0] === "--targets") return { kind: "targets" };
  let target = `${process.platform}-${process.arch}`;
  let output;
  let payload;
  let replace = false;
  let unsignedQa = false;
  let unsignedRelease = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--target") {
      const value = args[++index];
      if (!value || !Object.hasOwn(TARGETS, value)) throw new Error("--target must be darwin-arm64 or win32-x64");
      target = value;
    } else if (flag === "--output") {
      const value = args[++index];
      if (!value || output || !isAbsolute(value)) throw new Error("--output requires one absolute directory path");
      output = resolve(value);
    } else if (flag === "--prepare-desktop-payload") {
      const value = args[++index];
      if (!value || payload || !isAbsolute(value)) throw new Error("--prepare-desktop-payload requires one absolute directory path");
      payload = resolve(value);
    } else if (flag === "--replace") {
      if (replace) throw new Error("--replace can be used once");
      replace = true;
    } else if (flag === "--unsigned-qa") {
      unsignedQa = true;
    } else if (flag === "--unsigned-release") {
      unsignedRelease = true;
    } else throw new Error(`Unknown package option: ${flag}`);
  }
  if (!Object.hasOwn(TARGETS, target)) throw new Error(`No desktop target is configured for ${target}`);
  if (payload && output) throw new Error("Choose --prepare-desktop-payload or --output, not both");
  if (unsignedQa && unsignedRelease) throw new Error("Choose one unsigned distribution mode");
  if (!payload && !output) throw new Error("Provide --prepare-desktop-payload or --output");
  return { kind: payload ? "prepare" : "package", target, payload, output, replace, unsignedQa, unsignedRelease };
}

function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function digestBytes(value) { return createHash("sha256").update(value).digest("hex"); }
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function exactList(actual, expected, description) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error(`${description} does not match the audited allowlist.`);
  }
}

function assertNoSecret(path, data) {
  if (data.includes(0)) return;
  const text = data.toString("utf8");
  for (const [name, pattern] of SECRET_MARKERS) {
    if (pattern.test(text)) throw new Error(`Package input contains prohibited ${name}: ${path}`);
  }
}

function extensionId(publicKey) {
  const digestValue = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  return [...digestValue].flatMap((byte) => [byte >> 4, byte & 15]).map((value) => String.fromCharCode(97 + value)).join("");
}

function regularFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const file = resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Bridge release cannot include a symbolic link: ${file}`);
      if (entry.isDirectory()) return regularFiles(root, file);
      if (entry.isFile()) return [file];
      throw new Error(`Bridge release cannot include a non-regular file: ${file}`);
    });
}

function assertObjectKeys(value, keys, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${description} is invalid.`);
  exactList(Object.keys(value).sort(), [...keys].sort(), `${description} keys`);
}

export function captureBridgeRelease(extensionRoot = resolve(ROOT, "connector", "extension")) {
  const sourcePaths = regularFiles(extensionRoot).map((file) => relative(extensionRoot, file).replaceAll("\\", "/")).sort();
  exactList(sourcePaths, BRIDGE_SOURCE_FILES, "Morrow Bridge release file set");
  const source = BRIDGE_SOURCE_FILES.map((path) => {
    const file = resolve(extensionRoot, path);
    if (lstatSync(file).isSymbolicLink()) throw new Error(`Morrow Bridge release cannot include a symbolic link: ${path}`);
    const data = readFileSync(file);
    assertNoSecret(path, data);
    return { path, data };
  });
  const extensionManifest = JSON.parse(source.find((file) => file.path === "manifest.json").data.toString("utf8"));
  assertObjectKeys(extensionManifest, [
    "action", "background", "content_security_policy", "description", "host_permissions", "icons", "key", "manifest_version", "minimum_chrome_version",
    "name", "optional_host_permissions", "options_ui", "permissions", "sandbox", "version"
  ], "Morrow Bridge manifest");
  if (extensionId(extensionManifest.key) !== BRIDGE_EXTENSION_ID) throw new Error("Morrow Bridge extension identity is not the fixed release identity.");
  if (extensionManifest.manifest_version !== 3 || extensionManifest.name !== "Morrow Bridge" || extensionManifest.minimum_chrome_version !== "116"
    || typeof extensionManifest.version !== "string" || !/^\d+\.\d+\.\d+(?:\.[0-9A-Za-z-]+)?$/.test(extensionManifest.version)) {
    throw new Error("Morrow Bridge extension version is invalid.");
  }
  exactList(extensionManifest.permissions, ["activeTab", "alarms", "offscreen", "scripting", "storage", "tabs", "webNavigation", "webRequest"], "Morrow Bridge permissions");
  exactList(extensionManifest.host_permissions, ["http://127.0.0.1/*"], "Morrow Bridge host permissions");
  exactList(extensionManifest.optional_host_permissions, ["https://*/*"], "Morrow Bridge optional host permissions");
  // The one sandboxed page, with a policy that forbids every network load it could make.
  exactList(extensionManifest.sandbox.pages, ["render-check/render-check.html"], "Morrow Bridge sandbox pages");
  assertObjectKeys(extensionManifest.content_security_policy, ["sandbox"], "Morrow Bridge content security policy");
  if (extensionManifest.content_security_policy.sandbox !== "sandbox allow-scripts; default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'") {
    throw new Error("Morrow Bridge sandbox content security policy is invalid.");
  }
  assertObjectKeys(extensionManifest.background, ["service_worker", "type"], "Morrow Bridge background");
  assertObjectKeys(extensionManifest.action, ["default_icon", "default_popup", "default_title"], "Morrow Bridge action");
  assertObjectKeys(extensionManifest.options_ui, ["open_in_tab", "page"], "Morrow Bridge options");
  if (extensionManifest.background.service_worker !== "src/service-worker.js" || extensionManifest.background.type !== "module"
    || extensionManifest.action.default_icon !== "brand/morrow-knot-128.png" || extensionManifest.action.default_popup !== "popup/popup.html"
    || extensionManifest.action.default_title !== "Morrow Bridge" || extensionManifest.options_ui.page !== "settings/settings.html"
    || extensionManifest.options_ui.open_in_tab !== true) throw new Error("Morrow Bridge manifest scope is invalid.");
  return {
    extensionManifest,
    files: source
  };
}

function bridgeReleaseManifest(extensionRoot) {
  const bridge = captureBridgeRelease(extensionRoot);
  return {
    schema: "morrow.bridge-release.v1",
    version: bridge.extensionManifest.version,
    extensionId: BRIDGE_EXTENSION_ID,
    manifestSha256: digestBytes(bridge.files.find((file) => file.path === "manifest.json").data),
    permissions: [...bridge.extensionManifest.permissions],
    hostPermissions: [...bridge.extensionManifest.host_permissions],
    optionalHostPermissions: [...bridge.extensionManifest.optional_host_permissions],
    files: bridge.files.map((file) => ({ path: file.path, bytes: file.data.byteLength, sha256: digestBytes(file.data) }))
  };
}

function copyBridgeRelease(appRoot, extensionRoot) {
  const releaseRoot = resolve(appRoot, "bridge-release");
  const manifest = bridgeReleaseManifest(extensionRoot);
  copy(extensionRoot, resolve(releaseRoot, "extension"));
  writeFileSync(resolve(releaseRoot, "manifest.json"), json(manifest), { mode: 0o600, flag: "wx" });
  return { manifestSha256: digest(resolve(releaseRoot, "manifest.json")), version: manifest.version, extensionId: manifest.extensionId };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed with exit status ${result.status ?? 1}`);
}

function ensureEmptyDestination(destination, replace) {
  if (!isAbsolute(destination)) throw new Error("destination must be absolute");
  if (existsSync(destination)) {
    if (!replace) throw new Error(`Destination already exists: ${destination}. Review it and pass --replace to replace it.`);
    rmSync(destination, { recursive: true, force: true });
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
}

function packageManifest(directory) { return JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")); }

function workspacePackages() {
  const directory = resolve(ROOT, "packages");
  const directories = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(directory, entry.name, "package.json")))
    .map((entry) => entry.name)
    .sort();
  exactList(directories, [...WORKSPACE_PACKAGE_DIRECTORIES].sort(), "Workspace package release scope");
  return WORKSPACE_PACKAGE_DIRECTORIES.map((directoryName) => {
    const source = resolve(directory, directoryName);
    const manifest = packageManifest(source);
    return { directory: directoryName, source, name: String(manifest.name), manifest };
  });
}

function packageDirectory(name, fromDirectory = ROOT) {
  const requireFrom = createRequire(resolve(fromDirectory, "package.json"));
  const resolved = requireFrom.resolve(name);
  let current = dirname(resolved);
  for (;;) {
    const manifest = resolve(current, "package.json");
    if (existsSync(manifest) && packageManifest(current).name === name) return realpathSync(current);
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not find runtime dependency ${name}`);
    current = parent;
  }
}

function runtimeDependencies(packagesByName) {
  const queue = [];
  const enqueue = (manifest, from) => {
    for (const [name] of Object.entries(manifest.dependencies || {})) if (!packagesByName.has(name)) queue.push({ name, from, optional: false });
    for (const [name] of Object.entries(manifest.optionalDependencies || {})) if (!packagesByName.has(name)) queue.push({ name, from, optional: true });
    for (const [name] of Object.entries(manifest.peerDependencies || {})) {
      if (!packagesByName.has(name)) queue.push({ name, from, optional: manifest.peerDependenciesMeta?.[name]?.optional === true });
    }
  };
  for (const item of packagesByName.values()) enqueue(item.manifest, item.source);
  const requested = new Set();
  const traversed = new Set();
  const resolved = new Map();
  while (queue.length) {
    const current = queue.shift();
    const key = `${current.name}\0${current.from}`;
    if (requested.has(key)) continue;
    requested.add(key);
    let source;
    try { source = packageDirectory(current.name, current.from); } catch (error) { if (current.optional) continue; throw error; }
    const manifest = packageManifest(source);
    const present = resolved.get(current.name);
    if (present && present !== source) throw new Error(`Runtime dependency ${current.name} resolves to multiple locations.`);
    resolved.set(current.name, source);
    if (!traversed.has(source)) { traversed.add(source); enqueue(manifest, source); }
  }
  exactList([...resolved.keys()].sort(), [...RUNTIME_DEPENDENCY_NAMES].sort(), "Runtime dependency release scope");
  return resolved;
}

function copy(source, destination, filter) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  cpSync(source, destination, { recursive: true, dereference: true, preserveTimestamps: true, filter });
}

function recordTree(root, prefix, destinations, records) {
  for (const file of regularFiles(root)) {
    const path = relative(root, file).replaceAll("\\", "/");
    const data = readFileSync(file);
    assertNoSecret(`${prefix}/${path}`, data);
    records.push({
      path: `${prefix}/${path}`,
      bytes: data.byteLength,
      sha256: digestBytes(data),
      destinations: destinations(path).sort()
    });
  }
}

function sealStage(stage) {
  const files = regularFiles(stage);
  for (const file of files) chmodSync(file, 0o400);
  const directories = [];
  const visit = (directory) => {
    directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) visit(resolve(directory, entry.name));
  };
  visit(stage);
  for (const directory of directories.sort((left, right) => right.length - left.length)) chmodSync(directory, 0o500);
}

function removeStage(stage) {
  if (!existsSync(stage)) return;
  const files = regularFiles(stage);
  for (const file of files) chmodSync(file, 0o600);
  const directories = [];
  const visit = (directory) => {
    directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) visit(resolve(directory, entry.name));
  };
  visit(stage);
  for (const directory of directories) chmodSync(directory, 0o700);
  rmSync(stage, { recursive: true, force: true });
}

function mcpRuntimeManifest(stage, records, packages, dependencies) {
  const mcp = packages.find((entry) => entry.name === "@morrow-lms/gateway");
  if (!mcp) throw new Error("MCP package is absent from the sealed source stage.");
  const entry = records.find((record) => record.path === "packages/mcp-server/dist/index.js");
  if (!entry) throw new Error("MCP entrypoint is absent from the sealed source stage.");
  const packageNode = (name, directory, manifest) => {
    const packageRecord = records.find((record) => record.path === `${directory}/package.json` && record.destinations.includes(`app/node_modules/${name}/package.json`));
    if (!packageRecord) throw new Error(`Sealed runtime dependency is missing package.json: ${name}`);
    return {
      name,
      version: String(manifest.version),
      packageJson: { path: `node_modules/${name}/package.json`, bytes: packageRecord.bytes, sha256: packageRecord.sha256 },
      files: records.filter((record) => record.destinations.some((destination) => destination.startsWith(`app/node_modules/${name}/`)))
      .map((record) => ({
        path: record.destinations.find((destination) => destination.startsWith(`app/node_modules/${name}/`)).slice(4),
        bytes: record.bytes,
        sha256: record.sha256
      })).sort((left, right) => left.path.localeCompare(right.path))
    };
  };
  const nodes = [
    ...packages.map((item) => packageNode(item.name, `packages/${item.directory}`, packageManifest(resolve(stage, "packages", item.directory)))),
    ...[...dependencies.entries()].map(([name, source]) => packageNode(name, `node_modules/${name}`, packageManifest(source)))
  ].sort((left, right) => left.name.localeCompare(right.name));
  const manifest = {
    schema: "morrow.mcp-runtime-manifest.v1",
    package: { name: mcp.name, version: String(packageManifest(resolve(stage, "packages", mcp.directory)).version) },
    entrypoint: { path: "packages/mcp-server/dist/index.js", bytes: entry.bytes, sha256: entry.sha256 },
    dependencies: nodes
  };
  return { manifest, bytes: Buffer.from(json(manifest)) };
}

function stagePayloadInput(staging, packages, dependencies, checkpoint) {
  const stage = `${staging}.source-${process.pid}-${randomUUID()}`;
  mkdirSync(stage, { recursive: false, mode: 0o700 });
  try {
    const records = [];
    const stagedPackages = packages.map((entry) => {
      const destination = resolve(stage, "packages", entry.directory);
      if (lstatSync(resolve(entry.source, "package.json")).isSymbolicLink()) throw new Error(`Workspace package manifest cannot be a symbolic link: ${entry.name}`);
      regularFiles(resolve(entry.source, "dist"));
      copy(resolve(entry.source, "package.json"), resolve(destination, "package.json"));
      copy(resolve(entry.source, "dist"), resolve(destination, "dist"));
      recordTree(destination, `packages/${entry.directory}`, (path) => [
        `app/packages/${entry.directory}/${path}`,
        `app/node_modules/${entry.name}/${path}`
      ], records);
      return { ...entry, source: destination, manifest: packageManifest(destination) };
    });
    const stagedDependencies = new Map();
    for (const [name, source] of dependencies) {
      regularFiles(source);
      const destination = resolve(stage, "node_modules", ...name.split("/"));
      // Package-manager command shims contain build-host paths; runtime imports do not use them.
      copy(source, destination, (file) => !/(?:^|\/)node_modules\/\.bin(?:\/|$)/.test(relative(source, file).replaceAll("\\", "/")));
      recordTree(destination, `node_modules/${name}`, (path) => [`app/node_modules/${name}/${path}`], records);
      stagedDependencies.set(name, destination);
    }
    const catalog = resolve(ROOT, "artifacts/canvas-api/canvas-api-catalog.json");
    copy(catalog, resolve(stage, "artifacts/canvas-api/canvas-api-catalog.json"));
    recordTree(resolve(stage, "artifacts"), "artifacts", (path) => [`app/artifacts/${path}`], records);
    const bridge = captureBridgeRelease();
    for (const file of bridge.files) {
      const destination = resolve(stage, "connector/extension", file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, file.data, { mode: 0o600, flag: "wx" });
    }
    recordTree(resolve(stage, "connector/extension"), "connector/extension", (path) => [`app/connector/extension/${path}`], records);
    copy(resolve(INSTALLER, "shared/runtime-monitor.mjs"), resolve(stage, "installer/runtime-monitor.mjs"));
    recordTree(resolve(stage, "installer"), "installer", (path) => [`app/installer/${path}`], records);
    records.sort((left, right) => left.path.localeCompare(right.path));
    const mcpRuntime = mcpRuntimeManifest(stage, records, stagedPackages, stagedDependencies);
    const manifest = {
      schema: "morrow.desktop-package-input.v1",
      source: checkpoint,
      files: records,
      mcpRuntime: { path: "app/mcp-runtime-manifest.json", sha256: digestBytes(mcpRuntime.bytes) }
    };
    const manifestBytes = Buffer.from(json(manifest));
    writeFileSync(resolve(stage, "input-manifest.json"), manifestBytes, { mode: 0o600, flag: "wx" });
    sealStage(stage);
    return { stage, packages: stagedPackages, dependencies: stagedDependencies, manifest, manifestBytes, mcpRuntime };
  } catch (error) {
    removeStage(stage);
    throw error;
  }
}

function copyWorkspacePackage(entry, appRoot) {
  const dist = resolve(entry.source, "dist");
  if (!existsSync(dist)) throw new Error(`Compiled output is missing for ${entry.name}. Run pnpm build first.`);
  copy(resolve(entry.source, "package.json"), resolve(appRoot, "packages", entry.directory, "package.json"));
  copy(dist, resolve(appRoot, "packages", entry.directory, "dist"));
  copy(resolve(appRoot, "packages", entry.directory), resolve(appRoot, "node_modules", ...entry.name.split("/")));
}

async function nodeArchive(target, cache) {
  const descriptor = TARGETS[target];
  const path = resolve(cache, descriptor.archive);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const response = await fetch(`https://nodejs.org/download/release/v${NODE_VERSION}/${descriptor.archive}`);
    if (!response.ok || !response.body) throw new Error(`Official Node download failed: HTTP ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  }
  if (digest(path) !== descriptor.sha256) throw new Error(`Official Node checksum mismatch: ${descriptor.archive}`);
  return path;
}

function expectedNodePath(payload) {
  return process.platform === "win32" ? resolve(payload, "runtime/node/node.exe") : resolve(payload, "runtime/node/bin/node");
}

function expectedNodePathForTarget(payload, target) {
  return target === "win32-x64" ? resolve(payload, "runtime/node/node.exe") : resolve(payload, "runtime/node/bin/node");
}

function assertPayloadSnapshot(payload, input) {
  const inputBytes = readFileSync(resolve(payload, "app/package-input-manifest.json"));
  if (!inputBytes.equals(input.manifestBytes)) throw new Error("Prepared desktop payload input manifest differs from the sealed source snapshot.");
  const mcpBytes = readFileSync(resolve(payload, "app/mcp-runtime-manifest.json"));
  if (!mcpBytes.equals(input.mcpRuntime.bytes) || digestBytes(mcpBytes) !== input.manifest.mcpRuntime.sha256) {
    throw new Error("Prepared desktop payload MCP runtime manifest differs from the sealed source snapshot.");
  }
  const mcp = JSON.parse(mcpBytes.toString("utf8"));
  if (mcp.schema !== "morrow.mcp-runtime-manifest.v1" || mcp.package?.name !== "@morrow-lms/gateway"
    || mcp.entrypoint?.path !== "packages/mcp-server/dist/index.js") throw new Error("Prepared desktop payload MCP runtime manifest is invalid.");
  const mcpPackage = JSON.parse(readFileSync(resolve(payload, "app/packages/mcp-server/package.json"), "utf8"));
  if (mcpPackage.name !== mcp.package.name || String(mcpPackage.version) !== mcp.package.version) {
    throw new Error("Prepared desktop payload MCP package version does not match its sealed manifest.");
  }
  const entrypoint = resolve(payload, "app", mcp.entrypoint.path);
  if (!Number.isSafeInteger(mcp.entrypoint.bytes) || statSync(entrypoint).size !== mcp.entrypoint.bytes || digest(entrypoint) !== mcp.entrypoint.sha256) {
    throw new Error("Prepared desktop payload MCP entrypoint does not match its sealed manifest.");
  }
  if (!Array.isArray(mcp.dependencies) || mcp.dependencies.length === 0) throw new Error("Prepared desktop payload MCP dependency manifest is empty.");
  for (const dependency of mcp.dependencies) {
    if (!dependency || typeof dependency.name !== "string" || typeof dependency.version !== "string"
      || !dependency.packageJson || !Array.isArray(dependency.files)) throw new Error("Prepared desktop payload MCP dependency manifest is invalid.");
    const packageJson = dependency.packageJson;
    if (packageJson.path !== `node_modules/${dependency.name}/package.json` || !Number.isSafeInteger(packageJson.bytes)
      || !/^[0-9a-f]{64}$/.test(packageJson.sha256)) throw new Error("Prepared desktop payload MCP dependency package binding is invalid.");
    const packageJsonPath = resolve(payload, "app", packageJson.path);
    if (!existsSync(packageJsonPath) || statSync(packageJsonPath).size !== packageJson.bytes || digest(packageJsonPath) !== packageJson.sha256) {
      throw new Error(`Prepared desktop payload MCP dependency package changed: ${dependency.name}`);
    }
    for (const file of dependency.files) {
      if (!file || typeof file.path !== "string" || !file.path.startsWith(`node_modules/${dependency.name}/`)
        || !Number.isSafeInteger(file.bytes) || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new Error(`Prepared desktop payload MCP dependency file binding is invalid: ${dependency.name}`);
      }
      const filePath = resolve(payload, "app", file.path);
      if (!existsSync(filePath) || statSync(filePath).size !== file.bytes || digest(filePath) !== file.sha256) {
        throw new Error(`Prepared desktop payload MCP dependency file changed: ${file.path}`);
      }
    }
  }
  for (const record of input.manifest.files) {
    for (const destination of record.destinations) {
      const file = resolve(payload, destination);
      const relation = relative(payload, file);
      if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) throw new Error("Sealed source manifest escapes the payload.");
      if (!existsSync(file) || !statSync(file).isFile() || digest(file) !== record.sha256) {
        throw new Error(`Prepared desktop payload differs from the sealed source snapshot: ${destination}`);
      }
    }
  }
  const bridge = JSON.parse(readFileSync(resolve(payload, "app/bridge-release/manifest.json"), "utf8"));
  const expectedBridge = input.manifest.files.filter((record) => record.path.startsWith("connector/extension/"))
    .map((record) => ({ path: record.path.slice("connector/extension/".length), bytes: record.bytes, sha256: record.sha256 }));
  if (JSON.stringify(bridge.files) !== JSON.stringify(expectedBridge)) throw new Error("Bridge release manifest does not match the sealed source snapshot.");
  const bridgeFiles = regularFiles(resolve(payload, "app/bridge-release/extension"))
    .map((file) => relative(resolve(payload, "app/bridge-release/extension"), file).replaceAll("\\", "/")).sort();
  exactList(bridgeFiles, BRIDGE_SOURCE_FILES, "Prepared Bridge release file set");
}

function assertPayload(payload, target, input, { executable = false } = {}) {
  const node = expectedNodePathForTarget(payload, target);
  const required = [
    node,
    resolve(payload, "app/packages/client-config/dist/cli.js"),
    resolve(payload, "app/packages/mcp-server/dist/index.js"),
    resolve(payload, "app/packages/mcp-server/dist/local-owner-maintenance.js"),
    resolve(payload, "app/packages/mcp-server/dist/local-owner-sidecar-access.js"),
    resolve(payload, "app/packages/canvas-connector-mcp/dist/index.js"),
    resolve(payload, "app/installer/runtime-monitor.mjs"),
    resolve(payload, "app/connector/extension/manifest.json"),
    resolve(payload, "app/bridge-release/manifest.json"),
    resolve(payload, "app/bridge-release/extension/manifest.json"),
    resolve(payload, "app/artifacts/canvas-api/canvas-api-catalog.json"),
    resolve(payload, "app/package-input-manifest.json"),
    resolve(payload, "app/mcp-runtime-manifest.json")
  ];
  for (const file of required) if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Prepared desktop payload is incomplete: ${file}`);
  const scopedModules = resolve(payload, "app/node_modules/@morrow");
  if (!existsSync(scopedModules) || !statSync(scopedModules).isDirectory()) throw new Error("Prepared desktop payload does not materialize workspace runtime modules.");
  const nodeModules = resolve(payload, "app/node_modules");
  const symlinks = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = resolve(directory, entry.name);
      if (lstatSync(candidate).isSymbolicLink()) symlinks.push(candidate);
      else if (entry.isDirectory()) visit(candidate);
    }
  };
  visit(nodeModules);
  visit(resolve(payload, "runtime/node"));
  if (symlinks.length) throw new Error(`Prepared desktop payload contains unsupported runtime symlinks: ${symlinks[0]}`);
  assertPayloadSnapshot(payload, input);
  if (executable) {
    run(node, ["--check", resolve(payload, "app/packages/client-config/dist/cli.js")], { cwd: resolve(payload, "app") });
    run(node, ["--check", resolve(payload, "app/packages/mcp-server/dist/index.js")], { cwd: resolve(payload, "app") });
    run(node, ["--check", resolve(payload, "app/installer/runtime-monitor.mjs")], { cwd: resolve(payload, "app") });
  }
}

function copyRuntime(archive, staging, target) {
  const descriptor = TARGETS[target];
  const extracted = resolve(staging, ".node-extracted");
  mkdirSync(extracted, { recursive: true, mode: 0o700 });
  if (descriptor.extension === "zip") {
    if (process.platform === "win32") {
      run("tar.exe", ["-xf", archive, "-C", extracted]);
    } else {
      run("unzip", ["-q", archive, "-d", extracted]);
    }
  } else run("tar", ["-xJf", archive, "-C", extracted]);
  const directory = resolve(extracted, descriptor.archive.replace(/\.(tar\.xz|zip)$/, ""));
  const source = descriptor.platform === "win32" ? directory : directory;
  // The npm, npx and corepack launchers are symbolic links into lib/node_modules
  // that the payload never resolves, so they arrive dangling. Morrow spawns only
  // bin/node, and a dangling link inside the bundle breaks the macOS resource
  // seal that Gatekeeper validates.
  const launcher = /^(?:npm|npx|corepack)(?:\.cmd|\.ps1)?$/;
  copy(source, resolve(staging, "runtime/node"), (candidate) => !(launcher.test(basename(candidate)) && lstatSync(candidate).isSymbolicLink()));
  rmSync(extracted, { recursive: true, force: true });
}

function sourceCheckpoint() {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: ROOT,
    maxBuffer: 8 * 1024 * 1024
  });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (result.error || result.status !== 0 || head.error || head.status !== 0) throw new Error("Could not capture source checkpoint.");
  return { head: head.stdout.trim(), dirty: result.stdout.length > 0, statusSha256: digestBytes(result.stdout) };
}

async function preparePayload(target, destination, replace) {
  ensureEmptyDestination(destination, replace);
  const staging = `${destination}.staging-${process.pid}-${randomUUID()}`;
  const checkpoint = sourceCheckpoint();
  let input;
  try {
    const packages = workspacePackages();
    const packageMap = new Map(packages.map((entry) => [entry.name, entry]));
    const dependencies = runtimeDependencies(packageMap);
    const archive = await nodeArchive(target, resolve(ROOT, "artifacts", "desktop-runtime-cache"));
    mkdirSync(staging, { recursive: false, mode: 0o700 });
    input = stagePayloadInput(staging, packages, dependencies, checkpoint);
    copyRuntime(archive, staging, target);
    const appRoot = resolve(staging, "app");
    for (const entry of input.packages) copyWorkspacePackage(entry, appRoot);
    for (const [name, source] of input.dependencies) copy(source, resolve(appRoot, "node_modules", ...name.split("/")));
    copy(resolve(input.stage, "artifacts/canvas-api/canvas-api-catalog.json"), resolve(appRoot, "artifacts/canvas-api/canvas-api-catalog.json"));
    copy(resolve(input.stage, "connector/extension"), resolve(appRoot, "connector/extension"));
    const bridgeRelease = copyBridgeRelease(appRoot, resolve(input.stage, "connector/extension"));
    copy(resolve(input.stage, "installer/runtime-monitor.mjs"), resolve(appRoot, "installer/runtime-monitor.mjs"));
    writeFileSync(resolve(appRoot, "package-input-manifest.json"), input.manifestBytes, { mode: 0o600, flag: "wx" });
    writeFileSync(resolve(appRoot, "mcp-runtime-manifest.json"), input.mcpRuntime.bytes, { mode: 0o600, flag: "wx" });
    const sealedInput = { manifest: input.manifest, manifestBytes: input.manifestBytes, mcpRuntime: input.mcpRuntime };
    assertPayload(staging, target, sealedInput, { executable: target === `${process.platform}-${process.arch}` });
    removeStage(input.stage);
    input = undefined;
    renameSync(staging, destination);
    const receipt = {
      schema: "morrow.desktop-payload.v1",
      version: VERSION,
      target,
      payload: destination,
      node: {
        version: NODE_VERSION, archive: TARGETS[target].archive, sha256: TARGETS[target].sha256,
        binarySha256: digest(expectedNodePathForTarget(destination, target))
      },
      source: {
        ...checkpoint,
        inputManifestSha256: digestBytes(readFileSync(resolve(destination, "app/package-input-manifest.json"))),
        inputManifestFileCount: JSON.parse(readFileSync(resolve(destination, "app/package-input-manifest.json"), "utf8")).files.length,
        mcpRuntimeManifestSha256: digestBytes(readFileSync(resolve(destination, "app/mcp-runtime-manifest.json"))),
        reproducibleFrom: "app/package-input-manifest.json",
        note: "When dirty is true, the commit in head does not identify the delivered source by itself, and inputManifestSha256 is the binding record of every file sealed into this payload."
      },
      containsMutableState: false,
      workspaceModulesMaterialized: true,
      bridgeRelease
    };
    Object.defineProperty(receipt, "sealedInput", { value: sealedInput, enumerable: false });
    return receipt;
  } catch (error) {
    if (input) removeStage(input.stage);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function signingState(target, unsignedQa, unsignedRelease) {
  if (unsignedRelease) return { mode: "unsigned_public_release", target, publicRelease: true, automaticUpdates: false };
  if (!unsignedQa) throw new Error("Choose --unsigned-release for an unsigned distribution or --unsigned-qa for a private QA artifact.");
  return { mode: "unsigned_private_qa", target, publicRelease: false };
}

function installerArtifacts(output, target) {
  const files = readdirSync(output).filter((name) => statSync(resolve(output, name)).isFile());
  if (target === "darwin-arm64") {
    const dmg = files.filter((name) => name.startsWith("Morrow-") && name.endsWith("-mac-arm64.dmg"));
    const zip = files.filter((name) => name.startsWith("Morrow-") && name.endsWith("-mac-arm64.zip"));
    const metadata = files.filter((name) => name === "latest-mac.yml");
    if (dmg.length !== 1 || zip.length !== 1 || metadata.length !== 1) {
      throw new Error("Electron builder did not create exactly one Morrow DMG, ZIP, and latest-mac.yml update metadata file.");
    }
    return [...dmg, ...zip, ...metadata];
  }
  const executable = files.filter((name) => name.startsWith("Morrow-") && name.endsWith("-win-x64.exe"));
  if (executable.length !== 1) throw new Error("Electron builder did not create exactly one Windows NSIS installer.");
  return executable;
}

function findAppAsar(root, current = root, matches = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) findAppAsar(root, path, matches);
    else if (entry.isFile() && entry.name === "app.asar") matches.push(path);
  }
  return matches;
}

function readAsarPackage(archive) {
  const data = readFileSync(archive);
  if (data.byteLength < 20 || data.readUInt32LE(0) !== 4) throw new Error("Electron ASAR header is invalid.");
  const headerLength = data.readUInt32LE(4);
  const header = data.subarray(8, 8 + headerLength);
  if (header.length !== headerLength || header.readUInt32LE(0) + 4 !== header.length) throw new Error("Electron ASAR metadata is invalid.");
  const jsonLength = header.readUInt32LE(4);
  const tree = JSON.parse(header.subarray(8, 8 + jsonLength).toString("utf8"));
  const entry = tree?.files?.["package.json"];
  if (!entry || entry.files || entry.link || typeof entry.offset !== "string" || !Number.isSafeInteger(entry.size)) {
    throw new Error("Electron ASAR package.json is missing.");
  }
  const offset = 8 + headerLength + Number(entry.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + entry.size > data.byteLength) throw new Error("Electron ASAR package.json offset is invalid.");
  return JSON.parse(data.subarray(offset, offset + entry.size).toString("utf8"));
}

function assertFinalElectronPayload(electronOutput, target, receipt) {
  const asars = findAppAsar(electronOutput);
  if (asars.length !== 1) throw new Error(`Electron builder produced ${asars.length} app.asar files instead of one.`);
  const payload = resolve(dirname(asars[0]), "MorrowPayload");
  if (!existsSync(payload) || !statSync(payload).isDirectory()) throw new Error("Electron builder output is missing MorrowPayload.");
  assertPayload(payload, target, receipt.sealedInput);
  const appPackage = readAsarPackage(asars[0]);
  if (appPackage?.morrow?.bridgeRelease?.manifestSha256 !== receipt.bridgeRelease.manifestSha256
    || appPackage?.morrow?.mcpRuntime?.manifestSha256 !== receipt.sealedInput.manifest.mcpRuntime.sha256) {
    throw new Error("Electron ASAR does not bind the verified Bridge and MCP manifests.");
  }
}

async function packageDesktop(request) {
  const output = request.output;
  ensureEmptyDestination(output, request.replace);
  const staging = `${output}.staging-${process.pid}-${randomUUID()}`;
  const payload = resolve(staging, "MorrowPayload");
  try {
    mkdirSync(staging, { recursive: false, mode: 0o700 });
    const payloadReceipt = await preparePayload(request.target, payload, false);
    const signing = signingState(request.target, request.unsignedQa, request.unsignedRelease);
    const electronOutput = resolve(staging, "electron-output");
    run("pnpm", ["--dir", INSTALLER, "--ignore-workspace", `run`, TARGETS[request.target].electron[0]], {
      env: { ...process.env, MORROW_INSTALLER_PAYLOAD: payload, MORROW_INSTALLER_OUTPUT: electronOutput, MORROW_SIGNED_RELEASE: "0" }
    });
    assertFinalElectronPayload(electronOutput, request.target, payloadReceipt);
    const artifacts = installerArtifacts(electronOutput, request.target);
    const receipt = {
      schema: "morrow.desktop-installer.v1",
      version: VERSION,
      target: request.target,
      artifacts: artifacts.map((name) => ({ name, sha256: digest(resolve(electronOutput, name)) })),
      payload: { node: payloadReceipt.node, workspaceModulesMaterialized: true, containsMutableState: false },
      signing,
      verification: { payloadStatic: true, installerLaunch: "not_run", electronAsarAndBridge: true, electronAsarAndMcp: true }
    };
    for (const artifact of artifacts) copy(resolve(electronOutput, artifact), resolve(staging, artifact));
    writeFileSync(resolve(staging, "receipt.json"), json(receipt), { mode: 0o600 });
    rmSync(payload, { recursive: true, force: true });
    rmSync(electronOutput, { recursive: true, force: true });
    renameSync(staging, output);
    process.stdout.write(json({ ...receipt, output }));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  let request;
  try { request = parse(process.argv.slice(2)); } catch (error) { die(error instanceof Error ? error.message : String(error), 2); return; }
  if (request.kind === "targets") {
    process.stdout.write(json({
      schema: "morrow.desktop-targets.v1",
      targets: Object.entries(TARGETS).map(([target, value]) => ({ target, label: value.label, nodeArchive: value.archive, nodeSha256: value.sha256, installer: target === "darwin-arm64" ? "dmg" : "nsis" })),
      publicRelease: "unsigned_release_requires_native_verification"
    }));
    return;
  }
  try {
    if (request.kind === "prepare") process.stdout.write(json(await preparePayload(request.target, request.payload, request.replace)));
    else await packageDesktop(request);
  } catch (error) { die(error instanceof Error ? error.message : String(error)); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { BRIDGE_SOURCE_FILES, WORKSPACE_PACKAGE_DIRECTORIES, RUNTIME_DEPENDENCY_NAMES, assertPayloadSnapshot };
