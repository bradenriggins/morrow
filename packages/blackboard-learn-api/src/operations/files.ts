import { createHash } from "node:crypto";
import { canonicalJson, isJsonObject, sha256Text, type JsonObject, type SourceCapabilityMetadata } from "@morrow/contracts";
import * as z from "zod/v4";
import type { BlackboardEffectGrant } from "../effect-grant.js";
import { redactInto, type BlackboardCourseRead, type BlackboardLearnRuntime } from "../runtime.js";
import { BLACKBOARD_ID, BlackboardApiError, withBlackboardDispatchState, type BlackboardDispatchState } from "../types.js";
import { blackboardTool, contentScopeInput, effectGrantInput, type BlackboardOperationModule } from "./definition.js";
import { READ_ANNOTATIONS, READ_BEHAVIOR, READ_PROFILES } from "./course-read.js";

/**
 * The one file Morrow attaches, and how large it may be: 1 MiB, the same
 * boundary the Moodle resource file and the Canvas course file already use
 * (`MAX_STAGED_FILE_BYTES`, packages/mcp-server/src/file-staging.ts). One
 * approved plan attaches one file.
 */
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_LABEL = "1 MiB";

/**
 * The largest base64 payload this server reads at all. It is a transport
 * ceiling, not the file cap: a payload past it is refused by the input schema
 * before anything decodes it, and every payload under it is refused against
 * `MAX_ATTACHMENT_BYTES` before Morrow stages anything.
 */
const MAX_BASE64_LENGTH = 8 * 1024 * 1024;

const UPLOADS_ROUTE = "/learn/api/public/v1/uploads";
const ATTACHMENTS_ROUTE = "/learn/api/public/v1/courses/{course_id}/contents/{content_id}/attachments";
const ATTACHMENT_ROUTE = `${ATTACHMENTS_ROUTE}/{attachment_id}`;

/**
 * The request and response field names this module sends and reads. Anthology's
 * public documentation states the upload route and that its response carries the
 * id of the staged file, and states nothing further about these shapes. No
 * tenant Swagger has been read, so every name here is unverified against a live
 * Learn site: each read below refuses when a response does not carry the name it
 * expects, and never treats a missing field as an answer.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/ultra-assignments
 */
const UPLOAD_ID_FIELD = "id";
const ATTACH_UPLOAD_FIELD = "uploadId";
const FILENAME_FIELD = "fileName";
const MIME_TYPE_FIELD = "mimeType";
const SIZE_FIELD = "size";

/**
 * The one content handler Morrow attaches a file to, and the folder handler it
 * refuses, on the same reading as a content change: an Ultra document body is a
 * `resource/x-bb-document` child of an `isBbPage` `resource/x-bb-folder`, so a
 * file addressed to the wrapper lands on the container around the document.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/content-handler
 */
const DOCUMENT_HANDLER = "resource/x-bb-document";
const FOLDER_HANDLER = "resource/x-bb-folder";

/**
 * One Blackboard attachment or staged-upload identifier. Learn content ids have
 * the `_nnn_n` shape, but no tenant Swagger states the shape of an attachment id
 * or of the id the upload route returns, so Morrow accepts one bounded opaque
 * identifier and builds a path from nothing else.
 */
const OPAQUE_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;

/**
 * One file name Morrow sends: no path separator and no control character, as
 * `packages/mcp-server/src/file-staging.ts` already requires of a staged file.
 * `reviewedFile` also refuses a name with anything to trim and the two
 * directory names.
 */
const SAFE_FILENAME = /^[^\\/\u0000-\u001f]{1,255}$/;

/** One media type, as `packages/mcp-server/src/file-staging.ts` already accepts it. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const SHA256 = /^[0-9a-f]{64}$/;

/** What every reviewed Blackboard change reports about itself, by Morrow profile. */
const WRITE_PROFILES = {
  "private-full": { state: "supported" },
  "public-canvas": { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  sandbox: { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  "read-only": { state: "profile_limited", reason: "This action requires an approved Morrow effect." },
} as const;

const EVIDENCE = {
  live: { state: "unknown", reason: "api_configured_live_untested" },
  credentialBoundary: { state: "known" },
} as const;

/**
 * The reviewed file, as the plan freezes it and the approval page shows it: a
 * name, a size, and a SHA-256 digest of the bytes. The bytes themselves are not
 * here, and never enter a plan, a result, or a failure.
 */
const fileManifestInput = {
  filename: z.string().regex(SAFE_FILENAME),
  // The cap is enforced below, with a refusal that names it, rather than as a
  // schema bound that would report an oversized file as an invalid request.
  size_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(SHA256),
  content_type: z.string().regex(MEDIA_TYPE),
};

const attachmentScopeInput = contentScopeInput.extend({ attachment_id: z.string().regex(OPAQUE_ID) });
const attachmentPlanInput = contentScopeInput.extend(fileManifestInput);

/**
 * The bytes an approved dispatch carries, in the exact envelope Morrow already
 * hands a reviewed Moodle or Canvas file transfer
 * (`morrow.private-file-attachment.v1`, packages/bridge-protocol/src/index.ts,
 * sent as the `privateAttachment` argument by
 * `GatewayRuntime.callSourceOwned`). They are sent to Blackboard and are read
 * nowhere else: no result, no plan, and no failure message carries them.
 */
const privateAttachmentInput = z.strictObject({
  schema: z.literal("morrow.private-file-attachment.v1"),
  handle: z.string().max(200),
  manifest: z.strictObject({
    filename: z.string().regex(SAFE_FILENAME),
    size_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(SHA256),
  }),
  content_type: z.string().regex(MEDIA_TYPE).optional(),
  bytes_base64: z.string().min(1).max(MAX_BASE64_LENGTH),
});

const attachmentApplyInput = attachmentPlanInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  privateAttachment: privateAttachmentInput,
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});

type FileManifestInput = z.output<typeof attachmentPlanInput>;

/** The reviewed file, with the one-file cap already applied. */
interface ReviewedFile {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentType: string;
}

function contentPath(courseId: string, contentId: string): string {
  return `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}`;
}

function attachmentsPath(courseId: string, contentId: string): string {
  return `${contentPath(courseId, contentId)}/attachments`;
}

function attachmentPath(courseId: string, contentId: string, attachmentId: string): string {
  return `${attachmentsPath(courseId, contentId)}/${encodeURIComponent(attachmentId)}`;
}

/**
 * One identifier Morrow can name a record by, or `null` when it read none it
 * accepts. The two directory names are refused here, so no path is ever built
 * from a segment that would resolve somewhere else.
 */
function exactId(value: unknown): string | null {
  return typeof value === "string" && OPAQUE_ID.test(value) && value !== "." && value !== ".." ? value : null;
}

function providerMediaType(value: unknown): string | null {
  return typeof value === "string" && MEDIA_TYPE.test(value) ? value : null;
}

/** One size in bytes as a tenant reported it, or `null` when it reported none. */
function exactSize(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * One attachment as this module returns it. The file name is provider text — a
 * file can be named after a person — so it leaves through the same privacy
 * boundary as every other Blackboard text. The size appears only where the
 * tenant reported one, because an absent size is not a size of zero.
 */
function safeAttachment(value: JsonObject, read: BlackboardCourseRead): JsonObject {
  const id = exactId(value.id);
  if (!id) throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned a file with no identifier Morrow can name it by.");
  const output: JsonObject = { id };
  redactInto(output, value, [FILENAME_FIELD], read.roster, "attachment");
  const mimeType = providerMediaType(value[MIME_TYPE_FIELD]);
  if (mimeType) output[MIME_TYPE_FIELD] = mimeType;
  const size = exactSize(value[SIZE_FIELD]);
  if (size !== null) output[SIZE_FIELD] = size;
  return output;
}

/**
 * The reviewed file manifest. A file past the one-file cap is refused here,
 * before anything is staged with Blackboard and before any provider request is
 * sent.
 */
function reviewedFile(input: FileManifestInput): ReviewedFile {
  if (input.filename !== input.filename.trim() || input.filename === "." || input.filename === "..") {
    throw new BlackboardApiError("blackboard_response_invalid", "This file name is not one Morrow sends to Blackboard.");
  }
  if (input.size_bytes > MAX_ATTACHMENT_BYTES) {
    throw new BlackboardApiError(
      "blackboard_operation_unavailable",
      `Morrow attaches one Blackboard file of at most ${MAX_ATTACHMENT_LABEL}. This file is ${input.size_bytes} bytes, so Morrow staged nothing and attached nothing.`,
    );
  }
  return { filename: input.filename, sizeBytes: input.size_bytes, sha256: input.sha256, contentType: input.content_type };
}

/**
 * The bytes this dispatch was approved to send. They are checked against the
 * reviewed name, size, and digest before Morrow sends anything, so a payload
 * that is not the reviewed file stages nothing. Nothing derived from them
 * reaches a result: this returns the bytes to the one request that sends them.
 */
function reviewedBytes(attachment: z.output<typeof privateAttachmentInput>, file: ReviewedFile): Uint8Array<ArrayBuffer> {
  if (attachment.manifest.filename !== file.filename
    || attachment.manifest.size_bytes !== file.sizeBytes
    || attachment.manifest.sha256 !== file.sha256) {
    throw new BlackboardApiError(
      "blackboard_patch_review_required",
      "The file Morrow was handed is not the file this Blackboard change was reviewed for. Nothing was staged and nothing was attached.",
    );
  }
  const bytes = Buffer.from(attachment.bytes_base64, "base64");
  if (bytes.byteLength !== file.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    throw new BlackboardApiError(
      "blackboard_patch_review_required",
      "The file bytes Morrow was handed do not match the reviewed file name, size, and digest. Nothing was staged and nothing was attached.",
    );
  }
  return new Uint8Array(bytes);
}

/**
 * The admission rules for one attached file. Morrow attaches a file to one
 * document inside the selected course: not a folder, not the Ultra wrapper
 * around a document, and not an item whose handler it cannot read.
 */
function assertAttachableContent(content: JsonObject, courseId: string): void {
  if (content.courseId !== courseId) {
    throw new BlackboardApiError("blackboard_scope_binding_mismatch", "Blackboard did not return this content item as part of the selected course.");
  }
  if (content.parentId !== undefined && (typeof content.parentId !== "string" || !BLACKBOARD_ID.test(content.parentId))) {
    throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned an invalid parent for this content item.");
  }
  const handler = content.contentHandler;
  if (!isJsonObject(handler) || typeof handler.id !== "string" || !handler.id) {
    throw new BlackboardApiError("blackboard_operation_unavailable", "Blackboard did not name a content handler for this item, so Morrow cannot tell what a file would be attached to.");
  }
  if (handler.id === FOLDER_HANDLER) {
    throw new BlackboardApiError(
      "blackboard_operation_unavailable",
      handler.isBbPage === true
        ? `This item is the Ultra document wrapper (${FOLDER_HANDLER} with isBbPage true). Morrow attaches a file to the ${DOCUMENT_HANDLER} inside it, never to the wrapper.`
        : `This item is a Blackboard folder (${FOLDER_HANDLER}). Morrow attaches a file to one document, not to a folder.`,
    );
  }
  if (handler.id !== DOCUMENT_HANDLER) {
    throw new BlackboardApiError("blackboard_operation_unavailable", `Morrow attaches a file to a Blackboard document (${DOCUMENT_HANDLER}). This item is ${handler.id}.`);
  }
}

/**
 * The frozen provider state one attachment plan is reviewed against: the exact
 * item, and every file already on it. Only its digest leaves Morrow, so the raw
 * provider values here are never returned.
 */
function attachmentPrecondition(item: JsonObject, attachments: readonly JsonObject[]): JsonObject {
  const handler = isJsonObject(item.contentHandler) && typeof item.contentHandler.id === "string" ? item.contentHandler.id : null;
  return {
    id: typeof item.id === "string" ? item.id : null,
    courseId: typeof item.courseId === "string" ? item.courseId : null,
    parentId: typeof item.parentId === "string" ? item.parentId : null,
    handler,
    // Blackboard does not promise a collection order, so the frozen list is
    // ordered by its own content, and a reordered page is not a changed course.
    attachments: attachments
      .map((entry) => ({ id: exactId(entry.id), fileName: typeof entry[FILENAME_FIELD] === "string" ? entry[FILENAME_FIELD] : null }))
      .sort((left, right) => (canonicalJson(left) < canonicalJson(right) ? -1 : 1)),
  };
}

interface FrozenAttachmentPlan {
  readonly attachments: readonly JsonObject[];
  readonly attachmentIds: readonly string[];
  readonly beforeDigest: string;
  readonly planDigest: string;
}

/**
 * One fresh read of the exact item and of every file already on it, frozen as
 * the precondition this change is reviewed against. A file whose name is
 * already on the item is refused: Blackboard would then hold two files of one
 * name, and no readback could say which one Morrow attached.
 */
async function freezeAttachmentPlan(
  read: BlackboardCourseRead,
  contentId: string,
  file: ReviewedFile,
  signal?: AbortSignal,
): Promise<FrozenAttachmentPlan> {
  const item = await read.client.get(contentPath(read.courseId, contentId), signal);
  if (item.id !== contentId) throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different content item.");
  assertAttachableContent(item, read.courseId);
  const attachments = await read.client.collect(attachmentsPath(read.courseId, contentId), { label: "attachment", signal });
  if (attachments.some((entry) => entry[FILENAME_FIELD] === file.filename)) {
    throw new BlackboardApiError(
      "blackboard_operation_unavailable",
      "This Blackboard item already has a file with this name. Morrow does not add a second file of one name, because a later read could not tell them apart.",
    );
  }
  const beforeDigest = sha256Text(canonicalJson(attachmentPrecondition(item, attachments)));
  const planDigest = sha256Text(canonicalJson({
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    contentId,
    beforeDigest,
    file: { filename: file.filename, sizeBytes: file.sizeBytes, sha256: file.sha256, contentType: file.contentType },
  }));
  return {
    attachments,
    attachmentIds: attachments.map((entry) => exactId(entry.id)).filter((entry): entry is string => entry !== null),
    beforeDigest,
    planDigest,
  };
}

/**
 * Stages the reviewed bytes with Blackboard's upload route. Anthology documents
 * this as the first of two steps, where the id it returns is what a later
 * request references, so a staged upload is on no course item and a failure
 * here leaves the course as it was. The refusal says so, and keeps whatever the
 * tenant reported about the failure.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/ultra-assignments
 */
async function stageUpload(read: BlackboardCourseRead, file: ReviewedFile, bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<string> {
  let payload: JsonObject;
  try {
    payload = await read.client.upload(UPLOADS_ROUTE, { filename: file.filename, contentType: file.contentType, bytes }, signal);
  } catch (error) {
    if (!(error instanceof BlackboardApiError)) throw error;
    throw new BlackboardApiError(
      error.code,
      `${error.message} Morrow attached nothing to this Blackboard item.`,
      error.status,
      "not_sent",
      error.diagnostics,
    );
  }
  const id = exactId(payload[UPLOAD_ID_FIELD]);
  if (!id) {
    throw new BlackboardApiError("blackboard_response_invalid", "Blackboard did not name the file it staged, so Morrow attached nothing to this Blackboard item.");
  }
  return id;
}

/**
 * What one fresh read of the attached file proves. The file name has to be the
 * reviewed name, and a size the tenant reports has to be the reviewed size.
 * Bytes are not compared: see `READBACK_DETAIL`.
 */
function compareAttachment(
  record: JsonObject,
  attachmentId: string,
  file: ReviewedFile,
  dispatchState: BlackboardDispatchState,
): { readonly size: "matched" | "unreported" } {
  if (exactId(record.id) !== attachmentId) {
    throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different file than the one it reported attaching.", undefined, dispatchState);
  }
  if (record[FILENAME_FIELD] !== file.filename) {
    throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different file name for the file it attached.", undefined, dispatchState);
  }
  const size = exactSize(record[SIZE_FIELD]);
  if (size !== null && size !== file.sizeBytes) {
    throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard reported a different size for the file it attached.", undefined, dispatchState);
  }
  return { size: size === null ? "unreported" : "matched" };
}

/**
 * What the readback proves, in plain words. Morrow compares the file name, and
 * the size where the tenant reports one. It does not read the file's bytes back,
 * and whether a Learn site serves an attached file's bytes back to this
 * credential inside this tenant's API origin is unproven, so no result here
 * claims a byte-level check. The digest of the bytes Morrow sent is in the plan
 * and in the readback, for a person who compares the file by hand.
 */
const READBACK_DETAIL = "Morrow compared the file name Blackboard returned, and the size where Blackboard reported one. It did not read the file's bytes back, so this is a metadata check, not a byte-level check.";

const READBACK_STATE = "metadata_only";

function readCapability(sourceExport: string): SourceCapabilityMetadata {
  return {
    family: "course-read",
    provider: "blackboard",
    sourceExport,
    behavior: READ_BEHAVIOR,
    authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
    route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
    profiles: READ_PROFILES,
    evidence: EVIDENCE,
  };
}

/** Every file already attached to one selected content item. */
async function listContentAttachments(
  runtime: BlackboardLearnRuntime,
  input: { tenant_id: string; source_binding_id: string; course_id: string; content_id: string },
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const records = await read.client.collect(attachmentsPath(read.courseId, input.content_id), { label: "attachment", signal });
  const attachments = records.map((record) => safeAttachment(record, read));
  return {
    schema: "morrow.blackboard.content-attachments.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    contentId: input.content_id,
    attachments,
    count: attachments.length,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/** One selected file's own record: its name, its type, and its size where the tenant reports one. */
async function readContentAttachment(
  runtime: BlackboardLearnRuntime,
  input: { tenant_id: string; source_binding_id: string; course_id: string; content_id: string; attachment_id: string },
  signal?: AbortSignal,
): Promise<JsonObject> {
  const attachmentId = exactId(input.attachment_id);
  if (!attachmentId) throw new BlackboardApiError("blackboard_scope_binding_required", "Select one exact Blackboard file.");
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await read.client.get(attachmentPath(read.courseId, input.content_id, attachmentId), signal);
  if (record.id !== attachmentId) {
    throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different file.");
  }
  const attachment = safeAttachment(record, read);
  return {
    schema: "morrow.blackboard.content-attachment.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    contentId: input.content_id,
    attachmentId,
    attachment,
    sizeReported: Object.hasOwn(attachment, SIZE_FIELD),
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/** One reviewed file attachment, frozen against the item and the files already on it. */
async function planContentAttachment(
  runtime: BlackboardLearnRuntime,
  input: FileManifestInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const file = reviewedFile(input);
  runtime.assertEffectTargetFree(attachmentEffectTarget(runtime, input));
  // A plan exists only to be dispatched, so it carries the write condition. An
  // instructor is refused before review instead of after approving a change
  // Morrow would then refuse to send.
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeAttachmentPlan(write, input.content_id, file, signal);
  return {
    schema: "morrow.blackboard.content-attachment.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    contentId: input.content_id,
    before: frozen.attachments.map((record) => safeAttachment(record, write)),
    beforeDigest: frozen.beforeDigest,
    file: { filename: file.filename, sizeBytes: file.sizeBytes, sha256: file.sha256, contentType: file.contentType },
    planDigest: frozen.planDigest,
    reviewRequired: true,
    limits: { files: 1, maxBytes: MAX_ATTACHMENT_BYTES },
    readback: READBACK_STATE,
    readbackDetail: READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

function reservedGrant(value: z.output<typeof effectGrantInput>): BlackboardEffectGrant {
  return {
    schema: value.schema,
    operationId: value.operation_id,
    planDigest: value.plan_digest,
    outerPlanDigest: value.outer_plan_digest,
    approvalGrantDigest: value.approval_grant_digest,
    effectReceiptId: value.effect_receipt_id,
    dispatchAttempt: value.dispatch_attempt,
    gatewayProcessId: value.gateway_process_id,
    dispatchToken: value.dispatch_token,
  };
}

function attachmentEffectTarget(runtime: BlackboardLearnRuntime, input: FileManifestInput) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "content-attachments", { contentId: input.content_id });
}

/**
 * The one dispatch: it stages the reviewed bytes once, attaches them once, and
 * re-reads the file it attached. Everything it can refuse it refuses before the
 * upload request leaves this process, and the one-use receipt is spent before
 * the first provider request, so two dispatches of one approval cannot both
 * pass the precondition and attach a file.
 */
async function applyReviewedContentAttachment(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof attachmentApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  runtime.assertReservedEffectGrant(grant);
  if (grant.planDigest !== input.expected_plan_digest) {
    throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
  }
  const file = reviewedFile(input);
  const bytes = reviewedBytes(input.privateAttachment, file);
  const dispatch = runtime.claimReservedEffectGrant(grant, attachmentEffectTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeAttachmentPlan(write, input.content_id, file, signal);
  if (frozen.planDigest !== input.expected_plan_digest) {
    throw new BlackboardApiError("blackboard_content_mismatch", "This Blackboard item changed after review. Morrow staged nothing and attached nothing.");
  }
  // Morrow cannot prove a change did not land once the request that attaches
  // the file has left this process. Staging bytes is not that request: a staged
  // upload is attached to nothing, so the course is unchanged until the line
  // below the marker.
  let dispatchState: BlackboardDispatchState = "not_sent";
  try {
    const uploadId = await stageUpload(write, file, bytes, signal);
    dispatch.markSent();
    dispatchState = "applied_or_unknown";
    const created = await write.client.post(
      attachmentsPath(write.courseId, input.content_id),
      { [ATTACH_UPLOAD_FIELD]: uploadId, [FILENAME_FIELD]: file.filename },
      signal,
    );
    const attachmentId = created ? exactId(created.id) : null;
    if (!attachmentId) {
      throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard did not name the file it attached, so Morrow could not read it back.", undefined, dispatchState);
    }
    if (frozen.attachmentIds.includes(attachmentId)) {
      throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard named a file that was already on this item before this change.", undefined, dispatchState);
    }
    const record = await write.client.get(attachmentPath(write.courseId, input.content_id, attachmentId), signal);
    const compared = compareAttachment(record, attachmentId, file, dispatchState);
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.content-attachment.readback.v1",
      ok: true,
      // Morrow's operation journal reads this marker to decide what reached
      // Blackboard. The read payloads keep `status`, which is an evidence label.
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      contentId: input.content_id,
      attachmentId,
      attachment: safeAttachment(record, write),
      file: { filename: file.filename, sizeBytes: file.sizeBytes, sha256: file.sha256 },
      verification: { filename: "matched", size: compared.size, bytes: "not_compared" },
      readback: READBACK_STATE,
      readbackDetail: READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    if (dispatchState === "applied_or_unknown") dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed attachment. It holds no
 * frozen snapshot, so it states only whether exactly one file of the reviewed
 * name is on the item now, and whether a size the tenant reports matches. The
 * precondition that catches a changed item belongs to the dispatch above, which
 * sent the change and holds that snapshot.
 *
 * It prepares no roster and reads no course membership: it returns one boolean
 * and the identifiers the Gateway already holds, and no provider text. It
 * carries no `diagnostics` either, because the Gateway freezes this exact
 * payload when it plans the operation.
 */
async function verifyContentAttachment(
  runtime: BlackboardLearnRuntime,
  input: FileManifestInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const file = reviewedFile(input);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const records = await comparator.client.collect(attachmentsPath(comparator.courseId, input.content_id), { label: "attachment", signal });
  const matches = records.filter((record) => record[FILENAME_FIELD] === file.filename);
  const size = matches.length === 1 ? exactSize(matches[0]![SIZE_FIELD]) : null;
  const verified = matches.length === 1 && (size === null || size === file.sizeBytes);
  runtime.recordEffectComparison(attachmentEffectTarget(runtime, input), verified);
  return {
    schema: "morrow.blackboard.content-attachment.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    contentId: input.content_id,
    verified,
    readback: READBACK_STATE,
    status: "api_configured_live_untested",
  };
}

/**
 * Blackboard files: the files already on a course item, and one reviewed file
 * attached to one document. The two reads are reachable now. The change is not:
 * Morrow's Gateway has no public plan tool for a Blackboard file, does not stage
 * a file under a Blackboard scope, and refuses to hand a private attachment to
 * this source, so nothing can dispatch this route until that wiring exists.
 *
 * A change here is three separate routes, as every Morrow provider change is:
 * the plan an instructor reviews, the dispatch the Gateway makes once against a
 * signed one-use effect grant, and the fresh-read comparator. The reviewed
 * bytes reach the dispatch in the same private envelope Morrow already uses for
 * a Moodle or Canvas file, so a plan, a result, and an approval page carry only
 * the file name, the size, and the SHA-256 digest, never the bytes.
 *
 * Anthology's public documentation states the upload route and that its
 * response names the staged file. It states no field name, and no tenant
 * Swagger has been read, so every request and response shape here is
 * live-unverified and each read refuses rather than guesses.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/ultra-assignments
 */
export const blackboardFilesModule: BlackboardOperationModule = {
  id: "files",
  tools: [
    blackboardTool({
      name: "blackboard_list_content_attachments",
      title: "List the files on one Blackboard item",
      description: "List the files attached to one selected Blackboard Learn content item. Each file shows its name, its type, and its size where the tenant reports one; an absent size is reported as absent, never as zero. File names are redacted against the course roster before output. This tool does not read file contents.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: contentScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability("GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}/attachments"),
      rest: {
        method: "GET",
        pathTemplate: ATTACHMENTS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => listContentAttachments(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_read_content_attachment",
      title: "Read one Blackboard file's details",
      description: "Read one selected file on one selected Blackboard Learn content item: its name, its type, and its size where the tenant reports one. The result says whether a size was reported. The file name is redacted against the course roster before output. This tool does not read file contents.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: attachmentScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability("GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}/attachments/{attachment_id}"),
      rest: {
        method: "GET",
        pathTemplate: ATTACHMENT_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => readContentAttachment(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_content_attachment",
      title: "Plan one Blackboard file attachment",
      description: `Prepare one file for Morrow review, to attach to one selected Blackboard Learn document. One approved plan attaches one file of at most ${MAX_ATTACHMENT_LABEL}. The plan carries the file name, the size, and the SHA-256 digest, never the file itself. This tool stages nothing with Blackboard and attaches nothing.`,
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: attachmentPlanInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "content-attachment",
        provider: "blackboard",
        sourceExport: `POST ${UPLOADS_ROUTE}, then POST ${ATTACHMENTS_ROUTE}`,
        behavior: {
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: ATTACHMENTS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planContentAttachment(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_content_attachment",
      title: "Attach one reserved Blackboard file",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant and the reviewed file bytes.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: attachmentApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "content-attachment",
        provider: "blackboard",
        sourceExport: `POST ${UPLOADS_ROUTE}, then POST ${ATTACHMENTS_ROUTE}`,
        behavior: {
          readOnly: false, mutating: true, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "POST",
        pathTemplate: ATTACHMENTS_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_content_attachment",
        readbackComparator: "blackboard_verify_content_attachment",
      },
      run: (runtime, input, signal) => applyReviewedContentAttachment(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_content_attachment",
      title: "Verify one Blackboard file attachment",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard file attachment. It compares the file name, and the size where the tenant reports one. It does not read the file's bytes back.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: attachmentPlanInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "content-read",
        provider: "blackboard",
        sourceExport: `GET ${ATTACHMENTS_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: {
          "private-full": { state: "supported" },
          "public-canvas": { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
          sandbox: { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
          "read-only": { state: "private_only", reason: "Gateway-only Blackboard verification." },
        },
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: ATTACHMENTS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyContentAttachment(runtime, input, signal),
    }),
  ],
};
