import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { isJsonObject, type CatalogTool, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { MAX_STAGED_FILE_BYTES, type FileStageScope } from "./file-staging.js";
import type { GatewayRuntime } from "./runtime.js";

export const MOODLE_RESOURCE_FILE_TOOL = "moodle_create_resource_file";
export const MOODLE_RESOURCE_FILE_READ_TOOL = "moodle_get_resource_file_creation_form";
export const MOODLE_RESOURCE_FILE_OPERATION = "moodle.form.course.modedit.resource.file.create.write.v1";
export const MOODLE_FOLDER_FILE_TOOL = "moodle_create_folder_file";
export const MOODLE_FOLDER_FILE_READ_TOOL = "moodle_get_folder_file_creation_form";
export const MOODLE_FOLDER_FILE_OPERATION = "moodle.form.course.modedit.folder.file.create.write.v1";
export const MOODLE_IMSCP_PACKAGE_TOOL = "moodle_create_imscp_package";
export const MOODLE_IMSCP_PACKAGE_READ_TOOL = "moodle_get_imscp_package_creation_form";
export const MOODLE_IMSCP_PACKAGE_OPERATION = "moodle.form.course.modedit.imscp.package.create.write.v1";
export const MOODLE_SCORM_PACKAGE_TOOL = "moodle_create_scorm_package";
export const MOODLE_SCORM_PACKAGE_READ_TOOL = "moodle_get_scorm_package_creation_form";
export const MOODLE_SCORM_PACKAGE_OPERATION = "moodle.form.course.modedit.scorm.package.create.write.v1";
export const MOODLE_RESOURCE_REPLACEMENT_TOOL = "moodle_replace_resource_file";
export const MOODLE_RESOURCE_REPLACEMENT_READ_TOOL = "moodle_get_resource_files";
export const MOODLE_RESOURCE_REPLACEMENT_OPERATION = "moodle.form.course.modedit.resource.file.replace.write.v1";
export const MOODLE_FOLDER_FILES_TOOL = "moodle_add_folder_files";
export const MOODLE_FOLDER_FILES_READ_TOOL = "moodle_get_folder_files";
export const MOODLE_FOLDER_FILES_OPERATION = "moodle.form.course.modedit.folder.files.add.write.v1";
export const MOODLE_SCORM_REPLACEMENT_TOOL = "moodle_replace_scorm_package";
export const MOODLE_SCORM_REPLACEMENT_READ_TOOL = "moodle_get_scorm";
export const MOODLE_SCORM_REPLACEMENT_OPERATION = "moodle.form.course.modedit.scorm.package.replace.write.v1";
export const MOODLE_H5P_REPLACEMENT_TOOL = "moodle_replace_h5pactivity_package";
export const MOODLE_H5P_REPLACEMENT_READ_TOOL = "moodle_get_h5pactivity";
export const MOODLE_H5P_REPLACEMENT_OPERATION = "moodle.form.course.modedit.h5pactivity.package.replace.write.v1";
export const RESOURCE_FILE_APPROVAL_TTL_MS = 15 * 60_000;

export type MoodleStagedFileKind = "resource" | "folder" | "imscp" | "scorm" | "h5p" | "resource_replacement" | "folder_files" | "scorm_replacement" | "h5p_replacement";

export type MoodleStagedFileCapability = Readonly<{
  kind: MoodleStagedFileKind;
  module: "resource" | "folder" | "imscp" | "scorm" | "h5pactivity";
  toolName: string;
  preparationReadToolName: string;
  operationKey: string;
  planMode: "create" | "replace" | "folder_add";
  publicPlanToolName: string;
  title: string;
  description: string;
  noun: string;
}>;

export const MOODLE_STAGED_FILE_CAPABILITIES: Readonly<Record<MoodleStagedFileKind, MoodleStagedFileCapability>> = Object.freeze({
  resource: Object.freeze({
    kind: "resource", module: "resource", toolName: MOODLE_RESOURCE_FILE_TOOL,
    preparationReadToolName: MOODLE_RESOURCE_FILE_READ_TOOL, operationKey: MOODLE_RESOURCE_FILE_OPERATION, planMode: "create",
    publicPlanToolName: "morrow_plan_moodle_resource_file", title: "Prepare a course file for review",
    description: "Prepare one local file from this assistant's project folder as a new hidden Moodle Resource in one selected course section.", noun: "Resource",
  }),
  folder: Object.freeze({
    kind: "folder", module: "folder", toolName: MOODLE_FOLDER_FILE_TOOL,
    preparationReadToolName: MOODLE_FOLDER_FILE_READ_TOOL, operationKey: MOODLE_FOLDER_FILE_OPERATION, planMode: "create",
    publicPlanToolName: "morrow_plan_moodle_folder_file", title: "Prepare a Folder file for review",
    description: "Prepare one local file from this assistant's project folder as a new hidden Moodle Folder in one selected course section.", noun: "Folder",
  }),
  imscp: Object.freeze({
    kind: "imscp", module: "imscp", toolName: MOODLE_IMSCP_PACKAGE_TOOL,
    preparationReadToolName: MOODLE_IMSCP_PACKAGE_READ_TOOL, operationKey: MOODLE_IMSCP_PACKAGE_OPERATION, planMode: "create",
    publicPlanToolName: "morrow_plan_moodle_imscp_package", title: "Prepare an IMS content package for review",
    description: "Prepare one local ZIP or IMS Common Cartridge file from this assistant's project folder as a new hidden Moodle IMS content package in one selected course section.", noun: "IMS content package",
  }),
  scorm: Object.freeze({
    kind: "scorm", module: "scorm", toolName: MOODLE_SCORM_PACKAGE_TOOL,
    preparationReadToolName: MOODLE_SCORM_PACKAGE_READ_TOOL, operationKey: MOODLE_SCORM_PACKAGE_OPERATION, planMode: "create",
    publicPlanToolName: "morrow_plan_moodle_scorm_package", title: "Prepare a SCORM package for review",
    description: "Prepare one local ZIP file from this assistant's project folder as a new hidden Moodle SCORM activity in one selected course section.", noun: "SCORM package",
  }),
  h5p: Object.freeze({
    kind: "h5p", module: "h5pactivity", toolName: "moodle_create_h5pactivity",
    preparationReadToolName: "moodle_get_h5pactivity_creation_form", operationKey: "moodle.form.course.modedit.h5pactivity.create.write.v1", planMode: "create",
    publicPlanToolName: "morrow_plan_moodle_h5p_package", title: "Prepare an H5P package for review",
    description: "Prepare one local .h5p file from this assistant's project folder as a new hidden Moodle H5P activity in one selected course section.", noun: "H5P package",
  }),
  resource_replacement: Object.freeze({
    kind: "resource_replacement", module: "resource", toolName: MOODLE_RESOURCE_REPLACEMENT_TOOL,
    preparationReadToolName: MOODLE_RESOURCE_REPLACEMENT_READ_TOOL, operationKey: MOODLE_RESOURCE_REPLACEMENT_OPERATION, planMode: "replace",
    publicPlanToolName: "morrow_plan_moodle_resource_file_replacement", title: "Prepare a Resource file replacement for review",
    description: "Prepare one local file from this assistant's project folder to replace the saved file of one selected Moodle Resource.", noun: "Resource file replacement",
  }),
  folder_files: Object.freeze({
    kind: "folder_files", module: "folder", toolName: MOODLE_FOLDER_FILES_TOOL,
    preparationReadToolName: MOODLE_FOLDER_FILES_READ_TOOL, operationKey: MOODLE_FOLDER_FILES_OPERATION, planMode: "folder_add",
    publicPlanToolName: "morrow_plan_moodle_folder_files", title: "Prepare Folder files for review",
    description: "Prepare up to eight local files from this assistant's project folder to add to one existing path in a selected Moodle Folder.", noun: "Folder files",
  }),
  scorm_replacement: Object.freeze({
    kind: "scorm_replacement", module: "scorm", toolName: MOODLE_SCORM_REPLACEMENT_TOOL,
    preparationReadToolName: MOODLE_SCORM_REPLACEMENT_READ_TOOL, operationKey: MOODLE_SCORM_REPLACEMENT_OPERATION, planMode: "replace",
    publicPlanToolName: "morrow_plan_moodle_scorm_package_replacement", title: "Prepare a SCORM package replacement for review",
    description: "Prepare one local ZIP file from this assistant's project folder to replace the saved package of one selected Moodle SCORM activity.", noun: "SCORM package replacement",
  }),
  h5p_replacement: Object.freeze({
    kind: "h5p_replacement", module: "h5pactivity", toolName: MOODLE_H5P_REPLACEMENT_TOOL,
    preparationReadToolName: MOODLE_H5P_REPLACEMENT_READ_TOOL, operationKey: MOODLE_H5P_REPLACEMENT_OPERATION, planMode: "replace",
    publicPlanToolName: "morrow_plan_moodle_h5p_package_replacement", title: "Prepare an H5P package replacement for review",
    description: "Prepare one local .h5p file from this assistant's project folder to replace the saved package of one selected hidden Moodle H5P activity.", noun: "H5P package replacement",
  }),
});

export const moodleStagedFileCapability = (kind: MoodleStagedFileKind): MoodleStagedFileCapability => MOODLE_STAGED_FILE_CAPABILITIES[kind];

export const moodleResourceFileInputSchema = z.strictObject({
  source_binding_id: z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/),
  course_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  section_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().trim().min(1).max(1333),
  file_path: z.string().min(1).max(4096),
});

export type MoodleResourceFileInput = z.infer<typeof moodleResourceFileInputSchema>;

const moodleModuleFileInput = {
  source_binding_id: z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/),
  course_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  module_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

export const moodleResourceFileReplacementInputSchema = z.strictObject({
  ...moodleModuleFileInput,
  file_path: z.string().min(1).max(4096),
});

export const moodleFolderFilesInputSchema = z.strictObject({
  ...moodleModuleFileInput,
  folder_path: z.string().regex(/^\/(?:[^\\/]+\/)*$/).optional().default("/"),
  file_paths: z.array(z.string().min(1).max(4096)).min(1).max(8),
});

export function moodleStagedFileCapabilityForMapping(mapping: CatalogTool): MoodleStagedFileCapability | null {
  for (const capability of Object.values(MOODLE_STAGED_FILE_CAPABILITIES)) {
    if (mapping.upstreamName === capability.toolName
      && mapping.capability?.provider === "moodle"
      && mapping.capability.route.backend === "canvas-connector"
      && mapping.annotations?.readOnlyHint === false
      && mapping.capability.sourceImplementations.some((source) => (
        source.toolName === capability.toolName && source.sourceExport === capability.operationKey
      ))) return capability;
  }
  return null;
}

export function isMoodleStagedFile(mapping: CatalogTool): boolean {
  return moodleStagedFileCapabilityForMapping(mapping) !== null;
}

/** Kept for callers that explicitly need the existing Resource predicate. */
export function isMoodleResourceFile(mapping: CatalogTool): boolean {
  return moodleStagedFileCapabilityForMapping(mapping)?.kind === "resource";
}

export function moodleStagedFileScope(
  binding: JsonObject,
  sourceBindingId: string,
  courseId: number,
  capability: MoodleStagedFileCapability,
): FileStageScope {
  if (binding.provider !== "moodle" || binding.sourceBindingId !== sourceBindingId
    || binding.courseId !== String(courseId) || binding.runtimeVerified !== true
    || typeof binding.origin !== "string" || typeof binding.siteUrl !== "string"
    || typeof binding.principalFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(binding.principalFingerprint)
    || typeof binding.sessionGeneration !== "number" || !Number.isSafeInteger(binding.sessionGeneration) || binding.sessionGeneration < 1
    || typeof binding.catalogDigest !== "string" || !/^[a-f0-9]{64}$/.test(binding.catalogDigest)) {
    throw new Error("The selected Moodle course connection changed. Read its current connection and prepare the file again.");
  }
  return {
    provider: "moodle",
    sourceBindingId,
    courseId: String(courseId),
    origin: binding.origin,
    siteUrl: binding.siteUrl,
    principalFingerprint: binding.principalFingerprint,
    sessionGeneration: binding.sessionGeneration,
    catalogDigest: binding.catalogDigest,
    toolName: capability.toolName,
    operationKey: capability.operationKey,
  };
}

export function resourceFileScope(binding: JsonObject, sourceBindingId: string, courseId: number): FileStageScope {
  return moodleStagedFileScope(binding, sourceBindingId, courseId, MOODLE_STAGED_FILE_CAPABILITIES.resource);
}

export function folderFileScope(binding: JsonObject, sourceBindingId: string, courseId: number): FileStageScope {
  return moodleStagedFileScope(binding, sourceBindingId, courseId, MOODLE_STAGED_FILE_CAPABILITIES.folder);
}

export function assertNoPrivateAttachmentInput(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoPrivateAttachmentInput);
  } else if (isJsonObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (["privateattachment", "privateattachments", "bytesbase64"].includes(key.replace(/[^a-z0-9]/gi, "").toLowerCase())) {
        throw new TypeError("File bytes cannot be supplied in tool arguments. Prepare a local file for review.");
      }
      assertNoPrivateAttachmentInput(entry);
    }
  }
}

export async function readWorkspaceFile(
  filePath: string,
  workingDirectory: string,
  admittedDirectory = workingDirectory,
): Promise<{ filename: string; bytes: Buffer }> {
  let handle;
  let bytes: Buffer | undefined;
  try {
    const root = await realpath(workingDirectory);
    if (root !== workingDirectory) throw new Error("workspace_root_changed");
    const admitted = await realpath(admittedDirectory);
    const candidate = resolve(root, filePath);
    const target = await realpath(candidate);
    const localPath = relative(root, target);
    const admittedPath = relative(admitted, target);
    if (!localPath || isAbsolute(localPath) || localPath === ".." || localPath.startsWith(".." + sep)
      || !admittedPath || isAbsolute(admittedPath) || admittedPath === ".." || admittedPath.startsWith(".." + sep)) {
      throw new Error("file_outside_workspace");
    }
    const before = await lstat(target);
    if (!before.isFile() || before.size < 1 || before.size > MAX_STAGED_FILE_BYTES) throw new Error("file_size_or_type_invalid");
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("file_changed_before_read");
    }
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("file_changed_during_read");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(target);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino || await realpath(candidate) !== target
      || relative(await realpath(admittedDirectory), target).startsWith(".." + sep)) {
      throw new Error("file_changed_during_read");
    }
    return { filename: basename(target), bytes };
  } catch {
    bytes?.fill(0);
    throw new Error("Choose a regular file inside this assistant's project folder. The file must be nonempty, at most 1 MiB, and unchanged while it is read.");
  } finally {
    await handle?.close();
  }
}

export function registerMoodleResourceFileTool(
  server: McpServer,
  runtime: GatewayRuntime,
  workspaceRoot?: string,
): void {
  for (const capability of Object.values(MOODLE_STAGED_FILE_CAPABILITIES)) {
    const inputSchema = capability.planMode === "create"
      ? moodleResourceFileInputSchema
      : capability.planMode === "folder_add"
        ? moodleFolderFilesInputSchema
        : moodleResourceFileReplacementInputSchema;
    server.registerTool(capability.publicPlanToolName, {
      title: capability.title,
      description: `${capability.description} Read the current native form or file state and freeze the file name, size, SHA-256, target, account, and session for review. File bytes stay in local memory until a person approves the exact operation. Files are limited to 1 MiB. Approval expires after 15 minutes; a restart or changed connection requires a new plan. This tool does not upload or save the file.`,
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (input: unknown, context: ServerContext) => {
      return await runtime.planMoodleStagedFile(input, capability.kind, {
        signal: context.mcpReq.signal,
        workspaceRoot,
      }) as CallToolResult;
    });
  }
}
