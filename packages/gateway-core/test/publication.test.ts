import { describe, expect, it } from "vitest";
import {
  applyPublicationPolicy,
  mergeCatalog,
  publicationRuleForTool,
} from "../src/index.js";

const emptySchema = { type: "object", properties: {} };
const sourceDigest = "a".repeat(64);

function mergedCatalog() {
  return mergeCatalog([
    {
      id: "meridian",
      label: "Meridian",
      priority: 100,
      tools: [
        {
          name: "canvas_page_get",
          description: "Read a page through Meridian.",
          inputSchema: emptySchema,
          annotations: { readOnlyHint: true },
        },
        {
          name: "chcp_private_report",
          inputSchema: emptySchema,
          annotations: { readOnlyHint: true },
        },
      ],
    },
    {
      id: "morrow-legacy",
      label: "Morrow legacy",
      priority: 50,
      tools: [
        {
          name: "get_page",
          description: "Read a page through Morrow legacy.",
          inputSchema: {
            type: "object",
            properties: { course_id: { type: "string" } },
            required: ["course_id"],
          },
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
      ],
    },
  ], { generatedAt: "2026-09-03T00:00:00.000Z" });
}

function manifestFor(toolName = "get_page") {
  const catalog = mergedCatalog();
  const tool = catalog.tools.find((candidate) => candidate.upstreamName === toolName);
  if (!tool) throw new Error(`missing fixture tool ${toolName}`);
  return {
    catalog,
    manifest: {
      schema: "morrow.publication-policy.v1",
      profile: "public-canvas",
      release: "1.0.0-rc.0",
      sources: [{
        sourceId: tool.upstreamId,
        catalogDigest: sourceDigest,
        toolCount: tool.upstreamId === "morrow-legacy" ? 1 : 2,
      }],
      tools: [publicationRuleForTool(tool, "canvas_page_get")],
    },
  };
}

describe("applyPublicationPolicy", () => {
  it("publishes only exact reviewed source contracts under explicit public names", () => {
    const { catalog, manifest } = manifestFor();
    const applied = applyPublicationPolicy(catalog, manifest, [{
      sourceId: "morrow-legacy",
      catalogDigest: sourceDigest,
      toolCount: 1,
    }]);

    expect(applied.catalog.tools).toHaveLength(1);
    expect(applied.catalog.tools[0]).toMatchObject({
      publicName: "canvas_page_get",
      upstreamId: "morrow-legacy",
      upstreamName: "get_page",
    });
    expect(applied.catalog.collisions).toEqual([]);
    expect(applied.catalog.excluded).toEqual(expect.arrayContaining([
      {
        upstreamId: "meridian",
        upstreamName: "canvas_page_get",
        reason: "publication_policy",
      },
      {
        upstreamId: "meridian",
        upstreamName: "chcp_private_report",
        reason: "publication_policy",
      },
    ]));
    expect(applied.receipt).toMatchObject({
      applied: true,
      profile: "public-canvas",
      sourceCount: 1,
      allowedToolCount: 1,
      omittedToolCount: 2,
    });
    expect(applied.receipt.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(applied.catalog.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses source catalog and schema drift", () => {
    const { catalog, manifest } = manifestFor();
    expect(() => applyPublicationPolicy(catalog, manifest, [{
      sourceId: "morrow-legacy",
      catalogDigest: "b".repeat(64),
      toolCount: 1,
    }])).toThrow(/source catalog drift/);

    const changed = structuredClone(manifest);
    changed.tools[0]!.inputSchemaSha256 = "c".repeat(64);
    expect(() => applyPublicationPolicy(catalog, changed, [{
      sourceId: "morrow-legacy",
      catalogDigest: sourceDigest,
      toolCount: 1,
    }])).toThrow(/contract drift/);
  });

  it("refuses reserved names, held-provider prefixes, and duplicate source mappings", () => {
    const { catalog, manifest } = manifestFor();
    const reserved = structuredClone(manifest);
    reserved.tools[0]!.publicName = "morrow_health";
    expect(() => applyPublicationPolicy(catalog, reserved, [{
      sourceId: "morrow-legacy",
      catalogDigest: sourceDigest,
      toolCount: 1,
    }])).toThrow(/reserved/);

    const held = structuredClone(manifest);
    held.tools[0]!.publicName = "mindtap_page_get";
    expect(() => applyPublicationPolicy(catalog, held, [{
      sourceId: "morrow-legacy",
      catalogDigest: sourceDigest,
      toolCount: 1,
    }])).toThrow(/denied provider prefix/);

    const duplicated = structuredClone(manifest);
    duplicated.tools.push({
      ...duplicated.tools[0]!,
      publicName: "canvas_page_read",
    });
    expect(() => applyPublicationPolicy(catalog, duplicated, [{
      sourceId: "morrow-legacy",
      catalogDigest: sourceDigest,
      toolCount: 1,
    }])).toThrow(/selected more than once/);
  });
});
