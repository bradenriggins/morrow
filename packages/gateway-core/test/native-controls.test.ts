import { describe, expect, it } from "vitest";
import { mergeCatalog } from "../src/index.js";

const emptySchema = { type: "object", properties: {} };

describe("native control ownership", () => {
  it("excludes donor batch recovery instead of publishing an alternate control", () => {
    const catalog = mergeCatalog([{
      id: "meridian",
      label: "ExamplePlatform",
      priority: 100,
      tools: [
        { name: "morrow_batch_recover", inputSchema: emptySchema },
        { name: "canvas_page_get", inputSchema: emptySchema },
      ],
    }], { generatedAt: "2026-09-03T00:00:00.000Z" });

    expect(catalog.tools.map((tool) => tool.publicName)).toEqual(["canvas_page_get"]);
    expect(catalog.collisions).toEqual([]);
    expect(catalog.excluded).toEqual([{
      upstreamId: "meridian",
      upstreamName: "morrow_batch_recover",
      reason: "excluded_name",
    }]);
  });
});
