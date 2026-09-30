import { describe, expect, it } from "vitest";
import { collectCanvasPrivacyCollection } from "../src/canvas-privacy-pagination.js";

describe("bounded Canvas privacy roster pagination", () => {
  const complete = (data: unknown[] = []) => ({ ok: true, sent: true, truncated: false, data });
  it("accepts complete empty and nonempty collections", async () => {
    expect(await collectCanvasPrivacyCollection(async () => complete(), "incomplete")).toEqual([]);
    expect(await collectCanvasPrivacyCollection(async () => complete([{ id: "17" }]), "incomplete")).toEqual([{ id: "17" }]);
  });
  it.each([
    { ...complete(), truncated: true },
    { ...complete(), truncated: true, morrow_next_page: "http://evil.example", morrow_pages_read: 1 },
    { ...complete(), truncated: true, morrow_next_page: "opaque-token", morrow_pages_read: 0 },
    { ...complete(), truncated: undefined },
    { ...complete(), ok: false },
    { ...complete(), data: {} },
  ])("refuses incomplete or untrusted continuation evidence", async (result) => {
    await expect(collectCanvasPrivacyCollection(async () => result, "incomplete")).rejects.toThrow("incomplete");
  });
  it("refuses repeated tokens, non-progress, and a continuation beyond its total page bound", async () => {
    for (const mode of ["repeat", "no-progress", "excess"]) {
      let calls = 0;
      await expect(collectCanvasPrivacyCollection(async () => {
        calls += 1;
        return { ...complete(), truncated: true, morrow_next_page: mode === "repeat" ? "repeated-token" : `opaque-token-${calls}`,
          morrow_pages_read: mode === "no-progress" ? 1 : mode === "excess" ? 500 : calls };
      }, "incomplete")).rejects.toThrow("incomplete");
      expect(calls).toBeLessThanOrEqual(3);
    }
  });
  it("refuses a collection beyond its row bound", async () => {
    await expect(collectCanvasPrivacyCollection(async () => complete(Array.from({ length: 50_001 }, () => ({ id: "17" }))), "incomplete")).rejects.toThrow("incomplete");
  });
});
