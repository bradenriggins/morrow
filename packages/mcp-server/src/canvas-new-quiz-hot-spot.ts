import { isJsonObject, type CatalogTool, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import type { FileStageScope } from "./file-staging.js";

export const CANVAS_NEW_QUIZ_HOT_SPOT_TOOL = "canvas_create_new_quiz_hot_spot";
export const CANVAS_NEW_QUIZ_HOT_SPOT_OPERATION = "canvas.private.new_quiz.hot_spot.create.v1";
export const CANVAS_NEW_QUIZ_HOT_SPOT_APPROVAL_TTL_MS = 15 * 60_000;

const canvasId = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const canvasNewQuizHotSpotRequestSchema = z.strictObject({
  course_id: canvasId,
  assignment_id: canvasId,
  item: z.record(z.string(), z.unknown()),
  before_items_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  filename: z.string().min(1).max(255),
  size_bytes: z.number().int().positive().max(1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content_type: z.enum(["image/png", "image/jpeg", "image/gif"]),
});

export function isCanvasNewQuizHotSpotTransfer(mapping: CatalogTool): boolean {
  return mapping.upstreamName === CANVAS_NEW_QUIZ_HOT_SPOT_TOOL
    && mapping.capability?.provider === "canvas"
    && mapping.capability.route.backend === "canvas-connector"
    && mapping.annotations?.readOnlyHint === false
    && mapping.capability.sourceImplementations.some((source) => (
      source.toolName === CANVAS_NEW_QUIZ_HOT_SPOT_TOOL
      && source.sourceExport === CANVAS_NEW_QUIZ_HOT_SPOT_OPERATION
    ));
}

export function canvasNewQuizHotSpotScope(
  binding: JsonObject,
  sourceBindingId: string,
  courseId: string,
  contentType: string,
): FileStageScope {
  if (binding.provider !== "canvas" || binding.sourceBindingId !== sourceBindingId
    || binding.courseId !== courseId || binding.runtimeVerified !== true
    || typeof binding.origin !== "string"
    || typeof binding.principalFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(binding.principalFingerprint)
    || typeof binding.sessionGeneration !== "number" || !Number.isSafeInteger(binding.sessionGeneration) || binding.sessionGeneration < 1
    || typeof binding.catalogDigest !== "string" || !/^[a-f0-9]{64}$/.test(binding.catalogDigest)
    || !["image/png", "image/jpeg", "image/gif"].includes(contentType)) {
    throw new Error("The selected Canvas course connection changed. Read its current connection and prepare the Hot Spot again.");
  }
  return {
    provider: "canvas",
    sourceBindingId,
    courseId,
    origin: binding.origin,
    siteUrl: binding.origin + "/",
    principalFingerprint: binding.principalFingerprint,
    sessionGeneration: binding.sessionGeneration,
    catalogDigest: binding.catalogDigest,
    toolName: CANVAS_NEW_QUIZ_HOT_SPOT_TOOL,
    operationKey: CANVAS_NEW_QUIZ_HOT_SPOT_OPERATION,
    contentType,
  };
}

export function canvasNewQuizHotSpotContentType(filename: string): "image/png" | "image/jpeg" | "image/gif" {
  const extension = /\.([A-Za-z0-9]{1,12})$/.exec(filename)?.[1]?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  throw new Error("A Hot Spot image must be a PNG, JPEG, or GIF file.");
}

export function exactHotSpotTemplate(value: unknown): JsonObject | null {
  if (!isJsonObject(value) || value.entry_type !== "Item" || !isJsonObject(value.entry)
    || value.entry.interaction_type_slug !== "hot-spot" || !isJsonObject(value.entry.interaction_data)
    || Object.hasOwn(value.entry.interaction_data, "image_url")) return null;
  return structuredClone(value) as JsonObject;
}

/**
 * The bytes a person reviewed must be the kind of image the plan says they are.
 * Canvas is told the content type on the signed PUT, and a file whose name says
 * PNG but whose bytes are something else would be uploaded under a type nobody
 * reviewed. Each signature below is the fixed leading byte sequence its format
 * requires.
 */
const HOT_SPOT_IMAGE_SIGNATURES: Readonly<Record<string, readonly (readonly number[])[]>> = Object.freeze({
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/gif": [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
});

export function assertHotSpotImageBytes(bytes: Uint8Array, contentType: string): void {
  const signatures = HOT_SPOT_IMAGE_SIGNATURES[contentType];
  if (!signatures || !signatures.some((signature) => signature.length <= bytes.byteLength
    && signature.every((byte, index) => bytes[index] === byte))) {
    throw new Error("The reviewed Hot Spot image is not a PNG, JPEG, or GIF file.");
  }
}

/**
 * The item create carries the same signed upload URL with its query string
 * removed. Canvas documents that exactly: "note: the query params present on
 * the signed url are not included here". A URL that is not https, or that
 * carries a user name or a password, is refused rather than trimmed.
 */
export function unsignedHotSpotImageUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) {
    throw new Error("canvas_hot_spot_upload_url_refused");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("canvas_hot_spot_upload_url_refused");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error("canvas_hot_spot_upload_url_refused");
  }
  url.search = "";
  url.hash = "";
  const unsigned = url.href;
  if (unsigned.includes("?") || unsigned.includes("#")) throw new Error("canvas_hot_spot_upload_url_refused");
  return unsigned;
}
