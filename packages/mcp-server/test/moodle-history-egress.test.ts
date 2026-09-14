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

  it("preserves fixed privacy and capability problem identities without replaying problem details", async () => {
    const runtime = Object.create(GatewayRuntime.prototype) as GatewayRuntime;
    Object.assign(runtime, { resultArtifacts: { bound: (value: unknown) => value } });
    for (const code of ["privacy_moodle_history_dictionary_unavailable", "capability_input_invalid"]) {
      const result = await runtime.redactMcpEgress({
        content: [{ type: "text", text: "private provider detail" }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code,
          resultState: "not_sent",
          detail: "private provider detail",
        },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { schema: "morrow.problem.v1", code, resultState: "not_sent" },
      });
      expect(JSON.stringify(result)).not.toContain("private provider detail");
    }
  });
});
