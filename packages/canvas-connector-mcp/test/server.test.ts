import { describe, expect, it } from "vitest";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { canvasConnectorSummary, newQuizItemLifecycleWriteSchema, newQuizItemWriteSchema, privateMoodleEnrolmentCandidateInputSchema } from "../src/server.js";

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

describe("New Quiz item write schema", () => {
  it("publishes the exact complete-order guard for item_position writes", async () => {
    const schema = newQuizItemWriteSchema({
      type: "object",
      properties: { item_position: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    });
    const validate = fromJsonSchema(schema)["~standard"].validate;
    const guard = {
      kind: "new_quiz_item_position",
      before_item_ids_sha256: "a".repeat(64),
      expected_item_ids: ["89", "88", "90"],
      expected_item_ids_sha256: "b".repeat(64),
    };
    expect((await validate({ item_position: 2, morrow_new_quiz_item_position_guard: guard })).issues).toBeUndefined();
    expect((await validate({ item_position: 2, morrow_new_quiz_item_position_guard: { ...guard, expected_item_ids: ["89", "89"] } })).issues).toBeTruthy();
    expect((await validate({ item_position: 2, morrow_new_quiz_item_position_guard: { ...guard, extra: true } })).issues).toBeTruthy();
    expect((await validate({ item_position: 2, morrow_new_quiz_item_position_guard: { ...guard, before_item_ids_sha256: "stale" } })).issues).toBeTruthy();
  });

  it("publishes exact lifecycle guards for create and delete", async () => {
    const schema = newQuizItemLifecycleWriteSchema({ type: "object", properties: {}, additionalProperties: false });
    const validate = fromJsonSchema(schema)["~standard"].validate;
    const before = "a".repeat(64);
    expect((await validate({ morrow_new_quiz_item_lifecycle_guard: {
      kind: "create", before_items_sha256: before, payload_sha256: "b".repeat(64),
    } })).issues).toBeUndefined();
    expect((await validate({ morrow_new_quiz_item_lifecycle_guard: {
      kind: "delete", before_items_sha256: before, target_item_sha256: "c".repeat(64), item_id: "89", entry_type: "Item",
    } })).issues).toBeUndefined();
    expect((await validate({ morrow_new_quiz_item_lifecycle_guard: {
      kind: "create", before_items_sha256: before, item_id: "89",
    } })).issues).toBeTruthy();
    expect((await validate({ morrow_new_quiz_item_lifecycle_guard: {
      kind: "delete", before_items_sha256: before, target_item_sha256: "c".repeat(64), item_id: "89", entry_type: "Stimulus",
    } })).issues).toBeTruthy();
  });
});
