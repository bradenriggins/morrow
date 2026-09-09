import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  canonicalJson,
  isJsonObject,
  sha256Text,
  type JsonObject,
} from "@morrow/contracts";

export const SOURCE_DISPOSITIONS = Object.freeze([
  "direct_owned",
  "adapted_owned",
  "clean_reimplementation",
  "third_party_redistributable",
  "private_runtime_dependency",
  "rights_hold",
  "retired",
] as const);

export type SourceDisposition = (typeof SOURCE_DISPOSITIONS)[number];

export interface OutputPrivacyDescriptor {
  readonly allowedFields: readonly string[];
  readonly fieldPolicy?: "allow-listed" | "scrub-sensitive";
  readonly dataClass: "public" | "course" | "learner";
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly freeText: "allow" | "deny";
  readonly learnerTokens: boolean;
  readonly artifactInspection: "deny" | "text" | "trusted-generated";
  readonly aiClientAdmission: "allow" | "deny";
}

export const DENY_ALL_OUTPUT: OutputPrivacyDescriptor = Object.freeze({
  allowedFields: [],
  fieldPolicy: "allow-listed",
  dataClass: "public",
  maxRecords: 0,
  maxBytes: 0,
  freeText: "deny",
  learnerTokens: false,
  artifactInspection: "deny",
  aiClientAdmission: "deny",
});

export interface LearnerScope {
  readonly canvasOrigin: string;
  readonly account: string;
  readonly course: string;
  readonly principal: string;
  readonly profile: string;
}

export interface LearnerIdentity {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
  readonly loginId?: string;
  readonly sisUserId?: string;
  readonly aliases?: readonly string[];
}

interface VaultEntry {
  readonly token: string;
  readonly label: string;
  readonly scope: LearnerScope;
  readonly identity: LearnerIdentity;
}

interface VaultEnvelope {
  readonly schema: "morrow.learner-vault.v1";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

function scopeKey(scope: LearnerScope): string {
  return canonicalJson(scope);
}

function identityKey(scope: LearnerScope, identity: LearnerIdentity): string {
  return `${scopeKey(scope)}\0${identity.id}`;
}

function exactScope(scope: LearnerScope): LearnerScope {
  const fields = ["canvasOrigin", "account", "course", "principal", "profile"] as const;
  const output = {} as Record<(typeof fields)[number], string>;
  for (const field of fields) {
    const value = String(scope[field] || "").trim();
    if (!value || value.length > 500) throw new TypeError(`learner scope ${field} is invalid`);
    output[field] = value;
  }
  return output;
}

function exactIdentity(value: LearnerIdentity): LearnerIdentity {
  const id = String(value.id || "").trim();
  if (!id || id.length > 500) throw new TypeError("learner id is invalid");
  const optional = (candidate: string | undefined, label: string): string | undefined => {
    if (candidate === undefined) return undefined;
    const normalized = String(candidate).trim();
    if (!normalized || normalized.length > 500) throw new TypeError(`learner ${label} is invalid`);
    return normalized;
  };
  const name = optional(value.name, "name");
  const email = optional(value.email, "email");
  const loginId = optional(value.loginId, "login id");
  const sisUserId = optional(value.sisUserId, "SIS user id");
  if (value.aliases !== undefined && (!Array.isArray(value.aliases) || value.aliases.length > 100)) {
    throw new TypeError("learner aliases are invalid");
  }
  const aliases = [...new Set((value.aliases ?? []).map((alias) => optional(alias, "alias")!))];
  return {
    id,
    ...(aliases.length ? { aliases } : {}),
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(loginId ? { loginId } : {}),
    ...(sisUserId ? { sisUserId } : {}),
  };
}

export function normalizeLearnerIdentity(value: LearnerIdentity): LearnerIdentity {
  return exactIdentity(value);
}

function keyPathFor(path: string): string {
  return `${path}.key`;
}

function readOrCreateKey(pathValue: string): Buffer {
  const path = resolve(pathValue);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    if (key.length !== 32) throw new Error("learner vault key is invalid");
    try { chmodSync(path, 0o600); } catch { /* best effort outside POSIX */ }
    return key;
  }
  const key = randomBytes(32);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${key.toString("base64url")}\n`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readOrCreateKey(path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return key;
}

function parseEnvelope(value: unknown): VaultEnvelope {
  if (!isJsonObject(value) || value.schema !== "morrow.learner-vault.v1") {
    throw new Error("learner vault has an unsupported format");
  }
  for (const key of ["iv", "tag", "ciphertext"] as const) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error("learner vault is invalid");
  }
  return value as unknown as VaultEnvelope;
}

export class LearnerVault {
  private readonly path: string;
  private readonly key: Buffer | null;
  private readonly entries = new Map<string, VaultEntry>();
  private readonly byToken = new Map<string, VaultEntry>();
  private readonly byLabel = new Map<string, VaultEntry>();

  constructor(pathValue = ":memory:") {
    this.path = pathValue === ":memory:" ? pathValue : resolve(pathValue);
    this.key = this.path === ":memory:" ? null : readOrCreateKey(keyPathFor(this.path));
    if (this.path !== ":memory:" && existsSync(this.path)) this.load();
  }

  tokenize(scopeValue: LearnerScope, identityValue: LearnerIdentity): string {
    const scope = exactScope(scopeValue);
    const identity = exactIdentity(identityValue);
    const key = identityKey(scope, identity);
    const existing = this.entries.get(key);
    if (existing) return existing.label;
    const entry: VaultEntry = { token: `learner_${randomUUID()}`, label: this.nextLabel(scope), scope, identity };
    this.entries.set(key, entry);
    this.byToken.set(entry.token, entry);
    this.byLabel.set(`${scopeKey(scope)}\0${entry.label}`, entry);
    this.persist();
    return entry.label;
  }

  resolve(scopeValue: LearnerScope, tokenValue: string): LearnerIdentity {
    const scope = exactScope(scopeValue);
    const token = String(tokenValue || "").trim();
    const entry = this.byLabel.get(`${scopeKey(scope)}\0${token}`) ?? this.byToken.get(token);
    if (!entry || scopeKey(entry.scope) !== scopeKey(scope)) {
      throw new Error("learner token is unavailable for this exact scope");
    }
    return { ...entry.identity };
  }

  private nextLabel(scope: LearnerScope): string {
    let next = 1;
    while (this.byLabel.has(`${scopeKey(scope)}\0Student A${next}`)) next += 1;
    return `Student A${next}`;
  }

  private load(): void {
    const envelope = parseEnvelope(JSON.parse(readFileSync(this.path, "utf8")));
    const decipher = createDecipheriv("aes-256-gcm", this.key!, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const records = JSON.parse(plain) as unknown;
    if (!Array.isArray(records)) throw new Error("learner vault entries are invalid");
    for (const value of records) {
      if (!isJsonObject(value) || typeof value.token !== "string" || !/^learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.token)
        || this.byToken.has(value.token) || !isJsonObject(value.scope) || !isJsonObject(value.identity)) {
        throw new Error("learner vault entry is invalid");
      }
      const scope = exactScope(value.scope as unknown as LearnerScope);
      const label = value.label === undefined ? this.nextLabel(scope) : value.label;
      if (typeof label !== "string" || !/^Student A[1-9][0-9]*$/u.test(label) || this.byLabel.has(`${scopeKey(scope)}\0${label}`)) throw new Error("learner vault label is invalid");
      const entry: VaultEntry = {
        token: value.token,
        label,
        scope,
        identity: exactIdentity(value.identity as unknown as LearnerIdentity),
      };
      if (this.entries.has(identityKey(entry.scope, entry.identity))) throw new Error("learner vault identity is duplicated");
      this.entries.set(identityKey(entry.scope, entry.identity), entry);
      this.byToken.set(entry.token, entry);
      this.byLabel.set(`${scopeKey(scope)}\0${label}`, entry);
    }
  }

  private persist(): void {
    if (this.path === ":memory:") return;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
    const plain = Buffer.from(canonicalJson([...this.byToken.values()]), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const envelope: VaultEnvelope = {
      schema: "morrow.learner-vault.v1",
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* best effort outside POSIX */ }
  }
}

/**
 * Local, exact-scope roster index used only before learner text crosses the
 * gateway boundary. A roster registration replaces that scope atomically; it
 * cannot contribute aliases to another course or principal.
 */
export class LearnerRoster {
  private readonly entriesByScope = new Map<string, ReadonlyMap<string, LearnerIdentity>>();
  private readonly registeredAt = new Map<string, number>();

  register(scopeValue: LearnerScope, identities: readonly LearnerIdentity[]): void {
    const scope = exactScope(scopeValue);
    if (!Array.isArray(identities)) throw new TypeError("learner roster is invalid");
    const entries = new Map<string, LearnerIdentity>();
    for (const value of identities) {
      const identity = exactIdentity(value);
      const existing = entries.get(identity.id);
      if (existing) {
        throw new TypeError("learner roster contains conflicting identities");
      }
      entries.set(identity.id, identity);
    }
    this.entriesByScope.set(scopeKey(scope), entries);
    this.registeredAt.set(scopeKey(scope), Date.now());
  }

  isReady(scopeValue: LearnerScope): boolean {
    const key = scopeKey(exactScope(scopeValue));
    const registeredAt = this.registeredAt.get(key);
    return registeredAt !== undefined && Date.now() >= registeredAt && Date.now() - registeredAt <= 60_000;
  }

  identities(scopeValue: LearnerScope): readonly LearnerIdentity[] {
    const entries = this.entriesByScope.get(scopeKey(exactScope(scopeValue)));
    return entries ? [...entries.values()].map((identity) => ({ ...identity })) : [];
  }

  observe(scopeValue: LearnerScope, identities: readonly LearnerIdentity[]): void {
    const scope = exactScope(scopeValue);
    const key = scopeKey(scope);
    const existing = this.entriesByScope.get(key);
    if (!existing) throw new Error("learner_roster_scope_unavailable");
    const next = new Map(existing);
    for (const value of identities) {
      const identity = exactIdentity(value);
      const prior = next.get(identity.id);
      if (!prior) throw new Error("learner_roster_identity_unavailable");
      next.set(identity.id, mergeLearnerIdentity(prior, identity));
    }
    this.entriesByScope.set(key, next);
  }
}

export interface LearnerTextRedactionContext {
  readonly learnerRoster: LearnerRoster;
  readonly learnerVault: LearnerVault;
  readonly learnerScope: LearnerScope;
}

interface LearnerAlias {
  readonly token: string | null;
}

function mergeLearnerIdentity(left: LearnerIdentity, right: LearnerIdentity): LearnerIdentity {
  if (left.id !== right.id) throw new TypeError("learner identity does not match");
  for (const field of ["name", "email", "loginId", "sisUserId"] as const) {
    if (left[field] && right[field] && left[field] !== right[field]) {
      const knownAliases = [...(left.aliases ?? []), ...(field === "name" ? learnerNameAliases(left) : [])].map(normalizeAlias);
      if (!knownAliases.includes(normalizeAlias(right[field]!))) throw new Error("learner_roster_identity_conflict");
    }
  }
  return {
    id: left.id,
    aliases: [...new Set([...(left.aliases ?? []), ...(right.aliases ?? [])])],
    ...(left.name ?? right.name ? { name: left.name ?? right.name } : {}),
    ...(left.email ?? right.email ? { email: left.email ?? right.email } : {}),
    ...(left.loginId ?? right.loginId ? { loginId: left.loginId ?? right.loginId } : {}),
    ...(left.sisUserId ?? right.sisUserId ? { sisUserId: left.sisUserId ?? right.sisUserId } : {}),
  };
}

function normalizeAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function learnerNameAliases(identity: LearnerIdentity): readonly string[] {
  if (!identity.name) return [];
  const name = normalizeAlias(identity.name);
  if (!name || name.length > 500) return [];
  const given = (name.includes(",") ? name.split(",")[1]!.trim() : name).split(/\s+/u)[0]!;
  const aliases = new Set([name, ...((given.match(/\p{L}/gu)?.length ?? 0) >= 2 ? [given] : [])]);
  const comma = /^([^,]+),\s*(.+)$/u.exec(name);
  if (comma) aliases.add(`${comma[2]} ${comma[1]}`);
  else {
    const parts = name.split(" ");
    if (parts.length === 2) aliases.add(`${parts[1]} ${parts[0]}`);
  }
  return [...aliases];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

interface NormalizedTextView {
  readonly text: string;
  readonly spans: readonly SourceSpan[];
}

interface SourceAtom extends SourceSpan {
  readonly text: string;
}

interface SourceReplacement extends SourceSpan {
  readonly replacement: string;
}

const IDENTITY_NAMED_ENTITIES = new Map<string, string>([
  ["nbsp", " "],
  ["amp", "&"],
  ["quot", "\""],
  ["apos", "'"],
]);

function appendCodePoints(atoms: SourceAtom[], text: string, start: number, end: number): void {
  for (const point of text) atoms.push({ text: point, start, end });
}

function percentTripletAt(value: string, offset: number): number | null {
  if (!/^%[0-9a-f]{2}/iu.test(value.slice(offset, offset + 3))) return null;
  return Number.parseInt(value.slice(offset + 1, offset + 3), 16);
}

function utf8ScalarByteLength(first: number): number | null {
  if (first <= 0x7f) return 1;
  if (first >= 0xc2 && first <= 0xdf) return 2;
  if (first >= 0xe0 && first <= 0xef) return 3;
  if (first >= 0xf0 && first <= 0xf4) return 4;
  return null;
}

/** Decode each valid percent-encoded UTF-8 scalar with only its own source span. */
function appendPercentEscapes(atoms: SourceAtom[], value: string, start: number, end: number): void {
  let cursor = start;
  while (cursor < end) {
    const first = percentTripletAt(value, cursor);
    if (first === null) throw new Error("percent escape run is invalid");
    const width = utf8ScalarByteLength(first);
    const scalarEnd = width === null ? cursor : cursor + width * 3;
    const validContinuation = width !== null && scalarEnd <= end
      && Array.from({ length: width - 1 }, (_, index) => percentTripletAt(value, cursor + (index + 1) * 3))
        .every((byte) => byte !== null && byte >= 0x80 && byte <= 0xbf);
    if (validContinuation) {
      try {
        const source = value.slice(cursor, scalarEnd);
        const decoded = decodeURIComponent(source);
        if ([...decoded].length === 1) {
          appendCodePoints(atoms, decoded, cursor, scalarEnd);
          cursor = scalarEnd;
          continue;
        }
      } catch {
        // Preserve malformed UTF-8 escapes as literal source text below.
      }
    }
    appendCodePoints(atoms, value.slice(cursor, cursor + 3), cursor, cursor + 3);
    cursor += 3;
  }
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Produces a match-only representation of text. Every character in that
 * representation retains the exact source range from which it came. This
 * lets learner redaction recognize copied HTML and percent escapes without
 * reserializing unrelated URL or HTML bytes.
 */
function normalizedIdentityTextView(value: string): NormalizedTextView {
  const atoms: SourceAtom[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const entity = /^&#(?:x([0-9a-f]+)|([0-9]+));/iu.exec(value.slice(cursor));
    if (entity) {
      const point = Number.parseInt(entity[1] || entity[2] || "", entity[1] ? 16 : 10);
      if (Number.isInteger(point) && point >= 0 && point <= 0x10ffff) {
        try {
          appendCodePoints(atoms, String.fromCodePoint(point), cursor, cursor + entity[0].length);
          cursor += entity[0].length;
          continue;
        } catch {
          // Preserve the exact source text when a malformed scalar slips through.
        }
      }
    }
    const named = /^&([a-z]+);/iu.exec(value.slice(cursor));
    if (named) {
      const decoded = IDENTITY_NAMED_ENTITIES.get(named[1]!.toLocaleLowerCase("en-US"));
      if (decoded) {
        appendCodePoints(atoms, decoded, cursor, cursor + named[0].length);
        cursor += named[0].length;
        continue;
      }
    }
    if (/^%[0-9a-f]{2}/iu.test(value.slice(cursor))) {
      let end = cursor;
      while (/^%[0-9a-f]{2}/iu.test(value.slice(end))) end += 3;
      appendPercentEscapes(atoms, value, cursor, end);
      cursor = end;
      continue;
    }
    const point = value.codePointAt(cursor)!;
    const end = cursor + (point > 0xffff ? 2 : 1);
    atoms.push({ text: value.slice(cursor, end), start: cursor, end });
    cursor = end;
  }

  const sourceText = atoms.map((atom) => atom.text).join("");
  const sourceSpans = atoms.flatMap(({ text, start, end }) => (
    Array.from({ length: text.length }, () => ({ start, end }))
  ));
  const normalized: SourceAtom[] = [];
  for (const segment of GRAPHEME_SEGMENTER.segment(sourceText)) {
    const spans = sourceSpans.slice(segment.index, segment.index + segment.segment.length);
    if (spans.length === 0) continue;
    const start = Math.min(...spans.map((span) => span.start));
    const end = Math.max(...spans.map((span) => span.end));
    appendCodePoints(normalized, segment.segment.normalize("NFKC"), start, end);
  }

  return {
    text: normalized.map((atom) => atom.text).join(""),
    // RegExp offsets are UTF-16 indexes. Repeat a scalar's source span for
    // both surrogate code units so an earlier non-BMP character cannot shift
    // a later replacement range.
    spans: normalized.flatMap(({ text, start, end }) => (
      Array.from({ length: text.length }, () => ({ start, end }))
    )),
  };
}

function sourceRangeForView(view: NormalizedTextView, start: number, end: number): SourceSpan | null {
  const spans = view.spans.slice(start, end);
  if (spans.length === 0) return null;
  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
  };
}

function applySourceReplacements(value: string, replacements: readonly SourceReplacement[]): string {
  const ordered = [...replacements].sort((left, right) => left.start - right.start || right.end - left.end);
  let cursor = 0;
  let output = "";
  for (const replacement of ordered) {
    if (replacement.start < cursor || replacement.end < replacement.start) continue;
    output += value.slice(cursor, replacement.start);
    output += replacement.replacement;
    cursor = replacement.end;
  }
  return output + value.slice(cursor);
}

function addAlias(aliases: Map<string, LearnerAlias>, alias: string, token: string): void {
  const key = normalizeAlias(alias);
  if (!key) return;
  const existing = aliases.get(key);
  aliases.set(key, existing && existing.token !== token ? { token: null } : { token });
}

function replaceKnownAliases(value: string, aliases: ReadonlyMap<string, LearnerAlias>): string {
  const candidates = [...aliases.keys()].sort((left, right) => right.length - left.length);
  if (candidates.length === 0) return value;
  const expression = candidates.map((candidate) => escapeRegExp(candidate).replace(/ /gu, "\\s+")).join("|");
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${expression})(?![\\p{L}\\p{N}_])`, "giu");
  const view = normalizedIdentityTextView(value);
  const replacements: SourceReplacement[] = [];
  const references = [...view.text.matchAll(/\bStudent A[1-9][0-9]*\b/gu)];
  for (const match of view.text.matchAll(matcher)) {
    if (references.some((reference) => match.index! >= reference.index! && match.index! < reference.index! + reference[0].length)) continue;
    const source = sourceRangeForView(view, match.index!, match.index! + match[0].length);
    if (!source) continue;
    replacements.push({
      ...source,
      replacement: aliases.get(normalizeAlias(match[0]))?.token ?? "[learner]",
    });
  }
  return applySourceReplacements(value, replacements);
}

function replaceKnownIdentityReferences(value: string, identities: ReadonlyMap<string, LearnerAlias>): string {
  const lookup = (id: string): string | null => identities.get(String(id).trim())?.token ?? null;
  const patterns = [
    /((?:["']?(?:learner|student|user|recipient|enrollment|submission)[_-]?id["']?)\s*[:=]\s*["']?)([0-9]{1,500})/giu,
    /((?:\b(?:learner|student|user|recipient|enrollment|submission|grade)\b\s*(?:id\b\s*)?[#:=]\s*))([0-9]{1,500})\b/giu,
    /(\/(?:users|learners|students)\/)([0-9]{1,500})\b/giu,
  ];
  let output = value;
  for (const matcher of patterns) {
    const view = normalizedIdentityTextView(output);
    const replacements: SourceReplacement[] = [];
    for (const match of view.text.matchAll(matcher)) {
      const token = lookup(match[2]!);
      if (!token) continue;
      const start = match.index! + match[1]!.length;
      const source = sourceRangeForView(view, start, start + match[2]!.length);
      if (source) replacements.push({ ...source, replacement: token });
    }
    output = applySourceReplacements(output, replacements);
  }
  return output;
}

function exactLearnerTextContext(context: LearnerTextRedactionContext): LearnerTextRedactionContext {
  const scope = exactScope(context.learnerScope);
  if (!context.learnerRoster.isReady(scope)) throw new Error("learner_roster_scope_unavailable");
  return { learnerRoster: context.learnerRoster, learnerVault: context.learnerVault, learnerScope: scope };
}

/**
 * Replaces only identities registered for this exact roster scope. It does not
 * try to infer arbitrary names. Callers must register the complete roster for
 * the current course and principal before forwarding learner text.
 */
export function redactKnownLearnerText(value: string, context: LearnerTextRedactionContext): string {
  if (typeof value !== "string") throw new TypeError("learner text is invalid");
  const exactContext = exactLearnerTextContext(context);
  if (/^(?:moodle|mod|block|enrol|report)\/[a-z_]+:[a-z_]+$/u.test(value)) return value;
  if (/^\s*[\[{]/u.test(value)) {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { /* Ordinary prose is matched below. */ }
    if (Array.isArray(parsed) || isJsonObject(parsed)) return JSON.stringify(redactLearnerEgress(parsed, exactContext));
  }
  const scope = exactContext.learnerScope;
  value = value.replace(/\b(?:Student A[1-9][0-9]*|learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gu, (reference) => {
    const identity = exactContext.learnerVault.resolve(scope, reference);
    if (!exactContext.learnerRoster.identities(scope).some((entry) => entry.id === identity.id)) throw new Error("learner_roster_identity_unavailable");
    return exactContext.learnerVault.tokenize(scope, identity);
  });
  const aliases = new Map<string, LearnerAlias>();
  const identities = new Map<string, LearnerAlias>();
  for (const identity of exactContext.learnerRoster.identities(scope)) {
    const token = exactContext.learnerVault.tokenize(scope, identity);
    identities.set(identity.id, { token });
    addAlias(aliases, identity.id, token);
    for (const alias of learnerNameAliases(identity)) addAlias(aliases, alias, token);
    if (identity.email) addAlias(aliases, identity.email, token);
    if (identity.loginId) addAlias(aliases, identity.loginId, token);
    if (identity.sisUserId) addAlias(aliases, identity.sisUserId, token);
    for (const alias of identity.aliases ?? []) addAlias(aliases, alias, token);
  }
  return replaceKnownIdentityReferences(replaceKnownAliases(value, aliases), identities);
}

function redactLearnerNumber(value: number, key: string, context: LearnerTextRedactionContext): number | string {
  // Numeric measures and explicitly typed course resources are not user IDs.
  if (/^(?:(?:course|assignment|quiz|module|section|file|page|discussion|topic|question|item|group|rubric|context|account)[_.]?(?:id|count)|.*(?:score|grade|points|count|total|rows|limit|size|length|percent|status|generation|revision|index|timestamp|duration|attempt|page)|depth)$/iu.test(key)) return value;
  const identity = context.learnerRoster.identities(context.learnerScope).find((entry) => entry.id === String(value));
  return identity ? context.learnerVault.tokenize(context.learnerScope, identity) : value;
}

function redactLearnerKey(key: string, context: LearnerTextRedactionContext): string {
  if (["schema", "provider", "course", "name", "id", "title", "type", "tool", "code", "status", "data", "result", "content", "text", "learnerToken", "student", "user", "author", "participant", "students", "users", "authors", "participants", "grade", "score"].includes(key)) return key;
  const identity = context.learnerRoster.identities(context.learnerScope).find((entry) => entry.id === key);
  const output = identity ? context.learnerVault.tokenize(context.learnerScope, identity) : redactKnownLearnerText(key, context);
  if (containsSensitiveText(output)) throw new Error("privacy_sensitive_text_refused");
  return output;
}

const STRUCTURAL_REFERENCE_FIELDS = new Set([
  "source_binding_id", "sourceBindingId", "course_id", "courseId", "batch_id", "batchId",
  "child_id", "childId", "operation_id", "operationId", "approval_id", "approvalId",
  "operation_key", "operationKey", "effect_key", "effectKey", "idempotency_key", "idempotencyKey",
]);

export class ArtifactGenerationRegistry {
  private readonly digests = new Set<string>();

  record(bytes: Uint8Array): string {
    const digest = createHash("sha256").update(bytes).digest("hex");
    this.digests.add(digest);
    return digest;
  }

  has(bytes: Uint8Array): boolean {
    return this.digests.has(createHash("sha256").update(bytes).digest("hex"));
  }
}

export interface OutputPrivacyContext {
  readonly descriptor?: OutputPrivacyDescriptor;
  readonly learnerVault?: LearnerVault;
  readonly learnerRoster?: LearnerRoster;
  readonly learnerScope?: LearnerScope;
  readonly artifacts?: ArtifactGenerationRegistry;
  /**
   * Which boundary removed learner identity from this value. `gateway`, the
   * default, means Morrow holds the course roster for this scope and redacts
   * here. `source` means the source holds the roster inside its own process and
   * returns learner tokens instead of identities: Morrow holds no roster for
   * such a source, so requiring one would refuse every result rather than
   * protect one. A `source` value that still carries a learner identity is
   * refused, and every other projection here still applies.
   */
  readonly learnerBoundary?: "gateway" | "source";
}

export interface ProjectedOutput {
  readonly content: readonly JsonObject[];
  readonly structuredContent?: JsonObject;
}

type IdentityRecordKind = "learner" | "student" | "user" | "enrollment" | "submission" | "grade" | "recipient" | "member";

const IDENTITY_VALUE_FIELDS = new Set([
  "userid", "learnerid", "studentid", "canvasuserid", "sisuserid", "sispersonid", "pseudonymid",
  "displayname", "studentname", "integrationid", "sisid", "idnumber", "profile", "profileurl", "avatarurl",
  "userids", "studentids", "learnerids", "recipientids", "participantids", "authorid", "authorids",
  "email", "primaryemail", "loginid", "sisloginid", "firstname", "lastname", "pronouns", "avatarimageurl",
  "accommodations",
]);
const IDENTITY_RECORD_VALUE_FIELDS = new Set([
  "id", "name", "fullname", "username", "sortablename", "shortname",
]);
const IDENTITY_CONTAINER_KEYS = new Map<string, IdentityRecordKind>([
  ["learner", "learner"], ["learners", "learner"], ["student", "student"], ["students", "student"],
  ["user", "user"], ["users", "user"], ["person", "user"], ["people", "user"],
  ["enrollment", "enrollment"], ["enrollments", "enrollment"],
  ["submission", "submission"], ["submissions", "submission"],
  ["grade", "grade"], ["grades", "grade"], ["gradebook", "grade"],
  ["participant", "user"], ["participants", "user"], ["author", "user"], ["authors", "user"],
  ["recipient", "recipient"], ["recipients", "recipient"], ["member", "member"], ["members", "member"],
]);
const SECRET_FIELD = /(?:^|_)(?:authorization|bearer|access_token|refresh_token|csrf|cookie|secret|credential|jwt)(?:$|_)/i;
const SECRET_FIELD_NORMALIZED = new Set([
  "authorization", "bearer", "accesstoken", "refreshtoken", "csrf", "cookie", "secret", "credential", "jwt",
  "privateattachment", "bytesbase64",
]);

function privacyError(code: string): JsonObject {
  return {
    content: [{ type: "text", text: "Morrow refused unsafe upstream output." }],
    isError: true,
    structuredContent: { schema: "morrow.problem.v1", code, recoverable: false },
  };
}

function exactDescriptor(value: OutputPrivacyDescriptor | undefined): OutputPrivacyDescriptor {
  const descriptor = value || DENY_ALL_OUTPUT;
  const aiClientAdmission = descriptor.aiClientAdmission ?? "allow";
  const fieldPolicy = descriptor.fieldPolicy ?? "allow-listed";
  if (
    !Array.isArray(descriptor.allowedFields)
    || !["allow-listed", "scrub-sensitive"].includes(fieldPolicy)
    || !["public", "course", "learner"].includes(descriptor.dataClass)
    || !Number.isInteger(descriptor.maxRecords) || descriptor.maxRecords < 0 || descriptor.maxRecords > 10_000
    || !Number.isInteger(descriptor.maxBytes) || descriptor.maxBytes < 0 || descriptor.maxBytes > 10_000_000
    || !["allow", "deny"].includes(descriptor.freeText)
    || !["deny", "text", "trusted-generated"].includes(descriptor.artifactInspection)
    || !["allow", "deny"].includes(aiClientAdmission)
  ) throw new TypeError("output privacy descriptor is invalid");
  return { ...descriptor, aiClientAdmission, fieldPolicy };
}

function normalizePrivacyKey(key: string): string {
  return key.normalize("NFKC").replace(/[\s_-]/gu, "").toLocaleLowerCase("en-US");
}

function isSecretField(key: string): boolean {
  return SECRET_FIELD.test(key) || SECRET_FIELD_NORMALIZED.has(normalizePrivacyKey(key));
}

function isIdentityValueField(key: string, recordIdentity = false): boolean {
  const normalized = normalizePrivacyKey(key);
  if ((recordIdentity && IDENTITY_RECORD_VALUE_FIELDS.has(normalized)) || IDENTITY_VALUE_FIELDS.has(normalized)) return true;
  return /(?:learner|student|user|person|recipient|enrollment|submission)(?:id|name|email|login|sis|identifier|uuid|guid)$/u.test(normalized);
}

function identityRecordKind(key: string): IdentityRecordKind | undefined {
  return IDENTITY_CONTAINER_KEYS.get(normalizePrivacyKey(key));
}

function normalizedIdentityFields(value: JsonObject): ReadonlyMap<string, unknown> {
  return new Map(Object.entries(value).map(([key, candidate]) => [normalizePrivacyKey(key), candidate]));
}

function identityValue(fields: ReadonlyMap<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = fields.get(normalizePrivacyKey(key));
    if (typeof candidate === "string" || typeof candidate === "number") {
      const normalized = String(candidate).trim();
      if (normalized) return normalized;
    }
  }
  return undefined;
}

function learnerIdentity(value: JsonObject, kind?: IdentityRecordKind, context?: LearnerTextRedactionContext): LearnerIdentity | null {
  const fields = normalizedIdentityFields(value);
  const existingToken = fields.get("learnertoken");
  if (context && typeof existingToken === "string") {
    const identity = context.learnerVault.resolve(context.learnerScope, existingToken);
    const current = context.learnerRoster.identities(context.learnerScope).find((entry) => entry.id === identity.id);
    if (!current) throw new Error("learner_roster_identity_unavailable");
    return current;
  }
  const normalizedKeys = new Set(fields.keys());
  const hasGenericSignal = ["userid", "learnerid", "studentid", "canvasuserid", "sisuserid", "email", "loginid", "sortablename"]
    .some((key) => normalizedKeys.has(key))
    || (Boolean(context) && normalizedKeys.has("id") && normalizedKeys.has("name") && ["grade", "score", "enrollments", "grades", "submission", "attempts"].some((key) => normalizedKeys.has(key)))
    || ((normalizedKeys.has("avatarimageurl") || normalizedKeys.has("pronouns")) && (normalizedKeys.has("name") || normalizedKeys.has("displayname")));
  const bareId = identityValue(fields, ["id"]);
  const rosterMatch = context && bareId
    ? context.learnerRoster.identities(context.learnerScope).find((identity) => identity.id === bareId)
    : undefined;
  const hasName = ["name", "fullname", "displayname", "shortname", "sortablename"].some((key) => normalizedKeys.has(key));
  if (!kind && !hasGenericSignal && !(rosterMatch && hasName)) return null;
  const directId = identityValue(fields, ["user_id", "userId", "learner_id", "learnerId", "student_id", "studentId", "canvas_user_id", "canvasUserId", "sis_user_id", "sisUserId"]);
  const fallbackId = (kind || hasGenericSignal || rosterMatch) && kind !== "submission" && kind !== "enrollment"
    ? identityValue(fields, ["id"])
    : undefined;
  const id = directId || fallbackId;
  if (!id) return null;
  const name = identityValue(fields, ["name", "display_name", "displayName", "full_name", "fullName", "student_name", "studentName"]);
  const email = identityValue(fields, ["email", "primary_email", "primaryEmail"]);
  const loginId = identityValue(fields, ["login_id", "loginId"]);
  const sisUserId = identityValue(fields, ["sis_user_id", "sisUserId"]);
  return normalizeLearnerIdentity({
    id,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(loginId ? { loginId } : {}),
    ...(sisUserId ? { sisUserId } : {}),
  });
}

function learnerTextContext(context: OutputPrivacyContext): LearnerTextRedactionContext {
  if (!context.learnerRoster || !context.learnerVault || !context.learnerScope) {
    throw new Error("learner_roster_scope_unavailable");
  }
  const scope = exactScope(context.learnerScope);
  if (!context.learnerRoster.isReady(scope)) throw new Error("learner_roster_scope_unavailable");
  return { learnerRoster: context.learnerRoster, learnerVault: context.learnerVault, learnerScope: scope };
}

function projectText(
  value: string,
  descriptor: OutputPrivacyDescriptor,
  context: OutputPrivacyContext,
  requiresLearnerRedaction: boolean,
): string {
  const output = requiresLearnerRedaction ? redactKnownLearnerText(value, learnerTextContext(context)) : value;
  if (containsSensitiveText(output)) throw new Error("privacy_sensitive_text_refused");
  return output;
}

function projectValue(
  value: unknown,
  descriptor: OutputPrivacyDescriptor,
  context: OutputPrivacyContext,
  depth = 0,
  kind?: IdentityRecordKind,
  inheritedLearnerPrivacy = false,
): unknown {
  if (depth > 12) throw new Error("privacy_output_depth_exceeded");
  const sourceRedacted = context.learnerBoundary === "source";
  const requiresLearnerRedaction = !sourceRedacted
    && (descriptor.dataClass === "learner"
      || kind !== undefined
      || inheritedLearnerPrivacy
      || Boolean(context.learnerRoster && context.learnerVault && context.learnerScope));
  if (typeof value === "string") return projectText(value, descriptor, context, requiresLearnerRedaction);
  if (Array.isArray(value)) {
    if (value.length > descriptor.maxRecords) throw new Error("privacy_record_limit_exceeded");
    return value.map((item) => projectValue(item, descriptor, context, depth + 1, kind, inheritedLearnerPrivacy));
  }
  if (!isJsonObject(value)) return value;
  const learner = learnerIdentity(value, kind, context.learnerRoster && context.learnerVault && context.learnerScope ? learnerTextContext(context) : undefined);
  // A source that states it returns learner tokens and no learner identity is
  // held to that. A record shaped like a learner identity is a boundary
  // failure there, not a record to tokenize here; a record that carries only a
  // token is already resolved and is not an unresolved identity.
  if (sourceRedacted && learner) throw new Error("privacy_source_learner_identity_refused");
  if (!sourceRedacted && kind && !learner) throw new Error("privacy_identity_record_unresolved");
  const needsTextRedaction = requiresLearnerRedaction || learner !== null;
  let textContext: LearnerTextRedactionContext | undefined;
  if (needsTextRedaction) {
    textContext = learnerTextContext(context);
    if (learner) textContext.learnerRoster.observe(textContext.learnerScope, [learner]);
  }
  const output: JsonObject = {};
  if (learner && descriptor.learnerTokens) {
    output.learnerToken = textContext!.learnerVault.tokenize(textContext!.learnerScope, learner);
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizePrivacyKey(key);
    const allowField = descriptor.fieldPolicy === "scrub-sensitive" || descriptor.allowedFields.includes(key);
    if (!allowField || isSecretField(key) || isIdentityValueField(key, learner !== null) || (learner && normalizedKey === "learnertoken")) continue;
    if (descriptor.freeText === "deny" && (normalizedKey === "html" || normalizedKey === "body" || normalizedKey === "content")) continue;
    const childKind = identityRecordKind(key);
    const projected = projectValue(child, descriptor, context, depth + 1, childKind, needsTextRedaction);
    const safeKey = textContext ? redactLearnerKey(key, textContext) : key;
    if (Object.hasOwn(output, safeKey)) throw new Error("privacy_identity_key_collision");
    if (projected !== undefined) Object.defineProperty(output, safeKey, { value: projected, enumerable: true, writable: true, configurable: true });
  }
  return output;
}

function containsSensitiveText(value: string): boolean {
  // Redaction preserves non-learner source bytes, including HTML entities and
  // URL escapes. Inspect the same canonical match view so encoded credentials
  // and unrostered emails remain refused without rewriting a safe URL.
  return /(?:data:[^,;]{0,200};base64,|bearer\s+|cookie=|csrf|token=|(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|<[^>]+(?:hidden|display\s*:\s*none))/i
    .test(normalizedIdentityTextView(value).text);
}

/**
 * Sanitizes an arbitrary native-tool or sampling envelope without applying an
 * output allowlist. It preserves envelope shape and non-identity course data,
 * while routing every string and nested learner-shaped record through the
 * exact-scope roster and vault boundary.
 */
export function redactLearnerEgress(value: unknown, context: LearnerTextRedactionContext): unknown {
  const exactContext = exactLearnerTextContext(context);
  const walk = (candidate: unknown, depth = 0, kind?: IdentityRecordKind, inheritedLearnerPrivacy = false, scalarKey = ""): unknown => {
    if (depth > 12) throw new Error("privacy_output_depth_exceeded");
    if (typeof candidate === "number") return redactLearnerNumber(candidate, scalarKey, exactContext);
    if (typeof candidate === "string") {
      if (STRUCTURAL_REFERENCE_FIELDS.has(scalarKey)) return candidate;
      if (scalarKey === "schema" && /^morrow\.[a-z0-9.-]+\.v[0-9]+$/u.test(candidate)) return candidate;
      if (scalarKey === "provider" && ["canvas", "moodle", "blackboard"].includes(candidate)) return candidate;
      if (scalarKey === "roles" && ["Student", "Teacher", "TA", "Observer", "Designer", "Non-editing teacher"].includes(candidate)) return candidate;
      const output = redactKnownLearnerText(candidate, exactContext);
      if (containsSensitiveText(output)) throw new Error("privacy_sensitive_text_refused");
      return output;
    }
    if (Array.isArray(candidate)) return candidate.map((entry) => walk(entry, depth + 1, kind, inheritedLearnerPrivacy, scalarKey));
    if (!isJsonObject(candidate)) return candidate;
    if ((["image", "audio"].includes(String(candidate.type)) || candidate.encoding === "base64") && typeof candidate.data === "string") {
      throw new Error("privacy_opaque_artifact_refused");
    }
    const learner = learnerIdentity(candidate, kind, exactContext);
    if (kind && !learner) throw new Error("privacy_identity_record_unresolved");
    const needsLearnerPrivacy = inheritedLearnerPrivacy || kind !== undefined || learner !== null;
    if (learner) exactContext.learnerRoster.observe(exactContext.learnerScope, [learner]);
    const output: JsonObject = {};
    if (learner) output.learnerToken = exactContext.learnerVault.tokenize(exactContext.learnerScope, learner);
    for (const [key, child] of Object.entries(candidate)) {
      const normalizedKey = normalizePrivacyKey(key);
      if (isSecretField(key) || isIdentityValueField(key, learner !== null) || (learner && normalizedKey === "learnertoken")) continue;
      // A binary MCP resource has no safe text projection at this boundary.
      // Returning its encoded bytes could expose learner identities without a
      // chance to apply the exact-scope roster aliases.
      if (normalizedKey === "blob" && typeof child === "string") {
        throw new Error("privacy_resource_blob_refused");
      }
      const safeKey = redactLearnerKey(key, exactContext);
      if (Object.hasOwn(output, safeKey)) throw new Error("privacy_identity_key_collision");
      Object.defineProperty(output, safeKey, { value: walk(child, depth + 1, identityRecordKind(key), needsLearnerPrivacy, key === "id" ? `${scalarKey}_id` : key), enumerable: true, writable: true, configurable: true });
    }
    return output;
  };
  return walk(value);
}

function projectContent(
  value: unknown,
  descriptor: OutputPrivacyDescriptor,
  context: OutputPrivacyContext,
): readonly JsonObject[] {
  if (!Array.isArray(value)) return [];
  const requiresLearnerRedaction = context.learnerBoundary !== "source"
    && (descriptor.dataClass === "learner"
      || Boolean(context.learnerRoster && context.learnerVault && context.learnerScope));
  const output: JsonObject[] = [];
  for (const block of value) {
    if (!isJsonObject(block) || typeof block.type !== "string") throw new Error("privacy_content_block_invalid");
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new Error("privacy_content_block_invalid");
      }
      if (descriptor.freeText !== "allow") {
        continue;
      }
      const text = projectText(block.text, descriptor, context, requiresLearnerRedaction);
      if (Buffer.byteLength(text, "utf8") > descriptor.maxBytes) {
        throw new Error("privacy_byte_limit_exceeded");
      }
      output.push({ type: "text", text });
      continue;
    }
    const resource = isJsonObject(block.resource) ? block.resource : block;
    if (typeof resource.text === "string") {
      if (descriptor.artifactInspection !== "text") {
        throw new Error("privacy_text_artifact_refused");
      }
      const text = projectText(resource.text, descriptor, context, requiresLearnerRedaction);
      const projected = structuredClone(block);
      if (isJsonObject(projected.resource) && typeof projected.resource.text === "string") {
        projected.resource.text = text;
      } else if (typeof projected.text === "string") {
        projected.text = text;
      }
      output.push(projected);
      continue;
    }
    const encoded = typeof resource.blob === "string"
      ? resource.blob
      : typeof block.data === "string" ? block.data : "";
    if (!encoded || descriptor.artifactInspection !== "trusted-generated" || !context.artifacts) {
      throw new Error("privacy_opaque_artifact_refused");
    }
    if (!context.artifacts.has(Buffer.from(encoded, "base64"))) {
      throw new Error("privacy_artifact_digest_untrusted");
    }
    output.push(structuredClone(block));
  }
  return output;
}

export function projectOutput(
  value: unknown,
  context: OutputPrivacyContext = {},
): ProjectedOutput | JsonObject {
  const descriptor = exactDescriptor(context.descriptor);
  if (!isJsonObject(value)) return privacyError("privacy_output_invalid");
  if (value.isError === true) return privacyError("upstream_error_sanitized");
  if (descriptor.aiClientAdmission !== "allow") return privacyError("privacy_ai_client_admission_denied");
  try {
    const content = projectContent(value.content, descriptor, context);
    const structured = isJsonObject(value.structuredContent)
      ? projectValue(value.structuredContent, descriptor, context)
      : undefined;
    const structuredContent = isJsonObject(structured) && Object.keys(structured).length > 0
      ? structured
      : undefined;
    if (content.length === 0 && !structuredContent) return privacyError("privacy_output_denied");
    const projected: ProjectedOutput = { content, ...(structuredContent ? { structuredContent } : {}) };
    if (Buffer.byteLength(canonicalJson(projected), "utf8") > descriptor.maxBytes) {
      return privacyError("privacy_byte_limit_exceeded");
    }
    return projected;
  } catch (error) {
    return privacyError(error instanceof Error && /^(?:privacy|learner)_[a-z0-9_]{1,100}$/u.test(error.message) ? error.message : "privacy_output_refused");
  }
}

export function resolveLearnerTokens(
  value: Readonly<Record<string, unknown>>,
  vault: LearnerVault,
  scope: LearnerScope,
  roster?: LearnerRoster,
): Record<string, unknown> {
  const resolveIdentity = (token: string): LearnerIdentity => {
    const saved = vault.resolve(scope, token);
    if (!roster) return saved;
    if (!roster.isReady(scope)) throw new Error("learner_roster_scope_unavailable");
    const current = roster.identities(scope).find((identity) => identity.id === saved.id);
    if (!current) throw new Error("learner_roster_identity_unavailable");
    return current;
  };
  const resolveValue = (candidate: unknown, key = "", depth = 0): unknown => {
    if (depth > 12) throw new Error("privacy_output_depth_exceeded");
    if (typeof candidate === "string") {
      const identifier = /^(?:user|student|learner|recipient|author|participant)(?:s|_?ids?)?$/iu.test(key);
      return candidate.replace(/\b(?:Student A[1-9][0-9]*|learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gu, (token) => {
        const identity = resolveIdentity(token);
        if (identifier && candidate === token) return identity.id;
        if (!identity.name) throw new Error("learner_roster_name_unavailable");
        return identity.name;
      });
    }
    if (Array.isArray(candidate)) return candidate.map((entry) => resolveValue(entry, key, depth + 1));
    if (!isJsonObject(candidate)) return candidate;
    const output: JsonObject = {};
    for (const [field, child] of Object.entries(candidate)) {
      if (field === "learner_token" || field === "learnerToken") {
        const identity = resolveIdentity(String(child));
        output[field === "learner_token" ? "learner_id" : "learnerId"] = identity.id;
        continue;
      }
      const resolvedKey = /^(?:Student A[1-9][0-9]*|learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.test(field)
        ? resolveIdentity(field).id : field;
      if (Object.hasOwn(output, resolvedKey)) throw new Error("privacy_identity_key_collision");
      Object.defineProperty(output, resolvedKey, { value: resolveValue(child, field, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return output;
  };
  return resolveValue(value) as Record<string, unknown>;
}

export function outputDescriptorDigest(descriptor: OutputPrivacyDescriptor | undefined): string {
  return sha256Text(canonicalJson(exactDescriptor(descriptor)));
}
