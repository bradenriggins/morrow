import { describe, expect, it } from "vitest";
import {
  buildSourceCatalog,
  parseSourceCatalog,
  reconcileCatalogs,
} from "../src/index.js";

const emptySchema = { type: "object", properties: {} };
const idSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};

function catalog(id: string, tools: { name: string; inputSchema?: Record<string, unknown> }[]) {
  return buildSourceCatalog({
    id,
    label: id,
    kind: "synthetic",
    revision: "test",
    capturedAt: "2026-09-03T00:00:00.000Z",
  }, tools.map((tool) => ({
    name: tool.name,
    inputSchema: tool.inputSchema ?? emptySchema,
  })));
}

describe("source catalogs", () => {
  it("builds a timestamp-independent digest and verifies it on parse", () => {
    const first = buildSourceCatalog({
      id: "meridian",
      label: "ExamplePlatform",
      kind: "synthetic",
      capturedAt: "2026-09-03T00:00:00.000Z",
    }, [{ name: "canvas_page_get", inputSchema: emptySchema }]);
    const second = buildSourceCatalog({
      id: "meridian",
      label: "ExamplePlatform",
      kind: "synthetic",
      capturedAt: "2026-09-04T00:00:00.000Z",
    }, [{ name: "canvas_page_get", inputSchema: emptySchema }]);

    expect(first.digest).toBe(second.digest);
    expect(parseSourceCatalog(first)).toEqual(first);
    expect(() => parseSourceCatalog({ ...first, count: 99 })).toThrow("count mismatch");
  });
});

describe("reconcileCatalogs", () => {
  it("selects a compatible exact-name tool by source priority and preserves source-only rows", () => {
    const report = reconcileCatalogs([
      catalog("meridian", [
        { name: "canvas_page_get" },
        { name: "meridian_only" },
      ]),
      catalog("example-legacy", [
        { name: "canvas_page_get" },
        { name: "morrow_only" },
      ]),
    ], {
      generatedAt: "2026-09-03T00:00:00.000Z",
      sourcePriority: ["meridian", "example-legacy"],
    });

    const shared = report.rows.find((row) => row.id === "exact:canvas_page_get");
    expect(shared).toMatchObject({
      kind: "exact_name",
      status: "compatible",
      selected: { sourceId: "meridian", toolName: "canvas_page_get" },
      reviewRequired: false,
    });
    expect(report.counts.sourceOnlyBySource).toEqual({
      meridian: 1,
      "example-legacy": 1,
    });
  });

  it("refuses to select an exact-name contract drift", () => {
    const report = reconcileCatalogs([
      catalog("meridian", [{ name: "canvas_page_get", inputSchema: emptySchema }]),
      catalog("example-legacy", [{ name: "canvas_page_get", inputSchema: idSchema }]),
    ]);
    expect(report.rows[0]).toMatchObject({
      status: "contract_drift",
      selected: null,
      reviewRequired: true,
    });
  });

  it("joins differently named tools only through an explicit alias rule", () => {
    const report = reconcileCatalogs([
      catalog("meridian", [{ name: "canvas_pages_list" }]),
      catalog("example-legacy", [{ name: "list_pages" }]),
    ], {
      aliases: [{
        id: "canvas.pages.list",
        publicName: "canvas_pages_list",
        preferredSourceId: "meridian",
        reason: "Both tools list Canvas pages in one course.",
        members: [
          { sourceId: "meridian", toolName: "canvas_pages_list" },
          { sourceId: "example-legacy", toolName: "list_pages" },
        ],
      }],
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      kind: "alias",
      status: "compatible",
      publicName: "canvas_pages_list",
      selected: { sourceId: "meridian", toolName: "canvas_pages_list" },
    });
  });

  it("fails when an alias claims a tool that is not in its source catalog", () => {
    expect(() => reconcileCatalogs([
      catalog("meridian", [{ name: "canvas_pages_list" }]),
      catalog("example-legacy", [{ name: "list_pages" }]),
    ], {
      aliases: [{
        id: "bad.alias",
        publicName: "canvas_pages_list",
        preferredSourceId: "meridian",
        reason: "Invalid fixture.",
        members: [
          { sourceId: "meridian", toolName: "missing" },
          { sourceId: "example-legacy", toolName: "list_pages" },
        ],
      }],
    })).toThrow("references missing tool");
  });
});
