import { describe, expect, it } from "vitest";
import catalogJson from "../../../artifacts/canvas-api/canvas-api-catalog.json";
import {
  canvasAdmissionReason,
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

  it("admits response-bound accommodations and Progress-bound report creation", () => {
    const names = [
      "canvas_set_course_level_accommodations",
      "canvas_set_quiz_level_accommodations",
      "canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post",
    ];
    for (const name of names) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name);
      expect(operation, name).toBeTruthy();
      const admission = canvasOperationAdmission(operation!);
      expect(admission.courseTarget, name).toEqual({ kind: "course_path", argument: "course_id" });
      expect(admission.write, name).toEqual({ state: "admitted" });
      expect(canvasReadbackAssessment(catalog.operations, operation!, admission), name)
        .toEqual({ state: "structurally_exact" });
    }
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
   * Checked against the Canvas Assignment resource on 8 September 2026:
   * https://developerdocs.instructure.com/services/canvas/resources/assignments
   *
   * The response shape is not what blocks this. `result_type` has one allowed
   * value, `Quiz`; with the argument omitted "the response will be serialized
   * into an assignment format" and the route "Returns an Assignment object".
   * Two documented facts do block it. Canvas documents no field on the copy
   * that names it a New Quiz: the Assignment object documents
   * `is_quiz_assignment`, whose name and description disagree with each other,
   * and documents no `is_quiz_lti_assignment`. And Canvas documents no signal
   * that the copy has finished: `workflow_state` is documented only as "String
   * indicating what state this assignment is in", with `unpublished` as its one
   * example value, so a reread taken straight after the request could describe
   * a half-made copy.
   */
  it("holds assignment duplication because no documented state says the copy is finished", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_duplicate_assignment");
    expect(operation).toBeTruthy();
    const admission = canvasOperationAdmission(operation!);
    expect(admission.write).toEqual({ state: "held", reason: "duplicate_assignment_exact_readback_unavailable" });
    expect(canvasReadbackAssessment(catalog.operations, operation!, admission))
      .toEqual({ state: "not_applicable", reason: "write_held" });
    const reason = canvasAdmissionReason(admission.write)!;
    expect(reason).toContain("does not say when a duplicated assignment has finished copying");
    expect(reason).toContain("no documented field that names it as a New Quiz");
    // The retired belief: Canvas does document one response shape for the
    // request Morrow would send, so this must not come back as the reason.
    expect(reason).not.toContain("different record types");
  });
});
