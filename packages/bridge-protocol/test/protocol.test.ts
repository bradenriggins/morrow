import { describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMAS,
  augmentBridgeInputSchema,
  normalizeBridgeBindings,
  parseBridgeHello,
  splitBridgeCallArguments,
} from "../src/index.js";

const digest = "a".repeat(64);

describe("bridge protocol", () => {
  it("normalizes and sorts binding snapshots", () => {
    expect(normalizeBridgeBindings([
      { sourceBindingId: "canvas:22", provider: "canvas", courseId: "42", runtimeVerified: true },
      { sourceBindingId: "a-binding", provider: "canvas", runtimeVerified: false },
    ]).map((binding) => binding.sourceBindingId)).toEqual(["a-binding", "canvas:22"]);
  });

  it("validates an authenticated hello", () => {
    const hello = parseBridgeHello({
      schema: BRIDGE_SCHEMAS.hello,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      token: "x".repeat(48),
      extensionId: "a".repeat(32),
      donorRevision: "revision-1",
      catalogDigest: digest,
      bindings: [],
      sentAt: 1,
    });
    expect(hello.catalogDigest).toBe(digest);
  });

  it("adds routing controls without weakening an additionalProperties false schema", () => {
    const schema = augmentBridgeInputSchema({
      type: "object",
      properties: { course_id: { type: "string" } },
      required: ["course_id"],
      additionalProperties: false,
    });
    expect((schema.properties as Record<string, unknown>)._morrow).toBeTruthy();
    expect(schema.additionalProperties).toBe(false);
  });

  it("strips local routing controls before donor execution", () => {
    const split = splitBridgeCallArguments({
      course_id: "42",
      _morrow: { source_binding_id: "binding-42", operation_id: "operation:12345678" },
    });
    expect(split.arguments).toEqual({ course_id: "42" });
    expect(split.options).toEqual({
      sourceBindingId: "binding-42",
      operationId: "operation:12345678",
    });
  });
});
