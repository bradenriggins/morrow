import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANVAS_REVIEWED_UPLOAD_ROUTES, canvasAccountAuthorityRoute, canvasAdmissionIsBound, canvasReviewedUploadKind, canvasReviewedUploadPath, canvasReviewedUploadRoute, canvasAdmissionReason, canvasApiCompatibilityDigest, canvasCatalogTools, canvasSiteAuthorityNote, canvasOperationAdmission, canvasReadbackAssessment, canvasSemanticContextInputState, canvasSemanticCourseCollectionArguments, canvasSemanticCourseCollectionState, canvasSemanticCourseTarget, canvasSemanticObjectContext, canvasSemanticObjectVersion, canvasSemanticResolutionProblem, canvasSemanticResolvedCourseId, canvasSemanticSeriesInput, canvasSemanticVersionState, evaluateBrowserReadback, loadCanvasApiCatalog, operationalJsonSchema, parseCanvasApiCatalog, operationArguments, planBrowserReadback } from "../src/index.js";
import catalogJson from "../../../artifacts/canvas-api/canvas-api-catalog.json";

const catalog = parseCanvasApiCatalog(catalogJson);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function catalogFixture(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "morrow-public-catalog-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "canvas-api-catalog.json");
  writeFileSync(path, JSON.stringify(catalogJson));
  return { directory, path };
}

describe("Canvas API catalog", () => {
  it("loads an ordinary catalog through the exact public catalog reader", () => {
    const { path } = catalogFixture();
    const loaded = loadCanvasApiCatalog(path);
    expect(loaded.catalogDigest).toBe(catalog.catalogDigest);
    expect(loaded.operations.length).toBe(catalog.operations.length);
  });

  it("separates transport and presentation metadata from operational compatibility", () => {
    const expected = canvasApiCompatibilityDigest(catalog);
    const presentation = structuredClone(catalog);
    Object.assign(presentation.source, { indexUrl: "https://docs.example.invalid/new-index" });
    Object.assign(presentation.operations[0]!, {
      source: "new-provenance-label",
      resource: "New visible group",
      summary: "New visible title",
      description: "New visible explanation.",
    });
    const firstProperty = Object.values(presentation.operations[0]!.inputSchema.properties || {})[0];
    if (firstProperty && typeof firstProperty === "object") Object.assign(firstProperty, { description: "New field help." });
    expect(canvasApiCompatibilityDigest(presentation)).toBe(expected);

    const changedRoute = structuredClone(catalog);
    Object.assign(changedRoute.operations[0]!, { path: "/v1/changed-operational-route" });
    expect(canvasApiCompatibilityDigest(changedRoute)).not.toBe(expected);
  });

  it("removes schema annotations without removing fields named title or description", () => {
    expect(operationalJsonSchema({
      type: "object",
      title: "Visible schema title",
      description: "Visible schema help.",
      properties: {
        title: { type: "string", description: "Visible field help." },
        description: { type: "string", title: "Visible field title" },
      },
      additionalProperties: false,
    })).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
      },
      additionalProperties: false,
    });
  });

  it.skipIf(process.platform === "win32")("refuses a final symbolic link before catalog parsing", () => {
    const { directory, path } = catalogFixture();
    const linked = join(directory, "linked-catalog.json");
    symlinkSync(path, linked);
    expect(() => loadCanvasApiCatalog(linked)).toThrow(/stable regular file/u);
  });

  it("covers the official surface plus the browser-session Item Banks contract", () => {
    expect(catalog.counts.officialOperations).toBeGreaterThanOrEqual(1_100);
    expect(catalog.counts.itemBankOperations).toBe(18);
    expect(catalog.counts.newQuizzesOperations).toBeGreaterThan(12);
    expect(new Set(catalog.operations.map((operation) => operation.toolName)).size).toBe(catalog.operations.length);
  });

  it("keeps Canvas int64 identifiers as exact decimal strings", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_get_new_quiz");
    expect(operation).toBeTruthy();
    const course = operation!.parameters.find((parameter) => parameter.wireName === "course_id");
    expect(course?.schema).toMatchObject({ type: "string", pattern: "^[1-9][0-9]*$" });
    expect(operationArguments(operation!, { course_id: "9007199254740993", assignment_id: "9223372036854775807" }).path)
      .toBe("/quiz/v1/courses/9007199254740993/quizzes/9223372036854775807");
  });

  it("keeps anonymous submission references as path-safe opaque strings", () => {
    for (const name of [
      "canvas_get_single_submission_by_anonymous_id_courses",
      "canvas_get_single_submission_by_anonymous_id_sections",
      "canvas_grade_or_comment_on_submission_by_anonymous_id_courses",
      "canvas_grade_or_comment_on_submission_by_anonymous_id_sections",
      "canvas_show_provisional_grade_status_for_student_assignments_assignment_id_anonymous_provisional_grades_get",
    ]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name);
      expect(operation, name).toBeTruthy();
      expect(operation!.inputSchema.properties?.anonymous_id, name).toMatchObject({
        type: "string",
        pattern: "^[A-Za-z0-9_-]{1,255}$",
      });
    }
  });

  it("preserves official enums and distinguishes Canvas IDs from ordinary int64 values", () => {
    const parameter = (toolName: string, wireName: string) => {
      const operation = catalog.operations.find((candidate) => candidate.toolName === toolName);
      expect(operation, toolName).toBeTruthy();
      const found = operation!.parameters.find((candidate) => candidate.wireName === wireName);
      expect(found, `${toolName}:${wireName}`).toBeTruthy();
      return found!;
    };

    expect(parameter("canvas_switch_experience", "experience").schema.enum).toEqual(["academic", "career"]);
    expect(parameter("canvas_update_courses", "event").schema.enum).toEqual(["offer", "conclude", "delete", "undelete"]);
    expect(parameter("canvas_create_new_discussion_topic_courses", "discussion_type").schema.enum)
      .toEqual(["side_comment", "threaded", "not_threaded"]);
    for (const toolName of [
      "canvas_create_new_discussion_topic_courses",
      "canvas_update_topic_courses",
      "canvas_create_new_discussion_topic_groups",
      "canvas_update_topic_groups",
    ]) {
      expect(parameter(toolName, "discussion_type").schema.enum, toolName)
        .toEqual(["side_comment", "threaded", "not_threaded"]);
      expect(parameter(toolName, "sort_order").schema.enum, toolName).toEqual(["asc", "desc"]);
    }
    expect(parameter("canvas_create_ai_experience", "workflow_state").schema.enum)
      .toEqual(["published", "unpublished"]);
    expect(parameter("canvas_update_ai_experience", "workflow_state").schema.enum)
      .toEqual(["published", "unpublished"]);
    expect(parameter("canvas_list_ai_experiences", "workflow_state").schema.enum)
      .toEqual(["published", "unpublished", "deleted"]);
    expect(parameter("canvas_list_enrollments_courses", "type").schema).toMatchObject({
      type: "array",
      items: {
        type: "string",
        enum: ["StudentEnrollment", "TeacherEnrollment", "TaEnrollment", "DesignerEnrollment", "ObserverEnrollment"],
      },
    });
    expect(parameter("canvas_list_users_in_course_users", "enrollment_type").schema).toMatchObject({
      type: "array",
      items: { type: "string", enum: ["teacher", "student", "student_view", "ta", "observer", "designer"] },
    });
    expect(parameter("canvas_bulk_fetch_user_tags_for_multiple_users_in_course", "user_ids").schema)
      .toMatchObject({ type: "array", items: { type: "string", pattern: "^[1-9][0-9]*$" } });
    for (const toolName of [
      "canvas_retrieve_assignment_overridden_dates_for_classic_quizzes",
      "canvas_retrieve_assignment_overridden_dates_for_new_quizzes",
    ]) {
      expect(parameter(toolName, "quiz_assignment_overrides[quiz_ids]").schema, toolName)
        .toMatchObject({ type: "array", items: { type: "string", pattern: "^[1-9][0-9]*$" } });
    }
    for (const toolName of ["canvas_create_module_item", "canvas_update_module_item"]) {
      expect(parameter(toolName, "module_item[indent]").schema, toolName)
        .toMatchObject({ type: "integer", minimum: 0 });
    }
    for (const toolName of ["canvas_create_new_grading_standard_courses", "canvas_update_grading_standard_courses"]) {
      expect(parameter(toolName, "grading_scheme_entry[value]").schema, toolName)
        .toMatchObject({ type: "array", items: { type: "integer", minimum: 0, maximum: 100 } });
    }
  });

  it("models documented Canvas booleans, sentinels, nullable settings, and exceptional identifiers", () => {
    const schema = (toolName: string, wireName: string) => catalog.operations
      .find((candidate) => candidate.toolName === toolName)!.parameters
      .find((candidate) => candidate.wireName === wireName)!.schema;

    for (const toolName of ["canvas_create_assignment", "canvas_edit_assignment"]) {
      expect(schema(toolName, "assignment[grade_group_students_individually]"), toolName).toMatchObject({ type: "boolean" });
    }
    expect(schema("canvas_list_lti_launch_definitions_courses", "include_context_name[Boolean]")).toMatchObject({ type: "boolean" });
    expect(schema("canvas_create_assignment", "assignment[allowed_attempts]").anyOf)
      .toEqual([{ const: -1 }, { type: "integer", minimum: 1 }]);
    expect(schema("canvas_edit_assignment", "assignment[allowed_attempts]").anyOf)
      .toEqual([{ type: "null" }, { const: -1 }, { type: "integer", minimum: 1 }]);
    for (const toolName of ["canvas_create_quiz", "canvas_edit_quiz"]) {
      expect(schema(toolName, "quiz[allowed_attempts]").anyOf, toolName)
        .toEqual([{ const: -1 }, { type: "integer", minimum: 1 }]);
      expect(schema(toolName, "quiz[access_code]").type, toolName).toEqual(["string", "null"]);
      expect(schema(toolName, "quiz[ip_filter]").type, toolName).toEqual(["string", "null"]);
      expect(schema(toolName, "quiz[hide_results]"), toolName).toMatchObject({
        type: ["string", "null"], enum: ["always", "until_after_last_attempt", null],
      });
      expect(schema(toolName, "quiz[time_limit]").anyOf, toolName)
        .toEqual([{ type: "null" }, { type: "integer", minimum: 1 }]);
    }
    expect(schema("canvas_set_course_timetable", "timetables[course_section_id]")).toMatchObject({
      type: "array",
      items: { anyOf: [{ const: "all" }, { type: "string", pattern: "^[1-9][0-9]*$" }] },
    });
    expect(schema("canvas_get_outcome_results", "user_ids").items).toMatchObject({
      anyOf: [{ pattern: "^[1-9][0-9]*$" }, { pattern: "^sis_user_id:.+$", maxLength: 512 }],
    });
  });

  it("models proficiency arrays and course choices with their documented element contracts", () => {
    const schema = (toolName: string, wireName: string) => catalog.operations
      .find((candidate) => candidate.toolName === toolName)!.parameters
      .find((candidate) => candidate.wireName === wireName)!.schema;

    expect(schema("canvas_create_update_proficiency_ratings_courses", "ratings[points]")).toMatchObject({
      type: "array", items: { type: "integer", minimum: 0 },
    });
    expect(schema("canvas_create_update_proficiency_ratings_courses", "ratings[mastery]")).toMatchObject({
      type: "array", items: { type: "boolean" },
    });
    expect(schema("canvas_create_update_proficiency_ratings_courses", "ratings[color]")).toMatchObject({
      type: "array", items: { type: "string", pattern: "^[0-9A-Fa-f]{6}$" },
    });
    expect(schema("canvas_create_new_course", "course[course_format]").enum).toEqual(["on_campus", "online", "blended"]);
    expect(schema("canvas_update_course", "course[grade_passback_setting]").enum).toEqual(["nightly_sync", ""]);
    expect(schema("canvas_update_course", "course[course_format]").enum).toEqual(["on_campus", "online"]);
    expect(schema("canvas_update_course", "course[license]").enum).toEqual([
      "private", "cc_by_nc_nd", "cc_by_nc_sa", "cc_by_nc", "cc_by_nd", "cc_by_sa", "cc_by", "public_domain",
    ]);
    expect(schema("canvas_update_course", "course[event]").enum)
      .toEqual(["claim", "offer", "conclude", "delete", "undelete"]);
  });

  it("repairs official scalar metadata when the documented Canvas value is nullable, repeated, or boolean", () => {
    const schema = (toolName: string, wireName: string) => catalog.operations
      .find((candidate) => candidate.toolName === toolName)!.parameters
      .find((candidate) => candidate.wireName === wireName)!.schema;

    for (const toolName of ["canvas_create_appointment_group", "canvas_update_appointment_group"]) {
      expect(schema(toolName, "appointment_group[participants_per_appointment]").anyOf, toolName)
        .toEqual([{ type: "null" }, { type: "integer" }]);
    }
    for (const toolName of ["canvas_create_assignment_override", "canvas_update_assignment_override"]) {
      for (const wireName of ["assignment_override[due_at]", "assignment_override[lock_at]", "assignment_override[unlock_at]"]) {
        expect(schema(toolName, wireName).type, `${toolName}:${wireName}`).toEqual(["string", "null"]);
      }
    }
    for (const toolName of ["canvas_create_course_pace", "canvas_update_course_pace"]) {
      expect(schema(toolName, "selected_days_to_skip"), toolName)
        .toMatchObject({ type: "array", items: { type: "string" } });
    }
    for (const toolName of [
      "canvas_retrieve_assignments_enabled_for_grade_export_to_sis_accounts",
      "canvas_retrieve_assignments_enabled_for_grade_export_to_sis_courses",
    ]) {
      expect(schema(toolName, "include"), toolName).toMatchObject({
        type: "array", items: { type: "string", enum: ["student_overrides"] },
      });
    }
    for (const toolName of ["canvas_list_lti_launch_definitions_accounts", "canvas_list_lti_launch_definitions_courses"]) {
      expect(schema(toolName, "only_visible[Boolean]"), toolName).toMatchObject({ type: "boolean" });
    }
    expect(schema("canvas_update_account", "account[settings][suppress_notifications]").anyOf).toEqual([
      { type: "boolean" },
      { type: "array", items: { type: "string", minLength: 1 } },
    ]);
    for (const wireName of [
      "grading_period_set[display_totals_for_all_grading_periods]",
      "grading_period_set[weighted]",
    ]) {
      expect(schema("canvas_update_grading_period_set", wireName), wireName).toMatchObject({ type: "boolean" });
    }
    expect(schema("canvas_update_list_of_blackout_dates", "blackout_dates:")).toMatchObject({
      type: "array", items: { type: "object", additionalProperties: true },
    });
  });

  it("binds a collection readback to the exact updated discussion entry", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_update_entry_courses")!;
    const plan = planBrowserReadback(catalog.operations, operation, {
      course_id: "42", topic_id: "51", id: "77", message: "Edited body",
    }, {});

    expect(plan?.readOperation.toolName).toBe("canvas_list_topic_entries_courses");
    expect(plan?.arguments).toEqual({ course_id: "42", topic_id: "51" });
    expect(plan?.strategy).toBe("collection-contains-target");
    expect(plan?.targetId).toBe("77");
    expect(evaluateBrowserReadback(plan, { ok: true, status: 200, data: [
      { id: "76", message: "Other body" },
      { id: "77", message: "Edited body" },
    ] }).status).toBe("verified");
    expect(evaluateBrowserReadback(plan, { ok: true, status: 200, truncated: true, data: [
      { id: "77", message: "Edited body" },
    ] })).toMatchObject({ status: "unconfirmed", evidence: "collection_readback_incomplete" });
    expect(evaluateBrowserReadback(plan, { ok: true, status: 200, data: [
      { id: "77", message: "Old body" },
    ] }).status).toBe("mismatch");
  });

  it("retains New Quiz IP ranges and explicit setting resets through request and readback", () => {
    const ranges = [["10.0.0.1", "10.0.0.20"], ["192.168.1.1", "192.168.1.5"]];
    const input = {
      course_id: "42", assignment_id: "77", quiz_instructions: "",
      quiz_quiz_settings_filters_ips: ranges,
      quiz_quiz_settings_student_access_code: null,
      quiz_quiz_settings_session_time_limit_in_seconds: null,
    };
    for (const toolName of ["canvas_create_new_quiz", "canvas_update_single_quiz"]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === toolName)!;
      expect(operation.inputSchema).toMatchObject({ properties: {
        quiz_quiz_settings_filters_ips: {
          type: ["array", "null"], items: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } },
        },
        quiz_quiz_settings_student_access_code: { type: ["string", "null"] },
        quiz_quiz_settings_session_time_limit_in_seconds: { type: ["integer", "null"] },
      } });
      expect(operationArguments(operation, input).body).toEqual([
        ["quiz[instructions]", ""],
        ["quiz[quiz_settings][filters][ips]", ranges],
        ["quiz[quiz_settings][session_time_limit_in_seconds]", null],
        ["quiz[quiz_settings][student_access_code]", null],
      ]);
      const plan = planBrowserReadback(catalog.operations, operation, input, { id: "77" });
      expect(plan).toBeTruthy();
      const saved = { id: "77", instructions: "", quiz_settings: {
        filters: { ips: ranges }, student_access_code: null, session_time_limit_in_seconds: null,
      } };
      expect(evaluateBrowserReadback(plan, { ok: true, status: 200, data: saved }).status).toBe("verified");
      expect(evaluateBrowserReadback(plan, { ok: true, status: 200, data: {
        ...saved, quiz_settings: { ...saved.quiz_settings, session_time_limit_in_seconds: 3600 },
      } }).status).toBe("mismatch");
    }
  });

  it("accepts a Page module item with its page slug and no content ID", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_create_module_item");
    expect(operation).toBeTruthy();
    expect(operation!.inputSchema.required).not.toContain("module_item_content_id");
    expect(operation!.inputSchema.allOf).toContainEqual({
      if: { properties: { module_item_type: { const: "Page" } }, required: ["module_item_type"] },
      then: { required: ["module_item_page_url"] },
    });
    expect(operationArguments(operation!, {
      course_id: "1",
      module_id: "2",
      module_item_type: "Page",
      module_item_page_url: "cell-structures",
    }).body).toEqual([
      ["module_item[page_url]", "cell-structures"],
      ["module_item[type]", "Page"],
    ]);
  });

  it("still requires content ID for non-exempt module items", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_create_module_item");
    expect(operation).toBeTruthy();
    expect(() => operationArguments(operation!, {
      course_id: "1",
      module_id: "2",
      module_item_type: "Assignment",
    })).toThrow("module_item_content_id is required");
  });

  it("models the documented raw AssignmentDate array without passing it through generic form serialization", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_bulk_update_assignment_dates");
    expect(operation).toBeTruthy();
    expect(operation!.parameters.some((parameter) => parameter.inputName === "assignment_dates")).toBe(false);
    expect(operation!.inputSchema).toMatchObject({
      required: ["assignment_dates", "course_id"],
      properties: {
        assignment_dates: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            required: ["id", "all_dates"],
            properties: {
              all_dates: {
                minItems: 1,
                maxItems: 200,
                items: {
                  anyOf: [{ required: ["due_at"] }, { required: ["unlock_at"] }, { required: ["lock_at"] }],
                },
              },
            },
          },
        },
      },
    });
  });

  it("keeps all documented custom Gradebook Column updates as optional form fields", () => {
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_update_custom_gradebook_column");
    expect(operation).toBeTruthy();
    expect(operation!.inputSchema.required).toEqual(["course_id", "id"]);
    expect(operation!.parameters.filter((parameter) => parameter.location === "form")).toMatchObject([
      { inputName: "column_hidden", wireName: "column[hidden]", required: false, schema: { type: "boolean" } },
      { inputName: "column_position", wireName: "column[position]", required: false, schema: { type: "integer" } },
      { inputName: "column_read_only", wireName: "column[read_only]", required: false, schema: { type: "boolean" } },
      { inputName: "column_teacher_notes", wireName: "column[teacher_notes]", required: false, schema: { type: "boolean" } },
      { inputName: "column_title", wireName: "column[title]", required: false, schema: { type: "string" } },
    ]);
    expect(operationArguments(operation!, {
      course_id: "42",
      id: "7",
      column_title: "Participation",
      column_position: 3,
      column_hidden: true,
      column_teacher_notes: true,
      column_read_only: false,
    })).toEqual({
      path: "/v1/courses/42/custom_gradebook_columns/7",
      query: [],
      body: [
        ["column[hidden]", true],
        ["column[position]", 3],
        ["column[read_only]", false],
        ["column[teacher_notes]", true],
        ["column[title]", "Participation"],
      ],
    });
  });

  it("inherits documented Classic Quiz creation fields as optional updates", () => {
    const create = catalog.operations.find((candidate) => candidate.toolName === "canvas_create_quiz")!;
    const operation = catalog.operations.find((candidate) => candidate.toolName === "canvas_edit_quiz");
    expect(operation).toBeTruthy();
    expect(operation!.inputSchema.required).toEqual(["course_id", "id"]);
    const form = operation!.parameters.filter((parameter) => parameter.location === "form");
    for (const parameter of create.parameters.filter((parameter) => parameter.location === "form")) {
      expect(form).toContainEqual({ ...parameter, required: false });
    }
    expect(form).toContainEqual(expect.objectContaining({ inputName: "quiz_notify_of_update", required: false }));
    const args = { course_id: "42", id: "77", quiz_title: "Cell structures", quiz_time_limit: 30, quiz_shuffle_answers: true };
    expect(operationArguments(operation!, args).body).toEqual([
      ["quiz[shuffle_answers]", true], ["quiz[time_limit]", 30], ["quiz[title]", "Cell structures"],
    ]);
    const plan = planBrowserReadback(catalog.operations, operation!, args, { id: "77" });
    expect(evaluateBrowserReadback(plan, { ok: true, status: 200, data: {
      id: "77", title: "Cell structures", time_limit: 30, shuffle_answers: true,
    } }).status).toBe("verified");
    expect(evaluateBrowserReadback(plan, { ok: true, status: 200, data: {
      id: "77", title: "Cell structures", time_limit: 20, shuffle_answers: true,
    } }).status).toBe("mismatch");
  });

  it("types the Classic Quiz answer array and sends it as indexed form fields", () => {
    for (const toolName of ["canvas_update_existing_quiz_question", "canvas_create_single_quiz_question"]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === toolName);
      expect(operation).toBeTruthy();
      expect(operation!.parameters.find((parameter) => parameter.wireName === "question[answers]")?.schema).toMatchObject({
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["answer_text", "answer_weight"],
          properties: {
            id: { type: "string", pattern: "^[1-9][0-9]*$" },
            answer_text: { type: "string", maxLength: 16_384 },
            answer_weight: { type: "integer", minimum: 0, maximum: 100 },
            answer_comments: { type: "string", maxLength: 16_384 },
            answer_html: { type: "string", maxLength: 16_384 },
            text_after_answers: { type: "string", maxLength: 16_384 },
          },
        },
      });
    }

    const update = catalog.operations.find((candidate) => candidate.toolName === "canvas_update_existing_quiz_question");
    expect(operationArguments(update!, {
      course_id: "42",
      quiz_id: "77",
      id: "512",
      question_question_type: "multiple_choice_question",
      question_answers: [
        { id: "6656", answer_text: "Constantinople", answer_weight: 100, answer_comments: "Correct." },
        { answer_text: "Ankara", answer_weight: 0, answer_html: "<p>Ankara</p>" },
      ],
    })).toEqual({
      path: "/v1/courses/42/quizzes/77/questions/512",
      query: [],
      body: [
        ["question[answers][0][id]", "6656"],
        ["question[answers][0][answer_text]", "Constantinople"],
        ["question[answers][0][answer_weight]", 100],
        ["question[answers][0][answer_comments]", "Correct."],
        ["question[answers][1][answer_text]", "Ankara"],
        ["question[answers][1][answer_weight]", 0],
        ["question[answers][1][answer_html]", "<p>Ankara</p>"],
        ["question[question_type]", "multiple_choice_question"],
      ],
    });
    expect(() => operationArguments(update!, { course_id: "42", quiz_id: "77", id: "512", question_answers: "Constantinople" }))
      .toThrow("question_answers must be an array of answers");
  });

  it("reads one Item Bank item and offers only the verified share scopes", () => {
    const read = catalog.operations.find((candidate) => candidate.toolName === "canvas_item_bank_get_item");
    expect(read).toBeTruthy();
    expect(read!.readOnly).toBe(true);
    expect(canvasOperationAdmission(read!).write).toEqual({ state: "not_applicable" });
    expect(operationArguments(read!, { course_id: "42", bank_id: "901", item_id: "502" }).path).toBe("/api/banks/901/items/502");
    expect(() => operationArguments(read!, { bank_id: "901", item_id: "502" })).toThrow("course_id is required");
    expect(read!.parameters.map((parameter) => [parameter.inputName, parameter.location]))
      .toEqual([["bank_id", "path"], ["course_id", "control"], ["item_id", "path"]]);

    const shares = catalog.operations.find((candidate) => candidate.toolName === "canvas_item_bank_list_shares");
    expect(shares!.parameters.map((parameter) => [parameter.inputName, parameter.location]))
      .toEqual([["bank_id", "path"], ["course_id", "control"]]);
    expect(shares!.description).toContain("pagination is not established");

    const share = catalog.operations.find((candidate) => candidate.toolName === "canvas_item_bank_share_bank");
    expect(share!.inputSchema).toMatchObject({
      properties: {
        entity_type: { type: "string", enum: ["course"] },
        permission: { type: "string", enum: ["read"] },
      },
    });
    expect(share!.description).toContain("Only the course entity type and the read permission are verified.");
  });

  it("admits every Item Bank write with exact readback metadata", () => {
    const writes = catalog.operations.filter((operation) => operation.service === "item_bank" && !operation.readOnly);
    expect(writes).toHaveLength(11);
    for (const operation of writes) {
      expect(operation.inputSchema.required).toEqual(expect.arrayContaining(["course_id", "expected_snapshot"]));
      const admission = canvasOperationAdmission(operation);
      expect(admission.courseTarget, operation.toolName).toEqual({ kind: "course_path", argument: "course_id" });
      expect(admission.write).toEqual({ state: "admitted" });
      expect(canvasReadbackAssessment(catalog.operations, operation, admission)).toEqual({ state: "structurally_exact" });
    }
  });

  it("publishes every bound read and every admitted write that reads back exactly", () => {
    const tools = canvasCatalogTools(catalog);
    expect(tools).toHaveLength(catalog.counts.totalOperations);
    const writes = catalog.operations.filter((operation) => !operation.readOnly);
    const held = writes.filter((operation) => canvasOperationAdmission(operation).write.state === "held");
    const admittedWithoutExactReadback = writes.filter((operation) => (
      canvasOperationAdmission(operation).write.state === "admitted"
      && canvasReadbackAssessment(catalog.operations, operation).state !== "structurally_exact"
    ));
    const siteReads = catalog.operations.filter((operation) => operation.readOnly
      && canvasOperationAdmission(operation).authority === "site");
    const credentialReads = catalog.operations.filter((operation) => operation.toolName === "canvas_get_items_media_upload_url");
    const incompatibleAuthentication = catalog.operations.filter((operation) => (
      operation.path.startsWith("/lti/")
      && canvasOperationAdmission(operation).write.state !== "held"
    ));
    const redirectReads = catalog.operations.filter((operation) => operation.readOnly && operation.responseType === "void"
      && /redirect/iu.test(`${operation.summary} ${operation.description}`));
    expect(held).toHaveLength(10);
    expect(admittedWithoutExactReadback).toHaveLength(200);
    expect(siteReads).toHaveLength(355);
    // Every read is bound: to the selected course, or to the connected Canvas site as the signed-in person.
    expect(catalog.operations.filter((operation) => operation.readOnly
      && !canvasAdmissionIsBound(canvasOperationAdmission(operation)))).toEqual([]);
    const expectedLimited = new Set([
      ...held,
      ...credentialReads,
      ...catalog.operations.filter((operation) => operation.path.startsWith("/lti/")),
      ...redirectReads,
    ].map((operation) => operation.toolName));
    expect(tools.filter((tool) => tool.capability?.profiles["public-canvas"].state !== "supported"))
      .toHaveLength(expectedLimited.size);
    for (const operation of siteReads.filter((operation) => !expectedLimited.has(operation.toolName))) {
      const tool = tools.find((candidate) => candidate.name === operation.toolName);
      expect(tool?.capability?.profiles["public-canvas"], operation.toolName).toEqual({ state: "supported" });
      expect(tool?.capability?.authority.scopeClass, operation.toolName).toBe("site");
    }
    // A write with no exact readback is still published. It never claims a readback, the read-only
    // profile still refuses it, and the Bridge offers it only for approval one change at a time.
    for (const operation of admittedWithoutExactReadback.filter((operation) => !expectedLimited.has(operation.toolName))) {
      const tool = tools.find((candidate) => candidate.name === operation.toolName);
      expect(tool?.capability?.profiles["private-full"].state, operation.toolName).toBe("supported");
      expect(tool?.capability?.profiles["public-canvas"].state, operation.toolName).toBe("supported");
      expect(tool?.capability?.profiles["read-only"].state, operation.toolName).toBe("profile_limited");
      expect(tool?.capability?.behavior.supportsReadback, operation.toolName).toBe(false);
    }
    for (const operation of credentialReads) {
      const tool = tools.find((candidate) => candidate.name === operation.toolName);
      const reason = "This Canvas read returns a one-time media upload credential. Morrow keeps upload credentials inside its reviewed file transfer.";
      expect(tool?.capability?.profiles["private-full"]).toEqual({ state: "profile_limited", reason });
      expect(tool?.capability?.profiles["public-canvas"]).toEqual({ state: "profile_limited", reason });
      expect(tool?.capability?.profiles["read-only"]).toEqual({ state: "profile_limited", reason });
      expect(tool?.capability?.evidence?.admission).toEqual({ state: "blocked", reason });
    }
    for (const operation of incompatibleAuthentication) {
      const tool = tools.find((candidate) => candidate.name === operation.toolName);
      const reason = "This Canvas LTI service requires separate LTI authorization that the signed-in browser session does not hold.";
      expect(tool?.capability?.profiles["private-full"]).toEqual({ state: "profile_limited", reason });
      expect(tool?.capability?.profiles["public-canvas"]).toEqual({ state: "profile_limited", reason });
      expect(tool?.capability?.evidence?.admission).toEqual({ state: "blocked", reason });
    }
    for (const operation of redirectReads) {
      const tool = tools.find((candidate) => candidate.name === operation.toolName);
      const reason = "This Canvas route returns a navigation redirect instead of course data, which the Bridge does not follow across origins.";
      expect(tool?.capability?.profiles["private-full"]).toEqual({ state: "profile_limited", reason });
      expect(tool?.capability?.profiles["public-canvas"]).toEqual({ state: "profile_limited", reason });
      expect(tool?.capability?.evidence?.admission).toEqual({ state: "blocked", reason });
    }
    expect(tools.filter((tool) => tool.capability?.family === "new-quizzes-item-banks")).toHaveLength(18);
  });

  it("admits every course-path learner record under ordinary course Edit and exact readback", () => {
    const tools = new Map(canvasCatalogTools(catalog).map((tool) => [tool.name, tool]));
    const category = (operation: (typeof catalog.operations)[number]): string | undefined => {
      const { method, path } = operation;
      if (/^\/v1\/courses\/\{course_id\}\/assignments\/(?:overrides(?:\/|$)|\{[^}]+\}\/(?:allocate|anonymous_submissions|extensions|moderated_students|overrides|provisional_grades|submissions)(?:\/|$))/.test(path)) return "assignment records";
      if (/^\/v1\/courses\/\{course_id\}\/submissions(?:\/|$)/.test(path)) return "course submissions";
      if (/^\/v1\/courses\/\{course_id\}\/quizzes\/\{[^}]+\}\/(?:extensions|submissions)(?:\/|$)/.test(path)
        || /^\/v1\/courses\/\{course_id\}\/quiz_extensions(?:\/|$)/.test(path)) return "quiz attempts";
      if (/^\/v1\/courses\/\{course_id\}\/enrollments(?:\/|$)/.test(path)
        || /^\/v1\/courses\/\{course_id\}\/users\/\{[^}]+\}\/last_attended$/.test(path)) return "enrollments";
      if (/^\/v1\/courses\/\{course_id\}\/(?:custom_gradebook_column_data|what_if_grades)(?:\/|$)/.test(path)
        || /^\/v1\/courses\/\{course_id\}\/custom_gradebook_columns\/\{[^}]+\}\/data\/\{[^}]+\}$/.test(path)
        || /^\/v1\/courses\/\{course_id\}\/live_assessments\/\{[^}]+\}\/results$/.test(path)
        || /^\/v1\/courses\/\{course_id\}\/rubric_associations\/\{[^}]+\}\/rubric_assessments(?:\/|$)/.test(path)) return "grades and assessments";
      if (/^\/v1\/courses\/\{course_id\}\/modules\/\{[^}]+\}\/(?:assignment_overrides|relock|items\/\{[^}]+\}\/(?:done|mark_read|select_mastery_path))$/.test(path)) return "module learner state";
      if (/^\/v1\/courses\/\{course_id\}\/group_categories(?:\/|$)/.test(path)) return "group membership";
      if (/^\/quiz\/v1\/courses\/\{course_id\}(?:\/quizzes\/\{[^}]+\})?\/accommodations$/.test(path)) return "quiz accommodations";
      if (/^\/v1\/courses\/\{course_id\}\/ai_experiences\/\{[^}]+\}\/conversations(?:\/|$)/.test(path)) return "learner conversations";
      if (/^\/v1\/courses\/\{course_id\}\/course_pacing(?:\/|$)/.test(path)) return "learner pacing";
      if (/^\/v1\/courses\/\{course_id\}\/discussion_topics\/(?:read_all|\{[^}]+\}(?:\/.*)?)$/.test(path)
        && (path.endsWith("/read_all") || path.includes("/entries") || path.endsWith("/read")
          || path.endsWith("/subscribed") || path.endsWith("/rating")
          || /\/summaries\/\{[^}]+\}\/feedback$/.test(path))) return "discussion participation";
      if (method === "DELETE" && path === "/v1/courses/{course_id}/custom_gradebook_columns/{id}") return "grades and assessments";
      if (path === "/v1/courses/{course_id}/enqueue_outcome_rollup_calculation") return "learner rollup";
      if (path === "/v1/courses/{course_id}/quizzes/{id}/submission_users/message") return "learner messaging";
      if (method === "DELETE" && path === "/v1/courses/{id}") return "course lifecycle";
      return undefined;
    };
    const learnerWrites = catalog.operations.filter((operation) => !operation.readOnly && category(operation));
    const byCategory: Record<string, number> = {};
    for (const operation of learnerWrites) {
      const name = operation.toolName;
      const group = category(operation)!;
      byCategory[group] = (byCategory[group] || 0) + 1;
      const admission = canvasOperationAdmission(operation);
      expect(admission.courseTarget, name).toEqual({
        kind: "course_path",
        argument: operation.path === "/v1/courses/{id}" ? "id" : "course_id",
      });
      const expectedWrite = operation.path.endsWith("/files")
        ? { state: "held", reason: "multi_step_upload_requires_reviewed_transfer" }
        : { state: "admitted" };
      expect(admission.write, name).toEqual(expectedWrite);
      if (expectedWrite.state === "admitted") {
        // Admission is no longer the gate for a course learner record; exact readback still is.
        const readback = canvasReadbackAssessment(catalog.operations, operation);
        const profile = tools.get(name)?.capability?.profiles["private-full"];
        expect(profile?.state, name).toBe("supported");
        expect(tools.get(name)?.capability?.behavior.supportsReadback, name).toBe(readback.state === "structurally_exact");
        expect(tools.get(name)?.capability?.evidence?.admission, name).toEqual({ state: "known" });
      }
    }
    expect(byCategory).toEqual({
      "assignment records": 29,
      "course submissions": 3,
      "course lifecycle": 1,
      "discussion participation": 15,
      enrollments: 6,
      "grades and assessments": 8,
      "group membership": 3,
      "learner conversations": 6,
      "learner messaging": 1,
      "learner pacing": 3,
      "learner rollup": 1,
      "module learner state": 5,
      "quiz attempts": 7,
      "quiz accommodations": 2,
    });
    expect(learnerWrites).toHaveLength(90);
    // Every course-path learner record is course work, not a site request.
    expect(learnerWrites.filter((operation) => canvasOperationAdmission(operation).authority !== "course")).toEqual([]);
  });

  it("admits every body-semantic multi-course write as a site request and names its reach", () => {
    const tools = new Map(canvasCatalogTools(catalog).map((tool) => [tool.name, tool]));
    const multiCourse = [
      "canvas_begin_migration_to_push_to_associated_courses",
      "canvas_copy_course_content",
      "canvas_create_content_migration_courses",
      "canvas_create_link_outcome_courses",
      "canvas_create_link_outcome_courses_outcome_id",
      "canvas_delete_outcome_group_courses",
      "canvas_import_outcome_group_courses",
      "canvas_reset_course",
      "canvas_unlink_outcome_courses",
      "canvas_update_associated_courses",
      "canvas_update_course",
    ];
    const actual = catalog.operations.filter((operation) => canvasOperationAdmission(operation).siteClass === "multi_course"
      && !operation.readOnly);
    expect(actual.map((operation) => operation.toolName).sort()).toEqual(multiCourse);
    for (const operation of actual) {
      const admission = canvasOperationAdmission(operation);
      // The course path still names one of the courses. The request data can name another, so the
      // selected course does not narrow it and Canvas decides it with the person's own roles.
      expect(admission.courseTarget.kind, operation.toolName).toBe("course_path");
      expect(admission.authority, operation.toolName).toBe("site");
      expect(admission.write, operation.toolName).toEqual({ state: "admitted" });
      expect(tools.get(operation.toolName)?.capability?.authority.scopeClass, operation.toolName).toBe("site");
      const readback = canvasReadbackAssessment(catalog.operations, operation);
      expect(tools.get(operation.toolName)?.capability?.profiles["public-canvas"].state, operation.toolName)
        .toBe("supported");
      expect(tools.get(operation.toolName)?.capability?.behavior.supportsReadback, operation.toolName).toBe(readback.state === "structurally_exact");
    }
    expect(canvasSiteAuthorityNote("multi_course")).toBe("It can read from or change a Canvas course or account besides the selected one. Canvas decides it with your own roles in each of them.");
    // Deleting a group's discussion topic removes the posts under it too, so it is a person's record
    // reached through a group, not group content.
    const groupTopic = catalog.operations.find((operation) => operation.toolName === "canvas_delete_topic_groups")!;
    expect(canvasOperationAdmission(groupTopic)).toMatchObject({ authority: "site", siteClass: "learner_record", write: { state: "admitted" } });
  });

  it("admits a direct course route as course work and a personal route as a site request", () => {
    const direct = catalog.operations.find((operation) => operation.toolName === "canvas_update_course_settings");
    const nickname = catalog.operations.find((operation) => operation.toolName === "canvas_set_course_nickname");
    const createBank = catalog.operations.find((operation) => operation.toolName === "canvas_item_bank_create_bank");
    const existingBank = catalog.operations.find((operation) => operation.toolName === "canvas_item_bank_update_item");
    const bankDraw = catalog.operations.find((operation) => operation.toolName === "canvas_item_bank_attach_bank_to_quiz");
    const bookmark = catalog.operations.find((operation) => operation.toolName === "canvas_update_bookmark");
    const course = { courseTarget: { kind: "course_path", argument: "course_id" }, authority: "course", write: { state: "admitted" } };
    expect(canvasOperationAdmission(direct!)).toEqual(course);
    expect(canvasOperationAdmission(nickname!)).toEqual({
      courseTarget: { kind: "self_path", resource: "course_nickname", argument: "course_id" },
      authority: "site",
      siteClass: "person",
      write: { state: "admitted" },
    });
    expect(canvasOperationAdmission(createBank!)).toEqual(course);
    expect(canvasOperationAdmission(existingBank!)).toEqual(course);
    expect(canvasOperationAdmission(bankDraw!)).toEqual(course);
    expect(canvasOperationAdmission(bookmark!)).toEqual({
      courseTarget: { kind: "self_path", resource: "bookmark" },
      authority: "site",
      siteClass: "person",
      write: { state: "admitted" },
    });
  });

  it("admits Item Bank archive through the guarded private executor", () => {
    const archive = catalog.operations.find((operation) => operation.toolName === "canvas_item_bank_archive_bank")!;
    expect(archive.risk).toBe("destructive");
    expect(canvasOperationAdmission(archive)).toEqual({ courseTarget: { kind: "course_path", argument: "course_id" }, authority: "course", write: { state: "admitted" } });
    expect(canvasReadbackAssessment(catalog.operations, archive)).toEqual({ state: "structurally_exact" });
  });

  it("admits every personal bookmark and course-nickname write as a site request with an exact readback", () => {
    const tools = canvasCatalogTools(catalog);
    const selfScoped = [
      "canvas_create_bookmark",
      "canvas_update_bookmark",
      "canvas_delete_bookmark",
      "canvas_set_course_nickname",
      "canvas_remove_course_nickname",
      "canvas_clear_course_nicknames",
    ];
    for (const name of selfScoped) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name);
      expect(operation, name).toBeTruthy();
      const admission = canvasOperationAdmission(operation!);
      expect(admission.courseTarget.kind, name).toBe("self_path");
      expect(admission, name).toMatchObject({ authority: "site", siteClass: "person", write: { state: "admitted" } });
      expect(canvasReadbackAssessment(catalog.operations, operation!), name).toEqual({ state: "structurally_exact" });
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.capability?.behavior.supportsReadback, name).toBe(true);
      expect(tool?.capability?.profiles["public-canvas"], name).toEqual({ state: "supported" });
      expect(tool?.capability?.authority.scopeClass, name).toBe("site");
    }
  });

  // Account and administrative workflows are site requests. Canvas decides each one with the
  // signed-in person's own account roles, and docs/implementation/CANVAS-ADMISSION-CLASSES.md records
  // the contract. The LTI service routes under an account still need the LTI tool's own authorization.
  it("admits every account, global and developer key write as an account site request", () => {
    const tools = canvasCatalogTools(catalog);
    const accountRoute = (path: string) => path.startsWith("/v1/accounts/") || path.startsWith("/lti/accounts/")
      || path.startsWith("/v1/global/") || path.startsWith("/v1/developer_keys/") || path.startsWith("/lti/developer_key/")
      || path.includes("{account_id}");
    const accountWrites = catalog.operations.filter((operation) => !operation.readOnly && accountRoute(operation.path));
    const accountClass = catalog.operations.filter((operation) => !operation.readOnly
      && canvasOperationAdmission(operation).siteClass === "account");
    expect(accountClass.map((operation) => operation.toolName).sort())
      .toEqual(accountWrites.map((operation) => operation.toolName).sort());
    expect(accountWrites).toHaveLength(116);

    const byFamily: Record<string, number> = {};
    for (const operation of accountWrites) {
      const family = operation.path.split("/").slice(1, 3).join("/");
      byFamily[family] = (byFamily[family] || 0) + 1;
    }
    expect(byFamily).toEqual({
      "v1/account_calendars": 1,
      "v1/accounts": 105,
      "v1/developer_keys": 3,
      "v1/global": 7,
    });

    const note = "It changes a Canvas account, not one course. Canvas decides it with your own account roles on this Canvas site.";
    expect(canvasSiteAuthorityNote("account")).toBe(note);
    for (const operation of accountWrites) {
      const name = operation.toolName;
      const admission = canvasOperationAdmission(operation);
      expect(canvasAccountAuthorityRoute(operation), name).toBe(true);
      expect(admission.authority, name).toBe("site");
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.capability?.authority.scopeClass, name).toBe("site");
      if (operation.path.endsWith("/rubrics/upload")) {
        expect(admission.write, name).toEqual({ state: "held", reason: "multi_step_upload_requires_reviewed_transfer" });
        continue;
      }
      expect(admission.write, name).toEqual({ state: "admitted" });
      const readback = canvasReadbackAssessment(catalog.operations, operation);
      expect(tool?.capability?.behavior.supportsReadback, name).toBe(readback.state === "structurally_exact");
      expect(tool?.capability?.profiles["public-canvas"].state, name).toBe("supported");
    }

    // One named route from each part of the class. `canvas_update_courses` changes every course in
    // an account at once, which is exactly the authority a selected course cannot carry.
    expect(accountWrites.map((operation) => operation.toolName)).toEqual(expect.arrayContaining([
      "canvas_create_new_course",
      "canvas_update_courses",
      "canvas_create_lti_registration_lti_registrations",
      "canvas_create_developer_key",
      "canvas_update_developer_key",
      "canvas_create_link_outcome_global",
      "canvas_update_calendar",
    ]));

    // The class is about account authority, not about the letters "lti" in a route. A course write
    // that manages an LTI link through the ordinary API stays an admitted course write. The LTI
    // service's own writes accept only an installed tool's token, so the catalog carries none of them.
    const resourceLink = catalog.operations.find((candidate) => candidate.toolName === "canvas_update_lti_resource_link")!;
    expect(canvasAccountAuthorityRoute(resourceLink)).toBe(false);
    expect(canvasOperationAdmission(resourceLink)).toMatchObject({ authority: "course", write: { state: "admitted" } });
    expect(tools.find((candidate) => candidate.name === "canvas_update_lti_resource_link")?.capability?.authority.scopeClass).toBe("course");
    expect(catalog.operations.filter((operation) => !operation.readOnly && operation.path.startsWith("/lti/"))).toEqual([]);
    for (const name of ["canvas_create_line_item", "canvas_create_score", "canvas_update_public_jwk", "canvas_create_originality_report"]) {
      expect(catalog.operations.some((candidate) => candidate.toolName === name), name).toBe(false);
    }
    // The LTI reads stay listed with the reason they are unavailable.
    const ltiRead = catalog.operations.find((candidate) => candidate.readOnly && candidate.path === "/lti/courses/{course_id}/line_items")!;
    expect(tools.find((candidate) => candidate.name === ltiRead.toolName)?.capability?.profiles["public-canvas"].state).toBe("profile_limited");

    const admitted = catalog.operations.filter((operation) => !operation.readOnly
      && canvasOperationAdmission(operation).write.state === "admitted");
    expect(admitted).toHaveLength(540);
    expect(admitted.filter((operation) => accountRoute(operation.path))).toHaveLength(115);
  });

  it("keeps the single-nickname read bound to one course and produces no other course target kind", () => {
    const read = catalog.operations.find((operation) => operation.toolName === "canvas_get_course_nickname");
    expect(read?.path).toBe("/v1/users/self/course_nicknames/{course_id}");
    expect(canvasOperationAdmission(read!)).toEqual({
      courseTarget: { kind: "self_path", resource: "course_nickname", argument: "course_id" },
      authority: "course",
      write: { state: "not_applicable" },
    });
    const kinds = new Set(catalog.operations.map((operation) => canvasOperationAdmission(operation).courseTarget.kind));
    expect([...kinds].sort()).toEqual(["course_path", "none", "self_path", "semantic_course_object"]);
    const heldReasons = new Set(catalog.operations
      .map((operation) => canvasOperationAdmission(operation).write)
      .filter((write) => write.state === "held")
      .map((write) => write.reason));
    expect([...heldReasons].sort()).toEqual(["multi_step_upload_requires_reviewed_transfer"]);
  });

  // Every held write carries one reason from the closed set with its own sentence, and every site
  // request carries one site class with its own sentence. This case walks the whole catalog.
  it("gives every held write one reason and every site request one class, each with its own plain sentence", () => {
    const tools = canvasCatalogTools(catalog);
    const closedSet = ["multi_step_upload_requires_reviewed_transfer"] as const;
    const byReason = new Map<string, string[]>();
    const bySiteClass = new Map<string, string[]>();
    for (const operation of catalog.operations) {
      const admission = canvasOperationAdmission(operation);
      if (!operation.readOnly && admission.authority === "site") {
        expect(admission.siteClass, operation.toolName).toBeTruthy();
        bySiteClass.set(admission.siteClass!, [...(bySiteClass.get(admission.siteClass!) || []), operation.toolName].sort());
      }
      if (admission.authority === "course") expect(admission.siteClass, operation.toolName).toBeUndefined();
      const write = admission.write;
      if (write.state !== "held") {
        expect(canvasAdmissionReason(write), operation.toolName).toBeUndefined();
        continue;
      }
      expect(closedSet, operation.toolName).toContain(write.reason);
      byReason.set(write.reason, [...(byReason.get(write.reason) || []), operation.toolName].sort());
      const sentence = canvasAdmissionReason(write);
      const tool = tools.find((candidate) => candidate.name === operation.toolName);
      expect(tool?.capability?.profiles["public-canvas"], operation.toolName).toEqual({ state: "profile_limited", reason: sentence });
      expect(tool?.capability?.profiles["private-full"], operation.toolName).toEqual({ state: "profile_limited", reason: sentence });
      expect(tool?.capability?.evidence?.admission, operation.toolName).toEqual({ state: "blocked", reason: sentence });
      expect(tool?.capability?.behavior.supportsReadback, operation.toolName).toBe(false);
    }

    expect(Object.fromEntries([...byReason].map(([reason, names]) => [reason, names.length]))).toEqual({
      multi_step_upload_requires_reviewed_transfer: 10,
    });
    expect([...byReason.keys()].sort()).toEqual([...closedSet]);
    expect(Object.fromEntries([...bySiteClass].map(([siteClass, names]) => [siteClass, names.length]))).toEqual({
      account: 116,
      learner_record: 34,
      multi_course: 11,
      person: 98,
      session_credential: 9,
      shared_object: 48,
    });

    // No two classes share a sentence, none is empty, and none of them shows the person a route, an
    // internal name, or the word API.
    const sentences = [
      ...closedSet.map((reason) => canvasAdmissionReason({ state: "held", reason })!),
      ...[...bySiteClass.keys()].map((siteClass) => canvasSiteAuthorityNote(siteClass as Parameters<typeof canvasSiteAuthorityNote>[0])!),
    ];
    expect(new Set(sentences).size).toBe(closedSet.length + bySiteClass.size);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^[A-Z][^]*\.$/);
      expect(sentence).not.toMatch(/[{}/]|_[a-z]|\bAPI\b/);
    }

    // A Canvas group, file, folder, calendar item, section or outcome can belong to any course, so a
    // route on one that has no declared course reading is a site request.
    const sharedFamilies: Record<string, number> = {};
    for (const name of bySiteClass.get("shared_object")!) {
      const family = catalog.operations.find((operation) => operation.toolName === name)!.path.split("/")[2];
      sharedFamilies[family] = (sharedFamilies[family] || 0) + 1;
    }
    expect(sharedFamilies).toEqual({
      appointment_groups: 1,
      files: 2,
      folders: 5,
      group_categories: 3,
      groups: 34,
      outcomes: 1,
      sections: 2,
    });
    expect(bySiteClass.get("session_credential")).toEqual([
      "canvas_create_error_report",
      "canvas_create_jwt",
      "canvas_create_observer_pairing_code",
      "canvas_deprecated_create_instaccess_token",
      "canvas_generate_discovery_page_preview_token",
      "canvas_get_pandata_events_jwt_token_and_its_expiration_date",
      "canvas_kickoff_password_recovery_flow",
      "canvas_refresh_jwt",
      "canvas_start_kaltura_session",
    ]);

    // A quiz attempt, a what-if grade, an originality report on submitted work, group membership and a
    // booked time slot are all one person's own record, reached without its course.
    expect(bySiteClass.get("learner_record")!.filter((name) => {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      return !operation.path.startsWith("/v1/sections/");
    })).toEqual([
      "canvas_answering_questions",
      "canvas_assign_unassigned_members",
      "canvas_bulk_delete_memberships_bulk_deletes_memberships_by_providing_array_of_user_ids_or_for_different",
      "canvas_create_membership",
      "canvas_delete_appointment_group",
      "canvas_delete_topic_groups",
      "canvas_flagging_question",
      "canvas_import_category_groups",
      "canvas_invite_others_to_group",
      "canvas_leave_group_memberships",
      "canvas_leave_group_users",
      "canvas_reserve_time_slot",
      "canvas_reserve_time_slot_participant_id",
      "canvas_unflagging_question",
      "canvas_update_membership_memberships",
      "canvas_update_membership_users",
      "canvas_update_submission_s_what_if_score_and_calculate_grades",
    ]);

    // The admitted set is pinned here as well. Any change needs a reviewed admission reason.
    expect(catalog.operations.filter((operation) => !operation.readOnly
      && canvasOperationAdmission(operation).write.state === "admitted")).toHaveLength(540);
  });

  // Generic Canvas upload pre-flights cannot carry the remaining transfer steps. The Rubric CSV
  // operation cannot carry its required file at all. Every such route stays held, and this complete
  // list prevents a later readback match from publishing an operation with no executable body.
  it("holds every Canvas route that needs a reviewed file transfer", () => {
    const tools = canvasCatalogTools(catalog);
    const sentence = "Canvas takes a file's bytes in a later request that this route cannot carry, so Morrow sends every file through its reviewed file transfer, which checks the saved file and its bytes. Ask Morrow to prepare the file upload for this same target.";
    const transfers = catalog.operations.filter((operation) => {
      const write = canvasOperationAdmission(operation).write;
      return write.state === "held" && write.reason === "multi_step_upload_requires_reviewed_transfer";
    });
    expect(transfers.map((operation) => operation.toolName).sort()).toEqual([
      "canvas_creates_rubric_using_csv_file_accounts",
      "canvas_creates_rubric_using_csv_file_courses",
      "canvas_upload_file_courses",
      "canvas_upload_file_quiz_id_submissions_self_files_post",
      "canvas_upload_file_sections",
      "canvas_upload_file_submissions_user_id_comments_files_post",
      "canvas_upload_file_v1_courses_course_id_files_post",
      "canvas_upload_file_v1_folders_folder_id_files_post",
      "canvas_upload_file_v1_groups_group_id_files_post",
      "canvas_upload_file_v1_users_user_id_files_post",
    ]);
    for (const operation of transfers.filter((candidate) => candidate.path.startsWith("/v1/courses/"))) {
      const name = operation.toolName;
      expect(operation.method, name).toBe("POST");
      if (name === "canvas_creates_rubric_using_csv_file_courses") {
        expect(operation.path).toBe("/v1/courses/{course_id}/rubrics/upload");
        expect(operation.parameters.map((parameter) => parameter.inputName)).toEqual(["course_id"]);
        expect(operation.inputSchema.required).toEqual(["course_id"]);
      } else {
        expect(operation.path, name).toMatch(/^\/v1\/courses\/\{course_id\}\/(?:[^/]+\/)*files$/);
      }
      // The course is in the route, so the hold is not about scope: the courseTarget stays the
      // direct course path, and the write is still held.
      expect(canvasOperationAdmission(operation).courseTarget, name).toEqual({ kind: "course_path", argument: "course_id" });
      expect(canvasAdmissionReason(canvasOperationAdmission(operation).write), name).toBe(sentence);
      expect(canvasReadbackAssessment(catalog.operations, operation), name).toEqual({ state: "not_applicable", reason: "write_held" });
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.capability?.profiles["public-canvas"], name).toEqual({ state: "profile_limited", reason: sentence });
      expect(tool?.capability?.profiles["private-full"], name).toEqual({ state: "profile_limited", reason: sentence });
      expect(tool?.capability?.evidence?.admission, name).toEqual({ state: "blocked", reason: sentence });
      expect(tool?.capability?.behavior.supportsReadback, name).toBe(false);
    }

    // The same first step for a folder, a group, a section submission or a person is a site request,
    // and it needs the same reviewed transfer before any byte is sent.
    for (const operation of transfers.filter((candidate) => !candidate.path.startsWith("/v1/courses/"))) {
      expect(canvasOperationAdmission(operation).authority, operation.toolName).toBe("site");
      expect(canvasAdmissionReason(canvasOperationAdmission(operation).write), operation.toolName).toBe(sentence);
    }
    expect(catalog.operations.filter((operation) => !operation.readOnly && operation.method === "POST" && /files$/.test(operation.path)
      && !transfers.includes(operation))).toEqual([]);

    // The hold is exactly the upload pre-flight. A course-scoped write on a file that already
    // exists is still an ordinary admitted course write.
    const dateDetails = catalog.operations.find((operation) => operation.toolName === "canvas_update_learning_object_s_date_information_files")!;
    expect(dateDetails.path).toBe("/v1/courses/{course_id}/files/{attachment_id}/date_details");
    expect(canvasOperationAdmission(dateDetails).write).toEqual({ state: "admitted" });

    // The table a side without the Canvas catalog reads is exactly the catalog's own upload routes,
    // and every route in it builds its exact address only from ids that name every path input.
    const uploadRoutes = catalog.operations.filter((operation) => canvasReviewedUploadKind(operation));
    expect(Object.fromEntries(uploadRoutes.map((operation) => [operation.toolName, operation.path]))).toEqual(CANVAS_REVIEWED_UPLOAD_ROUTES);
    for (const operation of uploadRoutes) {
      const ids = Object.fromEntries(operation.parameters.filter((parameter) => parameter.location === "path").map((parameter) => [parameter.inputName, "7"]));
      expect(canvasReviewedUploadPath(operation, ids), operation.toolName).toBe(operation.path.replace(/\{[^}]+\}/g, "7"));
      expect(canvasReviewedUploadPath(canvasReviewedUploadRoute(operation.toolName), ids), operation.toolName).toBe(operation.path.replace(/\{[^}]+\}/g, "7"));
      expect(canvasReviewedUploadPath(operation, { ...ids, extra: "1" }), operation.toolName).toBe("");
      expect(canvasReviewedUploadPath(operation, Object.fromEntries(Object.keys(ids).map((name) => [name, "../1"]))), operation.toolName).toBe("");
    }
    expect(canvasReviewedUploadPath(catalog.operations.find((operation) => operation.toolName === "canvas_edit_assignment"), { course_id: "1", id: "1" })).toBe("");

    // The reviewed transfer is not one of these routes and cannot be held by this contract: it is
    // Morrow's own operation, outside the Canvas catalog.
    expect(catalog.operations.some((operation) => operation.toolName === "canvas_transfer_course_file")).toBe(false);
  });

  it("keeps ambiguous OutcomeLink and course deletion readbacks unreachable", () => {
    const tools = new Map(canvasCatalogTools(catalog).map((tool) => [tool.name, tool]));
    const outcomeLinks = catalog.operations.filter((operation) => operation.nickname.startsWith("create_link_outcome"));
    expect(outcomeLinks.map((operation) => operation.toolName).sort()).toEqual([
      "canvas_create_link_outcome_accounts",
      "canvas_create_link_outcome_accounts_outcome_id",
      "canvas_create_link_outcome_courses",
      "canvas_create_link_outcome_courses_outcome_id",
      "canvas_create_link_outcome_global",
      "canvas_create_link_outcome_global_outcome_id",
    ]);
    for (const operation of outcomeLinks) {
      const admission = canvasOperationAdmission(operation);
      // Admission is a site request now, so the readback itself refuses the nested link identity
      // (ledger row 412). The change is sent without a readback claim and reports that it was not checked.
      expect(admission, operation.toolName).toMatchObject({ authority: "site", write: { state: "admitted" } });
      expect(canvasReadbackAssessment(catalog.operations, operation, admission), operation.toolName)
        .toEqual({ state: "blocked", reason: "outcome_link_identity_is_nested" });
      expect(tools.get(operation.toolName)?.capability?.profiles["private-full"].state, operation.toolName).toBe("supported");
      expect(tools.get(operation.toolName)?.capability?.profiles["public-canvas"].state, operation.toolName).toBe("supported");
      expect(tools.get(operation.toolName)?.capability?.behavior.supportsReadback, operation.toolName).toBe(false);
    }

    const course = catalog.operations.find((operation) => operation.toolName === "canvas_delete_conclude_course")!;
    expect(course.inputSchema.properties?.event).toMatchObject({ enum: ["delete", "conclude"] });
    const admission = canvasOperationAdmission(course);
    // The course delete is admitted as course work; its readback still cannot tell delete from conclude.
    expect(admission.write).toEqual({ state: "admitted" });
    expect(canvasReadbackAssessment(catalog.operations, course, admission))
      .toEqual({ state: "blocked", reason: "course_delete_or_conclude_is_ambiguous" });
    expect(tools.get(course.toolName)?.capability?.profiles["private-full"]?.state).toBe("supported");
    expect(tools.get(course.toolName)?.capability?.profiles["public-canvas"]?.state).toBe("supported");
    expect(tools.get(course.toolName)?.capability?.behavior.supportsReadback).toBe(false);
  });

  it("admits a section only through its declared course-ownership reading, and holds every learner route", () => {
    const tools = canvasCatalogTools(catalog);
    const sectionTarget = {
      object: "section",
      objectParameter: "id",
      resolverRead: "canvas_get_section_information_sections",
      courseField: "course_id",
      courseCollectionRead: "canvas_list_course_sections",
    };
    for (const name of ["canvas_edit_section", "canvas_delete_section"]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasOperationAdmission(operation), name).toEqual({
        courseTarget: { kind: "semantic_course_object", target: sectionTarget },
        authority: "course",
        write: { state: "admitted" },
      });
      expect(canvasSemanticCourseTarget(operation), name).toEqual(sectionTarget);
      expect(canvasReadbackAssessment(catalog.operations, operation), name).toEqual({ state: "structurally_exact" });
      const plan = planBrowserReadback(catalog.operations, operation, { id: "302", course_section_name: "Section B" }, { id: "302" });
      expect(plan?.readOperation.toolName, name).toBe("canvas_get_section_information_sections");
      expect(plan?.arguments, name).toEqual({ id: "302" });
      expect(tools.find((tool) => tool.name === name)?.capability?.authority.scopeClass, name).toBe("course-object");
    }

    // The resolver read and the course-side listing the connector needs must both stay addressable
    // from the ids Morrow already holds: the object id, and the selected course id.
    const resolver = catalog.operations.find((candidate) => candidate.toolName === sectionTarget.resolverRead)!;
    expect(resolver.readOnly).toBe(true);
    expect(resolver.parameters.filter((parameter) => parameter.location === "path").map((parameter) => parameter.inputName)).toEqual(["id"]);
    const collection = catalog.operations.find((candidate) => candidate.toolName === sectionTarget.courseCollectionRead)!;
    expect(collection.readOnly).toBe(true);
    expect(collection.parameters.filter((parameter) => parameter.location === "path").map((parameter) => parameter.inputName)).toEqual(["course_id"]);

    const sectionWrites = catalog.operations.filter((operation) => !operation.readOnly && operation.path.startsWith("/v1/sections/"));
    expect(sectionWrites).toHaveLength(21);
    const byScope = new Map<string, string[]>();
    for (const operation of sectionWrites) {
      const admission = canvasOperationAdmission(operation);
      const key = admission.write.state === "held" ? admission.write.reason : admission.siteClass || admission.authority;
      byScope.set(key, [...(byScope.get(key) || []), operation.toolName].sort());
    }
    expect(byScope.get("course")).toEqual(["canvas_delete_section", "canvas_edit_section"]);
    // Cross-listing moves the section into a second course, so it is a site request on a shared object.
    expect(byScope.get("shared_object")).toEqual(["canvas_cross_list_section", "canvas_de_cross_list_section"]);
    // A person's record reached through a section is a site request; its file upload needs the
    // reviewed transfer.
    expect(byScope.get("learner_record")).toHaveLength(16);
    expect(byScope.get("multi_step_upload_requires_reviewed_transfer")).toEqual(["canvas_upload_file_sections"]);
    expect([...byScope.keys()].sort()).toEqual(["course", "learner_record", "multi_step_upload_requires_reviewed_transfer", "shared_object"]);
  });

  it("admits a group's own discussion topics and pages, and holds every route about who is in a group", () => {
    const tools = canvasCatalogTools(catalog);
    const groupTarget = {
      object: "group",
      objectParameter: "group_id",
      resolverRead: "canvas_get_single_group",
      courseField: "course_id",
      courseCollectionRead: "canvas_list_groups_available_in_context_courses",
      contextField: "context_type",
      contextValue: "Course",
      courseCollectionProof: true,
    };
    const groupContentWrites = [
      "canvas_create_new_discussion_topic_groups",
      "canvas_create_page_groups",
      "canvas_delete_page_groups",
      "canvas_update_create_front_page_groups",
      "canvas_update_create_page_groups",
      "canvas_update_topic_groups",
    ];
    for (const name of groupContentWrites) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasOperationAdmission(operation), name).toEqual({
        courseTarget: { kind: "semantic_course_object", target: groupTarget },
        authority: "course",
        write: { state: "admitted" },
      });
      expect(canvasSemanticCourseTarget(operation), name).toEqual(groupTarget);
      // The change is read back through the group content route's own GET, inside the same group
      // the reading proved.
      expect(canvasReadbackAssessment(catalog.operations, operation), name).toEqual({ state: "structurally_exact" });
      const plan = planBrowserReadback(catalog.operations, operation, { group_id: "88", topic_id: "9", url_or_id: "week-one", wiki_page_title: "Week one" }, { id: "9", page_id: "9", url: "week-one" });
      expect(plan?.readOperation.path, name).toMatch(/^\/v1\/groups\/\{group_id\}\//);
      expect(plan?.arguments.group_id, name).toBe("88");
      expect(tools.find((tool) => tool.name === name)?.capability?.authority.scopeClass, name).toBe("course-object");
    }

    const resolver = catalog.operations.find((candidate) => candidate.toolName === groupTarget.resolverRead)!;
    expect(resolver.readOnly).toBe(true);
    expect(resolver.parameters.filter((parameter) => parameter.location === "path").map((parameter) => parameter.inputName)).toEqual(["group_id"]);
    const collection = catalog.operations.find((candidate) => candidate.toolName === groupTarget.courseCollectionRead)!;
    expect(collection.readOnly).toBe(true);
    expect(collection.path).toBe("/v1/courses/{course_id}/groups");
    expect(collection.parameters.filter((parameter) => parameter.location === "path").map((parameter) => parameter.inputName)).toEqual(["course_id"]);

    const groupWrites = catalog.operations.filter((operation) => !operation.readOnly && /^\/v1\/(?:groups|group_categories)(?:\/|$)/.test(operation.path));
    expect(groupWrites).toHaveLength(53);
    const byScope = new Map<string, string[]>();
    for (const operation of groupWrites) {
      const admission = canvasOperationAdmission(operation);
      const key = admission.write.state === "held" ? admission.write.reason : admission.siteClass || admission.authority;
      byScope.set(key, [...(byScope.get(key) || []), operation.toolName].sort());
    }
    expect([...byScope.keys()].sort()).toEqual(["course", "learner_record", "multi_step_upload_requires_reviewed_transfer", "shared_object"]);
    expect(byScope.get("course")).toEqual(groupContentWrites);
    // Every route whose purpose is to place, move, or remove people is a person's record reached
    // through a group.
    expect(byScope.get("learner_record")).toEqual([
      "canvas_assign_unassigned_members",
      "canvas_bulk_delete_memberships_bulk_deletes_memberships_by_providing_array_of_user_ids_or_for_different",
      "canvas_create_membership",
      "canvas_delete_topic_groups",
      "canvas_import_category_groups",
      "canvas_invite_others_to_group",
      "canvas_leave_group_memberships",
      "canvas_leave_group_users",
      "canvas_update_membership_memberships",
      "canvas_update_membership_users",
    ]);
    // A group set and a group's own object have no declared course reading, so they are site requests
    // on a shared object that Canvas decides with the person's own roles.
    for (const name of ["canvas_create_group_group_categories", "canvas_delete_group_category", "canvas_update_group_category",
      "canvas_delete_group", "canvas_edit_group", "canvas_set_usage_rights_groups"]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasOperationAdmission(operation), name).toMatchObject({ authority: "site", siteClass: "shared_object", write: { state: "admitted" } });
      expect(canvasSemanticCourseTarget(operation), name).toBeUndefined();
    }
    expect(byScope.get("multi_step_upload_requires_reviewed_transfer")).toEqual(["canvas_upload_file_v1_groups_group_id_files_post"]);
  });

  it("proves a group's course from the group and from the selected course's own listing", () => {
    const target = canvasSemanticCourseTarget(catalog.operations.find((operation) => operation.toolName === "canvas_update_topic_groups")!)!;
    const courseGroup = { id: "88", course_id: "42", context_type: "Course", name: "Lab team 1" };
    expect(canvasSemanticResolvedCourseId(target, { ok: true, data: courseGroup }, "88")).toBe("42");
    // A group a person made for themselves, or one an account owns, is not this course's group even
    // when the reading also carries a course id.
    expect(canvasSemanticResolvedCourseId(target, { ok: true, data: { ...courseGroup, context_type: "User" } }, "88")).toBe("");
    expect(canvasSemanticResolvedCourseId(target, { ok: true, data: { ...courseGroup, context_type: "Account", course_id: null } }, "88")).toBe("");
    expect(canvasSemanticResolvedCourseId(target, { ok: true, data: { id: "88", course_id: "43", context_type: "Course" } }, "88")).toBe("43");
    expect(canvasSemanticResolvedCourseId(target, { ok: true, truncated: true, data: courseGroup }, "88")).toBe("");
    expect(canvasSemanticResolvedCourseId(target, { ok: false, status: 404 }, "88")).toBe("");

    // The course's own listing is the second half of the proof, and a listing that could not be read
    // to its last page is its own answer rather than absence.
    expect(target.courseCollectionProof).toBe(true);
    expect(canvasSemanticCourseCollectionState(target, { ok: true, data: [{ id: "87" }, { id: 88 }] }, "88")).toBe("listed");
    expect(canvasSemanticCourseCollectionState(target, { ok: true, data: [{ id: "87" }] }, "88")).toBe("absent");
    expect(canvasSemanticCourseCollectionState(target, { ok: true, truncated: true, data: [{ id: "87" }] }, "88")).toBe("unreadable");
    expect(canvasSemanticCourseCollectionState(target, { ok: false, status: 403 }, "88")).toBe("unreadable");
    expect(canvasSemanticCourseCollectionState(target, { ok: true, data: { id: "88" } }, "88")).toBe("unreadable");
    expect(canvasSemanticCourseCollectionState(target, { ok: true, data: [{ id: "88" }] }, "")).toBe("unreadable");
  });

  it("admits renaming, moving and removing a course file and adding a folder inside a course folder", () => {
    const tools = canvasCatalogTools(catalog);
    const fileTarget = {
      object: "file",
      objectParameter: "id",
      resolverRead: "canvas_get_file_files",
      courseField: "context_id",
      courseCollectionRead: "canvas_list_files_courses",
      contextField: "context_type",
      contextValue: "Course",
      courseCollectionProof: true,
      versionFields: ["id", "updated_at", "size", "content-type"],
      versionTimestampField: "updated_at",
      destinationParameter: "parent_folder_id",
      destinationCollectionRead: "canvas_list_all_folders_courses",
      requiredInputs: { on_duplicate: "rename" },
      readbackFields: { name: "display_name", parent_folder_id: "folder_id" },
      unsavedInputs: ["on_duplicate"],
    };
    for (const name of ["canvas_update_file", "canvas_delete_file"]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasOperationAdmission(operation), name).toEqual({
        courseTarget: { kind: "semantic_course_object", target: fileTarget },
        authority: "course",
        write: { state: "admitted" },
      });
      expect(canvasReadbackAssessment(catalog.operations, operation), name).toEqual({ state: "structurally_exact" });
      const plan = planBrowserReadback(catalog.operations, operation, { id: "601", name: "Syllabus 2026.pdf" }, { id: "601" });
      expect(plan?.readOperation.toolName, name).toBe("canvas_get_file_files");
      expect(plan?.arguments, name).toEqual({ id: "601" });
      expect(tools.find((tool) => tool.name === name)?.capability?.authority.scopeClass, name).toBe("course-object");
    }

    // A new folder is read back through its own route, where it names the proved parent again. The
    // folder list under the same route would name the new folder's own contents instead.
    const createFolder = catalog.operations.find((candidate) => candidate.toolName === "canvas_create_folder_folders")!;
    const folderTarget = canvasSemanticCourseTarget(createFolder)!;
    expect(folderTarget.object).toBe("folder");
    expect(folderTarget.readParameter).toBe("id");
    expect(folderTarget.childParentField).toBe("parent_folder_id");
    expect(folderTarget.refusedParameters).toEqual(["parent_folder_id", "parent_folder_path"]);
    expect(canvasOperationAdmission(createFolder).write).toEqual({ state: "admitted" });
    expect(canvasReadbackAssessment(catalog.operations, createFolder)).toEqual({ state: "structurally_exact" });
    const created = planBrowserReadback(catalog.operations, createFolder, { folder_id: "84", name: "Week 3" }, { id: "95", parent_folder_id: "84" });
    expect(created?.readOperation.toolName).toBe("canvas_get_folder_folders");
    expect(created?.arguments).toEqual({ id: "95" });
    expect(created?.targetId).toBe("95");
    expect(created?.strategy).toBe("created-resource");

    // Copying reaches a second object that the reading of the first one does not prove, and every
    // other file or folder write has no reading declared for it at all, so those are site requests.
    const fileWrites = catalog.operations.filter((operation) => !operation.readOnly && /^\/v1\/(?:files|folders)(?:\/|$)/.test(operation.path));
    expect(fileWrites).toHaveLength(10);
    const byScope = new Map<string, string[]>();
    for (const operation of fileWrites) {
      const admission = canvasOperationAdmission(operation);
      const key = admission.write.state === "held" ? admission.write.reason : admission.siteClass || admission.authority;
      byScope.set(key, [...(byScope.get(key) || []), operation.toolName].sort());
    }
    expect([...byScope.keys()].sort()).toEqual(["course", "multi_step_upload_requires_reviewed_transfer", "shared_object"]);
    expect(byScope.get("course")).toEqual(["canvas_create_folder_folders", "canvas_delete_file", "canvas_update_file"]);
    expect(byScope.get("shared_object")).toEqual([
      "canvas_copy_file",
      "canvas_copy_folder",
      "canvas_delete_folder",
      "canvas_reset_link_verifier",
      "canvas_update_folder",
      "canvas_update_word_count",
    ]);
    expect(byScope.get("multi_step_upload_requires_reviewed_transfer")).toEqual(["canvas_upload_file_v1_folders_folder_id_files_post"]);
  });

  it("proves a course file from its own reading and compares the saved version afterwards", () => {
    const target = canvasSemanticCourseTarget(catalog.operations.find((operation) => operation.toolName === "canvas_update_file")!)!;
    const file = {
      id: "601", context_type: "Course", context_id: "42", folder_id: "84", display_name: "Syllabus.pdf",
      "content-type": "application/pdf", size: 20480, updated_at: "2026-09-06T12:00:00Z",
    };
    expect(canvasSemanticResolvedCourseId(target, { ok: true, data: file }, "601")).toBe("42");
    // A file an account owns, and a file whose reading names no owner, both prove no course.
    expect(canvasSemanticResolvedCourseId(target, { ok: true, data: { ...file, context_type: "Account", context_id: "5" } }, "601")).toBe("");
    expect(canvasSemanticResolvedCourseId(target, { ok: true, data: { id: "601", display_name: "Syllabus.pdf" } }, "601")).toBe("");
    expect(canvasSemanticCourseCollectionState(target, { ok: true, data: [{ id: "600" }, { id: 601 }] }, "601")).toBe("listed");
    expect(canvasSemanticCourseCollectionState(target, { ok: true, truncated: true, data: [{ id: 601 }] }, "601")).toBe("unreadable");

    const version = canvasSemanticObjectVersion(target, { ok: true, data: file }, "601")!;
    expect(version).toEqual({ id: "601", updated_at: "2026-09-06T12:00:00Z", size: 20480, "content-type": "application/pdf" });
    const renamed = { ...file, display_name: "Syllabus 2026.pdf", updated_at: "2026-09-06T12:30:00Z" };
    expect(canvasSemanticVersionState(target, version, { ok: true, data: renamed }, "601")).toBe("same_object");
    // A rename never rewrites the bytes, and a reading older than the frozen one is an earlier copy.
    expect(canvasSemanticVersionState(target, version, { ok: true, data: { ...renamed, size: 40960 } }, "601")).toBe("changed");
    expect(canvasSemanticVersionState(target, version, { ok: true, data: { ...file, updated_at: "2026-09-05T09:00:00Z" } }, "601")).toBe("changed");
    expect(canvasSemanticVersionState(target, version, { ok: false, status: 404 }, "601")).toBe("unreadable");

    // The frozen reading has to carry the saved version and the exact destination the change asks
    // for, so a change that moves a file is proved for that one folder and for no other.
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    const proof = {
      objectId: "601",
      courseId: "42",
      resolverTool: "canvas_get_file_files",
      resolvedAt: "2026-09-06T11:59:59.000Z",
      snapshotDigest: "a".repeat(64),
      objectVersion: version,
    };
    expect(canvasSemanticResolutionProblem(target, proof, { objectId: "601", courseId: "42", now })).toBeUndefined();
    expect(canvasSemanticResolutionProblem(target, { ...proof, objectVersion: undefined }, { objectId: "601", courseId: "42", now }))
      .toBe("canvas_semantic_target_course_mismatch");
    expect(canvasSemanticResolutionProblem(target, proof, { objectId: "601", courseId: "42", now, destinationId: "85" }))
      .toBe("canvas_semantic_target_course_mismatch");
    expect(canvasSemanticResolutionProblem(target, { ...proof, destinationId: "85" }, { objectId: "601", courseId: "42", now, destinationId: "85" }))
      .toBeUndefined();
  });

  it("admits the course calendar event routes and an appointment group that serves one course", () => {
    const tools = canvasCatalogTools(catalog);
    for (const name of ["canvas_create_calendar_event", "canvas_update_calendar_event", "canvas_delete_calendar_event", "canvas_update_appointment_group"]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasOperationAdmission(operation).courseTarget.kind, name).toBe("semantic_course_object");
      expect(canvasOperationAdmission(operation).write, name).toEqual({ state: "admitted" });
      expect(canvasReadbackAssessment(catalog.operations, operation), name).toEqual({ state: "structurally_exact" });
      expect(tools.find((tool) => tool.name === name)?.capability?.authority.scopeClass, name).toBe("course-object");
    }

    // A change to one event is read back through that event's own route, and the requested fields
    // are the comparator.
    const update = catalog.operations.find((candidate) => candidate.toolName === "canvas_update_calendar_event")!;
    const changed = planBrowserReadback(catalog.operations, update, {
      id: "501", calendar_event_title: "Lab review", calendar_event_start_at: "2026-09-10T16:00:00Z",
      calendar_event_end_at: "2026-09-10T17:00:00Z", calendar_event_description: "<p>Bring the worksheet.</p>",
      calendar_event_location_name: "Room 2",
    }, { id: "501" });
    expect(changed?.readOperation.toolName).toBe("canvas_get_single_calendar_event_or_assignment");
    expect(changed?.arguments).toEqual({ id: "501" });
    expect(changed?.assertions.map((assertion) => assertion.inputName).sort()).toEqual([
      "calendar_event_description",
      "calendar_event_end_at",
      "calendar_event_location_name",
      "calendar_event_start_at",
      "calendar_event_title",
    ]);
    const saved = {
      id: "501", context_code: "course_42", title: "Lab review", start_at: "2026-09-10T16:00:00Z",
      end_at: "2026-09-10T17:00:00Z", description: "<p>Bring the worksheet.</p>", location_name: "Room 2",
    };
    expect(evaluateBrowserReadback(changed, { ok: true, status: 200, data: saved }).status).toBe("verified");
    expect(evaluateBrowserReadback(changed, { ok: true, status: 200, data: { ...saved, start_at: "2026-09-11T16:00:00Z" } }).status).toBe("mismatch");

    // A new event is read back through the same route, where Canvas names the calendar it landed on.
    const create = catalog.operations.find((candidate) => candidate.toolName === "canvas_create_calendar_event")!;
    const created = planBrowserReadback(catalog.operations, create, { calendar_event_context_code: "course_42", calendar_event_title: "Lab review" }, saved);
    expect(created?.readOperation.toolName).toBe("canvas_get_single_calendar_event_or_assignment");
    expect(created?.arguments).toEqual({ id: "501" });
    expect(created?.targetId).toBe("501");
    expect(created?.strategy).toBe("created-resource");
    expect(evaluateBrowserReadback(created, { ok: true, status: 200, data: saved }).status).toBe("verified");

    // A removal is proved by the event's own route answering 404, or by the course's whole calendar.
    const remove = catalog.operations.find((candidate) => candidate.toolName === "canvas_delete_calendar_event")!;
    const removed = planBrowserReadback(catalog.operations, remove, { id: "501" }, { id: "501" });
    expect(removed?.strategy).toBe("deleted-resource");
    expect(evaluateBrowserReadback(removed, { ok: false, status: 404 }).status).toBe("verified");

    // Canvas names a calendar with a context code, and an appointment group carries a list of them.
    const eventTarget = canvasSemanticCourseTarget(update)!;
    expect(canvasSemanticResolvedCourseId(eventTarget, { ok: true, data: saved }, "501")).toBe("42");
    expect(canvasSemanticResolvedCourseId(eventTarget, { ok: true, data: { ...saved, context_code: "group_9" } }, "501")).toBe("");
    const groupTarget = canvasSemanticCourseTarget(catalog.operations.find((candidate) => candidate.toolName === "canvas_update_appointment_group")!)!;
    const appointmentGroup = { id: "701", context_codes: ["course_42"], title: "Office hours" };
    expect(canvasSemanticObjectContext(groupTarget, { ok: true, data: appointmentGroup }, "701")).toEqual({ state: "course", courseId: "42" });
    // One appointment group can serve several courses at once. Morrow changes one course, so that
    // group is refused outright rather than changed for the others too.
    expect(canvasSemanticObjectContext(groupTarget, { ok: true, data: { ...appointmentGroup, context_codes: ["course_42", "course_43"] } }, "701"))
      .toEqual({ state: "multi_context" });
    expect(canvasSemanticContextInputState(groupTarget, { appointment_group_context_codes: ["course_42", "course_43"] }, "42")).toBe("multi_context");
    expect(canvasSemanticContextInputState(groupTarget, { appointment_group_context_codes: ["course_42"] }, "42")).toBe("selected_course");
    expect(canvasSemanticContextInputState(eventTarget, { calendar_event_context_code: "course_43" }, "42")).toBe("other_context");
    expect(canvasSemanticSeriesInput(eventTarget, { id: "501", calendar_event_rrule: "FREQ=WEEKLY;COUNT=5" })).toBe(true);

    // The course's whole calendar is asked for by its context code, and a listing Canvas did not
    // narrow to that calendar proves nothing about what the course holds.
    expect(canvasSemanticCourseCollectionArguments(eventTarget, "42")).toEqual({ context_codes: ["course_42"], all_events: "true" });
    expect(canvasSemanticCourseCollectionState(eventTarget, { ok: true, data: [saved] }, "501", "42")).toBe("listed");
    expect(canvasSemanticCourseCollectionState(eventTarget, { ok: true, data: [] }, "501", "42")).toBe("absent");
    expect(canvasSemanticCourseCollectionState(eventTarget, { ok: true, data: [{ ...saved, id: "601", context_code: "course_43" }] }, "501", "42")).toBe("unreadable");

    // Booking a slot and cancelling a whole sign-up sheet are a person's own record, creating a sign-up
    // sheet names its courses in the request itself, and the enabled account calendars are the
    // person's own list. Each is a site request.
    for (const [name, siteClass] of [
      ["canvas_reserve_time_slot", "learner_record"],
      ["canvas_reserve_time_slot_participant_id", "learner_record"],
      ["canvas_delete_appointment_group", "learner_record"],
      ["canvas_create_appointment_group", "shared_object"],
      ["canvas_save_enabled_account_calendars", "person"],
    ]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasOperationAdmission(operation), name).toMatchObject({ authority: "site", siteClass, write: { state: "admitted" } });
    }
  });

  it("refuses a section change until one current reading names this object and the selected course", () => {
    const target = canvasSemanticCourseTarget(catalog.operations.find((operation) => operation.toolName === "canvas_edit_section")!)!;
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    const proof = {
      objectId: "302",
      courseId: "42",
      resolverTool: "canvas_get_section_information_sections",
      resolvedAt: "2026-09-06T11:59:59.000Z",
      snapshotDigest: "a".repeat(64),
    };
    const expected = { objectId: "302", courseId: "42", now };
    expect(canvasSemanticResolutionProblem(target, proof, expected)).toBeUndefined();
    expect(canvasSemanticResolutionProblem(target, undefined, expected)).toBe("canvas_semantic_target_course_mismatch");
    expect(canvasSemanticResolutionProblem(target, { ...proof, courseId: "43" }, expected)).toBe("canvas_semantic_target_course_mismatch");
    expect(canvasSemanticResolutionProblem(target, { ...proof, objectId: "303" }, expected)).toBe("canvas_semantic_target_course_mismatch");
    expect(canvasSemanticResolutionProblem(target, { ...proof, resolverTool: "canvas_get_section_information_courses" }, expected))
      .toBe("canvas_semantic_target_course_mismatch");
    expect(canvasSemanticResolutionProblem(target, { ...proof, snapshotDigest: "" }, expected)).toBe("canvas_semantic_target_course_mismatch");
    expect(canvasSemanticResolutionProblem(target, { ...proof, resolvedAt: "2026-09-06T11:50:00.000Z" }, expected))
      .toBe("canvas_semantic_target_resolution_stale");

    const read = { ok: true, data: { id: "302", course_id: "42", name: "Section B" } };
    expect(canvasSemanticResolvedCourseId(target, read, "302")).toBe("42");
    expect(canvasSemanticResolvedCourseId(target, { ...read, truncated: true }, "302")).toBe("");
    expect(canvasSemanticResolvedCourseId(target, { ok: false, status: 404 }, "302")).toBe("");
    expect(canvasSemanticResolvedCourseId(target, { ok: true, data: { id: "303", course_id: "42" } }, "302")).toBe("");
    expect(canvasSemanticResolvedCourseId(target, { ok: true, data: { id: "302" } }, "302")).toBe("");
  });

  it("derives structural readback metadata from the shared planner", () => {
    const admittedWrites = catalog.operations.filter((operation) => !operation.readOnly && canvasOperationAdmission(operation).write.state === "admitted");
    const assessments = admittedWrites.map((operation) => canvasReadbackAssessment(catalog.operations, operation));
    expect(assessments.filter((assessment) => assessment.state === "unavailable")).toHaveLength(165);
    expect(assessments.filter((assessment) => assessment.state === "blocked")).toHaveLength(24);
    expect(assessments.filter((assessment) => assessment.state === "unconfirmed")).toHaveLength(11);
    expect(admittedWrites).toHaveLength(540);
    expect(assessments.filter((assessment) => assessment.state === "structurally_exact")).toHaveLength(340);
    const tools = canvasCatalogTools(catalog);
    expect(tools.find((tool) => tool.name === "canvas_update_custom_gradebook_column")?.capability?.behavior.supportsReadback).toBe(true);
    // Deleting a gradebook column is course work admitted through its course, and its absence reads back exactly.
    expect(tools.find((tool) => tool.name === "canvas_delete_custom_gradebook_column")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_mark_document_annotations_as_read_courses")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_mark_module_item_as_done_not_done")?.capability?.behavior.supportsReadback).toBe(false);
    expect(tools.find((tool) => tool.name === "canvas_mark_module_item_as_done_not_done")?.capability?.evidence?.readback).toMatchObject({
      state: "blocked",
      reason: "No safe exact post-write reader is available: module_item_reader_mutates_progress.",
    });
    expect(tools.find((tool) => tool.name === "canvas_mark_rubric_assessments_as_read_courses_rubric_assessments")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_mark_rubric_assessments_as_read_courses_rubric_comments")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_delete_external_feed_courses")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_remove_course_from_favorites")?.capability?.behavior.supportsReadback).toBe(false);
    expect(tools.find((tool) => tool.name === "canvas_remove_course_from_favorites")?.capability?.evidence?.readback).toMatchObject({
      state: "blocked",
      reason: "No safe exact post-write reader is available: favorite_list_is_effective_not_explicit_state.",
    });
    // Unlinking reads the group's link list back by the linked outcome's own id.
    expect(tools.find((tool) => tool.name === "canvas_unlink_outcome_courses")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_bulk_update_assignment_dates")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_re_activate_enrollment")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_disable_assignments_currently_enabled_for_grade_export_to_sis")?.capability?.behavior.supportsReadback).toBe(false);
    expect(tools.find((tool) => tool.name === "canvas_set_course_level_accommodations")?.capability?.evidence?.admission).toMatchObject({ state: "known" });
  });

  it("reads back discussion state, copies and reorders through their declared reads", () => {
    const write = (nickname: string) => catalog.operations.find((operation) => operation.nickname === nickname)!;
    const plan = (nickname: string, args: Record<string, unknown>, response: unknown = {}) => planBrowserReadback(catalog.operations, write(nickname), args, response)!;
    const status = (value: ReturnType<typeof plan>, data: unknown, extra: Record<string, unknown> = {}) => evaluateBrowserReadback(value, { ok: true, status: 200, data, ...extra }).status;

    for (const context of ["courses", "groups"]) {
      const scope = context === "courses" ? { course_id: "4" } : { group_id: "9" };
      const read = plan(`mark_topic_as_read_${context}`, { ...scope, topic_id: "8" });
      expect(read.readOperation.nickname).toBe(`get_single_topic_${context}`);
      expect(status(read, { id: 8, read_state: "read" })).toBe("verified");
      expect(status(read, { id: 8, read_state: "unread" })).toBe("mismatch");
      expect(status(plan(`unsubscribe_from_topic_${context}`, { ...scope, topic_id: "8" }), { id: 8, subscribed: false })).toBe("verified");
      expect(status(plan(`mark_all_entries_as_read_${context}`, { ...scope, topic_id: "8", forced_read_state: true }), { id: 8, read_state: "read", unread_count: 2 })).toBe("mismatch");

      const entry = plan(`mark_entry_as_unread_${context}`, { ...scope, topic_id: "8", entry_id: "12" });
      expect(entry.arguments).toMatchObject({ ids: ["12"], topic_id: "8" });
      expect(status(entry, [{ id: 12, read_state: "unread" }])).toBe("verified");
      expect(status(entry, [{ id: 13, read_state: "unread" }])).toBe("mismatch");
      expect(status(plan(`delete_entry_${context}`, { ...scope, topic_id: "8", id: "12" }), [{ id: 12, deleted: true }])).toBe("verified");

      const every = plan(`mark_all_topic_as_read_${context}`, scope);
      expect(status(every, [{ id: 1, read_state: "read" }, { id: 2, read_state: "read" }])).toBe("verified");
      expect(status(every, [{ id: 1, read_state: "read" }, { id: 2, read_state: "unread" }])).toBe("mismatch");
      expect(status(every, [{ id: 1, read_state: "read" }], { truncated: true })).toBe("unconfirmed");
    }

    const copy = plan("duplicate_discussion_topic_courses", { course_id: "4", topic_id: "8" }, { id: 31, title: "Week one Copy" });
    expect(copy.arguments).toEqual({ course_id: "4", topic_id: "31" });
    expect(status(copy, { id: 31 })).toBe("verified");
    const pageCopy = plan("duplicate_page", { course_id: "4", url_or_id: "week-one" }, { page_id: 77, url: "week-one-copy" });
    expect(pageCopy.arguments).toEqual({ course_id: "4", url_or_id: "week-one-copy" });

    const reorder = plan("reorder_pinned_topics_courses", { course_id: "4", order: ["9", "3", "7"] });
    expect(reorder.orderedTargets).toEqual(["9", "3", "7"]);
    expect(status(reorder, [{ id: 9 }, { id: 11 }, { id: 3 }, { id: 7 }])).toBe("verified");
    expect(status(reorder, [{ id: 3 }, { id: 9 }, { id: 7 }])).toBe("mismatch");
    expect(status(reorder, [{ id: 9 }, { id: 3 }])).toBe("mismatch");
    expect(planBrowserReadback(catalog.operations, write("reorder_custom_columns"), { course_id: "4", order: ["x"] }, {})).toBeNull();
  });

  it("refuses a readback whose read route is not the write target's own resource", () => {
    const tools = canvasCatalogTools(catalog);
    const withoutSafeRoute = [
      "canvas_create_rubricassociation",
      "canvas_delete_rubricassociation",
    ];
    for (const name of withoutSafeRoute) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeTruthy();
      expect(canvasReadbackAssessment(catalog.operations, catalog.operations.find((operation) => operation.toolName === name)!)).toEqual({
        state: "unavailable",
        reason: "no_safe_readback_route",
      });
      expect(tool!.capability?.behavior.supportsReadback, name).toBe(false);
      expect(tool!.capability?.evidence?.readback, name).toMatchObject({
        state: "blocked",
        reason: "No safe generic readback route is available.",
      });
    }
  });

  it("changes the structural assessment when the planner has no matching read route", () => {
    const update = catalog.operations.find((operation) => operation.toolName === "canvas_update_course_settings");
    expect(update).toBeTruthy();
    const withoutCanvasReads = catalog.operations.filter((operation) => !operation.readOnly || operation.service !== "canvas");
    expect(canvasReadbackAssessment(withoutCanvasReads, update!)).toEqual({
      state: "unavailable",
      reason: "no_safe_readback_route",
    });
  });
});
