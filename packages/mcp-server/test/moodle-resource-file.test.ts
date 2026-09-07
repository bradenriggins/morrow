import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoPrivateAttachmentInput, readWorkspaceFile } from "../src/moodle-resource-file.js";

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
});
