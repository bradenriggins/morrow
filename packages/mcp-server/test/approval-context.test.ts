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
});
