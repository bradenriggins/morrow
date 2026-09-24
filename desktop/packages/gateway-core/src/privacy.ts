import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { decodeHTML as decodeEntity } from "entities";
import {
  canonicalJson,
  isJsonObject,
  sha256Text,
  type JsonObject,
} from "@morrow/contracts";
import {
  canonicalPrivateStateFilePath,
  createExactPrivateStateFile,
  decodeExactUtf8,
  readExactPrivateStateFile,
  replaceExactPrivateStateFile,
  withExactPrivateStateFileTransaction,
} from "./private-state-file.js";

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

interface VaultState {
  readonly entries: Map<string, VaultEntry>;
  readonly byToken: Map<string, VaultEntry>;
  readonly byLabel: Map<string, VaultEntry>;
  readonly nextLabelByScope: Map<string, number>;
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

const MAX_LEARNER_VAULT_KEY_BYTES = 128;
const MAX_LEARNER_VAULT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LEARNER_VAULT_PLAINTEXT_BYTES = 48 * 1024 * 1024;
const MAX_LEARNER_VAULT_ENTRIES = 100_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const LEARNER_VAULT_KEY_OPTIONS = {
  label: "learner vault key",
  minBytes: 43,
  maxBytes: MAX_LEARNER_VAULT_KEY_BYTES,
} as const;
const LEARNER_VAULT_FILE_OPTIONS = {
  label: "learner vault",
  minBytes: 1,
  maxBytes: MAX_LEARNER_VAULT_FILE_BYTES,
} as const;
const LEARNER_VAULT_TRANSACTION_OPTIONS = { label: "learner vault" } as const;

function exactBase64Url(value: string, label: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(value)) throw new Error(`${label} is invalid`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || (expectedBytes !== undefined && bytes.length !== expectedBytes)) {
    throw new Error(`${label} is invalid`);
  }
  return bytes;
}

function parseLearnerVaultKey(content: Buffer): Buffer {
  const text = decodeExactUtf8(content, "learner vault key");
  if (!/^[A-Za-z0-9_-]{43}\n?$/u.test(text)) throw new Error("learner vault key is invalid");
  return exactBase64Url(text.endsWith("\n") ? text.slice(0, -1) : text, "learner vault key", 32);
}

function readOrCreateKey(pathValue: string, vaultExists: boolean): Buffer {
  const path = canonicalPrivateStateFilePath(pathValue, LEARNER_VAULT_KEY_OPTIONS.label);
  const existing = readExactPrivateStateFile(path, LEARNER_VAULT_KEY_OPTIONS);
  if (existing) return parseLearnerVaultKey(existing);
  if (vaultExists) throw new Error("learner vault key is unavailable for the saved vault");
  const key = randomBytes(32);
  const content = Buffer.from(`${key.toString("base64url")}\n`, "utf8");
  if (!createExactPrivateStateFile(path, content, LEARNER_VAULT_KEY_OPTIONS)) {
    throw new Error("learner vault key changed during its transaction");
  }
  return key;
}

function parseEnvelope(value: unknown): VaultEnvelope {
  if (!isJsonObject(value) || value.schema !== "morrow.learner-vault.v1"
    || Object.keys(value).sort().join(",") !== "ciphertext,iv,schema,tag") {
    throw new Error("learner vault has an unsupported format");
  }
  for (const key of ["iv", "tag", "ciphertext"] as const) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error("learner vault is invalid");
  }
  exactBase64Url(value.iv as string, "learner vault IV", 12);
  exactBase64Url(value.tag as string, "learner vault tag", 16);
  exactBase64Url(value.ciphertext as string, "learner vault ciphertext");
  return value as unknown as VaultEnvelope;
}

function emptyVaultState(): VaultState {
  return {
    entries: new Map(),
    byToken: new Map(),
    byLabel: new Map(),
    nextLabelByScope: new Map(),
  };
}

function nextVaultLabel(state: VaultState, scope: LearnerScope): string {
  const key = scopeKey(scope);
  let next = state.nextLabelByScope.get(key) ?? 1;
  while (state.byLabel.has(`${key}\0Student A${next}`)) next += 1;
  state.nextLabelByScope.set(key, next + 1);
  return `Student A${next}`;
}

function decodeVaultState(content: Buffer, key: Buffer): VaultState {
  const state = emptyVaultState();
  const envelope = parseEnvelope(JSON.parse(decodeExactUtf8(content, "learner vault")));
  const decipher = createDecipheriv("aes-256-gcm", key, exactBase64Url(envelope.iv, "learner vault IV", 12));
  decipher.setAuthTag(exactBase64Url(envelope.tag, "learner vault tag", 16));
  const plain = Buffer.concat([
    decipher.update(exactBase64Url(envelope.ciphertext, "learner vault ciphertext")),
    decipher.final(),
  ]);
  if (plain.length > MAX_LEARNER_VAULT_PLAINTEXT_BYTES) throw new Error("learner vault plaintext is oversized");
  const records = JSON.parse(decodeExactUtf8(plain, "learner vault plaintext")) as unknown;
  if (!Array.isArray(records) || records.length > MAX_LEARNER_VAULT_ENTRIES) {
    throw new Error("learner vault entries are invalid");
  }
  for (const value of records) {
    if (!isJsonObject(value) || typeof value.token !== "string" || !/^learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.token)
      || state.byToken.has(value.token) || !isJsonObject(value.scope) || !isJsonObject(value.identity)) {
      throw new Error("learner vault entry is invalid");
    }
    const scope = exactScope(value.scope as unknown as LearnerScope);
    const label = value.label === undefined ? nextVaultLabel(state, scope) : value.label;
    if (typeof label !== "string" || !/^Student A[1-9][0-9]*$/u.test(label)
      || state.byLabel.has(`${scopeKey(scope)}\0${label}`)) {
      throw new Error("learner vault label is invalid");
    }
    const entry: VaultEntry = {
      token: value.token,
      label,
      scope,
      identity: exactIdentity(value.identity as unknown as LearnerIdentity),
    };
    if (state.entries.has(identityKey(entry.scope, entry.identity))) {
      throw new Error("learner vault identity is duplicated");
    }
    state.entries.set(identityKey(entry.scope, entry.identity), entry);
    state.byToken.set(entry.token, entry);
    state.byLabel.set(`${scopeKey(scope)}\0${label}`, entry);
    const number = Number(label.slice("Student A".length));
    state.nextLabelByScope.set(
      scopeKey(scope),
      Math.max(state.nextLabelByScope.get(scopeKey(scope)) ?? 1, number + 1),
    );
  }
  return state;
}

function addVaultIdentities(
  state: VaultState,
  scope: LearnerScope,
  identities: readonly LearnerIdentity[],
): { readonly labels: readonly string[]; readonly changed: boolean } {
  let changed = false;
  const labels = identities.map((identity) => {
    const key = identityKey(scope, identity);
    const existing = state.entries.get(key);
    if (existing) return existing.label;
    let token: string;
    do { token = `learner_${randomUUID()}`; } while (state.byToken.has(token));
    const entry: VaultEntry = { token, label: nextVaultLabel(state, scope), scope, identity };
    state.entries.set(key, entry);
    state.byToken.set(entry.token, entry);
    state.byLabel.set(`${scopeKey(scope)}\0${entry.label}`, entry);
    changed = true;
    return entry.label;
  });
  return { labels, changed };
}

function persistVaultState(path: string, key: Buffer, state: VaultState): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(canonicalJson([...state.byToken.values()]), "utf8");
  if (state.byToken.size > MAX_LEARNER_VAULT_ENTRIES || plain.length > MAX_LEARNER_VAULT_PLAINTEXT_BYTES) {
    throw new Error("learner vault capacity is exceeded");
  }
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const envelope: VaultEnvelope = {
    schema: "morrow.learner-vault.v1",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  replaceExactPrivateStateFile(
    path,
    Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8"),
    LEARNER_VAULT_FILE_OPTIONS,
  );
}

export class LearnerVault {
  private readonly path: string;
  private readonly key: Buffer | null;
  private state: VaultState;

  constructor(pathValue = ":memory:") {
    this.path = pathValue === ":memory:"
      ? pathValue
      : canonicalPrivateStateFilePath(pathValue, "learner vault");
    if (this.path === ":memory:") {
      this.key = null;
      this.state = emptyVaultState();
    } else {
      const initial = withExactPrivateStateFileTransaction(this.path, LEARNER_VAULT_TRANSACTION_OPTIONS, () => {
        const content = readExactPrivateStateFile(this.path, LEARNER_VAULT_FILE_OPTIONS);
        const key = readOrCreateKey(keyPathFor(this.path), content !== null);
        return { key, state: content ? decodeVaultState(content, key) : emptyVaultState() };
      });
      this.key = initial.key;
      this.state = initial.state;
    }
  }

  tokenize(scopeValue: LearnerScope, identityValue: LearnerIdentity): string {
    return this.tokenizeMany(scopeValue, [identityValue])[0]!;
  }

  tokenizeMany(scopeValue: LearnerScope, identityValues: readonly LearnerIdentity[]): readonly string[] {
    return this.prepareTextReferences(scopeValue, identityValues).labels;
  }

  /**
   * Publishes any missing labels once, then returns the exact reference index
   * from that same durable vault snapshot for one privacy projection.
   */
  prepareTextReferences(scopeValue: LearnerScope, identityValues: readonly LearnerIdentity[]): {
    readonly labels: readonly string[];
    readonly referenceLabels: ReadonlyMap<string, string>;
  } {
    return this.prepareTextReferenceSets([{ scope: scopeValue, identities: identityValues }])[0]!;
  }

  /** Publishes several exact learner scopes in one durable vault transaction. */
  prepareTextReferenceSets(requests: readonly {
    readonly scope: LearnerScope;
    readonly identities: readonly LearnerIdentity[];
  }[]): readonly {
    readonly labels: readonly string[];
    readonly referenceLabels: ReadonlyMap<string, string>;
  }[] {
    const normalized = requests.map(({ scope, identities }) => ({
      scope: exactScope(scope),
      identities: identities.map(exactIdentity),
    }));
    let labelsByRequest: readonly (readonly string[])[];
    if (this.path === ":memory:") {
      labelsByRequest = normalized.map(({ scope, identities }) => addVaultIdentities(this.state, scope, identities).labels);
    } else {
      const result = withExactPrivateStateFileTransaction(this.path, LEARNER_VAULT_TRANSACTION_OPTIONS, () => {
        const state = this.readCurrentState();
        let changed = false;
        const labels = normalized.map(({ scope, identities }) => {
          const outcome = addVaultIdentities(state, scope, identities);
          changed ||= outcome.changed;
          return outcome.labels;
        });
        if (changed) persistVaultState(this.path, this.key!, state);
        return { labels, state };
      });
      this.state = result.state;
      labelsByRequest = result.labels;
    }
    return normalized.map(({ scope, identities }, index) => {
      const referenceLabels = new Map<string, string>();
      for (const identity of identities) {
        const entry = this.state.entries.get(identityKey(scope, identity));
        if (!entry) throw new Error("learner vault identity is unavailable after publication");
        referenceLabels.set(entry.token, entry.label);
        referenceLabels.set(entry.label, entry.label);
      }
      return { labels: labelsByRequest[index]!, referenceLabels };
    });
  }

  resolve(scopeValue: LearnerScope, tokenValue: string): LearnerIdentity {
    const scope = exactScope(scopeValue);
    const token = String(tokenValue || "").trim();
    if (this.path !== ":memory:") {
      this.state = withExactPrivateStateFileTransaction(
        this.path,
        LEARNER_VAULT_TRANSACTION_OPTIONS,
        () => this.readCurrentState(),
      );
    }
    const entry = this.state.byLabel.get(`${scopeKey(scope)}\0${token}`) ?? this.state.byToken.get(token);
    if (!entry || scopeKey(entry.scope) !== scopeKey(scope)) {
      throw new Error("learner token is unavailable for this exact scope");
    }
    return { ...entry.identity };
  }

  private readCurrentState(): VaultState {
    const keyContent = readExactPrivateStateFile(keyPathFor(this.path), LEARNER_VAULT_KEY_OPTIONS);
    if (!keyContent) throw new Error("learner vault key is unavailable");
    const key = parseLearnerVaultKey(keyContent);
    if (!key.equals(this.key!)) throw new Error("learner vault key changed after admission");
    const content = readExactPrivateStateFile(this.path, LEARNER_VAULT_FILE_OPTIONS);
    return content ? decodeVaultState(content, key) : emptyVaultState();
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
  /** Canvas course reads may include instructors and editors outside the student roster. */
  readonly allowUnrosteredCanvasIdentities?: boolean;
  /**
   * What to do with an address that named nobody on the roster. Reading provider
   * text removes it, so the reading itself can be returned. Text a person asked
   * Morrow to send refuses instead, because removing part of what they wrote
   * would change the thing being written.
   */
  readonly addresses?: "remove" | "refuse";
}

interface LearnerAlias {
  readonly token: string | null;
  /** Matches only where the text writes it with a capital letter. */
  readonly capitalized?: boolean;
}

interface PreparedLearnerTextRedactionContext extends LearnerTextRedactionContext {
  readonly identities: readonly LearnerIdentity[];
  readonly identityById: ReadonlyMap<string, LearnerIdentity>;
  readonly tokensById: ReadonlyMap<string, LearnerAlias>;
  readonly aliases: ReadonlyMap<string, LearnerAlias>;
  readonly aliasMatchers: readonly RegExp[];
  readonly referenceLabels: ReadonlyMap<string, string>;
  readonly identityByLabel: ReadonlyMap<string, LearnerIdentity>;
}

function mergeLearnerIdentity(left: LearnerIdentity, right: LearnerIdentity): LearnerIdentity {
  if (left.id !== right.id) throw new TypeError("learner identity does not match");
  for (const field of ["name", "email", "loginId", "sisUserId"] as const) {
    if (left[field] && right[field] && left[field] !== right[field]) {
      const knownAliases = [...(left.aliases ?? []), ...(field === "name" ? learnerNameAliases(left).aliases : [])].map(normalizeAlias);
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

// Rich-text editors and phones write a name's apostrophe or hyphen as another character, and
// people drop a name's accents. Both are folded away on the roster side and the text side.
// connector/extension/src/protected-request.js folds the same way, so the gateway and Morrow
// Bridge replace the same names.
const APOSTROPHE_VARIANTS = /[\u2018\u2019\u02bc\uff07\u0060\u00b4]/gu;
const HYPHEN_VARIANTS = /[\u2010-\u2013\ufe63\uff0d]/gu;
// Letters whose stroke or ligature is not a combining mark, so NFKD keeps them: Łukasz, Søren,
// Đorđe, Yıldız, Guðrún, Þór, Lætitia, Cœur, Weiß. People write these names without them.
const LETTER_FOLDS: ReadonlyMap<string, string> = new Map([
  ["ł", "l"], ["Ł", "L"], ["ø", "o"], ["Ø", "O"], ["đ", "d"], ["Đ", "D"], ["ı", "i"], ["ħ", "h"], ["Ħ", "H"],
  ["ŧ", "t"], ["Ŧ", "T"], ["ð", "d"], ["Ð", "D"], ["þ", "th"], ["Þ", "Th"], ["æ", "ae"], ["Æ", "AE"],
  ["œ", "oe"], ["Œ", "OE"], ["ß", "ss"], ["ẞ", "SS"],
]);
const FOLDED_LETTERS = /[łŁøØđĐıħĦŧŦðÐþÞæÆœŒßẞ]/gu;
// Invisible format characters that rich-text editors and word processors put
// inside a name: a soft hyphen, a zero-width space or joiner, a bidirectional
// mark, or a byte-order mark. They carry no word, so the match view on the
// roster side and the text side drops them.
const INVISIBLE_FORMAT_CHARACTERS = /[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/gu;

function foldIdentityText(value: string): string {
  return value.replace(APOSTROPHE_VARIANTS, "'").replace(HYPHEN_VARIANTS, "-")
    .replace(FOLDED_LETTERS, (letter) => LETTER_FOLDS.get(letter) ?? letter)
    .replace(INVISIBLE_FORMAT_CHARACTERS, "")
    .normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC");
}

function normalizeAlias(value: string): string {
  return foldIdentityText(value).trim().replace(/\s+/gu, " ").toLowerCase();
}

// Scripts that write words with no space between them, or that attach a particle to a name, as
// Korean does in 김민준의. A name written in one has no word edge. A name written in any other
// script still ends where a word of one of these begins, as in 请看Ada Lovelace的作业.
// An underscore is a word edge too, because Canvas builds page addresses and
// teachers name files from a name with its words joined by an underscore.
const UNSPACED_SCRIPT = "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}";
const UNSPACED_LETTER = new RegExp(`^[${UNSPACED_SCRIPT}]$`, "u");
const SPACED_WORD_CHARACTER = `(?![${UNSPACED_SCRIPT}])[\\p{L}\\p{N}]`;
const UNSPACED_GAP = new RegExp(`(?<=[${UNSPACED_SCRIPT}]) (?=[${UNSPACED_SCRIPT}])`, "gu");
// Arabic and Hebrew attach a one-letter prefix, such as "to" or "and", to the name that follows.
const PROCLITIC_LETTERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\p{scx=Arabic}$/u, "وفبكل"],
  [/^\p{scx=Hebrew}$/u, "ובכלמשה"],
];

/**
 * The lookup key of an alias. A space between two letters of an unspaced script is dropped,
 * because people write 佐藤花子 and 佐藤 花子 for one name.
 */
function aliasKey(value: string): string {
  return normalizeAlias(value).replace(UNSPACED_GAP, "");
}

function aliasBody(key: string): string {
  const points = [...key];
  let body = "";
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    if (previous !== undefined && UNSPACED_LETTER.test(previous) && UNSPACED_LETTER.test(point)) body += "\\s*";
    // A space in an alias also matches the joined spellings a title or a file
    // name carries, as Canvas's ada-lovelace-reflection for "Ada Lovelace
    // Reflection". One separator character, never a run, so "Ada. Lovelace"
    // across a sentence end does not match.
    body += point === " " ? "(?:\\s+|\\.|-|_)" : escapeRegExp(point);
  }
  return body;
}

/** The word edges an alias key needs on each side to be a whole name. */
function aliasEdges(key: string): readonly [string, string] {
  const points = [...key];
  const first = points[0] ?? "";
  const last = points.at(-1) ?? "";
  const edge = `(?<!${SPACED_WORD_CHARACTER})`;
  const proclitic = PROCLITIC_LETTERS.find(([script]) => script.test(first))?.[1];
  const before = UNSPACED_LETTER.test(first) ? "" : proclitic ? `(?:${edge}|(?<=${edge}[${proclitic}]))` : edge;
  const after = UNSPACED_LETTER.test(last) ? "" : `(?!${SPACED_WORD_CHARACTER})`;
  return [before, after];
}

/**
 * One matcher for each kind of word edge, so each edge is tested once at a position rather than
 * once for every alias. Within a matcher the longest alias is tried first.
 */
function aliasMatchers(keys: Iterable<string>): readonly RegExp[] {
  const groups = new Map<string, { readonly edges: readonly [string, string]; readonly keys: string[] }>();
  for (const key of keys) {
    if (!key) continue;
    const edges = aliasEdges(key);
    const group = groups.get(edges.join("\u0000")) ?? { edges, keys: [] };
    group.keys.push(key);
    groups.set(edges.join("\u0000"), group);
  }
  return [...groups.values()].map(({ edges: [before, after], keys: grouped }) => new RegExp(
    `${before}(?:${grouped.sort((left, right) => right.length - left.length).map(aliasBody).join("|")})${after}`,
    "giu",
  ));
}

/** Every alias the matchers find, leftmost first and the longest where two start together. */
function aliasMatches(text: string, matchers: readonly RegExp[]): Array<{ readonly index: number; readonly text: string }> {
  const found = matchers.flatMap((matcher) => [...text.matchAll(matcher)].map((match) => ({ index: match.index!, text: match[0] })))
    .sort((left, right) => left.index - right.index || right.text.length - left.text.length);
  const output: Array<{ readonly index: number; readonly text: string }> = [];
  let cursor = 0;
  for (const match of found) {
    if (match.index < cursor) continue;
    output.push(match);
    cursor = match.index + match.text.length;
  }
  return output;
}

// A generational suffix ends a name but is never the family name.
const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv|v)\.?$/u;

// A title leads a roster name but is never a word of it. Alone in prose it
// names the person it addresses, such as the course's teacher, so it never
// starts the given name and never stands for a student on its own.
const NAME_TITLE = /^(?:mr|mrs|ms|mx|miss|madam|sir|dr|doctor|prof|professor|rev|hon)\.?$/u;

// A family-name particle sits inside a name, as van in "Ana van der Berg".
// Alone in prose it is an ordinary word, so it never stands for a student
// on its own either.
const NAME_PARTICLE = /^(?:van|von|der|den|del|della|dos|ter|ten|zur|vom|bin|ibn|bint|abu)\.?$/u;

// A Korean or Chinese roster name is often stored with no space, as 김민준 or 王小明, and a
// Japanese one as 田中太郎. Its family name comes first: one syllable or character, or one of these
// two-letter family names. A Japanese four-character name is two and two.
// connector/extension/src/protected-request.js splits the same way.
const KOREAN_TWO_SYLLABLE_FAMILY_NAMES: ReadonlySet<string> = new Set(["남궁", "황보", "제갈", "선우", "독고", "사공", "서문", "동방"]);
const HAN_TWO_CHARACTER_FAMILY_NAMES: ReadonlySet<string> = new Set([
  "欧阳", "歐陽", "司马", "司馬", "上官", "诸葛", "諸葛", "东方", "東方", "皇甫", "尉迟", "尉遲", "公孙", "公孫",
  "慕容", "令狐", "长孙", "長孫", "宇文", "司徒", "夏侯", "轩辕", "軒轅", "端木", "独孤", "獨孤", "南宫", "南宮",
  "西门", "西門", "钟离", "鍾離", "澹台", "澹臺", "呼延", "赫连", "赫連", "百里", "闻人", "聞人", "申屠", "拓跋",
  "单于", "單于",
]);

/** The family name and the given name of a one-word Hangul or Han name, or null for any other name. */
function unspacedNameParts(name: string): readonly [string, string] | null {
  const points = [...name];
  const firstTwo = points.slice(0, 2).join("");
  let familyLength: number;
  if (/^\p{Script=Hangul}{2,4}$/u.test(name)) {
    familyLength = points.length >= 3 && KOREAN_TWO_SYLLABLE_FAMILY_NAMES.has(firstTwo) ? 2 : 1;
  } else if (/^\p{Script=Han}{3,4}$/u.test(name)) {
    familyLength = points.length === 4 || HAN_TWO_CHARACTER_FAMILY_NAMES.has(firstTwo) ? 2 : 1;
  } else {
    return null;
  }
  return [points.slice(0, familyLength).join(""), points.slice(familyLength).join("")];
}

function nameWords(value: string): string[] {
  const words = value.replace(/,/gu, " ").split(" ").filter(Boolean);
  while (words.length > 1 && NAME_SUFFIX.test(words.at(-1)!)) words.pop();
  return words;
}

interface LearnerNameAliases {
  readonly aliases: readonly string[];
  /**
   * A one-word given or family name used alone. Written in small letters it is
   * usually an ordinary word, such as will, grace, long, or page, and a label
   * there would come back as the student's full name in text the assistant
   * saves. A one-word roster name is the whole name and is not listed here.
   */
  readonly capitalized: ReadonlySet<string>;
}

/** A roster field that reads like a person's name, not an id, an address, or a username. */
function nameLikeForm(value: string): boolean {
  return /^[\p{L}][\p{L}\p{M}\p{N}\u00ad\u200b-\u200f\u2060-\u2064\ufeff' ,.\u2019-]{0,499}$/u.test(value.trim());
}

/** The one parsed name form: the given name, every family word it names, and whether the form names the family part. */
function parsedNameForm(form: string): {
  readonly words: readonly string[];
  readonly familyWords: readonly string[];
  readonly given: string;
  readonly familyFirst: boolean;
} | null {
  const name = normalizeAlias(form);
  if (!name || name.length > 500) return null;
  const comma = /^([^,]+),\s*(.+)$/u.exec(name);
  const familyFirst = comma && !NAME_SUFFIX.test(comma[2]!) ? comma : null;
  const words = givenWords(familyFirst ? familyFirst[2]! : name);
  if (words.length === 0) return null;
  // A comma form, and a Moodle lastname field, name the family part. A name
  // the roster gives with no such field says nothing about its family part, so
  // only its last word is taken, and each word after the given name still
  // names this student on its own.
  const familyWords = familyFirst
    ? givenWords(familyFirst[1]!)
    : words.length > 1
      ? [words.at(-1)!]
      : [];
  return { words, familyWords, given: words[0]!, familyFirst: familyFirst !== null };
}

/** The words of a name, without any title that leads them. */
function givenWords(value: string): string[] {
  const words = nameWords(value);
  while (words.length > 1 && NAME_TITLE.test(words[0]!)) words.shift();
  return words;
}

function learnerNameAliases(identity: LearnerIdentity): LearnerNameAliases {
  const none = { aliases: [], capitalized: new Set<string>() };
  if (!identity.name) return none;
  // Every name form the roster gives, as Canvas's sortable_name or Moodle's
  // lastname, can name the family part. Only forms that read like a name are
  // parsed; ids and usernames are matched whole instead.
  const forms = [identity.name, ...(identity.aliases ?? [])].filter(
    (form): form is string => typeof form === "string" && nameLikeForm(form),
  );
  if (!forms.length) return none;
  const name = normalizeAlias(identity.name);
  const aliases = new Set<string>();
  const capitalized = new Set<string>();
  const addPart = (part: string): void => {
    // A title or a particle alone is prose, not a reference to one student.
    if (part.includes(" ") || !(NAME_TITLE.test(part) || NAME_PARTICLE.test(part))) {
      if ((part.match(/\p{L}/gu)?.length ?? 0) >= 2 && part !== name) aliases.add(part);
    }
  };
  for (const form of forms) {
    // An invisible character can sit where the roster meant a space, as a word
    // processor does. Parse the words from the form with those characters as
    // spaces, and record the form both as it is written and spaced.
    const wording = form.replace(INVISIBLE_FORMAT_CHARACTERS, " ");
    const parsed = parsedNameForm(wording);
    if (!parsed) continue;
    aliases.add(normalizeAlias(form));
    if (wording !== form) aliases.add(normalizeAlias(wording));
    const { words, familyWords, given } = parsed;
    const family = familyWords.join(" ");
    // A one-word given or family name used alone. Written in small letters it
    // is usually an ordinary word, so it is replaced only where it is written
    // as a name.
    for (const part of [given, family, ...familyWords]) {
      addPart(part);
      if (aliases.has(part) && !part.includes(" ")) capitalized.add(part);
    }
    // A name of three or more words with no family-name field: each word after
    // the given name, which also covers a middle name.
    if (form === identity.name && words.length >= 3) {
      for (const word of words.slice(1)) {
        addPart(word);
        if (aliases.has(word)) capitalized.add(word);
      }
    }
    const unspaced = !parsed.familyFirst && nameWords(name).length === 1 ? unspacedNameParts(name) : null;
    for (const part of unspaced ?? []) {
      if ([...part].length >= 2) aliases.add(part);
    }
    if (parsed.familyFirst) aliases.add(`${parsed.words.join(" ")} ${parsed.familyWords.join(" ")}`);
    if (!parsed.familyFirst && parsed.words.length >= 2 && parsed.familyWords.length === 1) {
      // "Jane Alexandra Doe" is addressed as "Jane Doe" too: the first and last
      // name without a middle name.
      aliases.add(`${given} ${family}`);
      if (parsed.words.length === 2) aliases.add(`${parsed.words[1]!} ${given}`);
    }
  }
  capitalized.delete(name);
  return { aliases: [...aliases], capitalized: new Set([...capitalized].filter((part) => aliases.has(part))) };
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
  readonly spans: readonly SourceSpan[] | null;
}

interface SourceAtom extends SourceSpan {
  readonly text: string;
}

interface SourceReplacement extends SourceSpan {
  readonly replacement: string;
}

// Every HTML5 named character reference decodes with the same rules a browser
// uses, with case-sensitive names such as &Eacute; beside &eacute;, so a name
// written as references matches the name as it is written.
const NAMED_ENTITY = /^&([a-z0-9]+);/iu;

function decodedNamedEntity(source: string): string | null {
  let decoded: string;
  try {
    decoded = decodeEntity(source);
  } catch {
    return null;
  }
  return decoded === source ? null : decoded;
}

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
  // The source and match views have the same UTF-16 offsets when the text has
  // no encoded representation and normalization changes no code units. This
  // is the dominant provider-response path, so do not allocate one source span
  // per code unit or segment every grapheme unless a mapped view is required.
  if (!/[&%]/u.test(value) && foldIdentityText(value) === value) {
    return { text: value, spans: null };
  }

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
    const named = NAMED_ENTITY.exec(value.slice(cursor));
    if (named) {
      const decoded = decodedNamedEntity(named[0]);
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
    appendCodePoints(normalized, foldIdentityText(segment.segment), start, end);
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
  if (start < 0 || end < start || end > view.text.length) return null;
  if (view.spans === null) return start === end ? null : { start, end };
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

function addAlias(aliases: Map<string, LearnerAlias>, alias: string, token: string, capitalized = false): void {
  const key = aliasKey(alias);
  if (!key) return;
  const existing = aliases.get(key);
  aliases.set(key, {
    token: existing && existing.token !== token ? null : token,
    ...(capitalized && (!existing || existing.capitalized === true) ? { capitalized: true } : {}),
  });
}

function replaceKnownAliases(
  value: string,
  aliases: ReadonlyMap<string, LearnerAlias>,
  matchers: readonly RegExp[],
): string {
  if (matchers.length === 0) return value;
  const view = normalizedIdentityTextView(value);
  const replacements: SourceReplacement[] = [];
  const references = [...view.text.matchAll(/\bStudent A[1-9][0-9]*\b/gu)];
  for (const match of aliasMatches(view.text, matchers)) {
    if (references.some((reference) => match.index >= reference.index! && match.index < reference.index! + reference[0].length)) continue;
    const key = aliasKey(match.text);
    // The match may carry the joined spelling a page address or a file name
    // uses, as ada-lovelace for "Ada Lovelace". The alias is recorded under
    // its spaced key, so the lookup folds the separator back to the space.
    const alias = aliases.get(key) ?? (/[._-]/u.test(key) ? aliases.get(key.replace(/[._-]+/gu, " ")) : undefined);
    // A script with no capital letters cannot mark a name, so only a match written in small
    // letters of a cased script is left as the ordinary word it usually is.
    if (alias?.capitalized === true && !/[\p{Lu}\p{Lt}]/u.test(match.text) && /\p{Ll}/u.test(match.text)) continue;
    const source = sourceRangeForView(view, match.index, match.index + match.text.length);
    if (!source) continue;
    replacements.push({
      ...source,
      replacement: alias?.token ?? "[learner]",
    });
  }
  return applySourceReplacements(value, replacements);
}

// A number this long in prose is a platform id, not a count or a score. A word
// before it that names a course object says whose id it is.
const BARE_LEARNER_ID = /(?<![\p{L}\p{N}_/=.#:%&-])([0-9]{5,500})(?![\p{L}\p{N}_/.%])/gu;
const BARE_OBJECT_WORD = /\b(?:course|courses|assignment|assignments|quiz|quizzes|module|modules|page|pages|file|files|section|sections|group|groups|item|items|question|questions|rubric|outcome|term|account|attempt|version|order|room|zip|phone|ext)\s*$/iu;

function replaceKnownIdentityReferences(
  value: string,
  identities: ReadonlyMap<string, LearnerAlias>,
  bareIds = false,
): string {
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
  output = replaceLinkedIdentityReferences(output, lookup);
  if (!bareIds) return output;
  const view = normalizedIdentityTextView(output);
  const replacements: SourceReplacement[] = [];
  for (const match of view.text.matchAll(BARE_LEARNER_ID)) {
    const token = lookup(match[1]!);
    if (!token || BARE_OBJECT_WORD.test(view.text.slice(Math.max(0, match.index! - 40), match.index!))) continue;
    const source = sourceRangeForView(view, match.index!, match.index! + match[1]!.length);
    if (source) replacements.push({ ...source, replacement: token });
  }
  return replacements.length ? applySourceReplacements(output, replacements) : output;
}

// A numeric path segment after one of these names a course object, never a
// person. Every other container is treated as a person route, so a learner id
// in a route Morrow has not seen before is still replaced.
const LINK_OBJECT_CONTAINERS = new Set([
  "api", "v1", "courses", "course", "accounts", "account", "terms", "sections", "section", "enrollments",
  "assignments", "assignment", "assignment_groups", "quizzes", "quiz", "quiz_submissions", "attempts", "questions",
  "question_banks", "assessment_questions", "item_banks", "banks", "bank_entries", "items", "modules", "module",
  "pages", "page", "files", "file", "folders", "attachments", "attachment", "media_objects", "media_attachments",
  "thumbnails", "images", "discussion_topics", "discussions", "entries", "replies", "announcements", "conversations",
  "groups", "group_categories", "rubrics", "rubric_associations", "outcomes", "outcome_groups", "external_tools",
  "tools", "calendar_events", "collaborations", "content_migrations", "migrations", "blueprint_templates",
  "grading_periods", "grading_standards", "reports", "progress", "versions", "revisions", "contexts", "context",
  "pluginfile.php", "draftfile.php", "tokenpluginfile.php", "webservice", "draft", "content", "intro", "post",
]);

const LINK_PERSON_QUERY_KEY = /^(?:(?:[a-z]+_)?(?:user|student|learner|author|recipient|participant|member|observee|relateduser)s?_?ids?|user|users|student|students|learner|learners|uid)$/u;

// Moodle names the person by a plain `id` only on its person pages.
const MOODLE_PERSON_ROUTE = /\/(?:user\/(?:view|profile|edit|editadvanced)\.php|mod\/forum\/user\.php|message\/index\.php|report\/(?:outline|log|completion)\/user\.php|blog\/index\.php)$/u;

/**
 * Replaces a learner's platform id wherever a link carries it: a numeric path
 * segment after any container that does not name a course object, a query
 * value under a person key, and Moodle's `id` on its person pages. Only ids on
 * this roster change, so an object id that equals a learner id elsewhere in the
 * same link is kept.
 */
function replaceLinkedIdentityReferences(value: string, lookup: (id: string) => string | null): string {
  const view = normalizedIdentityTextView(value);
  const replacements: SourceReplacement[] = [];
  const replace = (start: number, id: string): void => {
    const token = lookup(id);
    if (!token) return;
    const source = sourceRangeForView(view, start, start + id.length);
    if (source) replacements.push({ ...source, replacement: token });
  };
  for (const match of view.text.matchAll(/(\/([A-Za-z_][A-Za-z0-9_.~-]{0,80})\/)([0-9]{1,500})(?![0-9A-Za-z_])/gu)) {
    const container = match[2]!.toLocaleLowerCase("en-US");
    if (LINK_OBJECT_CONTAINERS.has(container) || /^(?:mod|block|core|local|tool|report|qtype|assignsubmission|assignfeedback)_/u.test(container)) continue;
    replace(match.index! + match[1]!.length, match[3]!);
  }
  for (const match of view.text.matchAll(/([?&;]([A-Za-z_][A-Za-z0-9_.-]{0,80})(?:\[\]|%5B%5D)?=)([0-9]{1,500})(?![0-9A-Za-z_])/gu)) {
    const key = match[2]!.toLocaleLowerCase("en-US");
    const person = LINK_PERSON_QUERY_KEY.test(key) || (key === "id" && (() => {
      const before = view.text.slice(0, match.index!);
      const link = before.slice(Math.max(...[" ", "\n", "\t", "\"", "'", "<", ">", "("].map((mark) => before.lastIndexOf(mark))) + 1);
      return MOODLE_PERSON_ROUTE.test(link.split("?")[0]!);
    })());
    if (person) replace(match.index! + match[1]!.length, match[3]!);
  }
  return replacements.length ? applySourceReplacements(value, replacements) : value;
}

interface LearnerTextPreparation {
  readonly context: LearnerTextRedactionContext;
  readonly scope: LearnerScope;
  readonly identities: readonly LearnerIdentity[];
}

function learnerTextPreparation(context: LearnerTextRedactionContext): LearnerTextPreparation {
  const scope = exactScope(context.learnerScope);
  if (!context.learnerRoster.isReady(scope)) throw new Error("learner_roster_scope_unavailable");
  const identities = context.learnerRoster.identities(scope);
  return { context, scope, identities };
}

function preparedLearnerTextContext(
  preparation: LearnerTextPreparation,
  preparedReferences: {
    readonly labels: readonly string[];
    readonly referenceLabels: ReadonlyMap<string, string>;
  },
): PreparedLearnerTextRedactionContext {
  const { context, scope, identities } = preparation;
  const identityById = new Map(identities.map((identity) => [identity.id, identity]));
  const tokensById = new Map<string, LearnerAlias>();
  const identityByLabel = new Map<string, LearnerIdentity>();
  const aliases = new Map<string, LearnerAlias>();
  const labels = preparedReferences.labels;
  for (const [index, identity] of identities.entries()) {
    const token = labels[index]!;
    tokensById.set(identity.id, { token });
    identityByLabel.set(token, identity);
    // A bare numeric alias has no person meaning in prose. Typed identity fields
    // and contextual references still resolve it through identityById.
    if (!/^[0-9]+$/u.test(identity.id)) addAlias(aliases, identity.id, token);
    const names = learnerNameAliases(identity);
    for (const alias of names.aliases) addAlias(aliases, alias, token, names.capitalized.has(alias));
    if (identity.email) addAlias(aliases, identity.email, token);
    if (identity.loginId) addAlias(aliases, identity.loginId, token);
    if (identity.sisUserId) addAlias(aliases, identity.sisUserId, token);
    for (const alias of identity.aliases ?? []) addAlias(aliases, alias, token);
  }
  return {
    learnerRoster: context.learnerRoster,
    learnerVault: context.learnerVault,
    learnerScope: scope,
    ...(context.allowUnrosteredCanvasIdentities === true ? { allowUnrosteredCanvasIdentities: true } : {}),
    ...(context.addresses ? { addresses: context.addresses } : {}),
    identities,
    identityById,
    tokensById,
    aliases,
    aliasMatchers: aliasMatchers(aliases.keys()),
    referenceLabels: preparedReferences.referenceLabels,
    identityByLabel,
  };
}

function prepareLearnerTextContexts(
  contexts: readonly LearnerTextRedactionContext[],
): readonly PreparedLearnerTextRedactionContext[] {
  const preparations = contexts.map(learnerTextPreparation);
  const output: PreparedLearnerTextRedactionContext[] = new Array(preparations.length);
  const byVault = new Map<LearnerVault, Array<{ readonly index: number; readonly preparation: LearnerTextPreparation }>>();
  for (const [index, preparation] of preparations.entries()) {
    const grouped = byVault.get(preparation.context.learnerVault) ?? [];
    grouped.push({ index, preparation });
    byVault.set(preparation.context.learnerVault, grouped);
  }
  for (const [vault, grouped] of byVault) {
    const references = vault.prepareTextReferenceSets(grouped.map(({ preparation }) => ({
      scope: preparation.scope,
      identities: preparation.identities,
    })));
    for (const [groupIndex, item] of grouped.entries()) {
      output[item.index] = preparedLearnerTextContext(item.preparation, references[groupIndex]!);
    }
  }
  return output;
}

function prepareLearnerTextContext(context: LearnerTextRedactionContext): PreparedLearnerTextRedactionContext {
  return prepareLearnerTextContexts([context])[0]!;
}

/**
 * Replaces only identities registered for this exact roster scope. It does not
 * try to infer arbitrary names. Callers must register the complete roster for
 * the current course and principal before forwarding learner text.
 */
export function redactKnownLearnerText(value: string, context: LearnerTextRedactionContext): string {
  if (typeof value !== "string") throw new TypeError("learner text is invalid");
  return redactKnownLearnerTextPrepared(value, prepareLearnerTextContext(context));
}

interface LearnerTextRedactionShape {
  /**
   * Whether a string that is exactly a numeric platform id names a person.
   * A value under a measure-shaped key such as `score` or `page` is a number
   * that happens to equal an id, never a bare person reference.
   */
  readonly wholeNumericIdIsIdentity: boolean;
}

const DEFAULT_TEXT_SHAPE: LearnerTextRedactionShape = Object.freeze({ wholeNumericIdIsIdentity: true });
const NON_IDENTITY_TEXT_SHAPE: LearnerTextRedactionShape = Object.freeze({ wholeNumericIdIsIdentity: false });

function redactKnownLearnerTextPrepared(
  value: string,
  exactContext: PreparedLearnerTextRedactionContext,
  shape: LearnerTextRedactionShape = DEFAULT_TEXT_SHAPE,
): string {
  if (/^(?:moodle|mod|block|enrol|report)\/[a-z_]+:[a-z_]+$/u.test(value)) return value;
  if (/^\s*[\[{]/u.test(value)) {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { /* Ordinary prose is matched below. */ }
    if (Array.isArray(parsed) || isJsonObject(parsed)) return JSON.stringify(redactLearnerEgressPrepared(parsed, exactContext));
  }
  value = value.replace(/\b(?:Student A[1-9][0-9]*|learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gu, (reference) => {
    const label = exactContext.referenceLabels.get(reference);
    if (label) return label;
    // Morrow's own label vocabulary comes back in course prose, because people paste an
    // answer into an announcement or a comment. A label that names nobody on this roster
    // follows the unrostered-address rule: a reading replaces it with the marker, and the
    // strict projection a planned write is checked against refuses instead.
    if (exactContext.addresses === "refuse") throw new Error("learner_roster_identity_unavailable");
    return "[learner]";
  });
  // A string that is exactly a numeric platform id names a person: a recipient list entry or a
  // cache value carries people that way, with nothing around the number to say so.
  const wholeId = value.trim();
  if (shape.wholeNumericIdIsIdentity && /^[0-9]+$/u.test(wholeId) && exactContext.tokensById.has(wholeId)) {
    return value.replace(wholeId, exactContext.tokensById.get(wholeId)!.token ?? "[learner]");
  }
  return replaceKnownIdentityReferences(
    replaceKnownAliases(value, exactContext.aliases, exactContext.aliasMatchers),
    exactContext.tokensById,
    shape.wholeNumericIdIsIdentity,
  );
}

/**
 * A string under a measure- or status-shaped key is still text a provider
 * controls. Its key shape only says a bare number there is not a person; it
 * never exempts the value from roster redaction or the sensitive-text
 * refusal, so `grading_status: "Submitted by jane@school.test"` cannot leave.
 */
function projectNonIdentityText(value: string, exactContext: PreparedLearnerTextRedactionContext | undefined): string {
  const redacted = exactContext ? redactKnownLearnerTextPrepared(value, exactContext, NON_IDENTITY_TEXT_SHAPE) : value;
  const output = withoutUnrosteredAddresses(redacted, exactContext?.addresses);
  if (containsSensitiveText(output)) throw new Error("privacy_sensitive_text_refused");
  return output;
}

function nonIdentityScalar(key: string): boolean {
  return /^(?:(?:course|assignment|quiz|module|section|file|page|discussion|topic|question|item|group|rubric|context|account|target)[_.]?(?:id|count)|(?:parent)?sectionid|sectionnumber|sectionlist|cmlist|section|number|visibility|option[_.]?(?:label|value)|.*(?:score|grade|points|count|total|rows|limit|size|length|percent|status|generation|revision|index|timestamp|duration|attempt|page)|depth)$/iu.test(key);
}

function exactNumericAvailableOption(key: string, value: string): boolean {
  return /^available(?:_|[A-Z])[A-Za-z0-9_]*$/u.test(key) && /^[0-9]+$/u.test(value);
}

function exactNumericEnumOption(value: JsonObject): boolean {
  return typeof value.label === "string" && value.label === value.value && /^[0-9]+$/u.test(value.label);
}

function exactGradeDefinition(value: JsonObject): boolean {
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !["type", "maximum_points", "scale_id"].includes(key))) return false;
  if (!["none", "point", "scale"].includes(String(value.type))) return false;
  if (value.maximum_points !== undefined && (typeof value.maximum_points !== "number" || !Number.isFinite(value.maximum_points))) return false;
  if (value.scale_id !== undefined && !(/^[1-9][0-9]*$/u.test(String(value.scale_id)) || (Number.isSafeInteger(value.scale_id) && Number(value.scale_id) > 0))) return false;
  return true;
}

const RESOURCE_CONTAINER_KIND = new Map<string, string>([
  ["courses", "course"],
  ["assignments", "assignment"],
  ["quizzes", "quiz"],
  ["modules", "module"],
  ["activities", "module"],
  ["sections", "section"],
  ["files", "file"],
  ["pages", "page"],
  ["discussions", "discussion"],
  ["topics", "topic"],
  ["questions", "question"],
  ["items", "item"],
  ["groups", "group"],
  ["rubrics", "rubric"],
  ["contexts", "context"],
  ["accounts", "account"],
]);

/**
 * The label the prepared snapshot already published for one roster identity.
 * Vault labels are keyed by scope and id alone, so a record's extra identity
 * fields never change the answer, and no durable transaction reopens per
 * record. Only an identity outside the snapshot asks the vault.
 */
function snapshotLearnerToken(context: PreparedLearnerTextRedactionContext, identity: LearnerIdentity): string {
  return context.tokensById.get(identity.id)?.token ?? context.learnerVault.tokenize(context.learnerScope, identity);
}

/** The roster identity a token or label names in the prepared snapshot; the vault answers only for one outside it. */
function snapshotLearnerIdentity(context: PreparedLearnerTextRedactionContext, token: string): LearnerIdentity {
  const label = context.referenceLabels.get(token);
  const known = label === undefined ? undefined : context.identityByLabel.get(label);
  return known ?? context.learnerVault.resolve(context.learnerScope, token);
}

function redactLearnerNumber(value: number, key: string, context: PreparedLearnerTextRedactionContext): number | string {
  // Numeric measures and explicitly typed course resources are not user IDs.
  if (nonIdentityScalar(key)) return value;
  const identity = context.identityById.get(String(value));
  return identity ? snapshotLearnerToken(context, identity) : value;
}

function redactLearnerKey(key: string, context: PreparedLearnerTextRedactionContext): string {
  if (["schema", "provider", "course", "name", "id", "title", "type", "tool", "code", "status", "data", "result", "content", "text", "learnerToken", "student", "user", "author", "participant", "students", "users", "authors", "participants", "grade", "score"].includes(key)
    || nonIdentityScalar(key)) return key;
  const identity = context.identityById.get(key);
  const output = withoutUnrosteredAddresses(identity ? snapshotLearnerToken(context, identity) : redactKnownLearnerTextPrepared(key, context), context.addresses);
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
  /** Verified Canvas course reads can contain instructors and editors outside the student roster. */
  readonly allowUnrosteredCanvasIdentities?: boolean;
}

export interface ProjectedOutput {
  readonly content: readonly JsonObject[];
  readonly structuredContent?: JsonObject;
}

type IdentityRecordKind = "learner" | "student" | "user" | "author" | "enrollment" | "submission" | "grade" | "recipient" | "member";

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
  ["participant", "user"], ["participants", "user"], ["author", "author"], ["authors", "author"],
  ["lasteditedby", "author"], ["editor", "author"], ["createdby", "author"], ["updatedby", "author"],
  ["recipient", "recipient"], ["recipients", "recipient"], ["member", "member"], ["members", "member"],
  ["membership", "member"], ["memberships", "member"],
]);
// A field named for a credential never crosses this boundary, whatever its
// value looks like. `token`, `key` and `signature` stand for the whole family:
// access_token, refresh_token, api_key, consumer_key and private_key are all
// credentials a provider record can carry, and narrowing any of them to one
// spelling lets the next spelling through. The normalized set repeats the same
// names without separators, because the regex boundaries cannot see the word
// break in `apiKey` or `consumerKey`.
const SECRET_FIELD = /(?:^|_)(?:authorization|bearer|token|csrf|cookie|secret|credential|jwt|password|api_key|consumer_key|private_key|signature)(?:$|_)/i;
const SECRET_FIELD_NORMALIZED = new Set([
  "authorization", "bearer", "accesstoken", "refreshtoken", "sessiontoken", "token", "csrf", "cookie",
  "secret", "credential", "jwt", "password", "apikey", "consumerkey", "privatekey", "signature",
  "privateattachment", "bytesbase64",
]);

function privacyError(code: string): JsonObject {
  return {
    content: [{ type: "text", text: "Morrow refused unsafe upstream output." }],
    isError: true,
    structuredContent: { schema: "morrow.problem.v1", code, recoverable: false },
  };
}

function sanitizedUpstreamError(value: JsonObject): JsonObject {
  const output = privacyError("upstream_error_sanitized");
  const structured = isJsonObject(value.structuredContent) ? value.structuredContent : undefined;
  if (structured?.schema !== "morrow.canvas-connector.result.v1" || structured.ok !== false) return output;
  const candidate = structured.providerFailure;
  // A change carries no provider failure record, only the named reason below.
  const providerFailure = isJsonObject(candidate)
    && candidate.schema === "morrow.canvas-browser-failure.v1"
    && ["canvas", "moodle"].includes(String(candidate.provider))
    && typeof candidate.sent === "boolean"
    && (candidate.status === undefined
      || (Number.isInteger(candidate.status) && Number(candidate.status) >= 100 && Number(candidate.status) <= 599))
    && !Object.keys(candidate).some((key) => !["schema", "provider", "sent", "status"].includes(key))
    ? candidate
    : undefined;
  if (candidate !== undefined && providerFailure === undefined) return output;
  const resultState = ["not_sent", "unknown"].includes(String(structured.resultState))
    ? structured.resultState
    : undefined;
  const sourceProblem = isJsonObject(structured.problem) ? structured.problem : undefined;
  const namedReason = (value: unknown): string | undefined => (
    typeof value === "string" && /^[a-z][a-z0-9_]{0,99}$/u.test(value) ? value : undefined
  );
  const sourceCode = sourceProblem?.schema === "morrow.bridge.problem.v1"
    ? namedReason(sourceProblem.code)
    : undefined;
  // Morrow's own name for a request it refused before sending. It is a token
  // from Morrow's code, never provider output, so it crosses this boundary.
  const sourceRefusal = sourceProblem?.schema === "morrow.bridge.problem.v1"
    ? namedReason(sourceProblem.refusal)
    : undefined;
  if (providerFailure === undefined && sourceCode === undefined && sourceRefusal === undefined) return output;
  output.structuredContent = {
    ...(output.structuredContent as JsonObject),
    ...(typeof sourceProblem?.recoverable === "boolean" ? { recoverable: sourceProblem.recoverable } : {}),
    ...(providerFailure === undefined ? {} : { providerFailure: structuredClone(providerFailure) }),
    ...(resultState === undefined ? {} : { resultState }),
    ...(sourceCode === undefined ? {} : { sourceCode }),
    ...(sourceRefusal === undefined ? {} : { sourceRefusal }),
  };
  // The provider body was dropped, but its validated status is not unsafe
  // output. A missing item after a delete is the expected readback, so the
  // text names what the provider answered instead of reporting a refusal.
  if (providerFailure !== undefined) output.content = [{ type: "text", text: providerFailureText(providerFailure) }];
  else if (sourceCode !== undefined) output.content = [{ type: "text", text: bridgeProblemText(sourceCode) }];
  return output;
}

/** Morrow Bridge is not connected to the Morrow app, so no course request can reach the course. */
export const BRIDGE_NOT_CONNECTED_TEXT = "Morrow Bridge is not connected to Morrow, so Morrow could not reach the course. Open Chrome and open the Morrow Bridge popup, which shows the step that connects it. Then ask again.";

/**
 * The fixed sentence for a request Morrow Bridge answered with one of Morrow's
 * own reasons. The Bridge's message can name the course, so it is dropped at
 * this boundary and the reason is named from its code alone.
 */
function bridgeProblemText(code: string): string {
  switch (code) {
    case "bridge_unavailable":
      return BRIDGE_NOT_CONNECTED_TEXT;
    case "bridge_port_in_use":
      return "Another Morrow is already connected to Morrow Bridge, so this Morrow could not reach the course. Close the other Morrow, or use one Morrow for all your assistants.";
    // The same words Morrow Bridge shows for this code (connector/extension/src/bridge-problem-copy.js).
    case "canvas_binding_required":
      return "Morrow sent nothing, because the signed-in Canvas or Moodle tab for this course is closed, signed out, or showing another page. Open the course in Canvas or Moodle and sign in, then ask again. If the course is closed, select Open Canvas or Open Moodle in the Morrow Bridge popup.";
    case "course_binding_mismatch":
      return "This request names a course that is not the one this Morrow connection carries, so Morrow sent nothing to the course. Connect that course in Morrow Bridge, or ask for this in the connected course.";
    default:
      return "Morrow Bridge could not complete this request.";
  }
}

function providerFailureText(providerFailure: JsonObject): string {
  const provider = providerFailure.provider === "moodle" ? "Moodle" : "Canvas";
  if (providerFailure.sent !== true) return `Morrow did not send this request to ${provider}.`;
  const status = Number(providerFailure.status);
  if (!Number.isInteger(status)) return `${provider} did not complete this request.`;
  if (status === 404 || status === 410) return `${provider} could not find this item (HTTP ${status}).`;
  if (status === 401 || status === 403) return `${provider} refused this request for the signed-in account (HTTP ${status}).`;
  if (status === 429) return `${provider} limited the request rate (HTTP 429). Try again later.`;
  if (status >= 500) return `${provider} reported a server error (HTTP ${status}).`;
  return `${provider} rejected this request (HTTP ${status}).`;
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

function hasIdentityRecordSignal(value: JsonObject): boolean {
  return Object.keys(value).some((key) => isIdentityValueField(key, true));
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

function learnerIdentity(value: JsonObject, kind?: IdentityRecordKind, context?: PreparedLearnerTextRedactionContext): LearnerIdentity | null {
  const fields = normalizedIdentityFields(value);
  const existingToken = fields.get("learnertoken");
  if (context && typeof existingToken === "string") {
    const identity = snapshotLearnerIdentity(context, existingToken);
    const current = context.identityById.get(identity.id);
    if (!current) throw new Error("learner_roster_identity_unavailable");
    return current;
  }
  const normalizedKeys = new Set(fields.keys());
  const directId = identityValue(fields, ["user_id", "userId", "learner_id", "learnerId", "student_id", "studentId", "canvas_user_id", "canvasUserId", "sis_user_id", "sisUserId"]);
  const hasPersonId = ["userid", "learnerid", "studentid", "canvasuserid", "sisuserid"]
    .some((key) => normalizedKeys.has(key));
  const hasIdentityProfile = ["email", "loginid", "sortablename", "displayname", "fullname", "studentname", "avatarimageurl", "pronouns", "firstname", "lastname"]
    .some((key) => normalizedKeys.has(key));
  const hasGenericSignal = (hasPersonId && (hasIdentityProfile || Boolean(directId && context?.identityById.has(directId))))
    || (Boolean(context) && normalizedKeys.has("id") && normalizedKeys.has("name") && ["grade", "score", "enrollments", "grades", "submission", "attempts"].some((key) => normalizedKeys.has(key)))
    || ((normalizedKeys.has("avatarimageurl") || normalizedKeys.has("pronouns")) && (normalizedKeys.has("name") || normalizedKeys.has("displayname")));
  if (!kind && !hasGenericSignal) return null;
  const fallbackId = (kind || hasGenericSignal) && kind !== "submission" && kind !== "enrollment"
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

function learnerTextContext(context: OutputPrivacyContext): PreparedLearnerTextRedactionContext {
  if (!context.learnerRoster || !context.learnerVault || !context.learnerScope) {
    throw new Error("learner_roster_scope_unavailable");
  }
  return prepareLearnerTextContext({
    learnerRoster: context.learnerRoster,
    learnerVault: context.learnerVault,
    learnerScope: context.learnerScope,
  });
}

function projectText(
  value: string,
  descriptor: OutputPrivacyDescriptor,
  context: OutputPrivacyContext,
  requiresLearnerRedaction: boolean,
  textContext?: PreparedLearnerTextRedactionContext,
): string {
  const output = withoutUnrosteredAddresses(requiresLearnerRedaction
    ? redactKnownLearnerTextPrepared(value, textContext ?? learnerTextContext(context))
    : value);
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
  preparedTextContext?: PreparedLearnerTextRedactionContext,
  scalarKey = "",
): unknown {
  if (depth > MAX_PRIVACY_OUTPUT_DEPTH) throw new Error("privacy_output_depth_exceeded");
  const sourceRedacted = context.learnerBoundary === "source";
  const requiresLearnerRedaction = !sourceRedacted
    && (descriptor.dataClass === "learner"
      || kind !== undefined
      || inheritedLearnerPrivacy
      || Boolean(context.learnerRoster && context.learnerVault && context.learnerScope));
  if (typeof value === "string") {
    if (nonIdentityScalar(scalarKey) || exactNumericAvailableOption(scalarKey, value)) {
      return projectNonIdentityText(value, requiresLearnerRedaction ? preparedTextContext ?? learnerTextContext(context) : undefined);
    }
    return projectText(value, descriptor, context, requiresLearnerRedaction, preparedTextContext);
  }
  if (Array.isArray(value)) {
    if (value.length > descriptor.maxRecords) throw new Error("privacy_record_limit_exceeded");
    return value.map((item) => projectValue(item, descriptor, context, depth + 1, kind, inheritedLearnerPrivacy, preparedTextContext, scalarKey));
  }
  if (!isJsonObject(value)) return value;
  const numericEnumOption = exactNumericEnumOption(value);
  const detectedIdentity = learnerIdentity(value, kind, preparedTextContext);
  const mayScrubUnrosteredCanvasIdentity = context.allowUnrosteredCanvasIdentities === true
    && (kind !== undefined || detectedIdentity !== null);
  // A source that states it returns learner tokens and no learner identity is
  // held to that. A record shaped like a learner identity is a boundary
  // failure there, not a record to tokenize here; a record that carries only a
  // token is already resolved and is not an unresolved identity.
  if (sourceRedacted && detectedIdentity) throw new Error("privacy_source_learner_identity_refused");
  // A resolved parent says "redact learner text below here". It does not say the
  // records below it are that same person. An attribute bag such as an
  // enrollment's grades carries no identity signal and belongs to the parent, so
  // it passes; a nested record that names somebody Morrow could not resolve is a
  // second person and is refused exactly as it would be at the top level.
  if (!sourceRedacted && kind && !detectedIdentity && Object.keys(value).length !== 0
    && !(kind === "grade" && exactGradeDefinition(value))
    && !mayScrubUnrosteredCanvasIdentity
    && !((inheritedLearnerPrivacy || kind === "author" || kind === "member") && !hasIdentityRecordSignal(value))) {
    throw new Error("privacy_identity_record_unresolved");
  }
  let learner = detectedIdentity;
  const needsTextRedaction = requiresLearnerRedaction || detectedIdentity !== null;
  let textContext: PreparedLearnerTextRedactionContext | undefined;
  if (needsTextRedaction) {
    textContext = preparedTextContext ?? learnerTextContext(context);
    if (learner) {
      const current = textContext.identityById.get(learner.id);
      if (!current) {
        if (!mayScrubUnrosteredCanvasIdentity) throw new Error("learner_roster_identity_unavailable");
        learner = null;
      } else {
        learner = mergeLearnerIdentity(current, learner);
      }
    }
  }
  const output: JsonObject = {};
  if (learner && descriptor.learnerTokens) {
    output.learnerToken = snapshotLearnerToken(textContext!, learner);
  }
  const resourceKind = typeof value.kind === "string" && /^(?:course|assignment|quiz|module|section|file|page|discussion|topic|question|item|group|rubric|context|account)$/iu.test(value.kind)
    ? value.kind
    : RESOURCE_CONTAINER_KIND.get(normalizePrivacyKey(scalarKey)) ?? scalarKey;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizePrivacyKey(key);
    const allowField = descriptor.fieldPolicy === "scrub-sensitive" || descriptor.allowedFields.includes(key);
    if (!allowField || isSecretField(key) || isIdentityValueField(key, detectedIdentity !== null || mayScrubUnrosteredCanvasIdentity) || (learner && normalizedKey === "learnertoken")) continue;
    if (descriptor.freeText === "deny" && (normalizedKey === "html" || normalizedKey === "body" || normalizedKey === "content")) continue;
    const childKind = identityRecordKind(key);
    const projected = projectValue(
      child,
      descriptor,
      context,
      depth + 1,
      childKind,
      inheritedLearnerPrivacy || detectedIdentity !== null,
      textContext ?? preparedTextContext,
      key === "id" ? `${resourceKind}_id` : numericEnumOption && (key === "label" || key === "value") ? `option_${key}` : key,
    );
    const safeKey = textContext ? redactLearnerKey(key, textContext) : key;
    if (Object.hasOwn(output, safeKey)) throw new Error("privacy_identity_key_collision");
    if (projected !== undefined) Object.defineProperty(output, safeKey, { value: projected, enumerable: true, writable: true, configurable: true });
  }
  return output;
}

const UNROSTERED_EMAIL = /(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/giu;

/**
 * Text Morrow will not return at all. A credential, an embedded payload, or
 * markup that hides content is never safe to pass on, whatever surrounds it.
 *
 * An address is not in this list. An address that named a person on the roster
 * is already a learner token by the time this runs, and one that named nobody on
 * it is removed by `withoutUnrosteredAddresses` instead of taking the whole
 * reading with it. Refusing there made reads that every Canvas site answers,
 * such as an account's terms of service, impossible to use: institutional
 * contact addresses are part of that text.
 */
/**
 * How deep a provider answer may nest before the privacy walk refuses it. Canvas
 * nests a New Quizzes formula question eight levels inside one item, and a list
 * read wraps that in Morrow's own envelope, so twelve refused every quiz holding
 * one. Morrow accepts a question payload thirty-two levels deep, and the walk
 * reads back at least what Morrow will write.
 */
export const MAX_PRIVACY_OUTPUT_DEPTH = 32;

function containsSensitiveText(value: string): boolean {
  // Redaction preserves non-learner source bytes, including HTML entities and
  // URL escapes. Inspect the same canonical match view so encoded credentials
  // remain refused without rewriting a safe URL.
  //
  // Each name here has to stand on its own. `csrf` inside a longer run of
  // letters and digits is part of an identifier, not a credential: Canvas gives
  // every course a random uuid, and one of them reading `99bncSRfVsDh...`
  // refused an entire account audit. `bearer` likewise needs a credential after
  // it, or the words "bearer of" in a course page would take the page with them.
  return /(?:data:[^,;]{0,200};base64,|(?<![a-z0-9])bearer\s+[A-Za-z0-9._~+/-]{8,}|(?<![a-z0-9])cookie=|(?<![a-z0-9])csrf(?![a-z0-9])|(?<![a-z0-9])token=|<[^>]+(?:hidden|display\s*:\s*none))/i
    .test(normalizedIdentityTextView(value).text);
}

/**
 * Every address this text still carries, replaced by one fixed marker. What is
 * left names nobody, so the reading itself can be returned.
 */
function withoutUnrosteredAddresses(value: string, mode: "remove" | "refuse" = "remove"): string {
  if (mode === "refuse") {
    if (new RegExp(UNROSTERED_EMAIL.source, "iu").test(normalizedIdentityTextView(value).text)) {
      throw new Error("privacy_sensitive_text_refused");
    }
    return value;
  }
  const view = normalizedIdentityTextView(value);
  const replacements: SourceReplacement[] = [];
  // A global pattern keeps its own position between calls, so the matches are
  // taken from one fresh walk of this text and nothing else.
  for (const match of view.text.matchAll(new RegExp(UNROSTERED_EMAIL.source, "giu"))) {
    const source = sourceRangeForView(view, match.index!, match.index! + match[0].length);
    if (source) replacements.push({ ...source, replacement: "[address removed]" });
  }
  return replacements.length ? applySourceReplacements(value, replacements) : value;
}

/**
 * Sanitizes an arbitrary native-tool or sampling envelope without applying an
 * output allowlist. It preserves envelope shape and non-identity course data,
 * while routing every string and nested learner-shaped record through the
 * exact-scope roster and vault boundary.
 */
export function redactLearnerEgress(value: unknown, context: LearnerTextRedactionContext): unknown {
  return redactLearnerEgressPrepared(value, prepareLearnerTextContext(context));
}

/** Applies several exact learner scopes from one durable snapshot per vault. */
export function redactLearnerEgressBatch(entries: readonly {
  readonly value: unknown;
  readonly context: LearnerTextRedactionContext;
}[]): readonly unknown[] {
  const prepared = prepareLearnerTextContexts(entries.map(({ context }) => context));
  return entries.map(({ value }, index) => redactLearnerEgressPrepared(value, prepared[index]!));
}

function redactLearnerEgressPrepared(value: unknown, exactContext: PreparedLearnerTextRedactionContext): unknown {
  const walk = (candidate: unknown, depth = 0, kind?: IdentityRecordKind, inheritedLearnerPrivacy = false, scalarKey = ""): unknown => {
    if (depth > MAX_PRIVACY_OUTPUT_DEPTH) throw new Error("privacy_output_depth_exceeded");
    if (typeof candidate === "number") return redactLearnerNumber(candidate, scalarKey, exactContext);
    if (typeof candidate === "string") {
      if (STRUCTURAL_REFERENCE_FIELDS.has(scalarKey)) {
        // A structural reference names an object, never a person, so an address
        // here is removed like anywhere else before the value is passed on.
        const structural = withoutUnrosteredAddresses(candidate, exactContext.addresses);
        if (containsSensitiveText(structural)) throw new Error("privacy_sensitive_text_refused");
        return structural;
      }
      if (nonIdentityScalar(scalarKey) || exactNumericAvailableOption(scalarKey, candidate)) return projectNonIdentityText(candidate, exactContext);
      if (scalarKey === "schema" && /^morrow\.[a-z0-9.-]+\.v[0-9]+$/u.test(candidate)) return candidate;
      if (scalarKey === "provider" && ["canvas", "moodle", "blackboard"].includes(candidate)) return candidate;
      if (scalarKey === "roles" && ["Student", "Teacher", "TA", "Observer", "Designer", "Non-editing teacher"].includes(candidate)) return candidate;
      const output = withoutUnrosteredAddresses(redactKnownLearnerTextPrepared(candidate, exactContext), exactContext.addresses);
      if (containsSensitiveText(output)) throw new Error("privacy_sensitive_text_refused");
      return output;
    }
    if (Array.isArray(candidate)) return candidate.map((entry) => walk(entry, depth + 1, kind, inheritedLearnerPrivacy, scalarKey));
    if (!isJsonObject(candidate)) return candidate;
    const numericEnumOption = exactNumericEnumOption(candidate);
    if ((["image", "audio"].includes(String(candidate.type)) || candidate.encoding === "base64") && typeof candidate.data === "string") {
      throw new Error("privacy_opaque_artifact_refused");
    }
    let learner = learnerIdentity(candidate, kind, exactContext);
    const detectedIdentity = learner !== null;
    const mayScrubUnrosteredCanvasIdentity = exactContext.allowUnrosteredCanvasIdentities === true
      && (kind !== undefined || detectedIdentity);
    if (kind && !learner && Object.keys(candidate).length !== 0
      && !(kind === "grade" && exactGradeDefinition(candidate))
      && !((inheritedLearnerPrivacy || kind === "author" || kind === "member" || mayScrubUnrosteredCanvasIdentity)
        && !hasIdentityRecordSignal(candidate))) {
      throw new Error("privacy_identity_record_unresolved");
    }
    const needsLearnerPrivacy = inheritedLearnerPrivacy || kind !== undefined || learner !== null;
    if (learner) {
      const current = exactContext.identityById.get(learner.id);
      if (!current) {
        if (!mayScrubUnrosteredCanvasIdentity) throw new Error("learner_roster_identity_unavailable");
        learner = null;
      } else {
        learner = mergeLearnerIdentity(current, learner);
      }
    }
    const resourceKind = typeof candidate.kind === "string" && /^(?:course|assignment|quiz|module|section|file|page|discussion|topic|question|item|group|rubric|context|account)$/iu.test(candidate.kind)
      ? candidate.kind
      : RESOURCE_CONTAINER_KIND.get(normalizePrivacyKey(scalarKey)) ?? scalarKey;
    const output: JsonObject = {};
    if (learner) output.learnerToken = snapshotLearnerToken(exactContext, learner);
    for (const [key, child] of Object.entries(candidate)) {
      const normalizedKey = normalizePrivacyKey(key);
      if (isSecretField(key) || isIdentityValueField(key, detectedIdentity || mayScrubUnrosteredCanvasIdentity) || (learner && normalizedKey === "learnertoken")) continue;
      // A binary MCP resource has no safe text projection at this boundary.
      // Returning its encoded bytes could expose learner identities without a
      // chance to apply the exact-scope roster aliases.
      if (normalizedKey === "blob" && typeof child === "string") {
        throw new Error("privacy_resource_blob_refused");
      }
      const safeKey = redactLearnerKey(key, exactContext);
      if (Object.hasOwn(output, safeKey)) throw new Error("privacy_identity_key_collision");
      Object.defineProperty(output, safeKey, { value: walk(child, depth + 1, identityRecordKind(key), inheritedLearnerPrivacy || detectedIdentity, key === "id" ? `${resourceKind}_id` : numericEnumOption && (key === "label" || key === "value") ? `option_${key}` : key), enumerable: true, writable: true, configurable: true });
    }
    return output;
  };
  return walk(value);
}

function projectContent(
  value: unknown,
  descriptor: OutputPrivacyDescriptor,
  context: OutputPrivacyContext,
  textContext?: PreparedLearnerTextRedactionContext,
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
      const text = projectText(block.text, descriptor, context, requiresLearnerRedaction, textContext);
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
      const text = projectText(resource.text, descriptor, context, requiresLearnerRedaction, textContext);
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
  if (value.isError === true) return sanitizedUpstreamError(value);
  if (descriptor.aiClientAdmission !== "allow") return privacyError("privacy_ai_client_admission_denied");
  try {
    const textContext = context.learnerBoundary !== "source" && context.learnerRoster && context.learnerVault && context.learnerScope
      ? learnerTextContext(context)
      : undefined;
    const content = projectContent(value.content, descriptor, context, textContext);
    const structured = isJsonObject(value.structuredContent)
      ? projectValue(value.structuredContent, descriptor, context, 0, undefined, false, textContext)
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
  additionalLearnerIdentifierFields: readonly string[] = [],
): Record<string, unknown> {
  const learnerIdentifierFields = new Set(additionalLearnerIdentifierFields);
  if ([...learnerIdentifierFields].some((field) => !/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(field))) {
    throw new TypeError("privacy learner identifier field is invalid");
  }
  const resolveIdentity = (token: string): LearnerIdentity => {
    const saved = vault.resolve(scope, token);
    if (!roster) return saved;
    if (!roster.isReady(scope)) throw new Error("learner_roster_scope_unavailable");
    const current = roster.identities(scope).find((identity) => identity.id === saved.id);
    if (!current) throw new Error("learner_roster_identity_unavailable");
    return current;
  };
  // A page address Morrow redacted keeps its joined spelling, as
  // ada-lovelace-reflection for a page titled "Ada Lovelace Reflection". The
  // label comes back inside that address, so the person's name is restored in
  // the same spelling the address carries and the address still resolves.
  const slugOf = (name: string): string => name.normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
  const isAddressField = (key: string): boolean =>
    /^url_or_id$/iu.test(key) || /(?:^|_)(?:url|urls|href|link)$/iu.test(key);
  const resolveValue = (candidate: unknown, key = "", depth = 0): unknown => {
    if (depth > MAX_PRIVACY_OUTPUT_DEPTH) throw new Error("privacy_output_depth_exceeded");
    if (typeof candidate === "string") {
      const identifier = /^(?:user|student|learner|recipient|author|participant)(?:s|_?ids?)?$/iu.test(key)
        || learnerIdentifierFields.has(key);
      return candidate.replace(/\b(?:Student A[1-9][0-9]*|learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gu, (token) => {
        const identity = resolveIdentity(token);
        if (identifier && candidate === token) return identity.id;
        if (!identity.name) throw new Error("learner_roster_name_unavailable");
        return isAddressField(key) ? slugOf(identity.name) : identity.name;
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
