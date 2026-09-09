import type { CatalogTool, JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { FileStageStore } from "../src/file-staging.js";
import {
  CANVAS_NEW_QUIZ_HOT_SPOT_OPERATION,
  CANVAS_NEW_QUIZ_HOT_SPOT_TOOL,
  assertHotSpotImageBytes,
  canvasNewQuizHotSpotContentType,
  canvasNewQuizHotSpotRequestSchema,
  canvasNewQuizHotSpotScope,
  exactHotSpotTemplate,
  isCanvasNewQuizHotSpotTransfer,
  unsignedHotSpotImageUrl,
} from "../src/canvas-new-quiz-hot-spot.js";

const BINDING: JsonObject = {
  provider: "canvas",
  sourceBindingId: "canvas:instructor",
  courseId: "42",
  runtimeVerified: true,
  origin: "https://canvas.example.edu",
  principalFingerprint: "a".repeat(64),
  sessionGeneration: 3,
  catalogDigest: "b".repeat(64),
};

const MAPPING = {
  publicName: "canvas_create_new_quiz_hot_spot",
  upstreamName: CANVAS_NEW_QUIZ_HOT_SPOT_TOOL,
  annotations: { readOnlyHint: false },
  capability: {
    provider: "canvas",
    route: { backend: "canvas-connector" },
    sourceImplementations: [{ toolName: CANVAS_NEW_QUIZ_HOT_SPOT_TOOL, sourceExport: CANVAS_NEW_QUIZ_HOT_SPOT_OPERATION }],
  },
} as unknown as CatalogTool;

describe("the reviewed Hot Spot contract", () => {
  it("names only the exact private route", () => {
    expect(isCanvasNewQuizHotSpotTransfer(MAPPING)).toBe(true);
    for (const change of [
      { upstreamName: "canvas_create_quiz_item" },
      { annotations: { readOnlyHint: true } },
      { capability: { ...MAPPING.capability, provider: "moodle" } },
      { capability: { ...MAPPING.capability, sourceImplementations: [{ toolName: CANVAS_NEW_QUIZ_HOT_SPOT_TOOL, sourceExport: "canvas.private.course_file.transfer.v1" }] } },
    ]) {
      expect(isCanvasNewQuizHotSpotTransfer({ ...MAPPING, ...change } as CatalogTool)).toBe(false);
    }
  });

  it("binds the image to one course, sign-in, session and catalog", () => {
    expect(canvasNewQuizHotSpotScope(BINDING, "canvas:instructor", "42", "image/png")).toEqual({
      provider: "canvas",
      sourceBindingId: "canvas:instructor",
      courseId: "42",
      origin: "https://canvas.example.edu",
      siteUrl: "https://canvas.example.edu/",
      principalFingerprint: "a".repeat(64),
      sessionGeneration: 3,
      catalogDigest: "b".repeat(64),
      toolName: CANVAS_NEW_QUIZ_HOT_SPOT_TOOL,
      operationKey: CANVAS_NEW_QUIZ_HOT_SPOT_OPERATION,
      contentType: "image/png",
    });
    for (const change of [
      { provider: "moodle" },
      { courseId: "43" },
      { runtimeVerified: false },
      { principalFingerprint: "short" },
      { sessionGeneration: 0 },
      { catalogDigest: "not-a-digest" },
    ]) {
      expect(() => canvasNewQuizHotSpotScope({ ...BINDING, ...change }, "canvas:instructor", "42", "image/png")).toThrow();
    }
    expect(() => canvasNewQuizHotSpotScope(BINDING, "canvas:other", "42", "image/png")).toThrow();
    expect(() => canvasNewQuizHotSpotScope(BINDING, "canvas:instructor", "42", "application/pdf")).toThrow();
  });

  it("accepts only the three image types Canvas documents", () => {
    expect(canvasNewQuizHotSpotContentType("materials/cell.png")).toBe("image/png");
    expect(canvasNewQuizHotSpotContentType("materials/cell.JPEG")).toBe("image/jpeg");
    expect(canvasNewQuizHotSpotContentType("materials/cell.jpg")).toBe("image/jpeg");
    expect(canvasNewQuizHotSpotContentType("materials/cell.gif")).toBe("image/gif");
    for (const name of ["materials/cell.pdf", "materials/cell.svg", "materials/cell"]) {
      expect(() => canvasNewQuizHotSpotContentType(name)).toThrow();
    }
  });

  it("refuses bytes that are not the image type the plan names", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(() => assertHotSpotImageBytes(png, "image/png")).not.toThrow();
    expect(() => assertHotSpotImageBytes(jpeg, "image/jpeg")).not.toThrow();
    expect(() => assertHotSpotImageBytes(gif, "image/gif")).not.toThrow();
    expect(() => assertHotSpotImageBytes(png, "image/jpeg")).toThrow();
    expect(() => assertHotSpotImageBytes(new Uint8Array([0x3c, 0x73, 0x76, 0x67]), "image/png")).toThrow();
    expect(() => assertHotSpotImageBytes(new Uint8Array(), "image/png")).toThrow();
  });

  it("keeps a reviewed question free of any image URL of its own", () => {
    const template = {
      entry_type: "Item",
      entry: { interaction_type_slug: "hot-spot", interaction_data: {} },
    };
    expect(exactHotSpotTemplate(template)).toEqual(template);
    expect(exactHotSpotTemplate({ ...template, entry: { ...template.entry, interaction_data: { image_url: "https://a.example/b.png" } } })).toBeNull();
    expect(exactHotSpotTemplate({ ...template, entry_type: "BankEntry" })).toBeNull();
    expect(exactHotSpotTemplate({ ...template, entry: { interaction_type_slug: "choice", interaction_data: {} } })).toBeNull();
  });

  it("drops the signature from the URL the created question carries", () => {
    expect(unsignedHotSpotImageUrl("https://uploads.example.net/m/cell.png?X-Amz-Signature=secret&e=1"))
      .toBe("https://uploads.example.net/m/cell.png");
    expect(unsignedHotSpotImageUrl("https://uploads.example.net/m/cell.png#top"))
      .toBe("https://uploads.example.net/m/cell.png");
    for (const value of [
      "http://uploads.example.net/m/cell.png",
      "https://user:secret@uploads.example.net/m/cell.png",
      "not a url",
      "",
      42,
      null,
    ]) {
      expect(() => unsignedHotSpotImageUrl(value)).toThrow("canvas_hot_spot_upload_url_refused");
    }
  });

  it("freezes the whole reviewed request and refuses anything else", () => {
    const request = {
      course_id: "42",
      assignment_id: "77",
      item: { entry_type: "Item" },
      before_items_sha256: "c".repeat(64),
      payload_sha256: "d".repeat(64),
      filename: "cell.png",
      size_bytes: 24,
      sha256: "e".repeat(64),
      content_type: "image/png",
    };
    expect(canvasNewQuizHotSpotRequestSchema.parse(request)).toMatchObject(request);
    expect(() => canvasNewQuizHotSpotRequestSchema.parse({ ...request, content_type: "image/svg+xml" })).toThrow();
    expect(() => canvasNewQuizHotSpotRequestSchema.parse({ ...request, size_bytes: 1024 * 1024 + 1 })).toThrow();
    expect(() => canvasNewQuizHotSpotRequestSchema.parse({ ...request, folder_id: 3 })).toThrow();
    expect(() => canvasNewQuizHotSpotRequestSchema.parse({ ...request, course_id: "0" })).toThrow();
  });
});

describe("the reviewed Hot Spot image in the stage store", () => {
  const scope = {
    provider: "canvas" as const,
    sourceBindingId: "canvas:instructor",
    origin: "https://canvas.example.edu",
    siteUrl: "https://canvas.example.edu/",
    principalFingerprint: "a".repeat(64),
    sessionGeneration: 3,
    catalogDigest: "b".repeat(64),
    courseId: "42",
    toolName: CANVAS_NEW_QUIZ_HOT_SPOT_TOOL,
    operationKey: CANVAS_NEW_QUIZ_HOT_SPOT_OPERATION,
    contentType: "image/png",
  };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);

  function staged() {
    const store = new FileStageStore();
    const receipt = store.stage({ bytes: png, filename: "cell.png", scope, expiresAt: Date.now() + 120_000 });
    const binding = { handle: receipt.handle, manifest: receipt.manifest, scope, operationId: "op:hot-spot-1" };
    store.bind(binding);
    return { store, binding };
  }

  // This is the guarantee the dispatch depends on. It consumes the image before
  // it sends anything, so a refusal that comes back from Chrome, for a missing
  // permission or for any other reason, cannot leave the image behind: by then
  // there is nothing left to leave.
  it("hands the image over exactly once and keeps nothing after it", () => {
    const { store, binding } = staged();
    const dispatch = store.consume(binding);
    expect(dispatch.bytes).toEqual(png);
    expect(() => store.consume(binding)).toThrow("file_stage_unavailable");
    expect(() => store.verify(binding)).toThrow("file_stage_unavailable");
  });

  // The plan's own catch, and a cancelled operation, both discard by handle.
  it("keeps nothing after a discard, and a discard is safe to repeat", () => {
    const { store, binding } = staged();
    store.discard(binding.handle);
    expect(() => store.consume(binding)).toThrow("file_stage_unavailable");
    expect(() => store.discard(binding.handle)).not.toThrow();
  });

  // An image nobody approves is not kept: the store reaps it at its deadline.
  it("keeps nothing after the review window closes", () => {
    let now = 1_000_000;
    const store = new FileStageStore({ now: () => now });
    const receipt = store.stage({ bytes: png, filename: "cell.png", scope, expiresAt: now + 120_000 });
    const binding = { handle: receipt.handle, manifest: receipt.manifest, scope, operationId: "op:hot-spot-2" };
    store.bind(binding);
    now += 120_001;
    expect(store.reap()).toBe(1);
    expect(() => store.consume(binding)).toThrow("file_stage_unavailable");
  });
});
