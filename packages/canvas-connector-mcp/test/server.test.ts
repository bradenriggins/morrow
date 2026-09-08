import { describe, expect, it } from "vitest";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { canvasConnectorSummary, privateMoodleEnrolmentCandidateInputSchema } from "../src/server.js";

describe("canvasConnectorSummary", () => {
  it("uses verified connector state instead of a generic completion claim", () => {
    expect(canvasConnectorSummary({ ok: false, problem: { message: "provider detail" } }))
      .toBe("Morrow could not complete the Canvas request.");
    expect(canvasConnectorSummary({ schema: "morrow.canvas-connector.health.v1", ready: false }))
      .toBe("Morrow checked the connection. The extension is not connected to Morrow.");
    expect(canvasConnectorSummary({ schema: "morrow.canvas-connector.health.v1", ready: true }))
      .toBe("Morrow checked the connection. The extension is connected to Morrow.");
    expect(canvasConnectorSummary({ schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read" }))
      .toBe("Morrow read Canvas data.");
    expect(canvasConnectorSummary({
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      commandKind: "invoke_write",
      result: { verification: { schema: "morrow.browser-verification.v1", status: "verified" } },
    })).toBe("Morrow confirmed the Canvas change with a fresh Canvas check.");
    expect(canvasConnectorSummary({
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      commandKind: "invoke_write",
      result: { verification: { schema: "morrow.browser-verification.v1", status: "mismatch" } },
    })).toBe("Morrow could not confirm this change because Canvas returned a different result. Ask your assistant to check the existing request. Do not repeat this change.");
    expect(canvasConnectorSummary({
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      commandKind: "invoke_write",
      result: { verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed" } },
    })).toBe("Morrow could not confirm this change. Ask your assistant to check the existing request. Do not repeat this change.");
  });
});

describe("private Moodle enrolment candidate tool", () => {
  it("accepts only one exact course, query, and local source binding", async () => {
    const schema = privateMoodleEnrolmentCandidateInputSchema();
    const validate = fromJsonSchema(schema)["~standard"].validate;
    expect((await validate({
      course_id: 42,
      query: "Mary Jackson",
      _morrow: { source_binding_id: "moodle:course-42" },
    })).issues).toBeUndefined();
    expect((await validate({ course_id: 0, query: "Mary Jackson" })).issues).toBeTruthy();
    expect((await validate({ course_id: 42, query: "" })).issues).toBeTruthy();
    expect((await validate({ course_id: 42, query: "Mary Jackson", user_id: 21 })).issues).toBeTruthy();
  });
});
