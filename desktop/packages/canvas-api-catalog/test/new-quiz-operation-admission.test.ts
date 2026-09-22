import { describe, expect, it } from "vitest";
import catalogJson from "../../../artifacts/canvas-api/canvas-api-catalog.json";
import {
  canvasOperationAdmission,
  canvasReadbackAssessment,
  parseCanvasApiCatalog,
} from "../src/index.js";

const catalog = parseCanvasApiCatalog(catalogJson);

describe("New Quiz write admission", () => {
  it("publishes the official New Quiz enums, positive values, and date formats", () => {
    const quiz = catalog.operations.find((candidate) => candidate.toolName === "canvas_create_new_quiz")!;
    const item = catalog.operations.find((candidate) => candidate.toolName === "canvas_create_quiz_item")!;
    const quizProperties = quiz.inputSchema.properties as Record<string, Record<string, unknown>>;
    const itemProperties = item.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(quizProperties.quiz_points_possible).toMatchObject({ type: "number", exclusiveMinimum: 0 });
    expect(quizProperties.quiz_due_at).toMatchObject({ type: "string", format: "date-time" });
    expect(quizProperties.quiz_grading_type.enum).toEqual(["pass_fail", "percent", "letter_grade", "gpa_scale", "points"]);
    expect(quizProperties.quiz_quiz_settings_calculator_type.enum).toEqual([null, "none", "basic", "scientific"]);
    expect(quizProperties.quiz_quiz_settings_multiple_attempts_score_to_keep.enum).toEqual(["average", "first", "highest", "latest"]);
    expect(quizProperties.quiz_quiz_settings_one_at_a_time_type.enum).toEqual(["none", "question"]);
    expect(quizProperties.quiz_quiz_settings_result_view_settings_display_item_response_qualifier.enum)
      .toEqual(["always", "once_per_attempt", "after_last_attempt", "once_after_last_attempt"]);
    expect(itemProperties.item_entry_type).toMatchObject({ enum: ["Item"] });
    expect(itemProperties.item_points_possible).toMatchObject({ exclusiveMinimum: 0 });
    expect(itemProperties.item_position).toMatchObject({ type: "integer", exclusiveMinimum: 0 });
    expect(itemProperties.item_position).not.toHaveProperty("pattern");
    expect(itemProperties.item_entry_calculator_type.enum).toEqual(["none", "basic", "scientific"]);
    expect(itemProperties.item_entry_interaction_type_slug.enum).toEqual([
      "multi-answer", "matching", "categorization", "file-upload", "formula", "ordering",
      "rich-fill-blank", "hot-spot", "choice", "numeric", "true-false", "essay",
    ]);
  });

  it("admits learner-specific accommodations through their course and Progress-bound report creation", () => {
    const accommodations = [
      "canvas_set_course_level_accommodations",
      "canvas_set_quiz_level_accommodations",
    ];
    for (const name of accommodations) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name);
      expect(operation, name).toBeTruthy();
      const admission = canvasOperationAdmission(operation!);
      expect(admission.courseTarget, name).toEqual({ kind: "course_path", argument: "course_id" });
      expect(admission.write, name).toEqual({ state: "admitted" });
      expect(canvasReadbackAssessment(catalog.operations, operation!, admission), name)
        .toEqual({ state: "structurally_exact" });
    }

    const report = catalog.operations.find((candidate) => candidate.toolName
      === "canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post")!;
    const reportAdmission = canvasOperationAdmission(report);
    expect(reportAdmission.courseTarget).toEqual({ kind: "course_path", argument: "course_id" });
    expect(reportAdmission.write).toEqual({ state: "admitted" });
    expect(canvasReadbackAssessment(catalog.operations, report, reportAdmission))
      .toEqual({ state: "structurally_exact" });
  });

  it("admits New Quiz create and delete behind the lifecycle guard", () => {
    const names = ["canvas_create_new_quiz", "canvas_delete_new_quiz"];
    for (const name of names) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name);
      expect(operation, name).toBeTruthy();
      const admission = canvasOperationAdmission(operation!);
      expect(admission.write, name).toEqual({ state: "admitted" });
      expect(canvasReadbackAssessment(catalog.operations, operation!, admission), name)
        .toEqual({ state: "structurally_exact" });
    }
  });

  it("keeps guarded New Quiz update and item lifecycle writes admitted", () => {
    const names = [
      "canvas_update_single_quiz",
      "canvas_create_quiz_item",
      "canvas_update_quiz_item",
      "canvas_delete_quiz_item",
    ];
    for (const name of names) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name);
      expect(operation, name).toBeTruthy();
      expect(canvasOperationAdmission(operation!).write, name).toEqual({ state: "admitted" });
      expect(canvasReadbackAssessment(catalog.operations, operation!), name).toEqual({ state: "structurally_exact" });
    }
  });

  /*
   * Checked against the Canvas Assignment resource on 15 September 2026: a copy documents
   * `original_assignment_id`, so the named readback compares it and waits for a documented saved state.
   */
  it("admits assignment duplication with a named readback of the finished copy", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_duplicate_assignment");
    expect(operation).toBeTruthy();
    const admission = canvasOperationAdmission(operation!);
    expect(admission.write).toEqual({ state: "admitted" });
    expect(canvasReadbackAssessment(catalog.operations, operation!, admission)).toEqual({ state: "structurally_exact" });
  });
});
