import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStageStore, MAX_PENDING_FILE_STAGES, type FileStageScope } from "../src/file-staging.js";
import {
  assertNoPrivateAttachmentInput,
  MOODLE_STAGED_FILE_CAPABILITIES,
  readWorkspaceFile,
} from "../src/moodle-resource-file.js";
import { GatewayRuntime } from "../src/runtime.js";

describe("local course-file admission", () => {
  it("reads exact project file bytes and refuses outside, linked-outside, empty, and non-file inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-workspace-file-"));
    const workspace = join(directory, "project");
    await mkdir(workspace);
    try {
      const bytes = Buffer.from([0, 0, 42, 255]);
      await writeFile(join(workspace, "evidence.bin"), bytes);
      await writeFile(join(workspace, "empty.txt"), "");
      await writeFile(join(directory, "outside.txt"), "private outside content");
      await symlink(join(directory, "outside.txt"), join(workspace, "linked.txt"));
      const admittedWorkspace = await realpath(workspace);
      const admitted = await readWorkspaceFile("evidence.bin", admittedWorkspace);
      expect(admitted).toEqual({ filename: "evidence.bin", bytes });
      for (const path of ["../outside.txt", "linked.txt", "empty.txt", "."]) {
        await expect(readWorkspaceFile(path, admittedWorkspace)).rejects.toThrow("inside this assistant's project folder");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses private file payloads in any public argument location", () => {
    for (const value of [{ privateAttachment: {} }, { nested: [{ bytes_base64: "AA==" }] }, { private_attachment: {} }]) {
      expect(() => assertNoPrivateAttachmentInput(value)).toThrow("File bytes cannot be supplied");
    }
    expect(() => assertNoPrivateAttachmentInput({ filename: "lesson.pdf", size_bytes: 23, sha256: "a".repeat(64) })).not.toThrow();
  });

  it("refuses a workspace path that resolves somewhere else after admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-workspace-root-change-"));
    const workspace = join(directory, "project");
    const replacement = join(directory, "replacement");
    try {
      await mkdir(workspace);
      await mkdir(replacement);
      await writeFile(join(replacement, "evidence.txt"), "replacement content");
      const admittedWorkspace = await realpath(workspace);
      await rename(admittedWorkspace, join(directory, "original-project"));
      await symlink(await realpath(replacement), admittedWorkspace);
      await expect(readWorkspaceFile("evidence.txt", admittedWorkspace))
        .rejects.toThrow("inside this assistant's project folder");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes only newly allocated Folder stages when a later file reaches capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-folder-stage-cleanup-"));
    const workspace = await realpath(directory);
    const capability = MOODLE_STAGED_FILE_CAPABILITIES.folder_files;
    const scope: FileStageScope = {
      provider: "moodle",
      sourceBindingId: "moodle:folder-cleanup",
      origin: "https://moodle.example.edu",
      siteUrl: "https://moodle.example.edu/learn",
      principalFingerprint: "a".repeat(64),
      sessionGeneration: 1,
      catalogDigest: "b".repeat(64),
      courseId: "42",
      toolName: capability.toolName,
      operationKey: capability.operationKey,
    };
    const store = new FileStageStore();
    const stored = (store as unknown as {
      stages: Map<string, { bytes: Buffer; operationId: string | null }>;
    }).stages;
    const existing: Array<{ handle: string; bytes: Buffer; operationId: string | null }> = [];
    const newlyAllocated: Array<{ handle: string; bytes: Buffer }> = [];
    try {
      for (let index = 0; index < MAX_PENDING_FILE_STAGES - 1; index += 1) {
        const receipt = store.stage({
          bytes: Buffer.from(`existing-${index}`),
          filename: `existing-${index}.txt`,
          scope,
          expiresAt: Date.now() + 120_000,
        });
        if (index === 0) store.bind({ ...receipt, scope, operationId: "op:existing-stage" });
        const entry = stored.get(receipt.handle)!;
        existing.push({ handle: receipt.handle, bytes: Buffer.from(entry.bytes), operationId: entry.operationId });
      }

      const allocate = store.stage.bind(store);
      store.stage = (request) => {
        const receipt = allocate(request);
        newlyAllocated.push({ handle: receipt.handle, bytes: stored.get(receipt.handle)!.bytes });
        return receipt;
      };

      await writeFile(join(workspace, "first.txt"), "first private file");
      await writeFile(join(workspace, "second.txt"), "second private file");
      const writeMapping = {
        publicName: capability.toolName,
        upstreamId: "browser-session",
        upstreamName: capability.toolName,
        annotations: { readOnlyHint: false },
        capability: {
          provider: "moodle",
          route: { backend: "canvas-connector" },
          sourceImplementations: [{ toolName: capability.toolName, sourceExport: capability.operationKey }],
        },
      };
      const readMapping = {
        publicName: capability.preparationReadToolName,
        upstreamId: "browser-session",
        upstreamName: capability.preparationReadToolName,
        annotations: { readOnlyHint: true },
      };
      const runtime = {
        catalog: { tools: [writeMapping, readMapping] },
        fileStages: store,
        currentMoodleStagedFileScope: async () => scope,
        callSourceOwned: async () => ({
          structuredContent: {
            schema: "morrow.canvas-connector.result.v1",
            provider: "moodle",
            ok: true,
            result: {
              ok: true,
              sent: true,
              data: { course_id: 42, module_id: 32 },
              snapshot_digest: "c".repeat(64),
            },
          },
        }),
        resolveResultArtifact: (value: unknown) => value,
        planOperationRejected: (_tool: string, error: unknown) => ({
          isError: true,
          message: error instanceof Error ? error.message : String(error),
        }),
      } as unknown as GatewayRuntime;

      const result = await GatewayRuntime.prototype.planMoodleStagedFile.call(runtime, {
        source_binding_id: scope.sourceBindingId,
        course_id: 42,
        module_id: 32,
        folder_path: "/",
        file_paths: ["first.txt", "second.txt"],
      }, "folder_files", { workspaceRoot: workspace });

      expect(result).toMatchObject({ isError: true, message: "file_stage_capacity_reached" });
      expect([...stored.keys()].sort()).toEqual(existing.map((entry) => entry.handle).sort());
      for (const entry of existing) {
        expect(stored.get(entry.handle)).toMatchObject({ bytes: entry.bytes, operationId: entry.operationId });
      }
      expect(newlyAllocated).toHaveLength(1);
      expect(stored.has(newlyAllocated[0]!.handle)).toBe(false);
      expect([...newlyAllocated[0]!.bytes]).toEqual(Array(newlyAllocated[0]!.bytes.length).fill(0));
    } finally {
      store.clear();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
