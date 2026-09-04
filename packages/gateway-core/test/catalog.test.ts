import { describe, expect, it } from "vitest";
import { mergeCatalog } from "../src/index.js";
import { parseMorrowCapabilityDescriptorV1 } from "@morrow/contracts";

const emptySchema = { type: "object", properties: {} };

describe("mergeCatalog", () => {
  it("keeps the higher-priority source name and aliases a collision", () => {
    const snapshot = mergeCatalog([
      {
        id: "meridian",
        label: "ExamplePlatform",
        priority: 100,
        tools: [{ name: "canvas_page_get", inputSchema: emptySchema }],
      },
      {
        id: "example-legacy",
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
      aliasedSource: "example-legacy",
      aliasedTo: "morrow_legacy__canvas_page_get",
    }]);
  });

  it("excludes held provider prefixes before publication", () => {
    const snapshot = mergeCatalog([{
      id: "meridian",
      label: "ExamplePlatform",
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
      label: "ExamplePlatform",
      priority: 100,
      tools: [{ name: "canvas_page_get", inputSchema: emptySchema }],
    }];
    const first = mergeCatalog(source, { generatedAt: "2026-09-03T00:00:00.000Z" });
    const second = mergeCatalog(source, { generatedAt: "2026-09-04T00:00:00.000Z" });
    expect(first.digest).toBe(second.digest);
  });

  it("emits a validated descriptor and excludes held source ids before routing", () => {
    const snapshot = mergeCatalog([
      {
        id: "meridian",
        label: "ExamplePlatform",
        priority: 100,
        revision: "a".repeat(40),
        tools: [{ name: "canvas_page_get", inputSchema: emptySchema, annotations: { readOnlyHint: true } }],
      },
      {
        id: "mindtap",
        label: "Held",
        priority: 50,
        tools: [{ name: "unprefixed_tool", inputSchema: emptySchema }],
      },
    ]);

    const descriptor = snapshot.tools[0]?.capability;
    expect(descriptor).toBeDefined();
    expect(parseMorrowCapabilityDescriptorV1(descriptor)).toMatchObject({
      canonicalName: "canvas_page_get",
      profiles: { "read-only": { state: "supported" } },
      catalogDigest: snapshot.digest,
    });
    expect(snapshot.excluded).toContainEqual({
      upstreamId: "mindtap",
      upstreamName: "unprefixed_tool",
      reason: "held_provider",
    });
  });

  it("rejects an incomplete capability descriptor", () => {
    expect(() => parseMorrowCapabilityDescriptorV1({
      schema: "morrow.capability.v1",
      canonicalName: "canvas_page_get",
      aliases: [],
      family: "canvas-operation",
      provider: "canvas",
      description: "Read a page.",
      inputSchema: { type: "object" },
      sourceImplementations: [],
      behavior: {
        readOnly: true, mutating: false, destructive: false, irreversible: false,
        supportsDryRun: false, supportsReadback: false, supportsUndo: false,
        supportsBatch: false, requiresBrowser: false, requiresLiveCanvas: true,
      },
      authority: { scopeClass: "canvas", approvalClass: "none", dataClass: "course" },
      route: {},
      profiles: Object.fromEntries(["private-full", "public-canvas", "sandbox", "read-only"].map((profile) => [profile, { state: "supported" }])),
      catalogDigest: "a".repeat(64),
      evidence: {},
    })).toThrow(/sourceImplementations/);
  });
});
