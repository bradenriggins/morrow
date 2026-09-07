import { isAbsolute, join } from "node:path";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { type CatalogTool, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { type FileStageScope } from "./file-staging.js";
import { readWorkspaceFile } from "./moodle-resource-file.js";
import type { GatewayRuntime } from "./runtime.js";

export const CANVAS_COURSE_FILE_TRANSFER_TOOL = "canvas_transfer_course_file";
export const CANVAS_COURSE_FILE_TRANSFER_OPERATION = "canvas.private.course_file.transfer.v1";
export const CANVAS_FILE_APPROVAL_TTL_MS = 15 * 60_000;

export const canvasCourseFileUploadInputSchema = z.strictObject({
  source_binding_id: z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/),
  course_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  folder_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  material_path: z.string().min(11).max(4096),
});

export type CanvasCourseFileUploadInput = z.infer<typeof canvasCourseFileUploadInputSchema>;

export function isCanvasCourseFileTransfer(mapping: CatalogTool): boolean {
  return mapping.upstreamName === CANVAS_COURSE_FILE_TRANSFER_TOOL
    && mapping.capability?.provider === "canvas"
    && mapping.capability.route.backend === "canvas-connector"
    && mapping.annotations?.readOnlyHint === false
    && mapping.capability.sourceImplementations.some((source) => (
      source.toolName === CANVAS_COURSE_FILE_TRANSFER_TOOL && source.sourceExport === CANVAS_COURSE_FILE_TRANSFER_OPERATION
    ));
}

export function canvasFileScope(binding: JsonObject, sourceBindingId: string, courseId: number, contentType: string): FileStageScope {
  if (binding.provider !== "canvas" || binding.sourceBindingId !== sourceBindingId
    || binding.courseId !== String(courseId) || binding.runtimeVerified !== true
    || typeof binding.origin !== "string"
    || typeof binding.principalFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(binding.principalFingerprint)
    || typeof binding.sessionGeneration !== "number" || !Number.isSafeInteger(binding.sessionGeneration) || binding.sessionGeneration < 1
    || typeof binding.catalogDigest !== "string" || !/^[a-f0-9]{64}$/.test(binding.catalogDigest)
    || !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(contentType)) {
    throw new Error("The selected Canvas course connection changed. Read its current connection and prepare the file again.");
  }
  return {
    provider: "canvas",
    sourceBindingId,
    courseId: String(courseId),
    origin: binding.origin,
    siteUrl: binding.origin + "/",
    principalFingerprint: binding.principalFingerprint,
    sessionGeneration: binding.sessionGeneration,
    catalogDigest: binding.catalogDigest,
    toolName: CANVAS_COURSE_FILE_TRANSFER_TOOL,
    operationKey: CANVAS_COURSE_FILE_TRANSFER_OPERATION,
    contentType,
  };
}

export function contentTypeForCanvasFile(filename: string): string {
  const extension = /\.([A-Za-z0-9]{1,12})$/.exec(filename)?.[1]?.toLowerCase();
  return ({
    txt: "text/plain",
    csv: "text/csv",
    html: "text/html",
    htm: "text/html",
    xhtml: "application/xhtml+xml",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
  } as Record<string, string>)[extension || ""] || "application/octet-stream";
}

export async function readWorkspaceMaterial(materialPath: string, workspaceRoot: string): Promise<{ filename: string; bytes: Buffer }> {
  if (typeof materialPath !== "string" || isAbsolute(materialPath)
    || !/^materials\/(?:[A-Za-z0-9][A-Za-z0-9 ._()-]{0,159}\/)*[A-Za-z0-9][A-Za-z0-9 ._()-]{0,159}$/.test(materialPath)) {
    throw new Error("Choose a material in this assistant's project materials folder.");
  }
  return await readWorkspaceFile(materialPath, workspaceRoot, join(workspaceRoot, "materials"));
}

export function registerCanvasCourseFileUploadTool(
  server: McpServer,
  runtime: GatewayRuntime,
  workspaceRoot?: string,
): void {
  server.registerTool("morrow_plan_canvas_file_upload", {
    title: "Prepare a Canvas course file for review",
    description: "Prepare one canonical material from this assistant's project materials folder for one selected Canvas course folder. Morrow freezes the file name, size, SHA-256, target course and folder, signed-in session, and content type for review. File bytes stay private until one person approves this exact operation. Files are limited to 1 MiB. This tool does not upload a file.",
    inputSchema: canvasCourseFileUploadInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, context) => {
    return await runtime.planCanvasCourseFileUpload(input, {
      signal: context.mcpReq.signal,
      workspaceRoot,
    }) as CallToolResult;
  });
}
