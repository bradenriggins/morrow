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

  it("distinguishes same-named Moodle move sections by their section number", async () => {
    const moodleBindingId = "moodle:demo:2";
    const move: ApprovalReviewOperation = {
      state: "awaiting_approval",
      publicToolName: "moodle_move_activity",
      sourceId,
      sourceToolName: "moodle_move_activity",
      sourceBindingId: moodleBindingId,
      plan: {
        schema: "morrow.plan.v1",
        tool: "moodle_move_activity",
        source: sourceId,
        sourceTool: "moodle_move_activity",
        sourceBindingId: moodleBindingId,
        arguments: {
          course_id: 2,
          module_id: 25,
          target_section_id: 27,
          expected_digest: "d".repeat(64),
          _morrow: { source_binding_id: moodleBindingId },
        },
      },
    };
    const context = await resolveApprovalReviewContext({
      operation: move,
      tools: [
        moodleTool("moodle_move_activity", "moodle_move_activity", false, { type: "object" }, "moodle_get_contents"),
        moodleTool("moodle_get_contents", "moodle_get_contents", true, { type: "object", properties: { course_id: {} } }),
        moodleTool("morrow_browser_bindings", "morrow_browser_bindings", true, { type: "object" }),
      ],
      read: async (publicName, args) => {
        if (publicName === "morrow_browser_bindings") {
          expect(args).toEqual({});
          return { structuredContent: { schema: "morrow.browser-bindings.v1", bindings: [{ sourceBindingId: moodleBindingId, provider: "moodle", runtimeVerified: true, origin: "https://school.example", siteUrl: "https://school.example/moodle", courseId: "2" }] } };
        }
        expect(publicName).toBe("moodle_get_contents");
        expect(args).toEqual({ course_id: 2, _morrow: { source_binding_id: moodleBindingId } });
        return { structuredContent: {
          schema: "morrow.canvas-connector.result.v1", ok: true, provider: "moodle", commandKind: "invoke_read",
          result: {
            ok: true, sent: true,
            data: {
              activities: [{ id: 25, name: "Course overview", sectionid: 26 }],
              sections: [{ id: 26, number: 1, title: "New section" }, { id: 27, number: 2, title: "New section" }],
            },
            targets: [{ field: "course_id", label: "Course", name: "Biology" }],
            snapshot_digest: "d".repeat(64),
          },
        } };
      },
    });
    expect(context).toEqual({
      targets: [
        { field: "course_id", label: "Course", name: "Biology" },
        { field: "module_id", label: "Activity", name: "Course overview" },
        { field: "target_section_id", label: "Destination section", name: "Section 2: New section" },
      ],
      current: { current_section: "Section 1: New section" },
    });
  });

  it("binds a Book visibility change to the chapter and its native cascade", async () => {
    const moodleBindingId = "moodle:demo:2";
    const operation: ApprovalReviewOperation = {
      state: "awaiting_approval", publicToolName: "moodle_hide_book_chapter", sourceId, sourceToolName: "moodle_hide_book_chapter", sourceBindingId: moodleBindingId,
      plan: {
        schema: "morrow.plan.v1", tool: "moodle_hide_book_chapter", source: sourceId, sourceTool: "moodle_hide_book_chapter", sourceBindingId: moodleBindingId,
        arguments: { course_id: 2, module_id: 7, chapter_id: 31, expected_digest: "d".repeat(64), _morrow: { source_binding_id: moodleBindingId } },
      },
    };
    const context = await resolveApprovalReviewContext({
      operation,
      tools: [
        moodleTool("moodle_hide_book_chapter", "moodle_hide_book_chapter", false, { type: "object" }, "moodle_list_book_chapters"),
        moodleTool("moodle_list_book_chapters", "moodle_list_book_chapters", true, { type: "object", properties: { course_id: {}, module_id: {} } }),
        moodleTool("morrow_browser_bindings", "morrow_browser_bindings", true, { type: "object" }),
      ],
      read: async (publicName, args) => {
        if (publicName === "morrow_browser_bindings") return { structuredContent: { schema: "morrow.browser-bindings.v1", bindings: [{ sourceBindingId: moodleBindingId, provider: "moodle", runtimeVerified: true, origin: "https://school.example", siteUrl: "https://school.example/moodle", courseId: "2" }] } };
        expect(publicName).toBe("moodle_list_book_chapters");
        expect(args).toEqual({ course_id: 2, module_id: 7, _morrow: { source_binding_id: moodleBindingId } });
        return { structuredContent: {
          schema: "morrow.canvas-connector.result.v1", ok: true, provider: "moodle", commandKind: "invoke_read",
          result: {
            ok: true, sent: true,
            data: { chapters: [{ chapter_id: 31, title: "Evidence", subchapter: false, hidden: false }, { chapter_id: 32, title: "Details", subchapter: true, hidden: false }, { chapter_id: 33, title: "Conclusion", subchapter: false, hidden: false }] },
            targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Book", name: "Field guide" }],
            snapshot_digest: "d".repeat(64),
          },
        } };
      },
    });
    expect(context).toEqual({
      targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Book", name: "Field guide" }, { field: "chapter_id", label: "Chapter", name: "Evidence" }],
      current: { hidden: false, affected_chapters: ["Evidence", "Details"] },
    });
  });

  it("binds a Book chapter deletion to every native cascade target", async () => {
    const moodleBindingId = "moodle:demo:delete";
    const operation: ApprovalReviewOperation = {
      state: "awaiting_approval", publicToolName: "moodle_delete_book_chapter", sourceId, sourceToolName: "moodle_delete_book_chapter", sourceBindingId: moodleBindingId,
      plan: {
        schema: "morrow.plan.v1", tool: "moodle_delete_book_chapter", source: sourceId, sourceTool: "moodle_delete_book_chapter", sourceBindingId: moodleBindingId,
        arguments: { course_id: 2, module_id: 7, chapter_id: 31, expected_digest: "d".repeat(64), _morrow: { source_binding_id: moodleBindingId } },
      },
    };
    const context = await resolveApprovalReviewContext({
      operation,
      tools: [
        moodleTool("moodle_delete_book_chapter", "moodle_delete_book_chapter", false, { type: "object" }, "moodle_list_book_chapters"),
        moodleTool("moodle_list_book_chapters", "moodle_list_book_chapters", true, { type: "object", properties: { course_id: {}, module_id: {} } }),
        moodleTool("morrow_browser_bindings", "morrow_browser_bindings", true, { type: "object" }),
      ],
      read: async (publicName, args) => {
        if (publicName === "morrow_browser_bindings") return { structuredContent: { schema: "morrow.browser-bindings.v1", bindings: [{ sourceBindingId: moodleBindingId, provider: "moodle", runtimeVerified: true, origin: "https://school.example", siteUrl: "https://school.example/moodle", courseId: "2" }] } };
        expect(publicName).toBe("moodle_list_book_chapters");
        expect(args).toEqual({ course_id: 2, module_id: 7, _morrow: { source_binding_id: moodleBindingId } });
        return { structuredContent: {
          schema: "morrow.canvas-connector.result.v1", ok: true, provider: "moodle", commandKind: "invoke_read",
          result: {
            ok: true, sent: true,
            data: { chapters: [{ chapter_id: 31, title: "Evidence", subchapter: false, hidden: false }, { chapter_id: 32, title: "Details", subchapter: true, hidden: false }, { chapter_id: 33, title: "Conclusion", subchapter: false, hidden: false }] },
            targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Book", name: "Field guide" }],
            snapshot_digest: "d".repeat(64),
          },
        } };
      },
    });
    expect(context).toEqual({
      targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "Book", name: "Field guide" }, { field: "chapter_id", label: "Chapter", name: "Evidence" }],
      current: { affected_chapters: ["Evidence", "Details"] },
    });
  });

  it("resolves only fresh exact Moodle gradebook rename targets", async () => {
    const moodleBindingId = "moodle:demo:5";
    const gradeTools = [
      moodleTool("moodle_update_grade_item", "moodle_update_grade_item", false, { type: "object" }, "moodle_get_grade_item"),
      moodleTool("moodle_update_grade_category", "moodle_update_grade_category", false, { type: "object" }, "moodle_get_grade_category"),
      moodleTool("moodle_get_grade_item", "moodle_get_grade_item", true, { type: "object", properties: { course_id: {}, grade_item_id: {} } }),
      moodleTool("moodle_get_grade_category", "moodle_get_grade_category", true, { type: "object", properties: { course_id: {}, category_id: {} } }),
      moodleTool("moodle_get_course", "moodle_get_course", true, { type: "object", properties: { course_id: {} } }),
      moodleTool("moodle_get_gradebook_setup", "moodle_get_gradebook_setup", true, { type: "object", properties: { course_id: {} } }),
      moodleTool("morrow_browser_bindings", "morrow_browser_bindings", true, { type: "object" }),
    ];
    const readResult = (data: JsonObject, digest: string, targets: JsonObject[] = []) => ({ structuredContent: {
      schema: "morrow.canvas-connector.result.v1", ok: true, provider: "moodle", commandKind: "invoke_read",
      result: { ok: true, sent: true, data, targets, snapshot_digest: digest },
    } });
    const review = async (
      tool: "moodle_update_grade_item" | "moodle_update_grade_category",
      mismatch = false,
      state: "awaiting_approval" | "verified" = "awaiting_approval",
    ) => {
      const category = tool === "moodle_update_grade_category";
      const targetField = category ? "category_id" : "grade_item_id";
      const targetId = category ? 3 : 4;
      const digest = category ? "c".repeat(64) : "d".repeat(64);
      const operation: ApprovalReviewOperation = {
        state, publicToolName: tool, sourceId, sourceToolName: tool, sourceBindingId: moodleBindingId,
        plan: {
          schema: "morrow.plan.v1", tool, source: sourceId, sourceTool: tool, sourceBindingId: moodleBindingId,
          arguments: { course_id: 5, [targetField]: targetId, [category ? "fullname" : "item_name"]: category ? "Renamed course gradebook" : "Morrow gradebook check renamed", expected_digest: digest, _morrow: { source_binding_id: moodleBindingId } },
        },
      };
      return resolveApprovalReviewContext({
        operation, tools: gradeTools,
        read: async (publicName) => {
          if (publicName === "morrow_browser_bindings") return { structuredContent: { schema: "morrow.browser-bindings.v1", bindings: [{ sourceBindingId: moodleBindingId, provider: "moodle", runtimeVerified: true, origin: "https://school.example", siteUrl: "https://school.example/moodle", courseId: "5" }] } };
          if (publicName === "moodle_get_course") return readResult({ course_id: 5, fullname: "Moodle Biology" }, "a".repeat(64), [{ field: "course_id", label: "Course", name: "Moodle Biology" }]);
          if (publicName === "moodle_get_gradebook_setup") return readResult({ course_id: 5, categories: [{ id: 3, name: "Course root" }], grade_item_links: [{ id: 4, name: mismatch ? "Wrong item" : "Morrow gradebook check" }] }, "b".repeat(64));
          if (publicName === "moodle_get_grade_item") return readResult({ course_id: 5, grade_item_id: 4, item_name: "Morrow gradebook check", item_type: "manual", protected_settings_digest: "e".repeat(64), protected_setting_names: ["grademax"] }, state === "verified" ? "e".repeat(64) : digest);
          if (publicName === "moodle_get_grade_category") return readResult({ course_id: 5, category_id: 3, fullname: "", protected_settings_digest: "f".repeat(64), protected_setting_names: ["aggregateonlygraded"] }, digest);
          throw new Error(`unexpected read ${publicName}`);
        },
      });
    };
    await expect(review("moodle_update_grade_item")).resolves.toEqual({
      targets: [{ field: "course_id", label: "Course", name: "Moodle Biology" }, { field: "grade_item_id", label: "Manual grade item", name: "Morrow gradebook check" }],
      current: { gradebook_current_name: "Morrow gradebook check" },
    });
    await expect(review("moodle_update_grade_category")).resolves.toEqual({
      targets: [{ field: "course_id", label: "Course", name: "Moodle Biology" }, { field: "category_id", label: "Grade category", name: "Course grade category" }],
      current: { gradebook_current_name: "Course grade category" },
    });
    await expect(review("moodle_update_grade_item", true)).resolves.toEqual({ targets: [] });
    await expect(review("moodle_update_grade_item", false, "verified")).resolves.toEqual({
      targets: [{ field: "course_id", label: "Course", name: "Moodle Biology" }, { field: "grade_item_id", label: "Manual grade item", name: "Morrow gradebook check" }],
      current: { gradebook_current_name: "Morrow gradebook check" },
    });
  });

  it("labels a resource destination with its fresh Moodle section number", async () => {
    const moodleBindingId = "moodle:demo:2";
    const operation: ApprovalReviewOperation = {
      state: "awaiting_approval", publicToolName: "moodle_create_resource_file", sourceId, sourceToolName: "moodle_create_resource_file", sourceBindingId: moodleBindingId,
      plan: { schema: "morrow.plan.v1", tool: "moodle_create_resource_file", source: sourceId, sourceTool: "moodle_create_resource_file", sourceBindingId: moodleBindingId,
        arguments: { course_id: 2, section_id: 27, name: "Guide", filename: "guide.txt", size_bytes: 141, sha256: "a".repeat(64), expected_digest: "b".repeat(64), _morrow: { source_binding_id: moodleBindingId } } },
    };
    const result = (data: JsonObject, digest: string, targets: JsonObject[]) => ({ structuredContent: {
      schema: "morrow.canvas-connector.result.v1", ok: true, provider: "moodle", commandKind: "invoke_read", result: { ok: true, sent: true, data, targets, snapshot_digest: digest },
    } });
    const context = await resolveApprovalReviewContext({
      operation,
      tools: [
        moodleTool("moodle_create_resource_file", "moodle_create_resource_file", false, { type: "object" }, "moodle_get_resource_file_creation_form"),
        moodleTool("moodle_get_resource_file_creation_form", "moodle_get_resource_file_creation_form", true, { type: "object", properties: { course_id: {}, section_id: {} } }),
        moodleTool("moodle_get_contents", "moodle_get_contents", true, { type: "object", properties: { course_id: {} } }),
        moodleTool("morrow_browser_bindings", "morrow_browser_bindings", true, { type: "object" }),
      ],
      read: async (publicName) => {
        if (publicName === "morrow_browser_bindings") return { structuredContent: { schema: "morrow.browser-bindings.v1", bindings: [{ sourceBindingId: moodleBindingId, provider: "moodle", runtimeVerified: true, origin: "https://school.example", siteUrl: "https://school.example/moodle", courseId: "2" }] } };
        if (publicName === "moodle_get_resource_file_creation_form") return result({ course_id: 2, section_id: 27, name: "Guide" }, "b".repeat(64), [{ field: "course_id", label: "Course", name: "Biology" }, { field: "section_id", label: "Section", name: "New section" }]);
        if (publicName === "moodle_get_contents") return result({ course: { id: 2 }, sections: [{ id: 27, number: 2, title: "New section" }] }, "c".repeat(64), [{ field: "course_id", label: "Course", name: "Biology" }]);
        throw new Error(`unexpected read ${publicName}`);
      },
    });
    expect(context).toEqual({ targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "section_id", label: "Section", name: "Section 2: New section" }] });
  });

  it("reads the exact Moodle URL values before approving its update", async () => {
    const moodleBindingId = "moodle:demo:2";
    const update: ApprovalReviewOperation = {
      state: "awaiting_approval",
      publicToolName: "moodle_update_url",
      sourceId,
      sourceToolName: "moodle_update_url",
      sourceBindingId: moodleBindingId,
      plan: {
        schema: "morrow.plan.v1",
        tool: "moodle_update_url",
        source: sourceId,
        sourceTool: "moodle_update_url",
        sourceBindingId: moodleBindingId,
        arguments: {
          course_id: 2,
          module_id: 6,
          external_url: "https://openstax.org/books/biology-2e/pages/4-4-prokaryotic-cells",
          description: "Read the next section.",
          expected_digest: "e".repeat(64),
          _morrow: { source_binding_id: moodleBindingId },
        },
      },
    };
    const context = await resolveApprovalReviewContext({
      operation: update,
      tools: [
        moodleTool("moodle_update_url", "moodle_update_url", false, { type: "object" }, "moodle_get_url"),
        moodleTool("moodle_get_url", "moodle_get_url", true, { type: "object", properties: { course_id: {}, module_id: {} } }),
        moodleTool("morrow_browser_bindings", "morrow_browser_bindings", true, { type: "object" }),
      ],
      read: async (publicName, args) => {
        if (publicName === "morrow_browser_bindings") {
          expect(args).toEqual({});
          return { structuredContent: { schema: "morrow.browser-bindings.v1", bindings: [{ sourceBindingId: moodleBindingId, provider: "moodle", runtimeVerified: true, origin: "https://school.example", siteUrl: "https://school.example/moodle", courseId: "2" }] } };
        }
        expect(publicName).toBe("moodle_get_url");
        expect(args).toEqual({ course_id: 2, module_id: 6, _morrow: { source_binding_id: moodleBindingId } });
        return { structuredContent: {
          schema: "morrow.canvas-connector.result.v1", ok: true, provider: "moodle", commandKind: "invoke_read",
          result: {
            ok: true, sent: true,
            data: {
              name: "Cell biology reading",
              external_url: "https://openstax.org/books/biology-2e/pages/4-3-eukaryotic-cells",
              description: "Read the first section.",
            },
            targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "URL resource", name: "Cell biology reading" }],
            snapshot_digest: "e".repeat(64),
          },
        } };
      },
    });
    expect(context).toEqual({
      targets: [{ field: "course_id", label: "Course", name: "Biology" }, { field: "module_id", label: "URL resource", name: "Cell biology reading" }],
      current: {
        name: "Cell biology reading",
        external_url: "https://openstax.org/books/biology-2e/pages/4-3-eukaryotic-cells",
        description: "Read the first section.",
      },
    });
  });

  const itemBankTools = [
    tool("canvas_item_bank_update_item", "canvas_item_bank_update_item", false, "new-quizzes-item-banks"),
    tool("canvas_item_bank_get_bank", "canvas_item_bank_get_bank", true, "new-quizzes-item-banks"),
    tool("canvas_item_bank_get_entry", "canvas_item_bank_get_entry", true, "new-quizzes-item-banks"),
    tool("canvas_item_bank_get_item", "canvas_item_bank_get_item", true, "new-quizzes-item-banks"),
    tool("canvas_get_single_course_courses", "canvas_get_single_course_courses", true, "courses"),
  ];

  const questionBody = '<p>Which structure captures light?</p><img src="https://school.instructure.com/courses/42/files/9/preview">';

  function itemBankGuard(fanOut: JsonObject): JsonObject {
    return {
      kind: "item_bank_entry_image_alt",
      course_id: "42",
      bank_id: "5",
      bank_entry_id: "9",
      item_id: "7",
      entry_type: "Item",
      item_sha256: "a".repeat(64),
      protected_state_sha256: "b".repeat(64),
      image_index: 1,
      image_src_sha256: "c".repeat(64),
      alt_text: "Diagram of the light-dependent reactions",
      fan_out: {
        schema: "morrow.canvas.item-bank.fan-out.v1",
        bank_id: "5",
        course_id: "42",
        established_at: "2026-09-06T18:00:00.000Z",
        ...fanOut,
      },
      acknowledged_course_ids: Array.isArray(fanOut.external_course_ids) ? fanOut.external_course_ids : [],
    };
  }

  function itemBankOperation(guard: JsonObject): ApprovalReviewOperation {
    const argumentsValue = {
      bank_id: "5",
      item_id: "7",
      morrow_item_bank_guard: guard,
      _morrow: { source_binding_id: sourceBindingId },
    };
    return {
      state: "awaiting_approval",
      publicToolName: "canvas_item_bank_update_item",
      sourceId,
      sourceToolName: "canvas_item_bank_update_item",
      sourceBindingId,
      plan: {
        schema: "morrow.plan.v1",
        tool: "canvas_item_bank_update_item",
        source: sourceId,
        sourceTool: "canvas_item_bank_update_item",
        sourceBindingId,
        arguments: argumentsValue,
      },
    };
  }

  /** Every read the item bank review makes, answered the way a connected Canvas would. */
  function itemBankReads(
    courseNames: Record<string, string | null>,
    calls: { publicName: string; args: Readonly<Record<string, unknown>> }[] = [],
  ) {
    return async (publicName: string, args: Readonly<Record<string, unknown>>): Promise<JsonObject> => {
      calls.push({ publicName, args });
      if (publicName === "canvas_get_single_course_courses") {
        const id = String(args.id);
        const name = courseNames[id];
        return name ? connector({ id, name }) : { isError: true, structuredContent: { schema: "morrow.problem.v1", code: "canvas_read_failed" } };
      }
      if (publicName === "canvas_item_bank_get_bank") return connector({ id: "5", title: "Unit 3 question bank" });
      if (publicName === "canvas_item_bank_get_entry") return connector({ id: "9", entry_type: "Item", entry_id: "7" });
      if (publicName === "canvas_item_bank_get_item") {
        return connector({ id: "7", entry_type: "Item", entry: { title: "Photosynthesis stages", item_body: questionBody } });
      }
      throw new Error(`unexpected read ${publicName}`);
    };
  }

  it("names every course an item bank question change reaches", async () => {
    const calls: { publicName: string; args: Readonly<Record<string, unknown>> }[] = [];
    const context = await resolveApprovalReviewContext({
      operation: itemBankOperation(itemBankGuard({ complete: true, external_course_ids: ["456", "789"], unreachable: [] })),
      tools: itemBankTools,
      read: itemBankReads({ 42: "Intro to Biology", 456: "Chemistry 110", 789: "Human Anatomy" }, calls),
    });

    expect(context).toEqual({
      targets: [
        { field: "course_id", label: "Course", name: "Intro to Biology" },
        { field: "bank_id", label: "Item Bank", name: "Unit 3 question bank" },
        { field: "morrow_item_bank_fan_out", label: "Also changes these courses", name: "Chemistry 110 (course 456), Human Anatomy (course 789)." },
        { field: "item_id", label: "Question", name: "Photosynthesis stages" },
      ],
    });
    expect(calls).toEqual(expect.arrayContaining([
      { publicName: "canvas_item_bank_get_entry", args: { bank_id: "5", bank_entry_id: "9", _morrow: { source_binding_id: sourceBindingId } } },
      { publicName: "canvas_item_bank_get_item", args: { bank_id: "5", item_id: "7", _morrow: { source_binding_id: sourceBindingId } } },
      { publicName: "canvas_get_single_course_courses", args: { id: "456", _morrow: { source_binding_id: sourceBindingId } } },
      { publicName: "canvas_get_single_course_courses", args: { id: "789", _morrow: { source_binding_id: sourceBindingId } } },
    ]));
  });

  it("shows a course whose name it could not read by its id and says so", async () => {
    const context = await resolveApprovalReviewContext({
      operation: itemBankOperation(itemBankGuard({ complete: true, external_course_ids: ["456", "789"], unreachable: [] })),
      tools: itemBankTools,
      read: itemBankReads({ 42: "Intro to Biology", 456: "Chemistry 110", 789: null }),
    });

    expect(context.targets).toContainEqual({
      field: "morrow_item_bank_fan_out",
      label: "Also changes these courses",
      name: "Chemistry 110 (course 456), Course 789 (Morrow could not read this course name).",
    });
  });

  it("separates a bank that reaches no other course from a record that was not read", async () => {
    const complete = await resolveApprovalReviewContext({
      operation: itemBankOperation(itemBankGuard({ complete: true, external_course_ids: [], unreachable: [] })),
      tools: itemBankTools,
      read: itemBankReads({ 42: "Intro to Biology" }),
    });
    const incomplete = await resolveApprovalReviewContext({
      operation: itemBankOperation(itemBankGuard({ complete: false, external_course_ids: ["456"], unreachable: ["quiz_uses"] })),
      tools: itemBankTools,
      read: itemBankReads({ 42: "Intro to Biology", 456: "Chemistry 110" }),
    });
    const unreadable = await resolveApprovalReviewContext({
      operation: itemBankOperation(itemBankGuard({ complete: true, external_course_ids: "456" as unknown as string[] })),
      tools: itemBankTools,
      read: itemBankReads({ 42: "Intro to Biology" }),
    });

    expect(complete.targets).toContainEqual({ field: "morrow_item_bank_fan_out", label: "Also changes these courses", name: "No other course uses this item bank." });
    expect(incomplete.targets).toContainEqual({
      field: "morrow_item_bank_fan_out",
      label: "Also changes these courses",
      name: "Chemistry 110 (course 456). Morrow could not read every course this item bank reaches.",
    });
    expect(unreadable.targets).toContainEqual({
      field: "morrow_item_bank_fan_out",
      label: "Also changes these courses",
      name: "Morrow could not read every course this item bank reaches.",
    });
  });

  it("names every course it lists while bounding the names one review reads", async () => {
    const ids = Array.from({ length: 27 }, (_, index) => String(1000 + index));
    const courseNames = Object.fromEntries([["42", "Intro to Biology"], ...ids.map((id) => [id, `Section ${id}`])]);
    const calls: { publicName: string; args: Readonly<Record<string, unknown>> }[] = [];
    const context = await resolveApprovalReviewContext({
      operation: itemBankOperation(itemBankGuard({ complete: true, external_course_ids: ids, unreachable: [] })),
      tools: itemBankTools,
      read: itemBankReads(courseNames, calls),
    });

    const reach = context.targets.find((target) => target.field === "morrow_item_bank_fan_out")?.name || "";
    for (const id of ids) expect(reach).toContain(id);
    expect(reach).toContain("Section 1000 (course 1000)");
    expect(reach).toContain("Course 1025, Course 1026.");
    expect(reach).toContain("Morrow read the first 25 of these course names.");
    expect(calls.filter((call) => call.publicName === "canvas_get_single_course_courses")).toHaveLength(26);
  });

  it("leaves the item bank question unnamed when the fresh reads do not confirm it", async () => {
    const context = await resolveApprovalReviewContext({
      operation: itemBankOperation(itemBankGuard({ complete: true, external_course_ids: [], unreachable: [] })),
      tools: itemBankTools,
      read: async (publicName) => {
        if (publicName === "canvas_get_single_course_courses") return connector({ id: "42", name: "Intro to Biology" });
        if (publicName === "canvas_item_bank_get_bank") return connector({ id: "5", title: "Unit 3 question bank" });
        if (publicName === "canvas_item_bank_get_entry") return connector({ id: "9", entry_type: "Stimulus", entry_id: "7" });
        if (publicName === "canvas_item_bank_get_item") return connector({ id: "7", entry_type: "Item", entry: { title: "Photosynthesis stages", item_body: questionBody } });
        throw new Error(`unexpected read ${publicName}`);
      },
    });

    expect(context.targets).toContainEqual({ field: "item_id", label: "Question", name: "" });
  });

  it("keeps the question body and the image source out of the item bank review", async () => {
    const context = await resolveApprovalReviewContext({
      operation: itemBankOperation(itemBankGuard({ complete: true, external_course_ids: ["456"], unreachable: [] })),
      tools: itemBankTools,
      read: itemBankReads({ 42: "Intro to Biology", 456: "Chemistry 110" }),
    });

    const review = JSON.stringify(context);
    expect(review).not.toContain("<img");
    expect(review).not.toContain("school.instructure.com");
    expect(review).not.toContain("Which structure captures light?");
    expect(context.current).toBeUndefined();
    expect(context.question).toBeUndefined();
  });
});
