import { isAbsolute } from "node:path";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { type CatalogTool, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { type FileStageScope } from "./file-staging.js";
import { readWorkspaceFile } from "./moodle-resource-file.js";
import type { GatewayRuntime } from "./runtime.js";

export const CANVAS_COURSE_FILE_TRANSFER_TOOL = "canvas_transfer_course_file";
export const CANVAS_COURSE_FILE_TRANSFER_OPERATION = "canvas.private.course_file.transfer.v1";
export const CANVAS_FILE_APPROVAL_TTL_MS = 15 * 60_000;

const canvasId = z.preprocess(
  (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value,
  z.string().regex(/^[1-9][0-9]{0,18}$/),
);

const uploadId = z.preprocess(
  (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value,
  z.string().regex(/^(?:[1-9][0-9]{0,18}|self|Student [A-Z]+[1-9][0-9]*)$/),
);

/**
 * One material for one Canvas upload target. A course folder is named by `course_id` and `folder_id`.
 * Any other target is named by the Canvas upload route and the ids its path needs: a course's files,
 * any folder, a group, a person, an assignment or quiz submission, a submission comment, or a rubric
 * CSV import.
 */
export const canvasCourseFileUploadInputSchema = z.strictObject({
  source_binding_id: z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/),
  course_id: canvasId.optional(),
  folder_id: canvasId.optional(),
  upload_tool: z.string().regex(/^canvas_[a-z0-9_]{1,160}$/).optional(),
  upload_arguments: z.record(z.string().regex(/^[a-z_]{1,40}$/), uploadId).optional(),
  material_path: z.string().min(1).max(4096),
}).refine((input) => input.folder_id !== undefined
  ? input.course_id !== undefined && input.upload_tool === undefined && input.upload_arguments === undefined
  : input.upload_tool !== undefined && input.upload_arguments !== undefined, {
  message: "Name a course folder with course_id and folder_id, or one Canvas upload route with upload_tool and upload_arguments.",
});

export const CANVAS_FOLDER_UPLOAD_TOOL = "canvas_upload_file_v1_folders_folder_id_files_post";

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

export function canvasFileScope(binding: JsonObject, sourceBindingId: string, courseId: string, contentType: string): FileStageScope {
  if (binding.provider !== "canvas" || binding.sourceBindingId !== sourceBindingId
    || binding.courseId !== courseId || binding.runtimeVerified !== true
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
    courseId,
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

/**
 * Reads one material named by its path inside the folder the assistant works
 * in. Desktop runs every assistant in the educator's Materials folder, and a
 * developer's assistant in its project, so that folder is the materials
 * folder, as it is for Moodle files. Hidden files and folders are refused.
 */
export async function readWorkspaceMaterial(materialPath: string, workspaceRoot: string): Promise<{ filename: string; bytes: Buffer }> {
  if (typeof materialPath !== "string" || isAbsolute(materialPath)
    || !/^(?:[A-Za-z0-9][A-Za-z0-9 ._()-]{0,159}\/)*[A-Za-z0-9][A-Za-z0-9 ._()-]{0,159}$/.test(materialPath)) {
    throw new Error("Choose a file in this assistant's materials folder, named by its path inside that folder, such as syllabus.pdf.");
  }
  return await readWorkspaceFile(materialPath, workspaceRoot);
}

export function registerCanvasCourseFileUploadTool(
  server: McpServer,
  runtime: GatewayRuntime,
  workspaceRoot?: string,
): void {
  server.registerTool("morrow_plan_canvas_file_upload", {
    title: "Prepare a Canvas file upload for review",
    description: "Prepare one file from this assistant's materials folder, the folder it works in, for one Canvas upload target. Name the file by its path inside that folder, such as syllabus.pdf. The target is a course folder (course_id and folder_id), or any Canvas upload route (upload_tool and upload_arguments), such as a course's files, a group's or a person's files, an assignment or quiz submission, a submission comment, or a rubric CSV import. Morrow freezes the file name, size, SHA-256, target, signed-in session, and content type for review. File bytes stay private until one person approves this exact operation. Files are limited to 1 MiB. This tool does not upload a file.",
    inputSchema: canvasCourseFileUploadInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, context) => {
    return await runtime.planCanvasCourseFileUpload(input, {
      signal: context.mcpReq.signal,
      workspaceRoot,
    }) as CallToolResult;
  });
}
