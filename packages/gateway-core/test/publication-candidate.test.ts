import { upstreamCatalogDigest } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import {
  buildPublicationManifestCandidate,
  buildSourceCatalog,
} from "../src/index.js";

const emptySchema = { type: "object", properties: {} };

function catalogs() {
  return [
    buildSourceCatalog({
      id: "meridian",
      label: "ExamplePlatform",
      kind: "mcp-stdio",
      capturedAt: "2026-09-03T00:00:00.000Z",
    }, [
      {
        name: "canvas_page_get",
        description: "Read one page.",
        inputSchema: emptySchema,
        annotations: { readOnlyHint: true },
      },
      {
        name: "example-kit_private_report",
        inputSchema: emptySchema,
        annotations: { readOnlyHint: true },
      },
    ]),
    buildSourceCatalog({
      id: "example-legacy",
      label: "Morrow legacy",
      kind: "donor-export",
      capturedAt: "2026-09-03T00:00:00.000Z",
    }, [
      {
        name: "get_page",
        description: "Read one page from the browser runtime.",
        inputSchema: {
          type: "object",
          properties: { course_id: { type: "string" } },
          required: ["course_id"],
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      {
        name: "edit_page",
        inputSchema: emptySchema,
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      {
        name: "mindtap_hidden",
        inputSchema: emptySchema,
      },
    ]),
  ];
}

function selections(overrides: Record<string, unknown> = {}) {
  return {
    schema: "morrow.publication-selections.v1",
    release: "1.0.0-rc.0",
    selections: [
      {
        publicName: "canvas_page_get",
        sourceId: "example-legacy",
        sourceToolName: "get_page",
      },
      {
        publicName: "canvas_page_update",
        sourceId: "example-legacy",
        sourceToolName: "edit_page",
      },
    ],
    ...overrides,
  };
}

describe("buildPublicationManifestCandidate", () => {
  it("freezes exact source and contract evidence from reviewed selections", () => {
    const sourceCatalogs = catalogs();
    const manifest = buildPublicationManifestCandidate(sourceCatalogs, selections());
    const legacy = sourceCatalogs[1]!;
    expect(manifest).toMatchObject({
      schema: "morrow.publication-policy.v1",
      profile: "public-canvas",
      release: "1.0.0-rc.0",
      sources: [{
        sourceId: "example-legacy",
        catalogDigest: upstreamCatalogDigest("example-legacy", legacy.tools),
        toolCount: 3,
      }],
      tools: [
        {
          publicName: "canvas_page_get",
          sourceId: "example-legacy",
          sourceToolName: "get_page",
        },
        {
          publicName: "canvas_page_update",
          sourceId: "example-legacy",
          sourceToolName: "edit_page",
        },
      ],
    });
    expect(manifest.tools.every((tool) => /^[0-9a-f]{64}$/.test(tool.inputSchemaSha256))).toBe(true);
    expect(manifest.tools.every((tool) => /^[0-9a-f]{64}$/.test(tool.annotationsSha256))).toBe(true);
  });

  it("requires exact sources and exact source tool names", () => {
    expect(() => buildPublicationManifestCandidate(catalogs(), selections({
      selections: [{
        publicName: "canvas_page_get",
        sourceId: "missing",
        sourceToolName: "get_page",
      }],
    }))).toThrow(/missing source/);

    expect(() => buildPublicationManifestCandidate(catalogs(), selections({
      selections: [{
        publicName: "canvas_page_get",
        sourceId: "example-legacy",
        sourceToolName: "missing_tool",
      }],
    }))).toThrow(/Expected one/);
  });

  it("refuses native names, held-provider names, and held-provider source tools", () => {
    expect(() => buildPublicationManifestCandidate(catalogs(), selections({
      selections: [{
        publicName: "morrow_health",
        sourceId: "example-legacy",
        sourceToolName: "get_page",
      }],
    }))).toThrow(/reserved/);

    expect(() => buildPublicationManifestCandidate(catalogs(), selections({
      selections: [{
        publicName: "connect_page_get",
        sourceId: "example-legacy",
        sourceToolName: "get_page",
      }],
    }))).toThrow(/denied provider prefix/);

    expect(() => buildPublicationManifestCandidate(catalogs(), selections({
      selections: [{
        publicName: "canvas_publisher_read",
        sourceId: "example-legacy",
        sourceToolName: "mindtap_hidden",
      }],
    }))).toThrow(/unavailable/);
  });

  it("refuses duplicate public names and duplicate source mappings", () => {
    expect(() => buildPublicationManifestCandidate(catalogs(), selections({
      selections: [
        {
          publicName: "canvas_page_get",
          sourceId: "example-legacy",
          sourceToolName: "get_page",
        },
        {
          publicName: "canvas_page_get",
          sourceId: "example-legacy",
          sourceToolName: "edit_page",
        },
      ],
    }))).toThrow(/selected more than once/);

    expect(() => buildPublicationManifestCandidate(catalogs(), selections({
      selections: [
        {
          publicName: "canvas_page_get",
          sourceId: "example-legacy",
          sourceToolName: "get_page",
        },
        {
          publicName: "canvas_page_read",
          sourceId: "example-legacy",
          sourceToolName: "get_page",
        },
      ],
    }))).toThrow(/selected more than once/);
  });
});
