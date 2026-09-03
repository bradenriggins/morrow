import { describe, expect, it } from "vitest";
import { normalizeUpstreamResult } from "../src/index.js";

const mapping = {
  publicName: "canvas_page_get",
  upstreamId: "meridian",
  upstreamLabel: "Meridian",
  upstreamName: "canvas_page_get",
  inputSchema: { type: "object" },
};

describe("normalizeUpstreamResult", () => {
  it("preserves MCP content and adds bounded gateway metadata", () => {
    const result = normalizeUpstreamResult({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { value: 1 },
    }, {
      mapping,
      catalogDigest: "a".repeat(64),
    });

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(result.structuredContent).toEqual({ value: 1 });
    expect((result._meta as Record<string, unknown>)["io.morrow/gateway"]).toMatchObject({
      upstreamId: "meridian",
      upstreamToolName: "canvas_page_get",
    });
  });
});
