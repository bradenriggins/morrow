import { createHash, randomUUID } from "node:crypto";

export const MAX_STAGED_FILE_BYTES = 1024 * 1024;
export const MAX_PENDING_FILE_STAGES = 128;
export const MIN_FILE_STAGE_TTL_MS = 60_000;
export const MAX_FILE_STAGE_TTL_MS = 24 * 60 * 60_000;

const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,160}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface FileStageScope {
  readonly provider: "moodle" | "canvas" | "blackboard";
  readonly sourceBindingId: string;
  readonly origin: string;
  readonly siteUrl: string;
  readonly principalFingerprint: string;
  readonly sessionGeneration: number;
  readonly catalogDigest: string;
  readonly courseId: string;
  readonly toolName: string;
  readonly operationKey: string;
  /** Required only for the exact private Canvas course-file route. */
  readonly contentType?: string;
}

export interface FileStageManifest {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface FileStageReceipt {
  readonly handle: string;
  readonly manifest: FileStageManifest;
  readonly expiresAt: number;
}

export interface FileStageRequest {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly scope: FileStageScope;
  readonly expiresAt: number;
}

export interface FileStageBinding {
  readonly handle: string;
  readonly scope: FileStageScope;
  readonly manifest: FileStageManifest;
  readonly operationId: string;
}

export interface FileStageDispatch {
  readonly manifest: FileStageManifest;
  readonly bytes: Uint8Array;
}

interface StoredStage {
  readonly scope: FileStageScope;
  readonly manifest: FileStageManifest;
  readonly expiresAt: number;
  readonly bytes: Buffer;
  operationId: string | null;
}

export class FileStageError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "FileStageError";
    this.code = code;
  }
}

function refuse(code: string): never {
  throw new FileStageError(code);
}

function exactIdentifier(value: unknown): string | null {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : null;
}

function exactPositiveId(value: unknown): string | null {
  return typeof value === "string" && DECIMAL_ID.test(value) ? value : null;
}

function exactFilename(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || value !== value.trim()) return null;
  if (value === "." || value === ".." || /[\\/\u0000-\u001f]/.test(value)) return null;
  return value;
}

function exactSha256(value: unknown): string | null {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function normalizedSite(scope: FileStageScope): { readonly origin: string; readonly siteUrl: string } | null {
  try {
    const origin = new URL(scope.origin);
    const site = new URL(scope.siteUrl);
    if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password || site.protocol !== "https:"
      || site.origin !== origin.origin || site.href !== scope.siteUrl || site.search || site.hash || site.username || site.password) return null;
    return { origin: origin.origin, siteUrl: site.href };
  } catch {
    return null;
  }
}

function normalizedScope(value: FileStageScope): FileStageScope | null {
  if (!value || !["moodle", "canvas", "blackboard"].includes(value.provider)) return null;
  const sourceBindingId = exactIdentifier(value.sourceBindingId);
  const principalFingerprint = exactSha256(value.principalFingerprint);
  const sessionGeneration = value.sessionGeneration;
  const catalogDigest = exactSha256(value.catalogDigest);
  const courseId = value.provider === "blackboard"
    ? (typeof value.courseId === "string" && /^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/.test(value.courseId) ? value.courseId : null)
    : exactPositiveId(value.courseId);
  const toolName = exactIdentifier(value.toolName);
  const operationKey = exactIdentifier(value.operationKey);
  const site = normalizedSite(value);
  const contentType = value.contentType === undefined
    ? undefined
    : typeof value.contentType === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(value.contentType)
      ? value.contentType
      : null;
  if (!sourceBindingId || !principalFingerprint || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 1
    || !catalogDigest || !courseId || !toolName || !operationKey || !site
    || ((value.provider === "canvas" || value.provider === "blackboard") && !contentType)
    || (value.provider === "moodle" && contentType !== undefined)) return null;
  return {
    provider: value.provider,
    sourceBindingId,
    origin: site.origin,
    siteUrl: site.siteUrl,
    principalFingerprint,
    sessionGeneration,
    catalogDigest,
    courseId,
    toolName,
    operationKey,
    ...(contentType ? { contentType } : {}),
  };
}

function normalizedManifest(value: FileStageManifest): FileStageManifest | null {
  const filename = exactFilename(value?.filename);
  const sizeBytes = value?.sizeBytes;
  const sha256 = exactSha256(value?.sha256);
  if (!filename || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_STAGED_FILE_BYTES || !sha256) return null;
  return { filename, sizeBytes, sha256 };
}

function scopesMatch(left: FileStageScope, right: FileStageScope): boolean {
  return left.provider === right.provider
    && left.sourceBindingId === right.sourceBindingId
    && left.origin === right.origin
    && left.siteUrl === right.siteUrl
    && left.principalFingerprint === right.principalFingerprint
    && left.sessionGeneration === right.sessionGeneration
    && left.catalogDigest === right.catalogDigest
    && left.courseId === right.courseId
    && left.toolName === right.toolName
    && left.operationKey === right.operationKey
    && left.contentType === right.contentType;
}

function manifestsMatch(left: FileStageManifest, right: FileStageManifest): boolean {
  return left.filename === right.filename && left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function operationId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{8,160}$/.test(value) ? value : null;
}

export class FileStageStore {
  private readonly stages = new Map<string, StoredStage>();
  private readonly now: () => number;
  private readonly onExpire?: (handle: string, operationId: string | null) => void;
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(options: {
    readonly now?: () => number;
    readonly onExpire?: (handle: string, operationId: string | null) => void;
  } = {}) {
    this.now = options.now || Date.now;
    this.onExpire = options.onExpire;
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    let expiresAt = Number.POSITIVE_INFINITY;
    for (const stage of this.stages.values()) expiresAt = Math.min(expiresAt, stage.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.reap();
    }, Math.max(1, expiresAt - this.now()));
    this.expiryTimer.unref();
  }

  stage(request: FileStageRequest): FileStageReceipt {
    this.reap();
    const scope = normalizedScope(request?.scope);
    const filename = exactFilename(request?.filename);
    const bytes = request?.bytes instanceof Uint8Array ? request.bytes : null;
    const now = this.now();
    const expiresAt = request?.expiresAt;
    if (!scope || !filename || !bytes || bytes.byteLength < 1 || bytes.byteLength > MAX_STAGED_FILE_BYTES
      || !Number.isSafeInteger(expiresAt) || expiresAt < now + MIN_FILE_STAGE_TTL_MS || expiresAt > now + MAX_FILE_STAGE_TTL_MS) refuse("file_stage_invalid");
    if (this.stages.size >= MAX_PENDING_FILE_STAGES) refuse("file_stage_capacity_reached");
    const manifest = { filename, sizeBytes: bytes.byteLength, sha256: sha256(bytes) };
    const handle = `file:${randomUUID()}`;
    this.stages.set(handle, {
      scope,
      manifest,
      expiresAt,
      bytes: Buffer.from(bytes),
      operationId: null,
    });
    this.scheduleExpiry();
    return { handle, manifest: { ...manifest }, expiresAt };
  }

  bind(binding: FileStageBinding): void {
    this.reap();
    const stage = this.stages.get(binding?.handle);
    const scope = normalizedScope(binding?.scope);
    const manifest = normalizedManifest(binding?.manifest);
    const id = operationId(binding?.operationId);
    if (!stage || !scope || !manifest || !id) refuse("file_stage_unavailable");
    if (!scopesMatch(stage.scope, scope) || !manifestsMatch(stage.manifest, manifest) || stage.operationId !== null) {
      refuse("file_stage_binding_refused");
    }
    stage.operationId = id;
  }

  consume(binding: FileStageBinding): FileStageDispatch {
    this.reap();
    const stage = this.stages.get(binding?.handle);
    const scope = normalizedScope(binding?.scope);
    const manifest = normalizedManifest(binding?.manifest);
    const id = operationId(binding?.operationId);
    if (!stage || !scope || !manifest || !id) refuse("file_stage_unavailable");
    if (!scopesMatch(stage.scope, scope) || !manifestsMatch(stage.manifest, manifest) || stage.operationId !== id) {
      refuse("file_stage_binding_refused");
    }
    const bytes = new Uint8Array(stage.bytes);
    stage.bytes.fill(0);
    this.stages.delete(binding.handle);
    this.scheduleExpiry();
    return { manifest: { ...stage.manifest }, bytes };
  }

  verify(binding: FileStageBinding): void {
    this.reap();
    const stage = this.stages.get(binding?.handle);
    const scope = normalizedScope(binding?.scope);
    const manifest = normalizedManifest(binding?.manifest);
    const id = operationId(binding?.operationId);
    if (!stage || !scope || !manifest || !id) refuse("file_stage_unavailable");
    if (!scopesMatch(stage.scope, scope) || !manifestsMatch(stage.manifest, manifest) || stage.operationId !== id) {
      refuse("file_stage_binding_refused");
    }
  }

  discard(handle: string): void {
    const stage = this.stages.get(handle);
    if (!stage) return;
    stage.bytes.fill(0);
    this.stages.delete(handle);
    this.scheduleExpiry();
  }

  reap(now = this.now()): number {
    let removed = 0;
    for (const [handle, stage] of this.stages) {
      if (now < stage.expiresAt) continue;
      stage.bytes.fill(0);
      this.stages.delete(handle);
      try { this.onExpire?.(handle, stage.operationId); } catch { /* expiry cleanup must continue */ }
      removed += 1;
    }
    this.scheduleExpiry();
    return removed;
  }

  clear(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    for (const stage of this.stages.values()) stage.bytes.fill(0);
    this.stages.clear();
  }
}
