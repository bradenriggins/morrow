import { describe, expect, it } from "vitest";
import { canonicalMorrowResult, normalizeUpstreamResult } from "../src/index.js";

const mapping = {
  publicName: "canvas_page_get",
  upstreamId: "meridian",
  upstreamLabel: "ExamplePlatform",
  upstreamName: "canvas_page_get",
  inputSchema: { type: "object" },
};

describe("normalizeUpstreamResult", () => {
  it("preserves MCP content, drops raw upstream metadata, and adds bounded gateway metadata", () => {
    const result = normalizeUpstreamResult({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { value: 1 },
      _meta: {
        secret: "must-not-pass",
        "io.morrow/canvas-rate": {
          requestCost: 0.087,
          rateLimitRemaining: 699.5,
          ignored: "must-not-pass",
        },
      },
    }, {
      mapping,
      catalogDigest: "a".repeat(64),
      privacy: {
        descriptor: {
          allowedFields: ["value"],
          dataClass: "public",
          maxRecords: 1,
          maxBytes: 1_000,
          freeText: "allow",
          learnerTokens: false,
          artifactInspection: "deny",
          aiClientAdmission: "allow",
        },
      },
    });

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(result.structuredContent).toEqual({ value: 1 });
    expect(result._meta).toEqual({
      "io.morrow/gateway": expect.objectContaining({
        upstreamId: "meridian",
        upstreamToolName: "canvas_page_get",
      }),
      "io.morrow/canvas-rate": {
        schema: "morrow.canvas-rate.v1",
        requestCost: 0.087,
        rateLimitRemaining: 699.5,
      },
    });
  });

  it("uses trusted effect state for indeterminate and unconfirmed Canvas write text", () => {
    const indeterminate = canonicalMorrowResult({
      tool: "canvas_page_update",
      phase: "dispatch_failed",
      effectState: "applied_or_unknown",
      verificationStatus: "unconfirmed",
      result: {
        isError: true,
        content: [{ type: "text", text: "Morrow refused unsafe upstream output." }],
        structuredContent: { schema: "morrow.problem.v1", code: "upstream_error_sanitized" },
      },
    });
    expect(indeterminate).toMatchObject({
      isError: true,
      content: [{
        text: "Morrow cannot confirm the result. Canvas may have received this change. Ask your assistant to check the existing request. Do not repeat this change.",
      }],
      structuredContent: {
        status: "indeterminate",
        effectState: "applied_or_unknown",
        data: { code: "upstream_error_sanitized" },
      },
    });

    const unconfirmed = canonicalMorrowResult({
      tool: "canvas_page_update",
      phase: "readback_unconfirmed",
      effectState: "awaiting_verification",
      verificationStatus: "unconfirmed",
      result: {
        content: [{ type: "text", text: "Morrow completed the Canvas connector request." }],
        structuredContent: { schema: "morrow.canvas-connector.result.v1", ok: true },
      },
    });
    expect(unconfirmed).toMatchObject({
      content: [{
        text: "Morrow could not confirm this change. Ask your assistant to check the existing request. Do not repeat this change.",
      }],
      structuredContent: {
        status: "unconfirmed",
        effectState: "awaiting_verification",
        data: { ok: true },
      },
    });
    expect(JSON.stringify(unconfirmed)).not.toContain("completed the Canvas connector request");

    const awaitingApproval = canonicalMorrowResult({
      tool: "canvas_page_update",
      phase: "planned",
      effectState: "awaiting_approval",
      verificationStatus: "unconfirmed",
      result: {
        content: [{ type: "text", text: "Morrow completed the Canvas connector request." }],
      },
    });
    expect(awaitingApproval).toMatchObject({
      content: [{
        text: "Morrow prepared this change and is waiting for approval. Ask your assistant to check the existing request.",
      }],
      structuredContent: { status: "awaiting_approval" },
    });
    expect(JSON.stringify(awaitingApproval)).not.toContain("could not confirm this change");
  });
});
