const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { decodeStrictUtf8 } = require("./strict-utf8.cjs");

const CONFIG_SCHEMA = "morrow.blackboard-learn.config.v1";
const CREDENTIAL_SCHEMA = "morrow.blackboard-learn.credential.v1";
const TENANT_ID = /^[a-z][a-z0-9-]{0,79}$/;
const BLACKBOARD_ID = /^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/;
const SOURCE_BINDING_ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINCIPAL_VERIFICATION = new Set(["self", "membership-only"]);

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hash(content) { return crypto.createHash("sha256").update(content).digest("hex"); }
function serializeConfig(value) { return `${JSON.stringify(value)}\n`; }
function exactString(value, label, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new TypeError(`${label} is invalid`);
  return value.trim();
}
function parseTenantId(value) { const id = exactString(value, "Blackboard tenant name", 80); if (!TENANT_ID.test(id)) throw new TypeError("Blackboard tenant name is invalid"); return id; }
function parseHttpsOrigin(value) {
  const raw = exactString(value, "Blackboard HTTPS base URL"); let url;
  try { url = new URL(raw); } catch { throw new TypeError("Blackboard HTTPS base URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new TypeError("Blackboard HTTPS base URL must be one HTTPS origin");
  return url.origin;
}
/** Morrow names the connection after the site, so nobody has to invent a tenant name. */
function blackboardTenantIdFromBaseUrl(value) {
  const host = new URL(parseHttpsOrigin(value)).hostname.toLowerCase();
  const named = host.replaceAll(/[^a-z0-9]+/g, "-").replace(/^-+/, "");
  const id = (/^[a-z]/.test(named) ? named : `bb-${named}`).slice(0, 80).replace(/-+$/, "");
  return parseTenantId(id);
}
function parseBlackboardId(value, label) { const id = exactString(value, label, 80); if (!BLACKBOARD_ID.test(id)) throw new TypeError(`${label} is invalid`); return id; }
/**
 * The same identity `deriveBlackboardSourceBindingId` derives in
 * packages/blackboard-learn-api/src/binding.ts: SHA-256 over the canonical JSON
 * of the provider, origin, principal and course, whose keys are written here in
 * the sorted order canonicalJson emits. The Blackboard source re-derives every
 * stored binding when it loads, so a binding this file writes under a different
 * origin or account is refused there rather than used.
 */
function deriveBlackboardSourceBindingId(baseUrl, principalId, courseId) {
  const origin = parseHttpsOrigin(baseUrl);
  const principal = parseBlackboardId(principalId, "Blackboard integration principal ID");
  const course = parseBlackboardId(courseId, "Blackboard course id");
  const binding = `blackboard:${hash(JSON.stringify({ courseId: course, origin, principalId: principal, provider: "blackboard" }))}`;
  if (!SOURCE_BINDING_ID.test(binding)) throw new TypeError("Blackboard source binding id is invalid");
  return binding;
}
function parseCourseBindings(value, baseUrl, principalId) {
  if (!Array.isArray(value) || value.length > 500) throw new TypeError("Blackboard course bindings are invalid");
  const courseIds = new Set();
  return value.map((entry) => {
    if (!object(entry)) throw new TypeError("Blackboard course binding is invalid");
    const courseId = parseBlackboardId(entry.courseId, "Blackboard course id");
    if (courseIds.has(courseId)) throw new TypeError("Blackboard course binding is duplicated");
    courseIds.add(courseId);
    const sourceBindingId = deriveBlackboardSourceBindingId(baseUrl, principalId, courseId);
    if (entry.sourceBindingId !== undefined && entry.sourceBindingId !== sourceBindingId) throw new TypeError("Blackboard source binding id does not match its tenant principal and course");
    return { courseId, sourceBindingId };
  });
}
function parseAvailableCourses(value) {
  if (!Array.isArray(value) || value.length > 500) throw new TypeError("Blackboard accessible courses are invalid");
  const ids = new Set();
  return value.map((entry) => {
    if (!object(entry) || Object.keys(entry).length !== 2) throw new TypeError("Blackboard accessible course is invalid");
    const courseId = parseBlackboardId(entry.courseId, "Blackboard course id");
    if (ids.has(courseId)) throw new TypeError("Blackboard accessible course is duplicated");
    ids.add(courseId);
    return { courseId, title: exactString(entry.title, "Blackboard course title") };
  });
}
function parseDiscoveredConnection(value) {
  if (!object(value) || Object.keys(value).length !== 2) throw new TypeError("Blackboard connection discovery is invalid");
  return {
    principalId: parseBlackboardId(value.principalId, "Blackboard integration principal ID"),
    courses: parseAvailableCourses(value.courses),
  };
}
function parseStoredTenant(value) {
  if (!object(value)) throw new TypeError("Blackboard tenant configuration is invalid");
  const credentialRef = value.credentialRef === undefined ? "environment" : value.credentialRef;
  if (credentialRef !== "environment" && credentialRef !== "file") throw new TypeError("Blackboard credential reference is invalid");
  const baseUrl = parseHttpsOrigin(value.baseUrl);
  const principalId = parseBlackboardId(value.principalId, "Blackboard integration principal ID");
  const tenant = {
    id: parseTenantId(value.id), baseUrl, applicationKey: exactString(value.applicationKey, "Blackboard application key"), credentialRef,
    principalId, courseBindings: parseCourseBindings(value.courseBindings, baseUrl, principalId),
    availableCourses: value.availableCourses === undefined ? [] : parseAvailableCourses(value.availableCourses),
  };
  if (value.principalVerification !== undefined) {
    if (!PRINCIPAL_VERIFICATION.has(value.principalVerification)) throw new TypeError("Blackboard principal verification is invalid");
    tenant.principalVerification = value.principalVerification;
  }
  if (value.accountVerified !== undefined) {
    if (value.accountVerified !== true) throw new TypeError("Blackboard account verification is invalid");
    tenant.accountVerified = true;
  }
  if (credentialRef === "file") {
    if (typeof value.credentialRevision !== "string" || !REVISION.test(value.credentialRevision)) throw new TypeError("Blackboard credential revision is invalid");
    tenant.credentialRevision = value.credentialRevision;
  } else if (value.credentialRevision !== undefined) throw new TypeError("Blackboard credential revision is invalid");
  return tenant;
}
function parseConfig(value) {
  if (!object(value) || value.schema !== CONFIG_SCHEMA || !Array.isArray(value.tenants) || value.tenants.length > 100) throw new TypeError("Blackboard configuration is invalid");
  const ids = new Set(); const tenants = value.tenants.map((entry) => { const tenant = parseStoredTenant(entry); if (ids.has(tenant.id)) throw new TypeError("Blackboard tenant name is duplicated"); ids.add(tenant.id); return tenant; });
  return { schema: CONFIG_SCHEMA, tenants };
}
function parseSetup(value) {
  if (!object(value) || Object.keys(value).length !== 3) throw new TypeError("Blackboard setup is invalid");
  const baseUrl = parseHttpsOrigin(value.baseUrl);
  return { id: blackboardTenantIdFromBaseUrl(baseUrl), baseUrl, applicationKey: exactString(value.applicationKey, "Blackboard application key"), applicationSecret: exactString(value.applicationSecret, "Blackboard application secret", 10_000) };
}
function parseCourseSelection(value) {
  if (!object(value) || Object.keys(value).length !== 2) throw new TypeError("Blackboard course selection is invalid");
  return { tenantId: parseTenantId(value.tenantId), courseBindings: value.courseBindings };
}
function parseCredential(value, revision) {
  if (!object(value) || Object.keys(value).length !== 3 || value.schema !== CREDENTIAL_SCHEMA || value.credentialRevision !== revision) throw new TypeError("Blackboard credential binding is invalid");
  return exactString(value.applicationSecret, "Blackboard application secret", 10_000);
}
function blackboardPaths(home, tenantId) {
  const root = path.resolve(home); if (!path.isAbsolute(root)) throw new TypeError("Morrow home is invalid");
  const id = parseTenantId(tenantId); const configDirectory = path.join(root, ".morrow"); const credentialDirectory = path.join(configDirectory, "credentials", "blackboard");
  return { config: path.join(configDirectory, "blackboard-learn.json"), configDirectory, credentialDirectory, credential: path.join(credentialDirectory, `${id}.secret`) };
}
async function privateText(file, privateFileAccessAccepted, label, maximumBytes, trustedRoot) {
  if (typeof privateFileAccessAccepted !== "function") throw new TypeError(`${label} access is not private`);
  const metadata = await fs.lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes || privateFileAccessAccepted(file, metadata.mode, { trustedRoot }) !== true) throw new TypeError(`${label} access is not private`);
  return decodeStrictUtf8(await fs.readFile(file), label);
}
async function readConfig(home, privateFileAccessAccepted) {
  const paths = blackboardPaths(home, "default");
  const configPath = paths.config;
  try {
    const serialized = await privateText(configPath, privateFileAccessAccepted, "Blackboard configuration", 1024 * 1024, path.dirname(paths.configDirectory));
    return { path: configPath, config: parseConfig(JSON.parse(serialized)), serialized, sha256: hash(serialized) };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: configPath, config: { schema: CONFIG_SCHEMA, tenants: [] }, serialized: null, sha256: null };
    throw error;
  }
}
async function readCredential(paths, tenant, privateFileAccessAccepted) {
  const serialized = await privateText(paths.credential, privateFileAccessAccepted, "Blackboard credential", 16 * 1024, path.dirname(paths.configDirectory));
  return { serialized, sha256: hash(serialized), applicationSecret: parseCredential(JSON.parse(serialized), tenant.credentialRevision) };
}
async function readPriorCredential(paths, tenant, privateFileAccessAccepted) {
  try { return await readCredential(paths, tenant, privateFileAccessAccepted); }
  catch (error) {
    // A prior data-removal defect could leave a valid route whose secret is
    // absent. Fresh discovery and a newly supplied secret may replace that
    // unusable pair. Every other access or binding failure remains a refusal.
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
async function writeConfig(file, value) {
  const directory = path.dirname(file);
  try { await fs.lstat(directory); }
  catch (error) { if (error?.code === "ENOENT") await fs.mkdir(directory, { mode: 0o700 }); else throw error; }
  const metadata = await fs.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError("Blackboard configuration access is not private");
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${crypto.randomUUID()}`);
  await fs.writeFile(temporary, serializeConfig(value), { encoding: "utf8", mode: 0o600, flag: "wx" }); if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file); if (process.platform !== "win32") await fs.chmod(file, 0o600);
}
function publicTenant(value) {
  return {
    id: value.id,
    baseUrl: value.baseUrl,
    principalId: value.principalId,
    accountVerified: value.accountVerified === true,
    availableCourses: value.availableCourses.map((course) => ({ courseId: course.courseId, title: course.title })),
    courseBindings: value.courseBindings.map((binding) => ({ sourceBindingId: binding.sourceBindingId, courseId: binding.courseId })),
  };
}
function configuredHealth(tenants) { return { schema: "morrow.blackboard.health.v1", status: "api_configured_live_untested", tenants: tenants.map(publicTenant) }; }
function repairHealth(status, tenants = []) { return { schema: "morrow.blackboard.health.v1", status, tenants: tenants.map(publicTenant) }; }
function accessRefused(error) { return error?.code === "EACCES" || error?.code === "EPERM"; }
async function inspectHealthText(file, privateFileAccessAccepted, maximumBytes, trustedRoot) {
  let metadata;
  try { metadata = await fs.lstat(file); }
  catch (error) {
    if (error?.code === "ENOENT") return { status: "absent" };
    return { status: accessRefused(error) ? "private_access_refused" : "damaged" };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return { status: "private_access_refused" };
  if (metadata.size > maximumBytes) return { status: "damaged" };
  try {
    if (typeof privateFileAccessAccepted !== "function" || privateFileAccessAccepted(file, metadata.mode, { trustedRoot }) !== true) {
      return { status: "private_access_refused" };
    }
  } catch { return { status: "private_access_refused" }; }
  try { return { status: "readable", serialized: decodeStrictUtf8(await fs.readFile(file), "Blackboard private state") }; }
  catch (error) { return { status: accessRefused(error) ? "private_access_refused" : "damaged" }; }
}
async function readBlackboardHealth(home, { privateFileAccessAccepted } = {}) {
  const paths = blackboardPaths(home, "default");
  const configFile = await inspectHealthText(paths.config, privateFileAccessAccepted, 1024 * 1024, path.dirname(paths.configDirectory));
  if (configFile.status === "absent") return repairHealth("not_configured");
  if (configFile.status === "private_access_refused") return repairHealth("private_access_refused");
  if (configFile.status !== "readable") return repairHealth("configuration_repair_required");
  let config;
  try { config = parseConfig(JSON.parse(configFile.serialized)); }
  catch { return repairHealth("configuration_repair_required"); }
  if (config.tenants.length === 0) return repairHealth("not_configured");
  const tenants = config.tenants;
  for (const tenant of tenants) {
    if (tenant.credentialRef !== "file") continue;
    const credentialPaths = blackboardPaths(home, tenant.id);
    const credentialFile = await inspectHealthText(credentialPaths.credential, privateFileAccessAccepted, 16 * 1024, path.dirname(credentialPaths.configDirectory));
    if (credentialFile.status === "absent") return repairHealth("credential_missing", tenants);
    if (credentialFile.status === "private_access_refused") return repairHealth("private_access_refused", tenants);
    if (credentialFile.status !== "readable") return repairHealth("credential_mismatched", tenants);
    try { parseCredential(JSON.parse(credentialFile.serialized), tenant.credentialRevision); }
    catch { return repairHealth("credential_mismatched", tenants); }
  }
  return configuredHealth(tenants);
}
async function restoreCredential({ previous, next, paths, writeCredential, privateFileAccessAccepted }) {
  try {
    const current = await privateText(paths.credential, privateFileAccessAccepted, "Blackboard credential", 16 * 1024, path.dirname(paths.configDirectory));
    if (hash(current) !== next.sha256) return;
    if (!previous) { await fs.rm(paths.credential, { force: false }); return; }
    await writeCredential({ directory: paths.credentialDirectory, destination: paths.credential, credentialRevision: previous.revision, applicationSecret: previous.applicationSecret });
    const restored = await readCredential(paths, { credentialRevision: previous.revision }, privateFileAccessAccepted);
    if (restored.sha256 !== previous.sha256) throw new Error("Blackboard credential restoration is unconfirmed");
  } catch { /* A binding mismatch remains unusable if a concurrent change prevents rollback. */ }
}
/** Puts back the exact configuration the transaction read, and only when the transaction is what changed it. */
async function restoreConfig({ home, before, next, privateFileAccessAccepted, writeConfigFile }) {
  try {
    const current = await privateText(before.path, privateFileAccessAccepted, "Blackboard configuration", 1024 * 1024, path.dirname(path.dirname(before.path)));
    if (hash(current) !== next.sha256) return;
    if (before.serialized === null) await fs.rm(before.path, { force: false });
    else await writeConfigFile(before.path, before.config);
    const restored = await readConfig(home, privateFileAccessAccepted);
    if (JSON.stringify(restored.config) !== JSON.stringify(before.config)) throw new Error("Blackboard configuration restoration is unconfirmed");
  } catch { /* A configuration Morrow cannot restore stays unusable if another writer has changed it. */ }
}
/**
 * The secret of a connection the saved configuration no longer names. Removal
 * runs only after the new configuration is confirmed on disk, so a rollback
 * never loses the secret the stored configuration still points at.
 */
async function removeSupersededCredentials(home, previousTenants, savedTenantId) {
  for (const tenant of previousTenants) {
    if (tenant.id === savedTenantId || tenant.credentialRef !== "file") continue;
    // A secret Morrow cannot remove is no longer a connection: no stored
    // configuration names it, so nothing reads it and nothing can use it.
    try { await fs.rm(blackboardPaths(home, tenant.id).credential, { force: true }); } catch { /* left unreferenced */ }
  }
}
async function configureBlackboard({ home, input, discoverConnection, writeCredential, privateFileAccessAccepted, writeConfigFile = writeConfig, prepareCredentialDirectory = async () => {} }) {
  let setup = null;
  try {
    setup = parseSetup(input);
    if (typeof discoverConnection !== "function" || typeof writeCredential !== "function" || typeof privateFileAccessAccepted !== "function" || typeof writeConfigFile !== "function" || typeof prepareCredentialDirectory !== "function") throw new TypeError("Blackboard credential writer is unavailable");
    // A caller cannot name the service account or a course. Blackboard has to
    // answer both reads before this function writes a credential or configuration.
    const discovered = parseDiscoveredConnection(await discoverConnection({ ...setup }));
    const paths = blackboardPaths(home, setup.id); const before = await readConfig(home, privateFileAccessAccepted);
    const existing = before.config.tenants.find((tenant) => tenant.id === setup.id);
    const prior = existing?.credentialRef === "file" ? await readPriorCredential(paths, existing, privateFileAccessAccepted) : null;
    const credentialRevision = crypto.randomUUID();
    // A course binding proves one exact site and account, so a saved change of either releases it.
    const sameIdentity = existing?.baseUrl === setup.baseUrl && existing?.principalId === discovered.principalId;
    const accessible = new Set(discovered.courses.map((course) => course.courseId));
    const retainedBindings = sameIdentity
      ? parseCourseBindings(existing.courseBindings, setup.baseUrl, discovered.principalId).filter((binding) => accessible.has(binding.courseId))
      : [];
    const nextTenant = {
      id: setup.id, baseUrl: setup.baseUrl, applicationKey: setup.applicationKey, credentialRef: "file", credentialRevision,
      principalId: discovered.principalId, principalVerification: "self", accountVerified: true,
      availableCourses: discovered.courses, courseBindings: retainedBindings,
    };
    // Setup holds one Blackboard connection, which is the connection the app
    // shows and the connection its course list belongs to. Saving a different
    // site therefore replaces the saved one rather than adding a second one the
    // app would never show.
    const nextConfig = { schema: CONFIG_SCHEMA, tenants: [nextTenant] };
    await prepareCredentialDirectory({ directory: paths.credentialDirectory, destination: paths.credential });
    await writeCredential({ directory: paths.credentialDirectory, destination: paths.credential, credentialRevision, applicationSecret: setup.applicationSecret });
    const written = await readCredential(paths, nextTenant, privateFileAccessAccepted);
    const next = { sha256: written.sha256 };
    // The stored configuration has to be the exact bytes this transaction
    // intended. A failed write rolls back only bytes this transaction wrote;
    // a different current file belongs to another writer and is left alone.
    const intended = hash(serializeConfig(nextConfig));
    try {
      await writeConfigFile(before.path, nextConfig);
      const confirmed = await readConfig(home, privateFileAccessAccepted);
      if (confirmed.sha256 !== intended) throw new Error("Blackboard configuration write is unconfirmed");
    } catch (error) {
      await restoreConfig({ home, before, next: { sha256: intended }, privateFileAccessAccepted, writeConfigFile });
      await restoreCredential({ previous: prior && { ...prior, revision: existing.credentialRevision }, next, paths, writeCredential, privateFileAccessAccepted });
      throw error;
    }
    await removeSupersededCredentials(home, before.config.tenants, setup.id);
    return configuredHealth(nextConfig.tenants);
  } finally {
    if (setup) setup.applicationSecret = "";
    if (object(input) && typeof input.applicationSecret === "string") input.applicationSecret = "";
  }
}
/**
 * Writes the courses one configured tenant may address. Every binding is derived
 * from the stored web address and account, never taken from the caller, and the
 * readback must be the exact bytes this transaction intended. A failed write
 * rolls back only bytes this transaction wrote.
 */
async function selectBlackboardCourses({ home, input, privateFileAccessAccepted, writeConfigFile = writeConfig }) {
  if (typeof privateFileAccessAccepted !== "function" || typeof writeConfigFile !== "function") throw new TypeError("Blackboard configuration writer is unavailable");
  const selection = parseCourseSelection(input);
  const before = await readConfig(home, privateFileAccessAccepted);
  const existing = before.config.tenants.find((tenant) => tenant.id === selection.tenantId);
  if (!existing || before.serialized === null) throw new TypeError("Blackboard tenant is not configured");
  if (existing.accountVerified !== true) throw new TypeError("Blackboard account must be verified before choosing courses");
  const courseBindings = parseCourseBindings(selection.courseBindings, existing.baseUrl, existing.principalId);
  const accessible = new Set(existing.availableCourses.map((course) => course.courseId));
  if (courseBindings.some((binding) => !accessible.has(binding.courseId))) throw new TypeError("Blackboard course was not discovered for this account");
  const nextTenant = { ...existing, courseBindings };
  const nextConfig = { schema: CONFIG_SCHEMA, tenants: before.config.tenants.map((tenant) => tenant.id === selection.tenantId ? nextTenant : tenant) };
  const intended = hash(serializeConfig(nextConfig));
  try {
    await writeConfigFile(before.path, nextConfig);
    const confirmed = await readConfig(home, privateFileAccessAccepted);
    if (confirmed.sha256 !== intended) throw new Error("Blackboard course selection write is unconfirmed");
    // A stored course list is not a working connection. The status comes from
    // the same health read the app shows, which reads the secret this
    // configuration names as well as the configuration itself, so a saved
    // course never reports a connection this computer cannot open.
    return readBlackboardHealth(home, { privateFileAccessAccepted });
  } catch (error) {
    await restoreConfig({ home, before, next: { sha256: intended }, privateFileAccessAccepted, writeConfigFile });
    throw error;
  }
}
/** Whether the secret file is still on this computer, read from the file system rather than from the removal call. */
async function credentialPresence(file) {
  try { await fs.lstat(file); return "present"; }
  catch (error) { return error?.code === "ENOENT" ? "absent" : "unknown"; }
}
/**
 * Removes all local Blackboard connection data in dependency order. The route
 * goes first and its absence is read back before any credential is removed. If
 * the route remains or cannot be inspected, every secret remains available to
 * that route. If a secret cannot be removed after the route is gone, it is
 * unreferenced and the caller reports it as remaining.
 */
async function removeBlackboardData({ home, removePath = fs.rm }) {
  if (typeof removePath !== "function") throw new TypeError("Blackboard data removal is unavailable");
  const paths = blackboardPaths(home, "default");
  await removePath(paths.config, { force: true }).catch(() => {});
  const configuration = await credentialPresence(paths.config);
  if (configuration !== "absent") {
    return { configuration, credentials: await credentialPresence(paths.credentialDirectory) };
  }
  await removePath(paths.credentialDirectory, { recursive: true, force: true }).catch(() => {});
  return {
    configuration,
    credentials: await credentialPresence(paths.credentialDirectory)
  };
}
/**
 * Removes one saved Blackboard connection from this computer: its entry in the
 * stored configuration and the secret file that entry named. Nothing here
 * reaches Blackboard, and nothing in the Blackboard site changes.
 *
 * The secret goes only after the stored configuration no longer names it, so a
 * write that did not land leaves the connection whole. Both files are read
 * again afterwards, through the same health read the app shows, and the answer
 * is what they say: a secret this computer still holds, or one Morrow could not
 * check, is never reported as removed. A name no stored configuration carries
 * changes nothing and reports the state as it already is.
 */
async function removeBlackboardTenant({ home, tenantId, privateFileAccessAccepted, writeConfigFile = writeConfig }) {
  if (typeof privateFileAccessAccepted !== "function" || typeof writeConfigFile !== "function") throw new TypeError("Blackboard configuration writer is unavailable");
  const id = parseTenantId(tenantId);
  const paths = blackboardPaths(home, id);
  const before = await readConfig(home, privateFileAccessAccepted);
  const configured = before.config.tenants.some((tenant) => tenant.id === id);
  if (configured) {
    const nextConfig = { schema: CONFIG_SCHEMA, tenants: before.config.tenants.filter((tenant) => tenant.id !== id) };
    const intended = hash(serializeConfig(nextConfig));
    try {
      await writeConfigFile(before.path, nextConfig);
      const confirmed = await readConfig(home, privateFileAccessAccepted);
      if (confirmed.sha256 !== intended) throw new Error("Blackboard removal write is unconfirmed");
    } catch (error) {
      await restoreConfig({ home, before, next: { sha256: intended }, privateFileAccessAccepted, writeConfigFile });
      throw error;
    }
    // A removal call that fails reports nothing here. The readback below is
    // what says whether the secret is still on this computer.
    await fs.rm(paths.credential, { force: true }).catch(() => {});
  }
  const credential = await credentialPresence(paths.credential);
  return {
    schema: "morrow.blackboard.removal.v1",
    tenantId: id,
    status: !configured ? "not_configured" : credential === "absent" ? "removed" : "incomplete",
    credential,
    health: await readBlackboardHealth(home, { privateFileAccessAccepted })
  };
}
module.exports = { CONFIG_SCHEMA, CREDENTIAL_SCHEMA, blackboardPaths, blackboardTenantIdFromBaseUrl, configureBlackboard, deriveBlackboardSourceBindingId, readBlackboardHealth, removeBlackboardData, removeBlackboardTenant, selectBlackboardCourses };
