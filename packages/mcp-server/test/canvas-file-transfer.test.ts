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
  });

  it("admits only a real nonempty file below the project materials folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "morrow-canvas-material-"));
    const materials = join(root, "materials");
    try {
      await mkdir(materials);
      const bytes = Buffer.from("exact canonical material");
      await writeFile(join(materials, "guide.txt"), bytes);
      await writeFile(join(root, "outside.txt"), "private content");
      await symlink(join(root, "outside.txt"), join(materials, "linked.txt"));
      const workspaceRoot = await realpath(root);
      await expect(readWorkspaceMaterial("materials/guide.txt", workspaceRoot)).resolves.toEqual({ filename: "guide.txt", bytes });
      for (const value of ["guide.txt", "../outside.txt", "materials/../outside.txt", "materials/linked.txt", "/tmp/guide.txt"]) {
        await expect(readWorkspaceMaterial(value, workspaceRoot)).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
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
