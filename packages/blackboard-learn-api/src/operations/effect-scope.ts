import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { canonicalJson, isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { privateFileAccessAccepted } from "@morrow/gateway-core";
import { BlackboardApiError, type BlackboardPrincipalResolution, type BlackboardTenant } from "../types.js";

const SESSION_STATE_SCHEMA = "morrow.blackboard-learn.sessions.v1";

/** The path that keeps a session record only in this process, for a test. */
export const BLACKBOARD_SESSION_STATE_IN_MEMORY = ":memory:";

/**
 * How many Blackboard connection identities one record file holds. A setup file
 * holds at most 100 tenants, and a new identity appears only when a site,
 * integration account, or credential is repointed, so this bound is far above
 * ordinary use and exists to keep a corrupted or tampered file from being read
 * as an unbounded document.
 */
const MAX_SESSIONS = 1_000;
const MAX_STATE_BYTES = 1_048_576;
const RECORD_FULL = "Blackboard session record is full";

interface StoredSession {
  readonly identity: string;
  readonly generation: number;
  readonly revision: string;
}

/**
 * What a Blackboard effect is bound to, beside the site and the course: the
 * account and credential Morrow acts as, and which session that is.
 *
 * `principalFingerprint` covers the integration account **and** the credential
 * revision, so a rotated application secret is a different fingerprint.
 * `sessionGeneration` counts, from 1, how many times that pair has changed for
 * one site and account, so a plan frozen under an earlier credential cannot be
 * dispatched under a later one. Canvas and Moodle bindings carry the same two
 * values, and the Gateway requires a generation of 1 or more from all three.
 */
export interface BlackboardSessionBinding {
  readonly principalFingerprint: string;
  readonly sessionGeneration: number;
}

/**
 * Where the session record lives: the app-private state directory beside the
 * Blackboard setup file. `MORROW_BLACKBOARD_SESSION_STATE` moves it, the way
 * `MORROW_BLACKBOARD_CONFIG` moves the setup file.
 */
export function blackboardSessionStatePath(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.MORROW_BLACKBOARD_SESSION_STATE || `${homedir()}/.morrow/blackboard-sessions.json`);
}

/**
 * This tenant's credential, as a value Morrow can compare later without holding
 * the secret again. The digest is one-way: nothing derived from it can sign in
 * to Blackboard, and the secret itself is never written to the session record.
 * A rotated application secret, or a re-issued application key, is a different
 * credential and therefore a different digest.
 */
function credentialRevision(tenant: BlackboardTenant): string {
  return sha256Text(canonicalJson({
    schema: "morrow.blackboard-learn.credential-revision.v1",
    baseUrl: tenant.baseUrl,
    applicationKey: tenant.applicationKey,
    applicationSecret: tenant.clientSecret,
  }));
}

/** The exact account and credential one Blackboard effect is bound to. */
export function blackboardPrincipalFingerprint(tenant: BlackboardTenant): string {
  return sha256Text(canonicalJson({
    schema: "morrow.blackboard-learn.principal-fingerprint.v1",
    principalId: tenant.principalId,
    credentialRevision: credentialRevision(tenant),
  }));
}

/** One counted connection: this exact Learn site and integration account. */
function sessionIdentity(tenant: BlackboardTenant): string {
  return sha256Text(canonicalJson({
    schema: "morrow.blackboard-learn.session-identity.v1",
    origin: tenant.baseUrl,
    principalId: tenant.principalId,
  }));
}

/**
 * What has to stay the same for a session to stay the same session: the site,
 * the configured account, the credential, and the account Blackboard itself
 * reported for that credential. A tenant that does not answer the account read
 * is recorded as unresolved rather than as an account, so "Morrow could not find
 * out" never counts as a named account.
 */
function sessionRevision(tenant: BlackboardTenant, resolution: BlackboardPrincipalResolution): string {
  return sha256Text(canonicalJson({
    schema: "morrow.blackboard-learn.session-revision.v1",
    origin: tenant.baseUrl,
    principalId: tenant.principalId,
    credentialRevision: credentialRevision(tenant),
    resolvedPrincipal: resolution.state === "verified" ? resolution.principalId : "unresolved",
  }));
}

function parseSessions(value: unknown): Map<string, StoredSession> {
  if (!isJsonObject(value) || value.schema !== SESSION_STATE_SCHEMA || !Array.isArray(value.sessions)
    || value.sessions.length > MAX_SESSIONS) {
    throw new TypeError("Blackboard session record is invalid");
  }
  const sessions = new Map<string, StoredSession>();
  for (const entry of value.sessions) {
    if (!isJsonObject(entry) || typeof entry.identity !== "string" || !/^[0-9a-f]{64}$/.test(entry.identity)
      || typeof entry.revision !== "string" || !/^[0-9a-f]{64}$/.test(entry.revision)
      || typeof entry.generation !== "number" || !Number.isSafeInteger(entry.generation) || entry.generation < 1
      || sessions.has(entry.identity)) {
      throw new TypeError("Blackboard session record is invalid");
    }
    sessions.set(entry.identity, { identity: entry.identity, generation: entry.generation, revision: entry.revision });
  }
  return sessions;
}

function serializeSessions(sessions: ReadonlyMap<string, StoredSession>): string {
  const ordered = [...sessions.values()].sort((left, right) => (left.identity < right.identity ? -1 : 1));
  return `${JSON.stringify({ schema: SESSION_STATE_SCHEMA, sessions: ordered })}\n`;
}

/**
 * Morrow's own durable record of which Blackboard connection it is acting as.
 *
 * One counter per site and integration account. It rises by one whenever the
 * credential revision, the account Blackboard reports for that credential, or
 * the site changes, and never falls. A plan an instructor approved carries the
 * generation it was reviewed under, so a change reviewed before a secret
 * rotation or a repointed integration user is refused after it instead of being
 * sent as whatever account Morrow now acts as.
 *
 * The record holds digests only: no application key, no secret, no Learn origin,
 * and no account id. It is written as one private file, replaced atomically, and
 * it is the only Blackboard state that has to survive a restart. When it cannot
 * be read or written, Morrow keeps reading Blackboard, which sends no change,
 * and refuses every change instead of acting under a session it cannot account
 * for.
 */
export class BlackboardSessionGenerations {
  private readonly path: string;
  private readonly bindings = new Map<string, BlackboardSessionBinding>();
  private readonly revisions = new Map<string, string>();
  private sessions?: Map<string, StoredSession>;
  private unavailable?: string;

  constructor(path: string = BLACKBOARD_SESSION_STATE_IN_MEMORY) {
    this.path = path;
  }

  /** Whether this record survives a restart. */
  get durable(): boolean {
    return this.path !== BLACKBOARD_SESSION_STATE_IN_MEMORY;
  }

  /**
   * Records the connection one just-resolved account read proves. Every
   * Blackboard read and every Blackboard change calls it right after that
   * account read, so the generation a plan carries is the generation of a
   * session Morrow has just proved.
   *
   * It reads and writes the record only when something changed. A failure is
   * held rather than thrown: the caller's read may still answer, and
   * `binding` refuses every change until the record can be kept again.
   */
  async observe(tenant: BlackboardTenant, resolution: BlackboardPrincipalResolution): Promise<void> {
    const revision = sessionRevision(tenant, resolution);
    if (this.revisions.get(tenant.id) === revision && this.bindings.has(tenant.id)) return;
    const identity = sessionIdentity(tenant);
    try {
      const sessions = await this.load();
      const stored = sessions.get(identity);
      if (!stored || stored.revision !== revision) {
        if (!stored && sessions.size >= MAX_SESSIONS) throw new TypeError(RECORD_FULL);
        sessions.set(identity, { identity, generation: stored ? stored.generation + 1 : 1, revision });
        await this.persist(sessions);
      }
      const generation = sessions.get(identity)!.generation;
      if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError("Blackboard session generation is invalid");
      this.bindings.set(tenant.id, {
        principalFingerprint: blackboardPrincipalFingerprint(tenant),
        sessionGeneration: generation,
      });
      this.revisions.set(tenant.id, revision);
      this.unavailable = undefined;
    } catch (error) {
      // The generation Morrow cannot record is not a generation it may keep
      // using: a held number that was never written would come back as a lower
      // number after a restart, and a plan approved under the higher one would
      // become dispatchable again.
      this.bindings.delete(tenant.id);
      this.revisions.delete(tenant.id);
      this.sessions = undefined;
      this.unavailable = error instanceof Error && error.message === RECORD_FULL
        ? "Its record of past Blackboard connections is full."
        : "It could not read or write that record as one exact private file.";
    }
  }

  /**
   * The session this tenant is acting as, or a refusal. It refuses before any
   * account read has proved the session, and while the durable record cannot be
   * kept, so no Blackboard change is ever bound to a session Morrow made up.
   */
  binding(tenant: BlackboardTenant): BlackboardSessionBinding {
    const binding = this.bindings.get(tenant.id);
    if (binding) return binding;
    throw new BlackboardApiError(
      "blackboard_session_unavailable",
      this.unavailable
        ? `Morrow could not use its own record of which Blackboard account and credential this connection acts as, so it changed nothing in Blackboard. ${this.unavailable}`
        : "Morrow has not checked which Blackboard account this connection acts as, so it changed nothing in Blackboard.",
    );
  }

  private async load(): Promise<Map<string, StoredSession>> {
    if (this.sessions) return this.sessions;
    if (!this.durable) {
      this.sessions = new Map();
      return this.sessions;
    }
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STATE_BYTES
        || !privateFileAccessAccepted(this.path, metadata.mode)) {
        throw new TypeError("Blackboard session record is not one exact private file");
      }
      this.sessions = parseSessions(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.sessions = new Map();
    }
    return this.sessions;
  }

  private async persist(sessions: ReadonlyMap<string, StoredSession>): Promise<void> {
    if (!this.durable) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, serializeSessions(sessions), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600).catch(() => undefined);
  }
}

/**
 * The effect binding scope one Blackboard plan carries to the Gateway: the exact
 * site, course connection, account and credential, and session generation the
 * plan was made under. The Gateway freezes it into the durable operation and
 * requires the same shape from Canvas, Moodle, and Blackboard.
 */
export function blackboardEffectScope(
  tenant: BlackboardTenant,
  sourceBindingId: string,
  binding: BlackboardSessionBinding,
): JsonObject {
  return {
    provider: "blackboard",
    origin: tenant.baseUrl,
    sourceBindingId,
    principalFingerprint: binding.principalFingerprint,
    sessionGeneration: binding.sessionGeneration,
  };
}
