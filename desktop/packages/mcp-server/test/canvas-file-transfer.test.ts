import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canvasCourseFileUploadInputSchema,
  canvasFileScope,
  contentTypeForCanvasFile,
  readWorkspaceMaterial,
} from "../src/canvas-file-transfer.js";

const binding = {
  provider: "canvas",
  sourceBindingId: "canvas:course-42",
  courseId: "42",
  origin: "https://canvas.example.edu",
  principalFingerprint: "a".repeat(64),
  sessionGeneration: 2,
  catalogDigest: "b".repeat(64),
  runtimeVerified: true,
};

describe("Canvas reviewed file admission", () => {
  it("freezes an exact current Canvas scope with a canonical content type", () => {
    expect(canvasFileScope(binding, "canvas:course-42", "42", "text/plain")).toMatchObject({
      provider: "canvas",
      courseId: "42",
      origin: "https://canvas.example.edu",
      siteUrl: "https://canvas.example.edu/",
      contentType: "text/plain",
    });
    expect(() => canvasFileScope({ ...binding, sessionGeneration: 0 }, "canvas:course-42", "42", "text/plain"))
      .toThrow("selected Canvas course connection changed");
    expect(contentTypeForCanvasFile("lesson.html")).toBe("text/html");
    expect(contentTypeForCanvasFile("binary.material")).toBe("application/octet-stream");
  });

  it("keeps Canvas course and folder IDs exact across the public planning boundary", () => {
    expect(canvasCourseFileUploadInputSchema.parse({
      source_binding_id: "canvas:course-large",
      course_id: "9007199254740993",
      folder_id: "9999999999999999999",
      material_path: "materials/guide.txt",
    })).toMatchObject({
      course_id: "9007199254740993",
      folder_id: "9999999999999999999",
    });
    expect(canvasCourseFileUploadInputSchema.parse({
      source_binding_id: "canvas:course-42",
      course_id: 42,
      folder_id: 71,
      material_path: "materials/guide.txt",
    })).toMatchObject({ course_id: "42", folder_id: "71" });
    expect(canvasCourseFileUploadInputSchema.safeParse({
      source_binding_id: "canvas:course-large",
      course_id: 9_007_199_254_740_993,
      folder_id: 71,
      material_path: "materials/guide.txt",
    }).success).toBe(false);
    // Any other target is named by its upload route and ids; the two forms do not mix.
    expect(canvasCourseFileUploadInputSchema.parse({
      source_binding_id: "canvas:course-42",
      upload_tool: "canvas_upload_file_courses",
      upload_arguments: { course_id: 42, assignment_id: "7", user_id: "Student A1" },
      material_path: "materials/guide.txt",
    })).toMatchObject({ upload_arguments: { course_id: "42", assignment_id: "7", user_id: "Student A1" } });
    for (const mixed of [
      { course_id: "42", folder_id: "71", upload_tool: "canvas_upload_file_v1_groups_group_id_files_post", upload_arguments: { group_id: "9" } },
      { upload_tool: "canvas_upload_file_v1_groups_group_id_files_post" },
      { folder_id: "71" },
      { upload_tool: "canvas_upload_file_v1_groups_group_id_files_post", upload_arguments: { group_id: "../9" } },
    ]) {
      expect(canvasCourseFileUploadInputSchema.safeParse({
        source_binding_id: "canvas:course-42", material_path: "materials/guide.txt", ...mixed,
      }).success, JSON.stringify(mixed)).toBe(false);
    }
  });

  it("admits a real nonempty file anywhere in the materials folder the assistant works in, and nothing outside it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "morrow-canvas-material-"));
    // Desktop runs the assistant in its Materials folder, so that folder is the workspace root.
    const root = join(parent, "Materials");
    try {
      await mkdir(join(root, "Week 1"), { recursive: true });
      await mkdir(join(root, "materials"));
      const syllabus = Buffer.from("syllabus placed directly in the Materials folder");
      const notes = Buffer.from("notes in a folder inside it");
      const guide = Buffer.from("a project that keeps a materials folder");
      await writeFile(join(root, "syllabus.pdf"), syllabus);
      await writeFile(join(root, "Week 1", "notes.txt"), notes);
      await writeFile(join(root, "materials", "guide.txt"), guide);
      await writeFile(join(root, ".env"), "hidden settings");
      await writeFile(join(parent, "outside.txt"), "private content");
      await symlink(join(parent, "outside.txt"), join(root, "linked.txt"));
      const workspaceRoot = await realpath(root);
      await expect(readWorkspaceMaterial("syllabus.pdf", workspaceRoot)).resolves.toEqual({ filename: "syllabus.pdf", bytes: syllabus });
      await expect(readWorkspaceMaterial("Week 1/notes.txt", workspaceRoot)).resolves.toEqual({ filename: "notes.txt", bytes: notes });
      await expect(readWorkspaceMaterial("materials/guide.txt", workspaceRoot)).resolves.toEqual({ filename: "guide.txt", bytes: guide });
      for (const value of ["../outside.txt", "materials/../syllabus.pdf", "./syllabus.pdf", ".env", "linked.txt", "missing.pdf", "/tmp/guide.txt"]) {
        await expect(readWorkspaceMaterial(value, workspaceRoot), value).rejects.toThrow();
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("accepts a material named by its path inside the materials folder", () => {
    for (const material_path of ["q1.pdf", "syllabus.pdf", "Week 1/notes.txt", "materials/guide.txt"]) {
      expect(canvasCourseFileUploadInputSchema.safeParse({
        source_binding_id: "canvas:course-42", course_id: 42, folder_id: 71, material_path,
      }).success, material_path).toBe(true);
    }
  });

  it("does not expose a material digest as bytes", () => {
    const bytes = Buffer.from("canonical material");
    const manifest = {
      filename: "guide.txt",
      size_bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    expect(JSON.stringify(manifest)).not.toContain(bytes.toString());
  });
});
