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
}

interface VaultEntry {
  readonly token: string;
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
  return {
    id,
    ...(optional(value.name, "name") ? { name: optional(value.name, "name") } : {}),
    ...(optional(value.email, "email") ? { email: optional(value.email, "email") } : {}),
  };
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
    if (existing) return existing.token;
    const entry: VaultEntry = { token: `learner_${randomUUID()}`, scope, identity };
    this.entries.set(key, entry);
    this.byToken.set(entry.token, entry);
    this.persist();
    return entry.token;
  }

  resolve(scopeValue: LearnerScope, tokenValue: string): LearnerIdentity {
    const scope = exactScope(scopeValue);
    const token = String(tokenValue || "").trim();
    const entry = this.byToken.get(token);
    if (!entry || scopeKey(entry.scope) !== scopeKey(scope)) {
      throw new Error("learner token is unavailable for this exact scope");
    }
    return { ...entry.identity };
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
      if (!isJsonObject(value) || typeof value.token !== "string" || !isJsonObject(value.scope) || !isJsonObject(value.identity)) {
        throw new Error("learner vault entry is invalid");
      }
      const entry: VaultEntry = {
        token: value.token,
        scope: exactScope(value.scope as unknown as LearnerScope),
        identity: exactIdentity(value.identity as unknown as LearnerIdentity),
      };
      this.entries.set(identityKey(entry.scope, entry.identity), entry);
      this.byToken.set(entry.token, entry);
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
  readonly learnerScope?: LearnerScope;
  readonly artifacts?: ArtifactGenerationRegistry;
}

export interface ProjectedOutput {
  readonly content: readonly JsonObject[];
  readonly structuredContent?: JsonObject;
}

const LEARNER_FIELDS = new Set([
  "id", "user_id", "userId", "student_id", "studentId", "sis_user_id", "sisUserId",
  "name", "display_name", "email", "login_id", "loginId", "sortable_name", "short_name",
  "accommodations", "submission", "submissions",
]);
const SECRET_FIELD = /(?:^|_)(?:authorization|bearer|access_token|refresh_token|csrf|cookie|secret|credential|jwt)(?:$|_)/i;

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

function learnerIdentity(value: JsonObject): LearnerIdentity | null {
  const keys = new Set(Object.keys(value));
  const hasLearnerSignal = [
    "user_id", "userId", "student_id", "studentId", "sis_user_id", "sisUserId",
    "email", "login_id", "loginId", "sortable_name",
  ].some((key) => keys.has(key))
    || ((keys.has("avatar_image_url") || keys.has("pronouns")) && (keys.has("name") || keys.has("display_name")));
  if (!hasLearnerSignal) return null;
  const id = value.id ?? value.user_id ?? value.userId ?? value.student_id ?? value.studentId;
  if (typeof id !== "string" && typeof id !== "number") return null;
  return {
    id: String(id),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
  };
}

function projectValue(value: unknown, descriptor: OutputPrivacyDescriptor, context: OutputPrivacyContext, depth = 0): unknown {
  if (depth > 12) throw new Error("privacy_output_depth_exceeded");
  if (Array.isArray(value)) {
    if (value.length > descriptor.maxRecords) throw new Error("privacy_record_limit_exceeded");
    return value.map((item) => projectValue(item, descriptor, context, depth + 1));
  }
  if (!isJsonObject(value)) return value;
  const learner = learnerIdentity(value);
  const output: JsonObject = {};
  if (learner && descriptor.learnerTokens) {
    if (!context.learnerVault || !context.learnerScope) throw new Error("learner_vault_unavailable");
    output.learnerToken = context.learnerVault.tokenize(context.learnerScope, learner);
  }
  for (const [key, child] of Object.entries(value)) {
    const allowField = descriptor.fieldPolicy === "scrub-sensitive" || descriptor.allowedFields.includes(key);
    if (!allowField || SECRET_FIELD.test(key) || (learner && LEARNER_FIELDS.has(key))) continue;
    if (typeof child === "string") {
      if (descriptor.freeText === "deny" && (key === "html" || key === "body" || key === "content")) continue;
      if (containsSensitiveText(child)) throw new Error("privacy_sensitive_text_refused");
    }
    const projected = projectValue(child, descriptor, context, depth + 1);
    if (projected !== undefined) output[key] = projected;
  }
  return output;
}

function containsSensitiveText(value: string): boolean {
  return /(?:bearer\s+|cookie=|csrf|token=|(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|<[^>]+(?:hidden|display\s*:\s*none))/i.test(value);
}

function projectContent(
  value: unknown,
  descriptor: OutputPrivacyDescriptor,
  context: OutputPrivacyContext,
): readonly JsonObject[] {
  if (!Array.isArray(value)) return [];
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
      if (containsSensitiveText(block.text)) throw new Error("privacy_sensitive_text_refused");
      if (Buffer.byteLength(block.text, "utf8") > descriptor.maxBytes) {
        throw new Error("privacy_byte_limit_exceeded");
      }
      output.push({ type: "text", text: block.text });
      continue;
    }
    const resource = isJsonObject(block.resource) ? block.resource : block;
    if (typeof resource.text === "string") {
      if (descriptor.artifactInspection !== "text" || containsSensitiveText(resource.text)) {
        throw new Error("privacy_text_artifact_refused");
      }
      output.push(structuredClone(block));
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
    return privacyError(error instanceof Error ? error.message : "privacy_output_refused");
  }
}

export function resolveLearnerTokens(
  value: Readonly<Record<string, unknown>>,
  vault: LearnerVault,
  scope: LearnerScope,
): Record<string, unknown> {
  const resolveValue = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(resolveValue);
    if (!isJsonObject(candidate)) return candidate;
    const output: JsonObject = {};
    for (const [key, child] of Object.entries(candidate)) {
      if (key === "learner_token" || key === "learnerToken") {
        const identity = vault.resolve(scope, String(child));
        output[key === "learner_token" ? "learner_id" : "learnerId"] = identity.id;
        continue;
      }
      output[key] = resolveValue(child);
    }
    return output;
  };
  return resolveValue(value) as Record<string, unknown>;
}

export function outputDescriptorDigest(descriptor: OutputPrivacyDescriptor | undefined): string {
  return sha256Text(canonicalJson(exactDescriptor(descriptor)));
}
