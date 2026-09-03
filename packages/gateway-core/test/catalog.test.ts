import { describe, expect, it } from "vitest";
import { mergeCatalog } from "../src/index.js";

const emptySchema = { type: "object", properties: {} };

describe("mergeCatalog", () => {
  it("keeps the higher-priority source name and aliases a collision", () => {
    const snapshot = mergeCatalog([
      {
        id: "meridian",
        label: "Meridian",
        priority: 100,
        tools: [{ name: "canvas_page_get", inputSchema: emptySchema }],
      },
      {
        id: "morrow-legacy",
        label: "Morrow legacy",
        priority: 50,
        tools: [{ name: "canvas_page_get", inputSchema: emptySchema }],
      },
    ], { generatedAt: "2026-09-03T00:00:00.000Z" });

    expect(snapshot.tools.map((tool) => tool.publicName)).toEqual([
      "canvas_page_get",
      "morrow_legacy__canvas_page_get",
    ]);
    expect(snapshot.collisions).toEqual([{
      requestedName: "canvas_page_get",
      retainedBy: "meridian",
      aliasedSource: "morrow-legacy",
      aliasedTo: "morrow_legacy__canvas_page_get",
    }]);
  });

  it("excludes held provider prefixes before publication", () => {
    const snapshot = mergeCatalog([{
      id: "meridian",
      label: "Meridian",
      priority: 100,
      tools: [
        { name: "canvas_page_get", inputSchema: emptySchema },
        { name: "mindtap_read", inputSchema: emptySchema },
        { name: "connect_read", inputSchema: emptySchema },
      ],
    }], {
      generatedAt: "2026-09-03T00:00:00.000Z",
      excludePrefixes: ["mindtap_", "connect_"],
    });

    expect(snapshot.tools).toHaveLength(1);
    expect(snapshot.excluded).toHaveLength(2);
  });

  it("produces the same digest for the same semantic catalog", () => {
    const source = [{
      id: "meridian",
      label: "Meridian",
      priority: 100,
      tools: [{ name: "canvas_page_get", inputSchema: emptySchema }],
    }];
    const first = mergeCatalog(source, { generatedAt: "2026-09-03T00:00:00.000Z" });
    const second = mergeCatalog(source, { generatedAt: "2026-09-04T00:00:00.000Z" });
    expect(first.digest).toBe(second.digest);
  });
});
