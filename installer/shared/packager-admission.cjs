const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parseStrictJson } = require("./strict-utf8.cjs");

const PACKAGER_ADMISSION_SCHEMA = "morrow.desktop-packager-admission.v1";
const PACKAGE_INPUT_SCHEMA = "morrow.desktop-package-input.v2";
const MCP_RUNTIME_SCHEMA = "morrow.mcp-runtime-manifest.v2";
const BRIDGE_RELEASE_SCHEMA = "morrow.bridge-release.v1";
const PACKAGER_ADMISSION_ENV = "MORROW_PACKAGER_ADMISSION";
const REVIEWED_GRAPH_SHA256_ENV = "MORROW_REVIEWED_RELEASE_GRAPH_SHA256";
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_HEAD = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_FILES = 200_000;
const TARGETS = Object.freeze({
  "darwin-arm64": "runtime/node/bin/node",
  "win32-x64": "runtime/node/node.exe",
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function safeRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024
    || value.includes("\\") || path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function fileRecord(value) {
  if (!exactKeys(value, ["path", "bytes", "sha256"])) return null;
  const relative = safeRelative(value.path);
  if (!relative || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !SHA256.test(value.sha256)) return null;
  return { path: relative, bytes: value.bytes, sha256: value.sha256 };
}

function sourceCheckpoint(value) {
  if (!exactKeys(value, ["head", "dirty", "statusSha256"])
    || !SOURCE_HEAD.test(value.head) || typeof value.dirty !== "boolean" || !SHA256.test(value.statusSha256)) return null;
  return { head: value.head, dirty: value.dirty, statusSha256: value.statusSha256 };
}

function regularFile(root, relativePath) {
  const relative = safeRelative(relativePath);
  if (!relative) throw new Error(`Desktop release graph has an unsafe path: ${relativePath}`);
  const target = path.resolve(root, ...relative.split("/"));
  const relation = path.relative(root, target);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Desktop release graph escapes the payload: ${relative}`);
  }
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Desktop release graph path is not a regular file: ${relative}`);
  const canonicalRoot = fs.realpathSync(root);
  if (fs.realpathSync(target) !== path.resolve(canonicalRoot, ...relative.split("/"))) {
    throw new Error(`Desktop release graph path leaves its canonical payload: ${relative}`);
  }
  const data = fs.readFileSync(target);
  return { path: relative, bytes: data.byteLength, sha256: sha256(data) };
}

function payloadFiles(root) {
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Desktop payload contains a symbolic link: ${target}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) {
        found.push(regularFile(root, path.relative(root, target).split(path.sep).join("/")));
        if (found.length > MAX_FILES) throw new Error("Desktop release graph exceeds its file limit.");
      } else throw new Error(`Desktop payload contains a non-regular entry: ${target}`);
    }
  };
  visit(root);
  return found.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function dependencyMaterialization(value) {
  if (!exactKeys(value, ["dependencies", "install", "lockfile", "packageManager", "schema"])
    || value.schema !== "morrow.runtime-dependency-materialization.v1"
    || !exactKeys(value.packageManager, ["declared", "observed"])
    || value.packageManager.declared !== `pnpm@${value.packageManager.observed}`
    || !/^\d+\.\d+\.\d+$/.test(value.packageManager.observed)
    || !exactKeys(value.lockfile, ["integritySource", "path", "sha256"])
    || value.lockfile.path !== "pnpm-lock.yaml" || !SHA256.test(value.lockfile.sha256)
    || !exactKeys(value.install, ["flags", "mode", "network", "scripts"])
    || value.install.mode !== "isolated_frozen_install" || value.install.network !== "offline"
    || value.install.scripts !== "disabled" || !Array.isArray(value.install.flags)
    || !Array.isArray(value.dependencies) || value.dependencies.length === 0 || value.dependencies.length > 500) return false;
  const expectedFlags = ["--prod", "--frozen-lockfile", "--offline", "--ignore-scripts", "--verify-store-integrity"];
  if (value.install.flags.length !== expectedFlags.length
    || value.install.flags.some((flag, index) => flag !== expectedFlags[index])) return false;
  const names = new Set();
  for (const dependency of value.dependencies) {
    if (!exactKeys(dependency, ["integrity", "name", "version"])
      || typeof dependency.name !== "string" || dependency.name.length === 0 || dependency.name.length > 214
      || typeof dependency.version !== "string" || dependency.version.length === 0
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dependency.integrity) || names.has(dependency.name)) return false;
    names.add(dependency.name);
  }
  return true;
}

function packageInputManifest(root) {
  const bytes = fs.readFileSync(path.resolve(root, "app/package-input-manifest.json"));
  let value;
  try { value = parseStrictJson(bytes, "Prepared Morrow package input manifest"); } catch { throw new Error("Prepared Morrow payload has an invalid package input manifest."); }
  const source = sourceCheckpoint(value?.source);
  if (!exactKeys(value, ["schema", "source", "dependencyMaterialization", "files", "mcpRuntime"])
    || value.schema !== PACKAGE_INPUT_SCHEMA || !source || !dependencyMaterialization(value.dependencyMaterialization)
    || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES
    || !exactKeys(value.mcpRuntime, ["path", "sha256"])
    || value.mcpRuntime.path !== "app/mcp-runtime-manifest.json" || !SHA256.test(value.mcpRuntime.sha256)) {
    throw new Error("Prepared Morrow payload package input graph is invalid.");
  }
  const sourcePaths = new Set();
  const destinationPaths = new Set();
  for (const record of value.files) {
    if (!exactKeys(record, ["path", "bytes", "sha256", "destinations"])) {
      throw new Error("Prepared Morrow payload package input file record is invalid.");
    }
    const sourcePath = safeRelative(record.path);
    if (!sourcePath || sourcePaths.has(sourcePath)
      || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !SHA256.test(record.sha256)
      || !Array.isArray(record.destinations) || record.destinations.length === 0) {
      throw new Error("Prepared Morrow payload package input file record is invalid.");
    }
    sourcePaths.add(sourcePath);
    for (const destination of record.destinations) {
      const normalized = safeRelative(destination);
      if (!normalized || !normalized.startsWith("app/") || destinationPaths.has(normalized)) {
        throw new Error("Prepared Morrow payload package input destination graph is invalid.");
      }
      destinationPaths.add(normalized);
      const actual = regularFile(root, normalized);
      if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) {
        throw new Error(`Prepared Morrow payload differs from its package input graph: ${normalized}`);
      }
    }
  }
  return { bytes, value, source };
}

function mcpRuntimeManifest(root, expectedSha256) {
  const actual = regularFile(root, "app/mcp-runtime-manifest.json");
  if (actual.sha256 !== expectedSha256) throw new Error("Prepared Morrow payload MCP runtime manifest is not bound by its package input graph.");
  let value;
  try { value = parseStrictJson(fs.readFileSync(path.resolve(root, actual.path)), "Prepared Morrow MCP runtime manifest"); } catch { throw new Error("Prepared Morrow payload MCP runtime manifest is invalid."); }
  if (!exactKeys(value, ["schema", "package", "entrypoint", "dependencies", "directFiles"])
    || value.schema !== MCP_RUNTIME_SCHEMA || !exactKeys(value.package, ["name", "version"])
    || value.package.name !== "@morrow-lms/gateway" || !VERSION.test(value.package.version)
    || !fileRecord(value.entrypoint) || value.entrypoint.path !== "packages/mcp-server/dist/index.js"
    || !Array.isArray(value.dependencies) || value.dependencies.length === 0
    || !Array.isArray(value.directFiles) || value.directFiles.length === 0) {
    throw new Error("Prepared Morrow payload MCP runtime manifest is invalid.");
  }
  const validateAppRecord = (record) => {
    const parsed = fileRecord(record);
    if (!parsed) throw new Error("Prepared Morrow payload MCP runtime file graph is invalid.");
    const actualFile = regularFile(root, `app/${parsed.path}`);
    if (actualFile.bytes !== parsed.bytes || actualFile.sha256 !== parsed.sha256) {
      throw new Error(`Prepared Morrow payload differs from its MCP runtime graph: ${parsed.path}`);
    }
    return parsed;
  };
  validateAppRecord(value.entrypoint);
  const directPaths = new Set(value.directFiles.map((record) => validateAppRecord(record).path));
  for (const required of ["packages/client-config/dist/cli.js", "packages/mcp-server/dist/index.js", "packages/canvas-connector-mcp/dist/index.js", "installer/runtime-monitor.mjs", "installer/process-lifetime.cjs"]) {
    if (!directPaths.has(required)) throw new Error("Prepared Morrow payload MCP runtime direct-file graph is incomplete.");
  }
  const packageNames = new Set();
  for (const dependency of value.dependencies) {
    if (!exactKeys(dependency, ["name", "version", "packageJson", "files"])
      || typeof dependency.name !== "string" || dependency.name.length === 0 || packageNames.has(dependency.name)
      || typeof dependency.version !== "string" || !VERSION.test(dependency.version)
      || !Array.isArray(dependency.files) || dependency.files.length === 0) {
      throw new Error("Prepared Morrow payload MCP dependency graph is invalid.");
    }
    packageNames.add(dependency.name);
    const packageJson = validateAppRecord(dependency.packageJson);
    if (packageJson.path !== `node_modules/${dependency.name}/package.json`) {
      throw new Error("Prepared Morrow payload MCP dependency package binding is invalid.");
    }
    const files = new Set(dependency.files.map((record) => validateAppRecord(record).path));
    if (!files.has(packageJson.path)) throw new Error("Prepared Morrow payload MCP dependency file graph is incomplete.");
  }
  if (!packageNames.has(value.package.name)) throw new Error("Prepared Morrow payload MCP gateway package is absent from its dependency graph.");
  return actual;
}

function bridgeReleaseManifest(root, input) {
  const actual = regularFile(root, "app/bridge-release/manifest.json");
  let value;
  try { value = parseStrictJson(fs.readFileSync(path.resolve(root, actual.path)), "Prepared Morrow Bridge release manifest"); } catch { throw new Error("Prepared Morrow payload Bridge release manifest is invalid."); }
  if (!exactKeys(value, ["schema", "version", "extensionId", "manifestSha256", "permissions", "hostPermissions", "optionalHostPermissions", "files"])
    || value.schema !== BRIDGE_RELEASE_SCHEMA || !/^\d+(?:\.\d+){0,3}$/.test(value.version)
    || value.extensionId !== "abeloclekioohahgedmjcdbpllfjfhko" || !SHA256.test(value.manifestSha256)
    || !Array.isArray(value.permissions) || !Array.isArray(value.hostPermissions) || !Array.isArray(value.optionalHostPermissions)
    || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES) {
    throw new Error("Prepared Morrow payload Bridge release manifest is invalid.");
  }
  const expected = input.value.files.filter((record) => record.path.startsWith("connector/extension/"))
    .map((record) => ({ path: record.path.slice("connector/extension/".length), bytes: record.bytes, sha256: record.sha256 }));
  if (JSON.stringify(value.files) !== JSON.stringify(expected)) {
    throw new Error("Prepared Morrow payload Bridge release manifest differs from its package input graph.");
  }
  for (const record of value.files) {
    const parsed = fileRecord(record);
    if (!parsed) throw new Error("Prepared Morrow payload Bridge file graph is invalid.");
    const copied = regularFile(root, `app/bridge-release/extension/${parsed.path}`);
    if (copied.bytes !== parsed.bytes || copied.sha256 !== parsed.sha256) {
      throw new Error(`Prepared Morrow payload differs from its Bridge release graph: ${parsed.path}`);
    }
  }
  const manifest = value.files.find((record) => record.path === "manifest.json");
  if (!manifest || manifest.sha256 !== value.manifestSha256) {
    throw new Error("Prepared Morrow payload Bridge manifest identity is not content-addressed.");
  }
  return actual;
}

function inspectPayload(root, target) {
  if (!Object.hasOwn(TARGETS, target)) throw new Error(`Desktop packager admission target is invalid: ${target}`);
  const payload = path.resolve(root);
  const info = fs.lstatSync(payload);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Desktop packager admission requires one real payload directory.");
  const input = packageInputManifest(payload);
  const mcp = mcpRuntimeManifest(payload, input.value.mcpRuntime.sha256);
  const bridge = bridgeReleaseManifest(payload, input);
  const node = regularFile(payload, TARGETS[target]);
  return {
    payload,
    source: input.source,
    files: payloadFiles(payload),
    packageInputManifestSha256: sha256(input.bytes),
    mcpRuntimeManifestSha256: mcp.sha256,
    bridgeReleaseManifestSha256: bridge.sha256,
    nodeSha256: node.sha256,
  };
}

function graphCore({ target, source, files }) {
  return { target, source, files };
}

function graphSha256(core) {
  return sha256(Buffer.from(JSON.stringify(core)));
}

function createPackagerAdmission({ payload, target }) {
  const inspected = inspectPayload(payload, target);
  const core = graphCore({ target, source: inspected.source, files: inspected.files });
  return Object.freeze({ schema: PACKAGER_ADMISSION_SCHEMA, ...core, graphSha256: graphSha256(core) });
}

function validateAdmission(value) {
  if (!exactKeys(value, ["schema", "target", "source", "files", "graphSha256"])
    || value.schema !== PACKAGER_ADMISSION_SCHEMA || !Object.hasOwn(TARGETS, value.target)
    || !sourceCheckpoint(value.source) || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES
    || !SHA256.test(value.graphSha256)) throw new Error("Desktop packager admission receipt is invalid.");
  let previous = "";
  for (const valueRecord of value.files) {
    const record = fileRecord(valueRecord);
    if (!record || record.path <= previous) throw new Error("Desktop packager admission file graph is invalid.");
    previous = record.path;
  }
  const core = graphCore(value);
  if (graphSha256(core) !== value.graphSha256) throw new Error("Desktop packager admission graph digest is invalid.");
  return value;
}

function verifyPackagerAdmission({ payload, target, admission }) {
  const value = validateAdmission(admission);
  if (value.target !== target) throw new Error("Desktop packager admission target does not match this build.");
  const inspected = inspectPayload(payload, target);
  if (inspected.source.head !== value.source.head
    || inspected.source.dirty !== value.source.dirty
    || inspected.source.statusSha256 !== value.source.statusSha256
    || JSON.stringify(inspected.files) !== JSON.stringify(value.files)) {
    throw new Error("Desktop payload does not match the reviewed release graph.");
  }
  return Object.freeze({
    schema: PACKAGER_ADMISSION_SCHEMA,
    target,
    graphSha256: value.graphSha256,
    source: value.source,
    packageInputManifestSha256: inspected.packageInputManifestSha256,
    mcpRuntimeManifestSha256: inspected.mcpRuntimeManifestSha256,
    bridgeReleaseManifestSha256: inspected.bridgeReleaseManifestSha256,
    nodeSha256: inspected.nodeSha256,
  });
}

function readAdmission(pathValue, payload) {
  if (typeof pathValue !== "string" || !path.isAbsolute(pathValue)) {
    throw new Error(`${PACKAGER_ADMISSION_ENV} must name one absolute reviewed graph receipt.`);
  }
  const receipt = path.resolve(pathValue);
  const relation = path.relative(path.resolve(payload), receipt);
  if (!relation || (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation))) {
    throw new Error("Desktop packager admission receipt must remain outside the payload it reviews.");
  }
  const info = fs.lstatSync(receipt);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Desktop packager admission receipt must be one regular file.");
  try { return validateAdmission(parseStrictJson(fs.readFileSync(receipt), "Desktop packager admission receipt")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("Desktop packager admission receipt is invalid JSON.");
    throw error;
  }
}

function admitPackagerPayload({ payload, target, signedRelease, admissionPath, reviewedGraphSha256 }) {
  const supplied = admissionPath !== undefined || reviewedGraphSha256 !== undefined;
  if (signedRelease && !supplied) {
    throw new Error(`Signed Morrow packaging requires ${PACKAGER_ADMISSION_ENV} and ${REVIEWED_GRAPH_SHA256_ENV}.`);
  }
  if (supplied && (typeof admissionPath !== "string" || !SHA256.test(String(reviewedGraphSha256 || "")))) {
    throw new Error(`Desktop packager admission requires both ${PACKAGER_ADMISSION_ENV} and ${REVIEWED_GRAPH_SHA256_ENV}.`);
  }
  const admission = supplied ? readAdmission(admissionPath, payload) : createPackagerAdmission({ payload, target });
  if (supplied && admission.graphSha256 !== reviewedGraphSha256) {
    throw new Error("Desktop packager admission does not match the reviewed release graph digest.");
  }
  const binding = verifyPackagerAdmission({ payload, target, admission });
  return { admission, binding };
}

function writePackagerAdmission(file, admission) {
  validateAdmission(admission);
  fs.writeFileSync(file, `${JSON.stringify(admission, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return file;
}

module.exports = {
  PACKAGER_ADMISSION_ENV,
  PACKAGER_ADMISSION_SCHEMA,
  REVIEWED_GRAPH_SHA256_ENV,
  admitPackagerPayload,
  createPackagerAdmission,
  verifyPackagerAdmission,
  writePackagerAdmission,
};
