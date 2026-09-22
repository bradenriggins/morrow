import { describe, expect, it } from "vitest";
import { canvasReadResult } from "../src/canvas-read.js";

const answer = (browser: Record<string, unknown>) => ({
  structuredContent: {
    schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read",
    result: { ok: true, sent: true, ...browser },
  },
});
const runtime = { resultPage: () => ({}) } as never;

describe("canvasReadResult", () => {
  it("accepts one record, which carries no page bound", () => {
    expect(canvasReadResult(runtime, answer({ data: { id: "1", name: "Course" } })).data).toEqual({ id: "1", name: "Course" });
  });

  it("refuses one record Canvas says was cut short", () => {
    expect(() => canvasReadResult(runtime, answer({ data: { id: "1" }, truncated: true }))).toThrow();
  });

  it("requires a listing to say it is complete", () => {
    expect(() => canvasReadResult(runtime, answer({ data: [{ id: "1" }] }))).toThrow();
    expect(canvasReadResult(runtime, answer({ data: [{ id: "1" }], truncated: false })).data).toEqual([{ id: "1" }]);
  });
});
