import { describe, expect, it } from "vitest";
import type { CatalogTool, JsonObject } from "@morrow/contracts";
import {
  resolveApprovalReviewContext,
  type ApprovalReviewOperation,
} from "../src/approval-context.js";

const sourceId = "canvas-session";
const sourceBindingId = "canvas:test-account";

function tool(
  publicName: string,
  upstreamName: string,
  readOnly: boolean,
  family?: string,
): CatalogTool {
  return {
    publicName,
    upstreamId: sourceId,
    upstreamLabel: "Canvas",
    upstreamName,
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: readOnly },
    ...(family ? {
      capability: {
        family,
        provider: "canvas",
        sourcePath: "catalog",
        sourceExport: upstreamName,
        sourceDigest: "a".repeat(64),
        behavior: { readOnly, mutating: !readOnly, destructive: false, irreversible: false, supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: true, requiresBrowser: true, requiresLiveCanvas: true },
        authority: { scopeClass: "course", approvalClass: readOnly ? "none" : "standard", dataClass: "course" },
        route: { backend: "canvas-connector" },
        profiles: {
          "private-full": { state: "supported" },
          "public-canvas": { state: "supported" },
          sandbox: { state: "supported" },
          "read-only": { state: "supported" },
        },
        evidence: {},
      },
    } : {}),
  } as CatalogTool;
}

function moodleTool(
  publicName: string,
  upstreamName: string,
  readOnly: boolean,
  inputSchema: JsonObject,
  planBackend?: string,
): CatalogTool {
  return {
    publicName,
    upstreamId: sourceId,
    upstreamLabel: "Moodle",
    upstreamName,
    inputSchema,
    annotations: { readOnlyHint: readOnly },
    capability: {
      family: "moodle",
      provider: "moodle",
      sourcePath: "catalog",
      sourceExport: upstreamName,
      sourceDigest: "b".repeat(64),
      behavior: { readOnly, mutating: !readOnly, destructive: false, irreversible: false, supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: true, requiresBrowser: true, requiresLiveCanvas: true },
      authority: { scopeClass: "course", approvalClass: readOnly ? "none" : "standard", dataClass: "course" },
      route: { backend: "canvas-connector", ...(planBackend ? { planBackend } : {}) },
      profiles: {
        "private-full": { state: "supported" },
        "public-canvas": { state: "limited" },
        sandbox: { state: "supported" },
        "read-only": { state: "supported" },
      },
      evidence: {},
    },
  } as CatalogTool;
}

const tools = [
  tool("canvas_create_quiz_item", "canvas_create_quiz_item", false, "new-quizzes"),
  tool("morrow_canvas_bindings", "morrow_canvas_bindings", true),
  tool("canvas_get_single_course_courses", "canvas_get_single_course_courses", true, "courses"),
  tool("canvas_get_new_quiz", "canvas_get_new_quiz", true, "new-quizzes"),
];

function operation(): ApprovalReviewOperation {
  const argumentsValue = {
    course_id: "42",
    assignment_id: "77",
    _morrow: { source_binding_id: sourceBindingId },
  };
  return {
    state: "awaiting_approval",
    publicToolName: "canvas_create_quiz_item",
    sourceId,
    sourceToolName: "canvas_create_quiz_item",
    sourceBindingId,
    plan: {
      schema: "morrow.plan.v1",
      tool: "canvas_create_quiz_item",
      source: sourceId,
      sourceTool: "canvas_create_quiz_item",
      sourceBindingId,
      arguments: argumentsValue,
    },
  };
}

function connector(data: JsonObject): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      commandKind: "invoke_read",
      result: { ok: true, sent: true, data },
    },
  };
}

describe("approval review context", () => {
  it("resolves the exact file name before a file deletion", async () => {
    const base = operation();
    const deletion = { ...base, publicToolName: "canvas_delete_file", sourceToolName: "canvas_delete_file", plan: { ...base.plan,
      tool: "canvas_delete_file", sourceTool: "canvas_delete_file", arguments: { id: "88", _morrow: { source_binding_id: sourceBindingId } } } };
    const context = await resolveApprovalReviewContext({ operation: deletion,
      tools: [...tools, tool("canvas_delete_file", "canvas_delete_file", false, "files"), tool("canvas_get_file_files", "canvas_get_file_files", true, "files")],
      read: async (name, args) => {
        if (name === "morrow_canvas_bindings") return { structuredContent: { schema: "morrow.canvas-bindings.v1", bindings: [{ sourceBindingId, provider: "canvas", runtimeVerified: true, origin: "https://school.instructure.com" }] } };
        expect(name).toBe("canvas_get_file_files");
        expect(args).toEqual({ id: "88", _morrow: { source_binding_id: sourceBindingId } });
        return connector({ id: 88, display_name: "Week 4 study guide.pdf" });
      },
    });
    expect(context.targets).toEqual([{ field: "id", label: "File", name: "Week 4 study guide.pdf" }]);
  });

  it("uses the saved binding to resolve exact course and New Quiz names after completion", async () => {
    const calls: { publicName: string; args: Readonly<Record<string, unknown>> }[] = [];
    const context = await resolveApprovalReviewContext({
      operation: { ...operation(), state: "verified" },
      tools,
      read: async (publicName, args) => {
        calls.push({ publicName, args });
        if (publicName === "morrow_canvas_bindings") {
          return { structuredContent: { schema: "morrow.canvas-bindings.v1", bindings: [{ sourceBindingId, provider: "canvas", runtimeVerified: true, origin: "https://school.instructure.com" }] } };
        }
        if (publicName === "canvas_get_single_course_courses") return connector({ id: 42, name: "Intro to Biology" });
        if (publicName === "canvas_get_new_quiz") return connector({ id: 77, course_id: 42, title: "Cell Structure Check" });
        throw new Error(`unexpected read ${publicName}`);
      },
    });

    expect(context).toEqual({
      targets: [
        { field: "course_id", label: "Course", name: "Intro to Biology", url: "https://school.instructure.com/courses/42" },
        { field: "assignment_id", label: "Quiz", name: "Cell Structure Check", url: "https://school.instructure.com/courses/42/assignments/77" },
      ],
    });
    expect(calls).toEqual(expect.arrayContaining([
      { publicName: "canvas_get_single_course_courses", args: { id: "42", _morrow: { source_binding_id: sourceBindingId } } },
      { publicName: "canvas_get_new_quiz", args: { course_id: "42", assignment_id: "77", _morrow: { source_binding_id: sourceBindingId } } },
    ]));
  });

  it("leaves mismatched provider IDs explicitly unresolved", async () => {
    const context = await resolveApprovalReviewContext({
      operation: operation(),
      tools,
      read: async (publicName) => {
        if (publicName === "morrow_canvas_bindings") {
          return { structuredContent: { schema: "morrow.canvas-bindings.v1", bindings: [{ sourceBindingId, provider: "canvas", runtimeVerified: true, origin: "https://school.instructure.com" }] } };
        }
        if (publicName === "canvas_get_single_course_courses") return connector({ id: "41", name: "Wrong course" });
        if (publicName === "canvas_get_new_quiz") return connector({ id: "77", course_id: "41", title: "Wrong course quiz" });
        throw new Error(`unexpected read ${publicName}`);
      },
    });

    expect(context).toEqual({
      targets: [
        { field: "course_id", label: "Course", name: "" },
        { field: "assignment_id", label: "Quiz", name: "" },
      ],
    });
  });

  it("keeps the current quiz item details separate from a score-only update", async () => {
    const update = {
      ...operation(),
      publicToolName: "canvas_update_quiz_item",
      sourceToolName: "canvas_update_quiz_item",
      plan: {
        ...operation().plan,
        tool: "canvas_update_quiz_item",
        sourceTool: "canvas_update_quiz_item",
        arguments: {
          course_id: "42",
          assignment_id: "77",
          item_id: "10899365",
          item_entry_scoring_data: { value: "ribosomes" },
          _morrow: { source_binding_id: sourceBindingId },
        },
      },
    };
    const context = await resolveApprovalReviewContext({
      operation: update,
      tools: [...tools,
        tool("canvas_update_quiz_item", "canvas_update_quiz_item", false, "new-quizzes"),
        tool("canvas_get_quiz_item", "canvas_get_quiz_item", true, "new-quizzes")],
      read: async (publicName) => {
        if (publicName === "morrow_canvas_bindings") {
          return { structuredContent: { schema: "morrow.canvas-bindings.v1", bindings: [{ sourceBindingId, provider: "canvas", runtimeVerified: true, origin: "https://school.instructure.com" }] } };
        }
        if (publicName === "canvas_get_single_course_courses") return connector({ id: 42, name: "Intro to Biology" });
        if (publicName === "canvas_get_new_quiz") return connector({ id: 77, course_id: 42, title: "Cell Structure Check" });
        if (publicName === "canvas_get_quiz_item") return connector({
          id: 10899365,
          entry: {
            title: "Protein assembly",
            item_body: "Which structure directly assembles proteins?",
            interaction_type_slug: "choice",
            interaction_data: { choices: [{ id: "ribosomes", position: 1, item_body: "Ribosomes" }, { id: "mitochondria", position: 2, item_body: "Mitochondria" }] },
            scoring_algorithm: "Equivalence",
            scoring_data: { value: "mitochondria" },
          },
        });
        throw new Error(`unexpected read ${publicName}`);
      },
    });

    expect(context.question).toEqual({
      item_entry_title: "Protein assembly",
      item_entry_item_body: "Which structure directly assembles proteins?",
      item_entry_interaction_type_slug: "choice",
      item_entry_interaction_data: { choices: [{ id: "ribosomes", position: 1, item_body: "Ribosomes" }, { id: "mitochondria", position: 2, item_body: "Mitochondria" }] },
      item_entry_scoring_algorithm: "Equivalence",
      item_entry_scoring_data: { value: "mitochondria" },
    });
    expect(context.current).toBeUndefined();
  });

  it("reads the exact Moodle assignment before showing its current changed fields", async () => {
    const moodleBindingId = "moodle:demo:2";
    const dueDate = { year: 2027, month: 5, day: 14, hour: 15, minute: 45 };
    const update: ApprovalReviewOperation = {
      state: "awaiting_approval",
      publicToolName: "moodle_update_assignment",
      sourceId,
      sourceToolName: "moodle_update_assignment",
      sourceBindingId: moodleBindingId,
      plan: {
        schema: "morrow.plan.v1",
        tool: "moodle_update_assignment",
        source: sourceId,
        sourceTool: "moodle_update_assignment",
        sourceBindingId: moodleBindingId,
        arguments: {
          course_id: 2,
          module_id: 6,
          name: "Course reflection",
          instructions: "<p>Submit a short reflection.</p>",
          due_date: dueDate,
          expected_digest: "c".repeat(64),
          _morrow: { source_binding_id: moodleBindingId },
        },
      },
    };
    const context = await resolveApprovalReviewContext({
      operation: update,
      tools: [
        moodleTool("moodle_update_assignment", "moodle_update_assignment", false, { type: "object" }, "moodle_get_assignment"),
        moodleTool("moodle_get_assignment", "moodle_get_assignment", true, { type: "object", properties: { course_id: {}, module_id: {} } }),
        moodleTool("morrow_browser_bindings", "morrow_browser_bindings", true, { type: "object" }),
      ],
      read: async (publicName, args) => {
        if (publicName === "morrow_browser_bindings") {
          expect(args).toEqual({});
          return { structuredContent: { schema: "morrow.browser-bindings.v1", bindings: [{ sourceBindingId: moodleBindingId, provider: "moodle", runtimeVerified: true, origin: "https://school.example", siteUrl: "https://school.example/moodle", courseId: "2" }] } };
        }
        expect(publicName).toBe("moodle_get_assignment");
        expect(args).toEqual({ course_id: 2, module_id: 6, _morrow: { source_binding_id: moodleBindingId } });
        return { structuredContent: {
          schema: "morrow.canvas-connector.result.v1", ok: true, provider: "moodle", commandKind: "invoke_read",
          result: {
            ok: true, sent: true,
            data: { name: "Old reflection", instructions: "<p>Review the unit.</p>", due_date: dueDate },
            targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Activity", name: "Course reflection" }],
            snapshot_digest: "c".repeat(64),
          },
        } };
      },
    });
    expect(context).toEqual({
      targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Activity", name: "Course reflection" }],
      current: { name: "Old reflection", instructions: "<p>Review the unit.</p>", due_date: dueDate },
    });
  });
});
