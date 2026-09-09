import { describe, expect, it } from "vitest";
import { GatewayRuntime } from "../src/runtime.js";

describe("Moodle historical dictionary at native egress", () => {
  it("refuses nested historical results before a specialized projector can return them", async () => {
    const runtime = Object.create(GatewayRuntime.prototype) as GatewayRuntime;
    Object.assign(runtime, { toolByPublicName: new Map(), resultArtifacts: { bound: (value: unknown) => value } });
    const raw = {
      structuredContent: {
        schema: "morrow.result.v1", tool: "morrow_capability_read",
        data: { schema: "morrow.result.v1", tool: "moodle_get_quiz_attempt", data: { feedback: "Former Learner wrote this." } },
      },
    };
    const result = await runtime.redactMcpEgress(raw);
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "privacy_moodle_history_dictionary_unavailable" } });
    expect(JSON.stringify(result)).not.toContain("Former Learner");
  });
});
