import { lstat, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isJsonObject } from "@morrow/contracts";
import { privateFileAccessAccepted } from "@morrow/gateway-core";
import { BLACKBOARD_ID, blackboardPrincipalVerification, type BlackboardCourseBinding, type BlackboardPrincipalVerification, type BlackboardPublicTenant, type BlackboardTenant } from "./types.js";
import { deriveBlackboardSourceBindingId } from "./binding.js";

interface ConfigFile {
  readonly schema: "morrow.blackboard-learn.config.v1";
  readonly tenants: readonly unknown[];
}

interface CredentialFile {
  readonly schema: "morrow.blackboard-learn.credential.v1";
  readonly credentialRevision: string;
  readonly applicationSecret: string;
}

const CREDENTIAL_REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function exactString(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function tenantId(value: unknown): string {
  const output = exactString(value, "Blackboard tenant id", 80);
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(output)) throw new TypeError("Blackboard tenant id is invalid");
  return output;
}

function exactHttpsOrigin(value: unknown): string {
  const raw = exactString(value, "Blackboard base URL", 500);
  let url: URL;
  try { url = new URL(raw); } catch { throw new TypeError("Blackboard base URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("Blackboard base URL must be one HTTPS origin");
  }
  return url.origin;
}

function exactBlackboardId(value: unknown, label: string): string {
  const output = exactString(value, label, 80);
  if (!BLACKBOARD_ID.test(output)) throw new TypeError(`${label} is invalid`);
  return output;
}

/**
 * How far a tenant must prove the Learn account its server credential acts as.
 * The default requires that account read; `membership-only` is the setting for a
 * Learn site that does not answer it, and it permits reads without any write.
 */
function principalVerification(value: unknown): BlackboardPrincipalVerification {
  if (value === undefined) return "self";
  if (value !== "self" && value !== "membership-only") throw new TypeError("Blackboard principal verification is invalid");
  return value;
}

function credentialRevision(value: unknown): string {
  const output = exactString(value, "Blackboard credential revision", 36);
  if (!CREDENTIAL_REVISION.test(output)) throw new TypeError("Blackboard credential revision is invalid");
  return output;
}

function parseBindings(value: unknown, baseUrl: string, principalId: string): readonly BlackboardCourseBinding[] {
  if (!Array.isArray(value) || value.length > 500) throw new TypeError("Blackboard course bindings are invalid");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!isJsonObject(entry)) throw new TypeError("Blackboard course binding is invalid");
    const courseId = exactBlackboardId(entry.courseId, "Blackboard course id");
    const sourceBindingId = deriveBlackboardSourceBindingId(baseUrl, principalId, courseId);
    if (entry.sourceBindingId !== undefined && entry.sourceBindingId !== sourceBindingId) {
      throw new TypeError("Blackboard source binding id does not match its tenant principal and course");
    }
    if (seen.has(sourceBindingId) || seen.has(`course:${courseId}`)) throw new TypeError("Blackboard course binding is duplicated");
    seen.add(sourceBindingId); seen.add(`course:${courseId}`);
    return { sourceBindingId, courseId };
  });
}

function secretEnvironmentName(id: string): string {
  return `MORROW_BLACKBOARD_SECRET_${id.toUpperCase().replaceAll("-", "_")}`;
}

function parseCredentialFile(value: unknown, expectedRevision: string): CredentialFile {
  if (!isJsonObject(value) || Object.keys(value).length !== 3
    || value.schema !== "morrow.blackboard-learn.credential.v1") {
    throw new TypeError("Blackboard credential file is invalid");
  }
  const revision = credentialRevision(value.credentialRevision);
  if (revision !== expectedRevision) {
    throw new TypeError("Blackboard credential revision does not match its configuration");
  }
  return {
    schema: value.schema,
    credentialRevision: revision,
    applicationSecret: exactString(value.applicationSecret, "Blackboard credential file", 10_000),
  };
}

async function credentialFor(
  tenantIdValue: string,
  value: unknown,
  revision: unknown,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const reference = value === undefined ? "environment" : value;
  if (reference === "environment") {
    if (revision !== undefined) throw new TypeError("Blackboard environment credentials cannot specify a credential revision");
    return exactString(environment[secretEnvironmentName(tenantIdValue)], `Blackboard credential ${secretEnvironmentName(tenantIdValue)}`, 10_000);
  }
  if (reference !== "file") throw new TypeError("Blackboard credential reference is invalid");
  const expectedRevision = credentialRevision(revision);
  const path = resolve(homedir(), ".morrow", "credentials", "blackboard", `${tenantIdValue}.secret`);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !privateFileAccessAccepted(path, metadata.mode, { trustedRoot: homedir() })) {
    throw new TypeError("Blackboard credential access is not private");
  }
  if (metadata.size > 16_384) throw new TypeError("Blackboard credential file is invalid");
  const document = JSON.parse(await readFile(path, "utf8")) as unknown;
  return parseCredentialFile(document, expectedRevision).applicationSecret;
}

function pathInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return Boolean(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

/**
 * Proves every directory a configuration file outside the home directory was
 * reached through: each one has to be a directory this account or the system
 * owns and that no other account can write. The walk follows a directory link,
 * because macOS reaches a temporary directory through `/var`, and checks the
 * directory the link names. The configuration file itself is never followed.
 */
async function ancestorDirectoriesAccepted(path: string): Promise<boolean> {
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  let current = dirname(path);
  for (;;) {
    let directory;
    try { directory = await stat(current); } catch { return false; }
    if (!directory.isDirectory() || (directory.mode & 0o022) !== 0) return false;
    if (owner !== undefined && directory.uid !== owner && directory.uid !== 0) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function parseConfig(value: unknown): ConfigFile {
  if (!isJsonObject(value) || value.schema !== "morrow.blackboard-learn.config.v1" || !Array.isArray(value.tenants) || value.tenants.length > 100) {
    throw new TypeError("Blackboard configuration is invalid");
  }
  return { schema: value.schema, tenants: value.tenants };
}

export async function loadBlackboardLearnConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<readonly BlackboardTenant[]> {
  const configuredPath = environment.MORROW_BLACKBOARD_CONFIG;
  const home = resolve(homedir());
  const path = resolve(configuredPath || `${homedir()}/.morrow/blackboard-learn.json`);
  // A custom path was proved against its own parent, which proved nothing above
  // that parent: an ancestor could be a link into a directory another account
  // controls. A path inside the home directory is now proved from the home
  // directory down, the way the default path always was. A path outside it is
  // proved ancestor by ancestor instead.
  const insideHome = pathInside(home, path);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || !privateFileAccessAccepted(path, metadata.mode, insideHome ? { trustedRoot: home } : {})
    || (!insideHome && !await ancestorDirectoriesAccepted(path))) {
    throw new TypeError("Blackboard configuration access is not private");
  }
  if (metadata.size > 1_048_576) throw new TypeError("Blackboard configuration is invalid");
  const parsed = parseConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
  const tenantIds = new Set<string>();
  const tenants: BlackboardTenant[] = [];
  for (const entry of parsed.tenants) {
    if (!isJsonObject(entry)) throw new TypeError("Blackboard tenant configuration is invalid");
    const id = tenantId(entry.id);
    if (tenantIds.has(id)) throw new TypeError("Blackboard tenant id is duplicated");
    tenantIds.add(id);
    const baseUrl = exactHttpsOrigin(entry.baseUrl);
    const principalId = exactBlackboardId(entry.principalId, "Blackboard integration principal id");
    tenants.push({
      id,
      baseUrl,
      applicationKey: exactString(entry.applicationKey, "Blackboard application key", 500),
      clientSecret: await credentialFor(id, entry.credentialRef, entry.credentialRevision, environment),
      principalId,
      principalVerification: principalVerification(entry.principalVerification),
      courseBindings: parseBindings(entry.courseBindings, baseUrl, principalId),
    });
  }
  return tenants;
}

export function publicBlackboardTenant(value: BlackboardTenant): BlackboardPublicTenant {
  return {
    id: value.id,
    baseUrl: value.baseUrl,
    principalId: value.principalId,
    principalVerification: blackboardPrincipalVerification(value),
    courseBindings: value.courseBindings.map((binding) => ({ ...binding })),
  };
}
